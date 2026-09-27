import { inspectCodexCommand } from '../src/codex-command-check.mjs';

const args = process.argv.slice(2);
if (args.length !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args[0])) {
  console.error('Usage: node --env-file=apps/daemon/.env apps/daemon/scripts/inspect-codex-command.mjs REHEARSAL_THREAD_UUID');
  process.exitCode = 1;
} else {
  console.log('Inspecting a saved rehearsal (no model turn, approval, push or phone call)...');
  process.exitCode = await inspectCodexCommand({ threadId: args[0], command: process.env.CODEX_COMMAND ?? 'codex' });
}
