import { isServiceCategory, type DemandCategory } from '@matchbot/domain';
import type { Thresholds } from './thresholds.js';

export interface InboundSignals {
  isDemand: number;
  isSupply: number;
  category: DemandCategory;
  isSensitive: number;
  isMoveEvent: number;
  /** P14：是否在找本地商家/店铺/地方。只在 category=other 时使用。 */
  isLocalRequest: number;
}
export type InboundDecision =
  | { action: 'drop'; reason: 'sensitive' | 'not_demand' }
  | { action: 'tag_move_event' }
  | { action: 'enter_agent'; category: DemandCategory; kind: 'demand' | 'supply' | 'both' };

/**
 * 顺序即优先级：敏感 > 库外本地求助 > 非服务品类打标签 > 进 agent > 丢弃（架构 §3、PRD §4.3）。
 * 库外本地求助（P14）只认 category=other：租房、招聘、二手仍按 PRD 不接。
 */
export function decideInbound(v: InboundSignals, t: Thresholds): InboundDecision {
  if (v.isSensitive >= t.T_IS_SENSITIVE_DROP) return { action: 'drop', reason: 'sensitive' };
  const demand = v.isDemand >= t.T_IS_DEMAND_ENTER;
  const supply = v.isSupply >= t.T_IS_SUPPLY_ENTER;
  if (v.category === 'other' && v.isLocalRequest >= t.T_IS_LOCAL_REQUEST_ENTER) {
    return { action: 'enter_agent', category: 'other', kind: 'demand' };
  }
  if (!isServiceCategory(v.category)) {
    return v.isMoveEvent >= t.T_IS_MOVE_EVENT_TAG
      ? { action: 'tag_move_event' }
      : { action: 'drop', reason: 'not_demand' };
  }
  if (demand && supply) return { action: 'enter_agent', category: v.category, kind: 'both' };
  if (demand) return { action: 'enter_agent', category: v.category, kind: 'demand' };
  if (supply) return { action: 'enter_agent', category: v.category, kind: 'supply' };
  return { action: 'drop', reason: 'not_demand' };
}
