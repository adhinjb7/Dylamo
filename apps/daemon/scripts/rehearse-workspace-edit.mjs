import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareEditRehearsal, rehearseWorkspaceEdit } from '../src/edit-rehearsal.mjs';

const args = process.argv.slice(2);
if (args.length !== 1 || !['--prepare', '--run'].includes(args[0])) {
  console.error('Usage: node --env-file=apps/daemon/.env apps/daemon/scripts/rehearse-workspace-edit.mjs --prepare|--run');
  process.exitCode = 1;
} else {
  try {
    const fixture = prepareEditRehearsal(join(tmpdir(), 'dylamo-edit-rehearsals'));
    console.log(`Disposable fixture (retained for inspection): ${fixture.directory}`);
    if (args[0] === '--run') await rehearseWorkspaceEdit({ fixture,
      command: process.env.CODEX_COMMAND ?? 'codex', model: process.env.CODEX_MODEL_DEFAULT ?? 'gpt-6-sol',
      allowFullRead: process.env.CODEX_ALLOW_FULL_READ === 'true' });
    else console.log('PASS: prepared a failing test in a new local repository. No model turn, push or call was made.');
  } catch (error) {
    const message = error?.code || error?.stderr
      ? 'Could not prepare/run the local fixture. Check Git, Node and Codex in your normal terminal.'
      : error.message;
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }
}
