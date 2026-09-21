/**
 * matchAgent 组装（架构 §4）。
 * - 模型：OpenAIProvider({ baseURL: DeepSeek, useResponses: false })，model = env.DEEPSEEK_MODEL
 * - 出站工具一律 needsApproval 走 gating + jev
 * - tracing：禁用默认导出，注册写 decision_traces 的 processor
 */
export const AGENT_VERSION = '0.0.0';
