import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.js';

let client: PrismaClient | undefined;

/** 进程内单例。除本包外禁止 new PrismaClient。 */
export function getPrisma(connectionString: string): PrismaClient {
  client ??= new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  await client?.$disconnect();
  client = undefined;
}
