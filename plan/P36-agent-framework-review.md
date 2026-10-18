# P36 — Agent框架review与交付阶段优化

状态：完成实现与本轮验证，单执行者。用户要求重新review框架、分析不合理处并优化。真实完整多轮质量仍未验收，不把writer通过当整体通过。

已确认：P35六条Main消息41次模型调用；搜索工具重复返回累计来源，writer沿用研究会话和同一份长instructions。仅内存解密的脱敏审计显示三个checkpoint writer提示词约32168/27366/37379字符，研究Agent暴露16个工具。record_task_progress已能表示deliver/ask_user，但没有正常阶段切换，writer只能在失败收尾时单独运行。需要把已有边界真正接起来。

方案：复用现有finalizer/用户session/任务进度，不新增数据库实体或外部服务。已登记可交付进度→正常转writer；writer使用选定的当前来源和新会话窗口（仍是同一用户持久session），不重放搜索大包，只有现有reply_to_request出站；恢复时保留阶段与来源约束。研究工具按当前任务收口，catalogue旧路径保留。已知条件的追问在进度登记时即拒绝，出站仍复核。研究超时/轮次耗尽有证据时保留时间做一次受限交付，Jev拒绝/不可用不绕过。

所有判断trace，仍走tool/needsApproval/阶段/Jev/频控/出站表；不降低阈值或放宽来源/预算/日期。仅packages/agent及计划/报告/PoC。AGENT_VERSION递增，无SDK升级、依赖、表或个人数据字段。

补充修复：真实回放暴露whole-source的quote=null导致整个进度失败，改为server-owned有界原文摘录，仍走computed检查及Jev支持/矛盾检查；显式伪引文仍拒绝。旧计划里已知条件的追问不再传给writer。冻结契约发现“附近也可以”丢失搭子搜索路由，改为参考持久任务目标。亲子回放发现10 am→10:00误判成无来源00，增加时钟格式等价处理，不接受错误时间或用价格冒充时刻。

验证：pnpm check通过（134文件、1128测试），build通过；12冻结多轮契约、92录制入站回放通过。对已授权合成checkpoint只在内存重建，输出脱敏统计，不落明文context（自动审批拒绝的完整明文落盘方式已弃用）。最终writer字符较原路径约少72%–75%，不是实测token降幅。真实DeepSeek累计173645token、22次返回用量的调用，低于用户批准的200000；零Telegram消息。GP完整回放仍有数字证据失败，打印机/亲子等完整尝试被测试器预算预留阻断，不能算agent失败或完整通过。独立writer有实质答复；打印机/亲子最终writer带合成execution fence，亲子原始草稿在时间修复后原样通过真实工具/Jev（零新增DeepSeek）。GP等早期预览未带execution fence，不能代替生产任务门验收。剩余额度不自动使用。

详见 [P36评审与验证报告](../docs/evaluations/2026-10-18-agent-framework-review.md)。无新出站工具、表、依赖、SDK升级、个人数据字段或阈值放宽，AGENT_VERSION=0.23.0。
