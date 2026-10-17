import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('redacts current-user request context in structured logs while retaining operational fields', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { createLogger } from './packages/shared/dist/logger.js';
    createLogger('redaction-test').info({ status: 'ok', requestContext: 'synthetic-private-one', state: { request_context: 'synthetic-private-two' }, api: { state: { request_context: 'synthetic-private-three' } } });
  `,
    ],
    { cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8' },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('"status":"ok"');
  expect(result.stdout).not.toContain('synthetic-private');
});
