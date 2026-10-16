/** Synthetic-only compatibility probe for the existing OpenRouter Decisions client. */
import { writeFileSync } from 'node:fs';
import { createJevClient } from '../../../packages/jev/src/index.js';
import { createLogger, loadEnv } from '../../../packages/shared/src/index.js';
const env = loadEnv();
if (new URL(env.JEV_BASE_URL).hostname !== 'openrouter.ai')
  throw new Error('probe requires the configured OpenRouter host');
let requestedZdr = false;
const client = createJevClient({
  baseUrl: env.JEV_BASE_URL,
  apiKey: env.JEV_API_KEY,
  model: env.JEV_MODEL,
  logger: createLogger('zdr-probe', 'silent'),
  timeoutMs: 10000,
  maxRetries: 0,
  traces: { create: () => Promise.resolve({}), listByKind: () => Promise.resolve([]) } as never,
  fetchImpl: async (url, init) => {
    const body: unknown = JSON.parse(String(init?.body));
    requestedZdr =
      !!body &&
      typeof body === 'object' &&
      'provider' in body &&
      !!body.provider &&
      typeof body.provider === 'object' &&
      'zdr' in body.provider &&
      body.provider.zdr === true;
    if (!requestedZdr) throw new Error('probe refuses a request without ZDR');
    return fetch(url, init);
  },
});
const started = Date.now();
const result = await client.evaluate({
  state: {
    synthetic_probe: true,
    message: 'Schema compatibility test. No real user or listing data.',
  },
  questions: {
    is_probe: {
      type: 'noul',
      instructions:
        'Does this state explicitly identify itself as a synthetic schema compatibility probe?',
    },
  },
  inputRef: 'p25-zdr-probe',
  phase: 0,
});
writeFileSync(
  process.argv[2] ?? '/tmp/matchbot-zdr-probe.json',
  JSON.stringify({ requestedZdr, elapsedMs: Date.now() - started, result }, null, 2),
);
if (!result.ok) process.exitCode = 1;
