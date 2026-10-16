/** Synthetic fixed inputs, real DeepSeek + isolated DB. Preparation tools only: no Telegram, search or transaction actions. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  configureModelProvider,
  createTraceProcessor,
  createMatchAgent,
  AGENT_VERSION,
} from '../../../packages/agent/src/index.js';
import type { AgentDeps, MatchContext } from '../../../packages/agent/src/context.js';
import { createRepositories, getPrisma, disconnectPrisma } from '../../../packages/db/src/index.js';
import { loadEnv, createLogger } from '../../../packages/shared/src/index.js';
import { DEFAULT_THRESHOLDS } from '../../../packages/gating/src/index.js';
import { z } from 'zod';

const env = loadEnv();
const destination = new URL(env.DATABASE_URL);
if (destination.hostname !== '127.0.0.1' || destination.pathname !== '/matchbot_task_preview')
  throw new Error('P25 preview requires the isolated local matchbot_task_preview database');
const logger = createLogger('p25-task-preview', 'warn');
const repos = createRepositories(getPrisma(env.DATABASE_URL));
const processor = createTraceProcessor({ traces: repos.traces, logger });
configureModelProvider(env, [processor]);
const deps: AgentDeps = {
  env,
  repos,
  logger,
  thresholds: DEFAULT_THRESHOLDS,
  answerRequests: true,
  taskRequests: true,
  jev: { evaluate: () => Promise.reject(new Error('preparation preview has no Jev calls')) },
  evaluateOutbound: () =>
    Promise.reject(new Error('preparation preview refuses outbound evaluation')),
};
const cases = [
  {
    id: 'desk_chair',
    inputs: ['E14想收书桌和办公椅，每件50镑以内，能自提。', '桌子可以到70镑，椅子还是50'],
  },
  {
    id: 'cat_housing',
    inputs: [
      '想在Stratford找一居室，月租1600镑以内，11月入住，我有一只猫。',
      '11月5日入住，猫一定要能养，包账单更好，但不增加预算。',
    ],
  },
  { id: 'beginner_badminton', inputs: ['我住E14，周末想找适合初学者的羽毛球搭子。', '半小时以内'] },
];
const runId = randomUUID();
const sourceHash = createHash('sha256');
for (const root of ['packages/agent/src', 'packages/domain/src', 'packages/db/src/repos']) {
  for (const name of readdirSync(root, { recursive: true })
    .filter((name) => name.endsWith('.ts'))
    .sort()) {
    sourceHash.update(root + '/' + name);
    sourceHash.update(readFileSync(join(root, name)));
  }
}
sourceHash.update(readFileSync('pnpm-lock.yaml'));
const sourceFingerprint = sourceHash.digest('hex');
const outputPath = process.argv[2] ?? '/tmp/matchbot-p25-plan-preview.json';
const results: unknown[] = [];
const started = Date.now();
const save = (status: string) =>
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        runId,
        sourceFingerprint,
        agentVersion: AGENT_VERSION,
        model: env.DEEPSEEK_MODEL,
        status,
        elapsedMs: Date.now() - started,
        boundary: 'synthetic user inputs; real model and isolated DB; no search, Jev or Telegram',
        results,
      },
      null,
      2,
    ),
  );
const watchdog = setTimeout(() => {
  save('timeout');
  process.exit(2);
}, 300000);
try {
  for (const scenario of cases.filter((c) => !process.argv[3] || c.id === process.argv[3])) {
    const user = await repos.users.upsertByExternal({
      channel: 'telegram',
      externalId: `p25-preview-${runId}-${scenario.id}`,
    });
    const group = await repos.groups.upsert({
      channel: 'telegram',
      externalId: `-p25-preview-${runId}-${scenario.id}`,
      name: 'synthetic task preview',
    });
    for (const [index, input] of scenario.inputs.entries()) {
      const message = await repos.messages.create({
        userId: user.id,
        groupId: group.id,
        externalId: 'turn-' + index,
        text: input,
        receivedAt: new Date(),
      });
      const ctx: MatchContext = {
        userId: user.id,
        chatId: group.externalId,
        groupId: group.id,
        channel: 'telegram',
        phase: 0,
        sourceMessageId: message.id,
        recentReplies: [],
        taskCandidates: await repos.tasks.findOpenByScope({
          userId: user.id,
          scope: { channel: 'telegram', chatId: group.externalId },
        }),
      };
      const t0 = Date.now();
      try {
        const { agent, runner } = createMatchAgent(deps, {
          phase: 0,
          input,
          inputRef: message.id,
          taskPlanningOnly: true,
          taskRefs: ctx.taskCandidates?.map((task) => task.id) ?? [],
        });
        const result = await runner.run(agent, input, {
          context: ctx,
          maxTurns: 2,
          signal: AbortSignal.timeout(45000),
        });
        await processor.forceFlush();
        results.push({
          scenario: scenario.id,
          turn: index,
          input,
          elapsedMs: Date.now() - t0,
          update: ctx.taskUpdate,
          task: ctx.task,
          failures: ctx.taskPlanFailures ?? 0,
          calls: result.newItems
            .filter((item) => item.type === 'tool_call_item')
            .map((item) => item.rawItem),
        });
      } catch (error) {
        let calls: unknown[] = [];
        if (
          error instanceof Error &&
          'state' in error &&
          error.state &&
          typeof error.state === 'object' &&
          'toJSON' in error.state &&
          typeof error.state.toJSON === 'function'
        ) {
          const saved = z
            .object({
              modelResponses: z.array(
                z.object({ output: z.array(z.record(z.string(), z.unknown())) }),
              ),
            })
            .safeParse(error.state.toJSON());
          if (saved.success)
            calls = saved.data.modelResponses
              .flatMap((r) => r.output)
              .filter((i) => i['type'] === 'function_call')
              .map((i) => ({ name: i['name'], arguments: i['arguments'] }));
        }
        results.push({
          scenario: scenario.id,
          turn: index,
          input,
          elapsedMs: Date.now() - t0,
          error: error instanceof Error ? error.name : 'unknown_error',
          failures: ctx.taskPlanFailures ?? 0,
          calls,
        });
      }
      save('running');
      logger.warn(
        {
          scenario: scenario.id,
          turn: index,
          elapsedMs: Date.now() - t0,
          prepared: !!ctx.taskUpdate,
        },
        'preparation preview turn finished',
      );
    }
  }
  save('completed');
} finally {
  clearTimeout(watchdog);
  await processor.forceFlush();
  await disconnectPrisma();
}
