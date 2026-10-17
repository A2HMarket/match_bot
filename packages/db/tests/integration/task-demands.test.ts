import { expect, it } from 'vitest';
import { createRepositories } from '../../src/repos/index.js';
import { withTestDb } from './setup.js';

it('keeps two same-category tasks separate and reuses only the selected task demand', async () =>
  withTestDb(async (tx) => {
    expect(typeof tx.$connect).toBe('undefined');
    const r = createRepositories(tx),
      user = await r.users.upsertByExternal({
        channel: 'telegram',
        externalId: 'task-demand-owner',
      }),
      access = {
        userId: user.id,
        scope: { channel: 'telegram' as const, chatId: user.externalId },
      };
    async function plan(id: string, text: string) {
      const source = await r.messages.create({
        userId: user.id,
        groupId: null,
        externalId: id,
        text,
        receivedAt: new Date(),
      });
      const result = await r.tasks.planTurn({
        access,
        sourceMessageId: source.id,
        expectedRevision: 0,
        taskId: null,
        creation: {
          objective: text,
          category: 'man_and_van',
          counterparty: null,
          intentKey: 'primary',
        },
        patch: {
          goals: [
            {
              id: 'move',
              title: '搬家服务',
              required: true,
              sourceQuote: '搬家',
              criteria: [{ id: 'subject', label: '搬家服务', strength: 'hard' }],
            },
          ],
          constraints: [],
        },
        outcome: null,
      });
      if (result.kind !== 'applied') throw new Error('missing task');
      return { task: result.task, source };
    }
    const first = await plan('1', '周六搬家'),
      second = await plan('2', '周日搬家'),
      draft = {
        category: 'man_and_van' as const,
        need: 'moving service',
        confidence: 1,
        whenText: '周六',
        budgetPence: 10000,
      },
      a = await r.demands.recordForTask({
        access,
        taskId: first.task.id,
        requirementsVersion: first.task.requirementsVersion,
        sourceMessageId: first.source.id,
        draft,
      }),
      b = await r.demands.recordForTask({
        access,
        taskId: second.task.id,
        requirementsVersion: second.task.requirementsVersion,
        sourceMessageId: second.source.id,
        draft: { ...draft, whenText: '周日' },
      });
    expect(a.id).not.toBe(b.id);
    expect(a.taskId).toBe(first.task.id);
    expect(b.taskId).toBe(second.task.id);
    const again = await r.demands.recordForTask({
      access,
      taskId: first.task.id,
      requirementsVersion: first.task.requirementsVersion,
      sourceMessageId: first.source.id,
      draft: { ...draft, quantity: '几个箱子' },
    });
    expect(again.id).toBe(a.id);
    expect(await tx.demand.findUnique({ where: { id: b.id } })).toMatchObject({
      whenText: '周日',
      quantity: null,
    });
    await expect(
      r.demands.recordForTask({
        access,
        taskId: first.task.id,
        requirementsVersion: first.task.requirementsVersion + 1,
        sourceMessageId: first.source.id,
        draft,
      }),
    ).rejects.toThrow('task');
    await expect(
      r.demands.recordForTask({
        access: { ...access, userId: 'foreign-owner' },
        taskId: first.task.id,
        requirementsVersion: first.task.requirementsVersion,
        sourceMessageId: first.source.id,
        draft,
      }),
    ).rejects.toThrow('task');
    await expect(
      r.demands.recordForTask({
        access,
        taskId: first.task.id,
        requirementsVersion: first.task.requirementsVersion,
        sourceMessageId: second.source.id,
        draft,
      }),
    ).rejects.toThrow('turn');
    const done = await r.messages.create({
        userId: user.id,
        groupId: null,
        externalId: '3',
        text: '周六搬家解决了',
        receivedAt: new Date(),
      }),
      current = await r.tasks.findById({ access, id: first.task.id });
    await r.tasks.applyUserTurn({
      access,
      id: first.task.id,
      expectedRevision: current!.revision,
      operationKey: 'owner-solved',
      sourceMessageId: done.id,
      patch: null,
      outcome: { intent: 'achieved', goalIds: [] },
    });
    expect(await tx.demand.findUnique({ where: { id: a.id } })).toMatchObject({ status: 'closed' });
    expect(await tx.demand.findUnique({ where: { id: b.id } })).toMatchObject({ status: 'open' });
  }));
