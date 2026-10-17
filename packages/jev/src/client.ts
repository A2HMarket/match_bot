import type { Repositories } from '@matchbot/db';
import type { Phase } from '@matchbot/domain';
import type { Logger } from '@matchbot/shared';
import { JEV_ENDPOINT, type JevAnswer, type JevQuestion } from './types.js';
import { jevResponseSchema } from './schema.js';

export type JevOutcome<Q extends string> =
  | {
      ok: true;
      answers: Record<Q, JevAnswer>;
      usage: { input_tokens: number; cost: number };
      id: string;
      provider: string;
      model: string;
    }
  | {
      ok: false;
      reason: 'timeout' | 'rate_limited' | 'http_error' | 'invalid_response' | 'trace_unavailable';
    };

export interface JevClient {
  evaluate<Q extends string>(p: {
    state: unknown;
    questions: Record<Q, JevQuestion>;
    inputRef: string;
    phase: Phase;
    deadlineAt?: number;
  }): Promise<JevOutcome<Q>>;
}

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
  const timeoutMs = p.timeoutMs ?? 5000;
  const maxRetries = p.maxRetries ?? 3;

  async function once(
    body: string,
    deadlineAt?: number,
  ): Promise<
    | { kind: 'ok'; json: unknown }
    | { kind: 'retry' }
    | { kind: 'fail'; reason: 'timeout' | 'http_error' | 'invalid_response' }
  > {
    const remaining =
      deadlineAt === undefined ? timeoutMs : Math.min(timeoutMs, deadlineAt - Date.now());
    if (remaining <= 0) return { kind: 'fail', reason: 'timeout' };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), remaining);
    try {
      const res = await fetchImpl(`${p.baseUrl}${JEV_ENDPOINT}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${p.apiKey}`, 'content-type': 'application/json' },
        body,
        signal: ac.signal,
      });
      if (RETRY_STATUSES.has(res.status)) return { kind: 'retry' };
      if (!res.ok) return { kind: 'fail', reason: 'http_error' };
      try {
        return { kind: 'ok', json: await res.json() };
      } catch {
        return { kind: 'fail', reason: ac.signal.aborted ? 'timeout' : 'invalid_response' };
      }
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
      // AGENTS §6; OpenRouter Decisions accepts the same provider preferences, including per-request ZDR.
      // Do not retry with privacy enforcement removed if routing fails.
      const body = JSON.stringify({
        model: p.model,
        state: q.state,
        questions: q.questions,
        provider: { zdr: true },
      });
      let outcome: JevOutcome<never> | null = null;
      let cost = 0;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const r = await once(body, q.deadlineAt);
        if (r.kind === 'retry') {
          if (attempt < maxRetries) {
            const delay = 200 * 2 ** attempt;
            if (q.deadlineAt !== undefined && q.deadlineAt - Date.now() <= delay) {
              outcome = { ok: false, reason: 'timeout' };
              break;
            }
            await new Promise((res) => setTimeout(res, delay));
          }
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
        const missingAnswer = Object.keys(q.questions).some((id) => !(id in parsed.data.answers));
        if (missingAnswer) {
          outcome = { ok: false, reason: 'invalid_response' };
          break;
        }
        cost = parsed.data.usage.cost;
        outcome = {
          ok: true,
          answers: parsed.data.answers,
          usage: { input_tokens: parsed.data.usage.input_tokens, cost },
          id: parsed.data.id,
          provider: parsed.data.provider,
          model: parsed.data.model,
        };
        break;
      }
      outcome ??= { ok: false, reason: 'rate_limited' };
      try {
        await p.traces.create({
          kind: 'jev',
          inputRef: q.inputRef,
          output: outcome,
          phase: q.phase,
          latencyMs: Date.now() - t0,
          costMicro: Math.round(cost * 1e6),
        });
      } catch (e) {
        p.logger.warn(
          { errorKind: e instanceof Error ? e.name : 'unknown', inputRef: q.inputRef },
          'jev trace write failed; decision unavailable',
        );
        return { ok: false, reason: 'trace_unavailable' } as never;
      }
      if (!outcome.ok)
        p.logger.warn({ reason: outcome.reason, inputRef: q.inputRef }, 'jev unavailable');
      return outcome as never;
    },
  };
}
