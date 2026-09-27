import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const PIN_PATTERN = /^\d{4}$/;
const SPOKEN_DIGITS = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9' };

// Parse only digit-by-digit speech, never infer a PIN from surrounding prose.
// This runs before the agent/media session and must never log or echo input.
export function pinFromInput({ Digits, SpeechResult } = {}) {
  const digitsPresent = typeof Digits === 'string' && Digits.length > 0;
  const speechPresent = typeof SpeechResult === 'string' && SpeechResult.trim().length > 0;
  if (digitsPresent) return !speechPresent && PIN_PATTERN.test(Digits) ? Digits : '';
  if (!speechPresent || SpeechResult.length > 80) return '';
  const words = SpeechResult.trim().toLowerCase().replace(/[.!?]+$/, '').split(/[\s,\-]+/);
  const digits = words.map(word => /^\d{1,4}$/.test(word) ? word : (SPOKEN_DIGITS[word] ?? '')).join('');
  if (words.some(word => !/^\d{1,4}$/.test(word) && !Object.hasOwn(SPOKEN_DIGITS, word))) return '';
  return PIN_PATTERN.test(digits) ? digits : '';
}

export function hashPin(pin, salt = randomBytes(16)) {
  if (!PIN_PATTERN.test(pin)) throw new Error('PIN must contain exactly four digits');
  const saltBytes = Buffer.isBuffer(salt) ? salt : Buffer.from(salt, 'base64');
  if (saltBytes.length !== 16) throw new Error('PIN salt must be 16 bytes');
  const digest = scryptSync(pin, saltBytes, 32);
  return `scrypt:${saltBytes.toString('base64')}:${digest.toString('base64')}`;
}

export function isValidPinHash(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  return Buffer.from(parts[1], 'base64').length === 16 && Buffer.from(parts[2], 'base64').length === 32;
}

export function verifyPin(pin, pinHash) {
  if (!PIN_PATTERN.test(pin) || !isValidPinHash(pinHash)) return false;
  const [, salt, encodedDigest] = pinHash.split(':');
  const expected = Buffer.from(encodedDigest, 'base64');
  const received = scryptSync(pin, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(expected, received);
}
