/** Jev 问题 id。choice 的 option key 与 DemandCategory 完全一致（AGENTS.md §4.4）。 */
export const INBOUND_QUESTION_IDS = [
  'is_demand',
  'is_supply',
  'category',
  'urgency',
  'has_location',
  'is_sensitive',
  'is_move_event',
] as const;
export type InboundQuestionId = (typeof INBOUND_QUESTION_IDS)[number];

export const OUTBOUND_QUESTION_IDS = [
  'worth_replying',
  'language_ok',
  'mentions_unverified',
] as const;
export type OutboundQuestionId = (typeof OUTBOUND_QUESTION_IDS)[number];
