import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import WebSocket from 'ws';
import { createDaemonClient } from '../../daemon/src/client.mjs';
import { createFakeAgent, FAKE_AGENT_ID } from '../../daemon/src/fake-agent.mjs';
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

async function runApprovalFlow(choice) {
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
  const store = openStateStore(':memory:');
  const callbackRequests = [];
  let bridge;
  const server = createServer({
    authToken, accountSid, publicBaseUrl, allowedCallerNumber: caller,
    callbackCallerNumber: twilioNumber,
    pinHash: hashPin('1234', Buffer.alloc(16, 4)), voiceMode: 'realtime', agentMode: 'fake',
    openAiApiKey: 'test-key', stateStore: store,
    daemonCredentials: new Map([[machineId, createHash('sha256').update(machineToken).digest('hex')]]),
    callbackCreator: async (request) => { callbackRequests.push(request); return callbackSid; },
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
    agents: [{ agentId: FAKE_AGENT_ID, adapterType: 'fake', name: 'Demo fake agent', status: 'idle' }],
    onEvent: (event) => fake.receive(event),
    onStatus: (state) => { if (state === 'online') fake.flush(); },
  });
  fake = createFakeAgent({ machineId, send: (event) => client.send(event), delayMs: 60 });
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
    bridge.onTranscript('Push the demo branch.');
    media.close();
    await new Promise((resolve) => media.once('close', resolve));
    await waitFor(() => callbackRequests.length === 1);
    const sessionId = store.getCall(inboundSid).session_id;
    const task = store.listTasksForSession(sessionId)[0];
    await waitFor(() => store.getTask(task.id).state === 'waiting_human');
    const callbackUrl = new URL(callbackRequests[0].url);
    const callbackPath = callbackUrl.pathname + callbackUrl.search;
    const approvalId = callbackUrl.searchParams.get('approvalId');
    const nonce = callbackUrl.searchParams.get('nonce');
    await waitFor(() => store.getApprovalCallback(approvalId)?.call_sid === callbackSid);
    assert.equal(callbackRequests[0].to, caller);
    assert.equal(callbackRequests[0].from, twilioNumber);
    const outbound = { AccountSid: accountSid, From: twilioNumber, To: caller,
      CallSid: callbackSid, Direction: 'outbound-api' };
    const decisionPath = `/approval/decision?approvalId=${approvalId}&nonce=${nonce}`;
    assert.match(await (await post(decisionPath, { ...outbound, Digits: choice })).text(), /<Hangup\/>/);
    assert.equal(store.getApproval(approvalId).state, 'pending');
    const wrongSid = { ...outbound, CallSid: `CA${'d'.repeat(32)}` };
    assert.match(await (await post(callbackPath, wrongSid)).text(), /<Hangup\/>/);
    assert.match(await (await post(callbackPath, outbound)).text(), /Enter your four digit PIN/);
    const pinPath = `/approval/pin?approvalId=${approvalId}&nonce=${nonce}`;
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
