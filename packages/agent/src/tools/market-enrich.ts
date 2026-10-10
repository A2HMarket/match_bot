import { MarketSearchError, type MarketSearch } from '@matchbot/websearch';
import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
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
      'Read public details of already discovered A2H listings before recommending them. Fills original-post publication date, status and public practical information (descriptions truncated to the first 1500 characters). Choose 1-4 returned refs per batch; at most 8 distinct listing details per run. Re-check status: sold/expired is not an available offer. No contact lookup or private messages.',
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
      return JSON.stringify({
        listings: enriched.map((n) => marketListingForModel(n, MARKET_EXCERPT_CHARS.detail)),
        failures,
        remainingDetails: MARKET_RESEARCH_LIMITS.details - attempted.size,
        guidance:
          'Original sourcePublishedAt is not the import createdAt. Keep data from each listing together, do not recommend ended offers; uncertain dates/routes/rent units must be checked via the original post. Descriptions are truncated to the shown text; quote only text you can see.',
      });
    },
  });
}
