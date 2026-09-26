import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createCodexAgent, CODEX_AGENT_ID } from '../src/codex-agent.mjs';

function fixture(allowFullRead = false) {
  const sent = [];
  const requests = [];
  const errors = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.stdin.end(); child.stdout.end(); child.stderr.end(); };
  let buffered = '';
  child.stdin.on('data', (chunk) => {
    buffered += chunk.toString();
    while (buffered.includes('\n')) {
      const index = buffered.indexOf('\n');
      requests.push(JSON.parse(buffered.slice(0, index)));
      buffered = buffered.slice(index + 1);
    }
  });
  const agent = createCodexAgent({ machineId: randomUUID(), workspace: process.cwd(), allowFullRead,
    send: (event) => { sent.push(event); return true; }, spawnProcess: () => child,
    logger: { error: (message) => errors.push(message) } });
  const start = { type: 'task.start', agentId: CODEX_AGENT_ID,
    sessionId: randomUUID(), taskId: randomUUID(), runId: randomUUID(), prompt: 'Summarize package.json' };
  const reply = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return { agent, sent, requests, errors, child, start, reply, tick, allowFullRead };
}

async function startThread(f) {
  assert.equal(f.agent.receive(f.start), true);
  assert.equal(f.requests[0].method, 'initialize');
  assert.equal(f.requests[0].params.capabilities.experimentalApi, true);
  f.reply({ id: f.requests[0].id, result: {} });
  await f.tick();
  assert.equal(f.requests[1].method, 'initialized');
  assert.equal(f.requests[2].method, 'account/read');
  assert.deepEqual(f.requests[2].params, { refreshToken: false });
  f.reply({ id: f.requests[2].id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
  await f.tick();
  assert.equal(f.requests[3].method, 'configRequirements/read');
  f.reply({ id: f.requests[3].id, result: { requirements: null } });
  await f.tick();
  assert.equal(f.requests[4].method, 'thread/start');
  const threadParams = f.requests[4].params;
  assert.equal(threadParams.approvalPolicy, 'on-request');
  assert.equal(threadParams.sandbox, undefined, 'sandbox must not override the named permissions profile');
  if (f.allowFullRead) {
    assert.equal(threadParams.permissions, ':read-only');
    assert.equal(threadParams.config, undefined);
  } else {
    assert.deepEqual(threadParams.config.permissions[threadParams.permissions], {
      filesystem: { ':minimal': 'read', [process.cwd()]: 'read' }, network: { enabled: false },
    });
  }
  return threadParams;
}

async function startTurn(f) {
  const threadParams = await startThread(f);
  f.reply({ id: f.requests[4].id, result: { thread: { id: 'thread-test' },
    sandbox: { type: 'readOnly', networkAccess: false },
    approvalPolicy: 'on-request', activePermissionProfile: { id: threadParams.permissions, extends: null } } });
  await f.tick();
  assert.equal(f.requests[5].method, 'turn/start');
  assert.equal(f.requests[5].params.approvalPolicy, 'on-request');
  assert.equal(f.requests[5].params.permissions, threadParams.permissions);
  assert.equal(f.requests[5].params.sandboxPolicy, undefined);
  f.reply({ id: f.requests[5].id, result: { turn: { id: 'turn-test' } } });
  await f.tick();
}

test('Codex app-server read-only run persists IDs and completes with final answer', async () => {
  const f = fixture();
  try {
    await startTurn(f);
    f.reply({ method: 'item/completed', params: { threadId: 'thread-test', turnId: 'turn-test',
      item: { type: 'agentMessage', phase: 'final_answer', text: 'The project has three workspaces.' } } });
    f.reply({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status: 'completed' } } });
    await f.tick();
    assert.deepEqual(f.sent.map((event) => event.type), ['agent.progress', 'agent.started', 'agent.message', 'task.completed']);
    assert.equal(f.sent[1].codexThreadId, 'thread-test');
    assert.equal(f.sent[1].codexTurnId, 'turn-test');
    assert.equal(f.sent[3].summary, 'The project has three workspaces.');
  } finally { f.agent.stop(); }
});

test('Codex app-server approval is declined and task fails closed', async () => {
  const f = fixture();
  try {
    await startTurn(f);
    f.reply({ id: 91, method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-test', turnId: 'turn-test', itemId: 'item-1', command: 'git push', cwd: process.cwd(),
    } });
    await f.tick();
    assert.deepEqual(f.requests.at(-1), { id: 91, result: { decision: 'decline' } });
    f.reply({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status: 'completed' } } });
    await f.tick();
    assert.equal(f.sent.at(-1).type, 'task.failed');
    assert.equal(f.sent.some((event) => event.type === 'task.completed'), false);
  } finally { f.agent.stop(); }
});

test('approved full-read mode uses the same built-in read-only policy for thread and turn', async () => {
  const f = fixture(true);
  try { await startTurn(f); } finally { f.agent.stop(); }
});

test('sandboxed repository-read events can complete without an approval response or raw output forwarding', async () => {
  for (const allowFullRead of [false, true]) {
    const f = fixture(allowFullRead);
    try {
      await startTurn(f);
      const requestCount = f.requests.length;
      const params = { threadId: 'thread-test', turnId: 'turn-test' };
      const item = { id: 'read-files', type: 'commandExecution', command: 'rg --files', cwd: process.cwd() };
      f.reply({ method: 'item/started', params: { ...params, item: { ...item, status: 'inProgress' } } });
      f.reply({ method: 'item/completed', params: { ...params,
        item: { ...item, status: 'completed', exitCode: 0, aggregatedOutput: 'private-tool-output' } } });
      f.reply({ method: 'item/completed', params: { ...params,
        item: { type: 'agentMessage', phase: 'final_answer', text: 'The demo summarizes task status.' } } });
      f.reply({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status: 'completed' } } });
      await f.tick();
      assert.equal(f.requests.length, requestCount, 'ordinary tool events must not cause an approval reply');
      assert.equal(f.sent.at(-1).type, 'task.completed');
      assert.equal(f.sent.at(-1).summary, 'The demo summarizes task status.');
      assert.equal(JSON.stringify([f.sent, f.errors]).includes('private-tool-output'), false);
    } finally { f.agent.stop(); }
  }
});

test('on-request still denies file edits, network, extra permissions, and unsupported requests', async () => {
  const cases = [
    { method: 'item/fileChange/requestApproval', params: { grantRoot: process.cwd() }, result: { decision: 'decline' } },
    { method: 'item/commandExecution/requestApproval', params: {
      command: 'rg --files', additionalPermissions: { network: { enabled: true } },
    }, result: { decision: 'decline' } },
    { method: 'item/commandExecution/requestApproval', params: {
      networkApprovalContext: { host: 'example.com', protocol: 'https' },
    }, result: { decision: 'decline' } },
    { method: 'item/permissions/requestApproval', params: {
      permissions: { fileSystem: { write: [process.cwd()] }, network: { enabled: true } },
    }, result: { permissions: {} } },
    { method: 'mcpServer/elicitation/request', params: {}, result: { action: 'decline', content: null } },
    { method: 'unknown/request', params: {}, error: { code: -32601, message: 'Unsupported request' } },
  ];
  for (const allowFullRead of [false, true]) {
    for (const scenario of cases) {
      const f = fixture(allowFullRead);
      try {
        await startTurn(f);
        f.reply({ id: 91, method: scenario.method, params: {
          threadId: 'thread-test', turnId: 'turn-test', itemId: 'item-1', ...scenario.params,
        } });
        await f.tick();
        assert.deepEqual(f.requests.at(-1), scenario.result
          ? { id: 91, result: scenario.result } : { id: 91, error: scenario.error });
        f.reply({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status: 'completed' } } });
        await f.tick();
        assert.equal(f.sent.at(-1).type, 'task.failed');
        assert.equal(f.sent.some(event => event.type === 'task.completed' || event.type === 'agent.message'), false);
      } finally { f.agent.stop(); }
    }
  }
});

test('built-in profile does not accept writable or network-enabled effective permissions', async () => {
  for (const sandbox of [{ type: 'workspaceWrite', networkAccess: false }, { type: 'readOnly', networkAccess: true }, undefined]) {
    const f = fixture(true);
    try {
      await startThread(f);
      f.reply({ id: f.requests[4].id, result: { thread: { id: 'thread-test' },
        approvalPolicy: 'on-request', activePermissionProfile: { id: ':read-only', extends: null }, sandbox } });
      await f.tick();
      assert.equal(f.sent.at(-1).type, 'task.failed');
      assert.equal(f.requests.some(request => request.method === 'turn/start'), false);
    } finally { f.agent.stop(); }
  }
});

test('missing Codex executable produces an actionable failure and a safe local diagnostic', async () => {
  const f = fixture();
  try {
    f.agent.receive(f.start);
    f.child.emit('error', Object.assign(new Error('private process details'), { code: 'ENOENT' }));
    await f.tick();
    assert.equal(f.sent.at(-1).type, 'task.failed');
    assert.match(f.sent.at(-1).reason, /CODEX_COMMAND/);
    assert.match(f.errors[0], /ENOENT/);
    assert.equal(f.errors.join('').includes('private process details'), false);
    f.child.emit('exit', -1);
    assert.equal(f.sent.filter((event) => event.type === 'task.failed').length, 1);
  } finally { f.agent.stop(); }
});

test('rejected startup RPC is diagnosed without logging the raw server error', async () => {
  const f = fixture();
  try {
    await startThread(f);
    f.reply({ id: f.requests[4].id, error: { code: -32602, message: 'private configuration details' } });
    await f.tick();
    assert.equal(f.sent.at(-1).type, 'task.failed');
    assert.match(f.errors[0], /thread\/start; RPC -32602/);
    assert.equal(f.errors.join('').includes('private configuration details'), false);
  } finally { f.agent.stop(); }
});

test('Codex cannot start a turn if the server falls back to a different permissions profile', async () => {
  const f = fixture();
  try {
    await startThread(f);
    f.reply({ id: f.requests[4].id, result: { thread: { id: 'thread-test' },
      approvalPolicy: 'on-request', activePermissionProfile: { id: ':workspace' } } });
    await f.tick();
    assert.equal(f.sent.at(-1).type, 'task.failed');
    assert.match(f.sent.at(-1).reason, /read-only permissions profile/);
    assert.equal(f.requests.some((request) => request.method === 'turn/start'), false);
  } finally { f.agent.stop(); }
});

test('unauthenticated Codex fails before creating a thread', async () => {
  const f = fixture();
  try {
    f.agent.receive(f.start);
    f.reply({ id: f.requests[0].id, result: {} });
    await f.tick();
    f.reply({ id: f.requests[2].id, result: { account: null, requiresOpenaiAuth: true } });
    await f.tick();
    assert.match(f.sent.at(-1).reason, /not signed in/);
    assert.equal(f.requests.some(request => request.method === 'thread/start'), false);
  } finally { f.agent.stop(); }
});

test('workspace-requirements failure stops startup without disclosing upstream details', async () => {
  const f = fixture();
  try {
    f.agent.receive(f.start);
    f.reply({ id: f.requests[0].id, result: {} });
    await f.tick();
    f.reply({ id: f.requests[2].id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
    await f.tick();
    f.reply({ id: f.requests[3].id, error: { code: -32603, message: 'private workspace policy' } });
    await f.tick();
    assert.match(f.sent.at(-1).reason, /workspace requirements/);
    assert.match(f.errors[0], /configRequirements\/read; RPC -32603/);
    assert.equal(f.errors.join('').includes('private workspace policy'), false);
    assert.equal(f.requests.some(request => request.method === 'thread/start'), false);
  } finally { f.agent.stop(); }
});

test('failed turn reports the known workspace-requirements error with safe codes', async () => {
  const f = fixture();
  try {
    await startTurn(f);
    f.reply({ method: 'turn/completed', params: { threadId: 'thread-test', turn: {
      id: 'turn-test', status: 'failed', error: { message: 'failed to load workspace requirements; secret=private',
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } }, additionalDetails: 'private payload' },
    } } });
    await f.tick();
    assert.match(f.sent.at(-1).reason, /workspace requirements/);
    assert.match(f.errors[0], /httpConnectionFailed; HTTP 503/);
    assert.equal(JSON.stringify([f.sent, f.errors]).includes('private'), false);
    assert.equal(f.sent.filter(event => event.type === 'task.failed').length, 1);
  } finally { f.agent.stop(); }
});

test('retry errors are nonterminal, preserve diagnostics on failure, and allow recovery', async () => {
  for (const status of ['completed', 'failed']) {
    const f = fixture();
    try {
      await startTurn(f);
      f.reply({ method: 'error', params: { threadId: 'unrelated', turnId: 'turn-test',
        error: { message: 'failed to load workspace requirements' }, willRetry: true } });
      f.reply({ method: 'error', params: { threadId: 'thread-test', turnId: 'turn-test',
        error: { message: 'private limit details', codexErrorInfo: 'usageLimitExceeded' }, willRetry: true } });
      await f.tick();
      assert.equal(f.sent.at(-1).type, 'agent.started');
      f.reply({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status } } });
      await f.tick();
      assert.equal(f.sent.at(-1).type, `task.${status}`);
      if (status === 'failed') assert.match(f.sent.at(-1).reason, /usage or rate limit/);
      else assert.equal(f.errors.length, 0);
    } finally { f.agent.stop(); }
  }
});
