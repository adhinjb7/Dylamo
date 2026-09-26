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
    if (Date.now() > deadline) throw new Error('timed out waiting for fake task');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('phone transcript dispatches fake task that completes after hangup', async () => {
  const machineId = randomUUID();
  const token = 'test-only-fake-agent-machine-token-with-enough-length';
  const authToken = 'test-auth-token';
  const accountSid = `AC${'0'.repeat(32)}`;
  const caller = '+15065550123';
  const publicBaseUrl = 'https://example.ngrok.app';
  const callSid = `CA${'a'.repeat(32)}`;
  const streamSid = `MZ${'b'.repeat(32)}`;
  const store = openStateStore(':memory:');
  const spoken = [];
  let bridge;
  const server = createServer({
    authToken, accountSid, publicBaseUrl, allowedCallerNumber: caller,
    pinHash: hashPin('1234', Buffer.alloc(16, 3)), voiceMode: 'realtime', agentMode: 'fake',
    openAiApiKey: 'test-key', stateStore: store,
    daemonCredentials: new Map([[machineId, createHash('sha256').update(token).digest('hex')]]),
    realtimeConnector: (options) => {
      bridge = options;
      return { appendAudio() {}, acknowledgeMark() {}, close() {}, speak: (message) => { spoken.push(message); return true; } };
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let fake;
  const client = createDaemonClient({
    serverUrl: origin.replace('http:', 'ws:') + '/daemon', machineId, token,
    name: 'Demo laptop', allowInsecureLoopback: true,
    agents: [{ agentId: FAKE_AGENT_ID, adapterType: 'fake', name: 'Demo fake agent', status: 'idle' }],
    onEvent: (event) => fake.receive(event),
    onStatus: (state) => { if (state === 'online') fake.flush(); },
  });
  fake = createFakeAgent({ machineId, send: (event) => client.send(event), delayMs: 150 });
  let media;
  try {
    client.start();
    await waitFor(() => store.getMachine(machineId)?.status === 'online');
    const params = { AccountSid: accountSid, From: caller, CallSid: callSid };
    const post = (path, body) => fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': expectedTwilioSignature(authToken, `${publicBaseUrl}${path}`, body),
      },
      body: new URLSearchParams(body),
    });
    assert.equal((await post('/voice', params)).status, 200);
    const pinResponse = await post('/voice/pin', { ...params, Digits: '1234' });
    const streamToken = (await pinResponse.text()).match(/name="token" value="([0-9a-f]+)"/)?.[1];
    assert.ok(streamToken);
    media = new WebSocket(origin.replace('http:', 'ws:') + '/media', {
      headers: { 'x-twilio-signature': expectedTwilioSignature(authToken, 'wss://example.ngrok.app/media', {}) },
    });
    await new Promise((resolve, reject) => { media.once('open', resolve); media.once('error', reject); });
    media.send(JSON.stringify({
      event: 'start', streamSid,
      start: { streamSid, accountSid, callSid, customParameters: { token: streamToken } },
    }));
    await waitFor(() => bridge !== undefined && store.getCall(callSid).state === 'streaming');
    assert.equal(bridge.controlled, true);
    bridge.onTranscript('Please review the demo repository.');
    bridge.onTranscript('Duplicate transcript.');
    const sessionId = store.getCall(callSid).session_id;
    await waitFor(() => store.listTasksForSession(sessionId).length === 1);
    const task = store.listTasksForSession(sessionId)[0];
    assert.equal(task.prompt, 'Please review the demo repository.');
    await waitFor(() => store.getTask(task.id).state === 'running');
    media.close();
    await new Promise((resolve) => media.once('close', resolve));
    await waitFor(() => store.getCall(callSid).state === 'ended');
    await waitFor(() => store.getTask(task.id).state === 'completed');
    assert.equal(store.getSession(sessionId).state, 'active');
    assert.ok(spoken.some((message) => message.includes('simulated task')));
    assert.equal(spoken.some((message) => message.includes('simulated check is complete')), false);
  } finally {
    media?.close();
    fake.stop();
    client.stop();
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});
