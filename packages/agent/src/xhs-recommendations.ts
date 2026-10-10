import type { XhsNote } from '@matchbot/websearch';
import { z } from 'zod';
import { getXhsNoteKey, XHS_RESEARCH_LIMITS } from './xhs-research.js';
import { getXhsPassages } from './xhs-evidence.js';

const citationSchema = z.object({
  ref: z.string(),
  passages: z.array(z.string()).min(1).max(8),
});
const factSchema = z.object({
  label: z.enum(['dates', 'venue', 'price', 'booking']),
  status: z.enum(['known', 'unknown', 'conflicting']),
  passages: z.array(z.string()).max(3),
});
export const xhsRecommendationSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .describe('Actual event/place name copied from one source; never the title of a roundup.'),
  aliases: z
    .array(z.string().trim().min(2).max(80))
    .max(4)
    .describe(
      'Source-attested aliases, e.g. Chinese and English exhibition names. Merge all aliases of the same exhibition into one entry.',
    ),
  group: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .describe(
      'Category in user language, e.g. 绘画与艺术, 摄影与设计, 沉浸体验. Use consistent groups.',
    ),
  summary: z
    .string()
    .trim()
    .min(1)
    .max(220)
    .describe(
      'Describe the exhibition itself: subject, highlights and what visitors see, integrating all cited notes. Do not describe the posts or invent facts.',
    ),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe(
      'Who it suits and why to choose it, matching the user. Suggestion, not claimed personal experience.',
    ),
  sources: z
    .array(citationSchema)
    .min(1)
    .max(4)
    .describe(
      'Select returned passage IDs (e.g. x3:p2) supporting description AND facts. Never copy or rewrite quotes. Each ID must belong to its ref. Prefer 1-2 notes per entity; multiple posts may support one exhibition and one roundup may support several exhibitions.',
    ),
  facts: z
    .array(factSchema)
    .max(4)
    .describe(
      'Practical facts: select passage IDs from the notes cited in sources. known: exactly ONE passage containing the fact; code displays its original text. unknown: passages=[]. conflicting: at least two differing passages from distinct cited notes; code flags conflict. Never write or paraphrase a fact value. Prefer compact original date/venue/price/booking lines; avoid long mixed-topic paragraphs. Missing labels are unconfirmed.',
    ),
});
export type XhsRecommendation = z.infer<typeof xhsRecommendationSchema>;
export const singleLine = (text: string) => text.replace(/[\r\n]+/g, ' ').trim();
const normalizeName = (name: string) =>
  name
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{Z}\s]/gu, '');
const noteText = (note: XhsNote) =>
  note.title + '\n' + note.desc.slice(0, XHS_RESEARCH_LIMITS.excerptChars);
function containsEntityName(note: XhsNote, name: string): boolean {
  const key = normalizeName(name);
  return (
    key.length > 0 &&
    noteText(note)
      .split(/[\r\n]+/u)
      .some((line) => normalizeName(line).includes(key))
  );
}
/** 正式展名常写作“艺术家: 展名”；其他帖子可能分别写两者，不能只匹配艺术家。 */
function mentionsEntity(note: XhsNote, name: string): boolean {
  if (containsEntityName(note, name)) return true;
  const parts = name.split(/[:：]/u).map((s) => s.trim());
  return (
    parts.length === 2 &&
    parts.every((p) => normalizeName(p).length >= 3 && containsEntityName(note, p))
  );
}
function isCollectionName(name: string): boolean {
  return (
    /伦敦|london/iu.test(name) &&
    /合集|攻略|清单|指南|景点|好去处|好玩的|0元|things to do|roundup/iu.test(name)
  );
}
function hasPriceInformation(text: string): boolean {
  return /[£€$¥￥]|免费|free\b|不收[费门票]|无需付费|\d\s*(?:镑|磅|元|GBP|pounds?)/iu.test(text);
}
const labels = {
  zh: { dates: '时间', venue: '地点', price: '票价', booking: '预约' },
  en: { dates: 'Dates', venue: 'Venue', price: 'Price', booking: 'Booking' },
};

function gatherSources(
  item: XhsRecommendation,
  byRef: Map<string, XhsNote>,
): { notes: XhsNote[]; evidence: Map<string, { ref: string; text: string }> } | { error: string } {
  const citations = item.sources;
  const notes: XhsNote[] = [];
  const evidence = new Map<string, { ref: string; text: string }>();
  for (const citation of citations) {
    const note = byRef.get(citation.ref);
    if (!note) return { error: `invalid recommendation: unknown source ref ${citation.ref}` };
    if (note.isDetailLoaded === false)
      return {
        error: `invalid recommendation: ${note.ref} is only a discovery card; use xhs_read_notes before citing it`,
      };
    const byId = new Map(getXhsPassages(note).map((p) => [p.id, p.text]));
    for (const id of citation.passages) {
      const text = byId.get(id);
      if (!text)
        return {
          error: `invalid recommendation: sources.${citation.ref}.passages: unknown ID ${id}; select returned IDs for this ref`,
        };
    }
    // facts 自身的编号就是事实引用，不要求在介绍证据数组中重复登记；仍只能来自已引用的笔记。
    byId.forEach((text, id) => evidence.set(id, { ref: note.ref, text }));
    if (!/^https:\/\/www\.xiaohongshu\.com\/explore\/[\w-]+(?:\?[^\s()]+)?$/.test(note.url))
      return { error: 'invalid recommendation: source URL is not a returned Xiaohongshu note' };
    if (!notes.some((n) => getXhsNoteKey(n.url) === getXhsNoteKey(note.url))) notes.push(note);
  }
  const names = [item.name, ...item.aliases];
  // 每个别名都必须有来源，每篇引用也必须提到该实体的至少一个名字。
  // 名称仅忽略大小写、空白和标点，仍不翻译/补词/跨段拼接；展名中的年份保持区分。
  const invalidNames = names.filter(
    (name) =>
      !notes.some((n) =>
        name === item.name ? mentionsEntity(n, name) : containsEntityName(n, name),
      ),
  );
  const unrelated = notes.filter((n) => !names.some((name) => mentionsEntity(n, name)));
  if (invalidNames.length || unrelated.length)
    return {
      error: `invalid recommendation: name/aliases not found in sources: ${JSON.stringify(invalidNames)}; unrelated source refs: ${JSON.stringify(unrelated.map((n) => ({ ref: n.ref, title: n.title, opening: n.desc.slice(0, 100) })))}. Copy one actual name from source, add only source-attested aliases or remove unrelated refs`,
    };
  return { notes, evidence };
}
function validateSourceCoverage(
  item: XhsRecommendation,
  sources: XhsNote[],
  candidates: XhsNote[],
): string | null {
  const names = [item.name, ...item.aliases];
  const available = candidates.filter(
    (n) =>
      n.isDetailLoaded !== false &&
      (n.isDetailLoaded === true || n.desc.length >= 100) &&
      names.some((name) => mentionsEntity(n, name)),
  );
  // 同一链接或复制的同一正文不算两份资料，不能靠堆URL凑多源。
  const urls = new Set(available.map((n) => getXhsNoteKey(n.url)));
  const bodies = new Set(available.map((n) => normalizeName(n.desc)));
  if (sources.length > 1 && new Set(sources.map((n) => normalizeName(n.desc))).size < 2)
    return 'invalid recommendation: duplicated original bodies do not add a second source; select complementary notes or keep a labelled single source';
  if (urls.size >= 2 && bodies.size >= 2 && sources.length < 2)
    return `invalid recommendation: combine at least two relevant full notes for this entity; available refs ${available.map((n) => n.ref).join(',')}. Merge what each source adds to description/practical facts; keep venue, date and edition aligned, never pad unrelated links`;
  return null;
}
function findInvalidFacts(
  item: XhsRecommendation,
  sources: Map<string, { ref: string; text: string }>,
): string[] {
  const facts = item.facts;
  if (new Set(facts.map((f) => f.label)).size !== facts.length) return ['duplicate labels'];
  return facts
    .filter((f) => {
      if (f.status === 'unknown') return f.passages.length !== 0;
      const evidence = f.passages.flatMap((id) => sources.get(id) ?? []);
      if (f.passages.some((id) => !sources.has(id))) return true;
      if (f.label === 'price' && !evidence.every((p) => hasPriceInformation(p.text))) return true;
      if (f.status === 'conflicting')
        return !(
          new Set(evidence.map((p) => p.ref)).size >= 2 &&
          new Set(evidence.map((p) => p.text)).size >= 2
        );
      return f.passages.length !== 1;
    })
    .map((f) => f.label);
}

function renderFacts(
  item: XhsRecommendation,
  evidence: Map<string, { ref: string; text: string }>,
  zh: boolean,
): string {
  const lang = zh ? 'zh' : 'en';
  const byLabel = new Map(item.facts.map((f) => [f.label, f]));
  return (['dates', 'venue', 'price', 'booking'] as const)
    .filter((label) => label !== 'booking' || byLabel.has(label))
    .map((label) => {
      const fact = byLabel.get(label);
      const value =
        fact?.status === 'known'
          ? cleanFactText(evidence.get(fact.passages[0]!)!.text)
          : fact?.status === 'conflicting'
            ? zh
              ? '信息冲突，请核实'
              : 'Conflicting reports; verify'
            : zh
              ? '未确认'
              : 'Unconfirmed';
      return `${labels[lang][label]}${zh ? '：' : ': '}${value}`;
    })
    .join(' | ');
}

/** 只去掉原文的展示前缀，不解释或截断日期/票价等事实内容。 */
function cleanFactText(text: string): string {
  return singleLine(text)
    .replace(/^[\p{Extended_Pictographic}\p{M}\u200d\s]+/u, '')
    .replace(
      /^(?:展期|日期|时间|展览地点|地点|地址|票价|门票|费用|预约方式|预约|Dates?|Venue|Price|Booking)\s*[:：]\s*/iu,
      '',
    )
    .replace(/^[:：]\s*/u, '');
}

export function buildXhsRecommendations(p: {
  notes: XhsNote[];
  recommendations: XhsRecommendation[];
  zh: boolean;
  isBroadQuery?: boolean;
  canImproveCoverage?: boolean;
  allowUnconfirmedFactFallback?: boolean;
}):
  | { text: string; notes: XhsNote[]; validatedRecommendations: XhsRecommendation[] }
  | { error: string; validatedRecommendations: XhsRecommendation[] } {
  const byRef = new Map(p.notes.map((n) => [n.ref, n]));
  const names = new Set<string>();
  const groups = new Map<
    string,
    Array<{
      item: XhsRecommendation;
      sources: XhsNote[];
      evidence: Map<string, { ref: string; text: string }>;
    }>
  >();
  const allSources = new Map<string, XhsNote>();
  const errors: string[] = [];
  const validatedRecommendations: XhsRecommendation[] = [];
  if (p.isBroadQuery) {
    const target = Math.max(p.canImproveCoverage ? 2 : 1, Math.ceil(p.recommendations.length / 2));
    const combined = p.recommendations.filter(
      (r) =>
        new Set(
          r.sources.flatMap((s) => {
            const n = byRef.get(s.ref);
            return n && n.isDetailLoaded !== false ? [getXhsNoteKey(n.url)] : [];
          }),
        ).size >= 2,
    ).length;
    if ((combined > 0 || p.canImproveCoverage) && combined < target)
      errors.push(
        `broad research needs at least ${target} primary options synthesized from multiple relevant notes, currently ${combined}. ${p.canImproveCoverage ? 'Read matching candidates or enrich exact shortlisted names with year/edition, then read supporting refs.' : 'Read budget exhausted: stop researching and reduce the selection to your multi-source primary options plus at most the same number of clearly labelled single-source supplements; rewrite intro for that selection.'} Prefer fewer rich options, never pad unrelated links`,
      );
    if (!p.canImproveCoverage && combined === 0 && p.recommendations.length > 3)
      errors.push(
        'broad research is source-limited: return at most three clearly labelled single-source options and say evidence is limited, do not pad a broad recommendation with many uncorroborated items',
      );
  }
  for (const [index, originalItem] of p.recommendations.entries()) {
    const citedNotes = originalItem.sources.flatMap((s) => byRef.get(s.ref) ?? []);
    // 别名不展示；未被来源证实的翻译直接移除，不能让它牵连真实展名/引用或参与关联。
    let item = {
      ...originalItem,
      aliases: originalItem.aliases.filter((a) => citedNotes.some((n) => containsEntityName(n, a))),
    };
    if (isCollectionName(item.name)) {
      errors.push(
        `recommendations[${index}]: invalid recommendation: name is a collection/roundup, not a concrete activity or place. Choose specific venues/events from it and read their supporting notes`,
      );
      continue;
    }
    const sources = gatherSources(item, byRef);
    const keys = [item.name, ...item.aliases].map(normalizeName);
    if ('error' in sources) {
      errors.push(`recommendations[${index}]: ${sources.error}`);
      continue;
    }
    const coverageError = validateSourceCoverage(item, sources.notes, p.notes);
    if (coverageError) {
      errors.push(`recommendations[${index}]: ${coverageError}`);
      continue;
    }
    const invalidFacts = findInvalidFacts(item, sources.evidence);
    if (invalidFacts.length) {
      if (p.allowUnconfirmedFactFallback) {
        const labels = invalidFacts.includes('duplicate labels')
          ? new Set(item.facts.map((f) => f.label))
          : new Set(invalidFacts);
        item = {
          ...item,
          facts: [
            ...new Map(
              item.facts.map((f) => [
                f.label,
                labels.has(f.label) ? { ...f, status: 'unknown' as const, passages: [] } : f,
              ]),
            ).values(),
          ],
        };
      } else {
        errors.push(
          `recommendations[${index}]: invalid recommendation facts.${invalidFacts.join(',')}: known needs exactly one returned passage ID from a note cited in sources; price passage must contain monetary/free-entry information, never a title/intro; unknown needs []; conflicting needs differing passages from two distinct cited notes`,
        );
        continue;
      }
    }
    if (keys.some((key) => names.has(key))) {
      errors.push(
        `recommendations[${index}]: invalid recommendation: duplicate entity or alias; merge with combined sources`,
      );
      continue;
    }
    keys.forEach((key) => names.add(key));
    validatedRecommendations.push(item);
    sources.notes.forEach((n) => allSources.set(n.ref, n));
    const group = singleLine(item.group);
    const bucket = groups.get(group) ?? [];
    bucket.push({ item, sources: sources.notes, evidence: sources.evidence });
    groups.set(group, bucket);
  }
  if (errors.length) return { error: errors.join('\n'), validatedRecommendations };
  let number = 0;
  const blocks = [];
  for (const [group, items] of groups) {
    blocks.push(`【${group}】`);
    for (const { item, sources, evidence } of items) {
      number++;
      const links = sources
        .map((n, i) => `[${p.zh ? '小红书原文' : 'Xiaohongshu note'} ${i + 1}](${n.url})`)
        .join(' · ');
      blocks.push(
        [
          `${number}. ${singleLine(item.name)}`,
          singleLine(item.summary),
          `${p.zh ? '适合：' : 'Best for: '}${singleLine(item.reason)}`,
          renderFacts(item, evidence, p.zh),
          `${p.zh ? '来源：' : 'Source: '}${links}（${sources.length === 1 ? (p.zh ? '单篇资料' : 'single source') : p.zh ? `综合${sources.length}篇` : `${sources.length} notes combined`}）`,
        ].join('\n'),
      );
    }
  }
  return { text: blocks.join('\n\n'), notes: [...allSources.values()], validatedRecommendations };
}
