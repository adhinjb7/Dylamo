import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { openStateStore } from '../../voice-webhook/src/state.mjs';
import { prepareApprovalRehearsal, REHEARSAL_COMMAND } from '../src/approval-rehearsal.mjs';
import { CODEX_AGENT_ID } from '../src/codex-agent.mjs';
import { openPhoneApprovalProof, observePhoneApproval, PhoneProofError } from '../src/phone-approval-proof.mjs';

const commit = 'a'.repeat(40);
const baseline = { sourceCommit: commit, remoteCommit: '', latestSequence: 1, approvals: [] };
const pending = { id: 'approval-one', sequence: 2, state: 'pending', taskState: 'waiting_human',
  runState: 'waiting_human', exactAction: true, realRuntime: true, callbackPinVerified: false,
  callbackState: 'planned', outboundCall: false, inboundEndedAt: null, hungUpBeforeDecision: false,
  callbackAfterHangup: false,
  decidedByUser: false, decisionInTime: true };

test('observer requires a held request and PIN-verified completion before trusting a matching ref', async () => {
  const phases = [];
  const snapshots = [baseline,
    { ...baseline, latestSequence: 2, approvals: [pending] },
    { ...baseline, latestSequence: 2, approvals: [{ ...pending, state: 'approved',
      taskState: 'running', runState: 'running', callbackPinVerified: true,
      callbackState: 'finished', outboundCall: true, callbackAfterHangup: true,
      decidedByUser: true, inboundEndedAt: 2_000, hungUpBeforeDecision: true }] },
    { ...baseline, remoteCommit: commit, latestSequence: 2, approvals: [{ ...pending,
      state: 'approved', taskState: 'completed', runState: 'completed',
      callbackPinVerified: true, callbackState: 'finished', decidedByUser: true,
      inboundEndedAt: 2_000, hungUpBeforeDecision: true, outboundCall: true,
      callbackAfterHangup: true }] }];
  const result = await observePhoneApproval({ readSnapshot: () => snapshots.shift(), sleep: async () => {},
    onPhase: phase => phases.push(phase) });
  assert.deepEqual(phases, ['baseline', 'held', 'hangup', 'verified']);
  assert.deepEqual(result, { result: 'verified', commit });
});

test('observer fails closed if the ref changes early or approval lacks the callback PIN', async () => {
  for (const next of [
    { ...baseline, remoteCommit: commit, approvals: [] },
    { ...baseline, approvals: [{ ...pending, exactAction: false }] },
    { ...baseline, approvals: [{ ...pending, state: 'approved', taskState: 'completed',
      runState: 'completed', callbackState: 'finished', decidedByUser: true }] },
    { ...baseline, remoteCommit: commit, approvals: [{ ...pending, state: 'approved',
      taskState: 'completed', runState: 'completed', callbackPinVerified: true,
      callbackState: 'finished', decidedByUser: true }] },
  ]) {
    const snapshots = [baseline, next];
    await assert.rejects(observePhoneApproval({ readSnapshot: () => snapshots.shift(), sleep: async () => {} }), PhoneProofError);
  }
  const snapshots = [baseline, { ...baseline, approvals: [pending] },
    { ...baseline, remoteCommit: commit, approvals: [pending] }];
  await assert.rejects(observePhoneApproval({ readSnapshot: () => snapshots.shift(), sleep: async () => {} }),
    /remote changed while approval was still pending/);
  const noHangup = [baseline, { ...baseline, approvals: [pending] },
    { ...baseline, remoteCommit: commit, approvals: [{ ...pending, state: 'approved',
      taskState: 'completed', runState: 'completed', callbackPinVerified: true,
      callbackState: 'finished', outboundCall: true, decidedByUser: true }] }];
  await assert.rejects(observePhoneApproval({ readSnapshot: () => noHangup.shift(), sleep: async () => {} }),
    /inbound call did not end before/);
  const earlyCallback = [baseline, { ...baseline, approvals: [pending] },
    { ...baseline, remoteCommit: commit, approvals: [{ ...pending, state: 'approved',
      taskState: 'completed', runState: 'completed', callbackPinVerified: true,
      callbackState: 'finished', outboundCall: true, decidedByUser: true,
      inboundEndedAt: 2_000, hungUpBeforeDecision: true }] }];
  await assert.rejects(observePhoneApproval({ readSnapshot: () => earlyCallback.shift(), sleep: async () => {} }),
    /outbound callback was not recorded after/);
});

for (const decisionChannel of ['callback', 'inbound']) test(`read-only observer proves ${decisionChannel} approval against SQLite and local Git`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phone-proof-test-'));
  let store;
  let observer;
  try {
    const fixture = prepareApprovalRehearsal(join(directory, 'dylamo-approval-rehearsals'));
    const databasePath = join(directory, 'voice.db');
    let time = 1_000;
    store = openStateStore(databasePath, { now: () => time });
    observer = openPhoneApprovalProof({ workspace: fixture.workspace, databasePath,
      approvalCommand: REHEARSAL_COMMAND });
    assert.equal(observer.readSnapshot().remoteCommit, '');
    let stage = 0;
    let approvalId;
    const user = store.ensureUser({ phoneNumber: '+15065550123', pinHash: 'scrypt:test' });
    const machineId = randomUUID();
    store.ensureMachine({ machineId, userId: user.id, tokenHash: 'test-token' });
    const { sessionId } = store.startInboundCall({ userId: user.id,
      callSid: `CA${'1'.repeat(32)}`, phoneNumber: user.phoneNumber });
    store.assignSessionAgent(sessionId, machineId, CODEX_AGENT_ID);
    const phases = [];
    const result = await observePhoneApproval({ readSnapshot: observer.readSnapshot,
      sleep: async () => {
        stage += 1;
        if (stage === 1) {
          const taskId = store.createTask({ sessionId, prompt: 'Disposable push' });
          const runId = store.createRun({ taskId, agentId: CODEX_AGENT_ID });
          store.transitionTask(taskId, 'running');
          store.transitionRun(runId, 'running');
          store.setCodexRunIds(runId, 'thread-test', 'turn-test');
          store.transitionTask(taskId, 'waiting_human');
          store.transitionRun(runId, 'waiting_human');
          approvalId = store.createApproval({ runId, actionDigest: 'e'.repeat(64),
            command: REHEARSAL_COMMAND, cwd: fixture.workspace,
            codexItemId: 'item-test', codexRequestId: 'request-test', expiresAt: 60_000 });
          if (decisionChannel === 'callback') store.prepareApprovalCallback(approvalId);
        }
        if (stage === 2) {
          time = 2_000;
          store.setCallState(`CA${'1'.repeat(32)}`, 'streaming');
          store.audit(sessionId, 'call.authenticated', { callSid: `CA${'1'.repeat(32)}` });
          if (decisionChannel === 'callback') {
            store.setCallState(`CA${'1'.repeat(32)}`, 'ended', 'caller_hung_up');
            time = 2_500;
            store.markApprovalCallbackDialed(approvalId, `CA${'2'.repeat(32)}`);
            assert.equal(store.verifyApprovalCallbackPin(approvalId, `CA${'2'.repeat(32)}`), true);
          }
          time = 3_000;
          const context = store.getApprovalContext(approvalId);
          assert.equal(store.decideApproval({ approvalId, runId: context.run_id,
            actionDigest: context.action_digest, userId: user.id, approved: true,
            ...(decisionChannel === 'inbound' ? { inboundCallSid: `CA${'1'.repeat(32)}` } : {}) }), true);
          if (decisionChannel === 'callback') store.finishApprovalCallback(approvalId, `CA${'2'.repeat(32)}`);
          store.transitionRun(context.run_id, 'running');
          store.transitionTask(context.task_id, 'running');
          fixture.git(fixture.workspace, ['push', 'origin', 'HEAD:refs/heads/phone-demo']);
          store.transitionRun(context.run_id, 'completed');
          store.transitionTask(context.task_id, 'completed');
        }
      }, onPhase: phase => phases.push(phase) });
    assert.equal(result.result, 'verified');
    assert.equal(result.commit, fixture.expectedCommit);
    assert.deepEqual(phases, ['baseline', 'held', decisionChannel === 'callback' ? 'hangup' : 'approved-on-call', 'verified']);
    if (decisionChannel === 'inbound') {
      assert.equal(store.getApprovalCallback(approvalId), undefined);
      time = 4_000;
      store.setCallState(`CA${'1'.repeat(32)}`, 'ended', 'caller_hung_up');
      const approval = observer.readSnapshot(0).approvals[0];
      assert.equal(approval.inCallPinVerified, true);
      assert.equal(approval.inCallActiveAtDecision, true, 'ending later does not invalidate historical same-call proof');
    }
  } finally {
    observer?.close();
    store?.close();
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()) + sep)) throw new Error('refusing to remove unexpected test directory');
    rmSync(target, { recursive: true, force: true });
  }
});

test('same-call proof requires authentication, an active call, timely consent and no callback attempt', async () => {
  const approved = { ...pending, state: 'approved', taskState: 'completed', runState: 'completed',
    decisionChannel: 'inbound', inCallPinVerified: true, inCallActiveAtDecision: true,
    callbackAttempted: false, decidedByUser: true };
  for (const change of [{ inCallPinVerified: false }, { inCallActiveAtDecision: false },
    { callbackAttempted: true }, { decidedByUser: false }, { decisionInTime: false }]) {
    const snapshots = [baseline, { ...baseline, approvals: [pending] },
      { ...baseline, remoteCommit: commit, approvals: [{ ...approved, ...change }] }];
    await assert.rejects(observePhoneApproval({ readSnapshot: () => snapshots.shift(), sleep: async () => {} }),
      /same PIN-authenticated call/);
  }
});

test('observer refuses a nonlocal origin and an unconfigured action before watching', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phone-proof-test-'));
  let store;
  try {
    const fixture = prepareApprovalRehearsal(join(directory, 'dylamo-approval-rehearsals'));
    const databasePath = join(directory, 'voice.db');
    store = openStateStore(databasePath);
    assert.throws(() => openPhoneApprovalProof({ workspace: fixture.workspace, databasePath,
      approvalCommand: 'git push origin main' }), PhoneProofError);
    fixture.git(fixture.workspace, ['remote', 'set-url', 'origin', 'https://example.com/unsafe.git']);
    assert.throws(() => openPhoneApprovalProof({ workspace: fixture.workspace, databasePath,
      approvalCommand: REHEARSAL_COMMAND }), /not a local bare repository/);
  } finally {
    store?.close();
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()) + sep)) throw new Error('refusing to remove unexpected test directory');
    rmSync(target, { recursive: true, force: true });
  }
});
