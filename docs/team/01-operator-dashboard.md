# Teammate A — local operator dashboard

## Goal

Build a small, read-only dashboard for the local demo. Show recent calls, tasks, outcomes, and paired-machine status; keep it independent of live voice-flow changes.

## Scope

- Write only under **apps/operator-dashboard/**. You may read **apps/voice-webhook/src/state.mjs** for SQLite and **apps/daemon/src/management.mjs** for optional health data.
- Do not edit the voice server, daemon, protocol, root scripts, lockfile, or their tests. Do not migrate the live database.
- Use built-ins and static HTML/CSS/JavaScript. Add no Twilio, OpenAI, GitHub, or tunnel integration; no login, hosting, callbacks, controls, approvals, or writes.

## Requirements

1. Provide **apps/operator-dashboard/src/server.mjs**, runnable with Node 22.13+:

   ~~~sh
   node apps/operator-dashboard/src/server.mjs --db <absolute-path-to-agent-phone.db>
   ~~~

   Require an existing readable database with expected tables and open it read-only. Bind only 127.0.0.1:3330 by default. Fail clearly for a missing or invalid database and for an occupied port.

2. Serve one local page and GET /api/snapshot. Return only redacted, allowlisted data: machine names and connectivity; recent call state and timestamps; recent task/run state, elapsed time, short display IDs, and whether a Codex thread or turn exists. Never return phone numbers, PIN hashes, tokens, callback nonces, prompts, raw Codex messages, approval commands, database paths, or generic SQL.

3. Show machine connectivity, calls today, tasks by state, and recent activity. Include **No data yet**, refresh every 2–5 seconds, and show a visible database error.

4. Use bounded parameterized queries and a read-only handle that tolerates SQLite WAL concurrency. An optional daemon health probe may call only a configurable loopback URL, must be labeled separately from persisted state, and must not break the page when offline.

5. Make the page legible on a laptop projector, 1280px screen, and phone width. Use text with color for state and avoid external CDN, analytics, charts, or failure-hiding animation.

## Acceptance criteria

- The CLI cannot bind to non-loopback addresses, and the dashboard is never tunneled.
- A fake phone number, PIN hash, token, prompt, and approval command never appear in /api/snapshot or HTML.
- Only needed GET and HEAD routes exist; mutations return 404 or 405. JSON uses Cache-Control: no-store, and startup/errors never print database contents.
- Requests never modify the database; tests prove records remain unchanged.

## Deliverables

- Server and static assets under **apps/operator-dashboard/**.
- **apps/operator-dashboard/test/dashboard.test.mjs** with a temporary minimum-schema SQLite fixture. Cover redaction, empty and populated data, bounded output, read-only behavior, bad databases, and loopback binding without Twilio, OpenAI, tunnel, or real .env.
- **apps/operator-dashboard/README.md** with startup, displayed and hidden data, and a screenshot or concise visual description using fake data.
- Demonstrate the assignment test and root npm test. If the shared schema changes, update only this folder.

## PR description

State what the operator can see, how read-only and redaction behavior was verified, test results, fake-data screenshots, and any proposed cross-component integration.
