import type { Phase } from '@matchbot/domain';
import { Agent, Runner } from '@openai/agents';
import type { AgentDeps, MatchContext } from './context.js';
import { noGuaranteeOutputGuardrail, sensitiveInputGuardrail } from './guardrails.js';
import { askClarificationTool } from './tools/ask-clarification.js';
import { closeDemandTool } from './tools/close-demand.js';
import { doNothingTool } from './tools/do-nothing.js';
import { findPeerSupplyTool } from './tools/find-peer-supply.js';
import { findSuppliersTool } from './tools/find-suppliers.js';
import { notifyUserTool } from './tools/notify-user.js';
import { pushLeadTool } from './tools/push-lead.js';
import { replyInGroupTool } from './tools/reply-in-group.js';
import { upsertDemandTool } from './tools/upsert-demand.js';
import { upsertSupplyTool } from './tools/upsert-supply.js';

/** 改 instructions 或任何工具描述时递增（AGENTS.md §8 第 4 条）；升级 SDK 时清空待审 run_states。 */
export const AGENT_VERSION = '0.1.0';

const CATEGORY_NOTES: Record<string, string> = {
  man_and_van:
    'Key fields: date, from postcode, to postcode, volume (boxes/rooms). Weekend and same-day matter.',
  eot_cleaning:
    'Key fields: property size (studio/1-bed/2-bed), date, postcode. Guarantee period matters to tenants.',
  furniture_service:
    'Key fields: item and brand (IKEA PAX etc.), assembly vs delivery vs disposal, postcode, date.',
};

/**
 * 单个 matchAgent，品类差异走 instructions 注入（架构 §4.2）。
 * toolUseBehavior 保留默认 run_llm_again：matchAgent 需要 upsert_demand → find_suppliers →
 * reply_in_group 的链式调用，PoC V1 的 stop_on_first_tool 只适用于单工具分类场景；
 * 写工具全部幂等（upsert / replaceForDemand），出站经门控与频控兜底。
 *
 * Runner 按 run 构造（V6：traceMetadata 属 RunConfig，只能 new Runner 传），
 * traceIncludeSensitiveData: false 让 span 不带原文。
 */
export function createMatchAgent(deps: AgentDeps, run?: { phase: Phase }) {
  const agent = new Agent<MatchContext>({
    name: 'matchAgent',
    model: deps.env.DEEPSEEK_MODEL,
    instructions: (rc) =>
      [
        'You are a helpful member of a London community group who connects people with local services (man & van, end-of-tenancy cleaning, furniture assembly/removal).',
        'You never handle payment, never guarantee quality, never recommend suppliers that find_suppliers did not return.',
        'Reply in the language of the user. Be brief. One clarifying question at a time.',
        'Housing, job and second-hand requests are not your business: call do_nothing.',
        rc.context.demand
          ? `Current open demand: ${JSON.stringify(rc.context.demand)}. ${CATEGORY_NOTES[rc.context.demand.category] ?? ''}`
          : 'No open demand yet.',
        rc.context.recentReplies.length
          ? `Recent replies already posted in this group: ${rc.context.recentReplies.join(' | ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    tools: [
      upsertDemandTool(deps),
      upsertSupplyTool(deps),
      findSuppliersTool(deps),
      findPeerSupplyTool(deps),
      askClarificationTool(deps),
      replyInGroupTool(deps),
      notifyUserTool(deps),
      pushLeadTool(deps),
      closeDemandTool(deps),
      doNothingTool(deps),
    ],
    inputGuardrails: [sensitiveInputGuardrail],
    outputGuardrails: [noGuaranteeOutputGuardrail],
  });
  const runner = new Runner({
    traceIncludeSensitiveData: false,
    ...(run ? { traceMetadata: { phase: String(run.phase) } } : {}),
    ...(deps.modelProvider ? { modelProvider: deps.modelProvider } : {}),
  });
  return { agent, runner };
}
