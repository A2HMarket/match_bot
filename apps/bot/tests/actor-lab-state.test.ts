import { describe, expect, it } from 'vitest';
import {
  actorRoute,
  shouldStopActorLab,
  ActorLabInbox,
  splitActorTurn,
} from '../src/actor-lab-state.js';
describe('bounded actor controller', () => {
  const limits = { maxMessages: 6, maxSeconds: 600, tokenBudget: 150000 };
  it.each([
    { sent: 6, elapsedMs: 1, tokens: 0, stopped: false },
    { sent: 1, elapsedMs: 600000, tokens: 0, stopped: false },
    { sent: 1, elapsedMs: 1, tokens: 150000, stopped: false },
    { sent: 1, elapsedMs: 1, tokens: 0, stopped: true },
  ])('stops at each bound: %j', (state) =>
    expect(shouldStopActorLab(limits, state)).not.toBeNull(),
  );
  it('permits a finite active step', () =>
    expect(
      shouldStopActorLab(limits, { sent: 1, elapsedMs: 1, tokens: 1000, stopped: false }),
    ).toBeNull());
  it('routes only current-run actors to the fixed test group', () => {
    const ids = ['111', '222', '333'];
    expect(
      actorRoute({ target: '-123', toolCallId: 'actor:111:run-one:0' }, '-123', 'run-one', ids),
    ).toBe('111');
    for (const row of [
      { target: '-999', toolCallId: 'actor:111:run-one:0' },
      { target: '-123', toolCallId: 'actor:999:run-one:0' },
      { target: '-123', toolCallId: 'actor:111:old-run:0' },
    ])
      expect(() => actorRoute(row, '-123', 'run-one', ids)).toThrow();
  });
});

it('accepts only current-run replies and deduplicates updates seen by several actor bots', () => {
  const inbox = new ActorLabInbox('-123', '999', new Date('2026-10-17T00:00:00Z'));
  inbox.registerSent('1', '111');
  const reply = {
    chatId: '-123',
    userId: '999',
    messageId: '2',
    replyToMessageId: '1',
    text: '问一下你的预算？',
    receivedAt: '2026-10-17T00:00:01Z',
  };
  for (const other of [
    { ...reply, userId: 'human' },
    { ...reply, chatId: '-other' },
    { ...reply, replyToMessageId: 'old' },
    { ...reply, receivedAt: '2026-10-16T23:59:59Z' },
  ])
    expect(inbox.accept(other)).toBeNull();
  expect(inbox.accept(reply)).toBe('111');
  expect(inbox.accept(reply)).toBeNull();
  expect(inbox.latest('111')?.text).toContain('预算');
  expect(inbox.forMessage('1')?.messageId).toBe('2');
  expect(inbox.forMessage('unknown')).toBeUndefined();
});

it('splits only a bounded short-actor followup without dropping constraints', () => {
  expect(splitActorTurn('单程半小时以内，我坐地铁', true, 2)).toEqual([
    '单程半小时以内',
    '我坐地铁',
  ]);
  expect(splitActorTurn('单程半小时以内，我坐地铁', true, 1)).toHaveLength(1);
  expect(splitActorTurn('总预算1,600镑', true, 2)).toEqual(['总预算1,600镑']);
  expect(splitActorTurn('我养猫，预算不变', false, 2)).toHaveLength(1);
});
