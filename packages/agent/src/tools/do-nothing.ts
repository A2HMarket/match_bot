import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AgentDeps, MatchContext } from '../context.js';

export function doNothingTool(deps: AgentDeps) {
  return tool({
    name: 'do_nothing',
    description:
      'Explicitly take no action for irrelevant chatter, acknowledgement, job recruitment or a declined gate. London daily-life, GP registration and airport advice ARE supported. No match or unavailable source needs reply_to_request.',
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
      return ctx.currentRequest?.isActionable &&
        !ctx.outboundBlocked &&
        ctx.currentRequest.demand.category !== 'job'
        ? 'This is an actionable current request. Use reply_to_request for an answer or honest no-match/clarification/unavailable; do not silently stop.'
        : 'ok';
    },
  });
}
