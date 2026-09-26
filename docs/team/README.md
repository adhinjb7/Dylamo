# Parallel work plan

The live Twilio / Realtime / Codex path is owned by Ryan. Two teammates can work in parallel on the assignments below without editing that path:

| Owner | Assignment | Exclusive write area |
| --- | --- | --- |
| Teammate A | [Local operator dashboard](01-operator-dashboard.md) | `apps/operator-dashboard/**` |
| Teammate B | [Offline demo and smoke-test harness](02-offline-demo-harness.md) | `tools/offline-demo/**` |

The assignments are independent of each other. Both may **read** existing code and documentation, but neither should edit `apps/voice-webhook/**`, `apps/daemon/**`, `packages/protocol/**`, root `package.json`, `package-lock.json`, `README.md`, or `.env` files. Do not change the Twilio number, ngrok tunnel, live database, or Codex configuration. If a task genuinely requires changing a protected file or protocol, describe the proposed change in the pull request and ask Ryan to own that integration.

## Git handoff

1. Start from the latest pushed `origin/main`, not Ryan's local working tree. Ryan currently has local voice/daemon/protocol changes that may not yet be on GitHub.
2. Create a separate branch: `feature/operator-dashboard` or `feature/offline-demo-harness`.
3. Commit only files within your exclusive write area. Do not commit `.env`, database, auth tokens, phone numbers, or recordings.
4. Run your assignment's tests and the existing `npm test` from the repository root. Report exact commands and results in your pull request.
5. Open a pull request to `main`; do not push directly to `main`. Ryan will merge after the live-call work is stable. If `main` moved, update your branch before merge and rerun tests.

The two assignments have no shared implementation files, so their PRs can be reviewed and merged separately. A passing offline test does not substitute for a live phone call.
