// Only exact, self-contained phrases are handled locally. A longer request
// (including one beginning with a greeting) still reaches the agent.
const GREETINGS = new Set([
  'hi', 'hello', 'hey', 'hi there', 'hello there', 'hey there',
  'good morning', 'good afternoon', 'good evening',
]);
const STATUS_REQUESTS = new Set(['status', 'what is the status', "what's the status", 'any update',
  'any updates', 'how is it going', 'are you still working']);

export function localReplyForTranscript(transcript) {
  if (typeof transcript !== 'string') return null;
  const text = transcript.trim().toLowerCase().replace(/[.!?]+$/g, '').trim().replace(/\s+/g, ' ');
  if (GREETINGS.has(text)) {
    return 'Hi! Ask me a question about the demo repository when you are ready.';
  }
  if (text === 'can you hear me' || text === 'are you there') {
    return 'Yes, I can hear you. What would you like to know about the demo repository?';
  }
  if (text === 'what can you do') {
    return 'I can investigate the demo repository in read-only mode and answer your questions about it.';
  }
  if (text === 'thanks' || text === 'thank you') {
    return 'You are welcome. Ask another question whenever you are ready.';
  }
  return null;
}

export function isStatusRequest(transcript) {
  if (typeof transcript !== 'string') return false;
  const text = transcript.trim().toLowerCase().replace(/[.!?]+$/g, '').trim().replace(/\s+/g, ' ');
  return STATUS_REQUESTS.has(text);
}
