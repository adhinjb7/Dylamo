import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvalPrompt } from '../src/approval-prompt.mjs';

const context = { action_kind: 'local-demo-push', codex_item_id: 'item', codex_request_id: 'request',
  permission_scope: 'null', command: 'git push origin HEAD:refs/heads/phone-demo', cwd: 'C:\\private\\fixture' };

test('verified demo approval speaks implications without command or path', () => {
  for (const channel of ['inbound', 'callback']) {
    const text = approvalPrompt(context, { channel });
    assert.match(text, /prepared changes to the local demo branch/);
    assert.match(text, /Nothing goes to GitHub/);
    assert.equal(text.includes(context.command), false);
    assert.equal(text.includes(context.cwd), false);
    assert.ok(text.split(/\s+/).length <= 45, 'keep the default prompt short');
    assert.doesNotMatch(text, /tests passed|headline|safe|already published/i);
  }
});

test('exact command, path and decision choices remain available on request', () => {
  for (const channel of ['inbound', 'callback']) {
    const text = approvalPrompt(context, { channel, details: true });
    assert.ok(text.includes(context.command));
    assert.ok(text.includes(context.cwd));
    assert.match(text, /approve/i);
    assert.match(text, /reject/i);
  }
});

test('unclassified, old or extra-permission actions never get a guessed demo description', () => {
  for (const change of [{ action_kind: undefined }, { action_kind: 'deploy-production' },
    { codex_item_id: null }, { codex_request_id: null }, { permission_scope: '{"network":true}' }]) {
    const candidate = { ...context, ...change };
    const text = approvalPrompt(candidate);
    assert.ok(text.includes(candidate.command));
    assert.doesNotMatch(text, /Nothing goes to GitHub|prepared changes/);
    if (change.permission_scope) assert.ok(text.includes(change.permission_scope));
  }
});

test('fake approval is explicitly simulated in brief and detailed prompts', () => {
  const brief = approvalPrompt(context, { mode: 'fake', channel: 'callback' });
  assert.match(brief, /practice push. No files will change/);
  assert.doesNotMatch(brief, /Nothing goes to GitHub|prepared changes/);
  assert.match(approvalPrompt(context, { mode: 'fake', details: true }), /Simulated action/);
});
