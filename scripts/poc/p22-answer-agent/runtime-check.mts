/** Local deployment checks: no credentials or snapshot bodies exported. */
import { loadEnv } from '../../../packages/shared/src/index.js';
import { getPrisma, disconnectPrisma } from '../../../packages/db/src/index.js';
import { createQueues, closeQueues } from '../../../packages/queue/src/index.js';
const env = loadEnv(),
  db = getPrisma(env.DATABASE_URL),
  q = createQueues(env.REDIS_URL);
const timer = setTimeout(() => process.exit(2), 15000);
try {
  const queues = await Promise.all(
    [q.inbound, q.resume, q.outbound].map(async (x) => ({
      name: x.name,
      counts: await x.getJobCounts('active', 'waiting', 'delayed', 'failed'),
    })),
  );
  const pending = await db.runState.findMany({
    where: { status: 'pending' },
    select: { id: true, agentVersion: true, phase: true },
  });
  if (process.argv.includes('--expire-old')) {
    if (queues.some((x) => x.counts.active || x.counts.waiting || x.counts.delayed))
      throw new Error('Queues busy; do not expire snapshots or restart');
    for (const s of pending.filter((x) => x.agentVersion !== '0.14.2')) {
      await db.$transaction(async (tx) => {
        const changed = await tx.runState.updateMany({
          where: { id: s.id, status: 'pending' },
          data: { status: 'expired' },
        });
        if (changed.count)
          await tx.decisionTrace.create({
            data: {
              kind: 'rule',
              inputRef: s.id,
              phase: s.phase,
              latencyMs: 0,
              costMicro: 0,
              output: {
                outcome: 'snapshot_expired',
                reason: 'agent_version_changed',
                previousVersion: s.agentVersion,
                nextVersion: '0.14.2',
              },
            },
          });
      });
    }
  }
  process.stdout.write(
    JSON.stringify({
      queues,
      pending: pending.map((s) => ({ agentVersion: s.agentVersion, phase: s.phase })),
      agentVersion: '0.14.2',
    }) + '\n',
  );
} finally {
  await closeQueues(q);
  await disconnectPrisma();
  clearTimeout(timer);
}
