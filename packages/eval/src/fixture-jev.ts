import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { LabeledSample } from './samples.js';

/**
 * 录制下来的 Jev 响应。CI 里的回放一律走这里，不打真实 Jev
 * （AGENTS.md §7 jev 行、plan/P12-eval.md Global Constraints）。
 * 只有手动 `pnpm eval --live` 才联网。
 */
export const jevFixtureSchema = z.object({
  recordedAt: z.string(),
  /** 录制时请求里写的模型 id（如 typesafe/jev-1.13）。 */
  requestModel: z.string(),
  entries: z.record(
    z.string(),
    z.object({
      latencyMs: z.number().int().nonnegative(),
      /** 原样保存的 HTTP 响应体，回放时由真实 JevClient 做 zod 校验。 */
      response: z.unknown(),
    }),
  ),
});
export type JevFixture = z.infer<typeof jevFixtureSchema>;

export const JEV_FIXTURE_URL = new URL('../fixtures/jev-inbound.json', import.meta.url);

export function loadJevFixture(url: URL = JEV_FIXTURE_URL): JevFixture {
  return jevFixtureSchema.parse(JSON.parse(readFileSync(url, 'utf8')));
}

const requestBodySchema = z.object({ state: z.object({ text: z.string() }) });

/**
 * 把录制的响应包成 `fetchImpl` 注入真实 createJevClient，
 * 这样回放走的是生产同一条解析与降级路径，而不是一个平行实现。
 */
export function createFixtureFetch(p: {
  samples: readonly LabeledSample[];
  fixture: JevFixture;
}): typeof fetch {
  const idByText = new Map(p.samples.map((s) => [s.text, s.id]));
  return (_input, init) => {
    const raw = init?.body;
    if (typeof raw !== 'string') {
      return Promise.reject(new Error('fixture fetch: expected a JSON string body'));
    }
    const body = requestBodySchema.safeParse(JSON.parse(raw));
    if (!body.success) return Promise.reject(new Error('fixture fetch: unparsable request body'));
    const id = idByText.get(body.data.state.text);
    const entry = id === undefined ? undefined : p.fixture.entries[id];
    if (!entry) {
      return Promise.reject(
        new Error(`fixture fetch: no recorded Jev response for sample ${id ?? '<unknown text>'}`),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(entry.response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
}

/** 录制里的真实延迟；fixture 回放本身没有网络，延迟只能从录制里读。 */
export function recordedLatencies(fixture: JevFixture): number[] {
  return Object.values(fixture.entries)
    .map((e) => e.latencyMs)
    .sort((a, b) => a - b);
}
