# Dylamo

Dylamo is a self-hosted phone interface for local AI agents. A signed Twilio voice webhook communicates with a paired local daemon over an authenticated WebSocket so an authenticated caller can start a task, hang up, receive a callback, and approve one exact protected action when needed.

## What is included

- Caller allowlisting and a four-digit PIN stored as a hash.
- A loopback voice webhook with SQLite-backed call, task, and approval state.
- An authenticated WebSocket connection to a paired local daemon.
- A built-in fake agent and an opt-in Codex agent.
- A protected local-release demo and a synthetic local checkout-monitor demo.

## Run locally

Requires Node.js 22.13 or newer.

~~~sh
npm install
npm run build:protocol
~~~

Create ignored private .env files from **apps/voice-webhook/.env.example** and **apps/daemon/.env.example**. Never commit credentials, phone numbers, PINs, database files, or tunnel URLs.

Generate the values needed to configure those files:

~~~sh
node apps/voice-webhook/scripts/hash-pin.mjs
node apps/daemon/scripts/generate-pairing.mjs
~~~

The PIN script prints a DEMO_PIN_HASH. The pairing script prints the matching daemon machine ID, token, and voice-webhook credential entry. Set PUBLIC_BASE_URL to a bare public HTTPS origin, set DAEMON_SERVER_URL to its matching WSS /daemon endpoint, and configure Twilio to POST to PUBLIC_BASE_URL plus /voice.

Start both services in separate terminals after configuration:

~~~sh
node --env-file=apps/voice-webhook/.env apps/voice-webhook/src/server.mjs
node --env-file=apps/daemon/.env apps/daemon/src/server.mjs
~~~

Both bind to loopback by default. Run npm test for the full test suite when you want to verify a change.

## Modes and demos

The supplied .env.example defaults are VOICE_MODE=tone, AGENT_MODE=voice, and no Codex agent.

The protected release demo requires realtime voice, AGENT_MODE=codex, daemon CODEX_AGENT_ENABLED=true, voice CODEX_APPROVAL_ENABLED=true, a paired daemon, an OpenAI key, and an outbound Twilio number. It also needs an installed, signed-in Codex CLI, a disposable CODEX_WORKSPACE, and the exact CODEX_APPROVAL_COMMAND. The runbook prepares the fixture. It approves only the prepared local fixture push; it never pushes Dylamo or GitHub.

The synthetic monitor is opt-in. It emits fixed local outage and recovery events, places one notification call, checks no external site, and sends no SMS.

- [Protected local-release demo](docs/headline-demo.md)
- [Synthetic monitor demo](docs/site-monitor-demo.md)

## Repository layout

- **apps/voice-webhook/**: Twilio webhook, authentication, SQLite state, callbacks, and daemon gateway.
- **apps/daemon/**: paired local daemon, fake and Codex adapters, approval boundary, and monitor.
- **packages/protocol/**: validated messages shared by the webhook and daemon.
- **docs/**: architecture, demo runbooks, and poster provenance.

## Safety boundaries

- The caller must match the allowlist and PIN; raw PINs are never stored.
- Webhooks are signed, and daemon connections are authenticated.
- Codex is read-only by default. Workspace writes require a disposable, non-sensitive repository.
- Approvals are exact, one-use, and time-limited. A generic “yes” is insufficient.
- The release fixture targets a disposable local bare repository. It never deploys to GitHub or a public site.

## Documentation

- [Architecture](docs/architecture.md)
- [Protected local-release runbook](docs/headline-demo.md)
- [Synthetic monitor runbook](docs/site-monitor-demo.md)
- [Poster mockup provenance](docs/poster/daemon-dashboard-mockup-prompt.md)
