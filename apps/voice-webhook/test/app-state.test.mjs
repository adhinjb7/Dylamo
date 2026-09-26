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
const publicBaseUrl = 'https://example.ngrok.app';
const allowedCallerNumber = '+15065550123';
const pinHash = hashPin('1234', Buffer.alloc(16, 2));

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for persisted state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function withServer(store, run) {
  const server = createServer({ authToken, accountSid, publicBaseUrl, allowedCallerNumber, pinHash, stateStore: store });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, params) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': expectedTwilioSignature(authToken, `${publicBaseUrl}${path}`, params),
    },
    body: new URLSearchParams(params),
  });
  try { await run({ base, post }); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('signed call moves through persisted authentication, stream, and end states', async () => {
  const store = openStateStore(':memory:');
  const callSid = `CA${'1'.repeat(32)}`;
  const params = { AccountSid: accountSid, From: allowedCallerNumber, CallSid: callSid };
  try {
    await withServer(store, async ({ base, post }) => {
      assert.equal((await post('/voice', params)).status, 200);
      assert.equal(store.getCall(callSid).state, 'authenticating');
      const pin = await post('/voice/pin', { ...params, Digits: '1234' });
      const token = (await pin.text()).match(/name="token" value="([0-9a-f]+)"/)?.[1];
      assert.ok(token);
      const websocket = new WebSocket(base.replace('http:', 'ws:') + '/media', {
        headers: { 'x-twilio-signature': expectedTwilioSignature(authToken, 'wss://example.ngrok.app/media', {}) },
      });
      await new Promise((resolve, reject) => { websocket.once('open', resolve); websocket.once('error', reject); });
      const started = new Promise((resolve, reject) => {
        websocket.once('message', resolve);
        websocket.once('error', reject);
      });
      const streamSid = `MZ${'2'.repeat(32)}`;
      websocket.send(JSON.stringify({
        event: 'start', streamSid,
        start: { streamSid, accountSid, callSid, customParameters: { token } },
      }));
      await started;
      assert.equal(store.getCall(callSid).state, 'streaming');
      websocket.close();
      await new Promise((resolve) => websocket.once('close', resolve));
      await waitFor(() => store.getCall(callSid).state === 'ended');
      assert.equal(store.getCall(callSid).state, 'ended');
      assert.equal(store.listAudit(store.getCall(callSid).session_id)[0].type, 'call.authenticated');
    });
  } finally { store.close(); }
});

test('PIN lockout survives a server restart', async () => {
  const store = openStateStore(':memory:');
  const first = { AccountSid: accountSid, From: allowedCallerNumber, CallSid: `CA${'3'.repeat(32)}` };
  try {
    await withServer(store, async ({ post }) => {
      await post('/voice', first);
      for (let index = 0; index < 3; index += 1) await post('/voice/pin', { ...first, Digits: '9999' });
    });
    await withServer(store, async ({ post }) => {
      const second = { ...first, CallSid: `CA${'4'.repeat(32)}` };
      assert.match(await (await post('/voice', second)).text(), /<Reject\/>/);
      assert.equal(store.getCall(second.CallSid).ended_reason, 'auth_locked');
    });
  } finally { store.close(); }
});

test('duplicate call SID after recovery cannot re-enter a terminal call', async () => {
  const store = openStateStore(':memory:');
  const params = { AccountSid: accountSid, From: allowedCallerNumber, CallSid: `CA${'5'.repeat(32)}` };
  try {
    await withServer(store, async ({ post }) => { await post('/voice', params); });
    store.recoverAfterRestart();
    await withServer(store, async ({ post }) => {
      assert.match(await (await post('/voice', params)).text(), /<Hangup\/>/);
      assert.equal(store.getCall(params.CallSid).state, 'ended');
    });
  } finally { store.close(); }
});

test('machine registration and disconnect update durable status', async () => {
  const store = openStateStore(':memory:');
  const machineId = '00000000-0000-4000-8000-000000000001';
  const token = 'test-only-token-with-at-least-forty-characters';
  const hash = createHash('sha256').update(token).digest('hex');
  try {
    const server = createServer({
      authToken, accountSid, publicBaseUrl, allowedCallerNumber, pinHash,
      stateStore: store, daemonCredentials: new Map([[machineId, hash]]),
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const websocket = new WebSocket(`ws://127.0.0.1:${server.address().port}/daemon`, {
        headers: { 'x-machine-id': machineId, Authorization: `Bearer ${token}` },
      });
      await new Promise((resolve, reject) => { websocket.once('open', resolve); websocket.once('error', reject); });
      const registered = new Promise((resolve) => websocket.once('message', resolve));
      websocket.send(JSON.stringify({ v: 1, eventId: randomUUID(), machineId, type: 'machine.register', name: 'Demo machine', agents: [] }));
      await registered;
      assert.equal(store.getMachine(machineId).status, 'online');
      websocket.close();
      await new Promise((resolve) => websocket.once('close', resolve));
      await waitFor(() => store.getMachine(machineId).status === 'offline');
    } finally { await new Promise((resolve) => server.close(resolve)); }
  } finally { store.close(); }
});
