import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexAccountFailure, codexFailureDetails, createCodexSessionOptions, hasExpectedCodexPermissions, startupErrorMessage } from '../src/codex-session.mjs';

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
