import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '@hack-atlantic/protocol';
import { isValidPinHash, verifyPin } from './pin.mjs';
import { connectRealtime } from './realtime.mjs';
import { validateTwilioSignature } from './signature.mjs';
import { createDaemonGateway } from './daemon-gateway.mjs';
import { createTwilioCallback } from './callback.mjs';

const MAX_BODY_BYTES = 16 * 1024;
const XML_START = '<?xml version="1.0" encoding="UTF-8"?>';
const MAX_FAILURES = 3;
const LOCK_MS = 15 * 60 * 1000;
const CALL_TTL_MS = 30 * 60 * 1000;
const STREAM_MS = 12 * 1000;
const REALTIME_CALL_MS = 5 * 60 * 1000;

function twiml(content) {
  return `${XML_START}<Response>${content}</Response>`;
}

const REJECT = twiml('<Reject/>');
const HANGUP = twiml('<Hangup/>');
const STREAM_DONE = '<Say>Media stream test complete. The agent is not online yet.</Say><Hangup/>';

function xmlEscape(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function sameToken(expected, received) {
  if (typeof received !== 'string' || received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

function ulawSample(sample) {
  const bias = 0x84;
  const negative = sample < 0;
  const magnitude = Math.min(32635, Math.abs(sample) + bias);
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && !(magnitude & mask); exponent -= 1, mask >>= 1) {}
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return (~((negative ? 0x80 : 0) | (exponent << 4) | mantissa)) & 0xff;
}

function testTone() {
  const bytes = Buffer.alloc(8000 * 0.4);
  for (let index = 0; index < bytes.length; index += 1) {
    const amplitude = Math.sin((2 * Math.PI * 440 * index) / 8000) * 3500;
    bytes[index] = ulawSample(Math.round(amplitude));
  }
  return bytes.toString('base64');
}

const TONE_PAYLOAD = testTone();

function send(response, status, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('request body too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createServer({ authToken, accountSid, publicBaseUrl, allowedCallerNumber, callbackCallerNumber, pinHash, voiceMode = 'tone', agentMode = 'voice', openAiApiKey, realtimeConnector = connectRealtime, callbackCreator = createTwilioCallback, daemonCredentials = new Map(), onDaemonEvent, onDaemonStatus, stateStore, now = Date.now }) {
  if (!authToken || !accountSid || !publicBaseUrl || !allowedCallerNumber || !pinHash) {
    throw new Error('TWILIO_AUTH_TOKEN, TWILIO_ACCOUNT_SID, PUBLIC_BASE_URL, ALLOWED_CALLER_NUMBER, and DEMO_PIN_HASH are required');
  }
  const base = new URL(publicBaseUrl);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('PUBLIC_BASE_URL must be an HTTPS origin with no path or query');
  }
  if (!/^\+[1-9]\d{7,14}$/.test(allowedCallerNumber)) {
    throw new Error('ALLOWED_CALLER_NUMBER must be in E.164 format');
  }
  if (!isValidPinHash(pinHash)) {
    throw new Error('DEMO_PIN_HASH must be a valid scrypt PIN hash');
  }
  if (!['tone', 'realtime'].includes(voiceMode)) throw new Error('VOICE_MODE must be tone or realtime');
  if (!['voice', 'fake', 'codex'].includes(agentMode)) throw new Error('AGENT_MODE must be voice, fake, or codex');
  if (agentMode !== 'voice' && (!stateStore || voiceMode !== 'realtime')) throw new Error('agent mode requires durable state and realtime voice');
  if (callbackCallerNumber && !/^\+[1-9]\d{7,14}$/.test(callbackCallerNumber)) {
    throw new Error('TWILIO_PHONE_NUMBER must be a valid E.164 number');
  }
  if (voiceMode === 'realtime' && !openAiApiKey) throw new Error('OPENAI_API_KEY is required when VOICE_MODE=realtime');

  const user = stateStore?.ensureUser({ phoneNumber: allowedCallerNumber, pinHash });
  if (user) {
    for (const [machineId, tokenHash] of daemonCredentials) {
      stateStore.ensureMachine({ machineId, userId: user.id, tokenHash });
    }
  }

  const calls = new Map();
  const failures = new Map();
  const agentsByMachine = new Map();
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });

  function applyAgentEvent(event) {
    if (agentMode === 'voice' || !['agent.started', 'agent.progress', 'agent.message', 'approval.required', 'task.completed', 'task.failed'].includes(event.type)) return false;
    const run = stateStore.getRun(event.runId);
    const task = stateStore.getTask(event.taskId);
    const session = stateStore.getSession(event.sessionId);
    if (!run || !task || !session || run.task_id !== task.id || task.session_id !== session.id ||
        session.machine_id !== event.machineId || run.agent_id !== session.agent_id) {
      throw new Error('daemon event does not match assigned run');
    }
    if (['completed', 'failed', 'cancelled'].includes(run.state)) return false;
    if (run.state === 'waiting_human' && event.type !== 'approval.required' && event.type !== 'task.failed') {
      if (!stateStore.hasApprovedApprovalForRun(run.id)) throw new Error('run cannot resume without approval');
      stateStore.transitionRun(run.id, 'running', event.eventId);
      stateStore.transitionTask(task.id, 'running');
    }
    if (run.state === 'queued') stateStore.transitionRun(run.id, 'running', event.eventId);
    if (task.state === 'queued') stateStore.transitionTask(task.id, 'running');
    if (event.type === 'agent.started') stateStore.setCodexRunIds(run.id, event.codexThreadId, event.codexTurnId);
    if (event.type === 'approval.required') {
      if (agentMode === 'codex') throw new Error('real approval bridge is not enabled');
      if (stateStore.getApproval(event.approvalId)) return false;
      stateStore.createApproval({
        approvalId: event.approvalId, runId: run.id, actionDigest: event.actionDigest,
        command: event.command, cwd: event.cwd, expiresAt: Date.parse(event.expiresAt),
      });
      stateStore.transitionRun(run.id, 'waiting_human', event.eventId);
      stateStore.transitionTask(task.id, 'waiting_human');
    }
    if (event.type === 'task.completed' || event.type === 'task.failed') {
      const finalState = event.type === 'task.completed' ? 'completed' : 'failed';
      if (finalState === 'failed') stateStore.expirePendingApprovalsForRun(run.id);
      stateStore.transitionRun(run.id, finalState, event.eventId);
      stateStore.transitionTask(task.id, finalState);
    }
    stateStore.audit(session.id, event.type, { eventId: event.eventId, taskId: task.id });
    return true;
  }

  function speakToActiveCall(event) {
    if (agentMode === 'voice') return;
    const call = [...calls.values()].find((item) => item.sessionId === event.sessionId && item.taskId === event.taskId);
    if (event.type === 'agent.message') call?.realtime?.speak(event.text);
    if (event.type === 'task.failed') call?.realtime?.speak(agentMode === 'codex' ? event.reason : 'The demo task failed. No files were changed.');
    if (event.type === 'approval.required') {
      if (call?.realtime) call.realtime.speak('The simulated task needs approval. Hang up and I will call you back to confirm it.');
      else void initiateApprovalCallback(event.approvalId);
    }
    if (call && agentMode === 'codex' && (event.type === 'task.completed' || event.type === 'task.failed')) {
      if (event.type === 'task.completed') {
        call.codexThreadId = stateStore.getRun(event.runId)?.codex_thread_id ?? null;
        call.realtime?.speak('You can ask a follow-up question now.');
      }
      call.taskId = null;
      call.busyNotified = false;
    }
  }

  async function initiateApprovalCallback(approvalId) {
    if (!callbackCallerNumber || agentMode !== 'fake') return;
    const context = stateStore.getApprovalContext(approvalId);
    if (!context || context.state !== 'pending' || context.expires_at <= now() || stateStore.getApprovalCallback(approvalId)) return;
    const callback = stateStore.prepareApprovalCallback(approvalId);
    const url = `${base.origin}/approval/voice?approvalId=${approvalId}&nonce=${callback.nonce}`;
    try {
      const callSid = await callbackCreator({ accountSid, authToken, from: callbackCallerNumber, to: allowedCallerNumber, url });
      stateStore.markApprovalCallbackDialed(approvalId, callSid);
      console.log(`Approval callback initiated for approval ${approvalId}`);
    } catch (error) {
      stateStore.markApprovalCallbackFailed(approvalId);
      console.error(`Approval callback failed: ${error.message}`);
    }
  }

  function sendApprovalDecision(context) {
    return daemonGateway.sendToMachine(context.machine_id, {
      v: PROTOCOL_VERSION, eventId: randomUUID(), machineId: context.machine_id,
      sessionId: context.session_id, taskId: context.task_id, runId: context.run_id,
      type: 'approval.response', approvalId: context.id,
      actionDigest: context.action_digest, approved: context.state === 'approved',
    });
  }

  const daemonGateway = createDaemonGateway({
    credentials: daemonCredentials,
    onEvent: (event) => {
      if (stateStore) {
        let accepted = false;
        const applied = stateStore.applyEventOnce(event, () => { accepted = applyAgentEvent(event); });
        if (!applied) return;
        if (accepted) speakToActiveCall(event);
      }
      onDaemonEvent?.(event);
    },
    onStatus: (machineId, status, agents) => {
      stateStore?.setMachineStatus(machineId, status);
      if (status === 'online') agentsByMachine.set(machineId, agents ?? []);
      else agentsByMachine.delete(machineId);
      onDaemonStatus?.(machineId, status, agents);
      if (status === 'online' && stateStore && callbackCallerNumber && agentMode === 'fake') {
        for (const approval of stateStore.getDecidedApprovalsForMachine(machineId)) {
          sendApprovalDecision({ ...approval, id: approval.id, machine_id: machineId });
        }
      }
    },
    onHeartbeat: (machineId) => stateStore?.touchMachine(machineId),
    now,
  });

  function startAgentTask(call, transcript) {
    if (agentMode === 'voice' || !call.authenticated || typeof transcript !== 'string') return;
    const prompt = transcript.trim().slice(0, 10_000);
    if (!prompt) return;
    if (call.taskId) {
      if (agentMode === 'codex' && !call.busyNotified) {
        call.busyNotified = true;
        call.realtime?.speak('I am still working on that request. Please ask again after I answer.');
      }
      return;
    }
    const session = stateStore.getSession(call.sessionId);
    const selected = [...agentsByMachine].flatMap(([machineId, agents]) =>
      agents.filter((agent) => agent.adapterType === agentMode && agent.status !== 'offline')
        .map((agent) => ({ machineId, agentId: agent.agentId }))).find(({ machineId, agentId }) =>
      daemonGateway.status(machineId).online && (!session.machine_id ||
        (session.machine_id === machineId && session.agent_id === agentId)));
    if (!selected) {
      call.realtime?.speak('The selected agent is offline. Please try again shortly.');
      return;
    }
    stateStore.assignSessionAgent(call.sessionId, selected.machineId, selected.agentId);
    const taskId = stateStore.createTask({ sessionId: call.sessionId, prompt });
    const runId = stateStore.createRun({ taskId, agentId: selected.agentId });
    call.taskId = taskId;
    call.busyNotified = false;
    const delivered = daemonGateway.sendToMachine(selected.machineId, {
      v: PROTOCOL_VERSION, eventId: randomUUID(), machineId: selected.machineId,
      sessionId: call.sessionId, taskId, runId, type: 'task.start',
      agentId: selected.agentId, prompt,
      ...(agentMode === 'codex' && call.codexThreadId ? { codexThreadId: call.codexThreadId } : {}),
      scenario: agentMode === 'fake' && callbackCallerNumber ? 'approval' : 'basic',
    });
    if (!delivered) {
      stateStore.transitionRun(runId, 'failed');
      stateStore.transitionTask(taskId, 'failed');
      call.taskId = null;
      call.realtime?.speak('The agent disconnected before the task started.');
      return;
    }
    stateStore.audit(call.sessionId, 'task.dispatched', { taskId, runId });
    call.realtime?.speak(agentMode === 'codex'
      ? 'I started a real Codex task in read-only mode. Stay on the line for the answer and follow-ups, or hang up while it runs.'
      : 'I started a simulated task. No files will be changed. You can hang up; it will keep running.');
  }

  function streamTwiML(call) {
    if (!call.streamToken) call.streamToken = randomBytes(24).toString('hex');
    const streamUrl = `wss://${base.host}/media`;
    const intro = voiceMode === 'realtime'
      ? agentMode === 'fake' ? 'Access granted. Connecting the demo agent.' : agentMode === 'codex' ? 'Access granted. Connecting Codex in read-only mode.' : 'Access granted. Connecting the voice assistant.'
      : 'Access granted. Starting a short audio stream test.';
    const ending = voiceMode === 'realtime'
      ? '<Say>The voice assistant disconnected.</Say><Hangup/>'
      : STREAM_DONE;
    return twiml(`<Say>${intro}</Say><Connect><Stream url="${xmlEscape(streamUrl)}"><Parameter name="token" value="${call.streamToken}" /></Stream></Connect>${ending}`);
  }

  function prune() {
    const time = now();
    for (const [callSid, call] of calls) {
      if (call.expiresAt <= time) calls.delete(callSid);
    }
    for (const [number, record] of failures) {
      if (record.expiresAt <= time) failures.delete(number);
    }
  }

  function isLocked(number) {
    if (stateStore) return stateStore.isAuthLocked(number, MAX_FAILURES);
    const record = failures.get(number);
    return record && record.count >= MAX_FAILURES && record.expiresAt > now();
  }

  function recordFailure(number) {
    if (stateStore) return stateStore.recordAuthFailure(number, MAX_FAILURES, LOCK_MS);
    const record = failures.get(number);
    const count = record && record.expiresAt > now() ? record.count + 1 : 1;
    failures.set(number, { count, expiresAt: now() + LOCK_MS });
    return count >= MAX_FAILURES;
  }

  function pinGather() {
    const action = `${base.origin}/voice/pin`;
    return `<Gather input="dtmf" numDigits="4" timeout="8" action="${action}" method="POST" actionOnEmptyResult="true"><Say>Enter your four digit access code.</Say></Gather><Hangup/>`;
  }

  function approvalAction(pathname, approvalId, nonce) {
    return `${base.origin}${pathname}?approvalId=${encodeURIComponent(approvalId)}&nonce=${encodeURIComponent(nonce)}`;
  }

  function approvalPinGather(approvalId, nonce, context) {
    const action = approvalAction('/approval/pin', approvalId, nonce);
    const description = `A simulated protected action is waiting: ${context.command}, in ${context.cwd}. No command will actually run. Enter your four digit PIN to continue.`;
    return twiml(`<Gather input="dtmf" numDigits="4" timeout="8" action="${xmlEscape(action)}" method="POST" actionOnEmptyResult="true"><Say>${xmlEscape(description)}</Say></Gather><Hangup/>`);
  }

  function approvalChoiceGather(approvalId, nonce, context) {
    const action = approvalAction('/approval/decision', approvalId, nonce);
    const description = `Press 1 to approve the simulated action ${context.command}. Press 2 to reject it.`;
    return twiml(`<Gather input="dtmf" numDigits="1" timeout="8" action="${xmlEscape(action)}" method="POST" actionOnEmptyResult="true"><Say>${xmlEscape(description)}</Say></Gather><Hangup/>`);
  }

  const server = http.createServer(async (request, response) => {
    try {
    const path = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && path.pathname === '/health') {
      return send(response, 200, 'ok');
    }
    if (!['/voice', '/voice/pin', '/approval/voice', '/approval/pin', '/approval/decision'].includes(path.pathname) || request.method !== 'POST') {
      return send(response, 404, 'not found');
    }
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      return send(response, 415, 'expected form data');
    }

    let form;
    try {
      form = new URLSearchParams(await readBody(request));
    } catch {
      return send(response, 413, 'invalid or oversized request');
    }
    const params = Object.fromEntries(form);
    const signature = request.headers['x-twilio-signature'];
    const webhookUrl = `${base.origin}${request.url}`;
    if (
      typeof signature !== 'string' ||
      params.AccountSid !== accountSid ||
      !validateTwilioSignature(authToken, signature, webhookUrl, params)
    ) {
      return send(response, 403, 'forbidden');
    }

    prune();
    const from = params.From;
    const callSid = params.CallSid;
    if (path.pathname.startsWith('/approval/')) {
      if (agentMode !== 'fake' || !callbackCallerNumber || params.To !== allowedCallerNumber || from !== callbackCallerNumber ||
          params.Direction !== 'outbound-api' || !/^CA[0-9a-fA-F]{32}$/.test(callSid ?? '')) {
        return send(response, 200, HANGUP, 'text/xml; charset=utf-8');
      }
      const approvalId = path.searchParams.get('approvalId');
      const nonce = path.searchParams.get('nonce');
      const context = stateStore.getApprovalContext(approvalId);
      const callback = stateStore.getApprovalCallback(approvalId);
      if (!context || !callback || callback.nonce !== nonce || context.state !== 'pending' || context.expires_at <= now() || isLocked(allowedCallerNumber)) {
        return send(response, 200, twiml('<Say>This approval is no longer available.</Say><Hangup/>'), 'text/xml; charset=utf-8');
      }
      if (path.pathname === '/approval/voice') {
        if (!stateStore.bindApprovalCallback(approvalId, nonce, callSid)) return send(response, 200, HANGUP, 'text/xml; charset=utf-8');
        return send(response, 200, approvalPinGather(approvalId, nonce, context), 'text/xml; charset=utf-8');
      }
      if (callback.call_sid !== callSid || callback.state !== 'dialed') return send(response, 200, HANGUP, 'text/xml; charset=utf-8');
      if (path.pathname === '/approval/pin') {
        if (!callback.pin_verified && !verifyPin(params.Digits ?? '', pinHash)) {
          const locked = recordFailure(allowedCallerNumber);
          return send(response, 200, locked
            ? twiml('<Say>Too many incorrect codes.</Say><Hangup/>')
            : approvalPinGather(approvalId, nonce, context), 'text/xml; charset=utf-8');
        }
        stateStore.clearAuthFailures(allowedCallerNumber);
        stateStore.verifyApprovalCallbackPin(approvalId, callSid);
        return send(response, 200, approvalChoiceGather(approvalId, nonce, context), 'text/xml; charset=utf-8');
      }
      if (!callback.pin_verified) return send(response, 200, HANGUP, 'text/xml; charset=utf-8');
      if (!['1', '2'].includes(params.Digits)) return send(response, 200, approvalChoiceGather(approvalId, nonce, context), 'text/xml; charset=utf-8');
      const approved = params.Digits === '1';
      stateStore.decideApproval({ approvalId, runId: context.run_id, actionDigest: context.action_digest, userId: context.user_id, approved });
      const decision = stateStore.getApprovalContext(approvalId);
      stateStore.finishApprovalCallback(approvalId, callSid);
      if (decision.state === (approved ? 'approved' : 'rejected')) sendApprovalDecision(decision);
      const message = decision.state === 'approved'
        ? 'Approved. The fake agent will simulate the action. No command will run.'
        : 'Rejected. The fake agent will not continue.';
      return send(response, 200, twiml(`<Say>${message}</Say><Hangup/>`), 'text/xml; charset=utf-8');
    }
    if (from !== allowedCallerNumber || !/^CA[0-9a-fA-F]{32}$/.test(callSid ?? '')) {
      if (/^CA[0-9a-fA-F]{32}$/.test(callSid ?? '')) {
        stateStore?.recordRejectedCall({ callSid, phoneNumber: from ?? 'unknown' });
      }
      return send(response, 200, path.pathname === '/voice' ? REJECT : HANGUP, 'text/xml; charset=utf-8');
    }

    if (path.pathname === '/voice') {
      if (isLocked(from)) {
        if (stateStore?.getCall(callSid)) stateStore.setCallState(callSid, 'rejected', 'auth_locked');
        else stateStore?.recordRejectedCall({ callSid, phoneNumber: from, reason: 'auth_locked' });
        return send(response, 200, REJECT, 'text/xml; charset=utf-8');
      }
      if (!calls.has(callSid)) {
        const persisted = stateStore?.startInboundCall({ userId: user.id, callSid, phoneNumber: from });
        if (persisted && ['rejected', 'ended'].includes(persisted.state)) {
          return send(response, 200, HANGUP, 'text/xml; charset=utf-8');
        }
        calls.set(callSid, { from, authenticated: false, expiresAt: now() + CALL_TTL_MS, sessionId: persisted?.sessionId });
      }
      const body = calls.get(callSid).authenticated ? streamTwiML(calls.get(callSid)) : twiml(pinGather());
      return send(response, 200, body, 'text/xml; charset=utf-8');
    }

    const call = calls.get(callSid);
    if (!call || call.from !== from || isLocked(from)) {
      return send(response, 200, HANGUP, 'text/xml; charset=utf-8');
    }
    if (call.authenticated) return send(response, 200, streamTwiML(call), 'text/xml; charset=utf-8');

    if (!verifyPin(params.Digits ?? '', pinHash)) {
      const locked = recordFailure(from);
      if (locked) {
        calls.delete(callSid);
        stateStore?.setCallState(callSid, 'rejected', 'auth_locked');
      }
      const body = locked
        ? twiml('<Say>Too many attempts. Please try again later.</Say><Hangup/>')
        : twiml(`<Say>Incorrect code.</Say>${pinGather()}`);
      return send(response, 200, body, 'text/xml; charset=utf-8');
    }

    if (stateStore) stateStore.clearAuthFailures(from);
    else failures.delete(from);
    call.authenticated = true;
    if (call.sessionId) stateStore?.audit(call.sessionId, 'call.authenticated', { callSid });
    return send(response, 200, streamTwiML(call), 'text/xml; charset=utf-8');
    } catch (error) {
      console.error(`Voice request failed: ${error.message}`);
      if (!response.headersSent) send(response, 503, 'temporarily unavailable');
      else response.destroy();
    }
  });

  server.on('upgrade', (request, socket, head) => {
    const requestUrl = request.url ?? '';
    if (requestUrl === '/daemon') return daemonGateway.upgrade(request, socket, head);
    const signature = request.headers['x-twilio-signature'];
    const streamUrl = `wss://${base.host}${requestUrl}`;
    if (
      requestUrl !== '/media' ||
      typeof signature !== 'string' ||
      !(
        validateTwilioSignature(authToken, signature, streamUrl, {}) ||
        validateTwilioSignature(authToken, signature, `${streamUrl}/`, {})
      )
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit('connection', websocket);
    });
  });

  websocketServer.on('connection', (websocket) => {
    let streamSid;
    let callSid;
    let inboundPackets = 0;
    let toneAcknowledged = false;
    let timer;
    let realtime;

    websocket.on('message', (raw, isBinary) => {
      if (isBinary) return websocket.close(1003, 'text messages required');
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return websocket.close(1003, 'invalid JSON');
      }

      if (event.event === 'connected') return;
      if (event.event === 'start') {
        const start = event.start;
        const call = calls.get(start?.callSid);
        if (
          streamSid ||
          !/^MZ[0-9a-fA-F]{32}$/.test(start?.streamSid ?? '') ||
          event.streamSid !== start.streamSid ||
          start.accountSid !== accountSid ||
          !call?.authenticated ||
          call.expiresAt <= now() ||
          typeof call.streamToken !== 'string' ||
          !sameToken(call.streamToken, start.customParameters?.token)
        ) {
          return websocket.close(1008, 'unauthorized stream');
        }
        streamSid = start.streamSid;
        callSid = start.callSid;
        call.streamToken = undefined;
        try {
          stateStore?.setCallState(callSid, 'streaming');
        } catch (error) {
          console.error(`Could not persist stream start: ${error.message}`);
          return websocket.close(1011, 'state unavailable');
        }
        if (voiceMode === 'realtime') {
          try {
            realtime = realtimeConnector({
              twilio: websocket, streamSid, apiKey: openAiApiKey,
              controlled: agentMode !== 'voice',
              onTranscript: (text) => {
                try { startAgentTask(call, text); }
                catch (error) {
                  console.error(`Could not start agent task: ${error.message}`);
                  call.realtime?.speak('The agent task could not start. Please try again.');
                }
              },
            });
            call.realtime = realtime;
          } catch (error) {
            console.error(`Could not start voice bridge: ${error.message}`);
            return websocket.close(1011, 'voice service error');
          }
        } else {
          websocket.send(JSON.stringify({ event: 'media', streamSid, media: { payload: TONE_PAYLOAD } }));
          websocket.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'test-tone' } }));
        }
        timer = setTimeout(() => websocket.close(1000, 'call limit reached'), voiceMode === 'realtime' ? REALTIME_CALL_MS : STREAM_MS);
        console.log(`Media stream started for call ${callSid}`);
        return;
      }
      if (!streamSid || event.streamSid !== streamSid) return websocket.close(1008, 'invalid stream');
      if (event.event === 'media') {
        if (event.media?.track !== 'inbound' || typeof event.media?.payload !== 'string') {
          return websocket.close(1003, 'invalid media');
        }
        inboundPackets += 1;
        realtime?.appendAudio(event.media.payload);
      } else if (event.event === 'mark' && event.mark?.name === 'test-tone') {
        toneAcknowledged = true;
      } else if (event.event === 'mark' && typeof event.mark?.name === 'string') {
        realtime?.acknowledgeMark(event.mark.name);
      } else if (event.event === 'stop') {
        websocket.close(1000, 'stream stopped');
      }
    });

    websocket.on('close', () => {
      clearTimeout(timer);
      realtime?.close();
      if (callSid) {
        const call = calls.get(callSid);
        calls.delete(callSid);
        try {
          stateStore?.setCallState(callSid, 'ended', 'stream_closed');
          if (callbackCallerNumber && call?.sessionId) {
            const pending = stateStore.getPendingApprovalForSession(call.sessionId);
            if (pending) void initiateApprovalCallback(pending.id);
          }
        } catch (error) {
          console.error(`Could not persist stream end: ${error.message}`);
        }
        console.log(`Media stream ended for call ${callSid}: inbound packets=${inboundPackets}${voiceMode === 'tone' ? `, tone acknowledged=${toneAcknowledged}` : ''}`);
      }
    });
    websocket.on('error', (error) => console.error('Media stream error:', error.message));
  });

  server.daemonGateway = daemonGateway;
  server.on('close', () => daemonGateway.close());

  return server;
}
