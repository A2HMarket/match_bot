/** No model/API credentials. Real worker/SDK/isolated PG contract; provide only a named regression fault. */
import { startVitest } from 'vitest/node';
import { readFileSync } from 'node:fs';
import { taskConversationsSchema } from '../../../packages/eval/src/task-contract.js';
const expectedCount = taskConversationsSchema.parse(
  JSON.parse(
    readFileSync(
      new URL('../../../packages/eval/fixtures/task-agent/conversations.json', import.meta.url),
      'utf8',
    ),
  ),
).cases.length;
type TaskNode = { type: string; result?: { state: string }; tasks?: readonly TaskNode[] };
function passedTests(tasks: readonly TaskNode[]): number {
  return tasks.reduce(
    (sum, task) =>
      sum +
      (task.type === 'test' && task.result?.state === 'pass' ? 1 : 0) +
      passedTests(task.tasks ?? []),
    0,
  );
}
const flag = process.argv[2];
if (flag && flag !== '--inject-drop-chair') throw new Error('unsupported contract fault');
const ctx = await startVitest(['apps/worker/tests/e2e/task-conversations.test.ts'], {
  run: true,
  provide: { taskContractFault: flag ? 'drop-chair' : 'none' },
  reporters: ['default', 'json'],
  outputFile: {
    json: flag
      ? '/tmp/matchbot-task-contract-injected-results.json'
      : '/tmp/matchbot-task-contract-results.json',
  },
});
try {
  const failed =
    ctx.state.getFiles().length !== 1 ||
    ctx.state.getFiles().reduce((sum, file) => sum + passedTests(file.tasks), 0) !==
      expectedCount ||
    ctx.state.getFiles().some((file) => file.result?.state === 'fail') ||
    ctx.state.getUnhandledErrors().length > 0;
  process.exitCode = failed ? 1 : 0;
} finally {
  await ctx.close();
}
