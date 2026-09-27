# Dylamo architecture

~~~text
Caller phone
    ↕ Twilio Voice (signed webhooks and media)
Voice webhook
    ↕ authenticated WebSocket
Paired local daemon ──→ Codex agent
        └──────────────→ local synthetic monitor
~~~

## Components

- **Voice webhook** authenticates callers, verifies signed Twilio traffic, stores SQLite state, and calls back when needed.
- **Paired local daemon** continues tasks after calls, runs the agent adapter, and enforces one-use approval at the local action boundary.
- **Codex agent** investigates the configured workspace. It is read-only by default; writes require a disposable demo workspace.
- **Synthetic monitor** is a local demo page that emits fixed, signed incident and recovery events through the daemon. It never checks external sites.
- **Shared protocol** validates versioned webhook and daemon messages. Event IDs prevent retries from repeating protected actions.

## Flows

### Protected local release

1. The caller authenticates and requests the prepared release.
2. Codex requests one exact local Git command.
3. The command stays blocked until the authenticated call, or a fresh authenticated callback, gives a one-use decision.
4. The daemon verifies the local destination ref before reporting success. Nothing reaches GitHub.

### Synthetic monitor alert

1. The local page simulates a checkout failure.
2. The daemon emits one signed, deduplicated incident.
3. The voice webhook places one short notification call.
4. The caller can decline an offered text report; the MVP never sends SMS.

## Boundaries

- Caller identity requires the allowlist plus PIN; raw PINs are never stored.
- Webhooks are signed and the daemon connection is authenticated.
- Approvals are exact, one-use, and time-limited; a generic “yes” is insufficient.
- Monitor and release state are separate. A monitor alert cannot approve a command or change a repository.
- Keep .env files, local databases, credentials, phone numbers, and non-demo workspaces out of Git.
