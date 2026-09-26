import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { checkCodex, CODEX_CHECK_REPLY } from '../src/codex-check.mjs';
import { createCodexSessionOptions } from '../src/codex-session.mjs';

async function runCheck({ runModel = false, failureAt, sandbox = { type: 'readOnly', networkAccess: false },
  approvalPolicy = 'on-request', finalStatus = 'completed', answer = CODEX_CHECK_REPLY, tool = false, silent = false } = {}) {
  const options = createCodexSessionOptions({ workspace: process.cwd(), allowFullRead: true });
  const requests = [];
  const output = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let killed = 0;
  child.kill = () => { killed++; child.stdin.end(); child.stdout.end(); child.stderr.end(); };
  const send = message => { if (!killed) child.stdout.write(`${JSON.stringify(message)}\n`); };
  child.stdin.on('data', data => {
    const request = JSON.parse(data.toString());
    requests.push(request);
    queueMicrotask(() => {
      if (silent || request.id == null) return;
      if (request.method === failureAt) {
        send({ id: request.id, error: { code: -32603, message: 'failed to load workspace requirements sk-private-12345678' } });
        return;
      }
      const results = {
        initialize: {},
        'account/read': { account: { type: 'chatgpt', email: 'private@example.com' }, requiresOpenaiAuth: true },
        'configRequirements/read': { requirements: null },
        'thread/start': { thread: { id: 'test-thread' }, approvalPolicy,
          activePermissionProfile: { id: options.permissions, extends: null }, sandbox },
        'turn/start': { turn: { id: 'test-turn' } },
      };
      send({ id: request.id, result: results[request.method] });
      if (request.method === 'turn/start') {
        if (tool) {
          send({ method: 'item/started', params: { threadId: 'test-thread', turnId: 'test-turn', item: { type: 'commandExecution' } } });
          return;
        }
        send({ method: 'error', params: { threadId: 'test-thread', turnId: 'test-turn', willRetry: true,
          error: { message: 'failed to load workspace requirements' } } });
        send({ method: 'item/completed', params: { threadId: 'unrelated', item: { type: 'agentMessage', text: 'ignore me' } } });
        if (answer) send({ method: 'item/completed', params: { threadId: 'test-thread', turnId: 'test-turn',
          item: { type: 'agentMessage', phase: 'final_answer', text: answer } } });
        send({ method: 'turn/completed', params: { threadId: 'test-thread', turn: { id: 'test-turn', status: finalStatus } } });
      }
    });
  });
  const code = await checkCodex({ options, runModel, spawnProcess: () => child,
    log: line => output.push(line), timeoutMs: silent ? 5 : 1000 });
  assert.equal(killed, 1);
  assert.equal(output.join('').includes('private@example.com'), false);
  assert.equal(output.join('').includes('sk-private'), false);
  return { code, requests, output };
}

test('default checker never starts a model turn', async () => {
  const result = await runCheck();
  assert.equal(result.code, 0);
  assert.equal(result.requests.some(request => request.method === 'turn/start'), false);
  const request = result.requests.find(request => request.method === 'thread/start');
  assert.equal(request.params.ephemeral, true);
  assert.equal(request.params.permissions, ':read-only');
  assert.equal(request.params.approvalPolicy, 'on-request');
  assert.match(result.output.at(-1), /No model turn/);
});

test('explicit model check uses matching read-only options and requires a real final reply', async () => {
  const result = await runCheck({ runModel: true });
  assert.equal(result.code, 0);
  const turn = result.requests.find(request => request.method === 'turn/start');
  assert.equal(turn.params.permissions, ':read-only');
  assert.equal(turn.params.approvalPolicy, 'on-request');
  assert.equal(turn.params.effort, 'medium');
  assert.match(result.output.at(-1), /model replied "Codex is ready\."/);
});

test('check stops at failed readiness stages and prints redacted diagnostics', async () => {
  for (const failureAt of ['account/read', 'configRequirements/read', 'thread/start', 'turn/start']) {
    const result = await runCheck({ runModel: true, failureAt });
    assert.equal(result.code, 1);
    assert.match(result.output.at(-1), /failed to load workspace requirements/);
    assert.match(result.output.at(-1), /\[redacted\]/);
    if (failureAt !== 'turn/start') assert.equal(result.requests.some(request => request.method === 'turn/start'), false);
  }
});

test('failed or empty model turns cannot pass even after startup passed', async () => {
  for (const settings of [{ finalStatus: 'failed' }, { answer: '' }, { answer: 'Unexpected reply' }]) {
    const result = await runCheck({ runModel: true, ...settings });
    assert.equal(result.code, 1);
    assert.match(result.output.at(-1), /^FAIL:/);
  }
});

test('checker refuses broader effective permissions and attempted tool use', async () => {
  for (const settings of [{ sandbox: { type: 'readOnly', networkAccess: true } }, { tool: true }]) {
    const result = await runCheck({ runModel: true, ...settings });
    assert.equal(result.code, 1);
    assert.match(result.output.at(-1), /^FAIL:/);
  }
});

test('checker rejects an unexpected approval policy before starting a model turn', async () => {
  for (const approvalPolicy of ['untrusted', 'never']) {
    const result = await runCheck({ runModel: true, approvalPolicy });
    assert.equal(result.code, 1);
    assert.equal(result.requests.some(request => request.method === 'turn/start'), false);
    assert.match(result.output.at(-1), /^FAIL:/);
  }
});

test('silent app-server times out and is cleaned up', async () => {
  const result = await runCheck({ silent: true });
  assert.equal(result.code, 1);
  assert.match(result.output.at(-1), /timed out/);
});
