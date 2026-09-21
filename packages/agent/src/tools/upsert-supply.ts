import { DEMAND_CATEGORIES, supplyDraftSchema } from '@matchbot/domain';
import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AgentDeps, MatchContext } from '../context.js';

// 参数 nullable 而非 optional，原因同 upsert-demand（PoC V1）。
const params = z.object({
  category: z.enum(DEMAND_CATEGORIES),
  availability: z
    .string()
    .max(200)
    .nullable()
    .describe('When the user can offer the service, as they said it'),
  area: z.string().max(100).nullable().describe('Area or outward postcode the user can cover'),
  expiresAt: z
    .string()
    .describe(
      'ISO 8601 datetime when this offer expires; use 14 days from now if the user gave none',
    ),
});

export function upsertSupplyTool(deps: AgentDeps) {
  return tool({
    name: 'upsert_supply',
    description:
      'Record that the user OFFERS a service in the group (has a van, can clean, can assemble). Not for people asking for help.',
    parameters: params,
    execute: async (args, rc) => {
      const ctx = (rc as RunContext<MatchContext>).context;
      if (!ctx.groupId) return 'supplies are only recorded from group messages';
      const draft = supplyDraftSchema.parse({
        category: args.category,
        availability: args.availability ?? undefined,
        area: args.area ?? undefined,
        expiresAt: args.expiresAt,
      });
      const row = await deps.repos.supplies.create({
        ...draft,
        userId: ctx.userId,
        groupId: ctx.groupId,
        sourceMessageId: ctx.sourceMessageId,
      });
      return `supply recorded: ${row.id}`;
    },
  });
}
