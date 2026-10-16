import type { Phase } from '@matchbot/domain';
import type { PrismaClient, RunState } from '../generated/client.js';

export function runStatesRepo(prisma: PrismaClient) {
  return {
    create(p: {
      userId: string;
      chatId: string;
      phase: Phase;
      messageId?: string;
      snapshot: string;
      agentVersion: string;
      sdkVersion: string;
      interruptions: unknown;
      expiresAt: Date;
    }): Promise<RunState> {
      return prisma.runState.create({ data: { ...p, interruptions: p.interruptions as object } });
    },
    /** 原子消费：条件更新 0 行即已被别人恢复过（AGENTS.md §3.3 第 6 条）。 */
    async consume(id: string): Promise<RunState | null> {
      const r = await prisma.runState.updateMany({
        where: { id, status: 'pending' },
        data: { status: 'consumed', consumedAt: new Date() },
      });
      if (r.count === 0) return null;
      return prisma.runState.findUnique({ where: { id } });
    },
    async expireOld(now: Date): Promise<number> {
      const r = await prisma.runState.updateMany({
        where: { status: 'pending', expiresAt: { lt: now } },
        data: { status: 'expired' },
      });
      return r.count;
    },
    findById(id: string): Promise<RunState | null> {
      return prisma.runState.findUnique({ where: { id } });
    },
  };
}
