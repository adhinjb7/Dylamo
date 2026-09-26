import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { PROTOCOL_VERSION } from '@hack-atlantic/protocol';
import { CODEX_INITIALIZE_PARAMS, CODEX_ACCOUNT_PARAMS, codexAccountFailure, codexFailureDetails, createCodexSessionOptions, createCodexTurnOptions, hasExpectedCodexPermissions } from './codex-session.mjs';

export const CODEX_AGENT_ID = '00000000-0000-4000-8000-000000000008';
const STARTUP_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 10 * 60_000;

// P0.8 is deliberately read-only. A later slice must add a real, exact-action
// approval bridge before this adapter can perform protected side effects.
export function createCodexAgent({ machineId, send, workspace, command = 'codex', model = 'gpt-6-sol', allowFullRead = false, spawnProcess = spawn, logger = console }) {
  const sessionOptions = createCodexSessionOptions({ workspace, model, allowFullRead });
  const { cwd } = sessionOptions;
  const runs = new Map();
  const pending = [];

  function flush() {
    while (pending.length && send(pending[0])) pending.shift();
  }

  function emit(run, type, fields) {
    pending.push({ v: PROTOCOL_VERSION, eventId: randomUUID(), machineId,
      sessionId: run.sessionId, taskId: run.taskId, runId: run.runId, type, ...fields });
    flush();
  }

  function write(run, message) {
    if (!run.process?.stdin?.writable) throw new Error('Codex app server is unavailable');
    run.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(run, method, params) {
    const id = ++run.nextId;
    write(run, { id, method, params });
    return id;
  }

  function finish(run, type, fields) {
    if (run.finished) return;
    run.finished = true;
    clearTimeout(run.timer);
    if (type === 'task.failed') {
      // Diagnostics stay local and contain only our own messages and error codes.
      // Do not log raw RPC errors, stderr, prompts, or credentials.
      logger.error(`Codex task failed (${run.stage}${run.diagnostic ? `; ${run.diagnostic}` : ''}): ${fields.reason}`);
    }
    emit(run, type, fields);
    run.process?.kill();
    runs.delete(run.runId);
  }

  function handle(run, message) {
    if (run.finished || !message || typeof message !== 'object') return;
    if (message.id != null && message.method) {
      // App-server initiated approval and elicitation requests fail closed.
      const decision = message.method === 'item/commandExecution/requestApproval' ||
        message.method === 'item/fileChange/requestApproval'
        ? { decision: 'decline' }
        : message.method === 'item/permissions/requestApproval'
          ? { permissions: {} }
          : message.method === 'mcpServer/elicitation/request'
            ? { action: 'decline', content: null }
            : null;
      if (decision) write(run, { id: message.id, result: decision });
      else write(run, { id: message.id, error: { code: -32601, message: 'Unsupported request' } });
      run.deniedRequest = true;
      return;
    }
    if (message.id === run.initializeId) {
      if (message.error) {
        run.diagnostic = rpcErrorCode(message.error);
        return finish(run, 'task.failed', { reason: 'Codex initialization failed.' });
      }
      write(run, { method: 'initialized', params: {} });
      run.stage = 'account/read';
      run.accountRequestId = request(run, 'account/read', CODEX_ACCOUNT_PARAMS);
      return;
    }
    if (message.id === run.accountRequestId) {
      const reason = message.error ? 'Codex account-readiness check failed.' : codexAccountFailure(message.result);
      if (reason) {
        run.diagnostic = message.error ? rpcErrorCode(message.error) : null;
        return finish(run, 'task.failed', { reason });
      }
      run.stage = 'configRequirements/read';
      run.requirementsRequestId = request(run, 'configRequirements/read', {});
      return;
    }
    if (message.id === run.requirementsRequestId) {
      if (message.error || !message.result || !Object.hasOwn(message.result, 'requirements')) {
        run.diagnostic = rpcErrorCode(message.error);
        return finish(run, 'task.failed', { reason: 'Codex could not load workspace requirements. The repository investigation did not start.' });
      }
      run.stage = run.resumeThreadId ? 'thread/resume' : 'thread/start';
      const { serviceName, ...resumeOptions } = sessionOptions;
      run.threadRequestId = request(run, run.stage, run.resumeThreadId
        ? { ...resumeOptions, threadId: run.resumeThreadId } : sessionOptions);
      return;
    }
    if (message.id === run.threadRequestId) {
      const threadId = message.result?.thread?.id;
      if (typeof threadId !== 'string' || (run.resumeThreadId && threadId !== run.resumeThreadId)) {
        run.diagnostic = rpcErrorCode(message.error);
        return finish(run, 'task.failed', { reason: run.resumeThreadId
          ? 'Codex could not resume the previous conversation.' : 'Codex could not start a thread.' });
      }
      if (!hasExpectedCodexPermissions(message.result, sessionOptions)) {
        return finish(run, 'task.failed', { reason: 'Codex did not confirm the required read-only permissions profile.' });
      }
      run.threadId = threadId;
      run.stage = 'turn/start';
      run.turnRequestId = request(run, 'turn/start', createCodexTurnOptions(sessionOptions, threadId, run.prompt));
      return;
    }
    if (message.id === run.turnRequestId) {
      const turnId = message.result?.turn?.id;
      if (typeof turnId !== 'string') {
        run.diagnostic = rpcErrorCode(message.error);
        return finish(run, 'task.failed', { reason: 'Codex could not start a turn.' });
      }
      run.turnId = turnId;
      run.stage = 'running';
      clearTimeout(run.timer);
      run.timer = setTimeout(() => finish(run, 'task.failed', { reason: 'Codex task timed out.' }), TURN_TIMEOUT_MS);
      run.timer.unref?.();
      emit(run, 'agent.started', { codexThreadId: run.threadId, codexTurnId: turnId });
      return;
    }
    const params = message.params ?? {};
    if (params.threadId && params.threadId !== run.threadId) return;
    if (params.turnId && run.turnId && params.turnId !== run.turnId) return;
    if (message.method === 'error' && params.error) {
      // Retrying errors are not terminal. Keep a safe classification in case
      // the final failed turn omits its error; success always wins after recovery.
      run.lastFailure = codexFailureDetails(params.error);
    }
    if (message.method === 'item/completed' && params.item?.type === 'agentMessage') {
      const content = params.item.text?.trim();
      if (content && params.item.phase !== 'commentary') run.answer = content.slice(0, 4000);
    }
    if (message.method === 'turn/completed' && params.turn?.id === run.turnId) {
      if (params.turn.status !== 'completed' || run.deniedRequest) {
        const failure = params.turn.error ? codexFailureDetails(params.turn.error) : run.lastFailure;
        if (failure) run.diagnostic = failure.diagnostic;
        finish(run, 'task.failed', { reason: run.deniedRequest
          ? 'Codex requested an action that this read-only demo cannot approve.'
          : params.turn.status === 'interrupted' ? 'Codex task was interrupted.'
            : failure?.reason ?? 'Codex did not complete the task.' });
      } else {
        const summary = run.answer || 'Codex completed the read-only task without a final message.';
        emit(run, 'agent.message', { text: summary });
        finish(run, 'task.completed', { summary });
      }
    }
  }

  function receive(event) {
    if (event.type === 'task.cancel' && runs.has(event.runId)) {
      finish(runs.get(event.runId), 'task.failed', { reason: 'Codex task was cancelled.' });
      return true;
    }
    if (event.type !== 'task.start' || event.agentId !== CODEX_AGENT_ID || runs.has(event.runId)) return false;
    const run = { sessionId: event.sessionId, taskId: event.taskId, runId: event.runId,
      prompt: event.prompt, resumeThreadId: event.codexThreadId ?? null, process: null, nextId: 0, finished: false,
      initializeId: null, threadRequestId: null, turnRequestId: null,
      accountRequestId: null, requirementsRequestId: null, lastFailure: null,
      threadId: null, turnId: null, answer: '', deniedRequest: false, timer: null,
      stage: 'spawn', diagnostic: null, stderrTail: '' };
    runs.set(run.runId, run);
    try {
      run.process = spawnProcess(command, ['app-server'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const lines = readline.createInterface({ input: run.process.stdout });
      lines.on('line', (line) => {
        try { handle(run, JSON.parse(line)); }
        catch { finish(run, 'task.failed', { reason: 'Codex returned an invalid app-server message.' }); }
      });
      const processError = (error) => {
        run.diagnostic = ['ENOENT', 'EACCES', 'EPERM', 'EPIPE'].includes(error.code) ? error.code : 'process error';
        finish(run, 'task.failed', { reason: error.code === 'ENOENT'
          ? 'Could not find Codex or its workspace. Check CODEX_COMMAND and CODEX_WORKSPACE in the daemon configuration.'
          : 'Could not launch or communicate with Codex app server.' });
      };
      run.process.on('error', processError);
      run.process.stdin.on('error', processError);
      run.process.on('exit', (code) => {
        run.diagnostic = Number.isInteger(code) ? `exit ${code}` : 'process exited';
        finish(run, 'task.failed', { reason: run.stderrTail.includes('Could not find home directory')
          ? 'Codex could not find its home directory. Check the daemon environment.'
          : 'Codex app server exited before the task completed.' });
      });
      // Do not forward stderr, tool output, or reasoning to the phone or server.
      run.process.stderr?.on('data', (chunk) => {
        run.stderrTail = (run.stderrTail + chunk.toString()).slice(-2048);
      });
      run.stage = 'initialize';
      run.initializeId = request(run, 'initialize', CODEX_INITIALIZE_PARAMS);
      run.timer = setTimeout(() => finish(run, 'task.failed', { reason: 'Codex app server did not start in time.' }), STARTUP_TIMEOUT_MS);
      run.timer.unref?.();
      emit(run, 'agent.progress', { text: 'Starting Codex for a read-only repository task.' });
    } catch {
      finish(run, 'task.failed', { reason: 'Could not launch Codex app server.' });
    }
    return true;
  }

  function stop() {
    for (const run of runs.values()) { run.finished = true; clearTimeout(run.timer); run.process?.kill(); }
    runs.clear();
    pending.length = 0;
  }

  return { receive, flush, stop, pendingCount: () => pending.length };
}

function rpcErrorCode(error) {
  return Number.isInteger(error?.code) ? `RPC ${error.code}` : 'invalid RPC result';
}
