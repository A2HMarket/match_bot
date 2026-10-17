/** Three synthetic prompts, no Telegram and no production messages. */
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadEnv, createLogger } from '../../../packages/shared/src/index.js';
import { createPrisma, createRepositories } from '../../../packages/db/src/index.js';
import {
  configureModelProvider,
  createTraceProcessor,
  generateSimulatedUserTurn,
  queueSimulatedUserTurn,
  type AgentDeps,
} from '../../../packages/agent/src/index.js';
import { DEFAULT_THRESHOLDS } from '../../../packages/gating/src/index.js';
import { ACTOR_PROFILES } from '../../../apps/bot/src/actor-lab-config.js';
const env = loadEnv(),
  url = new URL(env.DATABASE_URL);
if (!['127.0.0.1', 'localhost'].includes(url.hostname))
  throw new Error('local_control_database_required');
url.pathname = '/matchbot_actor_lab';
const db = createPrisma(url.toString()),
  repos = createRepositories(db),
  logger = createLogger('actor-proposal-eval', env.LOG_LEVEL);
const processor = createTraceProcessor({ traces: repos.traces, logger });
configureModelProvider(env, [processor]);
const forbidden = () => Promise.reject(new Error('phase0_jev_call_forbidden'));
const deps = {
  env,
  repos,
  logger,
  thresholds: DEFAULT_THRESHOLDS,
  jev: { evaluate: forbidden },
  evaluateOutbound: forbidden,
} as AgentDeps;
const since = new Date(),
  refs: string[] = [],
  rows: unknown[] = [];
const questions = [
  '你坐什么交通工具去取？最多接受单程多久？',
  '房子还有什么必须满足的条件？账单算在1600里面吗？',
  '周六下午去室外打可以吗？',
];
try {
  for (const [i, profile] of ACTOR_PROFILES.entries()) {
    const actorId = String(111111 + i),
      inputRef = `actor-eval:${since.getTime()}:${i}`;
    refs.push(inputRef);
    try {
      const proposal = await generateSimulatedUserTurn(deps, {
        actorId,
        inputRef,
        goal: profile.goal,
        style: profile.style,
        history: [
          { speaker: 'self', text: profile.firstMessage },
          { speaker: 'match_bot', text: questions[i]! },
        ],
      });
      const relevant =
        !proposal.done &&
        (i === 0
          ? /地铁|半小时|30/.test(proposal.text)
          : i === 1
            ? /猫|账单|1600/.test(proposal.text)
            : /周日|星期日|室内/.test(proposal.text));
      const outbound = proposal.done
        ? null
        : await queueSimulatedUserTurn(deps, {
            actorId,
            runId: `eval-${since.getTime()}`,
            turn: i,
            groupId: '-999999',
            goal: profile.goal,
            text: proposal.text,
            replyToMessageId: null,
            phase: 0,
          });
      rows.push({ role: profile.role, proposal, relevant, phase0: outbound?.kind });
      if (!relevant || outbound?.kind !== 'dry_run') process.exitCode = 1;
    } catch (error) {
      rows.push({ role: profile.role, errorKind: error instanceof Error ? error.name : 'unknown' });
      process.exitCode = 1;
    }
  }
  await processor.forceFlush();
  const usage = await repos.traces.summarizeUsage({ since, inputRefs: refs });
  if (usage.calls !== 3 || usage.missingUsageCalls) process.exitCode = 1;
  mkdirSync('logs/actor-lab', { recursive: true, mode: 0o700 });
  writeFileSync(
    'logs/actor-lab/proposal-eval.json',
    JSON.stringify(
      {
        since,
        rows,
        usage,
        boundary: 'synthetic prompt relevance and phase0 only; not Telegram E2E or satisfaction',
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  logger.info(
    { cases: rows.length, usage, passed: !process.exitCode },
    'actor proposal preview finished',
  );
} finally {
  await processor.forceFlush();
  await db.$disconnect();
}
