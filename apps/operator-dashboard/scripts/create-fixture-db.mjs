// Writes a fake agent-phone database for trying the dashboard without a live call.
// Usage: node apps/operator-dashboard/scripts/create-fixture-db.mjs <path> [--empty]
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createFixtureDatabase } from '../test/fixtures.mjs';

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith('--'));
if (!target) {
  console.error('Usage: node apps/operator-dashboard/scripts/create-fixture-db.mjs <path> [--empty]');
  process.exit(1);
}
const path = resolve(target);
if (existsSync(path)) {
  console.error(`Refusing to overwrite existing file: ${path}`);
  process.exit(1);
}
createFixtureDatabase(path, { seed: !args.includes('--empty') });
console.log(`Created fake dashboard database at ${path}`);
