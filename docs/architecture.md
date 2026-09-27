# Dylamo architecture

```text
Caller phone
    ↕ Twilio Voice (signed webhooks and media)
Voice webhook
    ↕ authenticated WebSocket
Paired local daemon ──→ Codex agent
        └──────────────→ local synthetic monitor
```

## What each part owns

- **Voice webhook** authenticates the caller, receives signed Twilio traffic,
  stores call/task/approval state in SQLite, speaks concise updates, and places
  a callback only when needed.
- **Paired local daemon** keeps tasks running after a call ends, runs the local
  agent adapter, and enforces the exact one-use approval at the local action
  boundary.
- **Codex agent** investigates the configured local workspace. It is read-only
  by default; an optional write profile is only for a disposable demo workspace.
- **Synthetic monitor** is a local-only demo page. It sends fixed, signed
  incident and recovery events through the existing daemon connection; it does
  not inspect an external production site.
- **Shared protocol** validates versioned messages between the webhook and
  daemon. It includes event IDs so retries cannot repeat a protected action.

## The two main flows

### Protected local release

1. The caller authenticates and asks for the prepared demo release.
2. The daemon asks Codex to request one exact local Git command.
3. The command stays blocked until the same authenticated call, or a fresh
   PIN-authenticated callback, gives a one-use decision.
4. The daemon independently checks the local destination ref before reporting
   success. Nothing is pushed to GitHub.

### Synthetic monitor alert

1. The local demo page simulates a checkout failure.
2. The paired daemon emits one signed, deduplicated incident event.
3. The voice webhook places one short notification call.
4. The caller can decline a detailed report by text. The MVP deliberately sends
   no SMS.

## Safety and privacy boundaries

- Caller identity requires the allowlist plus PIN; raw PINs are never stored.
- Webhooks are signed and the daemon connection is authenticated.
- Approval is exact, one-use, and time-limited. A casual “yes” does not approve
  an action.
- The monitor and release demos have separate state. A monitor alert cannot
  approve a command or change a repository.
- Keep `.env` files, local databases, credentials, phone numbers, and any
  non-demo workspace out of Git.
