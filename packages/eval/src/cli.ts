import { createRepositories, disconnectPrisma, getPrisma } from '@matchbot/db';
import { createJevClient, evaluateInbound } from '@matchbot/jev';
import { createLogger, loadEnv } from '@matchbot/shared';
import { createFixtureFetch, loadJevFixture, recordedLatencies } from './fixture-jev.js';
import { loadInboundGate } from './gate.js';
import { computeDailyMetrics, percentile } from './metrics.js';
import { createMemoryTraces } from './memory-traces.js';
import { evaluateSamples, scoreInbound, summarizeSignals } from './replay.js';
import { loadLabeledSamples } from './samples.js';

/**
 * `pnpm eval`（AGENTS.md §7 评测行）。
 * 默认：24h 线上指标 + 用录制 fixture 离线回放入站，不联网。
 * `--live`：改打真实 Jev（只跑入站问题集；出站一律不执行，回放固定 Phase 0）。
 * `--skip-metrics`：不连库，只回放。
 */
const args = new Set(process.argv.slice(2));
const live = args.has('--live');
const skipMetrics = args.has('--skip-metrics');
const skipReplay = args.has('--skip-replay');

const env = loadEnv();
const logger = createLogger('eval', env.LOG_LEVEL);
const WINDOW_MS = 86_400_000;

if (!skipMetrics) {
  const prisma = getPrisma(env.DATABASE_URL);
  try {
    const repos = createRepositories(prisma);
    const metrics = await computeDailyMetrics({
      traces: repos.traces,
      since: new Date(Date.now() - WINDOW_MS),
    });
    logger.info({ window: 'last_24h', metrics }, 'decision_traces metrics');
  } finally {
    await disconnectPrisma();
  }
}

if (!skipReplay) {
  const samples = loadLabeledSamples();
  const traces = createMemoryTraces();
  const fixture = live ? null : loadJevFixture();
  const jev = createJevClient({
    baseUrl: env.JEV_BASE_URL,
    apiKey: env.JEV_API_KEY,
    model: env.JEV_MODEL,
    traces,
    logger,
    ...(fixture ? { fetchImpl: createFixtureFetch({ samples, fixture }) } : {}),
  });

  const { verdicts, unavailable } = await evaluateSamples({ samples, evaluateInbound, jev });
  // 回放自己产生的留痕形状与线上一致，成本 / 模型版本 / 延迟直接复用同一套聚合。
  const jevMetrics = await computeDailyMetrics({ traces, since: new Date(0) });
  const latencies = fixture ? recordedLatencies(fixture) : null;
  const signals = summarizeSignals(verdicts);

  logger.info(
    {
      mode: live ? 'live' : 'fixture',
      n: samples.length,
      unavailable,
      // 阈值只对这个模型版本有效（PoC V4 结论）；版本变了指标必须重跑。
      jev_model: jevMetrics.jevModels,
      cost_micro_total: jevMetrics.costMicroTotal,
      cost_micro_per_sample: verdicts.length ? jevMetrics.costMicroTotal / verdicts.length : 0,
      latency_p50_ms: latencies ? percentile(latencies, 50) : jevMetrics.jevLatencyP50,
      latency_p95_ms: latencies ? percentile(latencies, 95) : jevMetrics.jevLatencyP95,
      latency_source: latencies ? 'recorded' : 'measured',
      signals,
    },
    'inbound replay: jev signals',
  );

  const gate = loadInboundGate();
  if (gate === null) {
    logger.error(
      { blocked_by: 'packages/eval 未声明 @matchbot/gating 依赖', see: 'src/gate.ts' },
      'inbound gate not wired: precision / recall / silence correctness skipped',
    );
  } else {
    const report = scoreInbound({
      verdicts,
      unavailable,
      decide: (verdict) => gate(verdict),
      thresholds: undefined,
    });
    const { rows: _rows, ...summary } = report;
    logger.info({ mode: live ? 'live' : 'fixture', ...summary }, 'inbound replay: gate metrics');
  }
}
