import { isBlacklisted } from '@matchbot/gating';
import type { InputGuardrail, OutputGuardrail } from '@openai/agents';

/** 兜底：进 agent 前再挡一次敏感内容（Pre-gate 已挡过；这里防旁路调用，架构 §4.5）。 */
export const sensitiveInputGuardrail: InputGuardrail = {
  name: 'sensitive_input',
  runInParallel: false,
  execute: ({ input }) => {
    const text = typeof input === 'string' ? input : JSON.stringify(input);
    return Promise.resolve({ tripwireTriggered: isBlacklisted(text), outputInfo: {} });
  },
};

/** 平台不经手交易（PRD §3.3），最终输出不得含担保话术。 */
const GUARANTEE = /\b(guarantee|guaranteed|担保|保证|платформа гарантирует)\b/i;
export const noGuaranteeOutputGuardrail: OutputGuardrail = {
  name: 'no_guarantee',
  execute: ({ agentOutput }) =>
    Promise.resolve({ tripwireTriggered: GUARANTEE.test(String(agentOutput)), outputInfo: {} }),
};
