import { z } from 'zod';
import type { AgentDeps } from '../context.js';
import { makeOutboundTool } from './make-outbound-tool.js';

export function pushLeadTool(deps: AgentDeps) {
  return makeOutboundTool(deps, {
    name: 'push_lead',
    description:
      'SENDS a structured lead (enquiry) to a supplier. Use only for suppliers returned by find_suppliers, after the demand is clear.',
    parameters: z.object({
      supplierId: z.string().describe('Supplier ID returned by find_suppliers.'),
      demandSummary: z
        .string()
        .min(1)
        .max(1000)
        .describe('Structured summary of the demand: category, when, from/to, quantity, budget.'),
    }),
    toDraft: async (ctx, args: { supplierId: string; demandSummary: string }) => {
      const [supplier] = await deps.repos.suppliers.findByIds([args.supplierId]);
      if (!supplier)
        return { error: 'unknown supplier id; call find_suppliers and only use ids it returned' };
      if (!supplier.telegram)
        return {
          target: deps.env.TELEGRAM_OPS_CHAT_ID,
          text: `MANUAL LEAD for ${supplier.name} (no telegram on file): ${args.demandSummary}`,
          supplierSummaries: [supplier.name],
          inputRef: ctx.sourceMessageId,
          resultNote: 'supplier has no telegram; ops will send manually',
        };
      return {
        target: supplier.telegram,
        text: `New lead from a London community group (${ctx.demand?.category ?? 'service'}): ${args.demandSummary}`,
        supplierSummaries: [supplier.name],
        inputRef: ctx.sourceMessageId,
      };
    },
  });
}
