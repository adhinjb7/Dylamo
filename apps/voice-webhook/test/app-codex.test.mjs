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
  const dispatched = [];
  let bridge;
  const completeTask = (event) => {
    const base = { v: 1, machineId, sessionId: event.sessionId, taskId: event.taskId, runId: event.runId };
    client.send({ ...base, eventId: randomUUID(), type: 'agent.started', codexThreadId: 'thread-test', codexTurnId: `turn-test-${dispatched.length}` });
    client.send({ ...base, eventId: randomUUID(), type: 'agent.message', text: 'I inspected the test repository.' });
    client.send({ ...base, eventId: randomUUID(), type: 'task.completed', summary: 'Repository inspected without changes.' });
  };
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
    statusTiming: { firstMs: 20, repeatMs: 50, retryMs: 20 },
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
      dispatched.push(event);
      client.send({ v: 1, eventId: randomUUID(), machineId, sessionId: event.sessionId,
        taskId: event.taskId, runId: event.runId, type: 'agent.progress', text: 'Starting Codex.' });
      if (dispatched.length > 1) completeTask(event);
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
    bridge.onTranscript('Hi!');
    await waitFor(() => spoken.some((message) => message.startsWith('Hi!')));
    const sessionId = store.getCall(callSid).session_id;
    assert.equal(store.listTasksForSession(sessionId).length, 0, 'a greeting must not start Codex');
    bridge.onTranscript('Randh denopush.');
    assert.ok(spoken.at(-1).includes('Randh denopush.'), 'read back the actual transcript, not a guessed command');
    assert.equal(store.listTasksForSession(sessionId).length, 0, 'read-back alone must not start Codex');
    bridge.onTranscript('No.');
    assert.match(spoken.at(-1), /discarded/i);
    bridge.onTranscript('Yes, start it.');
    assert.equal(store.listTasksForSession(sessionId).length, 0, 'a discarded request cannot be confirmed');
    bridge.onTranscript('Run the demo push.');
    bridge.onTranscriptionFailure();
    bridge.onTranscript('Yes, start it.');
    assert.equal(store.listTasksForSession(sessionId).length, 0, 'a failed correction cannot leave an old request confirmable');
    bridge.onSpeechStart();
    bridge.onTranscript('What packages are in this repo?');
    assert.ok(spoken.at(-1).includes('What packages are in this repo?'));
    assert.equal(store.listTasksForSession(sessionId).length, 0);
    bridge.onTranscript('Yes, start it.');
    await waitFor(() => store.listTasksForSession(sessionId).length === 1);
    const task = store.listTasksForSession(sessionId)[0];
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(spoken.some((message) => message.includes('still working on your request')), false,
      'automatic status must wait while the caller is speaking');
    bridge.onSpeechStop();
    await waitFor(() => spoken.some((message) => message.includes('still working on your request')));
    const statusCount = spoken.filter((message) => message.includes('still working on your request')).length;
    bridge.onTranscript("What's the status?");
    await waitFor(() => spoken.filter((message) => message.includes('still working on your request')).length > statusCount);
    assert.equal(store.listTasksForSession(sessionId).length, 1, 'status question must not start a new task');
    completeTask(dispatched[0]);
    await waitFor(() => store.getTask(task.id).state === 'completed');
    const completedStatusCount = spoken.filter((message) => message.includes('still working on your request')).length;
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(spoken.filter((message) => message.includes('still working on your request')).length,
      completedStatusCount, 'status timer must stop when the task completes');
    bridge.onTranscript('Status?');
    await waitFor(() => spoken.some((message) => message.includes('no Codex task running')));
    assert.equal(store.listTasksForSession(sessionId).length, 1);
    const run = store.getRunForTask(task.id);
    assert.equal(task.prompt, 'What packages are in this repo?');
    assert.ok(spoken.some((message) => message.includes('I started that request')));
    assert.ok(spoken.some((message) => message.includes('inspected the test repository')));
    assert.equal(run.codex_thread_id, 'thread-test');
    assert.equal(run.codex_turn_id, 'turn-test-1');
    assert.ok(store.listAudit(sessionId).some((event) => event.type === 'agent.started'));
    assert.equal(dispatched[0].codexThreadId, undefined);
    bridge.onTranscript('What did you find in those packages?');
    assert.equal(store.listTasksForSession(sessionId).length, 1, 'follow-ups need their own transcript confirmation');
    bridge.onTranscript('Yes, start it.');
    await waitFor(() => store.listTasksForSession(sessionId).length === 2);
    const followUp = store.listTasksForSession(sessionId)[1];
    await waitFor(() => store.getTask(followUp.id).state === 'completed');
    assert.equal(followUp.prompt, 'What did you find in those packages?');
    assert.equal(dispatched[1].codexThreadId, 'thread-test');
    assert.equal(dispatched[1].machineId, dispatched[0].machineId);
    assert.equal(dispatched[1].agentId, dispatched[0].agentId);
    assert.equal(store.getRunForTask(followUp.id).codex_turn_id, 'turn-test-2');
    assert.equal(spoken.filter((message) => message.includes('I started that request')).length, 1);
    assert.equal(spoken.filter((message) => message === 'Checking that now.').length, 1);
    bridge.onTranscript('Run the demo push.');
    assert.equal(store.listTasksForSession(sessionId).length, 2);
    media.close();
    await new Promise(resolve => media.once('close', resolve));
    await waitFor(() => store.getCall(callSid).state === 'ended');
    bridge.onTranscript('Yes, start it.');
    assert.equal(store.listTasksForSession(sessionId).length, 2, 'hangup discards the unconfirmed draft, even with a late transcript');
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
