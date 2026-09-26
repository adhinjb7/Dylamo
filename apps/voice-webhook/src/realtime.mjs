import WebSocket from 'ws';

const MODEL = 'gpt-realtime-2.1';
const MAX_PENDING_FRAMES = 200;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

export function connectRealtime({ twilio, streamSid, apiKey, controlled = false, onTranscript = () => {}, createSocket = (url, options) => new WebSocket(url, options), logger = console }) {
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for realtime voice');
  const upstream = createSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const pendingFrames = [];
  const pendingSpeech = [];
  const pendingMarks = new Map();
  let ready = false;
  let closed = false;
  let responseActive = false;
  let activeResponseId;
  let activeSpeech;
  let speechNumber = 0;
  let markNumber = 0;
  let currentItem;
  let emittedMs = 0;
  let playedMs = 0;
  let contentIndex = 0;

  function sendUpstream(event) {
    if (upstream.readyState !== WebSocket.OPEN) return false;
    if (upstream.bufferedAmount > MAX_BUFFERED_BYTES) return false;
    upstream.send(JSON.stringify(event));
    return true;
  }

  function sendTwilio(event) {
    if (twilio.readyState !== WebSocket.OPEN) return false;
    if (twilio.bufferedAmount > MAX_BUFFERED_BYTES) return false;
    twilio.send(JSON.stringify({ ...event, streamSid }));
    return true;
  }

  function appendAudio(payload) {
    if (!ready) {
      if (pendingFrames.length >= MAX_PENDING_FRAMES) pendingFrames.shift();
      pendingFrames.push(payload);
      return;
    }
    sendUpstream({ type: 'input_audio_buffer.append', audio: payload });
  }

  function flushSpeech() {
    if (!controlled || !ready || closed || responseActive || !pendingSpeech.length) return;
    activeSpeech = { text: pendingSpeech.shift(), eventId: `speech-${++speechNumber}` };
    // Reserve immediately: response.created arrives asynchronously, and a task
    // result can arrive while its acknowledgment is still being generated.
    responseActive = true;
    const sent = sendUpstream({
      type: 'response.create',
      event_id: activeSpeech.eventId,
      response: {
        output_modalities: ['audio'], input: [],
        instructions: `Say exactly the following message, without adding anything: ${JSON.stringify(activeSpeech.text)}`,
      },
    });
    if (!sent) {
      pendingSpeech.unshift(activeSpeech.text);
      activeSpeech = undefined;
      responseActive = false;
    }
  }

  function speak(text) {
    if (!controlled || typeof text !== 'string' || !text.trim() || closed) return false;
    pendingSpeech.push(text);
    flushSpeech();
    return true;
  }

  function acknowledgeMark(name) {
    const mark = pendingMarks.get(name);
    if (!mark) return;
    pendingMarks.delete(name);
    if (mark.itemId === currentItem) playedMs = Math.max(playedMs, mark.endMs);
  }

  function close() {
    if (closed) return;
    closed = true;
    pendingFrames.length = 0;
    pendingSpeech.length = 0;
    pendingMarks.clear();
    activeSpeech = undefined;
    activeResponseId = undefined;
    responseActive = false;
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close();
    }
  }

  upstream.on('open', () => {
    sendUpstream({
      type: 'session.update',
      session: {
        type: 'realtime',
        model: MODEL,
        output_modalities: ['audio'],
        instructions: controlled
          ? 'You are a voice renderer. Do not respond to caller speech automatically. Only speak the exact text explicitly requested by the server.'
          : 'You are a concise, friendly Hack Atlantic demo voice assistant. Answer spoken questions briefly. You cannot access tools or perform actions yet; never imply that you did.',
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            ...(controlled ? { transcription: { model: 'gpt-transcribe' } } : {}),
            turn_detection: controlled
              ? { type: 'semantic_vad', create_response: false, interrupt_response: false }
              : { type: 'semantic_vad' },
          },
          output: { format: { type: 'audio/pcmu' }, voice: 'marin' },
        },
      },
    });
  });

  upstream.on('message', (raw) => {
    if (closed) return;
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      logger.error('Realtime returned invalid JSON');
      twilio.close(1011, 'voice service error');
      return;
    }
    if (event.type === 'session.updated') {
      ready = true;
      for (const payload of pendingFrames) appendAudio(payload);
      pendingFrames.length = 0;
      flushSpeech();
    } else if (controlled && event.type === 'response.created') {
      responseActive = true;
      activeResponseId = event.response?.id;
    } else if (controlled && event.type === 'response.done') {
      if (activeResponseId && event.response?.id !== activeResponseId) return;
      activeSpeech = undefined;
      activeResponseId = undefined;
      responseActive = false;
      flushSpeech();
    } else if (controlled && event.type === 'conversation.item.input_audio_transcription.completed' && typeof event.transcript === 'string') {
      try { onTranscript(event.transcript, event.item_id); }
      catch (error) { logger.error(`Transcript handling failed: ${error.message}`); }
    } else if (event.type === 'response.output_audio.delta' && typeof event.delta === 'string') {
      if (event.item_id !== currentItem) {
        currentItem = event.item_id;
        emittedMs = 0;
        playedMs = 0;
        pendingMarks.clear();
      }
      contentIndex = event.content_index ?? 0;
      const bytes = Buffer.from(event.delta, 'base64').length;
      if (!bytes || !sendTwilio({ event: 'media', media: { payload: event.delta } })) return;
      emittedMs += bytes / 8;
      const name = `audio-${++markNumber}`;
      if (sendTwilio({ event: 'mark', mark: { name } })) {
        pendingMarks.set(name, { itemId: currentItem, endMs: Math.floor(emittedMs) });
      }
    } else if (!controlled && event.type === 'input_audio_buffer.speech_started' && pendingMarks.size) {
      sendTwilio({ event: 'clear' });
      pendingMarks.clear();
      if (currentItem) {
        sendUpstream({
          type: 'conversation.item.truncate',
          item_id: currentItem,
          content_index: contentIndex,
          audio_end_ms: Math.floor(playedMs),
        });
      }
      currentItem = undefined;
    } else if (event.type === 'error') {
      logger.error(`Realtime error: ${event.error?.code ?? event.error?.type ?? 'unknown'}`);
      if (controlled && event.error?.code === 'conversation_already_has_active_response') {
        // Recover a rejected response.create without terminating the phone call.
        // Wait for the existing response.done, then retry the rejected message.
        if (activeSpeech && (!event.error.event_id || event.error.event_id === activeSpeech.eventId)) {
          pendingSpeech.unshift(activeSpeech.text);
          activeSpeech = undefined;
          responseActive = true;
        }
        return;
      }
      twilio.close(1011, 'voice service error');
    }
  });
  upstream.on('error', (error) => {
    logger.error(`Realtime connection error: ${error.message}`);
    if (twilio.readyState === WebSocket.OPEN) twilio.close(1011, 'voice service error');
  });
  upstream.on('close', () => {
    if (!closed && twilio.readyState === WebSocket.OPEN) twilio.close(1011, 'voice service disconnected');
  });

  return { appendAudio, acknowledgeMark, speak, close };
}
