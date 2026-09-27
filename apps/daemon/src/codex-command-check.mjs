import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { CODEX_INITIALIZE_PARAMS } from './codex-session.mjs';
import { describeCodexCommand, matchesCodexCommand } from './codex-command.mjs';

// Read an existing rehearsal only. No thread/start, turn/start, command/exec,
// approvals or model generation. This inspects how app-server renders a saved
// harmless command; it cannot establish that a later approval will match.
export function inspectCodexCommand({ threadId, command = 'codex', spawnProcess = spawn,
  log = console.log, timeoutMs = 15000, commandEnvironment }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId ?? '')) {
    throw new Error('Provide the rehearsal thread UUID.');
  }
  return new Promise(resolve => {
    let child;
    let lines;
    let finished = false;
    let stderr = '';
    const timer = setTimeout(() => finish('FAIL: read-only command inspection timed out.', 1), timeoutMs);
    function finish(message, code) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      log(message);
      lines?.close();
      child?.kill();
      resolve(code);
    }
    function send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); }
    function handle(message) {
      if (finished) return;
      // Never authorize an unsolicited runtime request during inspection.
      if (message.id != null && message.method) return finish('FAIL: unexpected interactive request. Nothing was approved.', 1);
      if (message.id === 1) {
        if (message.error) return finish('FAIL: Codex initialization failed.', 1);
        send({ method: 'initialized', params: {} });
        send({ id: 2, method: 'thread/read', params: { threadId, includeTurns: true } });
      } else if (message.id === 2) {
        if (message.error || message.result?.thread?.id !== threadId || !Array.isArray(message.result?.thread?.turns)) {
          return finish('FAIL: Codex could not read this saved rehearsal.', 1);
        }
        let found = false;
        for (const turn of message.result.thread.turns) {
          for (const item of turn.items ?? []) {
            if (item.type !== 'commandExecution' || typeof item.command !== 'string') continue;
            // Only display a structural preview of the known fixture README
            // read. Do not echo outputs, prompts, arbitrary commands or paths.
            const sample = 'Get-Content -LiteralPath README.md';
            if (!item.command.includes(sample)) continue;
            log(`Saved command format: ${JSON.stringify({
              ...describeCodexCommand(item.command, sample, commandEnvironment),
              matchesCurrentWrapper: matchesCodexCommand(item.command, sample, commandEnvironment),
            })}`);
            found = true;
            break;
          }
          if (found) break;
        }
        finish(found ? 'PASS: saved command inspected. No model turn, push or call was made.'
          : 'FAIL: the saved rehearsal has no supported README command to inspect.', found ? 0 : 1);
      }
    }
    try {
      const env = { ...process.env };
      for (const name of Object.keys(env)) {
        if (/^(?:TWILIO_|DAEMON_|DEMO_PIN|ALLOWED_CALLER|PUBLIC_BASE_URL|OPENAI_API_KEY)/i.test(name)) delete env[name];
      }
      child = spawnProcess(command, ['app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.on('error', () => finish('FAIL: could not launch Codex. Check CODEX_COMMAND.', 1));
      child.stdin.on('error', () => finish('FAIL: Codex communication ended.', 1));
      child.on('exit', () => finish(stderr.includes('Could not find home directory')
        ? 'FAIL: Codex could not find its home directory. Use your normal terminal.'
        : 'FAIL: Codex exited before command inspection completed.', 1));
      child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
      lines = readline.createInterface({ input: child.stdout });
      lines.on('line', line => {
        try { handle(JSON.parse(line)); }
        catch { finish('FAIL: invalid command-inspection response.', 1); }
      });
      send({ id: 1, method: 'initialize', params: CODEX_INITIALIZE_PARAMS });
    } catch { finish('FAIL: could not start command inspection.', 1); }
  });
}
