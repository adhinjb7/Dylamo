import { createHash, randomUUID } from 'node:crypto';
import { matchesPendingApproval, PROTOCOL_VERSION } from '@hack-atlantic/protocol';

export const FAKE_AGENT_ID = '00000000-0000-4000-8000-000000000006';
const COMPLETION_DELAY_MS = 8_000;
const APPROVAL_TTL_MS = 5 * 60_000;
const FAKE_COMMAND = 'git push origin demo-branch';
const FAKE_CWD = 'demo-repository';

export function createFakeAgent({ machineId, send, delayMs = COMPLETION_DELAY_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const runs = new Map();
  const pending = [];

  function emit(run, type, fields) {
    if (type === 'task.completed' || type === 'task.failed' || type === 'task.cancelled') run.finished = true;
    pending.push({
      v: PROTOCOL_VERSION, eventId: randomUUID(), machineId,
      sessionId: run.sessionId, taskId: run.taskId, runId: run.runId,
      type, ...fields,
    });
    flush();
  }

  function flush() {
    while (pending.length && send(pending[0])) pending.shift();
  }

  function receive(event) {
    if (event.type === 'task.cancel') {
      const run = runs.get(event.runId);
      if (!run || run.finished || event.machineId !== machineId || run.sessionId !== event.sessionId || run.taskId !== event.taskId) return false;
      if (run.timer) clearTimer(run.timer);
      run.timer = null;
      if (run.approval) run.approval.resolved = true;
      emit(run, 'task.cancelled', { reason: 'The simulated task was cancelled by the caller.' });
      return true;
    }
    if (event.type === 'approval.response') {
      const run = runs.get(event.runId);
      const pending = run?.approval;
      if (!pending || pending.resolved || !matchesPendingApproval(pending, event)) return false;
      if (Date.now() >= Date.parse(pending.expiresAt)) return false;
      pending.resolved = true;
      if (run.timer) clearTimer(run.timer);
      run.timer = null;
      if (event.approved) {
        emit(run, 'agent.message', { text: 'Approval received. The protected action was simulated; no command ran.' });
        emit(run, 'task.completed', { summary: 'Simulated approval complete; no command ran.' });
      } else {
        emit(run, 'task.failed', { reason: 'Approval rejected; no command ran.' });
      }
      return true;
    }
    if (event.type !== 'task.start' || event.agentId !== FAKE_AGENT_ID || runs.has(event.runId)) return false;
    const run = { sessionId: event.sessionId, taskId: event.taskId, runId: event.runId, timer: null, approval: null };
    runs.set(event.runId, run);
    emit(run, 'agent.progress', { text: 'Fake agent is checking the request. No commands will run.' });
    run.timer = setTimer(() => {
      run.timer = null;
      if (event.scenario === 'approval') {
        const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
        const approvalId = randomUUID();
        const actionDigest = createHash('sha256').update(`${FAKE_COMMAND}\0${FAKE_CWD}`).digest('hex');
        run.approval = {
          v: PROTOCOL_VERSION, eventId: randomUUID(), machineId,
          sessionId: run.sessionId, taskId: run.taskId, runId: run.runId,
          type: 'approval.required', approvalId, actionDigest,
          command: FAKE_COMMAND, cwd: FAKE_CWD, expiresAt,
          resolved: false,
        };
        const { resolved, ...request } = run.approval;
        pending.push(request);
        flush();
        run.timer = setTimer(() => {
          if (!run.approval?.resolved) {
            run.approval.resolved = true;
            emit(run, 'task.failed', { reason: 'Approval expired; no command ran.' });
          }
        }, APPROVAL_TTL_MS);
        return;
      }
      emit(run, 'agent.message', { text: 'The simulated check is complete. No files were changed.' });
      emit(run, 'task.completed', { summary: 'Simulated check complete; no files changed.' });
    }, delayMs);
    return true;
  }

  function stop() {
    for (const run of runs.values()) if (run.timer) clearTimer(run.timer);
    runs.clear();
    pending.length = 0;
  }

  return { receive, flush, stop, pendingCount: () => pending.length,
    activeRunIds: () => [...runs.values()].filter(run => !run.finished).map(run => run.runId) };
}
