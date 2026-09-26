import { checkCodex } from '../src/codex-check.mjs';
import { createCodexSessionOptions } from '../src/codex-session.mjs';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--run')) {
  console.error('Usage: node --env-file=apps/daemon/.env apps/daemon/scripts/check-codex.mjs [--run]');
  process.exitCode = 1;
} else {
  const options = createCodexSessionOptions({
    workspace: process.env.CODEX_WORKSPACE, model: process.env.CODEX_MODEL_DEFAULT ?? 'gpt-6-sol',
    allowFullRead: process.env.CODEX_ALLOW_FULL_READ === 'true',
  });
  process.exitCode = await checkCodex({ command: process.env.CODEX_COMMAND ?? 'codex', options, runModel: args.includes('--run') });
}
