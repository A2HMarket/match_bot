import { expect, it } from 'vitest';
import { taskSchema } from '@matchbot/domain';
import { taskCurrentRequest } from '../src/task-request.js';

it('rebuilds service time, route and volume from the selected task without using another request', () => {
  const task = taskSchema.parse({
    id: 'moving',
    ownerUserId: 'owner',
    scope: { channel: 'telegram', chatId: '-1' },
    objective: '搬家',
    category: 'man_and_van',
    status: 'active',
    revision: 1,
    goals: [
      {
        id: 'move',
        title: '搬家服务',
        required: true,
        criteria: [
          {
            id: 'source',
            label: '搬家服务',
            strength: 'hard',
            status: 'unknown',
            evidenceRefs: [],
          },
        ],
      },
    ],
    constraints: [
      {
        key: 'route_from',
        strength: 'hard',
        value: { kind: 'location', area: 'E14' },
        origin: { kind: 'user', sourceMessageId: 'first' },
      },
      {
        key: 'route_to',
        strength: 'hard',
        value: { kind: 'location', area: 'N1' },
        origin: { kind: 'user', sourceMessageId: 'first' },
      },
      {
        key: 'date',
        strength: 'hard',
        value: { kind: 'date_range', from: '2026-11-05', to: '2026-11-05' },
        origin: { kind: 'user', sourceMessageId: 'first' },
      },
      {
        key: 'time',
        strength: 'hard',
        value: { kind: 'text', text: '下午' },
        origin: { kind: 'user', sourceMessageId: 'first' },
      },
      {
        key: 'quantity',
        strength: 'hard',
        value: { kind: 'text', text: '几个箱子' },
        origin: { kind: 'user', sourceMessageId: 'first' },
      },
    ],
    evidence: [],
    pendingQuestion: null,
    blockReason: null,
    delivery: { status: 'none', level: 'none' },
    userConfirmation: null,
  });
  const result = taskCurrentRequest(
    {
      userId: 'owner',
      chatId: '-1',
      groupId: null,
      phase: 0,
      sourceMessageId: 'next',
      recentReplies: [],
      task,
      demand: {
        category: 'man_and_van',
        confidence: 1,
        fromPostcode: 'SW1',
        whenText: '周日',
        quantity: '另一家的家具',
      },
    },
    '还有哪些选择',
  );
  expect(result?.demand).toMatchObject({
    fromPostcode: 'E14',
    toPostcode: 'N1',
    quantity: '几个箱子',
  });
  expect(result?.demand.whenText).toContain('2026-11-05');
  expect(result?.demand.whenText).toContain('下午');
  expect(result?.demand.whenText).not.toContain('周日');
  expect(result?.demand.whenAt).toBeUndefined();
});
