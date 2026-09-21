import { scorePeerSupplies } from '@matchbot/matcher';
import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AgentDeps, MatchContext } from '../context.js';

export function findPeerSupplyTool(deps: AgentDeps) {
  return tool({
    name: 'find_peer_supply',
    description:
      'Find up to 3 peer offers from the group supply pool for the current demand. Call upsert_demand first.',
    parameters: z.object({}),
    execute: async (_args, rc) => {
      const ctx = (rc as RunContext<MatchContext>).context;
      if (!ctx.demand) return 'no demand recorded yet; call upsert_demand first';
      const supplies = await deps.repos.supplies.findActive(ctx.demand.category);
      const scored = scorePeerSupplies({ demand: ctx.demand, supplies, now: new Date() }).slice(
        0,
        3,
      );
      if (scored.length === 0) return 'no peer supply found for this demand';
      const byId = new Map(supplies.map((s) => [s.id, s]));
      // 群成员的联系方式不进返回（架构 §9）；撮合通过群内回复完成
      return JSON.stringify(
        scored.map((s) => {
          const c = byId.get(s.id);
          return {
            id: s.id,
            availability: c?.availability ?? null,
            area: c?.area ?? null,
            reasons: s.reasons,
          };
        }),
      );
    },
  });
}
