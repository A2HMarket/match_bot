import { inboundMessageSchema } from '@matchbot/domain';
import { z } from 'zod';

export const QUEUE_NAMES = {
  inbound: 'inbound_message',
  resume: 'resume_run',
  outbound: 'outbound_message',
  cron: 'cron',
} as const;

export const inboundJobSchema = inboundMessageSchema;
export const resumeRunJobSchema = z.object({ runStateId: z.string(), approvalId: z.string() });
export const outboundJobSchema = z.object({ outboundMessageId: z.string() });

/** 幂等 jobId：同一渠道消息只处理一次。 */
export function inboundJobId(channel: string, chatId: string, messageId: string): string {
  return `${channel}:${chatId}:${messageId}`;
}
