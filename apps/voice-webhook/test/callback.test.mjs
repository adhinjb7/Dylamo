import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTwilioCallback } from '../src/callback.mjs';

test('callback creator sends signed-account POST and checks returned SID', async () => {
  const accountSid = `AC${'a'.repeat(32)}`;
  const authToken = 'test-secret';
  const callSid = `CA${'b'.repeat(32)}`;
  const received = [];
  const result = await createTwilioCallback({
    accountSid, authToken, from: '+15065550111', to: '+15065550222',
    url: 'https://example.ngrok.app/approval/voice?approvalId=123&nonce=456',
    statusUrl: 'https://example.ngrok.app/approval/status?approvalId=123&nonce=456',
    fetchImpl: async (url, options) => {
      received.push({ url, options });
      return { ok: true, json: async () => ({ sid: callSid }) };
    },
  });
  assert.equal(result, callSid);
  assert.match(received[0].url, /Calls\.json$/);
  assert.equal(received[0].options.method, 'POST');
  assert.equal(new URLSearchParams(received[0].options.body).get('To'), '+15065550222');
  assert.equal(new URLSearchParams(received[0].options.body).get('Method'), 'POST');
  const form = new URLSearchParams(received[0].options.body);
  assert.equal(form.get('StatusCallback'), 'https://example.ngrok.app/approval/status?approvalId=123&nonce=456');
  assert.equal(form.get('StatusCallbackMethod'), 'POST');
  assert.equal(form.get('StatusCallbackEvent'), 'completed');
  assert.equal(form.get('Timeout'), '20');
  assert.equal(form.has('Record'), false);
  assert.equal(form.has('MachineDetection'), false, 'do not silently add a paid AMD service');
  assert.equal(received[0].options.headers.Authorization, `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`);
});

test('callback status destination must remain on the configured HTTPS origin', async () => {
  for (const statusUrl of ['http://example.ngrok.app/status', 'https://other.example/status']) {
    await assert.rejects(createTwilioCallback({ accountSid: `AC${'a'.repeat(32)}`, authToken: 'test-secret',
      from: '+15065550111', to: '+15065550222', url: 'https://example.ngrok.app/approval/voice', statusUrl,
      fetchImpl() { throw new Error('must not send'); },
    }), /same HTTPS origin/);
  }
});
