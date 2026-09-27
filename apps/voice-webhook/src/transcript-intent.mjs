// Only exact, self-contained phrases are handled locally. A longer request
// (including one beginning with a greeting) still reaches the agent.
const GREETINGS = new Set([
  'hi', 'hello', 'hey', 'hi there', 'hello there', 'hey there',
  'good morning', 'good afternoon', 'good evening',
]);
const STATUS_REQUESTS = new Set(['status', 'what is the status', "what's the status", 'any update',
  'any updates', 'how is it going', 'are you still working']);
// There is no task read-back in the MVP. Acknowledgments (including replies
// remembered from the old flow) must not become new repository tasks.
const ACKNOWLEDGMENTS = new Set([
  'yes', 'yeah', 'yep', 'yup', 'sure', 'okay', 'ok', 'correct', 'right', 'affirmative',
  'no', 'nope', 'nah', 'no thanks', 'no thank you',
  'yes please', 'yes start it', 'start it', 'yes please start it', 'please start it', 'start it please',
  'yes do it', 'go ahead', 'yes go ahead', 'sure go ahead', 'okay yes', 'ok yes', 'i said yes',
  "that's correct", 'that is correct', "yes that's correct", 'yes that is correct',
  "yeah that's correct", 'yeah that is correct', 'yes correct', "it's correct", "yes it's correct",
  "that's right", 'that is right', "yes that's right", 'yes that is right', "yeah that's right", 'yeah that is right',
  'yes stop it', 'yes cancel it', 'yes steer it', 'no keep working', 'yes connect',
  'approve', 'approve it', 'yes approve', 'yes approve it', 'reject', 'reject it', 'no reject', 'no reject it',
]);

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
  const acknowledgment = text.replace(/[’‘]/g, "'").replaceAll(',', ' ').replace(/\s+/g, ' ');
  if (ACKNOWLEDGMENTS.has(acknowledgment) || /^(?:yes|yeah|yep|yup)(?:[\s.!?]+(?:yes|yeah|yep|yup))+$/.test(acknowledgment)) {
    return 'Ready for your next request.';
  }
  return null;
}

export function isStatusRequest(transcript) {
  if (typeof transcript !== 'string') return false;
  const text = transcript.trim().toLowerCase().replace(/[.!?]+$/g, '').trim().replace(/\s+/g, ' ');
  return STATUS_REQUESTS.has(text);
}
