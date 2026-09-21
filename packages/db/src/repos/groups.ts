import type { Channel, Group, PrismaClient } from '../generated/client.js';

export function groupsRepo(prisma: PrismaClient) {
  return {
    findByExternal(channel: Channel, externalId: string): Promise<Group | null> {
      return prisma.group.findUnique({ where: { channel_externalId: { channel, externalId } } });
    },
    upsert(p: { channel: Channel; externalId: string; name: string }): Promise<Group> {
      return prisma.group.upsert({
        where: { channel_externalId: { channel: p.channel, externalId: p.externalId } },
        create: {
          channel: p.channel,
          externalId: p.externalId,
          name: p.name,
          categoriesEnabled: [],
        },
        update: { name: p.name },
      });
    },
  };
}
