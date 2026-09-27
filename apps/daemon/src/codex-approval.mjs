import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesPendingApproval, PROTOCOL_VERSION } from '@hack-atlantic/protocol';
import { matchesCodexCommand, describeCodexCommand } from './codex-command.mjs';

// The operator chooses ONE command for this demo. Matching is deliberately
// exact; shell fragments, stdin, host-wide network grants and session grants
// are never inferred from a command preview or a model explanation.
export function createCodexApproval({ machineId, workspace, command, now = Date.now, ttlMs = 300_000, commandEnvironment }) {
  if (command != null && (typeof command !== 'string' || !command.trim() || command.length > 2000 || /[\r\n\0]/.test(command))) {
    throw new Error('CODEX_APPROVAL_COMMAND must be one explicit command, at most 2000 characters');
  }
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000) throw new Error('invalid approval timeout');
  const cwd = resolve(workspace);

  // Do not resolve a file: URI as a relative filesystem path. Recent runtimes
  // serialize local working directories as file URLs (including on Windows).
  // URI decoding changes representation only; the resulting absolute path must
  // still match the one operator-configured workspace.
  function matchesCwd(value) {
    if (typeof value !== 'string' || /[\0\r\n]/.test(value)) return false;
    try {
      let path = value;
      if (/^file:/i.test(value)) {
        const url = new URL(value);
        if (url.hostname || url.search || url.hash || url.username || url.password) return false;
        path = fileURLToPath(url);
      }
      return isAbsolute(path) && resolve(path) === cwd;
    } catch { return false; }
  }

  function rejectionCode(run, request) {
    const p = request?.params;
    if (!command) return 'bridge-disabled';
    if (request?.method !== 'item/commandExecution/requestApproval') return 'unsupported-request';
    if (!p || typeof p !== 'object' || Array.isArray(p)) return 'invalid-params';
    if (!matchesCodexCommand(p.command, command, commandEnvironment)) return 'command-mismatch';
    if (!matchesCwd(p.cwd)) return 'cwd-mismatch';
    if (p.threadId !== run.threadId || p.turnId !== run.turnId || !run.threadId || !run.turnId) return 'runtime-id-mismatch';
    if (typeof p.itemId !== 'string' || !p.itemId || p.itemId.length > 200) return 'invalid-item-id';
    if (p.kind != null && p.kind !== 'command') return 'unsupported-action-kind';
    if (p.networkApprovalContext != null) return 'network-grant-not-command';
    if (p.environmentId != null && p.environmentId !== 'local') return 'nonlocal-environment';
    if (p.availableDecisions != null && (!Array.isArray(p.availableDecisions) || !p.availableDecisions.includes('accept'))) return 'one-time-accept-unavailable';
    if (!['number', 'string'].includes(typeof request.id) || JSON.stringify(request.id).length > 200) return 'invalid-request-id';
    if (JSON.stringify(p.additionalPermissions ?? null).length > 4000) return 'permission-scope-too-large';
    return null;
  }

  function describeRejection(run, request) {
    const p = request?.params;
    // Only fixed vocabulary, booleans and a redacted quoting template leave
    // the adapter. Do not print raw command text, reasons, IDs or paths.
    return {
      code: rejectionCode(run, request),
      requestType: request?.method === 'item/commandExecution/requestApproval' ? 'command'
        : request?.method === 'item/permissions/requestApproval' ? 'permissions'
          : request?.method === 'item/fileChange/requestApproval' ? 'file-change' : 'other',
      commandForm: p?.command === command ? 'exact'
        : typeof p?.command !== 'string' ? 'missing-or-nonstring'
          : /powershell(?:\.exe)?|pwsh(?:\.exe)?/i.test(p.command) ? 'powershell-wrapper'
            : /(?:bash|zsh|sh)(?:\.exe)?\s/i.test(p.command) ? 'other-shell-wrapper' : 'other',
      cwdForm: typeof p?.cwd !== 'string' ? 'missing-or-nonstring' : /^file:/i.test(p.cwd) ? 'file-url' : 'path',
      cwdMatches: matchesCwd(p?.cwd),
      commandPreview: describeCodexCommand(p?.command, command, commandEnvironment),
    };
  }

  function prepare(run, request) {
    if (rejectionCode(run, request)) return null;
    const p = request.params;
    const requestId = JSON.stringify(request.id);
    const runtime = { threadId: p.threadId, turnId: p.turnId, itemId: p.itemId, requestId };
    const permissionScope = JSON.stringify(p.additionalPermissions ?? null);
    // Persist and hash the actual full runtime command, including any accepted
    // shell wrapper. Equivalent readable actions must not share an approval
    // digest when their execution representation or permissions differ.
    const runtimeCommand = p.command;
    const actionDigest = createHash('sha256').update(JSON.stringify({ command, runtimeCommand, cwd, runtime,
      approvalId: p.approvalId ?? null, permissionScope })).digest('hex');
    return { v: PROTOCOL_VERSION, eventId: randomUUID(), machineId,
      sessionId: run.sessionId, taskId: run.taskId, runId: run.runId,
      type: 'approval.required', approvalId: randomUUID(), actionDigest,
      command: runtimeCommand, cwd, runtime, permissionScope, expiresAt: new Date(now() + ttlMs).toISOString() };
  }

  function accepts(pending, response) {
    return Boolean(pending && !pending.resolved && typeof response.approved === 'boolean' &&
      matchesPendingApproval(pending.event, response) && now() < Date.parse(pending.event.expiresAt));
  }

  return { prepare, accepts, describeRejection, enabled: Boolean(command), ttlMs };
}
