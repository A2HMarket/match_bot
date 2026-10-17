import { describe, expect, it } from 'vitest';
import { RunContext } from '@openai/agents';
import { createRepositories } from '@matchbot/db';
import { withTestDb } from '../../../db/tests/integration/setup.js';
import { taskPlanningTools } from '../../src/tools/plan-task.js';
import { bindCurrentRequest } from '../../src/current-request.js';
import type { AgentDeps, MatchContext } from '../../src/context.js';

describe('actual PostgreSQL delivery/continuation ordering', () => {
  it('preserves conditions and saves the supplement once after a real receipt changes the loaded revision', async () =>
    withTestDb(async (tx) => {
      const repos = createRepositories(tx),
        user = await repos.users.upsertByExternal({ channel: 'telegram', externalId: 'p30-owner' }),
        group = await repos.groups.upsert({
          channel: 'telegram',
          externalId: '-p30-group',
          name: 'synthetic p30',
        });
      const first = await repos.messages.create({
        userId: user.id,
        groupId: group.id,
        externalId: 'initial',
        text: '狗岛找止痛药，现在急用，出不了门',
        receivedAt: new Date(),
      });
      const access = {
        userId: user.id,
        scope: { channel: 'telegram' as const, chatId: group.externalId },
      };
      const initial = await repos.tasks.create({
        access,
        sourceMessageId: first.id,
        intentKey: 'primary',
        objective: '找正规取药渠道',
        category: 'other',
      });
      const planned = await repos.tasks.applyUserTurn({
        access,
        id: initial.id,
        expectedRevision: initial.revision,
        operationKey: 'first',
        sourceMessageId: first.id,
        outcome: null,
        patch: {
          goals: [
            {
              id: 'medicine',
              title: '正规取药渠道',
              required: true,
              sourceQuote: '找止痛药',
              criteria: [{ id: 'channel', label: '正规药房渠道', strength: 'hard' }],
            },
          ],
          constraints: [
            {
              key: 'custom:needed_now',
              strength: 'hard',
              value: { kind: 'boolean', value: true },
              sourceQuote: '现在急用',
            },
            {
              key: 'custom:access_difficulty',
              strength: 'hard',
              value: { kind: 'text', text: '出不了门' },
              sourceQuote: '出不了门',
            },
          ],
        },
      });
      if (planned.kind !== 'applied') throw new Error('seed plan failed');
      const queued = await repos.tasks.queueDelivery({
        access,
        id: initial.id,
        expectedRevision: planned.task.revision,
        operationKey: 'queued',
        outboundMessageId: 'synthetic-outbound',
        delivery: { requirementsVersion: planned.task.requirementsVersion, level: 'partial' },
      });
      if (queued.kind !== 'applied') throw new Error('seed delivery failed');
      const loaded = queued.task;
      const receipt = await repos.tasks.recordDeliveryReceipt({
        access,
        id: initial.id,
        expectedRevision: loaded.revision,
        operationKey: 'receipt',
        outboundMessageId: 'synthetic-outbound',
        requirementsVersion: loaded.requirementsVersion,
        status: 'sent',
      });
      expect(receipt.kind).toBe('applied');
      const next = await repos.messages.create({
        userId: user.id,
        groupId: group.id,
        externalId: 'supplement',
        text: '头痛',
        receivedAt: new Date(),
      });
      const ctx: MatchContext = {
        userId: user.id,
        chatId: group.externalId,
        groupId: group.id,
        phase: 2,
        sourceMessageId: next.id,
        recentReplies: [],
        taskCandidates: [loaded],
      };
      bindCurrentRequest(ctx, '头痛');
      const tools = taskPlanningTools({ repos } as AgentDeps, '头痛', [loaded.id]);
      const update = tools.find((t) => t.name === 'update_task')!;
      await update.invoke(
        new RunContext(ctx),
        JSON.stringify({
          taskRef: loaded.id,
          referenceQuote: null,
          goals: [],
          constraints: [
            {
              goalId: 'medicine',
              key: 'custom:context',
              strength: 'preference',
              value: { kind: 'text', text: '头痛' },
              sourceQuote: '头痛',
            },
          ],
          outcome: null,
        }),
      );
      expect(ctx.task?.id).toBe(initial.id);
      expect(ctx.task?.constraints.map((c) => c.key)).toEqual(
        expect.arrayContaining(['custom:needed_now', 'custom:access_difficulty', 'custom:context']),
      );
      expect(ctx.quietSupplementTaskId).toBe(initial.id);
      expect(
        await tx.taskEvent.count({ where: { sourceMessageId: next.id, kind: 'user_turn' } }),
      ).toBe(1);
      expect(
        await tx.decisionTrace.count({
          where: {
            inputRef: next.id,
            output: { path: ['decision'], equals: 'operational_revision_refreshed' },
          },
        }),
      ).toBe(1);
    }));
});
