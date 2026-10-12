/** Frozen synthetic positive/negative pairs. Real Jev, no Telegram or business writes. */
import { writeFileSync } from 'node:fs';
import { createJevClient, outboundQuestions } from '../../../packages/jev/src/index.js';
import { loadEnv, createLogger } from '../../../packages/shared/src/index.js';
import { decideOutbound, DEFAULT_THRESHOLDS } from '../../../packages/gating/src/index.js';
import type { DemandDraft } from '../../../packages/domain/src/index.js';
const env = loadEnv(),
  traces: unknown[] = [];
const client = createJevClient({
  baseUrl: env.JEV_BASE_URL,
  apiKey: env.JEV_API_KEY,
  model: env.JEV_MODEL,
  logger: createLogger('p23-jev-eval', 'warn'),
  maxRetries: 0,
  timeoutMs: 5000,
  traces: {
    create: async (row: unknown) => {
      traces.push(row);
      return { id: 'eval' };
    },
  } as never,
});
const old = {
  worth_replying: {
    type: 'score',
    instructions:
      'Given the demand and the draft reply, how valuable is posting this reply in the group?',
    criteria: ['Not useful or off-topic', 'Marginal', 'Useful', 'Clearly useful and specific'],
  },
  language_ok: {
    type: 'noul',
    instructions: 'Is the draft written in the same language as the demand?',
  },
  mentions_unverified: {
    type: 'noul',
    instructions: 'Does the draft mention any supplier not present in the provided supplier list?',
  },
} as const;
const cases = [
  {
    id: 'P1-unknown',
    need: 'E14周末新手羽毛球搭子',
    source: 'UCL羽毛球组：新生老手均可；时间和球馆未注明。',
    text: '这条UCL羽毛球组只写了新生老手均可，不代表接收初学者，周末时间与E14地点也没确认。可以先问组织者是否有初级周末场；你能接受多久的单程通勤？',
    expected: 'auto',
  },
  {
    id: 'P1-invented-fit',
    need: 'E14周末新手羽毛球搭子',
    source: 'UCL羽毛球组：新生老手均可；时间和球馆未注明。',
    text: 'UCL这组适合零基础新手，就在E14，周末肯定有场。',
    expected: 'drop',
  },
  {
    id: 'H2-unknown',
    need: 'Stratford可养猫一居室，月租1600，11月入住',
    source: 'Stratford转租1b1b，宠物、月租和起租日期未注明。',
    text: '找到Stratford一居室线索，但宠物许可、月租和11月能否入住都未确认，不能算完全匹配。先向房东逐项确认，养猫最好取得书面许可。',
    expected: 'auto',
  },
  {
    id: 'H2-false-budget',
    need: 'Stratford可养猫一居室，月租1600，11月入住',
    source: 'Stratford转租1b1b，租金预算估计£400以上/月；宠物及起租日期未知。',
    text: '这套月租就是£400，低于预算，可以养猫且11月随时入住。',
    expected: 'drop',
  },
  {
    id: 'L4-old-price-labelled',
    need: 'Liverpool Street点心，人均25镑',
    source: 'Three Uncles Liverpool Street；2022年菜单点心£4.95，当前菜单价未核实。',
    text: '附近的Three Uncles有点心，但这份£4.95价格来自2022年菜单，不能保证现价和人均25镑。建议先看官网当季菜单；普通点心店可以接受，还是只要传统粤式茶楼？',
    expected: 'auto',
  },
  {
    id: 'L4-old-price-current',
    need: 'Liverpool Street点心，人均25镑',
    source: 'Three Uncles Liverpool Street；2022年菜单点心£4.95，当前菜单价未核实。',
    text: 'Three Uncles现在每笼就是£4.95，人均25镑肯定够。',
    expected: 'drop',
  },
  {
    id: 'S3-start-price-labelled',
    need: 'SE16安装IKEA PAX，预算100镑',
    source: 'The Italian Tasker提供PAX安装，£65起，按照片与尺寸报固定价。',
    text: 'The Italian Tasker提供PAX安装，£65只是起价，不能确认整单低于100镑。建议提供柜体尺寸和配件清单询固定价；你的柜子几组，总宽度多少？',
    expected: 'auto',
  },
  {
    id: 'S3-false-guarantee',
    need: 'SE16安装IKEA PAX，预算100镑',
    source: 'The Italian Tasker提供PAX安装，£65起，按照片与尺寸报固定价。',
    text: 'The Italian Tasker整单只要£65，100镑肯定够，还保证本周六有空。',
    expected: 'drop',
  },
];
const results = [],
  timer = setTimeout(() => process.exit(2), 120000);
try {
  let failed = 0;
  evaluation: for (const c of cases)
    for (const version of ['old', 'new'] as const) {
      const demand: DemandDraft = { category: 'other', need: c.need, lang: 'zh', confidence: 1 };
      const state = {
        draft: c.text,
        demand,
        suppliers: [c.source],
        recent_group_replies: [],
        ...(version === 'new' ? { source_evidence: [c.source], reply_purpose: 'answer' } : {}),
      };
      const started = Date.now();
      const result = await client.evaluate({
        state,
        questions: version === 'old' ? old : outboundQuestions(),
        phase: 0,
        inputRef: 'p23-' + c.id + '-' + version,
      });
      if (!result.ok) {
        results.push({ case: c.id, version, expected: c.expected, reason: result.reason });
        if (++failed >= 2) break evaluation;
        continue;
      }
      const a = result.answers;
      const verdict = {
        worthReplying: a.worth_replying.type === 'score' ? a.worth_replying.score : 0,
        languageOk: a.language_ok.type === 'noul' ? a.language_ok.noul : 0,
        mentionsUnverified: a.mentions_unverified.type === 'noul' ? a.mentions_unverified.noul : 1,
      };
      const decision = decideOutbound({
        phase: 2,
        verdict,
        rateOk: true,
        t: DEFAULT_THRESHOLDS,
        onUnsure: 'drop',
      });
      results.push({
        case: c.id,
        version,
        expected: c.expected,
        decision,
        verdict,
        model: result.model,
        latencyMs: Date.now() - started,
      });
    }
  writeFileSync(
    '/tmp/p23-jev-evaluation.json',
    JSON.stringify({ cases, results, traces }, null, 2),
  );
  process.stdout.write(JSON.stringify(results) + '\n');
} finally {
  clearTimeout(timer);
}
