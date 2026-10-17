import type { MarketCandidate } from './market-research.js';
import type { MarketPlan } from './market-strategy.js';
import type { UserTask } from '@matchbot/domain';
import { buildMarketChoices, type MarketChoice, type MarketChoices } from './market-choices.js';
export type MarketSelection = { ref: string; name: string; evidence: string };
const compact = (s: string, max = 180) => {
  const plain = s.replace(/\s+/g, ' ').trim();
  const chars = [...plain];
  return chars.length > max ? chars.slice(0, max).join('') + '…' : plain;
};
const translate = (s: string, zh: boolean) => {
  const translations: Record<string, string> = {
    单品报价符合预算: 'The item price fits your budget',
    月租报价符合预算: 'The monthly rent fits your budget',
    地点符合你指定的范围: 'The location matches your requested area',
    路线方向与你一致: 'The route matches your direction',
    时间在你要求的范围内: 'The date matches your requested range',
    明确要求的条件有原文支持: 'The required condition is supported by the post',
    '价格/计价单位': 'Price/unit',
    '租金/计价单位': 'Rent/unit',
    地点: 'Location',
    路线: 'Route',
    '日期/年份': 'Date/year',
    行程与可用期冲突: 'Trip/availability conflict',
    可用状态: 'Availability',
    必要条件: 'Required condition',
    活动水平: 'Skill level',
  };
  return zh ? s : (translations[s] ?? s);
};
function explainChoice(row: MarketChoice, plan: MarketPlan, zh: boolean): string {
  const reasons = row.reasons.map((reason) => translate(reason, zh)).slice(0, 2);
  if (!reasons.length)
    reasons.push(
      zh
        ? plan.intent === 'companion'
          ? '原文是在找同类活动的伙伴'
          : '原文与这次物品或同行需求相关'
        : 'The post offers the requested item or activity',
    );
  return reasons.join(zh ? '；' : '; ');
}
function priceLine(row: MarketChoice, plan: MarketPlan, zh: boolean): string {
  if (plan.intent === 'companion' && !row.assessment.itemPriceEvidence) return '';
  const label =
    plan.intent === 'housing'
      ? zh
        ? '月租'
        : 'Monthly rent'
      : row.listing.tradeType === 'BUY'
        ? zh
          ? '买家报价'
          : 'Buyer offer'
        : plan.intent === 'carry'
          ? zh
            ? '费用'
            : 'Fee'
          : zh
            ? '单品报价'
            : 'Item price';
  const evidence = row.assessment.itemPriceEvidence;
  if (!evidence) return `${label}${zh ? '：待确认' : ': unconfirmed'}`;
  if (evidence.includes(String.fromCharCode(10)))
    return (zh ? '分项报价：' : 'Item quotes: ') + compact(evidence, 160);
  const parts = evidence.split('｜');
  const field =
    parts.length > 1 ? (parts.find((part) => /£|GBP|免费|free/i.test(part)) ?? evidence) : evidence;
  const unit =
    plan.intent === 'housing' && !/\/月|月租|每月|pcm|per month/i.test(field) ? ' /月' : '';
  return `${label}${zh ? '：' : ': '}${compact(field + unit, 100)}`;
}
function describeLocation(row: MarketChoice, zh: boolean): string {
  const proven = row.assessment.checks.find(
    (check) => check.label === 'area' && check.status === 'met',
  )?.evidence;
  const headers = row.listing.description
    .split('\n')
    .filter((line) => /^(?:地点|位置)[：:]/.test(line));
  const evidence = proven ?? (headers.length === 1 ? headers[0] : undefined);
  return evidence ? `${zh ? '地点原文：' : 'Location quote: '}${compact(evidence, 100)}` : '';
}
function practicalDetails(row: MarketChoice, plan: MarketPlan, zh: boolean): string[] {
  const wanted =
    plan.intent === 'housing'
      ? ['时间', '户型', '室友', '要求', '设施']
      : plan.intent === 'carry'
        ? ['时间', '费用', '交接', '限制', '要求']
        : [];
  const lines = row.listing.description.split('\n');
  return wanted
    .flatMap((label) => {
      const line = lines.find(
        (text) => text.startsWith(label + '：') || text.startsWith(label + ':'),
      );
      return line ? [`${zh ? '原文信息：' : 'Source detail: '}${compact(line, 90)}`] : [];
    })
    .slice(0, 2);
}
function renderChoice(
  row: MarketChoice,
  selection: MarketSelection,
  plan: MarketPlan,
  index: number,
  zh: boolean,
): string {
  const n = row.listing;
  const date = n.isRepost ? n.sourcePublishedAt : n.createdAt;
  const stamp = date
    ? `${zh ? (n.isRepost ? '原帖' : '发布') : 'Posted'} ${date.slice(0, 10)}`
    : zh
      ? '原帖日期未确认'
      : 'Original date unconfirmed';
  const links =
    `[${zh ? 'A2H详情' : 'A2H listing'}](${n.url})` +
    (n.sourceUrl ? ` · [${zh ? '原帖' : 'Original post'}](${n.sourceUrl})` : '');
  const details = uniqueSourceDetails([
    compact(selection.evidence),
    ...practicalDetails(row, plan, zh),
    priceLine(row, plan, zh),
    describeLocation(row, zh),
  ]);
  return [
    `${index}. ${compact(selection.name, 100)}`,
    `${zh ? (row.essentialMissing.length ? '可作备选：' : '推荐理由：') : 'Why: '}${explainChoice(row, plan, zh)}`,
    ...details,
    row.warning ? `${zh ? '注意原文：' : 'Source caution: '}${compact(row.warning, 100)}` : '',
    row.missing.length
      ? `${zh ? '待确认：' : 'Unconfirmed: '}${missingLabels(row, plan, zh).join(' / ')}`
      : '',
    stamp,
    (zh ? '来源：' : 'Source: ') + links,
  ]
    .filter(Boolean)
    .join('\n');
}
function missingLabels(row: MarketChoice, plan: MarketPlan, zh: boolean): string[] {
  return [
    ...new Set(
      row.missing
        .filter(
          (label) =>
            !(
              label === '预算' &&
              row.assessment.checks.some((c) => c.label === 'budget' && c.status === 'met')
            ) &&
            !(
              label === '地点' &&
              row.assessment.checks.some((c) => c.label === 'area' && c.status === 'met')
            ),
        )
        .map((label) =>
          plan.intent === 'housing' &&
          plan.budgetScope === 'all_in' &&
          row.assessment.itemPriceGBP &&
          ['预算', '租金/计价单位'].includes(label)
            ? zh
              ? '含账单总价'
              : 'total including bills'
            : label === '自提条件'
              ? zh
                ? '取货安排'
                : 'collection arrangements'
              : label === '来源核对'
                ? zh
                  ? '实际可用情况'
                  : 'actual availability'
                : translate(label, zh),
        ),
    ),
  ];
}
function renderBriefChoice(
  row: MarketChoice,
  selection: MarketSelection,
  plan: MarketPlan,
  index: number,
  zh: boolean,
): string {
  const n = row.listing;
  const details = uniqueSourceDetails([
    compact(selection.evidence, 110),
    ...practicalDetails(row, plan, zh),
    priceLine(row, plan, zh),
  ]);
  const missing = missingLabels(row, plan, zh);
  return [
    `${index}. ${compact(selection.name, 80)}${row.essentialMissing.length ? (zh ? '（待核实）' : ' (unconfirmed)') : ''}`,
    ...details,
    row.warning ? `${zh ? '注意：' : 'Caution: '}${compact(row.warning, 100)}` : '',
    missing.length ? `${zh ? '还需确认：' : 'Still to check: '}${missing.join(' / ')}` : '',
    `[${zh ? 'A2H详情' : 'A2H listing'}](${n.url})${n.sourceUrl ? ` · [${zh ? '原帖' : 'Original post'}](${n.sourceUrl})` : ''}`,
  ]
    .filter(Boolean)
    .join('\n');
}
function uniqueSourceDetails(lines: string[]): string[] {
  const kept: string[] = [];
  const content = (s: string) =>
    s
      .replace(
        /^(?:原文信息|Source detail|分项报价|Item quotes|月租|Monthly rent|买家报价|Buyer offer|费用|Fee|单品报价|Item price|地点原文|Location quote)[：:]\s*/i,
        '',
      )
      .replace(/\s+/g, '');
  for (const line of lines.filter(Boolean)) {
    const value = content(line);
    // Short values such as "unconfirmed" can concern different fields; do not merge those labels.
    if (value.length >= 8 && kept.some((old) => content(old).includes(value))) continue;
    kept.push(line);
  }
  return kept;
}
function introduction(choices: MarketChoices, zh: boolean): string {
  if (!choices.primary.length)
    return zh
      ? `这次尚未确认完全匹配的选项。下面${choices.backup.length}条是待核实线索，先看标出的缺口。`
      : 'This search did not confirm every essential condition. These are leads to check first.';
  return zh
    ? `先看这${choices.primary.length}条相关线索，报价和待确认项已分别标出。${choices.backup.length ? `另外${choices.backup.length}条备选还缺关键信息。` : ''}`
    : 'Here are the most relevant leads from this search. Quotes and remaining questions are shown for each option.';
}
export function renderMarketChoiceReply(p: {
  listings: MarketCandidate[];
  selections: MarketSelection[];
  plan: MarketPlan;
  zh: boolean;
  assessWholeOffer?: boolean;
  task?: UserTask;
  format?: 'full' | 'brief';
}) {
  const choices = buildMarketChoices({
    candidates: p.listings,
    plan: p.plan,
    ...(p.task ? { task: p.task } : {}),
    ...(p.assessWholeOffer
      ? {}
      : { names: Object.fromEntries(p.selections.map((s) => [s.ref, s.name])) }),
  });
  const blocks = p.format === 'brief' ? [] : [introduction(choices, p.zh)];
  const covered = new Set(
    [...choices.primary, ...choices.backup].flatMap((row) => row.assessment.needs),
  );
  const missing = p.plan.needs
    .filter((need) => !covered.has(need.id))
    .map((need) => need.terms[0] ?? need.id);
  if (missing.length)
    blocks.push((p.zh ? '尚未确认到：' : 'Not yet confirmed: ') + missing.join(' / '));
  let index = 0;
  for (const [heading, rows] of [
    [p.zh ? '【优先看】' : '【Start here】', choices.primary],
    [p.zh ? '【备选 · 需要确认】' : '【Backups · check first】', choices.backup],
  ] as const) {
    if (!rows.length) continue;
    if (p.format !== 'brief') blocks.push(heading);
    for (const row of rows)
      blocks.push(
        (p.format === 'brief' ? renderBriefChoice : renderChoice)(
          row,
          p.selections.find((s) => s.ref === row.listing.ref)!,
          p.plan,
          ++index,
          p.zh,
        ),
      );
  }
  return { text: blocks.join('\n\n'), choices };
}
