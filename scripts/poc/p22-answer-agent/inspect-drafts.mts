/** Inspect only frozen synthetic cases; never export other conversations. */
import { loadEnv } from '../../../packages/shared/src/index.js';
import { getPrisma, disconnectPrisma } from '../../../packages/db/src/index.js';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
const cases = z
  .object({ cases: z.array(z.object({ id: z.string(), query: z.string() })) })
  .parse(JSON.parse(readFileSync('scripts/poc/p21-london-ab/cases.json', 'utf8'))).cases;
const db = getPrisma(loadEnv().DATABASE_URL);
const timer = setTimeout(() => process.exit(2), 15000);
try {
  for (const c of cases.filter((x) => process.argv.slice(2).includes(x.id))) {
    const m = await db.message.findFirst({
      where: {
        text: c.query,
        receivedAt: { gte: new Date('2026-10-12T07:00:00Z') },
        group: { externalId: '-5522461480' },
      },
      orderBy: { receivedAt: 'desc' },
    });
    if (!m) continue;
    const t = await db.decisionTrace.findFirst({
      where: {
        inputRef: m.id,
        kind: 'gate',
        output: { path: ['outcome'], equals: 'agent_completed' },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!t) continue;
    const items = await db.sessionItem.findMany({
      where: { userId: m.userId, createdAt: { gte: m.receivedAt, lte: t.createdAt } },
      orderBy: { seq: 'asc' },
      select: { item: true },
    });
    const parsed = items.map((i) => i.item as Record<string, unknown>);
    const turnStart = parsed.findLastIndex(
      (i) =>
        i.role === 'user' &&
        (i.content === c.query ||
          (Array.isArray(i.content) &&
            i.content.some(
              (part: unknown) =>
                part !== null &&
                typeof part === 'object' &&
                'text' in part &&
                part.text === c.query,
            ))),
    );
    const calls =
      turnStart < 0 ? [] : parsed.slice(turnStart + 1).filter((i) => i.name === 'reply_to_request');
    process.stdout.write(
      JSON.stringify({ case: c.id, calls }).replace(
        /(?:\+?(?:44|86)[\d ()-]{8,}\d|\b0\d[\d ()-]{7,}\d\b)/g,
        '[contact hidden]',
      ) + '\n',
    );
  }
} finally {
  await disconnectPrisma();
  clearTimeout(timer);
}
