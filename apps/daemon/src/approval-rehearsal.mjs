import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCodexAgent, CODEX_AGENT_ID } from './codex-agent.mjs';
import { matchesCodexCommand } from './codex-command.mjs';

export const REHEARSAL_COMMAND = 'git push origin HEAD:refs/heads/phone-demo';

// No existing checkout is moved or reset, and no GitHub destination is used.
// Fixtures remain on disk for inspection; the operator may remove them later.
export function prepareApprovalRehearsal(parent) {
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(resolve(parent), 'approval-rehearsal-'));
  const workspace = join(directory, 'repository');
  const remote = join(directory, 'remote.git');
  const hooks = join(directory, 'empty-hooks');
  mkdirSync(workspace);
  mkdirSync(hooks);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  const gitConfig = join(directory, 'empty-gitconfig');
  writeFileSync(gitConfig, '');
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitConfig, GIT_TERMINAL_PROMPT: '0' });
  const git = (cwd, args) => execFileSync('git', ['-c', `core.hooksPath=${hooks}`, ...args],
    { cwd, env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }).trim();
  git(workspace, ['init', '-b', 'main']);
  git(directory, ['init', '--bare', remote]);
  git(workspace, ['config', 'user.name', 'Dylamo approval rehearsal']);
  git(workspace, ['config', 'user.email', 'rehearsal@example.invalid']);
  git(workspace, ['config', 'core.hooksPath', hooks]);
  writeFileSync(join(workspace, 'README.md'), '# Approval rehearsal\n\nThis disposable repository contains no personal data.\n');
  git(workspace, ['add', 'README.md']);
  git(workspace, ['commit', '-m', 'Initialize local approval fixture']);
  git(workspace, ['remote', 'add', 'origin', remote]);
  const expectedCommit = git(workspace, ['rev-parse', 'HEAD']);
  const remoteCommit = () => git(directory, ['--git-dir', remote, 'for-each-ref', '--format=%(objectname)', 'refs/heads/phone-demo']);
  const unchanged = () => git(workspace, ['status', '--porcelain']) === '' && git(workspace, ['rev-parse', 'HEAD']) === expectedCommit;
  return { directory, workspace, remote, expectedCommit, remoteCommit, unchanged, git, env };
}

export async function rehearseApproval({ fixture, decision, command = 'codex', model = 'gpt-6-sol',
  allowFullRead = false, makeAgent = createCodexAgent, timeoutMs = 120000, log = console.log }) {
  if (!['approve', 'reject', 'expire'].includes(decision)) throw new Error('Choose approve, reject or expire explicitly');
  if (fixture.remoteCommit()) throw new Error('Rehearsal destination is not empty');
  let resolveDone;
  let agent;
  let approval;
  let terminal;
  let failure;
  let holdTimer;
  let accepting = false;
  const done = new Promise(resolveDoneValue => { resolveDone = resolveDoneValue; });
  const finish = reason => { if (reason) failure = reason; resolveDone(); };
  const timeout = setTimeout(() => finish('The real runtime rehearsal timed out.'), timeoutMs);
  const machineId = randomUUID();
  try {
    agent = makeAgent({ machineId, workspace: fixture.workspace, command, model, allowFullRead,
      approvalCommand: REHEARSAL_COMMAND, approvalTimeoutMs: decision === 'expire' ? 1500 : 300000,
      // Only fixture-specific Git configuration is forwarded. Never alter the
      // user's global config or pass telephony credentials into Codex.
      processEnv: fixture.env,
      logger: { error() {} },
      onApprovalDiagnostic: diagnostic => log(`Approval check: ${JSON.stringify(diagnostic)}`),
      send(event) {
        if (event.type === 'approval.required') {
          if (approval || !matchesCodexCommand(event.command, REHEARSAL_COMMAND, {
            platform: process.platform, windowsRoot: fixture.env.SystemRoot ?? fixture.env.WINDIR,
          }) || event.cwd !== fixture.workspace) {
            finish('Unexpected approval proposal. Nothing was approved.');
            return true;
          }
          approval = event;
          if (fixture.remoteCommit()) {
            finish('The remote changed before approval. Do not use this runtime configuration for the demo.');
            return true;
          }
          log('PASS: real approval requested; local remote is unchanged. Holding the request.');
          if (decision !== 'expire') holdTimer = setTimeout(() => {
            try {
              if (fixture.remoteCommit()) return finish('The remote changed while approval was pending.');
              log(`Sending one ${decision} decision for this disposable local push only.`);
              accepting = decision === 'approve';
              if (!agent.receive({ v: 1, eventId: randomUUID(), machineId,
                sessionId: event.sessionId, taskId: event.taskId, runId: event.runId,
                type: 'approval.response', approvalId: event.approvalId,
                actionDigest: event.actionDigest, approved: accepting })) finish('The runtime refused the exact decision.');
            } catch { finish('Local verification failed; inspect the fixture before retrying.'); }
          }, 1000);
        } else if (event.type === 'task.completed' || event.type === 'task.failed') {
          terminal = event;
          finish();
        }
        return true;
      },
    });
    log('Starting a real Codex turn (uses Codex quota; no phone call or GitHub push).');
    agent.receive({ v: 1, eventId: randomUUID(), machineId, sessionId: randomUUID(), taskId: randomUUID(),
      runId: randomUUID(), type: 'task.start', agentId: CODEX_AGENT_ID,
      prompt: `Read README.md and summarize it briefly. Then run exactly ${REHEARSAL_COMMAND} in the current repository. The remote is a disposable local bare repository. Request approval through the command tool for this write outside the read-only workspace; do not use a plugin, alternate command, session-wide permission, prefix rule, or another tool to push. Do not modify or commit files. After the command ends report its actual outcome.` });
    await done;
    if (failure) throw new Error(failure);
    if (!approval) throw new Error(terminal?.reason ?? 'Codex did not request the exact protected command. No approval was sent.');
    if (!fixture.unchanged()) throw new Error('The source fixture changed unexpectedly. Inspect it before retrying.');
    const pushed = fixture.remoteCommit();
    if (decision === 'approve') {
      if (!accepting || terminal?.type !== 'task.completed' || pushed !== fixture.expectedCommit) {
        throw new Error('The approved push did not complete with the expected commit. Its outcome needs inspection.');
      }
    } else if (terminal?.type !== 'task.failed' || pushed) {
      throw new Error('Reject/expiry did not leave the local remote unchanged. Do not enable the live demo.');
    }
    log(`PASS: ${decision} rehearsal verified against the local Git ref. This does not verify Twilio or phone approval.`);
    return { decision, result: 'passed', expectedCommit: fixture.expectedCommit };
  } finally {
    clearTimeout(timeout);
    clearTimeout(holdTimer);
    agent?.stop();
  }
}
