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
      // ctx.userId 是库内 cuid；Telegram 私聊的目标是渠道侧 user id。此前直接用 cuid，发送必然失败
      Promise.resolve(
        ctx.source
          ? {
              kind: 'notification',
              target: ctx.source.userId,
              text: args.text,
              supplierSummaries: [],
              inputRef: ctx.sourceMessageId,
            }
          : { error: 'cannot message the user privately: their channel id is unknown' },
      ),
  });
}
