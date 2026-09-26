# Teammate A — local operator dashboard

## Goal

Build a small, read-only web page that lets the demo operator see whether the phone-to-agent system is working: recent calls, tasks, run outcomes, and paired-machine status. This is for a local hackathon demo, **not** a public admin product. It must remain useful even while Ryan changes the live voice flow.

## Ownership and non-goals

- Create files only under `apps/operator-dashboard/**`. You may read `apps/voice-webhook/src/state.mjs` to understand the existing SQLite schema and `apps/daemon/src/management.mjs` to understand the optional daemon health response.
- Do not edit, import private internals from, or alter the voice server, daemon, shared protocol, root scripts, lockfile, or their tests. Do not run migrations against the live database.
- Do not add Twilio, OpenAI, GitHub, or ngrok integrations. Do not add login, public hosting, callbacks, task control, approvals, or any write action.
- Prefer Node built-ins and static HTML/CSS/JavaScript so this work needs no root dependency or lockfile changes.

## Required behavior

1. Provide `apps/operator-dashboard/src/server.mjs`, runnable with Node 22.13+ as `node apps/operator-dashboard/src/server.mjs --db <absolute-path-to-agent-phone.db>`. The database argument is required; do not silently create a new database. Fail with a helpful error if it is missing, unreadable, or lacks expected tables. Open it read-only. Bind HTTP to `127.0.0.1` only, on port `3330` by default. If the port is taken, fail clearly rather than selecting a public interface.
2. Serve a single-page local dashboard and `GET /api/snapshot`. The snapshot must contain only an allowlisted, redacted view: machine names and online/offline state; recent call state and timestamps; recent task/run state, elapsed time, short display IDs, and whether a Codex thread/turn was recorded. The browser must not receive phone numbers, PIN hashes, tokens, callback nonces, full prompts, raw Codex messages, approval commands, or database paths. Do not expose a generic SQL endpoint.
3. Show at least four clear cards/sections: machine connectivity, calls today, tasks by state, and a recent activity timeline. Show "No data yet" states. Refresh automatically every 2–5 seconds without a page reload. A disconnected or unavailable database should show a visible error, not an empty success state.
4. Use parameterized, bounded queries (`LIMIT` on recent lists), handle nulls and SQLite WAL concurrency, and keep the database handle read-only. If the optional daemon `/health` is included, call only a configurable loopback URL; label its result separately from persisted machine state and do not make the page fail when the daemon is offline.
5. Make the UI legible on a laptop projector and at 1280px and phone widths. State labels must use text as well as color. Avoid charts or animation that obscure failures. No external CDN or analytics requests.

## Security and privacy acceptance criteria

- Requests to non-loopback bind addresses are impossible through the CLI. Do not tunnel this dashboard.
- A fixture containing a fake phone number, PIN hash, token, prompt, and approval command must not expose any of those strings in `/api/snapshot` or the HTML response.
- Only `GET` and `HEAD` routes needed for the dashboard work; mutation requests return 404 or 405. Set `Cache-Control: no-store` on JSON. Never print database contents in startup/errors.
- The dashboard must never modify an existing database; tests should prove records are unchanged after requests.

## Deliverables and tests

- `apps/operator-dashboard/src/server.mjs` plus any static assets under that folder.
- `apps/operator-dashboard/test/dashboard.test.mjs`: use a temporary SQLite fixture with the minimum current schema; verify redaction, empty state, populated state, bounded output, read-only behavior, bad database handling, and loopback binding. Tests must not need Twilio, OpenAI, ngrok, or a real `.env`.
- `apps/operator-dashboard/README.md`: startup command, what data is displayed/hidden, and a screenshot or concise visual description. Never include real caller data.
- Demonstrate `node --test apps/operator-dashboard/test/dashboard.test.mjs` and root `npm test` passing. If the existing schema changes before merge, update only your adapter and tests inside your owned folder.

## Suggested PR description

Explain what the operator can see, how you verified read-only/redaction guarantees, screenshots using fake fixture data, test results, and any proposed cross-component changes (do not implement those changes in this PR).
