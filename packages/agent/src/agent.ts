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
import { reactTool } from './tools/react.js';
import { replyInGroupTool } from './tools/reply-in-group.js';
import { replyWithSearchResultsTool } from './tools/reply-with-search-results.js';
import { upsertDemandTool } from './tools/upsert-demand.js';
import { upsertSupplyTool } from './tools/upsert-supply.js';
import { webSearchTool } from './tools/web-search.js';

/** 改 instructions 或任何工具描述时递增（AGENTS.md §8 第 4 条）；升级 SDK 时清空待审 run_states。 */
export const AGENT_VERSION = '0.4.0';

const CATEGORY_NOTES: Record<string, string> = {
  man_and_van:
    'Key fields: date, from postcode, to postcode, volume (boxes/rooms). Weekend and same-day matter.',
  eot_cleaning:
    'Key fields: property size (studio/1-bed/2-bed), date, postcode. Guarantee period matters to tenants.',
  furniture_service:
    'Key fields: item and brand (IKEA PAX etc.), assembly vs delivery vs disposal, postcode, date.',
  other:
    'Key fields: need (what they are looking for) and area if given. Do not insist on a date or postcode; anywhere in London is fine.',
};

/** 「下周六」要换算成 whenAt，模型需要知道今天是哪天、星期几（伦敦时区）。 */
export function londonToday(now = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      weekday: 'long',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day}`;
}

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
        'You never handle payment, never guarantee quality, and never recommend a business that neither find_suppliers nor web_search returned.',
        'Reply in the language of the user. Be brief. One clarifying question at a time.',
        // 0.4.0 人感：像群友说话，而不是客服或广告号
        'Write like a friendly, helpful member of the group, in first person singular ("I", "我"), never "we". Group replies are 1-3 short sentences: no headings, no numbered lists, no URLs, at most one emoji.',
        // 分寸：群是公开的，session 里记得的别的事不能在群里说
        'The group is public. Use only what the user said in this conversation. Never bring up anything else you know about them from earlier messages (moving plans, addresses, family, health, money or other requests).',
        `Today is ${londonToday()} (Europe/London).`,
        // 出站门拒绝后不许改写重投：0.3.0 前实测连投 6 版才过，等于把门当成要优化的目标
        'If a tool says a message was not sent, do not rewrite or retry it: stop.',
        // 0.1.0 会在推荐后问「要不要我帮你把需求发给其中某一家？」——用户回「要」也没有后续。
        "Only offer what you can do in this reply. Never offer to forward the request, contact, book or follow up with a supplier on the user's behalf, and never promise to check back later; suppliers are to be contacted by the user directly.",
        'Housing, job and second-hand requests are not your business: call do_nothing.',
        deps.webSearch
          ? 'Our own supplier list covers only moving, end-of-tenancy cleaning and furniture services. For anything else (category "other"), or when find_suppliers finds nothing, call web_search, then reply_with_search_results with the 1-3 most relevant refs. If web_search finds nothing, call do_nothing. In that reply write only a one-sentence intro: never type business names, phone numbers or links yourself.'
          : 'Requests outside moving, end-of-tenancy cleaning and furniture services: call do_nothing.',
        rc.context.addressedToBot
          ? [
              'The user is talking to you directly.',
              rc.context.replyToBotText
                ? `They are replying to your earlier message: """${rc.context.replyToBotText}"""`
                : '',
              'If they only thank you or acknowledge, call react (👍 or 🙏) and do nothing else. If they ask something you cannot know (opening hours, stock, a price you were not given), say so in one sentence and suggest asking the business. If they ask who or what you are: you are a bot that helps people here find local services, using a small checked list and public web search, and the group admins can switch you off.',
            ].join('\n')
          : '',
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
      reactTool(deps),
      ...(deps.webSearch
        ? [webSearchTool({ ...deps, webSearch: deps.webSearch }), replyWithSearchResultsTool(deps)]
        : []),
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
