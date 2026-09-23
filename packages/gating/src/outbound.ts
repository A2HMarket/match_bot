import type { Phase } from '@matchbot/domain';
import type { Thresholds } from './thresholds.js';

export interface OutboundSignals {
  worthReplying: number;
  languageOk: number;
  mentionsUnverified: number;
}
export type OutboundDecision = 'dry_run' | 'review' | 'auto' | 'drop';

/**
 * Phase 0 不发；Phase 1 全审；Phase 2 看分数。
 *
 * Phase 2 里「拿不准」的三种情况——Jev 不可用、分数居中、触发频控——交给 onUnsure：
 * 有人值守送审（review），无人值守直接不发（drop）。两种取值都不会在拿不准时自动发，
 * 所以 Jev 挂了仍然不会放行（AGENTS.md §3.3 第 5 条）。
 */
export function decideOutbound(p: {
  phase: Phase;
  verdict: OutboundSignals | null;
  rateOk: boolean;
  t: Thresholds;
  onUnsure?: 'review' | 'drop';
}): OutboundDecision {
  if (p.phase === 0) return 'dry_run';
  if (p.phase === 1) return 'review';
  const unsure = p.onUnsure ?? 'review';
  if (!p.verdict) return unsure;
  if (p.verdict.mentionsUnverified >= p.t.T_MENTIONS_UNVERIFIED_DROP) return 'drop';
  if (p.verdict.worthReplying < p.t.T_WORTH_REPLYING_DROP) return 'drop';
  if (!p.rateOk) return unsure;
  if (
    p.verdict.worthReplying >= p.t.T_WORTH_REPLYING_AUTO &&
    p.verdict.languageOk >= p.t.T_LANGUAGE_OK_AUTO
  )
    return 'auto';
  return unsure;
}
