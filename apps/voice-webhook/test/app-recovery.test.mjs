import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import WebSocket from 'ws';
import { createDaemonClient } from '../../daemon/src/client.mjs';
import { CODEX_AGENT_ID } from '../../daemon/src/codex-agent.mjs';
import { createServer } from '../src/app.mjs';
import { hashPin } from '../src/pin.mjs';
import { openStateStore } from '../src/state.mjs';

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for recovery');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function fixture(work) {
  const machineId = randomUUID();
  const token = 'test-only-recovery-token-with-enough-length';
  const phoneNumber = '+15065550123';
  const pinHash = hashPin('1234', Buffer.alloc(16, 5));
  const time = Date.now();
  const store = openStateStore(':memory:', { now: () => time });
  const callbacks = [];
  const acknowledged = new Set();
  const observed = new Set();
  const server = createServer({
    authToken: 'test-auth-token', accountSid: `AC${'0'.repeat(32)}`,
    publicBaseUrl: 'https://example.ngrok.app', allowedCallerNumber: phoneNumber,
    callbackCallerNumber: '+15065550124', pinHash, voiceMode: 'realtime', agentMode: 'codex',
    codexApprovalEnabled: true, openAiApiKey: 'test-key', stateStore: store, now: () => time,
    daemonCredentials: new Map([[machineId, createHash('sha256').update(token).digest('hex')]]),
    onDaemonEvent: event => observed.add(event.eventId),
    callbackCreator: async request => { callbacks.push(request); return `CA${'c'.repeat(32)}`; },
    realtimeConnector: () => { throw new Error('recovery must not initiate a voice model'); },
  });
  const user = store.ensureUser({ phoneNumber, pinHash });
  const callSid = `CA${'a'.repeat(32)}`;
  const { sessionId } = store.startInboundCall({ userId: user.id, callSid, phoneNumber });
  store.assignSessionAgent(sessionId, machineId, CODEX_AGENT_ID);
  store.setCallState(callSid, 'ended', 'caller_hung_up');
  const newRun = () => {
    const taskId = store.createTask({ sessionId, prompt: 'Push the demo branch' });
    const runId = store.createRun({ taskId, agentId: CODEX_AGENT_ID });
    store.transitionTask(taskId, 'running');
    store.transitionRun(runId, 'running');
    store.setCodexRunIds(runId, `thread-${runId}`, `turn-${runId}`);
    return { taskId, runId };
  };
  const approvalEvent = run => ({
    v: 1, eventId: randomUUID(), machineId, sessionId, ...run, type: 'approval.required',
    approvalId: randomUUID(), actionDigest: 'a'.repeat(64),
    command: 'git push origin HEAD:refs/heads/phone-demo', cwd: process.cwd(),
    expiresAt: new Date(time + 60000).toISOString(),
    runtime: { threadId: `thread-${run.runId}`, turnId: `turn-${run.runId}`,
      itemId: 'push-item', requestId: '"approval-rpc"' },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = createDaemonClient({
    serverUrl: `ws://127.0.0.1:${server.address().port}/daemon`, machineId, token,
    name: 'Recovery fixture', allowInsecureLoopback: true,
    agents: [{ agentId: CODEX_AGENT_ID, adapterType: 'codex', name: 'Codex fixture', status: 'working' }],
    createSocket: (url, options) => {
      const socket = new WebSocket(url, options);
      socket.on('message', raw => {
        const event = JSON.parse(raw.toString());
        if (event.type === 'event.ack') acknowledged.add(event.ackEventId);
      });
      return socket;
    },
  });
  const reconcile = async activeRunIds => {
    const eventId = randomUUID();
    client.send({ v: 1, eventId, machineId, type: 'machine.reconcile', activeRunIds });
    await waitFor(() => observed.has(eventId));
  };
  try {
    await work({ store, client, newRun, approvalEvent, callbacks, time, sessionId,
      acknowledged, reconcile, connect: async () => {
        client.start();
        await waitFor(() => client.status().state === 'online');
      } });
  } finally {
    client.stop();
    await new Promise(resolve => server.close(resolve));
    store.close();
  }
}

test('expired approval replay is acknowledged and fails the task without a callback or reconnect loop', () => fixture(async f => {
  const run = f.newRun();
  const event = { ...f.approvalEvent(run), expiresAt: new Date(f.time - 1).toISOString() };
  await f.connect();
  f.client.send(event);
  await waitFor(() => f.acknowledged.has(event.eventId));
  assert.equal(f.store.getTask(run.taskId).state, 'failed');
  assert.match(f.store.getTask(run.taskId).result_text, /expired before it could be delivered/);
  assert.equal(f.store.getApproval(event.approvalId), undefined);
  f.client.send(event); // Same durable event can be replayed safely.
  await f.reconcile([]);
  assert.equal(f.client.status().state, 'online');
  assert.equal(f.callbacks.length, 0);
  assert.equal(f.store.listAudit(f.sessionId).filter(row => row.type === 'approval.expired_before_delivery').length, 1);
}));

test('reconcile dials only a live pending approval with no previous callback attempt', () => fixture(async f => {
  const activeRunIds = [];
  const approvals = new Map();
  for (const state of ['missing', 'planned', 'dialed', 'failed', 'lost']) {
    const run = f.newRun();
    const event = f.approvalEvent(run);
    f.store.createApproval({ ...event, expiresAt: Date.parse(event.expiresAt) });
    f.store.transitionTask(run.taskId, 'waiting_human');
    f.store.transitionRun(run.runId, 'waiting_human');
    approvals.set(state, event);
    if (state !== 'lost') activeRunIds.push(run.runId);
    if (!['missing', 'lost'].includes(state)) f.store.prepareApprovalCallback(event.approvalId);
    if (state === 'failed') f.store.markApprovalCallbackFailed(event.approvalId);
    if (state === 'dialed') f.store.markApprovalCallbackDialed(event.approvalId, `CA${'d'.repeat(32)}`);
  }
  await f.connect();
  await f.reconcile(activeRunIds);
  await waitFor(() => f.callbacks.length === 1);
  const missing = approvals.get('missing');
  assert.equal(new URL(f.callbacks[0].url).searchParams.get('approvalId'), missing.approvalId);
  await waitFor(() => f.store.getApprovalCallback(missing.approvalId)?.state === 'dialed');
  await f.reconcile(activeRunIds);
  assert.equal(f.callbacks.length, 1, 'fresh snapshots must not repeat an existing provider attempt');
  assert.equal(f.store.getApproval(approvals.get('lost').approvalId).state, 'expired');
  assert.equal(f.store.getApprovalCallback(approvals.get('lost').approvalId), undefined);
  for (const state of ['planned', 'dialed', 'failed']) {
    assert.equal(f.store.getApprovalCallback(approvals.get(state).approvalId).state, state);
  }
}));
