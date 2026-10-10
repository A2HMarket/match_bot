/** 录制生产同款 Jev 问题集；匿名样本，内存留痕，所有成功后才原子替换 fixture。 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createJevClient, evaluateInbound } from '../../../packages/jev/src/index.js';
import { loadEnv, createLogger } from '../../../packages/shared/src/index.js';
import { parseLabeledSamples } from '../../../packages/eval/src/samples.js';
import { createMemoryTraces } from '../../../packages/eval/src/memory-traces.js';
const env = loadEnv(),
  logger = createLogger('market-calibration');
const samples = parseLabeledSamples(
  JSON.parse(readFileSync('packages/eval/fixtures/labeled-inbound.json', 'utf8')),
);
const traces = createMemoryTraces();
const entries: Record<string, { latencyMs: number; response: unknown }> = {};
let response: unknown;
const jev = createJevClient({
  baseUrl: env.JEV_BASE_URL,
  apiKey: env.JEV_API_KEY,
  model: env.JEV_MODEL,
  traces,
  logger,
  maxRetries: 1,
  fetchImpl: async (input, init) => {
    const res = await fetch(input, init);
    if (res.ok) response = await res.clone().json();
    return res;
  },
});
const recordedAt = new Date().toISOString();
let count = 0;
for (const sample of samples) {
  response = undefined;
  const started = Date.now();
  const result = await evaluateInbound(jev, {
    text: sample.text,
    groupName: sample.group,
    lang: sample.lang,
    recentTexts: [],
    inputRef: sample.id,
    phase: 0,
  });
  if (!result.ok || response === undefined)
    throw new Error(
      `recording failed at ${sample.id}: ${result.ok ? 'no response' : result.reason}`,
    );
  entries[sample.id] = { latencyMs: Date.now() - started, response };
  count++;
  if (count % 10 === 0) logger.info({ count, total: samples.length }, 'recording progress');
}
const path = 'packages/eval/fixtures/jev-inbound.json';
writeFileSync(
  '/tmp/matchbot-market-inbound-recorded.json',
  JSON.stringify({ recordedAt, requestModel: env.JEV_MODEL, entries }, null, 2) + '\n',
);
writeFileSync(path + '.tmp', readFileSync('/tmp/matchbot-market-inbound-recorded.json'));
renameSync(path + '.tmp', path);
logger.info({ count }, 'recorded all samples; fixture replaced');
