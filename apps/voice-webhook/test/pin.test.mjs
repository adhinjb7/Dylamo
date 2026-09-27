import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPin, isValidPinHash, verifyPin, pinFromInput } from '../src/pin.mjs';

test('scrypt PIN hash verifies only the exact four digits', () => {
  const hash = hashPin('1234', Buffer.alloc(16, 2));
  assert.equal(isValidPinHash(hash), true);
  assert.equal(verifyPin('1234', hash), true);
  assert.equal(verifyPin('1235', hash), false);
  assert.equal(verifyPin('12345', hash), false);
  assert.equal(verifyPin('abcd', hash), false);
});

test('PIN entry accepts keypad or exactly four spoken digits without guessing', () => {
  assert.equal(pinFromInput({ Digits: '0123' }), '0123');
  for (const SpeechResult of ['0123', '0 1 2 3', 'zero one two three', 'Oh, one, two, three.', 'zero-one-two-three', '0 one 23']) {
    assert.equal(pinFromInput({ SpeechResult }), '0123', SpeechResult);
  }
  for (const SpeechResult of ['', 'one two three', 'one two three four five', 'my code is 0123',
    'zero one to three', 'double zero one two', 'twelve thirty four', '0123 or 4567', '0/1/2/3']) {
    assert.equal(pinFromInput({ SpeechResult }), '', SpeechResult);
  }
  assert.equal(pinFromInput({ Digits: '0123', SpeechResult: '0123' }), '', 'ambiguous mixed input is refused');
  assert.equal(pinFromInput({ Digits: 'bad', SpeechResult: '0123' }), '');
});
