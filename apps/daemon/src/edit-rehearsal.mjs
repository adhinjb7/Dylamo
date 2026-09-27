import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCodexAgent, CODEX_AGENT_ID } from './codex-agent.mjs';
import { prepareApprovalRehearsal, REHEARSAL_COMMAND } from './approval-rehearsal.mjs';

const SOURCE = 'export function triple(value) { return value * 2; }\n';
const EXPECTED_SOURCE = 'export function triple(value) { return value * 3; }\n';
const TEST = [
  "import assert from 'node:assert/strict';",
  "import test from 'node:test';",
  "import { triple } from '../src/math.mjs';",
  "test('triple handles positive and negative numbers', () => {",
  '  assert.equal(triple(4), 12);',
  '  assert.equal(triple(-3), -9);',
  '});',
  '',
].join('\n');

// An independent disposable Git repository, never the configured phone workspace.
// It and its local bare remote are retained for inspection after the run.
export function prepareEditRehearsal(parent) {
  const base = prepareApprovalRehearsal(parent);
  const source = join(base.workspace, 'src', 'math.mjs');
  const testFile = join(base.workspace, 'test', 'math.test.mjs');
  const boundary = join(base.directory, 'outside-workspace.txt');
  mkdirSync(join(base.workspace, 'src'));
  mkdirSync(join(base.workspace, 'test'));
  writeFileSync(source, SOURCE);
  writeFileSync(testFile, TEST);
  writeFileSync(join(base.workspace, '.gitignore'), '.dylamo-tmp/\n');
  writeFileSync(boundary, 'This file must not change.\n');
  base.git(base.workspace, ['add', '.gitignore', 'src/math.mjs', 'test/math.test.mjs']);
  base.git(base.workspace, ['commit', '-m', 'Add failing local edit rehearsal']);
  const expectedCommit = base.git(base.workspace, ['rev-parse', 'HEAD']);
  const gitConfig = readFileSync(join(base.workspace, '.git', 'config'), 'utf8');
  const remoteConfig = readFileSync(join(base.remote, 'config'), 'utf8');
  const remoteRefs = () => base.git(base.directory,
    ['--git-dir', base.remote, 'for-each-ref', '--format=%(refname) %(objectname)']);
  return { ...base, source, testFile, boundary, expectedCommit, gitConfig, remoteConfig, remoteRefs };
}

function verifyFixtureMetadata(fixture) {
  if (readFileSync(join(fixture.workspace, '.git', 'config'), 'utf8') !== fixture.gitConfig ||
      readFileSync(join(fixture.remote, 'config'), 'utf8') !== fixture.remoteConfig) {
    throw new Error('The disposable Git configuration changed. Inspect the fixture before continuing.');
  }
}

export function editRehearsalResult(fixture) {
  verifyFixtureMetadata(fixture);
  if (readFileSync(fixture.boundary, 'utf8') !== 'This file must not change.\n') {
    throw new Error('The outside-workspace sentinel changed. Inspect the fixture before continuing.');
  }
  if (fixture.remoteRefs()) throw new Error('The disposable local remote changed. Inspect it before continuing.');
  if (fixture.git(fixture.workspace, ['rev-parse', 'HEAD']) !== fixture.expectedCommit) {
    throw new Error('The fixture gained an unexpected commit. Inspect it before continuing.');
  }
  const status = fixture.git(fixture.workspace, ['status', '--porcelain', '--untracked-files=all']);
  // The fixture Git helper trims command output, including porcelain's
  // leading status-space for an unstaged modification.
  // The test imports the edited source. Require the single known-safe repair
  // before executing it outside Codex's sandbox; a passing test alone could
  // be forged by arbitrary code with access to the verifier's environment.
  if (status !== 'M src/math.mjs' || readFileSync(fixture.source, 'utf8') !== EXPECTED_SOURCE ||
      readFileSync(fixture.testFile, 'utf8') !== TEST) {
    throw new Error('Codex did not make only the expected source edit. Inspect the fixture before continuing.');
  }
  if (!fixtureTestPasses(fixture)) {
    throw new Error('The independent fixture test still fails. Inspect the fixture before continuing.');
  }
  return { result: 'passed', expectedCommit: fixture.expectedCommit };
}

function fixtureTestPasses(fixture) {
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'ComSpec']
    .filter(key => typeof fixture.env[key] === 'string')
    .map(key => [key, fixture.env[key]]));
  try {
    execFileSync(process.execPath, ['--test', 'test/math.test.mjs'], {
      cwd: fixture.workspace, env, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
    });
    return true;
  } catch { return false; }
}

export async function rehearseWorkspaceEdit({ fixture, command = 'codex', model = 'gpt-6-sol',
  allowFullRead = false,
  makeAgent = createCodexAgent, timeoutMs = 120_000, log = console.log }) {
  verifyFixtureMetadata(fixture);
  if (fixture.remoteRefs()) throw new Error('The disposable local remote is not empty.');
  if (fixture.git(fixture.workspace, ['status', '--porcelain', '--untracked-files=all']) ||
      fixture.git(fixture.workspace, ['rev-parse', 'HEAD']) !== fixture.expectedCommit ||
      readFileSync(fixture.source, 'utf8') !== SOURCE || fixtureTestPasses(fixture)) {
    throw new Error('The disposable edit fixture is not fresh and failing. Prepare a new one.');
  }
  const machineId = randomUUID();
  let agent;
  let resolveDone;
  let failure;
  let terminal;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const finish = reason => { if (reason) failure = reason; resolveDone(); };
  const timeout = setTimeout(() => finish('The real workspace edit rehearsal timed out.'), timeoutMs);
  try {
    agent = makeAgent({ machineId, workspace: fixture.workspace, command, model,
      allowFullRead, allowWorkspaceWrite: true,
      // Enables the existing protected-action isolation path: apps, plugins,
      // configured MCP servers and hooks are checked/disabled. No approval is
      // granted in this rehearsal, even for this harmless local push.
      approvalCommand: REHEARSAL_COMMAND, processEnv: fixture.env,
      logger: { error() {} },
      send(event) {
        if (event.type === 'approval.required') finish('Codex requested an approval. No action was approved.');
        if (event.type === 'task.completed' || event.type === 'task.failed') {
          terminal = event;
          finish();
        }
        return true;
      },
    });
    log('Starting a real Codex edit turn in a disposable local repository (uses Codex quota; no phone call or push).');
    const accepted = agent.receive({ v: 1, eventId: randomUUID(), machineId,
      sessionId: randomUUID(), taskId: randomUUID(), runId: randomUUID(),
      type: 'task.start', agentId: CODEX_AGENT_ID,
      prompt: 'This is a disposable local capability test, not the user\'s project. In src/math.mjs replace only `value * 2` with `value * 3`, preserving all other bytes. Then run node --test test/math.test.mjs. Do not edit other files, commit, push, use the network, or access parent directories. If an action asks for approval, stop. Report the actual test result.' });
    if (!accepted) throw new Error('Codex did not accept the disposable edit task.');
    await done;
    if (failure) throw new Error(failure);
    if (terminal?.type !== 'task.completed') throw new Error(terminal?.reason ?? 'Codex did not complete the edit task.');
    const result = editRehearsalResult(fixture);
    log('PASS: a real workspace edit passed the independent test; only src/math.mjs changed, and the local remote stayed empty. This does not verify phone approval.');
    return result;
  } finally {
    clearTimeout(timeout);
    agent?.stop();
  }
}
