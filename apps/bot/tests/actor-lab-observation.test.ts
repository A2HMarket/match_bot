import { expect, it, vi } from 'vitest';
import type { Repositories } from '@matchbot/db';
import { observeActorMessage, observeActorMessages } from '../src/actor-lab-runtime.js';

it('correlates sender ID 3 to receiver ID 263, scoped by author, group, text and time', async () => {
  const at = new Date();
  const message = {
    id: 'main-263',
    externalId: '263',
    userId: 'user-111',
    groupId: 'group',
    text: '找书桌',
    receivedAt: at,
  };
  const recent = vi.fn().mockResolvedValue([message]);
  const repos = {
    groups: { findByExternal: vi.fn().mockResolvedValue({ id: 'group' }) },
    users: { findByExternal: vi.fn().mockResolvedValue({ id: 'user-111' }) },
    messages: { recentByUser: recent },
  } as unknown as Repositories;
  const p = { groupId: '-123', actorId: '111', text: '找书桌', sentAt: at };
  expect((await observeActorMessage(repos, p))?.id).toBe('main-263');
  expect(recent).toHaveBeenCalledWith('user-111', 1, { groupId: 'group' });
  expect(await observeActorMessage(repos, { ...p, text: '找房' })).toBeNull();
  expect(
    await observeActorMessage(repos, { ...p, sentAt: new Date(at.getTime() + 60000) }),
  ).toBeNull();
  recent.mockResolvedValue([message, { ...message, id: 'duplicate' }]);
  expect(await observeActorMessage(repos, p)).toBeNull();
  recent.mockResolvedValue([
    message,
    { ...message, userId: 'other' },
    { ...message, groupId: 'other' },
  ]);
  expect(
    await observeActorMessages(repos, {
      groupId: '-123',
      actorIds: ['111'],
      since: new Date(at.getTime() - 1000),
    }),
  ).toEqual([message]);
  recent.mockResolvedValue(Array.from({ length: 50 }, () => message));
  await expect(
    observeActorMessages(repos, { groupId: '-123', actorIds: ['111'], since: at }),
  ).rejects.toThrow('truncated');
});
