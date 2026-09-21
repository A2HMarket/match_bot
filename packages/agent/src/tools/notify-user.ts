import { z } from 'zod';
import type { AgentDeps } from '../context.js';
import { makeOutboundTool } from './make-outbound-tool.js';

export function notifyUserTool(deps: AgentDeps) {
  return makeOutboundTool(deps, {
    name: 'notify_user',
    description:
      'SENDS a private Telegram message to the user. Use for derived suggestions or match results that should not be posted in the group.',
    parameters: z.object({
      text: z.string().min(1).max(1500).describe("Message text in the user's language."),
    }),
    toDraft: (ctx, args: { text: string }) =>
      Promise.resolve({
        target: ctx.userId,
        text: args.text,
        supplierSummaries: [],
        inputRef: ctx.sourceMessageId,
      }),
  });
}
