import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const SYNTHETIC_SITE_MONITOR_SOURCE = 'synthetic-checkout';

const HEALTHY = 'healthy';
const DEGRADED = 'degraded';
const VALID_STATUSES = new Set([HEALTHY, DEGRADED]);

function isoTimestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error('The monitor clock returned an invalid time.');
  return date.toISOString();
}

function normalizeObservation(observation) {
  if (!observation || typeof observation !== 'object') {
    throw new Error('A site-monitor health check must return an observation object.');
  }
  const status = observation.status ?? (observation.ok ? HEALTHY : DEGRADED);
  if (!VALID_STATUSES.has(status)) throw new Error('A site-monitor health check returned an invalid status.');
  const httpStatus = Number(observation.httpStatus ?? (status === HEALTHY ? 200 : 503));
  if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) {
    throw new Error('A site-monitor health check returned an invalid HTTP status.');
  }
  return {
    status,
    ok: status === HEALTHY,
    httpStatus,
    summary: typeof observation.summary === 'string' && observation.summary.trim()
      ? observation.summary.trim()
      : status === HEALTHY ? 'Synthetic checkout is healthy.' : 'Synthetic checkout is degraded.',
  };
}

function eventFor({ source, sequence, observation, observedAt, recoveredIncidentId = null }) {
  const recovered = observation.status === HEALTHY;
  const incidentId = recovered ? recoveredIncidentId : `${source}-${sequence}`;
  return {
    type: recovered ? 'site_monitor.recovered' : 'site_monitor.incident',
    monitorId: 'local-checkout',
    incidentId,
    observedAt,
    ...(recovered ? {} : { condition: 'http_errors' }),
  };
}

/**
 * A small, deterministic monitor core. It emits only state transitions, so a
 * persistent outage leads to one incident and a later recovery leads to one
 * recovery event. The callback is intentionally supplied by the caller: this
 * module never calls a phone, SMS provider, or external service itself.
 */
export function createDeterministicSiteMonitor({
  check,
  onEvent = async () => {},
  onError = () => {},
  source = SYNTHETIC_SITE_MONITOR_SOURCE,
  now = () => new Date(),
  pollIntervalMs = 1_000,
} = {}) {
  if (typeof check !== 'function') throw new Error('A site-monitor health check is required.');
  if (typeof onEvent !== 'function') throw new Error('A site-monitor event callback must be a function.');
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10) {
    throw new Error('pollIntervalMs must be an integer of at least 10 milliseconds.');
  }

  let latestStatus = 'unknown';
  let activeIncidentId = null;
  let sequence = 0;
  let timer = null;
  let inFlight = null;
  let pendingEvent = null;
  let pendingStatus = null;

  async function notify(event, status) {
    const delivered = await onEvent(event);
    // A bridge may explicitly return false when its authenticated daemon
    // connection is down. Treat that as a delivery failure rather than
    // quietly marking the incident as reported.
    if (delivered === false) throw new Error('The site-monitor event was not delivered.');
    pendingEvent = null;
    pendingStatus = null;
    latestStatus = status;
    activeIncidentId = event.type === 'site_monitor.incident' ? event.incidentId : null;
    return event;
  }

  async function runPoll() {
    const observation = normalizeObservation(await check());

    if (pendingEvent) {
      // Never place a stale alert after the local state has changed again.
      // A transient bridge outage while the synthetic page is degraded retries
      // the same incident ID; recovery before delivery simply establishes the
      // current healthy baseline without a misleading phone call.
      if (pendingStatus !== observation.status) {
        pendingEvent = null;
        pendingStatus = null;
        latestStatus = observation.status;
        if (observation.status === HEALTHY) activeIncidentId = null;
        return null;
      }
      return notify(pendingEvent, observation.status);
    }

    const priorStatus = latestStatus;

    // A healthy first observation establishes the baseline quietly. If the
    // service is already down at startup, it is still an actionable incident.
    if (priorStatus === 'unknown' && observation.status === HEALTHY) {
      latestStatus = observation.status;
      return null;
    }
    if (priorStatus === observation.status) return null;

    let event;
    if (observation.status === DEGRADED) {
      event = eventFor({ source, sequence: ++sequence, observation, observedAt: isoTimestamp(now) });
    } else if (activeIncidentId) {
      event = eventFor({ source, sequence, observation, observedAt: isoTimestamp(now),
        recoveredIncidentId: activeIncidentId });
    } else {
      return null;
    }

    // Keep one event pending until the bridge accepts it. This avoids silently
    // losing the alert if the local daemon has briefly disconnected, while the
    // stable incident ID prevents a retry from becoming a second phone alert.
    pendingEvent = event;
    pendingStatus = observation.status;
    return notify(event, observation.status);
  }

  async function poll() {
    if (inFlight) return inFlight;
    inFlight = runPoll();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  function start() {
    if (timer) return;
    void poll().catch(onError);
    timer = setInterval(() => { void poll().catch(onError); }, pollIntervalMs);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    poll,
    start,
    stop,
    snapshot: () => ({ latestStatus, activeIncidentId, pendingEvent: pendingEvent?.incidentId ?? null, running: Boolean(timer) }),
  };
}

function htmlPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dylamo synthetic site monitor</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #07111f; color: #f4f7fb; }
    main { width: min(760px, calc(100vw - 2rem)); padding: 2rem; border: 1px solid #20334f; border-radius: 1.25rem; background: #0d1c31; box-shadow: 0 24px 90px #0008; }
    .eyebrow { color: #9eb5d8; font-size: .8rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: .35rem 0 .6rem; font-size: clamp(2rem, 6vw, 3.8rem); }
    p { color: #b8c7dc; line-height: 1.55; }
    .status { display: flex; gap: 1rem; align-items: center; padding: 1.1rem 1.25rem; margin: 1.5rem 0; border: 1px solid #2a4264; border-radius: 1rem; background: #102540; }
    .dot { width: 1rem; height: 1rem; border-radius: 50%; background: #59d99b; box-shadow: 0 0 24px #59d99b; }
    .status[data-status="degraded"] .dot { background: #ff6b6b; box-shadow: 0 0 24px #ff6b6b; }
    .status strong { display: block; font-size: 1.2rem; }
    .status small { color: #a8b9d2; }
    .actions { display: flex; flex-wrap: wrap; gap: .75rem; }
    button { min-height: 3rem; padding: .7rem 1rem; border: 0; border-radius: .7rem; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
    button:focus-visible { outline: 3px solid #fff; outline-offset: 3px; }
    .degrade { background: #bd3843; } .recover { background: #167a57; }
    .note { margin-top: 1.25rem; font-size: .9rem; }
    .delivery { min-height: 1.55em; margin: -.6rem 0 1.3rem; color: #98b3dc; font-weight: 650; }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">Local-only synthetic monitor</div>
    <h1>Checkout status</h1>
    <p>This is an intentionally simulated checkout dependency. Toggle its health to trigger a local monitor incident; it makes no external network calls.</p>
    <section class="status" id="status" data-status="healthy" aria-live="polite">
      <span class="dot" aria-hidden="true"></span>
      <div><strong id="headline">Checking status…</strong><small id="detail"></small></div>
    </section>
    <p class="delivery" id="delivery" aria-live="polite">Monitor is establishing its local baseline.</p>
    <div class="actions">
      <button class="degrade" type="button" id="degrade">Simulate checkout failure</button>
      <button class="recover" type="button" id="recover">Restore checkout</button>
    </div>
    <p class="note">The polling monitor reports only state changes: one incident while degraded and one recovery after restoration.</p>
  </main>
  <script>
    const status = document.querySelector('#status');
    const headline = document.querySelector('#headline');
    const detail = document.querySelector('#detail');
    async function refresh() {
      const response = await fetch('/health', { cache: 'no-store' });
      const health = await response.json();
      status.dataset.status = health.status;
      headline.textContent = health.ok ? 'Checkout is healthy' : 'Checkout is degraded';
      detail.textContent = health.summary + ' HTTP ' + health.httpStatus + '.';
      document.querySelector('#delivery').textContent = health.monitor.message;
    }
    async function change(path) { await fetch(path, { method: 'POST' }); await refresh(); }
    document.querySelector('#degrade').addEventListener('click', () => change('/api/simulate/degrade'));
    document.querySelector('#recover').addEventListener('click', () => change('/api/simulate/recover'));
    refresh().catch(() => { headline.textContent = 'Status unavailable'; });
    setInterval(() => refresh().catch(() => {}), 500);
  </script>
</body>
</html>`;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

/**
 * Creates a loopback-only site and its monitor. Consumers can supply onEvent
 * to bridge normalized incident events into the phone workflow; this module
 * deliberately does not make that call on its own.
 */
export function createSyntheticSiteMonitorDemo({
  host = '127.0.0.1',
  port = 0,
  pollIntervalMs = 1_000,
  onEvent = async () => {},
  onError,
  now,
  autoStartMonitor = true,
} = {}) {
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('The synthetic site-monitor demo may bind only to a loopback address.');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('port must be an integer from 0 to 65535.');

  let state = HEALTHY;
  let changedAt = isoTimestamp(now ?? (() => new Date()));
  const clock = now ?? (() => new Date());
  let monitor;
  let lastEmittedEvent = null;
  const health = () => ({
    service: SYNTHETIC_SITE_MONITOR_SOURCE,
    status: state,
    ok: state === HEALTHY,
    httpStatus: state === HEALTHY ? 200 : 503,
    summary: state === HEALTHY ? 'Synthetic checkout is healthy.' : 'Synthetic checkout dependency is unavailable.',
    changedAt,
    // The monitor has no acknowledgement from Twilio. Its local dashboard must
    // therefore report only what it observed, never that a call was delivered.
    monitor: lastEmittedEvent
      ? { lastEvent: lastEmittedEvent.type, incidentId: lastEmittedEvent.incidentId,
        message: lastEmittedEvent.type === 'site_monitor.incident'
          ? 'Incident detected locally. Watch the configured phone for a notification.'
          : 'Recovery detected locally. The dashboard has returned to healthy.' }
      : monitor?.snapshot().pendingEvent
        ? { lastEvent: 'pending', incidentId: monitor.snapshot().pendingEvent,
          message: 'Incident is waiting for the daemon connection.' }
        : { lastEvent: 'baseline', incidentId: null, message: 'Monitor is establishing its local baseline.' },
  });
  monitor = createDeterministicSiteMonitor({
    check: health,
    onEvent: async (event) => {
      const delivered = await onEvent(event);
      if (delivered !== false) lastEmittedEvent = event;
      return delivered;
    },
    onError,
    now: clock,
    pollIntervalMs,
  });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(htmlPage());
      return;
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, health().httpStatus, health());
      return;
    }
    if (request.method === 'POST' && (url.pathname === '/api/simulate/degrade' || url.pathname === '/api/simulate/recover')) {
      const nextState = url.pathname.endsWith('/degrade') ? DEGRADED : HEALTHY;
      const changed = state !== nextState;
      state = nextState;
      if (changed) changedAt = isoTimestamp(clock);
      sendJson(response, 200, { changed, ...health() });
      return;
    }
    sendJson(response, 404, { error: 'not_found' });
  });

  async function listen() {
    if (!server.listening) {
      await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(port, host, () => {
          server.off('error', rejectListen);
          resolveListen();
        });
      });
    }
    if (autoStartMonitor) monitor.start();
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    return { url: `http://${host === '::1' ? '[::1]' : host}:${actualPort}`, port: actualPort };
  }

  async function close() {
    monitor.stop();
    if (server.listening) await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
  }

  return {
    server,
    monitor,
    listen,
    close,
    health,
    poll: monitor.poll,
    setState(nextState) {
      if (!VALID_STATUSES.has(nextState)) throw new Error('Synthetic site state must be healthy or degraded.');
      const changed = state !== nextState;
      state = nextState;
      if (changed) changedAt = isoTimestamp(clock);
      return { changed, ...health() };
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.SYNTHETIC_SITE_MONITOR_PORT ?? 4300);
  const demo = createSyntheticSiteMonitorDemo({ port, onEvent: event => console.log(`Monitor event: ${JSON.stringify(event)}`),
    onError: error => console.error(`Monitor error: ${error.message}`) });
  const { url } = await demo.listen();
  console.log(`Synthetic site monitor demo listening at ${url}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void demo.close().finally(() => process.exit(0)); });
}
