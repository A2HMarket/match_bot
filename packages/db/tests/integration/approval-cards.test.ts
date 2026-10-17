import { describe, expect, it } from 'vitest';
import { createRepositories } from '../../src/repos/index.js';
import { withTestDb } from './setup.js';

async function seed(tx: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
  const r = createRepositories(tx),
    user = await r.users.upsertByExternal({
      channel: 'telegram',
      externalId: 'approval-card-user',
    }),
    group = await r.groups.upsert({
      channel: 'telegram',
      externalId: '-400',
      name: 'synthetic card source',
    });
  await tx.group.update({ where: { id: group.id }, data: { phase: 1, isActive: true } });
  const { message } = await r.executions.accept({
      userId: user.id,
      groupId: group.id,
      phase: 1,
      message: {
        channel: 'telegram',
        userId: user.externalId,
        chatId: group.externalId,
        messageId: '1',
        text: '找书桌',
        receivedAt: new Date().toISOString(),
      },
    }),
    runState = await r.runStates.create({
      userId: user.id,
      chatId: group.externalId,
      messageId: message.id,
      phase: 1,
      snapshot: 'encrypted fixture',
      agentVersion: 'test-agent',
      sdkVersion: 'test-sdk',
      interruptions: [
        {
          tool: 'reply_to_request',
          args: '{"text":"uncompiled model text"}',
          draftText: '冻结的拟发正文与来源',
        },
      ],
      expiresAt: new Date(Date.now() + 86400e3),
    });
  await tx.message.update({
    where: { id: message.id },
    data: { executionStatus: 'waiting_approval' },
  });
  return { r, runState, message, user, group };
}
describe('durable approval cards', () => {
  it('queues the frozen preview once and leaves the original request waiting for approval', async () =>
    withTestDb(async (tx) => {
      const { r, runState, message } = await seed(tx),
        params = { runStateId: runState.id, opsChatId: '-200', defaultPhase: 0 as const };
      expect(
        (
          await r.runStates.pendingCards({
            agentVersion: 'test-agent',
            sdkVersion: 'test-sdk',
            defaultPhase: 0,
          })
        ).map((row) => row.id),
      ).toContain(runState.id);
      const first = await r.outbound.enqueueApprovalCard(params),
        again = await r.outbound.enqueueApprovalCard(params);
      expect(first).toMatchObject({
        approvalRunStateId: runState.id,
        target: '-200',
        kind: 'notification',
        status: 'pending',
        sourceMessageId: message.id,
      });
      expect(again?.id).toBe(first?.id);
      expect(first?.text).toContain('冻结的拟发正文与来源');
      expect(first?.text).not.toContain('uncompiled model text');
      expect(
        await r.runStates.pendingCards({
          agentVersion: 'test-agent',
          sdkVersion: 'test-sdk',
          defaultPhase: 0,
        }),
      ).toEqual([]);
      expect(
        (await r.executions.claim({ userId: runState.userId, messageId: message.id })).kind,
      ).toBe('waiting');
      const approval = await r.approvals.decide({
        runStateId: runState.id,
        reviewer: 'operator',
        decision: 'approve',
      });
      if (!approval) throw new Error('missing approval');
      // An ops notification is never mistaken for the customer's completed answer.
      expect(
        (await r.approvals.claimResume({ runStateId: runState.id, approvalId: approval.id })).kind,
      ).toBe('acquired');
    }));
  it('uses the source phase and fixed current ops recipient, not the ops group default', async () =>
    withTestDb(async (tx) => {
      const { r, runState } = await seed(tx),
        card = await r.outbound.enqueueApprovalCard({
          runStateId: runState.id,
          opsChatId: '-200',
          defaultPhase: 0,
        });
      const [claim] = await r.outbound.claimPending(1);
      if (!card || !claim?.leaseToken) throw new Error('missing card');
      expect(
        await r.outbound.beginSend({
          id: card.id,
          leaseToken: claim.leaseToken,
          opsChatId: '-200',
          defaultPhase: 0,
        }),
      ).toBe(true);
      expect(
        await r.outbound.markSent({
          id: card.id,
          leaseToken: claim.leaseToken,
          externalMessageId: '77',
        }),
      ).toBe(true);
      expect((await r.runStates.findById(runState.id))?.status).toBe('pending');
    }));
  it('holds Phase0, unavailable previews, obsolete versions and changed source policy', async () =>
    withTestDb(async (tx) => {
      const { r, runState, group } = await seed(tx);
      expect(
        await r.runStates.pendingCards({
          agentVersion: 'another-version',
          sdkVersion: 'test-sdk',
          defaultPhase: 0,
        }),
      ).toEqual([]);
      await tx.group.update({ where: { id: group.id }, data: { phase: 0 } });
      expect(
        await r.outbound.enqueueApprovalCard({
          runStateId: runState.id,
          opsChatId: '-200',
          defaultPhase: 0,
        }),
      ).toBeNull();
      expect(await tx.outboundMessage.count()).toBe(0);
      await tx.group.update({ where: { id: group.id }, data: { phase: 1 } });
      const card = await r.outbound.enqueueApprovalCard({
          runStateId: runState.id,
          opsChatId: '-200',
          defaultPhase: 0,
        }),
        [claim] = await r.outbound.claimPending(1);
      if (!card || !claim?.leaseToken) throw new Error('missing card');
      expect(
        await r.outbound.beginSend({
          id: card.id,
          leaseToken: claim.leaseToken,
          opsChatId: '-201',
          defaultPhase: 0,
        }),
      ).toBe(false);
      expect(await tx.outboundMessage.findUnique({ where: { id: card.id } })).toMatchObject({
        status: 'failed',
      });
    }));
  it.each(['pending', 'consumed', 'expired'] as const)(
    'redacts %s snapshot contents and persisted card bodies after expiry',
    async (status) =>
      withTestDb(async (tx) => {
        const { r, runState } = await seed(tx);
        const card = await r.outbound.enqueueApprovalCard({
          runStateId: runState.id,
          opsChatId: '-200',
          defaultPhase: 0,
        });
        if (status === 'consumed')
          await r.approvals.decide({
            runStateId: runState.id,
            reviewer: 'operator',
            decision: 'approve',
          });
        await tx.runState.update({
          where: { id: runState.id },
          data: { expiresAt: new Date(Date.now() - 1), status },
        });
        expect(await r.runStates.expireOld(new Date())).toBe(1);
        expect(await r.runStates.findById(runState.id)).toMatchObject({
          status: 'expired',
          snapshot: '',
          interruptions: [],
        });
        expect(await tx.outboundMessage.findUnique({ where: { id: card!.id } })).toMatchObject({
          status: 'failed',
          text: '[approval content expired]',
        });
        if (status === 'consumed')
          expect(await tx.approval.findFirst({ where: { runStateId: runState.id } })).toMatchObject(
            {
              resumeStatus: 'failed',
              resumeError: 'snapshot_expired',
            },
          );
        expect(await r.runStates.expireOld(new Date())).toBe(0);
      }),
  );
  it('expires an older request without releasing a newer input user fence', async () =>
    withTestDb(async (tx) => {
      const { r, runState, user } = await seed(tx),
        next = await r.executions.accept({
          userId: user.id,
          groupId: null,
          phase: 1,
          message: {
            channel: 'telegram',
            userId: user.externalId,
            chatId: user.externalId,
            messageId: '2',
            text: '另一个新需求',
            receivedAt: new Date().toISOString(),
          },
        }),
        claimed = await r.executions.claim({ userId: user.id, messageId: next.message.id });
      if (claimed.kind !== 'acquired') throw new Error('missing new fence');
      await tx.runState.update({
        where: { id: runState.id },
        data: { expiresAt: new Date(Date.now() - 1) },
      });
      await r.runStates.expireOld(new Date());
      expect(await tx.user.findUnique({ where: { id: user.id } })).toMatchObject({
        executionLeaseToken: claimed.lease.token,
        executionFence: claimed.lease.fence,
      });
      await r
        .forExecution(claimed.lease)
        .sessionItems.append(user.id, [{ role: 'user', content: 'still active' }]);
      expect(await r.sessionItems.list(user.id)).toEqual([
        { role: 'user', content: 'still active' },
      ]);
    }));
  it('retains a newer pending snapshot for the same original message when the older one expires', async () =>
    withTestDb(async (tx) => {
      const { r, runState, user, group, message } = await seed(tx);
      await tx.runState.update({
        where: { id: runState.id },
        data: { status: 'consumed', expiresAt: new Date(Date.now() - 1) },
      });
      const newer = await r.runStates.create({
        userId: user.id,
        chatId: group.externalId,
        messageId: message.id,
        phase: 1,
        snapshot: 'new encrypted snapshot',
        agentVersion: 'test-agent',
        sdkVersion: 'test-sdk',
        interruptions: [{ tool: 'reply_request_status', draftText: '新的完整拟发正文' }],
        expiresAt: new Date(Date.now() + 86400e3),
      });
      await r.runStates.expireOld(new Date());
      expect(await tx.message.findUnique({ where: { id: message.id } })).toMatchObject({
        executionStatus: 'waiting_approval',
      });
      expect(await r.runStates.findById(newer.id)).toMatchObject({
        status: 'pending',
        snapshot: 'new encrypted snapshot',
      });
      expect(
        await r.outbound.enqueueApprovalCard({
          runStateId: newer.id,
          opsChatId: '-200',
          defaultPhase: 0,
        }),
      ).toMatchObject({ status: 'pending', approvalRunStateId: newer.id });
    }));
  it('never substitutes raw model arguments for a missing frozen preview', async () =>
    withTestDb(async (tx) => {
      const { r, runState, message } = await seed(tx);
      await tx.runState.update({
        where: { id: runState.id },
        data: { interruptions: [{ tool: 'reply_to_request', args: '{"text":"uncompiled"}' }] },
      });
      expect(
        await r.outbound.enqueueApprovalCard({
          runStateId: runState.id,
          opsChatId: '-200',
          defaultPhase: 0,
        }),
      ).toBeNull();
      expect(await tx.outboundMessage.count()).toBe(0);
      expect(await r.runStates.findById(runState.id)).toMatchObject({ status: 'expired' });
      expect(await tx.message.findUnique({ where: { id: message.id } })).toMatchObject({
        executionStatus: 'failed',
        executionError: 'approval_unavailable',
      });
    }));
});
