// Local, read-only operator dashboard for the phone-to-agent demo.
// Usage: node apps/operator-dashboard/src/server.mjs --db <path> [--port 3330]
//          [--daemon-url http://127.0.0.1:3210/health | --no-daemon]
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DAEMON_URL, parseDaemonUrl, readDaemonHealth } from './daemon-health.mjs';
import { DashboardDatabaseError, openDashboardDatabase, readSnapshot } from './snapshot.mjs';

// Deliberately not configurable: the dashboard is never reachable off this machine.
export const BIND_HOST = '127.0.0.1';
export const DEFAULT_PORT = 3330;

const publicDir = new URL('../public/', import.meta.url);
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export function createDashboardServer({ dbPath, daemonUrl = null, now = Date.now }) {
  let db = openDashboardDatabase(dbPath);
  const assets = Object.fromEntries(Object.entries(STATIC_FILES).map(([route, [file, type]]) =>
    [route, { body: readFileSync(new URL(file, publicDir)), type }]));

  function currentSnapshot() {
    try {
      db ??= openDashboardDatabase(dbPath);
      return { ok: true, ...readSnapshot(db, now()) };
    } catch {
      // Drop the handle so the next poll retries; never send the error text,
      // which could name the file path.
      try { db?.close(); } catch {}
      db = null;
      return { ok: false, error: 'Database unavailable' };
    }
  }

  const server = http.createServer(async (request, response) => {
    const send = (status, headers, body = '') => {
      response.writeHead(status, { ...SECURITY_HEADERS, 'cache-control': 'no-store', ...headers,
        'content-length': Buffer.byteLength(body) });
      response.end(request.method === 'HEAD' ? undefined : body);
    };

    // Reject other Host names so a web page cannot use DNS rebinding to read the API.
    const port = server.address()?.port;
    if (request.headers.host !== `${BIND_HOST}:${port}` && request.headers.host !== `localhost:${port}`) {
      return send(421, { 'content-type': 'text/plain; charset=utf-8' }, 'Misdirected request');
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return send(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' }, 'Method not allowed');
    }

    const { pathname } = new URL(request.url, 'http://localhost');
    if (pathname === '/api/snapshot') {
      const [snapshot, daemon] = await Promise.all([
        currentSnapshot(),
        daemonUrl ? readDaemonHealth(daemonUrl) : null,
      ]);
      const { ok, error, ...data } = snapshot;
      const body = JSON.stringify({ generatedAt: now(), database: ok ? { ok } : { ok, error }, ...data, daemon });
      return send(ok ? 200 : 503, { 'content-type': 'application/json; charset=utf-8' }, body);
    }
    const asset = assets[pathname];
    if (asset) return send(200, { 'content-type': asset.type }, asset.body);
    return send(404, { 'content-type': 'text/plain; charset=utf-8' }, 'Not found');
  });

  server.on('close', () => { try { db?.close(); } catch {} db = null; });
  return server;
}

export function parseArgs(argv) {
  const options = { dbPath: null, port: DEFAULT_PORT, daemonUrl: parseDaemonUrl(DEFAULT_DAEMON_URL) };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--db') options.dbPath = value();
    else if (arg === '--port') options.port = parsePort(value());
    else if (arg === '--daemon-url') options.daemonUrl = parseDaemonUrl(value());
    else if (arg === '--no-daemon') options.daemonUrl = null;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.dbPath) throw new Error('--db <absolute-path-to-agent-phone.db> is required');
  if (!isAbsolute(options.dbPath)) throw new Error('--db must be an absolute path');
  options.dbPath = resolve(options.dbPath);
  return options;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${value}`);
  return port;
}

export function startDashboard(options) {
  const server = createDashboardServer(options);
  return new Promise((resolvePromise, reject) => {
    server.once('error', (error) => {
      server.close();
      reject(error.code === 'EADDRINUSE'
        ? new Error(`Port ${options.port} on ${BIND_HOST} is already in use. Stop the other process or pass --port.`)
        : error);
    });
    server.listen(options.port, BIND_HOST, () => resolvePromise(server));
  });
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`operator-dashboard: ${error.message}`);
    console.error('Usage: node apps/operator-dashboard/src/server.mjs --db <absolute-path> [--port 3330] [--daemon-url <loopback-url> | --no-daemon]');
    process.exit(2);
  }
  try {
    const server = await startDashboard(options);
    const { port } = server.address();
    console.log(`Operator dashboard (read-only): http://${BIND_HOST}:${port}/`);
    console.log(options.daemonUrl ? `Daemon health: ${options.daemonUrl.href}` : 'Daemon health: disabled');
    const stop = () => server.close(() => process.exit(0));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    const message = error instanceof DashboardDatabaseError || error.message.includes('already in use')
      ? error.message
      : `could not start (${error.code ?? 'error'})`;
    console.error(`operator-dashboard: ${message}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
