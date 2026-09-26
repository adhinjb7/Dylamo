import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const PIN_PATTERN = /^\d{4}$/;

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
