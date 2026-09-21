# V6 自定义 tracing processor —— 结果

> 脚本：`scripts/poc/v6-tracing/main.ts`（三种模式：默认 / `--no-sensitive` / `--control`）
> 运行环境：Node v22.22.0、`@openai/agents` 0.18.0、`deepseek-flash`（Chat Completions，`useResponses: false`）
> 运行日期：2026-09-21

## 结论

**通过。**

1. `setTraceProcessors([ourProcessor])` 可以完全替换 SDK 默认的 OpenAI tracing 导出。导入 `@openai/agents`
   时它在 `dist/index.js:44` 调 `setDefaultOpenAITracingExporter()`（内部就是
   `setTraceProcessors([new BatchTraceProcessor(new OpenAITracingExporter())])`），我们在 import 之后再调一次
   `setTraceProcessors` 即把它整个顶掉。导出名与计划一致：`setTraceProcessors`、`addTraceProcessor`、
   `setTracingDisabled` 都从 `@openai/agents`（转自 `@openai/agents-core`）真实导出，
   `TracingProcessor` / `Span` / `Trace` / `SpanData` 也在。

2. 一次「一轮工具调用 + 一轮收尾」的 run，自定义 processor 收到 **16 个事件**：
   `trace.start` → `task.start` → `agent.start` → `turn.start` → `generation.start/end` →
   `function.start/end` → `turn.end` → `turn.start` → `generation.start/end` → `turn.end` →
   `agent.end` → `task.end` → `trace.end`。
   span 类型一共 5 种（计划里只预期 3 种）：

   | span type    | 数量 | `spanData` 真实字段                                                       |
   | ------------ | ---- | ------------------------------------------------------------------------- |
   | `task`       | 1    | `type`, `name`, `usage`（`usage` 只在 end 时出现）                        |
   | `agent`      | 1    | `type`, `name`, `handoffs`, `tools`, `output_type`                        |
   | `turn`       | 2    | `type`, `turn`(序号), `agent_name`, `usage`（只在 end 时出现）            |
   | `generation` | 2    | `type`, `model`, `model_config`, `input`, `output`（start 时只有 `type`） |
   | `function`   | 1    | `type`, `name`, `input`(JSON 字符串), `output`(字符串)                    |

3. **token usage 不在 `generation` span 上。** 0.18 的 `openaiChatCompletionsModel` 只在「截断 / 失败」分支才写
   `span.spanData.usage`，成功路径不写；`WHERE IS usage?` 一节实测 `generation: usage=<absent>`。
   usage 实际由 runner 写在两处（`agents-core/dist/runner/tracing.js:124/127`）：
   - `turn.spanData.usage` = `{ input_tokens, output_tokens, cached_input_tokens, cache_write_input_tokens }`（**单次模型调用**的量）
   - `task.spanData.usage` = 上面四项 + `requests` + `total_tokens`（**整个 run** 的汇总）
     另外 `generation.spanData.output[0].usage` 里有供应商原始 usage（`prompt_tokens` / `completion_tokens` /
     `total_tokens` / `prompt_cache_hit_tokens` / `reasoning_tokens`），但它只在 `traceIncludeSensitiveData !== false` 时存在。

4. **latency 不在 spanData 里，在 Span 对象上**：`span.startedAt` / `span.endedAt` 是 ISO8601 字符串，
   `latency_ms = Date.parse(endedAt) - Date.parse(startedAt)`。实测 generation=1259ms、function=1ms、
   turn=1263ms、agent/task=2126ms。另外还有 `span.spanId`、`span.parentId`、`span.traceId`、`span.error`、
   `span.traceMetadata`。

5. **span 里带原文。** `generation.spanData.input` 是完整的 messages 数组（含 system instructions 与用户原文），
   `generation.spanData.output` 是完整的 chat.completion（含 `content`、`reasoning_content`、tool_call 参数），
   `function.spanData.input/output` 是工具参数与返回值原文。→ 这些直接落库会违反 AGENTS.md §3.3 第 11 条。
   实测 `new Runner({ traceIncludeSensitiveData: false })` 后：`generation.spanData` 只剩
   `[type, model, model_config]`，`function.spanData.input/output` 变成空字符串，而 `turn`/`task` 的 `usage` 仍在。

6. **换掉默认 exporter 后没有任何到 `api.openai.com` 的请求。** 方法见下节：同时在应用层（patch
   `globalThis.fetch`）和传输层（patch `net.Socket.prototype.connect`，undici 的 `net.connect`/`tls.connect`
   最终都走它）记录出站目标；自定义模式下出站只有 `api.deepseek.com/chat/completions`（2 次 fetch、1 条 TCP 连接）。
   对照组（保留默认 exporter）同一拦截器抓到了 `POST api.openai.com/v1/traces/ingest` 共 3 次（重试 3 次，
   全部被 PoC 拦截器就地阻断，未真正发出数据），证明拦截器本身是有效的、不是「没抓到」。

## 证据

运行命令：

```
cd /Users/huanghaibin/Workspace/match_bot && set -a && . ./.env && set +a \
  && pnpm exec tsx scripts/poc/v6-tracing/main.ts               # 自定义 processor
  && pnpm exec tsx scripts/poc/v6-tracing/main.ts --no-sensitive # traceIncludeSensitiveData:false
  && pnpm exec tsx scripts/poc/v6-tracing/main.ts --control      # 对照组：保留默认 OpenAI exporter
```

### 1) 自定义 processor（默认模式），完整终端输出节选

```
[mode] CUSTOM —— setTraceProcessors([ourProcessor])，默认 OpenAI exporter 已被替换
[net:fetch] POST api.deepseek.com/chat/completions
[net:tcp]   connect api.deepseek.com:443
[net:fetch] POST api.deepseek.com/chat/completions

========== RUN ==========
finalOutput: "done"

========== EVENTS RECEIVED BY CUSTOM PROCESSOR ==========
total events: 16

--- trace.start traceId=trace_2d6cbcd769d747ea89facd2c85ee1d7a name="poc-v6-workflow" groupId=poc-v6-group-42 metadata={"phase":"phase0","tg_user_id":"12345"}

--- span.start type=task spanId=span_bcf8c1d7656641bf8704765f parentId=null traceId=trace_2d6cbcd769d747ea89facd2c85ee1d7a
    startedAt=2026-09-21T08:59:20.042Z endedAt=null durationMs=null
    error=null traceMetadata={"phase":"phase0","tg_user_id":"12345"}
    spanData keys = [type, name]
    spanData = {
  "type": "task",
  "name": "poc-v6-workflow"
}

--- span.start type=agent spanId=span_958b868cc5aa470ab8eb4619 parentId=span_bcf8c1d7656641bf8704765f traceId=trace_2d6cbcd769d747ea89facd2c85ee1d7a
    startedAt=2026-09-21T08:59:20.043Z endedAt=null durationMs=null
    error=null traceMetadata={"phase":"phase0","tg_user_id":"12345"}
    spanData keys = [type, name, handoffs, tools, output_type]
    spanData = {
  "type": "agent",
  "name": "poc-v6",
  "handoffs": [],
  "tools": [],
  "output_type": "text"
}

--- span.start type=turn spanId=span_74ad3974f57643399c7a0fa5 parentId=span_958b868cc5aa470ab8eb4619 traceId=trace_2d6cbcd769d747ea89facd2c85ee1d7a
    startedAt=2026-09-21T08:59:20.043Z endedAt=null durationMs=null
    error=null traceMetadata={"phase":"phase0","tg_user_id":"12345"}
    spanData keys = [type, turn, agent_name]
    spanData = {
  "type": "turn",
  "turn": 1,
  "agent_name": "poc-v6"
}

--- span.start type=generation spanId=span_7d047dd41ec74e1faf721385 parentId=span_74ad3974f57643399c7a0fa5 traceId=trace_2d6cbcd769d747ea89facd2c85ee1d7a
    startedAt=2026-09-21T08:59:20.046Z endedAt=null durationMs=null
    error=null traceMetadata={"phase":"phase0","tg_user_id":"12345"}
    spanData keys = [type]
    spanData = {
  "type": "generation"
}


  ...（省略 generation.start，只有 {"type":"generation"}）

--- span.end type=generation spanId=span_7d047dd41ec74e1faf721385 parentId=span_74ad3974f57643399c7a0fa5 traceId=trace_2d6cbcd769d747ea89facd2c85ee1d7a
    startedAt=2026-09-21T08:59:20.046Z endedAt=2026-09-21T08:59:21.305Z durationMs=1259
    error=null traceMetadata={"phase":"phase0","tg_user_id":"12345"}
    spanData keys = [type, model, model_config, input, output]
    spanData = {
  "type": "generation",
  "model": "deepseek-flash",
  "model_config": {},
  "input": [
    {
      "content": "Call the echo tool with the user text, then answer \"done\".",
      "role": "system"
    },
    {
      "role": "user",
      "content": "hello tracing"
    }
  ],
  "output": [
    {
      "id": "db1c0aa2-0f9d-4a9e-b529-7b0242a61399",
      "object": "chat.completion",
      "created": 1789981160,
      "model": "deepseek-flash",
      "choices": [
        {
          "index": 0,
          "message": {
            "role": "assistant",
            "content": "",
            "reasoning_content": "The user wants me to call the echo tool with the user text, then answer \"done\".\n\nThe user text is \"hello tracing\". Wait, the instruction says \"Call the echo tool with the user text\". The user text is \"hello tracing\". So I should echo \"hello tracing\".\n\nThen answer \"done\".",
            "tool_calls": [
              {
                "index": 0,
                "id": "call_00_vu0Pggp3vGOX7OF3G3u90624",
                "type": "function",
                "function": {
                  "name": "echo",
                  "arguments": "{\"text\": \"hello tracing\"}"
                }
              }
            ]
          },
          "logprobs": null,
          "finish_reason": "tool_calls"
        }
      ],
      "usage": {
        "prompt_tokens": 328,
        "completion_tokens": 101,
        "total_tokens": 429,
        "prompt_tokens_details": {
          "cached_tokens": 128
        },
        "completion_tokens_details": {
          "reasoning_tokens": 63
        },
        "prompt_cache_hit_tokens": 128,
        "prompt_cache_miss_tokens": 200
      },
      "system_fingerprint": "aeb56401ca74e127821c4f9126dcb669"
    }
  ]
}
    span.toJSON() = {"object":"trace.span","id":"span_7d047dd41ec74e1faf721385","trace_id":"trace_2d6cbcd769d747ea89facd2c85ee1d7a","parent_id":"span_74ad3974f57643399c7a0fa5","started_at":"2026-09-21T08:59:20.046Z","ended_at":"2026-09-21T08:59:21.305Z","span_data":{"type":"generation","model":"deepseek-flash","model_config":{},"input":[{"content":"Call the echo tool with the user text, then answer \"done\".","role":"system"},{"role":"user","content":"hello tracing"}],"output":[{"id":"db1c0aa2-0f9d-4a9e-b529-7b0242a61399","object":"chat.completion","created":1789981160,"model":"deepseek-flash","choices":[{"index":0,"message":{"role":"assistant","content":"","reasoning_content":"The user wants me to call the echo tool with the user text, then answer \"done\".\n\nThe user text is \"hello tracing\". Wait, the instruction says \"Call the echo tool with the user text\". The user text is \"hello tracing\". So I should echo \"hello tracing\".\n\nThen answer \"done\".","tool_calls":[{"index":0,"id":"call_00_vu0Pggp3vGOX7OF3G3u90624","type":"function","function":{"name":"echo","arguments":"{\"text\": \"hello tracing\"}"}}]},"logprobs":null,"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":328,"completion_tokens":101,"total_tokens":429,"prompt_tokens_details":{"cached_tokens":128},"completion_tokens_details":{"reasoning_tokens":63},"prompt_cache_hit_tokens":128,"prompt_cache_miss_tokens":200},"system_fingerprint":"aeb56401ca74e127821c4f9126dcb669"}]},"error":null}


--- span.end type=function spanId=span_9c56ae6929d2449fac060b36 parentId=span_74ad3974f57643399c7a0fa5 traceId=trace_2d6cbcd769d747ea89facd2c85ee1d7a
    startedAt=2026-09-21T08:59:21.317Z endedAt=2026-09-21T08:59:21.320Z durationMs=3
    error=null traceMetadata={"phase":"phase0","tg_user_id":"12345"}
    spanData keys = [type, input, output, name]
    spanData = {
  "type": "function",
  "input": "{\"text\": \"hello tracing\"}",
  "output": "hello tracing",
  "name": "echo"
}
    span.toJSON() = {"object":"trace.span","id":"span_9c56ae6929d2449fac060b36","trace_id":"trace_2d6cbcd769d747ea89facd2c85ee1d7a","parent_id":"span_74ad3974f57643399c7a0fa5","started_at":"2026-09-21T08:59:21.317Z","ended_at":"2026-09-21T08:59:21.320Z","span_data":{"type":"function","input":"{\"text\": \"hello tracing\"}","output":"hello tracing","name":"echo"},"error":null}

--- span.end type=turn spanId=span_74ad3974f57643399c7a0fa5 parentId=span_958b868cc5aa470ab8eb4619 traceId=trace_2d6cbcd769d747ea89facd2c85ee1d7a
    startedAt=2026-09-21T08:59:20.043Z endedAt=2026-09-21T08:59:21.323Z durationMs=1280
    error=null traceMetadata={"phase":"phase0","tg_user_id":"12345"}
    spanData keys = [type, turn, agent_name, usage]
    spanData = {
  "type": "turn",
  "turn": 1,
  "agent_name": "poc-v6",
  "usage": {
    "input_tokens": 328,
    "output_tokens": 101,
    "cached_input_tokens": 128,
    "cache_write_input_tokens": 0
  }
}
    span.toJSON() = {"object":"trace.span","id":"span_74ad3974f57643399c7a0fa5","trace_id":"trace_2d6cbcd769d747ea89facd2c85ee1d7a","parent_id":"span_958b868cc5aa470ab8eb4619","started_at":"2026-09-21T08:59:20.043Z","ended_at":"2026-09-21T08:59:21.323Z","span_data":{"type":"custom","name":"turn","data":{"sdk_span_type":"turn","turn":1,"agent_name":"poc-v6","usage":{"input_tokens":328,"output_tokens":101,"cached_input_tokens":128,"cache_write_input_tokens":0}}},"error":null}


--- span.end type=agent spanId=span_958b868cc5aa470ab8eb4619 parentId=span_bcf8c1d7656641bf8704765f traceId=trace_2d6cbcd769d747ea89facd2c85ee1d7a
    startedAt=2026-09-21T08:59:20.043Z endedAt=2026-09-21T08:59:22.168Z durationMs=2125
    error=null traceMetadata={"phase":"phase0","tg_user_id":"12345"}
    spanData keys = [type, name, handoffs, tools, output_type]
    spanData = {
  "type": "agent",
  "name": "poc-v6",
  "handoffs": [],
  "tools": [
    "echo"
  ],
  "output_type": "text"
}
    span.toJSON() = {"object":"trace.span","id":"span_958b868cc5aa470ab8eb4619","trace_id":"trace_2d6cbcd769d747ea89facd2c85ee1d7a","parent_id":"span_bcf8c1d7656641bf8704765f","started_at":"2026-09-21T08:59:20.043Z","ended_at":"2026-09-21T08:59:22.168Z","span_data":{"type":"agent","name":"poc-v6","handoffs":[],"tools":["echo"],"output_type":"text"},"error":null}

--- span.end type=task spanId=span_bcf8c1d7656641bf8704765f parentId=null traceId=trace_2d6cbcd769d747ea89facd2c85ee1d7a
    startedAt=2026-09-21T08:59:20.042Z endedAt=2026-09-21T08:59:22.168Z durationMs=2126
    error=null traceMetadata={"phase":"phase0","tg_user_id":"12345"}
    spanData keys = [type, name, usage]
    spanData = {
  "type": "task",
  "name": "poc-v6-workflow",
  "usage": {
    "input_tokens": 771,
    "output_tokens": 103,
    "cached_input_tokens": 384,
    "cache_write_input_tokens": 0,
    "requests": 2,
    "total_tokens": 874
  }
}
    span.toJSON() = {"object":"trace.span","id":"span_bcf8c1d7656641bf8704765f","trace_id":"trace_2d6cbcd769d747ea89facd2c85ee1d7a","parent_id":null,"started_at":"2026-09-21T08:59:20.042Z","ended_at":"2026-09-21T08:59:22.168Z","span_data":{"type":"custom","name":"task","data":{"sdk_span_type":"task","name":"poc-v6-workflow","usage":{"input_tokens":771,"output_tokens":103,"cached_input_tokens":384,"cache_write_input_tokens":0,"requests":2,"total_tokens":874}}},"error":null}


--- trace.end traceId=trace_2d6cbcd769d747ea89facd2c85ee1d7a name="poc-v6-workflow" groupId=poc-v6-group-42 metadata={"phase":"phase0","tg_user_id":"12345"}

========== SPAN TYPE SUMMARY (span.end only) ==========
  generation: 2
  function: 1
  turn: 2
  agent: 1
  task: 1

========== WHERE IS usage? ==========
  generation: usage=<absent>
  function: usage=<absent>
  turn: usage={"input_tokens":328,"output_tokens":101,"cached_input_tokens":128,"cache_write_input_tokens":0}
  generation: usage=<absent>
  turn: usage={"input_tokens":443,"output_tokens":2,"cached_input_tokens":256,"cache_write_input_tokens":0}
  agent: usage=<absent>
  task: usage={"input_tokens":771,"output_tokens":103,"cached_input_tokens":384,"cache_write_input_tokens":0,"requests":2,"total_tokens":874}

========== OUTBOUND HOSTS (fetch layer) ==========
  api.deepseek.com  calls=2 blocked=0 paths=[/chat/completions]
========== OUTBOUND HOSTS (tcp layer, net.Socket.prototype.connect) ==========
  api.deepseek.com:443  connects=1

RESULT: api.openai.com contacted? NO
```

### 2) `--no-sensitive`（`new Runner({ traceIncludeSensitiveData: false })`）：原文被剥掉，usage 仍在

```
--- span.end type=generation spanId=span_6d10a6f8ec2b47f2970b2e85 parentId=span_cd8ad0aa94864f49b0759739 traceId=trace_45bcedbef4534ba1b2753bbf471424ac
    startedAt=2026-09-21T08:59:22.745Z endedAt=2026-09-21T08:59:24.008Z durationMs=1263
    error=null traceMetadata={"phase":"phase0","tg_user_id":"12345"}
    spanData keys = [type, model, model_config]
    spanData = {
  "type": "generation",
  "model": "deepseek-flash",
  "model_config": {}
}
    span.toJSON() = {"object":"trace.span","id":"span_6d10a6f8ec2b47f2970b2e85","trace_id":"trace_45bcedbef4534ba1b2753bbf471424ac","parent_id":"span_cd8ad0aa94864f49b0759739","started_at":"2026-09-21T08:59:22.745Z","ended_at":"2026-09-21T08:59:24.008Z","span_data":{"type":"generation","model":"deepseek-flash","model_config":{}},"error":null}

--- span.end type=function spanId=span_27243fea936a4048a6bd6e80 parentId=span_cd8ad0aa94864f49b0759739 traceId=trace_45bcedbef4534ba1b2753bbf471424ac
    startedAt=2026-09-21T08:59:24.014Z endedAt=2026-09-21T08:59:24.015Z durationMs=1
    error=null traceMetadata={"phase":"phase0","tg_user_id":"12345"}
    spanData keys = [type, input, output, name]
    spanData = {
  "type": "function",
  "input": "",
  "output": "",
  "name": "echo"
}
    span.toJSON() = {"object":"trace.span","id":"span_27243fea936a4048a6bd6e80","trace_id":"trace_45bcedbef4534ba1b2753bbf471424ac","parent_id":"span_cd8ad0aa94864f49b0759739","started_at":"2026-09-21T08:59:24.014Z","ended_at":"2026-09-21T08:59:24.015Z","span_data":{"type":"function","input":"","output":"","name":"echo"},"error":null}


--- span.end type=task spanId=span_62b96e2c4bf5495d8d0c70bc parentId=null traceId=trace_45bcedbef4534ba1b2753bbf471424ac
    startedAt=2026-09-21T08:59:22.741Z endedAt=2026-09-21T08:59:24.887Z durationMs=2146
    error=null traceMetadata={"phase":"phase0","tg_user_id":"12345"}
    spanData keys = [type, name, usage]
    spanData = {
  "type": "task",
  "name": "poc-v6-workflow",
  "usage": {
    "input_tokens": 731,
    "output_tokens": 63,
    "cached_input_tokens": 384,
    "cache_write_input_tokens": 0,
    "requests": 2,
    "total_tokens": 794
  }
}
    span.toJSON() = {"object":"trace.span","id":"span_62b96e2c4bf5495d8d0c70bc","trace_id":"trace_45bcedbef4534ba1b2753bbf471424ac","parent_id":null,"started_at":"2026-09-21T08:59:22.741Z","ended_at":"2026-09-21T08:59:24.887Z","span_data":{"type":"custom","name":"task","data":{"sdk_span_type":"task","name":"poc-v6-workflow","usage":{"input_tokens":731,"output_tokens":63,"cached_input_tokens":384,"cache_write_input_tokens":0,"requests":2,"total_tokens":794}}},"error":null}

--- trace.end traceId=trace_45bcedbef4534ba1b2753bbf471424ac name="poc-v6-workflow" groupId=poc-v6-group-42 metadata={"phase":"phase0","tg_user_id":"12345"}

  agent: 1
  task: 1

========== WHERE IS usage? ==========
  generation: usage=<absent>
  function: usage=<absent>
  turn: usage={"input_tokens":328,"output_tokens":61,"cached_input_tokens":128,"cache_write_input_tokens":0}
  generation: usage=<absent>
  turn: usage={"input_tokens":403,"output_tokens":2,"cached_input_tokens":256,"cache_write_input_tokens":0}
  agent: usage=<absent>
  task: usage={"input_tokens":731,"output_tokens":63,"cached_input_tokens":384,"cache_write_input_tokens":0,"requests":2,"total_tokens":794}

========== OUTBOUND HOSTS (fetch layer) ==========
  api.deepseek.com  calls=2 blocked=0 paths=[/chat/completions]
========== OUTBOUND HOSTS (tcp layer, net.Socket.prototype.connect) ==========
  api.deepseek.com:443  connects=1

RESULT: api.openai.com contacted? NO
```

### 3) 对照组 `--control`：保留默认 exporter，同一拦截器立刻抓到 api.openai.com

```
[mode] CONTROL —— 保留 SDK 默认 OpenAI tracing exporter
[net:fetch] POST api.deepseek.com/chat/completions
[net:tcp]   connect api.deepseek.com:443
[net:fetch] POST api.deepseek.com/chat/completions
[net:fetch] POST api.openai.com/v1/traces/ingest  <= BLOCKED BY POC
[non-fatal] Tracing: request failed: object
[net:fetch] POST api.openai.com/v1/traces/ingest  <= BLOCKED BY POC
[non-fatal] Tracing: request failed: object
[net:fetch] POST api.openai.com/v1/traces/ingest  <= BLOCKED BY POC
[non-fatal] Tracing: request failed: object
Tracing: failed to export traces after 3 attempts

...

========== WHERE IS usage? ==========

========== OUTBOUND HOSTS (fetch layer) ==========
  api.deepseek.com  calls=2 blocked=0 paths=[/chat/completions]
  api.openai.com  calls=3 blocked=3 paths=[/v1/traces/ingest]
========== OUTBOUND HOSTS (tcp layer, net.Socket.prototype.connect) ==========
  api.deepseek.com:443  connects=1

RESULT: api.openai.com contacted? YES
```

出站取证方法（写在 `main.ts` 顶部，在 `import('@openai/agents')` **之前**装好）：

- 应用层：替换 `globalThis.fetch`，把每次请求的 host + pathname 打印出来。
  openai SDK 和 `OpenAITracingExporter`（`openaiTracingExporter.js:558` 的 `await fetch(...)`）都走全局 fetch。
- 传输层：替换 `net.Socket.prototype.connect`，打印每条 TCP 连接的 host:port。
  Node 内置 undici 的 `net.connect`/`tls.connect` 最终都调它，绕不过去。
- 对照组把目标是 `api.openai.com` 的 fetch 直接抛错阻断，所以即使在对照组，数据也没真的发出去；
  它只用来证明「拦截器确实抓得到默认 exporter 的请求」。

## 对 P8 的影响

### 1. processor 怎么注册

```ts
import '@openai/agents'; // 这一行就已经注册了默认 OpenAI exporter
import { setTraceProcessors } from '@openai/agents';
setTraceProcessors([decisionTraceProcessor]); // 在 packages/agent 初始化时顶掉它
```

`setTracingDisabled(true)` **不能**用来满足 §3.3 第 9 条——它会连 span 都不生成，第 2 条（每次模型调用都要
写 `decision_traces`）就没数据了。正确做法只有「替换 processor」。

### 2. 要实现哪些方法

`TracingProcessor` 只有 `start?()` 是可选的，其余六个都必须实现：

```ts
interface TracingProcessor {
  start?(): void; // 可选，给有导出循环的实现用
  onTraceStart(trace: Trace): Promise<void>;
  onTraceEnd(trace: Trace): Promise<void>;
  onSpanStart(span: Span<any>): Promise<void>;
  onSpanEnd(span: Span<any>): Promise<void>;
  shutdown(timeout?: number): Promise<void>;
  forceFlush(): Promise<void>;
}
```

实际要干活的只有 `onSpanEnd`（写一行 `decision_traces`）、`onTraceEnd`（可选：写 run 级汇总）、
`shutdown`/`forceFlush`（把缓冲刷库）。`onSpanStart` 留空即可——start 时 `spanData` 几乎是空的
（`generation` 只有 `{type}`，`turn` 没有 `usage`，`agent.tools` 还是 `[]`）。

### 3. span 字段 → `decision_traces` 列

| 列              | 取值                                                                                        | 来源                                              |
| --------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `latency_ms`    | `Date.parse(span.endedAt) - Date.parse(span.startedAt)`                                     | `Span` 对象属性，**不在 `spanData` 里**           |
| `cost_micro`    | 用 `turn.spanData.usage` 的 `input_tokens` / `output_tokens` / `cached_input_tokens` 乘单价 | **`turn` span**，不是 `generation` span           |
| （run 汇总）    | `task.spanData.usage`：另有 `requests`、`total_tokens`                                      | `task` span（`parentId === null`，整个 run 一个） |
| `phase`         | `span.traceMetadata.phase`（由 `new Runner({ traceMetadata: { phase } })` 注入）            | span 上每个都有，无需另传                         |
| model           | `generation.spanData.model`（如 `"deepseek-flash"`）                                        | `generation` span                                 |
| trace/span 关联 | `span.traceId` / `span.spanId` / `span.parentId`                                            | `Span` 对象属性                                   |
| 工具调用        | `function.spanData.name` + `input`(JSON 字符串) + `output`                                  | `function` span                                   |
| 失败            | `span.error`（`{ message, data }`，未出错时 `null`）                                        | `Span` 对象属性                                   |

**一次模型调用的信息被拆在两个 span 上**：`generation` 有 model / 真实耗时，`turn` 有 usage。
二者靠 `generation.parentId === turn.spanId` 关联；一个 `turn` 下恰好一个 `generation`（外加若干 `function`）。
建议 `decision_traces` 一行 = 一个 `turn`（模型调用维度），在 `onSpanEnd(turn)` 时落库，
把该 turn 下先到达的 `generation`（model、latency）和 `function` span 先缓存在内存里按 `parentId` 归并；
span 的到达顺序实测就是 `generation.end` → `function.end` → `turn.end`，`turn.end` 一定最后到。

`trace` 级：`trace.traceId`、`trace.name`（= `workflowName`）、`trace.groupId`（建议放 session/用户标识）、
`trace.metadata`（建议放 `phase`、`tg_user_id` 等；类型是 `Record<string, string>`）。

### 4. PII：span 里有原文，落库前必须处理

`generation.spanData.input` 是完整 messages（system instructions + 用户原文），`output` 是完整
chat.completion（含 `content`、`reasoning_content`、tool_call 参数），`function.spanData.input/output`
是工具参数与返回值原文。**直接 `JSON.stringify(spanData)` 落 `decision_traces` 会违反 §3.3 第 11 条和 §6。**

两条措施，建议都上：

1. `packages/agent` 的 Runner 统一配 `traceIncludeSensitiveData: false`。实测之后 `generation.spanData`
   只剩 `[type, model, model_config]`，`function.spanData.input/output` 变空字符串，而
   `turn`/`task` 的 `usage` 与所有时间戳**不受影响**，`cost_micro`/`latency_ms` 照常算。
2. processor 里再加一层白名单：只取上表列出的字段落库，`generation.input/output`、`function.input/output`
   一律不写原文，需要的话只写 `text_hash`（与 `messages.text_hash` 同一算法）和长度。
   注意 `traceIncludeSensitiveData: false` 之后 `generation.output[0].usage`（供应商原始 usage，含
   `prompt_cache_hit_tokens` 等）也一起没了——要细粒度缓存命中数就从 `turn.usage.cached_input_tokens` 取。

### 5. 必须是「不抛异常 + 缓冲 + 显式 flush」

`Span.end()` 的实现是 `void this.#processor.onSpanEnd(this).catch(log)`（`agents-core/dist/tracing/spans.js:106`）：

- **不 await**。run 不会等我们写完库，所以不能指望 span 回调结束时数据已落库；
- **异常被吞**，只打一行日志。processor 内部必须自己 try/catch + 记录失败（§3.3「不吞错误」），
  否则 trace 丢了没人知道；
- 因为不 await，**必须缓冲 + 在 `forceFlush()`/`shutdown()` 里批量 INSERT**，并在 worker 退出前显式
  `await getGlobalTraceProvider().forceFlush()`。SDK 自己注册了进程退出钩子调 `provider.shutdown(5000)`，
  但 5s 超时且不保证在所有退出路径触发，不能只靠它；
- **`onSpanEnd` 里必须立刻深拷贝 `span.spanData`**。SDK 全程复用同一个对象并就地改写
  （`agent.tools` start 时是 `[]`、end 时是 `["echo"]`；`usage` 是 end 前一刻才挂上去的），
  异步写库时再读就可能读到别的状态。
- 一条消息一次 run 会产生 7 个 span（1 task + 1 agent + 2 turn + 2 generation + 1 function），
  按 turn 维度落库就是 2 行；批量 INSERT，不要一 span 一次往返。

### 6. 与计划书不一致、需要按实测改的地方

1. `traceIncludeSensitiveData` / `workflowName` / `groupId` / `traceMetadata` / `tracingDisabled` 属于
   **`RunConfig`**，只能 `new Runner(config)` 传；`run(agent, input, options)` 的第三个参数是 `RunOptions`，
   传这些字段会被**静默忽略**（第一次跑就踩了这个坑：传进 `run()` 完全没生效）。
   `packages/agent` 应该持有一个配置好的 `Runner` 实例，而不是用顶层 `run()`。
2. 计划预期 3 类 span（`agent`/`generation`/`function`），实际 **5 类**，多出 `task` 和 `turn`——而 usage
   恰恰只在这两类新 span 上。按计划写会拿不到 token 数。
3. `generation` span 在成功路径上**没有** `spanData.usage`（0.18 只在截断/失败分支写）。
4. `span.toJSON()` 为了适配 OpenAI ingest schema，会把 `task`/`turn` 改写成
   `{"type":"custom","name":"turn","data":{"sdk_span_type":"turn",...}}`。**落库要读 `span.spanData`，
   不要读 `toJSON()`**。
5. 全局 tracing 在 `NODE_ENV === 'test'` 或 `OPENAI_AGENTS_DISABLE_TRACING=1` 时被自动关掉
   （`agents-core/dist/config.js`）。`packages/agent` 的单测里 span 不会产生，processor 的测试要直接构造
   假 span 调 `onSpanEnd`，不要指望跑一次 run 就有 trace。
6. 门（gating）的决定不是 SDK span，SDK 不会替我们生成。§3.3 第 2 条要求的「每次门的决定」要么自己直接写
   `decision_traces`，要么用 `createCustomSpan`/`withCustomSpan`（`CustomSpanData = { type:'custom', name, data }`）
   包一层，再由同一个 processor 落库——后者能自动带上 `traceId`/`parentId`/`traceMetadata.phase`，更推荐。
7. 默认 exporter 的目标是 `https://api.openai.com/v1/traces/ingest`，失败会重试 3 次。只要在 `packages/agent`
   初始化时 `setTraceProcessors([...])` 成功执行一次，就不会有任何请求发过去；建议在 `packages/agent` 加一条
   单测断言当前 processor 列表里没有 `BatchTraceProcessor`/`OpenAITracingExporter`，防止以后有人误加
   `addTraceProcessor` 把它加回来（`addTraceProcessor` 是追加，不是替换）。
