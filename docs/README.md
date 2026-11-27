# docs 地图：先读什么、哪些是历史

> "现在到哪了"只看 [`STATUS.md`](STATUS.md)。本页只回答"这份文档是现行的还是历史的"，不复述内容。
> 与代码冲突时以代码为准。新增文档时在这里补一行。

## 1. 现行入口

| 文档 | 用途 |
|---|---|
| [`STATUS.md`](STATUS.md) | 唯一的进度入口：里程碑、时间线、当前波次、遗留清单 |
| [`global-roadmap-2026-10-16.md`](global-roadmap-2026-10-16.md) | 现行排号推进计划（S10 余项 + S11 主线：波次、任务号、依赖、验收） |
| [`development-tasks.md`](development-tasks.md) | 任务拆解与每个任务的"实现说明"（随合入追加） |
| [`runbooks/README.md`](runbooks/README.md) | 部署、验收、演练、发版、排障手册的入口；发版与主机跟随 tag 见 [`runbooks/release.md`](runbooks/release.md) §3 |
| [`status-history.md`](status-history.md) | 已完成阶段与波次的历史记录、STATUS 精简时移出的原文 |

## 2. 现行设计与规范

| 文档 | 用途 |
|---|---|
| [`graph-ai-middle-platform-design.md`](graph-ai-middle-platform-design.md) | 系统设计、领域模型、三条底线 |
| [`platform-admin-design.md`](platform-admin-design.md) | 使用面 / 管理面 / 维护面 |
| [`goal-orchestration-and-admin-agent-plan-2026-10-16.md`](goal-orchestration-and-admin-agent-plan-2026-10-16.md) | S11 方案：目标级执行（GoalRun / PlanRevision / StepRun）与平台管理员 Agent |
| [`s10-evolution-plan-2026-10-04.md`](s10-evolution-plan-2026-10-04.md) | S10 方案与 11 项决定（可升级运行时、受治理的自进化、能力包 / Pack Contract v1）；剩余工作由全局推进计划排序 |
| [`admin-agent-packs-design-2026-11-06.md`](admin-agent-packs-design-2026-11-06.md) | S11 AA5g：管理员智能体看见并提议安装能力包 |
| [`wire-contract-conventions.md`](wire-contract-conventions.md)、[`contracts/`](contracts/) | 线上契约与语义约定，`pnpm contract:check` 校验快照 |
| [`console-usability-dod.md`](console-usability-dod.md) | 控制台可用性完成标准（11 条） |
| [`testing.md`](testing.md) | 测试分层与命令 |
| [`test-coverage-gaps-2026-11-06.md`](test-coverage-gaps-2026-11-06.md) | 测试覆盖缺口清单与"功能—测试同步"机制（按批次实施，进度见 STATUS） |
| [`howto-connect-claude-code.md`](howto-connect-claude-code.md)、[`howto-connect-pi.md`](howto-connect-pi.md) | 接入 Claude Code / pi |

## 3. 已完成或被接替的阶段方案

这些文件页首有「历史文档」标注：排期、"目标""待做"是当时的计划，不代表现状。其中一些设计小节仍被代码、CI 或 `CLAUDE.md` 引用，标注里写明了是哪几节，这些小节仍是依据。

| 文档 | 阶段 | 接替者 |
|---|---|---|
| [`console-completion-plan.md`](console-completion-plan.md) | S6 控制台完善（2026-09-18） | 随 v0.14.0 发布；§2b、§5.4–§5.9 仍被代码与 CI 引用 |
| [`console-redesign-plan-2026-09-25.md`](console-redesign-plan-2026-09-25.md) | S8 控制台产品化重构 v1 | [`productization-plan-v2-2026-09-26.md`](productization-plan-v2-2026-09-26.md) |
| [`productization-plan-v2-2026-09-26.md`](productization-plan-v2-2026-09-26.md) | S8 产品化重构 v2 | S9 交付线、S10、S11（见 STATUS 时间线） |
| [`console-visual-p3-spec-2026-09-26.md`](console-visual-p3-spec-2026-09-26.md) | S8 P3 视觉重构规格 | 实施记录见 `status-history.md`（2026-09-26 起）；控制台现行标准见 `console-usability-dod.md` |
| [`convergence-plan-2026-09-25.md`](convergence-plan-2026-09-25.md) | S8 W3 起的收敛期方案 | S9 交付线、S10、S11；§6 W7 依赖升级决定仍有效 |

## 4. 时点快照（复审、回顾、审计）

按日期命名，记录的是当时的发现与判断，不随代码更新。STATUS 遗留表里的条目以 STATUS 为准。

| 类别 | 文档 |
|---|---|
| 代码复审 | [`code-review-2026-09-04.md`](code-review-2026-09-04.md)、[`code-review-2026-09-10.md`](code-review-2026-09-10.md)、[`code-review-2026-10-02.md`](code-review-2026-10-02.md) |
| 设计复盘与调研 | [`design-review-2026-09-01.md`](design-review-2026-09-01.md)、[`reference-projects-and-oss-landscape.md`](reference-projects-and-oss-landscape.md) |
| 阶段回顾 | [`retrospective-2026-09-09.md`](retrospective-2026-09-09.md)、[`retrospective-2026-09-11.md`](retrospective-2026-09-11.md)、[`retrospective-2026-09-18.md`](retrospective-2026-09-18.md)、[`retrospective-2026-09-19.md`](retrospective-2026-09-19.md)、[`retrospective-s11-w3-admin-agent.md`](retrospective-s11-w3-admin-agent.md) |
| 控制台审计与覆盖盘点 | [`ui-audit-2026-09-23.md`](ui-audit-2026-09-23.md)（主机 v0.16.2）、[`kernel-console-coverage-2026-09-26.md`](kernel-console-coverage-2026-09-26.md) |
