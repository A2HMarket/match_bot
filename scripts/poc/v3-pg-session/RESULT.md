# V3 Postgres 自定义 Session

## 结论

**通过。**

- `implements Session` 只需 **5 个必需方法**，另有 4 个可选 hook。SDK 0.18.0 的真实签名（逐字摘自 `node_modules/@openai/agents-core/dist/memory/session.d.ts`）：

```ts
/**
 * Interface representing a persistent session store for conversation history.
 */
export interface Session {
  getSessionId(): Promise<string>;
  getItems(limit?: number): Promise<AgentInputItem[]>;
  prepareHistoryItemForModelInput?(item: AgentInputItem): AgentInputItem;
  prepareHistoryItemsForPersistenceComparison?(items: AgentInputItem[]): AgentInputItem[];
  preserveReasoningItemIdsForPersistence?(): boolean;
  addItems(items: AgentInputItem[]): Promise<void>;
  replaceHistoryWithCompaction?(items: AgentInputItem[]): Promise<void>;
  popItem(): Promise<AgentInputItem | undefined>;
  clearSession(): Promise<void>;
}
```

与 plan 的猜测差异：**`popItem()` 返回 `Promise<AgentInputItem | undefined>`（不是 `| null`）**；多出 4 个可选 hook；另有 `RunContextAwareSession`（加 `readonly acceptsRunContext: true` 后每个方法多收一个 `runContext`）、`SessionHistoryTransactionAwareSession`（`applyHistoryTransaction`，原子幂等）等可选子接口。

- `session` 的传法与 plan 一致：`run(agent, input, { session, sessionInputCallback })`。二者都在 `SharedRunOptions` 上（`run.d.ts:190-191`），`sessionInputCallback` 也可放 `RunConfig`（`run.d.ts:159`）。真实签名：

```ts
export type SessionInputCallback = (
  historyItems: AgentInputItem[],
  newItems: AgentInputItem[],
) => AgentInputItem[] | Promise<AgentInputItem[]>;
```

- **历史确实跨轮带入**：第 2 轮问 "Where am I moving from?"，模型答 "You're moving from E14."（E14 只在第 1 轮出现过）。
- **`sessionInputCallback` 在纯 string 输入时会被调用**：第 3 轮传 string，回调被调用 1 次，收到 `historyItems.length = 4`、`newItems.length = 1`，string 已被规范化成 `{type:'message', role:'user', content:'...'}`。源码 `prepareInputItemsWithSession` 先 `toAgentInputList(input)` 再调回调，所以输入是 string 还是数组都一样。
- **一轮追加 2 条**（无工具调用时：1 条 user + 1 条 assistant）。
- **SDK 从不调用 `popItem()`**：全 dist 里 `popItem` 只有类型声明和 `MemorySession` 自己的实现，runner 无调用点。`clearSession()` 则会被 runner 调用，但只在 compaction 替换历史的路径里（`replaceSessionItemsWithRecovery`，需要 `compaction` item，我们不用 OpenAI Responses compaction 就不会触发）。
- **`getItems(limit)` 语义是"最近 N 条，按时间正序返回"**（`session.d.ts` 注释：_"When provided the most recent limit items should be returned in chronological order"_）。但 **runner 永远不传 limit**：`getSessionItems()` 默认 `SESSION_LIMIT_UNSET`，9 处调用点全部以 `getItems()` 无参调用。所以裁剪必须由我们自己在 `getItems()` 内部做，或者用 `sessionInputCallback`。

## 证据

`set -a && . ./.env && set +a && pnpm exec tsx scripts/poc/v3-pg-session/main.ts` 真实输出（超长的 `reasoning_content` 已用 `[...]` 标出截断处，完整原文见下方"单条样本"）：

```
sessionId = user-42
turn 1 answer: I can help—what pickup time and drop-off location do you need for a van in E14 this Sunday?
turn 1 appended 2 items (total 2)
turn 2 answer: You’re moving from E14.
turn 2 appended 2 items (total 4)
history carried (answer mentions E14): true
stored items: 4
--- all stored items (compact) ---
0 {"role":"user","type":"message","content":"I need a van on Sunday from E14."}
1 {"id":"c694684b-8f0b-4d36-8cc9-4f6f756a7072","role":"assistant","type":"message","status":"completed","content":[{"text":"I can help—what pickup time and drop-off location do you need for a van in E14 this Sunday?","type":"output_text","providerData":{"role":"assistant","reasoning_content":"We need answer user. Need parse. [...约 1.9KB 思维链... ] Given desired answer in one short sentence. Final. "}}]}
2 {"role":"user","type":"message","content":"To SE1, about 8 boxes. Where am I moving from?"}
3 {"id":"4de96500-301f-4821-9d8a-8289bc908297","role":"assistant","type":"message","status":"completed","content":[{"text":"You’re moving from E14.","type":"output_text","providerData":{"role":"assistant","reasoning_content":"We need answer. Need parse. [...约 0.4KB 思维链...] Answer: E14. Need one short sentence. Must answer in one short sentence. Also maybe acknowledge. \"You're moving from E14.\" That's it. Ensure no extra."}}]}
getItems(2) === ["{\"role\":\"user\",\"type\":\"message\",\"content\":\"To SE1, about 8 b","{\"id\":\"4de96500-301f-4821-9d8a-8289bc908297\",\"role\":\"assista"]
turn 3 answer: Your destination postcode is SE1.
sessionInputCallback calls (string input): 1
sessionInputCallback saw: {"history":4,"newItems":1,"newItemsJson":"[{\"type\":\"message\",\"role\":\"user\",\"content\":\"And what is my destination postcode?\"}]"}
turn 3 appended 2 items (total 6)
popItem() returned: {"id":"d3c378af-c472-4ef0-8f33-89a268bdaccf","role":"assistant","type":"message","status":"completed","content":[{"text"
items after popItem: 5
```

单条样本（user item，完整原文，`poc_session_items.item` 的 jsonb 值）：

```json
{
  "role": "user",
  "type": "message",
  "content": "I need a van on Sunday from E14."
}
```

单条样本（assistant item，完整结构；`reasoning_content` 的正文为节省篇幅截断，其余字段逐字）：

```json
{
  "id": "c694684b-8f0b-4d36-8cc9-4f6f756a7072",
  "role": "assistant",
  "type": "message",
  "status": "completed",
  "content": [
    {
      "text": "I can help—what pickup time and drop-off location do you need for a van in E14 this Sunday?",
      "type": "output_text",
      "providerData": {
        "role": "assistant",
        "reasoning_content": "We need answer user. Need parse. \"I need a van on Sunday from E14.\" Likely they want rent a van? [... 完整约 1.9KB ...] Given desired answer in one short sentence. Final. "
      }
    }
  ]
}
```

落库后的真实行大小（`psql`，同一次运行的 5 行）：

```
 user_id | seq |   role    | bytes | json_chars
---------+-----+-----------+-------+------------
 user-42 |   1 | user      |    87 |         82
 user-42 |   2 | assistant |  1266 |       2420
 user-42 |   3 | user      |   101 |         96
 user-42 |   4 | assistant |   742 |        724
 user-42 |   5 | user      |    91 |         86
```

（第 6 行是被脚本末尾 `popItem()` 手动删掉的 assistant item。）

SDK 源码证据（`@openai/agents-core@0.18.0`）：

- `runner/sessionPersistence.mjs:34` `async function getSessionItems(session, runContext, limit = SESSION_LIMIT_UNSET)`，9 个调用点（271/317/512/1044/1150/1381/1461/1519…）全部不传 limit。
- `grep -rn popItem dist --exclude=*.map` → 只有 `memory/session.d.ts`（声明）与 `memory/memorySession.{js,mjs,d.ts}`（MemorySession 自身实现），**无 runner 调用点**。
- `session.clearSession()` 的唯一调用点是 `runner/sessionPersistence.mjs:1507/1529` 的 `replaceSessionItemsWithRecovery` / `restoreSessionItemsAfterFailedReplacement`（compaction 路径）。
- `runner/sessionPersistence.mjs:1131` `const newInputItems = toAgentInputList(input);` → `1171` `const combined = await sessionInputCallback(history, newInputItems);`，说明 string 输入同样触发回调。

`popItem` 返回 `| null` 的编译证据（把本目录 `pg-session.ts` 的返回类型改成 `| null` 后 `tsc --strict --noEmit`）：

```
error TS2416: Property 'popItem' in type 'PgSession' is not assignable to the same property in base type 'Session'.
  Type '() => Promise<AgentInputItem | null>' is not assignable to type '() => Promise<AgentInputItem | undefined>'.
        Type 'null' is not assignable to type 'AgentInputItem | undefined'.
```

（本目录实际提交的 `pg-session.ts` 在同样的 `tsc --strict` 下零报错。）

## 对 P8 的影响

**`packages/db`：表结构**

- 会话粒度是**用户**（AGENTS.md §3.3 第 7 条）。建议 Prisma model `SessionItem` / `@@map("session_items")`：
  - `id String @id @default(cuid())`
  - `userId String @map("user_id")` → FK 到 `User`
  - `seq Int @map("seq")` — 单调序号，`@@unique([userId, seq])`，`@@index([userId, seq])`
  - `item Json @map("item")` — 原样存 `AgentInputItem`（结构不稳定，按 §4.1 只能进 JSON 列；`domain` 侧无需 zod 全量建模，SDK 自己反序列化）
  - `createdAt DateTime @default(now()) @db.Timestamptz @map("created_at")` — 用于 30 天保留与裁剪
  - 可选 `role String?`、`byteSize Int?` 冗余列，便于裁剪与统计而不用解 JSON
- **不要**把 `chatId` / `messageId` 放进这张表的主键或唯一键：群和消息不是会话粒度，群上下文走 instructions 注入。若要审计可加一个可空 `sourceMessageId`。
- `seq` 用 `(SELECT COALESCE(MAX(seq),0)+1 …)` 生成在并发下有竞态；**仓储实现必须对 `(user_id)` 上锁或用 `INSERT … ON CONFLICT` 重试**，否则同一用户并发两条入站消息会撞主键。推荐把 `addItems` 做成单条事务 + `SELECT … FOR UPDATE` 取当前 max(seq)，或者直接用 `bigserial` 全局序列当 `seq`（顺序性够用，不要求连续）。

**增长率与裁剪**

- 无工具调用时 **每轮 2 条**（user + assistant）。有工具调用的轮次还会追加 `function_call` / `function_call_result` item，本 PoC 未测，P8 落地时需实测（预计 1 个工具 = +2 条）。
- 体积主要被 **`content[].providerData.reasoning_content` 撑大**：deepseek-flash 把整段思维链塞进这里，实测单条 assistant item 724–2420 字符（jsonb 742–1266 字节），而 user item 只有 ~90 字节。**这段思维链不但占存储，还会在下一轮被原样回放给模型**，直接抬高 input tokens 与成本。
- 因此 `packages/agent` 的 session 实现**必须**：
  1. 在 `addItems()` 里剥掉 `providerData.reasoning_content`（或整个 `providerData`）再落库，或
  2. 实现可选 hook `prepareHistoryItemForModelInput(item)` 把它从回放输入里摘掉（SDK 明确为此提供该 hook：_"strip provider-managed replay metadata while preserving their public getItems() shape"_）。
     推荐 1 + 2 都做：落库瘦身省存储，hook 保证回放干净。
- **裁剪必须自己做**：runner 永远以 `getItems()` 无参调用，拿到多少就发多少。在我们的 `getItems()` 里实现 "最近 N 条 / 最近 M 小时" 窗口（SQL 用 `ORDER BY seq DESC LIMIT N` 再外层 `ORDER BY seq` 转回正序），并保证不把 `function_call` 和它的 `function_call_result` 拆散（截断边界要按轮次对齐，否则模型会看到孤儿 tool call——SDK 自己有 `dropOrphanToolCalls`，但只在无 `sessionInputCallback` 的分支里生效）。
- 冷数据按 AGENTS.md §6 的 30 天保留跑 cron 删除；`session_items` 里含用户原文，属于个人数据，PR 里要写保留期。

**`packages/agent`：接口落地要点**

- 实现 `Session` 只需 `getSessionId / getItems / addItems / popItem / clearSession` 五个方法。`popItem()` 返回类型写 `Promise<AgentInputItem | undefined>`（plan 里的 `| null` 会编译失败，`strict` 下 `null` 不能赋给 `undefined`）。
- **`popItem()` 可以只留一个安全实现（SDK 不会调它）**，仓储设计不必为它优化；但 `clearSession()` 会被 runner 在 compaction 路径调用，实现要真的能删干净并且可回滚，不能抛。
- 需要在 session 方法里拿 `RunContext`（例如把 `runId` 写进 `decision_traces`）时，改成实现 `RunContextAwareSession` 并加 `readonly acceptsRunContext: true`，否则 runner 走 legacy 调用形状、不传 context。
- 需要"入站消息与 session 写入原子"时，可选实现 `SessionHistoryTransactionAwareSession.applyHistoryTransaction({ operationId, transaction })`——SDK 要求实现方把 operationId 与历史变更原子持久化、重复 operationId 幂等。这与 §3.3 第 6 条的原子消费思路一致，P8 值得评估。
- `sessionInputCallback` 确认可用且对 string 输入生效，是注入"群上下文 / 用户画像"或做"窗口裁剪"的第二个钩子；但注意用了它以后 SDK 不再帮你跑 `dropOrphanToolCalls`（见 `prepareInputItemsWithSession` 的 `if (!sessionInputCallback)` 分支），孤儿 tool call 要自己防。

**与 plan 的签名差异汇总**

| plan 写的                                    | 实际                                                             |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `popItem(): Promise<AgentInputItem \| null>` | `popItem(): Promise<AgentInputItem \| undefined>`                |
| 只有 5 个方法                                | 5 必需 + 4 可选 hook + 3 个可选子接口                            |
| `getItems(limit)` 靠 `items.slice(-limit)`   | 语义正确（最近 N 条正序），但 runner 从不传 limit                |
| （未提）                                     | `sessionInputCallback` 在 `RunOptions` 与 `RunConfig` 两处都可传 |
