/** 只导出本轮固定模拟问题的脱敏实际回答，不导出群成员/其他会话。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { loadEnv } from '../../../packages/shared/src/index.js';
import { getPrisma, disconnectPrisma } from '../../../packages/db/src/index.js';
const cases = z
  .object({ cases: z.array(z.object({ id: z.string(), query: z.string() })) })
  .parse(JSON.parse(readFileSync('scripts/poc/p21-london-ab/cases.json', 'utf8'))).cases;
const groupExternalId = z
  .string()
  .regex(/^-\d+$/)
  .parse(process.argv[2]);
const db = getPrisma(loadEnv().DATABASE_URL);
const timer = setTimeout(() => process.exit(2), 15_000);
const redact = (text: string) =>
  text
    .replace(/(?:\+?(?:44|86)[\d ()-]{8,}\d|\b0\d[\d ()-]{7,}\d\b)/g, '[联系方式已隐藏]')
    .replace(/@[A-Za-z0-9_]{3,}/g, '[联系方式已隐藏]');
try {
  const results = [];
  for (const c of cases) {
    const m = await db.message.findFirst({
      where: {
        text: c.query,
        group: { externalId: groupExternalId },
        receivedAt: { gte: new Date('2026-10-12T03:49:00Z') },
      },
      orderBy: { receivedAt: 'desc' },
    });
    if (!m) {
      results.push({ case: c.id, state: 'not_processed' });
      continue;
    }
    const traces = await db.decisionTrace.findMany({
      where: { inputRef: m.id },
      orderBy: { createdAt: 'asc' },
    });
    const outbound = await db.outboundMessage.findMany({
      where: {
        target: groupExternalId,
        replyToMessageId: m.externalId,
        createdAt: { gte: m.receivedAt },
      },
      orderBy: { createdAt: 'asc' },
      select: { text: true, status: true, kind: true, error: true, sentAt: true },
    });
    const terminal = traces.findLast((t) =>
      [
        'agent_completed',
        'agent_failed',
        'dropped_by_jev',
        'dropped_by_rule',
        'tagged_move_event',
        'agent_interrupted',
      ].includes(String((t.output as Record<string, unknown>).outcome)),
    );
    const result = {
      case: c.id,
      query: c.query,
      state: terminal ? 'finished' : 'processing',
      receivedAt: m.receivedAt,
      queueDelayMs: m.createdAt.getTime() - m.receivedAt.getTime(),
      processingMs: terminal?.latencyMs ?? null,
      elapsedToSentMs: outbound[0]?.sentAt
        ? outbound[0].sentAt.getTime() - m.receivedAt.getTime()
        : null,
      outbound: outbound.map((row) => ({
        ...row,
        text: redact(row.text),
        error: row.error ? 'send_failed' : null,
      })),
      traces: traces
        .filter((t) => t.kind === 'gate' || t.kind === 'rule')
        .map((t) => {
          const o = t.output as Record<string, unknown>;
          return Object.fromEntries(
            Object.entries(o).filter(([k]) =>
              [
                'gate',
                'outcome',
                'decision',
                'reason',
                'tool',
                'attempt',
                'attempts',
                'toolsCalled',
                'error',
                'primaryRefs',
                'backupRefs',
                'rejectedRefs',
              ].includes(k),
            ),
          );
        }),
    };
    results.push(result);
  }
  writeFileSync('/tmp/p21-b-telegram.json', JSON.stringify(results, null, 2));
  process.stdout.write(
    JSON.stringify(
      results.map((r) => ({
        case: r.case,
        state: r.state,
        ...('outbound' in r
          ? {
              replies: r.outbound.length,
              statuses: r.outbound.map((o) => o.status),
              terminal: r.traces.at(-1),
            }
          : {}),
      })),
    ) + '\n',
  );
} finally {
  await disconnectPrisma();
  clearTimeout(timer);
}
