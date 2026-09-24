import { hashText } from '@matchbot/shared';
import type { Message, PrismaClient } from '../generated/client.js';

export function messagesRepo(prisma: PrismaClient) {
  return {
    /**
     * 同一条渠道消息是否已落过库。私聊 groupId 为空，Postgres 的 unique 不把两个 NULL
     * 视为重复，所以私聊按 userId 查——队列重投时靠它识别，而不是靠 unique 碰运气。
     */
    findExisting(p: {
      groupId: string | null;
      userId: string;
      externalId: string;
    }): Promise<Message | null> {
      return prisma.message.findFirst({
        where: p.groupId
          ? { groupId: p.groupId, externalId: p.externalId }
          : { groupId: null, userId: p.userId, externalId: p.externalId },
      });
    },
    create(p: {
      groupId: string | null;
      userId: string;
      externalId: string;
      text: string;
      lang?: string;
      receivedAt: Date;
    }): Promise<Message> {
      return prisma.message.create({
        data: {
          groupId: p.groupId,
          userId: p.userId,
          externalId: p.externalId,
          text: p.text,
          textHash: hashText(p.text),
          lang: p.lang ?? null,
          receivedAt: p.receivedAt,
        },
      });
    },
    recentByUser(userId: string, sinceHours: number): Promise<Message[]> {
      return prisma.message.findMany({
        where: { userId, receivedAt: { gte: new Date(Date.now() - sinceHours * 3600e3) } },
        orderBy: { receivedAt: 'desc' },
        take: 50,
      });
    },
    async redactOlderThan(days: number): Promise<number> {
      const r = await prisma.message.updateMany({
        where: { receivedAt: { lt: new Date(Date.now() - days * 86400e3) }, NOT: { text: '' } },
        data: { text: '' },
      });
      return r.count;
    },
  };
}
