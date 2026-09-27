# Secondary synthetic-monitor phone alert demo

This bounded second demo simulates a local checkout outage. The daemon forwards one signed incident, and the voice webhook places one short operator call; the monitor page neither checks internet sites nor sends SMS.

## Enable it

Add these non-secret settings to the ignored private .env files:

~~~ini
# apps/daemon/.env
SITE_MONITOR_DEMO_ENABLED=true
SITE_MONITOR_DEMO_PORT=4174

# apps/voice-webhook/.env
SITE_MONITOR_DEMO_ENABLED=true
# Same DAEMON_MACHINE_ID as apps/daemon/.env.
SITE_MONITOR_MACHINE_ID=replace-with-the-paired-daemon-uuid
~~~

The phone-demo configuration must already provide the Twilio number, allowed caller, public URL, daemon credentials, and public HTTPS tunnel. No SMS setup is required.

After rebuilding the protocol, restart the webhook and daemon. Keep the public HTTPS tunnel running:

~~~sh
npm run build:protocol
node --env-file=apps/voice-webhook/.env apps/voice-webhook/src/server.mjs
node --env-file=apps/daemon/.env apps/daemon/src/server.mjs
~~~

After the daemon reports that it is online and listening on port 4174, open http://127.0.0.1:4174/. The monitor page binds locally and does not inspect external sites.

## One-minute presentation flow

1. Show the healthy page and explain that the checkout monitor is local and repeatable.
2. Click **Simulate checkout failure**. The panel turns red and requests an alert.
3. Answer the call. It reports a degraded local checkout and offers a text report.
4. Say **no** or press **2**. It confirms that no text was sent; show the red dashboard and explain that SMS is disabled.
5. Optionally click **Restore checkout** to close the local incident.

Alert calls only notify. They cannot approve commands, alter repositories, or grant permissions; signed Twilio traffic is limited to the configured caller and number.

## Repeat safely

Restore the checkout to green, then simulate another failure. One incident per outage and one recovery after restoration prevent alert spam from refreshes or repeated clicks.
