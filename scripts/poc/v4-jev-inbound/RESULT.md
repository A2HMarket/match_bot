# V4 — Jev 入站问题集 precision 与延迟

## 结论

**通过。** 在 50 条人工标注的多语种群消息上，Jev（`typesafe/jev-1.13`，实际解析为 `typesafe/jev-1.13-20260917`）的入站 7 问问题集达到：

| 指标                                  | 结果                   | plan Task 4 通过标准 | 判定 |
| ------------------------------------- | ---------------------- | -------------------- | ---- |
| `is_demand` precision @0.70           | **1.00**（tp=22 fp=0） | ≥ 0.90               | PASS |
| `is_demand` recall @0.70              | **1.00**（fn=0 tn=28） | —（未设）            | —    |
| `category` accuracy（全部 50 条）     | **0.98**（49/50）      | —（未设）            | —    |
| `category` accuracy（仅 22 条真需求） | **1.00**（22/22）      | —（未设）            | —    |
| 延迟 p50                              | **325 ms**             | —（未设）            | —    |
| 延迟 p95                              | **517 ms**             | < 2000 ms            | PASS |
| 平均 input tokens / 条                | **1087**               | —（未设）            | —    |
| 成本 / 条                             | **$0.00004565**        | —（未设）            | —    |
| 本轮 50 条总成本                      | **$0.002283**          | —（未设）            | —    |

采用的最终问题集是 `main.ts` 里的 `QUESTIONS_V3`（`JEV_QUESTION_SET=v3`，脚本默认）。**P4 逐字采用该版本**，不要用 plan 里的原始文案（见下方文案消融）。

**路由（重要）**：能用的端点是 OpenRouter alpha decisions，`POST https://openrouter.ai/api/alpha/decisions`，`model: "typesafe/jev-1.13"`。
**直连 `POST https://api.typesafe.ai/v1/systemone` 用本仓库的 `JEV_API_KEY` 返回 401 `authentication_error`（该 key 是 OpenRouter key，不是 TypeSafe key）——不要再重试这条路径**，除非将来拿到真正的 TypeSafe key。原始响应见「证据」。

推荐阈值（AGENTS.md §4.4，落到 `packages/gating` 配置表）：

| 常量                    | 推荐值           | 依据                                                                                                                     |
| ----------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `T_IS_DEMAND_ENTER`     | **0.70**         | 正类 noul 最小 0.86、负类最大 0.13；0.14–0.85 是空带，0.70 居中留双向余量                                                |
| `T_IS_SUPPLY_RECORD`    | **0.80**         | 5 条真服务供给 0.97–0.98；求职消息落在 0.46–0.72，0.80 把它们排除。**必须再用 `category ∈ SERVICE_CATEGORIES` 二次过滤** |
| `T_IS_SENSITIVE_REJECT` | **0.50**         | 2 条换汇/虚拟币 0.98–0.99，其余最高 0.38                                                                                 |
| `T_HAS_LOCATION_MATCH`  | 0.70（**暂定**） | 本样本集没有 `has_location` 的人工标注，不能算校准过                                                                     |
| `T_IS_MOVE_EVENT_TAG`   | 0.70（**暂定**） | 同上，无人工标注                                                                                                         |
| `urgency` 同日阈        | 暂不设           | 见「对 P8 的影响」第 5 条                                                                                                |

## 证据

### 1. 直连 api.typesafe.ai 的 401（确认不可用）

```
$ curl -i -X POST https://api.typesafe.ai/v1/systemone \
    -H "authorization: Bearer $JEV_API_KEY" -H "content-type: application/json" \
    -d '{"model":"jev-latest","state":{...},"questions":{"is_demand":{...}}}'

HTTP/2 401
date: Mon, 21 Sep 2026 08:54:33 GMT
server: istio-envoy
content-type: application/json
x-typesafe-request-id: req_01a0c32c97cb74ad83e33a75236f9e3d

{"detail":{"error_type":"authentication_error","message":"Cannot authenticate with the server. Please check your API key and try again."}}
```

`JEV_API_KEY` 前缀是 `sk-or-v1-`，对 `https://openrouter.ai/api/v1/key` 校验有效（非 management / provisioning key）。Jev **不在** OpenRouter 的 chat 模型目录里（拉取 `/api/v1/models` 共 446 个模型，`jev` / `typesafe` 匹配数为 0），它只在 alpha decisions 端点上可用。

### 2. 可用路由的真实响应（本 PoC 实跑）

```
$ curl -X POST "$JEV_BASE_URL/decisions" -H "authorization: Bearer $JEV_API_KEY" ...
HTTP=200
{"model":"typesafe/jev-1.13-20260917",
 "answers":{"is_demand":{"type":"noul","noul":0.67},
            "urgency":{"type":"score","score":1.68,
                       "legend":{"0":"No time given","1":"Within a week","2":"Within three days","3":"Tomorrow","4":"Today"},
                       "probabilities":{"0":0.01,"1":0.54,"2":0.22,"3":0.22,"4":0.01},
                       "confidence":0.42}},
 "usage":{"input_tokens":375,"output_tokens":36,"cost":0.00001575},
 "id":"gen-dec-1789981050-t6sizUDycbUpwXEUJpjA","provider":"TypeSafe"}
```

**与 `docs/reference/jev-decision-model.md` §3.3 的差异（P4 必须按实际形状写 schema）：**

| 差异                  | 文档                       | 实际                                                                               |
| --------------------- | -------------------------- | ---------------------------------------------------------------------------------- |
| `usage.cost`          | 无此字段                   | 有，USD float。×1e6 直接落 `decision_traces.cost_micro`，不需要本地价格表          |
| `usage.output_tokens` | 文档称输出免费、示例为 `0` | 非 0，本样本集平均 181 / 条；计费仍以 `usage.cost` 为准                            |
| 顶层 `id`             | 无                         | 有，形如 `gen-dec-1789981050-…`，是存进 `decision_traces` 的天然外部引用           |
| 顶层 `provider`       | 无                         | 有，值 `"TypeSafe"`                                                                |
| `model` 回显          | 回显请求值                 | 回显**带日期的 pin**：请求 `typesafe/jev-1.13` → 响应 `typesafe/jev-1.13-20260917` |
| `state`               | 文档端点 `/v1/systemone`   | 实际 `/decisions`（OpenRouter alpha），请求体字段名一致                            |

`score` 答案带 `legend`、`choice` 答案带 `probabilities` + `confidence`，与文档一致。7 个问题在单次请求内并行评估，一次约 1087 input tokens / 350 ms。

### 3. labeled.json 构成（50 条）

| 语言        | 条数   | 其中 demand |
| ----------- | ------ | ----------- |
| zh 中文     | 10     | 5           |
| en 英文     | 10     | 4           |
| ru 俄文     | 10     | 4           |
| uk 乌克兰文 | 10     | 4           |
| pt 葡萄牙文 | 10     | 5           |
| **合计**    | **50** | **22**      |

**demand / non-demand = 22 / 28（44% / 56%）。**

| category（逐字取自 `packages/domain/src/demand.ts`） | 条数 | 其中 demand |
| ---------------------------------------------------- | ---- | ----------- |
| `man_and_van`                                        | 16   | 11          |
| `other`                                              | 8    | 0           |
| `furniture_service`                                  | 6    | 6           |
| `eot_cleaning`                                       | 5    | 5           |
| `housing`                                            | 5    | 0           |
| `job`                                                | 5    | 0           |
| `second_hand`                                        | 5    | 0           |

对抗性覆盖：5 条供给广告（「我有 van」，`category` 仍是 `man_and_van` 但 `is_demand=false`）、5 条找房、5 条招聘/求职（其中 2 条求职内容本身是清洁/搬运，专门用来和 `eot_cleaning`/`man_and_van` 混淆）、5 条二手、2 条换汇/虚拟币（敏感）、3 条纯闲聊、2 条「要搬家但没提出任何请求」的模糊 move-event、以及 20 条含 postcode/outcode 与 30 条只有区域名或完全无地点的对照；时效上覆盖「今天/明天/本周/下周三/下个月/完全没说」。

`group` 取自 Brief §4 的首批实验群与 seed 清单（`@london_housing`、`@londonchatik`、`@ukrainians_london`、`@obyavleniya_anglia`、`@jobsinlondonua`、`@brasileirosemlondresoficial`、`@studentsfromlondon`、`East London Telugu Accommodation 2026`、`@adslondon`、`@rulondon`、`@fosalelondon`、`@bestlondonrent`、`@uk_work_kz`、`@ukindianz`，共 15 个）。**注意：Brief §4 的群 seed 里没有中文群**，中文条目使用占位群名 `@london_chinese_life` 代表 PRD §3 列出的华人社区群；真接入中文群后应替换。

### 4. 文案消融（每行 = 一次完整 50 条实跑）

| 问题集           | 改动                                                                     | precision@0.7 | recall@0.7 | category acc              | p50        | p95        | avg input tok | $/条      |
| ---------------- | ------------------------------------------------------------------------ | ------------- | ---------- | ------------------------- | ---------- | ---------- | ------------- | --------- |
| `v0`             | plan/P0-poc.md Task 4 **逐字文案**                                       | 1.00          | 1.00       | 0.94                      | 372 ms     | 788 ms     | 702           | 0.0000295 |
| `v1`             | v0 + `category` 的 criteria 写全                                         | 1.00          | 1.00       | 0.96                      | 328 ms     | 423 ms     | 748           | 0.0000314 |
| `v2`             | v1 + `is_demand`/`is_supply`/`has_location` 补对称的 true/false criteria | 1.00          | 1.00       | 0.98 / 0.96（两次跑）     | 322–330 ms | 423–502 ms | 1016          | 0.0000427 |
| **`v3`（采用）** | v2 + `category` instructions 加「只按主题分类，与是否求助无关」          | 1.00          | 1.00       | **0.98 / 0.98（两次跑）** | 325–330 ms | 453–517 ms | 1087          | 0.0000457 |

有效改动的归因：

- **写全 `category` 的 criteria**（v0→v1）修掉葡语「刚买了床，谁做单件家具配送」被判成 `furniture_service` 的错误。
- **给 noul 补对称的 true/false criteria**（v1→v2）是提升最大的一步：`is_demand` 正类 noul 下限从 0.77 抬到 0.84–0.86，阈值可用区间从 `[0.50, 0.75]` 扩到 `[0.50, 0.85]`。
- **「只按主题分类」那一句**（v2→v3）本身不提高峰值准确率，但消除了 v2 在边界样本 #19 上的跑间抖动（v2 两次跑 0.98/0.96，v3 两次跑 0.98/0.98）。为稳定性付出的代价是每条多约 70 input tokens（$0.000003）。

本次 PoC 共 6 次完整跑（300 次调用），总成本 **$0.0119**。

### 5. 最终一跑的分离度（v3，n=50）

```
is_demand 阈值扫描：t=0.50 ~ 0.85 全部 precision=1.00 recall=1.00；t=0.90 时 recall 降到 0.86
  gold=true   n=22  min=0.86  p05=0.88  median=0.95  max=0.98  mean=0.94
  gold=false  n=28  min=0.01  median=0.02  p95=0.06  max=0.13  mean=0.03

noul 分布（全部 50 条）
  is_demand      min=0.01 p25=0.02 median=0.03 p75=0.95 max=0.98   >=0.7: 22/50
  is_supply      min=0.01 p25=0.02 median=0.03 p75=0.04 max=0.98   >=0.7:  6/50
  has_location   min=0.02 p25=0.07 median=0.89 p75=0.98 max=0.99   >=0.7: 30/50
  is_sensitive   min=0.01 p25=0.02 median=0.03 p75=0.05 max=0.99   >=0.7:  2/50
  is_move_event  min=0.01 p25=0.06 median=0.42 p75=0.74 max=0.93   >=0.7: 14/50

category 混淆（gold -> predicted）：唯一一条不一致
  40 uk  demand=0.13/F  cat=man_and_van/other  move=0.72
     "Знайшли нарешті квартиру, переїжджаємо через два тижні, ще нічого не організували"
     （找到房子了、两周后搬，但没提出任何请求）——`is_demand=0.13` 正确；`category` 分歧
     出在标注本身（判 `other` 还是「主题是搬家」可争论），且 `is_move_event=0.72` 正确点亮 F14。
```

关键行为观察：

- **需求 / 供给的分离在五种语言里都近乎完美**：5 条供给广告 `is_demand` 全部 ≤ 0.03、`is_supply` 0.97–0.98；22 条真需求 `is_supply` 全部 ≤ 0.04。
- **`category` 判的是「主题」而不是「是不是需求」**：供给广告的 `category` 也是 `man_and_van`（这正是标注设计）。因此 `category` 单独读永远不能当作「这是需求」。
- **`is_supply` 会把求职者也抬起来**：俄语「找清洁工作」0.72、葡语「找清洁工作」0.62、英语「找 kitchen porter」0.46，而它们的 `category` 正确判为 `job`。所以 `is_supply` 必须与 `category ∈ SERVICE_CATEGORIES` 联合使用。
- **`urgency` 在非需求消息上照样会高**：求职消息「可以立刻上工」拿到 3.7、换汇消息 3.8。`urgency` 只能在 `is_demand` 过阈之后读。

## 对 P8 的影响

1. **P4（jev 客户端）的 zod schema 必须按实测形状写，不能照抄 `docs/reference/jev-decision-model.md`。** 端点是 `${JEV_BASE_URL}/decisions`（`JEV_BASE_URL=https://openrouter.ai/api/alpha`），模型 id `typesafe/jev-1.13`。响应多出 `usage.cost`、`id`、`provider` 三个字段，且 `usage.output_tokens` 非 0。把 `output_tokens` 断言为 0、或把 `id`/`provider` 当作可选而丢弃，都会让 P8 拿不到该记的东西。
2. **`decision_traces` 的三个字段直接来自 Jev 响应（AGENTS.md §3.3 第 2 条）**：`cost_micro = Math.round(usage.cost * 1e6)`（不需要自建价格表）、外部引用存顶层 `id`、并且**必须存响应里回显的 `model`（`typesafe/jev-1.13-20260917` 这种带日期的 pin）而不是请求里写的 `typesafe/jev-1.13`**——模型版本一变，本文给出的阈值全部作废，trace 里没有解析后的版本就无法事后判断某条判断是哪版模型做的。P4 应把「响应 model ≠ 上次见到的 model」做成一个告警。
3. **`packages/gating` 的阈值表按「结论」一节落值**，`T_IS_DEMAND_ENTER = 0.70`、`T_IS_SUPPLY_RECORD = 0.80`、`T_IS_SENSITIVE_REJECT = 0.50`。三者都有本样本集的分离度支撑。**`T_HAS_LOCATION_MATCH` 与 `T_IS_MOVE_EVENT_TAG` 只是暂定值：本样本集只标注了 `is_demand` 与 `category`，这两问没有 gold label，因此它们在 Phase 0 只许打标签、不许成为「硬匹配 / 不硬匹配」的开关**，等 P12 用 Shadow 数据补标注后再校准（AGENTS.md §4.4 要求阈值用自己的标注样本校准，不能盲用 0.8）。
4. **P5/P8 不得把 `category` 当需求信号**，也不得把 `is_supply` 单独当供给信号。入站进 agent 的条件必须是 `is_demand ≥ T_IS_DEMAND_ENTER` **且** `category ∈ SERVICE_CATEGORIES`；`housing` / `job` / `second_hand` 只打标签（PRD §2.1、AGENTS.md §3.3 第 10 条）。本 PoC 里 5 条供给广告的 `category` 全是 `man_and_van`，只靠 `category` 路由会把广告直接送进撮合。
5. **`urgency` 只在 `is_demand` 过阈后读。** 实测求职与换汇消息的 `urgency` 也能到 3.7–3.8，它衡量的是「文本里的时间紧迫感」而非「服务需求的紧迫感」。P6 用 `urgency` 匹配 same-day 供应商时，输入必须是已经过 `is_demand` 门的需求。
6. **延迟远低于预算，入站 Jev 调用可以放在 worker 的同步路径上。** p50 325 ms / p95 517 ms，是 2000 ms 预算的 1/4。7 个问题合并成一次请求就能拿全，不需要拆成多次（文档 §3.2：同次请求内问题相互独立、并行评估——本问题集的 7 问确实没有互相依赖）。P8 的入站段可以按「一次 Jev 调用 → 门 → 决定是否进 agent」串行写，不必引入额外的队列跳转。
7. **成本模型：入站每条约 $0.0000457（1087 input tokens）。** 按 Brief §2.2「每 1000 条消息出现多少有效需求」的口径，跑满 8 个实验群每天 1 万条消息，入站判断一天约 $0.46 —— 入站全量过 Jev 在 Phase 0 是经济的，不需要先用规则预筛。但这也意味着**问题集文案长度直接是钱**：v0 到 v3 把 input tokens 从 702 抬到 1087（+55%），P8 若再往 `state` 里塞「该用户近期消息摘要」（文档 §6 的草案）会继续线性放大，改问题集时必须重跑本脚本看 token 数。
8. **AGENTS.md §3.3 第 5 条的降级路径依然是必须实现的，而且本 PoC 把它具体化了**：Jev 路由是 OpenRouter alpha（`/api/alpha/decisions`），一个 alpha 端点 + 一个第三方代理商，比直连多一层失效点；而直连 `api.typesafe.ai` 这条备份路径在当前 key 下是 401 不可用的，**没有 failover**。因此 `packages/jev` 必须把超时 / 429 / 529 / schema 校验失败统一映射成「入站不进 agent，出站送审」，并且这条降级路径要有测试（AGENTS.md §7 `jev` 行）。`main.ts` 已实现 429/529 指数退避（最多 5 次）与严格的 schema 校验（校验失败抛 `JevSchemaError`），P4 可直接移植这两段。
9. **`labeled.json` 交给 P12 复用**：50 条、五语种各 10 条、22/28 的 demand 划分、category 逐字对齐 `DEMAND_CATEGORIES`，满足 AGENTS.md §7「Phase 0 结束前建 ≥ 50 条标注样本放 `packages/eval/fixtures`」。搬过去时需要补的是：(a) `has_location` / `is_move_event` / `urgency` 的人工标注；(b) 真实中文群的群名与真实语料替换掉占位的 `@london_chinese_life`；(c) 现在 22 条真需求里 11 条是 `man_and_van`，`eot_cleaning` 与 `furniture_service` 各只有 5–6 条，品类分布偏斜，P12 扩样本时应优先补这两类。
