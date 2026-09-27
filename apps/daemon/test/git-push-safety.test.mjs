import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareApprovalRehearsal } from '../src/approval-rehearsal.mjs';
import { DemoPushSafetyError, inspectDemoPush, sameDemoPushState, verifyDemoPushResult } from '../src/git-push-safety.mjs';

function withFixture(run) {
  const parent = resolve(join(tmpdir(), 'dylamo-approval-rehearsals'));
  const fixture = prepareApprovalRehearsal(parent);
  try { return run(fixture); }
  finally {
    const target = resolve(fixture.directory);
    const suffix = relative(parent, target);
    if (!suffix.startsWith('approval-rehearsal-') || suffix.includes('..') || suffix.includes('/') || suffix.includes('\\')) {
      throw new Error('Unexpected cleanup target');
    }
    rmSync(target, { recursive: true, force: true });
  }
}

test('clean demo push snapshot binds HEAD and its single local destination', () => withFixture(fixture => {
  const first = inspectDemoPush({ workspace: fixture.workspace, environment: fixture.env });
  assert.equal(first.head, fixture.expectedCommit);
  assert.equal(first.pushUrl, fixture.remote);
  assert.equal(first.localTarget, fixture.remote);
  assert.equal(sameDemoPushState(first,
    inspectDemoPush({ workspace: fixture.workspace, environment: fixture.env })), true);
  fixture.git(fixture.workspace, ['remote', 'set-url', 'origin', join(fixture.directory, 'different.git')]);
  assert.throws(() => inspectDemoPush({ workspace: fixture.workspace, environment: fixture.env }),
    /destination is unavailable|not its sibling/);
}));

test('uncommitted or untracked changes cannot be represented as a pushed fix', () => withFixture(fixture => {
  writeFileSync(join(fixture.workspace, 'README.md'), '# Edited but not committed\n');
  assert.throws(() => inspectDemoPush({ workspace: fixture.workspace, environment: fixture.env }),
    DemoPushSafetyError);
  writeFileSync(join(fixture.workspace, 'README.md'), '# Approval rehearsal\n\nThis disposable repository contains no personal data.\n');
  writeFileSync(join(fixture.workspace, 'unexpected.txt'), 'untracked\n');
  assert.throws(() => inspectDemoPush({ workspace: fixture.workspace, environment: fixture.env }),
    /uncommitted or untracked/);
}));

test('a demo push with multiple destinations is refused', () => withFixture(fixture => {
  fixture.git(fixture.workspace, ['remote', 'set-url', '--add', '--push', 'origin', fixture.remote]);
  fixture.git(fixture.workspace, ['remote', 'set-url', '--add', '--push', 'origin', join(fixture.directory, 'other.git')]);
  assert.throws(() => inspectDemoPush({ workspace: fixture.workspace, environment: fixture.env }),
    /exactly one origin destination/);
}));

test('the named demo push refuses unisolated Git settings and changed hooks', () => withFixture(fixture => {
  assert.throws(() => inspectDemoPush({ workspace: fixture.workspace,
    environment: { ...fixture.env, GIT_CONFIG_COUNT: '1' } }), /environment is not isolated/);
  writeFileSync(join(fixture.directory, 'empty-hooks', 'pre-push'), 'unexpected hook\n');
  assert.throws(() => inspectDemoPush({ workspace: fixture.workspace, environment: fixture.env }),
    /Git fixture changed/);
}));

test('the named demo push refuses remote hooks or a pre-existing destination ref', () => withFixture(fixture => {
  writeFileSync(join(fixture.remote, 'hooks', 'pre-receive'), 'unexpected hook\n');
  assert.throws(() => inspectDemoPush({ workspace: fixture.workspace, environment: fixture.env }),
    /Git fixture changed/);
}));

test('the named demo push refuses a pre-existing destination ref', () => withFixture(fixture => {
  fixture.git(fixture.workspace, ['push', 'origin', 'HEAD:refs/heads/phone-demo']);
  assert.throws(() => inspectDemoPush({ workspace: fixture.workspace, environment: fixture.env }),
    /already has a ref/);
}));

test('the named demo push cannot target another repository', () => withFixture(fixture => {
  assert.throws(() => inspectDemoPush({ workspace: fixture.directory, environment: fixture.env }),
    /limited to its disposable local approval fixture/);
}));

test('post-command verification requires the exact held commit at the local destination', () => withFixture(fixture => {
  const expectedState = inspectDemoPush({ workspace: fixture.workspace, environment: fixture.env });
  assert.throws(() => verifyDemoPushResult({ workspace: fixture.workspace,
    environment: fixture.env, expectedState }), /does not match the approved commit/);
  fixture.git(fixture.workspace, ['push', 'origin', 'HEAD:refs/heads/phone-demo']);
  assert.equal(verifyDemoPushResult({ workspace: fixture.workspace,
    environment: fixture.env, expectedState }), true);
  assert.throws(() => inspectDemoPush({ workspace: fixture.workspace, environment: fixture.env }),
    /already has a ref/, 'a used fixture cannot request a second approval');
}));

test('operator preflight checks the child environment without a push', () => withFixture(fixture => {
  const output = execFileSync(process.execPath,
    [fileURLToPath(new URL('../scripts/check-demo-push.mjs', import.meta.url))], {
      cwd: fixture.workspace, encoding: 'utf8', windowsHide: true, timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...fixture.env, CODEX_WORKSPACE: fixture.workspace, GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_VALUE_0: 'unexpected', GIT_PAGER: 'unexpected' },
    });
  assert.match(output, /PASS: the named local demo push is ready/);
  assert.equal(fixture.remoteCommit(), '', 'a preflight must not create the destination ref');
}));
