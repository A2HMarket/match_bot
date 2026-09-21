import type { DemandCategory } from '@matchbot/domain';
import type { PrismaClient, Supplier } from '../generated/client.js';

export function suppliersRepo(prisma: PrismaClient) {
  return {
    findCandidates(p: { category: DemandCategory; pool?: 'A' | 'B' }): Promise<Supplier[]> {
      return prisma.supplier.findMany({
        where: { category: p.category, ...(p.pool ? { pool: p.pool } : {}) },
        orderBy: [{ pool: 'asc' }, { rating: 'desc' }],
      });
    },
    findByIds(ids: string[]): Promise<Supplier[]> {
      return prisma.supplier.findMany({ where: { id: { in: ids } } });
    },
  };
}
