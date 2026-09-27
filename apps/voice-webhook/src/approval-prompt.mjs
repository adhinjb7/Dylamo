// Presentation only. Decisions still use the exact persisted command/digest.
// Only fixed daemon-verified action kinds get a short implication summary.
export function approvalPrompt(context, { mode = 'codex', channel = 'inbound', details = false } = {}) {
  const knownLocalPush = mode === 'codex' && context.action_kind === 'local-demo-push'
    && context.codex_item_id && context.codex_request_id
    && (context.permission_scope == null || context.permission_scope === 'null');
  let description;
  if (details || (mode !== 'fake' && !knownLocalPush)) {
    description = `${mode === 'fake' ? 'Simulated action' : 'Exact action'}: ${context.command}. Working directory: ${context.cwd}.`;
    if (context.permission_scope && context.permission_scope !== 'null') {
      description += ` Extra permissions: ${context.permission_scope}.`;
    }
  } else {
    description = mode === 'fake'
      ? 'This is a practice push. No files will change.'
      : 'Ready to publish the prepared changes to the local demo branch. Nothing goes to GitHub.';
  }
  const choices = channel === 'callback'
    ? 'Say approve or push the demo repo to allow once, reject to decline, or details for the exact command. Keypad 1, 2, and 3 also work.'
    : details ? 'Say approve or press 1 to allow once. Say reject or press 2 to decline.'
      : 'Say approve or reject, or details for the exact command. You can hang up for a callback.';
  return `${description} ${choices}`;
}
