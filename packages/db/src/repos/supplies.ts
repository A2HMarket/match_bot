import type { DemandCategory, SupplyDraft } from '@matchbot/domain';
import type { PrismaClient, Supply } from '../generated/client.js';

export function suppliesRepo(prisma: PrismaClient) {
  return {
    create(p: SupplyDraft & { userId: string; groupId: string; sourceMessageId: string }): Promise<Supply> {
      return prisma.supply.create({ data: { userId: p.userId, groupId: p.groupId, category: p.category, availability: p.availability, area: p.area, expiresAt: new Date(p.expiresAt), sourceMessageId: p.sourceMessageId } });
    },
    findActive(category: DemandCategory): Promise<Supply[]> {
      return prisma.supply.findMany({ where: { category, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
    },
  };
}
