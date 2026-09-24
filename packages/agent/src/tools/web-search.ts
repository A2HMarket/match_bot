import { UnsafeQueryError, type WebSearch } from '@matchbot/websearch';
import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AgentDeps, MatchContext } from '../context.js';

/**
 * P14：库里没有合适商家时的兜底。前置条件在代码里判断，不靠 prompt：
 * 需求品类是 other（库里本就没有这类），或本次 run 的 find_suppliers 已查过且为空。
 */
export function webSearchTool(deps: AgentDeps & { webSearch: WebSearch }) {
  return tool({
    name: 'web_search',
    description:
      'Search the public web for local businesses when our own supplier list has nothing suitable. Only allowed after find_suppliers returned nothing, or when the demand category is "other". Returns up to 5 candidates with a ref (w1…) and contact type.',
    parameters: z.object({
      need: z
        .string()
        .min(2)
        .max(60)
        .describe(
          'What to find, in a few English words, e.g. "Chinese birthday cake bakery". No names, phone numbers, addresses or other personal details.',
        ),
      area: z
        .string()
        .max(30)
        .nullable()
        .describe('London outcode (E14) or area name (Battersea), or null for anywhere in London'),
    }),
    execute: async (args, rc) => {
      const ctx = (rc as RunContext<MatchContext>).context;
      const allowed = ctx.demand?.category === 'other' || ctx.supplierSearchEmpty === true;
      if (!allowed) {
        return 'not allowed: call find_suppliers first; web_search is only for when it finds nothing';
      }
      // 每次 run 只搜一次：实测模型会搜完再 find_suppliers、再搜一遍，白耗免费额度
      if (ctx.searchResults) {
        return ctx.searchResults.length
          ? `already searched; use these refs: ${ctx.searchResults.map((c) => c.ref).join(', ')}`
          : 'already searched and found nothing; do not reply';
      }
      try {
        const found = await deps.webSearch.find({
          need: args.need,
          ...(args.area ? { area: args.area } : {}),
        });
        ctx.searchResults = found;
        await deps.repos.traces.create({
          kind: 'gate',
          inputRef: ctx.sourceMessageId,
          output: {
            gate: 'web_search',
            need: args.need,
            area: args.area,
            candidates: found.map((c) => ({
              ref: c.ref,
              host: new URL(c.url).hostname,
              evidence: c.evidence,
            })),
          },
          phase: ctx.phase,
          latencyMs: 0,
          costMicro: 0,
        });
        if (found.length === 0) return 'no verified results; do not reply';
        // 只给模型结构化字段，不给网页正文（防注入）
        return JSON.stringify(
          found.map((c) => ({
            ref: c.ref,
            name: c.name,
            contact: Object.keys(c.contact),
            source: c.evidence,
          })),
        );
      } catch (e) {
        if (e instanceof UnsafeQueryError) {
          return `${e.message}. Rewrite "need" as a short generic description with no personal details.`;
        }
        throw e;
      }
    },
  });
}
