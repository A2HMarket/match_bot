/** 纯规则。本包禁止 import @matchbot/jev 或 @openai/agents（scripts/check-deps.mjs 校验）。 */
export { DEFAULT_THRESHOLDS, type Thresholds } from './thresholds.js';
export { resolvePhase } from './phase.js';
export { isBlacklisted } from './blacklist.js';
