import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAnswerDelivery } from '../src/answer-delivery.mjs';

test('short answers are spoken directly', () => {
  const delivery = createAnswerDelivery('The repository has two packages.');
  assert.equal(delivery.needsChoice, false);
  assert.equal(delivery.opening, 'The repository has two packages.');
});

test('long answers offer a grounded summary and paced details without consuming a new task', () => {
  const result = 'The repository contains a voice server, a daemon, and a shared protocol package. '
    + 'The voice server authenticates calls and routes requests to the local daemon. '
    + 'The daemon starts Codex and reports results through the protocol. '
    + 'The test suite ran 20 tests: 18 passed and 2 failed. '
    + 'The two failures concern callback expiry and daemon reconnect behavior. '
    + 'The remaining work is to inspect those failures and rerun the affected tests.';
  const delivery = createAnswerDelivery(result);
  assert.equal(delivery.needsChoice, true);
  assert.match(delivery.opening, /summary or details/i);
  assert.equal(delivery.receive('Please investigate those failures.').handled, false);
  assert.match(delivery.receive('Repeat.').message, /summary or details first/i);

  const summary = delivery.receive('Summary.');
  assert.equal(summary.handled, true);
  assert.match(summary.message, /18 passed and 2 failed/i);
  assert.match(summary.message, /Say details/i);

  const first = delivery.receive('Details.');
  assert.equal(first.handled, true);
  assert.match(first.message, /Say continue/i);
  assert.equal(delivery.receive('Repeat.').message, first.message);
  const second = delivery.receive('Continue.');
  assert.equal(second.handled, true);
  assert.notEqual(second.message, first.message);
  const third = delivery.receive('Continue.');
  assert.match(third.message, /full answer/i);
  assert.match(delivery.receive('Continue.').message, /full answer/i);
  assert.equal(delivery.receive('No thanks.').dismiss, true);
});
