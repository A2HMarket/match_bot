/** Synthetic frozen budget case: real Jev; no production reads or Telegram. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createJevClient, evaluateOutbound } from '../../../packages/jev/src/index.js';
import { loadEnv, createLogger } from '../../../packages/shared/src/index.js';
import { DEFAULT_THRESHOLDS, decideOutbound } from '../../../packages/gating/src/index.js';
import { taskSchema } from '../../../packages/domain/src/index.js';
import { taskCurrentRequest } from '../../../packages/agent/src/task-request.js';
import { marketListingSchema } from '../../../packages/websearch/src/market.js';
const env = loadEnv(),
  traces: unknown[] = [];
const report = JSON.parse(
  readFileSync('docs/evaluations/task-core-real-model/v16-desk_chair-r2.json', 'utf8'),
);
const task = taskSchema.parse(report.results[2].task);
const request = taskCurrentRequest(
  {
    task,
    userId: task.ownerUserId,
    chatId: task.scope.chatId,
    groupId: null,
    phase: 0,
    sourceMessageId: 'synthetic',
    recentReplies: [],
  },
  '桌子可以到70镑，椅子还是50',
)!;
const corpus = JSON.parse(
  readFileSync('packages/eval/fixtures/task-agent/source-corpus.json', 'utf8'),
);
const listings = corpus.cases[0].listings
  .map((row: unknown) => marketListingSchema.parse(row))
  .filter((row: { id: string }) =>
    ['task-eval-desk-basic', 'task-eval-chair-basic'].includes(row.id),
  );
const client = createJevClient({
  baseUrl: env.JEV_BASE_URL,
  apiKey: env.JEV_API_KEY,
  model: env.JEV_MODEL,
  logger: createLogger('context-preview', 'warn'),
  timeoutMs: 10000,
  maxRetries: 0,
  traces: {
    create: (row: unknown) => {
      traces.push(row);
      return Promise.resolve({ id: 'synthetic' });
    },
  } as never,
});
const cases = [
  {
    id: 'restated-item-caps',
    text: '书桌£40、椅子£45都在你新的预算内（£70／£50），同在E14支持自提；具体路程能否在30分钟内还需确认。',
    expected: 'auto',
  },
  {
    id: 'swapped-item-caps',
    text: '你给的预算是书桌50镑、椅子70镑。两件都符合这个上限。',
    expected: 'drop',
  },
  { id: 'invented-price', text: '书桌售价£25，椅子£30，两件便宜又方便。', expected: 'drop' },
  {
    id: 'unknown-travel-labelled',
    text: '两件报价符合各自预算；具体自提地址和路程尚未核实，不能确认半小时内能到。',
    expected: 'auto',
  },
];
const results = [],
  timer = setTimeout(() => process.exit(2), 90000);
try {
  for (const sample of cases) {
    const verdict = await evaluateOutbound(client, {
      draft: sample.text,
      demand: request.demand,
      requestContext: request.text,
      supplierSummaries: listings.map(
        (row: { title: string; description: string }) => row.title + '\n' + row.description,
      ),
      recentReplies: [],
      inputRef: 'synthetic-' + sample.id,
      phase: 0,
    });
    const decision = decideOutbound({
      phase: 2,
      verdict: verdict.ok ? verdict : null,
      rateOk: true,
      t: DEFAULT_THRESHOLDS,
      onUnsure: 'drop',
    });
    results.push({ ...sample, verdict, decision });
  }
  writeFileSync(
    process.argv[2] ?? '/tmp/matchbot-outbound-context-preview.json',
    JSON.stringify(
      {
        boundary: 'synthetic user/source data, real Jev, no business reads or Telegram',
        request,
        results,
        traces,
      },
      null,
      2,
    ),
  );
  if (results.some((r) => r.decision !== r.expected)) process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
