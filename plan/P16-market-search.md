# P16 A2H公开集市搜索

状态：本地实现与验证完成，已本机发布，待真实群用户验收；负责人：Codex；用户于 2026-10-10 授权将伦敦二手交易、租房、求帮带、找搭子需求走A2H公开接口。

## 范围

采用多词召回、去重、详情补全、按需求推荐；只读搜索和推荐，不发帖、不联系贴主、不支付或履约。用户新指令覆盖旧的租房/二手不响应规则；招聘不开放。

- [x] 核对匿名搜索、tradeType、分页、详情、伦敦证据与原帖日期
- [x] HTTP 响应 schema、超时/重试、隐私脱敏、转载原帖链接
- [x] market_search / market_enrich / reply_with_market_results，固定预算与来源隔离
- [x] 入站问题集/门与指引，版本递增与录制评测
- [x] 单测、审批恢复、真实 Phase 0 预览、pnpm check

## 跨包契约

见 plan/interfaces.md 的 P16 条目。实现只扩展 websearch/agent/gating/jev 的现有职责，不引入依赖或数据库字段。


## 实测偏差与修正

1. 接口匿名可用，未使用用户提供的浏览器 Cookie，也没有鉴权/私信/写接口。原以为方向只有 SELL/BUY；真实网球查询及当前后端 TradeType.java 证实 PEER。严格增加 PEER 枚举、搭子固定查询 PEER，未让未知方向绕过 schema。早期“无匹配”其实为协议校验失败；已明确 ok/empty/partial/unavailable。
2. 真实 availableUntil 是 YYYY-MM-DD，不仅是时间戳；两种格式分别校验，日历截止日包含当天。原帖明确已售/已出标记优先于滞后的 ON_SALE。
3. 帮带模型误把用户求助映射成 BUY。按当前原始请求在纯规则层选对家方向，强制执行 SELL（求供给）/BUY（找买家、租客、求助者）/PEER（找伙伴），返回实际执行方向并留痕；不复用历史请求。
4. 当前公开接口只给帖子级报价。显示“帖子标价/帖内范围”，未标价保留，模型不得声称具体单品满足预算。事实/引用绑定每条 listing，不跨贴主合并；联系方式/邮件/账号不交给模型或公开回复。
5. 原始引用参数说明不充分导致预览多次被证据校验拒绝，已明确名称为连续原文片段、原句不得改写，细化错误提示；保留校验，不放宽以获得草稿。
6. 本地新版 XHS 研究仍未通过：非思考模式回归 137.4s 达到 MaxTurns(12)，0 草稿。发布配置默认关闭 XHS_RESEARCH_ENABLED，保留 0.6.0 旧工具协议，新研究代码和测试不删。保留既有小红书能力，A2H四类使用已验证研究流程。

## 验证

- `pnpm check`：59 文件 / 430 用例通过（含真实本机 Postgres/Redis 集成、SDK审批快照恢复、频道UTF-16链接偏移），日志 `/tmp/matchbot-market-check.log`。
- Jev 同问题集重新录制 n=92（原80 + 新12），固定模型 typesafe/jev-1.13-20260917。首次 precision=1 / recall=0.9846（“有没有人想买”漏判）；明确找对家的语义后原纯广告又误进（s17），加不依赖模型的纯广告守卫，生产与评测共同传当前 text。最终 precision=1、recall=1、silenceCorrect=1，tp65/fp0/fn0/tn27；categoryAccuracy=0.9891，既有 s39 分类差异；p95录制793ms，成本5406 micro。未降 T_IS_LOCAL_REQUEST_ENTER=0.7。BRP 正例0.73，回归检查按实际门阈值0.7而非旧经验下限0.75，明确记录偏差。
- 真实生成/公开API Phase 0，内存仓储，不发测试消息：二手3查询/26候选/8详情/6推荐，26.9s；租房3查询/20候选/8详情/6推荐，34.2s；帮带修正后3个 SELL查询/4推荐，15.2s；网球搭子3个 PEER查询/27候选/6推荐，12.2s。日志与 JSON 位于 `/tmp/matchbot-market-*-preview.*`。
- 未新增 SDK、依赖、DB schema、用户个人字段；新增只读工具和一个出站推荐工具，仍按阶段/Jev/频控 needsApproval 门写 outbound_messages。公开来源候选/预算在服务端加密快照，7天到期；消息保留期仍30天。


## 本机发布

`pnpm build` 成功，launchd worker/bot kickstart 成功，运行 0.8.0。worker 3621（2026-10-10T14:44:08+08:00）、bot 3633（2026-10-10T14:44:10+08:00），两项 state=running，新错误日志 0 字节。启动前 pending run_states=0，inbound/resume active/waiting=0。XHS_RESEARCH_ENABLED=false，DEFAULT_PHASE=0，已接入群的 Phase 2 配置不变。未提交/未合并，保留工作区原有改动；没有在群里发送测试内容。

最终检查 59 文件 / 430 用例全绿，入站回放 n=92 的 precision/recall/沉默正确率均为1。PEER 修正后的真实网球预览：3查询、27候选、6推荐，12.2s；先前因 tradeType 字段错误而报告无匹配的预览已作废，不把它当作空召回证据。

### 主干交付（2026-10-10）

用户授权将这几轮已在本地部署的改动一并提交并合并到 main。采用 codex/search-recommendations-p17 分支提交后快进合并，保留既有工作；不直接在 main 创建提交。跨包改动覆盖 shared/websearch/agent/channel-telegram/approval/gating/jev/eval/worker 的搜索、推荐呈现、审批正文及入站契约，没有新增依赖、数据库字段或交易能力。验证：472 测试通过；92 条入站 fixture 回放 precision/recall/silenceCorrect=1，既有 s39 分类分歧保留。
