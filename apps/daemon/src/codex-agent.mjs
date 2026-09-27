import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { PROTOCOL_VERSION } from '@hack-atlantic/protocol';
import { CODEX_INITIALIZE_PARAMS, CODEX_ACCOUNT_PARAMS, codexAccountFailure, codexFailureDetails, codexProcessEnvironment, createCodexSessionOptions, createCodexTurnOptions, hasExpectedCodexPermissions } from './codex-session.mjs';
import { createCodexApproval } from './codex-approval.mjs';
import { DEMO_PUSH_COMMAND, prepareCodexTask } from './codex-task.mjs';
import { DemoPushSafetyError, inspectDemoPush, sameDemoPushState, verifyDemoPushResult } from './git-push-safety.mjs';

export const CODEX_AGENT_ID = '00000000-0000-4000-8000-000000000008';
const STARTUP_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 10 * 60_000;

// Read-only by default. Opt-in workspace edits do not authorize a protected
// command, which is still held at the app-server RPC boundary for phone approval.
export function createCodexAgent({ machineId, send, workspace, command = 'codex', model = 'gpt-6-sol',
  allowFullRead = false, allowWorkspaceWrite = false, approvalCommand, approvalTimeoutMs = 300_000,
  now = Date.now, spawnProcess = spawn, processEnv = process.env, logger = console,
  inspectPushState = inspectDemoPush, verifyPushResult = verifyDemoPushResult,
  onApprovalDiagnostic = () => {} }) {
  const sessionOptions = createCodexSessionOptions({ workspace, model, allowFullRead, allowWorkspaceWrite });
  if (approvalCommand) {
    sessionOptions.approvalsReviewer = 'user';
    // Command network rules do not constrain hosted search or delegated agents.
    // Keep the phone approval boundary within this one local Codex turn.
    sessionOptions.config = { ...sessionOptions.config, web_search: 'disabled',
      features: { apps: false, plugins: false, multi_agent: false } };
  }
  const { cwd } = sessionOptions;
  const runs = new Map();
  const seenRuns = new Set();
  const pending = [];
  const approvals = createCodexApproval({ machineId, workspace, command: approvalCommand, now, ttlMs: approvalTimeoutMs,
    commandEnvironment: { platform: process.platform, windowsRoot: processEnv.SystemRoot ?? processEnv.WINDIR } });

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

  function startThread(run) {
    run.stage = run.resumeThreadId ? 'thread/resume' : 'thread/start';
    const options = run.sessionOptions ?? sessionOptions;
    const { serviceName, ...resumeOptions } = options;
    run.threadRequestId = request(run, run.stage, run.resumeThreadId
      ? { ...resumeOptions, threadId: run.resumeThreadId } : options);
  }

  function finish(run, type, fields) {
    if (run.finished) return;
    run.finished = true;
    clearTimeout(run.timer);
    clearTimeout(run.approvalTimer);
    if (run.approval && !run.approval.resolved) {
      run.approval.resolved = true;
      try { write(run, { id: run.approval.rpcId, result: { decision: 'cancel' } }); } catch {}
    }
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
      let proposal = approvals.prepare(run, message);
      if (proposal && !run.approval) {
        let pushState = null;
        if (approvalCommand === DEMO_PUSH_COMMAND) {
          try {
            pushState = inspectPushState({ workspace: cwd, environment: run.childEnv });
            proposal = approvals.prepare(run, message, pushState);
          } catch (error) {
            try { write(run, { id: message.id, result: { decision: 'decline' } }); } catch {}
            return finish(run, 'task.failed', { reason: error instanceof DemoPushSafetyError
              ? error.message : 'Could not verify the demo push state. No action was approved.' });
          }
        }
        run.approval = { event: proposal, rpcId: message.id, resolved: false, pushState };
        run.stage = 'waiting_human';
        clearTimeout(run.timer);
        run.approvalTimer = setTimeout(() => finish(run, 'task.failed', {
          reason: 'Approval expired. The protected action was not authorized.',
        }), approvals.ttlMs);
        run.approvalTimer.unref?.();
        pending.push(proposal);
        flush();
        return;
      }
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
      if (approvals.enabled) {
        const diagnostic = approvals.describeRejection(run, message);
        if (proposal && run.approval) diagnostic.code = 'second-approval-not-supported';
        run.diagnostic = `approval ${diagnostic.code}`;
        // Diagnostics are local only, never task events or spoken content.
        onApprovalDiagnostic(diagnostic);
      }
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
      if (approvals.enabled) {
        run.stage = 'config/read';
        run.configRequestId = request(run, 'config/read', { cwd, includeLayers: false });
      } else startThread(run);
      return;
    }
    if (run.configRequestId != null && message.id === run.configRequestId) {
      const config = message.result?.config;
      if (message.error || !config || typeof config !== 'object' || Array.isArray(config)) {
        return finish(run, 'task.failed', { reason: 'Codex could not check local tool configuration for the protected-action demo.' });
      }
      // Command sandboxing does not constrain connector tools. Disable inherited
      // apps/plugins and configured MCP servers for this thread only. Reject hooks
      // rather than silently overriding operator-managed command execution.
      if (config.hooks && Object.keys(config.hooks).length) {
        return finish(run, 'task.failed', { reason: 'The protected-action demo requires a Codex configuration without hooks.' });
      }
      run.sessionOptions = { ...sessionOptions, config: { ...sessionOptions.config,
        mcp_servers: Object.fromEntries(Object.keys(config.mcp_servers ?? {}).map(name => [name, { enabled: false }])),
        plugins: Object.fromEntries(Object.keys(config.plugins ?? {}).map(name => [name, { enabled: false }])),
      } };
      startThread(run);
      return;
    }
    if (message.id === run.threadRequestId) {
      const threadId = message.result?.thread?.id;
      if (typeof threadId !== 'string' || (run.resumeThreadId && threadId !== run.resumeThreadId)) {
        run.diagnostic = rpcErrorCode(message.error);
        return finish(run, 'task.failed', { reason: run.resumeThreadId
          ? 'Codex could not resume the previous conversation.' : 'Codex could not start a thread.' });
      }
      if (!hasExpectedCodexPermissions(message.result, sessionOptions) ||
          (approvals.enabled && message.result.approvalsReviewer !== 'user')) {
        return finish(run, 'task.failed', { reason: 'Codex did not confirm the required permissions profile.' });
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
    if (run.steerRequests.has(message.id)) {
      const requestEventId = run.steerRequests.get(message.id);
      run.steerRequests.delete(message.id);
      emit(run, 'task.steer.result', {
        requestEventId, accepted: !message.error && message.result?.turnId === run.turnId,
      });
      return;
    }
    const params = message.params ?? {};
    if (params.threadId && params.threadId !== run.threadId) return;
    if (params.turnId && run.turnId && params.turnId !== run.turnId) return;
    if (message.method === 'serverRequest/resolved' && run.approval && !run.approval.resolved &&
        params.requestId === run.approval.rpcId) {
      return finish(run, 'task.failed', { reason: 'Codex cleared the pending approval. The action was not authorized.' });
    }
    if (approvals.enabled && message.method === 'item/started' &&
        ['mcpToolCall', 'dynamicToolCall', 'collabToolCall', 'webSearch'].includes(params.item?.type)) {
      return finish(run, 'task.failed', {
        reason: 'Codex attempted an external or delegated tool in protected-action mode. The task was stopped.',
      });
    }
    if (message.method === 'item/started' && params.item?.type === 'commandExecution') {
      emit(run, 'agent.progress', { text: 'Codex is checking a repository command.' });
    }
    if (message.method === 'error' && params.error) {
      // Retrying errors are not terminal. Keep a safe classification in case
      // the final failed turn omits its error; success always wins after recovery.
      run.lastFailure = codexFailureDetails(params.error);
    }
    if (message.method === 'item/completed' && params.item?.type === 'agentMessage') {
      const content = params.item.text?.trim();
      if (content && params.item.phase !== 'commentary') run.answer = content.slice(0, 4000);
    }
    if (message.method === 'item/completed' && run.approval?.approved &&
        params.item?.id === run.approval.event.runtime.itemId && params.item.type === 'commandExecution') {
      run.protectedOutcome = params.item.status === 'completed' && params.item.exitCode === 0;
    }
    if (message.method === 'turn/completed' && params.turn?.id === run.turnId) {
      if (run.approval && !run.approval.resolved) {
        return finish(run, 'task.failed', { reason: 'Codex ended before the pending approval was resolved.' });
      }
      if (run.approval?.approved && run.protectedOutcome !== true) {
        return finish(run, 'task.failed', { reason: run.protectedOutcome === false
          ? 'The approved command failed. Check the repository before retrying.'
          : 'Codex did not confirm the approved command result. Its outcome is uncertain; check before retrying.' });
      }
      if (params.turn.status === 'completed' && run.approval?.approved && run.approval.pushState &&
          run.protectedOutcome === true) {
        try {
          verifyPushResult({ workspace: cwd, environment: run.childEnv, expectedState: run.approval.pushState });
        } catch {
          return finish(run, 'task.failed', { reason: 'Codex reported a successful push, but the local destination ref could not be verified. Inspect it before retrying.' });
        }
      }
      if (params.turn.status !== 'completed' || run.deniedRequest) {
        const failure = params.turn.error ? codexFailureDetails(params.turn.error) : run.lastFailure;
        if (failure) run.diagnostic = failure.diagnostic;
        finish(run, 'task.failed', { reason: run.deniedRequest
          ? approvals.enabled ? 'Codex requested an action that did not match the protected-action approval policy.'
            : 'Codex requested an action that this read-only demo cannot approve.'
          : params.turn.status === 'interrupted' ? 'Codex task was interrupted.'
            : failure?.reason ?? 'Codex did not complete the task.' });
      } else if (run.requiresApproval && !run.approval) {
        finish(run, 'task.failed', { reason: 'The demo push did not reach a verified approval request. No action was authorized.' });
      } else {
        const summary = run.approval?.approved && run.approval.pushState
          ? 'Done. The prepared changes are published to the local demo branch.'
          : run.answer || 'Codex completed the read-only task without a final message.';
        emit(run, 'agent.message', { text: summary });
        finish(run, 'task.completed', { summary });
      }
    }
  }

  function receive(event) {
    if (event.type === 'approval.response') {
      const run = runs.get(event.runId);
      if (!run || !approvals.accepts(run.approval, event)) return false;
      if (event.approved && run.approval.pushState) {
        let current;
        try { current = inspectPushState({ workspace: cwd, environment: run.childEnv }); }
        catch { current = null; }
        if (!sameDemoPushState(run.approval.pushState, current)) {
          run.approval.resolved = true;
          try { write(run, { id: run.approval.rpcId, result: { decision: 'cancel' } }); } catch {}
          finish(run, 'task.failed', { reason: 'The demo push commit or destination changed while approval was pending. No action was approved.' });
          return true;
        }
      }
      run.approval.resolved = true;
      run.approval.approved = event.approved;
      clearTimeout(run.approvalTimer);
      try {
        write(run, { id: run.approval.rpcId, result: { decision: event.approved ? 'accept' : 'cancel' } });
      } catch {
        finish(run, 'task.failed', { reason: 'Codex could not receive the approval decision. Check the action outcome before retrying.' });
        return true;
      }
      if (!event.approved) {
        finish(run, 'task.failed', { reason: 'The protected action was rejected.' });
      } else {
        run.stage = 'running';
        run.timer = setTimeout(() => finish(run, 'task.failed', { reason: 'Codex task timed out after approval. Check the action outcome before retrying.' }), TURN_TIMEOUT_MS);
        run.timer.unref?.();
        emit(run, 'agent.progress', { text: 'The exact action was approved once. Codex is resuming.' });
      }
      return true;
    }
    if (event.type === 'task.cancel') {
      const run = runs.get(event.runId);
      if (!run || event.machineId !== machineId || event.sessionId !== run.sessionId || event.taskId !== run.taskId) return false;
      finish(run, 'task.cancelled', { reason: 'Codex task was cancelled by the caller.' });
      return true;
    }
    if (event.type === 'task.steer') {
      const run = runs.get(event.runId);
      if (!run || event.machineId !== machineId || event.sessionId !== run.sessionId ||
          event.taskId !== run.taskId || typeof event.prompt !== 'string' ||
          !event.prompt.trim() || event.prompt.length > 600 || !event.eventId) return false;
      if (run.stage !== 'running' || !run.threadId || !run.turnId || run.approval) {
        emit(run, 'task.steer.result', { requestEventId: event.eventId, accepted: false });
        return true;
      }
      try {
        const requestId = request(run, 'turn/steer', { threadId: run.threadId,
          expectedTurnId: run.turnId, input: [{ type: 'text', text: event.prompt }] });
        run.steerRequests.set(requestId, event.eventId);
      } catch {
        emit(run, 'task.steer.result', { requestEventId: event.eventId, accepted: false });
      }
      return true;
    }
    if (event.type !== 'task.start' || event.agentId !== CODEX_AGENT_ID || seenRuns.has(event.runId)) return false;
    const task = prepareCodexTask(event.prompt, approvalCommand);
    const run = { sessionId: event.sessionId, taskId: event.taskId, runId: event.runId,
      prompt: task.prompt, requiresApproval: task.requiresApproval === true,
      resumeThreadId: event.codexThreadId ?? null, process: null, nextId: 0, finished: false,
      initializeId: null, threadRequestId: null, turnRequestId: null,
      accountRequestId: null, requirementsRequestId: null, lastFailure: null,
      threadId: null, turnId: null, answer: '', deniedRequest: false, timer: null,
      stage: 'spawn', diagnostic: null, stderrTail: '', approval: null, approvalTimer: null,
      childEnv: null, steerRequests: new Map() };
    seenRuns.add(run.runId);
    runs.set(run.runId, run);
    if (task.reason) {
      run.stage = 'task/preflight';
      finish(run, 'task.failed', { reason: task.reason });
      return true;
    }
    try {
      const env = codexProcessEnvironment({ source: processEnv, cwd, allowWorkspaceWrite,
        isolateDemoGit: approvalCommand === DEMO_PUSH_COMMAND });
      run.childEnv = env;
      const args = approvals.enabled
        ? ['-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.multi_agent=false',
          '-c', 'web_search=disabled', 'app-server']
        : ['app-server'];
      run.process = spawnProcess(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
      emit(run, 'agent.progress', { text: allowWorkspaceWrite
        ? 'Starting Codex for a workspace task.' : 'Starting Codex for a read-only repository task.' });
    } catch {
      finish(run, 'task.failed', { reason: 'Could not launch Codex app server.' });
    }
    return true;
  }

  function stop() {
    for (const run of runs.values()) { run.finished = true; clearTimeout(run.timer); clearTimeout(run.approvalTimer); run.process?.kill(); }
    runs.clear();
    pending.length = 0;
  }

  return { receive, flush, stop, pendingCount: () => pending.length, activeRunIds: () => [...runs.keys()] };
}

function rpcErrorCode(error) {
  return Number.isInteger(error?.code) ? `RPC ${error.code}` : 'invalid RPC result';
}
