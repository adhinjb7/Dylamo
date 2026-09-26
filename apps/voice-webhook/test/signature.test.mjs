import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectedTwilioSignature, validateTwilioSignature } from '../src/signature.mjs';

// Published Twilio example: https://www.twilio.com/docs/usage/security
test('matches Twilio published form-webhook signature example', () => {
  const url = 'https://example.com/myapp.php?foo=1&bar=2';
  const params = {
    Digits: '1234',
    To: '+18005551212',
    From: '+14158675310',
    Caller: '+14158675310',
    CallSid: 'CA1234567890ABCDE',
  };
  const signature = 'L/OH5YylLD5NRKLltdqwSvS0BnU=';
  assert.equal(expectedTwilioSignature('12345', url, params), signature);
  assert.equal(validateTwilioSignature('12345', signature, url, params), true);
  assert.equal(validateTwilioSignature('wrong', signature, url, params), false);
});
