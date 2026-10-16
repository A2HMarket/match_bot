import { describe, expect, it } from 'vitest';
import { taskSchema } from '@matchbot/domain';
import { groundTaskConfirmation } from '../src/task-confirmation.js';

const task = taskSchema.parse({
  id: 't',
  ownerUserId: 'u',
  scope: { channel: 'telegram', chatId: 'c' },
  objective: '买桌椅',
  category: 'second_hand',
  status: 'active',
  revision: 0,
  goals: ['desk', 'chair'].map((id) => ({
    id,
    title: id,
    required: true,
    criteria: [
      { id: 'fit', label: '符合条件', strength: 'hard', status: 'unknown', evidenceRefs: [] },
    ],
  })),
  evidence: [],
  pendingQuestion: null,
  blockReason: null,
  delivery: { status: 'none', level: 'none' },
  userConfirmation: null,
});
describe('user outcome grounding', () => {
  const p = {
    task,
    userId: 'u',
    messageId: 'm',
    text: '桌椅都买到了，这个需求解决了',
    quote: '这个需求解决了',
    intent: 'achieved' as const,
  };
  it('grounds an explicit whole-task result in the current owner message', () => {
    expect(groundTaskConfirmation(p)).toEqual({
      kind: 'user',
      userId: 'u',
      messageId: 'm',
      intent: 'achieved',
    });
    expect(
      groundTaskConfirmation({
        ...p,
        text: '不找了，取消这个需求',
        quote: '取消这个需求',
        intent: 'cancelled',
      }).intent,
    ).toBe('cancelled');
  });
  it.each([
    '谢谢',
    '这个挺好',
    '如果买到了就告诉你',
    '买到了的话再说',
    '还没买到',
    '已经买到了吗？',
    'I will buy it',
    'if I found it',
  ])('does not turn %s into completion', (text) => {
    expect(() => groundTaskConfirmation({ ...p, text, quote: text })).toThrow('confirmation');
  });
  it('cannot strip conditionals from the sentence or use a foreign owner', () => {
    expect(() =>
      groundTaskConfirmation({
        ...p,
        text: '如果买到了就告诉你',
        quote: '买到了',
        goalId: 'chair',
      }),
    ).toThrow('confirmation');
    expect(() => groundTaskConfirmation({ ...p, userId: 'other' })).toThrow('owner');
    expect(() => groundTaskConfirmation({ ...p, quote: '全都买到了' })).toThrow('confirmation');
  });
  it('records a single subgoal without claiming the whole task is solved', () => {
    expect(
      groundTaskConfirmation({
        ...p,
        text: '椅子买到了，桌子继续找',
        quote: '椅子买到了',
        goalId: 'chair',
      }).intent,
    ).toBe('achieved');
    expect(() =>
      groundTaskConfirmation({ ...p, text: '椅子买到了，桌子继续找', quote: '椅子买到了' }),
    ).toThrow('whole-task');
    expect(() => groundTaskConfirmation({ ...p, goalId: 'unknown' })).toThrow('goal');
  });
});
