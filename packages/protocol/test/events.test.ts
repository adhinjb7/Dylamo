import assert from 'node:assert/strict';
import test from 'node:test';
import { DaemonEvent, ServerEvent, PROTOCOL_VERSION, matchesPendingApproval } from '../src/index.js';

const machineId = '00000000-0000-4000-8000-000000000001';
const sessionId = '00000000-0000-4000-8000-000000000002';
const taskId = '00000000-0000-4000-8000-000000000003';
const runId = '00000000-0000-4000-8000-000000000004';
const approvalId = '00000000-0000-4000-8000-000000000005';
const eventId = '00000000-0000-4000-8000-000000000006';
const actionDigest = 'a'.repeat(64);
const common = { v: PROTOCOL_VERSION, eventId, machineId };
const run = { sessionId, taskId, runId };

test('accepts a versioned registration without credentials in the payload', () => {
  const result = DaemonEvent.parse({ ...common, type: 'machine.register', name: 'Demo laptop', agents: [] });
  assert.equal(result.type, 'machine.register');
  assert.equal(DaemonEvent.safeParse({ ...result, token: 'must-not-travel-in-event' }).success, false);
});

test('requires correlation IDs on run events and rejects unknown versions', () => {
  const message = { ...common, ...run, type: 'agent.progress', text: 'Tests are running' };
  assert.equal(DaemonEvent.safeParse(message).success, true);
  assert.equal(DaemonEvent.safeParse({ ...message, taskId: undefined }).success, false);
  assert.equal(DaemonEvent.safeParse({ ...message, v: 2 }).success, false);
});

test('Codex run identity requires both thread and turn IDs', () => {
  const started = { ...common, ...run, type: 'agent.started', codexThreadId: 'thread-1', codexTurnId: 'turn-1' };
  assert.equal(DaemonEvent.safeParse(started).success, true);
  assert.equal(DaemonEvent.safeParse({ ...started, codexTurnId: '' }).success, false);
});

test('task start may carry a validated Codex continuation thread ID', () => {
  const start = { ...common, ...run, type: 'task.start', agentId: machineId, prompt: 'Follow up' };
  assert.equal(ServerEvent.safeParse(start).success, true);
  assert.equal(ServerEvent.safeParse({ ...start, codexThreadId: 'thread-1' }).success, true);
  assert.equal(ServerEvent.safeParse({ ...start, codexThreadId: '' }).success, false);
});

test('approval requests and responses bind to the exact action digest', () => {
  const request = {
    ...common, ...run, type: 'approval.required', approvalId, actionDigest,
    command: 'git push origin demo', cwd: 'C:\\demo', expiresAt: '2026-09-26T16:00:00.000Z',
  };
  const response = { ...common, ...run, type: 'approval.response', approvalId, actionDigest, approved: true };
  assert.equal(DaemonEvent.safeParse(request).success, true);
  assert.equal(ServerEvent.safeParse(response).success, true);
  assert.equal(ServerEvent.safeParse({ ...response, actionDigest: 'bad' }).success, false);
  assert.equal(ServerEvent.safeParse({ ...response, approved: 'yes' }).success, false);

  const parsedRequest = DaemonEvent.parse(request);
  const parsedResponse = ServerEvent.parse(response);
  assert.equal(parsedRequest.type, 'approval.required');
  assert.equal(parsedResponse.type, 'approval.response');
  if (parsedRequest.type !== 'approval.required' || parsedResponse.type !== 'approval.response') return;
  assert.equal(matchesPendingApproval(parsedRequest, parsedResponse), true);
  assert.equal(matchesPendingApproval(parsedRequest, { ...parsedResponse, runId: eventId }), false);
  assert.equal(matchesPendingApproval(parsedRequest, { ...parsedResponse, actionDigest: 'b'.repeat(64) }), false);
});
