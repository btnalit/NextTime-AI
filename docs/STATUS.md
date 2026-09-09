# STATUS — 项目入口与进度（唯一真相）

> 这是"现在到哪了"的唯一入口。任何会话、任何阶段开始先读这里；波次合入、主机验收、发版
> 之后在同一 PR 或紧随的 docs PR 里更新这里。它只放三块内容：里程碑状态、当前波次、遗留清单。
> 拆解与实现说明在 `development-tasks.md`，评估在 `retrospective-*.md` / `code-review-*.md`，
> 本文只链接不复制。与代码冲突时以代码为准，并修正本文。

最后更新：2026-09-09（v0.3.0，S3 收口）

## 1. 入口指引

| 想知道 | 去哪 |
|---|---|
| 系统是什么、领域模型、三条底线 | `graph-ai-middle-platform-design.md`、`design-review-2026-09-01.md` |
| 任务拆解、依赖图、每个任务怎么实现的 | `development-tasks.md`（"实现说明"随合入追加） |
| 线上契约与语义约定 | `wire-contract-conventions.md`、`contracts/*.json`（`pnpm contract:check`） |
| 怎么部署、验收、演练、排障 | `runbooks/README.md` 起步；验收 `runbooks/accept-s1.md`、`runbooks/host-accept-s2.md`、`runbooks/host-accept-s3.md` |
| 测试分层与命令 | `testing.md` |
| 自动化与发布 | `runbooks/automation.md`、`runbooks/release.md`、`CHANGELOG.md` |
| 阶段评估与设计反思 | `retrospective-2026-09-09.md`、`code-review-2026-09-04.md` |
| 接入 Claude Code / pi | `howto-connect-claude-code.md`、`howto-connect-pi.md` |

## 2. 里程碑状态

| 里程碑 | 目标 | 状态 | 证据 |
|---|---|---|---|
| E | 目标主机可跑全部服务 | 达成 | `runbooks/host-*.md` |
| R | monorepo lint / test / build / migrate | 达成 | CI `guards / quality / test` |
| S1 | 登录 → 对话 → 自己的 pi 回答 → Turn 入图 | 达成 | `accept_s1.sh` 22 PASS + 1 SKIP（2026-09-09） |
| S2 | 说需求 → find_workers → invoke_worker → 门动作 → 审批 → 执行 → 写回 | 达成 | `accept_s2.sh` 66 PASS（2026-09-09） |
| S3 | 本体 v1 + 采集器 + Explorer + MCP gateway | 达成 | `accept_s3.sh` 24 PASS（2026-09-09，PR #125） |
| S3.11–S3.15 | 控制面、接入向导、AgentProfile、web 控制台、pi 漂移 | 达成 | `development-tasks.md` 各节实现说明 |
| 发布 | — | v0.3.0 | `CHANGELOG.md` |

## 3. 当前波次

**W5 收口**（排定 2026-09-09，预计 1–2 天；范围与完成标准见 `retrospective-2026-09-09.md` §4）

| 项 | 范围 | 状态 |
|---|---|---|
| `explain` 收敛到喂给该 Fact 的 Observation + `search` 分页 | 内核 epistemic / graph 读，同一 PR | 未开工 |
| `create_task` 接现有 spawn 路径，或先下架 | 内核 task | 未开工 |
| fake-llm 自检两个预存失败 | `deploy/accept-s2` | 未开工 |
| 单 commit PR 改 squash（CHANGELOG 去重） | 流程 | 未开工 |
| Renovate 首跑确认 | 自动化 | 观察中 |
| E7 主机备份定时器决定 | 运维 | 待决定 |

后续：W6 验收工具链治理 → W7 真实模型验证 + Explorer 按调用者鉴权 → 两周稳定期 → 镜像发布与 P5。

## 4. 遗留清单

每条要么链接到关闭它的 PR，要么标明归属波次。关闭遗留的 PR 必须同时改本表。

| # | 项 | 归属 | 状态 |
|---|---|---|---|
| 1 | `explain` 对 collector Fact 返回整批 Observation（>400KB）；根因是 Fact 与 Observation 无直接关系（`retrospective-2026-09-09.md` §5.1） | W5 | 开放 |
| 2 | `search` 无 `limit` / `cursor`，硬上限 50（§5.5） | W5 | 开放 |
| 3 | `create_task` 的 Task 永远 `queued`（§5.6） | W5 | 开放 |
| 4 | fake-llm 自检 `entry-restart-chat-turn2/3` 预存失败 | W5 | 开放 |
| 5 | Renovate 首跑未见 | W5 | 观察中 |
| 6 | E7 主机备份定时器"S3 后重评" | W5 | 待决定 |
| 7 | 验收 harness：四份 heredoc driver、验收改生产 provider 配置、fake-llm 硬编码场景（§5.2–5.4） | W6 | 开放 |
| 8 | Explorer 由 caddy 注入 key 的信任边界（§5.8） | W7 | 开放 |
| 9 | 领域包烤进 kernel 镜像（§5.7）；采集器 Source 状态按文件缓存（§5.9） | 待排 | 开放 |
| 10 | `extension_ui_request` 子协议；Trigger；CLI help 清单解析 | P5 | 开放 |
| 11 | 容器运行时访问面收敛（§5.10）；备份 root + capability（§5.11）；清理靠名字正则（§5.12） | 长期 | 记债 |
| 12 | bot PR 的 CI 需人工批准 run（决定：暂维持人工） | 决定 | 关闭 |
| 13 | 容器镜像不发布到 GitHub（决定：稳定后再做） | 决定 | 关闭 |

## 5. 更新规则

1. 会话开始：读本文；再读与本次任务相关的 `development-tasks.md` 小节与 runbook。
2. 波次合入、主机验收、发版之后：更新 §2 状态与证据、§3 进度、§4 增删；同一 PR 或紧随的
   docs PR 完成。
3. 关闭遗留的 PR 必须同时把 §4 对应行改为"关闭 + PR 号"。
4. 不写主机别名、IP、路径、密钥、外部系统 ID（公开仓库）；主机应用细节记在 gitignored 的
   `docs/private/`。
5. 评估、反思、复审写独立文档并在 §1 登记；本文只链接。
