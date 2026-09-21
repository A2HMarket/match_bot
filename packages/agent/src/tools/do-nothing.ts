import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AgentDeps, MatchContext } from '../context.js';

export function doNothingTool(deps: AgentDeps) {
  return tool({
    name: 'do_nothing',
    description:
      'Explicitly take no action this turn, with a reason. Use for chit-chat, housing/job/second-hand messages, or anything outside the service categories.',
    parameters: z.object({
      reason: z.string().max(300),
    }),
    execute: async (args, rc) => {
      const ctx = (rc as RunContext<MatchContext>).context;
      await deps.repos.traces.create({
        kind: 'gate',
        inputRef: ctx.sourceMessageId,
        output: { gate: 'agent_noop', reason: args.reason },
        phase: ctx.phase,
        latencyMs: 0,
        costMicro: 0,
      });
      return 'ok';
    },
  });
}
