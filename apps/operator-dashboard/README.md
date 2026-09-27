# Operator dashboard

A small, read-only web page for the person running the phone-to-agent demo. It shows whether the system is working: paired machines, today's calls, tasks and their runs, and recent activity. It reads the voice server's SQLite database and never writes to it. It is a local demo tool, not a public admin product.

## Start it

Requires Node.js 22.13 or newer. There are no extra dependencies.

```bash
node apps/operator-dashboard/src/server.mjs --db /absolute/path/to/data/agent-phone.db
```

Open <http://127.0.0.1:3330/>. The page refreshes itself every 3 seconds. Stop the server with Ctrl+C.

| Option | Default | Meaning |
| --- | --- | --- |
| `--db <path>` | required | Absolute path to the voice server's database (by default `data/agent-phone.db` at the repository root, created once the voice server has run). |
| `--port <n>` | `3330` | Local port. If it is taken, the dashboard exits with an error instead of choosing another address. |
| `--daemon-url <url>` | `http://127.0.0.1:3210/health` | The local daemon's health endpoint. Only `http://` on `127.0.0.1`, `localhost` or `[::1]` is accepted. |
| `--no-daemon` | | Turn off the live daemon check. |

The dashboard always binds to `127.0.0.1`; there is no option to change that. Do not tunnel it or expose it publicly.

It refuses to start, with a message saying why, if `--db` is missing or relative, the file does not exist or cannot be read, or the file is not an agent-phone database. It never creates a database.

### Try it without a live call

Create a database of fake demo data and point the dashboard at it:

```bash
node apps/operator-dashboard/scripts/create-fixture-db.mjs ~/Desktop/demo-agent-phone.db
node apps/operator-dashboard/src/server.mjs --db ~/Desktop/demo-agent-phone.db --no-daemon
```

Add `--empty` to the first command for a database with the tables but no rows. The script will not overwrite an existing file.

## What the page shows

One page with four cards. Every state is written as a word on a coloured label (for example `FAILED` on red), so it stays readable on a projector or without colour.

- **Machines:** each paired machine's name, `ONLINE` or `OFFLINE` as recorded in the database, and when it was last seen. Below it, **Live daemon check** shows what the local daemon reports right now, labelled separately because it can differ from the stored state. If the daemon is not running this box says so; the rest of the page keeps working.
- **Calls today:** the number of calls since local midnight, counts per call state, and the ten most recent calls with direction, state, end reason, start time and duration.
- **Tasks by state:** counts for queued, running, waiting for a human, completed, failed and cancelled; the number of pending approvals; and the ten most recent tasks with their latest run state, whether a Codex thread was recorded, and elapsed time.
- **Recent activity:** the latest twenty call and task events, newest first.

Empty sections say "No data yet". If the database becomes unavailable, a red `ERROR` banner appears and the page stops showing new data until it recovers; it never shows an empty page as if nothing had happened.

On a laptop or projector the cards sit two or three to a row; at phone width they stack in one column, and wide tables scroll inside their card.

## What stays hidden

The browser only receives the fields listed above. The dashboard never sends:

- caller phone numbers, PIN hashes or daemon token hashes;
- task prompts or anything the caller said;
- approval commands, working directories or callback nonces;
- raw Codex messages or thread/turn IDs (only "recorded: yes/no");
- Twilio call SIDs, full record IDs (only the last six characters) or the database file path.

These columns are never queried. There is no endpoint that accepts SQL or filters.

## HTTP interface

| Route | Returns |
| --- | --- |
| `GET /` | The dashboard page (`/app.js` and `/styles.css` are its assets). |
| `GET /api/snapshot` | JSON summary described above, with `Cache-Control: no-store`. Status `503` with `{"database":{"ok":false,...}}` when the database is unavailable. |

Only `GET` and `HEAD` are served. Other methods get `405`, unknown paths `404`, and requests whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` get `421` (protection against DNS rebinding). Responses carry a strict Content-Security-Policy; the page loads nothing from outside this server.

## How it reads the database

The database is opened read-only (`readOnly: true` and `PRAGMA query_only`), so neither a bug nor a request can change it. Each snapshot is read in one transaction, giving a consistent view while the voice server keeps writing in WAL mode. Every list query has a `LIMIT`. If a query fails, the handle is closed and reopened on the next refresh.

The dashboard depends only on the columns it reads from `machines`, `call_attempts`, `tasks`, `agent_runs` and `approvals`, and checks for them at startup.

## Tests

```bash
node --test apps/operator-dashboard/test/*.test.mjs
```

The tests build temporary fake databases (`test/fixtures.mjs`) and need no Twilio, OpenAI, ngrok or `.env`. They cover redaction (planted fake secrets must never appear in the JSON or page), empty and populated states, bounded lists, proof that no record changes, bad or vanishing databases, method and host checks, loopback-only binding, and the optional daemon check.

`test/fixtures.mjs` holds a copy of the voice server's schema, because the dashboard must not import voice-server code. A test compares that copy with `apps/voice-webhook/src/state.mjs` and fails if the live schema changes, so the copy cannot silently fall behind.
