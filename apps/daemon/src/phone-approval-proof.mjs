import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { matchesCodexCommand } from './codex-command.mjs';
import { REHEARSAL_COMMAND } from './approval-rehearsal.mjs';

export class PhoneProofError extends Error {}

function fail(message) { throw new PhoneProofError(message); }

function samePath(first, second) {
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function fixturePaths(workspace) {
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) fail('CODEX_WORKSPACE must be an absolute disposable fixture path.');
  let actual;
  let root;
  try {
    actual = realpathSync(workspace);
    root = realpathSync(tmpdir());
  } catch { fail('The configured disposable workspace is unavailable.'); }
  const underTemp = relative(root, actual);
  const parts = underTemp.split(sep);
  if (!underTemp || underTemp.startsWith('..') || isAbsolute(underTemp) ||
      parts.length < 3 || parts.at(-1) !== 'repository' ||
      !parts.at(-2).startsWith('approval-rehearsal-') || parts.at(-3) !== 'dylamo-approval-rehearsals') {
    fail('This verifier only accepts the disposable local approval fixture under the OS temporary directory.');
  }
  const remote = join(dirname(actual), 'remote.git');
  if (!existsSync(join(remote, 'HEAD'))) fail('The disposable local bare remote is missing.');
  return { workspace: actual, remote: realpathSync(remote) };
}

function safeGitEnvironment(source, fixtureDirectory) {
  return {
    PATH: source.PATH ?? source.Path ?? '',
    SystemRoot: source.SystemRoot ?? source.WINDIR ?? '',
    WINDIR: source.WINDIR ?? source.SystemRoot ?? '',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(fixtureDirectory, 'empty-gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

function approvalCwdMatches(cwd, workspace) {
  if (typeof cwd !== 'string') return false;
  try {
    const path = cwd.startsWith('file:') ? fileURLToPath(cwd) : cwd;
    return samePath(resolve(path), workspace);
  } catch { return false; }
}

// This reader never executes the protected command or contacts the remote.
// Its Git calls only read local fixture configuration, HEAD and bare refs.
export function openPhoneApprovalProof({ workspace, databasePath, approvalCommand,
  gitExecutable = 'git', environment = process.env }) {
  if (approvalCommand !== REHEARSAL_COMMAND) fail('The configured protected command is not the disposable phone-demo push.');
  const paths = fixturePaths(workspace);
  const gitEnv = safeGitEnvironment(environment, dirname(paths.workspace));
  const git = (args, cwd = paths.workspace) => {
    try {
      return execFileSync(gitExecutable, args, { cwd, env: gitEnv, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 15_000 }).trim();
    } catch { fail('Could not inspect the disposable local Git fixture. No call or push was made.'); }
  };
  const local = (args) => git(['-c', `safe.directory=${paths.workspace}`, '-C', paths.workspace, ...args]);
  const bare = (args) => git(['-c', `safe.directory=${paths.remote}`, `--git-dir=${paths.remote}`, ...args], dirname(paths.remote));
  const origin = local(['remote', 'get-url', 'origin']);
  if (!origin || /^[a-z][a-z\d+.-]*:\/\//i.test(origin) || /^[^/\\]+@[^:]+:/.test(origin)) {
    fail('The fixture origin is not a local bare repository.');
  }
  let resolvedOrigin;
  try { resolvedOrigin = realpathSync(isAbsolute(origin) ? origin : resolve(paths.workspace, origin)); }
  catch { fail('The fixture origin is unavailable.'); }
  if (!samePath(resolvedOrigin, paths.remote)) fail('The fixture origin does not match its sibling local bare remote.');
  if (typeof databasePath !== 'string' || !existsSync(databasePath)) fail('The voice state database is unavailable.');
  let db;
  try { db = new DatabaseSync(databasePath, { readOnly: true }); }
  catch { fail('Could not open the voice state database read-only.'); }

  function readSnapshot(sinceSequence = null) {
    try {
      const sourceCommit = local(['rev-parse', 'HEAD']);
      const remoteCommit = bare(['for-each-ref', '--format=%(objectname)', 'refs/heads/phone-demo']);
      if (!/^[a-f0-9]{40,64}$/.test(sourceCommit) || (remoteCommit && !/^[a-f0-9]{40,64}$/.test(remoteCommit))) {
        fail('The local Git fixture returned an invalid commit identity.');
      }
      const latestSequence = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS value FROM approvals').get().value;
      const rows = sinceSequence == null ? [] : db.prepare(`SELECT a.rowid AS sequence, a.id, a.state,
        a.command, a.cwd, a.action_digest, a.expires_at, a.resolved_at,
        a.decided_by_user_id IS NOT NULL AS decided_by_user,
        c.pin_verified, c.state AS callback_state,
        json_extract(d.redacted_payload, '$.channel') AS decision_channel,
        ci.direction='inbound' AND ci.session_id=t.session_id AND ci.state IN ('streaming','ended')
          AND ci.started_at<=a.resolved_at AND (ci.ended_at IS NULL OR ci.ended_at>=a.resolved_at) AS in_call_active,
        EXISTS (SELECT 1 FROM audit_events e WHERE e.session_id=t.session_id AND e.type='call.authenticated'
          AND json_extract(e.redacted_payload, '$.callSid')=ci.call_sid AND e.created_at<=a.resolved_at) AS in_call_pin_verified,
        c.approval_id IS NOT NULL AS callback_attempted,
        ca.direction='outbound' AND ca.session_id=t.session_id AS outbound_call,
        ca.started_at AS outbound_started_at,
        (SELECT MIN(ci.ended_at) FROM call_attempts ci WHERE ci.session_id=t.session_id
          AND ci.direction='inbound' AND ci.state='ended') AS inbound_ended_at,
        r.state AS run_state, t.state AS task_state,
        r.codex_thread_id IS NOT NULL AND r.codex_turn_id IS NOT NULL AND
          a.codex_item_id IS NOT NULL AND a.codex_request_id IS NOT NULL AS real_runtime
        FROM approvals a JOIN agent_runs r ON r.id=a.run_id JOIN tasks t ON t.id=r.task_id
        LEFT JOIN approval_callbacks c ON c.approval_id=a.id
        LEFT JOIN call_attempts ca ON ca.call_sid=c.call_sid
        LEFT JOIN audit_events d ON d.session_id=t.session_id AND d.type='approval.decided'
          AND json_extract(d.redacted_payload, '$.approvalId')=a.id
          AND json_extract(d.redacted_payload, '$.channel')='inbound'
        LEFT JOIN call_attempts ci ON ci.call_sid=json_extract(d.redacted_payload, '$.callSid')
        WHERE a.rowid > ? AND r.codex_thread_id IS NOT NULL ORDER BY a.rowid`).all(sinceSequence);
      const approvals = rows.map(row => ({
        id: row.id, sequence: row.sequence, state: row.state,
        taskState: row.task_state, runState: row.run_state,
        callbackPinVerified: row.pin_verified === 1,
        callbackState: row.callback_state, outboundCall: row.outbound_call === 1,
        decisionChannel: row.decision_channel === 'inbound' ? 'inbound' : 'callback',
        inCallPinVerified: row.in_call_pin_verified === 1,
        inCallActiveAtDecision: row.in_call_active === 1,
        callbackAttempted: row.callback_attempted === 1,
        inboundEndedAt: row.inbound_ended_at,
        hungUpBeforeDecision: row.inbound_ended_at != null && row.resolved_at != null &&
          row.inbound_ended_at < row.resolved_at,
        callbackAfterHangup: row.inbound_ended_at != null && row.outbound_started_at != null &&
          row.outbound_started_at >= row.inbound_ended_at,
        decidedByUser: row.decided_by_user === 1,
        realRuntime: row.real_runtime === 1,
        decisionInTime: row.resolved_at == null || row.resolved_at < row.expires_at,
        exactAction: approvalCwdMatches(row.cwd, paths.workspace) &&
          matchesCodexCommand(row.command, REHEARSAL_COMMAND, {
            platform: process.platform, windowsRoot: environment.SystemRoot ?? environment.WINDIR,
          }),
      }));
      return { sourceCommit, remoteCommit, latestSequence, approvals };
    } catch (error) {
      if (error instanceof PhoneProofError) throw error;
      fail('Could not read the live approval state. No call or push was made by this verifier.');
    }
  }

  return { readSnapshot, close: () => db.close() };
}

export async function observePhoneApproval({ readSnapshot, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now, pollMs = 250, timeoutMs = 6 * 60_000, onPhase = () => {} }) {
  const baseline = readSnapshot();
  if (baseline.remoteCommit) fail('The disposable remote already has phone-demo; use a fresh fixture.');
  const sourceCommit = baseline.sourceCommit;
  const startedAt = now();
  onPhase('baseline');
  let pendingId;
  let hangupObserved = false;
  let inlineDecisionObserved = false;
  while (now() - startedAt < timeoutMs) {
    await sleep(pollMs);
    const current = readSnapshot(baseline.latestSequence);
    if (current.sourceCommit !== sourceCommit) fail('The disposable source HEAD changed during observation.');
    if (current.approvals.length > 1) fail('More than one real Codex approval appeared; use a fresh fixture and repeat.');
    const approval = current.approvals[0];
    if (!pendingId) {
      if (current.remoteCommit) fail('The local remote changed before a pending approval was observed.');
      if (!approval) continue;
      if (!approval.realRuntime || !approval.exactAction) fail('Codex requested an unexpected protected action. Nothing should be approved.');
      if (approval.state !== 'pending' || approval.taskState !== 'waiting_human' || approval.runState !== 'waiting_human') {
        fail('The verifier did not observe the exact action held pending before a decision.');
      }
      pendingId = approval.id;
      onPhase('held');
      if (approval.inboundEndedAt != null) {
        hangupObserved = true;
        onPhase('hangup');
      }
      continue;
    }
    if (!approval || approval.id !== pendingId) fail('The pending approval identity changed.');
    if (!approval.exactAction || !approval.realRuntime) fail('The protected action identity changed.');
    if (approval.state === 'pending') {
      if (current.remoteCommit) fail('The local remote changed while approval was still pending.');
      if (!hangupObserved && approval.inboundEndedAt != null) {
        hangupObserved = true;
        onPhase('hangup');
      }
      continue;
    }
    if (approval.state !== 'approved') {
      if (current.remoteCommit) fail('The local remote changed despite an unapproved decision.');
      fail('The observed protected action was not approved; the remote must remain unchanged.');
    }
    if (approval.decisionChannel === 'inbound') {
      if (!approval.inCallPinVerified || !approval.inCallActiveAtDecision || approval.callbackAttempted
        || !approval.decidedByUser || !approval.decisionInTime) {
        fail('The approval lacks a timely decision on the same PIN-authenticated call. Do not trust the action outcome.');
      }
      if (!inlineDecisionObserved) {
        inlineDecisionObserved = true;
        onPhase('approved-on-call');
      }
    } else {
      if (!approval.callbackPinVerified || approval.callbackState !== 'finished' || !approval.outboundCall ||
          !approval.decidedByUser || !approval.decisionInTime) {
        fail('The approval lacks a timely PIN-verified callback decision. Do not trust the action outcome.');
      }
      if (!approval.hungUpBeforeDecision) fail('The original inbound call did not end before the protected action was approved.');
      if (!approval.callbackAfterHangup) fail('The outbound callback was not recorded after the inbound hangup.');
      if (!hangupObserved) {
        hangupObserved = true;
        onPhase('hangup');
      }
    }
    if (current.remoteCommit && current.remoteCommit !== sourceCommit) fail('The local remote points to an unexpected commit.');
    if (['failed', 'cancelled'].includes(approval.taskState) || ['failed', 'cancelled'].includes(approval.runState)) {
      fail('Codex did not complete after approval. Inspect the local Git ref before any retry.');
    }
    if (approval.taskState === 'completed' && approval.runState === 'completed') {
      if (current.remoteCommit !== sourceCommit) fail('Codex completed, but the local remote lacks the expected commit.');
      onPhase('verified');
      return { result: 'verified', commit: sourceCommit };
    }
  }
  fail('Phone approval observation timed out. Inspect the laptop and local Git ref before retrying.');
}
