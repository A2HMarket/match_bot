import { createRateLimiter, decideOutbound, type OutboundDecision } from '@matchbot/gating';
import { hashText } from '@matchbot/shared';
import type { RunContext } from '@openai/agents';
import type { AgentDeps, MatchContext } from '../context.js';

export interface OutboundDraftInput {
  target: string;
  text: string;
  supplierSummaries: string[];
  inputRef: string;
  toolCallId?: string;
  /** 附加在工具返回值末尾的说明（如 push_lead 的人工转达提示）。 */
  resultNote?: string;
  /** 是否附免责。只有向用户推荐商家的草稿（reply_in_group）需要，追问与线索不需要。 */
  disclaimer?: boolean;
}

/**
 * PRD F7 / §6.3：推荐商家的群内回复末尾固定一句免责，中文取 PRD 原文。
 * 此前是所有出站都附一句英文，连「请问您什么时候搬？」这种追问后面也挂着
 * 「直接联系他们报价」——没有「他们」，而且中文对话后面跟英文。
 */
const DISCLAIMERS: Record<string, string> = {
  zh: '请直接联系商家确认报价与档期，我们不参与交易。',
  en: 'Please contact the suppliers directly to confirm price and availability — we are not part of the transaction.',
  ru: 'Цену и время уточняйте напрямую у исполнителя — мы не участвуем в сделке.',
  uk: 'Ціну та час уточнюйте безпосередньо у виконавця — ми не беремо участі в угоді.',
  pt: 'Confirme preço e disponibilidade diretamente com o fornecedor — não fazemos parte da transação.',
};

/**
 * 语言优先用需求上记录的 lang；没有就只凭汉字判中文。西里尔字母不猜俄/乌——
 * 给乌克兰用户回俄语比回英语糟得多，猜不准就落到英语。
 */
export function disclaimerFor(lang: string | undefined, text: string): string {
  const key = lang && DISCLAIMERS[lang] ? lang : /\p{Script=Han}/u.test(text) ? 'zh' : 'en';
  return DISCLAIMERS[key]!;
}

/** PRD §6.2「一个群一天三次就是广告机器人」。群级覆盖留待 group_configs 落地后接入。 */
const OUTBOUND_LIMIT_PER_DAY = 3;

/**
 * needsApproval 与 execute 在一次 run 里都会要出站决定；按（ctx, target+text）缓存，
 * 避免 Phase 2 下同一草稿调两次 Jev。
 */
const decisionCache = new WeakMap<MatchContext, Map<string, OutboundDecision>>();

/**
 * 三个门里的出站门（架构 §3）：阶段 → Jev 出站分 → 频控。
 * Phase 0/1 不调 Jev（省钱）；Phase 2 且 Jev 不可用时按 §3.3 第 5 条送审。
 * 每一次决定都写 decision_traces（kind = gate）。
 */
export async function decideForOutbound(
  deps: AgentDeps,
  ctx: MatchContext,
  d: OutboundDraftInput,
): Promise<OutboundDecision> {
  const key = hashText(`${d.target}${d.text}`);
  const cached = decisionCache.get(ctx)?.get(key);
  if (cached) return cached;

  let verdict = null;
  let rateOk = true;
  if (ctx.phase === 2) {
    const v = ctx.demand
      ? await deps.evaluateOutbound(deps.jev, {
          draft: d.text,
          demand: ctx.demand,
          supplierSummaries: d.supplierSummaries,
          recentReplies: ctx.recentReplies,
          inputRef: d.inputRef,
          phase: ctx.phase,
        })
      : null;
    verdict = v && v.ok ? v : null;
    rateOk = await createRateLimiter(deps.repos.outbound).check({
      target: d.target,
      limitPerDay: OUTBOUND_LIMIT_PER_DAY,
      now: new Date(),
    });
  }
  const decision = decideOutbound({ phase: ctx.phase, verdict, rateOk, t: deps.thresholds });
  await deps.repos.traces.create({
    kind: 'gate',
    inputRef: d.inputRef,
    output: { gate: 'outbound', decision, verdict, rateOk },
    phase: ctx.phase,
    latencyMs: 0,
    costMicro: 0,
  });

  let byKey = decisionCache.get(ctx);
  if (!byKey) {
    byKey = new Map();
    decisionCache.set(ctx, byKey);
  }
  byKey.set(key, decision);
  return decision;
}

/** 出站只写 outbound_messages 表（AGENTS.md §3.3 第 3 条）；发送由 apps/bot 消费。 */
export async function executeOutbound(
  deps: AgentDeps,
  ctx: MatchContext,
  d: OutboundDraftInput,
  decision: OutboundDecision,
): Promise<string> {
  if (decision === 'drop') return 'not sent: the outbound gate dropped this draft';
  const status = decision === 'dry_run' ? 'dry_run' : 'pending';
  const row = await deps.repos.outbound.create(
    {
      channel: 'telegram',
      target: d.target,
      text: d.disclaimer ? `${d.text}\n\n${disclaimerFor(ctx.demand?.lang, d.text)}` : d.text,
      ...(d.toolCallId ? { toolCallId: d.toolCallId } : {}),
    },
    status,
  );
  deps.logger.info({ outboundId: row.id, decision, phase: ctx.phase }, 'outbound message recorded');
  return status === 'dry_run'
    ? `dry-run recorded (${row.id}); nothing was sent`
    : `queued (${row.id})`;
}

/** needsApproval：只有 'review' 才中断；auto / dry_run / drop 都不中断，由 execute 按 decision 处理。 */
export function outboundNeedsApproval(deps: AgentDeps) {
  return async (rc: RunContext<MatchContext>, d: OutboundDraftInput): Promise<boolean> =>
    (await decideForOutbound(deps, rc.context, d)) === 'review';
}
