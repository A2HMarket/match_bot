import { z } from 'zod';

const noul = z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) });
const choice = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
});
const score = z.object({
  type: z.literal('score'),
  score: z.number(),
  legend: z.record(z.string(), z.string()),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
});
export const jevAnswerSchema = z.discriminatedUnion('type', [noul, choice, score]);
export const jevResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), jevAnswerSchema),
  usage: z.object({ input_tokens: z.number().int(), output_tokens: z.number().int() }),
});
