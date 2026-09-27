import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export class DemoPushSafetyError extends Error {}

function samePath(first, second) {
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

// Read-only preflight for the one named demo push. Never execute a push here.
// The Git calls suppress optional index locks and fsmonitor, and their raw
// output/errors (including a possibly credential-bearing URL) are not logged.
export function inspectDemoPush({ workspace, environment = process.env, gitExecutable = 'git',
  expectedDestinationCommit = null }) {
  let cwd;
  try { cwd = realpathSync(workspace); }
  catch { throw new DemoPushSafetyError('The demo push workspace is unavailable.'); }
  const underTemp = relative(realpathSync(tmpdir()), cwd);
  const parts = underTemp.split(sep);
  if (!underTemp || underTemp.startsWith('..') || isAbsolute(underTemp) || parts.length < 3 ||
      parts.at(-1) !== 'repository' || !parts.at(-2).startsWith('approval-rehearsal-') ||
      parts.at(-3) !== 'dylamo-approval-rehearsals') {
    throw new DemoPushSafetyError('The demo push is limited to its disposable local approval fixture.');
  }
  const directory = dirname(cwd);
  const expectedRemote = join(directory, 'remote.git');
  const expectedHooks = join(directory, 'empty-hooks');
  const expectedGlobal = join(directory, 'empty-gitconfig');
  const allowedGitVariables = new Set(['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT',
    'GIT_OPTIONAL_LOCKS']);
  if (Object.keys(environment).some(key => /^GIT_/i.test(key) && !allowedGitVariables.has(key.toUpperCase())) ||
      environment.GIT_CONFIG_NOSYSTEM !== '1' || environment.GIT_TERMINAL_PROMPT !== '0') {
    throw new DemoPushSafetyError('The disposable Git environment is not isolated.');
  }
  try {
    if (!samePath(realpathSync(environment.GIT_CONFIG_GLOBAL), realpathSync(expectedGlobal)) ||
        readFileSync(expectedGlobal).length !== 0 || readdirSync(expectedHooks).length !== 0 ||
        !existsSync(join(expectedRemote, 'HEAD')) ||
        readdirSync(join(expectedRemote, 'hooks')).some(name => !name.endsWith('.sample'))) {
      throw new Error('fixture changed');
    }
  } catch { throw new DemoPushSafetyError('The disposable Git fixture changed.'); }
  const env = { ...environment, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  const git = args => {
    try {
      return execFileSync(gitExecutable, ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
        cwd, env, encoding: 'utf8', windowsHide: true, timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch { throw new DemoPushSafetyError('Could not inspect the demo push repository safely.'); }
  };
  let root;
  try { root = realpathSync(git(['rev-parse', '--show-toplevel'])); }
  catch { throw new DemoPushSafetyError('The demo push workspace is not a Git repository root.'); }
  if (!samePath(root, cwd)) throw new DemoPushSafetyError('The demo push workspace is not a Git repository root.');
  if (git(['status', '--porcelain=v1', '--untracked-files=all'])) {
    throw new DemoPushSafetyError('The demo push is blocked: the repository has uncommitted or untracked files.');
  }
  const head = git(['rev-parse', '--verify', 'HEAD']);
  if (!/^[a-f0-9]{40,64}$/.test(head)) throw new DemoPushSafetyError('The demo push has no verified HEAD commit.');
  const urls = git(['remote', 'get-url', '--push', '--all', 'origin']).split(/\r?\n/).filter(Boolean);
  if (urls.length !== 1) throw new DemoPushSafetyError('The demo push requires exactly one origin destination.');
  const pushUrl = urls[0];
  if (/^[^/\\]+@[^:]+:/.test(pushUrl) || /^[a-z][a-z\d+.-]*:\/\//i.test(pushUrl)) {
    throw new DemoPushSafetyError('The demo push destination must be its sibling local bare repository.');
  }
  let localTarget;
  try { localTarget = realpathSync(isAbsolute(pushUrl) ? pushUrl : resolve(cwd, pushUrl)); }
  catch { throw new DemoPushSafetyError('The local demo push destination is unavailable.'); }
  if (!samePath(localTarget, realpathSync(expectedRemote))) {
    throw new DemoPushSafetyError('The demo push destination is not its sibling local bare repository.');
  }
  const destinationCommit = git(['--git-dir', expectedRemote, 'for-each-ref', '--format=%(objectname)', 'refs/heads/phone-demo']);
  if (expectedDestinationCommit === null ? Boolean(destinationCommit) : destinationCommit !== expectedDestinationCommit) {
    throw new DemoPushSafetyError(expectedDestinationCommit === null
      ? 'The disposable phone-demo destination already has a ref. Use a fresh fixture.'
      : 'The disposable phone-demo destination does not match the approved commit.');
  }
  const hooksPath = git(['config', '--get', 'core.hooksPath']);
  let actualHooks;
  try { actualHooks = realpathSync(isAbsolute(hooksPath) ? hooksPath : resolve(cwd, hooksPath)); }
  catch { throw new DemoPushSafetyError('The disposable Git hooks path is unavailable.'); }
  if (!samePath(actualHooks, realpathSync(expectedHooks))) {
    throw new DemoPushSafetyError('The disposable Git hooks path changed.');
  }
  const fingerprint = createHash('sha256').update(readFileSync(join(cwd, '.git', 'config')))
    .update(readFileSync(join(expectedRemote, 'config'))).digest('hex');
  return Object.freeze({ head, pushUrl, localTarget, fingerprint, destinationCommit });
}

export function sameDemoPushState(first, second) {
  return Boolean(first && second && first.head === second.head && first.pushUrl === second.pushUrl &&
    first.localTarget === second.localTarget && first.fingerprint === second.fingerprint);
}

// A successful command item is not enough evidence that the intended Git ref
// moved. Recheck the same local fixture after app-server reports completion.
export function verifyDemoPushResult({ workspace, environment = process.env, expectedState, gitExecutable = 'git' }) {
  if (!expectedState || !/^[a-f0-9]{40,64}$/.test(expectedState.head ?? '')) {
    throw new DemoPushSafetyError('The approved demo push has no trusted commit to verify.');
  }
  const current = inspectDemoPush({ workspace, environment, gitExecutable,
    expectedDestinationCommit: expectedState.head });
  if (!sameDemoPushState(expectedState, current)) {
    throw new DemoPushSafetyError('The demo push source or destination changed after approval.');
  }
  return true;
}
