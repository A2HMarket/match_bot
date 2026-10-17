import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.js';

let client: PrismaClient | undefined;

/** Explicit independent clients keep a test outbox separate from the live read-only observer. */
export function createPrisma(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/** 进程内单例。除本包外禁止 new PrismaClient。 */
export function getPrisma(connectionString: string): PrismaClient {
  client ??= createPrisma(connectionString);
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  await client?.$disconnect();
  client = undefined;
}
