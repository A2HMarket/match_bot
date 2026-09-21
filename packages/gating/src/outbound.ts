import type { Phase } from '@matchbot/domain';
import type { Thresholds } from './thresholds.js';

export interface OutboundSignals {
  worthReplying: number;
  languageOk: number;
  mentionsUnverified: number;
}
export type OutboundDecision = 'dry_run' | 'review' | 'auto' | 'drop';

/** Phase 0 不发；Phase 1 全审；Phase 2 才看分数。Jev 不可用永远送审（AGENTS.md §3.3 第 4、5 条）。 */
export function decideOutbound(p: {
  phase: Phase;
  verdict: OutboundSignals | null;
  rateOk: boolean;
  t: Thresholds;
}): OutboundDecision {
  if (p.phase === 0) return 'dry_run';
  if (p.phase === 1) return 'review';
  if (!p.verdict) return 'review';
  if (p.verdict.mentionsUnverified >= p.t.T_MENTIONS_UNVERIFIED_DROP) return 'drop';
  if (p.verdict.worthReplying < p.t.T_WORTH_REPLYING_DROP) return 'drop';
  if (!p.rateOk) return 'review';
  if (
    p.verdict.worthReplying >= p.t.T_WORTH_REPLYING_AUTO &&
    p.verdict.languageOk >= p.t.T_LANGUAGE_OK_AUTO
  )
    return 'auto';
  return 'review';
}
