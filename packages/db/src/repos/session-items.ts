import type { PrismaClient } from '../generated/client.js';

export function sessionItemsRepo(prisma: PrismaClient) {
  return {
    async list(userId: string, limit?: number): Promise<unknown[]> {
      const rows = await prisma.sessionItem.findMany({
        where: { userId },
        orderBy: { seq: 'asc' },
      });
      const items = rows.map((r) => r.item as unknown);
      return limit ? items.slice(-limit) : items;
    },
    async append(userId: string, items: unknown[], operationId?: string): Promise<void> {
      if (operationId && (await prisma.sessionItem.count({ where: { userId, operationId } })) > 0)
        return;
      const max = await prisma.sessionItem.aggregate({ where: { userId }, _max: { seq: true } });
      let seq = max._max.seq ?? 0;
      await prisma.sessionItem.createMany({
        data: items.map((item) => ({
          userId,
          seq: ++seq,
          item: item as object,
          operationId: operationId ?? null,
        })),
      });
    },
    async popLast(userId: string): Promise<unknown> {
      const last = await prisma.sessionItem.findFirst({
        where: { userId },
        orderBy: { seq: 'desc' },
      });
      if (!last) return null;
      await prisma.sessionItem.delete({ where: { id: last.id } });
      return last.item;
    },
    async clear(userId: string): Promise<void> {
      await prisma.sessionItem.deleteMany({ where: { userId } });
    },
  };
}
