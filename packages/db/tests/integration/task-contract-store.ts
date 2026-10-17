import { createRepositories } from '../../src/repos/index.js';
import type { PrismaClient } from '../../src/generated/client.js';

export async function createTaskContractStore(tx: PrismaClient) {
  const repos = createRepositories(tx),
    users = new Map<string, Awaited<ReturnType<typeof repos.users.upsertByExternal>>>(),
    groups = new Map<string, Awaited<ReturnType<typeof repos.groups.upsert>>>();
  for (const [index, key] of ['owner', 'user-a', 'user-b'].entries())
    users.set(
      key,
      await repos.users.upsertByExternal({
        channel: 'telegram',
        externalId: String(9899000000 + index),
      }),
    );
  for (const [index, key] of ['group', 'unrelated-group'].entries()) {
    const row = await repos.groups.upsert({
      channel: 'telegram',
      externalId: String(-9899000000 - index),
      name: 'synthetic task contract ' + key,
    });
    await tx.group.update({ where: { id: row.id }, data: { phase: 2, isActive: true } });
    groups.set(key, row);
  }
  return {
    repos,
    user: (key: string) => {
      const row = users.get(key);
      if (!row) throw new Error('unknown synthetic owner');
      return row;
    },
    group: (key: string) => {
      const row = groups.get(key);
      if (!row) throw new Error('unknown synthetic group');
      return row;
    },
    outbounds: (messageId: string) =>
      tx.outboundMessage.findMany({
        where: { sourceMessageId: messageId, approvalRunStateId: null },
        orderBy: { createdAt: 'asc' },
      }),
  };
}
