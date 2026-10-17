import { afterAll, expect, it } from 'vitest';
import { disconnectPrisma } from '@matchbot/db';
import { envSchema } from '@matchbot/shared';
import { buildDeps } from '../src/deps.js';

afterAll(disconnectPrisma);
it('enables persisted task execution in the actual worker assembly used by inbound and resume', () => {
  const deps = buildDeps({
    env: envSchema.parse({
      DATABASE_URL: 'postgresql://matchbot:matchbot@127.0.0.1:5432/matchbot_task_test',
      REDIS_URL: 'redis://127.0.0.1:6379/15',
      DEEPSEEK_API_KEY: 'synthetic',
      JEV_API_KEY: 'synthetic',
      TELEGRAM_BOT_TOKEN: 'synthetic',
      TELEGRAM_OPS_CHAT_ID: '-999',
      SNAPSHOT_KEY: 'synthetic-worker-assembly-key',
      LOG_LEVEL: 'error',
    }),
  });
  expect(deps.answerRequests).toBe(true);
  expect(deps.taskRequests).toBe(true);
  expect(deps.repos.tasks).toBeDefined();
  expect(deps.repos.executions).toBeDefined();
});
