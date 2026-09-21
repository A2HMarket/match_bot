import type { OutboundDraft } from '@matchbot/domain';
import type { OutboundMessage, OutboundStatus, PrismaClient } from '../generated/client.js';

export function outboundRepo(prisma: PrismaClient) {
  return {
    create(draft: OutboundDraft, status: OutboundStatus): Promise<OutboundMessage> {
      return prisma.outboundMessage.create({
        data: {
          channel: draft.channel,
          target: draft.target,
          text: draft.text,
          toolCallId: draft.toolCallId ?? null,
          status,
        },
      });
    },
    claimPending(limit: number): Promise<OutboundMessage[]> {
      return prisma.outboundMessage.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
        take: limit,
      });
    },
    async markSent(id: string): Promise<void> {
      await prisma.outboundMessage.update({
        where: { id },
        data: { status: 'sent', sentAt: new Date() },
      });
    },
    async markFailed(id: string, error: string): Promise<void> {
      await prisma.outboundMessage.update({ where: { id }, data: { status: 'failed', error } });
    },
    countSentToTargetSince(target: string, since: Date): Promise<number> {
      return prisma.outboundMessage.count({
        where: { target, status: 'sent', sentAt: { gte: since } },
      });
    },
  };
}
