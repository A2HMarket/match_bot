import { isServiceCategory, type DemandCategory } from '@matchbot/domain';
import type { Thresholds } from './thresholds.js';
import { isStandaloneMarketAdvertisement } from './market-request.js';

export interface InboundSignals {
  isDemand: number;
  isSupply: number;
  category: DemandCategory;
  isSensitive: number;
  isMoveEvent: number;
  /** 是否在求助伦敦日常生活（找商家/服务/活动/地方、办事咨询、本地生活信息）。只在 category=other 时使用。 */
  isLocalRequest: number;
}
export type InboundDecision =
  | { action: 'drop'; reason: 'sensitive' | 'not_demand' }
  | { action: 'tag_move_event' }
  | {
      action: 'enter_agent';
      category: DemandCategory;
      kind: 'demand' | 'supply' | 'both' | 'followup';
    };

/**
 * 顺序即优先级：敏感 > 对 bot 接话 > 库外生活服务求助 > 非服务品类打标签 > 进 agent > 丢弃（架构 §3、PRD §4.3）。
 * 库外生活服务求助（P14，「生活服务小助手」口径）只认 category=other：用户授权 P16：二手/租房进入公开搜索，招聘仍不接。
 */
export function decideInbound(
  v: InboundSignals,
  t: Thresholds,
  opts: { addressedToBot?: boolean | undefined; text?: string | undefined } = {},
): InboundDecision {
  if (v.isSensitive >= t.T_IS_SENSITIVE_DROP) return { action: 'drop', reason: 'sensitive' };
  // 对 bot 说的话（回复 bot / @bot）是在接话：「谢谢」「这家周末开吗」都不是新需求，
  // 按需求门判会被丢掉，用户就会觉得 bot 发完一条就不理人。敏感检查仍在前面。
  if (opts.addressedToBot) return { action: 'enter_agent', category: v.category, kind: 'followup' };
  if (
    (v.category === 'housing' || v.category === 'second_hand') &&
    opts.text &&
    isStandaloneMarketAdvertisement(opts.text)
  )
    return v.isMoveEvent >= t.T_IS_MOVE_EVENT_TAG
      ? { action: 'tag_move_event' }
      : { action: 'drop', reason: 'not_demand' };
  const demand = v.isDemand >= t.T_IS_DEMAND_ENTER;
  const supply = v.isSupply >= t.T_IS_SUPPLY_ENTER;
  if (
    ['other', 'housing', 'second_hand'].includes(v.category) &&
    v.isLocalRequest >= t.T_IS_LOCAL_REQUEST_ENTER
  ) {
    return { action: 'enter_agent', category: v.category, kind: 'demand' };
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
