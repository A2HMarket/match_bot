import { z } from 'zod';
import { knowledgeResultSchema, type KnowledgeResult } from '@matchbot/websearch';

export const knowledgeSourceSchema = knowledgeResultSchema.extend({
  ref: z.string(),
  fetchedAt: z.iso.datetime(),
  passages: z.array(z.object({ id: z.string(), text: z.string().min(1).max(700) })).max(12),
});
export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;

export function createKnowledgeSource(source: KnowledgeResult, index: number): KnowledgeSource {
  const ref = 'k' + index;
  const rows = source.text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 15);
  const chunks = rows
    .flatMap((s) => [...s.matchAll(/[\s\S]{1,650}/g)].map((m) => m[0]))
    .slice(0, 12);
  return {
    ...source,
    ref,
    fetchedAt: new Date().toISOString(),
    passages: (chunks.length ? chunks : [source.text.slice(0, 650)]).map((text, i) => ({
      id: ref + ':p' + (i + 1),
      text,
    })),
  };
}
