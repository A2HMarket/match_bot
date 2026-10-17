import { describe, expect, it } from 'vitest';
import { canSkipSupplementReply, isContextSupplement } from '../src/supplement-replies.js';
import { taskSchema } from '@matchbot/domain';
import type { MatchContext } from '../src/context.js';
describe('quiet context additions', () => {
  it.each(['头痛', '坐地铁', 'USB-C', 'Headache'])(
    'recognizes background without a new action: %s',
    (text) => expect(isContextSupplement(text)).toBe(true),
  );
  it.each([
    '头痛怎么办？',
    '帮我查能送药的',
    '突然剧烈头痛',
    'I need medical help',
    '严重不舒服',
    '头痛手脚麻木',
    'Headache with numbness',
  ])('does not grant quiet for a new question or danger signal: %s', (text) =>
    expect(isContextSupplement(text)).toBe(false),
  );
  it('requires server-bound same owner, conversation and continued task', () => {
    const ctx = {
      userId: 'u',
      chatId: 'g',
      groupId: null,
      sourceMessageId: 'm',
      recentReplies: [],
      phase: 2,
      quietSupplementTaskId: 't',
      taskUpdate: { kind: 'continued' },
      task: taskSchema.parse({
        id: 't',
        ownerUserId: 'u',
        scope: { channel: 'telegram', chatId: 'g' },
        objective: '找药',
        status: 'active',
        revision: 1,
        goals: [],
        constraints: [],
        evidence: [],
        pendingQuestion: null,
        blockReason: null,
        delivery: { status: 'none', level: 'none' },
        userConfirmation: null,
      }),
    } as MatchContext;
    expect(canSkipSupplementReply(ctx)).toBe(true);
    expect(canSkipSupplementReply({ ...ctx, userId: 'other' })).toBe(false);
    expect(canSkipSupplementReply({ ...ctx, chatId: 'other' })).toBe(false);
    expect(canSkipSupplementReply({ ...ctx, taskUpdate: { kind: 'new' } })).toBe(false);
  });
});
