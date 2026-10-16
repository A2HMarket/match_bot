import { describe, expect, it } from 'vitest';
import { createRepositories } from '../../src/repos/index.js';
import { withTestDb } from './setup.js';

describe('sessionItems', () => {
  it('append is idempotent per operationId and keeps order', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const u = await r.users.upsertByExternal({ channel: 'telegram', externalId: 's1' });
      await r.sessionItems.append(u.id, [{ role: 'user', content: 'a' }], 'op1');
      await r.sessionItems.append(u.id, [{ role: 'user', content: 'a' }], 'op1');
      await r.sessionItems.append(u.id, [{ role: 'assistant', content: 'b' }]);
      expect((await r.sessionItems.list(u.id)).length).toBe(2);
      expect(await r.sessionItems.popLast(u.id)).toEqual({ role: 'assistant', content: 'b' });
      await r.sessionItems.clear(u.id);
      expect(await r.sessionItems.list(u.id)).toEqual([]);
    });
  });
});

describe('runStates.consume', () => {
  it('returns the row once, null the second time', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const u = await r.users.upsertByExternal({ channel: 'telegram', externalId: 'r1' });
      const rs = await r.runStates.create({
        userId: u.id,
        chatId: '-1',
        phase: 1,
        snapshot: '{}',
        agentVersion: '0.0.0',
        sdkVersion: '0.18.0',
        interruptions: [],
        expiresAt: new Date(Date.now() + 1000),
      });
      expect((await r.runStates.consume(rs.id))?.id).toBe(rs.id);
      expect(await r.runStates.consume(rs.id)).toBeNull();
    });
  });
  it('expireOld marks pending rows past expiresAt', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const u = await r.users.upsertByExternal({ channel: 'telegram', externalId: 'r2' });
      await r.runStates.create({
        userId: u.id,
        chatId: '-1',
        phase: 0,
        snapshot: '{}',
        agentVersion: '0',
        sdkVersion: '0',
        interruptions: [],
        expiresAt: new Date(Date.now() - 1),
      });
      expect(await r.runStates.expireOld(new Date())).toBe(1);
    });
  });
});

describe('approvals', () => {
  it('create + findById round-trips a decision', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const u = await r.users.upsertByExternal({ channel: 'telegram', externalId: 'a1' });
      const rs = await r.runStates.create({
        userId: u.id,
        chatId: '-1',
        phase: 1,
        snapshot: '{}',
        agentVersion: '0',
        sdkVersion: '0',
        interruptions: [],
        expiresAt: new Date(Date.now() + 1000),
      });
      const a = await r.approvals.create({
        runStateId: rs.id,
        reviewer: 'ops',
        decision: 'edit',
        editedText: 'hi',
      });
      expect((await r.approvals.findById(a.id))?.editedText).toBe('hi');
    });
  });
});

describe('outbound', () => {
  it('claimPending returns pending only; countSentToTargetSince counts sent', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const a = await r.outbound.create(
        { channel: 'telegram', target: '-1', text: 'x', phase: 2 },
        'pending',
      );
      await r.outbound.create({ channel: 'telegram', target: '-1', text: 'y' }, 'dry_run');
      const [claim] = await r.outbound.claimPending(10);
      expect(claim?.id).toBe(a.id);
      await r.outbound.beginSend({ id: a.id, leaseToken: claim!.leaseToken! });
      await r.outbound.markSent({
        id: a.id,
        leaseToken: claim!.leaseToken!,
        externalMessageId: '1',
      });
      expect(await r.outbound.countSentToTargetSince('-1', new Date(Date.now() - 60e3))).toBe(1);
      expect(await r.outbound.claimPending(10)).toEqual([]);
    });
  });
  it('countSentToTargetSince filters by kind; rows default to recommendation', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const rec = await r.outbound.create(
        { channel: 'telegram', target: '-2', text: 'r', phase: 2 },
        'pending',
      );
      const ask = await r.outbound.create(
        { channel: 'telegram', target: '-2', text: 'q', kind: 'clarification', phase: 2 },
        'pending',
      );
      expect(rec.kind).toBe('recommendation');
      const claims = await r.outbound.claimPending(10);
      expect(claims.map((row) => row.id)).toEqual(expect.arrayContaining([rec.id, ask.id]));
      for (const [index, row] of claims.entries()) {
        await r.outbound.beginSend({ id: row.id, leaseToken: row.leaseToken! });
        await r.outbound.markSent({
          id: row.id,
          leaseToken: row.leaseToken!,
          externalMessageId: String(index + 1),
        });
      }
      const since = new Date(Date.now() - 60e3);
      expect(await r.outbound.countSentToTargetSince('-2', since)).toBe(2);
      expect(await r.outbound.countSentToTargetSince('-2', since, 'recommendation')).toBe(1);
    });
  });
});

describe('traces', () => {
  it('create applies defaults and listByKind filters', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      await r.traces.create({
        kind: 'jev',
        inputRef: 'm1',
        output: { ok: true },
        phase: 0,
        latencyMs: 5,
        costMicro: 0,
      });
      await r.traces.create({
        kind: 'rule',
        inputRef: 'm1',
        output: {},
        phase: 0,
        latencyMs: 0,
        costMicro: 0,
      });
      expect(await r.traces.listByKind('jev', new Date(Date.now() - 60e3))).toHaveLength(1);
    });
  });
});
