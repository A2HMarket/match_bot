import { hashText } from '@matchbot/shared';
import type { Message, PrismaClient } from '../generated/client.js';

export function messagesRepo(prisma: PrismaClient) {
  return {
    create(p: { groupId: string | null; userId: string; externalId: string; text: string; lang?: string; receivedAt: Date }): Promise<Message> {
      return prisma.message.create({
        data: { groupId: p.groupId, userId: p.userId, externalId: p.externalId, text: p.text, textHash: hashText(p.text), lang: p.lang ?? null, receivedAt: p.receivedAt },
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
