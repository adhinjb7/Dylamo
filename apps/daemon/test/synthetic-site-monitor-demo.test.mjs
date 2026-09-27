import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeterministicSiteMonitor, createSyntheticSiteMonitorDemo } from '../src/synthetic-site-monitor-demo.mjs';

test('deterministic monitor emits one incident and one recovery for a state transition', async () => {
  let health = { status: 'healthy', httpStatus: 200, summary: 'Checkout is healthy.' };
  const events = [];
  const monitor = createDeterministicSiteMonitor({
    check: async () => health,
    onEvent: async event => events.push(event),
    now: () => new Date('2026-09-27T12:00:00.000Z'),
    pollIntervalMs: 10,
  });

  assert.equal(await monitor.poll(), null, 'the initial healthy observation is only a baseline');
  health = { status: 'degraded', httpStatus: 503, summary: 'Synthetic dependency is unavailable.' };
  const incident = await monitor.poll();
  assert.equal(incident.type, 'site_monitor.incident');
  assert.equal(incident.monitorId, 'local-checkout');
  assert.equal(incident.condition, 'http_errors');
  assert.equal(incident.incidentId, 'synthetic-checkout-1');
  assert.equal(await monitor.poll(), null, 'a persistent outage must not create callback spam');

  health = { status: 'healthy', httpStatus: 200, summary: 'Checkout is healthy.' };
  const recovery = await monitor.poll();
  assert.equal(recovery.type, 'site_monitor.recovered');
  assert.equal(recovery.incidentId, incident.incidentId);
  assert.equal(recovery.monitorId, 'local-checkout');
  assert.equal(await monitor.poll(), null, 'a stable recovery must not create callback spam');
  assert.deepEqual(events.map(event => event.type), ['site_monitor.incident', 'site_monitor.recovered']);
});

test('synthetic monitor site exposes a local health endpoint and degradation controls', async () => {
  const events = [];
  const demo = createSyntheticSiteMonitorDemo({ autoStartMonitor: false, onEvent: async event => events.push(event), pollIntervalMs: 10 });
  try {
    const { url } = await demo.listen();
    const page = await fetch(`${url}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Simulate checkout failure/);
    assert.match(await (await fetch(`${url}/health`)).json().then(JSON.stringify), /"status":"healthy"/);

    const degraded = await fetch(`${url}/api/simulate/degrade`, { method: 'POST' });
    assert.equal(degraded.status, 200);
    assert.deepEqual(await degraded.json(), {
      changed: true,
      service: 'synthetic-checkout',
      status: 'degraded',
      ok: false,
      httpStatus: 503,
      summary: 'Synthetic checkout dependency is unavailable.',
      changedAt: demo.health().changedAt,
      monitor: { lastEvent: 'baseline', incidentId: null, message: 'Monitor is establishing its local baseline.' },
    });
    assert.equal((await fetch(`${url}/health`)).status, 503);
    const incident = await demo.poll();
    assert.equal(incident.type, 'site_monitor.incident');
    assert.equal(demo.health().monitor.lastEvent, 'site_monitor.incident');
    assert.equal(demo.health().monitor.message,
      'Incident detected locally. Watch the configured phone for a notification.');
    assert.doesNotMatch(demo.health().monitor.message, /sent|forwarded|delivery/i);

    const restored = await fetch(`${url}/api/simulate/recover`, { method: 'POST' });
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).status, 'healthy');
    const recovery = await demo.poll();
    assert.equal(recovery.type, 'site_monitor.recovered');
    assert.equal(demo.health().monitor.message,
      'Recovery detected locally. The dashboard has returned to healthy.');
    assert.deepEqual(events.map(event => event.type), ['site_monitor.incident', 'site_monitor.recovered']);
    assert.equal((await fetch(`${url}/not-a-route`)).status, 404);
  } finally {
    await demo.close();
  }
});

test('synthetic monitor binds only to loopback and rejects invalid synthetic states', () => {
  assert.throws(() => createSyntheticSiteMonitorDemo({ host: '0.0.0.0' }), /loopback/);
  const demo = createSyntheticSiteMonitorDemo({ autoStartMonitor: false });
  assert.throws(() => demo.setState('offline'), /healthy or degraded/);
});

test('a temporarily unavailable bridge retries one stable incident instead of losing or duplicating it', async () => {
  let health = { status: 'healthy', httpStatus: 200 };
  let attempts = 0;
  const delivered = [];
  const monitor = createDeterministicSiteMonitor({
    check: async () => health,
    onEvent: async (event) => {
      attempts += 1;
      if (attempts === 1) return false;
      delivered.push(event);
      return true;
    },
    now: () => new Date('2026-09-27T12:00:00.000Z'),
    pollIntervalMs: 10,
  });

  await monitor.poll();
  health = { status: 'degraded', httpStatus: 503 };
  await assert.rejects(monitor.poll(), /not delivered/);
  assert.equal(monitor.snapshot().pendingEvent, 'synthetic-checkout-1');
  const incident = await monitor.poll();
  assert.equal(incident.incidentId, 'synthetic-checkout-1');
  assert.equal(attempts, 2);
  assert.deepEqual(delivered.map(event => event.incidentId), ['synthetic-checkout-1']);
});
