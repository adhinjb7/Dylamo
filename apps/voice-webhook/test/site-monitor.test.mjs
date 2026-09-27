import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import WebSocket from 'ws';
import { createServer } from '../src/app.mjs';
import { hashPin } from '../src/pin.mjs';
import { expectedTwilioSignature } from '../src/signature.mjs';
import { openStateStore } from '../src/state.mjs';

const authToken = 'test-auth-token';
const accountSid = `AC${'0'.repeat(32)}`;
const caller = '+15065550123';
const twilioNumber = '+15067045673';
const publicBaseUrl = 'https://example.ngrok.app';

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for site monitor callback');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function withMonitorServer(run) {
  const store = openStateStore(':memory:');
  const machineId = randomUUID();
  const machineToken = 'test-only-monitor-machine-token-with-enough-length';
  const callbacks = [];
  const server = createServer({
    authToken, accountSid, publicBaseUrl, allowedCallerNumber: caller,
    callbackCallerNumber: twilioNumber, pinHash: hashPin('1234', Buffer.alloc(16, 9)),
    stateStore: store, siteMonitorDemoEnabled: true, siteMonitorMachineId: machineId,
    daemonCredentials: new Map([[machineId, createHash('sha256').update(machineToken).digest('hex')]]),
    callbackCreator: async request => {
      callbacks.push(request);
      return `CA${callbacks.length === 1 ? 'c'.repeat(32) : 'd'.repeat(32)}`;
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, params) => fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': expectedTwilioSignature(authToken, `${publicBaseUrl}${path}`, params),
    },
    body: new URLSearchParams(params),
  });
  try { await run({ store, machineId, machineToken, callbacks, server, post, origin }); }
  finally {
    await new Promise(resolve => server.close(resolve));
    store.close();
  }
}

function incident(machineId, overrides = {}) {
  return { v: 1, eventId: randomUUID(), machineId, type: 'site_monitor.incident',
    monitorId: 'local-checkout', incidentId: 'synthetic-checkout-1', condition: 'slow_response',
    observedAt: new Date().toISOString(), ...overrides };
}

test('a configured site-monitor incident sends one bounded callback and records no-SMS response', async () => {
  await withMonitorServer(async ({ store, machineId, callbacks, server, post }) => {
    const event = incident(machineId);
    assert.equal(server.routeSiteMonitorEvent(event), true);
    assert.equal(server.routeSiteMonitorEvent(event), true, 'a replay is accepted but cannot redial');
    assert.equal(server.routeSiteMonitorEvent(incident(randomUUID())), false, 'another paired machine cannot trigger this caller');
    await waitFor(() => callbacks.length === 1);
    const callback = new URL(callbacks[0].url);
    const path = callback.pathname + callback.search;
    const incidentId = callback.searchParams.get('incidentId');
    const nonce = callback.searchParams.get('nonce');
    assert.ok(incidentId && nonce);
    assert.equal(callbacks[0].to, caller);
    assert.equal(callbacks[0].from, twilioNumber);
    assert.equal(store.getSiteMonitorIncident(incidentId).condition, 'slow_response');

    const outbound = { AccountSid: accountSid, From: twilioNumber, To: caller,
      CallSid: `CA${'c'.repeat(32)}`, Direction: 'outbound-api' };
    const voice = await post(path, outbound);
    const body = await voice.text();
    assert.match(body, /local demo checkout is responding too slowly/i);
    assert.match(body, /Want a text report/i);
    assert.doesNotMatch(body, /PIN|Codex|git push/i);

    const decisionPath = `/site-monitor/decision?incidentId=${incidentId}&nonce=${nonce}`;
    const decision = await post(decisionPath, { ...outbound, SpeechResult: 'No.' });
    assert.match(await decision.text(), /<Say>Okay\. No text will be sent\.<\/Say><Hangup\/>/);
    assert.equal(store.getSiteMonitorIncident(incidentId).report_decision, 'declined');
    assert.equal(store.getSiteMonitorIncident(incidentId).callback_state, 'finished');
    assert.equal(callbacks.length, 1, 'the report decision never creates an SMS or second call');

    const statusPath = `/site-monitor/status?incidentId=${incidentId}&nonce=${nonce}`;
    assert.equal((await post(statusPath, { ...outbound, CallStatus: 'completed' })).status, 204);
    assert.equal(store.getSiteMonitorIncident(incidentId).callback_state, 'finished');
  });
});

test('a requested report truthfully sends no SMS and recovery re-arms a later incident', async () => {
  await withMonitorServer(async ({ store, machineId, callbacks, server, post }) => {
    const first = incident(machineId, { condition: 'http_errors', observedAt: '2026-09-27T12:00:00.000Z' });
    assert.equal(server.routeSiteMonitorEvent(first), true);
    await waitFor(() => callbacks.length === 1);
    const callback = new URL(callbacks[0].url);
    const incidentId = callback.searchParams.get('incidentId');
    const nonce = callback.searchParams.get('nonce');
    const outbound = { AccountSid: accountSid, From: twilioNumber, To: caller,
      CallSid: `CA${'c'.repeat(32)}`, Direction: 'outbound-api' };
    await post(callback.pathname + callback.search, outbound);
    const response = await post(`/site-monitor/decision?incidentId=${incidentId}&nonce=${nonce}`, { ...outbound, Digits: '1' });
    assert.match(await response.text(), /not enabled in this demo. No text was sent/i);
    assert.equal(store.getSiteMonitorIncident(incidentId).report_decision, 'requested');
    assert.equal(callbacks.length, 1);

    assert.equal(server.routeSiteMonitorEvent({ v: 1, eventId: randomUUID(), machineId,
      type: 'site_monitor.recovered', monitorId: 'local-checkout', incidentId: 'synthetic-checkout-1',
      observedAt: '2026-09-27T12:00:01.000Z' }), true);
    assert.equal(store.getSiteMonitorIncident(incidentId).state, 'resolved');
    assert.equal(server.routeSiteMonitorEvent(incident(machineId, {
      incidentId: 'synthetic-checkout-2', condition: 'slow_response', observedAt: '2026-09-27T12:00:02.000Z' })), true);
    await waitFor(() => callbacks.length === 2);
  });
});

test('an authenticated daemon event crosses the gateway before it can place a monitor callback', async () => {
  await withMonitorServer(async ({ machineId, machineToken, callbacks, origin }) => {
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/daemon`, {
      headers: { 'x-machine-id': machineId, Authorization: `Bearer ${machineToken}` },
    });
    try {
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      const registered = new Promise((resolve, reject) => {
        socket.once('message', raw => resolve(JSON.parse(raw.toString())));
        socket.once('error', reject);
      });
      socket.send(JSON.stringify({ v: 1, eventId: randomUUID(), machineId,
        type: 'machine.register', name: 'Synthetic monitor', agents: [] }));
      assert.equal((await registered).type, 'machine.registered');

      socket.send(JSON.stringify(incident(machineId, { condition: 'http_errors' })));
      await waitFor(() => callbacks.length === 1);
      assert.equal(callbacks[0].to, caller);
      assert.equal(callbacks[0].from, twilioNumber);
    } finally {
      socket.close();
      await new Promise(resolve => socket.once('close', resolve));
    }
  });
});

test('site monitor feature refuses an unpaired machine or a missing outbound caller number', () => {
  const store = openStateStore(':memory:');
  try {
    assert.throws(() => createServer({ authToken, accountSid, publicBaseUrl, allowedCallerNumber: caller,
      pinHash: hashPin('1234', Buffer.alloc(16, 1)), stateStore: store, siteMonitorDemoEnabled: true,
      siteMonitorMachineId: randomUUID(), daemonCredentials: new Map(),
    }), /TWILIO_PHONE_NUMBER.*SITE_MONITOR_MACHINE_ID/);
  } finally { store.close(); }
});
