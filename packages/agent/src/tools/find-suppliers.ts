import { scoreSuppliers } from '@matchbot/matcher';
import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AgentDeps, MatchContext } from '../context.js';

export function findSuppliersTool(deps: AgentDeps) {
  return tool({
    name: 'find_suppliers',
    description:
      'Find up to 3 verified suppliers for the current demand. Returns id, name, price, contact and reasons. Call upsert_demand first.',
    parameters: z.object({}),
    execute: async (_args, rc) => {
      const ctx = (rc as RunContext<MatchContext>).context;
      if (!ctx.demand || !ctx.demandId) return 'no demand recorded yet; call upsert_demand first';
      const candidates = await deps.repos.suppliers.findCandidates({
        category: ctx.demand.category,
      });
      const scored = scoreSuppliers({
        demand: ctx.demand,
        suppliers: candidates,
        now: new Date(),
      }).slice(0, 3);
      if (scored.length === 0) return 'no suppliers found for this demand';
      await deps.repos.matches.replaceForDemand(
        ctx.demandId,
        scored.map((s, i) => ({ supplierId: s.id, matcherScore: s.score, rank: i + 1 })),
      );
      const byId = new Map(candidates.map((c) => [c.id, c]));
      return JSON.stringify(
        scored.map((s) => {
          const c = byId.get(s.id);
          return {
            id: s.id,
            name: c?.name,
            price: c?.roughPrice,
            phone: c?.phone,
            whatsapp: c?.whatsapp,
            pool: c?.pool,
            reasons: s.reasons,
          };
        }),
      );
    },
  });
}
