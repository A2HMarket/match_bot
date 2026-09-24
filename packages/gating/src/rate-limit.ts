import type { Repositories } from '@matchbot/db';

/**
 * 频控按 target（群 chat id）按自然日（UTC）计**推荐**的 sent 条数（PRD §6.2
 * "一个群一天三次就是广告机器人"）。追问、私聊通知不计：它们是在回应某个人，
 * 算进来的话一问一答就吃掉两格额度，一个群一天只够服务一个人。
 */
export function createRateLimiter(
  outbound: Pick<Repositories['outbound'], 'countSentToTargetSince'>,
) {
  return {
    async check(p: { target: string; limitPerDay: number; now: Date }): Promise<boolean> {
      const dayStart = new Date(
        Date.UTC(p.now.getUTCFullYear(), p.now.getUTCMonth(), p.now.getUTCDate()),
      );
      const sent = await outbound.countSentToTargetSince(p.target, dayStart, 'recommendation');
      return sent < p.limitPerDay;
    },
  };
}
