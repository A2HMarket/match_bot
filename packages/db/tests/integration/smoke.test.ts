import { describe, expect, it } from 'vitest';
import { withTestDb } from './setup.js';

describe('db smoke', () => {
  it('can insert and read a user inside a rolled-back tx', async () => {
    await withTestDb(async (tx) => {
      const u = await tx.user.create({
        data: { channel: 'telegram', externalId: '1', languages: ['en'], lastSeenAt: new Date() },
      });
      expect((await tx.user.findUnique({ where: { id: u.id } }))?.externalId).toBe('1');
    });
  });
});
