import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '@hack-atlantic/protocol';
import { isValidPinHash, verifyPin, pinFromInput } from './pin.mjs';
import { connectRealtime } from './realtime.mjs';
import { validateTwilioSignature } from './signature.mjs';
import { createDaemonGateway } from './daemon-gateway.mjs';
import { createTwilioCallback } from './callback.mjs';
import { isStatusRequest, localReplyForTranscript } from './transcript-intent.mjs';
import { createAnswerDelivery } from './answer-delivery.mjs';
import { createAgentSelection } from './agent-selection.mjs';
import { createTaskSteer } from './task-steer.mjs';
import { approvalPrompt } from './approval-prompt.mjs';

const MAX_BODY_BYTES = 16 * 1024;
const XML_START = '<?xml version="1.0" encoding="UTF-8"?>';
const MAX_FAILURES = 3;
const LOCK_MS = 15 * 60 * 1000;
const CALL_TTL_MS = 30 * 60 * 1000;
const STREAM_MS = 12 * 1000;
const REALTIME_CALL_MS = 5 * 60 * 1000;
const FIRST_STATUS_MS = 15 * 1000;
const REPEAT_STATUS_MS = 30 * 1000;
const SPEAKING_RETRY_MS = 3 * 1000;
const CANCEL_CONFIRM_MS = 15 * 1000;
const STEER_ACK_MS = 10 * 1000;
const CANCEL_REQUESTS = new Set(['cancel', 'stop', 'cancel the task', 'stop the task',
  'cancel the current task', 'stop the current task']);
const CANCEL_CONFIRMATIONS = new Set(['yes stop it', 'yes cancel it']);
const CANCEL_REJECTIONS = new Set(['no', 'no keep working']);
const ACTION_APPROVE = new Set(['approve', 'approve it', 'yes approve', 'yes approve it']);
const ACTION_REJECT = new Set(['reject', 'reject it', 'no reject', 'no reject it']);
// These are adapter-owned milestones, not model text or tool output.
const SPOKEN_CODEX_PROGRESS = new Set([
  'Codex is checking a repository command.',
  // Consent already has a spoken acknowledgment. Keep the adapter's approval
  // progress event in the audit trail without narrating the same thing twice.
]);

function localChoice(text) {
  return text.toLowerCase().replace(/[.!?]+$/g, '').replaceAll(',', '').trim().replace(/\s+/g, ' ');
}

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

export function createServer({ authToken, accountSid, publicBaseUrl, allowedCallerNumber, callbackCallerNumber, pinHash, voiceMode = 'tone', agentMode = 'voice', openAiApiKey, codexApprovalEnabled = false, realtimeConnector = connectRealtime, callbackCreator = createTwilioCallback, daemonCredentials = new Map(), onDaemonEvent, onDaemonStatus, stateStore, now = Date.now, statusTiming = { firstMs: FIRST_STATUS_MS, repeatMs: REPEAT_STATUS_MS }, steerAckMs = STEER_ACK_MS }) {
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
  if (codexApprovalEnabled && (agentMode !== 'codex' || !callbackCallerNumber)) throw new Error('Codex approvals require codex mode and TWILIO_PHONE_NUMBER');
  const callbacksEnabled = Boolean(callbackCallerNumber && (agentMode === 'fake' || codexApprovalEnabled));

  const user = stateStore?.ensureUser({ phoneNumber: allowedCallerNumber, pinHash });
  if (user) {
    for (const [machineId, tokenHash] of daemonCredentials) {
      stateStore.ensureMachine({ machineId, userId: user.id, tokenHash });
    }
  }

  const calls = new Map();
  const failures = new Map();
  const agentsByMachine = new Map();
  const reconcileCandidates = new Map();
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });

  function clearTaskStatus(call) {
    if (call?.statusTimer) clearTimeout(call.statusTimer);
    if (call) call.statusTimer = null;
  }

  function clearSteerAck(call) {
    if (call?.steerAckTimer) clearTimeout(call.steerAckTimer);
    if (call) call.steerAckTimer = null;
  }

  function scheduleTaskStatus(call, delayMs = statusTiming.firstMs) {
    clearTaskStatus(call);
    if (agentMode !== 'codex' || !call?.taskId || !call.realtime) return;
    call.statusTimer = setTimeout(() => {
      call.statusTimer = null;
      if (!call.taskId || !call.realtime) return;
      const taskState = stateStore.getTask(call.taskId)?.state;
      if (!['queued', 'running'].includes(taskState)) return;
      if (call.callerSpeaking) {
        scheduleTaskStatus(call, statusTiming.retryMs ?? SPEAKING_RETRY_MS);
        return;
      }
      call.realtime.speak(call.cancelRequested ? 'I asked Codex to stop, but have not confirmed it yet.'
        : taskState === 'queued' ? 'Your request is waiting for Codex to start.'
          : 'Codex is still working on your request. I will let you know when it finishes.');
      scheduleTaskStatus(call, statusTiming.repeatMs);
    }, delayMs);
    call.statusTimer.unref?.();
  }

  function applyAgentEvent(event) {
    if (agentMode === 'voice' || !['agent.started', 'agent.progress', 'agent.message', 'approval.required', 'task.completed', 'task.failed', 'task.cancelled', 'task.steer.result'].includes(event.type)) return false;
    const run = stateStore.getRun(event.runId);
    const task = stateStore.getTask(event.taskId);
    const session = stateStore.getSession(event.sessionId);
    if (!run || !task || !session || run.task_id !== task.id || task.session_id !== session.id ||
        session.machine_id !== event.machineId || run.agent_id !== session.agent_id) {
      throw new Error('daemon event does not match assigned run');
    }
    if (['completed', 'failed', 'cancelled'].includes(run.state)) return false;
    if (event.type === 'task.steer.result') {
      stateStore.audit(session.id, event.type, { eventId: event.eventId, taskId: task.id,
        requestEventId: event.requestEventId, accepted: event.accepted });
      return true;
    }
    if (run.state === 'waiting_human' && event.type !== 'approval.required' && event.type !== 'task.failed' && event.type !== 'task.cancelled') {
      if (!stateStore.hasApprovedApprovalForRun(run.id)) throw new Error('run cannot resume without approval');
      stateStore.transitionRun(run.id, 'running', event.eventId);
      stateStore.transitionTask(task.id, 'running');
    }
    if (run.state === 'queued') stateStore.transitionRun(run.id, 'running', event.eventId);
    if (task.state === 'queued') stateStore.transitionTask(task.id, 'running');
    if (event.type === 'agent.started') stateStore.setCodexRunIds(run.id, event.codexThreadId, event.codexTurnId);
    if (event.type === 'approval.required') {
      if (agentMode === 'codex' && (!codexApprovalEnabled || !event.runtime ||
          event.runtime.threadId !== run.codex_thread_id || event.runtime.turnId !== run.codex_turn_id)) {
        throw new Error('real approval bridge is not enabled or runtime IDs do not match');
      }
      const prior = stateStore.getApproval(event.approvalId);
      if (prior) {
        if (prior.run_id !== run.id || prior.action_digest !== event.actionDigest || prior.command !== event.command || prior.cwd !== event.cwd) {
          throw new Error('approval identity cannot be reused for a changed action');
        }
        return false;
      }
      if (Date.parse(event.expiresAt) <= now()) {
        // A disconnected daemon may replay a request only after it expired.
        // Settle it instead of repeatedly rejecting the same durable event and
        // preventing subsequent events from draining on every reconnect.
        const reason = 'The approval expired before it could be delivered. The action remains blocked.';
        stateStore.setTaskResult(task.id, reason);
        stateStore.expirePendingApprovalsForRun(run.id);
        stateStore.transitionRun(run.id, 'failed', event.eventId);
        stateStore.transitionTask(task.id, 'failed');
        stateStore.audit(session.id, 'approval.expired_before_delivery', { eventId: event.eventId, runId: run.id });
        return { ...event, type: 'task.failed', reason };
      }
      stateStore.createApproval({
        approvalId: event.approvalId, runId: run.id, actionDigest: event.actionDigest,
        command: event.command, cwd: event.cwd, expiresAt: Date.parse(event.expiresAt),
        codexItemId: event.runtime?.itemId, codexRequestId: event.runtime?.requestId, permissionScope: event.permissionScope,
      });
      stateStore.transitionRun(run.id, 'waiting_human', event.eventId);
      stateStore.transitionTask(task.id, 'waiting_human');
    }
    if (event.type === 'task.completed' || event.type === 'task.failed' || event.type === 'task.cancelled') {
      const finalState = event.type === 'task.completed' ? 'completed'
        : event.type === 'task.cancelled' ? 'cancelled' : 'failed';
      if (finalState !== 'completed') stateStore.expirePendingApprovalsForRun(run.id);
      stateStore.setTaskResult(task.id, finalState === 'completed' ? event.summary : event.reason);
      stateStore.transitionRun(run.id, finalState, event.eventId);
      stateStore.transitionTask(task.id, finalState);
    }
    stateStore.audit(session.id, event.type, { eventId: event.eventId, taskId: task.id,
      ...(event.type === 'approval.required' ? { approvalId: event.approvalId, actionKind: event.actionKind } : {}) });
    return true;
  }

  function speakToActiveCall(event) {
    if (agentMode === 'voice') return;
    const call = [...calls.values()].find((item) => item.sessionId === event.sessionId && item.taskId === event.taskId);
    if (event.type === 'agent.progress' && agentMode === 'codex' && call?.realtime &&
        SPOKEN_CODEX_PROGRESS.has(event.text)) {
      if (call.callerSpeaking) call.pendingProgress = event.text;
      else {
        call.realtime.speak(event.text);
        scheduleTaskStatus(call);
      }
    }
    if (event.type === 'task.steer.result' && call?.steerPendingEventId === event.requestEventId) {
      clearSteerAck(call);
      call.steerPendingEventId = null;
      call.realtime?.speak(event.accepted
        ? 'Codex accepted your change for the current task.'
        : 'Codex did not confirm that change. The current task may still be running; check the laptop before relying on it.');
    }
    if (event.type === 'agent.message' && agentMode !== 'codex') call?.realtime?.speak(event.text);
    if (event.type === 'task.failed') call?.realtime?.speak(agentMode === 'codex' ? event.reason : 'The demo task failed. No files were changed.');
    if (event.type === 'task.cancelled') call?.realtime?.speak('The task stopped. You can start another request.');
    if (event.type === 'approval.required') {
      clearTaskStatus(call);
      clearSteerAck(call);
      call?.steer?.clear();
      if (call) {
        call.steerPendingEventId = null;
        call.pendingProgress = null;
      }
      if (call?.realtime) offerInCallApproval(call, stateStore.getApprovalContext(event.approvalId));
      else void initiateApprovalCallback(event.approvalId);
    }
    if (call && (event.type === 'task.completed' || event.type === 'task.failed' || event.type === 'task.cancelled')) {
      clearTaskStatus(call);
      clearSteerAck(call);
      call.steer?.clear();
      call.steerPendingEventId = null;
      if (agentMode === 'codex' && event.type === 'task.completed') {
        call.codexThreadId = stateStore.getRun(event.runId)?.codex_thread_id ?? null;
        const delivery = createAnswerDelivery(event.summary);
        call.answerDelivery = delivery?.needsChoice ? delivery : null;
        if (delivery) call.realtime?.speak(delivery.opening);
      }
      call.taskId = null;
      call.busyNotified = false;
      call.cancelRequested = false;
      call.cancelDraftExpiresAt = null;
      call.pendingProgress = null;
      call.inlineApprovalId = null;
      call.approvalUtterances?.clear();
    }
  }

  async function initiateApprovalCallback(approvalId) {
    if (!callbacksEnabled) return;
    const context = stateStore.getApprovalContext(approvalId);
    if (!context || context.state !== 'pending' || context.expires_at <= now() || stateStore.getApprovalCallback(approvalId)) return;
    if ([...calls.values()].some(call => call.sessionId === context.session_id && call.realtime)) return;
    const callback = stateStore.prepareApprovalCallback(approvalId);
    const url = `${base.origin}/approval/voice?approvalId=${approvalId}&nonce=${callback.nonce}`;
    const statusUrl = `${base.origin}/approval/status?approvalId=${approvalId}&nonce=${callback.nonce}`;
    try {
      const callSid = await callbackCreator({ accountSid, authToken, from: callbackCallerNumber, to: allowedCallerNumber, url, statusUrl });
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

  function offerInCallApproval(call, context, details = false) {
    if (!call) return;
    if (!callbacksEnabled || !call?.authenticated || !context || context.state !== 'pending'
      || context.expires_at <= now() || context.session_id !== call.sessionId || context.task_id !== call.taskId) {
      call.inlineApprovalId = null;
      call.realtime?.speak('There is no active action available to approve on this call.');
      return;
    }
    const message = approvalPrompt(context, { mode: agentMode, details });
    call.inlineApprovalId = call.realtime?.speak(message) ? context.id : null;
  }

  function decideOnCall(call, approved, expectedApprovalId) {
    if (!callbacksEnabled || !call.authenticated || call.expiresAt <= now() || isLocked(call.from)
      || !expectedApprovalId || call.inlineApprovalId !== expectedApprovalId) return false;
    const context = stateStore.getApprovalContext(expectedApprovalId);
    if (!context || context.state !== 'pending' || context.expires_at <= now()
      || context.session_id !== call.sessionId || context.task_id !== call.taskId || context.user_id !== user.id) {
      call.inlineApprovalId = null;
      call.realtime?.speak('That approval is no longer available.');
      return false;
    }
    call.inlineApprovalId = null;
    call.approvalUtterances?.clear();
    stateStore.decideApproval({ approvalId: context.id, runId: context.run_id,
      actionDigest: context.action_digest, userId: user.id, approved, inboundCallSid: call.callSid });
    const decision = stateStore.getApprovalContext(context.id);
    if (decision.state !== (approved ? 'approved' : 'rejected')) {
      call.realtime?.speak('The decision could not be recorded. The action remains blocked.');
      return false;
    }
    const sent = sendApprovalDecision(decision);
    call.realtime?.speak(sent
      ? approved ? 'Approved once. Finishing now.' : 'Rejected. That action will not run.'
      : 'Your decision is saved, but the agent is disconnected. I cannot confirm the outcome yet.');
    return true;
  }

  const daemonGateway = createDaemonGateway({
    credentials: daemonCredentials,
    onEvent: (event) => {
      if (stateStore) {
        if (event.type === 'machine.reconcile') {
          let interrupted = [];
          stateStore.applyEventOnce(event, () => {
            interrupted = stateStore.reconcileMachineRuns(event.machineId, event.activeRunIds,
              reconcileCandidates.get(event.machineId) ?? []);
          });
          reconcileCandidates.delete(event.machineId);
          for (const failure of interrupted) speakToActiveCall(failure);
          // Recover the crash window between committing approval.required and
          // initiating its callback. Existing planned/dialed attempts are never
          // repeated, since their provider outcome could be uncertain.
          for (const approval of stateStore.getUndialedApprovalsForMachine(event.machineId)) {
            if (event.activeRunIds.includes(approval.run_id)) void initiateApprovalCallback(approval.id);
          }
          onDaemonEvent?.(event);
          return;
        }
        let accepted = false;
        const applied = stateStore.applyEventOnce(event, () => { accepted = applyAgentEvent(event); });
        if (!applied) return;
        if (accepted) speakToActiveCall(accepted === true ? event : accepted);
      }
      onDaemonEvent?.(event);
    },
    onStatus: (machineId, status, agents) => {
      stateStore?.setMachineStatus(machineId, status);
      if (status === 'online') agentsByMachine.set(machineId, agents ?? []);
      else agentsByMachine.delete(machineId);
      onDaemonStatus?.(machineId, status, agents);
      if (status === 'online' && stateStore) reconcileCandidates.set(machineId,
        stateStore.unfinishedRunsForMachine(machineId).map(run => run.runId));
      if (status === 'online' && stateStore && callbacksEnabled) {
        for (const approval of stateStore.getDecidedApprovalsForMachine(machineId)) {
          sendApprovalDecision({ ...approval, id: approval.id, machine_id: machineId });
        }
      }
    },
    onHeartbeat: (machineId) => stateStore?.touchMachine(machineId),
    now,
  });

  function startAgentTask(call, transcript, spokenApprovalId = null) {
    if (agentMode === 'voice' || !call.authenticated || typeof transcript !== 'string') return;
    let prompt = transcript.trim().slice(0, 10_000);
    if (!prompt) return;
    if (call.taskId) {
      const taskState = stateStore.getTask(call.taskId)?.state;
      if (taskState === 'waiting_human') {
        clearTaskStatus(call);
        const choice = localChoice(prompt);
        if (spokenApprovalId && spokenApprovalId === call.inlineApprovalId
          && (ACTION_APPROVE.has(choice) || ACTION_REJECT.has(choice))) {
          decideOnCall(call, ACTION_APPROVE.has(choice), spokenApprovalId);
          return;
        }
        const pending = stateStore.getPendingApprovalForSession(call.sessionId);
        if (pending) offerInCallApproval(call, stateStore.getApprovalContext(pending.id),
          ['details', 'show details', 'more details', 'exact command', 'what is the command'].includes(choice));
        else call.realtime?.speak('There is no active decision to make on this call. Check the laptop for the task outcome.');
        return;
      }
      const choice = localChoice(prompt);
      if (call.cancelDraftExpiresAt && call.cancelDraftExpiresAt <= now()) call.cancelDraftExpiresAt = null;
      if (call.cancelRequested && (CANCEL_REQUESTS.has(choice) || CANCEL_CONFIRMATIONS.has(choice) || isStatusRequest(prompt))) {
        call.realtime?.speak('I asked the agent to stop, but have not confirmed it yet.');
        return;
      }
      if (CANCEL_REQUESTS.has(choice)) {
        call.cancelDraftExpiresAt = now() + CANCEL_CONFIRM_MS;
        call.steer?.clear();
        call.realtime?.speak('Do you want to stop the current task? Say yes stop it, or no keep working.');
        return;
      }
      if (CANCEL_CONFIRMATIONS.has(choice)) {
        if (!call.cancelDraftExpiresAt) {
          call.realtime?.speak('There is no cancellation awaiting confirmation.');
          return;
        }
        call.cancelDraftExpiresAt = null;
        const run = stateStore.getRunForTask(call.taskId);
        const session = stateStore.getSession(call.sessionId);
        if (!run || !session?.machine_id || !['queued', 'running'].includes(run.state) ||
            !daemonGateway.sendToMachine(session.machine_id, {
              v: PROTOCOL_VERSION, eventId: randomUUID(), machineId: session.machine_id,
              sessionId: call.sessionId, taskId: call.taskId, runId: run.id, type: 'task.cancel',
            })) {
          call.realtime?.speak('I could not confirm that the agent received the stop request. Check the laptop before trying again.');
          return;
        }
        call.cancelRequested = true;
        call.realtime?.speak('I asked the agent to stop. I will confirm when it does.');
        return;
      }
      if (call.cancelDraftExpiresAt && CANCEL_REJECTIONS.has(choice)) {
        call.cancelDraftExpiresAt = null;
        call.realtime?.speak('Okay, the task will continue.');
        return;
      }
      call.cancelDraftExpiresAt = null;
      if (agentMode === 'codex') {
        if (call.steerPendingEventId) {
          call.realtime?.speak('I am waiting for Codex to confirm the change to this task.');
          return;
        }
        call.steer ??= createTaskSteer({ now });
        const reviewed = call.steer.receive(prompt);
        if (reviewed.handled) {
          const run = stateStore.getRunForTask(call.taskId);
          const session = stateStore.getSession(call.sessionId);
          if ((reviewed.prompt || call.steer.hasPending()) &&
              (!run || run.state !== 'running' || !run.codex_thread_id || !run.codex_turn_id || !session?.machine_id)) {
            call.steer.clear();
            call.realtime?.speak('Codex has not confirmed an active turn to steer. No change was sent. Please try again after it starts.');
            return;
          }
          if (!reviewed.prompt) {
            call.realtime?.speak(reviewed.reply);
            return;
          }
          const requestEventId = randomUUID();
          if (!daemonGateway.sendToMachine(session.machine_id, {
            v: PROTOCOL_VERSION, eventId: requestEventId, machineId: session.machine_id,
            sessionId: call.sessionId, taskId: call.taskId, runId: run.id,
            type: 'task.steer', prompt: reviewed.prompt,
          })) {
            call.realtime?.speak('I could not deliver that change to Codex. The current task may still be running; check the laptop.');
            return;
          }
          call.steerPendingEventId = requestEventId;
          call.steerAckTimer = setTimeout(() => {
            if (call.steerPendingEventId !== requestEventId) return;
            call.steerPendingEventId = null;
            call.steerAckTimer = null;
            if (call.realtime) call.realtime.speak('I could not confirm whether Codex accepted that change. Check the laptop before relying on it.');
          }, steerAckMs);
          call.steerAckTimer.unref?.();
          call.realtime?.speak('I sent the change to Codex. I will confirm whether it was accepted.');
          return;
        }
      }
      if (agentMode === 'codex' && isStatusRequest(prompt)) {
        call.realtime?.speak(call.cancelRequested ? 'I have not confirmed that Codex stopped yet.'
          : 'Codex is still working on your request. I will let you know when it finishes.');
        scheduleTaskStatus(call, statusTiming.repeatMs);
        return;
      }
      if (agentMode === 'codex' && !call.busyNotified) {
        call.busyNotified = true;
        call.realtime?.speak('I am still working on that request. Please ask again after I answer.');
      }
      return;
    }
    let selectedFromMenu;
    if (call.agentSelection) {
      const choice = call.agentSelection.receive(prompt);
      if (choice.reply) {
        call.realtime?.speak(choice.reply);
        return;
      }
      if (choice.selected) {
        prompt = choice.prompt;
        selectedFromMenu = choice.selected;
      }
      call.agentSelection = null;
    }
    if (agentMode === 'codex' && !selectedFromMenu) {
      const localReply = localReplyForTranscript(prompt);
      if (localReply) {
        call.realtime?.speak(localReply);
        return;
      }
      if (call.answerDelivery) {
        if (isStatusRequest(prompt)) {
          call.realtime?.speak('Codex finished. Say summary or details to hear the answer.');
          return;
        }
        const response = call.answerDelivery.receive(prompt);
        if (response.handled) {
          if (response.dismiss) call.answerDelivery = null;
          call.realtime?.speak(response.message);
          return;
        }
        call.answerDelivery = null;
      }
      if (isStatusRequest(prompt)) {
        const latest = stateStore.getLatestTaskForUser(user.id);
        if (latest && latest.session_id !== call.sessionId) {
          if (latest.state === 'queued' || latest.state === 'running') {
            call.realtime?.speak(latest.machine_status === 'online'
              ? 'Your most recent agent task is marked in progress. This call did not start another task.'
              : 'Your most recent task is marked in progress, but its machine is offline. I cannot confirm the outcome yet. Check the laptop before retrying.');
          } else if (latest.state === 'waiting_human') {
            call.realtime?.speak('Your most recent task is paused around a protected action. This call cannot approve it; use the authenticated callback or check the laptop.');
          } else if (latest.state === 'completed') {
            const delivery = latest.result_text ? createAnswerDelivery(latest.result_text) : null;
            call.answerDelivery = delivery?.needsChoice ? delivery : null;
            call.realtime?.speak(delivery?.opening ?? 'Your most recent task completed, but its answer is unavailable. Check the laptop.');
          } else {
            call.realtime?.speak(latest.state === 'cancelled'
              ? 'Your most recent task was stopped. No new task was started.'
              : 'Your most recent task failed. Check the laptop for details before retrying. No new task was started.');
          }
          return;
        }
        call.realtime?.speak('There is no Codex task running right now. You can ask another question.');
        return;
      }
      // MVP: a substantive transcript is the request. Protected actions still
      // pause at the daemon approval boundary for same-call or callback consent.
    }
    const isFollowUp = agentMode === 'codex' && Boolean(call.codexThreadId);
    const session = stateStore.getSession(call.sessionId);
    const candidates = [...agentsByMachine].flatMap(([machineId, agents]) =>
      agents.filter((agent) => agent.adapterType === agentMode && agent.status !== 'offline')
        .map((agent) => ({ machineId, agentId: agent.agentId,
          name: `${agent.name ?? agentMode} on ${stateStore.getMachine(machineId)?.name ?? 'machine'}` }))).filter(({ machineId, agentId }) =>
      daemonGateway.status(machineId).online && (!session.machine_id ||
        (session.machine_id === machineId && session.agent_id === agentId)))
      .sort((a, b) => a.name.localeCompare(b.name) || a.machineId.localeCompare(b.machineId) || a.agentId.localeCompare(b.agentId));
    if (!selectedFromMenu && candidates.length > 1) {
      call.agentSelection = createAgentSelection({ now });
      call.realtime?.speak(call.agentSelection.offer(prompt, candidates));
      return;
    }
    const selected = selectedFromMenu
      ? candidates.find(({ machineId, agentId }) => machineId === selectedFromMenu.machineId && agentId === selectedFromMenu.agentId)
      : candidates[0];
    if (!selected) {
      call.realtime?.speak('The selected agent is offline. Please repeat your request. No task was started.');
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
    scheduleTaskStatus(call);
    call.realtime?.speak(agentMode === 'codex'
      ? isFollowUp ? 'Checking that now.' : callbacksEnabled
        ? 'Working on it. You can hang up; I will call if approval is needed.' : 'Working on it.'
      : 'I started a simulated task. No files will be changed. You can hang up; it will keep running.');
  }

  function streamTwiML(call) {
    if (!call.streamToken) call.streamToken = randomBytes(24).toString('hex');
    const streamUrl = `wss://${base.host}/media`;
    const intro = voiceMode === 'realtime'
      ? agentMode === 'fake' ? 'Access granted. Connecting the demo agent.' : agentMode === 'codex' ? 'Access granted. Connecting Codex.' : 'Access granted. Connecting the voice assistant.'
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
    return `<Gather input="dtmf speech" numDigits="4" timeout="8" speechTimeout="2" language="en-US" action="${action}" method="POST" actionOnEmptyResult="true"><Say>Enter your four digit access code, or say each digit separately.</Say></Gather><Hangup/>`;
  }

  function approvalAction(pathname, approvalId, nonce) {
    return `${base.origin}${pathname}?approvalId=${encodeURIComponent(approvalId)}&nonce=${encodeURIComponent(nonce)}`;
  }

  function approvalPinGather(approvalId, nonce, context) {
    const action = approvalAction('/approval/pin', approvalId, nonce);
    const description = 'Dylamo calling. Say your four PIN digits, or enter them.';
    return twiml(`<Gather input="dtmf speech" numDigits="4" timeout="8" speechTimeout="2" language="en-US" action="${xmlEscape(action)}" method="POST" actionOnEmptyResult="true"><Say>${xmlEscape(description)}</Say></Gather><Hangup/>`);
  }

  function approvalChoiceGather(approvalId, nonce, context, details = false) {
    const action = approvalAction('/approval/decision', approvalId, nonce);
    const description = approvalPrompt(context, { mode: agentMode, channel: 'callback', details });
    return twiml(`<Gather input="dtmf" numDigits="1" timeout="8" action="${xmlEscape(action)}" method="POST" actionOnEmptyResult="true"><Say>${xmlEscape(description)}</Say></Gather><Hangup/>`);
  }

  const server = http.createServer(async (request, response) => {
    try {
    const path = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && path.pathname === '/health') {
      return send(response, 200, 'ok');
    }
    if (!['/voice', '/voice/pin', '/approval/voice', '/approval/pin', '/approval/decision', '/approval/result', '/approval/status'].includes(path.pathname) || request.method !== 'POST') {
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
      if (!callbacksEnabled || params.To !== allowedCallerNumber || from !== callbackCallerNumber ||
          params.Direction !== 'outbound-api' || !/^CA[0-9a-fA-F]{32}$/.test(callSid ?? '')) {
        return send(response, 200, HANGUP, 'text/xml; charset=utf-8');
      }
      const approvalId = path.searchParams.get('approvalId');
      const nonce = path.searchParams.get('nonce');
      const context = stateStore.getApprovalContext(approvalId);
      const callback = stateStore.getApprovalCallback(approvalId);
      if (path.pathname === '/approval/status') {
        if (!context || !callback || callback.nonce !== nonce ||
            (callback.call_sid && callback.call_sid !== callSid)) return send(response, 403, 'forbidden');
        stateStore.recordApprovalCallEnd({ approvalId, nonce, callSid, status: params.CallStatus });
        return send(response, 204, '');
      }
      if (path.pathname === '/approval/result') {
        if (!context || !callback || callback.nonce !== nonce || callback.call_sid !== callSid || !callback.pin_verified ||
            callback.state !== 'finished' || context.state !== 'approved' || isLocked(allowedCallerNumber)) {
          return send(response, 200, HANGUP, 'text/xml; charset=utf-8');
        }
        const task = stateStore.getTask(context.task_id);
        if (['completed', 'failed', 'cancelled'].includes(task?.state)) {
          const text = task.state === 'completed' ? `Codex finished. ${task.result_text ?? ''}` : `The task stopped. ${task.result_text ?? ''}`;
          return send(response, 200, twiml(`<Say>${xmlEscape(text.slice(0, 1000))}</Say><Hangup/>`), 'text/xml; charset=utf-8');
        }
        if (now() - context.resolved_at > 60_000) return send(response, 200, twiml('<Say>The task is still pending. Check its status on the laptop before retrying any action.</Say><Hangup/>'), 'text/xml; charset=utf-8');
        const resultUrl = approvalAction('/approval/result', approvalId, nonce);
        return send(response, 200, twiml(`<Pause length="2"/><Redirect method="POST">${xmlEscape(resultUrl)}</Redirect>`), 'text/xml; charset=utf-8');
      }
      if (!context || !callback || callback.nonce !== nonce || context.state !== 'pending' || context.expires_at <= now() || isLocked(allowedCallerNumber)) {
        return send(response, 200, twiml('<Say>This approval is no longer available.</Say><Hangup/>'), 'text/xml; charset=utf-8');
      }
      if (path.pathname === '/approval/voice') {
        if (!stateStore.bindApprovalCallback(approvalId, nonce, callSid)) return send(response, 200, HANGUP, 'text/xml; charset=utf-8');
        return send(response, 200, approvalPinGather(approvalId, nonce, context), 'text/xml; charset=utf-8');
      }
      if (callback.call_sid !== callSid || callback.state !== 'dialed') return send(response, 200, HANGUP, 'text/xml; charset=utf-8');
      if (path.pathname === '/approval/pin') {
        if (!callback.pin_verified && !verifyPin(pinFromInput(params), pinHash)) {
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
      if (!['1', '2'].includes(params.Digits)) return send(response, 200,
        approvalChoiceGather(approvalId, nonce, context, params.Digits === '3'), 'text/xml; charset=utf-8');
      const approved = params.Digits === '1';
      stateStore.decideApproval({ approvalId, runId: context.run_id, actionDigest: context.action_digest, userId: context.user_id, approved });
      const decision = stateStore.getApprovalContext(approvalId);
      stateStore.finishApprovalCallback(approvalId, callSid);
      if (decision.state === (approved ? 'approved' : 'rejected')) sendApprovalDecision(decision);
      const message = decision.state === 'approved'
        ? agentMode === 'fake' ? 'Approved. This is a simulation; no command will run.' : 'Approved once. Finishing now.'
        : decision.state === 'rejected' ? 'Rejected. The agent will not continue.' : 'The approval expired. The action remains blocked.';
      const ending = agentMode === 'codex' && decision.state === 'approved'
        ? `<Pause length="2"/><Redirect method="POST">${xmlEscape(approvalAction('/approval/result', approvalId, nonce))}</Redirect>` : '<Hangup/>';
      return send(response, 200, twiml(`<Say>${message}</Say>${ending}`), 'text/xml; charset=utf-8');
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
        calls.set(callSid, { callSid, from, authenticated: false, expiresAt: now() + CALL_TTL_MS, sessionId: persisted?.sessionId });
      }
      const body = calls.get(callSid).authenticated ? streamTwiML(calls.get(callSid)) : twiml(pinGather());
      return send(response, 200, body, 'text/xml; charset=utf-8');
    }

    const call = calls.get(callSid);
    if (!call || call.from !== from || isLocked(from)) {
      return send(response, 200, HANGUP, 'text/xml; charset=utf-8');
    }
    if (call.authenticated) return send(response, 200, streamTwiML(call), 'text/xml; charset=utf-8');

    if (!verifyPin(pinFromInput(params), pinHash)) {
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
              onSpeechStart: (itemId) => {
                call.callerSpeaking = true;
                if (typeof itemId === 'string' && itemId) {
                  call.approvalUtterances ??= new Map();
                  if (!call.approvalUtterances.has(itemId)) call.approvalUtterances.set(itemId, call.inlineApprovalId ?? null);
                  if (call.approvalUtterances.size > 100) call.approvalUtterances.delete(call.approvalUtterances.keys().next().value);
                }
              },
              onSpeechStop: () => {
                call.callerSpeaking = false;
                if (calls.get(callSid) === call && call.pendingProgress && call.taskId && call.realtime) {
                  call.realtime.speak(call.pendingProgress);
                  call.pendingProgress = null;
                  scheduleTaskStatus(call);
                }
              },
              onTranscriptionFailure: () => { call.approvalUtterances?.clear(); call.agentSelection?.clear(); call.agentSelection = null; call.cancelDraftExpiresAt = null; call.steer?.clear(); },
              onTranscript: (text, itemId) => {
                // A late transcript after hangup cannot dispatch a new task.
                // Already-dispatched daemon tasks remain independent.
                if (calls.get(callSid) !== call) return;
                const spokenApprovalId = call.approvalUtterances?.get(itemId);
                call.approvalUtterances?.delete(itemId);
                try { startAgentTask(call, text, spokenApprovalId); }
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
      } else if (event.event === 'dtmf') {
        const call = calls.get(callSid);
        if (event.dtmf?.track !== 'inbound_track' || !call?.inlineApprovalId) return;
        try {
          if (event.dtmf.digit === '3') offerInCallApproval(call, stateStore.getApprovalContext(call.inlineApprovalId), true);
          else if (['1', '2'].includes(event.dtmf.digit)) decideOnCall(call, event.dtmf.digit === '1', call.inlineApprovalId);
        } catch (error) {
          console.error(`Could not record in-call decision: ${error.message}`);
          call.realtime?.speak('The decision could not be confirmed. Check the laptop before retrying.');
        }
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
        clearTaskStatus(call);
        clearSteerAck(call);
        call?.steer?.clear();
        call?.agentSelection?.clear();
        call?.approvalUtterances?.clear();
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
