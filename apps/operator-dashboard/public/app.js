// Polls /api/snapshot and renders it. Every value is inserted with textContent,
// never innerHTML, so data from the database cannot inject markup.
const REFRESH_MS = 3000;

const TONE = {
  online: 'good', streaming: 'good', running: 'good', completed: 'good', ended: 'neutral', connected: 'good',
  waiting_human: 'warn', queued: 'neutral', authenticating: 'warn', received: 'neutral',
  offline: 'bad', failed: 'bad', rejected: 'bad', cancelled: 'neutral',
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) node.append(child ?? '');
  return node;
}

function badge(state) {
  const label = String(state ?? 'unknown');
  const tone = Object.hasOwn(TONE, label) ? TONE[label] : 'neutral';
  return el('span', { class: `badge ${tone}` }, label.replaceAll('_', ' ').toUpperCase());
}

function time(ms) {
  return ms == null ? '—' : new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function duration(ms) {
  if (ms == null || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function empty() {
  return el('p', { class: 'empty' }, 'No data yet');
}

// Wide tables scroll inside their own box so the card heading never scrolls away.
function table(headers, rows) {
  return el('div', { class: 'table-scroll' }, el('table', {},
    el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', { scope: 'col' }, h)))),
    el('tbody', {}, ...rows.map((cells) => el('tr', {}, ...cells.map((c) => el('td', {}, c)))))));
}

function counts(byState) {
  return el('ul', { class: 'counts' }, ...Object.entries(byState).map(([state, n]) =>
    el('li', {}, badge(state), el('strong', {}, String(n)))));
}

function render(data) {
  const machines = document.getElementById('machines');
  machines.replaceChildren(data.machines.length
    ? table(['Machine', 'State', 'Last seen'], data.machines.map((m) => [m.name, badge(m.status), time(m.lastSeenAt)]))
    : empty());

  const daemon = document.getElementById('daemon');
  if (!data.daemon) daemon.replaceChildren(el('p', { class: 'empty' }, 'Disabled'));
  else if (!data.daemon.reachable) daemon.replaceChildren(el('p', {}, badge('offline'), ' ', data.daemon.error));
  else daemon.replaceChildren(el('p', {}, badge(data.daemon.state), ' ', data.daemon.name ?? ''),
    data.daemon.agents.length
      ? table(['Agent', 'Type', 'Status'], data.daemon.agents.map((a) => [a.name, a.adapterType, badge(a.status)]))
      : empty());

  const calls = document.getElementById('calls');
  calls.replaceChildren(
    el('p', { class: 'total' }, el('strong', {}, String(data.calls.today.total)), ' calls since midnight'),
    counts(data.calls.today.byState),
    data.calls.recent.length
      ? table(['Call', 'Direction', 'State', 'Started', 'Duration'], data.calls.recent.map((c) =>
        [c.id, c.direction, el('span', {}, badge(c.state), c.endedReason ? ` ${c.endedReason}` : ''), time(c.startedAt), duration(c.durationMs)]))
      : empty());

  const tasks = document.getElementById('tasks');
  tasks.replaceChildren(
    counts(data.tasks.byState),
    el('p', {}, 'Pending approvals: ', el('strong', {}, String(data.approvals.pending))),
    data.tasks.recent.length
      ? table(['Task', 'State', 'Run', 'Codex', 'Elapsed'], data.tasks.recent.map((t) =>
        [t.id, badge(t.state), t.runState ? badge(t.runState) : '—',
          t.codexThreadRecorded ? 'thread recorded' : 'no thread', duration(t.elapsedMs)]))
      : empty());

  const timeline = document.getElementById('timeline');
  timeline.replaceChildren(data.timeline.length
    ? el('ol', { class: 'timeline' }, ...data.timeline.map((item) =>
      el('li', {}, el('time', {}, time(item.at)), ` ${item.kind} ${item.id} `, badge(item.state), item.detail ? ` ${item.detail}` : '')))
    : empty());
}

async function refresh() {
  const status = document.getElementById('status');
  const banner = document.getElementById('error');
  try {
    const response = await fetch('/api/snapshot', { cache: 'no-store' });
    const data = await response.json();
    if (!data.database?.ok) throw new Error(data.database?.error ?? 'Database unavailable');
    render(data);
    banner.hidden = true;
    status.textContent = `Updated ${time(data.generatedAt)}`;
  } catch (error) {
    banner.textContent = `ERROR: ${error.message === 'Failed to fetch' ? 'Dashboard server not reachable' : error.message}. Data below may be stale.`;
    banner.hidden = false;
    status.textContent = 'Not updating';
  }
}

refresh();
setInterval(refresh, REFRESH_MS);
