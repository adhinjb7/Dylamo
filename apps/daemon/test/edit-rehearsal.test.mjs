import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { editRehearsalResult, prepareEditRehearsal, rehearseWorkspaceEdit } from '../src/edit-rehearsal.mjs';

async function withFixture(run) {
  const parent = mkdtempSync(join(tmpdir(), 'dylamo-edit-tests-'));
  try { return await run(prepareEditRehearsal(parent)); }
  finally {
    const target = resolve(parent);
    if (!target.startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected cleanup target');
    rmSync(target, { recursive: true, force: true });
  }
}

test('prepared edit fixture has a failing test and an empty local remote', () => withFixture(fixture => {
  assert.equal(fixture.remoteRefs(), '');
  const env = { ...fixture.env };
  for (const key of Object.keys(env)) if (/^NODE_TEST_/i.test(key)) delete env[key];
  assert.throws(() => execFileSync(process.execPath, ['--test', 'test/math.test.mjs'], {
    cwd: fixture.workspace, env, stdio: 'ignore', timeout: 15_000,
  }));
  assert.throws(() => editRehearsalResult(fixture), /expected source edit/);
}));

test('rehearsal verifies a real local edit independently of the reported completion', async () => {
  await withFixture(async fixture => {
    const logs = [];
    let stopped = false;
    const makeAgent = ({ send, workspace, allowWorkspaceWrite, allowFullRead, approvalCommand, processEnv }) => ({
      receive(event) {
        assert.equal(workspace, fixture.workspace);
        assert.equal(allowWorkspaceWrite, true);
        assert.equal(allowFullRead, true, 'the rehearsal must use the configured startup read scope');
        assert.equal(approvalCommand, 'git push origin HEAD:refs/heads/phone-demo');
        assert.equal(processEnv.GIT_CONFIG_NOSYSTEM, '1');
        if (event.type === 'task.start') setImmediate(() => {
          writeFileSync(fixture.source, 'export function triple(value) { return value * 3; }\n');
          send({ ...event, type: 'task.completed', summary: 'Done' });
        });
        return true;
      },
      stop() { stopped = true; },
    });
    const result = await rehearseWorkspaceEdit({ fixture, allowFullRead: true, makeAgent,
      log: message => logs.push(message) });
    assert.equal(result.result, 'passed');
    assert.equal(stopped, true);
    assert.match(logs.at(-1), /does not verify phone approval/);
  });
});

test('a completion claim without a passing source edit fails', async () => {
  await withFixture(async fixture => {
    const makeAgent = ({ send }) => ({
      receive(event) { setImmediate(() => send({ ...event, type: 'task.completed' })); return true; }, stop() {},
    });
    await assert.rejects(rehearseWorkspaceEdit({ fixture, makeAgent, log() {} }), /expected source edit/);
  });
});

test('extra workspace edits, outside sentinel changes and local pushes fail verification', () => withFixture(fixture => {
  writeFileSync(fixture.source, 'export function triple(value) { return value * 3; }\n');
  writeFileSync(fixture.testFile, `${readFileSync(fixture.testFile, 'utf8')}\n`);
  assert.throws(() => editRehearsalResult(fixture), /expected source edit/);
  fixture.git(fixture.workspace, ['restore', 'test/math.test.mjs']);
  writeFileSync(fixture.boundary, 'changed\n');
  assert.throws(() => editRehearsalResult(fixture), /outside-workspace sentinel/);
  writeFileSync(fixture.boundary, 'This file must not change.\n');
  fixture.git(fixture.workspace, ['push', 'origin', 'HEAD:refs/heads/phone-demo']);
  assert.throws(() => editRehearsalResult(fixture), /local remote changed/);
}));

test('verifier rejects agent-written executable code before running the independent test', () => withFixture(fixture => {
  const hook = join(fixture.directory, 'node-hook.cjs');
  writeFileSync(hook, `require('node:fs').writeFileSync(${JSON.stringify(fixture.boundary)}, 'hook ran\\n');\n`);
  fixture.env.NODE_OPTIONS = `--require=${hook}`;
  writeFileSync(fixture.source,
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(fixture.boundary)}, 'source ran\\n');\nexport function triple(value) { return value * 3; }\n`);
  assert.throws(() => editRehearsalResult(fixture), /expected source edit/);
  assert.equal(readFileSync(fixture.boundary, 'utf8'), 'This file must not change.\n');
  writeFileSync(fixture.source, 'export function triple(value) { return value * 3; }\n');
  assert.equal(editRehearsalResult(fixture).result, 'passed', 'NODE_OPTIONS must not reach the independent test');
  assert.equal(readFileSync(fixture.boundary, 'utf8'), 'This file must not change.\n');
}));

test('verifier rejects a changed Git configuration before invoking Git', () => withFixture(fixture => {
  const path = join(fixture.workspace, '.git', 'config');
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n[core]\n  fsmonitor = do-not-run\n`);
  assert.throws(() => editRehearsalResult(fixture), /Git configuration changed/);
}));

test('an approval request fails without a decision', async () => {
  await withFixture(async fixture => {
    let stopped = false;
    const makeAgent = ({ send }) => ({
      receive(event) { setImmediate(() => send({ ...event, type: 'approval.required' })); return true; },
      stop() { stopped = true; },
    });
    await assert.rejects(rehearseWorkspaceEdit({ fixture, makeAgent, log() {} }), /No action was approved/);
    assert.equal(stopped, true);
    assert.equal(fixture.remoteRefs(), '');
  });
});
