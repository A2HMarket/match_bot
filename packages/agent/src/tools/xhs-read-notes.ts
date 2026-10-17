import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AgentDeps, MatchContext } from '../context.js';
import { getXhsPassages } from '../xhs-evidence.js';
import { XHS_RESEARCH_LIMITS, getXhsNoteKey } from '../xhs-research.js';

/** 广召回只拿卡片；把限时详情预算集中在入选实体，避免前几篇合集占满全文额度。 */
export function xhsReadNotesTool(deps: AgentDeps) {
  return tool({
    name: 'xhs_read_notes',
    description:
      'Read full original bodies of 1-6 returned XHS refs before synthesizing. Search returns discovery cards, not full evidence. Read overview notes to discover entities, then read at least two relevant notes for each shortlisted entity when available. Budget: 12 unique full-note reads per run, failed attempts cached. Returns replacement passages with stable note refs; use the NEW passage IDs/text, never the earlier card excerpts. Only returned refs are accepted; stop after outbound decline.',
    parameters: z.object({ refs: z.array(z.string()).min(1).max(6) }),
    execute: async (args, rc) => {
      const ctx = (rc as RunContext<MatchContext>).context;
      const byRef = new Map((ctx.xhsNotes ?? []).map((n) => [n.ref, n]));
      let denial: string | undefined;
      if (ctx.outboundBlocked) denial = 'outbound declined; stop';
      else if (ctx.marketListings || ctx.searchResults)
        denial = 'different source already selected';
      else if (!deps.xhsSearch?.readNote) denial = 'full-note reader unavailable';
      else if (args.refs.some((ref) => !byRef.has(ref)))
        denial = 'unknown ref; select returned refs';
      const previous = ctx.xhsDetailRefs ?? [];
      const requested = [...new Set(args.refs)].filter(
        (ref) => !previous.includes(ref) && byRef.get(ref)?.isDetailLoaded !== true,
      );
      const remaining = Math.max(0, XHS_RESEARCH_LIMITS.detailReads - previous.length);
      const pending = requested.slice(0, remaining);
      const budgetLimitedRefs = requested.slice(remaining);
      if (!denial && !remaining && requested.length)
        denial = 'full-note read budget exhausted; use already read sources';
      if (denial) {
        await record(ctx, { decision: 'deny', reason: denial });
        return denial;
      }
      ctx.xhsDetailRefs = [...previous, ...pending];
      const started = Date.now();
      const results = await Promise.allSettled(
        pending.map((ref) => deps.xhsSearch!.readNote!(byRef.get(ref)!)),
      );
      const failedRefs: string[] = [];
      for (const [i, result] of results.entries()) {
        const ref = pending[i]!,
          original = byRef.get(ref)!;
        if (result.status === 'rejected')
          deps.logger.warn(
            { errorKind: result.reason instanceof Error ? result.reason.name : 'unknown' },
            'xhs note read failed',
          );
        const note = result.status === 'fulfilled' ? result.value : null;
        if (
          !note ||
          note.ref !== ref ||
          getXhsNoteKey(note.url) !== getXhsNoteKey(original.url) ||
          note.isDetailLoaded !== true
        ) {
          failedRefs.push(ref);
          continue;
        }
        Object.assign(original, {
          ...note,
          ref,
          url: original.url,
          desc: note.desc.slice(0, XHS_RESEARCH_LIMITS.excerptChars),
        });
      }
      if (failedRefs.length) {
        ctx.sourceFailures ??= [];
        ctx.sourceFailures.push('xiaohongshu:detail_unavailable');
      }
      await record(
        ctx,
        {
          decision: 'read',
          requested: pending.length,
          loaded: pending.length - failedRefs.length,
          failedRefs,
          budgetLimitedRefs,
          usedReads: ctx.xhsDetailRefs.length,
        },
        Date.now() - started,
      );
      return JSON.stringify({
        notes: args.refs
          .filter((ref) => byRef.get(ref)?.isDetailLoaded === true)
          .map((ref) => {
            const n = byRef.get(ref)!;
            return {
              ref,
              title: n.title,
              author: n.author,
              passages: getXhsPassages(n),
              isDetailLoaded: true,
            };
          }),
        failedRefs,
        budgetLimitedRefs,
        unavailableRefs: args.refs.filter((ref) => byRef.get(ref)?.isDetailLoaded !== true),
        remainingReads: XHS_RESEARCH_LIMITS.detailReads - ctx.xhsDetailRefs.length,
        guidance:
          'Combine distinct relevant full notes about the same event/venue/edition. A roundup discovers options; do not use it as the sole final account when other full notes exist.',
      });
    },
  });
  async function record(ctx: MatchContext, output: Record<string, unknown>, latencyMs = 0) {
    await deps.repos.traces.create({
      kind: 'gate',
      inputRef: ctx.sourceMessageId,
      output: { gate: 'xhs_read_notes', ...output },
      phase: ctx.phase,
      latencyMs,
      costMicro: 0,
    });
  }
}
