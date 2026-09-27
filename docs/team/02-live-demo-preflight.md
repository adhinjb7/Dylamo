# Teammate B — live-demo preflight and recovery kit

## Goal and why this matters

Give the operator one fast, read-only command to run on the **actual demo laptop** before placing a real phone call. It should catch the failures we have already hit: wrong working directory, stale Codex executable path, a stopped voice webhook, an offline daemon, mismatched tunnel URLs, or a public tunnel that does not reach the webhook. Pair it with a concise recovery runbook and live presentation script. This complements the offline harness already in progress: it checks the real services and configuration, while still not making a phone call or consuming a model turn. Finish the offline-harness PR first; this is a separate follow-up assignment, not a replacement.

This complements Teammate A's dashboard: the dashboard displays ongoing task history; this preflight checks readiness **before** the live call. The two PRs must have no shared implementation files.

## Ownership and boundaries

- Create files only under `tools/live-preflight/**`. Read existing `.env.example` files, `apps/voice-webhook/src/app.mjs`, `apps/daemon/src/management.mjs`, and existing check scripts as needed. Do not edit those files, the root manifest/lockfile, protocol, live server/daemon, or either private `.env`.
- Do not request, print, copy, commit, or transmit API keys, Twilio credentials, PINs, daemon tokens, caller numbers, or complete environment files. The operator runs this locally with their existing private config; teammates never need those values.
- The command must be observational: GET health endpoints, check local file existence, and invoke `codex --version` or an equivalent version-only probe. It must not create a task, call Twilio, start an app-server model turn, alter settings, start/stop services, write the database, or change Git state.
- Use Node built-ins and existing dependencies only. Do not modify `package.json` or `package-lock.json`. Never bind a public port or expose a new HTTP service.

## Required command and checks

Implement `tools/live-preflight/check.mjs` so the operator can run it from the repository root:

```powershell
node --env-file=apps/voice-webhook/.env --env-file=apps/daemon/.env tools/live-preflight/check.mjs
```

The checker must give one PASS/FAIL/WARN line per check, a final summary, and exit nonzero if a required check fails. It must apply short timeouts (5 seconds or less per network/process probe) and never hang indefinitely. Required checks:

1. **Configuration shape:** Confirm the required variables are present without showing values. Validate that `PUBLIC_BASE_URL` is an HTTPS origin and that `DAEMON_SERVER_URL` uses `wss:` with the **same host** and `/daemon` path. Confirm `VOICE_MODE=realtime`, `AGENT_MODE=codex`, and `CODEX_AGENT_ENABLED=true` for this live Codex demo. Warn, rather than fail, for settings that are intentionally optional.
2. **Codex executable and workspace:** Resolve `CODEX_COMMAND` as either a concrete executable path or a command on the child-process PATH. Confirm it can run `--version` without a model turn, and confirm `CODEX_WORKSPACE` exists and is a directory. Clearly distinguish “executable not found” from “workspace missing.” Do not print the path or raw process stderr; give safe next steps such as “update CODEX_COMMAND, then restart daemon.”
3. **Local voice health:** GET `http://127.0.0.1:<PORT>/health` (default 3000) and require HTTP 200 with body `ok`. This is the existing read-only endpoint; do not call `/voice` or `/voice/pin`.
4. **Local daemon health:** GET `http://127.0.0.1:<DAEMON_PORT>/health` (default 3210), parse the existing JSON response, and require `state: "online"` with a registered `codex` adapter. A listening daemon that is still `connecting` is a FAIL, not a PASS. Do not display machine ID or other response fields.
5. **Public tunnel health:** GET `<PUBLIC_BASE_URL>/health` and require HTTP 200 with body `ok`; use a timeout and a generic error classification. Do not print the full public URL or response body. Provide `--no-public` for an intentionally local-only check; in that mode mark the tunnel check SKIP, not PASS.

Handle malformed ports, malformed URLs, non-JSON daemon responses, timeouts, DNS/TLS failures, and an unavailable executable without a stack trace or credential leak. A check failure must not prevent independent checks from running, except when its missing input makes that specific check impossible. The output should make the *first actionable fix* obvious. Do not issue a Twilio API request to verify its webhook configuration; put that as a manual item in the runbook.

## Recovery runbook and presentation script

Create `tools/live-preflight/RUNBOOK.md` containing:

- A two-minute pre-call sequence: start or confirm webhook, ngrok, and daemon in separate terminals; run the checker; confirm Twilio Voice webhook points to the configured public origin plus `/voice` in the Twilio console; then make one real call from the allowlisted phone.
- A one-minute judge-facing script using only a non-sensitive demo repository: one substantive repository question, wait for the spoken answer, then one follow-up in the same call. Explain that Codex is read-only and that the phone number/PIN are private. Do not embed a real number, PIN, API key, tunnel host, or machine ID.
- A short symptom-to-action table for `spawn codex ENOENT`, daemon `connecting`, local `/health` down, public `/health` down, voice disconnect, Codex task failure, and “question asked while a previous turn is still running.” Include which process must be restarted after changing each config value.
- Honest limitations: a green preflight does **not** verify Twilio webhook settings, call audio, OpenAI transcription, model generation, or a successful Codex repository answer. Only a real call verifies the complete path.
- A privacy-safe fallback plan: if the live call fails, show a previously recorded, sanitized demo (only if the team has prepared one with consent) and the operator dashboard. Do not automatically record calls or include recordings in the repository.

## Tests and acceptance criteria

- `tools/live-preflight/test/check.test.mjs` must use fake environment values, temporary files, and injected/mock fetch and process probes or local fixture servers. Tests must not contact Twilio, OpenAI, ngrok, or a real tunnel, and must not read either private `.env`.
- Cover: all checks pass; missing Codex executable; missing workspace; mismatched tunnel host; local voice down; daemon listening but not online; public timeout; malformed daemon JSON; `--no-public`; redaction of secret-like test values from both success and error output; nonzero exit on required failure.
- Run twice without creating files or leaving processes behind. The checker should have no dependency on the dashboard PR.
- Demonstrate `node --test tools/live-preflight/test/check.test.mjs` and root `npm test` passing. The PR should include a sample **redacted** output and explain any check that needs manual confirmation.

## Git handoff

Use branch `feature/live-demo-preflight`, commit only `tools/live-preflight/**`, and open a PR to `main`. If a useful check requires changing the voice server, daemon, protocol, or root scripts, describe that as a follow-up request for Ryan rather than editing those files in this PR.
