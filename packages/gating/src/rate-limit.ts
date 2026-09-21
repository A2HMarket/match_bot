import type { Repositories } from '@matchbot/db';

/** 频控按 target（群 chat id）按自然日计 sent 条数（PRD §6.2 "一个群一天三次就是广告机器人"）。 */
export function createRateLimiter(outbound: Pick<Repositories['outbound'], 'countSentToTargetSince'>) {
  return {
    async check(p: { target: string; limitPerDay: number; now: Date }): Promise<boolean> {
      const dayStart = new Date(Date.UTC(p.now.getUTCFullYear(), p.now.getUTCMonth(), p.now.getUTCDate()));
      return (await outbound.countSentToTargetSince(p.target, dayStart)) < p.limitPerDay;
    },
  };
}
