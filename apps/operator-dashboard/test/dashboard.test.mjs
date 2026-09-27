import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDaemonUrl } from '../src/daemon-health.mjs';
import { BIND_HOST, parseArgs, startDashboard } from '../src/server.mjs';
import { RECENT_LIMIT, TIMELINE_LIMIT } from '../src/snapshot.mjs';
import {
  IDS, SECRETS, createFixtureDatabase, createUnrelatedDatabase, dumpDatabase, makeTempDir,
} from './fixtures.mjs';

const serverScript = fileURLToPath(new URL('../src/server.mjs', import.meta.url));

// A fixed midday clock keeps "earlier today" fixture rows on the same calendar
// day, whatever time the tests actually run.
const NOW = new Date(2026, 8, 26, 12, 0, 0).getTime();

async function withDashboard(t, { seed = true, extraTasks = 0, daemonUrl = null } = {}) {
  const { dir, cleanup } = makeTempDir();
  t.after(cleanup);
  const dbPath = createFixtureDatabase(join(dir, 'agent-phone.db'), { seed, extraTasks, now: NOW });
  const server = await startDashboard({ dbPath, port: 0, daemonUrl, now: () => NOW });
  t.after(() => new Promise((done) => server.close(done)));
  const base = `http://${BIND_HOST}:${server.address().port}`;
  return { dir, dbPath, server, base };
}

async function getJson(base, path = '/api/snapshot') {
  const response = await fetch(base + path);
  return { response, body: await response.json() };
}

function request(base, { method = 'GET', path = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { method, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [serverScript, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill(), 5000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

test('populated snapshot summarizes machines, calls, tasks and activity', async (t) => {
  const { base } = await withDashboard(t);
  const { response, body } = await getJson(base);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(body.database, { ok: true });
  assert.deepEqual(body.machines.map((m) => [m.name, m.status]), [['Demo laptop', 'online'], ['Old desktop', 'offline']]);

  // Yesterday's call is excluded from today's count but still listed as recent.
  assert.equal(body.calls.today.total, 4);
  assert.deepEqual(body.calls.today.byState, { received: 0, authenticating: 0, streaming: 1, rejected: 1, ended: 2 });
  assert.equal(body.calls.recent.length, 5);
  assert.equal(body.calls.recent[0].state, 'streaming');
  assert.equal(body.calls.recent[0].endedAt, null);

  assert.deepEqual(body.tasks.byState, { queued: 0, running: 1, waiting_human: 1, completed: 1, failed: 1, cancelled: 0 });
  const running = body.tasks.recent.find((task) => task.state === 'running');
  assert.equal(running.id, IDS.taskRunning.replace(/-/g, '').slice(-6));
  assert.equal(running.elapsedMs, 3 * 60_000);
  assert.equal(running.codexThreadRecorded, true);
  assert.equal(body.tasks.recent.find((task) => task.state === 'completed').codexThreadRecorded, false);
  assert.equal(body.approvals.pending, 1);
  assert.ok(body.timeline.length > 0);
  assert.equal(body.daemon, null);
});

test('snapshot and page never expose private values', async (t) => {
  const { base, dbPath } = await withDashboard(t);
  const exposed = [
    await (await fetch(`${base}/api/snapshot`)).text(),
    await (await fetch(`${base}/`)).text(),
    await (await fetch(`${base}/app.js`)).text(),
  ].join('\n');

  for (const [name, value] of Object.entries(SECRETS)) {
    assert.ok(!exposed.includes(value), `leaked ${name}`);
  }
  assert.ok(!exposed.includes(dbPath), 'leaked database path');
  for (const id of Object.values(IDS)) assert.ok(!exposed.includes(id), `leaked full id ${id}`);
});

test('empty database reports zero counts and empty lists', async (t) => {
  const { base } = await withDashboard(t, { seed: false });
  const { response, body } = await getJson(base);
  assert.equal(response.status, 200);
  assert.deepEqual(body.machines, []);
  assert.equal(body.calls.today.total, 0);
  assert.deepEqual(body.calls.recent, []);
  assert.ok(Object.values(body.tasks.byState).every((n) => n === 0));
  assert.deepEqual(body.tasks.recent, []);
  assert.deepEqual(body.timeline, []);
});

test('recent lists stay bounded on a large database', async (t) => {
  const { base } = await withDashboard(t, { extraTasks: 500 });
  const { body } = await getJson(base);
  assert.equal(body.tasks.byState.completed, 501);
  assert.equal(body.tasks.recent.length, RECENT_LIMIT);
  assert.equal(body.timeline.length, TIMELINE_LIMIT);
});

test('requests leave every database record unchanged', async (t) => {
  const { base, dbPath } = await withDashboard(t);
  const before = dumpDatabase(dbPath);
  for (let i = 0; i < 5; i += 1) await getJson(base);
  await request(base, { method: 'POST', path: '/api/snapshot' });
  await request(base, { method: 'DELETE', path: '/api/snapshot' });
  assert.deepEqual(dumpDatabase(dbPath), before);
});

test('only GET and HEAD are served', async (t) => {
  const { base } = await withDashboard(t);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await request(base, { method, path: '/api/snapshot' });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.allow, 'GET, HEAD');
  }
  const head = await request(base, { method: 'HEAD', path: '/' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal((await request(base, { path: '/api/sql' })).status, 404);
  assert.equal((await request(base, { path: '/../package.json' })).status, 404);
});

test('rejects requests addressed to another host name', async (t) => {
  const { base } = await withDashboard(t);
  const response = await request(base, { path: '/api/snapshot', headers: { host: 'attacker.example:3330' } });
  assert.equal(response.status, 421);
});

test('binds to loopback only and has no host option', async (t) => {
  const { server } = await withDashboard(t);
  assert.equal(server.address().address, '127.0.0.1');
  assert.throws(() => parseArgs(['--db', '/tmp/x.db', '--host', '0.0.0.0']), /Unknown option: --host/);
});

test('a database that disappears mid-run shows an error, then recovers', async (t) => {
  const { base, dbPath } = await withDashboard(t);
  const writer = new DatabaseSync(dbPath);
  writer.exec('ALTER TABLE tasks RENAME TO tasks_hidden');
  const broken = await getJson(base);
  assert.equal(broken.response.status, 503);
  assert.deepEqual(broken.body.database, { ok: false, error: 'Database unavailable' });

  writer.exec('ALTER TABLE tasks_hidden RENAME TO tasks');
  writer.close();
  assert.equal((await getJson(base)).response.status, 200);
});

test('bad database paths fail with a helpful message', async (t) => {
  const { dir, cleanup } = makeTempDir();
  t.after(cleanup);
  const notSqlite = join(dir, 'notes.txt');
  writeFileSync(notSqlite, 'FIXTURE-SECRET-FILE-CONTENTS');
  const unrelated = createUnrelatedDatabase(join(dir, 'other.db'));

  const cases = [
    [[], /--db .* is required/],
    [['--db', 'relative.db'], /absolute path/],
    [['--db', join(dir, 'missing.db')], /not found/],
    [['--db', dir], /not a file/],
    [['--db', notSqlite], /Could not open .* as a SQLite database/],
    [['--db', unrelated], /missing expected agent-phone tables/],
  ];
  for (const [args, pattern] of cases) {
    const { code, output } = await runCli([...args, '--no-daemon']);
    assert.notEqual(code, 0, args.join(' '));
    assert.match(output, pattern);
    assert.ok(!output.includes('FIXTURE-SECRET-FILE-CONTENTS'));
  }
  // Opening read-only must not create the missing file.
  assert.equal(dumpDatabase(unrelated).notes.length, 0);
});

test('a port already in use fails clearly', async (t) => {
  const { server, dbPath } = await withDashboard(t);
  const { code, output } = await runCli(['--db', dbPath, '--no-daemon', '--port', String(server.address().port)]);
  assert.equal(code, 1);
  assert.match(output, /already in use/);
});

test('daemon URL must be loopback', () => {
  assert.equal(parseDaemonUrl('http://127.0.0.1:3210/health').port, '3210');
  for (const bad of ['http://192.168.1.5:3210/health', 'http://example.com/health', 'https://127.0.0.1/health', 'file:///etc/passwd']) {
    assert.throws(() => parseDaemonUrl(bad), /daemon URL|Invalid/, bad);
  }
});

test('daemon health is optional, separate and filtered', async (t) => {
  const daemon = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      machineId: IDS.laptop, name: 'Demo laptop', state: 'connected', lastConnectedAt: '2026-09-26T15:00:00.000Z',
      token: SECRETS.tokenHash,
      agents: [{ agentId: IDS.agent, adapterType: 'codex', name: 'Codex read-only agent', status: 'idle', secret: SECRETS.prompt }],
    }));
  });
  await new Promise((done) => daemon.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => daemon.close(done)));

  const { base } = await withDashboard(t, { daemonUrl: parseDaemonUrl(`http://127.0.0.1:${daemon.address().port}/health`) });
  const { body } = await getJson(base);
  assert.deepEqual(body.daemon, {
    reachable: true, name: 'Demo laptop', state: 'connected', lastConnectedAt: '2026-09-26T15:00:00.000Z',
    agents: [{ name: 'Codex read-only agent', adapterType: 'codex', status: 'idle' }],
  });
});

test('an offline daemon does not break the snapshot', async (t) => {
  const probe = http.createServer();
  await new Promise((done) => probe.listen(0, '127.0.0.1', done));
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));

  const { base } = await withDashboard(t, { daemonUrl: parseDaemonUrl(`http://127.0.0.1:${port}/health`) });
  const { response, body } = await getJson(base);
  assert.equal(response.status, 200);
  assert.deepEqual(body.daemon, { reachable: false, error: 'Daemon not reachable' });
});
