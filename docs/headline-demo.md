# Protected local-release demo

This is the primary Dylamo demo. It proves that a task can continue after a
caller hangs up, a real callback can return the human to the loop, and one
exact protected action needs a one-use phone approval.

It is intentionally a **prepared-change** demo. Codex requests a local push of
a prepared commit to a fresh disposable bare repository. It does not edit the
Dylamo project, push to GitHub, or deploy a public website.

## What the audience sees

1. A local preview starts navy and says **Dylamo demo site**.
2. The caller asks Dylamo to “Run the demo push” (or “Push the demo repo”), then hangs up.
3. Dylamo calls back, authenticates the caller again, and briefly explains the
   effect: publish prepared changes to the **local demo branch** only.
4. The caller approves once. The preview turns green and says **Hello, Hack
   Atlantic!**

## First rehearsal: prepare safely

Run these commands in a normal PowerShell terminal from the repository root:

```powershell
npm run build:protocol
node apps/daemon/scripts/headline-demo.mjs --serve
```

Keep the preview terminal open and visit `http://127.0.0.1:4173/`. It should
show the navy baseline. The script prints a fresh disposable `CODEX_WORKSPACE`
and `GIT_CONFIG_GLOBAL` path. Put only those two printed paths in the private
`apps/daemon/.env`. The daemon pins the other isolation settings itself.

For the named demo action, the daemon `.env` must also keep these values:

```ini
CODEX_APPROVAL_COMMAND=git push origin HEAD:refs/heads/phone-demo
CODEX_ALLOW_WORKSPACE_WRITE=false
```

Do **not** point the Dylamo GitHub remote at this fixture. The fixture's
`origin` is a sibling local bare repository created in a temporary folder.

The private voice `.env` needs the already-working live configuration:
`VOICE_MODE=realtime`, `AGENT_MODE=codex`, `CODEX_APPROVAL_ENABLED=true`, a
Twilio number, your allowlisted caller number, and a configured PIN. Keep ngrok
running. Restart the daemon and voice webhook after changing either `.env` or
after rebuilding the protocol.

Before any call, run:

```powershell
node --env-file=apps/daemon/.env apps/daemon/scripts/check-demo-push.mjs
node --env-file=apps/voice-webhook/.env --env-file=apps/daemon/.env apps/daemon/scripts/observe-phone-approval.mjs --check
```

Both must print `PASS`. These checks do not start a model turn, place a phone
call, or push anything.

## Low-risk Codex rehearsal

Before a live phone test, run this exact reject rehearsal:

```powershell
node --env-file=apps/daemon/.env apps/daemon/scripts/rehearse-approval.mjs --run --decision=reject
```

It uses one short Codex turn but never calls a phone, touches GitHub, or pushes
the local branch. It verifies that the exact command is held and remains blocked
after rejection. It can take up to two minutes.

## Full callback trial

Start and leave open these four things:

1. The preview created with `headline-demo.mjs --serve`.
2. The voice webhook:

   ```powershell
   node --env-file=apps/voice-webhook/.env apps/voice-webhook/src/server.mjs
   ```

3. The paired daemon:

   ```powershell
   node --env-file=apps/daemon/.env apps/daemon/src/server.mjs
   ```

4. ngrok forwarding port 3000, plus this watcher in another terminal:

   ```powershell
   node --env-file=apps/voice-webhook/.env --env-file=apps/daemon/.env apps/daemon/scripts/observe-phone-approval.mjs --watch
   ```

Then call from the allowlisted phone, enter or say the PIN, and say exactly:
**“Run the demo push.”** **“Push the demo repo”** is an equivalent supported
phrase. Wait until Dylamo confirms the task started, then hang up. Answer the
callback, authenticate again, and say **“approve”** or **“push the demo repo”**
to approve once. Say **“reject”** to decline or **“details”** to hear the exact
command. Keypad **1**, **2**, and **3** remain optional fallbacks.

Treat the demo as successful only when the watcher reports a final `PASS` and
the preview turns green. If the watcher has not first shown the held action,
do not approve.

## Reset for another trial

A successful fixture cannot be reused because its `phone-demo` branch is no
longer empty. Press Ctrl+C only in the old preview terminal, run
`headline-demo.mjs --serve` again, replace the two printed daemon fixture paths,
restart the daemon, and repeat the two preflight checks. Leave old temporary
fixtures alone for inspection; never reset or clean the Dylamo repository.

## Optional same-call variation

Stay on the original authenticated call instead of hanging up. Once the held
action is announced, say **“approve”** or press **1**. This skips the callback;
the one-use decision is still tied to that exact action. The callback-first flow
is the stronger presentation because it visibly demonstrates work continuing
without the caller.

## Timing and honest limits

Allow 3–5 minutes for local setup, up to 2 minutes for the reject rehearsal,
and 5–10 minutes for a first live callback trial. Carrier, tunnel, and Codex
latency mean it is not guaranteed to complete inside one minute. For judges,
start the task shortly before presenting and keep a clearly labeled fallback
ready. The live contribution is protected continuation and approval—not an
autonomous code change or a GitHub deployment.
