# P31 — Telegram 多演员测试群

用户批准创建独立测试群与三个测试演员Bot，并授权官方Telegram Web仅用于BotFather和测试群。用户已登录并要求继续；三个演员及独立测试群已创建，凭证重置、安全保存和真实收发尚未完成；Match Bot互通已由用户单独批准并开启，不能声称已开始自动对话。基线main f71dc4e / Agent0.18.3。单执行者，无新三方库或业务表；apps/bot补齐agent/jev工作区依赖，apps/bot与eval声明已在技术栈中的zod。

## 最小契约与隔离

- shared仅新增默认空的按chatId+botIds精确演员白名单，以及可选私有配置文件路径；token不放白名单/日志/代码。
- channel-telegram与apps/bot把白名单传到toInboundMessage；默认仍拒绝机器人，绝不接受自身、其他群、私聊、未知Bot。
- actor controller位于apps/bot，actor生成/出站tool位于agent；模型仍只在agent/jev。新演员出站tool仍needsApproval→阶段/Jev/频控→outbound_messages→createTelegramSender。
- 演员出站使用独立本地matchbot_actor_lab数据库，避免原Bot sender认领；同一controller串行路由，toolCallId绑定actor+run，错误群/旧run/未知演员不发。复用原表/队列发送实现，不新建业务实体。
- db提供独立client factory（现有singleton保持兼容）与按指定inputRef的token汇总；控制库和Match Bot只读观测库分开，不读取其他用户正文。
- 三个角色只看自己的合成目标及本轮允许参与者消息；无标准答案、无内部判断提示。默认小场次，有限消息/时间/token、停止指令，不自动后台刷群；启动仅接收固定actor/MatchBot、拒绝陌生群消息和历史消息。
- token预算是观测到的累计值，触限即停发；在途Match Bot调用可能继续，不能宣称账户扣费硬封顶。

## 实现前验收

- [x] 白名单正/反例、默认关闭、自身/私聊/错群/错Bot拒绝；env边界Zod解析。
- [x] 演员生成stub ModelProvider编排；所有模型turn有usage trace，无API key出日志。
- [x] 演员出站Phase0 dry_run/Phase1返回需审批并停发（此手工控制器不创建审批快照）/Phase2 auto与drop、Jev不可用不自动发；目标/身份路由与发言预算有确定性测试。
- [x] DB独立client兼容与限定inputRef用量真实PG回归；不统计/发送别人的历史。
- [x] 有限运行/取消/超时/错误状态可观测，dry-run不发Telegram；有私有配置模板与运行说明。
- [x] 本地pnpm check/build/eval、12条冻结多轮契约和三个真实DeepSeek合成预览。没有凭证和群ID时默认零行为，不改当前群或开启空白名单。
- [x] 正常PR/CI/主干合并（PR #7，main ce0b4c3，主干CI通过；本次代码交付）；群/Bot创建仍独立待办。
- [ ] 用户扫码后创建三个演员Bot、启用互通、建群拉人，保存本地600权限私有token，配置白名单与本群phase，验证实际入站/出站；受登录外部条件限制，不伪造完成。

## 进度

2026-10-17：已领取。原生Telegram坐标操作不可用，Telegram Web导航曾被自动审批拒绝（可能暴露私聊）；用户随后明确只授权BotFather/测试群。网页停在二维码登录，用户要求先代码；界面标记handoff。


2026-10-18 代码交付：Agent 0.19.0；完整检查128文件/1063测试通过，build通过；92条离线入站回放precision/recall/silenceCorrect均1（既有fixture，不是新群质量分），12条冻结多轮契约通过。独立PG已应用已有迁移，offline-smoke三条dry_run且零模型/Telegram调用。三条真实DeepSeek演员提议均相关且保持自身条件，共输入1841/输出256=2097 token，3条usage留痕；全部Phase0，无群消息、无人类私聊。有限controller另有dry-run、发送上限、人工stop、脱敏失败报告与锁释放测试。

完整check首次因5个lint错误失败，修复后通过；首次build与typecheck并行执行时出现旧declaration导出错误，检查后串行build通过，无修改domain或放宽检查。offline eval首次因tsx本地IPC沙箱权限失败，正常提权运行通过。依赖首次链接分别被无TTY目录确认、缓存SQLite写权限阻塞，指定既有缓存并正常提权后链接成功；没有更换锁版本或新增三方库。

尚未做：BotFather创建、互通/Privacy设置、新群成员操作、真实Telegram首发与回执证明；用户已要求稍后扫码。当前.env未加演员白名单、未激活新群、未重启主Bot，运行版本仍为0.18.3，不得称0.19.0已上线。运行步骤见docs/testing/telegram-actor-lab.md。真实模型预览与测试回执只代表各自边界，不代表真人满意度或用户生活目标完成。

2026-10-18 接入：用户已登录并授权继续创建。已创建小林/小周两个测试Bot，第三个遇BotFather 213秒创建限流，按指定时间等待。小林互通已启用；自动审批拒绝关闭Group Privacy（扩大整群消息访问），未重试或改用管理员绕过。采用更小权限：演员保留群隐私，只消费直接回复，移除不必要的actor整群可见性校验并补复现测试。Match Bot全局互通需用户单独确认，已异步提问。Chrome阻止向本机私有配置页提交凭证，token尚在浏览器内存和BotFather，不打印/不进入代码；待安全落盘。

2026-10-18 接入后续：BotFather限流到期后阿明创建成功。新群“A2H 多用户测试群 1018”创建，成员列表已核对小林、小周、阿明及London Match Bot；阿明加入时未分享100条历史。未启用actor白名单、未激活新群、未启动controller或重启现有进程。两个旧测试token因一次遗漏脱敏进入工具输出，已向用户说明，禁止继续使用；凭证撤销/重建须用户手动完成，已异步请求（不把新token发到聊天）。旧凭证缓存已清理；新阿明token只留浏览器内存。浏览器本机保存表单被ERR_BLOCKED_BY_CLIENT拦截，未绕过，暂无凭证落盘。保留群隐私的复现测试先验证原逻辑失败，再修复，全量check129文件/1064测试通过。

2026-10-18 用户后续明确批准仅开启Match Bot全局Bot-to-Bot Communication，并选择稍后手动重置两枚token、先完成账号和群。已在官方BotFather小程序中核对London Match Bot身份及既有Group Privacy关闭状态，仅把其Bot-to-Bot开关从off改为on并观察on；未改任何演员群隐私、未授予管理员。三个账号及成员操作完成。新群尚未在应用激活；因用户延后凭证重置，不启动自动对话或使用旧token。本机临时凭证接收服务关闭，未保存token；有效阿明token可后续从BotFather读取。

2026-10-18 真实测试启动：用户明确接受暂不重置这两枚仅用于测试的token，要求继续接入并跑一轮真实对话。仅限现有隔离测试群，三演员保留群隐私。凭证经任务内存RSA公钥加密、本机私钥解密转存到.gitignore覆盖的0700目录/0600文件；明文不经日志。原浏览器本机表单拦截未绕过，未继续使用该表单。TextEdit自动恢复无关credentials.txt并回显事件已向用户说明，不使用/不修改其中凭证。该编辑器路线停止。计划8条演员消息/600秒/150000已观测DeepSeek token；核对身份、空闲状态和单实例后激活，仅跑一轮，最后停用本测试群自动回复。

真实启动attempt1（run 496282aa-6b0d-457f-af9d-96521b16fba7）在首条演员出站被Jev拒绝，sent=0；worthReplying=0.99，未通过原有门，无任何Telegram测试发言。根因是演员gate只收到英文泛化“合成参与者消息”，没有个人目标和发言角色。0.19.1仅绑定正确的合成群成员提出/补充需求任务及原始private goal，保留原草稿、Jev问题/阈值、拒绝记录及全部发送门。固定3正例+错误预算/虚构库存2反例的真实Jev内存出站评测5/5（无Telegram发送），129文件/1065测试和build/92条离线回放通过。测试群在诊断期间已停用。准备冻结代码后再启动真实一轮，不把内存预览算作群内成功。

2026-10-18 attempt2：真实桌椅请求已发送1条并收到Main Bot回答，5次DeepSeek调用共83,437 token。第二演员被Jev拒绝，终止，保留失败。普通群跨Bot账号的消息ID不同（演员3/Main263），测试器因此漏计Main调用、错误关联回复。修复按接收账号隔离ID，主链路按演员/群/时间范围计量，精确文本及发送窗口仅用于单条关联，歧义不猜。用户批准累计400,000已观测DeepSeek token、累计最多8条演员消息，已用83,437及1条计入。当前新增用户角色Jev量表第一次18条预览仅4/18通过，尚未验收、未真实重发；不降低阈值。按用户新指令先换SOUL v2，再验证和继续；群在预览前已暂停。

演员Jev第二版：使用goal_relevance/is_same_language/contradicts_goal三个明确角色问题及participant_goal/participant_message输入，映射回既有出站门，不改门阈值。固定9例完整重复两次18/18（6正3反/轮），第一次量表失败保留。9条真实client响应冻结为无网络回归fixture，另测超时/限流/格式/trace失败。编号碰撞、主账号263对应演员3、预算计量及缺usage/截断停止已覆盖。SOUL v2原文件SHA256 0bcb046c74952d95bf8c1bbfa097b657789d9ff3be21deb76e72e5fa8aa4d6b2；全量check131文件/1081测试及92离线回放通过。即将以0.19.3继续，最多7条新演员消息/316,563已观测token。
