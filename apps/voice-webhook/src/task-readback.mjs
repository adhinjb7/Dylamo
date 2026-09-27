import { isStatusRequest, localReplyForTranscript } from './transcript-intent.mjs';

const CONFIRM = new Set(['yes', 'yes start it', 'yes please', 'start it']);
const DISCARD = new Set(['no', 'no cancel', 'no cancel it', 'cancel', 'cancel it', 'start over']);
const MAX_READBACK_CHARACTERS = 600;

// One ephemeral draft per authenticated call. This confirms the task text only;
// it cannot produce an approval.response or retain consent across calls.
export function createTaskReadback({ now = Date.now, ttlMs = 60_000 } = {}) {
  let pending;
  const clear = () => { pending = undefined; };
  const readback = () => `I heard: ${JSON.stringify(pending.prompt)}. Say yes, start it if that is correct, or no to discard it. This confirms the task only, not a protected action.`;

  function receive(transcript) {
    if (typeof transcript !== 'string' || !transcript.trim()) return {};
    const prompt = transcript.trim();
    const choice = prompt.toLowerCase().replace(/[.!?]+$/, '').replaceAll(',', '').trim().replace(/\s+/g, ' ');
    const expired = pending && pending.expiresAt <= now();
    if (expired) clear();

    if (CONFIRM.has(choice)) {
      if (!pending) return { reply: expired
        ? 'That read-back expired. Please say your request again. No task was started.'
        : 'There is no request waiting for confirmation. Please say what you want Codex to do.' };
      const confirmed = pending.prompt;
      clear(); // Consume before dispatch so duplicates cannot launch it twice.
      return { prompt: confirmed };
    }
    if (DISCARD.has(choice)) {
      clear();
      return { reply: 'Request discarded. No task was started. Please say your request again when ready.' };
    }
    if (isStatusRequest(prompt)) return { reply: pending ? readback()
      : 'There is no Codex task running right now. You can ask another question.' };
    const localReply = localReplyForTranscript(prompt);
    if (localReply) return { reply: localReply };

    // Never ask the caller to confirm a truncated command or hidden suffix.
    if (prompt.length > MAX_READBACK_CHARACTERS) {
      clear();
      return { reply: 'Please give a shorter request so I can read it back in full. No task was started.' };
    }
    pending = { prompt, expiresAt: now() + ttlMs };
    return { reply: readback() };
  }

  return { receive, clear };
}
