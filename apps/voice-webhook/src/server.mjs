import { createServer } from './app.mjs';
import { parseDaemonCredentials } from './daemon-gateway.mjs';
import { databasePathFromUrl, openStateStore } from './state.mjs';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer from 1 to 65535');
}

const store = openStateStore(databasePathFromUrl(process.env.DATABASE_URL));
const recovered = store.recoverAfterRestart();
if (recovered.calls || recovered.machines) console.log(`Recovered state: ${recovered.calls} call(s) ended, ${recovered.machines} machine(s) offline`);

const server = createServer({
  authToken: process.env.TWILIO_AUTH_TOKEN,
  accountSid: process.env.TWILIO_ACCOUNT_SID,
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  allowedCallerNumber: process.env.ALLOWED_CALLER_NUMBER,
  callbackCallerNumber: process.env.TWILIO_PHONE_NUMBER,
  pinHash: process.env.DEMO_PIN_HASH,
  voiceMode: process.env.VOICE_MODE ?? 'tone',
  agentMode: process.env.AGENT_MODE ?? (process.env.VOICE_MODE === 'realtime' && process.env.DAEMON_CREDENTIALS ? 'fake' : 'voice'),
  openAiApiKey: process.env.OPENAI_API_KEY,
  codexApprovalEnabled: process.env.CODEX_APPROVAL_ENABLED === 'true',
  siteMonitorDemoEnabled: process.env.SITE_MONITOR_DEMO_ENABLED === 'true',
  siteMonitorMachineId: process.env.SITE_MONITOR_MACHINE_ID ?? null,
  daemonCredentials: parseDaemonCredentials(process.env.DAEMON_CREDENTIALS),
  onDaemonStatus: (machineId, status) => console.log(`Machine ${machineId}: ${status}`),
  stateStore: store,
});
server.on('close', () => store.close());

server.listen(port, '127.0.0.1', () => {
  console.log(`Voice webhook listening on http://127.0.0.1:${port}`);
});
