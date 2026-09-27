const ORDINALS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const SELECT = /^(?:select|choose)(?: option| agent| number)? (one|two|three|four|five|six|seven|eight|nine|[1-9])$/;
const CONNECT = new Set(['yes connect', 'connect']);
const NO = new Set(['no', 'no thanks', 'cancel', 'start over']);

const normalize = (text) => typeof text === 'string'
  ? text.trim().toLowerCase().replace(/[.!?]+$/g, '').replace(/\s+/g, ' ') : '';
const label = (text) => String(text ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'agent';

// A task request waits in memory while the caller chooses an online agent.
// An ordinal is read back before dispatch, and no choice survives this call.
export function createAgentSelection({ now = Date.now, ttlMs = 60_000 } = {}) {
  let pending;
  const clear = () => { pending = undefined; };
  const menu = () => `I found ${pending.options.length} available agents. ${pending.options.map((option, index) =>
    `Option ${ORDINALS[index]}: ${label(option.name)}.`).join(' ')} Say select followed by the option number.`;

  function offer(prompt, options) {
    if (!Array.isArray(options) || options.length < 2 || options.length > ORDINALS.length) {
      clear();
      return 'There are too many available agents for this phone menu. Please narrow the selection on the laptop and repeat your request.';
    }
    pending = { prompt, options: options.map((option) => ({ ...option })), selected: null, expiresAt: now() + ttlMs };
    return menu();
  }

  function receive(transcript) {
    if (!pending) return { unhandled: true };
    if (pending.expiresAt <= now()) {
      clear();
      return { reply: 'Agent selection expired. Please repeat your request. No task was started.' };
    }
    const choice = normalize(transcript);
    if (CONNECT.has(choice)) {
      if (pending.selected == null) return { reply: 'Choose an agent first. ' + menu() };
      const result = { prompt: pending.prompt, selected: pending.options[pending.selected] };
      clear();
      return result;
    }
    if (NO.has(choice)) {
      if (pending.selected != null) {
        pending.selected = null;
        return { reply: 'Selection cleared. ' + menu() };
      }
      clear();
      return { reply: 'Request discarded. No task was started.' };
    }
    const match = SELECT.exec(choice);
    if (match) {
      const index = /^\d$/.test(match[1]) ? Number(match[1]) - 1 : ORDINALS.indexOf(match[1]);
      if (index >= pending.options.length) return { reply: 'That option is not available. ' + menu() };
      pending.selected = index;
      return { reply: `I selected ${label(pending.options[index].name)}. Say yes connect to start your request, or no to choose again.` };
    }
    if (isStatusRequest(choice)) {
      return { reply: pending.selected == null ? menu()
        : `I selected ${label(pending.options[pending.selected].name)}. Say yes connect to start your request.` };
    }
    clear();
    return { unhandled: true };
  }

  return { offer, receive, clear };
}
import { isStatusRequest } from './transcript-intent.mjs';
