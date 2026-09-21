import { transition, type DemandDraft, type DemandStatus } from '@matchbot/domain';
import type { Demand, PrismaClient } from '../generated/client.js';

function draftToData(d: Partial<DemandDraft>) {
  return {
    whenText: d.whenText,
    whenAt: d.whenAt ? new Date(d.whenAt) : undefined,
    fromPostcode: d.fromPostcode,
    toPostcode: d.toPostcode,
    quantity: d.quantity,
    budgetPence: d.budgetPence,
    lang: d.lang,
    confidence: d.confidence,
  };
}

export function demandsRepo(prisma: PrismaClient) {
  return {
    findOpenByUser(userId: string): Promise<Demand[]> {
      return prisma.demand.findMany({ where: { userId, status: { in: ['open', 'clarifying', 'matched'] } }, orderBy: { updatedAt: 'desc' } });
    },
    create(p: DemandDraft & { userId: string; sourceMessageId: string; isMoveEvent?: boolean }): Promise<Demand> {
      return prisma.demand.create({
        data: { ...draftToData(p), userId: p.userId, category: p.category, confidence: p.confidence, isMoveEvent: p.isMoveEvent ?? false, sourceMessageIds: [p.sourceMessageId] },
      });
    },
    async update(id: string, patch: Partial<DemandDraft> & { sourceMessageId?: string }): Promise<Demand> {
      const current = await prisma.demand.findUniqueOrThrow({ where: { id } });
      const ids = patch.sourceMessageId && !current.sourceMessageIds.includes(patch.sourceMessageId) ? [...current.sourceMessageIds, patch.sourceMessageId] : current.sourceMessageIds;
      return prisma.demand.update({ where: { id }, data: { ...draftToData(patch), category: patch.category, sourceMessageIds: ids } });
    },
    async setStatus(id: string, status: DemandStatus): Promise<Demand> {
      const current = await prisma.demand.findUniqueOrThrow({ where: { id } });
      transition(current.status, status); // 非法转移抛 IllegalTransitionError
      return prisma.demand.update({ where: { id }, data: { status } });
    },
    async expireOlderThan(days: number): Promise<number> {
      const r = await prisma.demand.updateMany({
        where: { status: { in: ['open', 'clarifying'] }, updatedAt: { lt: new Date(Date.now() - days * 86400e3) } },
        data: { status: 'expired' },
      });
      return r.count;
    },
  };
}
