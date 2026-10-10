import type { Phase } from '@matchbot/domain';
import type { Thresholds } from './thresholds.js';

export interface OutboundSignals {
  worthReplying: number;
  languageOk: number;
  mentionsUnverified: number;
}
export type OutboundDecision = 'dry_run' | 'review' | 'auto' | 'drop';

/**
 * Phase 0 不发；Phase 1 全审；Phase 2 过了硬下限就自动发。
 *
 * 2026-10-10 起取消「分数居中送审」的中间带：用户要求回复不经过人工过目。
 * worthReplying / mentionsUnverified 的硬下限保留（明显文不对题、推荐未核实商家的仍然不发）；
 * language_ok 仍由 Jev 出题留痕，但不再参与门控。
 *
 * 拿不准只剩两种情况——Jev 不可用、触发频控——交给 onUnsure：有人值守送审（review），
 * 无人值守直接不发（drop）。Jev 挂了仍然永远不自动发（AGENTS.md §3.3 第 5 条）。
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
  return 'auto';
}
