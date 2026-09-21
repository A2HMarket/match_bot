export type JevQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };

export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | {
      type: 'score';
      score: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
      confidence: number;
    };

export interface JevResponse<Q extends string> {
  model: string;
  answers: Record<Q, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number; cost: number };
  id: string;
  provider: string;
}

export const JEV_ENDPOINT = '/decisions';
