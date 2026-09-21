import type { Channel, Lead, PrismaClient } from '../generated/client.js';

export function leadsRepo(prisma: PrismaClient) {
  return {
    create(p: { matchId: string; sentVia: Channel; sentAt: Date }): Promise<Lead> {
      return prisma.lead.create({ data: p });
    },
    update(id: string, patch: { supplierResponse?: string; isConverted?: boolean; isPaid?: boolean; followedUpAt?: Date }): Promise<Lead> {
      return prisma.lead.update({ where: { id }, data: patch });
    },
  };
}
