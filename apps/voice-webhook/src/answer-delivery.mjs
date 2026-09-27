const DIRECT_WORD_LIMIT = 42;
const DETAIL_WORD_LIMIT = 42;

const words = (text) => text.match(/\S+/g) ?? [];
const choiceFor = (text) => typeof text === 'string'
  ? text.trim().toLowerCase().replace(/[.!?]+$/g, '').replace(/\s+/g, ' ') : '';

function shortVersion(text) {
  const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
  const firstWords = words(sentences[0] ?? text);
  const lead = firstWords.slice(0, 32).join(' ');
  const testTerm = /\b(?:tests?|passed|failed|failures?|errors?)\b/i;
  const evidence = sentences.filter((sentence, index) => testTerm.test(sentence) &&
    (index !== 0 || firstWords.length > 32)).slice(0, 2).map((sentence) => {
    const sentenceWords = words(sentence);
    const signal = sentenceWords.findIndex((word) => testTerm.test(word));
    return sentenceWords.slice(Math.max(0, signal - 4), signal + 25).join(' ');
  });
  return `Short version: ${lead}${firstWords.length > 32 ? '…' : ''}${evidence.length ? ` ${evidence.join(' ')}` : ''} Say details to hear the full answer.`;
}

// The full result stays in task history. This object only controls what a live
// call speaks, so the caller can request one short section at a time.
export function createAnswerDelivery(result) {
  const text = typeof result === 'string' ? result.trim() : '';
  if (!text) return null;
  const allWords = words(text);
  const needsChoice = allWords.length > DIRECT_WORD_LIMIT;
  const chunks = [];
  for (let i = 0; i < allWords.length; i += DETAIL_WORD_LIMIT) {
    chunks.push(allWords.slice(i, i + DETAIL_WORD_LIMIT).join(' '));
  }
  let nextChunk = 0;
  let lastChunk = null;

  function receive(transcript) {
    const choice = choiceFor(transcript);
    if (['summary', 'the summary', 'short version', 'give me a summary'].includes(choice)) {
      return { handled: true, message: shortVersion(text) };
    }
    if (['details', 'the details', 'read the details', 'continue', 'more'].includes(choice)) {
      if (nextChunk >= chunks.length) return { handled: true, message: 'That is the full answer. You can ask Codex a follow-up question.' };
      lastChunk = chunks[nextChunk++];
      return { handled: true, message: `${lastChunk} ${nextChunk < chunks.length
        ? 'Say continue for the next part.' : 'That is the full answer.'}` };
    }
    if (choice === 'repeat' && lastChunk) {
      return { handled: true, message: `${lastChunk} ${nextChunk < chunks.length
        ? 'Say continue for the next part.' : 'That is the full answer.'}` };
    }
    if (choice === 'repeat') return { handled: true, message: 'Say summary or details first.' };
    if (['no', 'no thanks', 'neither'].includes(choice)) {
      return { handled: true, dismiss: true, message: 'Okay. Ask another question whenever you are ready.' };
    }
    return { handled: false };
  }

  return { needsChoice, opening: needsChoice
    ? 'Codex finished. The answer is long. Would you like a summary or details?'
    : text, receive };
}
