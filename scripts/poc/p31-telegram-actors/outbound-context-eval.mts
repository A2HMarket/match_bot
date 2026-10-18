/** Real Jev, synthetic facts, memory outbox, no Telegram sender or generator calls. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadEnv } from '../../../packages/shared/src/index.js';
import type { OutboundMessage } from '../../../packages/db/src/index.js';
import { queueSimulatedUserTurn } from '../../../packages/agent/src/index.js';
import { openActorLab } from '../../../apps/bot/src/actor-lab-runtime.js';
import { loadActorLabConfig } from '../../../apps/bot/src/actor-lab-config.js';
const env = loadEnv(),
  cfg = loadActorLabConfig(env.ACTOR_LAB_CONFIG_PATH!),
  rt = openActorLab(env, cfg);
const since = new Date(),
  runId = 'context-' + Date.now();
let row: OutboundMessage | null = null;
const deps = {
  ...rt.deps,
  repos: {
    ...rt.repos,
    outbound: {
      ...rt.repos.outbound,
      create: (draft: unknown, status: unknown) => {
        row = { ...(draft as object), id: 'memory-preview', status } as OutboundMessage;
        return Promise.resolve(row);
      },
      findByToolCallId: () => Promise.resolve(row),
    },
  },
};
const cases = [
  ...cfg.actors.map((actor) => ({ actor, text: actor.firstMessage, expected: 'queued' })),
  { actor: cfg.actors[0]!, text: 'E14想收书桌和办公椅，每件500镑以内', expected: 'not_queued' },
  {
    actor: cfg.actors[0]!,
    text: 'E14有一套桌椅库存充足，每件20镑，今天保证免费送到家。',
    expected: 'not_queued',
  },
];
const results: unknown[] = [];
try {
  await rt.mainRepos.groups.setPolicy({
    channel: 'telegram',
    externalId: cfg.groupId,
    isActive: false,
    phase: 0,
    rateLimitPerDay: 30,
  });
  for (const [i, c] of cases.entries()) {
    row = null;
    const result = await queueSimulatedUserTurn(deps, {
      actorId: c.actor.id,
      runId,
      turn: i,
      groupId: cfg.groupId,
      goal: c.actor.goal,
      text: c.text,
      replyToMessageId: null,
      phase: 2,
    });
    results.push({
      role: c.actor.role,
      text: c.text,
      expected: c.expected,
      actual: result.kind,
      correct: result.kind === c.expected,
    });
    if (result.kind !== c.expected) process.exitCode = 1;
  }
  const traces = (await rt.repos.traces.listByKind('gate', since, 100)).filter((t) =>
    t.inputRef.includes(runId),
  );
  mkdirSync('logs/actor-lab', { recursive: true, mode: 0o700 });
  writeFileSync(
    'logs/actor-lab/outbound-context-eval.json',
    JSON.stringify(
      {
        since,
        runId,
        results,
        traces,
        boundary:
          'Real Jev with unchanged questions/thresholds; memory outbox only. Original rejected live attempt preserved. No Telegram send.',
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  rt.logger.info(
    {
      cases: cases.length,
      correct: results.filter((r) => (r as { correct: boolean }).correct).length,
      boundary: 'memory outbox, no Telegram send',
    },
    'actor outbound context evaluation finished',
  );
} finally {
  await rt.close();
}
