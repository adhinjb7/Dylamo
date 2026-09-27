// Optional live status from the local daemon's management endpoint. This is
// reported separately from the persisted machine state in SQLite.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:3210/health';

export function parseDaemonUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid daemon URL: ${value}`);
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password) {
    throw new Error('The daemon URL must be a plain http:// address on 127.0.0.1, localhost or [::1].');
  }
  return url;
}

export async function readDaemonHealth(url, { timeoutMs = 1000 } = {}) {
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { reachable: false, error: `HTTP ${response.status}` };
    const body = await response.json();
    return {
      reachable: true,
      name: text(body?.name, 100),
      state: text(body?.state, 32),
      lastConnectedAt: text(body?.lastConnectedAt, 40),
      agents: (Array.isArray(body?.agents) ? body.agents : []).slice(0, 32).map((agent) => ({
        name: text(agent?.name, 100),
        adapterType: text(agent?.adapterType, 64),
        status: text(agent?.status, 32),
      })),
    };
  } catch {
    return { reachable: false, error: 'Daemon not reachable' };
  }
}

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : null;
}
