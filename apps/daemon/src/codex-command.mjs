import { win32 } from 'node:path';

// Diagnostics only: preserve quoting/escaping around known text, not arbitrary
// command arguments, paths, credentials or reasons. Never use this to approve.
export function describeCodexCommand(actual, expected, {
  platform = process.platform, windowsRoot = process.env.SystemRoot ?? process.env.WINDIR,
} = {}) {
  const windowsRootKnown = typeof windowsRoot === 'string' && /^[A-Za-z]:[\\/][A-Za-z0-9_ .\\/-]+$/.test(windowsRoot);
  if (typeof actual !== 'string') return { windows: platform === 'win32', windowsRootKnown, shape: 'missing-or-nonstring' };
  const tokens = [];
  if (typeof expected === 'string' && expected) tokens.push([expected, '<configured-command>', false]);
  if (windowsRootKnown) {
    const shell = win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    tokens.push([shell, '<system-powershell>', true],
      [shell.replaceAll('\\', '\\\\'), '<escaped-system-powershell>', true],
      [shell.replaceAll('\\', '/'), '<slash-system-powershell>', true]);
  }
  for (const token of ['powershell.exe', 'pwsh.exe', '-NoProfile', '-Command', '-EncodedCommand', '-File']) {
    tokens.push([token, token, true]);
  }
  tokens.sort((a, b) => b[0].length - a[0].length);
  let shape = '';
  let unknown = false;
  let offset = 0;
  while (offset < actual.length && offset < 4000 && shape.length < 500) {
    const token = tokens.find(([text, , ignoreCase]) => ignoreCase
      ? actual.slice(offset, offset + text.length).toLowerCase() === text.toLowerCase()
      : actual.startsWith(text, offset));
    if (token) {
      shape += token[1]; offset += token[0].length; unknown = false;
    } else {
      const char = actual[offset++];
      const punctuation = " '\"\\[]();&|=:";
      if (punctuation.includes(char) || /[\r\n\t]/.test(char)) {
        shape += char === '\r' ? '<CR>' : char === '\n' ? '<LF>' : char === '\t' ? '<TAB>' : char;
        unknown = false;
      } else if (!unknown) { shape += '<other>'; unknown = true; }
    }
  }
  if (offset < actual.length) shape += '<truncated>';
  return { windows: platform === 'win32', windowsRootKnown, shape };
}

// App-server command previews can include the Windows shell's argv wrapper.
// Recognize a finite set of complete representations, never a substring or a
// best-effort commandActions preview. We do not evaluate/parse arbitrary shell.
export function matchesCodexCommand(actual, expected, {
  platform = process.platform, windowsRoot = process.env.SystemRoot ?? process.env.WINDIR,
} = {}) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected) return false;
  if (actual === expected) return true;
  // Wrapper compatibility is deliberately restricted to literal word commands.
  // Quotes, substitutions, redirection, separators, newlines and other shell
  // syntax are not normalized. An operator's more complex command must match
  // the complete raw runtime string exactly instead.
  if (!/^[A-Za-z0-9_.:/-]+(?: [A-Za-z0-9_.:/-]+)*$/.test(expected)) return false;
  // Codex on macOS presents the literal command through zsh. Accept only the
  // observed login-shell form and only the known system shell; no additional
  // flags, arguments, substitutions, or shell syntax are normalized.
  if (platform === 'darwin') {
    return [`zsh -lc '${expected}'`, `/bin/zsh -lc '${expected}'`].includes(actual);
  }
  if (platform !== 'win32') return false;
  if (typeof windowsRoot !== 'string' || !/^[A-Za-z]:[\\/][A-Za-z0-9_ .\\/-]+$/.test(windowsRoot)) return false;
  const executable = win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const shells = [`'${executable}'`, `"${executable}"`];
  if (!/\s/.test(executable)) shells.push(executable);
  // Observed in the operator's app-server thread/read preview: the executable
  // is double-quoted and each Windows separator is escaped as two backslashes.
  // Generate that one known path representation; do NOT unescape arbitrary
  // input or alter the command body. The full runtime string stays in the
  // approval record/digest. Bare and single-quoted escaped paths stay rejected.
  shells.push(`"${executable.replaceAll('\\', '\\\\')}"`);
  // These correspond to the native Windows PowerShell runtime with its default
  // login behavior or login:false. No -File, encoded command, alternate shell,
  // policy changes, startup switches or trailing arguments are accepted.
  for (const shell of shells) {
    for (const flags of ['-Command', '-NoProfile -Command']) {
      const prefix = `${shell} ${flags} `;
      if (actual.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) continue;
      const body = actual.slice(prefix.length);
      if ([expected, `'${expected}'`, `"${expected}"`].includes(body)) return true;
    }
  }
  return false;
}
