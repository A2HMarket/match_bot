import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadEnv, createLogger } from '../../../packages/shared/src/index.js';
import { createPrisma, createRepositories } from '../../../packages/db/src/index.js';
import { createWebSearch } from '../../../packages/websearch/src/index.js';
import { createDeepSeekSearch } from '../../../packages/agent/src/index.js';
const env = loadEnv(),
  p = createPrisma(env.DATABASE_URL),
  repos = createRepositories(p),
  logger = createLogger('p34-compare', 'silent');
const providers = {
  deepseek: createDeepSeekSearch({ apiKey: env.DEEPSEEK_API_KEY, logger }),
  ...(env.SEARCH_API_KEY
    ? { tavily: createWebSearch({ apiKey: env.SEARCH_API_KEY, logger }) }
    : {}),
};
const cases = [
  {
    id: 'gp-policy',
    query: 'register GP without NHS number proof of address',
    domains: ['nhs.uk'],
  },
  { id: 'gp-local', query: 'Island Health E14 online patient registration', domains: ['nhs.uk'] },
  { id: 'badminton', query: 'Isle of Dogs Sunday afternoon indoor badminton beginners' },
  { id: 'family', query: 'London free exhibitions children October 24 2026' },
  {
    id: 'exhibition-price',
    query: 'Renoir Love 2026 Saturday adult children ticket price',
    domains: ['nationalgallery.org.uk'],
  },
  { id: 'printer', query: 'E14 second hand wireless laser printer 60 pounds' },
];
const resume = process.argv[2];
if (resume && !/^logs\/p34\/search-[a-f0-9-]{36}$/.test(resume))
  throw new Error('invalid_resume_path');
const id = resume?.split('search-')[1] ?? randomUUID(),
  root = resume ?? 'logs/p34/search-' + id;
mkdirSync(root, { recursive: true, mode: 0o700 });
const results: Array<{
  id: string;
  provider: string;
  latencyMs: number;
  status: string;
  sources: unknown[];
  reason?: string;
}> = resume ? JSON.parse(readFileSync(root + '/results.json', 'utf8')).results : [];
const deadline = setTimeout(() => process.exit(2), 240000);
try {
  for (const c of cases)
    for (const [provider, search] of Object.entries(providers)) {
      if (results.some((r) => r.id === c.id && r.provider === provider)) continue;
      const started = Date.now();
      const result = await search.research!(c);
      const row = { id: c.id, provider, latencyMs: Date.now() - started, ...result };
      results.push(row);
      writeFileSync(
        root + '/results.json',
        JSON.stringify({ id, cases, results }, null, 2) + '\n',
        { mode: 0o600 },
      );
      await repos.traces.create({
        kind: 'gate',
        inputRef: 'poc:p34-search:' + id + ':' + c.id,
        phase: 0,
        latencyMs: row.latencyMs,
        costMicro: 0,
        output: {
          gate: 'information_search_comparison',
          provider,
          status: result.status,
          count: result.sources.length,
          reason: result.reason ?? null,
        },
      });
      process.stdout.write(
        JSON.stringify({
          id: c.id,
          provider,
          status: result.status,
          count: result.sources.length,
          latencyMs: row.latencyMs,
          reason: result.reason ?? null,
        }) + '\n',
      );
    }
  process.stdout.write(JSON.stringify({ event: 'finished', root }) + '\n');
} finally {
  clearTimeout(deadline);
  await p.$disconnect();
}
