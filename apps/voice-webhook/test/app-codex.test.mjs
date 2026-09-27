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

for (const multipleAgents of [false, true]) test(`Codex phone mode dispatches without task read-back (${multipleAgents ? 'agent menu' : 'single agent'})`, async () => {
  const machineId = randomUUID();
  const otherAgentId = randomUUID();
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
  const cancellations = [];
  const steers = [];
  const longResult = 'The repository contains a voice server, daemon, and shared protocol. '
    + 'The voice server authenticates calls and sends requests to the daemon. '
    + 'The daemon starts Codex and reports the result back through the protocol. '
    + 'I checked the package scripts and their test commands. '
    + 'The test suite ran 20 tests: 18 passed and 2 failed. '
    + 'The failures concern callback expiry and daemon reconnect behavior. '
    + 'Inspect those two cases before treating the test suite as green.';
  let bridge;
  const completeTask = (event, result = 'Repository inspected without changes.') => {
    const base = { v: 1, machineId, sessionId: event.sessionId, taskId: event.taskId, runId: event.runId };
    client.send({ ...base, eventId: randomUUID(), type: 'agent.message', text: result });
    client.send({ ...base, eventId: randomUUID(), type: 'task.completed', summary: result });
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
    steerAckMs: 25,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let client;
  client = createDaemonClient({
    serverUrl: origin.replace('http:', 'ws:') + '/daemon', machineId, token,
    name: 'Demo laptop', allowInsecureLoopback: true,
    agents: [{ agentId: CODEX_AGENT_ID, adapterType: 'codex', name: 'Codex Alpha', status: 'idle' },
      ...(multipleAgents ? [{ agentId: otherAgentId, adapterType: 'codex', name: 'Codex Beta', status: 'idle' }] : [])],
    onEvent: (event) => {
      if (event.type === 'task.steer') {
        steers.push(event);
        if (steers.length < 3) client.send({ v: 1, eventId: randomUUID(), machineId, sessionId: event.sessionId,
          taskId: event.taskId, runId: event.runId, type: 'task.steer.result',
          requestEventId: event.eventId, accepted: steers.length === 1 });
        return;
      }
      if (event.type === 'task.cancel') {
        cancellations.push(event);
        client.send({ v: 1, eventId: randomUUID(), machineId, sessionId: event.sessionId,
          taskId: event.taskId, runId: event.runId, type: 'task.cancelled', reason: 'Stopped by the caller.' });
        return;
      }
      if (event.type !== 'task.start') return;
      dispatched.push(event);
      client.send({ v: 1, eventId: randomUUID(), machineId, sessionId: event.sessionId,
        taskId: event.taskId, runId: event.runId, type: 'agent.started',
        codexThreadId: 'thread-test', codexTurnId: `turn-test-${dispatched.length}` });
      client.send({ v: 1, eventId: randomUUID(), machineId, sessionId: event.sessionId,
        taskId: event.taskId, runId: event.runId, type: 'agent.progress', text: 'Starting Codex.' });
      if (dispatched.length === 2) completeTask(event, longResult);
    },
  });
  let media;
  const pressKey = async (digit, track = 'inbound_track') => {
    media.send(JSON.stringify({ event: 'dtmf', streamSid, dtmf: { track, digit } }));
    // A pong after the event is a barrier for assertions about ignored keys.
    await new Promise(resolve => { media.once('pong', resolve); media.ping(); });
  };
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
    const beforeKeys = spoken.length;
    await pressKey('1');
    await pressKey('2');
    assert.equal(spoken.length, beforeKeys, 'inbound keys are not task requests');
    assert.equal(store.listTasksForSession(sessionId).length, 0);
    for (const text of ['Yes', 'Yes, that’s correct.', 'Yes, start it.', 'No.', 'Thank you', '']) {
      bridge.onTranscript(text);
      assert.equal(store.listTasksForSession(sessionId).length, 0, 'acknowledgments are not new tasks');
    }
    bridge.onTranscriptionFailure();
    assert.equal(store.listTasksForSession(sessionId).length, 0, 'transcription failure does not invent a task');
    bridge.onTranscript('Status?');
    assert.match(spoken.at(-1), /no Codex task running/);
    bridge.onSpeechStart();
    bridge.onTranscript('What packages are in this repo?');
    assert.equal(spoken.some(message => message.startsWith('I heard:')), false, 'no task read-back is spoken');
    if (multipleAgents) {
      assert.equal(store.listTasksForSession(sessionId).length, 0, 'multiple agents still require a target choice');
      assert.match(spoken.at(-1), /Option two/i);
      await pressKey('1');
      assert.equal(store.listTasksForSession(sessionId).length, 0, 'inbound keys cannot choose an agent');
      bridge.onTranscript('Yes connect.');
      assert.equal(store.listTasksForSession(sessionId).length, 0, 'confirmation without a choice does not dispatch');
      bridge.onTranscript('Select two.');
      assert.match(spoken.at(-1), /Codex Beta/i);
      await pressKey('1');
      assert.equal(store.listTasksForSession(sessionId).length, 0, 'keypad is not an agent-selection confirmation');
      bridge.onTranscript('Yes connect.');
    } else {
      assert.equal(store.listTasksForSession(sessionId).length, 1, 'the request itself immediately dispatches once');
    }
    await waitFor(() => store.listTasksForSession(sessionId).length === 1);
    const task = store.listTasksForSession(sessionId)[0];
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(spoken.some((message) => message.includes('still working on your request')), false,
      'automatic status must wait while the caller is speaking');
    client.send({ v: 1, eventId: randomUUID(), machineId, sessionId,
      taskId: task.id, runId: store.getRunForTask(task.id).id,
      type: 'agent.progress', text: 'Codex is checking a repository command.' });
    await waitFor(() => store.listAudit(sessionId).some((event) => event.type === 'agent.progress'));
    assert.equal(spoken.some((message) => message.includes('checking a repository command')), false,
      'progress must not speak over the caller');
    bridge.onSpeechStop();
    await waitFor(() => spoken.some((message) => message.includes('checking a repository command')));
    await waitFor(() => spoken.some((message) => message.includes('still working on your request')));
    const statusCount = spoken.filter((message) => message.includes('still working on your request')).length;
    bridge.onTranscript("What's the status?");
    await waitFor(() => spoken.filter((message) => message.includes('still working on your request')).length > statusCount);
    assert.equal(store.listTasksForSession(sessionId).length, 1, 'status question must not start a new task');
    bridge.onTranscript('Steer the task: focus on failing tests first.');
    assert.equal(steers.length, 0, 'a steering transcript alone cannot change the active turn');
    assert.match(spoken.at(-1), /focus on failing tests first/i);
    bridge.onTranscript('Yes, steer it.');
    await waitFor(() => steers.length === 1 && spoken.some(message => message.includes('Codex accepted your change')));
    assert.equal(steers[0].prompt, 'focus on failing tests first.');
    assert.equal(store.listTasksForSession(sessionId).length, 1, 'steering must not start a second task');
    bridge.onTranscript('Actually, check the callback code first.');
    bridge.onTranscript('Yes, steer it.');
    await waitFor(() => steers.length === 2 && spoken.some(message => message.includes('did not confirm that change')));
    bridge.onTranscript('Actually, check the README first.');
    bridge.onTranscript('No, keep working.');
    bridge.onTranscript('Actually, check the README first.');
    bridge.onTranscriptionFailure();
    bridge.onTranscript('Yes, steer it.');
    assert.equal(steers.length, 2, 'rejection and failed transcription clear steering drafts');
    bridge.onTranscript('Actually, check the test fixtures next.');
    bridge.onTranscript('Yes, steer it.');
    await waitFor(() => steers.length === 3 && spoken.some(message => message.includes('could not confirm whether Codex accepted')));
    assert.equal(store.listTasksForSession(sessionId).length, 1, 'unconfirmed steering cannot create a new task');
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
    assert.ok(spoken.some((message) => message.includes('Working on it.')));
    assert.ok(spoken.some((message) => message.includes('Repository inspected without changes')));
    assert.equal(run.codex_thread_id, 'thread-test');
    assert.equal(run.codex_turn_id, 'turn-test-1');
    assert.ok(store.listAudit(sessionId).some((event) => event.type === 'agent.started'));
    assert.equal(dispatched[0].codexThreadId, undefined);
    assert.equal(dispatched[0].agentId, multipleAgents ? otherAgentId : CODEX_AGENT_ID);
    bridge.onTranscript('What did you find in those packages?');
    assert.equal(store.listTasksForSession(sessionId).length, 2, 'a follow-up starts without a second utterance');
    await waitFor(() => store.listTasksForSession(sessionId).length === 2);
    const followUp = store.listTasksForSession(sessionId)[1];
    await waitFor(() => store.getTask(followUp.id).state === 'completed');
    assert.equal(store.getTask(followUp.id).result_text, longResult, 'the full answer remains in durable task history');
    assert.match(spoken.at(-1), /summary or details/i);
    assert.equal(spoken.includes(longResult), false, 'do not speak the long answer before the caller chooses');
    bridge.onTranscript('Status?');
    assert.match(spoken.at(-1), /Codex finished/i);
    bridge.onTranscript('Summary.');
    assert.match(spoken.at(-1), /18 passed and 2 failed/i);
    bridge.onTranscript('Details.');
    assert.match(spoken.at(-1), /Say continue/i);
    bridge.onTranscript('Continue.');
    assert.equal(store.listTasksForSession(sessionId).length, 2, 'answer controls do not start a Codex turn');
    assert.equal(followUp.prompt, 'What did you find in those packages?');
    assert.equal(dispatched[1].codexThreadId, 'thread-test');
    assert.equal(dispatched[1].machineId, dispatched[0].machineId);
    assert.equal(dispatched[1].agentId, dispatched[0].agentId);
    assert.equal(store.getRunForTask(followUp.id).codex_turn_id, 'turn-test-2');
    assert.equal(spoken.filter((message) => message.includes('Working on it.')).length, 1);
    assert.equal(spoken.filter((message) => message === 'Checking that now.').length, 1);
    bridge.onTranscript('Yes, that’s correct.');
    assert.equal(store.listTasksForSession(sessionId).length, 2, 'acknowledging an answer is not a task');
    bridge.onTranscript('Inspect the callback code.');
    assert.equal(store.listTasksForSession(sessionId).length, 3, 'the third request also dispatches immediately');
    await pressKey('1');
    await pressKey('1');
    await waitFor(() => store.listTasksForSession(sessionId).length === 3);
    const cancelledTask = store.listTasksForSession(sessionId)[2];
    assert.equal(cancelledTask.prompt, 'Inspect the callback code.');
    bridge.onTranscript('Cancel the current task.');
    await pressKey('1');
    assert.equal(cancellations.length, 0, 'a stop request alone cannot cancel a task');
    bridge.onTranscript('No, keep working.');
    assert.equal(cancellations.length, 0);
    bridge.onTranscript('Cancel the current task.');
    bridge.onTranscriptionFailure();
    bridge.onTranscript('Yes, stop it.');
    assert.equal(cancellations.length, 0, 'failed transcription clears the stop confirmation');
    bridge.onTranscript('Cancel the current task.');
    bridge.onTranscript('Yes, stop it.');
    await waitFor(() => store.getTask(cancelledTask.id).state === 'cancelled');
    assert.equal(cancellations.length, 1);
    assert.ok(spoken.some(message => message.includes('The task stopped')));
    bridge.onTranscript('Yes, stop it.');
    assert.equal(cancellations.length, 1, 'confirmation cannot be replayed');
    assert.equal(store.listTasksForSession(sessionId).length, 3);
    media.close();
    await new Promise(resolve => media.once('close', resolve));
    await waitFor(() => store.getCall(callSid).state === 'ended');
    bridge.onTranscript('Run the demo push.');
    assert.equal(store.listTasksForSession(sessionId).length, 3, 'late transcripts after hangup cannot dispatch tasks');
    const nextParams = { ...params, CallSid: `CA${'c'.repeat(32)}` };
    const nextStreamSid = `MZ${'d'.repeat(32)}`;
    assert.equal((await post('/voice', nextParams)).status, 200);
    const nextPin = await post('/voice/pin', { ...nextParams, Digits: '1234' });
    const nextToken = (await nextPin.text()).match(/name="token" value="([0-9a-f]+)"/)?.[1];
    assert.ok(nextToken);
    media = new WebSocket(origin.replace('http:', 'ws:') + '/media', { headers: {
      'x-twilio-signature': expectedTwilioSignature(authToken, 'wss://example.ngrok.app/media', {}),
    } });
    await new Promise((resolve, reject) => { media.once('open', resolve); media.once('error', reject); });
    media.send(JSON.stringify({ event: 'start', streamSid: nextStreamSid,
      start: { streamSid: nextStreamSid, accountSid, callSid: nextParams.CallSid, customParameters: { token: nextToken } } }));
    await waitFor(() => store.getCall(nextParams.CallSid).state === 'streaming');
    bridge.onTranscript('Status?');
    await waitFor(() => spoken.some((message) => message.includes('most recent task was stopped')));
    assert.equal(store.listTasksForSession(store.getCall(nextParams.CallSid).session_id).length, 0,
      'asking after reconnect must not dispatch another Codex task');
    bridge.onTranscript('Inspect the demo repository.');
    bridge.onTranscript('Status?');
    assert.match(spoken.at(-1), multipleAgents ? /Option two/i : /still working/i,
      'status during a new request must not replace it with old task history');
    assert.equal(store.listTasksForSession(store.getCall(nextParams.CallSid).session_id).length, multipleAgents ? 0 : 1);
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
