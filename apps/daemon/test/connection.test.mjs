import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import WebSocket from 'ws';
import { createDaemonGateway, parseDaemonCredentials } from '../../voice-webhook/src/daemon-gateway.mjs';
import { createDaemonClient } from '../src/client.mjs';
import { createManagementServer } from '../src/management.mjs';

const machineId = '00000000-0000-4000-8000-000000000001';
const sessionId = '00000000-0000-4000-8000-000000000002';
const taskId = '00000000-0000-4000-8000-000000000003';
const runId = '00000000-0000-4000-8000-000000000004';
const token = 'this-is-a-test-only-machine-token-with-enough-length';
const tokenHash = createHash('sha256').update(token).digest('hex');

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for connection state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function withGateway(run) {
  const received = [];
  const statuses = [];
  const gateway = createDaemonGateway({
    credentials: new Map([[machineId, tokenHash]]),
    onEvent: (event) => received.push(event),
    onStatus: (id, state) => statuses.push({ id, state }),
  });
  const server = http.createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  server.on('upgrade', gateway.upgrade);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const serverUrl = `ws://127.0.0.1:${server.address().port}/daemon`;
  try {
    await run({ gateway, serverUrl, received, statuses });
  } finally {
    gateway.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

function newClient(serverUrl, extra = {}) {
  return createDaemonClient({
    serverUrl, machineId, token, name: 'Test laptop', allowInsecureLoopback: true,
    reconnectMinMs: 20, reconnectMaxMs: 100, ...extra,
  });
}

test('unauthorized daemon handshake is rejected', async () => {
  await withGateway(async ({ serverUrl }) => {
    const socket = new WebSocket(serverUrl, { headers: { 'x-machine-id': machineId } });
    const status = await new Promise((resolve, reject) => {
      socket.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); });
      socket.on('open', () => reject(new Error('unauthorized socket opened')));
      socket.on('error', reject);
    });
    assert.equal(status, 403);
  });
});

test('pairing configuration rejects malformed or duplicate credentials', () => {
  assert.equal(parseDaemonCredentials(`${machineId}:${tokenHash}`).get(machineId), tokenHash);
  assert.throws(() => parseDaemonCredentials(`${machineId}:${tokenHash},${machineId}:${tokenHash}`), /duplicate/);
  assert.throws(() => parseDaemonCredentials(`${machineId}:not-a-hash`), /DAEMON_CREDENTIALS/);
});

test('daemon reports rejected credentials without exposing the token', async () => {
  await withGateway(async ({ serverUrl }) => {
    const errors = [];
    const client = newClient(serverUrl, { token: 'wrong-token-that-is-still-long-enough-to-validate', onError: (message) => errors.push(message) });
    try {
      client.start();
      await waitFor(() => errors.length > 0);
      assert.match(errors[0], /HTTP 403/);
      assert.doesNotMatch(errors[0], /wrong-token/);
    } finally {
      client.stop();
    }
  });
});

test('daemon registers, routes messages, deduplicates events, and reconnects', async () => {
  await withGateway(async ({ gateway, serverUrl, received, statuses }) => {
    const routed = [];
    const client = newClient(serverUrl, { onEvent: (event) => routed.push(event) });
    try {
      client.start();
      await waitFor(() => client.status().state === 'online');
      assert.equal(gateway.status(machineId).online, true);
      assert.deepEqual(statuses.at(-1), { id: machineId, state: 'online' });

      const event = { v: 1, eventId: randomUUID(), machineId, sessionId, taskId, runId, type: 'agent.progress', text: 'Tests running' };
      assert.equal(client.send(event), true);
      assert.equal(client.send(event), true);
      await waitFor(() => received.length === 1);
      assert.equal(received[0].text, 'Tests running');

      assert.equal(gateway.sendToMachine(machineId, {
        v: 1, eventId: randomUUID(), machineId, sessionId, taskId, runId,
        type: 'agent.message', text: 'Continue',
      }), true);
      await waitFor(() => routed.length === 1);
      assert.equal(routed[0].text, 'Continue');

      assert.equal(gateway.disconnectMachine(machineId), true);
      await waitFor(() => statuses.some((item) => item.state === 'offline'));
      await waitFor(() => client.status().state === 'online');
      assert.equal(gateway.status(machineId).online, true);
      assert.equal(statuses.filter((item) => item.state === 'online').length, 2);
    } finally {
      client.stop();
      await waitFor(() => !gateway.status(machineId).online);
    }
  });
});

test('registration must match authenticated machine and WSS is required outside tests', async () => {
  await withGateway(async ({ serverUrl }) => {
    assert.throws(() => newClient(serverUrl, { allowInsecureLoopback: false }), /WSS/);
    const socket = new WebSocket(serverUrl, {
      headers: { 'x-machine-id': machineId, Authorization: `Bearer ${token}` },
    });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.send(JSON.stringify({ v: 1, eventId: randomUUID(), machineId: randomUUID(), type: 'machine.register', name: 'Wrong', agents: [] }));
    assert.equal(await closed, 1008);
  });
});

test('management endpoint exposes status on loopback without credentials', async () => {
  const client = { status: () => ({ machineId, state: 'offline', agents: [] }) };
  const server = createManagementServer(client);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { machineId, state: 'offline', agents: [] });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('unacknowledged run events replay before a fresh snapshot, but stale snapshots never replay', async () => {
  const sockets = [];
  class Socket extends EventEmitter {
    readyState = WebSocket.OPEN;
    sent = [];
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = WebSocket.CLOSED; this.emit('close'); }
    receive(event) { this.emit('message', Buffer.from(JSON.stringify({ v: 1, eventId: randomUUID(), machineId, ...event })), false); }
  }
  const client = newClient('ws://127.0.0.1:1/daemon', {
    createSocket() { const socket = new Socket(); sockets.push(socket); return socket; },
    onStatus(status) { if (status === 'online') client.send({ v: 1, eventId: randomUUID(), machineId,
      type: 'machine.reconcile', activeRunIds: [] }); },
  });
  const register = socket => {
    socket.emit('open');
    socket.receive({ type: 'machine.registered', heartbeatIntervalMs: 15000 });
  };
  try {
    client.start();
    register(sockets[0]);
    const terminal = { v: 1, eventId: randomUUID(), machineId, sessionId, taskId, runId,
      type: 'task.completed', summary: 'Done.' };
    client.send(terminal);
    sockets[0].close(); // The completion or its ACK was lost.
    await waitFor(() => sockets.length === 2);
    register(sockets[1]);
    assert.deepEqual(sockets[1].sent.map(event => event.type), ['machine.register', 'task.completed', 'machine.reconcile']);
    assert.equal(sockets[1].sent[1].eventId, terminal.eventId);
    assert.notEqual(sockets[1].sent[2].eventId, sockets[0].sent[1].eventId);
    sockets[1].receive({ type: 'event.ack', ackEventId: terminal.eventId });
    sockets[1].close();
    await waitFor(() => sockets.length === 3);
    register(sockets[2]);
    assert.deepEqual(sockets[2].sent.map(event => event.type), ['machine.register', 'machine.reconcile']);
  } finally { client.stop(); }
});
