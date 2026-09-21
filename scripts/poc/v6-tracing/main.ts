/**
 * PoC V6 —— 自定义 tracing processor
 *
 * 验证三件事：
 *  1. 用 setTraceProcessors([custom]) 替换 SDK 默认的 OpenAI tracing 导出是否可行；
 *  2. 自定义 processor 收到哪些 span 类型、每类 span 上到底有哪些字段
 *     （token usage 在哪个 span、latency 从哪里来、prompt/response 原文是否在 span 里）；
 *  3. 替换之后进程有没有向 api.openai.com 发过任何请求。
 *
 * 用法：
 *   tsx scripts/poc/v6-tracing/main.ts                 # 默认：自定义 processor
 *   tsx scripts/poc/v6-tracing/main.ts --no-sensitive  # traceIncludeSensitiveData: false
 *   tsx scripts/poc/v6-tracing/main.ts --control       # 对照组：保留 SDK 默认 OpenAI exporter
 *
 * --control 是"出站拦截器本身有效"的对照实验：它不替换默认 processor，并给一个假的
 * OPENAI_API_KEY 让默认 exporter 真的尝试导出；拦截器在发现目标是 api.openai.com 时
 * 直接抛错阻断（所以对照组也不会把任何数据真的发给 OpenAI），只记录"曾经尝试连它"。
 */

import net from 'node:net';
import { z } from 'zod';

const MODE_CONTROL = process.argv.includes('--control');
const MODE_NO_SENSITIVE = process.argv.includes('--no-sensitive');
const RUN_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// 1. 出站流量拦截（必须在 import @openai/agents 之前装好）
// ---------------------------------------------------------------------------

type HostHit = { host: string; paths: Set<string>; count: number; blocked: number };
const fetchHits = new Map<string, HostHit>();
const tcpHits = new Map<string, number>();

function recordFetch(host: string, path: string, blocked: boolean): void {
  const hit = fetchHits.get(host) ?? { host, paths: new Set<string>(), count: 0, blocked: 0 };
  hit.paths.add(path);
  hit.count += 1;
  if (blocked) hit.blocked += 1;
  fetchHits.set(host, hit);
}

// (a) 应用层：全局 fetch —— openai SDK 与 OpenAITracingExporter 都走它
const originalFetch = globalThis.fetch;
globalThis.fetch = async function patchedFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const raw =
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  let host = '<unparsable>';
  let path = raw;
  try {
    const u = new URL(raw);
    host = u.host;
    path = u.pathname;
  } catch {
    /* ignore */
  }
  const shouldBlock = MODE_CONTROL && host === 'api.openai.com';
  recordFetch(host, path, shouldBlock);
  console.log(
    `[net:fetch] ${init?.method ?? 'GET'} ${host}${path}${shouldBlock ? '  <= BLOCKED BY POC' : ''}`,
  );
  if (shouldBlock) {
    throw new Error('[poc-v6] outbound request to api.openai.com blocked by interceptor');
  }
  return originalFetch(input as never, init);
} as typeof fetch;

// (b) 传输层：所有 TCP 连接（undici 的 net.connect / tls.connect 最终都走 Socket.prototype.connect）
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(this: net.Socket, ...args: unknown[]) {
  const first = args[0];
  let host = '<unknown>';
  if (first && typeof first === 'object') {
    const o = first as { host?: string; servername?: string; path?: string; port?: number };
    host = o.servername ?? o.host ?? o.path ?? '<unknown>';
    if (o.port) host = `${host}:${o.port}`;
  } else if (typeof first === 'number' && typeof args[1] === 'string') {
    host = `${args[1] as string}:${first}`;
  } else if (typeof first === 'string') {
    host = first;
  }
  tcpHits.set(host, (tcpHits.get(host) ?? 0) + 1);
  console.log(`[net:tcp]   connect ${host}`);
  return originalConnect.apply(this, args as never);
} as typeof net.Socket.prototype.connect;

// ---------------------------------------------------------------------------
// 2. 载入 SDK（此时 @openai/agents 的 index.js 会注册默认 OpenAI tracing exporter）
// ---------------------------------------------------------------------------

const agents = await import('@openai/agents');
const {
  Agent,
  OpenAIProvider,
  Runner,
  setDefaultModelProvider,
  setTraceProcessors,
  tool,
  getGlobalTraceProvider,
} = agents;
type Span<T> = InstanceType<typeof agents.Span<T>>;
type Trace = InstanceType<typeof agents.Trace>;
type TracingProcessor = Parameters<typeof setTraceProcessors>[0][number];

// ---------------------------------------------------------------------------
// 3. 自定义 processor
// ---------------------------------------------------------------------------

type Event =
  | {
      kind: 'trace';
      phase: 'start' | 'end';
      traceId: string;
      name: string;
      groupId: string | null;
      metadata?: unknown;
    }
  | {
      kind: 'span';
      phase: 'start' | 'end';
      type: string;
      spanId: string;
      parentId: string | null;
      traceId: string;
      startedAt: string | null;
      endedAt: string | null;
      durationMs: number | null;
      error: unknown;
      traceMetadata: unknown;
      data: unknown;
      json: unknown;
    };

const events: Event[] = [];

function snapshotSpan(s: Span<never>, phase: 'start' | 'end'): Event {
  const startedAt = s.startedAt;
  const endedAt = s.endedAt;
  return {
    kind: 'span',
    phase,
    type: (s.spanData as { type: string }).type,
    spanId: s.spanId,
    parentId: s.parentId,
    traceId: s.traceId,
    startedAt,
    endedAt,
    durationMs:
      startedAt && endedAt ? new Date(endedAt).getTime() - new Date(startedAt).getTime() : null,
    error: s.error,
    traceMetadata: s.traceMetadata,
    // 深拷贝：SDK 会在 span 结束后继续复用同一个对象
    data: JSON.parse(JSON.stringify(s.spanData)),
    json: phase === 'end' ? s.toJSON() : undefined,
  };
}

const processor: TracingProcessor = {
  async onTraceStart(t: Trace) {
    events.push({
      kind: 'trace',
      phase: 'start',
      traceId: t.traceId,
      name: t.name,
      groupId: t.groupId,
      metadata: t.metadata,
    });
  },
  async onTraceEnd(t: Trace) {
    events.push({
      kind: 'trace',
      phase: 'end',
      traceId: t.traceId,
      name: t.name,
      groupId: t.groupId,
      metadata: t.metadata,
    });
  },
  async onSpanStart(s: Span<never>) {
    events.push(snapshotSpan(s, 'start'));
  },
  async onSpanEnd(s: Span<never>) {
    events.push(snapshotSpan(s, 'end'));
  },
  async shutdown() {},
  async forceFlush() {},
};

if (MODE_CONTROL) {
  // 对照组：不替换默认 processor，并给假 key 让默认 exporter 真的去尝试导出
  process.env.OPENAI_API_KEY = 'sk-poc-v6-fake-key-never-valid';
  console.log('[mode] CONTROL —— 保留 SDK 默认 OpenAI tracing exporter');
} else {
  setTraceProcessors([processor]);
  console.log('[mode] CUSTOM —— setTraceProcessors([ourProcessor])，默认 OpenAI exporter 已被替换');
}

setDefaultModelProvider(
  new OpenAIProvider({
    baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY!,
    useResponses: false,
  }),
);

// ---------------------------------------------------------------------------
// 4. 一个带 echo 工具的 agent，跑一轮
// ---------------------------------------------------------------------------

const echo = tool({
  name: 'echo',
  description: 'Echo text back to the caller',
  parameters: z.object({ text: z.string() }),
  execute: async ({ text }) => text,
});

const agent = new Agent({
  name: 'poc-v6',
  model: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash',
  instructions: 'Call the echo tool with the user text, then answer "done".',
  tools: [echo],
});

const timeout = new Promise<never>((_, reject) =>
  setTimeout(
    () => reject(new Error(`run timed out after ${RUN_TIMEOUT_MS}ms`)),
    RUN_TIMEOUT_MS,
  ).unref(),
);

// 注意：traceIncludeSensitiveData / workflowName / groupId / traceMetadata 属于 RunConfig，
// 只能通过 new Runner(config) 传，run(agent, input, options) 的第三参是 RunOptions，传不进去。
const runner = new Runner({
  workflowName: 'poc-v6-workflow',
  groupId: 'poc-v6-group-42',
  traceMetadata: { phase: 'phase0', tg_user_id: '12345' },
  ...(MODE_NO_SENSITIVE ? { traceIncludeSensitiveData: false } : {}),
});

let runError: unknown = null;
let finalOutput: string | undefined;
try {
  const result = await Promise.race([runner.run(agent, 'hello tracing'), timeout]);
  finalOutput = result.finalOutput;
} catch (err) {
  runError = err;
}

// 让默认 / 自定义 processor 把队列里的东西吐出去
await getGlobalTraceProvider().forceFlush();
await getGlobalTraceProvider().shutdown();

// ---------------------------------------------------------------------------
// 5. 打印结果
// ---------------------------------------------------------------------------

console.log('\n========== RUN ==========');
console.log('finalOutput:', JSON.stringify(finalOutput));
if (runError) console.log('runError:', runError instanceof Error ? runError.message : runError);

console.log('\n========== EVENTS RECEIVED BY CUSTOM PROCESSOR ==========');
console.log(`total events: ${events.length}`);
for (const e of events) {
  if (e.kind === 'trace') {
    console.log(
      `\n--- trace.${e.phase} traceId=${e.traceId} name=${JSON.stringify(e.name)} groupId=${String(e.groupId)} metadata=${JSON.stringify(e.metadata)}`,
    );
    continue;
  }
  console.log(
    `\n--- span.${e.phase} type=${e.type} spanId=${e.spanId} parentId=${String(e.parentId)} traceId=${e.traceId}`,
  );
  console.log(
    `    startedAt=${String(e.startedAt)} endedAt=${String(e.endedAt)} durationMs=${String(e.durationMs)}`,
  );
  console.log(
    `    error=${JSON.stringify(e.error)} traceMetadata=${JSON.stringify(e.traceMetadata)}`,
  );
  console.log(`    spanData keys = [${Object.keys(e.data as object).join(', ')}]`);
  console.log(`    spanData = ${JSON.stringify(e.data, null, 2)}`);
  if (e.phase === 'end') console.log(`    span.toJSON() = ${JSON.stringify(e.json)}`);
}

console.log('\n========== SPAN TYPE SUMMARY (span.end only) ==========');
const byType = new Map<string, number>();
for (const e of events) {
  if (e.kind === 'span' && e.phase === 'end') byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
}
for (const [t, n] of byType) console.log(`  ${t}: ${n}`);

console.log('\n========== WHERE IS usage? ==========');
for (const e of events) {
  if (e.kind !== 'span' || e.phase !== 'end') continue;
  const d = e.data as Record<string, unknown>;
  console.log(`  ${e.type}: usage=${'usage' in d ? JSON.stringify(d.usage) : '<absent>'}`);
}

console.log('\n========== OUTBOUND HOSTS (fetch layer) ==========');
if (fetchHits.size === 0) console.log('  <none>');
for (const h of fetchHits.values()) {
  console.log(
    `  ${h.host}  calls=${h.count} blocked=${h.blocked} paths=[${[...h.paths].join(', ')}]`,
  );
}
console.log('========== OUTBOUND HOSTS (tcp layer, net.Socket.prototype.connect) ==========');
if (tcpHits.size === 0) console.log('  <none>');
for (const [h, n] of tcpHits) console.log(`  ${h}  connects=${n}`);

const touchedOpenAI = [...fetchHits.keys(), ...tcpHits.keys()].some((h) =>
  h.includes('api.openai.com'),
);
console.log(`\nRESULT: api.openai.com contacted? ${touchedOpenAI ? 'YES' : 'NO'}`);

process.exit(runError ? 1 : 0);
