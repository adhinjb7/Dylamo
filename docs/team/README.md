# Parallel work plan

The live Twilio / Realtime / Codex path is owned by Ryan. Two teammates can work in parallel on the assignments below without editing that path:

| Owner | Assignment | Exclusive write area |
| --- | --- | --- |
| Teammate A | [Local operator dashboard](01-operator-dashboard.md) | `apps/operator-dashboard/**` |
| Teammate B (in progress) | [Offline demo and smoke-test harness](02-offline-demo-harness.md) | `tools/offline-demo/**` |
| Follow-up after B's PR | [Live-demo preflight and recovery kit](02-live-demo-preflight.md) | `tools/live-preflight/**` |

The assignments are independent of each other. Both may **read** existing code and documentation, but neither should edit `apps/voice-webhook/**`, `apps/daemon/**`, `packages/protocol/**`, root `package.json`, `package-lock.json`, `README.md`, or `.env` files. Do not change the Twilio number, ngrok tunnel, live database, or Codex configuration. If a task genuinely requires changing a protected file or protocol, describe the proposed change in the pull request and ask Ryan to own that integration.

## Git handoff

1. Start from the latest pushed `origin/main`, not Ryan's local working tree. Ryan may have local voice-flow changes that are not yet on GitHub.
2. Create a separate branch for each assignment: `feature/operator-dashboard`, `feature/offline-demo-harness`, or, later, `feature/live-demo-preflight`.
3. Commit only files within your exclusive write area. Do not commit `.env`, database, auth tokens, phone numbers, or recordings.
4. Run your assignment's tests and the existing `npm test` from the repository root. Report exact commands and results in your pull request.
5. Open a pull request to `main`; do not push directly to `main`. Ryan will merge after the live-call work is stable. If `main` moved, update your branch before merge and rerun tests.

These assignments have no shared implementation files, so their PRs can be reviewed and merged separately. Teammate B should finish the offline harness already in progress; the live preflight is a separate follow-up, not a replacement. The offline harness tests a synthetic path, and the preflight checks local readiness; neither substitutes for a real phone test.
