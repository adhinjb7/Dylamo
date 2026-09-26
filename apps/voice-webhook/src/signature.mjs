import { createHmac, timingSafeEqual } from 'node:crypto';

// Twilio's form-webhook algorithm: full URL, then case-sensitive sorted form
// parameter names and values, signed with the account auth token.
export function expectedTwilioSignature(authToken, webhookUrl, params) {
  const signedText = Object.keys(params)
    .sort()
    .reduce((text, key) => text + key + params[key], webhookUrl);
  return createHmac('sha1', authToken).update(signedText, 'utf8').digest('base64');
}

export function validateTwilioSignature(authToken, signature, webhookUrl, params) {
  const expected = Buffer.from(expectedTwilioSignature(authToken, webhookUrl, params));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
