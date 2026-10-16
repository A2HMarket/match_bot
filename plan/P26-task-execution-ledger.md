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
