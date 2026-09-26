import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { DaemonEvent, InternalId, PROTOCOL_VERSION, ServerEvent } from '@hack-atlantic/protocol';

const REGISTER_TIMEOUT_MS = 5_000;

export function createDaemonClient({
  serverUrl,
  machineId,
  token,
  name,
  agents = [],
  onEvent = () => {},
  onStatus = () => {},
  onError = () => {},
  createSocket = (url, options) => new WebSocket(url, options),
  reconnectMinMs = 500,
  reconnectMaxMs = 15_000,
  allowInsecureLoopback = false,
}) {
  const url = new URL(serverUrl);
  if (url.protocol !== 'wss:' && !(allowInsecureLoopback && url.protocol === 'ws:' && url.hostname === '127.0.0.1')) {
    throw new Error('DAEMON_SERVER_URL must use WSS');
  }
  if (url.pathname !== '/daemon' || url.search || url.hash) throw new Error('DAEMON_SERVER_URL must end in /daemon');
  if (!InternalId.safeParse(machineId).success) throw new Error('DAEMON_MACHINE_ID must be a UUID');
  if (typeof token !== 'string' || token.length < 40 || token.length > 256) throw new Error('DAEMON_TOKEN is missing or invalid');
  const registration = DaemonEvent.safeParse({
    v: PROTOCOL_VERSION, eventId: randomUUID(), machineId,
    type: 'machine.register', name, agents,
  });
  if (!registration.success) throw new Error('daemon name or agents are invalid');
  if (!Number.isInteger(reconnectMinMs) || !Number.isInteger(reconnectMaxMs) || reconnectMinMs < 1 || reconnectMaxMs < reconnectMinMs) {
    throw new Error('invalid reconnect delay');
  }

  let socket;
  let state = 'stopped';
  let started = false;
  let attempt = 0;
  let reconnectTimer;
  let heartbeatTimer;
  let registerTimer;
  let lastConnectedAt = null;

  function setState(next) {
    if (state === next) return;
    state = next;
    onStatus(next);
  }

  function clearTimers() {
    clearTimeout(reconnectTimer);
    clearInterval(heartbeatTimer);
    clearTimeout(registerTimer);
    reconnectTimer = undefined;
    heartbeatTimer = undefined;
    registerTimer = undefined;
  }

  function send(event) {
    const parsed = DaemonEvent.safeParse(event);
    if (!parsed.success || parsed.data.machineId !== machineId) throw new Error('invalid or mismatched daemon event');
    if (state !== 'online' || socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(parsed.data));
    return true;
  }

  function connect() {
    if (!started) return;
    setState('connecting');
    let current;
    try {
      current = createSocket(url.toString(), {
        headers: { Authorization: `Bearer ${token}`, 'x-machine-id': machineId },
        maxPayload: 64 * 1024,
      });
    } catch {
      scheduleReconnect();
      return;
    }
    socket = current;
    current.on('open', () => {
      if (!started || socket !== current) return current.close();
      current.send(JSON.stringify({ ...registration.data, eventId: randomUUID() }));
      registerTimer = setTimeout(() => current.terminate(), REGISTER_TIMEOUT_MS);
      registerTimer.unref?.();
    });
    current.on('message', (raw, isBinary) => {
      if (isBinary) return current.close(1003, 'JSON required');
      let parsed;
      try {
        parsed = ServerEvent.safeParse(JSON.parse(raw.toString()));
      } catch {
        return current.close(1003, 'invalid JSON');
      }
      if (!parsed.success || parsed.data.machineId !== machineId) return current.close(1008, 'invalid event');
      const event = parsed.data;
      if (state !== 'online') {
        if (event.type !== 'machine.registered') return current.close(1008, 'registration required');
        clearTimeout(registerTimer);
        registerTimer = undefined;
        attempt = 0;
        lastConnectedAt = new Date().toISOString();
        setState('online');
        heartbeatTimer = setInterval(() => {
          send({ v: PROTOCOL_VERSION, eventId: randomUUID(), machineId, type: 'machine.heartbeat', sentAt: new Date().toISOString() });
        }, event.heartbeatIntervalMs);
        heartbeatTimer.unref?.();
        return;
      }
      if (event.type === 'machine.registered') return current.close(1008, 'duplicate registration');
      onEvent(event);
    });
    current.on('unexpected-response', (_request, response) => {
      onError(`Daemon connection rejected (HTTP ${response.statusCode})`);
      response.resume();
      current.terminate();
    });
    current.on('error', (error) => {
      onError(`Daemon connection failed: ${error.code ?? error.message ?? 'unknown error'}`);
    });
    current.on('close', () => {
      if (socket !== current) return;
      socket = undefined;
      clearTimeout(registerTimer);
      clearInterval(heartbeatTimer);
      registerTimer = undefined;
      heartbeatTimer = undefined;
      if (started) scheduleReconnect();
      else setState('stopped');
    });
  }

  function scheduleReconnect() {
    if (!started) return;
    setState('reconnecting');
    const delay = Math.min(reconnectMaxMs, reconnectMinMs * (2 ** Math.min(attempt++, 20)));
    reconnectTimer = setTimeout(connect, delay);
    reconnectTimer.unref?.();
  }

  function start() {
    if (started) return;
    started = true;
    connect();
  }

  function stop() {
    started = false;
    clearTimers();
    socket?.close(1000, 'daemon stopped');
    socket = undefined;
    setState('stopped');
  }

  function status() {
    return { machineId, name, state, lastConnectedAt, agents: registration.data.agents };
  }

  return { start, stop, send, status };
}
