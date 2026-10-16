import { z } from 'zod';

export const EXECUTION_STATUSES = [
  'accepted',
  'running',
  'waiting_approval',
  'completed',
  'failed',
] as const;
export const executionLeaseSchema = z.strictObject({
  userId: z.string().min(1).max(160),
  messageId: z.string().min(1).max(160),
  token: z.string().uuid(),
  fence: z.number().int().positive(),
});
export type ExecutionLease = z.infer<typeof executionLeaseSchema>;
