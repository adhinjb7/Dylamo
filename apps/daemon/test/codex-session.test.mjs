import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { codexAccountFailure, codexFailureDetails, codexProcessEnvironment,
  createCodexSessionOptions, hasExpectedCodexPermissions, startupErrorMessage } from '../src/codex-session.mjs';

test('account preflight distinguishes missing login, invalid replies, and non-OpenAI providers', () => {
  assert.match(codexAccountFailure({ account: null, requiresOpenaiAuth: true }), /not signed in/);
  assert.match(codexAccountFailure(undefined), /invalid/);
  assert.equal(codexAccountFailure({ account: null, requiresOpenaiAuth: false }), null);
  assert.equal(codexAccountFailure({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true }), null);
});

test('turn failures never echo arbitrary messages, error codes, or additional details', () => {
  assert.deepEqual(codexFailureDetails({ message: 'secret source contents', codexErrorInfo: 'secret-code', additionalDetails: 'private data' }), {
    reason: 'Codex did not complete the task.', diagnostic: null,
  });
  assert.equal(codexFailureDetails({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 'secret-value' } } }).diagnostic, 'httpConnectionFailed');
});

test('default profile limits reads to minimal runtime and workspace', () => {
  const options = createCodexSessionOptions({ workspace: process.cwd() });
  assert.deepEqual(options.config.permissions[options.permissions], {
    filesystem: { ':minimal': 'read', [options.cwd]: 'read' }, network: { enabled: false },
  });
});

test('full read compatibility requires explicit true and never grants writes or network', () => {
  for (const allowFullRead of [true, false, undefined, 'true']) {
    const options = createCodexSessionOptions({ workspace: process.cwd(), allowFullRead });
    if (allowFullRead === true) {
      assert.equal(options.permissions, ':read-only');
      assert.equal(options.config, undefined, 'no ephemeral custom profile in full-read mode');
    } else {
      const profile = options.config.permissions[options.permissions];
      assert.equal(profile.filesystem[':root'], undefined);
      assert.ok(Object.values(profile.filesystem).every(value => value === 'read'));
      assert.equal(profile.network.enabled, false);
    }
    assert.equal(options.approvalPolicy, 'on-request');
  }
});

test('workspace editing requires explicit opt-in and keeps network and .env access denied', () => {
  for (const allowFullRead of [false, true]) {
    const options = createCodexSessionOptions({ workspace: process.cwd(), allowWorkspaceWrite: true, allowFullRead });
    const profile = options.config.permissions[options.permissions];
    assert.equal(profile.extends, ':workspace');
    assert.equal(profile.filesystem[':root'], allowFullRead ? undefined : 'deny');
    assert.equal(profile.filesystem[':minimal'], 'read');
    assert.equal(profile.filesystem[':tmpdir'], 'read', 'the sibling bare remote in temp must not be writable');
    assert.equal(profile.filesystem[':slash_tmp'], 'read');
    assert.equal(profile.filesystem[':workspace_roots']['.'], 'write');
    assert.equal(profile.filesystem[':workspace_roots']['.env'], 'deny');
    assert.equal(profile.filesystem[':workspace_roots']['**/*.env'], 'deny');
    assert.equal(profile.network.enabled, false);
    assert.equal(options.approvalPolicy, 'on-request');
  }
  const stringFlag = createCodexSessionOptions({ workspace: process.cwd(), allowWorkspaceWrite: 'true' });
  assert.equal(stringFlag.config.permissions[stringFlag.permissions].extends, undefined,
    'string values must not enable editing');
});

test('coding mode moves process scratch into its workspace and strips service secrets', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dylamo-session-test-'));
  try {
    const source = { PATH: 'test-path', TEMP: tmpdir(), TWILIO_AUTH_TOKEN: 'twilio-secret',
      DAEMON_TOKEN: 'daemon-secret', OPENAI_API_KEY: 'voice-secret',
      NGROK_AUTHTOKEN: 'tunnel-secret', GH_TOKEN: 'github-secret', AWS_SECRET_ACCESS_KEY: 'cloud-secret' };
    const edit = codexProcessEnvironment({ source, cwd: workspace, allowWorkspaceWrite: true });
    assert.equal(edit.TMP, join(workspace, '.dylamo-tmp'));
    assert.equal(edit.TEMP, edit.TMP);
    assert.equal(edit.TMPDIR, edit.TMP);
    assert.equal(edit.PATH, 'test-path');
    assert.equal(edit.TWILIO_AUTH_TOKEN, undefined);
    assert.equal(edit.DAEMON_TOKEN, undefined);
    assert.equal(edit.OPENAI_API_KEY, undefined);
    assert.equal(edit.NGROK_AUTHTOKEN, undefined);
    assert.equal(edit.GH_TOKEN, undefined);
    assert.equal(edit.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(source.TEMP, tmpdir(), 'do not alter the daemon environment');
    const readonly = codexProcessEnvironment({ source, cwd: workspace });
    assert.equal(readonly.TEMP, tmpdir());
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('named local demo push removes ambient Git injection before starting Codex', () => {
  const source = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'fixture-config',
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.origin.pushurl',
    GIT_CONFIG_VALUE_0: 'unexpected-target', GIT_PAGER: 'unexpected-pager' };
  const env = codexProcessEnvironment({ source, cwd: process.cwd(), isolateDemoGit: true });
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_CONFIG_GLOBAL, 'fixture-config');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  for (const name of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_PAGER']) {
    assert.equal(env[name], undefined);
    assert.ok(name in source, 'do not mutate the parent environment');
  }
  const normal = codexProcessEnvironment({ source, cwd: process.cwd() });
  assert.equal(normal.GIT_CONFIG_COUNT, '1', 'unrelated repository investigations retain their environment');
});

test('workspace editing refuses a different or broader effective profile', () => {
  const options = createCodexSessionOptions({ workspace: process.cwd(), allowWorkspaceWrite: true });
  const result = { activePermissionProfile: { id: options.permissions, extends: ':workspace' },
    sandbox: { type: 'workspaceWrite', networkAccess: false }, approvalPolicy: 'on-request' };
  assert.equal(hasExpectedCodexPermissions(result, options), true);
  for (const changed of [
    { ...result, activePermissionProfile: { id: ':workspace', extends: null } },
    { ...result, activePermissionProfile: { id: options.permissions, extends: ':danger-full-access' } },
    { ...result, sandbox: { type: 'dangerFullAccess', networkAccess: false } },
    { ...result, sandbox: { type: 'workspaceWrite', networkAccess: true } },
    { ...result, approvalPolicy: 'never' },
  ]) assert.equal(hasExpectedCodexPermissions(changed, options), false);
});

test('session verification requires the on-request approval policy for either read profile', () => {
  for (const allowFullRead of [false, true]) {
    const options = createCodexSessionOptions({ workspace: process.cwd(), allowFullRead });
    const result = {
      activePermissionProfile: { id: options.permissions, extends: null },
      sandbox: { type: 'readOnly', networkAccess: false },
      approvalPolicy: 'on-request',
    };
    assert.equal(hasExpectedCodexPermissions(result, options), true);
    for (const approvalPolicy of ['untrusted', 'never', undefined]) {
      assert.equal(hasExpectedCodexPermissions({ ...result, approvalPolicy }, options), false);
    }
  }
});

test('startup diagnostics omit HTTP headers and JWT-like credentials', () => {
  const message = startupErrorMessage({ message: 'failed to load workspace requirements; eyJtest.payload.signature headers={"set-cookie":"private-cookie"}' });
  assert.match(message, /failed to load workspace requirements/);
  assert.equal(message.includes('eyJtest'), false);
  assert.equal(message.includes('private-cookie'), false);
});

test('startup diagnostics retain useful sandbox errors without exposing credentials', () => {
  const detail = 'error creating thread: windows sandbox cannot enforce split filesystem read restrictions';
  const message = startupErrorMessage({ message: `${detail}\nDAEMON_TOKEN=secret-pairing-token Bearer opaque-auth sk-secret-api-123456` }, {
    DAEMON_TOKEN: 'secret-pairing-token',
  });
  assert.match(message, /windows sandbox cannot enforce split filesystem read restrictions/);
  assert.equal(message.includes('secret-pairing-token'), false);
  assert.equal(message.includes('opaque-auth'), false);
  assert.equal(message.includes('sk-secret-api'), false);
  assert.equal(message.includes('\n'), false);
});
