# V2 RunState 跨进程恢复

跑的日期：2026-09-21 · SDK：`@openai/agents` 0.18.0 / `@openai/agents-core` 0.18.0 · 模型：`deepseek-flash`（`OpenAIProvider({ baseURL, useResponses: false })`）

## 结论

**通过。** 四个验证点逐条回答：

1. **`needsApproval: true` 的工具会中断 run** —— 通过。`run()` 正常返回（不抛错），`result.interruptions` 有 1 条 `type: 'tool_approval_item'`，其 `rawItem` 是 `type: 'function_call'`，带 `name: 'reply_in_group'`、`arguments`（JSON 字符串）、`callId`。工具的 `execute` 没有被调用。

2. **跨进程 `toString` → `RunState.fromString` → `approve` → `run` 能真正执行工具** —— 通过。`pause.ts` 与 `resume.ts` 是两个独立的 `tsx` 进程，中间只经过 `/tmp/poc-v2-state.json` 这个文件。`resume.ts` 里 `state.getInterruptions().length === 1`，`approve()` 后 `run(agent, state)` 使 `sent` 数组从 0 变成 1，工具确实执行了。

3. **`addInput(...)` 在暂停期间写入的内容会进到模型** —— 通过，但**不是在当次 model call 生效，而是在批准的工具执行完之后的下一次 model call**。`state.pendingInput` 读回 `[{type:'message',role:'user',content:'Also, my budget is £120 max.'}]`；恢复后的 `result.history` 角色序列是 `user, function_call, function_call_result, user, function_call, function_call_result, assistant` —— 注入的 user 消息排在第一次工具结果之后。模型据此发起了第二次 `reply_in_group`，文案里出现 `£120 max noted`，即 `addInput` 确实到达了模型。
   **顺带发现（计划里没写、但对 P8 很重要）**：批准一次 ≠ run 跑完。`addInput` 让模型又发起一次需批准的工具调用，第一次 `run()` 返回时 `interruptions.length === 1`、`finalOutput` 为 `undefined`（SDK 打印 `Accessed finalOutput before agent run is completed.`）。必须循环"批准 → run → 检查 interruptions"直到 `interruptions` 为空。

4. **同一份快照能不能被恢复两次** —— **SDK 不拦截，可以重放**，与预期一致，**证实了 `AGENTS.md` §3.3 第 6 条的必要性**。用同一份 `raw` 字符串第二次 `RunState.fromString` → `approve` → `run`，工具又执行了一次（`sent` 3 → 从 2 涨到 3），并且这次跑到了 `finalOutput`。SDK 里没有任何 nonce / 已消费标记；`runStateIdentity.ts` 只做 agent 名到实例的映射，跟重放无关。**去重只能由我们自己的 `run_states` 条件更新做。**

补充事实：

- **快照大小：22 680 bytes（UTF-8），22 316 chars**，仅一次 model call + 一个待批准工具调用。gzip 后 2 583 bytes。
- **快照包含完整消息历史与原始用户文本**：`originalInput` 就是 `"I need a van Sunday E14 to SE1, 8 boxes"`；待发文案在 `modelResponses` / `lastModelResponse` / `lastProcessedResponse` / `generatedItems` / `currentStep` 里各存一份（约 5 倍放大，这 5 个键占了 22 680 中的 21 308）。`context` 里还有 usage（token 数）与 `approvals`。**→ §6 "`run_states.snapshot` 落库前加密"是硬需求，快照就是明文 PII。**
- **`fromString` 要求 agent 图一致**，绑定键是**名字**：
  - 传入名字不同的 agent → `UserError: Agent poc-v2 not found`；
  - 传入同名但缺了 `reply_in_group` 工具的 agent → `UserError: Tool reply_in_group not found`。
  - instructions 不参与校验，所以**改 instructions 不会让旧快照反序列化失败，但会让恢复后的这一轮用新 instructions 跑**——静默行为变更，比报错更危险。
- **`$schemaVersion = "1.20"`**，`runState.js` 里有 `SUPPORTED_SCHEMA_VERSIONS` 白名单，不在名单内直接 `UserError: Run state schema version X is not supported.`。

### 与计划代码的差异 / SDK 签名更正

- 计划里 `agent.ts` 用 `zod`，但**根 `node_modules` 没有 zod**（它只是 `@openai/agents` 的 peer，未提升到根）。为了不动 `package.json`，本 PoC 改用 SDK 原生支持的 `JsonObjectSchema` 写 `parameters`（`ToolInputParameters` 联合类型里就有）。副作用：`execute` 的参数类型退化为 `unknown`，要手动断言。
- 计划里 `i.rawItem.name` / `i.rawItem.arguments` **类型上不直接可用**：`RunToolApprovalItem['rawItem']` 是联合类型（可能是 `function_call`、也可能是 hosted/computer 调用），要先窄化或 `in` 判断。运行时字段名本身是对的。
- `import './agent.js'`（`.ts` 源码写 `.js` 后缀）在 tsx + NodeNext 下**解析正常**，无需改。
- 已核对无误的签名：`RunState.fromString(initialAgent, str): Promise<RunState>`（静态、异步）、`state.getInterruptions(): RunToolApprovalItem[]`、`state.approve(item, { alwaysApprove? })`、`state.reject(item, { alwaysReject?, message? })`、`state.addInput(string | AgentInputItem[])`、`state.pendingInput`、`state.clearPendingInput()`、`state.toString({ includeTracingApiKey? })`、`result.interruptions`。
- 另有 `RunState.fromStringWithContext(agent, str, context, { contextStrategy })`，恢复时要带回我们自己的 `RunContext`（chatId / userId / phase）就用它，P8 需要。
- `toString()` **默认剥掉 tracing API key**，无需额外处理。
- `run()` 支持 `{ signal }`，本 PoC 用 `AbortSignal.timeout(90_000)` 防挂死。

## 证据

`pause.ts`（进程 1）：

```
$ set -a && . ./.env && set +a && pnpm exec tsx scripts/poc/v2-runstate-resume/pause.ts
interruptions: [{"type":"tool_approval_item","rawItemType":"function_call","tool":"reply_in_group","args":"{\"text\": \"Got it — Sunday, E14 → SE1, 8 boxes. Two options:\\n\\nOption A — Man & Van (driver + van, they do the lifting)\\n• Best if you'd rather not drive/park a van yourself\\n• Roughly 1–1.5 hrs typical for a short E14→SE1 run with 8 boxes; Sunday rates usually carry a minimum (often 2 hrs)\\n• Check they confirm Sunday availability and whether the price includes loading/unloading and Congestion Charge/ULEZ\\n\\nOption B — Self-drive van hire\\n• Cheaper per hour if you're happy to drive and can park at both ends\\n• You'd need a valid licence, deposit, and to watch mileage limits and Sunday opening hours for collection/return\\n\\nTo firm up quotes, can you confirm: pickup time on Sunday, full postcodes, any stairs/lift at either end, and whether the boxes are already packed and ground-floor? I'll get two firm prices once I have that.\"}","callId":"call_00_cXh5Stpx7gmv3eNL60Lg7568"}]
state saved to /tmp/poc-v2-state.json
bytes (utf8) = 22680  chars = 22316
$schemaVersion = 1.20
top-level keys = $schemaVersion,currentTurn,currentAgent,originalInput,modelResponses,context,toolUseTracker,maxTurns,currentAgentSpan,noActiveAgentRun,inputGuardrailResults,outputGuardrailResults,toolInputGuardrailResults,toolOutputGuardrailResults,currentTurnInProgress,currentStep,lastModelResponse,generatedItems,currentResponseGeneratedItemOwnership,pendingAgentToolRuns,pendingAgentToolRunAliases,lastProcessedResponse,currentTurnPersistedItemCount,completedToolInvocations,completedToolInvocationEvidence,ambiguousToolInvocationCallIds,trace
snapshot contains original user text? true | contains tool arguments text? true
```

`resume.ts`（进程 2，长文案已在脚本里截断到 160/200 字符）：

```
$ set -a && . ./.env && set +a && pnpm exec tsx scripts/poc/v2-runstate-resume/resume.ts
=== RESUME #1 (with addInput) ===
rehydrated interruptions = 1
pendingInput = [{"type":"message","role":"user","content":"Also, my budget is £120 max."}]
round 1: sent=1 interruptions=1
round 1: new interruptions -> [{"tool":"reply_in_group","callId":"call_00_jEzyvUHOBJsxWnoaRifX6760","args":"{\"text\": \"Thanks — £120 max noted. That's doable, but tight-ish for a Sunday, so worth being strategic:\\n\\nOption A — Man & Van, capped at £120\\n• Look for a 1–"}]
round 2: sent=2 interruptions=0
round 2: new interruptions -> []
final #1: I've posted both replies to the group — the two-option breakdown (man & van vs self-drive hire) and an update factoring in your £120 ceiling, with the key questions still needed to lock in firm quotes (Sunday pickup time, full postcodes, stairs/lift, and whether the boxes are packed and ground-floor).
sent #1 (each truncated to 200 chars):
  [0] Got it — Sunday, E14 → SE1, 8 boxes. Two options: ⏎  ⏎ Option A — Man & Van (driver + van, they do the lifting) ⏎ • Best if you'd rather not drive/park a van yourself ⏎ • Roughly 1–1.5 hrs typical for a short
  [1] Thanks — £120 max noted. That's doable, but tight-ish for a Sunday, so worth being strategic: ⏎  ⏎ Option A — Man & Van, capped at £120 ⏎ • Look for a 1–1.5 hr minimum deal, or a "small van + 1 man" rate ra
addInput reached the model? -> true
history roles = ["user","function_call","function_call_result","user","function_call","function_call_result","assistant"]
budget message present in history? -> true

=== RESUME #2 (same snapshot again, no addInput) ===
SECOND RESUME RAN — SDK did NOT block the replay.
sent count before=2 after=3 (tool executed again = true)
second final: I've posted the reply to the group with two options (man & van vs. self-drive hire) for your Sunday E14 → SE1 move of 8 boxes, and asked for the details needed to firm up quotes.

=== fromString with a DIFFERENT agent graph ===
DIFFERENT AGENT GRAPH rejected: UserError: Agent poc-v2 not found

=== fromString with same name but different instructions/tools ===
rejected: UserError: Tool reply_in_group not found
```

快照体积构成（对 `/tmp/poc-v2-state.json` 跑 `node -e`）：

```
total bytes: 22680
   5031 modelResponses
   5029 lastModelResponse
   4743 lastProcessedResponse
   4268 generatedItems
   2237 currentStep
    393 context
    143 currentResponseGeneratedItemOwnership
     94 trace
gzip bytes: 2583
originalInput: "I need a van Sunday E14 to SE1, 8 boxes"
context keys: [ 'usage', 'approvals', 'approvalInvocations', 'context' ]
```

## 对 P8 的影响

**1. 存储与加密（`packages/db` + `packages/agent`）**

- `run_states.snapshot` 列用 `bytea`（存密文），**不要**用 `jsonb`：加密后不是 JSON，且 jsonb 会额外膨胀。本次最小 run 已 22.7 KB，真实场景带 session 历史与多轮工具会到几十到上百 KB；**先 gzip 再加密**（本例 22 680 → 2 583，约 8.8×），否则 TOAST 压力和加密开销都白给。
- §6 的"落库前加密"是刚性的，不是保守做法：快照里 `originalInput` 是群成员原话、`generatedItems` 是待发文案，全是明文 PII，而且同一段文本在 5 个键里各存一份。加解密封在 `packages/db` 的 `run-state-store.ts`，`packages/agent` 只见明文字符串。
- 序列化用 `state.toString()` 即可，默认不含 tracing key；不要传 `includeTracingApiKey: true`。
- §6 的"7 天后标 `expired`"落成 cron，同时物理清空 `snapshot` 列而不只是改状态，否则 PII 还在。

**2. 重放必须由我们自己的原子消费挡住（这是本 PoC 最关键的结论）**

- 已实测：SDK **不会**拒绝同一份快照的第二次恢复，工具会被再执行一次、群里会被再发一次。`AGENTS.md` §3.3 第 6 条不是防御性写法，是唯一防线。
- worker 的 `resume_run` 必须是：`UPDATE run_states SET status='consumed', consumed_at=now() WHERE id=$1 AND status='pending' RETURNING snapshot` —— **一条语句里同时消费并取出快照**，`rowCount === 0` 直接放弃并记 `decision_traces`。不要先 SELECT 再 UPDATE。
- 审批回调（Telegram callback query / 未来的 admin）天然会重复投递（用户连点、Telegram 重试），BullMQ 的 `jobId` 幂等只挡同 id 重复入队，挡不住同一快照被两条不同 job 恢复；DB 条件更新是唯一可靠层。
- 严禁把快照塞进 BullMQ payload 或回调 data 里；job 只带 `runStateId`，快照只从服务端存储读（§3.3 第 6 条后半句）。

**3. 批准一次不等于跑完 —— 恢复是个循环，每一轮都要重新落库**

- 实测第一次 `run(agent, state)` 返回时 `interruptions.length === 1`、`finalOutput === undefined`。`resume_run` 的处理逻辑必须是：
  1. 原子消费取出快照 → `fromStringWithContext` → approve/reject → `run()`；
  2. 若 `result.interruptions.length > 0` → **写一条新的 `run_states` 行（新 id，`status='pending'`）**，发新的审批卡，本次 job 结束；
  3. 若为 0 → 写 `outbound_messages`，run 终结。
- 不要在一个 job 里循环等审批。也不要把新快照写回原行——原行已经 `consumed`，新 id 才能让下一次审批继续走同一套原子消费。
- 不要读 `result.finalOutput` 来判断是否完成（会触发 SDK 警告且为 `undefined`），判据是 `result.interruptions.length === 0`。

**4. `addInput` 的正确用法：承载审批时的人工修改**

- 审批人在卡片上写的补充/修正（"改成只发一个选项"、"加上预算上限"）用 `state.addInput(...)` 注入，**在 `approve()` 之前调用**，它会作为一条 user 消息排在被批准工具的结果之后、下一次 model call 之前。
- 但注意语义：`addInput` **不会修改已经待批准的那次工具调用的参数**。本次实测的结果是——旧文案照原样发出去了，新预算只影响了**下一条**。所以：
  - 要"改文案再发" → `reject(item, { message: '...' })` 把修改意见作为拒绝理由回给模型，让它重出一版，**不要**用 approve + addInput；
  - 要"这条照发，另外补充一句" → approve + `addInput`。
  - 这两条路径在 `packages/approval` 的决策枚举里要分开（`approve` / `approve_with_note` / `reject_with_note`），不要混成一个。
- `addInput` 之后必然产生新一轮 interruption（出站工具都有 `needsApproval`），配合第 3 点的循环，审批人可能要点两次——UI 上要说清楚。

**5. 快照与 SDK 版本绑定（对 `AGENTS.md` §2 升级条款的量化）**

- 快照带 `$schemaVersion`（当前 `"1.20"`），`fromString` 对不在 `SUPPORTED_SCHEMA_VERSIONS` 白名单的版本直接 `UserError`。升 `@openai/agents` 前清空待审 `run_states` 的规定是对的。
- 建议在 `run_states` 加两列：`sdk_version`（`@openai/agents` 的版本）和 `agent_version`（§8 第 4 条的 `AGENT_VERSION`）。恢复前先比对，不一致就走"作废 + 通知审批人重来"，不要硬 `fromString`。
- **agent 图按名字绑定**：`Agent.name` 改名或删工具 → `UserError: Agent X not found` / `Tool Y not found`（显式失败，能接住）。但**改 instructions 不报错**，旧快照会用新 instructions 继续跑——这正是 §8 第 4 条要求 `AGENT_VERSION` 递增的原因，必须靠上面那个版本列拦，SDK 帮不了。
- `fromString` 会抛 `UserError`，`packages/agent` 要把它映射成明确的失败值（§5 "不吞错误"），worker 据此把该审批标为 `stale` 而不是重试。

**6. 其他**

- `packages/agent` 恢复时用 `RunState.fromStringWithContext(agent, str, ctx)` 而不是 `fromString`，把 `chatId` / `userId` / `phase` 这些 `RunContext` 带回来（`fromString` 只恢复快照里序列化的那份 context）。
- `run()` 一律传 `{ signal: AbortSignal.timeout(...) }`，worker 的 job 超时要大于它。
- 快照里 `context.usage` 有 `inputTokens` / `outputTokens` / `requestUsageEntries`，可以在恢复时补记 `decision_traces` 的 `cost_micro`（§3.3 第 2 条），不用额外从 tracing 里捞。
