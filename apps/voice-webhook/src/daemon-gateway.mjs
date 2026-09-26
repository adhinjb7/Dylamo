import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { DaemonEvent, InternalId, ServerEvent, PROTOCOL_VERSION } from '@hack-atlantic/protocol';

const REGISTER_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 30_000;
const MAX_SEEN_EVENTS = 10_000;

function reject(socket, status = 403) {
  socket.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Bad Request'}\r\nConnection: close\r\n\r\n`);
}

export function parseDaemonCredentials(value) {
  if (!value) return new Map();
  const credentials = new Map();
  for (const item of value.split(',')) {
    const [machineId, hash, extra] = item.trim().split(':');
    if (extra !== undefined || !InternalId.safeParse(machineId).success || !/^[a-f0-9]{64}$/.test(hash ?? '')) {
      throw new Error('DAEMON_CREDENTIALS must contain comma-separated machineId:sha256hash entries');
    }
    if (credentials.has(machineId)) throw new Error('DAEMON_CREDENTIALS contains a duplicate machine ID');
    credentials.set(machineId, hash);
  }
  return credentials;
}

export function createDaemonGateway({ credentials = new Map(), onEvent = () => {}, onStatus = () => {}, onHeartbeat = () => {}, now = Date.now } = {}) {
  const sockets = new Map();
  const lastSeen = new Map();
  const seenEvents = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  function upgrade(request, socket, head) {
    if (request.url !== '/daemon') return reject(socket, 400);
    const machineId = request.headers['x-machine-id'];
    const authorization = request.headers.authorization;
    const hash = typeof machineId === 'string' ? credentials.get(machineId) : undefined;
    const token = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice(7) : '';
    if (!hash || !token || token.length > 256) return reject(socket);
    const suppliedHash = createHash('sha256').update(token).digest();
    if (!timingSafeEqual(Buffer.from(hash, 'hex'), suppliedHash)) return reject(socket);
    wss.handleUpgrade(request, socket, head, (websocket) => {
      wss.emit('connection', websocket, machineId);
    });
  }

  wss.on('connection', (websocket, authenticatedMachineId) => {
    let registered = false;
    const registerTimer = setTimeout(() => websocket.close(1008, 'registration timeout'), REGISTER_TIMEOUT_MS);
    registerTimer.unref?.();

    websocket.on('message', (data, isBinary) => {
      if (isBinary) return websocket.close(1003, 'JSON required');
      let parsed;
      try {
        parsed = DaemonEvent.safeParse(JSON.parse(data.toString()));
      } catch {
        return websocket.close(1003, 'invalid JSON');
      }
      if (!parsed.success) return websocket.close(1008, 'invalid event');
      const event = parsed.data;
      if (event.machineId !== authenticatedMachineId) return websocket.close(1008, 'machine mismatch');

      if (!registered) {
        if (event.type !== 'machine.register') return websocket.close(1008, 'registration required');
        registered = true;
        clearTimeout(registerTimer);
        const previous = sockets.get(authenticatedMachineId);
        sockets.set(authenticatedMachineId, websocket);
        lastSeen.set(authenticatedMachineId, now());
        if (previous && previous !== websocket) previous.close(1000, 'replaced by reconnect');
        websocket.send(JSON.stringify({
          v: PROTOCOL_VERSION, eventId: randomUUID(), machineId: authenticatedMachineId,
          type: 'machine.registered', heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        }));
        onStatus(authenticatedMachineId, 'online', event.agents);
        return;
      }
      if (event.type === 'machine.register') return websocket.close(1008, 'already registered');
      if (sockets.get(authenticatedMachineId) !== websocket) return websocket.close(1008, 'stale connection');
      lastSeen.set(authenticatedMachineId, now());
      if (event.type === 'machine.heartbeat') {
        onHeartbeat(authenticatedMachineId);
        return;
      }

      let seen = seenEvents.get(authenticatedMachineId);
      if (!seen) {
        seen = new Set();
        seenEvents.set(authenticatedMachineId, seen);
      }
      if (seen.has(event.eventId)) return;
      seen.add(event.eventId);
      if (seen.size > MAX_SEEN_EVENTS) seen.delete(seen.values().next().value);
      try { onEvent(event); }
      catch (error) {
        console.error(`Daemon event could not be applied: ${error.message}`);
        websocket.close(1011, 'event processing failed');
      }
    });

    websocket.on('close', () => {
      clearTimeout(registerTimer);
      if (sockets.get(authenticatedMachineId) === websocket) {
        sockets.delete(authenticatedMachineId);
        lastSeen.delete(authenticatedMachineId);
        onStatus(authenticatedMachineId, 'offline');
      }
    });
    websocket.on('error', () => {});
  });

  const watchdog = setInterval(() => {
    for (const [machineId, websocket] of sockets) {
      if (now() - (lastSeen.get(machineId) ?? 0) > HEARTBEAT_TIMEOUT_MS) {
        websocket.terminate();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  watchdog.unref?.();

  function sendToMachine(machineId, event) {
    const parsed = ServerEvent.safeParse(event);
    if (!parsed.success || parsed.data.machineId !== machineId) throw new Error('invalid or mismatched server event');
    const websocket = sockets.get(machineId);
    if (!websocket || websocket.readyState !== WebSocket.OPEN) return false;
    websocket.send(JSON.stringify(parsed.data));
    return true;
  }

  function status(machineId) {
    return { machineId, online: sockets.get(machineId)?.readyState === WebSocket.OPEN, lastSeenAt: lastSeen.get(machineId) ?? null };
  }

  function disconnectMachine(machineId) {
    const websocket = sockets.get(machineId);
    if (!websocket) return false;
    websocket.close(1012, 'connection reset');
    return true;
  }

  function close() {
    clearInterval(watchdog);
    for (const websocket of sockets.values()) websocket.close(1001, 'server shutdown');
    sockets.clear();
    lastSeen.clear();
    wss.close();
  }

  return { upgrade, sendToMachine, status, disconnectMachine, close };
}
