import { tool, type RunContext } from '@openai/agents';
import type { z } from 'zod';
import type { AgentDeps, MatchContext } from '../context.js';
import { decideForOutbound, executeOutbound, type OutboundDraftInput } from './outbound-gate.js';

export type DraftResult = OutboundDraftInput | { error: string };

/**
 * 四个出站工具共用的骨架：needsApproval 与 execute 都只经 outbound-gate 决定（AGENTS.md §3.3
 * 第 3、4 条），工具自身不判断 phase。toDraft 返回 error 时不中断、不写库，错误文案还给模型。
 * parameters 用具体 ZodObject 类型（SDK 的 ToolOptions 对泛型 schema 不可判定），args 经 toDraft 收窄。
 */
export function makeOutboundTool<A>(
  deps: AgentDeps,
  cfg: {
    name: string;
    description: string;
    parameters: z.ZodObject<z.ZodRawShape>;
    toDraft: (ctx: MatchContext, args: A) => Promise<DraftResult>;
  },
) {
  const toArgs = (raw: unknown): A => cfg.parameters.parse(raw) as A;
  return tool({
    name: cfg.name,
    description: cfg.description,
    parameters: cfg.parameters,
    needsApproval: async (rc, args, callId) => {
      const ctx = rc.context as MatchContext;
      if (ctx.outboundBlocked) return false;
      const d = await cfg.toDraft(ctx, toArgs(args));
      if ('error' in d) return false;
      const decision = await decideForOutbound(deps, ctx, {
        ...d,
        ...(callId ? { toolCallId: callId } : {}),
      });
      return decision === 'review';
    },
    execute: async (args, rc, details) => {
      if (!rc) return 'internal error: missing run context';
      const ctx = (rc as RunContext<MatchContext>).context;
      if (ctx.outboundBlocked) {
        return 'not sent: this run was already declined by the outbound gate. Stop; do not retry.';
      }
      const d = await cfg.toDraft(ctx, toArgs(args));
      if ('error' in d) return d.error;
      const draft: OutboundDraftInput = {
        ...d,
        ...(details?.toolCall?.callId ? { toolCallId: details.toolCall.callId } : {}),
      };
      const result = await executeOutbound(
        deps,
        ctx,
        draft,
        await decideForOutbound(deps, ctx, draft),
      );
      return d.resultNote ? `${result}; ${d.resultNote}` : result;
    },
  });
}
