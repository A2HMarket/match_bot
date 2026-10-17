/** Frozen practical inferences: real Jev, synthetic data, no business reads or Telegram. */
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { createJevClient, evaluateOutbound } from '../../../packages/jev/src/index.js';
import { DEFAULT_THRESHOLDS, decideOutbound } from '../../../packages/gating/src/index.js';
import { loadEnv, createLogger } from '../../../packages/shared/src/index.js';
const fixture = z
  .object({
    cases: z
      .array(
        z.object({
          id: z.string(),
          need: z.string(),
          source: z.string(),
          draft: z.string(),
          expected: z.enum(['auto', 'drop']),
        }),
      )
      .min(1)
      .max(20),
  })
  .parse(
    JSON.parse(
      readFileSync(
        process.argv[3] ?? 'packages/jev/tests/fixtures/outbound-practical-claims.json',
        'utf8',
      ),
    ),
  );
const env = loadEnv(),
  traces: unknown[] = [],
  results: unknown[] = [];
const client = createJevClient({
  baseUrl: env.JEV_BASE_URL,
  apiKey: env.JEV_API_KEY,
  model: env.JEV_MODEL,
  logger: createLogger('practical-claims-preview', 'warn'),
  timeoutMs: 10000,
  maxRetries: 0,
  traces: {
    create: (row: unknown) => {
      traces.push(row);
      return Promise.resolve({ id: 'synthetic' });
    },
  } as never,
});
const timer = setTimeout(() => process.exit(2), 120000);
try {
  for (const sample of fixture.cases) {
    const verdict = await evaluateOutbound(client, {
      draft: sample.draft,
      demand: { category: 'other', need: sample.need, lang: 'zh', confidence: 1 },
      requestContext: sample.need,
      supplierSummaries: [sample.source],
      recentReplies: [],
      inputRef: 'practical-' + sample.id,
      phase: 0,
    });
    const decision = decideOutbound({
      phase: 2,
      verdict: verdict.ok ? verdict : null,
      rateOk: true,
      t: DEFAULT_THRESHOLDS,
      onUnsure: 'drop',
    });
    const passed = decision === sample.expected;
    results.push({ ...sample, verdict, decision, passed });
    if (!passed) process.exitCode = 1;
  }
  writeFileSync(
    process.argv[2] ?? '/tmp/matchbot-practical-claims-preview.json',
    JSON.stringify(
      { boundary: 'synthetic data; real Jev; no business reads or Telegram', results, traces },
      null,
      2,
    ),
  );
} finally {
  clearTimeout(timer);
}
