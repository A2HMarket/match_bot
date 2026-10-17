# P26 — 执行与投递账本

依赖P24；与P25接口串行衔接。验收以[P24总计划](./P24-task-agent-plan-and-acceptance.md)A13–A16为准。

- [ ] TaskTurn/TaskEvent的版本和幂等、租约/fencing，跨入站/恢复按用户协调。
- [ ] 消息已存在但未执行完成可恢复，不能用无条件duplicate_delivery丢弃。
- [ ] 审批决定与可补投resume意图同事务，Redis失败可补发且消费幂等。
- [ ] 出站原子认领、发送回执、已明确失败重试、delivery_unknown保留待核对。
- [ ] queued/sent/用户完成分开，问题送达才等待用户，重启可重建。
- [ ] 隔离真实DB/并发进程故障注入逐点验收，清理与PII回归。

不承诺外部Telegram exactly-once，不盲重发不确定结果，不增加未经委托的后台触达/商家联系。

2026-10-17开工：先补现有outbound_messages的原子认领、租约/fencing、发送起点及渠道回执。复用既有表和sender，避免新建第二套发送系统；出站已进入外部调用后超时/崩溃只能记delivery_unknown，不自动重发。TaskTurn/审批与问题送达后续按同一契约衔接，本记录不代表完成。

分支投递组件已实现并实测：原子认领/发送起点、过期前后恢复方向、权威回执/写库失败不重发、明确429限次延后重试、阶段变更检查及30天回执清理。全检85文件/742测试；独立进程与真实墙钟SIGKILL、本地HTTP共7场景通过。详见docs/evaluations/2026-10-17-outbound-delivery-ledger.md。Prisma migrate dev在非交互宿主两次退出，按安装CLI支持的只读diff生成/检查新增SQL再deploy到隔离库，未应用业务库。

剩余优先：入站执行状态/用户协调→同事务审批与可补投恢复→Task/问题与出站/回执关联→恢复/隐私/旧版本失效验收。不能把投递组件完成当成整个P26完成；看板继续进行中，未合并或发布。

入站阶段进展：消息先落库、未完成补投、用户租约/fencing、每批工具加密checkpoint及同请求出站幂等已接入。真实SDK进程SIGKILL后恢复，最终仍1Task/1用户变更/1搜索/1dry_run；新旧进程不同，租约实际到期。全检89文件/765测试通过，详见docs/evaluations/2026-10-17-request-execution-ledger.md。审批恢复尚未接入同一租约；问题送达与最终验收/发布仍未完成。

审批阶段进展：决定/条件consume/待恢复意图/trace同事务；Redis失败可从DB补投。恢复已接同一用户fence，按原消息/当前Task版本/Agent与SDK版本/作用域恢复，不读最新其他需求；限次重试，已排队出站/新中断可收敛。全检91文件/776测试通过；实际SDK+独立进程SIGKILL、事务回滚、Redis失败证明通过。详见docs/evaluations/2026-10-17-approval-resume-ledger.md。审批卡本身的持久投递、问题/Task送达回写、快照清理及最终多轮验收仍未完成，不关闭整个P26。

任务回执阶段进展：复用Task与出站，排队/拟发问题及sent/unknown/failed同事务关联；Phase0不假送达，只有已发问题才waiting_user。外部消息编号按owner/会话解析回复anchor；新轮次（含同条件）取代旧拟发与审批，发送前复核。全检95文件/803测试，任务域分支280/280；SDK两任务接话和PG回执测试通过；入站/审批真实进程证明复跑通过。真实DeepSeek/Jev房源v13两轮8/8，仅这一场景回归，不计三核心或Telegram。详见docs/evaluations/2026-10-17-task-delivery-receipts.md。剩余：审批卡持久投递、快照清理、日期/布尔语义负例、完整质量门与最终验收发布。

本轮实现卡片持久投递/版本化发现/固定Ops收件人与来源阶段复核，worker不再直接发卡；统一sender/fence/回执及unknown保守方向。快照三种状态内容与卡片副本7天清理，新fence及新快照受保护。真实SDK+独立发布/恢复进程+SIGKILL+本地HTTP证明通过；截断问题误等待漏洞也已复现并修复。并行修复真实模型v14–v16暴露的历史检索词丢失、预算口径、禁宠和明确日期问题；v17两轮8/8，但不是三核心验收。详见docs/evaluations/2026-10-17-durable-approval-cards-and-search-context.md。P26保持进行中，最终整体验收与发布仍待P27。
