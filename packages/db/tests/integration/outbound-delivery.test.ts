import { describe, expect, it } from 'vitest';
import { createRepositories } from '../../src/repos/index.js';
import { withTestDb } from './setup.js';

const now = new Date('2026-10-17T00:00:00Z');
const later = new Date('2026-10-17T00:00:10Z');
describe('outbound delivery leases', () => {
  it('redacts expired receipts by delivery time without removing fresh or active fences', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx),
        old = new Date('2026-09-01T00:00:00Z'),
        cutoff = new Date('2026-09-17T00:00:00Z');
      const a = await r.outbound.create(
        { channel: 'telegram', target: '-receipt-retention', text: 'old receipt', phase: 2 },
        'pending',
      );
      const claim = (await r.outbound.claimPending(1, { now: old }))[0]!;
      await r.outbound.beginSend({ id: a.id, leaseToken: claim.leaseToken!, now: old });
      await r.outbound.markSent({
        id: a.id,
        leaseToken: claim.leaseToken!,
        externalMessageId: '1',
        now: old,
      });
      const b = await r.outbound.create(
        { channel: 'telegram', target: '-receipt-retention', text: 'fresh receipt', phase: 2 },
        'pending',
      );
      await tx.outboundMessage.update({ where: { id: b.id }, data: { createdAt: old } });
      const fresh = (await r.outbound.claimPending(1, { now }))[0]!;
      await r.outbound.beginSend({ id: b.id, leaseToken: fresh.leaseToken!, now });
      await r.outbound.markSent({
        id: b.id,
        leaseToken: fresh.leaseToken!,
        externalMessageId: '2',
        now,
      });
      const c = await r.outbound.create(
        { channel: 'telegram', target: '-receipt-retention', text: 'active claim', phase: 2 },
        'pending',
      );
      await tx.outboundMessage.update({ where: { id: c.id }, data: { createdAt: old } });
      const active = (await r.outbound.claimPending(1, { now }))[0]!;
      expect(await r.outbound.redactDeliveryReceiptsBefore(cutoff)).toBe(1);
      expect(
        (await tx.outboundMessage.findUniqueOrThrow({ where: { id: a.id } })).externalMessageId,
      ).toBeNull();
      expect(
        (await tx.outboundMessage.findUniqueOrThrow({ where: { id: b.id } })).externalMessageId,
      ).toBe('2');
      expect((await tx.outboundMessage.findUniqueOrThrow({ where: { id: c.id } })).leaseToken).toBe(
        active.leaseToken,
      );
      expect(await r.outbound.redactDeliveryReceiptsBefore(cutoff)).toBe(0);
    });
  });
  it('atomically claims disjoint rows and excludes shadow, unclassified and non-Telegram rows', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const pending = await r.outbound.create(
        { channel: 'telegram', target: '-delivery-test', text: 'approved', phase: 2 },
        'pending',
      );
      await r.outbound.create(
        { channel: 'telegram', target: '-delivery-test', text: 'shadow', phase: 0 },
        'dry_run',
      );
      await r.outbound.create(
        { channel: 'telegram', target: '-delivery-test', text: 'legacy phase unknown' },
        'pending',
      );
      await r.outbound.create(
        { channel: 'whatsapp', target: 'not-a-telegram-chat', text: 'other channel', phase: 2 },
        'pending',
      );
      const first = await r.outbound.claimPending(1, { now, leaseMs: 5000 });
      expect(first.map((m) => m.id)).toEqual([pending.id]);
      expect(first[0]?.status).toBe('sending');
      expect(first[0]?.leaseToken).toEqual(expect.any(String));
      expect(await r.outbound.claimPending(1, { now, leaseMs: 5000 })).toEqual([]);
    });
  });
  it('requeues only expired claims that never began an external send and rejects the old fence', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      await r.outbound.create(
        { channel: 'telegram', target: '-delivery-test', text: 'approved', phase: 2 },
        'pending',
      );
      const first = (await r.outbound.claimPending(1, { now, leaseMs: 5000 }))[0]!;
      expect(await r.outbound.recoverExpiredClaims(later)).toMatchObject({
        requeued: 1,
        unknown: 0,
      });
      const second = (await r.outbound.claimPending(1, { now: later, leaseMs: 5000 }))[0]!;
      expect(second.leaseToken).not.toBe(first.leaseToken);
      expect(
        await r.outbound.beginSend({ id: first.id, leaseToken: first.leaseToken!, now: later }),
      ).toBe(false);
      expect(
        await r.outbound.beginSend({ id: second.id, leaseToken: second.leaseToken!, now: later }),
      ).toBe(true);
    });
  });
  it('never reclaims a potentially accepted send, but can record a late authoritative receipt', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      await r.outbound.create(
        { channel: 'telegram', target: '-delivery-test', text: 'approved', phase: 2 },
        'pending',
      );
      const row = (await r.outbound.claimPending(1, { now, leaseMs: 5000 }))[0]!;
      const identity = { id: row.id, leaseToken: row.leaseToken! };
      expect(await r.outbound.beginSend({ ...identity, now })).toBe(true);
      expect(await r.outbound.beginSend({ ...identity, now })).toBe(false);
      expect(await r.outbound.recoverExpiredClaims(later)).toMatchObject({
        requeued: 0,
        unknown: 1,
      });
      expect((await tx.outboundMessage.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
        'delivery_unknown',
      );
      expect(await r.outbound.claimPending(1, { now: later })).toEqual([]);
      expect(await r.outbound.markSent({ ...identity, externalMessageId: '123', now: later })).toBe(
        true,
      );
      expect(await r.outbound.markSent({ ...identity, externalMessageId: '123', now: later })).toBe(
        true,
      );
      const sent = await tx.outboundMessage.findUniqueOrThrow({ where: { id: row.id } });
      expect(sent.status).toBe('sent');
      expect(sent.externalMessageId).toBe('123');
      expect(
        await r.outbound.markFailed({
          ...identity,
          deliveryState: 'unknown',
          errorCode: 'network_error',
          now: later,
        }),
      ).toBe(false);
    });
  });
  it('retries a definitive rejection only at its due time and stops after three claims', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      await r.outbound.create(
        { channel: 'telegram', target: '-delivery-test', text: 'approved', phase: 2 },
        'pending',
      );
      for (let attempt = 0; attempt < 3; attempt++) {
        const at = new Date(now.getTime() + attempt * 10000),
          due = new Date(at.getTime() + 5000);
        const row = (await r.outbound.claimPending(1, { now: at }))[0]!;
        const identity = { id: row.id, leaseToken: row.leaseToken! };
        await r.outbound.beginSend({ ...identity, now: at });
        expect(
          await r.outbound.markFailed({
            ...identity,
            deliveryState: 'not_sent',
            errorCode: 'telegram_429',
            retryAt: due,
            now: at,
          }),
        ).toBe(true);
        expect(await r.outbound.claimPending(1, { now: at })).toEqual([]);
        expect((await tx.outboundMessage.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
          attempt < 2 ? 'pending' : 'failed',
        );
      }
    });
  });
});

it('keeps basic-group receipts unique per sender account, not across different bots', async () => {
  await withTestDb(async (tx) => {
    await tx.$executeRaw`INSERT INTO outbound_messages (id, channel, target, text, sender_account_id, external_message_id) VALUES ('actor-receipt-one', 'telegram', '-actor-collision', 'synthetic', '111', '3')`;
    await tx.$executeRaw`INSERT INTO outbound_messages (id, channel, target, text, sender_account_id, external_message_id) VALUES ('actor-receipt-two', 'telegram', '-actor-collision', 'synthetic', '222', '3')`;
    expect(await tx.outboundMessage.count({ where: { target: '-actor-collision' } })).toBe(2);
    for (const accountId of ['111', '222']) {
      const scoped = createRepositories(tx, undefined, accountId);
      const row = await scoped.outbound.create(
        { channel: 'telegram', target: '-actor-factory', text: 'synthetic', phase: 2 },
        'pending',
      );
      expect(row.senderAccountId).toBe(accountId);
    }

    await expect(
      tx.$executeRaw`INSERT INTO outbound_messages (id, channel, target, text, sender_account_id, external_message_id) VALUES ('actor-receipt-duplicate', 'telegram', '-actor-collision', 'synthetic', '111', '3')`,
    ).rejects.toThrow();
  });
});

it('preserves receipt uniqueness for the default single-bot account', async () => {
  await withTestDb(async (tx) => {
    await tx.$executeRaw`INSERT INTO outbound_messages (id, channel, target, text, external_message_id) VALUES ('default-receipt-one', 'telegram', '-default-collision', 'synthetic', '3')`;
    await expect(
      tx.$executeRaw`INSERT INTO outbound_messages (id, channel, target, text, external_message_id) VALUES ('default-receipt-two', 'telegram', '-default-collision', 'synthetic', '3')`,
    ).rejects.toThrow();
  });
});
