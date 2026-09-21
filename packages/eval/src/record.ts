import { writeFileSync } from 'node:fs';
import { createJevClient, evaluateInbound } from '@matchbot/jev';
import { createLogger, loadEnv } from '@matchbot/shared';
import { JEV_FIXTURE_URL, type JevFixture } from './fixture-jev.js';
import { createMemoryTraces } from './memory-traces.js';
import { evaluateSamples } from './replay.js';
import { loadLabeledSamples } from './samples.js';

/**
 * 录制 CI 回放用的 Jev 响应（`pnpm --filter @matchbot/eval exec tsx src/record.ts`）。
 * 唯一会打真实 Jev 的入口之一（另一个是 `pnpm eval --live`）；改问题集、换模型版本、
 * 扩标注集之后需要重跑一次并把 fixture 一起提交。只跑入站问题集，不产生任何出站动作。
 */
const env = loadEnv();
const logger = createLogger('eval-record', env.LOG_LEVEL);
const samples = loadLabeledSamples();
const idByText = new Map(samples.map((s) => [s.text, s.id]));
const entries: JevFixture['entries'] = {};

const recordingFetch: typeof fetch = async (input, init) => {
  const raw = init?.body;
  if (typeof raw !== 'string') throw new Error('record: expected a JSON string body');
  const state = (JSON.parse(raw) as { state?: { text?: unknown } }).state;
  const id = typeof state?.text === 'string' ? idByText.get(state.text) : undefined;
  const t0 = Date.now();
  const res = await fetch(input, init);
  const latencyMs = Date.now() - t0;
  const body: unknown = await res.clone().json();
  if (id !== undefined && res.ok) entries[id] = { latencyMs, response: body };
  return res;
};

const jev = createJevClient({
  baseUrl: env.JEV_BASE_URL,
  apiKey: env.JEV_API_KEY,
  model: env.JEV_MODEL,
  traces: createMemoryTraces(),
  logger,
  fetchImpl: recordingFetch,
});

const { verdicts, unavailable } = await evaluateSamples({ samples, evaluateInbound, jev });
const fixture: JevFixture = {
  recordedAt: new Date().toISOString(),
  requestModel: env.JEV_MODEL,
  entries,
};
writeFileSync(JEV_FIXTURE_URL, `${JSON.stringify(fixture, null, 2)}\n`);
logger.info(
  {
    recorded: Object.keys(entries).length,
    samples: samples.length,
    verdicts: verdicts.length,
    unavailable,
  },
  'jev inbound fixture recorded',
);
