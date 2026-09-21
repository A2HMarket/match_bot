import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/client.js';

const url = process.env.DATABASE_URL ?? 'postgresql://matchbot:matchbot@localhost:5432/matchbot';
export const testPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

/** 每个用例在事务里执行，最后抛出哨兵错误回滚，保证用例互不污染。 */
class Rollback extends Error {}
export async function withTestDb(fn: (tx: PrismaClient) => Promise<void>): Promise<void> {
  try {
    await testPrisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaClient);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}
