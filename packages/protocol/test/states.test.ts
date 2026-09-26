import assert from 'node:assert/strict';
import test from 'node:test';
import { canTransitionApproval, canTransitionCall, canTransitionTask } from '../src/index.js';

test('task cannot complete directly from queued or resume after completion', () => {
  assert.equal(canTransitionTask('queued', 'running'), true);
  assert.equal(canTransitionTask('queued', 'completed'), false);
  assert.equal(canTransitionTask('running', 'waiting_human'), true);
  assert.equal(canTransitionTask('waiting_human', 'running'), true);
  assert.equal(canTransitionTask('completed', 'running'), false);
});

test('call cannot stream before authentication or resume after ending', () => {
  assert.equal(canTransitionCall('received', 'streaming'), false);
  assert.equal(canTransitionCall('received', 'authenticating'), true);
  assert.equal(canTransitionCall('authenticating', 'streaming'), true);
  assert.equal(canTransitionCall('ended', 'streaming'), false);
});

test('approval decisions are one-way and cannot be repeated', () => {
  assert.equal(canTransitionApproval('pending', 'approved'), true);
  assert.equal(canTransitionApproval('pending', 'rejected'), true);
  assert.equal(canTransitionApproval('approved', 'approved'), false);
  assert.equal(canTransitionApproval('expired', 'approved'), false);
});
