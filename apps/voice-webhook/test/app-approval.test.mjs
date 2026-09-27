import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { win32 } from 'node:path';
import WebSocket from 'ws';
import { createDaemonClient } from '../../daemon/src/client.mjs';
import { createFakeAgent, FAKE_AGENT_ID } from '../../daemon/src/fake-agent.mjs';
import { createCodexAgent, CODEX_AGENT_ID } from '../../daemon/src/codex-agent.mjs';
import { stubCodexProcess } from './helpers/codex-process.mjs';
import { createServer } from '../src/app.mjs';
import { hashPin } from '../src/pin.mjs';
import { expectedTwilioSignature } from '../src/signature.mjs';
import { openStateStore } from '../src/state.mjs';

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for approval state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function runApprovalFlow(choice, mode = 'fake', failurePath, transcript = 'Push the demo branch.') {
  const isCodex = mode === 'codex';
  const command = 'git push origin HEAD:refs/heads/phone-demo';
  const runtimeCommand = process.platform === 'win32' && process.env.SystemRoot
    ? `"${win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe').replaceAll('\\', '\\\\')}" -Command '${command}'`
    : command;
  const decisions = [];
  const runtimeRequests = [];
  const machineId = randomUUID();
  const machineToken = 'test-only-fake-agent-machine-token-with-enough-length';
  const authToken = 'test-auth-token';
  const accountSid = `AC${'0'.repeat(32)}`;
  const caller = '+15065550123';
  const twilioNumber = '+15067045673';
  const publicBaseUrl = 'https://example.ngrok.app';
  const inboundSid = `CA${'a'.repeat(32)}`;
  const callbackSid = `CA${'c'.repeat(32)}`;
  const streamSid = `MZ${'b'.repeat(32)}`;
  let time = Date.now();
  const store = openStateStore(':memory:', { now: () => time });
  const callbackRequests = [];
  let bridge;
  const server = createServer({
    authToken, accountSid, publicBaseUrl, allowedCallerNumber: caller,
    callbackCallerNumber: twilioNumber,
    pinHash: hashPin('1234', Buffer.alloc(16, 4)), voiceMode: 'realtime', agentMode: mode,
    codexApprovalEnabled: isCodex,
    openAiApiKey: 'test-key', stateStore: store, now: () => time,
    daemonCredentials: new Map([[machineId, createHash('sha256').update(machineToken).digest('hex')]]),
    callbackCreator: async (request) => {
      callbackRequests.push(request);
      if (failurePath === 'callback-error') throw new Error('test callback unavailable');
      return callbackSid;
    },
    realtimeConnector: (options) => {
      bridge = options;
      return { appendAudio() {}, acknowledgeMark() {}, close() {}, speak: () => true };
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let fake;
  const client = createDaemonClient({
    serverUrl: origin.replace('http:', 'ws:') + '/daemon', machineId, token: machineToken,
    name: 'Demo laptop', allowInsecureLoopback: true,
    agents: [{ agentId: isCodex ? CODEX_AGENT_ID : FAKE_AGENT_ID, adapterType: mode, name: 'Demo agent', status: 'idle' }],
    onEvent: (event) => fake.receive(event),
    onStatus: (state) => { if (state === 'online') fake.flush(); },
  });
  fake = isCodex ? createCodexAgent({ machineId, send: event => client.send(event), workspace: process.cwd(), allowFullRead: true,
    approvalCommand: command, now: () => time, spawnProcess: () => stubCodexProcess({ command: runtimeCommand, cwd: process.cwd(), decisions, requests: runtimeRequests }),
    logger: { error() {} },
  }) : createFakeAgent({ machineId, send: (event) => client.send(event), delayMs: 60 });
  let media;
  const post = (path, params) => fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': expectedTwilioSignature(authToken, `${publicBaseUrl}${path}`, params),
    },
    body: new URLSearchParams(params),
  });
  try {
    client.start();
    await waitFor(() => store.getMachine(machineId)?.status === 'online');
    const inbound = { AccountSid: accountSid, From: caller, To: twilioNumber, CallSid: inboundSid };
    await post('/voice', inbound);
    const pin = await post('/voice/pin', { ...inbound, Digits: '1234' });
    const token = (await pin.text()).match(/name="token" value="([0-9a-f]+)"/)?.[1];
    assert.ok(token);
    media = new WebSocket(origin.replace('http:', 'ws:') + '/media', {
      headers: { 'x-twilio-signature': expectedTwilioSignature(authToken, 'wss://example.ngrok.app/media', {}) },
    });
    await new Promise((resolve, reject) => { media.once('open', resolve); media.once('error', reject); });
    media.send(JSON.stringify({ event: 'start', streamSid,
      start: { streamSid, accountSid, callSid: inboundSid, customParameters: { token } } }));
    await waitFor(() => bridge && store.getCall(inboundSid).state === 'streaming');
    bridge.onTranscript(transcript);
    if (isCodex) {
      assert.equal(store.listTasksForSession(store.getCall(inboundSid).session_id).length, 0);
      assert.deepEqual(decisions, []);
      assert.equal(callbackRequests.length, 0, 'read-back is not an action approval');
      bridge.onTranscript('Yes, start it.');
      if (transcript === 'Run the demo push.') {
        await waitFor(() => store.listTasksForSession(store.getCall(inboundSid).session_id)[0]?.state === 'waiting_human');
        bridge.onTranscript('Yes, start it.');
        assert.deepEqual(decisions, [], 'spoken confirmation cannot approve the protected action');
        assert.equal(callbackRequests.length, 0, 'callback waits for hangup');
      }
    }
    media.close();
    await new Promise((resolve) => media.once('close', resolve));
    await waitFor(() => callbackRequests.length === 1);
    const sessionId = store.getCall(inboundSid).session_id;
    const task = store.listTasksForSession(sessionId)[0];
    assert.equal(task.prompt, transcript, 'durable task keeps the original caller request');
    await waitFor(() => store.getTask(task.id).state === 'waiting_human');
    const callbackUrl = new URL(callbackRequests[0].url);
    const callbackPath = callbackUrl.pathname + callbackUrl.search;
    const approvalId = callbackUrl.searchParams.get('approvalId');
    const nonce = callbackUrl.searchParams.get('nonce');
    if (failurePath !== 'callback-error') await waitFor(() => store.getApprovalCallback(approvalId)?.call_sid === callbackSid);
    assert.equal(callbackRequests[0].to, caller);
    assert.equal(callbackRequests[0].from, twilioNumber);
    if (isCodex) {
      if (transcript === 'Run the demo push.') {
        const turnInput = runtimeRequests.find(request => request.method === 'turn/start').params.input[0].text;
        assert.ok(turnInput.includes(command), 'the daemon expands the shortcut into the exact literal command');
        assert.match(turnInput, /not approval/);
      }
      const approval = store.getApproval(approvalId);
      assert.equal(approval.command, runtimeCommand, 'the persisted action retains the exact runtime wrapper');
      assert.equal(approval.codex_item_id, 'push-item');
      assert.equal(approval.codex_request_id, '"approval-rpc"');
      assert.deepEqual(decisions, [], 'underlying request remains paused after hangup');
    }
    const outbound = { AccountSid: accountSid, From: twilioNumber, To: caller,
      CallSid: callbackSid, Direction: 'outbound-api' };
    const decisionPath = `/approval/decision?approvalId=${approvalId}&nonce=${nonce}`;
    const statusUrl = new URL(callbackRequests[0].statusUrl);
    const statusPath = statusUrl.pathname + statusUrl.search;
    const pinPath = `/approval/pin?approvalId=${approvalId}&nonce=${nonce}`;
    if (failurePath) {
      if (failurePath === 'callback-error') {
        assert.equal(store.getApprovalCallback(approvalId).state, 'failed');
        await post(callbackPath, outbound); // A delayed answer cannot revive failed authentication.
      } else if (failurePath === 'expired') {
        await post(callbackPath, outbound);
        await post(pinPath, { ...outbound, Digits: '1234' });
        time += 300001;
        assert.match(await (await post(decisionPath, { ...outbound, Digits: '1' })).text(), /no longer available/);
      } else if (failurePath === 'voicemail') {
        const greeting = await (await post(callbackPath, outbound)).text();
        assert.equal(greeting.includes('git push'), false);
        for (let i = 0; i < 3; i++) await post(pinPath, { ...outbound, Digits: '' });
        assert.equal(store.getApprovalCallback(approvalId).pin_verified, 0);
      }
      if (['no-answer', 'busy', 'failed', 'canceled', 'voicemail', 'callback-error'].includes(failurePath)) {
        const status = ['voicemail', 'callback-error'].includes(failurePath) ? 'completed' : failurePath;
        assert.equal((await fetch(`${origin}${statusPath}`, { method: 'POST', headers: {
          'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'forged',
        }, body: new URLSearchParams({ ...outbound, CallStatus: status }) })).status, 403);
        assert.equal((await post(statusPath, { ...outbound, CallStatus: status })).status, 204);
        assert.equal(store.getCall(callbackSid).direction, 'outbound');
        assert.equal(store.getCall(callbackSid).state, 'ended');
        assert.equal(store.getCall(callbackSid).ended_reason, `callback_${status.replace('-', '_')}`);
        await post(statusPath, { ...outbound, CallStatus: status }); // duplicate terminal delivery
        assert.equal(store.listAudit(sessionId).filter(event => event.type === 'callback.ended').length, 1);
      }
      await post(pinPath, { ...outbound, Digits: '1234' });
      await post(decisionPath, { ...outbound, Digits: '1' });
      assert.deepEqual(decisions, [], 'failure, silence or expiration must never accept the real RPC');
      assert.equal(store.getApproval(approvalId).state, 'pending');
      assert.equal(store.getTask(task.id).state, 'waiting_human');
      assert.equal(callbackRequests.length, 1, 'never retry an uncertain outbound call automatically');
      return;
    }
    assert.match(await (await post(decisionPath, { ...outbound, Digits: choice })).text(), /<Hangup\/>/);
    assert.equal(store.getApproval(approvalId).state, 'pending');
    const wrongSid = { ...outbound, CallSid: `CA${'d'.repeat(32)}` };
    assert.match(await (await post(callbackPath, wrongSid)).text(), /<Hangup\/>/);
    const beforePin = await (await post(callbackPath, outbound)).text();
    assert.match(beforePin, /Enter your four digit PIN/);
    assert.equal(beforePin.includes('git push'), false, 'action details must not be disclosed before PIN verification');
    assert.match(await (await post(pinPath, { ...outbound, Digits: '9999' })).text(), /Enter your four digit PIN/);
    assert.equal(store.getApprovalCallback(approvalId).pin_verified, 0);
    assert.match(await (await post(pinPath, { ...outbound, Digits: '1234' })).text(), /Press 1 to approve/);
    assert.equal(store.getApprovalCallback(approvalId).pin_verified, 1);
    const result = await (await post(decisionPath, { ...outbound, Digits: choice })).text();
    assert.match(result, choice === '1' ? /Approved/ : /Rejected/);
    assert.equal(store.getApproval(approvalId).state, choice === '1' ? 'approved' : 'rejected');
    await waitFor(() => store.getTask(task.id).state === (choice === '1' ? 'completed' : 'failed'));
    assert.match(await (await post(decisionPath, { ...outbound, Digits: choice })).text(), /no longer available/);
    assert.equal(callbackRequests.length, 1);
    if (isCodex) {
      assert.deepEqual(decisions, [choice === '1' ? 'accept' : 'cancel']);
      if (choice === '1') {
        const resultPath = `/approval/result?approvalId=${approvalId}&nonce=${nonce}`;
        assert.match(await (await post(resultPath, outbound)).text(), /fixture push completed/);
        assert.equal(store.getTask(task.id).result_text, 'The fixture push completed.');
      }
    }
    await post(statusPath, { ...outbound, CallStatus: 'completed' });
    assert.equal(store.getCall(callbackSid).state, 'ended');
    assert.equal(store.getApprovalCallback(approvalId).state, 'finished');
    assert.equal(store.getApproval(approvalId).state, choice === '1' ? 'approved' : 'rejected');
  } finally {
    media?.close();
    fake.stop();
    client.stop();
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
}

test('PIN-authenticated callback approves exact fake action once after hangup', () => runApprovalFlow('1'));
test('PIN-authenticated callback rejects fake action after hangup', () => runApprovalFlow('2'));
test('real adapter request survives hangup and receives one exact acceptance after PIN and DTMF', () => runApprovalFlow('1', 'codex'));
test('real adapter request receives cancel after authenticated rejection', () => runApprovalFlow('2', 'codex'));

test('demo push shortcut survives hangup and accepts only after PIN and DTMF', () =>
  runApprovalFlow('1', 'codex', undefined, 'Run the demo push.'));
test('demo push shortcut survives hangup and cancels after PIN and DTMF rejection', () =>
  runApprovalFlow('2', 'codex', undefined, 'Run the demo push.'));

for (const failure of ['no-answer', 'busy', 'failed', 'canceled', 'voicemail', 'expired', 'callback-error']) {
  test(`callback ${failure} keeps the real request blocked without a repeated call`, () => runApprovalFlow('1', 'codex', failure));
}
