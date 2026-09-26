# Teammate B — offline demo and smoke-test harness

## Goal

Make the working phone flow demonstrable and testable on any teammate's laptop without a Twilio number, ngrok, an OpenAI API key, a Codex account, or a real daemon credential. This should give us a reliable pre-demo check when the live phone path is unavailable.

## Ownership and non-goals

- Create files only under `tools/offline-demo/**`. You may import public constructors from existing modules (for example `createServer`, `openStateStore`, `createDaemonClient`) and read existing tests for the signed Twilio request/media handshake pattern.
- Do not edit `apps/voice-webhook/**`, `apps/daemon/**`, `packages/protocol/**`, root scripts/lockfile/README, or any `.env`. If you find a production bug, report it in the PR with a minimal reproduction; Ryan will fix the shared component.
- Do not call Twilio, OpenAI, Codex, GitHub, or the public internet. Do not use the real database, caller number, tunnel URL, daemon token, or a production PIN. Do not start a background process that survives the command.
- This is a deterministic fake-agent rehearsal, not a claim that live speech recognition or Codex generation works.

## Required behavior

1. Provide `tools/offline-demo/run.mjs` with a one-command entry point: `node tools/offline-demo/run.mjs`. It creates an in-memory or temporary isolated state store, chooses unused loopback ports, creates throwaway credentials, starts a local voice server with an injected fake Realtime connector, and connects a fake daemon client. No `.env` file is loaded.
2. Exercise the real server's signed Twilio HTTP endpoints over loopback: inbound call, four-digit PIN, signed WebSocket media start, and one fake spoken task through the connector's `onTranscript` callback. Wait for durable task completion. End the media stream and close all servers, sockets, timers, and temporary files in a `finally` block, even after failure.
3. Print a concise, chronological trace such as `daemon online -> call authenticated -> media connected -> task queued -> task completed -> call ended`, plus a final `PASS` or `FAIL` and nonzero exit code on failure. Use synthetic IDs; redact credentials, PIN, raw prompt, and any secret-like values. Avoid dumping raw protocol events or the full database.
4. Include at least two negative checks: wrong PIN must not authenticate, and an unsigned or invalid media connection must not open a valid stream or task. Negative checks must use separate synthetic call IDs so they cannot affect the success path. If the fake agent takes several seconds, set a bounded timeout with a clear failure reason; do not busy-wait.
5. Do not duplicate the production implementation. Use the existing server and client constructors, injecting only fake external boundaries. If the existing API is too narrow, document the missing seam in the PR instead of changing protected files.

## Acceptance criteria

- Runs on Node 22.13+ after the repository's normal `npm install`/protocol build, without secrets, internet, or a telephone.
- A successful run exits 0 and reports a persisted completed task and ended call. Failed auth/signature checks cannot create a task.
- Every run uses isolated ephemeral state and loopback only; it cannot touch `data/agent-phone.db` or port 3000/3210 used by the live demo.
- Running twice in a row succeeds; no ports, sockets, timers, or temp files are left behind.
- A purposely broken expected result produces a nonzero exit rather than a misleading green demo.

## Deliverables and tests

- `tools/offline-demo/run.mjs` and any helper modules, with a small `tools/offline-demo/README.md` explaining exactly what is and is not tested.
- `tools/offline-demo/test/harness.test.mjs`: verify success exit, bounded failure behavior, redacted output, and repeatability. Use no real credentials or external calls.
- Demonstrate `node tools/offline-demo/run.mjs`, `node --test tools/offline-demo/test/harness.test.mjs`, and root `npm test` passing.

## Suggested PR description

Include a sample synthetic trace, timing, test results, and gaps between the offline rehearsal and a real Twilio/OpenAI/Codex call. List any shared-code bugs separately without modifying shared production files in this PR.
