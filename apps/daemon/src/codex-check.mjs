import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { CODEX_INITIALIZE_PARAMS, CODEX_ACCOUNT_PARAMS, codexAccountFailure,
  createCodexTurnOptions, hasExpectedCodexPermissions, startupErrorMessage } from './codex-session.mjs';

export const CODEX_CHECK_REPLY = 'Codex is ready.';

// No generation by default. runModel explicitly opts into a single short turn.
export function checkCodex({ command = 'codex', options, runModel = false,
  spawnProcess = spawn, log = console.log, environment = process.env,
  timeoutMs = runModel ? 90_000 : 30_000 }) {
  return new Promise((resolve) => {
    let child;
    let lines;
    let finished = false;
    let threadId;
    let turnId;
    let answer = '';
    let lastError;
    let stage = 'initialize';
    const timer = setTimeout(() => finish(`FAIL: ${stage} timed out.`, 1), timeoutMs);

    function finish(message, code) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      log(message);
      lines?.close();
      child?.kill();
      resolve(code);
    }

    function fail(name, error) {
      const code = Number.isInteger(error?.code) ? ` (${error.code})` : '';
      finish(`FAIL: ${name}${code}: ${startupErrorMessage(error)}`, 1);
    }

    function send(message) {
      if (finished) return;
      try { child.stdin.write(`${JSON.stringify(message)}\n`); }
      catch (error) { fail('Codex communication', error); }
    }

    function request(id, method, params) {
      stage = method;
      send({ id, method, params });
    }

    function handle(message) {
      if (finished) return;
      if (message.id != null && message.method) {
        send({ id: message.id, error: { code: -32601, message: 'No interactive actions during diagnostic' } });
        finish('FAIL: Codex requested an interactive action during the diagnostic.', 1);
        return;
      }
      if (message.id === 1) {
        if (message.error) { fail('initialize', message.error); return; }
        send({ method: 'initialized', params: {} });
        request(2, 'account/read', CODEX_ACCOUNT_PARAMS);
      } else if (message.id === 2) {
        if (message.error) { fail('account/read', message.error); return; }
        const reason = codexAccountFailure(message.result);
        if (reason) { finish(`FAIL: ${reason}`, 1); return; }
        log('PASS: account-readiness check.');
        request(3, 'configRequirements/read', {});
      } else if (message.id === 3) {
        if (message.error) { fail('configRequirements/read', message.error); return; }
        if (!message.result || !Object.hasOwn(message.result, 'requirements')) {
          finish('FAIL: Codex returned an invalid configuration-requirements result.', 1);
          return;
        }
        log('PASS: configuration-requirements check (not a model-generation test).');
        request(4, 'thread/start', { ...options, ephemeral: true });
      } else if (message.id === 4) {
        if (message.error) { fail('thread/start', message.error); return; }
        if (!hasExpectedCodexPermissions(message.result, options) || typeof message.result?.thread?.id !== 'string') {
          finish('FAIL: Codex did not confirm a session with the required permissions.', 1);
          return;
        }
        if (!runModel) {
          finish('PASS: Codex created a session with the required permissions profile. No model turn was started.', 0);
          return;
        }
        threadId = message.result.thread.id;
        log('PASS: requested permissions profile. Testing a short model reply now...');
        request(5, 'turn/start', createCodexTurnOptions(options, threadId,
          `Reply with exactly: ${CODEX_CHECK_REPLY} Do not use any tools, inspect files, or make changes.`));
      } else if (message.id === 5) {
        if (message.error) { fail('turn/start', message.error); return; }
        turnId = message.result?.turn?.id;
        if (typeof turnId !== 'string') { finish('FAIL: Codex returned an invalid turn result.', 1); return; }
        stage = 'model response';
      } else if (runModel && threadId) {
        const params = message.params ?? {};
        if (params.threadId && params.threadId !== threadId) return;
        if (params.turnId && turnId && params.turnId !== turnId) return;
        if (message.method === 'error' && params.error) lastError = params.error;
        if (message.method === 'item/started' && ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabToolCall', 'webSearch'].includes(params.item?.type)) {
          finish('FAIL: Codex attempted tool use during the reply-only test.', 1);
          return;
        }
        if (message.method === 'item/completed' && params.item?.type === 'agentMessage' && params.item.phase !== 'commentary') {
          answer = params.item.text?.trim() ?? '';
        }
        if (message.method === 'turn/completed' && params.turn?.id === turnId) {
          if (params.turn.status !== 'completed') {
            fail('model response', params.turn.error ?? lastError ?? { message: 'Turn did not complete.' });
          } else if (answer !== CODEX_CHECK_REPLY) {
            finish('FAIL: model finished without the expected diagnostic reply.', 1);
          } else {
            finish(`PASS: model replied "${CODEX_CHECK_REPLY}" No phone call was made.`, 0);
          }
        }
      }
    }

    log(runModel ? 'Checking Codex including one short model turn (uses Codex quota; no phone call)...'
      : 'Checking Codex startup (no model turn or phone call)...');
    try {
      child = spawnProcess(command, ['app-server'], { cwd: options.cwd, env: environment,
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.on('error', (error) => fail('Codex launch', error));
      child.stdin.on('error', (error) => fail('Codex communication', error));
      // Drain stderr without exposing arbitrary headers, file contents, or tokens.
      let missingHome = false;
      child.stderr?.on('data', data => { if (data.toString().includes('Could not find home directory')) missingHome = true; });
      child.on('exit', code => {
        if (!finished) finish(missingHome ? 'FAIL: Codex could not find its home directory. Run this check in your regular terminal.'
          : `FAIL: Codex exited (${Number.isInteger(code) ? code : 'unknown'}) during ${stage}.`, 1);
      });
      lines = readline.createInterface({ input: child.stdout });
      lines.on('line', line => {
        if (finished) return;
        try { handle(JSON.parse(line)); }
        catch { finish('FAIL: Codex returned an invalid diagnostic message.', 1); }
      });
      request(1, 'initialize', CODEX_INITIALIZE_PARAMS);
    } catch (error) { fail('Codex launch', error); }
  });
}
