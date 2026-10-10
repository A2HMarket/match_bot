# P14 库外需求：web search 兜底

> 状态：**完成（方案 B）**，2026-09-24 真实群验证通过。2026-09-24 用户选 B：华人店铺也覆盖，接受 Instagram / WhatsApp 作联系方式。

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
6. **真实群首测没回复**（「Battersea 附近华人超市」）：8 条结果核验通过 0 条。Tian Tian Market（tiantian.london）页面有 Instagram，但官网是 JS 渲染，抓到的 HTML 里一个 London 都没有，被「提到伦敦」误杀。改为伦敦证据取页面正文、域名、搜索标题与摘要任一处。同时发现商场的入驻商户页（batterseapowerstation.co.uk/retailers/oseyo）上的 Instagram 是商场自己的，按路径 `/retailers/` 剔除。修复后同一查询返回 Tian Tian Market。

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
| 实施 | 2026-09-24 完成，见 §4–§5。`pnpm check` 50 文件 / 272 用例 |
| 真实群验证 | 2026-09-24 通过。「london happy life」（Phase 2）发「Battersea 附近华人超市」：Jev is_local_request 0.98 → web_search 核验出 HIYOU、Tian Tian Market（均为 Instagram）→ 出站门 worth 2.45 / language 0.97 / unverified 0.03 → auto，约 15 秒到群，@ 了提问人。注意：agent 第二次搜索自行去掉了区域（查询为「Chinese supermarket」），开场白「Battersea 附近没查到」大体属实但并非按 Battersea 重搜得出 |
| 定位放宽 | 2026-10-10：bot 定位从「三品类撮合」放宽为「生活服务小助手」，任何伦敦日常生活需求都响应。改动：`is_local_request` 措辞从「找本地商家/店铺/地方」放宽为「日常生活求助（商家/服务/活动/办事咨询/本地生活信息）」（`is_demand` 措辞不动，仍按 PoC V4 校准）；`T_IS_LOCAL_REQUEST_ENTER` 0.8 → 0.7；标注集 80 条（+L20「伦敦哪里能找圣诞节活动」，N02 BRP / N09 罢工 / s35 NI 按新口径改标为正例）；fixture 全量重录。评测（fixture，n=80，jev-1.13-20260917）：precision 1、recall 1、沉默正确率 1；`is_local_request` 正类最低 0.79、负类最高 0.13。边界：租房/招聘/二手/换汇/纯闲聊仍不接。触发 case「圣诞节活动」实测 0.03 → 0.97 |
| 小红书搜索源 | 2026-10-10：吃喝玩乐类需求改走小红书（TikHub `search_notes` + `get_image_note_detail`，`packages/websearch/src/xhs.ts`），其余库外需求仍走 Tavily。新增 `xhs_search` / `reply_with_xhs_notes` 工具（与 web_search 同一前置条件、每次 run 只搜一个源、笔记链接不进群消息、UGC 正文截断 100 字才给模型）；`AGENT_VERSION` 0.4.0 → 0.5.0；`TIKHUB_API_KEY` 进 env schema，不配则不注册这两个工具。真实接口冒烟（「圣诞活动」）：返回 5 篇笔记，标题/作者/正文/链接齐全。`pnpm check` 53 文件 / 307 用例；评测（fixture，n=80）precision / recall / 沉默正确率均为 1 |


## 2026-10-10 小红书推荐、排版与链接修复（Codex）

本地实现与发布完成，待真实群验收；未提交、未合并，保留工作区原有接入改动。

- 原实现让模型只写一句开场白，代码用顿号拼接标题，并明确省略 URL；通用 instructions 又禁止编号/标题/链接。这直接导致只有笔记清单、没有推荐、排版拥挤、不能点原文。
- 新版从笔记里选择具体地点/餐厅/活动，按适配程度列 1–3 项，每项含名称、推荐理由、可查验正文摘录、作者与原文链接。名称与摘录必须出自候选；未知/重复 ref、虚构摘录、错误来源 URL 拒绝落库。模型不得编造日期、票价或亲身体验，时效不能确认时不推荐。
- 工具节选由 100 提至 500 字（服务端仍上限 500），并显式标为不可信数据。链接从原候选取，保留 xsec_token。Telegram 原生 bold/text_link 排版，长链接目标隐藏，适配 username/text_mention/emoji 的 UTF-16 偏移。免责声明改为核对官方时间、价格、开放情况。
- `AGENT_VERSION` 0.5.0 → 0.6.0；未升级 SDK。工具参数发生变化，部署前旧版 xhs 待审调用需拒绝后重跑，不能当作新版 recommendations 使用。
- 额外复现了已有的审批恢复缺陷：`fromStringWithContext` 的 merge 只合并审批元数据，不合并 xhsNotes，旧 rebuildContext 会丢失候选与原消息定位。新增服务端快照字段校验和恢复；stub 搜索 → 推荐 → 加密中断 → 审批恢复 → outbound pending 已通过。
- 范围：agent 与 channel-telegram 的跨包文本契约（见 interfaces.md），未新增出站路径、依赖、模型调用或个人信息字段。现有保留/删除路径不变。

验证（2026-10-10）：

```text
pnpm check
  typecheck: pass
  lint + dependency direction: pass
  format:check: pass
  Test Files 55 passed (55)
  Tests 330 passed (330)
```

首次沙箱运行被本机数据库/Redis连接权限阻止（EPERM）；授权提升后运行同一 `pnpm check` 全绿，日志 `/tmp/matchbot-xhs-check.log`。没有删掉或跳过集成/e2e用例。

`pnpm eval --skip-metrics` 的 tsx IPC 被沙箱阻止；改用等价入口 `node --import tsx packages/eval/src/cli.ts --skip-metrics`：fixture n=80，precision=1、recall=1、silenceCorrect=1、tp=54、fp=0、fn=0、tn=26，categoryAccuracy=0.9875（既有 s39 差异）。这是入站回放，不代表真实推荐质量；推荐契约/审批恢复/链接实体由 stub 与 fixture 测试验证，尚未调用真实生成模型或发消息到群。

### 本机发布记录（2026-10-10，用户授权）

- `pnpm build` 成功；编译产物 `AGENT_VERSION=0.6.0`。
- 运行目录确认是 `/Users/huanghaibin/Workspace/match_bot`，使用既有 launchd 服务。队列发布前 inbound/resume/outbound 的 active/waiting/delayed 均为 0，数据库 pending run_states 为 0，无需清理旧快照。
- `launchctl kickstart -k gui/$UID/com.matchbot.worker` 与 bot 均成功。Bot PID 82799 → 90684；worker PID 86019 → 90674。
- 新启动日志：bot `2026-10-10T13:20:53+08:00`；worker `2026-10-10T13:20:53+08:00`。两者均为 Node 22.22.0，launchd state=running，新增错误日志为 0 字节。
- 既有配置保留：DEFAULT_PHASE=0，已接入群 phase=2；XHS/Tavily 搜索已配置；OUTBOUND_UNSURE_ACTION=drop。
- 本次仅验证构建、启动与本机服务状态，没有伪造用户消息或往群里发送测试内容；真实群推荐质量/链接跳转仍待用户实际提问验收。


## 2026-10-10 泛需求研究与实体合并（0.7.0，未发布）

用户反馈：召回少；用户要的是展览，不是帖子，应多主题召回、合并多帖，再按展名补全。

### 本地实现

- 原代码每 run 单词/单次搜索，page=1，前 5 笔记，500 字正文，最多 3 项，ref 不能复用。本轮改为模型批量分解主题，发现后可按已见展名补搜。总预算 8 个不同查询（发现最多 4），40 篇唯一候选，每查询最多 8 发现/6 补全；空/失败查询也消耗预算，重复查询缓存，不绕过出站拒绝。
- 日期查询独立守卫允许短年份/月数字及公共展名标点，仍拦电话/账号/URL/完整邮编，不改 Tavily 守卫。页 2 携带首次 search_id 与 search_session_id；最新排序与半年内筛选可选。官方接口参考：https://docs.tikhub.io/420136398e0 。
- 检索正文上限 2000 字；详情匹配请求笔记 ID，按 URL path 去重，保持跨批 ref 稳定；并行批次实际 API 请求共用串行限速 350ms。429 退避有上限，单查询总 30s，避免反复失败。
- 回答以实体为主（最多 6），支持中文/英文名称合并、分类、展览介绍、适合人群、时间/地点/票价/预约、多篇原文。一个 roundup 可支撑多个实体，同展多个帖子可合并。每篇来源须提到实体或有证据的别名，源原句逐字校验；已知实用字段必须是该来源 quote 的字面子串，缺失/冲突分别显示。相同艺术家或场馆不能自动当作同一个展。
- 原始出站文本仍遵循 domain 4000 上限，为免责与 @ 预留空间，不放宽 schema。Telegram 原生 entities 支持分类标题、1–6 编号及多原文链接，偏移沿用 UTF-16。
- 查询预算/候选跨审批保留；MAX_TURNS 8 → 12。修复了 needsApproval 中 malformed 参数抛错让整轮崩溃的问题；无效 schema/证据的门决定只记录类别，不存个人参数。完整 SDK 签名以 node_modules 0.18.0 类型/实现为准。
- 为避免每个 fact 重复嵌套大段摘录，证据集中进 sources，facts 只引用 ref。AGENT_VERSION 0.6.0 → 0.7.0；没升级 SDK/依赖/数据库，没新增出站路径或个人数据字段。候选与查询仍在服务端加密快照，7 天到期。

### 真实 Phase 0 验证与阻塞

使用 `scripts/poc/p14-search/research-preview.mts`，输入固定为「伦敦看展有哪些推荐」；真实 DeepSeek/TikHub，内存仓储，无生产写入、无群消息。

1. 第一次：58.8s，发现 3 查询 + 展名补搜 3 查询，40 唯一笔记，52 HTTP 请求（6 次 429），0 最终草稿，ToolCallError。未通过。证据 `/tmp/matchbot-xhs-research-first.json`。
2. 共享限速后第二次：180s watchdog 超时，36 笔记，34 HTTP 请求，0 次 429，0 最终草稿。未通过。证据 `/tmp/matchbot-xhs-research-second.json`。
3. 简化证据结构/修复参数中断后第三次：180s watchdog 超时，发现 3 查询 + 展名补搜 3 查询，40 唯一笔记，0 次 429，0 最终草稿。未通过。证据 `/tmp/matchbot-xhs-research-live.json`。

按 AGENTS.md §9.2「同一个操作失败 2–3 次就停下来报告」，本轮停止真实调用，没有继续重试、删除测试或伪称完整闭环通过。

慢回复的一个确认因素：工程未指定 DeepSeek thinking，官方文档明确默认 enabled/high（https://api-docs.deepseek.com/guides/thinking_mode/）。已在本地 0.7.0 将 deepseek-flash 的生成循环设为非思考模式，其他模型不传 provider 参数；这是待验证的缓解，不是确认的根因修复。研究拓展/补搜成功不等于最终推荐生成成功。

本机 launchd 当前仍是已发布 0.6.0 的进程（Bot 90684 / worker 90674），未对 0.7.0 做 restart。下一步：先核对非思考模式最终 payload 与完整 Phase 0 预览，再验收展览合并/事实/耗时，之后才切换本地服务。


最终本地验证：`pnpm check` 全绿（55 文件 / 349 用例，含集成/e2e），日志 `/tmp/matchbot-xhs-research-check.log`；`node --import tsx packages/eval/src/cli.ts --skip-metrics`：fixture n=80，precision/recall/沉默正确率均为 1，既有分类差异 s39 不变，日志 `/tmp/matchbot-xhs-research-eval.log`。这些结果证明本地契约与回归通过，不证明新非思考配置的真实推荐质量或端到端耗时。服务 PID 与发布后保持一致（90684/90674），未执行 0.7.0 的 kickstart。


P16 发布隔离记录：0.8.0 的 XHS_RESEARCH_ENABLED 默认 false，单次检索/三条带依据链接的 0.6.0 协议继续运行；新多轮研究代码/测试保留，未混入本次有闲发布。非思考模式真实研究回归仍在137.4s达到12轮上限且0草稿，因此本项不宣称通过；证据 `/tmp/matchbot-xhs-research-live.json`。

## 2026-10-10 综合校验循环修复（0.9.0，验证中）

- 用户继续询问180秒问题。当前本机实际上已发布0.8.0有闲搜索，XHS新研究仍默认关闭。取之前40篇缓存单独重放综合，无检索请求，108.4s仍12轮0草稿。
- 捕获SDK公开error.state（类型来自node_modules），证据保存在`/tmp/matchbot-xhs-synthesis-failure.json`。12次工具输出持续报“quote不是连续原文”：模型用省略号拼接/改写多个段落，后续还存在合成中英名称/无来源别名。仅关闭thinking或扩大超时不足以解决。
- 实际改为代码按原文行切分（单段300字符）并给出稳定xN:pM编号；模型sources只选编号，代码取正文。已知事实仍必须逐字出自该来源的已选段落，拒绝未知/跨来源ID、无来源名字、虚构事实、重复实体，所有无效条目一次返回索引和字段。无需新增持久化字段：编号确定性从快照正文派生。
- 保留8次检索/40篇与12轮硬上限，原出站门/免责声明/3700字符草稿限制不变。修改范围agent与其已有P14协议/预览脚本，无新增出站路径、依赖或个人数据字段。AGENT_VERSION升0.9.0，SDK未升级。
- 先写段落编号失败测试（模块缺失RED），随后实现，局部33用例通过；完整check、92条入站回放、同一40篇真实综合和完整搜索预览继续验证。

第一版段落编号结果：同一40篇缓存综合43.9s成功，6实体，5次综合；完整真实链路131.3s成功，6查询/40篇、6实体，但仍8次综合修正。其中主要是中英文冒号、大小写和不同来源名称别名，以及实用facts的手抄值。为避免仍接近12轮，最终协议把facts也改为原文段落ID：known一个已选段落，unknown空数组，conflicting两篇不同来源。文本由代码获取并去掉emoji/事实标签展示前缀，不截断改写事实。名称匹配仅归一化标点大小写/空白、不跨行合成、保留年份；反馈提供不匹配来源的标题/开头帮助一次补齐真实别名。新协议失败用例RED后实施；最终check和完整预览正在运行。

最终facts编号版一次完整回归119.9s仍耗尽12轮（0草稿）：其中连续5次SDK通用InvalidToolInputError，实参每实体sources达6项，超过保持不变的max4；SDK在traceIncludeSensitiveData=false下脱敏掉具体原因，默认反馈只有“Invalid JSON input”。保留max4与所有schema约束，在needsApproval先缓存仅字段路径/限值的Zod反馈（每run工具私有WeakMap，不写参数值/日志/快照），errorFunction把具体字段返回模型；其他工具异常返回明确停止提示。真实SDK ScriptedModel用“无效5来源→修正1来源→dry_run”回归，已通过。facts自身ID已构成原文引用，只要求出自sources中已引用的笔记，不需要在summary的passages中重复登记；跨未引用来源/未知ID仍拒绝。SDK测试入口要显式传callId，已按真实testing类型修正；不引入SDK私有导出。

修复SDK反馈后完整Phase 0真实预览已成功：77.8s，6查询/40篇唯一笔记，6实体/4分类/22项已知实用事实，两次综合（一次证据字段修正），1草稿。43次TikHub请求；所有拟发内容只落内存dry_run，无Telegram发送。证据`/tmp/matchbot-xhs-release-full-success.json`。展示复核发现个别desc用字面\\n或U+2028分隔日期/地点，新增RED复现后让原文段落切分识别这些换行，事实不再跨行混排；正文片段仍是原文连续子串。最终437→440用例（含SDK恢复、来源限值、换行回归），完整check与同批资料最终排版复核见后续发布记录。

### 0.9.0 本机发布完成（2026-10-10，沿用用户本机发布授权）

- 最终 `pnpm check` 全绿：60文件/440用例，typecheck、lint/依赖方向、format均通过（`/tmp/matchbot-xhs-release-check.log`）。`pnpm build`通过（`/tmp/matchbot-xhs-release-build.log`）。
- 入站fixture回放 n=92，precision=1、recall=1、silenceCorrect=1，categoryAccuracy=0.9891，既有s39分类差异不变（`/tmp/matchbot-xhs-release-eval.log`）。这是入站回归，不等同真实推荐准确率。
- 完整实搜成功记录`/tmp/matchbot-xhs-release-full-success.json`：77.8s，6查询/40篇、6展/4类/22项已知事实；2次回答，一次字段修正，无群发送。最终真实/转义/Unicode换行展示修复后，同批40篇缓存复核40.3s成功、6项/3318原始字符（`/tmp/matchbot-xhs-release-render-success.json`）；本次缓存重放6次回答修正，仍受12轮硬上限，模型选择质量及耗时存在波动，不声称零修正或每次固定78s。
- 发布前重新查询：pending run_states=0；inbound/resume/outbound的active/waiting/delayed全部0；无需清理旧快照。实际`.env`启用XHS_RESEARCH_ENABLED=true，Env默认false保留为新环境显式启用策略。
- 本机launchd重启成功：worker PID 3621→7921，bot PID 3633→7933；启动时间2026-10-10T15:06:28+08:00（worker）、15:06:32+08:00（bot），两者state=running。新增bot/worker错误日志各0字节。编译产物AGENT_VERSION=0.9.0，运行配置确认新研究true，默认phase0/既有群phase2策略未变，有闲搜索继续启用。
- 任务范围完成，本机已发布；真实群文案/点击验收仍由自然用户触发。本次没有向群发送测试消息。源文件保留未提交状态，未覆盖其他贡献者改动，也未在main直接提交。

## 2026-10-10 小红书来源切换Sandbase（0.9.1）

用户要求用Sandbase替换TikHub；source ~/.zshrc确认SANDBASE_API_KEY已存在，只记录是否存在。先PoC确认官方Model API：POST /v1/api/xiaohongshu/app-v2/search-notes和image-note-detail，Bearer + JSON。首次搜索20篇/3.46s，详情请求ID匹配/2.35s，带外层search_id/search_session_id翻页20篇/2.79s，结果形状已用zod确认（`/tmp/matchbot-sandbase-probe.log`）。官方参考https://blog.sandbase.ai/xiaohongshu-note-research-api/；目录GET /apis/v1与通用生成示例存在不同表述，实际使用已验证的同步POST入口。

客户端改为Sandbase envelope(status/outputs[0].data)→小红书payload(success/data)两层校验。翻页ID从payload外层读；page传整数；详情只传note_id、仍按ID匹配；原文保留xsec_token；过滤广告；30s查询/10s请求/两次尝试/350ms共享限速不变，确定性4xx不重试，不记录API错误正文/密钥。createXhsSearch及研究/推荐/快照契约未变。跨包仅shared环境变量、worker装配、agent版本/注释、websearch客户端与PoC脚本，无新SDK/依赖、出站路径或个人数据字段。

TDD：Sandbase环境变量用例先RED，替换传输/响应fixture后客户端7个用例RED，再实施并补充非completed、upstream失败、401不重试/不泄密、详情ID不匹配回归。局部21测试通过；最终pnpm check 60文件/447用例全绿（`/tmp/matchbot-sandbase-check.log`），pnpm build通过（`/tmp/matchbot-sandbase-build.log`）。fixture入站回放92条precision/recall/silenceCorrect=1，既有s39分类差异保留（`/tmp/matchbot-sandbase-eval.log`）。

真实Phase0完整预览成功（`/tmp/matchbot-sandbase-research-success.json`）：93.8s，5查询/35篇唯一笔记，最终拟发1草稿；所有API请求经Sandbase新路径，未发Telegram消息。本机配置最终使用动态引用：启动子shell source ~/.zshrc后只读取SANDBASE_API_KEY；不在.env中另存密钥值，.env权限收紧600；SANDBASE_API_KEY只通过loadEnv进入worker。发布记录继续补充。

### 0.9.1本机发布记录

- 真实预览最终6分类条目、12原文链接、4次回答尝试，28次API请求均HTTP200，路径全部为Sandbase /v1/api/xiaohongshu/app-v2/search-notes或image-note-detail；时间93.8s。本次仅Phase0内存草稿，没有发送群消息。
- 发布前pending run_states=0；inbound/resume/outbound active/waiting/delayed全部0，无旧快照需处理。未改SDK版本或模型instructions。
- launchd重启后worker PID 7921→11847，bot 7933→11875；启动时间2026-10-10T15:16:23+08:00，两者state=running，新增stderr各0字节。实际编译版本0.9.1、sandbaseConfigured=true、XHS_RESEARCH_ENABLED=true。部署仍使用既有本机进程、默认phase/群级策略和有闲源未变。
- 环境变量最终按启动动态读取~/.zshrc，.env仅含读取表达式而非新复制的Sandbase密钥；配置权限600，不触碰~/.zshrc。服务重启后的读取已验证。源码和文档仍未提交，保留其他贡献者原有修改，未在main提交。

## 2026-10-10 真实群单源退化复核（0.10.0，验证中）

- 用户反馈刚发了一条感觉全出自一篇。只读核对实际问题“伦敦有哪些好玩的”：2026-10-10T16:27+08:00的6条推荐引用5个唯一笔记，每项仅1篇，电影节/NFL共用x2活动合集；5篇来自5个作者。真实初搜3主题24篇，但16篇仅60字搜索摘要；补搜批次因Knit + Stitch的+被拒而整体丢弃两次，另一次所有entity/keyword不匹配；最后仅BFI和花市两查询、不含年份，补到12篇（BFI还包含2025版本）。花市已经有多篇不同完整笔记，却只用了x33。这说明不能把召回量/链接数量等同于综合质量。
- 修复公开+查询，同时保持长号码等PII拦截；批次按query独立拒绝/执行，减少无效轮次；新研究先拿卡片，再用xhs_read_notes读取入选原文，把详情预算从“广搜前几个帖”转为“入选实体多帖”。每run12份全文、每批6，失败计预算且缓存；身份/URL稳定，拒绝不匹配详情；元数据与额度通过审批快照恢复。
- 最终来源覆盖规则：拒绝未读卡片；已有2份不同完整正文介绍同实体时要求合并；复制的相同全文不算多份，单源明确标记。instructions要求泛生活需求按市集/户外、文化/音乐、免费/季节等分主题，定期活动补搜包含年份，避免把上一届当现在，优先3-4个丰富选项而非6个摘要。AGENT_VERSION=0.10.0，无SDK升级、新依赖、出站路径、个人数据字段。
- 复现RED包含+与批次拖累、卡片/入选全文分离、读取额度/失败缓存/身份、已有多帖却单源、重复正文、审批恢复。局部和完整检查进行；真实预览脚本发现残留固定London exhibitions需求，已清除旧需求，原预览已自行结束，按用户原问题重跑，不把偏题测试宣称为真实验收。

原问题初次新流程59.0s/3查询24候选/读取11份全文成功，6项中4项各综合2篇，但发现末项仍是“伦敦0元景点”清单而非实际去处，以及普通介绍被标作票价；新增RED并增加具体实体/价格内容校验，保留全部来源门。随后73.98s回归成功5项但仅1项多源：SDK会因正式全名在第二帖中拆开（Es Devlin 与 Other Worlds）而误拒，模型反复修正后删除第二来源。现在主名称/别名仍需在至少一篇来源中完整出现；其他关联帖可分别包含“艺术家:展名”两部分，必须同时出现，艺术家相同而展名不同仍拒绝（正反单测已通过）。为防读过少量候选就结束，广泛发现至少2个查询的请求在全文额度未耗尽时要求至少半数、最低2个选项多源；无法再读时只许明确单源标记，不能靠不相关URL凑数。新规则未放宽schema/预算；最终完整回归继续验证。

### 最终综合编译与审阅一致性

在真实全文缓存回放中，仍发现模型会反复删来源/保留非法可选别名和不合格实用字段，最后do_nothing（0草稿），不能只把预算耗尽当综合完成。最终保留本轮逐项通过引用校验的DTO（ctx.xhsValidatedRecommendations，max6）；主名称/原文/事实仍校验，无效别名不参与关联，无法验证的实用字段在额度末尾标为unknown而非显示错误值。已有两份多源主项或读取额度耗尽时，代码优先充分来源的有效条目，限制单源补充并重建intro，不再依赖模型删改整篇。曾验证缓存综合10.2s、22.4s各1草稿，无新增API；最终完整预览继续确认覆盖数量。

编译后的选择与原模型args可能不同，补齐实际拟发正文预览：needsApproval按SDK callId保存outboundPreviews，run_states.interruptions携带可选draftText，审批卡显示最终正文，恢复后使用同一正文（含免责声明，避免重复追加）。SDK搜索→双帖全文→审批→恢复的测试验证预览与实际outbound.text完全相同；旧args快照兼容。无新表/迁移/SDK依赖/出站路径，JSON状态沿用现有服务端快照7天加密/过期，数据种类未增加。

最后一轮曾出现模型纯文本追问“好玩是哪类”而未调用工具（1.6s/0检索/0草稿，不视为通过）。明确泛伦敦休闲需求无需先追问主题，所有回复经出站工具；研究启用时Flash首轮toolChoice=required，SDK resetToolChoice默认true（实类型/实现核对），后续可正常结束，不增加模型轮次或放宽任何门。最终完整验证及发布记录见下文。

最后完整回归86.98s达到12轮仍无草稿（如实不视为通过）：读取用了11份，剩1份时请求2个ref被整批拒绝，无法利用最后额度，模型继续投低覆盖稿。已修复全文请求按剩余额度读取可用部分，余项明确budgetLimitedRefs；新边界用例通过。XHS回复成功queued/dry_run/not_sent时即由SDK toolUseBehavior结束，证据错误仍回模型修正，审批中断仍保持（实SDK类型/phase回归已核对）。未增加12轮/8query/12read上限。

最终完整真实链路96.1s成功，5query/36候选/12份全文/17次API，1份Phase0草稿，未向群发送。证据`/tmp/matchbot-diversity-complete-chain.json`。最后正式名（艺术家与展名在同一正文中分别出现）关联后，同批真实全文15.7s无新增API完成最终筛选，2个主/补项，其中Frieze项目综合3篇，另1项单篇并明确标记，实际引用4个不同笔记（`/tmp/matchbot-diversity-final-curation.json`）。实际结果条目数随证据足够程度收敛，不宣称每次4-6项或全部多源；不靠无关来源凑数。

`pnpm check`最终61文件/466用例全绿（`/tmp/matchbot-final-name-check.log`）；fixture n=92 precision/recall/silenceCorrect=1、旧s39分类差异仍保留。审批实际正文与恢复发送的文本完全一致，去重保留已校验的多帖条目、未证实别名去除、不可验证实用字段明确unknown的回归均通过。声明：这是引用结构与行为回归，不代表逐条活动已得到官方核实，仍保留小红书免责声明。

### 0.10.0 本机发布完成

- 最终引用关联主名支持同一篇内分别出现的“艺术家:展名”两部分，不能仅有艺术家或编造主名；未证实可选别名移除，不成为关联依据。旧严格一整串匹配会删掉真正的补充来源，已修正并有正反用例。源关联仍不代表跨年/跨场馆可合并，需保持模型语义判断与原文可查。
- 最终 pnpm check 61文件/466用例全绿（`/tmp/matchbot-final-name-check.log`），build成功（`/tmp/matchbot-diversity-publish-build.log`）；92条fixture回放指标precision/recall/silenceCorrect=1，旧s39分类差异不变。没有删除/跳过失败用例，预算与所有出站门保持。
- 完整真实输入“伦敦有哪些好玩的”链路已成功96.1s、5query/36候选/12全文；最后来源关联改进以同批真实全文缓存15.7s无新增API复核，1草稿，两项有效选择，一项综合3份来源、另一项单源明确标记（实际选取4份原文）。这是证据充分度下的收敛结果，不宣称每次必须6项/全部多源或官方事实已核实，内容仍附免责声明。
- 已沿用用户本机发布授权重启worker/bot；实际compiled version=0.10.0、Sandbase配置=true、研究开关=true，发布前pending snapshots=0、inbound/resume/outbound active/waiting/delayed全0。不改group/default phase、Jev配置、有闲搜索或个人数据清理路径。没有向群发送测试消息。
- 源码仍保留未提交状态，未在main提交或覆盖其他贡献者修改。

### 主干交付（2026-10-10）

用户授权将这几轮已在本地部署的改动一并提交并合并到 main。采用 codex/search-recommendations-p17 分支提交后快进合并，保留既有工作；不直接在 main 创建提交。跨包改动覆盖 shared/websearch/agent/channel-telegram/approval/gating/jev/eval/worker 的搜索、推荐呈现、审批正文及入站契约，没有新增依赖、数据库字段或交易能力。验证：472 测试通过；92 条入站 fixture 回放 precision/recall/silenceCorrect=1，既有 s39 分类分歧保留。
