import type { AgentDeps, MatchContext, runInbound as runInboundFn } from '@matchbot/agent';
import type { publishApproval as publishApprovalFn } from '@matchbot/approval';
import type { Demand, Group } from '@matchbot/db';
import type { DemandDraft, InboundMessage, Phase } from '@matchbot/domain';
import { decideInbound, isBlacklisted, resolvePhase } from '@matchbot/gating';
import type { evaluateInbound as evaluateInboundFn } from '@matchbot/jev';

export interface PipelineDeps extends AgentDeps {
  evaluateInbound: typeof evaluateInboundFn;
  runInbound: typeof runInboundFn;
  publishApproval: typeof publishApprovalFn;
  cards: Parameters<typeof publishApprovalFn>[0]['cards'];
}

/** Jev 看的最近上下文条数上限（架构 §3：同一作者最近消息作为弱上下文）。 */
const RECENT_TEXTS = 5;
const RECENT_WINDOW_HOURS = 24;

function toPhase(raw: number): Phase {
  return raw === 1 || raw === 2 ? raw : 0;
}

/** 代码门里不需要访问数据库的部分（架构 §3：空文本 / 命令 / 黑名单 / 群未接入）。 */
function preGateReason(text: string, group: Group | null, isPrivate: boolean): string | null {
  if (text.trim().length === 0) return 'empty_text';
  if (text.trimStart().startsWith('/')) return 'command';
  if (isBlacklisted(text)) return 'blacklist';
  if (!isPrivate && !group) return 'group_not_registered';
  if (group && !group.isActive) return 'group_inactive';
  return null;
}

function toDemandDraft(d: Demand): DemandDraft {
  return {
    category: d.category,
    confidence: d.confidence,
    ...(d.whenText ? { whenText: d.whenText } : {}),
    ...(d.whenAt ? { whenAt: d.whenAt.toISOString() } : {}),
    ...(d.fromPostcode ? { fromPostcode: d.fromPostcode } : {}),
    ...(d.toPostcode ? { toPostcode: d.toPostcode } : {}),
    ...(d.quantity ? { quantity: d.quantity } : {}),
    ...(d.budgetPence !== null ? { budgetPence: d.budgetPence } : {}),
    ...(d.lang ? { lang: d.lang } : {}),
  };
}

/**
 * 架构 §3 流程图的直译：代码门 → Jev 入站门 → agent。
 * 每个终点写一条 decision_traces（AGENTS.md §3.3 第 2 条）：dropped_by_rule / dropped_by_jev /
 * tagged_move_event / entered_agent / agent_interrupted / agent_completed。
 * Jev 不可用一律按「不进 agent」降级（§3.3 第 5 条）。
 */
export async function processInbound(d: PipelineDeps, msg: InboundMessage): Promise<void> {
  const t0 = Date.now();
  const isPrivate = msg.chatId === msg.userId;
  const group = isPrivate ? null : await d.repos.groups.findByExternal(msg.channel, msg.chatId);
  const phase = resolvePhase({ group, defaultPhase: toPhase(d.env.DEFAULT_PHASE) });
  const trace = (kind: 'rule' | 'gate', inputRef: string, output: Record<string, unknown>) =>
    d.repos.traces.create({
      kind,
      inputRef,
      output,
      phase,
      latencyMs: Date.now() - t0,
      costMicro: 0,
    });

  // 代码门先于落库：被规则挡下的消息不写 messages，避免留存无用文本（AGENTS.md §6）。
  const blocked = preGateReason(msg.text, group, isPrivate);
  if (blocked) {
    await trace('rule', `${msg.channel}:${msg.chatId}:${msg.messageId}`, {
      outcome: 'dropped_by_rule',
      reason: blocked,
    });
    return;
  }

  const user = await d.repos.users.upsertByExternal({
    channel: msg.channel,
    externalId: msg.userId,
    ...(msg.lang ? { lang: msg.lang } : {}),
  });
  const stored = await d.repos.messages.create({
    groupId: group?.id ?? null,
    userId: user.id,
    externalId: msg.messageId,
    text: msg.text,
    ...(msg.lang ? { lang: msg.lang } : {}),
    receivedAt: new Date(msg.receivedAt),
  });

  const recent = (await d.repos.messages.recentByUser(user.id, RECENT_WINDOW_HOURS))
    .filter((m) => m.id !== stored.id && m.text.length > 0)
    .slice(0, RECENT_TEXTS)
    .map((m) => m.text);
  const verdict = await d.evaluateInbound(d.jev, {
    text: msg.text,
    groupName: group?.name ?? 'private',
    ...(msg.lang ? { lang: msg.lang } : {}),
    recentTexts: recent,
    inputRef: stored.id,
    phase,
  });
  if (!verdict.ok) {
    // Jev 挂了不等于放行：入站方向固定为不进 agent（AGENTS.md §3.3 第 5 条）。
    await trace('gate', stored.id, {
      outcome: 'dropped_by_jev',
      reason: verdict.reason,
      jevAvailable: false,
    });
    return;
  }

  const decision = decideInbound(verdict, d.thresholds);
  if (decision.action === 'drop') {
    await trace('gate', stored.id, {
      outcome: 'dropped_by_jev',
      reason: decision.reason,
      verdict,
    });
    return;
  }
  if (decision.action === 'tag_move_event') {
    await d.repos.demands.create({
      userId: user.id,
      category: verdict.category,
      confidence: verdict.categoryConfidence,
      sourceMessageId: stored.id,
      isMoveEvent: true,
    });
    await trace('gate', stored.id, { outcome: 'tagged_move_event', verdict });
    return;
  }

  const open = (await d.repos.demands.findOpenByUser(user.id)).find(
    (x) => x.category === decision.category,
  );
  const ctx: MatchContext = {
    userId: user.id,
    chatId: msg.chatId,
    groupId: group?.id ?? null,
    phase,
    sourceMessageId: stored.id,
    source: { messageId: msg.messageId, userId: msg.userId },
    recentReplies: [],
    ...(open ? { demandId: open.id, demand: toDemandDraft(open) } : {}),
  };
  await trace('gate', stored.id, { outcome: 'entered_agent', decision, verdict });

  const r = await d.runInbound({ deps: d, ctx, input: msg.text });
  if (r.kind === 'interrupted') {
    const runState = await d.repos.runStates.findById(r.runStateId);
    if (runState) {
      await d.publishApproval({ repos: d.repos, cards: d.cards, runState });
    } else {
      d.logger.warn({ runStateId: r.runStateId }, 'interrupted run has no run_state row');
    }
    await trace('gate', stored.id, { outcome: 'agent_interrupted', runStateId: r.runStateId });
    return;
  }
  await trace('gate', stored.id, { outcome: 'agent_completed', toolsCalled: r.toolsCalled });
}
