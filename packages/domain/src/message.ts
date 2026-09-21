import { z } from 'zod';

/** 所有渠道适配器都必须产出这个形状。渠道差异到此为止。 */
export const inboundMessageSchema = z.object({
  channel: z.enum(['telegram', 'whatsapp']),
  chatId: z.string(),
  messageId: z.string(),
  userId: z.string(),
  text: z.string(),
  lang: z.string().length(2).optional(), // ISO 639-1，渠道能给就给，否则由 Jev 判
  replyToMessageId: z.string().optional(),
  receivedAt: z.string().datetime(), // UTC ISO 8601
});
export type InboundMessage = z.infer<typeof inboundMessageSchema>;
