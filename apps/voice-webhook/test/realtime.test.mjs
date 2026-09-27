import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import WebSocket from 'ws';
import { connectRealtime } from '../src/realtime.mjs';

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  receive(event) { this.emit('message', Buffer.from(JSON.stringify(event))); }
}

test('Realtime bridge configures PCMU and forwards audio both ways', () => {
  const twilio = new FakeSocket();
  const upstream = new FakeSocket();
  let connection;
  const bridge = connectRealtime({
    twilio,
    streamSid: `MZ${'a'.repeat(32)}`,
    apiKey: 'test-key',
    createSocket: (url, options) => {
      connection = { url, options };
      return upstream;
    },
  });
  assert.match(connection.url, /model=gpt-realtime-2\.1/);
  assert.equal(connection.options.headers.Authorization, 'Bearer test-key');
  bridge.appendAudio('AAAA');
  upstream.emit('open');
  assert.equal(upstream.sent[0].type, 'session.update');
  assert.equal(upstream.sent[0].session.audio.input.format.type, 'audio/pcmu');
  assert.equal(upstream.sent[0].session.audio.output.format.type, 'audio/pcmu');
  assert.equal(upstream.sent[0].session.audio.input.transcription, undefined, 'voice-only mode is unchanged');
  upstream.receive({ type: 'session.updated' });
  assert.deepEqual(upstream.sent[1], { type: 'input_audio_buffer.append', audio: 'AAAA' });

  const delta = Buffer.alloc(800, 0xff).toString('base64');
  upstream.receive({ type: 'response.output_audio.delta', item_id: 'item_1', content_index: 0, delta });
  upstream.receive({ type: 'response.output_audio.delta', item_id: 'item_1', content_index: 0, delta });
  assert.equal(twilio.sent[0].event, 'media');
  assert.equal(twilio.sent[0].media.payload, delta);
  assert.equal(twilio.sent[1].event, 'mark');
  bridge.acknowledgeMark(twilio.sent[1].mark.name);
  upstream.receive({ type: 'input_audio_buffer.speech_started' });
  assert.equal(twilio.sent.at(-1).event, 'clear');
  assert.deepEqual(upstream.sent.at(-1), {
    type: 'conversation.item.truncate', item_id: 'item_1', content_index: 0, audio_end_ms: 100,
  });
  bridge.close();
  assert.equal(upstream.readyState, WebSocket.CLOSED);
});

test('controlled Realtime transcribes without auto-reply and speaks only server text', () => {
  const twilio = new FakeSocket();
  const upstream = new FakeSocket();
  const transcripts = [];
  const speechEvents = [];
  const bridge = connectRealtime({
    twilio, streamSid: `MZ${'b'.repeat(32)}`, apiKey: 'test-key', controlled: true,
    onTranscript: (text) => transcripts.push(text), createSocket: () => upstream,
    onSpeechStart: () => speechEvents.push('start'), onSpeechStop: () => speechEvents.push('stop'),
  });
  try {
    assert.equal(bridge.speak('Starting a demo task.'), true);
    upstream.emit('open');
    assert.equal(upstream.sent[0].session.audio.input.transcription.model, 'gpt-transcribe');
    assert.deepEqual(upstream.sent[0].session.audio.input.transcription.languages, ['en']);
    assert.equal(upstream.sent[0].session.audio.input.transcription.language, undefined);
    assert.ok(upstream.sent[0].session.audio.input.transcription.keywords.includes('Run the demo push'));
    assert.ok(upstream.sent[0].session.audio.input.transcription.keywords.includes('Push the demo repo'));
    assert.match(upstream.sent[0].session.audio.input.transcription.prompt, /English.*Dylamo.*Codex/);
    assert.equal(upstream.sent[0].session.audio.input.turn_detection.create_response, false);
    upstream.receive({ type: 'session.updated' });
    assert.equal(upstream.sent[1].type, 'response.create');
    assert.match(upstream.sent[1].response.instructions, /Starting a demo task/);
    upstream.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item1', transcript: 'Please check my repository.' });
    assert.deepEqual(transcripts, ['Please check my repository.']);
    upstream.receive({ type: 'input_audio_buffer.speech_started' });
    upstream.receive({ type: 'input_audio_buffer.speech_stopped' });
    assert.deepEqual(speechEvents, ['start', 'stop']);
  } finally { bridge.close(); }
});

test('transcription hints never rewrite garbled text or turn transcription failure into a task', () => {
  const twilio = new FakeSocket();
  const upstream = new FakeSocket();
  const transcripts = [];
  let failures = 0;
  const bridge = connectRealtime({ twilio, streamSid: 'MZtranscription', apiKey: 'test-key', controlled: true,
    onTranscript: text => transcripts.push(text), onTranscriptionFailure: () => { failures++; }, createSocket: () => upstream });
  try {
    upstream.receive({ type: 'session.updated' });
    for (const transcript of ['走走。', 'Randh denopush.', 'Do not run the demo push.']) {
      upstream.receive({ type: 'conversation.item.input_audio_transcription.completed', transcript });
    }
    assert.deepEqual(transcripts, ['走走。', 'Randh denopush.', 'Do not run the demo push.']);
    upstream.receive({ type: 'conversation.item.input_audio_transcription.failed', error: { message: 'private failure detail' } });
    assert.equal(transcripts.length, 3);
    assert.equal(failures, 1);
    assert.match(upstream.sent.at(-1).response.instructions, /Please repeat your request/);
    assert.equal(JSON.stringify(upstream.sent).includes('private failure detail'), false);
    assert.equal(twilio.readyState, WebSocket.OPEN);
  } finally { bridge.close(); }
});

test('duplicate transcript events cannot replay a task or its confirmation', () => {
  const twilio = new FakeSocket();
  const upstream = new FakeSocket();
  const transcripts = [];
  const bridge = connectRealtime({ twilio, streamSid: 'MZduplicates', apiKey: 'test-key', controlled: true,
    onTranscript: (text, id) => transcripts.push({ text, id }), createSocket: () => upstream });
  try {
    const task = { type: 'conversation.item.input_audio_transcription.completed', item_id: 'task-item', transcript: 'Run the demo push.' };
    const confirmation = { ...task, item_id: 'confirmation-item', transcript: 'Yes, start it.' };
    for (const event of [task, confirmation, task, confirmation]) upstream.receive(event);
    assert.deepEqual(transcripts, [{ text: task.transcript, id: task.item_id },
      { text: confirmation.transcript, id: confirmation.item_id }]);
    upstream.receive({ ...task, item_id: 'new-utterance' });
    assert.equal(transcripts.length, 3, 'distinct utterances may have the same words');
  } finally { bridge.close(); }
});

test('speech-start item IDs allow delayed transcripts to be bound to the correct utterance', () => {
  const twilio = new FakeSocket();
  const upstream = new FakeSocket();
  const starts = [];
  const transcripts = [];
  const bridge = connectRealtime({ twilio, streamSid: 'MZbinding', apiKey: 'test-key', controlled: true,
    onSpeechStart: id => starts.push(id), onTranscript: (text, id) => transcripts.push({ text, id }),
    createSocket: () => upstream });
  try {
    for (const item_id of ['old-turn', 'new-turn']) upstream.receive({ type: 'input_audio_buffer.speech_started', item_id });
    upstream.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'new-turn', transcript: 'Repeat.' });
    upstream.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'old-turn', transcript: 'Approve.' });
    assert.deepEqual(starts, ['old-turn', 'new-turn']);
    assert.deepEqual(transcripts, [{ text: 'Repeat.', id: 'new-turn' }, { text: 'Approve.', id: 'old-turn' }]);
  } finally { bridge.close(); }
});

function controlledFixture() {
  const twilio = new FakeSocket();
  const upstream = new FakeSocket();
  const errors = [];
  const bridge = connectRealtime({
    twilio, streamSid: 'MZspeech', apiKey: 'test-key', controlled: true,
    createSocket: () => upstream, logger: { error: (message) => errors.push(message) },
  });
  const responses = () => upstream.sent.filter((event) => event.type === 'response.create');
  return { twilio, upstream, errors, bridge, responses };
}

test('task acknowledgment and immediate failure are spoken sequentially without disconnecting', () => {
  const f = controlledFixture();
  try {
    f.upstream.receive({ type: 'session.updated' });
    f.bridge.speak('I started a real Codex task.');
    f.bridge.speak('Could not launch Codex app server.');
    assert.equal(f.responses().length, 1, 'reserve the response before response.created arrives');
    f.upstream.receive({ type: 'response.created', response: { id: 'resp-1' } });
    f.bridge.speak('Please check the daemon log.');
    f.upstream.receive({ type: 'response.output_audio.done', response_id: 'resp-1' });
    assert.equal(f.responses().length, 1, 'audio.done is not response.done');
    f.upstream.receive({ type: 'response.done', response: { id: 'resp-1', status: 'completed' } });
    assert.equal(f.responses().length, 2);
    assert.match(f.responses()[1].response.instructions, /Could not launch Codex/);
    f.upstream.receive({ type: 'response.created', response: { id: 'resp-2' } });
    f.upstream.receive({ type: 'response.done', response: { id: 'resp-2', status: 'completed' } });
    assert.equal(f.responses().length, 3);
    assert.match(f.responses()[2].response.instructions, /check the daemon log/);
    assert.equal(f.twilio.readyState, WebSocket.OPEN);
  } finally { f.bridge.close(); }
});

test('speech queued before session readiness drains one response at a time and stops on close', () => {
  const f = controlledFixture();
  f.bridge.speak('First message.');
  f.bridge.speak('Second message.');
  assert.equal(f.responses().length, 0);
  f.upstream.receive({ type: 'session.updated' });
  assert.equal(f.responses().length, 1);
  f.bridge.close();
  f.upstream.receive({ type: 'response.done', response: { id: 'resp-1', status: 'cancelled' } });
  assert.equal(f.responses().length, 1);
  assert.equal(f.bridge.speak('Too late.'), false);
});

test('an active-response conflict waits for completion and retries the rejected speech', () => {
  const f = controlledFixture();
  try {
    f.upstream.receive({ type: 'session.updated' });
    f.bridge.speak('Read the task result.');
    f.bridge.speak('Next message.');
    f.upstream.receive({ type: 'error', error: {
      code: 'conversation_already_has_active_response', event_id: f.responses()[0].event_id,
    } });
    assert.equal(f.twilio.readyState, WebSocket.OPEN);
    assert.equal(f.responses().length, 1);
    f.upstream.receive({ type: 'response.done', response: { id: 'other-response', status: 'completed' } });
    assert.equal(f.responses().length, 2);
    assert.match(f.responses()[1].response.instructions, /Read the task result/);
    f.upstream.receive({ type: 'response.created', response: { id: 'retry' } });
    f.upstream.receive({ type: 'response.done', response: { id: 'retry', status: 'completed' } });
    assert.equal(f.responses().length, 3);
    assert.match(f.responses()[2].response.instructions, /Next message/);
  } finally { f.bridge.close(); }
});

test('controlled barge-in cancels generation, clears playback and drops late audio without cancelling the task', () => {
  const f = controlledFixture();
  try {
    f.upstream.receive({ type: 'session.updated' });
    f.bridge.speak('A long result.');
    f.bridge.speak('An old queued reminder.');
    f.upstream.receive({ type: 'response.created', response: { id: 'resp-long' } });
    const audio = { type: 'response.output_audio.delta', response_id: 'resp-long', item_id: 'spoken-result',
      content_index: 0, delta: Buffer.alloc(800, 0xff).toString('base64') };
    f.upstream.receive(audio);
    f.bridge.acknowledgeMark(f.twilio.sent.at(-1).mark.name);
    f.upstream.receive(audio);
    const clearedMark = f.twilio.sent.at(-1).mark.name;
    f.upstream.receive({ type: 'input_audio_buffer.speech_started' });
    assert.equal(f.twilio.sent.at(-1).event, 'clear');
    assert.equal(f.upstream.sent.find(event => event.type === 'response.cancel').response_id, 'resp-long');
    assert.deepEqual(f.upstream.sent.at(-1), { type: 'conversation.item.truncate', item_id: 'spoken-result', content_index: 0, audio_end_ms: 100 });
    f.bridge.acknowledgeMark(clearedMark); // Twilio returns marks for cleared audio too.
    f.upstream.receive(audio);
    assert.equal(f.twilio.sent.at(-1).event, 'clear', 'late audio is not played');
    f.bridge.speak('A new task result arriving during caller speech.');
    f.upstream.receive({ type: 'response.done', response: { id: 'resp-long', status: 'cancelled' } });
    assert.equal(f.responses().length, 1, 'wait until the caller stops speaking');
    f.upstream.receive({ type: 'input_audio_buffer.speech_stopped' });
    assert.equal(f.responses().length, 2);
    assert.match(f.responses()[1].response.instructions, /new task result/);
    assert.equal(f.twilio.readyState, WebSocket.OPEN);
  } finally { f.bridge.close(); }
});

test('barge-in before response.created cancels by ID once it arrives and tolerates a completion race', () => {
  const f = controlledFixture();
  try {
    f.upstream.receive({ type: 'session.updated' });
    f.bridge.speak('Checking now.');
    f.upstream.receive({ type: 'input_audio_buffer.speech_started' });
    assert.equal(f.upstream.sent.some(event => event.type === 'response.cancel'), false);
    f.upstream.receive({ type: 'response.created', response: { id: 'late-created' } });
    const cancel = f.upstream.sent.at(-1);
    assert.equal(cancel.type, 'response.cancel');
    f.upstream.receive({ type: 'error', error: { code: 'response_cancel_not_active', event_id: cancel.event_id } });
    f.upstream.receive({ type: 'response.done', response: { id: 'late-created', status: 'completed' } });
    assert.equal(f.twilio.readyState, WebSocket.OPEN);
    assert.deepEqual(f.errors, []);
  } finally { f.bridge.close(); }
});

test('controlled renderer waits for Twilio playback before starting another response', () => {
  const f = controlledFixture();
  try {
    f.upstream.receive({ type: 'session.updated' });
    f.bridge.speak('First.');
    f.bridge.speak('Second.');
    f.upstream.receive({ type: 'response.created', response: { id: 'first' } });
    f.upstream.receive({ type: 'response.output_audio.delta', response_id: 'first', item_id: 'first-item',
      delta: Buffer.alloc(800, 0xff).toString('base64') });
    f.upstream.receive({ type: 'response.done', response: { id: 'first', status: 'completed' } });
    assert.equal(f.responses().length, 1);
    f.bridge.acknowledgeMark(f.twilio.sent.at(-1).mark.name);
    assert.equal(f.responses().length, 2);
  } finally { f.bridge.close(); }
});
