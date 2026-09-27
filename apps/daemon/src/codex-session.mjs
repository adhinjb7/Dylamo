import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export const CODEX_INITIALIZE_PARAMS = {
  clientInfo: { name: 'hack_atlantic', title: 'Hack Atlantic daemon', version: '0.0.1' },
  capabilities: { experimentalApi: true },
};

// Read account readiness without forcing a sign-in, token refresh, or account change.
export const CODEX_ACCOUNT_PARAMS = { refreshToken: false };

// Let commands run within the read-only sandbox. The adapter still declines
// approvals unless the opt-in exact-action phone bridge is enabled. This policy
// alone does not grant writes, network, or escalation.
const CODEX_APPROVAL_POLICY = 'on-request';

export function codexAccountFailure(result) {
  if (typeof result?.requiresOpenaiAuth !== 'boolean') return 'Codex returned an invalid account-readiness result.';
  if (result.requiresOpenaiAuth && !result.account) return 'Codex is not signed in. Sign in to Codex on this computer, then retry.';
  return null;
}

// Only allowlisted classifications leave the process. Raw upstream error messages
// and additionalDetails may contain private configuration or request contents.
export function codexFailureDetails(error) {
  const info = error?.codexErrorInfo;
  const knownCodes = new Set([
    'contextWindowExceeded', 'sessionBudgetExceeded', 'usageLimitExceeded', 'rateLimitExceeded',
    'serverOverloaded', 'cyberPolicy', 'misalignmentPolicyViolation', 'internalServerError',
    'unauthorized', 'badRequest', 'threadRollbackFailed', 'sandboxError', 'other',
    'httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected',
    'responseTooManyFailedAttempts', 'activeTurnNotSteerable',
  ]);
  const candidate = typeof info === 'string' ? info : info && Object.keys(info)[0];
  const code = knownCodes.has(candidate) ? candidate : null;
  const httpStatus = code && typeof info === 'object' ? info[code]?.httpStatusCode : null;
  let reason = 'Codex did not complete the task.';
  if (/failed to (?:re)?load workspace requirements/i.test(error?.message ?? '')) {
    reason = 'Codex could not load workspace requirements. The repository investigation did not finish.';
  } else if (code === 'unauthorized') {
    reason = 'Codex could not authenticate. Check the Codex sign-in on this computer.';
  } else if (code === 'usageLimitExceeded' || code === 'rateLimitExceeded') {
    reason = 'Codex reported a usage or rate limit. Check the account limits before retrying.';
  } else if (code === 'sandboxError') {
    reason = 'Codex encountered a sandbox error while running the task.';
  }
  const diagnostic = [code, Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? `HTTP ${httpStatus}` : null]
    .filter(Boolean).join('; ') || null;
  return { reason, diagnostic };
}

export function createCodexSessionOptions({ workspace, model = 'gpt-6-sol', allowFullRead = false }) {
  if (!workspace) throw new Error('CODEX_WORKSPACE is required for the Codex agent');
  const cwd = resolve(workspace);
  // No temporary profile definition is needed once broad reads are approved.
  if (allowFullRead === true) {
    return { cwd, model, approvalPolicy: CODEX_APPROVAL_POLICY, permissions: ':read-only', serviceName: 'hack_atlantic' };
  }
  // A unique profile avoids merging broader rules from a user-defined profile.
  const permissions = `hack_atlantic_readonly_${randomUUID().replaceAll('-', '')}`;
  return {
    cwd, model, approvalPolicy: CODEX_APPROVAL_POLICY, permissions, serviceName: 'hack_atlantic',
    config: { permissions: { [permissions]: {
      filesystem: { ':minimal': 'read', [cwd]: 'read' }, network: { enabled: false },
    } } },
  };
}

export function hasExpectedCodexPermissions(result, options) {
  if (result?.activePermissionProfile?.id !== options.permissions ||
      result?.activePermissionProfile?.extends != null || result?.approvalPolicy !== CODEX_APPROVAL_POLICY) return false;
  // Verify effective permissions as well as profile identity for the built-in.
  return options.permissions !== ':read-only' ||
    (result.sandbox?.type === 'readOnly' && result.sandbox.networkAccess === false);
}

export function createCodexTurnOptions(options, threadId, prompt) {
  return { threadId, cwd: options.cwd, model: options.model, effort: 'medium',
    approvalPolicy: options.approvalPolicy, permissions: options.permissions,
    ...(options.approvalsReviewer ? { approvalsReviewer: options.approvalsReviewer } : {}),
    input: [{ type: 'text', text: prompt }] };
}

export function startupErrorMessage(error, env = process.env) {
  let message = typeof error?.message === 'string' ? error.message : 'No error message returned';
  for (const [name, value] of Object.entries(env)) {
    if (/token|secret|api_?key|credential|password/i.test(name) && value?.length >= 8) {
      message = message.replaceAll(value, '[redacted]');
    }
  }
  return message
    .replace(/\bheaders\s*=\s*\{[^\r\n]*/gi, 'headers=[redacted]')
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}/g, '[redacted]')
    .replace(/((?:api_?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .slice(0, 2000);
}
