import { MarketSearchError, type MarketSearch } from '@matchbot/websearch';
import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import { buildMarketChoices, buildMarketResearchTasks } from '../market-choices.js';
import type { AgentDeps, MatchContext } from '../context.js';
import {
  MARKET_EXCERPT_CHARS,
  marketListingForModel,
  MARKET_RESEARCH_LIMITS,
} from '../market-research.js';
export function marketEnrichTool(deps: AgentDeps & { marketSearch: MarketSearch }) {
  return tool({
    name: 'market_enrich',
    description:
      'Resolve important missing public facts yourself by reading details of discovered A2H listings before answering; do not send the user a list of facts this tool can look up. Fills original-post publication date, status and public practical information (descriptions truncated to the first 1500 characters). Choose 1-4 returned refs per batch; at most 8 distinct listing details per run. Re-check status: sold/expired is not an available offer. No contact lookup or private messages.',
    parameters: z.object({ refs: z.array(z.string()).min(1).max(4) }),
    execute: async (args, rc) => {
      const ctx = (rc as RunContext<MatchContext>).context;
      const deny = async (reason: string) => {
        await deps.repos.traces.create({
          kind: 'gate',
          inputRef: ctx.sourceMessageId,
          output: { gate: 'market_enrich', decision: 'deny', reason },
          phase: ctx.phase,
          latencyMs: 0,
          costMicro: 0,
        });
        return reason;
      };
      if (ctx.outboundBlocked) return deny('not allowed: outbound declined; stop');
      const listings = ctx.marketListings ?? [];
      const selected = [...new Set(args.refs)].map((ref) => listings.find((n) => n.ref === ref));
      if (selected.some((n) => !n)) return deny('unknown ref: only use market_search results');
      const attempted = new Set(ctx.marketDetailIds ?? []);
      const fresh = selected.filter((n) => n && !attempted.has(n.id));
      if (attempted.size + fresh.length > MARKET_RESEARCH_LIMITS.details)
        return deny('detail budget exhausted; use existing evidence');
      if (!fresh.length) return deny('details already attempted; no repeated calls');
      for (const n of fresh) if (n) attempted.add(n.id);
      ctx.marketDetailIds = [...attempted];
      const started = Date.now();
      const results = await Promise.allSettled(fresh.map((n) => deps.marketSearch.detail(n!.id)));
      const failures = [];
      const enriched = [];
      for (const [index, result] of results.entries()) {
        const old = fresh[index];
        if (!old) continue;
        if (result.status === 'rejected') {
          failures.push({
            ref: old.ref,
            reason:
              result.reason instanceof MarketSearchError ? result.reason.reason : 'detail_failed',
          });
          continue;
        }
        const replacement = { ...result.value, ref: old.ref };
        const stored = listings.findIndex((n) => n.id === old.id);
        if (stored >= 0) listings[stored] = replacement;
        enriched.push(replacement);
      }
      await deps.repos.traces.create({
        kind: 'gate',
        inputRef: ctx.sourceMessageId,
        output: { gate: 'market_enrich', refs: args.refs, enriched: enriched.length, failures },
        phase: ctx.phase,
        latencyMs: Date.now() - started,
        costMicro: 0,
      });
      const choices = ctx.marketPlan
        ? buildMarketChoices({ candidates: listings, plan: ctx.marketPlan })
        : null;
      const researchTasks =
        choices && ctx.marketPlan
          ? buildMarketResearchTasks({
              choices,
              plan: ctx.marketPlan,
              detailIds: ctx.marketDetailIds,
              queries: (ctx.marketQueries ?? []).map((q) => q.keyword),
              remainingDetails: 8 - attempted.size,
              remainingQueries: 8 - (ctx.marketQueries?.length ?? 0),
            })
          : [];
      return JSON.stringify({
        choiceHints: choices
          ? {
              primaryRefs: choices.primary.map((r) => r.listing.ref),
              backupRefs: choices.backup.map((r) => r.listing.ref),
              missing: [...choices.primary, ...choices.backup].map((r) => ({
                ref: r.listing.ref,
                critical: r.essentialMissing,
                unconfirmed: r.missing,
              })),
            }
          : null,
        researchTasks,
        listings: enriched.map((n) =>
          marketListingForModel(
            n,
            MARKET_EXCERPT_CHARS.detail,
            ctx.marketPlan
              ? [
                  ...ctx.marketPlan.needs.flatMap((need) => need.terms),
                  ...ctx.marketPlan.preferences,
                  '价格：',
                  '时间：',
                  '入住',
                  '地点：',
                ]
              : [],
          ),
        ),
        failures,
        remainingDetails: MARKET_RESEARCH_LIMITS.details - attempted.size,
        guidance:
          "Check choiceHints and researchTasks before replying. If critical facts are still missing, use at most 1-2 remaining searches for the source-attested entity and that gap, not generic new discovery. Never borrow another owner's conditions. If they remain unknown, show backups rather than confirmed recommendations. Original sourcePublishedAt is not the import createdAt. Keep data from each listing together, do not recommend ended offers; uncertain dates/routes/rent units must be checked via the original post. Descriptions are truncated to the shown text; quote only text you can see.",
      });
    },
  });
}
