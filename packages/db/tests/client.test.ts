import { expect, it } from 'vitest';
import { createPrisma, getPrisma, disconnectPrisma } from '../src/client.js';
it('keeps singleton compatibility while isolated factories remain independent', async () => {
  const url = 'postgresql://local:local@127.0.0.1:5432/unused';
  const a = createPrisma(url),
    b = createPrisma(url);
  expect(a).not.toBe(b);
  expect(getPrisma(url)).toBe(getPrisma(url));
  expect(a).not.toBe(getPrisma(url));
  await Promise.all([a.$disconnect(), b.$disconnect(), disconnectPrisma()]);
});
