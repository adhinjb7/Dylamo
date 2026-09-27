# Dylamo

Dylamo is a self-hosted, phone-native control plane for local AI agents. A
caller can start a task, let it continue after hanging up, receive a short
alert when a protected action needs attention, and make one exact approval by
phone.

The agent runs on the paired local machine. The phone is the remote interface,
not a replacement for local control.

## What the MVP demonstrates

- Caller authentication with an allowlisted phone number and a spoken or
  spoken or keypad PIN.
- A local Codex task that can keep running after the caller hangs up.
- One-use human approval before one configured **local** Git push. The demo
  pushes only to a disposable local bare repository, never to GitHub.
- A separate, synthetic site-monitor alert: a local simulated checkout issue
  triggers one short phone notification. It does not run a Codex task or send
  SMS.

## Quick local check

Requires Node.js 22.13 or newer.

From the repository root:

```powershell
npm install
npm run build:protocol
npm test
```

Private configuration belongs only in the ignored `.env` files. Start from
`apps/voice-webhook/.env.example` and `apps/daemon/.env.example`; never commit
phone numbers, PINs, API keys, daemon tokens, or tunnel URLs.

## Run the two demos

1. **Protected local release:** [protected-release runbook](docs/headline-demo.md)
   shows a prepared visual change, a real phone callback, one-use approval,
   and a visible local release.
2. **Synthetic monitor alert:** [monitor runbook](docs/site-monitor-demo.md)
   safely simulates a local checkout failure, places a short alert call, and
   demonstrates the “no SMS sent” response.

For a first rehearsal, use the protected-release runbook's local checks and
reject rehearsal before placing a real phone call.

## Project layout

- `apps/voice-webhook/` — Twilio voice webhook, caller authentication, durable
  call/task/approval state, and callback logic.
- `apps/daemon/` — paired local daemon, Codex adapter, approval boundary, and
  synthetic monitor demo.
- `packages/protocol/` — validated messages exchanged by the webhook and
  daemon.
- `docs/` — concise runbooks, architecture, teammate handoffs, and poster
  asset provenance.

## Important MVP boundaries

- The default Codex profile is read-only. Workspace-writing is opt-in and
  should use a disposable, non-sensitive repository.
- A PIN authenticates a caller; it does not grant blanket approval. Each
  protected action is bound to one pending action and expires.
- The synthetic monitor is local and deliberately narrow. It is not a claim of
  production monitoring, clinical workflow, classified-data handling, or
  operational command authority.
- A successful phone call is evidence of the live demo, but it is not a
  deployment to GitHub or a public website.

## Documentation map

- [Architecture](docs/architecture.md) — components, data boundaries, and
  safety model.
- [Protected local-release runbook](docs/headline-demo.md) — the primary
  callback-first demo and reset instructions.
- [Synthetic monitor demo](docs/site-monitor-demo.md) — the secondary phone
  alert demo.
- [Team handoffs](docs/team/README.md) — isolated work specifications for
  active teammates.
- [Poster mockup provenance](docs/poster/daemon-dashboard-mockup-prompt.md) —
  explains that the dashboard image is a concept, not a product screenshot.
