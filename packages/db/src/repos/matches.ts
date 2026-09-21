import type { Match, PrismaClient } from '../generated/client.js';

export function matchesRepo(prisma: PrismaClient) {
  return {
    async replaceForDemand(
      demandId: string,
      rows: Array<{
        supplierId?: string;
        supplyId?: string;
        matcherScore: number;
        jevFit?: number;
        rank: number;
      }>,
    ): Promise<Match[]> {
      await prisma.match.deleteMany({ where: { demandId } });
      const out: Match[] = [];
      for (const r of rows)
        out.push(
          await prisma.match.create({
            data: {
              demandId,
              supplierId: r.supplierId ?? null,
              supplyId: r.supplyId ?? null,
              matcherScore: r.matcherScore,
              jevFit: r.jevFit ?? null,
              rank: r.rank,
            },
          }),
        );
      return out;
    },
  };
}
