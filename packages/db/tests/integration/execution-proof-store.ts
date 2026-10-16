import { createRepositories } from '../../src/repos/index.js';
import { getPrisma, disconnectPrisma } from '../../src/client.js';

export function createExecutionProofStore() {
  const prisma = getPrisma('postgresql://matchbot:matchbot@127.0.0.1:5432/matchbot_delivery_proof');
  const repos = createRepositories(prisma);
  return {
    repos,
    async seed() {
      if (await prisma.message.count())
        throw new Error('proof database already contains message fixtures');
      const user = await repos.users.upsertByExternal({
        channel: 'telegram',
        externalId: '999900000002',
      });
      const group = await repos.groups.upsert({
        channel: 'telegram',
        externalId: '-999900000001',
        name: 'synthetic execution proof',
      });
      await prisma.group.update({ where: { id: group.id }, data: { isActive: true, phase: 0 } });
      return { user, group };
    },
    async state() {
      const message = await prisma.message.findFirst({ include: { user: true } });
      return {
        message,
        tasks: await prisma.task.count(),
        turnEvents: await prisma.taskEvent.count({ where: { kind: 'user_turn' } }),
        outbounds: await prisma.outboundMessage.findMany(),
        sessions: await prisma.sessionItem.count(),
      };
    },
    async cleanup() {
      const users = await prisma.user.findMany({ where: { externalId: '999900000002' } });
      const ids = users.map((u) => u.id),
        messages = await prisma.message.findMany({ where: { userId: { in: ids } } });
      await prisma.decisionTrace.deleteMany({
        where: { inputRef: { in: messages.map((m) => m.id) } },
      });
      await prisma.outboundMessage.deleteMany({
        where: { sourceMessageId: { in: messages.map((m) => m.id) } },
      });
      await prisma.sessionItem.deleteMany({ where: { userId: { in: ids } } });
      await prisma.task.deleteMany({ where: { userId: { in: ids } } });
      await prisma.message.deleteMany({ where: { userId: { in: ids } } });
      await prisma.group.deleteMany({ where: { externalId: '-999900000001' } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    },
    close: disconnectPrisma,
  };
}
