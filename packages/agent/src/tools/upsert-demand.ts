import { DEMAND_CATEGORIES, demandDraftSchema, type DemandDraft } from '@matchbot/domain';
import { normalizePostcode } from '@matchbot/shared';
import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AgentDeps, MatchContext } from '../context.js';

// PoC V1：strict JSON Schema 下 optional 字段不稳，工具参数一律 nullable，落库前转回 domain 的 optional。
const params = z.object({
  category: z.enum(DEMAND_CATEGORIES),
  need: z
    .string()
    .max(80)
    .nullable()
    .describe(
      'What the user is looking for, in a few English words, e.g. "Chinese birthday cake" or "locksmith". Never include names, phone numbers, addresses or other personal details.',
    ),
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
    need: args.need ?? undefined,
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
  const feedback = new WeakMap<MatchContext, string>();
  return tool({
    name: 'upsert_demand',
    description:
      "Record or update the user's open service demand (category, when, from/to postcode, quantity, budget). Call this whenever the user states or refines what they need. Every schema field is required: use null for unspecified fields, and quote ISO timestamps as JSON strings.",
    parameters: params,
    needsApproval: async (rc, args) => {
      const ctx = rc.context as MatchContext;
      const parsed = params.safeParse(args);
      if (parsed.success) {
        feedback.delete(ctx);
        return false;
      }
      feedback.set(
        ctx,
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      );
      await deps.repos.traces.create({
        kind: 'gate',
        inputRef: ctx.sourceMessageId,
        output: {
          gate: 'demand_input',
          decision: 'deny',
          reason: 'invalid_schema',
          fields: parsed.error.issues.map((issue) => issue.path.join('.')),
        },
        phase: ctx.phase,
        latencyMs: 0,
        costMicro: 0,
      });
      return false;
    },
    errorFunction: (rc, error) => {
      if (error instanceof Error && ['InvalidToolInputError', 'SyntaxError'].includes(error.name))
        return `invalid demand input: ${feedback.get(rc.context as MatchContext) ?? Object.keys(params.shape).join(', ')}. Missing fields must be included with null; quote timestamps as strings and use valid JSON. Correct all listed fields in one call.`;
      return 'demand update failed internally; stop rather than repeating';
    },
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
