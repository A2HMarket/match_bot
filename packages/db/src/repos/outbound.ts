import { randomUUID } from 'node:crypto';
import { outboundDraftSchema, type OutboundDraft, type OutboundKind } from '@matchbot/domain';
import { z } from 'zod';
import { Prisma, type OutboundMessage, type PrismaClient } from '../generated/client.js';

const fence = z.object({
  id: z.string().min(1),
  leaseToken: z.string().min(1).max(100),
  now: z.date().optional(),
});
const receipt = fence.extend({
  externalMessageId: z
    .string()
    .regex(/^[1-9]\d{0,29}$/)
    .nullable(),
});
const failure = fence.extend({
  deliveryState: z.enum(['not_sent', 'unknown']),
  errorCode: z.string().regex(/^[a-z0-9_]{1,80}$/),
  retryAt: z.date().optional(),
});
const MAX_ATTEMPTS = 3;
async function trace(
  tx: Prisma.TransactionClient,
  p: { id: string; phase: number; decision: string; attemptCount?: number },
) {
  await tx.decisionTrace.create({
    data: {
      kind: 'gate',
      inputRef: p.id,
      phase: p.phase === 1 || p.phase === 2 ? p.phase : 0,
      latencyMs: 0,
      costMicro: 0,
      output: {
        gate: 'outbound_delivery',
        decision: p.decision,
        ...(p.attemptCount !== undefined ? { attemptCount: p.attemptCount } : {}),
      },
    },
  });
}
export function outboundRepo(prisma: PrismaClient) {
  // Reuse an existing transaction boundary in repositories and rollback integration tests.
  const atomic = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
    typeof prisma.$transaction === 'function' ? prisma.$transaction(fn) : fn(prisma);
  return {
    create(raw: OutboundDraft, status: 'dry_run' | 'pending'): Promise<OutboundMessage> {
      const draft = outboundDraftSchema.parse(raw);
      return prisma.outboundMessage.create({
        data: {
          channel: draft.channel,
          target: draft.target,
          text: draft.text,
          phase: draft.phase ?? 0,
          toolCallId: draft.toolCallId ?? null,
          kind: draft.kind ?? 'recommendation',
          replyToMessageId: draft.replyToMessageId ?? null,
          mentionUserId: draft.mentionUserId ?? null,
          status,
        },
      });
    },
    async claimPending(
      limit: number,
      options: { now?: Date; leaseMs?: number } = {},
    ): Promise<OutboundMessage[]> {
      const count = z.number().int().min(1).max(100).parse(limit),
        now = options.now ?? new Date();
      const duration = z
        .number()
        .int()
        .min(1000)
        .max(300000)
        .parse(options.leaseMs ?? 60000);
      const token = randomUUID(),
        expiresAt = new Date(now.getTime() + duration);
      return atomic(async (tx) => {
        const raw: unknown = await tx.$queryRaw(Prisma.sql`
          WITH candidates AS (
            SELECT id FROM outbound_messages
            WHERE status = 'pending' AND channel = 'telegram' AND phase IN (1,2)
              AND attempt_count < ${MAX_ATTEMPTS} AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
            ORDER BY created_at,id LIMIT ${count} FOR UPDATE SKIP LOCKED
          ) UPDATE outbound_messages AS o SET status = 'sending',lease_token = ${token},lease_expires_at = ${expiresAt},
            attempt_started_at = NULL,next_attempt_at = NULL,attempt_count = attempt_count + 1
          FROM candidates WHERE o.id = candidates.id RETURNING o.id
        `);
        const ids = z
          .array(z.object({ id: z.string() }))
          .parse(raw)
          .map((row) => row.id);
        const rows = await tx.outboundMessage.findMany({
          where: { id: { in: ids }, status: 'sending', leaseToken: token },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        for (const row of rows)
          await trace(tx, {
            id: row.id,
            phase: row.phase,
            decision: 'claimed',
            attemptCount: row.attemptCount,
          });
        return rows;
      });
    },
    async beginSend(raw: z.input<typeof fence>): Promise<boolean> {
      const p = fence.parse(raw),
        now = p.now ?? new Date();
      return atomic(async (tx) => {
        const row = await tx.outboundMessage.findUnique({ where: { id: p.id } });
        const result = await tx.outboundMessage.updateMany({
          where: {
            id: p.id,
            leaseToken: p.leaseToken,
            status: 'sending',
            phase: { in: [1, 2] },
            leaseExpiresAt: { gt: now },
            attemptStartedAt: null,
          },
          data: { attemptStartedAt: now },
        });
        await trace(tx, {
          id: p.id,
          phase: row?.phase ?? 0,
          decision: result.count ? 'send_started' : 'start_fence_rejected',
        });
        return result.count === 1;
      });
    },
    async markSent(raw: z.input<typeof receipt>): Promise<boolean> {
      const p = receipt.parse(raw),
        now = p.now ?? new Date();
      return atomic(async (tx) => {
        const row = await tx.outboundMessage.findUnique({ where: { id: p.id } });
        if (
          row?.status === 'sent' &&
          row.leaseToken === p.leaseToken &&
          row.externalMessageId === p.externalMessageId
        ) {
          await trace(tx, { id: row.id, phase: row.phase, decision: 'receipt_replayed' });
          return true;
        }
        if (
          !row ||
          (row.kind !== 'reaction' && p.externalMessageId === null) ||
          (row.kind === 'reaction' && p.externalMessageId !== null)
        ) {
          await trace(tx, { id: p.id, phase: row?.phase ?? 0, decision: 'invalid_receipt' });
          return false;
        }
        const result = await tx.outboundMessage.updateMany({
          where: {
            id: p.id,
            leaseToken: p.leaseToken,
            status: { in: ['sending', 'delivery_unknown'] },
            phase: { in: [1, 2] },
            attemptStartedAt: { not: null },
          },
          data: {
            status: 'sent',
            sentAt: now,
            externalMessageId: p.externalMessageId,
            error: null,
            leaseExpiresAt: null,
          },
        });
        await trace(tx, {
          id: p.id,
          phase: row.phase,
          decision: result.count ? 'receipt_recorded' : 'receipt_fence_rejected',
        });
        return result.count === 1;
      });
    },
    async markFailed(raw: z.input<typeof failure>): Promise<boolean> {
      const p = failure.parse(raw),
        now = p.now ?? new Date();
      return atomic(async (tx) => {
        const row = await tx.outboundMessage.findUnique({ where: { id: p.id } });
        const canRetry =
          p.deliveryState === 'not_sent' &&
          p.retryAt !== undefined &&
          p.retryAt > now &&
          (row?.attemptCount ?? MAX_ATTEMPTS) < MAX_ATTEMPTS;
        const status =
          p.deliveryState === 'unknown' ? 'delivery_unknown' : canRetry ? 'pending' : 'failed';
        const result = await tx.outboundMessage.updateMany({
          where: {
            id: p.id,
            leaseToken: p.leaseToken,
            status: { in: ['sending', 'delivery_unknown'] },
          },
          data: {
            status,
            error: p.errorCode,
            nextAttemptAt: canRetry ? p.retryAt! : null,
            ...(canRetry ? { leaseToken: null, leaseExpiresAt: null, attemptStartedAt: null } : {}),
          },
        });
        await trace(tx, {
          id: p.id,
          phase: row?.phase ?? 0,
          decision: result.count ? status : 'failure_fence_rejected',
        });
        return result.count === 1;
      });
    },
    async recoverExpiredClaims(now: Date = new Date()) {
      return atomic(async (tx) => {
        const rows = await tx.outboundMessage.findMany({
          where: { status: 'sending', leaseExpiresAt: { lte: now } },
          take: 100,
          orderBy: { leaseExpiresAt: 'asc' },
        });
        const totals = { requeued: 0, unknown: 0, failed: 0 };
        for (const row of rows) {
          const status = row.attemptStartedAt
            ? 'delivery_unknown'
            : row.attemptCount >= MAX_ATTEMPTS
              ? 'failed'
              : 'pending';
          const changed = await tx.outboundMessage.updateMany({
            where: {
              id: row.id,
              status: 'sending',
              leaseToken: row.leaseToken,
              leaseExpiresAt: { lte: now },
              attemptStartedAt: row.attemptStartedAt,
            },
            data: {
              status,
              error:
                status === 'delivery_unknown'
                  ? 'send_receipt_missing'
                  : status === 'failed'
                    ? 'retry_budget_exhausted'
                    : null,
              ...(status === 'pending'
                ? { leaseToken: null, leaseExpiresAt: null, nextAttemptAt: now }
                : {}),
            },
          });
          if (!changed.count) continue;
          if (status === 'pending') totals.requeued++;
          else if (status === 'delivery_unknown') totals.unknown++;
          else totals.failed++;
          await trace(tx, { id: row.id, phase: row.phase, decision: 'expired_' + status });
        }
        return totals;
      });
    },
    async redactDeliveryReceiptsBefore(before: Date): Promise<number> {
      const result = await prisma.outboundMessage.updateMany({
        where: {
          AND: [
            { OR: [{ externalMessageId: { not: null } }, { leaseToken: { not: null } }] },
            {
              OR: [
                { status: 'sent', sentAt: { lt: before } },
                {
                  status: { in: ['failed', 'delivery_unknown'] },
                  attemptStartedAt: { lt: before },
                },
                {
                  status: { in: ['failed', 'delivery_unknown'] },
                  attemptStartedAt: null,
                  createdAt: { lt: before },
                },
              ],
            },
          ],
        },
        data: { externalMessageId: null, leaseToken: null },
      });
      return result.count;
    },
    countSentToTargetSince(target: string, since: Date, kind?: OutboundKind): Promise<number> {
      return prisma.outboundMessage.count({
        where: { target, status: 'sent', sentAt: { gte: since }, ...(kind ? { kind } : {}) },
      });
    },
  };
}
