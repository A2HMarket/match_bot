/** Record the exact synthetic source-support unit request/response, never production data. */
import { writeFileSync } from 'node:fs';
import { createJevClient, evaluateSourceSupport } from '../../../packages/jev/src/index.js';
import { loadEnv, createLogger } from '../../../packages/shared/src/index.js';
const env = loadEnv();
let request: unknown, response: unknown;
const client = createJevClient({
  baseUrl: env.JEV_BASE_URL,
  apiKey: env.JEV_API_KEY,
  model: env.JEV_MODEL,
  logger: createLogger('source-fixture', 'silent'),
  timeoutMs: 10000,
  maxRetries: 0,
  traces: { create: async () => ({}) } as never,
  fetchImpl: async (url, init) => {
    request = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    const result = await fetch(url, init);
    response = await result.clone().json();
    return result;
  },
});
const result = await evaluateSourceSupport(client, {
  taskContext: '找可养猫一居室',
  claims: ['a', 'b'].map((sourceId) => ({
    goalId: 'home',
    criterionId: 'pets',
    goal: '一居室',
    requirement: '可养猫',
    proposedStatus: 'supported',
    sourceId,
    quote: '允许养猫',
  })),
  sources: [
    { id: 'a', text: '允许养猫' },
    { id: 'b', text: '不允许养猫' },
  ],
  inputRef: 'synthetic-source-fixture',
  phase: 0,
});
if (!result.ok) throw new Error('synthetic fixture capture failed: ' + result.reason);
writeFileSync(
  process.argv[2] ?? '/tmp/matchbot-source-support-response.json',
  JSON.stringify(response, null, 2) + '\n',
);
writeFileSync(
  process.argv[3] ?? '/tmp/matchbot-source-support-recording.json',
  JSON.stringify(
    {
      boundary: 'synthetic source text and task; real Jev; no production data or Telegram',
      request,
      response,
    },
    null,
    2,
  ) + '\n',
);
