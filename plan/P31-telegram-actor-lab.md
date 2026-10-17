# P31 — Telegram 多演员测试群

用户批准创建独立测试群与三个测试演员Bot，并授权官方Telegram Web仅用于BotFather和测试群。目前Web未登录，用户选择“稍后登录，先做代码”；不得称Bot/群已创建。基线main f71dc4e / Agent0.18.3。单执行者，无新三方库或业务表；apps/bot补齐agent/jev工作区依赖，apps/bot与eval声明已在技术栈中的zod。

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
- [ ] 正常PR/CI/主干合并（本次代码交付）；群/Bot创建仍独立待办。
- [ ] 用户扫码后创建三个演员Bot、启用互通、建群拉人，保存本地600权限私有token，配置白名单与本群phase，验证实际入站/出站；受登录外部条件限制，不伪造完成。

## 进度

2026-10-17：已领取。原生Telegram坐标操作不可用，Telegram Web导航曾被自动审批拒绝（可能暴露私聊）；用户随后明确只授权BotFather/测试群。网页停在二维码登录，用户要求先代码；界面标记handoff。


2026-10-18 代码交付：Agent 0.19.0；完整检查128文件/1063测试通过，build通过；92条离线入站回放precision/recall/silenceCorrect均1（既有fixture，不是新群质量分），12条冻结多轮契约通过。独立PG已应用已有迁移，offline-smoke三条dry_run且零模型/Telegram调用。三条真实DeepSeek演员提议均相关且保持自身条件，共输入1841/输出256=2097 token，3条usage留痕；全部Phase0，无群消息、无人类私聊。有限controller另有dry-run、发送上限、人工stop、脱敏失败报告与锁释放测试。

完整check首次因5个lint错误失败，修复后通过；首次build与typecheck并行执行时出现旧declaration导出错误，检查后串行build通过，无修改domain或放宽检查。offline eval首次因tsx本地IPC沙箱权限失败，正常提权运行通过。依赖首次链接分别被无TTY目录确认、缓存SQLite写权限阻塞，指定既有缓存并正常提权后链接成功；没有更换锁版本或新增三方库。

尚未做：BotFather创建、互通/Privacy设置、新群成员操作、真实Telegram首发与回执证明；用户已要求稍后扫码。当前.env未加演员白名单、未激活新群、未重启主Bot，运行版本仍为0.18.3，不得称0.19.0已上线。运行步骤见docs/testing/telegram-actor-lab.md。真实模型预览与测试回执只代表各自边界，不代表真人满意度或用户生活目标完成。
