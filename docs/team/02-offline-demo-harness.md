# Teammate B — offline demo and smoke-test harness

## Goal

Create a deterministic fake-agent rehearsal for any laptop, without external services, production credentials, or a real daemon. It provides a reliable pre-demo check when the live phone path is unavailable.

## Scope

- Write only under **tools/offline-demo/**. You may use public constructors such as createServer, openStateStore, and createDaemonClient, plus existing signed-request tests.
- Do not edit production apps, protocol, root scripts, lockfile, README, or .env files. Report shared bugs with a minimal reproduction for Ryan.
- Use no Twilio, OpenAI, Codex, GitHub, public internet, real database, caller number, tunnel URL, daemon token, or PIN. Leave no background process.
- This rehearses a deterministic fake agent; it does not validate live transcription or Codex generation.

## Requirements

1. Provide **tools/offline-demo/run.mjs**, runnable as:

   ~~~sh
   node tools/offline-demo/run.mjs
   ~~~

   Create isolated in-memory or temporary state, unused loopback ports, throwaway credentials, a local voice server with an injected fake Realtime connector, and a fake daemon client. Load no .env file.

2. Exercise the real signed Twilio HTTP and media endpoints over loopback: inbound call, four-digit PIN, signed media start, and one fake spoken task through onTranscript. Wait for durable completion, then close servers, sockets, timers, and temporary files in finally.

3. Print a short trace such as daemon online → call authenticated → media connected → task queued → task completed → call ended, then PASS or FAIL. Use synthetic IDs, redact secrets and prompts, and exit nonzero on failure.

4. Prove that a wrong PIN cannot authenticate and invalid or unsigned media cannot open a valid stream or task. Use separate fake call IDs and bounded timeouts.

5. Reuse production constructors and inject only external boundaries. Document a missing seam in the PR instead of modifying protected files.

## Acceptance criteria

- Runs on Node 22.13+ after normal install and protocol build, with no secrets, internet, or phone.
- Success exits 0 with a persisted completed task and ended call; failed auth or signatures create no task.
- Each run uses ephemeral loopback state, never data/agent-phone.db or ports 3000/3210, and leaves no ports, sockets, timers, or files.
- Repeated runs succeed, and a deliberately broken expectation exits nonzero.

## Deliverables

- **tools/offline-demo/run.mjs**, helpers, and a README describing coverage and limits.
- **tools/offline-demo/test/harness.test.mjs** for success exit, bounded failure, redacted output, and repeatability without real credentials or external calls.
- Demonstrate the runner, assignment tests, and root npm test.

## PR description

Include a sample synthetic trace, timing, test results, live-call gaps, and any shared-code bug without changing production files.
