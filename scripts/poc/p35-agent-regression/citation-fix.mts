/** One continuation message within the already-approved P35 budget; no automatic retries. */
import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { z } from 'zod';
import { loadEnv } from '../../../packages/shared/src/index.js';
import { AGENT_VERSION } from '../../../packages/agent/src/index.js';
import {
  actorLabConfigSchema,
  loadActorLabConfig,
} from '../../../apps/bot/src/actor-lab-config.js';
import { openActorLab, observeActorMessages } from '../../../apps/bot/src/actor-lab-runtime.js';
import { runActorLab } from '../../../apps/bot/src/actor-lab-run.js';
async function main() {
  const root = 'logs/p35/live-aa2adec9-c00c-49d2-b79d-37d4109d82dd';
  const parent = z
    .object({
      batchId: z.literal('aa2adec9-c00c-49d2-b79d-37d4109d82dd'),
      approvedBudget: z.literal(1200000),
      messageLimit: z.literal(6),
      used: z.number().int(),
      sent: z.number().int(),
    })
    .parse(JSON.parse(readFileSync(root + '/batch.json', 'utf8')));
  const ledger = z
    .object({
      p35: z.object({
        baselineBatchId: z.literal(parent.batchId),
        used: z.number().int(),
        actorMessages: z.number().int(),
      }),
    })
    .parse(JSON.parse(readFileSync('logs/actor-lab/cumulative-budget.json', 'utf8')));
  if (
    ledger.p35.used !== parent.used ||
    ledger.p35.actorMessages !== parent.sent ||
    parent.sent !== 5
  )
    throw new Error('parent_budget_changed');
  const remaining = parent.approvedBudget - parent.used;
  if (remaining < 139910 || String(AGENT_VERSION) !== '0.22.0')
    throw new Error('budget_or_version_mismatch');
  if (execFileSync('git', ['diff', 'HEAD', '--', 'packages', 'apps'], { encoding: 'utf8' }).trim())
    throw new Error('uncommitted_runtime_changes');
  const env = loadEnv(),
    base = loadActorLabConfig(env.ACTOR_LAB_CONFIG_PATH!);
  const scenario = z
    .array(
      z.object({
        id: z.string(),
        role: z.enum(['short', 'changes', 'interruption']),
        firstMessage: z.string(),
        goal: z.string(),
        style: z.string(),
      }),
    )
    .parse(
      JSON.parse(
        readFileSync(new URL('../p33-live-multiturn/cases.json', import.meta.url), 'utf8'),
      ),
    )
    .find((c) => c.id === 'gp-registration')!;
  const cfg = actorLabConfigSchema.parse({
    ...base,
    actors: base.actors.map((a) =>
      a.role === scenario.role
        ? {
            ...a,
            ...{ goal: scenario.goal, style: scenario.style, firstMessage: scenario.firstMessage },
          }
        : a,
    ),
    turnOrder: [scenario.role],
    maxMessages: 1,
    maxSeconds: 300,
    replyWaitSeconds: 210,
    waitForEachReply: true,
    minRemainingTokens: 139910,
    tokenBudget: Math.min(500000, remaining),
  });
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(
    root + '/citation-fix-started.json',
    JSON.stringify(
      {
        sourceSha,
        agentVersion: AGENT_VERSION,
        parentBatchId: parent.batchId,
        budgetScope: 'continuation_of_p35',
        remainingTokens: remaining,
        remainingMessages: 1,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  const batchLock = openSync('.env.actor-lab-batch.lock', 'wx', 0o600);
  writeFileSync(batchLock, String(process.pid));
  const rt = openActorLab(env, cfg),
    since = new Date();
  try {
    await rt.activate();
    const result = await runActorLab(rt);
    let settled = false;
    for (let i = 0; i < 23; i++) {
      const messages = await observeActorMessages(rt.mainRepos, {
        groupId: cfg.groupId,
        actorIds: cfg.actors.filter((a) => a.role === scenario.role).map((a) => a.id),
        since,
      });
      const replies = await Promise.all(
        messages.map((m) =>
          rt.mainRepos.outbound.findReplyForSource({
            channel: 'telegram',
            target: cfg.groupId,
            sourceMessageId: m.id,
          }),
        ),
      );
      if (
        messages.length === result.sent &&
        messages.every(
          (m) =>
            m.executionStatus !== null &&
            !['accepted', 'running', 'waiting_approval'].includes(m.executionStatus),
        ) &&
        replies.every((r) => !r || !['pending', 'sending'].includes(r.status))
      ) {
        settled = true;
        break;
      }
      await pause(2000);
    }
    const report = z
      .object({ usage: z.object({ tokens: z.number().int().nonnegative() }).nullable() })
      .passthrough()
      .parse(JSON.parse(readFileSync(result.report, 'utf8')));
    const summary = {
      sourceSha,
      agentVersion: AGENT_VERSION,
      parentBatchId: parent.batchId,
      budgetScope: 'continuation_of_p35',
      result,
      settled,
      report,
      used: report.usage?.tokens ?? null,
      totalThisRoundTokens: report.usage ? parent.used + report.usage.tokens : null,
      totalThisRoundMessages: parent.sent + result.sent,
    };
    writeFileSync(root + '/citation-fix-result.json', JSON.stringify(summary, null, 2) + '\n', {
      mode: 0o600,
    });
    process.stdout.write(
      JSON.stringify({
        event: 'citation_fix_finished',
        sent: result.sent,
        used: summary.used,
        totalTokens: summary.totalThisRoundTokens,
        totalMessages: summary.totalThisRoundMessages,
        settled,
      }) + '\n',
    );
    if (!settled || !report.usage) process.exitCode = 1;
  } finally {
    await rt.mainRepos.groups.setPolicy({
      channel: 'telegram',
      externalId: cfg.groupId,
      isActive: false,
      phase: 0,
      rateLimitPerDay: 30,
    });
    try {
      await rt.close();
    } finally {
      closeSync(batchLock);
      unlinkSync('.env.actor-lab-batch.lock');
    }
  }
}
await main().catch((error: unknown) => {
  process.stdout.write(
    JSON.stringify({
      event: 'citation_fix_error',
      errorKind: error instanceof Error ? error.name : 'unknown_error',
    }) + '\n',
  );
  process.exitCode = 1;
});
