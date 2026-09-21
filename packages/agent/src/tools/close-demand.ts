import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AgentDeps, MatchContext } from '../context.js';

export function closeDemandTool(deps: AgentDeps) {
  return tool({
    name: 'close_demand',
    description: "Close the user's open demand when they say it is solved or no longer needed.",
    parameters: z.object({}),
    execute: async (_args, rc) => {
      const ctx = (rc as RunContext<MatchContext>).context;
      if (!ctx.demandId) return 'no open demand recorded';
      await deps.repos.demands.setStatus(ctx.demandId, 'closed');
      return 'demand closed';
    },
  });
}
