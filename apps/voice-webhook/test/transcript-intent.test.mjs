import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isStatusRequest, localReplyForTranscript } from '../src/transcript-intent.mjs';

test('short greetings and basic call checks get a local response', () => {
  for (const transcript of ['Hi', 'Hello!', 'Hey there.', 'Good morning', 'Can you hear me?', 'What can you do?']) {
    assert.equal(typeof localReplyForTranscript(transcript), 'string');
  }
});

test('only standalone status questions are handled as status requests', () => {
  for (const transcript of ['Status?', "What's the status?", 'Any updates?', 'Are you still working?']) {
    assert.equal(isStatusRequest(transcript), true);
  }
  for (const transcript of ['What is the status of the tests in this repository?',
    'Any updates to package.json?', 'How is it going with the build?', '']) {
    assert.equal(isStatusRequest(transcript), false);
  }
});

test('standalone acknowledgments do not become tasks after removing read-back', () => {
  for (const transcript of ['Yes.', 'Yes, that’s correct.', 'Yes, start it.', 'No.', 'Okay', 'Sure',
    'Yes. Yes!', 'Yes, stop it.', 'Yes, steer it.', 'No, keep working.', 'Yes connect.']) {
    assert.equal(localReplyForTranscript(transcript), 'Ready for your next request.', transcript);
  }
});

test('substantive questions are never swallowed by the greeting handler', () => {
  for (const transcript of ['Hi, summarize this repo', 'Hello. What packages are installed?',
    'Can you hear me and inspect package.json?', 'Thanks, what did you find?',
    'Yes, investigate the failing tests.', 'No changes, just summarize the repo.', 'Run the demo push.',
    'Correct the headline.', 'Confirm which tests passed.', '']) {
    assert.equal(localReplyForTranscript(transcript), null);
  }
});
