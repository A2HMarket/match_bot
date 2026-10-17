import { describe, expect, it } from 'vitest';
import { createRepositories } from '../../src/repos/index.js';
import { withTestDb } from './setup.js';
describe('actor scoped usage', () => {
  it('sums only the selected run refs and reports missing usage', async () =>
    withTestDb(async (tx) => {
      const repos = createRepositories(tx);
      const since = new Date(Date.now() - 1000);
      for (const [inputRef, output] of [
        ['actor:one', { inputTokens: 100, outputTokens: 20 }],
        ['actor:one', {}],
        ['unrelated', { inputTokens: 99999, outputTokens: 9 }],
      ] as const)
        await repos.traces.create({
          kind: 'agent_run',
          inputRef,
          output,
          phase: 0,
          costMicro: 0,
          latencyMs: 0,
        });
      expect(await repos.traces.summarizeUsage({ since, inputRefs: ['actor:one'] })).toEqual({
        calls: 2,
        inputTokens: 100,
        outputTokens: 20,
        missingUsageCalls: 1,
      });
      expect((await repos.traces.summarizeUsage({ since, inputRefs: [] })).calls).toBe(0);
    }));
});

it('changes only the exact requested group policy and finds actors read-only', async () =>
  withTestDb(async (tx) => {
    const repos = createRepositories(tx);
    await repos.groups.upsert({ channel: 'telegram', externalId: '-actor-test', name: 'A2H 测试' });
    const other = await repos.groups.upsert({
      channel: 'telegram',
      externalId: '-other-test',
      name: 'Other',
    });
    await repos.groups.setPolicy({
      channel: 'telegram',
      externalId: '-actor-test',
      isActive: true,
      phase: 2,
      rateLimitPerDay: 30,
    });
    expect((await repos.groups.findByExternal('telegram', '-actor-test'))?.phase).toBe(2);
    expect(await repos.groups.findByExternal('telegram', '-other-test')).toEqual(other);
    expect(await repos.users.findByExternal('telegram', 'missing-actor')).toBeNull();
  }));
