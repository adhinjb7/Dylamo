import { codexProcessEnvironment } from '../src/codex-session.mjs';
import { DemoPushSafetyError, inspectDemoPush } from '../src/git-push-safety.mjs';

if (process.argv.length !== 2) {
  console.error('Usage: node --env-file=apps/daemon/.env apps/daemon/scripts/check-demo-push.mjs');
  process.exitCode = 1;
} else {
  try {
    const workspace = process.env.CODEX_WORKSPACE;
    const environment = codexProcessEnvironment({ source: process.env, cwd: workspace,
      isolateDemoGit: true });
    inspectDemoPush({ workspace, environment });
    console.log('PASS: the named local demo push is ready under the Codex child environment. No model turn, call or push was made.');
  } catch (error) {
    console.error(`FAIL: ${error instanceof DemoPushSafetyError ? error.message
      : 'Could not inspect the named local demo push safely.'}`);
    process.exitCode = 1;
  }
}
