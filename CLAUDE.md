# NextTime-AI — 会话约束（Claude Code 与任何 agent 会话）

## 会话开始

- 先读 `docs/STATUS.md`：里程碑状态、当前波次、遗留清单。它是"现在到哪了"的唯一入口；
  与代码冲突时以代码为准，并在本次工作里修正它。
- 再读与本次任务相关的 `docs/development-tasks.md` 小节与 `docs/runbooks/` 对应手册；
  设计与领域模型见 `docs/graph-ai-middle-platform-design.md`。

## 阶段 / 波次结束

- 波次合入、主机验收、发版之后，`docs/STATUS.md` 要更新（状态与证据、波次进度、遗留增删），
  关闭遗留的改动必须落到 STATUS 的遗留表。多线程协作时 `docs/STATUS.md`、`docs/development-tasks.md`、
  `docs/status-history.md` 只由合并线程在随后的成批记录里写（`docs/runbooks/dev-loop.md` §6），
  其他 PR 不改它们，在正文「合入后由合并线程写入的状态」一节写明要记什么、关哪条；
  单会话工作时在同一 PR 或紧随的 docs PR 里自己改。
- 实现细节追加到 `docs/development-tasks.md` 对应任务的"实现说明"；评估与反思写
  `docs/retrospective-*.md`，STATUS 只链接不复制。

## 开发闭环

- 角色、交接、遗留分档、记录节奏、巡检与上主机的流程在 `docs/runbooks/dev-loop.md`；提醒线与上限在
  `docs/state/loop.json`。必须每次都发生的事由脚本和 CI 检查，不靠会话记住：
  - 开 PR 后：`node scripts/review-route.mjs --base origin/main` 算出风险级与评审席位，直接找这些席位；
  - 合并前：`node scripts/pr-gate.mjs merge <PR>`；合 release PR 前：`node scripts/pr-gate.mjs release <PR>`；
    最后一行是 `RESULT ok` 才合；
  - 主机升级的简报：`node scripts/host-upgrade-brief.mjs --from <主机版本> --to <tag>`，不手数迁移和小节；
  - 巡检：`node scripts/loop-health.mjs`，报告里的「该处理」当场处理或分派，「无样本」不等于正常。
- 不为了触发 CI 推空 commit，也不把 PR 关了再开。
- 被权限检查拦下时，先对照上一次成功的做法（哪个工具、哪条路径），仍不行再上报；不自己加允许规则。
- 出过一次的错，先写成守卫、测试或门脚本里的一项检查；只能靠判断的在手册里写一行并删掉它取代的旧规则。

## 公开仓库红线

- 主机别名、内网 IP 与网段、数据目录与检出路径、密钥、Handle / token、外部系统的 ID 只存在
  gitignored 的 `docs/private/` 与主机 `.env` / `secrets/`；不写进任何入库文件、commit
  message、PR 描述、issue。
- 三条设计底线不可降级：agent / kernel 进程不持凭证；触及有凭证、内部或有状态系统的动作
  必经审批；隔离与审计只增不减。

## 工程约定

- 全 TS pnpm monorepo。改动走分支 + PR，CI `guards / quality / test` 绿后合并；
  Conventional Commits（release-please 据此生成 CHANGELOG 与版本）；单 commit 的 PR 用 squash。
- 线上契约与语义：`docs/wire-contract-conventions.md`；`pnpm contract:check` 校验快照；
  `pnpm ci:guards` 含词表守卫（读 `packages/shared/dist`，先构建 shared）。
- bot PR（release-please）的 workflow 需人工批准后再合并发版；Dependabot 安全更新开关保持关闭
  （2026-10-02 决定），发版前用 `gh api …/dependabot/alerts?state=open` 查开放告警并手工修
  （接口对会话返回 403 时以 `pnpm audit` 为准，`pr-gate release` 已包含）；常规依赖升级
  不交给 bot，按收敛方案的波次手动做（2026-09-25 决定，Renovate 已移除）。
- 主机应用与验收：按 `docs/runbooks/` 执行，报告进 `docs/host-upgrades/`（主机别名、地址、路径写成占位符；
  密钥类、模型供应商与花费只记 `docs/private/`，维护者 2026-11-27 定），不改主机上项目目录之外
  的任何东西，不触碰主机上其他既有服务。
