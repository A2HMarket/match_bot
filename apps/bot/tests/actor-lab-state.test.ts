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
    expect(inbox.accept(other, '111')).toBeNull();
  expect(inbox.accept(reply, '111')).toBe('111');
  expect(inbox.accept(reply, '111')).toBeNull();
  expect(inbox.latest('111')?.text).toContain('预算');
  expect(inbox.forMessage('1', '111')?.messageId).toBe('2');
  expect(inbox.forMessage('unknown', '111')).toBeUndefined();
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

it('isolates identical basic-group message IDs in different bot accounts', () => {
  const inbox = new ActorLabInbox('-123', '999', new Date('2026-10-17T00:00:00Z'));
  for (const actor of ['111', '222']) inbox.registerSent('3', actor);
  const reply = {
    chatId: '-123',
    userId: '999',
    messageId: '4',
    replyToMessageId: '3',
    text: '预算？',
    receivedAt: '2026-10-17T00:00:01Z',
  };
  expect(inbox.accept(reply, '333')).toBeNull();
  expect(inbox.accept(reply, '111')).toBe('111');
  expect(inbox.accept({ ...reply, text: '入住时间？' }, '222')).toBe('222');
  expect(inbox.forMessage('3', '111')?.text).toBe('预算？');
  expect(inbox.forMessage('3', '222')?.text).toBe('入住时间？');
});

it('reserves a configured observed request cost before starting another user turn', () => {
  const limits = {
    maxMessages: 8,
    maxSeconds: 600,
    tokenBudget: 150907,
    minRemainingTokens: 120449,
  };
  expect(shouldStopActorLab(limits, { sent: 1, elapsedMs: 1, tokens: 40000, stopped: false })).toBe(
    'token_reserve',
  );
  expect(
    shouldStopActorLab(limits, { sent: 0, elapsedMs: 1, tokens: 0, stopped: false }),
  ).toBeNull();
});

it('feeds only delivery-confirmed public replies without inventing another bot account message ID', () => {
  const inbox = new ActorLabInbox('-123', '999', new Date('2026-10-18T00:00:00Z'));
  inbox.registerSent('3', '111');
  expect(
    inbox.acceptDelivered({
      actorId: '222',
      originalMessageId: '3',
      outboundId: 'main-out',
      text: '真实群回复',
    }),
  ).toBe(false);
  expect(
    inbox.acceptDelivered({
      actorId: '111',
      originalMessageId: '3',
      outboundId: 'main-out',
      text: '真实群回复',
    }),
  ).toBe(true);
  expect(inbox.latest('111')).toMatchObject({
    messageId: null,
    text: '真实群回复',
    observation: 'sent_outbound',
  });
  expect(
    inbox.acceptDelivered({
      actorId: '111',
      originalMessageId: '3',
      outboundId: 'main-out',
      text: '重复',
    }),
  ).toBe(false);
});
