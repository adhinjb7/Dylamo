import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  IDS, SCHEMA, SECRETS, createFixtureDatabase, createUnrelatedDatabase, dumpDatabase, makeTempDir,
} from './fixtures.mjs';

const liveStatePath = new URL('../../voice-webhook/src/state.mjs', import.meta.url);

function columnsBySchema(schemaSql) {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all();
  const result = Object.fromEntries(tables.map(({ name }) => [
    name,
    db.prepare(`PRAGMA table_info("${name}")`).all().map(({ name: column, type, notnull }) => `${column}:${type}:${notnull}`),
  ]));
  db.close();
  return result;
}

test('fixture schema matches the voice server schema', () => {
  // Reads the live schema as text instead of importing voice-server code.
  const source = readFileSync(liveStatePath, 'utf8');
  const liveSchema = source.match(/const SCHEMA = `([\s\S]*?)`;/)?.[1];
  assert.ok(liveSchema, 'could not find SCHEMA in apps/voice-webhook/src/state.mjs');
  assert.deepEqual(columnsBySchema(SCHEMA), columnsBySchema(liveSchema));
});

test('seeded fixture covers each dashboard state', (t) => {
  const { dir, cleanup } = makeTempDir();
  t.after(cleanup);
  const path = createFixtureDatabase(join(dir, 'agent-phone.db'));
  const rows = dumpDatabase(path);

  assert.deepEqual(rows.machines.map((m) => m.connection_status).sort(), ['offline', 'online']);
  assert.deepEqual(rows.call_attempts.map((c) => c.state).sort(), ['ended', 'ended', 'ended', 'rejected', 'streaming']);
  assert.deepEqual(rows.tasks.map((task) => task.state).sort(), ['completed', 'failed', 'running', 'waiting_human']);
  assert.equal(rows.agent_runs.filter((run) => run.codex_thread_id).length, 3);
  assert.equal(rows.approvals[0].run_id, IDS.runWaiting);

  const everything = JSON.stringify(rows);
  for (const [name, value] of Object.entries(SECRETS)) {
    assert.ok(everything.includes(value), `fixture is missing planted secret ${name}`);
  }
});

test('empty fixture has the schema but no rows', (t) => {
  const { dir, cleanup } = makeTempDir();
  t.after(cleanup);
  const rows = dumpDatabase(createFixtureDatabase(join(dir, 'empty.db'), { seed: false }));
  assert.equal(Object.keys(rows).length, 11);
  assert.ok(Object.values(rows).every((table) => table.length === 0));
});

test('extraTasks creates enough rows to test bounded lists', (t) => {
  const { dir, cleanup } = makeTempDir();
  t.after(cleanup);
  const rows = dumpDatabase(createFixtureDatabase(join(dir, 'big.db'), { extraTasks: 500 }));
  assert.equal(rows.tasks.length, 504);
});

test('closed fixture can be reopened read-only and cannot be written', (t) => {
  const { dir, cleanup } = makeTempDir();
  t.after(cleanup);
  const path = createFixtureDatabase(join(dir, 'agent-phone.db'));
  const db = new DatabaseSync(path, { readOnly: true });
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT count(*) AS n FROM tasks').get().n, 4);
  assert.throws(() => db.exec("UPDATE tasks SET state='failed'"), /readonly/i);
});

test('unrelated database lacks the dashboard tables', (t) => {
  const { dir, cleanup } = makeTempDir();
  t.after(cleanup);
  const rows = dumpDatabase(createUnrelatedDatabase(join(dir, 'other.db')));
  assert.deepEqual(Object.keys(rows), ['notes']);
});
