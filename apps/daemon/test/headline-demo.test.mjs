import assert from 'node:assert/strict';
import { rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { inspectDemoPush, verifyDemoPushResult } from '../src/git-push-safety.mjs';
import { headlineDemoPage, prepareHeadlineDemo } from '../src/headline-demo.mjs';

function withFixture(run) {
  const parent = join(tmpdir(), 'dylamo-approval-rehearsals');
  const fixture = prepareHeadlineDemo(parent);
  try { return run(fixture); }
  finally {
    const target = realpathSync(fixture.directory);
    if (dirname(target) !== realpathSync(parent)) throw new Error('Unexpected cleanup target');
    rmSync(target, { recursive: true, force: true });
  }
}

test('headline demo has an unpublished old page and a clean prepared commit', () => withFixture(fixture => {
  const before = headlineDemoPage(fixture);
  assert.equal(before.published, false);
  assert.equal(before.commit, fixture.baselineCommit);
  assert.match(before.html, /<h1>Dylamo demo site<\/h1>/);
  assert.doesNotMatch(before.html, /Hello, Hack Atlantic!/);
  assert.match(before.html, /<body class="awaiting-approval">/);
  assert.match(before.html, /linear-gradient\(145deg, #0a1220 0%, #142a4d 100%\)/);
  assert.match(before.html, /Before local approval/);
  assert.equal(fixture.remoteCommit(), '');
  const prepared = fixture.git(fixture.workspace, ['show', 'HEAD:site/index.html']);
  assert.match(prepared, /<h1>Hello, Hack Atlantic!<\/h1>/);
  assert.equal(inspectDemoPush({ workspace: fixture.workspace, environment: fixture.env }).head,
    fixture.preparedCommit);
}));

test('only the local protected push makes the new headline visible', () => withFixture(fixture => {
  const held = inspectDemoPush({ workspace: fixture.workspace, environment: fixture.env });
  assert.equal(headlineDemoPage(fixture).published, false);
  fixture.git(fixture.workspace, ['push', 'origin', 'HEAD:refs/heads/phone-demo']);
  assert.equal(verifyDemoPushResult({ workspace: fixture.workspace, environment: fixture.env,
    expectedState: held }), true);
  const after = headlineDemoPage(fixture);
  assert.equal(after.published, true);
  assert.equal(after.commit, fixture.preparedCommit);
  assert.match(after.html, /<h1>Hello, Hack Atlantic!<\/h1>/);
  assert.match(after.html, /<body class="published">/);
  assert.match(after.html, /linear-gradient\(145deg, #063f31 0%, #08714e 100%\)/);
  assert.match(after.html, /Published to local phone-demo branch/);
}));

test('preview fails closed if the prepared source or published ref changes', () => withFixture(fixture => {
  writeFileSync(fixture.site, 'unexpected edit\n');
  assert.throws(() => headlineDemoPage(fixture), /source changed/);
  fixture.git(fixture.workspace, ['restore', 'site/index.html']);
  fixture.git(fixture.workspace, ['push', 'origin',
    `${fixture.baselineCommit}:refs/heads/phone-demo`]);
  assert.throws(() => headlineDemoPage(fixture), /ref changed unexpectedly/);
}));
