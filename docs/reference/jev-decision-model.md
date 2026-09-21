# Jev（TypeSafe AI Decision Model）技术摘要

| 项               | 内容                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 整理日期         | 2026-09-21                                                                                                                                                                                                                                                                                                                                                                        |
| 来源             | 内部调研稿《Jev：当 AI 不再负责"写答案"，而只负责"做判断"》（原文见 [jev-调研-原文.md](./jev-调研-原文.md)）；TypeSafe 官方 API 参考 https://docs.typesafe.ai/api；Vercel KB《How to classify, route, and score with Jev and AI SDK》https://vercel.com/kb/guide/typesafe-jev-and-ai-sdk；Vercel《Where does Jev fit in an AI agent loop?》https://vercel.com/i/jev-agent-control |
| 在本项目中的角色 | 撮合 agent 的 **decision 模型**：入站判断（是不是需求 / 哪个品类）、出站判断（值不值得发 / 该不该自动发）、lead 质量打分。生成文案由 deepseek-flash 负责                                                                                                                                                                                                                          |

## 1. 一句话定义

**unstructured state in, typed probabilistic decisions out。** 复杂状态进去，程序可消费的概率决策出来。Jev 不生成文本，只在程序给定的有限候选里做判断，并返回整个概率分布。

## 2. 适用边界（三问法）

| 问题                     | 归属                           | 本项目里的例子                                                                                        |
| ------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 答案能不能直接算出来？   | **代码**                       | postcode 是否在供应商 service_area 内；该群 24h 内是否已回复过；当前是否 Phase 0                      |
| 不能算，但候选答案已知？ | **Jev**                        | 这条消息是不是需求；属于搬家 / 清洁 / 家具 / 找房 / 招聘 / 二手 / 其他哪一类；紧急程度；是否 same-day |
| 答案需要被创造？         | **生成模型（deepseek-flash）** | 抽取自由字段（起点、终点、数量的原文归一化）；写群内回复文案；写供应商 lead 文案                      |

原则：能算的不让 AI 猜；能选择的不让 AI 生成；只有答案本身需要被创造时才调用生成模型。

## 3. API（已核对官方文档）

### 3.1 端点

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

也可经 Vercel AI Gateway 使用，模型 id `typesafe-ai/jev`，AI SDK 7 通过 `experimental_evaluate` 调用。LiteLLM、Pydantic AI、AI/ML API 均有接入。

### 3.2 请求体

```json
{
  "model": "jev-latest",
  "state": "<string | object | array>",
  "questions": {
    "<question_id>": { "type": "noul" | "choice" | "score", "instructions": "...", "criteria": ... }
  }
}
```

| 字段        | 说明                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `state`     | 待评估状态。字符串、JSON 对象或数组均可；对象结构会被模型读取                                                    |
| `model`     | `jev-latest` 为旗舰                                                                                              |
| `questions` | 问题 map，key 即响应里的 key。同一次请求内的问题**相互独立、并行评估**，不能互相依赖；有依赖的判断要拆成两次请求 |

三种原语：

| 类型                | 请求                                                                                               | 响应                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **noul**（Boolean） | `{ type: "noul", instructions, criteria?: { true: "...", false: "..." } }`                         | `{ type: "noul", noul: 0~1 }`，0.5 表示不确定                                                |
| **choice**          | `{ type: "choice", instructions, criteria: { option_key: "描述" \| null, ... } }`，最多 255 个选项 | `{ type: "choice", choice: "<key>", probabilities: { key: p }, confidence: 0~1 }`            |
| **score**           | `{ type: "score", instructions, criteria: ["level0 描述", ..., "levelN 描述"] }`，2~10 级          | `{ type: "score", score: 概率加权均值, legend, probabilities: { "0": p, ... }, confidence }` |

`instructions` 与 `criteria` 的值都允许是字符串、对象或数组。

### 3.3 响应体

```json
{
  "model": "jev-latest",
  "answers": {
    "is_demand": { "type": "noul", "noul": 0.93 },
    "category": {
      "type": "choice",
      "choice": "man_and_van",
      "probabilities": { "man_and_van": 0.91, "furniture": 0.06, "other": 0.03 },
      "confidence": 0.88
    }
  },
  "usage": { "input_tokens": 412, "output_tokens": 0 }
}
```

### 3.4 限制与错误

| 项          | 值                                                                     |
| ----------- | ---------------------------------------------------------------------- |
| state 上限  | 32k tokens；单请求上下文 64k tokens（Vercel KB 口径）                  |
| choice 选项 | ≤ 255                                                                  |
| score 级数  | 2~10                                                                   |
| 错误码      | 401 密钥无效；422 请求校验失败；429 限流；529 过载。429/529 用指数退避 |
| 计费        | 输入 $0.042 / 1M tokens，输出免费（Vercel Gateway 口径）               |
| 数据        | 支持按请求 Zero Data Retention / No Training                           |

## 4. 关键工程原则

1. **概率比 argmax 重要。** `fraud 0.52` 和 `fraud 0.997` 的 argmax 相同，但系统动作必须不同。阈值写在代码里，由业务定义风险政策：
   ```python
   if p >= 0.90:  auto_send()
   elif p >= 0.70: send_to_review()
   else:           log_only()
   ```
2. **阈值要用自己的标注样本校准。** 不能盲用统一的 0.8。误判「进审批队列」和误判「群里自动发一条」代价不同：不可逆动作阈值取高（≈0.9+），只读动作可取低（≈0.7）。
3. **「零幻觉」只是结构保证。** Jev 不会返回 schema 之外的选项、不会输出畸形 JSON，但**完全可能选错合法答案**。生产系统仍需评测集与抽检。
4. **模型判断，代码授权。** Jev 选了 `auto_send`，不代表可以发；权限、频控、阶段开关必须在代码里再检查一遍。
5. **不要用 Jev 做已经能算的事。** `amount > 10000` 不需要模型。
6. **答案空间未知时不用 Jev。** 「为什么这个服务崩了」这类开放问题给一组固定选项会严重限制能力。

## 5. Jev 在 agent loop 里的位置

```
        Generative Model (deepseek-flash)   ← 抽取自由字段、写文案、开放推理  调用 2~3 次
        ───────────────────────────────────────────────
        Decision Model (Jev)                ← route / choose / score / verify / stop / escalate  每个决策点
        ───────────────────────────────────────────────
        Deterministic Code                  ← policy / auth / 频控 / 阈值 / 执行
```

Vercel 列出的核心用途：tool / subagent selection、continue / retry / ask / stop、风险评分、结果验证、guardrail。

## 6. 本项目的候选问题集（草案）

同一份 `state`（群消息原文 + 群名 + 语言 + 该用户近期消息摘要）一次并行问：

| question_id     | 类型   | 候选 / 尺度                                                                          | 用途                                           |
| --------------- | ------ | ------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `is_demand`     | noul   | 是否为一条可撮合的服务需求                                                           | 入站判断第一道                                 |
| `category`      | choice | man_and_van / eot_cleaning / furniture_service / housing / job / second_hand / other | 品类路由；housing / job / second_hand 只打标签 |
| `urgency`       | score  | 0 无时间 / 1 一周内 / 2 三天内 / 3 明天 / 4 今天                                     | 匹配 same_day 供应商、排序                     |
| `has_location`  | noul   | 原文是否含可用地点（postcode / 区域）                                                | 缺字段不硬匹配                                 |
| `is_move_event` | noul   | 是否暗示即将搬家 / 退租                                                              | F14 标签                                       |
| `is_sensitive`  | noul   | 是否涉及换汇 / 虚拟币 / 代付等黑名单                                                 | 硬拒                                           |

出站判断（state = 候选回复 + 候选供应商 + 群配置 + 近期回复历史）：

| question_id         | 类型      | 用途                                                                                    |
| ------------------- | --------- | --------------------------------------------------------------------------------------- |
| `worth_replying`    | score 0~3 | 值不值得在群里发                                                                        |
| `reply_language_ok` | noul      | 回复语言是否与提问者一致                                                                |
| `supplier_fit`      | score 0~4 | 每个候选供应商与需求的贴合度（逐供应商单独一次评估或把候选放进 state 用 choice 选最优） |

阈值全部先由 Phase 0 的 Shadow 数据校准，再进入 Phase 1。
