# Teammate B — live-demo preflight and recovery kit

## Goal

Provide a fast, read-only pre-call check for the demo laptop, with a recovery runbook and presentation script. Detect working-directory, Codex-path, voice, daemon, tunnel, and public-reachability failures without a call or model turn. Complete the offline harness first; this is a separate follow-up.

## Scope

- Write only under **tools/live-preflight/**. You may read .env.example files, the voice app, daemon management code, and existing check scripts. Do not edit them, private .env files, the protocol, root manifest, or lockfile.
- Never request, print, copy, commit, or transmit keys, credentials, PINs, tokens, caller numbers, or full environment files.
- The checker may read local files, call health endpoints, and run codex --version. It may not create tasks, call Twilio, use a model turn, change configuration, start or stop services, write the database, or change Git state.
- Use Node built-ins and existing dependencies. Do not bind a public port.

## Command and checks

Implement **tools/live-preflight/check.mjs**, run from the repository root:

~~~sh
node --env-file=apps/voice-webhook/.env --env-file=apps/daemon/.env tools/live-preflight/check.mjs
~~~

Print one PASS, FAIL, WARN, or SKIP line per check, a final summary, and a nonzero exit for a required failure. Network and process probes time out within five seconds. Continue independent checks after failures and never expose a stack trace or secret.

Required checks:

1. **Configuration:** Confirm required variables without values. PUBLIC_BASE_URL must be an HTTPS origin; DAEMON_SERVER_URL must be wss, use the same host, and end in /daemon. Require VOICE_MODE=realtime, AGENT_MODE=codex, and CODEX_AGENT_ENABLED=true. Warn for intentionally optional settings.
2. **Codex and workspace:** Resolve CODEX_COMMAND as a path or PATH command, run --version only, and confirm CODEX_WORKSPACE is a directory. Distinguish a missing executable from a missing workspace without showing paths or raw stderr.
3. **Voice:** GET `http://127.0.0.1:<PORT>/health`, default port 3000, and require HTTP 200 with body ok. Do not call `/voice` or `/voice/pin`.
4. **Daemon:** GET `http://127.0.0.1:<DAEMON_PORT>/health`, default 3210. Require valid JSON with state: online and a codex adapter. A connecting daemon fails. Do not print machine IDs or extra response data.
5. **Public tunnel:** GET `<PUBLIC_BASE_URL>/health` and require HTTP 200 with body ok. Classify timeouts, DNS, TLS, and HTTP errors generically. With `--no-public`, mark it SKIP.

Handle malformed ports and URLs, malformed daemon JSON, unavailable Codex, and timeouts safely. A missing input skips only checks that depend on it. Put Twilio webhook verification in the manual runbook, not the checker.

## Runbook and script

Create **tools/live-preflight/RUNBOOK.md** with:

- A two-minute pre-call sequence: confirm webhook, public tunnel, and daemon; run the checker; verify the Twilio Voice webhook targets the configured public origin plus /voice; make one allowlisted-phone call.
- A one-minute judge script using a non-sensitive demo repository: ask one substantive repository question, wait for the answer, then ask one follow-up. Explain that Codex is read-only and that the phone number and PIN are private.
- A symptom-to-action table for Codex ENOENT, daemon connecting, local or public health down, voice disconnect, Codex task failure, and a new question during an active turn. State which process to restart after each configuration change.
- Limits: a green preflight does not verify Twilio settings, call audio, transcription, generation, or a successful repository answer; only a real call does.
- A privacy-safe fallback: show a consented sanitized recording and the dashboard only if the team prepared them. Do not record automatically or commit recordings.

## Tests and handoff

- Add **tools/live-preflight/test/check.test.mjs** using fake environment values, temporary files, injected or mock fetch/process probes, or fixture servers. Never contact external services or private .env files.
- Cover passing checks, missing Codex/workspace, mismatched hosts, voice down, daemon connecting, public timeout, bad JSON, --no-public, redaction, and nonzero required failure. Run twice without files or processes left behind.
- Demonstrate the assignment tests and root npm test, include redacted sample output in the PR, and keep the dashboard independent.
- Use branch feature/live-demo-preflight, commit only this directory, and open a PR to main. Request any shared-code change from Ryan.
