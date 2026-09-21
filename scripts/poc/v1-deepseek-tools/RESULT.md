# V1 deepseek-flash 经 Chat Completions 的多工具调用

## 结论

**通过。**

`OpenAIProvider({ baseURL: 'https://api.deepseek.com', apiKey, useResponses: false })` +
`model: 'deepseek-flash'` 能稳定通过 `@openai/agents@0.18.0` 调用 zod 参数工具。

| 变体                                                    | 通过率    | p50     | p95     |
| ------------------------------------------------------- | --------- | ------- | ------- |
| 计划原样（`run_llm_again` 默认）第 1 次                 | **10/10** | 2848 ms | 3365 ms |
| 计划原样 第 2 次（复跑验稳定性）                        | **10/10** | 2728 ms | 5018 ms |
| `toolUseBehavior: 'stop_on_first_tool'`（**推荐**）     | **10/10** | 1458 ms | 1826 ms |
| `stop_on_first_tool` + `.optional()` 代替 `.nullable()` | **10/10** | 1431 ms | 1710 ms |
| `stop_on_first_tool`（根 zod 安装后复跑）               | **10/10** | 1667 ms | 2056 ms |
| `modelSettings.toolChoice: 'required'`                  | **0/10**  | —       | —       |

- 工具 `parameters` 全部是真实 zod schema（`z.object({...})`，含 `z.enum` / `z.number().int()` / `z.string().length(2)`），没有用手写 JSON Schema 绕过。`zod@4.6.5` 原先在工作区根解析不到，已由 `pnpm add -Dw zod@^4.6.5` 加进根 devDependencies；装好后复跑（Run 6）仍然 10/10。
- 10 条样例覆盖 en / zh / ru / pt，一次都没有出现"输出散文而不调工具"。
- 分类（`category`）、多语言槽位抽取（`whenText` 保留原文、`lang` 猜对、`budget £150 -> budgetPence 15000`）全部正确。
- **`toolChoice: 'required'` 不能用**：DeepSeek 直接返回 `400 Thinking mode does not support this tool_choice`。deepseek-flash 是 thinking 模型，只能让它自由选工具。
- 默认 `toolUseBehavior`（`run_llm_again`）下，10 条里有 1~2 条出现**重复/多余的第二次工具调用**（`upsert_supply` 之后又调 `do_nothing`、`upsert_demand` 调两次、`do_nothing` 调两次）。判定只看第一次调用所以不影响通过率，但写库会重复。`stop_on_first_tool` 消除了这个问题，同时把延迟砍掉约一半（少一轮 LLM 往返）。

## 证据

运行命令（密钥来自根 `.env`，未打印）：

```
set -a && . ./.env && set +a && pnpm exec tsx scripts/poc/v1-deepseek-tools/main.ts
```

### Run 1 — 计划原样

```
PASS   2711ms  I need someone with a van this Sunday, moving from  -> upsert_demand {"category":"man_and_van","whenText":"this Sunday","fromPostcode":"E14","toPostcode":"SE1","quantity":"around 8 boxes","budgetPence":null,"lang":"en"}
PASS   3268ms  退租要做 end of tenancy cleaning，1-bed，下周三，SW6  -> upsert_demand {"category":"eot_cleaning","whenText":"下周三","fromPostcode":"SW6","toPostcode":null,"quantity":"1-bed","budgetPence":null,"lang":"zh"}
PASS   3165ms  Кто может собрать шкаф IKEA PAX в субботу? N1  -> upsert_demand {"category":"furniture_service","whenText":"суббота","fromPostcode":"N1","toPostcode":null,"quantity":"1 шкаф IKEA PAX","budgetPence":null,"lang":"ru"}
PASS   3139ms  Tenho uma van livre no domingo, posso ajudar com m  -> upsert_supply {"category":"man_and_van","availability":"domingo","area":"zona leste"}  [!! 2 tool calls: upsert_supply,do_nothing]
PASS   2650ms  有人周末有 van 吗，我可以出车帮忙搬，东伦敦  -> upsert_supply {"category":"man_and_van","availability":"周末","area":"东伦敦"}
PASS   2848ms  Looking for a room near Stratford from 1 March  -> do_nothing {"reason":"Housing search (room wanted near Stratford), not a service demand or offer."}
PASS   3365ms  哈哈哈今天好累  -> do_nothing {"reason":"Chit-chat about being tired; no service demand or offer."}  [!! 2 tool calls: do_nothing,do_nothing]
PASS   2881ms  Need a man and van, 2 bed flat, from Ilford to Cro  -> upsert_demand {"category":"man_and_van","whenText":"next Friday","fromPostcode":"Ilford","toPostcode":"Croydon","quantity":"2 bed flat","budgetPence":15000,"lang":"en"}
PASS   2661ms  Anyone knows a cleaner for end of tenancy? 2 bed,   -> upsert_demand {"category":"eot_cleaning","whenText":null,"fromPostcode":"E1","toPostcode":null,"quantity":"2 bed","budgetPence":null,"lang":"en"}
PASS   2762ms  Selling a double bed frame £40 pick up only SE15  -> do_nothing {"reason":"Selling a second-hand item (double bed frame), not a service demand or offer."}

10/10 passed
latency p50=2848ms p95=3365ms min=2650ms max=3365ms
```

### Run 2 — 计划原样，复跑

```
config: model=deepseek-flash baseURL=https://api.deepseek.com useResponses=false stopOnFirstTool=false toolChoice=(default)
PASS   2857ms  I need someone with a van this Sunday, moving from  -> upsert_demand {"category":"man_and_van","whenText":"this Sunday","fromPostcode":"E14","toPostcode":"SE1","quantity":"around 8 boxes","budgetPence":null,"lang":"en"}
PASS   5018ms  退租要做 end of tenancy cleaning，1-bed，下周三，SW6  -> upsert_demand {"category":"eot_cleaning","whenText":"下周三","fromPostcode":"SW6","toPostcode":null,"quantity":"1-bed","budgetPence":null,"lang":"zh"}  [!! 2 tool calls: upsert_demand,upsert_demand]
PASS   3010ms  Кто может собрать шкаф IKEA PAX в субботу? N1  -> upsert_demand {"category":"furniture_service","whenText":"суббота","fromPostcode":"N1","toPostcode":null,"quantity":"1 шкаф IKEA PAX","budgetPence":null,"lang":"ru"}
PASS   2728ms  Tenho uma van livre no domingo, posso ajudar com m  -> upsert_supply {"category":"man_and_van","availability":"domingo","area":"zona leste"}
PASS   3408ms  有人周末有 van 吗，我可以出车帮忙搬，东伦敦  -> upsert_supply {"category":"man_and_van","availability":"周末 (weekends)","area":"东伦敦 (East London)"}  [!! 2 tool calls: upsert_supply,do_nothing]
PASS   2646ms  Looking for a room near Stratford from 1 March  -> do_nothing {"reason":"Housing search (looking for a room near Stratford), not a man & van / cleaning / furniture service demand."}
PASS   2340ms  哈哈哈今天好累  -> do_nothing {"reason":"Chit-chat about being tired; no service demand or offer."}
PASS   2341ms  Need a man and van, 2 bed flat, from Ilford to Cro  -> upsert_demand {"category":"man_and_van","whenText":"next Friday","fromPostcode":"Ilford","toPostcode":"Croydon","quantity":"2 bed flat","budgetPence":15000,"lang":"en"}
PASS   2606ms  Anyone knows a cleaner for end of tenancy? 2 bed,   -> upsert_demand {"category":"eot_cleaning","whenText":null,"fromPostcode":"E1","toPostcode":null,"quantity":"2 bed","budgetPence":null,"lang":"en"}
PASS   2808ms  Selling a double bed frame £40 pick up only SE15  -> do_nothing {"reason":"Message is selling a second-hand item (double bed frame, £40, pickup SE15), not a service demand or offer."}

10/10 passed
latency p50=2728ms p95=5018ms min=2340ms max=5018ms
```

### Run 3 — `modelSettings.toolChoice: 'required'`（DeepSeek 拒绝）

```
config: model=deepseek-flash baseURL=https://api.deepseek.com useResponses=false stopOnFirstTool=true toolChoice=required
FAIL    631ms  I need someone with a van this Sunday, moving from  -> undefined undefined  [error: Error: 400 Thinking mode does not support this tool_choice]
FAIL    647ms  退租要做 end of tenancy cleaning，1-bed，下周三，SW6  -> undefined undefined  [error: Error: 400 Thinking mode does not support this tool_choice]
FAIL    435ms  Кто может собрать шкаф IKEA PAX в субботу? N1  -> undefined undefined  [error: Error: 400 Thinking mode does not support this tool_choice]
FAIL    431ms  Tenho uma van livre no domingo, posso ajudar com m  -> undefined undefined  [error: Error: 400 Thinking mode does not support this tool_choice]
FAIL    478ms  有人周末有 van 吗，我可以出车帮忙搬，东伦敦  -> undefined undefined  [error: Error: 400 Thinking mode does not support this tool_choice]
FAIL    453ms  Looking for a room near Stratford from 1 March  -> undefined undefined  [error: Error: 400 Thinking mode does not support this tool_choice]
FAIL    435ms  哈哈哈今天好累  -> undefined undefined  [error: Error: 400 Thinking mode does not support this tool_choice]
FAIL    469ms  Need a man and van, 2 bed flat, from Ilford to Cro  -> undefined undefined  [error: Error: 400 Thinking mode does not support this tool_choice]
FAIL    452ms  Anyone knows a cleaner for end of tenancy? 2 bed,   -> undefined undefined  [error: Error: 400 Thinking mode does not support this tool_choice]
FAIL    482ms  Selling a double bed frame £40 pick up only SE15  -> undefined undefined  [error: Error: 400 Thinking mode does not support this tool_choice]

0/10 passed
latency p50=453ms p95=647ms min=431ms max=647ms
```

### Run 4 — `toolUseBehavior: 'stop_on_first_tool'`（推荐配置）

```
config: model=deepseek-flash baseURL=https://api.deepseek.com useResponses=false stopOnFirstTool=true toolChoice=(default)
PASS   1458ms  I need someone with a van this Sunday, moving from  -> upsert_demand {"category":"man_and_van","whenText":"this Sunday","fromPostcode":"E14","toPostcode":"SE1","quantity":"8 boxes","budgetPence":null,"lang":"en"}
PASS   1826ms  退租要做 end of tenancy cleaning，1-bed，下周三，SW6  -> upsert_demand {"category":"eot_cleaning","whenText":"下周三","fromPostcode":"SW6","toPostcode":null,"quantity":"1-bed","budgetPence":null,"lang":"zh"}
PASS   1523ms  Кто может собрать шкаф IKEA PAX в субботу? N1  -> upsert_demand {"category":"furniture_service","whenText":"суббота","fromPostcode":"N1","toPostcode":null,"quantity":"1 шкаф IKEA PAX","budgetPence":null,"lang":"ru"}
PASS   1294ms  Tenho uma van livre no domingo, posso ajudar com m  -> upsert_supply {"category":"man_and_van","availability":"domingo","area":"zona leste"}
PASS   1632ms  有人周末有 van 吗，我可以出车帮忙搬，东伦敦  -> upsert_supply {"category":"man_and_van","availability":"weekend","area":"East London"}
PASS   1103ms  Looking for a room near Stratford from 1 March  -> do_nothing {"reason":"Message is a housing/room search request, not a man & van, cleaning, or furniture service demand or offer."}
PASS   1263ms  哈哈哈今天好累  -> do_nothing {"reason":"Chit-chat about being tired; no service demand or offer."}
PASS   1632ms  Need a man and van, 2 bed flat, from Ilford to Cro  -> upsert_demand {"category":"man_and_van","whenText":"next Friday","fromPostcode":"Ilford","toPostcode":"Croydon","quantity":"2 bed flat","budgetPence":15000,"lang":"en"}
PASS   1354ms  Anyone knows a cleaner for end of tenancy? 2 bed,   -> upsert_demand {"category":"eot_cleaning","whenText":null,"fromPostcode":"E1","toPostcode":null,"quantity":"2 bed","budgetPence":null,"lang":"en"}
PASS   1725ms  Selling a double bed frame £40 pick up only SE15  -> do_nothing {"reason":"Message is a second-hand item sale (double bed frame, £40, pickup SE15), not a service demand or offer."}

10/10 passed
latency p50=1458ms p95=1826ms min=1103ms max=1826ms
```

### Run 5 — `.optional()` 代替 `.nullable()`

```
config: model=deepseek-flash baseURL=https://api.deepseek.com useResponses=false stopOnFirstTool=true toolChoice=(default) optionalInsteadOfNullable=true
PASS   1315ms  I need someone with a van this Sunday, moving from  -> upsert_demand {"category":"man_and_van","whenText":"this Sunday","fromPostcode":"E14","toPostcode":"SE1","quantity":"around 8 boxes","lang":"en"}
PASS   1604ms  退租要做 end of tenancy cleaning，1-bed，下周三，SW6  -> upsert_demand {"category":"eot_cleaning","whenText":"下周三","fromPostcode":"SW6","quantity":"1-bed","lang":"zh"}
PASS   1647ms  Кто может собрать шкаф IKEA PAX в субботу? N1  -> upsert_demand {"category":"furniture_service","whenText":"суббота","fromPostcode":"N1","quantity":"1 шкаф IKEA PAX","lang":"ru"}
PASS   1251ms  Tenho uma van livre no domingo, posso ajudar com m  -> upsert_supply {"category":"man_and_van","availability":"domingo","area":"zona leste"}
PASS   1710ms  有人周末有 van 吗，我可以出车帮忙搬，东伦敦  -> upsert_supply {"category":"man_and_van","availability":"周末","area":"东伦敦"}
PASS   1683ms  Looking for a room near Stratford from 1 March  -> do_nothing {"reason":"Housing search (looking for a room near Stratford), not a man & van / cleaning / furniture service demand."}
PASS   1225ms  哈哈哈今天好累  -> do_nothing {"reason":"Chit-chat about being tired; not a service demand or offer."}
PASS   1206ms  Need a man and van, 2 bed flat, from Ilford to Cro  -> upsert_demand {"category":"man_and_van","whenText":"next Friday","fromPostcode":"Ilford","toPostcode":"Croydon","quantity":"2 bed flat","budgetPence":15000,"lang":"en"}
PASS   1580ms  Anyone knows a cleaner for end of tenancy? 2 bed,   -> upsert_demand {"category":"eot_cleaning","fromPostcode":"E1","quantity":"2 bed","lang":"en"}
PASS   1431ms  Selling a double bed frame £40 pick up only SE15  -> do_nothing {"reason":"Message is selling a second-hand item (double bed frame), not a service demand or offer."}

10/10 passed
latency p50=1431ms p95=1710ms min=1206ms max=1710ms
```

### Run 6 — `zod` 装到根 devDependencies 后复跑推荐配置

```
config: model=deepseek-flash baseURL=https://api.deepseek.com useResponses=false stopOnFirstTool=true toolChoice=(default) optionalInsteadOfNullable=false
PASS   1802ms  I need someone with a van this Sunday, moving from  -> upsert_demand {"category":"man_and_van","whenText":"this Sunday","fromPostcode":"E14","toPostcode":"SE1","quantity":"around 8 boxes","budgetPence":null,"lang":"en"}
PASS   1667ms  退租要做 end of tenancy cleaning，1-bed，下周三，SW6  -> upsert_demand {"category":"eot_cleaning","whenText":"下周三","fromPostcode":"SW6","toPostcode":null,"quantity":"1-bed","budgetPence":null,"lang":"zh"}
PASS   1753ms  Кто может собрать шкаф IKEA PAX в субботу? N1  -> upsert_demand {"category":"furniture_service","whenText":"суббота","fromPostcode":"N1","toPostcode":null,"quantity":"1 (шкаф IKEA PAX)","budgetPence":null,"lang":"ru"}
PASS   1410ms  Tenho uma van livre no domingo, posso ajudar com m  -> upsert_supply {"category":"man_and_van","availability":"domingo","area":"zona leste"}
PASS   1629ms  有人周末有 van 吗，我可以出车帮忙搬，东伦敦  -> upsert_supply {"category":"man_and_van","availability":"weekend","area":"East London"}
PASS   2056ms  Looking for a room near Stratford from 1 March  -> do_nothing {"reason":"Housing search (looking for a room), not a service demand or offer."}
PASS   1183ms  哈哈哈今天好累  -> do_nothing {"reason":"Chit-chat in Chinese (\"haha I'm so tired today\"), not a service demand or offer."}
PASS   1523ms  Need a man and van, 2 bed flat, from Ilford to Cro  -> upsert_demand {"category":"man_and_van","whenText":"next Friday","fromPostcode":"Ilford","toPostcode":"Croydon","quantity":"2 bed flat","budgetPence":15000,"lang":"en"}
PASS   1830ms  Anyone knows a cleaner for end of tenancy? 2 bed,   -> upsert_demand {"category":"eot_cleaning","whenText":null,"fromPostcode":"E1","toPostcode":null,"quantity":"2 bed","budgetPence":null,"lang":"en"}
PASS   1743ms  Selling a double bed frame £40 pick up only SE15  -> do_nothing {"reason":"Message is a private sale of a second-hand item (double bed frame, £40, pick up only SE15), not a request for or offer of a service."}

10/10 passed
latency p50=1667ms p95=2056ms min=1183ms max=2056ms
```

## 对 P8 的影响

1. **Provider 配置按假设可用，照抄即可。**

   ```ts
   setDefaultModelProvider(
     new OpenAIProvider({
       baseURL: process.env.DEEPSEEK_BASE_URL, // https://api.deepseek.com
       apiKey: process.env.DEEPSEEK_API_KEY,
       useResponses: false, // 必须；DeepSeek 只有 Chat Completions
     }),
   );
   ```

   `OpenAIProviderOptions` 里确实有 `useResponses?: boolean`，签名与计划一致。
   `Agent` 的 `model` 直接写模型名字符串 `'deepseek-flash'` 即可。

2. **必须设 `toolUseBehavior: 'stop_on_first_tool'`。** 这是 V1 最重要的结论。默认的
   `run_llm_again` 下 deepseek-flash 会在工具返回后再跑一轮，10 条里 1~2 条会多调一次工具
   （同一个工具调两次，或 `upsert_supply` 之后补一个 `do_nothing`）。V1 的判定只看第一次调用所以
   看不出来，但在 P8 里就是**重复写库 / 状态被后一次调用覆盖**。加上这一行之后 5 次运行 0 次重复，
   而且延迟少一轮往返，p50 从 ~2.8s 降到 ~1.45s。

   ```ts
   new Agent({ ..., toolUseBehavior: 'stop_on_first_tool' })
   ```

   如果业务上确实需要一次 run 里调多个工具，那就别用这个开关，改成在 tool `execute` 里做幂等
   （按 message_id upsert），不要指望 prompt 能压住第二次调用。

3. **不要用 `modelSettings.toolChoice: 'required'` / `{ type: 'function', ... }`。**
   deepseek-flash 是 thinking 模型，服务端直接 400：`Thinking mode does not support this tool_choice`。
   P8 里只能靠 instructions（"Call exactly one tool. Never reply with prose."）+ `do_nothing`
   兜底工具来保证一定有工具调用——本 PoC 50 次调用里没有一次输出散文，这个组合够用。

4. **`nullable` 与 `optional` 在 DeepSeek 上都能跑通（各 10/10），但选 `nullable`。**
   理由不是准确率，是类型与协议：
   - `@openai/agents` 的 zod 工具参数**强制 `strict: true`**（`tool.d.ts`: "Zod schemas are not supported
     without strict: true"），严格 JSON Schema 语义下所有字段都必须 required，`nullable` 才是合法的
     "可为空"写法；`optional` 只是 DeepSeek 没严格校验才放过去。日后换回 OpenAI 官方端点会炸。
   - `nullable` 下模型每次都把所有 key 填齐（缺失值写 `null`），`optional` 下 key 直接消失
     （见 Run 5 的 `budgetPence`/`toPostcode`）。前者在 TS 侧只有 `T | null` 一种分支，写库更简单。

5. **单次调用延迟预算：p50 ≈ 1.45 s、p95 ≈ 1.9 s（stop_on_first_tool，非流式，10 条串行）。**
   默认双轮配置是 p50 ≈ 2.8 s、p95 最坏见过 5.0 s。按 P8 的 worker 设计，一条群消息的 LLM 分类
   按 **2 s 预算、5 s 超时、可重试** 来设计是安全的；不要放在 Telegram webhook 的同步路径上。

6. **SDK 签名与计划的差异（已核对 `@openai/agents@0.18.0`）：**
   - 计划中 `OpenAIProvider` / `setDefaultModelProvider` / `setTracingDisabled` / `Agent` / `run` /
     `tool` 全部从 `@openai/agents` 顶层导出，属实，无需改。
   - 计划没提到的：`toolUseBehavior: ToolUseBehaviorFlags = 'run_llm_again' | 'stop_on_first_tool'`
     （`agent.d.ts:105`），P8 要用。
   - **`zod` 原先在工作区根解析不到**：它只作为 `@openai/agents` 的传递依赖躺在
     `node_modules/.pnpm/zod@4.6.5`，根上 `import 'zod'` 报 `ERR_MODULE_NOT_FOUND`。本次 PoC 期间
     已经 `pnpm add -Dw zod@^4.6.5` 把它加进根 `devDependencies`（装好后复跑 Run 6 仍 10/10）。
     **P8 的 `packages/agent` 还要把 `zod@^4.6.5` 写进自己的 `dependencies`**，版本必须和
     `@openai/agents` 用的一致，否则 zod 双实例会让 `tool()` 的 schema 转换报错。
