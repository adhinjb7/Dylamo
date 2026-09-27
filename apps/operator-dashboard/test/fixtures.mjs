// Builds fake SQLite databases shaped like the voice server's live store, so
// dashboard tests never need Twilio, OpenAI, a real call, or the live database.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Copied from apps/voice-webhook/src/state.mjs (schema user_version 2). The
// dashboard must not import voice-server internals, so keep this in sync by hand
// when that schema changes.
export const SCHEMA_VERSION = 2;
export const SCHEMA = `
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
  started_at INTEGER NOT NULL, finished_at INTEGER
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
  codex_item_id TEXT, codex_request_id TEXT,
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
`;

// Distinctive fake values planted in private columns. The redaction tests
// assert that none of these strings reach /api/snapshot or the HTML page.
export const SECRETS = Object.freeze({
  callerPhone: '+15065550199',
  rejectedPhone: '+15065550142',
  pinHash: 'scrypt:FIXTURE-PIN-HASH-9f3a',
  tokenHash: 'FIXTURE-TOKEN-HASH-7c21',
  callSid: 'CAFIXTURESECRETSID0001',
  callbackSid: 'CAFIXTURECALLBACKSID02',
  prompt: 'FIXTURE-SECRET-PROMPT run the auth tests',
  command: 'git push FIXTURE-SECRET-REMOTE demo-branch',
  cwd: '/FIXTURE-SECRET-CWD/demo-repository',
  nonce: 'FIXTURE-CALLBACK-NONCE-5b8e',
  codexThreadId: 'FIXTURE-CODEX-THREAD-11',
  codexTurnId: 'FIXTURE-CODEX-TURN-12',
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Fixed UUIDs make failures readable and let tests look rows up directly.
export const IDS = Object.freeze({
  user: '00000000-0000-4000-8000-000000000001',
  laptop: '00000000-0000-4000-8000-00000000000a',
  desktop: '00000000-0000-4000-8000-00000000000b',
  agent: '00000000-0000-4000-8000-0000000000a1',
  sessionDone: '00000000-0000-4000-8000-000000000101',
  sessionLive: '00000000-0000-4000-8000-000000000102',
  sessionWaiting: '00000000-0000-4000-8000-000000000103',
  taskCompleted: '00000000-0000-4000-8000-000000000201',
  taskRunning: '00000000-0000-4000-8000-000000000202',
  taskWaiting: '00000000-0000-4000-8000-000000000203',
  taskFailed: '00000000-0000-4000-8000-000000000204',
  runCompleted: '00000000-0000-4000-8000-000000000301',
  runRunning: '00000000-0000-4000-8000-000000000302',
  runWaiting: '00000000-0000-4000-8000-000000000303',
  runFailed: '00000000-0000-4000-8000-000000000304',
  approval: '00000000-0000-4000-8000-000000000401',
});

export function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'operator-dashboard-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Creates a database with the live schema. `seed: false` gives the empty state
// seen right after the voice server first starts. `extraTasks` adds many
// completed tasks for testing that recent lists stay bounded.
export function createFixtureDatabase(path, { seed = true, now = Date.now(), extraTasks = 0 } = {}) {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    if (seed) seedDemoData(db, now);
    if (extraTasks) seedExtraTasks(db, now, extraTasks);
  } finally {
    db.close();
  }
  return path;
}

// A file that is a valid SQLite database but not the voice server's store.
export function createUnrelatedDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
  db.close();
  return path;
}

// Every row in every table, for proving the dashboard changed nothing.
export function dumpDatabase(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all();
    return Object.fromEntries(tables.map(({ name }) => [
      name,
      db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
    ]));
  } finally {
    db.close();
  }
}

function seedDemoData(db, now) {
  const insert = (sql, ...values) => db.prepare(sql).run(...values);

  insert('INSERT INTO users VALUES (?, ?, ?, ?, ?)',
    IDS.user, SECRETS.callerPhone, SECRETS.pinHash, 'Demo caller', now - 48 * HOUR);

  // One connected laptop and one machine that went offline hours ago.
  insert('INSERT INTO machines VALUES (?, ?, ?, ?, ?, ?, ?)',
    IDS.laptop, IDS.user, 'Demo laptop', SECRETS.tokenHash, 'online', now - 2_000, now - 48 * HOUR);
  insert('INSERT INTO machines VALUES (?, ?, ?, ?, ?, ?, ?)',
    IDS.desktop, IDS.user, 'Old desktop', SECRETS.tokenHash, 'offline', now - 3 * HOUR, now - 48 * HOUR);

  for (const [id, state, age] of [
    [IDS.sessionDone, 'closed', 90 * MINUTE],
    [IDS.sessionLive, 'active', 4 * MINUTE],
    [IDS.sessionWaiting, 'active', 40 * MINUTE],
  ]) {
    insert('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, IDS.user, IDS.laptop, IDS.agent, state, 'voice', now - age, now - age);
  }

  const call = (id, sessionId, sid, phone, direction, state, reason, startedAgo, endedAgo) =>
    insert('INSERT INTO call_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, sessionId, sid, phone, direction, state, reason,
      now - startedAgo, endedAgo == null ? null : now - endedAgo);
  // Yesterday's call should not count toward "calls today".
  call('c0000000-0000-4000-8000-000000000001', null, 'CAFIXTUREYESTERDAY0001', SECRETS.callerPhone,
    'inbound', 'ended', 'completed', 26 * HOUR, 26 * HOUR - 3 * MINUTE);
  call('c0000000-0000-4000-8000-000000000002', IDS.sessionDone, SECRETS.callSid, SECRETS.callerPhone,
    'inbound', 'ended', 'completed', 90 * MINUTE, 85 * MINUTE);
  // An unknown caller rejected before PIN entry has no session.
  call('c0000000-0000-4000-8000-000000000003', null, 'CAFIXTUREREJECTED00003', SECRETS.rejectedPhone,
    'inbound', 'rejected', 'caller_not_allowed', 60 * MINUTE, 60 * MINUTE);
  call('c0000000-0000-4000-8000-000000000004', IDS.sessionWaiting, 'CAFIXTUREWAITING000004', SECRETS.callerPhone,
    'inbound', 'ended', 'completed', 40 * MINUTE, 35 * MINUTE);
  call('c0000000-0000-4000-8000-000000000005', IDS.sessionLive, 'CAFIXTURELIVECALL00005', SECRETS.callerPhone,
    'inbound', 'streaming', null, 4 * MINUTE, null);

  const task = (id, sessionId, state, startedAgo, finishedAgo) =>
    insert('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?)',
      id, sessionId, SECRETS.prompt, state, now - startedAgo, finishedAgo == null ? null : now - finishedAgo);
  task(IDS.taskCompleted, IDS.sessionDone, 'completed', 88 * MINUTE, 80 * MINUTE);
  task(IDS.taskFailed, IDS.sessionDone, 'failed', 86 * MINUTE, 84 * MINUTE);
  task(IDS.taskWaiting, IDS.sessionWaiting, 'waiting_human', 38 * MINUTE, null);
  task(IDS.taskRunning, IDS.sessionLive, 'running', 3 * MINUTE, null);

  // Only the Codex runs record a thread/turn; fake-agent runs leave them null.
  const run = (id, taskId, state, codex, startedAgo, finishedAgo) =>
    insert('INSERT INTO agent_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, taskId, IDS.agent,
      codex ? `${SECRETS.codexThreadId}-${id.slice(-3)}` : null,
      codex ? `${SECRETS.codexTurnId}-${id.slice(-3)}` : null,
      state, null, now - startedAgo, finishedAgo == null ? null : now - finishedAgo);
  run(IDS.runCompleted, IDS.taskCompleted, 'completed', false, 88 * MINUTE, 80 * MINUTE);
  run(IDS.runFailed, IDS.taskFailed, 'failed', true, 86 * MINUTE, 84 * MINUTE);
  run(IDS.runWaiting, IDS.taskWaiting, 'waiting_human', true, 38 * MINUTE, null);
  run(IDS.runRunning, IDS.taskRunning, 'running', true, 3 * MINUTE, null);

  // The waiting task is paused at a protected action with a callback dialed.
  insert('INSERT INTO approvals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    IDS.approval, IDS.runWaiting, 'a'.repeat(64), SECRETS.command, SECRETS.cwd,
    null, null, 'pending', now + 20 * MINUTE, null, null);
  insert('INSERT INTO approval_callbacks VALUES (?, ?, ?, ?, ?, ?)',
    IDS.approval, SECRETS.nonce, SECRETS.callbackSid, 0, 'dialed', now - 30 * MINUTE);

  insert('INSERT INTO audit_events VALUES (?, ?, ?, ?, ?)',
    'e0000000-0000-4000-8000-000000000001', IDS.sessionDone, 'task.completed', '{}', now - 80 * MINUTE);
  insert('INSERT INTO processed_events VALUES (?, ?, ?, ?)',
    'e0000000-0000-4000-8000-000000000002', IDS.laptop, 'task.completed', now - 80 * MINUTE);
  insert('INSERT INTO auth_failures VALUES (?, ?, ?)',
    SECRETS.rejectedPhone, 1, now + 14 * MINUTE);
}

function seedExtraTasks(db, now, count) {
  // Tasks need a session. Reuse the seeded one, or add a minimal one to an empty database.
  if (!db.prepare('SELECT 1 FROM sessions WHERE id=?').get(IDS.sessionDone)) {
    db.prepare('INSERT OR IGNORE INTO users VALUES (?, ?, ?, ?, ?)')
      .run(IDS.user, SECRETS.callerPhone, SECRETS.pinHash, 'Demo caller', now);
    db.prepare('INSERT INTO sessions VALUES (?, ?, NULL, NULL, ?, ?, ?, ?)')
      .run(IDS.sessionDone, IDS.user, 'closed', 'voice', now, now);
  }
  const insert = db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  for (let i = 0; i < count; i += 1) {
    const id = `f0000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    insert.run(id, IDS.sessionDone, SECRETS.prompt, 'completed', now - (i + 1) * MINUTE, now - i * MINUTE);
  }
  db.exec('COMMIT');
}
