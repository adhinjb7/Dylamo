import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchesCodexCommand, describeCodexCommand } from '../src/codex-command.mjs';

const command = 'git push origin HEAD:refs/heads/phone-demo';
const executable = String.raw`C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe`;
const windows = { platform: 'win32', windowsRoot: String.raw`C:\WINDOWS` };

test('diagnostic preview retains only known tokens and quoting, never private arguments', () => {
  const wrapped = `"${executable}" -Command "${command}"`;
  assert.deepEqual(describeCodexCommand(wrapped, command, windows), {
    windows: true, windowsRootKnown: true, shape: '"<system-powershell>" -Command "<configured-command>"',
  });
  const escaped = `'${executable.replaceAll('\\', '\\\\')}' -Command '${command}'`;
  assert.equal(describeCodexCommand(escaped, command, windows).shape,
    "'<escaped-system-powershell>' -Command '<configured-command>'");
  for (const actual of [wrapped + '; echo sk-private-12345678',
    `C:\\Users\\private-person\\powershell.exe -Command "${command}; print secret-value"`,
    `pwsh.exe -EncodedCommand secret-base64\n`, 'x'.repeat(20000), '"'.repeat(20000)]) {
    const result = JSON.stringify(describeCodexCommand(actual, command, windows));
    for (const secret of ['sk-private', 'private-person', 'secret-value', 'secret-base64', 'Users']) {
      assert.equal(result.includes(secret), false);
    }
    assert.ok(result.length < 1200, 'diagnostics are bounded even with large input');
  }
  assert.equal(describeCodexCommand(null, command, windows).shape, 'missing-or-nonstring');
  assert.equal(describeCodexCommand(wrapped, command, { ...windows, windowsRoot: '' }).windowsRootKnown, false);
});

test('exact commands and only complete known Windows PowerShell wrappers match', () => {
  assert.equal(matchesCodexCommand(command, command, { platform: 'linux' }), true);
  for (const shell of [executable, `'${executable}'`, `"${executable}"`, `"${executable.toLowerCase()}"`]) {
    for (const flags of ['-Command', '-NoProfile -Command']) {
      for (const body of [command, `'${command}'`, `"${command}"`]) {
        assert.equal(matchesCodexCommand(`${shell} ${flags} ${body}`, command, windows), true);
      }
    }
  }
  const wrapped = `"${executable}" -Command "${command}"`;
  assert.equal(matchesCodexCommand(wrapped, command, { ...windows, platform: 'linux' }), false);
  assert.equal(matchesCodexCommand(wrapped, command, { ...windows, windowsRoot: 'relative' }), false);
});

test('observed double-quoted escaped Windows path matches without unescaping the command body', () => {
  // The operator's thread/read diagnostic reported exactly this shape:
  // "<escaped-system-powershell>" -Command '<configured-command>'
  const escapedExecutable = executable.replaceAll('\\', '\\\\');
  for (const expected of ['Get-Content -LiteralPath README.md', command]) {
    const actual = `"${escapedExecutable}" -Command '${expected}'`;
    assert.equal(describeCodexCommand(actual, expected, windows).shape,
      `"<escaped-system-powershell>" -Command '<configured-command>'`);
    assert.equal(matchesCodexCommand(actual, expected, windows), true);
    assert.equal(matchesCodexCommand(actual, expected, { ...windows, platform: 'linux' }), false);
  }
  for (const actual of [
    `"${escapedExecutable}" -Command '${command}; whoami'`,
    `"${escapedExecutable}" -Command '${command}' ; whoami`,
    `"${escapedExecutable}" -Command '${command}'\n`,
    `"${escapedExecutable}" -Command '${command} $(whoami)'`,
    `"${escapedExecutable}" -Command '${command.replace('phone-demo', 'main')}'`,
    `"${escapedExecutable}" -ExecutionPolicy Bypass -Command '${command}'`,
    `"${escapedExecutable}" -EncodedCommand Z2l0`,
    `"${escapedExecutable.replace('System32', 'untrusted')}" -Command '${command}'`,
    `"${escapedExecutable.replace('System32', 'System32\\\\..\\\\untrusted')}" -Command '${command}'`,
    `"${escapedExecutable.replaceAll('\\\\', '\\\\\\\\')}" -Command '${command}'`,
    `'${escapedExecutable}' -Command '${command}'`,
    `${escapedExecutable} -Command '${command}'`,
  ]) assert.equal(matchesCodexCommand(actual, command, windows), false, actual);
});

test('extra commands, different executables, branches and shell arguments fail closed', () => {
  const wrapped = `"${executable}" -Command "${command}"`;
  const rejected = [
    `${wrapped}; echo changed`, `${wrapped} extra`, `${wrapped}\n`,
    `"${executable}" -Command "${command}; echo changed"`,
    `"${executable}" -Command "${command} && echo changed"`,
    `"${executable}" -Command "${command} | Write-Output"`,
    `"${executable}" -Command "${command} > result.txt"`,
    `"${executable}" -Command "${command} # comment"`,
    `"${executable}" -Command "${command}\r\necho changed"`,
    `"${executable}" -Command "${command.replace('phone-demo', 'main')}"`,
    `"${executable}" -Command "${command.replace('git', 'GIT')}"`,
    `"${executable}" -ExecutionPolicy Bypass -Command "${command}"`,
    `"${executable}" -EncodedCommand Z2l0`, `"${executable}" -File "${command}"`,
    `"${executable}" -Command "& { ${command} }"`,
    `"${executable}" -Command "${command} $(whoami)"`,
    `"${executable}" -Command "${command}" -NoExit`,
    `powershell.exe -Command "${command}"`, `pwsh.exe -Command "${command}"`,
    `"C:\\untrusted\\powershell.exe" -Command "${command}"`,
    `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\..\\powershell.exe" -Command "${command}"`,
    `'${wrapped}'`, `echo ${wrapped}`, `"${executable}"\t-Command "${command}"`,
  ];
  for (const candidate of rejected) assert.equal(matchesCodexCommand(candidate, command, windows), false, candidate);
});

test('wrapper compatibility never interprets shell syntax in the configured command', () => {
  for (const expected of ['git push; echo yes', 'git push $env:SECRET', "git push 'quoted'", 'git push `whoami`',
    'git push && echo yes', 'git push\nwhoami', 'git push > log', 'git push *', 'git push # note']) {
    assert.equal(matchesCodexCommand(expected, expected, windows), true, 'raw exact operator command remains explicit');
    assert.equal(matchesCodexCommand(`"${executable}" -Command "${expected}"`, expected, windows), false);
  }
});
