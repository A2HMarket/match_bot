import { DEFAULT_THRESHOLDS, decideInbound } from '@matchbot/gating';
import type { InboundVerdict } from '@matchbot/jev';

/** 已绑定阈值的入站门。 */
export type BoundInboundGate = (verdict: InboundVerdict) => { action: string };

/**
 * 回放跑的是**生产同一份**门与阈值，绝不在本包复制阈值——复制会让 gating 与 eval
 * 悄悄分叉，评测结果就不再能代表线上行为（AGENTS.md §4.4）。
 */
export function loadInboundGate(): BoundInboundGate | null {
  return (verdict) => decideInbound(verdict, DEFAULT_THRESHOLDS);
}
