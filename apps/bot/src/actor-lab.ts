import { loadEnv, createLogger } from '@matchbot/shared';
import { createPrisma, createRepositories } from '@matchbot/db';
import { queueSimulatedUserTurn } from '@matchbot/agent';
import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import type { AgentDeps } from '@matchbot/agent';
import { ACTOR_PROFILES, loadActorLabConfig } from './actor-lab-config.js';
import { openActorLab } from './actor-lab-runtime.js';
import { runActorLab } from './actor-lab-run.js';

async function offlineSmoke() {
  const env = loadEnv(),
    url = new URL(env.DATABASE_URL);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname))
    throw new Error('offline_lab_must_be_local');
  url.pathname = '/matchbot_actor_lab';
  const p = createPrisma(url.toString()),
    repos = createRepositories(p),
    logger = createLogger('actor-offline', env.LOG_LEVEL);
  const forbidden = () => Promise.reject(new Error('offline_model_call_forbidden'));
  const deps = {
    env,
    repos,
    logger,
    thresholds: DEFAULT_THRESHOLDS,
    jev: { evaluate: forbidden },
    evaluateOutbound: forbidden,
  } as AgentDeps;
  try {
    const results = [];
    for (const [i, profile] of ACTOR_PROFILES.entries())
      results.push(
        await queueSimulatedUserTurn(deps, {
          actorId: String(111111 + i),
          runId: 'offline-' + Date.now(),
          turn: i,
          groupId: '-999999',
          goal: profile.goal,
          text: profile.firstMessage,
          replyToMessageId: null,
          phase: 0,
        }),
      );
    if (results.some((r) => r.kind !== 'dry_run')) throw new Error('offline_dry_run_failed');
    logger.info(
      {
        outcomes: results.map((r) => r.kind),
        boundary: 'real isolated PG, Phase0, no sender or model calls',
      },
      'actor offline smoke passed',
    );
  } finally {
    await p.$disconnect();
  }
}
async function main() {
  const mode = process.argv[2] ?? '--plan';
  const logger = createLogger('actor-lab-cli');
  if (mode === '--plan') {
    logger.info(
      {
        profiles: ACTOR_PROFILES,
        limits: { maxMessages: 6, maxSeconds: 600, tokenBudget: 150000 },
        status: 'credentials_and_group_setup_required',
      },
      'bounded actor lab plan',
    );
    return;
  }
  if (mode === '--offline-smoke') {
    await offlineSmoke();
    return;
  }
  if (!['--check', '--activate', '--run', '--dry-run'].includes(mode))
    throw new Error('unknown_actor_lab_mode');
  const env = loadEnv();
  if (!env.ACTOR_LAB_CONFIG_PATH)
    throw new Error('set_ACTOR_LAB_CONFIG_PATH_after_BotFather_setup');
  const cfg = loadActorLabConfig(env.ACTOR_LAB_CONFIG_PATH),
    runtime = openActorLab(env, cfg);
  try {
    if (mode === '--activate') {
      await runtime.activate();
      logger.info({ groupId: cfg.groupId, phase: 2 }, 'verified test group activated');
      return;
    }
    if (mode === '--check') {
      await runtime.verify();
      logger.info(
        {
          groupId: cfg.groupId,
          actorIds: cfg.actors.map((a) => a.id),
          transport: 'bot-to-bot delivery still needs live verification',
        },
        'actor identities and group verified',
      );
      return;
    }
    const result = await runActorLab(runtime, mode === '--dry-run');
    logger.info(result, 'bounded actor lab finished');
  } finally {
    await runtime.close();
  }
}
const knownFailures = new Set([
  'set_ACTOR_LAB_CONFIG_PATH_after_BotFather_setup',
  'actor_config_must_be_private_0600',
  'invalid_actor_lab_configuration',
  'actor_allowlist_not_configured',
  'wrong_match_bot',
  'match_bot_requires_group_message_visibility',
  'wrong_test_group',
  'wrong_actor_identity',
  'test_group_not_active_phase2',
  'actor_outbox_not_idle',
  'unknown_actor_lab_mode',
  'offline_lab_must_be_local',
  'offline_dry_run_failed',
]);
void main().catch((error: unknown) => {
  createLogger('actor-lab-cli').error(
    {
      errorKind: error instanceof Error ? error.name : 'unknown_error',
      errorCode:
        error instanceof Error && knownFailures.has(error.message)
          ? error.message
          : 'actor_lab_failed',
    },
    'actor lab did not complete',
  );
  process.exitCode = 1;
});
