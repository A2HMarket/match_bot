/** 初值来自架构文档；Phase 0 结束后用标注样本校准并在此更新（AGENTS.md §8 第 3 条）。 */
export interface Thresholds {
  T_IS_DEMAND_ENTER: number;
  T_IS_SUPPLY_ENTER: number;
  T_IS_SENSITIVE_DROP: number;
  T_IS_MOVE_EVENT_TAG: number;
  T_IS_LOCAL_REQUEST_ENTER: number;
  T_MENTIONS_UNVERIFIED_DROP: number;
  T_WORTH_REPLYING_DROP: number;
  T_SOURCE_SUPPORT_ACCEPT: number;
}
export const DEFAULT_THRESHOLDS: Thresholds = {
  // 校准依据 `pnpm eval`（n=50，jev-1.13-20260917）：正类最低 0.89、负类最高 0.11，
  // 0.12–0.88 是空带，0.7 有充足余量。
  T_IS_DEMAND_ENTER: 0.7,
  // 0.7 → 0.8：同一轮评测里负类最高到 0.77（俄语求职消息），0.7 已被越过。
  // 本轮没出假阳只是因为 decideInbound 先用 isServiceCategory 挡掉了 job 品类——
  // 那是第二道防线，不该拿它兜底第一道。PoC V4 当初建议的就是 0.8。
  T_IS_SUPPLY_ENTER: 0.8,
  T_IS_SENSITIVE_DROP: 0.5,
  T_IS_MOVE_EVENT_TAG: 0.6,
  // 生活服务小助手校准（n=80，jev-1.13-20260917，category=other 的 34 条）：题目放宽为
  // 「任何伦敦日常生活需求」后，正类最低 0.79（BRP 补办），负类最高 0.13，空带 0.13–0.79，
  // 0.7 两侧都有余量。响应范围含生活办事咨询（GP / NI / BRP）与本地生活信息（罢工等）；
  // 租房 / 招聘 / 二手 / 换汇 / 纯闲聊仍不接。
  T_IS_LOCAL_REQUEST_ENTER: 0.7,
  // 出站立两个硬下限，过了就自动发，没有中间带（2026-10-10：回复不经过人工过目）。
  T_MENTIONS_UNVERIFIED_DROP: 0.5,
  T_WORTH_REPLYING_DROP: 1.0,
  // Source-level semantic support; an uncertain result remains unknown and does not silence the request.
  T_SOURCE_SUPPORT_ACCEPT: 0.8,
};
