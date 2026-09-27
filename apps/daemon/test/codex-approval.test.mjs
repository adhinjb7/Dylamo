import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCodexApproval } from '../src/codex-approval.mjs';

function fixture() {
  let now = 1000;
  const machineId = randomUUID();
  const command = 'git push origin HEAD:refs/heads/phone-demo';
  const run = { threadId: 'thread', turnId: 'turn', sessionId: randomUUID(), taskId: randomUUID(), runId: randomUUID() };
  const request = { id: 7, method: 'item/commandExecution/requestApproval', params: {
    threadId: run.threadId, turnId: run.turnId, itemId: 'item', command, cwd: process.cwd(),
    availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
  } };
  const policy = createCodexApproval({ machineId, command, workspace: process.cwd(), now: () => now, ttlMs: 100 });
  return { policy, request, run, expire: () => { now += 101; } };
}

test('approval binds the exact action and runtime request, and expires', () => {
  const f = fixture();
  const event = f.policy.prepare(f.run, f.request);
  assert.equal(event.runtime.requestId, '7');
  const decision = { ...event, type: 'approval.response', approved: true };
  const pending = { event, resolved: false };
  assert.equal(f.policy.accepts(pending, decision), true);
  for (const key of ['approvalId', 'runId', 'taskId', 'sessionId', 'machineId', 'actionDigest']) {
    assert.equal(f.policy.accepts(pending, { ...decision, [key]: 'mismatch' }), false, key);
  }
  assert.equal(f.policy.accepts({ ...pending, resolved: true }, decision), false);
  f.expire();
  assert.equal(f.policy.accepts(pending, decision), false);
});

test('unsupported or changed approval requests cannot reach the phone bridge', () => {
  const f = fixture();
  for (const change of [
    { command: f.request.params.command + ' && echo changed' }, { cwd: '/' },
    { threadId: 'other' }, { turnId: 'other' }, { itemId: '' }, { kind: 'writeStdin' },
    { networkApprovalContext: { host: 'github.com', protocol: 'https' } },
    { environmentId: 'remote' }, { availableDecisions: ['acceptForSession'] },
  ]) assert.equal(f.policy.prepare(f.run, { ...f.request, params: { ...f.request.params, ...change } }), null);
  assert.equal(f.policy.prepare(f.run, { ...f.request, method: 'item/fileChange/requestApproval' }), null);
});

test('permission changes and different runtime identities require a different digest', () => {
  const f = fixture();
  const first = f.policy.prepare(f.run, f.request);
  for (const change of [{ itemId: 'new-item' }, { additionalPermissions: { network: { enabled: true } } }]) {
    const next = f.policy.prepare(f.run, { ...f.request, params: { ...f.request.params, ...change } });
    assert.notEqual(first.actionDigest, next.actionDigest);
  }
  assert.notEqual(first.actionDigest, f.policy.prepare(f.run, { ...f.request, id: '7' }).actionDigest);
});

test('local file-URL cwd matches only the configured absolute workspace', () => {
  const f = fixture();
  const fromPath = f.policy.prepare(f.run, f.request);
  const fromUrl = f.policy.prepare(f.run, { ...f.request, params: {
    ...f.request.params, cwd: pathToFileURL(process.cwd()).href,
  } });
  assert.ok(fromUrl);
  assert.equal(fromUrl.cwd, process.cwd());
  assert.equal(fromUrl.actionDigest, fromPath.actionDigest, 'path representation is not a different working directory');
  for (const cwd of ['.', '', 'file://other-host/share', 'https://example.com/repo',
    `${pathToFileURL(process.cwd()).href}?changed=true`, `${pathToFileURL(process.cwd()).href}#fragment`,
    'file:///malformed%ZZ', pathToFileURL(join(process.cwd(), 'other')).href]) {
    assert.equal(f.policy.prepare(f.run, { ...f.request, params: { ...f.request.params, cwd } }), null, cwd);
  }
  const workspace = join(process.cwd(), 'demo space #literal');
  const policy = createCodexApproval({ machineId: fromPath.machineId, command: f.request.params.command, workspace });
  assert.ok(policy.prepare(f.run, { ...f.request, params: { ...f.request.params, cwd: pathToFileURL(workspace).href } }));
});

test('rejection diagnostics identify a mismatch without disclosing raw command, path or reason', () => {
  const f = fixture();
  const request = { ...f.request, params: { ...f.request.params,
    command: 'powershell.exe -Command "git push secret-token"',
    cwd: pathToFileURL(process.cwd()).href, reason: 'private upstream reason',
  } };
  assert.equal(f.policy.prepare(f.run, request), null, 'a shell wrapper is not implicitly approved');
  const { commandPreview, ...classification } = f.policy.describeRejection(f.run, request);
  assert.deepEqual(classification, {
    code: 'command-mismatch', requestType: 'command', commandForm: 'powershell-wrapper', cwdForm: 'file-url', cwdMatches: true,
  });
  assert.equal(commandPreview.shape, 'powershell.exe -Command "<other> <other> <other>"');
  const diagnostics = JSON.stringify(f.policy.describeRejection(f.run, request));
  assert.equal(diagnostics.includes('secret-token'), false);
  assert.equal(diagnostics.includes(process.cwd()), false);
  assert.equal(diagnostics.includes('private upstream reason'), false);
  assert.equal(f.policy.describeRejection(f.run, { ...f.request, method: 'unknown/private-method' }).requestType, 'other');
});

test('accepted Windows wrapper stays in the approval record and changes its digest', () => {
  const f = fixture();
  const policy = createCodexApproval({ machineId: randomUUID(), command: f.request.params.command, workspace: process.cwd(),
    commandEnvironment: { platform: 'win32', windowsRoot: String.raw`C:\WINDOWS` } });
  const executable = String.raw`C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe`;
  const raw = policy.prepare(f.run, f.request);
  const actual = `"${executable}" -Command "${f.request.params.command}"`;
  const wrapped = policy.prepare(f.run, { ...f.request, params: { ...f.request.params, command: actual } });
  assert.ok(wrapped);
  assert.equal(wrapped.command, actual, 'store the executed representation, not just its friendly inner text');
  assert.notEqual(wrapped.actionDigest, raw.actionDigest);
  const otherWrapper = policy.prepare(f.run, { ...f.request, params: {
    ...f.request.params, command: `"${executable}" -NoProfile -Command "${f.request.params.command}"`,
  } });
  assert.notEqual(wrapped.actionDigest, otherWrapper.actionDigest);
  assert.equal(policy.accepts({ event: wrapped, resolved: false }, { ...wrapped, approved: true, actionDigest: raw.actionDigest }), false);
  assert.equal(policy.prepare(f.run, { ...f.request, params: { ...f.request.params, command: `${actual}; whoami` } }), null);
});

test('escaped system-shell preview remains bound to its exact one-use approval', () => {
  const f = fixture();
  const command = f.request.params.command;
  const executable = String.raw`C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe`;
  const policy = createCodexApproval({ machineId: randomUUID(), command, workspace: process.cwd(),
    commandEnvironment: { platform: 'win32', windowsRoot: String.raw`C:\WINDOWS` } });
  const actual = `"${executable.replaceAll('\\', '\\\\')}" -Command '${command}'`;
  const event = policy.prepare(f.run, { ...f.request, params: { ...f.request.params, command: actual } });
  assert.ok(event);
  assert.equal(event.command, actual, 'preserve escaping rather than overwriting the approval command');
  const unescaped = policy.prepare(f.run, { ...f.request, params: {
    ...f.request.params, command: `"${executable}" -Command '${command}'`,
  } });
  assert.notEqual(event.actionDigest, unescaped.actionDigest);
  const response = { ...event, type: 'approval.response', approved: true };
  assert.equal(policy.accepts({ event, resolved: false }, response), true);
  assert.equal(policy.accepts({ event, resolved: true }, response), false);
  assert.equal(policy.accepts({ event, resolved: false }, { ...response, actionDigest: unescaped.actionDigest }), false);
  assert.equal(policy.prepare(f.run, { ...f.request, params: { ...f.request.params, command: `${actual}; whoami` } }), null);
});
