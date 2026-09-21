/** 初值来自架构文档；Phase 0 结束后用标注样本校准并在此更新（AGENTS.md §8 第 3 条）。 */
export interface Thresholds {
  T_IS_DEMAND_ENTER: number;
  T_IS_SUPPLY_ENTER: number;
  T_IS_SENSITIVE_DROP: number;
  T_IS_MOVE_EVENT_TAG: number;
  T_WORTH_REPLYING_AUTO: number;
  T_LANGUAGE_OK_AUTO: number;
  T_MENTIONS_UNVERIFIED_DROP: number;
  T_WORTH_REPLYING_DROP: number;
}
export const DEFAULT_THRESHOLDS: Thresholds = {
  T_IS_DEMAND_ENTER: 0.7,
  T_IS_SUPPLY_ENTER: 0.7,
  T_IS_SENSITIVE_DROP: 0.5,
  T_IS_MOVE_EVENT_TAG: 0.6,
  T_WORTH_REPLYING_AUTO: 2.2,
  T_LANGUAGE_OK_AUTO: 0.8,
  T_MENTIONS_UNVERIFIED_DROP: 0.5,
  T_WORTH_REPLYING_DROP: 1.0,
};
