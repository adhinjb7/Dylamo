# P0 readiness — 26 September 2026

This is an evidence checklist against `Hack_Atlantic_Agent_Telephony_Codex_Brief_Revised.docx`, not a claim that all P0 milestones are finished. Reported phone tests and automated protocol fixtures are deliberately distinguished. A fixture using the production adapter is still not a real Codex runtime test.

## Where we are

| Brief milestone | Implemented / demonstrated | Remaining evidence or work |
| --- | --- | --- |
| P0.0 — provider preflight | User confirmed inbound audio, spoken replies, outbound callback and a real Codex repository answer. Signed HTTP and WebSocket paths have automated coverage. | Repeat the combined live flow on the demo laptop after these changes. |
| P0.1 — shared contract | Monorepo, versioned Zod events, IDs and lifecycle transition tests. | Keep the additive approval/ACK/reconciliation fields compatible with teammate consumers. |
| P0.2 — phone authentication | Caller allowlist, signed requests, PIN hashing, three-attempt lockout, callback PIN and caller/SID binding. | Live negative-path rehearsal. No action details are spoken before callback PIN verification. |
| P0.3 — live media | Bidirectional PCMU, transcriptions, queued replies. New controlled barge-in clears playback, cancels only the voice response and drops late audio. | Hear the interruption behavior on a real call; unit tests alone cannot establish audio quality. |
| P0.4 — daemon connection | Authenticated outbound WSS, registration, heartbeat, reconnect, agent routing. New event ACK/replay and active-run reconciliation. | Rehearse a daemon/server connection drop during a real task. Multiple eligible machines now fail closed instead of silently choosing the first. |
| P0.5 — durable state | SQLite sessions, calls, runs, tasks, approvals, audit and deduplication. Schema v3 adds final result text and approval permission scope. Outbound attempts and signed terminal call outcomes now persist. | Verify restart behavior on the demo laptop. A dead daemon process makes its lost runs uncertain/failed, not successfully resumed. |
| P0.6 — task survives hangup | Deterministic fake task and production adapter run lifetime are independent of the call. Fake path previously phone-tested. | Real hangup-plus-result evidence is part of P0.9. |
| P0.7 — simulated approval | User confirmed callback and DTMF approval. Automated approve/reject, authentication and one-shot binding tests. Callback failure, busy, no-answer, canceled, no-PIN and expiry fixtures keep the real adapter request blocked. | Rehearse no-answer/voicemail and expired callbacks live; neither should approve. No answering-machine detection service is enabled; a voicemail simply cannot pass PIN authentication. |
| P0.8 — real Codex adapter | Real read-only repository answers and same-call follow-ups reported working. Runtime thread/turn IDs persist. Operator-run real Codex reject, expire and approve rehearsals now pass, including verified local Git refs. | Exercise the same runtime bridge through the phone path. |
| P0.9 — real protected action after hangup | Approval bridge, callback, persisted decision/result, one-time RPC acceptance and recovery have automated coverage. All three real-runtime local approval rehearsals passed. | **Not complete:** the real phone → hangup → callback → approve/reject → verified Git ref demo. |

The brief's broader investigate/test/fix/push story is not yet implemented in full: normal Codex turns still use a read-only base sandbox. The bridge admits at most one exact operator-configured command; it is not general permission to edit, commit, deploy, or run arbitrary writes. Do not describe this slice as a complete autonomous coding workflow.

## Latest automated evidence

The full `npm test` suite passed after the callback/recovery, Windows command-preview compatibility, named demo-push shortcut and transcription/read-back changes: 147 tests (8 protocol, 67 voice-webhook, 72 daemon). The tests use local HTTP/WebSockets, an isolated SQLite database and a simulated Codex process; no real phone call, provider API request or real Codex model turn is made. The Git rehearsal tests use a real disposable local Git remote but still simulate the model side.

- Signed `/approval/status` callbacks record terminal outcomes exactly once. They require the configured account, caller/destination, outbound direction, approval nonce and matching call SID. Neither call completion nor a failed callback authorizes an action.
- A terminal webhook arriving before the REST create response cannot be undone by that late response. Invalid nonces/SIDs cannot bind or finish another call.
- Provider attempts are limited to one per approval, with a 20-second ring timeout and no automatic redial of an uncertain result. On reconnect, only an active pending request with **no prior provider attempt** can initiate a missed callback.
- An already-expired approval replay is acknowledged and settles the task as failed instead of causing a perpetual reconnect loop. A lost daemon-owned run expires its pending approvals and is never automatically re-executed.

These checks strengthen the failure paths but do not replace the real-runtime and phone gates below.

## Local real-runtime approval rehearsal — passed

The operator supplied successful real Codex console results for **reject**, **expire**, and **approve** on 26 September. Each run observed a real pending approval with the local remote unchanged. The checker then verified rejection/expiry left the destination absent, and approval created the expected commit in the disposable local bare remote. These are real-runtime results, distinct from the automated tests; they do **not** establish Twilio or phone approval. The instructions and diagnostic history below remain for reproducibility.

The rehearsal creates a fresh disposable source repository and a separate bare Git remote beneath the OS temporary directory, outside HackAtlantic and outside the existing demo repository. It does not change a GitHub remote, publish code, change either private `.env`, or make a phone call. Artifacts are retained for inspection. Global Git config and hooks are excluded from this fixture.

Run from a normal PowerShell terminal at the repository root. The embedded execution sandbox currently fails native Codex startup with a home-directory error; successful unit tests do not remove that limitation.

```powershell
cd C:\Users\ryans\HackAtlantic
npm run build:protocol
node --env-file=apps/daemon/.env apps/daemon/scripts/rehearse-approval.mjs --run --decision=reject
```

`--run` explicitly starts a real Codex model turn and consumes Codex quota. Start with **reject**, then run separately with `--decision=expire` and finally `--decision=approve`. Each invocation uses a new fixture. The approve run intentionally permits one real push to its own local bare remote; it never approves a GitHub push. For a preparation-only check with no model turn, use `--prepare` instead of both run/decision flags.

The checker must observe a real pending approval with the destination ref still absent. It verifies the local Git ref after the decision: reject/expiry must leave it absent; approve must create exactly the fixture's expected commit. An unsupported request, missing approval, mismatch, timeout, failed command or unconfirmed outcome is a failure. A model sentence claiming success is not sufficient. Automated tests of this checker use a simulated Codex actor and do not count as this real-runtime gate.

On Windows, the bridge recognizes a small, explicit set of native Windows PowerShell command previews around the exact configured literal command. It requires the full system shell path derived from the child environment, only `-Command` or `-NoProfile -Command`, and the complete unchanged command body. The observed double-quoted system path with doubled backslashes is also recognized by constructing that exact representation from the trusted path; arbitrary input and command bodies are never unescaped. Additional commands, alternate shells, encoded commands, policy switches and other unrecognized representations remain rejected. The actual runtime command is retained in the approval record and bound into its one-use digest. This is format compatibility, not a substring/prefix check or session-wide permission. Local permission rules, configured tools and managed policy must still be reviewed against the real rehearsal; an inherited rule must not let a protected action run without a request.

The first operator-run reject rehearsal successfully started Codex and read its fixture README, then failed because the bridge rejected an approval request. Its local remote was inspected and contained no branch refs. A subsequent run reported `command-mismatch`, `powershell-wrapper` and `cwdMatches:true`, isolating the current failure to the command representation rather than the workspace. The adapter now recognizes local `file:` working-directory URLs and the constrained PowerShell representations described above. Automated tests cover allowed wrappers, adversarial extra syntax, digest binding, callback decisions and local Git verification. The persisted trace does not include the full approval RPC, so the compatibility fix still needs confirmation against the actual runtime. Retry the reject rehearsal and retain its PASS or diagnostic output before testing expire and approve.

The next operator run still reported the same command mismatch. Rejection diagnostics now include a bounded, redacted quoting template that hides arbitrary command arguments and paths. A no-model inspection was added to examine the known saved rehearsal in the normal PowerShell terminal:

```powershell
node --env-file=apps/daemon/.env apps/daemon/scripts/inspect-codex-command.mjs REHEARSAL_THREAD_UUID
```

Use the UUID of that rehearsal's Codex thread, not its temporary directory name. This diagnostic initializes app-server and calls only `thread/read` on the existing thread. It prints the structural representation of the fixture's harmless README read; no model turn, command execution, approval, push or phone call is requested. A diagnostic `PASS` means history was inspected, **not** that protected-action authorization now works. The saved read can reveal the runtime's serialization, but does not substitute for inspecting a mismatched approval request. Native startup still fails inside this task's execution sandbox with a home-directory lookup error; do not bypass that sandbox to run it here.

The operator's inspection succeeded and reported `"<escaped-system-powershell>" -Command '<configured-command>'`, with `windowsRootKnown:true` and `matchesCurrentWrapper:false`. That shows doubled backslashes inside the double-quoted executable path, which the original matcher omitted. A failing regression test reproduced this reported shape; the constrained matcher now accepts it, preserving the actual runtime string in the one-use digest. Regression coverage also rejects changed commands, extra statements, alternate paths, traversal, further escaping and unsupported shell switches. Windows callback/rehearsal fixtures now exercise the observed representation. Subsequent operator runs passed reject, expire and approve. **Next: the phone callback gate below.**

## After the local gate passes

Current operator setup: a fresh disposable fixture was prepared for the phone test. Its source `origin` points only to its sibling local bare remote, and that remote has no branch refs. The ignored daemon `.env` now selects that fixture and the exact protected push; fixture-specific `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM` and `GIT_TERMINAL_PROMPT` preserve the rehearsal's Git isolation. The ignored voice `.env` now enables real approval callbacks. Credentials were not changed. These settings are effective only after operator restart; no call or push was initiated by this setup. After the demo, remove the temporary approval/Git overrides and restore the prior dedicated workspace; do not repurpose this approval configuration for the Dylamo GitHub remote.

1. Agree on the non-sensitive source repository, destination and branch. The existing external demo repository currently has no remote. Do not use the Dylamo project remote as an accidental test target.
2. Set the exact `CODEX_APPROVAL_COMMAND` in the private daemon `.env`. Set `CODEX_APPROVAL_ENABLED=true` in the private voice `.env`, along with `AGENT_MODE=codex` and the existing `TWILIO_PHONE_NUMBER`. Example-file defaults remain off. For the current operator's disposable phone test, these private settings have now been configured as described above.
3. Restart voice server and daemon after configuration changes. Keep ngrok running. If the daemon already has the shortcut, only the voice server needs restarting for the new transcription/read-back behavior. Make one real authenticated call and say **“Run the demo push.”** as a standalone request. Listen to the full read-back. If correct, say **“Yes, start it”**; otherwise say **“No”** and repeat the request. The daemon then expands the confirmed shortcut to the literal configured command. Wait for the protected-action pause message, then hang up. A progress reminder is not an approval request. The task lifetime is independent of the call only after dispatch; hanging up before transcript confirmation discards the draft without starting Codex.
4. Confirm the task remains active without the call. At the actual tool boundary it must pause. Before approval, verify that the destination ref has not changed.
5. Answer the callback. Before PIN it must disclose no task or action details. Enter the PIN, hear the exact command and working directory, then press **2** for the first live rejection test. Press **3** to repeat details if necessary.
6. Start a fresh task and repeat with **1**. Approval must resume only that pending request, never the session. The callback waits briefly for a persisted result; if it cannot confirm completion it says to inspect the laptop. Independently verify the destination Git ref.
7. Repeat or inject expiry, duplicate decision, invalid PIN, callback no-answer, daemon reconnect, server restart and daemon restart. Record observed outcomes without phone numbers, credentials, raw prompts, recordings, or source contents.

Never infer approval from an incoming caller ID alone, spoken yes, silence, a failed callback or a model response. Lost runtime processes are not automatically restarted to repeat a potentially completed write.

### First phone attempt and the named-action shortcut

The first real phone attempt dispatched a task and continued after hangup, but the transcribed Git command used lowercase `head` and `refs/head` rather than `HEAD` and `refs/heads`. The saved tool request preserved those differences, so the exact-action policy refused it. No approval or callback attempt was created for that run; inspection found the disposable remote still had no refs. This was a task-input mismatch, not evidence of a failed Twilio outbound request.

The standalone shortcut “Run the demo push” now expands on the daemon to the exact `git push origin HEAD:refs/heads/phone-demo` command, only if that is already the operator-configured approval command. It also permits “Please run the demo push” and “Run the demo push please,” ignoring case, whitespace, terminal periods and exclamation marks. It does not substring-match questions, negations or extra instructions, or repair arbitrary dictated commands. Those requests remain unchanged. A missing/different setting fails locally without launching Codex. The original caller transcript remains in the task record; the model receives the expanded task instructions.

The shortcut prepares a request; it does not supply an approval or change the command matcher, workspace binding, runtime IDs, digest, PIN checks, expiry or one-use decision. A completed model turn without a verified approval request is a failure for this shortcut. Unit tests cover strict recognition, unchanged ordinary requests, configuration refusal and continued rejection of mismatched actions. Local integration tests exercise the shortcut through hangup, callback authentication and approve/reject decisions using a simulated Codex process and stubbed provider. **A real phone retry is still required; P0.9 remains incomplete.**

### Subsequent transcription failures and read-back

Two later attempts never matched the shortcut: one saved an unrelated Chinese transcript; the next saved “Randh denopush.” Codex answered those texts rather than requesting the configured command, and neither run created an approval/callback. There is no retained audio to establish whether noise, clipping or language detection caused these recognition failures. Do not attribute the failure to the caller or claim an acoustic fix was proved by text-only tests.

Controlled transcription now supplies `languages: ['en']`, a short English repository-call context and relevant keywords to the same `gpt-transcribe` model. This uses the documented plural `languages` field, not the older singular `language` field. Models, PCMU format and turn detection are unchanged. See [OpenAI transcription context guidance](https://developers.openai.com/api/docs/guides/transcription#improve-transcription-quality). Hints can help but are not a forced output or an authorization mechanism; real phone audio must still be evaluated.

Every new Codex task/follow-up now has a local spoken read-back and a one-use transcript confirmation before task creation. The full unchanged request (up to 600 characters) is repeated; a standalone “Yes, start it” releases that draft. “No” discards it, another request replaces it and must be confirmed, and no draft is dispatched on silence, expiry, transcription failure or hangup. Unconfirmed drafts expire after 60 seconds and stay in memory; the confirmed original text is persisted. Duplicate transcript item IDs are ignored. A spoken confirmation while an action awaits approval cannot authorize it: the callback still needs PIN and DTMF. Unit/integration fixtures cover the observed bad texts, correction, duplicate confirmations, expiry, late post-hangup transcripts and the still-protected callback path. **These are software tests, not evidence that real speech recognition or the live callback is now successful.**

## Isolation and integration notes

Protected-action mode requests a human reviewer, disables apps/plugins and configured MCP servers for the child session, rejects configurations with hooks, and removes known telephony/voice credentials from its inherited environment. These are per-process/session settings, not edits to global Codex config. The base sandbox remains read-only; an accepted command can execute with the permissions of that one runtime approval. Filesystem-wide **reads** remain possible if the operator has explicitly enabled `CODEX_ALLOW_FULL_READ=true`. Use only a clean, non-sensitive demo machine/workspace, and verify effective behavior in the real runtime before enabling live callbacks. Official behavior references: [app-server approvals](https://learn.chatgpt.com/docs/app-server), [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

SQLite upgrades add columns without discarding existing data. Back up the private database before the live upgrade; do not commit it. Old consumers should ignore added nullable columns and new event types. No teammate implementation directories were edited.

Teammate A's dashboard remains independent. Teammate B should finish [the offline harness](team/02-offline-demo-harness.md); [the live preflight](team/02-live-demo-preflight.md) is a separate follow-up. Both remain in the plan, and neither substitutes for the real phone approval test.
