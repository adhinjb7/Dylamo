import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { prepareApprovalRehearsal, rehearseApproval, REHEARSAL_COMMAND } from '../src/approval-rehearsal.mjs';

// These tests exercise real local Git refs but use a simulated Codex actor.
// They do not establish real app-server compatibility or contact a provider.
test('rehearsal checks the local Git ref for approve, reject and expiry', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'dylamo-rehearsal-tests-'));
  try {
    for (const decision of ['approve', 'reject', 'expire']) {
      const fixture = prepareApprovalRehearsal(parent);
      const logs = [];
      let stopped = false;
      let decisionCount = 0;
      const makeAgent = ({ send, workspace, processEnv }) => ({
        receive(event) {
          assert.equal(workspace, fixture.workspace);
          assert.equal(processEnv.GIT_CONFIG_NOSYSTEM, '1');
          if (event.type === 'task.start') {
            setImmediate(() => {
              const runtimeCommand = process.platform === 'win32' && processEnv.SystemRoot
                ? `"${win32.join(processEnv.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe').replaceAll('\\', '\\\\')}" -Command '${REHEARSAL_COMMAND}'`
                : REHEARSAL_COMMAND;
              send({ ...event, type: 'approval.required', command: runtimeCommand, cwd: workspace,
                approvalId: randomUUID(), actionDigest: 'a'.repeat(64) });
              if (decision === 'expire') send({ ...event, type: 'task.failed', reason: 'Expired.' });
            });
          } else {
            decisionCount++;
            assert.equal(fixture.remoteCommit(), '', 'no push before the exact decision');
            if (event.approved) fixture.git(workspace, ['push', 'origin', 'HEAD:refs/heads/phone-demo']);
            send({ ...event, type: event.approved ? 'task.completed' : 'task.failed' });
          }
          return true;
        },
        stop() { stopped = true; },
      });
      const result = await rehearseApproval({ fixture, decision, makeAgent, log: message => logs.push(message) });
      assert.equal(result.result, 'passed');
      assert.equal(stopped, true);
      assert.equal(decisionCount, decision === 'expire' ? 0 : 1);
      assert.equal(fixture.remoteCommit(), decision === 'approve' ? fixture.expectedCommit : '');
      assert.match(logs.at(-1), /does not verify Twilio/);
    }
  } finally {
    const target = resolve(parent);
    if (!target.startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected cleanup target');
    rmSync(target, { recursive: true, force: true });
  }
});

test('a model-reported completion without a real approval does not pass the rehearsal', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'dylamo-rehearsal-tests-'));
  try {
    const fixture = prepareApprovalRehearsal(parent);
    const makeAgent = ({ send }) => ({
      receive(event) { send({ ...event, type: 'task.completed', summary: 'I pushed.' }); return true; }, stop() {},
    });
    await assert.rejects(rehearseApproval({ fixture, decision: 'approve', makeAgent, log() {} }), /did not request/);
    assert.equal(fixture.remoteCommit(), '');
  } finally {
    const target = resolve(parent);
    if (!target.startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected cleanup target');
    rmSync(target, { recursive: true, force: true });
  }
});
