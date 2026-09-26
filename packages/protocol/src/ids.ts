import { z } from 'zod';

// Internal IDs are opaque UUIDs. Provider IDs remain distinct so they cannot
// accidentally be used as machine, session, task, or approval IDs.
export const InternalId = z.uuid();
export const TwilioCallSid = z.string().regex(/^CA[0-9a-fA-F]{32}$/);
export const TwilioStreamSid = z.string().regex(/^MZ[0-9a-fA-F]{32}$/);

export type InternalId = z.infer<typeof InternalId>;
export type TwilioCallSid = z.infer<typeof TwilioCallSid>;
export type TwilioStreamSid = z.infer<typeof TwilioStreamSid>;
