# Teammate handoffs

Ryan owns the live Twilio, Realtime, and Codex path. These handoffs define independent work outside that path.

| Owner | Assignment | Exclusive write area |
| --- | --- | --- |
| Teammate A | [Local operator dashboard](01-operator-dashboard.md) | apps/operator-dashboard/** |
| Teammate B (in progress) | [Offline demo and smoke-test harness](02-offline-demo-harness.md) | tools/offline-demo/** |
| Optional after MVP | [Live-demo preflight and recovery kit](02-live-demo-preflight.md) | tools/live-preflight/** |

Assignments may read code and docs but write only their assigned directory. Leave apps/voice-webhook/**, apps/daemon/**, packages/protocol/**, root manifests and README, and .env files unchanged; propose required integrations in the PR for Ryan.

## Git handoff

1. Start from the latest pushed origin/main, not Ryan’s local working tree.
2. Use a separate branch for each assignment.
3. Commit only the assigned area. Never commit .env files, databases, tokens, phone numbers, or recordings.
4. Run the assignment tests and root npm test; report commands and results in the PR.
5. Open a PR to main. Ryan merges after live-call work is stable.

The offline harness and preflight do not replace a real phone test.
