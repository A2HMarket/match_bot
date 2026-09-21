import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';

export interface ApprovalCard {
  runStateId: string;
  title: string;
  draftText: string;
  supplierLines: string[];
  confidence: number;
}
export const DECISIONS = ['approve', 'reject', 'ignore'] as const;
export type Decision = (typeof DECISIONS)[number];

/** Phase 1 审批台就是运营群里的一张卡（架构 §8.4）。「改文案」走人工旁路，不做按钮。 */
export function renderApprovalCard(c: ApprovalCard): { text: string; keyboard: InlineKeyboard } {
  const text = [
    `🔎 ${c.title}`,
    '',
    '拟发：',
    c.draftText,
    '',
    '候选：',
    ...c.supplierLines,
    '',
    `置信度 ${c.confidence.toFixed(2)}`,
  ].join('\n');
  const keyboard = new InlineKeyboard()
    .text('✅ 批准', `apv:${c.runStateId}:approve`)
    .text('❌ 拒绝', `apv:${c.runStateId}:reject`)
    .text('⏭ 忽略', `apv:${c.runStateId}:ignore`);
  return { text, keyboard };
}

export function createOpsCardSender(p: { bot: Bot; opsChatId: string }) {
  return {
    async sendApprovalCard(card: ApprovalCard): Promise<{ messageId: string }> {
      const { text, keyboard } = renderApprovalCard(card);
      const r = await p.bot.api.sendMessage(Number(p.opsChatId), text, { reply_markup: keyboard });
      return { messageId: String(r.message_id) };
    },
  };
}

export function parseApprovalCallback(
  data: string,
): { runStateId: string; decision: Decision } | null {
  const m = /^apv:([A-Za-z0-9_-]+):(approve|reject|ignore)$/.exec(data);
  if (!m?.[1] || !m[2]) return null;
  return { runStateId: m[1], decision: m[2] as Decision };
}
