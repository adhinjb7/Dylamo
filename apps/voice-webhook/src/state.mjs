import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canTransitionApproval, canTransitionCall, canTransitionTask } from '@hack-atlantic/protocol';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, phone_number TEXT NOT NULL UNIQUE, pin_hash TEXT NOT NULL,
  display_name TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
  token_hash TEXT NOT NULL, connection_status TEXT NOT NULL CHECK(connection_status IN ('online','offline')),
  last_seen_at INTEGER, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  machine_id TEXT REFERENCES machines(id), agent_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('active','closed')),
  active_channel TEXT NOT NULL CHECK(active_channel IN ('voice','sms')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS call_attempts (
  id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id),
  call_sid TEXT NOT NULL UNIQUE, phone_number TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  state TEXT NOT NULL CHECK(state IN ('received','authenticating','streaming','rejected','ended')),
  ended_reason TEXT, started_at INTEGER NOT NULL, ended_at INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), prompt TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','waiting_human','completed','failed','cancelled')),
  started_at INTEGER NOT NULL, finished_at INTEGER, result_text TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), agent_id TEXT NOT NULL,
  codex_thread_id TEXT, codex_turn_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('queued','running','waiting_human','completed','failed','cancelled')),
  last_event_id TEXT, started_at INTEGER NOT NULL, finished_at INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id),
  action_digest TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT NOT NULL,
  codex_item_id TEXT, codex_request_id TEXT, permission_scope TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','expired')),
  expires_at INTEGER NOT NULL, resolved_at INTEGER, decided_by_user_id TEXT REFERENCES users(id)
) STRICT;
CREATE TABLE IF NOT EXISTS approval_callbacks (
  approval_id TEXT PRIMARY KEY REFERENCES approvals(id), nonce TEXT NOT NULL UNIQUE,
  call_sid TEXT UNIQUE, pin_verified INTEGER NOT NULL DEFAULT 0 CHECK(pin_verified IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('planned','dialed','finished','failed')),
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id), type TEXT NOT NULL,
  redacted_payload TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS processed_events (
  event_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL,
  type TEXT NOT NULL, processed_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS auth_failures (
  phone_number TEXT PRIMARY KEY, count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_call_session ON call_attempts(session_id);
CREATE INDEX IF NOT EXISTS idx_task_session ON tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_run_task ON agent_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_approval_run ON approvals(run_id);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_events(session_id, created_at);
`;

export function databasePathFromUrl(value = 'file:./data/agent-phone.db') {
  if (value === ':memory:') return value;
  if (!value.startsWith('file:')) throw new Error('DATABASE_URL must start with file:');
  const path = value.slice(5);
  if (!path || path.startsWith('//')) throw new Error('DATABASE_URL must name a local file path');
  return resolve(path);
}

export function openStateStore(path, { now = Date.now } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 3) {
    db.close();
    throw new Error('database schema is newer than this application');
  }
  db.exec(SCHEMA);
  if (version < 3) {
    if (!db.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'result_text')) db.exec('ALTER TABLE tasks ADD COLUMN result_text TEXT');
    if (!db.prepare('PRAGMA table_info(approvals)').all().some(column => column.name === 'permission_scope')) db.exec('ALTER TABLE approvals ADD COLUMN permission_scope TEXT');
    db.exec('PRAGMA user_version = 3');
  }

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function ensureUser({ phoneNumber, pinHash, displayName = 'Demo caller' }) {
    db.prepare(`INSERT INTO users (id, phone_number, pin_hash, display_name, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(phone_number) DO UPDATE SET pin_hash=excluded.pin_hash`)
      .run(randomUUID(), phoneNumber, pinHash, displayName, now());
    return db.prepare('SELECT id, phone_number AS phoneNumber FROM users WHERE phone_number=?').get(phoneNumber);
  }

  function ensureMachine({ machineId, userId, name = 'Registered machine', tokenHash }) {
    db.prepare(`INSERT INTO machines (id, user_id, name, token_hash, connection_status, created_at)
      VALUES (?, ?, ?, ?, 'offline', ?) ON CONFLICT(id) DO UPDATE SET
      user_id=excluded.user_id, token_hash=excluded.token_hash, connection_status='offline'`)
      .run(machineId, userId, name, tokenHash, now());
  }

  function setMachineStatus(machineId, status, name) {
    if (!['online', 'offline'].includes(status)) throw new Error('invalid machine status');
    const result = db.prepare(`UPDATE machines SET connection_status=?, last_seen_at=?,
      name=COALESCE(?, name) WHERE id=?`).run(status, now(), name ?? null, machineId);
    if (!result.changes) throw new Error('unknown machine');
  }

  function touchMachine(machineId) {
    db.prepare('UPDATE machines SET last_seen_at=? WHERE id=?').run(now(), machineId);
  }

  function startInboundCall({ userId, callSid, phoneNumber }) {
    return transaction(() => {
      const existing = db.prepare('SELECT id AS callId, session_id AS sessionId, state FROM call_attempts WHERE call_sid=?').get(callSid);
      if (existing) return existing;
      const sessionId = randomUUID();
      const callId = randomUUID();
      const time = now();
      db.prepare(`INSERT INTO sessions (id, user_id, state, active_channel, created_at, updated_at)
        VALUES (?, ?, 'active', 'voice', ?, ?)`).run(sessionId, userId, time, time);
      db.prepare(`INSERT INTO call_attempts (id, session_id, call_sid, phone_number, direction, state, started_at)
        VALUES (?, ?, ?, ?, 'inbound', 'authenticating', ?)`).run(callId, sessionId, callSid, phoneNumber, time);
      return { callId, sessionId, state: 'authenticating' };
    });
  }

  function recordRejectedCall({ callSid, phoneNumber, reason = 'caller_not_allowed' }) {
    db.prepare(`INSERT OR IGNORE INTO call_attempts
      (id, call_sid, phone_number, direction, state, ended_reason, started_at, ended_at)
      VALUES (?, ?, ?, 'inbound', 'rejected', ?, ?, ?)`)
      .run(randomUUID(), callSid, phoneNumber, reason, now(), now());
  }

  function setCallState(callSid, next, reason = null) {
    const call = db.prepare('SELECT state FROM call_attempts WHERE call_sid=?').get(callSid);
    if (!call) throw new Error('unknown call');
    if (call.state === next) return false;
    if (!canTransitionCall(call.state, next)) throw new Error(`invalid call transition: ${call.state} -> ${next}`);
    const terminal = next === 'ended' || next === 'rejected';
    db.prepare('UPDATE call_attempts SET state=?, ended_reason=?, ended_at=? WHERE call_sid=?')
      .run(next, terminal ? reason : null, terminal ? now() : null, callSid);
    return true;
  }

  function recordAuthFailure(phoneNumber, maxFailures = 3, lockMs = 15 * 60_000) {
    const prior = db.prepare('SELECT count, expires_at AS expiresAt FROM auth_failures WHERE phone_number=?').get(phoneNumber);
    const count = prior && prior.expiresAt > now() ? prior.count + 1 : 1;
    db.prepare(`INSERT INTO auth_failures (phone_number, count, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(phone_number) DO UPDATE SET count=excluded.count, expires_at=excluded.expires_at`)
      .run(phoneNumber, count, now() + lockMs);
    return count >= maxFailures;
  }

  function isAuthLocked(phoneNumber, maxFailures = 3) {
    const failure = db.prepare('SELECT count, expires_at AS expiresAt FROM auth_failures WHERE phone_number=?').get(phoneNumber);
    return Boolean(failure && failure.count >= maxFailures && failure.expiresAt > now());
  }

  function clearAuthFailures(phoneNumber) {
    db.prepare('DELETE FROM auth_failures WHERE phone_number=?').run(phoneNumber);
  }

  function createTask({ sessionId, prompt }) {
    const id = randomUUID();
    db.prepare(`INSERT INTO tasks (id, session_id, prompt, state, started_at) VALUES (?, ?, ?, 'queued', ?)`)
      .run(id, sessionId, prompt, now());
    return id;
  }

  function assignSessionAgent(sessionId, machineId, agentId) {
    const result = db.prepare(`UPDATE sessions SET machine_id=?, agent_id=?, updated_at=?
      WHERE id=? AND state='active' AND (machine_id IS NULL OR (machine_id=? AND agent_id=?))`)
      .run(machineId, agentId, now(), sessionId, machineId, agentId);
    if (!result.changes) throw new Error('session cannot be assigned to machine');
  }

  function transitionTask(taskId, next) {
    const task = db.prepare('SELECT state FROM tasks WHERE id=?').get(taskId);
    if (!task || !canTransitionTask(task.state, next)) throw new Error('invalid task transition');
    db.prepare('UPDATE tasks SET state=?, finished_at=? WHERE id=?')
      .run(next, ['completed', 'failed', 'cancelled'].includes(next) ? now() : null, taskId);
  }

  function createRun({ taskId, agentId }) {
    const id = randomUUID();
    db.prepare(`INSERT INTO agent_runs (id, task_id, agent_id, state, started_at)
      VALUES (?, ?, ?, 'queued', ?)`).run(id, taskId, agentId, now());
    return id;
  }

  function transitionRun(runId, next, lastEventId = null) {
    const run = db.prepare('SELECT state FROM agent_runs WHERE id=?').get(runId);
    if (!run || !canTransitionTask(run.state, next)) throw new Error('invalid run transition');
    db.prepare('UPDATE agent_runs SET state=?, last_event_id=COALESCE(?, last_event_id), finished_at=? WHERE id=?')
      .run(next, lastEventId, ['completed', 'failed', 'cancelled'].includes(next) ? now() : null, runId);
  }

  function setCodexRunIds(runId, threadId, turnId) {
    const result = db.prepare(`UPDATE agent_runs SET codex_thread_id=?, codex_turn_id=?
      WHERE id=? AND state IN ('queued','running') AND codex_thread_id IS NULL AND codex_turn_id IS NULL`)
      .run(threadId, turnId, runId);
    if (!result.changes) throw new Error('Codex run IDs cannot be assigned');
  }

  function createApproval({ approvalId = randomUUID(), runId, actionDigest, command, cwd, expiresAt, codexItemId = null, codexRequestId = null, permissionScope = null }) {
    if (!/^[a-f0-9]{64}$/.test(actionDigest) || !Number.isInteger(expiresAt) || expiresAt <= now()) {
      throw new Error('invalid approval action or expiry');
    }
    db.prepare(`INSERT INTO approvals (id, run_id, action_digest, command, cwd, codex_item_id, codex_request_id, permission_scope, state, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(approvalId, runId, actionDigest, command, cwd, codexItemId, codexRequestId, permissionScope, expiresAt);
    return approvalId;
  }

  function prepareApprovalCallback(approvalId) {
    const nonce = randomBytes(24).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO approval_callbacks (approval_id, nonce, state, created_at)
      VALUES (?, ?, 'planned', ?)`).run(approvalId, nonce, now());
    return db.prepare('SELECT * FROM approval_callbacks WHERE approval_id=?').get(approvalId);
  }

  function markApprovalCallbackDialed(approvalId, callSid) {
    if (!/^CA[0-9a-fA-F]{32}$/.test(callSid)) throw new Error('invalid callback call SID');
    const prior = db.prepare('SELECT call_sid, state FROM approval_callbacks WHERE approval_id=?').get(approvalId);
    // Twilio may send webhooks before its REST response reaches this server.
    if (prior?.call_sid === callSid && ['finished', 'failed'].includes(prior.state)) return;
    const result = db.prepare(`UPDATE approval_callbacks SET call_sid=?, state='dialed'
      WHERE approval_id=? AND state IN ('planned','dialed') AND (call_sid IS NULL OR call_sid=?)`)
      .run(callSid, approvalId, callSid);
    if (!result.changes) throw new Error('callback SID mismatch');
    recordApprovalCall(approvalId, callSid);
  }

  function markApprovalCallbackFailed(approvalId) {
    db.prepare("UPDATE approval_callbacks SET state='failed' WHERE approval_id=? AND state='planned'").run(approvalId);
  }

  function bindApprovalCallback(approvalId, nonce, callSid) {
    if (!/^CA[0-9a-fA-F]{32}$/.test(callSid)) return false;
    const result = db.prepare(`UPDATE approval_callbacks SET call_sid=?, state='dialed'
      WHERE approval_id=? AND nonce=? AND state IN ('planned','dialed') AND (call_sid IS NULL OR call_sid=?)`)
      .run(callSid, approvalId, nonce, callSid);
    if (result.changes) recordApprovalCall(approvalId, callSid);
    return result.changes === 1;
  }

  function recordApprovalCall(approvalId, callSid) {
    db.prepare(`INSERT OR IGNORE INTO call_attempts
      (id, session_id, call_sid, phone_number, direction, state, started_at)
      SELECT ?, t.session_id, ?, u.phone_number, 'outbound', 'authenticating', ?
      FROM approvals a JOIN agent_runs r ON r.id=a.run_id JOIN tasks t ON t.id=r.task_id
      JOIN sessions s ON s.id=t.session_id JOIN users u ON u.id=s.user_id WHERE a.id=?`)
      .run(randomUUID(), callSid, now(), approvalId);
  }

  function recordApprovalCallEnd({ approvalId, nonce, callSid, status }) {
    const reasons = { completed: 'callback_completed', busy: 'callback_busy', failed: 'callback_failed',
      'no-answer': 'callback_no_answer', canceled: 'callback_canceled' };
    if (!Object.hasOwn(reasons, status) || !/^CA[0-9a-fA-F]{32}$/.test(callSid)) return false;
    return transaction(() => {
      const callback = db.prepare('SELECT * FROM approval_callbacks WHERE approval_id=? AND nonce=?').get(approvalId, nonce);
      if (!callback || (callback.call_sid && callback.call_sid !== callSid)) return false;
      if (!callback.call_sid) {
        // A REST timeout can leave the create outcome uncertain. A later signed
        // terminal webhook supplies its SID without reopening authentication.
        db.prepare('UPDATE approval_callbacks SET call_sid=? WHERE approval_id=? AND call_sid IS NULL').run(callSid, approvalId);
        recordApprovalCall(approvalId, callSid);
      }
      const call = db.prepare('SELECT * FROM call_attempts WHERE call_sid=?').get(callSid);
      if (!call || ['ended', 'rejected'].includes(call.state)) return false;
      setCallState(callSid, 'ended', reasons[status]);
      // The call ending is never an approval or rejection. A pending action
      // stays paused until its independent approval timer expires.
      db.prepare("UPDATE approval_callbacks SET state='failed' WHERE approval_id=? AND state IN ('planned','dialed')").run(approvalId);
      audit(call.session_id, 'callback.ended', { approvalId, status });
      return true;
    });
  }

  function verifyApprovalCallbackPin(approvalId, callSid) {
    return db.prepare(`UPDATE approval_callbacks SET pin_verified=1
      WHERE approval_id=? AND call_sid=? AND state='dialed'`).run(approvalId, callSid).changes === 1;
  }

  function finishApprovalCallback(approvalId, callSid) {
    db.prepare(`UPDATE approval_callbacks SET state='finished'
      WHERE approval_id=? AND call_sid=? AND state='dialed'`).run(approvalId, callSid);
  }

  function decideApproval({ approvalId, runId, actionDigest, userId, approved, inboundCallSid = null }) {
    if (typeof approved !== 'boolean') throw new Error('approval decision must be explicit');
    return transaction(() => {
      const approval = db.prepare(`SELECT a.*, r.state AS run_state, s.user_id AS session_user_id, s.id AS session_id
        FROM approvals a JOIN agent_runs r ON r.id=a.run_id
        JOIN tasks t ON t.id=r.task_id JOIN sessions s ON s.id=t.session_id
        WHERE a.id=?`).get(approvalId);
      if (!approval || approval.state !== 'pending' || approval.run_state !== 'waiting_human' || approval.run_id !== runId ||
          approval.action_digest !== actionDigest || approval.session_user_id !== userId) return false;
      if (inboundCallSid !== null) {
        // Same-call consent reuses this call's successful PIN authentication,
        // not caller ID or another call's authentication. Never race a callback.
        const authenticatedCall = db.prepare(`SELECT 1 FROM call_attempts c
          WHERE c.call_sid=? AND c.session_id=? AND c.direction='inbound' AND c.state='streaming'
          AND EXISTS (SELECT 1 FROM audit_events e WHERE e.session_id=c.session_id
            AND e.type='call.authenticated' AND json_extract(e.redacted_payload, '$.callSid')=c.call_sid)
          AND NOT EXISTS (SELECT 1 FROM approval_callbacks WHERE approval_id=?)`)
          .get(inboundCallSid, approval.session_id, approvalId);
        if (!authenticatedCall) return false;
      }
      const next = approval.expires_at <= now() ? 'expired' : (approved === true ? 'approved' : 'rejected');
      if (!canTransitionApproval(approval.state, next)) return false;
      db.prepare('UPDATE approvals SET state=?, resolved_at=?, decided_by_user_id=? WHERE id=?')
        .run(next, now(), userId, approvalId);
      db.prepare(`INSERT INTO audit_events (id, session_id, type, redacted_payload, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), approval.session_id, 'approval.decided', JSON.stringify({ approvalId, state: next,
          ...(inboundCallSid !== null ? { channel: 'inbound', callSid: inboundCallSid } : {}) }), now());
      return next === 'approved';
    });
  }

  function expirePendingApprovalsForRun(runId) {
    return db.prepare(`UPDATE approvals SET state='expired', resolved_at=?
      WHERE run_id=? AND state='pending'`).run(now(), runId).changes;
  }

  function applyEventOnce({ eventId, machineId, type }, work = () => {}) {
    return transaction(() => {
      const result = db.prepare(`INSERT OR IGNORE INTO processed_events (event_id, machine_id, type, processed_at)
        VALUES (?, ?, ?, ?)`).run(eventId, machineId, type, now());
      if (!result.changes) return false;
      work(db);
      return true;
    });
  }

  function audit(sessionId, type, redactedPayload = {}) {
    db.prepare(`INSERT INTO audit_events (id, session_id, type, redacted_payload, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), sessionId, type, JSON.stringify(redactedPayload), now());
  }

  function recoverAfterRestart() {
    const time = now();
    const calls = db.prepare(`UPDATE call_attempts SET state='ended', ended_reason='server_restart', ended_at=?
      WHERE state IN ('received','authenticating','streaming')`).run(time).changes;
    const machines = db.prepare("UPDATE machines SET connection_status='offline' WHERE connection_status='online'").run().changes;
    return { calls, machines };
  }

  function unfinishedRunsForMachine(machineId) {
    return db.prepare(`SELECT r.id AS runId, r.task_id AS taskId, t.session_id AS sessionId
      FROM agent_runs r JOIN tasks t ON t.id=r.task_id JOIN sessions s ON s.id=t.session_id
      WHERE s.machine_id=? AND r.state IN ('queued','running','waiting_human')`).all(machineId);
  }

  function reconcileMachineRuns(machineId, activeRunIds, candidates) {
    const active = new Set(activeRunIds);
    const prior = new Set(candidates);
    const interrupted = [];
    for (const run of unfinishedRunsForMachine(machineId)) {
      if (active.has(run.runId) || !prior.has(run.runId)) continue;
      transitionRun(run.runId, 'failed');
      transitionTask(run.taskId, 'failed');
      expirePendingApprovalsForRun(run.runId);
      const reason = 'The daemon no longer owns this task. Its outcome is uncertain; check the repository before retrying.';
      db.prepare('UPDATE tasks SET result_text=? WHERE id=?').run(reason, run.taskId);
      audit(run.sessionId, 'task.interrupted', { runId: run.runId, taskId: run.taskId });
      interrupted.push({ ...run, machineId, type: 'task.failed', reason });
    }
    return interrupted;
  }

  return {
    ensureUser, ensureMachine, setMachineStatus, touchMachine,
    startInboundCall, recordRejectedCall, setCallState,
    recordAuthFailure, isAuthLocked, clearAuthFailures,
    assignSessionAgent, createTask, transitionTask, createRun, transitionRun, setCodexRunIds,
    createApproval, decideApproval, expirePendingApprovalsForRun,
    prepareApprovalCallback, markApprovalCallbackDialed, recordApprovalCallEnd,
    markApprovalCallbackFailed, bindApprovalCallback, verifyApprovalCallbackPin,
    finishApprovalCallback, applyEventOnce, audit, recoverAfterRestart,
    unfinishedRunsForMachine, reconcileMachineRuns,
    setTaskResult: (taskId, text) => db.prepare('UPDATE tasks SET result_text=? WHERE id=?').run(text.slice(0, 4000), taskId),
    getCall: (callSid) => db.prepare('SELECT * FROM call_attempts WHERE call_sid=?').get(callSid),
    getMachine: (machineId) => db.prepare('SELECT id, name, connection_status AS status, last_seen_at AS lastSeenAt FROM machines WHERE id=?').get(machineId),
    getTask: (taskId) => db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId),
    getLatestTaskForUser: (userId) => db.prepare(`SELECT t.id, t.session_id, t.state, t.result_text,
      t.started_at, s.machine_id, m.connection_status AS machine_status
      FROM tasks t JOIN sessions s ON s.id=t.session_id
      LEFT JOIN machines m ON m.id=s.machine_id
      WHERE s.user_id=? ORDER BY t.started_at DESC, t.rowid DESC LIMIT 1`).get(userId),
    listTasksForSession: (sessionId) => db.prepare('SELECT * FROM tasks WHERE session_id=? ORDER BY started_at').all(sessionId),
    getSession: (sessionId) => db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId),
    getRun: (runId) => db.prepare('SELECT * FROM agent_runs WHERE id=?').get(runId),
    getRunForTask: (taskId) => db.prepare('SELECT * FROM agent_runs WHERE task_id=? ORDER BY started_at DESC LIMIT 1').get(taskId),
    getApproval: (approvalId) => db.prepare('SELECT * FROM approvals WHERE id=?').get(approvalId),
    hasApprovedApprovalForRun: (runId) => Boolean(db.prepare(`SELECT 1 FROM approvals WHERE run_id=? AND state='approved'
      AND NOT EXISTS (SELECT 1 FROM approvals WHERE run_id=? AND state != 'approved') LIMIT 1`).get(runId, runId)),
    getApprovalContext: (approvalId) => db.prepare(`SELECT a.*, r.task_id, t.session_id, s.machine_id, s.user_id,
      (SELECT json_extract(e.redacted_payload, '$.actionKind') FROM audit_events e
        WHERE e.session_id=t.session_id AND e.type='approval.required'
        AND json_extract(e.redacted_payload, '$.approvalId')=a.id LIMIT 1) AS action_kind
      FROM approvals a JOIN agent_runs r ON r.id=a.run_id JOIN tasks t ON t.id=r.task_id
      JOIN sessions s ON s.id=t.session_id WHERE a.id=?`).get(approvalId),
    getApprovalCallback: (approvalId) => db.prepare('SELECT * FROM approval_callbacks WHERE approval_id=?').get(approvalId),
    getPendingApprovalForSession: (sessionId) => db.prepare(`SELECT a.id FROM approvals a
      JOIN agent_runs r ON r.id=a.run_id JOIN tasks t ON t.id=r.task_id
      WHERE t.session_id=? AND a.state='pending' AND a.expires_at>? ORDER BY a.expires_at LIMIT 1`).get(sessionId, now()),
    getDecidedApprovalsForMachine: (machineId) => db.prepare(`SELECT a.id, a.run_id, a.action_digest, a.state,
      r.task_id, t.session_id FROM approvals a JOIN agent_runs r ON r.id=a.run_id
      JOIN tasks t ON t.id=r.task_id JOIN sessions s ON s.id=t.session_id
      WHERE s.machine_id=? AND a.state IN ('approved','rejected') AND r.state='waiting_human'`).all(machineId),
    getUndialedApprovalsForMachine: (machineId) => db.prepare(`SELECT a.id, a.run_id
      FROM approvals a JOIN agent_runs r ON r.id=a.run_id JOIN tasks t ON t.id=r.task_id
      JOIN sessions s ON s.id=t.session_id LEFT JOIN approval_callbacks c ON c.approval_id=a.id
      WHERE s.machine_id=? AND r.state='waiting_human' AND a.state='pending'
      AND a.expires_at>? AND c.approval_id IS NULL`).all(machineId, now()),
    listAudit: (sessionId) => db.prepare('SELECT type, redacted_payload AS payload FROM audit_events WHERE session_id=? ORDER BY created_at').all(sessionId),
    close: () => db.close(),
  };
}
