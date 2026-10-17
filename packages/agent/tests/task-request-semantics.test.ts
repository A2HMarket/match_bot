import { expect, it } from 'vitest';
import { taskSchema, type TaskConstraint } from '@matchbot/domain';
import { taskCurrentRequest } from '../src/task-request.js';

function request(key: string, value: TaskConstraint['value']) {
  const task = taskSchema.parse({
    id: 't',
    ownerUserId: 'u',
    scope: { channel: 'telegram', chatId: 'c' },
    objective: '找房',
    category: 'housing',
    status: 'active',
    revision: 0,
    goals: [
      {
        id: 'home',
        title: '一居室',
        required: true,
        criteria: [
          { id: 'fit', label: '房源', strength: 'hard', status: 'unknown', evidenceRefs: [] },
        ],
      },
    ],
    constraints: [
      { key, value, strength: 'hard', origin: { kind: 'user', sourceMessageId: 'initial' } },
    ],
    evidence: [],
    pendingQuestion: null,
    blockReason: null,
    delivery: { status: 'none', level: 'none' },
    userConfirmation: null,
  });
  return taskCurrentRequest(
    {
      task,
      userId: 'u',
      chatId: 'c',
      groupId: null,
      phase: 0,
      sourceMessageId: 'next',
      recentReplies: [],
    },
    '继续看',
  )!.text;
}
it('projects a broad date range as an acceptable window rather than a required earliest date', () => {
  expect(
    request('move_in_date', { kind: 'date_range', from: '2026-11-01', to: '2026-11-30' }),
  ).toContain('acceptable window');
});
it('keeps an exact date distinct from a flexible range', () => {
  const text = request('move_in_date', {
    kind: 'date_range',
    from: '2026-11-05',
    to: '2026-11-05',
  });
  expect(text).toContain('exact requested date');
  expect(text).not.toContain('acceptable window');
});
it('does not turn a travel duration cap into a return-trip limit', () => {
  expect(request('max_travel_minutes', { kind: 'duration', minutes: 30 })).toContain(
    'do not infer a round trip',
  );
  expect(request('custom:service_duration', { kind: 'duration', minutes: 30 })).not.toContain(
    'round trip',
  );
});
