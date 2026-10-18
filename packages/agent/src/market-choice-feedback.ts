import type { MatchContext } from './context.js';
import { buildMarketChoices } from './market-choices.js';

/** Return the same eligibility used by outbound validation, without exposing URLs or raw source data. */
export function marketChoiceFeedback(ctx: MatchContext) {
  if (!ctx.marketPlan) return null;
  const choices = buildMarketChoices({
    candidates: ctx.marketListings ?? [],
    plan: ctx.marketPlan,
    ...(ctx.task && ctx.taskProgressVersion === ctx.task.requirementsVersion
      ? { task: ctx.task }
      : {}),
  });
  const eligible = [
    ...choices.primary.map((row) => ({
      ref: row.listing.ref,
      level: 'primary',
      missing: row.essentialMissing,
    })),
    ...choices.backup.map((row) => ({
      ref: row.listing.ref,
      level: 'lead',
      missing: row.essentialMissing,
    })),
  ];
  return {
    eligible,
    excludedRefs: (ctx.marketListings ?? [])
      .filter((row) => !eligible.some((item) => item.ref === row.ref))
      .map((row) => row.ref),
    guidance:
      'These are internal checks, not wording for the user. Do not quote eligibility/lead/missing field labels as a report. Explain the concrete finding or obstacle in ordinary language. Only cite eligible refs and their own facts. Leads have unconfirmed conditions, not a complete match. Excluded refs must not appear as recommendations or donate facts to the chosen offer. Eligibility is not guaranteed real-world availability.',
  };
}
