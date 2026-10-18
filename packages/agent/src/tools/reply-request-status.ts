import { z } from 'zod';
import type { AgentDeps } from '../context.js';
import { renderRequestStatus } from '../request-status.js';
import { makeOutboundTool } from './make-outbound-tool.js';
import { groupReplyAddressing } from './addressing.js';

export function replyRequestStatusTool(deps: AgentDeps) {
  return makeOutboundTool(deps, {
    name: 'reply_request_status',
    description:
      'SENDS one brief code-generated status; it asks only an already-planned, unanswered personal constraint. No recommendation, names, URLs or model text. Still respects phase, Jev availability and status policy.',
    isRequestStatus: true,
    parameters: z.object({}),
    toDraft: (ctx) => {
      const text = renderRequestStatus(ctx);
      if (!text)
        return Promise.resolve({ error: 'Request status is not authorized or already answered' });
      return Promise.resolve({
        kind: 'notification' as const,
        target: ctx.chatId,
        text,
        supplierSummaries: [],
        inputRef: ctx.sourceMessageId,
        replyPurpose: 'request_status' as const,
        ...groupReplyAddressing(ctx),
      });
    },
  });
}
