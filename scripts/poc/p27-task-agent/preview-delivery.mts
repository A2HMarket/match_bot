import type { getPrisma } from '../../../packages/db/src/index.js';
/** Other preview processes may claim our row. Observe its receipt, never resend or mark it sent here. */
export async function waitForPreviewOutbounds(p: {
  prisma: ReturnType<typeof getPrisma>;
  sourceMessageId: string;
  timeoutMs?: number;
}) {
  const until = Date.now() + (p.timeoutMs ?? 5000);
  for (;;) {
    const rows = await p.prisma.outboundMessage.findMany({
      where: { sourceMessageId: p.sourceMessageId, approvalRunStateId: null },
      orderBy: { createdAt: 'asc' },
    });
    if (
      !rows.some((row) => row.status === 'pending' || row.status === 'sending') ||
      Date.now() >= until
    )
      return rows;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}
