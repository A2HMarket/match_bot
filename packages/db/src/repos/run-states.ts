import type { Phase } from '@matchbot/domain';
import type { PrismaClient, RunState } from '../generated/client.js';
import { inTransaction } from '../execution-fence.js';

export function runStatesRepo(prisma: PrismaClient) {
  return {
    async create(p: {
      userId: string;
      chatId: string;
      phase: Phase;
      messageId?: string;
      task?: { id: string; requirementsVersion: number };
      snapshot: string;
      agentVersion: string;
      sdkVersion: string;
      interruptions: unknown;
      expiresAt: Date;
    }): Promise<RunState> {
      return inTransaction(prisma, async (tx) => {
        const { task, ...data } = p;
        if (p.messageId) {
          const message = await tx.message.findFirst({
            where: { id: p.messageId, userId: p.userId },
            include: { user: true, group: true },
          });
          if (!message || (message.group?.externalId ?? message.user.externalId) !== p.chatId)
            throw new Error('approval message binding inaccessible');
          if (task) {
            const bound = await tx.task.findFirst({
              where: {
                id: task.id,
                userId: p.userId,
                channel: message.user.channel,
                chatId: p.chatId,
                requirementsVersion: task.requirementsVersion,
              },
            });
            if (!bound) throw new Error('approval task binding inaccessible or obsolete');
            await tx.message.update({
              where: { id: message.id },
              data: { taskId: bound.id, taskRequirementsVersion: bound.requirementsVersion },
            });
          }
        }
        return tx.runState.create({ data: { ...data, interruptions: p.interruptions as object } });
      });
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
