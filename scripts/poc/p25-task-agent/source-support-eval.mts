/** Fixed synthetic claims, real Jev. Explicit threshold gate; never sends messages or changes listings. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createJevClient, evaluateSourceSupport } from '../../../packages/jev/src/index.js';
import { DEFAULT_THRESHOLDS } from '../../../packages/gating/src/index.js';
import { createLogger, loadEnv } from '../../../packages/shared/src/index.js';
const fixturePath = 'packages/eval/fixtures/task-agent/source-support.json';
const data = readFileSync(fixturePath, 'utf8');
const sourceFingerprint = createHash('sha256')
  .update(readFileSync('packages/jev/src/questions/source-support.ts'))
  .update(readFileSync('packages/jev/src/client.ts'))
  .update(readFileSync('packages/gating/src/thresholds.ts'))
  .digest('hex');
const fixture = z
  .object({
    cases: z.array(
      z.object({
        id: z.string(),
        task: z.string(),
        goal: z.string(),
        criterionId: z.string().optional(),
        requirement: z.string(),
        quote: z.string(),
        source: z.string(),
        status: z.enum(['supported', 'conflict']),
        expected: z.boolean(),
      }),
    ),
  })
  .parse(JSON.parse(data));
const env = loadEnv(),
  traces: unknown[] = [];
const client = createJevClient({
  baseUrl: env.JEV_BASE_URL,
  apiKey: env.JEV_API_KEY,
  model: env.JEV_MODEL,
  logger: createLogger('source-support-eval', 'silent'),
  timeoutMs: 15000,
  maxRetries: 0,
  traces: {
    create: async (row) => {
      traces.push(row);
      return {};
    },
  } as never,
});
const results: unknown[] = [],
  started = Date.now(),
  output = process.argv[2] ?? '/tmp/matchbot-source-support-eval.json';
let failures = 0;
for (let offset = 0; offset < fixture.cases.length; offset += 4) {
  const batch = fixture.cases.slice(offset, offset + 4);
  const result = await evaluateSourceSupport(client, {
    taskContext:
      'Independent synthetic tasks indexed by goalId: ' +
      JSON.stringify(batch.map((c) => ({ goalId: c.id, task: c.task }))),
    claims: batch.map((c) => ({
      goalId: c.id,
      criterionId: c.criterionId ?? c.id,
      goal: c.goal,
      requirement: c.requirement,
      proposedStatus: c.status,
      sourceId: c.id,
      quote: c.quote,
    })),
    sources: batch.map((c) => ({ id: c.id, text: c.source })),
    phase: 0,
    inputRef: 'p25-source-eval-' + offset,
  });
  for (const [index, c] of batch.entries()) {
    const score = result.ok ? (result.scores[index] ?? null) : null;
    const passed =
      score !== null && score >= DEFAULT_THRESHOLDS.T_SOURCE_SUPPORT_ACCEPT === c.expected;
    if (!passed) failures++;
    results.push({
      id: c.id,
      expected: c.expected,
      score,
      passed,
      ...(!result.ok ? { reason: result.reason } : {}),
    });
  }
  writeFileSync(
    output,
    JSON.stringify(
      {
        fixtureSha256: createHash('sha256').update(data).digest('hex'),
        sourceFingerprint,
        threshold: DEFAULT_THRESHOLDS.T_SOURCE_SUPPORT_ACCEPT,
        elapsedMs: Date.now() - started,
        failures,
        results,
        traces,
      },
      null,
      2,
    ),
  );
}
if (failures) process.exitCode = 1;
