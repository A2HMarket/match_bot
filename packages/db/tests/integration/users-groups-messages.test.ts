import { describe, expect, it } from 'vitest';
import { createRepositories } from '../../src/repos/index.js';
import { withTestDb } from './setup.js';

describe('users/groups/messages', () => {
  it('upsertByExternal is idempotent and records lang', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const a = await r.users.upsertByExternal({
        channel: 'telegram',
        externalId: '42',
        lang: 'ru',
      });
      const b = await r.users.upsertByExternal({ channel: 'telegram', externalId: '42' });
      expect(a.id).toBe(b.id);
      expect(b.languages).toContain('ru');
    });
  });
  it('messages.recentByUser returns newest first within window', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const u = await r.users.upsertByExternal({ channel: 'telegram', externalId: '7' });
      const g = await r.groups.upsert({ channel: 'telegram', externalId: '-100', name: 'test' });
      await r.messages.create({
        groupId: g.id,
        userId: u.id,
        externalId: '1',
        text: 'old',
        receivedAt: new Date(Date.now() - 48 * 3600e3),
      });
      await r.messages.create({
        groupId: g.id,
        userId: u.id,
        externalId: '2',
        text: 'new',
        receivedAt: new Date(),
      });
      const recent = await r.messages.recentByUser(u.id, 24);
      expect(recent.map((m) => m.text)).toEqual(['new']);
    });
  });
  it('redactOlderThan blanks text but keeps hash', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const u = await r.users.upsertByExternal({ channel: 'telegram', externalId: '8' });
      await r.messages.create({
        groupId: null,
        userId: u.id,
        externalId: '9',
        text: 'secret',
        receivedAt: new Date(Date.now() - 40 * 86400e3),
      });
      expect(await r.messages.redactOlderThan(30)).toBe(1);
      const m = (await r.messages.recentByUser(u.id, 24 * 60))[0]!;
      expect(m.text).toBe('');
      expect(m.textHash).toHaveLength(64);
    });
  });
});
