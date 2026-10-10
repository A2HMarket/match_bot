import type { DemandCategory } from '@matchbot/domain';
import type {
  evaluateInbound as evaluateInboundFn,
  InboundVerdict,
  JevClient,
} from '@matchbot/jev';
import { percentile } from './metrics.js';
import type { LabeledSample } from './samples.js';

/**
 * 入站门的注入点。真实实现是 `@matchbot/gating` 的 `decideInbound` 与 `DEFAULT_THRESHOLDS`：
 * `decideInbound(v: InboundSignals, t: Thresholds)` 结构上满足这里的签名，直接传进来即可。
 *
 * 之所以注入而不是 import：`scripts/check-deps.mjs` 的 ALLOWED 矩阵里 `@matchbot/eval`
 * 没有列 `@matchbot/gating`（AGENTS.md §3.2 的依赖链其实允许 eval 依赖 gating），
 * 并行期间本包不得自行改 check-deps 与 package.json（AGENTS.md §9.2）。注入同时保证
 * 规则与阈值只有一份实现，eval 不复制任何裸阈值（AGENTS.md §4.4）。
 */
export type InboundDecider<TThresholds> = (
  verdict: InboundVerdict,
  thresholds: TThresholds,
  opts?: { text?: string },
) => { action: string };

export interface SampleVerdict {
  sample: LabeledSample;
  verdict: InboundVerdict;
}

export interface ReplayRow {
  id: string;
  lang: string;
  /** 期望进 agent（标注的 is_demand、is_supply 或 is_local_request 任一为真）。 */
  expected: boolean;
  predicted: boolean;
  action: string;
  category: DemandCategory;
  expectedCategory: DemandCategory;
  isDemand: number;
  isSupply: number;
  isSensitive: number;
  isMoveEvent: number;
  hasLocation: number;
  urgency: number;
}

export interface ReplayReport {
  n: number;
  precision: number;
  recall: number;
  categoryAccuracy: number;
  /** PRD §9 沉默正确率：没进 agent 的样本里确实不该进的比例。 */
  silenceCorrect: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  /** Jev 不可用（降级为"不进 agent"）的条数；这些样本不计入 n。 */
  unavailable: number;
  actions: Record<string, number>;
  rows: ReplayRow[];
}

export interface SignalSummary {
  n: number;
  categoryAccuracy: number;
  /** 分歧样本，便于人工复核标注本身（PoC V4 唯一一条不一致就出在标注可争议）。 */
  categoryMismatches: Array<{ id: string; expected: DemandCategory; got: DemandCategory }>;
  /** 按金标分组的 is_demand / is_supply 分离度，与阈值无关。 */
  isDemand: { positive: SignalStats; negative: SignalStats };
  isSupply: { positive: SignalStats; negative: SignalStats };
  /**
   * P14：只在金标 category=other 的样本上统计——门控也只在 other 上用这道题，
   * 三品类的需求本来就不靠它（它们在这题上分数偏低，混进来会误导阈值）。
   */
  isLocalRequest: { positive: SignalStats; negative: SignalStats };
}
export interface SignalStats {
  n: number;
  min: number;
  p50: number;
  max: number;
}

const REPLAY_PHASE = 0; // 回放一律 Phase 0：出站不执行，只跑到入站门（plan/P12-eval.md Global Constraints）

/** 只跑 Jev，不碰门。门不可用时也能拿到字段准确率与分离度。 */
export async function evaluateSamples(p: {
  samples: readonly LabeledSample[];
  evaluateInbound: typeof evaluateInboundFn;
  jev: JevClient;
}): Promise<{ verdicts: SampleVerdict[]; unavailable: number }> {
  const verdicts: SampleVerdict[] = [];
  let unavailable = 0;
  for (const sample of p.samples) {
    const verdict = await p.evaluateInbound(p.jev, {
      text: sample.text,
      groupName: sample.group,
      ...(sample.lang ? { lang: sample.lang } : {}),
      recentTexts: [],
      inputRef: `eval:${sample.id}`,
      phase: REPLAY_PHASE,
    });
    if (!verdict.ok) {
      unavailable++;
      continue;
    }
    verdicts.push({ sample, verdict });
  }
  return { verdicts, unavailable };
}

/** PRD §9：Intent precision、字段准确率、沉默正确率。 */
export function scoreInbound<TThresholds>(p: {
  verdicts: readonly SampleVerdict[];
  unavailable: number;
  decide: InboundDecider<TThresholds>;
  thresholds: TThresholds;
}): ReplayReport {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let catOk = 0;
  let silent = 0;
  let silentCorrect = 0;
  const actions: Record<string, number> = {};
  const rows: ReplayRow[] = [];

  for (const { sample, verdict } of p.verdicts) {
    const decision = p.decide(verdict, p.thresholds, { text: sample.text });
    actions[decision.action] = (actions[decision.action] ?? 0) + 1;
    const predicted = decision.action === 'enter_agent';
    const expected = sample.is_demand || sample.is_supply || sample.is_local_request;
    if (predicted && expected) tp++;
    else if (predicted && !expected) fp++;
    else if (!predicted && expected) fn++;
    else tn++;
    if (!predicted) {
      silent++;
      if (!expected) silentCorrect++;
    }
    if (verdict.category === sample.category) catOk++;
    rows.push({
      id: sample.id,
      lang: sample.lang,
      expected,
      predicted,
      action: decision.action,
      category: verdict.category,
      expectedCategory: sample.category,
      isDemand: verdict.isDemand,
      isSupply: verdict.isSupply,
      isSensitive: verdict.isSensitive,
      isMoveEvent: verdict.isMoveEvent,
      hasLocation: verdict.hasLocation,
      urgency: verdict.urgency,
    });
  }

  const n = p.verdicts.length;
  // 分母为 0 时报 1：没有正预测就没有假阳，没有沉默就没有沉默错误。
  const safe = (a: number, b: number): number => (b === 0 ? 1 : a / b);
  return {
    n,
    precision: safe(tp, tp + fp),
    recall: safe(tp, tp + fn),
    categoryAccuracy: safe(catOk, n),
    silenceCorrect: safe(silentCorrect, silent),
    tp,
    fp,
    fn,
    tn,
    unavailable: p.unavailable,
    actions,
    rows,
  };
}

export async function replayInbound<TThresholds>(p: {
  samples: readonly LabeledSample[];
  evaluateInbound: typeof evaluateInboundFn;
  jev: JevClient;
  decide: InboundDecider<TThresholds>;
  thresholds: TThresholds;
}): Promise<ReplayReport> {
  const { verdicts, unavailable } = await evaluateSamples(p);
  return scoreInbound({ verdicts, unavailable, decide: p.decide, thresholds: p.thresholds });
}

function stats(values: number[]): SignalStats {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 50),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

/** 与阈值无关的分离度，用来判断现有阈值是否还落在空带里（PoC V4「最终一跑的分离度」同口径）。 */
export function summarizeSignals(verdicts: readonly SampleVerdict[]): SignalSummary {
  const pick = (f: (v: SampleVerdict) => boolean, g: (v: SampleVerdict) => number): SignalStats =>
    stats(verdicts.filter(f).map(g));
  const mismatches = verdicts
    .filter((v) => v.verdict.category !== v.sample.category)
    .map((v) => ({ id: v.sample.id, expected: v.sample.category, got: v.verdict.category }));
  return {
    n: verdicts.length,
    categoryAccuracy: verdicts.length ? (verdicts.length - mismatches.length) / verdicts.length : 1,
    categoryMismatches: mismatches,
    isDemand: {
      positive: pick(
        (v) => v.sample.is_demand,
        (v) => v.verdict.isDemand,
      ),
      // 库外本地求助（「找水管工」「找钢琴调音师」）确实是在请人做付费服务，只是不在三品类里：
      // 实测 is_demand 0.56–0.70。它们既非 is_demand 的干净正例也非干净反例，且门控走的是
      // is_local_request 通道，混进反例会把这条空带「拉窄」成假警报。
      negative: pick(
        (v) => !v.sample.is_demand && !v.sample.is_local_request,
        (v) => v.verdict.isDemand,
      ),
    },
    isSupply: {
      positive: pick(
        (v) => v.sample.is_supply,
        (v) => v.verdict.isSupply,
      ),
      negative: pick(
        (v) => !v.sample.is_supply,
        (v) => v.verdict.isSupply,
      ),
    },
    isLocalRequest: {
      positive: pick(
        (v) => v.sample.category === 'other' && v.sample.is_local_request,
        (v) => v.verdict.isLocalRequest,
      ),
      negative: pick(
        (v) => v.sample.category === 'other' && !v.sample.is_local_request,
        (v) => v.verdict.isLocalRequest,
      ),
    },
  };
}
