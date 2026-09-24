# P14 库外需求：web search 兜底

> 状态：**已实施（方案 B）**，待真实群验证。2026-09-24 用户选 B：华人店铺也覆盖，接受 Instagram / WhatsApp 作联系方式。

**动机（2026-09-24 产品决定）**：只靠 30 家商家与三个品类，大多数群内求助 bot 都接不住。决定：库里有合适数据就用库；没有就用 web search 回答。
**Spec:** PRD §3.3（不经手交易、免责）、§6.2（频控）；AGENTS.md §3.3、§6

## 1. 方案

```
群消息 → Jev 入站（是否在找本地服务/东西？品类？敏感类？）
       → find_suppliers 查库 ── 有 → 现有推荐流程（kind=recommendation）
                             └─ 无 → web_search → 核验 → Jev 出站（是否每个商家都出自结果？）
                                                      → 自动发，带「来自公开网络、未核实」提示
```

设计要点（与用户讨论后确定）：

1. **「库里有没有」由查库决定，不由 Jev 判断**。Jev 只看得到消息看不到库，让它猜是多一个出错点。web_search 工具在代码里校验：本次 run 必须已调用过 find_suppliers 且结果为空才允许调用。
2. **查询只含「服务 + 区域」，不含用户原话**。Tavily 条款明示会留存并可能用查询训练模型，且无零留存选项（见 §3）。这条在工具实现里强制，不靠 prompt。
3. **工具只返回结构化字段**（编号、名称、网址、电话），不把网页正文交给模型；回复只能引用结果编号，代码层拒绝结果以外的商家——与现有「不许编造商家」同一机制。防止网页内容注入。
4. **独立的出站用途与提示语**，与库内推荐区分；计入频控。
5. Jev 入站新增「其他」品类；租房 / 招聘 / 二手仍按 PRD 排除。

## 2. PoC 结果（2026-09-24）

脚本：`scripts/poc/p14-search/run.mts`。20 条三个品类以外、伦敦华人群常见的请求，写成 agent 会产出的查询形态。每条：Tavily basic 搜 8 条 → 剔除点评/目录站 → 抓商家自己的页面，检查有无英国电话、是否提到伦敦 → 人工逐条看相关性。共消耗 **20 credits**（基础搜索 1 次 1 点）。

**机械核验**：160 条结果里 83 条「自有站 + 有英国电话 + 提到伦敦」。

**人工复核**：83 条里约 10 条不该算——榜单/指南页（`londonpianocentre.com`「Your Guide To Piano Tuners」、`cycleislington.uk`）、撮合平台（`hamuch.com`、`housekeep.com`、`drivingschoolstop.co.uk`）、商场介绍页（`brentcross.co.uk`）、相关但不对题（问华人理发给了日本沙龙，问普通话牙医给了 Invisalign 通用诊所）。**精度约 88%**。

**按请求看：16/20 条至少有 2 家像样的结果；失败 4 条**：

| 失败的请求 | 原因 |
|---|---|
| 华人超市（Battersea） | 真实结果（Tian Tian、Oseyo）网站上没有电话；其余是 reddit / Instagram / 榜单 |
| 定制生日蛋糕（华人烘焙） | 真实店铺（Polly Chan、Chinatown Bakery）网站无电话，下单走 Instagram / WhatsApp |
| 华人理发（Soho） | 搜到的全是日韩沙龙，且多数网站无电话 |
| 裁缝改衣（Paddington） | 首次请求 Tavily 返回 **0 条**，重试正常——**需要重试** |

**结论**：

1. **通用上门服务效果好**：开锁、水电、锅炉、修手机、宠物医院、钢琴调音、翻译、地毯清洁、除虫、仓储都能给出 3–8 家。
2. **华人社区特有的店铺效果差**：它们在 Instagram / 小红书 / 微信上活跃，官网往往没有电话，按「官网有电话」的核验会把真店筛掉。而这恰恰是华人群最常问的一类。若要覆盖，核验规则得放宽（例如接受 Instagram / WhatsApp 作联系方式），风险相应升高。
3. **有一类风险核验挡不住**：伦敦上门服务的搜索结果里大量是按区域做的 SEO 落地页（`plumber-se1.co.uk`、`camden-town-electricians.co.uk` 这类），常是接单后转卖给师傅的中介。「官网有电话」只证明页面有电话，证明不了商家靠谱。库内 30 家是 Brief 人工挑过的，搜索结果没有这层把关——回复里的「未核实」提示不是客套。
4. **Tavily 偶发返回空**，接入需重试一次。

## 3. 选型记录

| 服务 | 免费额度 | 结论 |
|---|---|---|
| **Tavily**（选用） | 每月 1000 credits，每月重置，不用绑卡；basic 1 点/次 | 结果带原始链接，可核验。**条款：会留存并可能用查询训练模型，无零留存选项**；对存储结果无明文限制 |
| Brave Search | 每月 $5 抵扣（约 1000 次），要绑卡 | 标准方案**不授予存储结果的权利** |
| Serper | 2500 次一次性 | 用完即付费 |
| Google Custom Search | — | 已不接受新客户，且只能搜指定站点 |
| Bing Search API | — | 2025-08-11 已下线 |
| SearXNG 自建 | 无上限 | 靠抓各搜索引擎结果页，易被限流、违反其条款，不作生产依赖 |

## 4. Jev 新题 `is_local_request` 的校准

`is_demand` 的措辞写死了三个品类且已按 PoC V4 校准，不能改；「在找本地商家/店铺/地方」单独一题，只在 `category=other` 上用（门控：`other` 且 ≥ `T_IS_LOCAL_REQUEST_ENTER` → 以 `other` 进 agent；租房/招聘/二手不受影响）。

- 校准集 80 条：原 50 条按新口径重标（s25「哪里看俄语解说的足球」、s46「哪里有巴西奶酪面包」由「非需求」改为正例）+ 20 条库外求助 + 10 条易混反例（换汇、二手、办事咨询、找房、求职），五语种。脚本 `scripts/poc/p14-search/calibrate.mts`，花费 $0.004。
- 只看 `category=other` 的 31 条：正类最低 **0.88**，负类最高 **0.59**（「怎么在 Tower Hamlets 注册 GP」），其余负类 ≤ 0.15。阈值取 **0.8**。
- 加题后原有题目无漂移：原 50 条 `is_demand` 判定与之前完全一致，category 唯一分歧仍是已知的 s39。
- 评测集并入 79 条（去掉口径有争议的 N04「我是水电工承接维修」），fixture 重录。离线回放：**precision 1.00 / recall 1.00**，tp 49 / fp 0 / fn 0 / tn 30。
- ⚠ 重录时「注册 GP」得 0.72（校准时 0.59），同一条两次调用差 0.13，离阈值只剩 0.08。Shadow 期重点看「办事咨询」类是否被误放进来。

## 5. 实施

| 层 | 改动 |
|---|---|
| domain / db | `DemandDraft.need`（在找什么，简短英文）+ 迁移 `add_demand_need`；`INBOUND_QUESTION_IDS` 加 `is_local_request` |
| jev | 入站问题集加 `is_local_request`，`InboundVerdict.isLocalRequest` |
| gating | `T_IS_LOCAL_REQUEST_ENTER = 0.8`；`decideInbound` 在 `other` 上放行本地求助 |
| **websearch（新包）** | Tavily（空结果重试一次）→ 不联网先剔除目录/点评/平台/媒体站、文章路径、榜单标题 → 按域名去重 → 并发抓自有页核验（英国电话 / WhatsApp / Instagram 之一 + 提到伦敦）；Instagram 主页凭搜索摘要提到伦敦收录。`buildSearchQuery` 代码层拒绝号码、@、URL、超长输入 |
| agent | `web_search`（前置：品类 other 或 find_suppliers 为空；每轮只搜一次）；`reply_with_search_results`（模型只写开场白，商家名单与联系方式由代码按编号生成，附「未核实」免责）；AGENT_VERSION 0.3.0 |
| worker | 配了 `SEARCH_API_KEY` 才启用 |

### 实施中发现并修掉的问题

1. **agent 在「刷」出站门**：一条真实群消息的回复被出站门连拒 5 次，模型每次改写重投，第 6 版才过——门变成了被优化的目标。现在出站门拒一次后，本轮所有出站工具直接拒绝（`ctx.outboundBlocked`），不再问 Jev。
2. **重投会重复发帖**：上面那轮随后耗尽 8 轮上限抛错，BullMQ 整条重跑；第 6 版已发出，只因 `messages` 唯一约束碰巧挡住才没发第二遍。现在 agent 出错不再抛给队列（留 `agent_failed` 痕迹），并在落库前按渠道消息 id 查重（`duplicate_delivery`）。私聊 `group_id` 为空，原唯一约束对私聊无效，查重按 userId 做。
3. 同域名去重早于过滤时，同一家店排在前面的博客页会把首页一起挤掉——改为先剔除再去重。
4. 杂志文章（GQ）页面上有电话、提到伦敦，混进了候选——加媒体域名与文章路径规则。
5. 店名撇号截断（Polly's → Polly）。

### 端到端（模拟私聊，Phase 0 dry_run）

| 请求 | 结果 |
|---|---|
| 中式奶油水果生日蛋糕，东伦敦 | Polly Chan's Bakehouse（Instagram）、East Asian Cakes（WhatsApp + Instagram）、Okaeri Bakery（Instagram）——PoC 里因官网无电话被筛掉的真店，方案 B 找回来了 |
| Stratford 开锁 | 3 家，其一是外区公司的区域推广页（PoC 结论 3 的典型） |
| Soho / Chinatown 华人理发 | agent 如实说没找到华人店，给了一家日式沙龙 |
| 换汇 | 代码门黑名单拦下，未调 Jev |

## 完成记录

| 项 | 内容 |
|---|---|
| PoC | 2026-09-24 完成，结论见 §2 |
| 实施 | 2026-09-24 完成，见 §4–§5。`pnpm check` 50 文件 / 270 用例 |
| 真实群验证 | 待做 |
