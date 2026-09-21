import { readFileSync } from 'node:fs';
import { DEMAND_CATEGORIES } from '@matchbot/domain';
import { z } from 'zod';

/**
 * 标注样本。category 取值直接复用 DEMAND_CATEGORIES，不做二次映射（AGENTS.md §4.4）。
 * 起点是 PoC V4 的 scripts/poc/v4-jev-inbound/labeled.json（50 条，五语种各 10 条），
 * 本包补上 `is_supply` 金标与稳定 id。
 */
export const labeledSampleSchema = z.object({
  id: z.string().min(1),
  lang: z.string().min(1),
  group: z.string().min(1),
  /**
   * Brief §4 的群 seed 里没有中文群，中文条目用占位群名代表 PRD §3 的华人社区群
   * （scripts/poc/v4-jev-inbound/RESULT.md §3 记的已知问题）。真接入中文群后替换群名并
   * 去掉本字段；在此之前它必须显式为 true，不允许占位群伪装成真实语料。
   */
  group_is_placeholder: z.boolean().optional(),
  text: z.string().min(1),
  is_demand: z.boolean(),
  is_supply: z.boolean(),
  category: z.enum(DEMAND_CATEGORIES),
});
export type LabeledSample = z.infer<typeof labeledSampleSchema>;

export const LABELED_INBOUND_URL = new URL('../fixtures/labeled-inbound.json', import.meta.url);

export function parseLabeledSamples(raw: unknown): LabeledSample[] {
  return z.array(labeledSampleSchema).parse(raw);
}

export function loadLabeledSamples(url: URL = LABELED_INBOUND_URL): LabeledSample[] {
  return parseLabeledSamples(JSON.parse(readFileSync(url, 'utf8')));
}
