import { z } from 'zod';

export const TaskState = z.enum(['queued', 'running', 'waiting_human', 'completed', 'failed', 'cancelled']);
export const CallState = z.enum(['received', 'authenticating', 'streaming', 'rejected', 'ended']);
export const ApprovalState = z.enum(['pending', 'approved', 'rejected', 'expired']);

export type TaskState = z.infer<typeof TaskState>;
export type CallState = z.infer<typeof CallState>;
export type ApprovalState = z.infer<typeof ApprovalState>;

const taskTransitions: Record<TaskState, readonly TaskState[]> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['waiting_human', 'completed', 'failed', 'cancelled'],
  waiting_human: ['running', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

const callTransitions: Record<CallState, readonly CallState[]> = {
  received: ['authenticating', 'rejected', 'ended'],
  authenticating: ['streaming', 'rejected', 'ended'],
  streaming: ['ended'],
  rejected: [],
  ended: [],
};

const approvalTransitions: Record<ApprovalState, readonly ApprovalState[]> = {
  pending: ['approved', 'rejected', 'expired'],
  approved: [],
  rejected: [],
  expired: [],
};

export function canTransitionTask(from: TaskState, to: TaskState): boolean {
  return taskTransitions[from].includes(to);
}

export function canTransitionCall(from: CallState, to: CallState): boolean {
  return callTransitions[from].includes(to);
}

export function canTransitionApproval(from: ApprovalState, to: ApprovalState): boolean {
  return approvalTransitions[from].includes(to);
}
