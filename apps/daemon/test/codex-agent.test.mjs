import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createCodexAgent, CODEX_AGENT_ID } from '../src/codex-agent.mjs';
import { DemoPushSafetyError } from '../src/git-push-safety.mjs';

function fixture(allowFullRead = false, options = {}) {
  const sent = [];
  const requests = [];
  const errors = [];
  const launches = [];
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
    send: (event) => { sent.push(event); return true; }, spawnProcess: (...args) => { launches.push(args); return child; },
    logger: { error: (message) => errors.push(message) },
    inspectPushState: () => ({ head: 'a'.repeat(40), pushUrl: 'fixture-origin', localTarget: null }),
    verifyPushResult: () => true, ...options });
  const start = { type: 'task.start', agentId: CODEX_AGENT_ID,
    sessionId: randomUUID(), taskId: randomUUID(), runId: randomUUID(), prompt: 'Summarize package.json' };
  const reply = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return { agent, sent, requests, errors, child, start, reply, tick, allowFullRead,
    allowWorkspaceWrite: options.allowWorkspaceWrite === true, launches };
}

async function startThread(f, method = 'thread/start') {
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
  if (f.requests.at(-1).method === 'config/read') {
    f.reply({ id: f.requests.at(-1).id, result: { config: {
      mcp_servers: { privateService: { enabled: true, command: 'not-run' } }, plugins: { 'demo@local': { enabled: true } },
    } } });
    await f.tick();
    assert.equal(f.requests.at(-1).params.config.features.apps, false);
    assert.equal(f.requests.at(-1).params.config.features.plugins, false);
    assert.equal(f.requests.at(-1).params.config.features.multi_agent, false);
    assert.equal(f.requests.at(-1).params.config.web_search, 'disabled');
    assert.deepEqual(f.requests.at(-1).params.config.mcp_servers.privateService, { enabled: false });
    assert.deepEqual(f.requests.at(-1).params.config.plugins['demo@local'], { enabled: false });
  }
  assert.equal(f.requests.at(-1).method, method);
  const threadParams = f.requests.at(-1).params;
  assert.equal(threadParams.approvalPolicy, 'on-request');
  assert.equal(threadParams.sandbox, undefined, 'sandbox must not override the named permissions profile');
  if (f.allowWorkspaceWrite) {
    const profile = threadParams.config.permissions[threadParams.permissions];
    assert.equal(profile.extends, ':workspace');
    assert.equal(profile.filesystem[':workspace_roots']['.'], 'write');
    assert.equal(profile.network.enabled, false);
  } else if (f.allowFullRead) {
    assert.equal(threadParams.permissions, ':read-only');
    if (!threadParams.approvalsReviewer) assert.equal(threadParams.config, undefined);
  } else {
    assert.deepEqual(threadParams.config.permissions[threadParams.permissions], {
      filesystem: { ':minimal': 'read', [process.cwd()]: 'read' }, network: { enabled: false },
    });
  }
  return threadParams;
}

async function startTurn(f) {
  const threadParams = await startThread(f);
  f.reply({ id: f.requests.at(-1).id, result: { thread: { id: 'thread-test' },
    sandbox: { type: f.allowWorkspaceWrite ? 'workspaceWrite' : 'readOnly', networkAccess: false },
    approvalsReviewer: 'user',
    approvalPolicy: 'on-request', activePermissionProfile: { id: threadParams.permissions,
      extends: f.allowWorkspaceWrite ? ':workspace' : null } } });
  await f.tick();
  assert.equal(f.requests.at(-1).method, 'turn/start');
  assert.equal(f.requests.at(-1).params.approvalPolicy, 'on-request');
  assert.equal(f.requests.at(-1).params.permissions, threadParams.permissions);
  assert.equal(f.requests.at(-1).params.sandboxPolicy, undefined);
  f.reply({ id: f.requests.at(-1).id, result: { turn: { id: 'turn-test' } } });
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

test('opt-in workspace editing starts with a bounded profile but cannot auto-approve a protected command', async () => {
  const f = fixture(false, { allowWorkspaceWrite: true });
  try {
    await startTurn(f);
    assert.equal(f.requests.find(request => request.method === 'turn/start').params.permissions,
      f.requests.find(request => request.method === 'thread/start').params.permissions);
    f.reply({ id: 91, method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-test', turnId: 'turn-test', itemId: 'item-1', command: 'git push', cwd: process.cwd(),
    } });
    await f.tick();
    assert.deepEqual(f.requests.at(-1), { id: 91, result: { decision: 'decline' } });
    f.reply({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status: 'completed' } } });
    await f.tick();
    assert.equal(f.sent.at(-1).type, 'task.failed');
  } finally { f.agent.stop(); }
});

test('protected-action mode stops on an unexpected external or delegated tool item', async () => {
  for (const type of ['mcpToolCall', 'dynamicToolCall', 'collabToolCall', 'webSearch']) {
    const f = fixture(true, { approvalCommand: 'git push origin HEAD:refs/heads/phone-demo' });
    try {
      await startTurn(f);
      f.reply({ method: 'item/started', params: { threadId: 'thread-test', turnId: 'turn-test',
        item: { type, id: 'unexpected-tool' } } });
      await f.tick();
      assert.equal(f.sent.at(-1).type, 'task.failed');
      assert.match(f.sent.at(-1).reason, /external or delegated tool/);
      assert.equal(f.sent.some(event => event.type === 'task.completed'), false);
    } finally { f.agent.stop(); }
  }
});

test('a correlated cancel stops the Codex run without reporting success', async () => {
  const f = fixture();
  try {
    await startTurn(f);
    const cancel = { type: 'task.cancel', machineId: f.sent[0].machineId,
      sessionId: f.start.sessionId, taskId: f.start.taskId, runId: f.start.runId };
    assert.equal(f.agent.receive({ ...cancel, taskId: randomUUID() }), false);
    assert.equal(f.agent.receive(cancel), true);
    assert.equal(f.sent.at(-1).type, 'task.cancelled');
    assert.equal(f.agent.receive(cancel), false);
    assert.equal(f.sent.some(event => event.type === 'task.completed'), false);
  } finally { f.agent.stop(); }
});

test('steering targets only the active turn and reports the app-server acknowledgment', async () => {
  const f = fixture();
  try {
    await startTurn(f);
    const steer = { type: 'task.steer', eventId: randomUUID(), machineId: f.sent[0].machineId,
      sessionId: f.start.sessionId, taskId: f.start.taskId, runId: f.start.runId,
      prompt: 'Focus on failing tests first.' };
    assert.equal(f.agent.receive({ ...steer, taskId: randomUUID() }), false);
    assert.equal(f.agent.receive(steer), true);
    const request = f.requests.at(-1);
    assert.equal(request.method, 'turn/steer');
    assert.deepEqual(request.params, { threadId: 'thread-test', expectedTurnId: 'turn-test',
      input: [{ type: 'text', text: steer.prompt }] });
    f.reply({ id: request.id, result: { turnId: 'turn-test' } });
    await f.tick();
    assert.equal(f.sent.at(-1).type, 'task.steer.result');
    assert.equal(f.sent.at(-1).requestEventId, steer.eventId);
    assert.equal(f.sent.at(-1).accepted, true);

    const changed = { ...steer, eventId: randomUUID(), prompt: 'Check the README first.' };
    assert.equal(f.agent.receive(changed), true);
    f.reply({ id: f.requests.at(-1).id, result: { turnId: 'other-turn' } });
    await f.tick();
    assert.equal(f.sent.at(-1).accepted, false, 'a different turn cannot confirm a steer');
    assert.equal(f.sent.at(-1).requestEventId, changed.eventId);
    assert.equal(f.requests.filter((item) => item.method === 'turn/start').length, 1,
      'steering must not start another turn');
  } finally { f.agent.stop(); }
});

test('steering before a Codex turn exists is declined without starting another turn', () => {
  const f = fixture();
  try {
    assert.equal(f.agent.receive(f.start), true);
    const steer = { type: 'task.steer', eventId: randomUUID(), machineId: f.sent[0].machineId,
      sessionId: f.start.sessionId, taskId: f.start.taskId, runId: f.start.runId,
      prompt: 'Focus on tests.' };
    assert.equal(f.agent.receive(steer), true);
    assert.equal(f.sent.at(-1).type, 'task.steer.result');
    assert.equal(f.sent.at(-1).accepted, false);
    assert.equal(f.requests.some((request) => request.method === 'turn/steer'), false);
  } finally { f.agent.stop(); }
});

test('Codex resumes the prior thread for a follow-up and starts a new read-only turn', async () => {
  const f = fixture(true);
  f.start.codexThreadId = 'thread-test';
  try {
    const threadParams = await startThread(f, 'thread/resume');
    assert.equal(threadParams.threadId, 'thread-test');
    assert.equal(threadParams.permissions, ':read-only');
    assert.equal(threadParams.serviceName, undefined);
    f.reply({ id: f.requests[4].id, result: { thread: { id: 'thread-test' },
      sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'on-request',
      activePermissionProfile: { id: ':read-only', extends: null } } });
    await f.tick();
    assert.equal(f.requests[5].method, 'turn/start');
    assert.equal(f.requests[5].params.threadId, 'thread-test');
    assert.equal(f.requests[5].params.permissions, ':read-only');
    assert.deepEqual(f.requests[5].params.input, [{ type: 'text', text: f.start.prompt }]);
    f.reply({ id: f.requests[5].id, result: { turn: { id: 'turn-follow-up' } } });
    await f.tick();
    assert.equal(f.sent.at(-1).codexThreadId, 'thread-test');
    assert.equal(f.sent.at(-1).codexTurnId, 'turn-follow-up');
    f.reply({ method: 'item/completed', params: { threadId: 'thread-test', turnId: 'turn-follow-up',
      item: { type: 'agentMessage', phase: 'final_answer', text: 'Here is the follow-up answer.' } } });
    f.reply({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-follow-up', status: 'completed' } } });
    await f.tick();
    assert.equal(f.sent.at(-1).type, 'task.completed');
  } finally { f.agent.stop(); }
});

test('Codex refuses a resume response for the wrong thread', async () => {
  const f = fixture(true);
  f.start.codexThreadId = 'thread-test';
  try {
    await startThread(f, 'thread/resume');
    f.reply({ id: f.requests[4].id, result: { thread: { id: 'other-thread' },
      sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'on-request',
      activePermissionProfile: { id: ':read-only', extends: null } } });
    await f.tick();
    assert.equal(f.sent.at(-1).type, 'task.failed');
    assert.equal(f.requests.some((request) => request.method === 'turn/start'), false);
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
    assert.match(f.sent.at(-1).reason, /required permissions profile/);
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

test('real command approval stays paused and accepts only the exact decision once', async () => {
  const command = 'git push origin HEAD:refs/heads/phone-demo';
  const f = fixture(true, { approvalCommand: command });
  try {
    await startTurn(f);
    f.reply({ id: 91, method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-test', turnId: 'turn-test', itemId: 'protected-push', command, cwd: pathToFileURL(process.cwd()).href,
    } });
    await f.tick();
    const approval = f.sent.at(-1);
    assert.equal(approval.type, 'approval.required');
    assert.equal(approval.actionKind, 'local-demo-push');
    assert.equal(f.requests.some(request => request.id === 91), false, 'no response before the phone decision');
    const response = { ...approval, type: 'approval.response', approved: true };
    assert.equal(f.agent.receive({ ...response, actionDigest: '0'.repeat(64) }), false);
    assert.equal(f.agent.receive(response), true);
    assert.equal(f.agent.receive(response), false);
    assert.deepEqual(f.requests.filter(request => request.id === 91), [{ id: 91, result: { decision: 'accept' } }]);
    f.reply({ method: 'item/completed', params: { threadId: 'thread-test', turnId: 'turn-test',
      item: { id: 'protected-push', type: 'commandExecution', status: 'completed', exitCode: 0 } } });
    f.reply({ method: 'item/completed', params: { threadId: 'thread-test', turnId: 'turn-test',
      item: { type: 'agentMessage', phase: 'final_answer', text: 'The protected push completed.' } } });
    f.reply({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status: 'completed' } } });
    await f.tick();
    assert.equal(f.sent.at(-1).type, 'task.completed');
    assert.equal(f.sent.at(-1).summary, 'Done. The prepared changes are published to the local demo branch.');
    assert.equal(f.agent.receive(f.start), false, 'a replayed task must not start another Codex process');
  } finally { f.agent.stop(); }
});

test('a zero-exit demo push is not reported complete without the expected remote ref', async () => {
  const command = 'git push origin HEAD:refs/heads/phone-demo';
  const f = fixture(true, { approvalCommand: command,
    verifyPushResult: () => { throw new DemoPushSafetyError('Destination ref missing'); } });
  try {
    await startTurn(f);
    f.reply({ id: 91, method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-test', turnId: 'turn-test', itemId: 'protected-push', command, cwd: process.cwd(),
    } });
    await f.tick();
    const approval = f.sent.at(-1);
    assert.equal(approval.type, 'approval.required');
    assert.equal(f.agent.receive({ ...approval, type: 'approval.response', approved: true }), true);
    f.reply({ method: 'item/completed', params: { threadId: 'thread-test', turnId: 'turn-test',
      item: { id: 'protected-push', type: 'commandExecution', status: 'completed', exitCode: 0 } } });
    f.reply({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status: 'completed' } } });
    await f.tick();
    assert.equal(f.sent.at(-1).type, 'task.failed');
    assert.match(f.sent.at(-1).reason, /destination ref could not be verified/);
    assert.equal(f.sent.some(event => event.type === 'task.completed'), false);
  } finally { f.agent.stop(); }
});

test('demo push cannot be approved after HEAD or origin changes while the callback is pending', async () => {
  for (const changed of [
    { head: 'b'.repeat(40), pushUrl: 'fixture-origin', localTarget: null },
    { head: 'a'.repeat(40), pushUrl: 'different-origin', localTarget: null },
  ]) {
    let reads = 0;
    const f = fixture(true, { approvalCommand: 'git push origin HEAD:refs/heads/phone-demo',
      inspectPushState: () => ++reads === 1
        ? { head: 'a'.repeat(40), pushUrl: 'fixture-origin', localTarget: null } : changed });
    try {
      await startTurn(f);
      f.reply({ id: 91, method: 'item/commandExecution/requestApproval', params: {
        threadId: 'thread-test', turnId: 'turn-test', itemId: 'protected-push',
        command: 'git push origin HEAD:refs/heads/phone-demo', cwd: process.cwd(),
      } });
      await f.tick();
      const approval = f.sent.at(-1);
      assert.equal(approval.type, 'approval.required');
      assert.equal(f.agent.receive({ ...approval, type: 'approval.response', approved: true }), true);
      assert.deepEqual(f.requests.filter(request => request.id === 91), [{ id: 91, result: { decision: 'cancel' } }]);
      assert.equal(f.sent.at(-1).type, 'task.failed');
      assert.match(f.sent.at(-1).reason, /changed while approval was pending/);
    } finally { f.agent.stop(); }
  }
});

test('dirty or unverifiable demo push state fails before a phone approval is offered', async () => {
  const f = fixture(true, { approvalCommand: 'git push origin HEAD:refs/heads/phone-demo',
    inspectPushState: () => { throw new DemoPushSafetyError('The demo push is blocked: the repository has uncommitted or untracked files.'); } });
  try {
    await startTurn(f);
    f.reply({ id: 91, method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-test', turnId: 'turn-test', itemId: 'protected-push',
      command: 'git push origin HEAD:refs/heads/phone-demo', cwd: process.cwd(),
    } });
    await f.tick();
    assert.equal(f.sent.some(event => event.type === 'approval.required'), false);
    assert.deepEqual(f.requests.filter(request => request.id === 91), [{ id: 91, result: { decision: 'decline' } }]);
    assert.equal(f.sent.at(-1).type, 'task.failed');
    assert.match(f.sent.at(-1).reason, /uncommitted or untracked/);
  } finally { f.agent.stop(); }
});

test('demo push shortcuts send the exact configured action but still wait for rejection', async () => {
  const command = 'git push origin HEAD:refs/heads/phone-demo';
  for (const spokenPrompt of ['Run the demo push.', 'Push the demo repo.']) {
    const f = fixture(true, { approvalCommand: command });
    f.start.prompt = spokenPrompt;
    try {
      await startTurn(f);
      const prompt = f.requests.find(request => request.method === 'turn/start').params.input[0].text;
      assert.ok(prompt.includes(command), 'the model receives the literal configured command, not spoken punctuation');
      assert.match(prompt, /not approval/i);
      assert.match(prompt, /Do not modify or commit files/);
      assert.equal(f.sent.some(event => event.type === 'approval.required'), false);
      f.reply({ id: 91, method: 'item/commandExecution/requestApproval', params: {
        threadId: 'thread-test', turnId: 'turn-test', itemId: 'protected-push', command, cwd: process.cwd(),
      } });
      await f.tick();
      const approval = f.sent.at(-1);
      assert.equal(approval.type, 'approval.required');
      assert.equal(f.requests.some(request => request.id === 91), false, 'shortcut is not authorization');
      assert.equal(f.agent.receive({ ...approval, type: 'approval.response', approved: false }), true);
      assert.deepEqual(f.requests.filter(request => request.id === 91), [{ id: 91, result: { decision: 'cancel' } }]);
      assert.equal(f.sent.at(-1).type, 'task.failed');
      assert.equal(f.requests.some(request => request.result?.decision === 'accept'), false);
    } finally { f.agent.stop(); }
  }
});

test('demo push shortcut fails before launching Codex when its command is not configured', () => {
  for (const approvalCommand of [undefined, 'git push origin HEAD:refs/heads/main']) {
    const f = fixture(true, { approvalCommand });
    f.start.prompt = 'Please run the demo push!';
    try {
      assert.equal(f.agent.receive(f.start), true);
      assert.equal(f.launches.length, 0);
      assert.equal(f.requests.length, 0);
      assert.equal(f.sent.at(-1).type, 'task.failed');
      assert.match(f.sent.at(-1).reason, /demo push shortcut is not configured/);
      assert.deepEqual(f.agent.activeRunIds(), []);
      assert.equal(f.agent.receive(f.start), false, 'failed shortcut is deduplicated too');
    } finally { f.agent.stop(); }
  }
});

test('demo push shortcut cannot turn a model success claim without approval into success', async () => {
  const f = fixture(true, { approvalCommand: 'git push origin HEAD:refs/heads/phone-demo' });
  f.start.prompt = 'Run the demo push.';
  try {
    await startTurn(f);
    f.reply({ method: 'item/completed', params: { threadId: 'thread-test', turnId: 'turn-test',
      item: { type: 'agentMessage', phase: 'final_answer', text: 'The push succeeded!' } } });
    f.reply({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status: 'completed' } } });
    await f.tick();
    assert.equal(f.sent.at(-1).type, 'task.failed');
    assert.match(f.sent.at(-1).reason, /did not reach a verified approval request/);
    assert.equal(f.sent.some(event => ['agent.message', 'task.completed', 'approval.required'].includes(event.type)), false);
  } finally { f.agent.stop(); }
});

test('demo push shortcut never relaxes command, workspace or runtime identity checks', async () => {
  const command = 'git push origin HEAD:refs/heads/phone-demo';
  for (const change of [{ command: 'git push origin head:refs/head/phone-demo' },
    { command: `${command}; echo extra` }, { cwd: `${process.cwd()}/elsewhere` }, { turnId: 'wrong-turn' }]) {
    const f = fixture(true, { approvalCommand: command });
    f.start.prompt = 'Run the demo push.';
    try {
      await startTurn(f);
      f.reply({ id: 91, method: 'item/commandExecution/requestApproval', params: {
        threadId: 'thread-test', turnId: 'turn-test', itemId: 'protected-push', command, cwd: process.cwd(), ...change,
      } });
      await f.tick();
      assert.deepEqual(f.requests.filter(request => request.id === 91), [{ id: 91, result: { decision: 'decline' } }]);
      assert.equal(f.sent.some(event => event.type === 'approval.required'), false);
    } finally { f.agent.stop(); }
  }
});

test('protected-mode rejection reports a safe local diagnostic but never sends it to the caller', async () => {
  const diagnostics = [];
  const f = fixture(true, { approvalCommand: 'git push origin phone-demo',
    onApprovalDiagnostic: diagnostic => diagnostics.push(diagnostic) });
  try {
    await startTurn(f);
    f.reply({ id: 91, method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-test', turnId: 'turn-test', itemId: 'protected-push',
      command: 'powershell.exe -Command "private command"', cwd: pathToFileURL(process.cwd()).href,
      reason: 'private reason',
    } });
    await f.tick();
    assert.deepEqual(f.requests.at(-1), { id: 91, result: { decision: 'decline' } });
    assert.deepEqual(diagnostics.map(({ commandPreview, ...classification }) => classification), [{ code: 'command-mismatch', requestType: 'command',
      commandForm: 'powershell-wrapper', cwdForm: 'file-url', cwdMatches: true }]);
    assert.equal(diagnostics[0].commandPreview.shape, 'powershell.exe -Command "<other> <other>"');
    f.reply({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status: 'completed' } } });
    await f.tick();
    assert.match(f.errors.at(-1), /approval command-mismatch/);
    assert.equal(JSON.stringify([f.sent, f.errors, diagnostics]).includes('private'), false);
    assert.equal(JSON.stringify(f.sent).includes('command-mismatch'), false);
  } finally { f.agent.stop(); }
});

test('rejection and expiration cancel the real pending request without acceptance', async () => {
  for (const mode of ['reject', 'expire', 'runtime-cleared']) {
    const command = 'git push origin HEAD:refs/heads/phone-demo';
    const f = fixture(true, { approvalCommand: command, approvalTimeoutMs: mode === 'expire' ? 20 : 300_000 });
    try {
      await startTurn(f);
      f.reply({ id: 91, method: 'item/commandExecution/requestApproval', params: {
        threadId: 'thread-test', turnId: 'turn-test', itemId: 'protected-push', command, cwd: process.cwd(),
      } });
      await f.tick();
      if (mode === 'reject') f.agent.receive({ ...f.sent.at(-1), type: 'approval.response', approved: false });
      if (mode === 'expire') await new Promise(resolve => setTimeout(resolve, 40));
      if (mode === 'runtime-cleared') {
        f.reply({ method: 'serverRequest/resolved', params: { threadId: 'thread-test', requestId: 91 } });
        await f.tick();
      }
      assert.equal(f.sent.at(-1).type, 'task.failed');
      assert.equal(f.requests.some(request => request.result?.decision === 'accept'), false);
      assert.equal(f.requests.filter(request => request.id === 91).length, 1);
    } finally { f.agent.stop(); }
  }
});

test('approved action requires a matching successful tool result, not merely model-reported success', async () => {
  for (const outcome of ['failed', 'missing', 'wrong-item']) {
    const command = 'git push origin HEAD:refs/heads/phone-demo';
    const f = fixture(true, { approvalCommand: command });
    try {
      await startTurn(f);
      f.reply({ id: 91, method: 'item/commandExecution/requestApproval', params: {
        threadId: 'thread-test', turnId: 'turn-test', itemId: 'protected-push', command, cwd: process.cwd(),
      } });
      await f.tick();
      assert.equal(f.agent.receive({ ...f.sent.at(-1), type: 'approval.response', approved: true }), true);
      if (outcome !== 'missing') f.reply({ method: 'item/completed', params: { threadId: 'thread-test', turnId: 'turn-test',
        item: { id: outcome === 'wrong-item' ? 'other-command' : 'protected-push', type: 'commandExecution',
          status: outcome === 'failed' ? 'failed' : 'completed', exitCode: outcome === 'failed' ? 1 : 0 } } });
      f.reply({ method: 'item/completed', params: { threadId: 'thread-test', turnId: 'turn-test',
        item: { type: 'agentMessage', phase: 'final_answer', text: 'The push succeeded!' } } });
      f.reply({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status: 'completed' } } });
      await f.tick();
      assert.equal(f.sent.at(-1).type, 'task.failed');
      assert.equal(f.sent.some(event => event.type === 'agent.message'), false);
    } finally { f.agent.stop(); }
  }
});

test('protected actions refuse automatic approval reviewers before starting a model turn', async () => {
  const f = fixture(true, { approvalCommand: 'git push origin phone-demo' });
  try {
    const threadParams = await startThread(f);
    assert.equal(threadParams.approvalsReviewer, 'user');
    f.reply({ id: f.requests.at(-1).id, result: { thread: { id: 'thread-test' },
      sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review', activePermissionProfile: { id: ':read-only', extends: null } } });
    await f.tick();
    assert.equal(f.sent.at(-1).type, 'task.failed');
    assert.equal(f.requests.some(request => request.method === 'turn/start'), false);
  } finally { f.agent.stop(); }
});

test('the spawned runtime does not inherit telephony keys or the voice API key', () => {
  const f = fixture(true, { approvalCommand: 'git push origin phone-demo', processEnv: {
    PATH: 'runtime-path', TWILIO_AUTH_TOKEN: 'secret', DAEMON_TOKEN: 'secret', DAEMON_CREDENTIALS: 'secret',
    OPENAI_API_KEY: 'voice-secret', DEMO_PIN_HASH: 'secret', USERPROFILE: 'local-user',
  } });
  try {
    f.agent.receive(f.start);
    assert.deepEqual(f.launches[0][2].env, { PATH: 'runtime-path', USERPROFILE: 'local-user' });
    assert.deepEqual(f.launches[0][1], ['-c', 'features.apps=false', '-c', 'features.plugins=false',
      '-c', 'features.multi_agent=false', '-c', 'web_search=disabled', 'app-server']);
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
