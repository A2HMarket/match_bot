import { DEMAND_CATEGORIES, demandDraftSchema, type DemandDraft } from '@matchbot/domain';
import { normalizePostcode } from '@matchbot/shared';
import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AgentDeps, MatchContext } from '../context.js';

// PoC V1：strict JSON Schema 下 optional 字段不稳，工具参数一律 nullable，落库前转回 domain 的 optional。
const params = z.object({
  category: z.enum(DEMAND_CATEGORIES),
  whenText: z
    .string()
    .max(200)
    .nullable()
    .describe('When the service is needed, as the user said it'),
  whenAt: z
    .string()
    .nullable()
    .describe(
      'UTC ISO 8601 datetime such as 2026-09-27T09:00:00Z. Resolve relative days ("next Saturday", "下周六") against today\'s date; use 09:00 if no time was given. Null only if the day itself is unclear.',
    ),
  fromPostcode: z
    .string()
    .max(20)
    .nullable()
    .describe('UK postcode or outward code, e.g. E14 or SE1 7AB'),
  toPostcode: z.string().max(20).nullable(),
  quantity: z.string().max(100).nullable().describe('Volume: boxes, rooms, item count'),
  budgetPence: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe('Budget in pence (£150 -> 15000)'),
  lang: z.string().length(2).nullable().describe('ISO 639-1 code of the user message language'),
  confidence: z.number().min(0).max(1),
});

function toDraft(args: z.output<typeof params>): DemandDraft {
  return demandDraftSchema.parse({
    category: args.category,
    whenText: args.whenText ?? undefined,
    whenAt: args.whenAt ?? undefined,
    fromPostcode: args.fromPostcode ? normalizePostcode(args.fromPostcode)?.full : undefined,
    toPostcode: args.toPostcode ? normalizePostcode(args.toPostcode)?.full : undefined,
    quantity: args.quantity ?? undefined,
    budgetPence: args.budgetPence ?? undefined,
    lang: args.lang ?? undefined,
    confidence: args.confidence,
  });
}

export function upsertDemandTool(deps: AgentDeps) {
  return tool({
    name: 'upsert_demand',
    description:
      "Record or update the user's open service demand (category, when, from/to postcode, quantity, budget). Call this whenever the user states or refines what they need.",
    parameters: params,
    execute: async (args, rc) => {
      const ctx = (rc as RunContext<MatchContext>).context;
      const draft = toDraft(args);
      const open = (await deps.repos.demands.findOpenByUser(ctx.userId)).find(
        (d) => d.category === draft.category,
      );
      const row = open
        ? await deps.repos.demands.update(open.id, {
            ...draft,
            sourceMessageId: ctx.sourceMessageId,
          })
        : await deps.repos.demands.create({
            ...draft,
            userId: ctx.userId,
            sourceMessageId: ctx.sourceMessageId,
          });
      ctx.demand = draft;
      ctx.demandId = row.id;
      return `demand ${open ? 'updated' : 'created'}: ${row.id}`;
    },
  });
}
