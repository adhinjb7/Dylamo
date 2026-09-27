// Read-only, allowlisted view of the voice server's SQLite store. Only the
// columns selected below ever leave this module; phone numbers, PIN hashes,
// tokens, prompts, commands, nonces and raw Codex IDs are never queried.
import { accessSync, constants, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const RECENT_LIMIT = 10;
export const TIMELINE_LIMIT = 20;
const MACHINE_LIMIT = 20;

const TASK_STATES = ['queued', 'running', 'waiting_human', 'completed', 'failed', 'cancelled'];
const CALL_STATES = ['received', 'authenticating', 'streaming', 'rejected', 'ended'];

// Columns the dashboard reads. If any are missing, the file is not an
// agent-phone database, or the voice server's schema changed and this
// dashboard needs updating.
const REQUIRED_COLUMNS = {
  machines: ['name', 'connection_status', 'last_seen_at'],
  call_attempts: ['id', 'direction', 'state', 'ended_reason', 'started_at', 'ended_at'],
  tasks: ['id', 'state', 'started_at', 'finished_at'],
  agent_runs: ['id', 'task_id', 'codex_thread_id', 'codex_turn_id', 'state', 'started_at'],
  approvals: ['state'],
};

export class DashboardDatabaseError extends Error {}

export function openDashboardDatabase(path) {
  if (!path) throw new DashboardDatabaseError('A database path is required (--db <absolute-path>).');
  let info;
  try {
    info = statSync(path);
    accessSync(path, constants.R_OK);
  } catch (error) {
    if (error.code === 'ENOENT') throw new DashboardDatabaseError(`Database file not found: ${path}`);
    throw new DashboardDatabaseError(`Database file is not readable: ${path}`);
  }
  if (!info.isFile()) throw new DashboardDatabaseError(`Database path is not a file: ${path}`);

  let db;
  try {
    // readOnly never creates a file, so a typo cannot produce an empty database.
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 2000;');
    checkSchema(db);
  } catch (error) {
    db?.close();
    if (error instanceof DashboardDatabaseError) throw error;
    throw new DashboardDatabaseError(`Could not open ${path} as a SQLite database (${error.code ?? 'error'}).`);
  }
  return db;
}

function checkSchema(db) {
  const missing = [];
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const present = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((column) => column.name));
    if (!present.size) missing.push(table);
    else for (const column of columns) if (!present.has(column)) missing.push(`${table}.${column}`);
  }
  if (missing.length) {
    throw new DashboardDatabaseError(`Database is missing expected agent-phone tables or columns: ${missing.join(', ')}`);
  }
}

export function readSnapshot(db, now = Date.now()) {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  // One read transaction gives every section the same consistent view while
  // the voice server keeps writing through WAL.
  db.exec('BEGIN');
  try {
    return {
      machines: db.prepare(`SELECT name, connection_status AS status, last_seen_at AS lastSeenAt
        FROM machines ORDER BY connection_status = 'online' DESC, name LIMIT ?`).all(MACHINE_LIMIT)
        .map((row) => ({ name: row.name, status: row.status, lastSeenAt: row.lastSeenAt })),
      calls: readCalls(db, startOfToday.getTime(), now),
      tasks: readTasks(db, now),
      approvals: {
        pending: db.prepare("SELECT count(*) AS n FROM approvals WHERE state='pending'").get().n,
      },
      timeline: readTimeline(db),
    };
  } finally {
    db.exec('ROLLBACK');
  }
}

function readCalls(db, since, now) {
  const byState = Object.fromEntries(CALL_STATES.map((state) => [state, 0]));
  let total = 0;
  for (const row of db.prepare(`SELECT state, count(*) AS n FROM call_attempts
    WHERE started_at >= ? GROUP BY state`).all(since)) {
    byState[row.state] = row.n;
    total += row.n;
  }
  const recent = db.prepare(`SELECT id, direction, state, ended_reason, started_at, ended_at
    FROM call_attempts ORDER BY started_at DESC LIMIT ?`).all(RECENT_LIMIT)
    .map((row) => ({
      id: shortId(row.id),
      direction: row.direction,
      state: row.state,
      endedReason: safeCode(row.ended_reason),
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationMs: (row.ended_at ?? now) - row.started_at,
    }));
  return { today: { total, byState }, recent };
}

function readTasks(db, now) {
  const byState = Object.fromEntries(TASK_STATES.map((state) => [state, 0]));
  for (const row of db.prepare('SELECT state, count(*) AS n FROM tasks GROUP BY state').all()) {
    byState[row.state] = row.n;
  }
  // Each task shows its latest run; the Codex IDs only become yes/no flags.
  const recent = db.prepare(`SELECT t.id, t.state, t.started_at, t.finished_at,
      r.state AS run_state,
      r.codex_thread_id IS NOT NULL AS has_thread,
      r.codex_turn_id IS NOT NULL AS has_turn
    FROM tasks t
    LEFT JOIN agent_runs r ON r.id = (
      SELECT id FROM agent_runs WHERE task_id = t.id ORDER BY started_at DESC LIMIT 1)
    ORDER BY t.started_at DESC LIMIT ?`).all(RECENT_LIMIT)
    .map((row) => ({
      id: shortId(row.id),
      state: row.state,
      runState: row.run_state ?? null,
      codexThreadRecorded: Boolean(row.has_thread),
      codexTurnRecorded: Boolean(row.has_turn),
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      elapsedMs: (row.finished_at ?? now) - row.started_at,
    }));
  return { byState, recent };
}

function readTimeline(db) {
  return db.prepare(`
    SELECT 'call' AS kind, id, state, direction AS detail, started_at AS at FROM call_attempts
    UNION ALL
    SELECT 'task', id, state, NULL, COALESCE(finished_at, started_at) FROM tasks
    ORDER BY at DESC LIMIT ?`).all(TIMELINE_LIMIT)
    .map((row) => ({ kind: row.kind, id: shortId(row.id), state: row.state, detail: row.detail, at: row.at }));
}

// Short display ID: enough to match against logs without exposing the full value.
function shortId(id) {
  return String(id).replace(/-/g, '').slice(-6);
}

// ended_reason is set by the voice server; pass through only short lowercase codes.
function safeCode(value) {
  if (value == null) return null;
  return /^[a-z][a-z0-9_-]{0,39}$/.test(value) ? value : 'other';
}
