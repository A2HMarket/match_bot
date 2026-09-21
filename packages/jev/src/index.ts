/**
 * Jev 客户端与问题集。接口规格见 docs/reference/jev-decision-model.md §3。
 * 契约：超时 3s；429/529 指数退避 3 次；失败时入站按"不进 agent"、出站按"送审"处理；每次调用写 decision_traces(kind=jev)。
 */
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
  usage: { input_tokens: number; output_tokens: number };
}

export const JEV_ENDPOINT = '/v1/systemone';
