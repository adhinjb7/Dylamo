import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTaskSteer } from '../src/task-steer.mjs';

test('a complete steering directive needs a second standalone confirmation', () => {
  const steer = createTaskSteer();
  assert.equal(steer.receive('Steer the task: focus on failing tests first.').prompt, undefined);
  assert.equal(steer.hasPending(), true);
  assert.match(steer.receive('Status?').reply, /focus on failing tests first/i);
  assert.deepEqual(steer.receive('Yes, steer it.'), { handled: true, prompt: 'focus on failing tests first.' });
  assert.equal(steer.hasPending(), false);
  assert.match(steer.receive('Yes, steer it.').reply, /nothing was sent/i);
});

test('correction, rejection, expiry and clearing cannot replay an old steer', () => {
  let time = 0;
  const steer = createTaskSteer({ now: () => time });
  steer.receive('Actually, focus on tests.');
  steer.receive('Actually, focus on docs.');
  assert.deepEqual(steer.receive('Yes, change it.'), { handled: true, prompt: 'focus on docs.' });
  steer.receive('Steer the task to run the unit tests.');
  assert.match(steer.receive('No, keep working.').reply, /discarded/i);
  assert.equal(steer.hasPending(), false);
  steer.receive('Actually, inspect the failing test.');
  time = 15_000;
  assert.equal(steer.hasPending(), false);
  assert.match(steer.receive('Yes, steer it.').reply, /expired/i);
  steer.receive('Actually, inspect the failing test.');
  steer.clear();
  assert.match(steer.receive('Yes, steer it.').reply, /nothing was sent/i);
});

test('unrelated speech and oversized instructions cannot create a hidden steer', () => {
  const steer = createTaskSteer();
  assert.deepEqual(steer.receive('How are things going?'), { handled: false });
  steer.receive('Actually, inspect the tests.');
  assert.deepEqual(steer.receive('I meant something else'), { handled: false });
  assert.equal(steer.hasPending(), false);
  assert.match(steer.receive(`Actually ${'x'.repeat(601)}`).reply, /too long/i);
  assert.equal(steer.hasPending(), false);
});
