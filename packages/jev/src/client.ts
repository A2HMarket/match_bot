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
  | { ok: false; reason: 'timeout' | 'rate_limited' | 'http_error' | 'invalid_response' };

export interface JevClient {
  evaluate<Q extends string>(p: {
    state: unknown;
    questions: Record<Q, JevQuestion>;
    inputRef: string;
    phase: Phase;
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
  const timeoutMs = p.timeoutMs ?? 3000;
  const maxRetries = p.maxRetries ?? 3;

  async function once(
    body: string,
  ): Promise<
    | { kind: 'ok'; json: unknown }
    | { kind: 'retry' }
    | { kind: 'fail'; reason: 'timeout' | 'http_error' | 'invalid_response' }
  > {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      // TODO(P4): AGENTS.md §6 / plan/P4-jev.md require Zero Data Retention on Jev
      // requests. The PoC (scripts/poc/v4-jev-inbound/RESULT.md) never recorded a
      // header/field name for this — needs confirmation from Jev's docs or a follow-up
      // PoC before it can be implemented. Not yet implemented.
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
        return { kind: 'fail', reason: 'invalid_response' };
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
      const body = JSON.stringify({ model: p.model, state: q.state, questions: q.questions });
      let outcome: JevOutcome<never> | null = null;
      let cost = 0;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const r = await once(body);
        if (r.kind === 'retry') {
          if (attempt < maxRetries) {
            await new Promise((res) => setTimeout(res, 200 * 2 ** attempt));
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
          { err: e, inputRef: q.inputRef },
          'jev trace write failed; evaluate outcome unaffected',
        );
      }
      if (!outcome.ok)
        p.logger.warn({ reason: outcome.reason, inputRef: q.inputRef }, 'jev unavailable');
      return outcome as never;
    },
  };
}
