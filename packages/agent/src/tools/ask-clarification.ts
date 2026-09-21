import { z } from 'zod';
import type { AgentDeps } from '../context.js';
import { makeOutboundTool } from './make-outbound-tool.js';

export function askClarificationTool(deps: AgentDeps) {
  return makeOutboundTool(deps, {
    name: 'ask_clarification',
    description:
      'SENDS a follow-up question into the Telegram group asking for missing demand details. Ask exactly one question at a time.',
    parameters: z.object({
      question: z.string().min(1).max(500).describe("One short question in the user's language."),
      missingFields: z
        .array(z.string())
        .min(1)
        .describe('Demand fields still missing, e.g. ["whenAt", "toPostcode"].'),
    }),
    toDraft: (ctx, args: { question: string; missingFields: string[] }) =>
      Promise.resolve({
        target: ctx.chatId,
        text: args.question,
        supplierSummaries: [],
        inputRef: ctx.sourceMessageId,
      }),
  });
}
