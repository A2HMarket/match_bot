import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadEnv } from '../../../packages/shared/src/index.js';
import { createPrisma, createRepositories } from '../../../packages/db/src/index.js';
const env = loadEnv(),
  p = createPrisma(env.DATABASE_URL),
  repos = createRepositories(p);
const id = randomUUID(),
  started = Date.now();
const schema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.url(),
      snippet: z.string(),
      summary: z.string(),
      content: z.string(),
    }),
  ),
});
try {
  const response = await fetch('https://api.deepseek.com/v1/tools/search', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + env.DEEPSEEK_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query: 'NHS register GP without NHS number site:nhs.uk',
      count: 3,
      need_content: true,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const parsed = response.ok ? schema.safeParse(await response.json()) : null;
  const report = {
    id,
    status: response.status,
    valid: parsed?.success ?? false,
    results: parsed?.success
      ? parsed.data.results.map((r) => ({
          title: r.title,
          url: r.url,
          contentChars: r.content.length,
          summaryChars: r.summary.length,
        }))
      : [],
  };
  await repos.traces.create({
    kind: 'gate',
    inputRef: 'poc:p34:' + id,
    phase: 0,
    latencyMs: Date.now() - started,
    costMicro: 0,
    output: { gate: 'deepseek_search_probe', ...report },
  });
  mkdirSync('logs/p34', { recursive: true, mode: 0o700 });
  writeFileSync('logs/p34/probe.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify(report) + '\n');
  if (!report.valid) process.exitCode = 1;
} catch (e) {
  process.stdout.write(
    JSON.stringify({ errorKind: e instanceof Error ? e.name : 'unknown' }) + '\n',
  );
  process.exitCode = 1;
} finally {
  await p.$disconnect();
}
