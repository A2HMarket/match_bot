import { isServiceCategory, type DemandCategory } from '@matchbot/domain';
import type { Thresholds } from './thresholds.js';

export interface InboundSignals { isDemand: number; isSupply: number; category: DemandCategory; isSensitive: number; isMoveEvent: number }
export type InboundDecision =
  | { action: 'drop'; reason: 'sensitive' | 'not_demand' }
  | { action: 'tag_move_event' }
  | { action: 'enter_agent'; category: DemandCategory; kind: 'demand' | 'supply' | 'both' };

/** 顺序即优先级：敏感 > 非服务品类打标签 > 进 agent > 丢弃（架构 §3、PRD §4.3）。 */
export function decideInbound(v: InboundSignals, t: Thresholds): InboundDecision {
  if (v.isSensitive >= t.T_IS_SENSITIVE_DROP) return { action: 'drop', reason: 'sensitive' };
  const demand = v.isDemand >= t.T_IS_DEMAND_ENTER;
  const supply = v.isSupply >= t.T_IS_SUPPLY_ENTER;
  if (!isServiceCategory(v.category)) {
    return v.isMoveEvent >= t.T_IS_MOVE_EVENT_TAG ? { action: 'tag_move_event' } : { action: 'drop', reason: 'not_demand' };
  }
  if (demand && supply) return { action: 'enter_agent', category: v.category, kind: 'both' };
  if (demand) return { action: 'enter_agent', category: v.category, kind: 'demand' };
  if (supply) return { action: 'enter_agent', category: v.category, kind: 'supply' };
  return { action: 'drop', reason: 'not_demand' };
}
