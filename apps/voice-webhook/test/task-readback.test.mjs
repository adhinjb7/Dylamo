import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTaskReadback } from '../src/task-readback.mjs';

test('reads the complete unchanged transcript and only releases it on confirmation', () => {
  for (const prompt of ['Run the demo push.', 'Randh denopush.', '走走。', 'Do not run the demo push.']) {
    const review = createTaskReadback();
    const draft = review.receive(prompt);
    assert.equal(draft.prompt, undefined);
    assert.ok(draft.reply.includes(JSON.stringify(prompt)));
    assert.match(draft.reply, /not a protected action/);
    assert.deepEqual(review.receive('Yes, start it.'), { prompt });
    assert.equal(review.receive('Yes, start it.').prompt, undefined);
  }
});

test('negative replies discard the garbled task rather than starting or repairing it', () => {
  for (const reply of ['No.', 'No, cancel it.', 'Cancel', 'Start over']) {
    const review = createTaskReadback();
    review.receive('Randh denopush.');
    assert.match(review.receive(reply).reply, /discarded/);
    assert.equal(review.receive('Yes').prompt, undefined);
    review.receive('Run the demo push.');
    assert.deepEqual(review.receive('Yes, start it.'), { prompt: 'Run the demo push.' });
  }
});

test('a correction replaces the draft and must itself be confirmed in full', () => {
  const review = createTaskReadback();
  review.receive('Randh denopush.');
  const corrected = review.receive('Run the demo push.');
  assert.ok(corrected.reply.includes('Run the demo push.'));
  assert.equal(corrected.prompt, undefined);
  assert.deepEqual(review.receive('Yes'), { prompt: 'Run the demo push.' });
});

test('a longer yes phrase is a new draft, never consent to the previous one', () => {
  for (const reply of ['Yes, but do not push.', 'Yes, start it. Actually no.', 'Yes; delete everything', 'Approve the push']) {
    const review = createTaskReadback();
    review.receive('Run the demo push.');
    const result = review.receive(reply);
    assert.equal(result.prompt, undefined);
    assert.ok(result.reply.includes(JSON.stringify(reply)));
  }
});

test('silence, expiration, hangup clearing and a new call never authorize a draft', () => {
  let time = 0;
  const review = createTaskReadback({ now: () => time });
  review.receive('Run the demo push.');
  assert.deepEqual(review.receive(''), {});
  time = 60_000;
  assert.match(review.receive('Yes').reply, /expired/);
  review.receive('Run the demo push.');
  review.clear();
  assert.equal(review.receive('Yes').prompt, undefined);
  assert.equal(createTaskReadback().receive('Yes').prompt, undefined);
});

test('greetings and status do not become tasks or replace a pending read-back', () => {
  const review = createTaskReadback();
  assert.match(review.receive('Hi').reply, /^Hi!/);
  assert.match(review.receive('Status?').reply, /no Codex task running/);
  review.receive('Run the demo push.');
  assert.match(review.receive('Status?').reply, /Run the demo push/);
  review.receive('Thank you');
  assert.deepEqual(review.receive('Yes'), { prompt: 'Run the demo push.' });
});

test('requests too long to read back fully are refused, not silently truncated', () => {
  const review = createTaskReadback();
  review.receive('Run the demo push.');
  assert.match(review.receive('x'.repeat(601)).reply, /shorter request/);
  assert.equal(review.receive('Yes').prompt, undefined);
});
