import type { Repositories } from '@matchbot/db';
import type { AgentInputItem, Session } from '@openai/agents';

/**
 * runner 从不给 getItems 传 limit（PoC V3 实测），历史窗口必须自己裁。
 * 40 条足够覆盖多轮补充需求，又不至于把整段群史塞进 prompt。
 */
const MAX_HISTORY_ITEMS = 40;

/**
 * deepseek-flash 把整段思维链塞进 content[].providerData.reasoning_content（PoC V3 实测，
 * 一句 12 词回答落库 2420 字节）。落库前与回放前都剥离：reasoning 不回放给模型。
 */
function stripProviderData<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v: unknown) => stripProviderData(v)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k !== 'providerData') out[k] = stripProviderData(v);
    }
    return out as T;
  }
  return value;
}

/** 从头裁到 MAX_HISTORY_ITEMS，但不能把 function_call_output 和它的 function_call 拆散。 */
function trimHistory(items: AgentInputItem[]): AgentInputItem[] {
  if (items.length <= MAX_HISTORY_ITEMS) return items;
  let start = items.length - MAX_HISTORY_ITEMS;
  while (
    start < items.length &&
    (items[start] as { type?: string } | undefined)?.type === 'function_call_output'
  ) {
    start++;
  }
  return items.slice(start);
}

/**
 * Session 粒度 = 用户（AGENTS.md §3.3 第 7 条）。群上下文与画像走 instructions，不进 session。
 * popItem 返回 undefined 而不是 null（PoC V3：SDK 类型如此，写 null 会 TS2416）。
 */
export function createPgSession(p: { repos: Repositories; userId: string }): Session {
  return {
    getSessionId() {
      return Promise.resolve(p.userId);
    },
    async getItems(limit?: number) {
      const items = (await p.repos.sessionItems.list(p.userId, limit)) as AgentInputItem[];
      return trimHistory(items);
    },
    prepareHistoryItemForModelInput(item: AgentInputItem) {
      return stripProviderData(item);
    },
    async addItems(items: AgentInputItem[]) {
      await p.repos.sessionItems.append(p.userId, items.map(stripProviderData));
    },
    async popItem() {
      const item = (await p.repos.sessionItems.popLast(p.userId)) as AgentInputItem | null;
      return item ?? undefined;
    },
    async clearSession() {
      await p.repos.sessionItems.clear(p.userId);
    },
  };
}
