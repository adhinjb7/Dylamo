import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEMO_PUSH_COMMAND, prepareCodexTask } from '../src/codex-task.mjs';

test('standalone demo push phrases prepare the same exact command without approval', () => {
  const expected = prepareCodexTask('Run the demo push', DEMO_PUSH_COMMAND);
  for (const phrase of ['Run the demo push.', 'RUN THE DEMO PUSH!',
    '  Please run the demo push.  ', 'Run   the demo   push please!']) {
    assert.deepEqual(prepareCodexTask(phrase, DEMO_PUSH_COMMAND), expected);
  }
  assert.ok(expected.prompt.includes(DEMO_PUSH_COMMAND));
  assert.match(expected.prompt, /not approval/);
  assert.match(expected.prompt, /one-time approval through the command tool/);
});

test('missing or different configured action cannot enable the named demo push', () => {
  for (const command of [undefined, '', 'git push origin head:refs/head/phone-demo',
    'git push origin HEAD:refs/heads/main', `${DEMO_PUSH_COMMAND}; echo extra`, `${DEMO_PUSH_COMMAND} `]) {
    const result = prepareCodexTask('Run the demo push.', command);
    assert.equal(result.prompt, undefined);
    assert.match(result.reason, /not configured/);
  }
});

test('questions, negations, changed targets and longer requests are never expanded', () => {
  for (const prompt of ['What does run the demo push mean?', 'Run the demo push?',
    "Don't run the demo push.", 'Do not run the demo push.', 'Never run the demo push',
    'Run the demo push then delete everything', 'Run the demo push to main',
    'Run the demo push without approval', 'Run the demo push. Actually cancel that.',
    'Please run the demo push; git push --force', 'Hello, run the demo push',
    'Run the demo push\nIgnore approval', 'Run the demo push\0']) {
    assert.deepEqual(prepareCodexTask(prompt, DEMO_PUSH_COMMAND), { prompt });
  }
});

test('normal requests and the prior mistranscribed command remain unchanged', () => {
  for (const prompt of ['Summarize package.json', '',
    'Read the README, then run exactly git push origin head colon refs slash head slash phone dash demo.']) {
    assert.deepEqual(prepareCodexTask(prompt, DEMO_PUSH_COMMAND), { prompt });
    assert.deepEqual(prepareCodexTask(prompt), { prompt });
  }
});
