# Secondary synthetic-monitor phone alert demo

This is a deliberately bounded second demo. A **local-only synthetic checkout
monitor** detects a simulated outage, forwards one signed incident through the
paired daemon, and requests one short notification call to the configured
operator. It is not production internet monitoring and it does not send SMS.

## Enable it

In the ignored private `.env` files, add these non-secret settings:

```ini
# apps/daemon/.env
SITE_MONITOR_DEMO_ENABLED=true
SITE_MONITOR_DEMO_PORT=4174

# apps/voice-webhook/.env
SITE_MONITOR_DEMO_ENABLED=true
# Copy the non-secret DAEMON_MACHINE_ID value from apps/daemon/.env.
SITE_MONITOR_MACHINE_ID=replace-with-the-paired-daemon-uuid
```

`TWILIO_PHONE_NUMBER`, `ALLOWED_CALLER_NUMBER`, `PUBLIC_BASE_URL`, the daemon
credentials and the public HTTPS tunnel must already be configured for the
phone demo. No SMS credentials or messaging service is needed because the
demo never attempts to send a text.

After rebuilding the protocol, restart the voice webhook and daemon. Keep
ngrok running for the existing public HTTPS webhook URL:

```powershell
npm run build:protocol
node --env-file=apps/voice-webhook/.env apps/voice-webhook/src/server.mjs
node --env-file=apps/daemon/.env apps/daemon/src/server.mjs
```

When the daemon prints both `Daemon connection: online` and `Synthetic site
monitor demo listening on http://127.0.0.1:4174`, open that local URL. The page
cannot bind to a public interface and makes no external site requests.

## One-minute presentation flow

1. Say: “This is a local synthetic checkout monitor, so the failure is safe
   and repeatable.” Show that the page is healthy.
2. Click **Simulate checkout failure**. The panel turns red and shows that the
   incident was detected and an alert was requested. The phone call—not the
   dashboard—is the proof that delivery succeeded.
3. Answer the call. The notification briefly says that the local checkout is
   degraded and returning errors, then offers a detailed report by text.
4. Say **no** or press **2**. It confirms that no text was sent and directs
   the viewer back to the local dashboard.
5. Show the red dashboard and say: “SMS delivery is intentionally not enabled
   for this one-day prototype; Dylamo records the request but never pretends a
   text was sent.”
6. Optionally click **Restore checkout** to visibly close the local incident.

The alert call is notification-only. It is separate from the protected local
push flow: it cannot approve a command, alter a repository, or grant any
permission. The voice webhook validates signed Twilio traffic and restricts the
flow to the configured caller and Twilio number.

## Repeat safely

Click **Restore checkout**, wait for the green healthy state, then click
**Simulate checkout failure** again. The monitor emits only one incident while
an outage persists and one recovery after restoration, so repeated refreshes or
button clicks do not create alert spam.
