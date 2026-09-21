/** 纯规则。本包禁止 import @matchbot/jev 或 @openai/agents（scripts/check-deps.mjs 校验）。 */
export { DEFAULT_THRESHOLDS, type Thresholds } from './thresholds.js';
export { resolvePhase } from './phase.js';
export { isBlacklisted } from './blacklist.js';
export { decideInbound, type InboundSignals, type InboundDecision } from './inbound.js';
export { decideOutbound, type OutboundSignals, type OutboundDecision } from './outbound.js';
export { createRateLimiter } from './rate-limit.js';
