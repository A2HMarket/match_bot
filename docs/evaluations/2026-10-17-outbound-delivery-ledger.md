# 出站投递账本：分支阶段验收

2026-10-17，父提交c326b17。P26进行中；**未合并main、未发布或重启本地业务服务**。本文只验证投递组件，不代表入站任务、审批恢复、追问送达或真实Telegram全链路完成。

## 本次实现

复用outbound_messages，新增sending/delivery_unknown以及phase、认领令牌/到期时间、外部发送起点、尝试次数/下次时间、外部消息编号。新迁移为20261016205000_outbound_delivery_ledger；只在隔离matchbot_task_test和matchbot_delivery_proof应用，未应用业务库。

- 原子CTE加FOR UPDATE SKIP LOCKED认领，并在同事务写trace；每个发送前校验当前阶段/群是否有效及认领令牌。Phase0、阶段未知、非Telegram行不进入Telegram投递。
- 认领后尚未开始外部发送的过期记录可重领，新令牌拒绝旧进程。已写发送起点后过期只能转delivery_unknown，不自动重新投递。外部接口已接受但确认丢失，与尚未实际调用但已写起点无法完全区分，因此后者也保守记不确定。
- sender返回经过schema校验、目标一致的消息回执。消息只有保存回执才记sent；反应成功没有新message_id。回执写库失败不能被当成Telegram发送失败重试；不确定行可以接受仍持同一令牌的晚到权威回执。
- Telegram明确拒绝与网络/超时区分。明确429按retry_after延后重试，最多3次认领；网络错误、未知回执或失去确认不自动重发。发送错误只记录固定错误码，不复制Telegram错误描述或消息载荷进日志。
- 发送前再次读取当前群阶段：切到Phase0/停用后不发；自动阶段变成待审阶段也暂缓。Sender要求调用方提供发送起点回调，避免遗漏fencing。
- 通过grammY实际支持的client.timeoutSeconds=10设置HTTP上界，Bot长轮询为5秒。安装的Node版本grammY使用自己的AbortSignal类型，未强转Node原生signal绕过类型。审批卡发送工厂也使用相同HTTP上界。
- 新回执/认领标识30天清理：成功按sentAt，失败/不确定按最后发送起点或创建时间；不清除活动认领。复用既有cron每6小时执行，无对外通知。未新增联系方式、证件或私人身份字段。

包契约跨domain/db/channel-telegram/agent/apps：outboundDraft.phase由服务端ctx写入，模型参数不提供；bot复用已有gating规则，新增其工作区依赖声明；channel声明栈内既有zod用于API回执校验。锁文件只新增这两处依赖声明，无外部库升级，也未修改lint/严格类型规则。

## 可复核证据

|验证|结果|范围|
|---|---|---|
|pnpm check|85文件/742测试全绿|类型、lint、依赖方向、格式、隔离服务测试|
|pnpm build|通过|所有包/apps构建；不代表运行中的进程已升级|
|旧92条入站fixture|precision/recall/silenceCorrect=1，分类91/92|旧s39差异保留；不是任务完成率|
|真实PG事务回滚|5条新增投递测试通过|原子认领、旧fence、恢复方向、晚到/重复回执、重试上限与保留期；旧仓储测试也已改为经认领/发送起点验证|
|独立进程与本地HTTP故障证明|最终7场景通过，6.9秒|真实Postgres、独立Node进程、SIGKILL、真实墙钟租约到期；传输为本地模拟Telegram，未调用真实Telegram|
|迁移一致性|No difference detected，exit0|隔离测试库与schema一致；证明库最终outbound/trace行均为0，合成夹具已清理|

进程证明不是同一个回滚事务中的重叠调用。两个子进程分别认领不同的已提交行；随后在三个不同窗口SIGKILL：认领后未写起点（pending可重领）、已写起点未HTTP（delivery_unknown、接收0次）、本地接口已确认但未写库（delivery_unknown、接收1次、可补权威回执）。另外验证正常完整投递、明确429一次后延时重试成功、接口接受但HTTP确认丢失后不重试。

最终记录中模拟接口收到5个请求，其中4个接受、1个明确拒绝；丢失确认没有产生第二个发送。v1使用注入到期时间，v2改为真实墙钟到期，v3增加完整HTTP路径，v4添加源码/迁移/证明程序指纹。四份记录及检查/构建日志都保留在outbound-delivery-ledger目录，最终以v4的sourceFingerprint绑定本次证明代码。

## 迁移命令偏差

按AGENTS先运行pnpm db:migrate --name outbound_delivery_ledger。普通及TTY两次都因Prisma将宿主判为非交互而在应用前退出；没有继续重试该命令。读取安装CLI的帮助后，使用官方只读migrate diff生成SQL，检查只有新增列、枚举和索引，再由migrate deploy记录并应用到两个隔离库。保留了唯一回执约束，没有为绕过警告削弱schema，也没有db push或手写业务库变更。

## 尚未验收与发布前要求

- 入站消息的可恢复执行记录、跨inbound/resume用户租约、按完成步骤恢复仍未实现；不能凭本次出站证明关闭A13–A15。
- 审批consume/决定/可补投resume意图需同事务；恢复须核对原Task/版本/作用域。审批关联、问题排队与真实送达后的pendingQuestion、Task.delivery回写仍待接入。
- 新增phase缺省为0，旧pending行会被保留而非猜测原授权。发布时需检查旧队列/快照/未知阶段行；停止所有旧发送进程后再切换，避免旧无fencing进程与新协议混跑。
- 桌椅/羽毛球/展览等完整固定源多轮、盲序朋友感评分、原群真实Telegram、最终合并推送和本地运行版本证明仍在P25/P27。当前taskRequests不开启，不声称用户生活目标已完成。
