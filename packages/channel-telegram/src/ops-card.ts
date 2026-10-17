import { InlineKeyboard } from 'grammy';
import { z } from 'zod';

export interface ApprovalCard {
  runStateId: string;
  title: string;
  draftText: string;
  supplierLines: string[];
  confidence: number;
}
export const DECISIONS = ['approve', 'reject', 'ignore'] as const;
export type Decision = (typeof DECISIONS)[number];

/** Keep the reviewed body intact when a reviewer stamp would exceed Telegram's text limit. */
export function stampApprovalCardText(text: string, stamp: string): string {
  const combined = text + '\n\n' + stamp;
  return combined.length <= 4096 ? combined : text;
}

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
  const keyboard = approvalKeyboard(c.runStateId);
  return { text, keyboard };
}

export function approvalKeyboard(raw: string): InlineKeyboard {
  const id = z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,48}$/)
    .parse(raw);
  return new InlineKeyboard()
    .text('✅ 批准', `apv:${id}:approve`)
    .text('❌ 拒绝', `apv:${id}:reject`)
    .text('⏭ 忽略', `apv:${id}:ignore`);
}

export function parseApprovalCallback(
  data: string,
): { runStateId: string; decision: Decision } | null {
  const m = /^apv:([A-Za-z0-9_-]+):(approve|reject|ignore)$/.exec(data);
  if (!m?.[1] || !m[2]) return null;
  return { runStateId: m[1], decision: m[2] as Decision };
}
