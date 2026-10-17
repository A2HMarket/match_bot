import { createRepositories } from '../../src/repos/index.js';
import { getPrisma, disconnectPrisma } from '../../src/client.js';

/** Dedicated committed fixtures for process crash proofs; ordinary integration tests still roll back. */
export function createDeliveryProofStore() {
  const prisma = getPrisma('postgresql://matchbot:matchbot@127.0.0.1:5432/matchbot_delivery_proof');
  const repos = createRepositories(prisma);
  return {
    repos,
    seed: (text: string) =>
      repos.outbound.create(
        { channel: 'telegram', target: '-999900000001', text, phase: 2 },
        'pending',
      ),
    row: (id: string) => prisma.outboundMessage.findUniqueOrThrow({ where: { id } }),
    liveCount: () =>
      prisma.outboundMessage.count({ where: { status: { in: ['pending', 'sending'] } } }),
    async remove(ids: string[]) {
      await prisma.decisionTrace.deleteMany({ where: { inputRef: { in: ids } } });
      await prisma.outboundMessage.deleteMany({ where: { id: { in: ids } } });
    },
    close: disconnectPrisma,
  };
}
