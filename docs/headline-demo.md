# Local headline release demo

This is the reliable **prepared-change** demo, not an autonomous edit. A fresh
disposable Git repository contains two commits: a baseline page headed “Dylamo
demo site,” then a clean prepared commit headed “Hello, Hack Atlantic!” The
local preview shows the baseline until the separate bare remote gains the exact
`phone-demo` branch. It does not deploy to GitHub or a public website.

## Prepare and preview

In a normal PowerShell terminal at the Dylamo repository root, run:

```powershell
node apps/daemon/scripts/headline-demo.mjs --serve
```

Keep that terminal open and open `http://127.0.0.1:4173/`. It should say
“Dylamo demo site” and “Before local approval.” The script prints the new
disposable `CODEX_WORKSPACE` and `GIT_CONFIG_GLOBAL` paths. It makes no Codex
turn, phone call or push. Use `--prepare` instead if you only want to inspect
the fixture without starting the preview.

For a repeat after a successful push, stop only the old preview terminal with
Ctrl+C before running this command again. It creates a new fixture; it does
not reset or delete the old one. Update the two private paths below to match.

In the **ignored, private** daemon `.env`, set `CODEX_WORKSPACE` and
`GIT_CONFIG_GLOBAL` to the paths just printed. For this one named action,
keep `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`,
`CODEX_APPROVAL_COMMAND=git push origin HEAD:refs/heads/phone-demo`, and
`CODEX_ALLOW_WORKSPACE_WRITE=false`. Do not replace the Dylamo GitHub remote
with this local fixture. Keep credentials private and do not commit `.env`.

The voice `.env` needs its existing real Codex/approval settings, including
`AGENT_MODE=codex` and `CODEX_APPROVAL_ENABLED=true`. After installing the short
approval prompts, run `npm run build:protocol` and restart **both** the voice
server and daemon (new action-description metadata crosses that connection).
There are no new environment flags or database columns. Keep ngrok running.
Restart the relevant server after any `.env` change. Before calling, run
these from another normal PowerShell terminal:

```powershell
node --env-file=apps/daemon/.env apps/daemon/scripts/check-demo-push.mjs
node --env-file=apps/voice-webhook/.env --env-file=apps/daemon/.env apps/daemon/scripts/observe-phone-approval.mjs --check
```

Both must pass. Then start the watcher with the same command ending in
`--watch` and leave it open **before** the call.

## Callback-first presentation

This one flow demonstrates delegation, work continuing after hangup, a real
callback, human approval and a visible local release. No second editing flow
is needed for the one-minute presentation.

1. Show the baseline preview. Call, say your PIN digits and ask “Run the demo
   push.” Wait for the acknowledgment that the task started, then hang up.
2. The watcher must report the exact request held pending while the local
   destination is still empty. The website must still show the baseline.
3. Answer the callback: “Dylamo calling. Say your four PIN digits, or enter
   them.” Speak the PIN. No action details are disclosed before authentication.
4. Hear: “Ready to publish the prepared changes to the local demo branch.
   Nothing goes to GitHub. Press 1 to approve once, 2 to reject, or 3 for details.”
   Press **1** if that matches your request; **2** rejects. The long command and
   temporary Windows path are available on **3**, not read by default.
5. Hear the short result, require the watcher's verified-ref PASS and refresh
   the preview. Explain that this is a local release of a prepared change,
   not a GitHub deployment or autonomous editing.

For a strict one-minute slot, start the task shortly before presenting and
say plainly that it is already running. Do not approve before the demonstration
or imply the earlier request was made on stage. The callback timing still
depends on Codex, the tunnel and the carrier; shorter narration is not a
one-minute completion guarantee. Approval expires after five minutes. Keep
a clearly labeled recording as backup; do not claim a failed live run worked.

## Same-call option

1. Show the preview's old heading. Call the number and authenticate once by
   typing the four-digit PIN **or saying each digit separately**.
2. Say “Run the demo push.” The task starts directly, without a read-back,
   second “yes” or keypad confirmation. Do not hang up before it has started.
3. Stay on the call. Wait for the held protected-action message. The watcher
   must show the pending real Codex request and an empty `phone-demo` ref.
4. Listen to the short explanation of the action's effect and destination.
   Say **“approve”** or press **1** to allow it once. If it sounds wrong, say
   **“reject”** or press **2**. Say **“details”** or press **3** for the exact
   command and directory; **“repeat”** repeats the short summary. There is no
   second PIN or callback while you remain on this authenticated call.
5. Require the watcher to confirm the same-call PIN-authenticated decision, completed task and
   local destination ref equal to the held source HEAD. Refresh the preview;
   only now should it say “Hello, Hack Atlantic!” and “Published to local
   phone-demo branch.”

The MVP has no task-confirmation step. New requests
and follow-up questions start directly; greetings and standalone “yes” replies
do not become tasks or authorize a push. PIN authentication proves who is
calling; it is not blanket permission for every protected action. The decision
applies only to the exact currently held action. An optional task
read-back mode is deferred until after the MVP/demo.

If you need to leave, hang up after the task starts. A pending protected action
still triggers one callback. Because that is a **different call**, authenticate
again (spoken or keypad PIN), then listen and press **1** or **2**; **3** requests
the details. The watcher verifies this callback path too. No answer, failed PIN
or expired approval leaves the action blocked. Hanging up after a same-call
decision does not trigger another approval callback.

Say PIN digits in English, including leading zeros, with no extra sentence.
Both input methods share the existing three-attempt lockout. Spoken PINs are
processed by Twilio's speech-recognition service, not sent to Codex; the app
does not echo or persist the raw PIN. Keypad input remains available when
speaking a PIN aloud is inappropriate. See [Twilio Gather](https://www.twilio.com/docs/voice/twiml/gather).

After installing a voice-server code change, hang up and restart that server
with its normal command; it does not reload source files automatically. Keep
the daemon, ngrok and preview running. Restart the watcher before retrying if
it has timed out.

If the watcher fails, the callback does not arrive, or the preview reports a
changed fixture, stop and inspect the state. Do not approve blindly or retry
against the same branch. A fresh demo run needs a fresh fixture because the
`phone-demo` destination must initially be absent.

Current evidence: both the earlier callback-approved push and the later
same-call approved push have completed real-runtime records and matching
local refs. The latter decision was recorded at 05:47 UTC on 27 September,
on the original authenticated call, with no callback attempt. The caller
confirmed using a spoken PIN. These are saved-state checks plus the caller's
report, not a claim that this agent heard the call or observed a live watcher
PASS. The newly shortened narration still needs a fresh phone rehearsal.
An empty-ref preflight cannot pass on a published fixture; create a fresh one.

The short local-push description is a fixed template, enabled only by the
daemon after its local destination and source checks. It is bound into the
same action digest and persisted in the existing approval audit. Unknown or
older actions, or requests with extra permission grants, retain the full
command/permission disclosure instead of receiving a guessed summary. Fake
mode explicitly says no files will change. Approval, expiry, rejection and
Git verification rules are unchanged. The brief success sentence is emitted
only after the daemon checks the destination ref, not merely a model's claim.

Tell judges plainly: the headline change was prepared in advance; Dylamo's
live contribution is running the Codex task independently of the phone call
and requiring exact, one-use phone approval before the local release. The
caller can stay on the line or leave and receive a callback. A real
agent-authored change remains a separate, unverified stretch goal.
