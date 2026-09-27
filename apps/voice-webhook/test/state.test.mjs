import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { databasePathFromUrl, openStateStore } from '../src/state.mjs';

const callSid = `CA${'1'.repeat(32)}`;
const phoneNumber = '+15065550123';

function withMemoryStore(run, clock = () => Date.now()) {
  const store = openStateStore(':memory:', { now: clock });
  try { return run(store); } finally { store.close(); }
}

test('file-backed calls and lockout survive reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hack-atlantic-state-'));
  const path = join(directory, 'state.db');
  try {
    const first = openStateStore(path);
    const user = first.ensureUser({ phoneNumber, pinHash: 'scrypt:test' });
    const { sessionId } = first.startInboundCall({ userId: user.id, callSid, phoneNumber });
    assert.ok(sessionId);
    assert.equal(first.startInboundCall({ userId: user.id, callSid, phoneNumber }).sessionId, sessionId);
    assert.equal(first.recordAuthFailure(phoneNumber), false);
    assert.equal(first.recordAuthFailure(phoneNumber), false);
    assert.equal(first.recordAuthFailure(phoneNumber), true);
    first.close();

    const second = openStateStore(path);
    try {
      assert.equal(second.getCall(callSid).session_id, sessionId);
      assert.equal(second.isAuthLocked(phoneNumber), true);
      const recovered = second.recoverAfterRestart();
      assert.equal(recovered.calls, 1);
      assert.equal(second.getCall(callSid).state, 'ended');
      assert.equal(second.getCall(callSid).ended_reason, 'server_restart');
      assert.throws(() => second.setCallState(callSid, 'streaming'), /invalid call transition/);
    } finally { second.close(); }
  } finally {
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()) + sep)) throw new Error('refusing to remove unexpected test directory');
    rmSync(target, { recursive: true, force: true });
  }
});

test('version one database upgrades to callback schema without losing calls', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hack-atlantic-upgrade-'));
  const path = join(directory, 'state.db');
  try {
    const first = openStateStore(path);
    const user = first.ensureUser({ phoneNumber, pinHash: 'scrypt:test' });
    first.startInboundCall({ userId: user.id, callSid, phoneNumber });
    first.close();
    const old = new DatabaseSync(path);
    old.exec('DROP TABLE approval_callbacks; ALTER TABLE tasks DROP COLUMN result_text; ALTER TABLE approvals DROP COLUMN permission_scope; PRAGMA user_version = 1;');
    old.close();
    const upgraded = openStateStore(path);
    try {
      assert.ok(upgraded.getCall(callSid));
      assert.equal(upgraded.getApprovalCallback(randomUUID()), undefined);
    } finally { upgraded.close(); }
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(check.prepare('PRAGMA user_version').get().user_version, 3);
      assert.ok(check.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'result_text'));
      assert.ok(check.prepare('PRAGMA table_info(approvals)').all().some(column => column.name === 'permission_scope'));
    } finally { check.close(); }
  } finally {
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()) + sep)) throw new Error('refusing to remove unexpected test directory');
    rmSync(target, { recursive: true, force: true });
  }
});

test('task and run states persist independently of a call ending', () => {
  withMemoryStore((store) => {
    const user = store.ensureUser({ phoneNumber, pinHash: 'scrypt:test' });
    const { sessionId } = store.startInboundCall({ userId: user.id, callSid, phoneNumber });
    const taskId = store.createTask({ sessionId, prompt: 'Run tests' });
    const runId = store.createRun({ taskId, agentId: randomUUID() });
    store.transitionTask(taskId, 'running');
    store.transitionRun(runId, 'running');
    store.setCallState(callSid, 'streaming');
    store.setCallState(callSid, 'ended', 'caller_hung_up');
    assert.equal(store.getTask(taskId).state, 'running');
    assert.equal(store.getRun(runId).state, 'running');
    assert.equal(store.getCall(callSid).state, 'ended');
  });
});

test('Codex thread and turn IDs are stored once on the assigned run', () => {
  withMemoryStore((store) => {
    const user = store.ensureUser({ phoneNumber, pinHash: 'scrypt:test' });
    const { sessionId } = store.startInboundCall({ userId: user.id, callSid, phoneNumber });
    const taskId = store.createTask({ sessionId, prompt: 'Inspect repository' });
    const runId = store.createRun({ taskId, agentId: randomUUID() });
    store.transitionRun(runId, 'running');
    store.setCodexRunIds(runId, 'thread-test', 'turn-test');
    assert.equal(store.getRun(runId).codex_thread_id, 'thread-test');
    assert.equal(store.getRun(runId).codex_turn_id, 'turn-test');
    assert.throws(() => store.setCodexRunIds(runId, 'other', 'other'), /cannot be assigned/);
  });
});

test('approval is exact, one-shot, and audited without the command text', () => {
  withMemoryStore((store) => {
    const user = store.ensureUser({ phoneNumber, pinHash: 'scrypt:test' });
    const { sessionId } = store.startInboundCall({ userId: user.id, callSid, phoneNumber });
    const taskId = store.createTask({ sessionId, prompt: 'Push demo' });
    const runId = store.createRun({ taskId, agentId: randomUUID() });
    const actionDigest = 'a'.repeat(64);
    store.transitionTask(taskId, 'running');
    store.transitionRun(runId, 'running');
    store.transitionTask(taskId, 'waiting_human');
    store.transitionRun(runId, 'waiting_human');
    const approvalId = store.createApproval({ runId, actionDigest, command: 'git push secret', cwd: 'C:\\demo', expiresAt: Date.now() + 60_000 });
    assert.equal(store.decideApproval({ approvalId, runId, actionDigest: 'b'.repeat(64), userId: user.id, approved: true }), false);
    assert.equal(store.getApproval(approvalId).state, 'pending');
    assert.equal(store.decideApproval({ approvalId, runId, actionDigest, userId: user.id, approved: true }), true);
    assert.equal(store.decideApproval({ approvalId, runId, actionDigest, userId: user.id, approved: true }), false);
    assert.equal(store.getApproval(approvalId).state, 'approved');
    assert.equal(store.listAudit(sessionId).length, 1);
    assert.doesNotMatch(store.listAudit(sessionId)[0].payload, /git push secret/);
  });
});

test('expired approval cannot be approved', () => {
  let time = 1_000;
  withMemoryStore((store) => {
    const user = store.ensureUser({ phoneNumber, pinHash: 'scrypt:test' });
    const { sessionId } = store.startInboundCall({ userId: user.id, callSid, phoneNumber });
    const taskId = store.createTask({ sessionId, prompt: 'Do work' });
    const runId = store.createRun({ taskId, agentId: randomUUID() });
    const actionDigest = 'f'.repeat(64);
    store.transitionTask(taskId, 'running');
    store.transitionRun(runId, 'running');
    store.transitionTask(taskId, 'waiting_human');
    store.transitionRun(runId, 'waiting_human');
    const approvalId = store.createApproval({ runId, actionDigest, command: 'deploy', cwd: '/demo', expiresAt: 2_000 });
    time = 2_001;
    assert.equal(store.decideApproval({ approvalId, runId, actionDigest, userId: user.id, approved: true }), false);
    assert.equal(store.getApproval(approvalId).state, 'expired');
  }, () => time);
});

test('callback status is bound to its nonce and SID and cannot reopen after a late REST reply', () => {
  withMemoryStore(store => {
    const user = store.ensureUser({ phoneNumber, pinHash: 'scrypt:test' });
    const { sessionId } = store.startInboundCall({ userId: user.id, callSid, phoneNumber });
    const taskId = store.createTask({ sessionId, prompt: 'Push demo' });
    const runId = store.createRun({ taskId, agentId: randomUUID() });
    store.transitionTask(taskId, 'running');
    store.transitionRun(runId, 'running');
    store.transitionTask(taskId, 'waiting_human');
    store.transitionRun(runId, 'waiting_human');
    const approvalId = store.createApproval({ runId, actionDigest: 'e'.repeat(64),
      command: 'git push origin phone-demo', cwd: '/demo', expiresAt: Date.now() + 60000 });
    const { nonce } = store.prepareApprovalCallback(approvalId);
    const callbackSid = `CA${'c'.repeat(32)}`;
    const status = { approvalId, nonce, callSid: callbackSid, status: 'no-answer' };
    assert.equal(store.recordApprovalCallEnd({ ...status, nonce: 'wrong' }), false);
    assert.equal(store.recordApprovalCallEnd({ ...status, status: 'ringing' }), false);
    assert.equal(store.getCall(callbackSid), undefined);
    assert.equal(store.recordApprovalCallEnd(status), true, 'status may arrive before the REST create response');
    assert.equal(store.getCall(callbackSid).ended_reason, 'callback_no_answer');
    store.markApprovalCallbackDialed(approvalId, callbackSid); // Delayed successful REST create response.
    assert.equal(store.getApprovalCallback(approvalId).state, 'failed');
    assert.equal(store.bindApprovalCallback(approvalId, nonce, callbackSid), false);
    assert.equal(store.verifyApprovalCallbackPin(approvalId, callbackSid), false);
    assert.equal(store.recordApprovalCallEnd({ ...status, callSid: `CA${'d'.repeat(32)}` }), false);
    assert.equal(store.recordApprovalCallEnd(status), false);
    assert.equal(store.getApproval(approvalId).state, 'pending', 'call completion never decides the protected action');
    assert.equal(store.getTask(taskId).state, 'waiting_human');
    assert.equal(store.listAudit(sessionId).filter(row => row.type === 'callback.ended').length, 1);
  });
});

test('event IDs dedupe atomically and roll back on failure', () => {
  withMemoryStore((store) => {
    const event = { eventId: randomUUID(), machineId: randomUUID(), type: 'agent.progress' };
    let effects = 0;
    assert.equal(store.applyEventOnce(event, () => { effects += 1; }), true);
    assert.equal(store.applyEventOnce(event, () => { effects += 1; }), false);
    assert.equal(effects, 1);
    const failed = { ...event, eventId: randomUUID() };
    assert.throws(() => store.applyEventOnce(failed, () => { throw new Error('side effect failed'); }), /side effect failed/);
    assert.equal(store.applyEventOnce(failed, () => { effects += 1; }), true);
  });
});

test('database URL is restricted to a local file', () => {
  assert.equal(databasePathFromUrl(':memory:'), ':memory:');
  assert.throws(() => databasePathFromUrl('https://example.com/db'), /file:/);
  assert.throws(() => databasePathFromUrl('file://remote/share'), /local file/);
});

test('reconnect fails only lost pre-connection runs and expires their pending approvals', () => {
  withMemoryStore(store => {
    const user = store.ensureUser({ phoneNumber, pinHash: 'scrypt:test' });
    const machineId = randomUUID();
    const agentId = randomUUID();
    store.ensureMachine({ machineId, userId: user.id, tokenHash: '0'.repeat(64) });
    const { sessionId } = store.startInboundCall({ userId: user.id, callSid, phoneNumber });
    store.assignSessionAgent(sessionId, machineId, agentId);
    const newRun = () => {
      const taskId = store.createTask({ sessionId, prompt: 'Inspect demo' });
      const runId = store.createRun({ taskId, agentId });
      store.transitionTask(taskId, 'running');
      store.transitionRun(runId, 'running');
      return { taskId, runId };
    };
    const lost = newRun();
    const alive = newRun();
    const completed = newRun();
    store.transitionTask(lost.taskId, 'waiting_human');
    store.transitionRun(lost.runId, 'waiting_human');
    const approvalId = store.createApproval({ runId: lost.runId, actionDigest: 'e'.repeat(64),
      command: 'git push origin phone-demo', cwd: '/demo', expiresAt: Date.now() + 60000 });
    const candidates = store.unfinishedRunsForMachine(machineId).map(run => run.runId);
    const fresh = newRun(); // Dispatched after registration; not in the snapshot candidates.
    store.setTaskResult(completed.taskId, 'Already complete.');
    store.transitionTask(completed.taskId, 'completed');
    store.transitionRun(completed.runId, 'completed'); // Replayed final event arrives before snapshot.
    const interrupted = store.reconcileMachineRuns(machineId, [alive.runId], candidates);
    assert.deepEqual(interrupted.map(run => run.runId), [lost.runId]);
    assert.equal(store.getTask(lost.taskId).state, 'failed');
    assert.match(store.getTask(lost.taskId).result_text, /uncertain/);
    assert.equal(store.getApproval(approvalId).state, 'expired');
    assert.equal(store.getTask(alive.taskId).state, 'running');
    assert.equal(store.getTask(fresh.taskId).state, 'running');
    assert.equal(store.getTask(completed.taskId).result_text, 'Already complete.');
    assert.deepEqual(store.reconcileMachineRuns(machineId, [alive.runId], candidates), []);
  });
});
