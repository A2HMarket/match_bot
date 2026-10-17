import { expect, it } from 'vitest';
import { createRepositories } from '../../src/repos/index.js';
import { withTestDb } from './setup.js';

it('reloads task search vocabulary across turns without changing user requirements or sharing it across owners', async () =>
  withTestDb(async (tx) => {
    const r = createRepositories(tx),
      owner = await r.users.upsertByExternal({
        channel: 'telegram',
        externalId: 'search-vocabulary-owner',
      }),
      message = await r.messages.create({
        userId: owner.id,
        groupId: null,
        externalId: '1',
        text: '找书桌，预算50镑',
        receivedAt: new Date(),
      }),
      access = {
        userId: owner.id,
        scope: { channel: 'telegram' as const, chatId: owner.externalId },
      },
      planned = await r.tasks.planTurn({
        access,
        sourceMessageId: message.id,
        expectedRevision: 0,
        taskId: null,
        creation: {
          objective: '收书桌',
          category: 'second_hand',
          counterparty: 'supply',
          intentKey: 'primary',
        },
        patch: {
          goals: [
            {
              id: 'desk',
              title: '书桌候选',
              required: true,
              sourceQuote: '书桌',
              criteria: [{ id: 'subject', label: '书桌', strength: 'hard' }],
            },
          ],
          constraints: [
            {
              key: 'budget',
              strength: 'hard',
              value: { kind: 'money', amountPence: 5000, unit: 'item' },
              sourceQuote: '50镑',
            },
          ],
        },
        outcome: null,
      });
    if (planned.kind !== 'applied') throw new Error('missing task');
    const data = {
        access,
        id: planned.task.id,
        sourceMessageId: message.id,
        requirementsVersion: planned.task.requirementsVersion,
        operationKey: 'public-search-vocabulary',
        hints: [{ goalId: 'desk', terms: ['书桌', 'desk'] }],
      },
      saved = await r.tasks.rememberSearchTerms(data);
    expect(saved).toMatchObject({
      kind: 'applied',
      task: { requirementsVersion: planned.task.requirementsVersion, userConfirmation: null },
    });
    expect((await r.tasks.rememberSearchTerms(data)).kind).toBe('replayed');
    const reloaded = await createRepositories(tx).tasks.findById({ access, id: planned.task.id });
    expect(reloaded?.goals[0]?.searchTerms).toEqual(['书桌', 'desk']);
    expect(reloaded?.constraints).toEqual(planned.task.constraints);
    const next = await r.messages.create({
      userId: owner.id,
      groupId: null,
      externalId: '2',
      text: '预算70镑',
      receivedAt: new Date(),
    });
    const updated = await r.tasks.applyUserTurn({
      access,
      id: planned.task.id,
      expectedRevision: reloaded!.revision,
      operationKey: 'budget-update',
      sourceMessageId: next.id,
      patch: {
        goals: [],
        constraints: [
          {
            key: 'budget',
            strength: 'hard',
            value: { kind: 'money', amountPence: 7000, unit: 'item' },
            sourceQuote: '70镑',
          },
        ],
      },
      outcome: null,
    });
    expect(updated).toMatchObject({
      kind: 'applied',
      task: { goals: [expect.objectContaining({ searchTerms: ['书桌', 'desk'] })] },
    });
    await expect(
      r.tasks.rememberSearchTerms({ ...data, operationKey: 'stale-vocabulary' }),
    ).rejects.toThrow('requirements');
    expect(
      (
        await r.tasks.rememberSearchTerms({
          ...data,
          access: { ...access, userId: 'foreign-owner' },
          operationKey: 'foreign',
        })
      ).kind,
    ).toBe('not_found');
  }));
