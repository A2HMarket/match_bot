import type { Repositories } from '@matchbot/db';
import type { Phase } from '@matchbot/domain';
import type { Logger } from '@matchbot/shared';
import { JEV_ENDPOINT, type JevAnswer, type JevQuestion } from './types.js';
import { jevResponseSchema } from './schema.js';

export type JevOutcome<Q extends string> =
  | { ok: true; answers: Record<Q, JevAnswer>; usage: { input_tokens: number } }
  | { ok: false; reason: 'timeout' | 'rate_limited' | 'http_error' | 'invalid_response' };

export interface JevClient {
  evaluate<Q extends string>(p: {
    state: unknown;
    questions: Record<Q, JevQuestion>;
    inputRef: string;
    phase: Phase;
  }): Promise<JevOutcome<Q>>;
}

const USD_PER_INPUT_TOKEN_MICRO = 0.042; // $0.042 / 1M tokens = 0.042 micro-USD / token
const RETRY_STATUSES = new Set([429, 529]);

export function createJevClient(p: {
  baseUrl: string;
  apiKey: string;
  model: string;
  traces: Repositories['traces'];
  logger: Logger;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
}): JevClient {
  const fetchImpl = p.fetchImpl ?? fetch;
  const timeoutMs = p.timeoutMs ?? 3000;
  const maxRetries = p.maxRetries ?? 3;

  async function once(
    body: string,
  ): Promise<
    | { kind: 'ok'; json: unknown }
    | { kind: 'retry' }
    | { kind: 'fail'; reason: 'timeout' | 'http_error' }
  > {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${p.baseUrl}${JEV_ENDPOINT}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${p.apiKey}`, 'content-type': 'application/json' },
        body,
        signal: ac.signal,
      });
      if (RETRY_STATUSES.has(res.status)) return { kind: 'retry' };
      if (!res.ok) return { kind: 'fail', reason: 'http_error' };
      return { kind: 'ok', json: await res.json() };
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return { kind: 'fail', reason: 'timeout' };
      return { kind: 'fail', reason: 'http_error' };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async evaluate(q) {
      const t0 = Date.now();
      const body = JSON.stringify({ model: p.model, state: q.state, questions: q.questions });
      let outcome: JevOutcome<never> | null = null;
      let parsedUsage = 0;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const r = await once(body);
        if (r.kind === 'retry') {
          await new Promise((res) => setTimeout(res, 200 * 2 ** attempt));
          continue;
        }
        if (r.kind === 'fail') {
          outcome = { ok: false, reason: r.reason };
          break;
        }
        const parsed = jevResponseSchema.safeParse(r.json);
        if (!parsed.success) {
          outcome = { ok: false, reason: 'invalid_response' };
          break;
        }
        parsedUsage = parsed.data.usage.input_tokens;
        outcome = { ok: true, answers: parsed.data.answers, usage: { input_tokens: parsedUsage } };
        break;
      }
      outcome ??= { ok: false, reason: 'rate_limited' };
      await p.traces.create({
        kind: 'jev',
        inputRef: q.inputRef,
        output: outcome,
        phase: q.phase,
        latencyMs: Date.now() - t0,
        costMicro: Math.round(parsedUsage * USD_PER_INPUT_TOKEN_MICRO),
      });
      if (!outcome.ok)
        p.logger.warn({ reason: outcome.reason, inputRef: q.inputRef }, 'jev unavailable');
      return outcome as never;
    },
  };
}
