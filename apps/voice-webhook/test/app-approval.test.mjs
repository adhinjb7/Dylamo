import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { join, relative, resolve, win32 } from 'node:path';
import WebSocket from 'ws';
import { createDaemonClient } from '../../daemon/src/client.mjs';
import { createFakeAgent, FAKE_AGENT_ID } from '../../daemon/src/fake-agent.mjs';
import { createCodexAgent, CODEX_AGENT_ID } from '../../daemon/src/codex-agent.mjs';
import { prepareApprovalRehearsal } from '../../daemon/src/approval-rehearsal.mjs';
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

async function runApprovalFlow(choice, mode = 'fake', failurePath, transcript = 'Push the demo branch.', decisionMode = 'callback', additionalPermissions = null,
  callbackDecisionMode = 'dtmf') {
  const isCodex = mode === 'codex';
  const fixture = isCodex ? prepareApprovalRehearsal(join(tmpdir(), 'dylamo-approval-rehearsals')) : null;
  const codexWorkspace = fixture?.workspace ?? process.cwd();
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
  const spoken = [];
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
      return { appendAudio() {}, acknowledgeMark() {}, close() {}, speak: text => { spoken.push(text); return true; } };
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
  fake = isCodex ? createCodexAgent({ machineId, send: event => client.send(event), workspace: codexWorkspace, allowFullRead: true,
    approvalCommand: command, now: () => time, processEnv: fixture.env,
    spawnProcess: () => stubCodexProcess({ command: runtimeCommand, cwd: codexWorkspace, decisions, requests: runtimeRequests, additionalPermissions,
      onAccept: () => {
        assert.equal(fixture.remoteCommit(), '', 'the destination must be empty until the authenticated decision');
        assert.equal(fixture.unchanged(), true, 'only the prepared disposable source may be pushed');
        fixture.git(fixture.workspace, ['push', 'origin', 'HEAD:refs/heads/phone-demo']);
      },
    }),
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
  const callbackDecisionInput = () => callbackDecisionMode === 'speech-push'
    ? { SpeechResult: 'Push the demo repo.' }
    : callbackDecisionMode === 'speech'
      ? { SpeechResult: choice === '1' ? 'Approve.' : 'Reject.' }
      : { Digits: choice };
  const callbackDetailsInput = () => callbackDecisionMode === 'dtmf'
    ? { Digits: '3' } : { SpeechResult: 'Details.' };
  try {
    client.start();
    await waitFor(() => store.getMachine(machineId)?.status === 'online');
    const inbound = { AccountSid: accountSid, From: caller, To: twilioNumber, CallSid: inboundSid };
    await post('/voice', inbound);
    const pin = await post('/voice/pin', { ...inbound,
      ...(decisionMode === 'callback' ? { Digits: '1234' } : { SpeechResult: 'one two three four' }) });
    const token = (await pin.text()).match(/name="token" value="([0-9a-f]+)"/)?.[1];
    assert.ok(token);
    media = new WebSocket(origin.replace('http:', 'ws:') + '/media', {
      headers: { 'x-twilio-signature': expectedTwilioSignature(authToken, 'wss://example.ngrok.app/media', {}) },
    });
    await new Promise((resolve, reject) => { media.once('open', resolve); media.once('error', reject); });
    media.send(JSON.stringify({ event: 'start', streamSid,
      start: { streamSid, accountSid, callSid: inboundSid, customParameters: { token } } }));
    await waitFor(() => bridge && store.getCall(inboundSid).state === 'streaming');
    bridge.onSpeechStart('before-action');
    bridge.onSpeechStop();
    bridge.onTranscript(transcript);
    if (isCodex) {
      assert.equal(store.listTasksForSession(store.getCall(inboundSid).session_id).length, 1,
        'the spoken request starts a task without a read-back or confirmation');
      assert.deepEqual(decisions, []);
      assert.equal(callbackRequests.length, 0, 'starting a task is not action approval');
      if (transcript === 'Run the demo push.') {
        await waitFor(() => store.listTasksForSession(store.getCall(inboundSid).session_id)[0]?.state === 'waiting_human');
        bridge.onTranscript('Approve.', 'before-action');
        bridge.onTranscript('Approve.', 'missing-start');
        bridge.onTranscript('Yes, start it.');
        for (const digit of ['0', '9']) media.send(JSON.stringify({ event: 'dtmf', streamSid,
          dtmf: { track: 'inbound_track', digit } }));
        await new Promise(resolve => { media.once('pong', resolve); media.ping(); });
        assert.deepEqual(decisions, [], 'generic yes, pre-action speech and uncorrelated transcripts cannot approve');
        assert.equal(store.listTasksForSession(store.getCall(inboundSid).session_id)[0].state, 'waiting_human',
          'unrecognized inbound keys cannot decide the protected action');
        assert.equal(fixture.remoteCommit(), '', 'authentication alone cannot push');
        assert.equal(callbackRequests.length, 0, 'callback waits for hangup');
      }
    }
    if (decisionMode !== 'callback') {
      const sessionId = store.getCall(inboundSid).session_id;
      const task = store.listTasksForSession(sessionId)[0];
      await waitFor(() => store.getTask(task.id).state === 'waiting_human');
      const approvalId = store.getPendingApprovalForSession(sessionId).id;
      assert.ok(spoken.some(text => text.includes('prepared changes to the local demo branch')));
      assert.ok(spoken.some(text => text.includes('Say approve or reject')));
      assert.equal(spoken.some(text => text.includes(runtimeCommand) || text.includes(codexWorkspace)), false,
        'the default approval prompt omits technical details');
      const context = store.getApprovalContext(approvalId);
      assert.equal(context.action_kind, 'local-demo-push');
      assert.equal(context.command, runtimeCommand, 'the full runtime command is still persisted');
      const digest = context.action_digest;
      bridge.onTranscript('Details.');
      assert.ok(spoken.at(-1).includes(runtimeCommand) && spoken.at(-1).includes(codexWorkspace));
      bridge.onTranscript('Repeat.');
      assert.match(spoken.at(-1), /prepared changes to the local demo branch/);
      assert.equal(store.getApprovalContext(approvalId).action_digest, digest);
      assert.deepEqual(decisions, [], 'details and repeat do not decide anything');
      assert.equal(store.listAudit(sessionId).filter(e => e.type === 'call.authenticated').length, 1);
      bridge.onSpeechStart('qualified');
      bridge.onSpeechStop();
      bridge.onTranscript('Approve, but only if the tests pass.', 'qualified');
      assert.deepEqual(decisions, [], 'qualified consent must not approve');
      bridge.onSpeechStart('failed-transcription');
      bridge.onTranscriptionFailure();
      bridge.onSpeechStop();
      bridge.onTranscript('Approve.', 'failed-transcription');
      assert.deepEqual(decisions, [], 'transcription failure invalidates consent');
      media.send(JSON.stringify({ event: 'dtmf', streamSid, dtmf: { track: 'outbound_track', digit: '1' } }));
      media.send(JSON.stringify({ event: 'dtmf', streamSid, dtmf: { track: 'inbound_track', digit: '3' } }));
      await new Promise(resolve => { media.once('pong', resolve); media.ping(); });
      assert.ok(spoken.at(-1).includes(runtimeCommand) && spoken.at(-1).includes(codexWorkspace));
      assert.equal(store.getApproval(approvalId).state, 'pending', 'repeat and invalid track are not decisions');
      if (failurePath === 'expired-inline') time += 300_001;
      if (decisionMode === 'speech') {
        bridge.onSpeechStart('decision');
        bridge.onSpeechStop();
        bridge.onTranscript(choice === '1' ? 'Approve.' : 'Reject.', 'decision');
        bridge.onTranscript(choice === '1' ? 'Approve.' : 'Reject.', 'decision');
      } else {
        for (let i = 0; i < 2; i++) media.send(JSON.stringify({ event: 'dtmf', streamSid,
          dtmf: { track: 'inbound_track', digit: choice } }));
        await new Promise(resolve => { media.once('pong', resolve); media.ping(); });
      }
      if (failurePath === 'expired-inline') {
        assert.deepEqual(decisions, []);
        assert.equal(fixture.remoteCommit(), '');
        assert.notEqual(store.getApproval(approvalId).state, 'approved');
      } else {
        await waitFor(() => store.getTask(task.id).state === (choice === '1' ? 'completed' : 'failed'));
        assert.deepEqual(decisions, [choice === '1' ? 'accept' : 'cancel']);
        assert.equal(fixture.remoteCommit(), choice === '1' ? fixture.expectedCommit : '');
        assert.equal(store.getApprovalCallback(approvalId), undefined);
        assert.equal(spoken.includes('The exact action was approved once. Codex is resuming.'), false,
          'do not narrate a second approval acknowledgment');
        const audit = store.listAudit(sessionId).filter(e => e.type === 'approval.decided');
        assert.equal(audit.length, 1);
        assert.equal(JSON.parse(audit[0].payload).channel, 'inbound');
        assert.equal(store.listTasksForSession(sessionId).length, 1, 'duplicate consent is not another task');
        assert.doesNotMatch(JSON.stringify(store.listAudit(sessionId)), /one two three four|1234/);
      }
      assert.equal(callbackRequests.length, 0, 'remaining on the call requires no callback');
      media.close();
      await new Promise(resolve => media.once('close', resolve));
      await waitFor(() => store.getCall(inboundSid).state === 'ended');
      assert.equal(callbackRequests.length, 0, 'resolved or expired decisions never trigger a callback on hangup');
      return;
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
      assert.equal(fixture.remoteCommit(), '', 'the local destination stays empty after hangup');
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
      if (isCodex) assert.equal(fixture.remoteCommit(), '', 'an unavailable callback cannot push');
      return;
    }
    assert.match(await (await post(decisionPath, { ...outbound, ...callbackDecisionInput() })).text(), /<Hangup\/>/);
    assert.equal(store.getApproval(approvalId).state, 'pending');
    const wrongSid = { ...outbound, CallSid: `CA${'d'.repeat(32)}` };
    assert.match(await (await post(callbackPath, wrongSid)).text(), /<Hangup\/>/);
    const beforePin = await (await post(callbackPath, outbound)).text();
    assert.match(beforePin, /Say your four PIN digits/);
    assert.equal(beforePin.includes('git push'), false, 'action details must not be disclosed before PIN verification');
    assert.doesNotMatch(beforePin, /prepared changes|demo branch|GitHub/);
    assert.match(await (await post(pinPath, { ...outbound, Digits: '9999' })).text(), /Say your four PIN digits/);
    assert.equal(store.getApprovalCallback(approvalId).pin_verified, 0);
    const brief = await (await post(pinPath, { ...outbound, SpeechResult: 'one two three four' })).text();
    assert.match(brief, /<Gather input="dtmf speech" numDigits="1"/);
    assert.match(brief, /Say approve or push the demo repo to allow once/);
    assert.equal(brief.includes(runtimeCommand) || brief.includes(codexWorkspace), additionalPermissions != null);
    assert.match(brief, additionalPermissions ? /Extra permissions/ : isCodex ? /prepared changes to the local demo branch/ : /practice push/);
    if (additionalPermissions) assert.doesNotMatch(brief, /Nothing goes to GitHub|prepared changes/);
    assert.equal(store.getApprovalCallback(approvalId).pin_verified, 1);
    const details = await (await post(decisionPath, { ...outbound, ...callbackDetailsInput() })).text();
    // XML escapes the Windows wrapper quotes while retaining the exact command body.
    assert.match(details, /git push/);
    assert.ok(details.includes(isCodex ? codexWorkspace : 'demo-repository'));
    assert.equal(store.getApproval(approvalId).state, 'pending');
    assert.deepEqual(decisions, [], 'details never authorize a command');
    for (const input of [{ Digits: '1', SpeechResult: 'Reject.' }, { Digits: '1', SpeechResult: '' },
      { Digits: '', SpeechResult: 'Approve.' }, { SpeechResult: 'Yes.' }, { SpeechResult: 'Push main.' },
      { SpeechResult: 'Approve, but only if the tests pass.' }]) {
      const rejected = await (await post(decisionPath, { ...outbound, ...input })).text();
      assert.match(rejected, /prepared changes|practice push|Extra permissions/i);
      assert.equal(store.getApproval(approvalId).state, 'pending', 'ambiguous or qualified speech must not authorize a command');
      assert.deepEqual(decisions, [], 'invalid speech must not reach the daemon');
    }
    const repeat = await (await post(decisionPath, { ...outbound, Digits: '' })).text();
    assert.match(repeat, additionalPermissions ? /Extra permissions/ : isCodex ? /prepared changes to the local demo branch/ : /practice push/);
    assert.equal(repeat.includes('git push'), additionalPermissions != null, 'no input returns to the default prompt');
    const result = await (await post(decisionPath, { ...outbound, ...callbackDecisionInput() })).text();
    assert.match(result, choice === '1' ? /Approved/ : /Rejected/);
    assert.equal(store.getApproval(approvalId).state, choice === '1' ? 'approved' : 'rejected');
    await waitFor(() => store.getTask(task.id).state === (choice === '1' ? 'completed' : 'failed'));
    assert.match(await (await post(decisionPath, { ...outbound, ...callbackDecisionInput() })).text(), /no longer available/);
    assert.equal(callbackRequests.length, 1);
    if (isCodex) {
      assert.deepEqual(decisions, [choice === '1' ? 'accept' : 'cancel']);
      assert.equal(fixture.remoteCommit(), choice === '1' ? fixture.expectedCommit : '',
        'only an authenticated approval moves the local destination ref');
      if (choice === '1') {
        const resultPath = `/approval/result?approvalId=${approvalId}&nonce=${nonce}`;
        assert.match(await (await post(resultPath, outbound)).text(), /published to the local demo branch/);
        assert.equal(store.getTask(task.id).result_text, 'Done. The prepared changes are published to the local demo branch.');
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
    if (fixture) {
      const parent = resolve(join(tmpdir(), 'dylamo-approval-rehearsals'));
      const target = resolve(fixture.directory);
      const suffix = relative(parent, target);
      if (!suffix.startsWith('approval-rehearsal-') || suffix.includes('..') || suffix.includes('/') || suffix.includes('\\')) {
        throw new Error('Unexpected cleanup target');
      }
      rmSync(target, { recursive: true, force: true });
    }
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

for (const choice of ['1', '2']) test(`callback speech ${choice === '1' ? 'approval' : 'rejection'} is PIN-bound and one-use`, () =>
  runApprovalFlow(choice, 'codex', undefined, 'Run the demo push.', 'callback', null, 'speech'));

test('callback accepts the explicit spoken demo-push phrase after PIN verification', () =>
  runApprovalFlow('1', 'codex', undefined, 'Run the demo push.', 'callback', null, 'speech-push'));

test('extra permission requests retain the full disclosure rather than a brief demo summary', () =>
  runApprovalFlow('1', 'codex', undefined, 'Run the demo push.', 'callback', { network: { enabled: true } }));

for (const failure of ['no-answer', 'busy', 'failed', 'canceled', 'voicemail', 'expired', 'callback-error']) {
  test(`callback ${failure} keeps the real request blocked without a repeated call`, () => runApprovalFlow('1', 'codex', failure));
}

for (const decisionMode of ['speech', 'keypad']) {
  for (const choice of ['1', '2']) test(`same-call ${decisionMode} ${choice === '1' ? 'approval' : 'rejection'} needs one PIN and no callback`, () =>
    runApprovalFlow(choice, 'codex', undefined, 'Run the demo push.', decisionMode));
  test(`expired same-call action cannot be approved by ${decisionMode}`, () =>
    runApprovalFlow('1', 'codex', 'expired-inline', 'Run the demo push.', decisionMode));
}
