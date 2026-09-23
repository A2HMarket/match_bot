import { handleApprovalCallback as defaultHandle } from '@matchbot/approval';
import { parseApprovalCallback } from '@matchbot/channel-telegram';
import type { Repositories } from '@matchbot/db';
import type { Queues } from '@matchbot/queue';
import type { Logger } from '@matchbot/shared';

export type ApprovalOutcome =
  'approved' | 'rejected' | 'ignored' | 'stale' | 'forbidden' | 'invalid';

const TOAST: Record<ApprovalOutcome, string> = {
  approved: '已批准，正在发送',
  rejected: '已拒绝',
  ignored: '已忽略',
  stale: '这张卡已经处理过或已过期',
  forbidden: '只能在运营群里审批',
  invalid: '无法识别的按钮',
};

/** 卡片处理完后追加到原文末尾的一行，让群里其他运营看到谁做了什么。 */
const STAMP: Partial<Record<ApprovalOutcome, string>> = {
  approved: '✅ 已批准',
  rejected: '❌ 已拒绝',
  ignored: '⏭ 已忽略',
  stale: '⌛ 已失效',
};

/**
 * 运营群审批卡的按钮回调（架构 §8.4）。只做「来源校验 + 翻译结果」，
 * 快照原子消费与入队 resume 由 @matchbot/approval 负责（AGENTS.md §3.3 第 6 条）。
 */
export function createApprovalCallbackHandler(p: {
  repos: Repositories;
  queues: Queues;
  opsChatId: string;
  logger: Logger;
  handle?: typeof defaultHandle;
}) {
  const handle = p.handle ?? defaultHandle;
  return async (q: {
    data: string;
    chatId: number | undefined;
    reviewer: string;
  }): Promise<{ outcome: ApprovalOutcome; toast: string; stamp: string | null }> => {
    const done = (outcome: ApprovalOutcome) => ({
      outcome,
      toast: TOAST[outcome],
      stamp: STAMP[outcome] ? `${STAMP[outcome]} · ${q.reviewer}` : null,
    });
    const parsed = parseApprovalCallback(q.data);
    if (!parsed) return done('invalid');
    // 卡只发在运营群；别处来的回调（被转发的卡等）一律不认，避免群外的人替运营做决定
    if (q.chatId === undefined || String(q.chatId) !== p.opsChatId) {
      p.logger.warn(
        { chatId: q.chatId, runStateId: parsed.runStateId },
        'approval from non-ops chat',
      );
      return done('forbidden');
    }
    const r = await handle({
      repos: p.repos,
      queues: p.queues,
      reviewer: q.reviewer,
      data: q.data,
    });
    // handle 对「运营点了忽略」和「快照已被消费」都返回 ignored，靠按钮本身区分
    const outcome: ApprovalOutcome =
      r === 'invalid'
        ? 'invalid'
        : r === 'queued'
          ? parsed.decision === 'approve'
            ? 'approved'
            : 'rejected'
          : parsed.decision === 'ignore'
            ? 'ignored'
            : 'stale';
    p.logger.info({ runStateId: parsed.runStateId, outcome }, 'approval callback');
    return done(outcome);
  };
}
