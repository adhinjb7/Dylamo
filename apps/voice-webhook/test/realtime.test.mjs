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
  const bridge = connectRealtime({
    twilio, streamSid: `MZ${'b'.repeat(32)}`, apiKey: 'test-key', controlled: true,
    onTranscript: (text) => transcripts.push(text), createSocket: () => upstream,
  });
  try {
    assert.equal(bridge.speak('Starting a demo task.'), true);
    upstream.emit('open');
    assert.equal(upstream.sent[0].session.audio.input.transcription.model, 'gpt-transcribe');
    assert.equal(upstream.sent[0].session.audio.input.turn_detection.create_response, false);
    upstream.receive({ type: 'session.updated' });
    assert.equal(upstream.sent[1].type, 'response.create');
    assert.match(upstream.sent[1].response.instructions, /Starting a demo task/);
    upstream.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item1', transcript: 'Please check my repository.' });
    assert.deepEqual(transcripts, ['Please check my repository.']);
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

test('controlled speech is not truncated by caller speech while automatic interruption is disabled', () => {
  const f = controlledFixture();
  try {
    f.upstream.receive({ type: 'response.output_audio.delta', item_id: 'spoken-result',
      content_index: 0, delta: Buffer.alloc(800, 0xff).toString('base64') });
    f.upstream.receive({ type: 'input_audio_buffer.speech_started' });
    assert.equal(f.twilio.sent.some((event) => event.event === 'clear'), false);
    assert.equal(f.upstream.sent.some((event) => event.type === 'conversation.item.truncate'), false);
  } finally { f.bridge.close(); }
});
