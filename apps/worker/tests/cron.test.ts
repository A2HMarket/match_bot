import { describe, expect, it, vi } from 'vitest';
import { CRON_JOBS, runCronJob, scheduleCron } from '../src/cron.js';

function repos() {
  return {
    messages: { redactOlderThan: vi.fn(() => Promise.resolve(3)) },
    demands: { expireOlderThan: vi.fn(() => Promise.resolve(2)) },
    runStates: { expireOld: vi.fn(() => Promise.resolve(1)) },
    tasks: { deleteInactiveBefore: vi.fn((_cutoff: Date) => Promise.resolve(2)) },
    outbound: { redactDeliveryReceiptsBefore: vi.fn((_cutoff: Date) => Promise.resolve(1)) },
  };
}
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('scheduleCron', () => {
  // BullMQ 6：`repeat` 不再是 Queue.add 的合法选项，必须走 upsertJobScheduler
  // （node_modules/bullmq/dist/esm/types/job-options.d.ts）。
  it('upserts one job scheduler per cron job, keyed by job name', async () => {
    const cron = { upsertJobScheduler: vi.fn(() => Promise.resolve({})), add: vi.fn() };
    await scheduleCron({ cron } as never);
    expect(cron.add).not.toHaveBeenCalled();
    expect(cron.upsertJobScheduler).toHaveBeenCalledTimes(Object.keys(CRON_JOBS).length);
    expect(cron.upsertJobScheduler).toHaveBeenCalledWith(
      CRON_JOBS.redactMessages.name,
      { every: CRON_JOBS.redactMessages.every },
      { name: CRON_JOBS.redactMessages.name, data: {} },
    );
  });
});

describe('runCronJob', () => {
  it.each([
    [CRON_JOBS.redactMessages.name, 'messages', 'redactOlderThan'],
    [CRON_JOBS.expireDemands.name, 'demands', 'expireOlderThan'],
    [CRON_JOBS.expireRunStates.name, 'runStates', 'expireOld'],
    ['delete_inactive_tasks', 'tasks', 'deleteInactiveBefore'],
    ['redact_delivery_receipts', 'outbound', 'redactDeliveryReceiptsBefore'],
  ])('%s calls the matching repository method', async (name, repo, method) => {
    const r = repos();
    await runCronJob(name, r as never, logger() as never);
    const fn = (r as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>)[repo]?.[
      method
    ];
    expect(fn).toHaveBeenCalled();
  });

  it('unknown job names warn instead of throwing', async () => {
    const log = logger();
    await runCronJob('nope', repos() as never, log as never);
    expect(log.warn).toHaveBeenCalledWith({ name: 'nope' }, 'unknown cron job');
  });
  it('deletes task personal data after 30 inactive days using a bounded cutoff', async () => {
    const r = repos();
    const before = Date.now();
    await runCronJob('delete_inactive_tasks', r as never, logger() as never);
    const cutoff = r.tasks.deleteInactiveBefore.mock.calls[0]?.[0];
    expect(cutoff).toBeInstanceOf(Date);
    expect(cutoff?.getTime()).toBeGreaterThanOrEqual(before - 30 * 86400e3);
    expect(cutoff?.getTime()).toBeLessThanOrEqual(Date.now() - 30 * 86400e3);
  });
});
