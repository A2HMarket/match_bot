import { z } from 'zod';
import type { AgentDeps } from '../context.js';
import { makeOutboundTool } from './make-outbound-tool.js';

export const replyInGroupParams = z.object({
  text: z
    .string()
    .min(1)
    .max(1500)
    .describe(
      'Reply text in the same language as the demand. Mention 2-3 suppliers with rough price and contact.',
    ),
  supplierIds: z
    .array(z.string())
    .min(1)
    .max(3)
    .describe('IDs returned by find_suppliers. Never invent suppliers.'),
});

export function replyInGroupTool(deps: AgentDeps) {
  return makeOutboundTool(deps, {
    name: 'reply_in_group',
    description:
      "SENDS a message into the Telegram group under the user's demand. Use only after find_suppliers returned candidates. Never invent suppliers.",
    parameters: replyInGroupParams,
    toDraft: async (ctx, args: z.infer<typeof replyInGroupParams>) => {
      const suppliers = await deps.repos.suppliers.findByIds(args.supplierIds);
      if (suppliers.length !== new Set(args.supplierIds).size)
        return {
          error: 'unknown supplier id; call find_suppliers again and only use ids it returned',
        };
      return {
        target: ctx.chatId,
        text: args.text,
        supplierSummaries: suppliers.map((s) => `${s.name} ${s.roughPrice ?? ''}`.trim()),
        inputRef: ctx.sourceMessageId,
      };
    },
  });
}
