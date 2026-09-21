> 落盘说明：本文为 2026-09-21 团队提供的 Jev 调研原稿，原样保存。经核对官方 API 的技术摘要见 [jev-decision-model.md](./jev-decision-model.md)。

# Jev：当 AI 不再负责"写答案"，而只负责"做判断"

过去几年，大模型应用有一个默认前提：

> 只要任务里需要"智能"，就调用一个生成式大模型。

判断用户意图，调用 LLM；选择工具，调用 LLM；判断任务有没有完成，调用 LLM；判断结果是否可信，调用 LLM；最后写一段回复，还是调用 LLM。

这其实把很多完全不同的问题，都塞进了同一种计算范式：

**生成下一个 token。**

TypeSafe AI 在 2026 年发布的 Jev，尝试把其中一类问题单独拆出来：

> 如果程序并不需要模型"创造一个答案"，而只是需要它在一组已知答案中做判断，为什么还要运行一个完整的生成式语言模型？

这就是 Jev 所代表的 **Decision Model**。

---

## 一、先理解 Jev 不是什么

Jev 不是一个更快的小型 ChatGPT。

它不会：

- 写文章；
- 回邮件；
- 生成代码；
- 写 SQL；
- 创造一段新的自然语言答案。

它接受的是：

**State + Questions**

输出的是：

**Typed Decisions + Probabilities**

例如一个客服系统收到了：

> "你们怎么又扣了我一次钱？我已经说过要取消了，再不处理我就换平台。"

程序可以一次问 Jev：

```text
用户意图是什么？

A. 重复扣款
B. 取消服务
C. 技术问题
D. 普通咨询
```

同时再问：

```text
用户是否有明显流失风险？

True / False
```

再问：

```text
问题紧急程度？

低 / 中 / 高
```

Jev 不会写一段分析，它直接返回类似：

```text
intent:
  duplicate_charge  0.71
  cancellation      0.24
  technical         0.01
  other             0.04

churn_risk:
  true              0.91

urgency:
  high              0.78
```

然后程序决定下一步做什么。

这也是 TypeSafe 对 Jev 最简洁的定义：

**unstructured state in, typed probabilistic decisions out。**

即：

> 复杂状态进去，可编程的概率决策出来。

---

# 二、真正理解 Jev，只需要记住三个问题

面对任何一个 AI 任务，先问：

### 第一类：答案能不能直接算出来？

例如：

```text
账户余额是否小于 100 元？
```

如果数据库里余额是 37：

```python
balance < 100
```

结束。

不需要 AI。

再比如：

- HTTP 状态是不是 200；
- 用户有没有退款权限；
- 发票金额是否超过合同上限；
- 当前日期是否超过付款日；
- Agent 调用工具时是否缺少必填参数。

这些都是**确定性规则**。

应该交给代码。

---

### 第二类：答案不能直接算，但候选答案是不是已经确定？

例如客户说：

> "我账单里好像莫名其妙多了一笔一样的费用。"

程序想知道：

```text
这属于什么问题？

A. 重复扣款
B. 欺诈
C. 退款
D. 技术问题
E. 其他
```

这里程序员很难写：

```python
if ...
```

因为真实用户可以用无数种方式表达"重复扣款"。

但程序其实并不需要 AI 创造一个新的答案。

**所有合法答案已经提前知道了。**

这种问题就是 Decision Model 最自然的领域。

---

### 第三类：答案本身是不是需要被创造出来？

例如：

> 根据这个客户的情况，写一封安抚并解释退款流程的邮件。

合法答案不是：

```text
A / B / C / D
```

而是一个几乎无限的文本空间。

这时候才真正需要 Generative LLM。

因此可以把整个 AI 软件栈压缩成一句话：

> **能算出来的，用代码；
> 不能算、但能从有限候选中判断的，用 Decision Model；
> 必须创造新内容的，才用 Generative Model。**

这句话基本就是 Jev 最重要的适用边界。

Vercel 对 Jev 的使用建议也是类似划分：明确规则由代码执行，bounded interpretation 交给 Jev，文字回复仍由生成模型完成。

---

# 三、为什么这个东西对 Agent 特别重要

因为仔细拆开一个 Agent，会发现很多步骤根本不是"生成问题"。

假设一个 Agent 有这些工具：

```text
search_web
query_database
send_email
create_ticket
ask_user
```

用户说：

> "看看这个客户上个月是不是投诉过类似的问题。"

Agent 下一步真正要解决的是：

```text
search_web？
query_database？
send_email？
create_ticket？
ask_user？
```

这是一个典型的有限动作空间。

今天的 Agent 通常会让 LLM：

```text
阅读 prompt
↓
理解问题
↓
思考
↓
生成 JSON
↓
生成 tool name
↓
生成 arguments
```

但其中：

> **"应该调用哪个 tool？"**

其实只是一个 Choice。

完全可以：

```text
current state
     ↓
    Jev
     ↓
query_database
```

然后再让生成模型负责真正开放式的部分，例如：

```text
需要生成什么查询参数？
```

---

一个 Agent loop 里还有大量类似问题：

```text
下一步继续还是结束？

continue
retry
ask_user
stop
```

```text
应该交给哪个 sub-agent？

coding
search
data_analysis
browser
human
```

```text
当前结果可靠吗？

yes
no
```

```text
Agent 是否偏离了用户最初的任务？

yes
no
```

```text
这次 tool result 应该：

accept
retry
fallback
escalate
```

它们都有一个共同特点：

> **世界状态很复杂，但合法动作很少。**

这可能才是 Jev 最重要的使用场景。

Vercel 在目前的 Jev Agent 指南中列出的核心用途正是 tool/subagent selection、continue/retry/ask/stop、风险评分、结果验证和 guardrail。

---

# 四、Jev 的技术原理为什么会比 LLM 快这么多

传统生成模型计算的是：

```text
P(next token | previous tokens)
```

比如最终程序只需要：

```json
{ "action": "retry" }
```

一个 LLM 仍然是在进行 autoregressive generation：

```text
{
"
a
c
t
i
o
n
...
```

当然现实实现会有 tokenization、structured output 和 grammar constraint，不是真的一个字符一个字符输出，但核心仍然是：

> **不断预测下一个 token。**

Jev 则放弃文本生成。

它直接计算：

```text
P(retry | state)
P(continue | state)
P(stop | state)
P(ask_user | state)
```

一次模型调用就得到一个概率分布。

而且如果同一份 state 上有多个相互独立的问题：

```text
用户意图？
风险等级？
是否需要人工？
是否涉嫌欺诈？
是否应该退款审核？
```

Jev 可以并行评估这些问题，而不是像生成模型一样依次"写答案"。

Vercel 当前的 Jev 接口也直接暴露这种范式：

```text
state
+
questions
↓
Choice / Score / Boolean
```

多个问题可以在同一个 evaluation 中处理。

这就是 Jev 高 intelligence-per-second 的核心来源之一。

---

# 五、Jev 有三种基本原语

Jev 目前主要提供三类 decision primitive。

## Choice

有限候选里选择：

```text
哪个部门？

billing
sales
technical
fraud
```

输出整个概率分布。

---

## Boolean / Noul

判断一个命题：

```text
客户是否明确要求退款？
```

得到：

```text
True: 0.93
False: 0.07
```

TypeSafe 自己把这一 primitive 称为 **Noul**。

---

## Score

对一个有顺序的尺度评分：

```text
用户愤怒程度：

0 不明显
1 轻微
2 明显
3 强烈
4 极端
```

不是简单分类，而是有 ordinal relationship 的评分问题。

TypeSafe 的 workflow eval 正是将现实业务拆成这些 narrow decisions，再由程序代码组合成完整 workflow。

---

# 六、为什么"概率"比"答案"本身更重要

如果 Jev 只返回：

```text
fraud
```

其实和一个 classifier 没有太大区别。

真正重要的是：

```text
fraud     0.52
normal    0.48
```

与：

```text
fraud     0.997
normal    0.003
```

虽然 argmax 都是 fraud，但系统显然不应该采取同样的动作。

于是应用程序可以设计：

```python
if fraud_probability > 0.98:
    block()

elif fraud_probability > 0.70:
    send_to_human_review()

else:
    continue()
```

这就把一个很重要的控制权重新交给了软件工程：

> **模型负责判断概率，程序负责定义风险政策。**

TypeSafe 把 Jev 的训练方法称作 **RLCD——Reinforcement Learning for Calibrated Decisions**，目标不是让模型写出人更喜欢的答案，而是让它给出更可靠的概率判断。TypeSafe 尚未公开 RLCD 的完整训练公式、数据配方或模型架构细节，因此目前能确认的是这一训练目标，而不是具体实现 recipe。

实际部署时，也不能盲信一个统一的 `0.8` 阈值。Vercel 建议使用自己业务的 labeled cases 来校准阈值，因为"误判一个客服队列"和"误执行一次不可逆操作"的代价完全不同。

---

# 七、Jev 所谓"不会 hallucinate"要准确理解

这是 Jev 最容易被误解的一点。

假设程序规定：

```text
下一步只能是：

continue
retry
stop
ask_user
```

Jev 不会突然返回：

```text
restart_kubernetes_cluster
```

输出空间是由程序定义的。

因此它不会产生：

- 不存在的 enum；
- 虚构 tool name；
- malformed JSON；
- schema 之外的 action。

TypeSafe 因此把它描述为"zero hallucinations"。

但这不等于：

> **Jev 永远不会判断错。**

它完全可能应该选择：

```text
retry
```

却选择：

```text
stop
```

TypeSafe 自己也明确说明，其"0% hallucination"并不是一个实验得到的事实正确率，而来自 schema matching 的结构保证。

因此更准确的说法应该是：

> **Jev 可以保证不输出非法答案，但不能保证永远选对合法答案。**

对于生产系统，这是非常重要的区别。

---

# 八、它和普通分类器有什么区别

看到这里，很容易产生一个问题：

> 这不就是 classifier 吗？

某种意义上，是。

传统分类器可能是：

```text
客服意图分类器：

退款
投诉
咨询
取消
```

问题是它的 label space 通常在训练时就固定了。

换一个任务：

```text
Agent 下一步动作：

search
retry
stop
ask_user
```

往往又要训练另一个分类模型。

Jev 想做的是：

> **一个通用、可编程的 classifier。**

运行时才告诉模型：

```text
这是 state。

这是问题。

这是本次允许的 options。

请判断。
```

下一次完全可以换成另一组问题和另一组 options。

因此 Jev 更像：

> **foundation model 级的 programmable classifier / scorer。**

它不是让程序员为每一个分类任务训练一个模型，而是让分类本身变成一次 model call。

---

# 九、Jev 最适合哪些应用

最典型的并不是聊天机器人，而是**状态复杂、动作有限、高频决策**的系统。

### Agent Controller

```text
继续
retry
换 tool
问用户
结束
人工介入
```

### Tool / Skill Router

从几十甚至几百个工具里选下一步。

### Coding Agent Supervisor

判断：

```text
是否跑偏？
是否该测试？
是否完成？
是否需要回滚？
```

### Browser / Computer Agent

屏幕可能非常复杂，但任意时刻合法动作往往只是：

```text
click
type
scroll
back
wait
done
```

### 客服系统

判断：

```text
intent
urgency
churn risk
fraud
department
next action
```

最终回复再交给 LLM 写。

### Agent Observability

检查完整 Agent trace：

```text
正常
需要人工审核
高优先级审核
file bug
page on-call
```

TypeSafe 自己公开的 Agent Trace Observability workflow 就是在做这种事情。

### 发票、合规与业务流程

TypeSafe 的 invoice workflow 很能说明边界：

**金额、日期、账号、状态由代码计算；**

而诸如：

> 文档是否真的支持这笔费用？

> 当前材料是否显示异常模式？

这类 semantic judgment 交给模型。

最后业务规则再由代码组合。

### 安全事件

代码掌握资产等级、权限和 policy；

模型判断：

```text
行为是否异常？
证据有多强？
已有记录是否解释了这一行为？
```

然后 playbook 决定是关闭、排队还是立即 containment。

---

# 十、什么场景不要用 Jev

Jev 并不是"只要有选项就该用"。

如果：

```text
if amount > 10000:
    require_manager_approval()
```

规则已经很清楚。

让 Jev 再判断：

> "这个金额是否应该经理审批？"

反而增加不确定性。

因此第一原则始终是：

> **能确定性计算，就不要调用模型。**

第二种不适用，是答案空间本身未知：

> 为什么这个服务崩了？

如果需要模型发现一种开发者事先没有想到的原因，仅给：

```text
数据库
网络
配置
其他
```

可能会严重限制能力。

第三种则是必须生成内容：

```text
写代码
写邮件
写报告
构造 SQL
提出新方案
```

这依然属于 Generative Model。

---

# 十一、未来的 Agent 可能不是"一个 LLM 不停循环"

今天常见的 Agent 可以粗略写成：

```text
LLM
 ↓
tool
 ↓
LLM
 ↓
tool
 ↓
LLM
 ↓
tool
```

每一步：

- 理解；
- 判断；
- 规划；
- 选择；
- 生成；

都让同一个大模型完成。

Decision Model 提供了另一种可能：

```text
                 ┌──────────────┐
                 │ Generative   │
                 │ Model        │
                 │              │
                 │ 写作         │
                 │ 代码         │
                 │ 开放式推理   │
                 └──────┬───────┘
                        │
              Generation Plane
                        │
────────────────────────┼─────────────────
                        │
               Decision Plane
                        │
                 ┌──────▼───────┐
                 │ Jev           │
                 │              │
                 │ route        │
                 │ choose       │
                 │ score        │
                 │ verify       │
                 │ retry        │
                 │ stop         │
                 │ escalate     │
                 └──────┬───────┘
                        │
────────────────────────┼─────────────────
                        │
                 Deterministic
                     Code

                 policy
                 auth
                 math
                 limits
                 execution
```

生成模型可能只被调用两三次。

Decision Model 却可以出现在 Agent loop 的每一个 decision point。

而代码最终决定什么行为真正允许发生。

这种架构的价值并不只在于便宜。

它更重要的优势可能是：

- 更低延迟；
- 更少无意义 token generation；
- 更稳定的 output schema；
- 更容易建立测试集；
- 更容易针对每一个判断单独评测；
- 更容易加入 confidence threshold；
- 更容易把业务规则从 prompt 重新拿回代码。

TypeSafe 的 workflow eval 也体现了这种设计哲学：先把任务拆成程序规则和窄语义判断，再组合，而不是让一个 prompt 一口气完成整件事情。其公开评测中，这种 workflow 结构普遍优于让模型直接从整段 policy 生成最终动作；TypeSafe 同时报告，在其选定的 workflow 上，Jev 在部分场景达到最高约 193.6 倍速度和 444.6 倍成本优势，但他们也明确说明这些属于较高端的收益，不应直接外推到所有业务。

---

# 十二、Jev 真正值得关注的，不是"它比 GPT 强不强"

如果把问题问成：

> Jev 和 GPT 谁更聪明？

其实很容易问错方向。

GPT、Claude 这样的模型试图解决：

> **开放世界里，我应该生成什么？**

Jev 解决：

> **在程序定义的世界里，我应该选择什么？**

两者不是简单替代关系。

更合理的 AI 技术栈可能逐渐变成：

```text
Code
负责确定性规则

Decision Model
负责模糊判断

Generative Model
负责开放式创造

Embedding / Retrieval
负责寻找信息
```

每一种模型只做自己最擅长的工作。

这也是 Jev 最值得关注的地方：

它并不是在问：

> "如何做出另一个更强的聊天模型？"

它问的是另一个问题：

> **软件真正需要的智能，究竟有多少需要被生成出来？**

如果答案是：

> 很多时候，我们其实早就知道所有合法答案，只是不知道此刻应该选哪一个。

那么 Decision Model 就可能成为 Agent 技术栈里一个长期缺失的基础组件。

最后，可以用三句话概括 Jev：

> **能算的，不要让 AI 猜。**

> **能选择的，不要让 AI 生成。**

> **只有答案本身需要被创造时，才调用生成模型。**

Jev 的意义，不一定是造出了一个"更聪明的模型"。

它更可能是在提醒我们：

**过去几年，我们可能把太多本质上属于"决策"的问题，错误地做成了"生成"。**
