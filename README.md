# Dylamo

Dylamo is a self-hosted phone interface for local AI agents. An authenticated caller can start a task, hang up, and approve one exact action by phone when needed. The paired machine remains in control.

## MVP

- Allowlisted caller authentication by spoken or keypad PIN.
- A local Codex task that continues after the caller hangs up.
- One-use approval for one configured local Git push to a disposable bare repository; never GitHub.
- A synthetic local checkout monitor that places one phone alert. It runs no Codex task and sends no SMS.

## Local setup

Requires Node.js 22.13 or newer.

~~~sh
npm install
npm run build:protocol
npm test
~~~

Create ignored .env files from **apps/voice-webhook/.env.example** and **apps/daemon/.env.example**. Never commit phone numbers, PINs, keys, tokens, or tunnel URLs.

## Demos

1. [Protected local release](docs/headline-demo.md): a prepared visual change, callback, and one-use approval.
2. [Synthetic monitor alert](docs/site-monitor-demo.md): a safe local outage simulation and phone notification.

Run the protected-release preflight and rejection rehearsal before a live call.

## Layout

- **apps/voice-webhook/**: Twilio webhook, authentication, SQLite state, and callbacks.
- **apps/daemon/**: paired local daemon, Codex adapter, approval boundary, and monitor.
- **packages/protocol/**: validated webhook and daemon messages.
- **docs/**: runbooks, architecture, handoffs, and poster provenance.

## Boundaries

- Codex is read-only by default. Use writes only in a disposable, non-sensitive repository.
- A PIN authenticates the caller; each approval applies to one pending action and expires.
- The local monitor is a demo, not production monitoring or operational authority.
- A successful call validates the demo; it does not deploy to GitHub or a public site.

## Documentation

- [Architecture](docs/architecture.md)
- [Protected local-release runbook](docs/headline-demo.md)
- [Synthetic monitor demo](docs/site-monitor-demo.md)
- [Team handoffs](docs/team/README.md)
- [Poster mockup provenance](docs/poster/daemon-dashboard-mockup-prompt.md)
