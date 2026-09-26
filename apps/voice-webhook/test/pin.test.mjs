import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPin, isValidPinHash, verifyPin } from '../src/pin.mjs';

test('scrypt PIN hash verifies only the exact four digits', () => {
  const hash = hashPin('1234', Buffer.alloc(16, 2));
  assert.equal(isValidPinHash(hash), true);
  assert.equal(verifyPin('1234', hash), true);
  assert.equal(verifyPin('1235', hash), false);
  assert.equal(verifyPin('12345', hash), false);
  assert.equal(verifyPin('abcd', hash), false);
});
