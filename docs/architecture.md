# Control plane boundaries

This repository is moving toward the brief's self-hosted phone-to-agent control plane. The current `apps/voice-webhook` is the working inbound call, PIN, media, and Realtime voice slice; it remains runnable while the server and daemon are split into their own modules.

## Ownership

- **Control server:** validates Twilio requests, authenticates callers, owns call/session/task/approval state, routes normalized text and events, and initiates callbacks. It must not import Codex-specific code or expose daemon credentials in call audio.
- **Local daemon:** opens an outbound authenticated WSS connection to the control server, supervises the local agent process, retains tasks after a call ends, and enforces exact pending approvals at the tool boundary. Its management API will bind to loopback only.
- **Agent adapter:** maps one runtime (Codex first, deterministic fake first for tests) into normalized progress, message, completion, failure, human-needed, and approval events. It owns runtime thread/turn identifiers.
- **Voice provider:** maps call audio to speech/transcript events and spoken responses. OpenAI Realtime is the first implementation; it has no direct access to the local daemon or tools.
- **Shared protocol:** `packages/protocol` owns versioned, runtime-validated server/daemon messages, typed IDs, and allowed lifecycle transitions. Neither side should create an ad-hoc wire format.

## Message rules

Every server/daemon event has protocol version `1`, a unique `eventId`, and a `machineId`. Run-scoped events additionally carry `sessionId`, `taskId`, and `runId`. Provider call and stream SIDs are different from internal UUIDs. The daemon authenticates in the WSS handshake with a revocable per-machine token; the token is never an event field. The receiver must persist processed event IDs before side effects so reconnect and retry cannot repeat a protected action. `approval.response` identifies the same approval, run, and SHA-256 action digest as the pending request; validating its schema alone does not grant permission.

## Lifecycle invariants

- A call can end while its task remains running.
- Tasks cannot jump from `queued` straight to `completed`, and terminal states cannot resume.
- Approvals leave `pending` at most once; expired, rejected, or already approved requests never become executable again.
- Machine disconnect marks it offline but does not invent a task result. Reconciliation uses event and run IDs.

The schemas and transition helpers are the P0.1 contract. P0.4 adds the authenticated outbound daemon transport, registration, heartbeats, reconnect, and event routing. P0.5 adds a server-owned SQLite store for users, machines, sessions, calls, tasks, runs, approvals, processed event IDs, audit events, and PIN failures. P0.6 connects a transcribed phone request to a durable task and a deterministic fake agent over that transport. The fake emits progress, a message, and completion; its timer continues after hangup, and unsent events queue in daemon memory until reconnect. Server-side event deduplication and task transitions occur in one transaction before any spoken response. Protected actions remain disabled until the real Codex execution boundary exists.

P0.7 adds an opt-in fake protected-action scenario. The daemon reports `approval.required` with a SHA-256 digest of the simulated command and working directory, then pauses. The server persists the exact approval and transitions task/run to `waiting_human`. After the original call ends, it places an outbound Twilio callback to the allowlisted number; signed callback webhooks require the expected Twilio source and destination, a bound callback SID and nonce, the PIN, and a one-digit approval decision. The server records that decision once and sends `approval.response` with the same approval, run, and digest. The daemon checks all identifiers and expiry before simulating continuation. Rejection never resumes the action. There is no shell or Codex execution in this path.
