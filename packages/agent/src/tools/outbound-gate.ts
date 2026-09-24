import { createRateLimiter, decideOutbound, type OutboundDecision } from '@matchbot/gating';
import type { OutboundKind } from '@matchbot/domain';
import { hashText } from '@matchbot/shared';
import type { RunContext } from '@openai/agents';
import type { AgentDeps, MatchContext } from '../context.js';

export interface OutboundDraftInput {
  /** 用途；决定是否计入频控。每个出站工具必须显式给出。 */
  kind: OutboundKind;
  target: string;
  text: string;
  supplierSummaries: string[];
  inputRef: string;
  toolCallId?: string;
  /** 附加在工具返回值末尾的说明（如 push_lead 的人工转达提示）。 */
  resultNote?: string;
  /**
   * 附哪种免责。推荐库内商家用 catalogue，推荐 web search 结果用 web（明说未核实）；
   * 追问与线索不附。
   */
  disclaimer?: 'catalogue' | 'web'; /** 群内回帖：回复哪条原消息、@ 谁（均为渠道侧 id）。 */
  replyToMessageId?: string;
  mentionUserId?: string;
}

/**
 * PRD F7 / §6.3：推荐商家的群内回复末尾固定一句免责，中文取 PRD 原文。
 * 此前是所有出站都附一句英文，连「请问您什么时候搬？」这种追问后面也挂着
 * 「直接联系他们报价」——没有「他们」，而且中文对话后面跟英文。
 */
const DISCLAIMERS: Record<'catalogue' | 'web', Record<string, string>> = {
  catalogue: {
    zh: '请直接联系商家确认报价与档期，我们不参与交易。',
    en: 'Please contact the suppliers directly to confirm price and availability — we are not part of the transaction.',
    ru: 'Цену и время уточняйте напрямую у исполнителя — мы не участвуем в сделке.',
    uk: 'Ціну та час уточнюйте безпосередньо у виконавця — ми не беремо участі в угоді.',
    pt: 'Confirme preço e disponibilidade diretamente com o fornecedor — não fazemos parte da transação.',
  },
  // P14：搜索结果没有人工把关（PoC 里大量是按区域做的 SEO 中介页），必须明说未核实
  web: {
    zh: '以上来自公开网络搜索，我们没有核实过这些商家，请自行判断并直接联系确认。',
    en: 'These come from a public web search — we have not checked these businesses, so please judge for yourself and contact them directly.',
    ru: 'Это результаты открытого веб-поиска — мы не проверяли эти компании, решайте сами и связывайтесь с ними напрямую.',
    uk: 'Це результати відкритого пошуку в інтернеті — ми не перевіряли ці компанії, вирішуйте самі та звертайтеся до них напряму.',
    pt: 'Isto vem de uma busca pública na internet — não verificamos estas empresas, avalie por conta própria e contacte-as diretamente.',
  },
};

/**
 * 语言优先用需求上记录的 lang；没有就只凭汉字判中文。西里尔字母不猜俄/乌——
 * 给乌克兰用户回俄语比回英语糟得多，猜不准就落到英语。
 */
export function disclaimerFor(
  lang: string | undefined,
  text: string,
  kind: 'catalogue' | 'web' = 'catalogue',
): string {
  const set = DISCLAIMERS[kind];
  const key = lang && set[lang] ? lang : /\p{Script=Han}/u.test(text) ? 'zh' : 'en';
  return set[key]!;
}

/** PRD §6.2「一个群一天三次就是广告机器人」。群级额度取 groups.rateLimitPerDay，这里只是缺省。 */
const DEFAULT_LIMIT_PER_DAY = 3;

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
    // 只有推荐受频控；追问、通知、线索不占额度
    rateOk =
      d.kind !== 'recommendation' ||
      (await createRateLimiter(deps.repos.outbound).check({
        target: d.target,
        limitPerDay: ctx.rateLimitPerDay ?? DEFAULT_LIMIT_PER_DAY,
        now: new Date(),
      }));
  }
  const decision = decideOutbound({
    phase: ctx.phase,
    verdict,
    rateOk,
    t: deps.thresholds,
    onUnsure: deps.env.OUTBOUND_UNSURE_ACTION,
  });
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
  if (decision === 'drop') {
    ctx.outboundBlocked = true;
    return 'not sent: the outbound gate decided this should not be posted. Do not rewrite or retry; stop here.';
  }
  const status = decision === 'dry_run' ? 'dry_run' : 'pending';
  const row = await deps.repos.outbound.create(
    {
      channel: 'telegram',
      kind: d.kind,
      target: d.target,
      text: d.disclaimer
        ? `${d.text}\n\n${disclaimerFor(ctx.demand?.lang, d.text, d.disclaimer)}`
        : d.text,
      ...(d.toolCallId ? { toolCallId: d.toolCallId } : {}),
      ...(d.replyToMessageId ? { replyToMessageId: d.replyToMessageId } : {}),
      ...(d.mentionUserId ? { mentionUserId: d.mentionUserId } : {}),
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
