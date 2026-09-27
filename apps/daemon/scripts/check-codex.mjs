import { checkCodex } from '../src/codex-check.mjs';
import { codexProcessEnvironment, createCodexSessionOptions } from '../src/codex-session.mjs';

const args = process.argv.slice(2);
if (args.some(arg => !['--run', '--workspace-write'].includes(arg))) {
  console.error('Usage: node --env-file=apps/daemon/.env apps/daemon/scripts/check-codex.mjs [--workspace-write] [--run]');
  process.exitCode = 1;
} else {
  const options = createCodexSessionOptions({
    workspace: process.env.CODEX_WORKSPACE, model: process.env.CODEX_MODEL_DEFAULT ?? 'gpt-6-sol',
    allowFullRead: process.env.CODEX_ALLOW_FULL_READ === 'true',
    allowWorkspaceWrite: process.env.CODEX_ALLOW_WORKSPACE_WRITE === 'true' || args.includes('--workspace-write'),
  });
  const environment = codexProcessEnvironment({ cwd: options.cwd,
    allowWorkspaceWrite: process.env.CODEX_ALLOW_WORKSPACE_WRITE === 'true' || args.includes('--workspace-write') });
  process.exitCode = await checkCodex({ command: process.env.CODEX_COMMAND ?? 'codex', options,
    environment, runModel: args.includes('--run') });
}
