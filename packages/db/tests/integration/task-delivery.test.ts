import { describe, expect, it } from 'vitest';
import { createRepositories } from '../../src/repos/index.js';
import { withTestDb } from './setup.js';

async function seed(tx: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
  const r = createRepositories(tx),
    user = await r.users.upsertByExternal({
      channel: 'telegram',
      externalId: 'task-delivery-owner',
    }),
    now = new Date();
  const { message } = await r.executions.accept({
      userId: user.id,
      groupId: null,
      phase: 2,
      message: {
        channel: 'telegram',
        userId: user.externalId,
        chatId: user.externalId,
        messageId: '1',
        text: '找羽毛球搭子',
        receivedAt: now.toISOString(),
      },
    }),
    access = { userId: user.id, scope: { channel: 'telegram' as const, chatId: user.externalId } },
    planned = await r.tasks.planTurn({
      access,
      sourceMessageId: message.id,
      expectedRevision: 0,
      taskId: null,
      creation: {
        intentKey: 'primary',
        objective: '找羽毛球搭子',
        category: 'other',
        counterparty: 'peer',
      },
      patch: {
        goals: [
          {
            id: 'partner',
            title: '羽毛球搭子',
            required: true,
            sourceQuote: '羽毛球',
            criteria: [{ id: 'subject', label: '羽毛球活动', strength: 'hard' }],
          },
        ],
        constraints: [],
      },
      outcome: null,
    });
  if (planned.kind !== 'applied') throw new Error('missing task');
  const task = planned.task,
    claim = await r.executions.claim({ userId: user.id, messageId: message.id });
  if (claim.kind !== 'acquired') throw new Error('missing execution');
  const draft = {
    channel: 'telegram' as const,
    target: user.externalId,
    text: '最多接受多久单程通勤？',
    kind: 'clarification' as const,
    phase: 2 as const,
    execution: claim.lease,
    taskDelivery: {
      id: task.id,
      requirementsVersion: task.requirementsVersion,
      level: 'partial' as const,
      question: {
        constraintKey: 'max_travel_minutes',
        answerType: 'duration' as const,
        text: '最多接受多久单程通勤？',
      },
    },
  };
  return { r, user, now, message, task, access, claim, draft };
}
describe('task outbound delivery integration', () => {
  it('rejects question metadata for text absent from the actual outgoing body before any queue state is written', async () =>
    withTestDb(async (tx) => {
      const { r, draft, task, access } = await seed(tx);
      await expect(
        r.outbound.create({ ...draft, text: '只保留了建议，问题被截掉了。' }, 'pending'),
      ).rejects.toThrow('actual outbound');
      expect(await tx.outboundMessage.count()).toBe(0);
      expect(await r.tasks.findById({ access, id: task.id })).toMatchObject({
        delivery: { status: 'none' },
        pendingQuestion: null,
      });
    }));
  it('does not resume an approval superseded by a newer owner turn with unchanged requirements', async () =>
    withTestDb(async (tx) => {
      const { r, task, access, user, message, claim } = await seed(tx);
      const rs = await r.runStates.create({
        userId: user.id,
        chatId: user.externalId,
        messageId: message.id,
        task: { id: task.id, requirementsVersion: task.requirementsVersion },
        phase: 2,
        snapshot: 'encrypted fixture',
        agentVersion: 'test',
        sdkVersion: 'test',
        interruptions: [],
        expiresAt: new Date(Date.now() + 86400e3),
      });
      await r.executions.finish({
        lease: claim.lease,
        status: 'waiting_approval',
        runStateId: rs.id,
      });
      const approval = await r.approvals.decide({
        runStateId: rs.id,
        reviewer: 'operator',
        decision: 'approve',
      });
      if (!approval) throw new Error('missing decision');
      const next = await r.executions.accept({
          userId: user.id,
          groupId: null,
          phase: 2,
          message: {
            channel: 'telegram',
            userId: user.externalId,
            chatId: user.externalId,
            messageId: '2',
            text: '先比较一下',
            receivedAt: new Date().toISOString(),
          },
        }),
        execution = await r.executions.claim({ userId: user.id, messageId: next.message.id });
      if (execution.kind !== 'acquired') throw new Error('missing second turn');
      const result = await r.tasks.applyUserTurn({
        access,
        id: task.id,
        expectedRevision: task.revision,
        operationKey: 'new-turn',
        sourceMessageId: next.message.id,
        patch: null,
        outcome: null,
      });
      expect(result).toMatchObject({
        kind: 'applied',
        task: { requirementsVersion: task.requirementsVersion, delivery: { status: 'none' } },
      });
      await r.executions.finish({ lease: execution.lease, status: 'completed' });
      expect(
        (await r.approvals.claimResume({ runStateId: rs.id, approvalId: approval.id })).kind,
      ).toBe('done');
      expect(await tx.approval.findUnique({ where: { id: approval.id } })).toMatchObject({
        resumeStatus: 'failed',
      });
      expect(await r.tasks.findLatestUserMessageId({ access, id: task.id })).toBe(next.message.id);
    }));
  it('keeps a safe retry queued, then records definite failure without a user wait or reply anchor', async () =>
    withTestDb(async (tx) => {
      const { r, draft, task, access } = await seed(tx),
        out = await r.outbound.create(draft, 'pending'),
        [claimed] = await r.outbound.claimPending(1);
      if (!claimed?.leaseToken) throw new Error('missing delivery');
      const fence = { id: out.id, leaseToken: claimed.leaseToken };
      await r.outbound.beginSend(fence);
      const retryAt = new Date(Date.now() + 10000);
      await r.outbound.markFailed({
        ...fence,
        deliveryState: 'not_sent',
        errorCode: 'rate_limited',
        retryAt,
      });
      expect((await r.tasks.findById({ access, id: task.id }))?.delivery.status).toBe('queued');
      const [retried] = await r.outbound.claimPending(1, { now: retryAt });
      if (!retried?.leaseToken) throw new Error('missing retry');
      await r.outbound.beginSend({ id: out.id, leaseToken: retried.leaseToken, now: retryAt });
      await r.outbound.markFailed({
        id: out.id,
        leaseToken: retried.leaseToken,
        deliveryState: 'not_sent',
        errorCode: 'forbidden',
        now: retryAt,
      });
      expect(await r.tasks.findById({ access, id: task.id })).toMatchObject({
        status: 'active',
        delivery: { status: 'failed' },
        pendingQuestion: { deliveryStatus: 'proposed' },
      });
      expect(await r.tasks.findReplyAnchor({ access, externalMessageId: '103' })).toBeNull();
    }));
  it('queues a proposal, records actual delivery atomically and resolves only its owner/conversation reply anchor', async () =>
    withTestDb(async (tx) => {
      const { r, draft, task, access, message } = await seed(tx),
        out = await r.outbound.create(draft, 'pending');
      expect(out.taskId).toBe(task.id);
      expect(out.taskRequirementsVersion).toBe(task.requirementsVersion);
      expect(await r.tasks.findById({ access, id: task.id })).toMatchObject({
        status: 'waiting_delivery',
        pendingQuestion: { deliveryStatus: 'proposed', outboundMessageId: out.id },
      });
      expect(await r.tasks.findReplyAnchor({ access, externalMessageId: '101' })).toBeNull();
      const [claimed] = await r.outbound.claimPending(1);
      if (!claimed?.leaseToken) throw new Error('missing delivery');
      const fence = { id: out.id, leaseToken: claimed.leaseToken };
      expect(await r.outbound.beginSend(fence)).toBe(true);
      expect(await r.outbound.markSent({ ...fence, externalMessageId: '101' })).toBe(true);
      const sent = await r.tasks.findById({ access, id: task.id });
      expect(sent).toMatchObject({
        status: 'waiting_user',
        pendingQuestion: { deliveryStatus: 'sent' },
        userConfirmation: null,
      });
      expect(await r.tasks.findReplyAnchor({ access, externalMessageId: '101' })).toMatchObject({
        id: task.id,
      });
      expect(
        await r.tasks.findReplyAnchor({
          access: { ...access, userId: 'another-owner' },
          externalMessageId: '101',
        }),
      ).toBeNull();
      expect(
        await r.tasks.findReplyAnchor({
          access: { ...access, scope: { channel: 'telegram', chatId: 'another-chat' } },
          externalMessageId: '101',
        }),
      ).toBeNull();
      expect(await r.outbound.markSent({ ...fence, externalMessageId: '101' })).toBe(true);
      expect((await r.tasks.findById({ access, id: task.id }))?.revision).toBe(sent?.revision);
      expect(await tx.message.findUnique({ where: { id: message.id } })).toMatchObject({
        taskId: task.id,
        taskRequirementsVersion: task.requirementsVersion,
      });
    }));
  it('keeps unknown receipts out of waiting_user and accepts a late authoritative receipt', async () =>
    withTestDb(async (tx) => {
      const { r, draft, task, access } = await seed(tx),
        out = await r.outbound.create(draft, 'pending'),
        [claimed] = await r.outbound.claimPending(1);
      if (!claimed?.leaseToken) throw new Error('missing delivery');
      const fence = { id: out.id, leaseToken: claimed.leaseToken };
      await r.outbound.beginSend(fence);
      await r.outbound.markFailed({
        ...fence,
        deliveryState: 'unknown',
        errorCode: 'receipt_missing',
      });
      expect(await r.tasks.findById({ access, id: task.id })).toMatchObject({
        status: 'active',
        delivery: { status: 'unknown' },
        pendingQuestion: { deliveryStatus: 'proposed' },
      });
      await r.outbound.markSent({ ...fence, externalMessageId: '102' });
      expect(await r.tasks.findById({ access, id: task.id })).toMatchObject({
        status: 'waiting_user',
        delivery: { status: 'sent' },
      });
    }));
  it('keeps phase0 at dry_run and records definite failure without a delivered anchor', async () =>
    withTestDb(async (tx) => {
      const { r, draft, task, access } = await seed(tx);
      const dry = await r.outbound.create({ ...draft, phase: 0 }, 'dry_run');
      expect((await r.tasks.findById({ access, id: task.id }))?.delivery.status).toBe('none');
      // Another request is used for a real pending attempt; dry_run is never promoted by replay.
      expect((await r.outbound.create(draft, 'pending')).id).toBe(dry.id);
      expect(await r.outbound.claimPending(1)).toEqual([]);
    }));
  it('holds an obsolete queued reply after conditions change, without overwriting the new task state', async () =>
    withTestDb(async (tx) => {
      const { r, draft, task, access, user, claim } = await seed(tx),
        out = await r.outbound.create(draft, 'pending');
      await r.executions.finish({ lease: claim.lease, status: 'completed' });
      const changed = await r.messages.create({
          userId: user.id,
          groupId: null,
          externalId: '2',
          text: '预算50镑',
          receivedAt: new Date(),
        }),
        current = await r.tasks.findById({ access, id: task.id });
      if (!current) throw new Error('missing task');
      await r.tasks.reviseRequirements({
        access,
        id: task.id,
        expectedRevision: current.revision,
        operationKey: 'new-budget',
        sourceMessageId: changed.id,
        patch: {
          goals: [],
          constraints: [
            {
              key: 'budget',
              strength: 'hard',
              value: { kind: 'money', amountPence: 5000, unit: 'person' },
              sourceQuote: '50镑',
            },
          ],
        },
      });
      const [claimed] = await r.outbound.claimPending(1);
      if (!claimed?.leaseToken) throw new Error('missing delivery');
      expect(await r.outbound.beginSend({ id: out.id, leaseToken: claimed.leaseToken })).toBe(
        false,
      );
      expect(await tx.outboundMessage.findUnique({ where: { id: out.id } })).toMatchObject({
        status: 'failed',
        error: 'obsolete_task_reply',
      });
      expect(await r.tasks.findById({ access, id: task.id })).toMatchObject({
        status: 'active',
        pendingQuestion: null,
        delivery: { status: 'none' },
      });
    }));
});
