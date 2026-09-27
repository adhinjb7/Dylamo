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
    const taskId = first.createTask({ sessionId, prompt: 'Run the demo push.' });
    const runId = first.createRun({ taskId, agentId: randomUUID() });
    const approvalId = first.createApproval({ runId, actionDigest: 'a'.repeat(64),
      command: 'git push origin HEAD:refs/heads/phone-demo', cwd: '/fixture', expiresAt: Date.now() + 60000 });
    first.audit(sessionId, 'approval.required', { approvalId: randomUUID(), actionKind: 'local-demo-push' });
    assert.equal(first.getApprovalContext(approvalId).action_kind, null, 'another approval cannot supply this description');
    first.audit(sessionId, 'approval.required', { approvalId, actionKind: 'local-demo-push' });
    assert.equal(first.startInboundCall({ userId: user.id, callSid, phoneNumber }).sessionId, sessionId);
    assert.equal(first.recordAuthFailure(phoneNumber), false);
    assert.equal(first.recordAuthFailure(phoneNumber), false);
    assert.equal(first.recordAuthFailure(phoneNumber), true);
    first.close();

    const second = openStateStore(path);
    try {
      assert.equal(second.getCall(callSid).session_id, sessionId);
      assert.equal(second.isAuthLocked(phoneNumber), true);
      assert.equal(second.getApprovalContext(approvalId).action_kind, 'local-demo-push',
        'fixed description metadata survives restart without a new database column');
      assert.equal(second.getApprovalContext(approvalId).action_digest, 'a'.repeat(64));
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
      assert.equal(check.prepare('PRAGMA user_version').get().user_version, 4);
      assert.ok(check.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'result_text'));
      assert.ok(check.prepare('PRAGMA table_info(approvals)').all().some(column => column.name === 'permission_scope'));
    } finally { check.close(); }
  } finally {
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()) + sep)) throw new Error('refusing to remove unexpected test directory');
    rmSync(target, { recursive: true, force: true });
  }
});

test('site monitor incidents are one-per-active-condition and never reuse approval state', () => {
  let time = 1_000;
  withMemoryStore(store => {
    const user = store.ensureUser({ phoneNumber, pinHash: 'scrypt:test' });
    const machineId = randomUUID();
    store.ensureMachine({ machineId, userId: user.id, tokenHash: '0'.repeat(64) });
    const first = store.createSiteMonitorIncident({ machineId, monitorId: 'local-checkout',
      condition: 'slow_response', observedAt: 1_000 });
    assert.equal(first.created, true);
    assert.equal(first.incident.state, 'active');
    assert.equal(first.incident.callback_state, 'planned');
    assert.equal(store.createSiteMonitorIncident({ machineId, monitorId: 'local-checkout',
      condition: 'http_errors', observedAt: 1_100 }).created, false, 'a worsening incident cannot redial');

    const callbackSid = `CA${'c'.repeat(32)}`;
    assert.equal(store.bindSiteMonitorCallback(first.incident.id, 'wrong', callbackSid), false);
    assert.equal(store.bindSiteMonitorCallback(first.incident.id, first.incident.callback_nonce, callbackSid), true);
    assert.equal(store.finishSiteMonitorCallback({ incidentId: first.incident.id, callSid: callbackSid,
      reportDecision: 'declined' }), true);
    assert.equal(store.finishSiteMonitorCallback({ incidentId: first.incident.id, callSid: callbackSid,
      reportDecision: 'requested' }), false, 'the report answer is one-use');
    assert.equal(store.getSiteMonitorIncident(first.incident.id).report_decision, 'declined');
    assert.equal(store.getActiveSiteMonitorIncident(machineId).id, first.incident.id);

    time = 2_000;
    assert.equal(store.resolveSiteMonitorIncident({ machineId, monitorId: 'local-checkout', observedAt: 2_000 }), true);
    assert.equal(store.getActiveSiteMonitorIncident(machineId), undefined);
    assert.equal(store.createSiteMonitorIncident({ machineId, monitorId: 'local-checkout',
      condition: 'http_errors', observedAt: 1_500 }).stale, true, 'a delayed pre-recovery alert cannot reopen it');
    const later = store.createSiteMonitorIncident({ machineId, monitorId: 'local-checkout',
      condition: 'http_errors', observedAt: 3_000 });
    assert.equal(later.created, true);
    assert.notEqual(later.incident.id, first.incident.id);
    assert.equal(store.getApproval(randomUUID()), undefined, 'monitor data never creates an approval');
  }, () => time);
});

test('site monitor callback completion tolerates the Twilio status race without redialing', () => {
  withMemoryStore(store => {
    const user = store.ensureUser({ phoneNumber, pinHash: 'scrypt:test' });
    const machineId = randomUUID();
    store.ensureMachine({ machineId, userId: user.id, tokenHash: '0'.repeat(64) });
    const created = store.createSiteMonitorIncident({ machineId, monitorId: 'local-checkout',
      condition: 'http_errors', observedAt: 1_000 }).incident;
    const callbackSid = `CA${'d'.repeat(32)}`;
    assert.equal(store.recordSiteMonitorCallbackEnd({ incidentId: created.id, nonce: created.callback_nonce,
      callSid: callbackSid, status: 'no-answer' }), true);
    assert.equal(store.markSiteMonitorCallbackDialed(created.id, callbackSid), false,
      'a late REST response cannot turn the failed call into another notification or a false success log');
    assert.equal(store.bindSiteMonitorCallback(created.id, created.callback_nonce, callbackSid), false);
    assert.equal(store.recordSiteMonitorCallbackEnd({ incidentId: created.id, nonce: created.callback_nonce,
      callSid: callbackSid, status: 'no-answer' }), false);
    assert.equal(store.getSiteMonitorIncident(created.id).callback_state, 'failed');
  });
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

test('latest task lookup is scoped to the authenticated user and survives hangup', () => {
  withMemoryStore((store) => {
    const first = store.ensureUser({ phoneNumber, pinHash: 'scrypt:test' });
    const second = store.ensureUser({ phoneNumber: '+15065550999', pinHash: 'scrypt:test' });
    const machineId = randomUUID();
    store.ensureMachine({ machineId, userId: first.id, tokenHash: 'test-token-hash' });
    store.setMachineStatus(machineId, 'online');
    const { sessionId } = store.startInboundCall({ userId: first.id, callSid, phoneNumber });
    store.assignSessionAgent(sessionId, machineId, randomUUID());
    const older = store.createTask({ sessionId, prompt: 'Old task' });
    const newest = store.createTask({ sessionId, prompt: 'Current task' });
    store.transitionTask(newest, 'running');
    store.setCallState(callSid, 'streaming');
    store.setCallState(callSid, 'ended', 'caller_hung_up');
    const otherSession = store.startInboundCall({ userId: second.id, callSid: `CA${'2'.repeat(32)}`, phoneNumber: second.phoneNumber }).sessionId;
    const otherTask = store.createTask({ sessionId: otherSession, prompt: 'Other user task' });
    assert.equal(store.getLatestTaskForUser(first.id).id, newest);
    assert.equal(store.getLatestTaskForUser(first.id).machine_status, 'online');
    assert.equal(store.getLatestTaskForUser(second.id).id, otherTask);
    assert.notEqual(store.getLatestTaskForUser(first.id).id, older);
  }, () => 1_000);
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

test('same-call decisions require the exact live inbound call and its prior PIN authentication', () => {
  for (const variant of ['valid', 'unauthenticated', 'ended', 'other-call', 'callback-planned', 'expired']) {
    let time = 1_000;
    withMemoryStore(store => {
      const user = store.ensureUser({ phoneNumber, pinHash: 'scrypt:test' });
      const { sessionId } = store.startInboundCall({ userId: user.id, callSid, phoneNumber });
      const taskId = store.createTask({ sessionId, prompt: 'Demo push' });
      const runId = store.createRun({ taskId, agentId: randomUUID() });
      store.transitionTask(taskId, 'running');
      store.transitionRun(runId, 'running');
      store.transitionTask(taskId, 'waiting_human');
      store.transitionRun(runId, 'waiting_human');
      store.setCallState(callSid, 'streaming');
      const actionDigest = 'c'.repeat(64);
      const approvalId = store.createApproval({ runId, actionDigest, command: 'push', cwd: '/demo', expiresAt: 2_000 });
      if (variant !== 'unauthenticated') store.audit(sessionId, 'call.authenticated', { callSid });
      if (variant === 'ended') store.setCallState(callSid, 'ended', 'hangup');
      if (variant === 'other-call') {
        const otherCallSid = `CA${'9'.repeat(32)}`;
        const other = store.startInboundCall({ userId: user.id, callSid: otherCallSid, phoneNumber });
        store.setCallState(otherCallSid, 'streaming');
        store.audit(other.sessionId, 'call.authenticated', { callSid: otherCallSid });
      }
      if (variant === 'callback-planned') store.prepareApprovalCallback(approvalId);
      if (variant === 'expired') time = 2_001;
      const decision = { approvalId, runId, actionDigest, userId: user.id, approved: true,
        inboundCallSid: variant === 'other-call' ? `CA${'9'.repeat(32)}` : callSid };
      assert.equal(store.decideApproval(decision), variant === 'valid', variant);
      if (variant === 'valid') {
        assert.equal(store.decideApproval(decision), false, 'one-use decision');
        const audit = store.listAudit(sessionId).find(e => e.type === 'approval.decided');
        assert.equal(JSON.parse(audit.payload).channel, 'inbound');
        assert.equal(JSON.parse(audit.payload).callSid, callSid);
        assert.equal(store.getApprovalCallback(approvalId), undefined);
      }
    }, () => time);
  }
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

test('a session cannot switch to another agent on the same machine', () => {
  withMemoryStore(store => {
    const user = store.ensureUser({ phoneNumber, pinHash: 'scrypt:test' });
    const machineId = randomUUID();
    const agentId = randomUUID();
    store.ensureMachine({ machineId, userId: user.id, tokenHash: '0'.repeat(64) });
    const { sessionId } = store.startInboundCall({ userId: user.id, callSid, phoneNumber });
    store.assignSessionAgent(sessionId, machineId, agentId);
    assert.doesNotThrow(() => store.assignSessionAgent(sessionId, machineId, agentId));
    assert.throws(() => store.assignSessionAgent(sessionId, machineId, randomUUID()), /cannot be assigned/);
    assert.equal(store.getSession(sessionId).agent_id, agentId);
  });
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
