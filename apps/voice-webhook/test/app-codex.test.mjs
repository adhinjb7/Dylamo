import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import WebSocket from 'ws';
import { createDaemonClient } from '../../daemon/src/client.mjs';
import { CODEX_AGENT_ID } from '../../daemon/src/codex-agent.mjs';
import { createServer } from '../src/app.mjs';
import { hashPin } from '../src/pin.mjs';
import { expectedTwilioSignature } from '../src/signature.mjs';
import { openStateStore } from '../src/state.mjs';

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for Codex task');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('Codex phone mode routes to the real-agent slot and persists thread/turn IDs', async () => {
  const machineId = randomUUID();
  const token = 'test-only-codex-machine-token-with-enough-length';
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
    callbackCallerNumber: '+15065550124',
    pinHash: hashPin('1234', Buffer.alloc(16, 3)), voiceMode: 'realtime', agentMode: 'codex',
    openAiApiKey: 'test-key', stateStore: store,
    daemonCredentials: new Map([[machineId, createHash('sha256').update(token).digest('hex')]]),
    realtimeConnector: (options) => {
      bridge = options;
      return { appendAudio() {}, acknowledgeMark() {}, close() {}, speak: (message) => { spoken.push(message); return true; } };
    },
    callbackCreator: () => { throw new Error('Codex read-only mode must not call out'); },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let client;
  client = createDaemonClient({
    serverUrl: origin.replace('http:', 'ws:') + '/daemon', machineId, token,
    name: 'Demo laptop', allowInsecureLoopback: true,
    agents: [{ agentId: CODEX_AGENT_ID, adapterType: 'codex', name: 'Codex read-only agent', status: 'idle' }],
    onEvent: (event) => {
      if (event.type !== 'task.start') return;
      const base = { v: 1, machineId, sessionId: event.sessionId, taskId: event.taskId, runId: event.runId };
      client.send({ ...base, eventId: randomUUID(), type: 'agent.started', codexThreadId: 'thread-test', codexTurnId: 'turn-test' });
      client.send({ ...base, eventId: randomUUID(), type: 'agent.message', text: 'I inspected the test repository.' });
      client.send({ ...base, eventId: randomUUID(), type: 'task.completed', summary: 'Repository inspected without changes.' });
    },
  });
  let media;
  try {
    client.start();
    await waitFor(() => store.getMachine(machineId)?.status === 'online');
    const params = { AccountSid: accountSid, From: caller, CallSid: callSid };
    const post = (path, body) => fetch(`${origin}${path}`, { method: 'POST', headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': expectedTwilioSignature(authToken, `${publicBaseUrl}${path}`, body),
    }, body: new URLSearchParams(body) });
    assert.equal((await post('/voice', params)).status, 200);
    const pinResponse = await post('/voice/pin', { ...params, Digits: '1234' });
    const streamToken = (await pinResponse.text()).match(/name="token" value="([0-9a-f]+)"/)?.[1];
    assert.ok(streamToken);
    media = new WebSocket(origin.replace('http:', 'ws:') + '/media', { headers: {
      'x-twilio-signature': expectedTwilioSignature(authToken, 'wss://example.ngrok.app/media', {}),
    } });
    await new Promise((resolve, reject) => { media.once('open', resolve); media.once('error', reject); });
    media.send(JSON.stringify({ event: 'start', streamSid,
      start: { streamSid, accountSid, callSid, customParameters: { token: streamToken } } }));
    await waitFor(() => bridge !== undefined && store.getCall(callSid).state === 'streaming');
    assert.equal(bridge.controlled, true);
    bridge.onTranscript('What packages are in this repo?');
    const sessionId = store.getCall(callSid).session_id;
    await waitFor(() => store.listTasksForSession(sessionId).length === 1);
    const task = store.listTasksForSession(sessionId)[0];
    await waitFor(() => store.getTask(task.id).state === 'completed');
    const run = store.getRunForTask(task.id);
    assert.equal(task.prompt, 'What packages are in this repo?');
    assert.ok(spoken.some((message) => message.includes('real Codex task')));
    assert.ok(spoken.some((message) => message.includes('inspected the test repository')));
    assert.equal(run.codex_thread_id, 'thread-test');
    assert.equal(run.codex_turn_id, 'turn-test');
    assert.ok(store.listAudit(sessionId).some((event) => event.type === 'agent.started'));
  } finally {
    if (media && media.readyState === WebSocket.OPEN) {
      media.close();
      await new Promise((resolve) => media.once('close', resolve));
    }
    client.stop();
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});
