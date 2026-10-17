import { describe, expect, it } from 'vitest';
import { createRepositories } from '../../src/repos/index.js';
import { withTestDb } from './setup.js';

async function seed(tx: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
  const repos = createRepositories(tx),
    user = await repos.users.upsertByExternal({
      channel: 'telegram',
      externalId: 'approval-execution-user',
    }),
    now = new Date();
  const { message } = await repos.executions.accept({
    userId: user.id,
    groupId: null,
    phase: 1,
    message: {
      channel: 'telegram',
      userId: user.externalId,
      chatId: user.externalId,
      messageId: '1',
      text: '找书桌',
      receivedAt: now.toISOString(),
    },
  });
  const runState = await repos.runStates.create({
    userId: user.id,
    chatId: user.externalId,
    messageId: message.id,
    phase: 1,
    snapshot: 'encrypted fixture',
    agentVersion: 'test-agent',
    sdkVersion: 'test-sdk',
    interruptions: [],
    expiresAt: new Date(now.getTime() + 86400e3),
  });
  await tx.message.update({
    where: { id: message.id },
    data: { executionStatus: 'waiting_approval' },
  });
  return { repos, user, message, runState, now };
}

describe('durable approval execution', () => {
  it('returns failed generation to a durable intent and stops after three resume attempts', async () =>
    withTestDb(async (tx) => {
      const { repos, runState, now } = await seed(tx);
      const approval = await repos.approvals.decide({
        runStateId: runState.id,
        reviewer: 'operator',
        decision: 'approve',
        now,
      });
      if (!approval) throw new Error('missing decision');
      const job = { runStateId: runState.id, approvalId: approval.id };
      for (let attempt = 1; attempt <= 3; attempt++) {
        const claimed = await repos.approvals.claimResume({ ...job, now });
        if (claimed.kind !== 'acquired') throw new Error('missing retry');
        expect(
          await repos.approvals.finishResume({
            ...job,
            lease: claimed.lease,
            status: 'accepted',
            errorCode: 'provider_failure',
            now,
          }),
        ).toBe(true);
        expect(await tx.approval.findUnique({ where: { id: approval.id } })).toMatchObject({
          resumeAttempts: attempt,
          resumeStatus: attempt === 3 ? 'failed' : 'accepted',
        });
      }
      expect(await repos.approvals.dispatchable(20, now)).toEqual([]);
    }));
  it('consumes once and records both decision and dispatch intent, without replaying legacy approvals', async () =>
    withTestDb(async (tx) => {
      const { repos, runState, now } = await seed(tx);
      const decision = {
        runStateId: runState.id,
        reviewer: 'operator',
        decision: 'approve' as const,
        now,
      };
      const row = await repos.approvals.decide(decision);
      expect(row).toMatchObject({ resumeStatus: 'accepted', decision: 'approve' });
      expect(await repos.approvals.decide(decision)).toBeNull();
      expect(await repos.runStates.findById(runState.id)).toMatchObject({ status: 'consumed' });
      const legacy = await repos.approvals.create({
        runStateId: runState.id,
        reviewer: 'legacy',
        decision: 'approve',
      });
      const intents = await repos.approvals.dispatchable(20, now);
      expect(intents.map((i) => i.approvalId)).toContain(row!.id);
      expect(intents.map((i) => i.approvalId)).not.toContain(legacy.id);
    }));
  it('does not consume an expired or unbound snapshot, and ignores without leaving a waiting request', async () =>
    withTestDb(async (tx) => {
      const { repos, runState, message, now } = await seed(tx);
      await tx.runState.update({ where: { id: runState.id }, data: { expiresAt: now } });
      expect(
        await repos.approvals.decide({
          runStateId: runState.id,
          reviewer: 'operator',
          decision: 'approve',
          now,
        }),
      ).toBeNull();
      await tx.runState.update({
        where: { id: runState.id },
        data: { expiresAt: new Date(now.getTime() + 1000), messageId: null },
      });
      expect(
        await repos.approvals.decide({
          runStateId: runState.id,
          reviewer: 'operator',
          decision: 'approve',
          now,
        }),
      ).toBeNull();
      await tx.runState.update({ where: { id: runState.id }, data: { messageId: message.id } });
      expect(
        await repos.approvals.decide({
          runStateId: runState.id,
          reviewer: 'operator',
          decision: 'ignore',
          now,
        }),
      ).toMatchObject({ resumeStatus: 'completed' });
      expect(await tx.message.findUnique({ where: { id: message.id } })).toMatchObject({
        executionStatus: 'completed',
      });
      expect(await repos.approvals.dispatchable(20, now)).toEqual([]);
    }));
  it('shares the user fence with inbound, retries boundedly, and refuses stale completion', async () =>
    withTestDb(async (tx) => {
      const { repos, user, message, runState, now } = await seed(tx);
      const approval = await repos.approvals.decide({
        runStateId: runState.id,
        reviewer: 'operator',
        decision: 'approve',
        now,
      });
      if (!approval) throw new Error('missing decision');
      const job = { runStateId: runState.id, approvalId: approval.id };
      const one = await repos.approvals.claimResume({ ...job, now, leaseMs: 1000 });
      if (one.kind !== 'acquired') throw new Error('missing lease');
      expect(
        (await repos.executions.claim({ userId: user.id, messageId: message.id, now })).kind,
      ).toBe('busy');
      const later = new Date(now.getTime() + 2000);
      // Expired resume is owned by its durable approval intent, never regenerated as inbound.
      expect(
        (await repos.executions.claim({ userId: user.id, messageId: message.id, now: later })).kind,
      ).toBe('waiting');
      const two = await repos.approvals.claimResume({ ...job, now: later, leaseMs: 1000 });
      if (two.kind !== 'acquired') throw new Error('missing recovery');
      expect(two.lease.fence).toBeGreaterThan(one.lease.fence);
      expect(
        await repos.approvals.finishResume({
          ...job,
          lease: one.lease,
          status: 'completed',
          now: later,
        }),
      ).toBe(false);
      expect(
        await repos.approvals.finishResume({
          ...job,
          lease: two.lease,
          status: 'completed',
          now: later,
        }),
      ).toBe(true);
      expect((await repos.approvals.claimResume({ ...job, now: later })).kind).toBe('done');
      expect(await tx.user.findUnique({ where: { id: user.id } })).toMatchObject({
        executionLeaseToken: null,
      });
    }));
  it('links a new interruption or existing outbox after a crash instead of rerunning the approved call', async () =>
    withTestDb(async (tx) => {
      const { repos, runState, user, message, now } = await seed(tx);
      const approval = await repos.approvals.decide({
        runStateId: runState.id,
        reviewer: 'operator',
        decision: 'approve',
        now,
      });
      if (!approval) throw new Error('missing decision');
      const job = { runStateId: runState.id, approvalId: approval.id };
      const claim = await repos.approvals.claimResume({ ...job, now, leaseMs: 1000 });
      if (claim.kind !== 'acquired') throw new Error('missing lease');
      await repos.outbound.create(
        {
          channel: 'telegram',
          target: user.externalId,
          text: 'approved original',
          phase: 1,
          execution: claim.lease,
        },
        'pending',
      );
      expect(
        (await repos.approvals.claimResume({ ...job, now: new Date(now.getTime() + 2000) })).kind,
      ).toBe('done');
      expect(await tx.outboundMessage.count({ where: { sourceMessageId: message.id } })).toBe(1);
      expect(await tx.approval.findUnique({ where: { id: approval.id } })).toMatchObject({
        resumeStatus: 'completed',
      });
    }));
});
