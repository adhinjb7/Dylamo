# Protected local-release demo

This primary demo shows a task continuing after the caller hangs up, a callback returning the caller to the loop, and a one-use approval for one exact action. It pushes a prepared commit only to a fresh disposable local bare repository; it never changes Dylamo, GitHub, or a public site.

## Audience flow

1. The local preview starts navy and says **Dylamo demo site**.
2. The caller says **Run the demo push**, receives task-start confirmation, and hangs up.
3. Dylamo calls back, reauthenticates the caller, and requests approval to publish prepared changes to the local demo branch.
4. After one approval, the preview turns green and says **Hello, Hack Atlantic!**

## Prepare the fixture

From the repository root:

~~~sh
npm run build:protocol
node apps/daemon/scripts/headline-demo.mjs --serve
~~~

Keep the preview open at http://127.0.0.1:4173/ and confirm the navy baseline. Copy only the printed CODEX_WORKSPACE and GIT_CONFIG_GLOBAL paths into the private **apps/daemon/.env**; the daemon sets the remaining isolation values.

Keep these daemon settings:

~~~ini
CODEX_APPROVAL_COMMAND=git push origin HEAD:refs/heads/phone-demo
CODEX_ALLOW_WORKSPACE_WRITE=false
~~~

The fixture origin is a sibling local bare repository in a temporary folder. Do not point the Dylamo GitHub remote at it.

On this Mac, set CODEX_ALLOW_FULL_READ=true only with the machine owner’s consent. It enables the required workspace reads while writes and network access remain restricted.

The private voice .env needs the working live configuration: VOICE_MODE=realtime, AGENT_MODE=codex, CODEX_APPROVAL_ENABLED=true, OPENAI_API_KEY, DAEMON_CREDENTIALS, a Twilio number, an allowlisted caller, and a PIN. Keep a public HTTPS tunnel to port 3000 running. Restart the daemon and webhook after changing either .env file or rebuilding the protocol.

Before calling, run:

~~~sh
node --env-file=apps/daemon/.env apps/daemon/scripts/check-demo-push.mjs
node --env-file=apps/voice-webhook/.env --env-file=apps/daemon/.env apps/daemon/scripts/observe-phone-approval.mjs --check
~~~

Both must print PASS; neither starts Codex, calls a phone, nor pushes.

## Rehearse rejection

Before a live call, run:

~~~sh
node --env-file=apps/daemon/.env apps/daemon/scripts/rehearse-approval.mjs --run --decision=reject
~~~

It uses one short Codex turn and confirms the exact command remains blocked after rejection. It never calls a phone, accesses GitHub, or pushes. Allow up to two minutes.

## Run the callback trial

Keep the preview, webhook, daemon, public HTTPS tunnel, and watcher running:

1. Preview: headline-demo.mjs --serve.
2. Webhook:

   ~~~sh
   node --env-file=apps/voice-webhook/.env apps/voice-webhook/src/server.mjs
   ~~~

3. Daemon:

   ~~~sh
   node --env-file=apps/daemon/.env apps/daemon/src/server.mjs
   ~~~

4. Watcher:

   ~~~sh
   node --env-file=apps/voice-webhook/.env --env-file=apps/daemon/.env apps/daemon/scripts/observe-phone-approval.mjs --watch
   ~~~

Call from the allowlisted phone, authenticate, and say **Run the demo push**. After task-start confirmation, hang up. On callback, authenticate and say **approve** or **push the demo repo**. Say **reject** to decline or **details** to hear the command; keys 1–3 are fallbacks.

Success requires a final watcher PASS and a green preview. Do not approve unless the watcher showed the held action.

## Reset

A successful fixture cannot be reused because its phone-demo branch is no longer empty. Stop only the old preview, run headline-demo.mjs --serve again, replace the two printed fixture paths, restart the daemon, and repeat the preflight checks. Leave old temporary fixtures for inspection; never reset or clean the Dylamo repository.

## Same-call option

Stay on the original authenticated call and approve when the held action is announced. The decision remains tied to that exact action. Use the callback flow in the presentation to show work continuing after hang-up.

## Timing and limits

Allow 3–5 minutes for setup, up to 2 minutes for rehearsal, and 5–10 minutes for a first callback trial. Carrier, tunnel, and Codex latency can exceed one minute, so start early and label a fallback. The demo proves protected continuation and approval, not autonomous edits or a GitHub deployment.
