import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createFakeAgent, FAKE_AGENT_ID } from '../src/fake-agent.mjs';

test('fake agent completes a deterministic task without executing commands', () => {
  const sent = [];
  let finish;
  const agent = createFakeAgent({
    machineId: randomUUID(), send: (event) => { sent.push(event); return true; },
    setTimer: (callback) => { finish = callback; return 1; },
    clearTimer: () => {},
  });
  const start = {
    type: 'task.start', agentId: FAKE_AGENT_ID,
    sessionId: randomUUID(), taskId: randomUUID(), runId: randomUUID(),
    prompt: 'Please edit the repository',
  };
  try {
    assert.equal(agent.receive(start), true);
    assert.equal(agent.receive(start), false);
    assert.deepEqual(sent.map((event) => event.type), ['agent.progress']);
    finish();
    assert.deepEqual(sent.map((event) => event.type), ['agent.progress', 'agent.message', 'task.completed']);
    assert.equal(sent[2].summary, 'Simulated check complete; no files changed.');
    assert.equal(agent.pendingCount(), 0);
  } finally { agent.stop(); }
});

test('fake agent holds events while disconnected and flushes on reconnect', () => {
  const sent = [];
  let online = false;
  let finish;
  const agent = createFakeAgent({
    machineId: randomUUID(), send: (event) => { if (!online) return false; sent.push(event); return true; },
    setTimer: (callback) => { finish = callback; return 1; },
    clearTimer: () => {},
  });
  try {
    agent.receive({ type: 'task.start', agentId: FAKE_AGENT_ID, sessionId: randomUUID(), taskId: randomUUID(), runId: randomUUID(), prompt: 'test' });
    finish();
    assert.equal(agent.pendingCount(), 3);
    online = true;
    agent.flush();
    assert.deepEqual(sent.map((event) => event.type), ['agent.progress', 'agent.message', 'task.completed']);
  } finally { agent.stop(); }
});

test('fake protected action requires an exact, one-shot approval', () => {
  const sent = [];
  const timers = [];
  const machineId = randomUUID();
  const agent = createFakeAgent({
    machineId, send: (event) => { sent.push(event); return true; },
    setTimer: (callback) => { timers.push(callback); return timers.length; },
    clearTimer: () => {},
  });
  try {
    const start = { type: 'task.start', agentId: FAKE_AGENT_ID, scenario: 'approval',
      sessionId: randomUUID(), taskId: randomUUID(), runId: randomUUID(), prompt: 'Push demo' };
    assert.equal(agent.receive(start), true);
    timers[0]();
    const request = sent.find((event) => event.type === 'approval.required');
    assert.ok(request);
    assert.equal(sent.some((event) => event.type === 'task.completed'), false);
    const exact = { v: 1, eventId: randomUUID(), machineId,
      sessionId: start.sessionId, taskId: start.taskId, runId: start.runId,
      type: 'approval.response', approvalId: request.approvalId,
      actionDigest: request.actionDigest, approved: true };
    assert.equal(agent.receive({ ...exact, actionDigest: '0'.repeat(64) }), false);
    assert.equal(agent.receive({ ...exact, runId: randomUUID() }), false);
    assert.equal(agent.receive(exact), true);
    assert.equal(agent.receive({ ...exact, eventId: randomUUID() }), false);
    assert.deepEqual(sent.map((event) => event.type), ['agent.progress', 'approval.required', 'agent.message', 'task.completed']);
  } finally { agent.stop(); }
});

test('rejection leaves the fake protected action unexecuted', () => {
  const sent = [];
  const timers = [];
  const machineId = randomUUID();
  const agent = createFakeAgent({ machineId,
    send: (event) => { sent.push(event); return true; },
    setTimer: (callback) => { timers.push(callback); return timers.length; }, clearTimer: () => {} });
  try {
    const start = { type: 'task.start', agentId: FAKE_AGENT_ID, scenario: 'approval',
      sessionId: randomUUID(), taskId: randomUUID(), runId: randomUUID(), prompt: 'Push demo' };
    agent.receive(start);
    timers[0]();
    const request = sent.find((event) => event.type === 'approval.required');
    assert.equal(agent.receive({ ...request, type: 'approval.response', eventId: randomUUID(), approved: false }), true);
    assert.equal(sent.at(-1).type, 'task.failed');
    assert.equal(sent.some((event) => event.type === 'task.completed'), false);
  } finally { agent.stop(); }
});
