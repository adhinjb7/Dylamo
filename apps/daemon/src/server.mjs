import { createDaemonClient } from './client.mjs';
import { createFakeAgent, FAKE_AGENT_ID } from './fake-agent.mjs';
import { createCodexAgent, CODEX_AGENT_ID } from './codex-agent.mjs';
import { createManagementServer } from './management.mjs';
import { randomUUID } from 'node:crypto';

const port = Number(process.env.DAEMON_PORT ?? 3210);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DAEMON_PORT must be an integer from 1 to 65535');

let fakeAgent;
let codexAgent;
const codexEnabled = process.env.CODEX_AGENT_ENABLED === 'true';
const allowWorkspaceWrite = process.env.CODEX_ALLOW_WORKSPACE_WRITE === 'true';
if (codexEnabled && !process.env.CODEX_WORKSPACE) throw new Error('CODEX_WORKSPACE is required when CODEX_AGENT_ENABLED=true');
const agents = [{ agentId: FAKE_AGENT_ID, adapterType: 'fake', name: 'Demo fake agent', status: 'idle' }];
if (codexEnabled) agents.push({ agentId: CODEX_AGENT_ID, adapterType: 'codex',
  name: allowWorkspaceWrite ? 'Codex workspace agent' : 'Codex read-only agent', status: 'idle' });
const client = createDaemonClient({
  serverUrl: process.env.DAEMON_SERVER_URL,
  machineId: process.env.DAEMON_MACHINE_ID,
  token: process.env.DAEMON_TOKEN,
  name: process.env.DAEMON_NAME ?? 'Local machine',
  agents,
  onEvent: (event) => {
    if (!codexAgent?.receive(event)) fakeAgent.receive(event);
  },
  onStatus: (state) => {
    console.log(`Daemon connection: ${state}`);
    if (state === 'online') {
      fakeAgent.flush(); codexAgent?.flush();
      client.send({ v: 1, eventId: randomUUID(), machineId: process.env.DAEMON_MACHINE_ID,
        type: 'machine.reconcile', activeRunIds: [...fakeAgent.activeRunIds(), ...(codexAgent?.activeRunIds() ?? [])] });
    }
  },
  onError: (message) => console.error(message),
});
fakeAgent = createFakeAgent({ machineId: process.env.DAEMON_MACHINE_ID, send: (event) => client.send(event) });
if (codexEnabled) codexAgent = createCodexAgent({
  machineId: process.env.DAEMON_MACHINE_ID, send: (event) => client.send(event),
  workspace: process.env.CODEX_WORKSPACE, command: process.env.CODEX_COMMAND ?? 'codex',
  model: process.env.CODEX_MODEL_DEFAULT ?? 'gpt-6-sol',
  allowFullRead: process.env.CODEX_ALLOW_FULL_READ === 'true',
  allowWorkspaceWrite,
  approvalCommand: process.env.CODEX_APPROVAL_COMMAND || undefined,
});
const management = createManagementServer(client);

management.listen(port, '127.0.0.1', () => {
  console.log(`Daemon status on http://127.0.0.1:${port}/health`);
  client.start();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    fakeAgent.stop();
    codexAgent?.stop();
    client.stop();
    management.close();
  });
}
