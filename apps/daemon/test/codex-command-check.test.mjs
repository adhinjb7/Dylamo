import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { inspectCodexCommand } from '../src/codex-command-check.mjs';

const threadId = '00000000-0000-4000-8000-000000000001';
const shell = String.raw`C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe`;
const sample = 'Get-Content -LiteralPath README.md';

async function inspect({ failure, items = [{ type: 'commandExecution', command: `"${shell}" -Command "${sample}"`,
  aggregatedOutput: 'private-output' }] } = {}) {
  const requests = [];
  const output = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let killed = 0;
  child.kill = () => { killed++; child.stdin.end(); child.stdout.end(); child.stderr.end(); };
  const send = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  child.stdin.on('data', data => {
    const request = JSON.parse(data.toString());
    requests.push(request);
    queueMicrotask(() => {
      if (killed || request.id == null || failure === 'silent') return;
      if (failure === request.method) return send({ id: request.id, error: { message: 'secret-error' } });
      if (request.method === 'initialize') return send({ id: request.id, result: {} });
      if (failure === 'interactive') return send({ id: 99, method: 'item/commandExecution/requestApproval', params: { command: 'secret-command' } });
      if (failure === 'home') { child.stderr.write('Could not find home directory secret-path'); return child.emit('exit', 1); }
      if (failure === 'malformed') return child.stdout.write('secret-invalid-json\n');
      send({ id: request.id, result: { thread: { id: threadId, turns: [{ items }] } } });
    });
  });
  const code = await inspectCodexCommand({ threadId, spawnProcess: () => child, log: line => output.push(line),
    timeoutMs: failure === 'silent' ? 5 : 1000, commandEnvironment: { platform: 'win32', windowsRoot: String.raw`C:\WINDOWS` } });
  assert.equal(killed, 1);
  assert.equal(output.join('').includes('secret-'), false);
  assert.equal(output.join('').includes('private-output'), false);
  assert.ok(requests.every(r => ['initialize', 'initialized', 'thread/read'].includes(r.method)));
  return { code, output, requests };
}

test('command inspector only reads existing history and prints a redacted preview', async () => {
  const result = await inspect();
  assert.equal(result.code, 0);
  assert.deepEqual(result.requests.map(r => r.method), ['initialize', 'initialized', 'thread/read']);
  assert.deepEqual(result.requests[2].params, { threadId, includeTurns: true });
  const preview = JSON.parse(result.output[0].slice('Saved command format: '.length));
  assert.equal(preview.shape, '"<system-powershell>" -Command "<configured-command>"');
  assert.equal(preview.matchesCurrentWrapper, true);
});

test('unsupported history command format is observable without being accepted', async () => {
  const result = await inspect({ items: [{ type: 'commandExecution', command: `"${shell}" -Command "& { ${sample} }"` }] });
  assert.equal(result.code, 0, 'inspection success is not an approval-policy pass');
  const preview = JSON.parse(result.output[0].slice('Saved command format: '.length));
  assert.equal(preview.matchesCurrentWrapper, false);
});

test('operator-reported escaped preview now matches the constrained wrapper', async () => {
  const result = await inspect({ items: [{ type: 'commandExecution',
    command: `"${shell.replaceAll('\\', '\\\\')}" -Command '${sample}'` }] });
  assert.equal(result.code, 0);
  const preview = JSON.parse(result.output[0].slice('Saved command format: '.length));
  assert.equal(preview.shape, `"<escaped-system-powershell>" -Command '<configured-command>'`);
  assert.equal(preview.matchesCurrentWrapper, true);
});

test('command inspector handles failure, timeout and unsolicited approval without model or command requests', async () => {
  for (const failure of ['initialize', 'thread/read', 'interactive', 'home', 'malformed', 'silent']) {
    assert.equal((await inspect({ failure })).code, 1, failure);
  }
  assert.equal((await inspect({ items: [{ type: 'agentMessage', text: 'secret-text' }] })).code, 1);
  assert.throws(() => inspectCodexCommand({ threadId: 'not-a-thread' }), /UUID/);
});
