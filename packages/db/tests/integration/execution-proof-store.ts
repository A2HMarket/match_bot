import { createRepositories } from '../../src/repos/index.js';
import { getPrisma, disconnectPrisma } from '../../src/client.js';
import type { PrismaClient } from '../../src/generated/client.js';

export function createExecutionProofStore() {
  const prisma = getPrisma('postgresql://matchbot:matchbot@127.0.0.1:5432/matchbot_delivery_proof');
  const repos = createRepositories(prisma);
  return {
    repos,
    async seed(phase: 0 | 1 | 2 = 0) {
      if (await prisma.message.count())
        throw new Error('proof database already contains message fixtures');
      const user = await repos.users.upsertByExternal({
        channel: 'telegram',
        externalId: '999900000002',
      });
      const group = await repos.groups.upsert({
        channel: 'telegram',
        externalId: '-999900000001',
        name: 'synthetic execution proof',
      });
      await prisma.group.update({ where: { id: group.id }, data: { isActive: true, phase } });
      return { user, group };
    },
    async probeDecisionRollback(runStateId: string) {
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            "CREATE FUNCTION pg_temp.fail_approval_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected approval insert failure'; END $$",
          );
          await tx.$executeRawUnsafe(
            'CREATE TRIGGER synthetic_approval_insert_failure BEFORE INSERT ON approvals FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_approval_insert()',
          );
          await createRepositories(tx as PrismaClient).approvals.decide({
            runStateId,
            reviewer: 'synthetic',
            decision: 'approve',
          });
        });
        throw new Error('fault injection was not exercised');
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes('injected approval insert failure')
        )
          throw error;
      }
      return {
        runState: await prisma.runState.findUniqueOrThrow({ where: { id: runStateId } }),
        approvals: await prisma.approval.count({ where: { runStateId } }),
      };
    },
    async state() {
      const message = await prisma.message.findFirst({ include: { user: true } });
      return {
        message,
        tasks: await prisma.task.count(),
        turnEvents: await prisma.taskEvent.count({ where: { kind: 'user_turn' } }),
        outbounds: await prisma.outboundMessage.findMany(),
        sessions: await prisma.sessionItem.count(),
        runStates: await prisma.runState.findMany(),
        approvals: await prisma.approval.findMany(),
      };
    },
    async cleanup() {
      const users = await prisma.user.findMany({ where: { externalId: '999900000002' } });
      const ids = users.map((u) => u.id),
        messages = await prisma.message.findMany({ where: { userId: { in: ids } } });
      const runStates = await prisma.runState.findMany({ where: { userId: { in: ids } } });
      await prisma.decisionTrace.deleteMany({
        where: { inputRef: { in: [...messages.map((m) => m.id), ...runStates.map((r) => r.id)] } },
      });
      await prisma.outboundMessage.deleteMany({
        where: { sourceMessageId: { in: messages.map((m) => m.id) } },
      });
      await prisma.sessionItem.deleteMany({ where: { userId: { in: ids } } });
      await prisma.approval.deleteMany({
        where: { runStateId: { in: runStates.map((r) => r.id) } },
      });
      await prisma.runState.deleteMany({ where: { id: { in: runStates.map((r) => r.id) } } });
      await prisma.task.deleteMany({ where: { userId: { in: ids } } });
      await prisma.message.deleteMany({ where: { userId: { in: ids } } });
      await prisma.group.deleteMany({ where: { externalId: '-999900000001' } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    },
    close: disconnectPrisma,
  };
}
