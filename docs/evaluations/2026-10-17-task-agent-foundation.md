# 任务 Agent 基础阶段验证

日期：2026-10-17。基线 main `254e462` / Agent `0.15.1`；开发分支 `codex/task-agent-foundation`。本报告是基础阶段证据，不是新版本发布或真实用户满意度验收。

## 已完成

- 实现前冻结 P24–P27 计划、A01–A18验收与12组多轮会话；原始案例和期望在 `packages/eval/fixtures/task-agent/conversations.json`，完整任务评测器尚未接入。
- 纯领域模型区分任务、分项验收、硬条件/偏好、来源证据、待答问题、信息投递和用户实际结果。完成一件商品不关闭其他项，用户自行解决不伪造来源已核实。
- 条件按goal/key合并；桌子预算改变不覆盖椅子预算，新增验收条目不删除旧条目。条件变化使旧适配证据失效。原句校验只证明模型提议引用当前用户文本，不能替代语义正确性评测。
- 仓储验证用户/渠道/会话及来源消息归属，头状态与事件checkpoint嵌套写入，CAS版本、幂等键载荷一致性及30天不活跃级联删除。迁移只应用隔离测试库，业务库未变。
- 服务端选中任务可绑定简短补充到有效请求；ScriptedModel真实SDK路径已验证羽毛球/E14/初学者/30分钟进入模型instructions并走原出站表。worker尚未自动选取任务。

## 实际验证结果

完整命令（本地测试静态凭据，不含生产密钥）：

```sh
COREPACK_HOME=/tmp/matchbot-corepack \
DATABASE_URL=postgresql://matchbot:matchbot@127.0.0.1:5432/matchbot_task_test \
REDIS_URL=redis://127.0.0.1:6379/15 corepack pnpm check
```

结果：typecheck、lint（含依赖方向）、format:check全通过；72个测试文件、643个测试通过。新增仓储11条全部使用真实Postgres事务回滚；重叠调用共用同一回滚事务，不等同独立连接/进程故障测试。

```sh
./node_modules/.bin/vitest run packages/domain/tests/task*.test.ts \
  --coverage '--coverage.include=packages/domain/src/task*.ts' \
  --coverage.reportsDirectory=/tmp/matchbot-task-coverage \
  --coverage.thresholds.branches=100 --coverage.thresholds.lines=100 \
  --coverage.thresholds.functions=100 --coverage.thresholds.statements=100
```

结果：34条领域测试通过；语句188/188、分支136/136、函数28/28、行166/166，全部100%。不是全仓库100%覆盖率。

旧入站fixture回放：92条，precision=1、recall=1、silenceCorrect=1；categoryAccuracy=91/92（s39原有other/housing差异仍在）。这是录制Jev响应的回放，不是新任务能力得分，不是本轮实时模型调用。

## 尚未完成

入站语义关联和歧义追问、真实任务规划/来源核验、问题发送回执关联、任务驱动的朋友式回答、可恢复执行/审批投递账本、固定源真实模型多轮、Telegram实际多轮、主干合并与发布仍需P25–P27。当前运行仍为0.15.1，不能用上述单测宣称线上问题已解决。

依赖说明：增加匹配Vitest版本的coverage-v8开发依赖；db显式声明原有zod，未升级现有SDK/运行时依赖。安装后的Prisma可选peer路径变化曾造成旧链接失效，冻结锁文件安装及generate已恢复；最终完整检查通过。
