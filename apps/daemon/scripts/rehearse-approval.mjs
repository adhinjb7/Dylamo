import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareApprovalRehearsal, rehearseApproval, REHEARSAL_COMMAND } from '../src/approval-rehearsal.mjs';

const args = process.argv.slice(2);
const decision = args.find(arg => arg.startsWith('--decision='))?.slice('--decision='.length);
const valid = args.length === 1 && args[0] === '--prepare' || args.length === 2 && args.includes('--run') &&
  ['approve', 'reject', 'expire'].includes(decision);
if (!valid) {
  console.log('Usage: node --env-file=apps/daemon/.env apps/daemon/scripts/rehearse-approval.mjs --prepare');
  console.log('Or: same command with --run --decision=reject|expire|approve (uses Codex quota).');
  process.exitCode = 1;
} else {
  try {
    const fixture = prepareApprovalRehearsal(join(tmpdir(), 'dylamo-approval-rehearsals'));
    console.log(`Disposable fixture (retained for inspection): ${fixture.directory}`);
    console.log(`Protected command: ${REHEARSAL_COMMAND}`);
    if (args.includes('--run')) await rehearseApproval({ fixture, decision,
      command: process.env.CODEX_COMMAND ?? 'codex', model: process.env.CODEX_MODEL_DEFAULT ?? 'gpt-6-sol',
      allowFullRead: process.env.CODEX_ALLOW_FULL_READ === 'true' });
    else console.log('PASS: prepared a new local repository and bare remote. No model turn, push or call was made.');
  } catch (error) {
    // Git/spawn errors can contain environment details. Only own rehearsal
    // messages are safe to show; never dump stderr, stack traces or env values.
    const message = error?.code || error?.stderr ? 'Could not prepare/run the local fixture. Check Git and Codex in your normal terminal.' : error.message;
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }
}
