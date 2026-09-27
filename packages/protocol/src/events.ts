import { z } from 'zod';
import { InternalId } from './ids.js';

export const PROTOCOL_VERSION = 1 as const;

const common = {
  v: z.literal(PROTOCOL_VERSION),
  eventId: InternalId,
  machineId: InternalId,
};

const run = {
  sessionId: InternalId,
  taskId: InternalId,
  runId: InternalId,
};

const ApprovalRuntime = z.strictObject({
  threadId: z.string().min(1).max(200), turnId: z.string().min(1).max(200),
  itemId: z.string().min(1).max(200), requestId: z.string().min(1).max(200),
});

export const AgentStatus = z.enum(['available', 'idle', 'working', 'offline']);

export const RegisteredAgent = z.strictObject({
  agentId: InternalId,
  adapterType: z.string().min(1).max(64),
  name: z.string().min(1).max(100),
  status: AgentStatus,
});

// Daemon -> server. Credentials belong in the WSS handshake, never in events.
export const DaemonEvent = z.discriminatedUnion('type', [
  z.strictObject({ ...common, type: z.literal('machine.register'), name: z.string().min(1).max(100), agents: z.array(RegisteredAgent).max(32) }),
  z.strictObject({ ...common, type: z.literal('machine.heartbeat'), sentAt: z.iso.datetime() }),
  z.strictObject({ ...common, type: z.literal('machine.reconcile'), activeRunIds: z.array(InternalId).max(1000) }),
  z.strictObject({ ...common, ...run, type: z.literal('agent.started'), codexThreadId: z.string().min(1).max(200), codexTurnId: z.string().min(1).max(200) }),
  z.strictObject({ ...common, ...run, type: z.literal('agent.progress'), text: z.string().min(1).max(2000) }),
  z.strictObject({ ...common, ...run, type: z.literal('agent.message'), text: z.string().min(1).max(4000) }),
  z.strictObject({ ...common, ...run, type: z.literal('human_needed'), reason: z.string().min(1).max(1000) }),
  z.strictObject({ ...common, ...run, type: z.literal('approval.required'), approvalId: InternalId, actionDigest: z.string().regex(/^[a-f0-9]{64}$/), command: z.string().min(1).max(2000), cwd: z.string().min(1).max(1000), expiresAt: z.iso.datetime(), runtime: ApprovalRuntime.optional(), permissionScope: z.string().max(4000).optional(), actionKind: z.literal('local-demo-push').optional() }),
  z.strictObject({ ...common, ...run, type: z.literal('task.completed'), summary: z.string().min(1).max(4000) }),
  z.strictObject({ ...common, ...run, type: z.literal('task.failed'), reason: z.string().min(1).max(2000) }),
  z.strictObject({ ...common, ...run, type: z.literal('task.cancelled'), reason: z.string().min(1).max(2000) }),
  z.strictObject({ ...common, ...run, type: z.literal('task.steer.result'), requestEventId: InternalId, accepted: z.boolean() }),
]);

// Server -> daemon. The daemon must still check the exact pending approval
// request before unblocking a protected action.
export const ServerEvent = z.discriminatedUnion('type', [
  z.strictObject({ ...common, type: z.literal('machine.registered'), heartbeatIntervalMs: z.number().int().min(1000).max(60000) }),
  z.strictObject({ ...common, type: z.literal('event.ack'), ackEventId: InternalId }),
  z.strictObject({ ...common, ...run, type: z.literal('task.start'), agentId: InternalId, prompt: z.string().min(1).max(10000), codexThreadId: z.string().min(1).max(200).optional(), scenario: z.enum(['basic', 'approval']).optional() }),
  z.strictObject({ ...common, ...run, type: z.literal('agent.message'), text: z.string().min(1).max(4000) }),
  z.strictObject({ ...common, ...run, type: z.literal('task.cancel') }),
  z.strictObject({ ...common, ...run, type: z.literal('task.steer'), prompt: z.string().min(1).max(600) }),
  z.strictObject({ ...common, ...run, type: z.literal('approval.response'), approvalId: InternalId, actionDigest: z.string().regex(/^[a-f0-9]{64}$/), approved: z.boolean() }),
]);

export const ProtocolEvent = z.union([DaemonEvent, ServerEvent]);

export type AgentStatus = z.infer<typeof AgentStatus>;
export type RegisteredAgent = z.infer<typeof RegisteredAgent>;
export type DaemonEvent = z.infer<typeof DaemonEvent>;
export type ServerEvent = z.infer<typeof ServerEvent>;
export type ProtocolEvent = z.infer<typeof ProtocolEvent>;

export function matchesPendingApproval(
  request: Extract<DaemonEvent, { type: 'approval.required' }>,
  response: Extract<ServerEvent, { type: 'approval.response' }>,
): boolean {
  return request.approvalId === response.approvalId
    && request.machineId === response.machineId
    && request.sessionId === response.sessionId
    && request.taskId === response.taskId
    && request.runId === response.runId
    && request.actionDigest === response.actionDigest;
}
