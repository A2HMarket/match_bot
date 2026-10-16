import { describe, expect, it } from 'vitest';
import { createRepositories } from '../../src/repos/index.js';
import { withTestDb } from './setup.js';

const at = new Date('2026-10-17T00:00:00Z');
async function setup(tx: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
  const r = createRepositories(tx),
    user = await r.users.upsertByExternal({ channel: 'telegram', externalId: 'execution-user' });
  const msg = {
    channel: 'telegram' as const,
    chatId: 'execution-user',
    userId: 'execution-user',
    messageId: '1',
    text: '找书桌',
    receivedAt: at.toISOString(),
  };
  return { r, user, msg };
}
describe('durable request execution', () => {
  it('binds a checkpoint only to the same owner, conversation and current task requirements', async () => {
    await withTestDb(async (tx) => {
      const { r, user, msg } = await setup(tx);
      const accepted = await r.executions.accept({
        userId: user.id,
        groupId: null,
        message: msg,
        phase: 2,
      });
      const task = await r.tasks.create({
        access: { userId: user.id, scope: { channel: 'telegram', chatId: msg.chatId } },
        sourceMessageId: accepted.message.id,
        intentKey: 'binding',
        objective: '找书桌',
        category: 'second_hand',
      });
      const claim = await r.executions.claim({
        userId: user.id,
        messageId: accepted.message.id,
        now: at,
      });
      if (claim.kind !== 'acquired') throw new Error('missing lease');
      const input = { lease: claim.lease, snapshot: 'opaque encrypted checkpoint', now: at };
      await expect(
        r.executions.saveCheckpoint({
          ...input,
          task: { id: task.id, requirementsVersion: task.requirementsVersion + 1 },
        }),
      ).rejects.toThrow('binding');
      await expect(
        r.executions.saveCheckpoint({
          ...input,
          task: { id: 'unowned-task', requirementsVersion: task.requirementsVersion },
        }),
      ).rejects.toThrow('binding');
      expect(
        await r.executions.saveCheckpoint({
          ...input,
          task: { id: task.id, requirementsVersion: task.requirementsVersion },
        }),
      ).toBe(true);
      expect(await tx.message.findUnique({ where: { id: accepted.message.id } })).toMatchObject({
        taskId: task.id,
        taskRequirementsVersion: task.requirementsVersion,
      });
    });
  });
  it('redacts stored execution inputs and checkpoints together after retention expires', async () => {
    await withTestDb(async (tx) => {
      const { r, user, msg } = await setup(tx);
      const accepted = await r.executions.accept({
        userId: user.id,
        groupId: null,
        message: { ...msg, replyToBotText: 'old private context' },
        phase: 2,
      });
      await tx.message.update({
        where: { id: accepted.message.id },
        data: {
          executionSnapshot: 'encrypted retained context',
          receivedAt: new Date(Date.now() - 31 * 86400e3),
        },
      });
      await r.messages.redactOlderThan(30);
      expect(await tx.message.findUnique({ where: { id: accepted.message.id } })).toMatchObject({
        text: '',
        executionSnapshot: null,
        replyToBotText: null,
      });
    });
  });
  it('reuses a recorded demand during the same fenced request', async () => {
    await withTestDb(async (tx) => {
      const { r, user, msg } = await setup(tx);
      const accepted = await r.executions.accept({
        userId: user.id,
        groupId: null,
        message: msg,
        phase: 2,
      });
      const claim = await r.executions.claim({
        userId: user.id,
        messageId: accepted.message.id,
        now: at,
      });
      if (claim.kind !== 'acquired') throw new Error('missing lease');
      const scoped = r.forExecution(claim.lease),
        data = {
          userId: user.id,
          sourceMessageId: accepted.message.id,
          category: 'second_hand' as const,
          confidence: 1,
          need: '书桌',
        };
      const first = await scoped.demands.create(data),
        again = await scoped.demands.create({ ...data, need: '另一种摘要' });
      expect(again.id).toBe(first.id);
      expect(await tx.demand.count({ where: { userId: user.id } })).toBe(1);
    });
  });
  it('recovers factual rejection from traces without treating a fixed-status score as that rejection', async () => {
    await withTestDb(async (tx) => {
      const { r, user, msg } = await setup(tx);
      const accepted = await r.executions.accept({
        userId: user.id,
        groupId: null,
        message: msg,
        phase: 2,
      });
      const claim = await r.executions.claim({
        userId: user.id,
        messageId: accepted.message.id,
        now: at,
      });
      if (claim.kind !== 'acquired') throw new Error('missing lease');
      const base = {
        kind: 'gate' as const,
        inputRef: accepted.message.id,
        phase: 2 as const,
        latencyMs: 0,
        costMicro: 0,
      };
      await r.traces.create({
        ...base,
        output: { gate: 'outbound', decision: 'drop', isVerifiedRequestStatus: true },
      });
      expect(await r.executions.recoveryFlags(claim.lease)).toEqual({
        outboundBlocked: false,
        answerInputExhausted: false,
      });
      await r.traces.create({
        ...base,
        output: { gate: 'outbound', decision: 'drop', isVerifiedRequestStatus: false },
      });
      await r.traces.create({ ...base, output: { gate: 'outbound_retry', decision: 'deny' } });
      expect(await r.executions.recoveryFlags(claim.lease)).toEqual({
        outboundBlocked: true,
        answerInputExhausted: true,
      });
    });
  });
  it('does not duplicate a reply after a crash between queueing and completion', async () => {
    await withTestDb(async (tx) => {
      const { r, user, msg } = await setup(tx);
      const accepted = await r.executions.accept({
        userId: user.id,
        groupId: null,
        message: msg,
        phase: 2,
      });
      const claim = await r.executions.claim({
        userId: user.id,
        messageId: accepted.message.id,
        now: at,
        leaseMs: 1000,
      });
      if (claim.kind !== 'acquired') throw new Error('missing lease');
      const draft = {
        channel: 'telegram' as const,
        target: msg.chatId,
        text: 'first approved reply',
        phase: 2 as const,
        execution: claim.lease,
      };
      const first = await r.outbound.create(draft, 'pending');
      const replay = await r.outbound.create(
        { ...draft, text: 'different generated draft' },
        'pending',
      );
      expect(replay.id).toBe(first.id);
      expect(replay.text).toBe('first approved reply');
      expect(first.sourceMessageId).toBe(accepted.message.id);
      expect(
        (
          await r.executions.claim({
            userId: user.id,
            messageId: accepted.message.id,
            now: new Date(at.getTime() + 2000),
          })
        ).kind,
      ).toBe('done');
      expect(
        await tx.outboundMessage.count({ where: { sourceMessageId: accepted.message.id } }),
      ).toBe(1);
      await expect(r.outbound.create(draft, 'pending')).rejects.toThrow('fence');
    });
  });
  it('accepts one private message atomically and resumes an unfinished record', async () => {
    await withTestDb(async (tx) => {
      const { r, user, msg } = await setup(tx);
      const accepted = await r.executions.accept({
        userId: user.id,
        groupId: null,
        message: msg,
        phase: 2,
      });
      const replay = await r.executions.accept({
        userId: user.id,
        groupId: null,
        message: msg,
        phase: 2,
      });
      expect(accepted.message.id).toBe(replay.message.id);
      expect(replay.message.executionStatus).toBe('accepted');
      const claim = await r.executions.claim({
        userId: user.id,
        messageId: accepted.message.id,
        now: at,
        leaseMs: 1000,
      });
      expect(claim.kind).toBe('acquired');
      if (claim.kind !== 'acquired') throw new Error('missing lease');
      expect(
        await r.executions.saveCheckpoint({
          lease: claim.lease,
          snapshot: 'opaque encrypted fixture',
          now: at,
        }),
      ).toBe(true);
      expect(await r.executions.finish({ lease: claim.lease, status: 'completed', now: at })).toBe(
        true,
      );
      expect(
        (await r.executions.claim({ userId: user.id, messageId: accepted.message.id, now: at }))
          .kind,
      ).toBe('done');
    });
  });
  it('does not reactivate a legacy stored message or accept a changed replay payload', async () => {
    await withTestDb(async (tx) => {
      const { r, user, msg } = await setup(tx);
      const old = await r.messages.create({
        userId: user.id,
        groupId: null,
        externalId: msg.messageId,
        text: msg.text,
        receivedAt: at,
      });
      const legacy = await r.executions.accept({
        userId: user.id,
        groupId: null,
        message: msg,
        phase: 2,
      });
      expect(legacy.kind).toBe('legacy');
      expect(legacy.message.id).toBe(old.id);
      const fresh = { ...msg, messageId: '2' };
      await r.executions.accept({ userId: user.id, groupId: null, message: fresh, phase: 2 });
      await expect(
        r.executions.accept({
          userId: user.id,
          groupId: null,
          message: { ...fresh, text: 'different input' },
          phase: 2,
        }),
      ).rejects.toThrow('payload');
    });
  });
  it('serializes one user across messages, fences stale actors and allows another user', async () => {
    await withTestDb(async (tx) => {
      const { r, user, msg } = await setup(tx);
      const first = await r.executions.accept({
        userId: user.id,
        groupId: null,
        message: msg,
        phase: 2,
      });
      const second = await r.executions.accept({
        userId: user.id,
        groupId: null,
        message: { ...msg, messageId: '2', receivedAt: new Date(at.getTime() + 1).toISOString() },
        phase: 2,
      });
      const one = await r.executions.claim({
        userId: user.id,
        messageId: first.message.id,
        now: at,
        leaseMs: 1000,
      });
      expect(
        (await r.executions.claim({ userId: user.id, messageId: second.message.id, now: at })).kind,
      ).toBe('busy');
      const next = await r.executions.claim({
        userId: user.id,
        messageId: first.message.id,
        now: new Date(at.getTime() + 2000),
        leaseMs: 1000,
      });
      if (one.kind !== 'acquired' || next.kind !== 'acquired') throw new Error('missing lease');
      expect(next.lease.fence).toBeGreaterThan(one.lease.fence);
      expect(
        await r.executions.saveCheckpoint({
          lease: one.lease,
          snapshot: 'stale',
          now: new Date(at.getTime() + 2000),
        }),
      ).toBe(false);
      expect(
        await r.executions.finish({
          lease: one.lease,
          status: 'completed',
          now: new Date(at.getTime() + 2000),
        }),
      ).toBe(false);
      await expect(
        r
          .forExecution(one.lease)
          .sessionItems.append(user.id, [{ role: 'user', content: 'stale' }]),
      ).rejects.toThrow('fence');
      await r
        .forExecution(next.lease)
        .sessionItems.append(user.id, [{ role: 'user', content: 'current' }]);
      expect(await r.sessionItems.list(user.id)).toEqual([{ role: 'user', content: 'current' }]);
      const other = await r.users.upsertByExternal({
        channel: 'telegram',
        externalId: 'other-execution-user',
      });
      const foreign = await r.executions.accept({
        userId: other.id,
        groupId: null,
        message: { ...msg, chatId: other.externalId, userId: other.externalId },
        phase: 2,
      });
      expect(
        (await r.executions.claim({ userId: other.id, messageId: foreign.message.id, now: at }))
          .kind,
      ).toBe('acquired');
      expect(
        (await r.executions.claim({ userId: other.id, messageId: first.message.id, now: at })).kind,
      ).toBe('missing');
    });
  });
});
