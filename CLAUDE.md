# NextTime-AI — 会话约束（Claude Code 与任何 agent 会话）

## 会话开始

- 先读 `docs/STATUS.md`：里程碑状态、当前波次、遗留清单。它是"现在到哪了"的唯一入口；
  与代码冲突时以代码为准，并在本次工作里修正它。
- 再读与本次任务相关的 `docs/development-tasks.md` 小节与 `docs/runbooks/` 对应手册；
  设计与领域模型见 `docs/graph-ai-middle-platform-design.md`。

## 阶段 / 波次结束

- 波次合入、主机验收、发版之后，在同一 PR 或紧随的 docs PR 里更新 `docs/STATUS.md`
  （状态与证据、波次进度、遗留增删）。关闭遗留的 PR 必须同时改 STATUS 的遗留表。
- 实现细节追加到 `docs/development-tasks.md` 对应任务的"实现说明"；评估与反思写
  `docs/retrospective-*.md`，STATUS 只链接不复制。

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
- bot PR（release-please）的 workflow 需人工批准后再合并发版；Renovate / Dependabot 自动。
- 主机应用与验收：按 `docs/runbooks/` 执行，结果记 `docs/private/`，不改主机上项目目录之外
  的任何东西，不触碰主机上其他既有服务。
