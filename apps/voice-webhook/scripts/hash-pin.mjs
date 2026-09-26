import readline from 'node:readline';
import { hashPin, isValidPinHash, verifyPin } from '../src/pin.mjs';

const checkMode = process.argv.includes('--check');
if (checkMode && !isValidPinHash(process.env.DEMO_PIN_HASH)) {
  console.error('DEMO_PIN_HASH is not configured. Run with --env-file=apps/voice-webhook/.env.');
  process.exit(1);
}

if (!process.stdin.isTTY || !process.stdin.setRawMode) {
  console.error('Run this script in an interactive terminal.');
  process.exit(1);
}

let pin = '';
let extraDigits = 0;
process.stdout.write(`${checkMode ? 'Enter your intended PIN' : 'Choose a four-digit PIN'} (input hidden): `);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (input) => {
  for (const key of input) {
    if (key === '\u0003') {
      process.stdout.write('\n');
      process.exit(130);
    }
    if (key === '\r' || key === '\n') {
      process.stdin.setRawMode(false);
      process.stdout.write('\n');
      if (!/^\d{4}$/.test(pin) || extraDigits > 0) {
        console.error('PIN must contain exactly four digits.');
        process.exit(1);
      }
      if (checkMode) {
        const matches = verifyPin(pin, process.env.DEMO_PIN_HASH);
        console.log(matches ? 'PIN matches the configured hash.' : 'PIN does not match the configured hash.');
        pin = '';
        process.exit(matches ? 0 : 2);
      }
      console.log(hashPin(pin));
      pin = '';
      process.exit(0);
    }
    if (key === '\u007f' || key === '\b') {
      if (extraDigits > 0) extraDigits -= 1;
      else pin = pin.slice(0, -1);
    } else if (/^\d$/.test(key)) {
      if (pin.length < 4) pin += key;
      else extraDigits += 1;
    }
  }
});
