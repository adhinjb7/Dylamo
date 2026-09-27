import { isStatusRequest } from './transcript-intent.mjs';

const CONFIRM = new Set(['yes steer it', 'yes change it']);
const DISCARD = new Set(['no', 'no keep working', 'keep working']);
const MAX_STEER_CHARACTERS = 600;

function choice(text) {
  return text.toLowerCase().replace(/[.!?]+$/g, '').replaceAll(',', '').trim().replace(/\s+/g, ' ');
}

function instructionFrom(text) {
  const match = text.match(/^\s*(?:steer\s+(?:the\s+)?task(?:\s+to)?|actually)\s*[:,]?\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

export function createTaskSteer({ now = Date.now, ttlMs = 15_000 } = {}) {
  let draft;
  const clear = () => { draft = undefined; };
  const hasPending = () => Boolean(draft && draft.expiresAt > now());
  const readback = () => `I heard this change for the current task: ${JSON.stringify(draft.prompt)}. Say yes, steer it, or no, keep working. This does not approve a protected action.`;

  function receive(transcript) {
    if (typeof transcript !== 'string' || !transcript.trim()) return { handled: false };
    const normalized = choice(transcript);
    const expired = draft && draft.expiresAt <= now();
    if (expired) clear();
    if (CONFIRM.has(normalized)) {
      if (!draft) return { handled: true, reply: expired
        ? 'That change expired. Say the full steering request again. Nothing was sent.'
        : 'There is no change awaiting confirmation. Nothing was sent.' };
      const prompt = draft.prompt;
      clear();
      return { handled: true, prompt };
    }
    if (draft && DISCARD.has(normalized)) {
      clear();
      return { handled: true, reply: 'Change discarded. The current task continues.' };
    }
    if (draft && isStatusRequest(transcript)) return { handled: true, reply: readback() };
    const instruction = instructionFrom(transcript);
    if (instruction) {
      if (instruction.length > MAX_STEER_CHARACTERS) {
        clear();
        return { handled: true, reply: 'That change is too long to read back in full. Please give a shorter steering request. Nothing was sent.' };
      }
      draft = { prompt: instruction, expiresAt: now() + ttlMs };
      return { handled: true, reply: readback() };
    }
    clear();
    return { handled: false };
  }

  return { receive, clear, hasPending };
}
