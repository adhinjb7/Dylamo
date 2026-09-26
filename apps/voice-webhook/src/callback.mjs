const E164 = /^\+[1-9]\d{7,14}$/;

export async function createTwilioCallback({ accountSid, authToken, from, to, url, fetchImpl = fetch }) {
  if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid) || !authToken || !E164.test(from) || !E164.test(to)) {
    throw new Error('invalid Twilio callback configuration');
  }
  const target = new URL(url);
  if (target.protocol !== 'https:') throw new Error('callback webhook must use HTTPS');
  const response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ From: from, To: to, Url: target.toString(), Method: 'POST' }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Twilio callback creation failed (HTTP ${response.status})`);
  const result = await response.json();
  if (!/^CA[0-9a-fA-F]{32}$/.test(result.sid ?? '')) throw new Error('Twilio callback response did not contain a call SID');
  return result.sid;
}
