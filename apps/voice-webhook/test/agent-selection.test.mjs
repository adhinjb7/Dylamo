import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgentSelection } from '../src/agent-selection.mjs';

test('agent choice requires an ordinal and a separate confirmation', () => {
  const selection = createAgentSelection();
  const options = [{ machineId: 'machine-a', agentId: 'agent-a', name: 'Codex on laptop A' },
    { machineId: 'machine-b', agentId: 'agent-b', name: 'Codex on laptop B' }];
  assert.match(selection.offer('Inspect the repository', options), /Option two/i);
  assert.match(selection.receive('Yes connect.').reply, /Choose an agent first/i);
  assert.match(selection.receive('Select three.').reply, /not available/i);
  assert.match(selection.receive('Select two.').reply, /laptop B/i);
  assert.match(selection.receive('No.').reply, /Selection cleared/i);
  assert.match(selection.receive('Select one.').reply, /laptop A/i);
  assert.deepEqual(selection.receive('Yes connect.'), { prompt: 'Inspect the repository', selected: options[0] });
  assert.equal(selection.receive('Yes connect.').unhandled, true, 'choice cannot be reused');
});

test('expired or replaced agent choices do not dispatch the old request', () => {
  let time = 100;
  const selection = createAgentSelection({ now: () => time, ttlMs: 10 });
  const options = [{ machineId: 'a', agentId: 'a', name: 'A' }, { machineId: 'b', agentId: 'b', name: 'B' }];
  selection.offer('Old request', options);
  selection.receive('Select one.');
  time = 110;
  assert.match(selection.receive('Yes connect.').reply, /expired/i);
  assert.equal(selection.receive('Yes connect.').unhandled, true);
  selection.offer('Another request', options);
  assert.equal(selection.receive('A different question.').unhandled, true);
  assert.equal(selection.receive('Yes connect.').unhandled, true);
});
