# STATUS — 项目入口与进度（唯一真相）

> 这是"现在到哪了"的唯一入口。任何会话、任何阶段开始先读这里；波次合入、主机验收、发版
> 之后在同一 PR 或紧随的 docs PR 里更新这里。它只放三块内容：里程碑状态（含时间线与验收边界）、当前波次、遗留清单。
> 拆解与实现说明在 `development-tasks.md`，评估在 `retrospective-*.md` / `code-review-*.md`，
> 本文只链接不复制。与代码冲突时以代码为准，并修正本文。

最后更新：2026-09-10（v0.4.0；W5 收口完成并发版，当前波次切到 W6）

## 1. 入口指引

| 想知道 | 去哪 |
|---|---|
| 系统是什么、领域模型、三条底线 | `graph-ai-middle-platform-design.md`、`design-review-2026-09-01.md` |
| 任务拆解、依赖图、每个任务怎么实现的 | `development-tasks.md`（"实现说明"随合入追加） |
| 线上契约与语义约定 | `wire-contract-conventions.md`、`contracts/*.json`（`pnpm contract:check`） |
| 怎么部署、验收、演练、排障 | `runbooks/README.md` 起步；验收 `runbooks/accept-s1.md`、`runbooks/host-accept-s2.md`、`runbooks/host-accept-s3.md` |
| 测试分层与命令 | `testing.md` |
| 自动化与发布 | `runbooks/automation.md`、`runbooks/release.md`、`CHANGELOG.md` |
| 阶段评估与设计反思 | `retrospective-2026-09-09.md`、`code-review-2026-09-04.md`、`code-review-2026-09-10.md` |
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
| 发布 | — | v0.4.0（2026-09-10，PR #130） | `CHANGELOG.md` |

> S1–S3 的「达成」以各自验收脚本为准。2026-09-10 全量通读复审发现 S3.2 的冲突检测在
> Worker 断言这条主路径上不生效（`code-review-2026-09-10.md` §2.1）。验收对 Conflict 的唯一断言是
> 「采集器跑两遍后为零」，因此压制 Conflict 的缺陷无论存在与否验收都表现为通过；里程碑状态不改，
> 缺陷按 §4 第 16 项跟踪。

### 2.1 时间线（每阶段一行，追加不覆盖）

| 日期 | 发生了什么 | 依据 |
|---|---|---|
| 2026-09-01 | 架构设计 v0.3 定稿；对照原始需求复盘 | `graph-ai-middle-platform-design.md`、`design-review-2026-09-01.md` |
| 2026-09-02 | 目标主机上线（里程碑 E）：检出、密钥、Postgres、caddy | `runbooks/host-*.md` |
| 2026-09-04 | 首次代码复审，列出 P0 三条与 F1–F10 修复计划 | `code-review-2026-09-04.md` |
| 2026-09-08 | F1–F10 全部合入并在目标主机验证；排定 S3 实施波次 | `development-tasks.md`「S3 实施波次」 |
| 2026-09-09 | S3 波次 W1–W4 合入，主机三份验收通过；发布 v0.2.0、v0.3.0；本文建立 | `retrospective-2026-09-09.md`、`CHANGELOG.md` |
| 2026-09-10 | 全量通读（约 6.2 万行源码）+ 三轮定向复审；新增 P1 三条 | `code-review-2026-09-10.md` |
| 2026-09-10 | W5 收口：遗留 1–5、15 关闭（PR #128 / #129 / #131 / #132），fake-llm 自检进 CI，仓库只留 squash；发布 v0.4.0（PR #130）。主机未应用（停栈中），迁移 0018 待下次起栈时随 `make migrate` 落地 | `CHANGELOG.md`、本文 §4 |

### 2.2 验收证明了什么，没证明什么

三份验收脚本证明的是**内核 / 门 / 扩展这一侧的链路成立**。两处已知盲区，排期时按此判断，不要把
「验收通过」读成「功能可用」：

- **全部跑在 `deploy/fake-llm` 上**，而它是硬编码的 if / else 状态机。「真实模型会自己选对工具」
  从未被验证过——这正是 W7 的内容。
- **对 Conflict 的唯一断言是「采集器跑两遍后为零」**，因此任何**压制** Conflict 的缺陷，
  存在与否验收都表现为通过（§4 第 16 项即属此类）。缺一条「异源矛盾断言 → 恰好一个 open Conflict」
  的正向用例。
- **v0.4.0 未在主机验收**：W5 的 #132 改了 `explain`（collector Fact 只返回喂给它的那一条 Observation）
  与 `search`（分页参数）并带迁移 0018；主机停栈中，三份验收的证据仍是 v0.3.0 的 09-09 结果。下次起栈
  按 `runbooks/host-*.md` 应用后复跑 `accept_s3.sh`，里程碑状态在那之前不改。

## 3. 当前波次

**W5 收口：完成**（2026-09-10，一天）。六项里五项关闭（PR #128 文档漂移、#129 fake-llm 自检、#131 `create_task` 下架、#132 `explain` 收敛 + `search` 分页、仓库设置只留 squash、Renovate 决定暂不装），E7 仍待决定；各项细节见 §4 第 1–6 项与 `development-tasks.md` 的 W5 实现说明。复审新发现一条（§4 第 23 项：`query_decisions` / `list_conflicts` 的 cursor 精度）。

**当前波次：W6 验收工具链治理**（范围与完成标准见 `retrospective-2026-09-09.md` §4；未开工）

| 项 | 范围 | 状态 |
|---|---|---|
| 四份 heredoc driver 抽成一份 | `scripts/accept_s{1,2,3}.sh`、`deploy/accept-s2` | 未开工（§4 第 7 项） |
| fake provider 切换改为 compose override，不再改生产 provider 配置 | `docker-compose.yml`、验收脚本 | 未开工（§4 第 7 项） |
| 至少 S1 精简版进 CI | `.github/workflows/`、compose 精简 profile | 未开工（§4 第 7 项） |

W6 开工前需要维护者拍板的两件事：P1 第 16 / 17 / 18 项是否插到 W6 之前（复审建议提前）；E7 备份定时器（§4 第 6 项）。

目标主机：09-09 验收后处于停栈状态，仅 `llm-proxy` 与 `fake-llm` 在跑，Postgres 干净停机、数据与镜像完好；W5 若需主机验收，先按 `runbooks/host-*.md` 起栈。

后续：W6 验收工具链治理 → W7 真实模型验证 + Explorer 按调用者鉴权 → 两周稳定期 → 镜像发布与 P5。

## 4. 遗留清单

每条要么链接到关闭它的 PR，要么标明归属波次。关闭遗留的 PR 必须同时改本表。
级别沿用复审口径：P1 破坏不变量 / 授权 / 可靠性；P2 加固与运维正确性；P3 语义与文档漂移。

| # | 项 | 级别 | 归属 | 状态 |
|---|---|---|---|---|
| 1 | `explain` 对 collector Fact 返回整批 Observation（>400KB）；根因是 Fact 与 Observation 无直接关系（`retrospective-2026-09-09.md` §5.1） | P2 | W5 | 关闭（PR #132：迁移 0018 加 `links.observation_id`，`explain(factId)` 收窄到该 Fact 自己的 Observation） |
| 2 | `search` 无 `limit` / `cursor`，硬上限 50（§5.5） | P2 | W5 | 关闭（PR #132：加 `limit`/`cursor` 与 `GraphStore.searchPage`，`MAX_SEARCH_LIMIT=200` 截断标 `truncated:true`） |
| 3 | `create_task` 的 Task 永远 `queued`；2026-09-10 复审确认它在唯一现实路径上不可达，**建议下架**（`code-review-2026-09-10.md` §3.2） | P2 | W5 | 关闭（PR #131：下架，接线留到授权衰减模型有结论之后） |
| 4 | fake-llm 自检 `entry-restart-chat-turn2/3` 预存失败 | P3 | W5 | 关闭（PR #129：自检夹具对齐线上契约形状，自检进 CI `quality`） |
| 5 | Renovate 首跑未见 | P3 | W5 | 关闭（决定：暂不安装；Dependabot 告警暂不处理，见 §3） |
| 6 | E7 主机备份定时器"S3 后重评" | — | W5 → 待决定 | 待决定（W5 收口时仍未决） |
| 7 | 验收 harness：四份 heredoc driver、验收改生产 provider 配置、fake-llm 硬编码场景（§5.2–5.4） | P2 | W6 | 开放 |
| 8 | Explorer 由 caddy 注入 key 的信任边界（§5.8） | P2 | W7 | 开放 |
| 9 | 领域包烤进 kernel 镜像（§5.7）；采集器 Source 状态按文件缓存（§5.9） | P3 | 待排 | 开放 |
| 10 | `extension_ui_request` 子协议；Trigger；CLI help 清单解析 | 功能缺口 | P5 | 开放 |
| 11 | 容器运行时访问面收敛（§5.10）；备份 root + capability（§5.11）；清理靠名字正则（§5.12） | P2 | 长期 | 记债 |
| 12 | bot PR 的 CI 需人工批准 run（决定：暂维持人工） | — | 决定 | 关闭 |
| 13 | 容器镜像不发布到 GitHub（决定：稳定后再做） | — | 决定 | 关闭 |
| 14 | 主机验收记录断档：09-09 的 S3 验收与 v0.2.0 / v0.3.0 发版都没有 `docs/private/` 记录（主机上也没有该目录），最新一份记录停在 09-04；§2 的 22 / 66 / 24 目前只有 retrospective 与 PR 正文为据 | P2 | W5 / 流程 | 开放 |
| 15 | 入库文档与代码状态漂移：`README.md` 仍称「设计阶段（v0.2）…仓库只有文档，尚无可运行组件」；设计文档头部仍写「全部为提案…尚无任何组件实现」、§7.6 仍写「当前实现只有『工作』区」、§9.3 把 task 组标 `propose / observe` 而注册表里 `create_task` / `cancel_task` 均为 `write`；`development-tasks.md` 的 S3.6 一节没有完成标记，而其代码与验收都已落地 | P3 | docs PR | 关闭（PR #128：README 重写、设计文档头部 / §7.6 / §9.3 修正、S3.6 完成标记） |
| 16 | **Worker 断言的 Fact 永远按 principal 判定来源**：`postWorkerResult` 先断言后记 Observation，`resolveFactOrigin` 因此拿不到 Source；叠加 agent principal 每 WorkerDefinition 一个，同一定义两次运行的矛盾断言被静默 supersede 而非开 Conflict —— S3.2 的核心场景（`code-review-2026-09-10.md` §2.1） | **P1** | 待排（建议提前至 W5） | 开放 |
| 17 | 并发首次断言同一身份不开 Conflict：`FOR UPDATE` 锁不住不存在的行，`links` 上也无 `(link_type, source, target)` 唯一约束（`code-review-2026-09-10.md` §2.2） | **P1** | 待排（建议提前至 W5） | 开放 |
| 18 | Handle 通道不校验 `minRole`，`member` 的入口 Handle 结构性携带 5 个 `minRole:'builder'` 的 `propose_*` 并可调用；不构成越权发布（草稿私有 + I16），但 `minRole` 在该通道事实失效（`code-review-2026-09-10.md` §2.3；代码已自认并写明修法） | **P1** | 待排 | 开放 |
| 19 | `llm-proxy` 无任何预算代码，设计 §5.4 I18 的「100% 时代理返回预算耗尽错误」未实现，超支只能由内核事后止损（`code-review-2026-09-10.md` §3.1） | P2 | 待排 | 开放 |
| 20 | 两个门容器与 caddy / postgres 无 `read_only` / `cap_drop:[ALL]` / `no-new-privileges`，其余服务均有；门是唯一持外部凭证的进程（`code-review-2026-09-10.md` §3.3） | P2 | 待排 | 开放 |
| 21 | 控制台看不到审批历史：注册表只有 `list_pending` 与 `get_action`，无列出已决 ActionRequest 的能力（`code-review-2026-09-10.md` §3.4） | P2 | 待排 | 开放 |
| 22 | 出网拒绝表在 `reconcile()` 后回退到容器创建时的旧值：标签只在创建时打，复用分支刷新 source map 却回写不了标签，而 `reconcile()` 每次 docker-events 重连都跑；与 `EGRESS_DENY_LABEL` 自称的「永不放宽，哪怕暂时」冲突（`code-review-2026-09-10.md` §3.5；平台级拒绝不受影响） | P2 | 待排 | 开放 |
| 23 | `query_decisions` / `list_conflicts` 的 keyset cursor 与 `search` 修复前同一模式：`created_at` 经 JS `Date` 只剩毫秒，回传后与微秒精度的列做 `<` 比较，同一毫秒内（同事务写入）的行会在翻页边界被漏掉；`search` 在 PR #132 里改为 `date_trunc('milliseconds', …)` 作排序键，这两处未改 | P2 | 待排 | 开放 |

## 5. 更新规则

1. 会话开始：读本文；再读与本次任务相关的 `development-tasks.md` 小节与 runbook。
2. 波次合入、主机验收、发版之后：更新 §2 状态与证据、§3 进度、§4 增删；同一 PR 或紧随的
   docs PR 完成。
3. 关闭遗留的 PR 必须同时把 §4 对应行改为"关闭 + PR 号"。
4. 不写主机别名、IP、路径、密钥、外部系统 ID（公开仓库）；主机应用细节记在 gitignored 的
   `docs/private/`。
5. 评估、反思、复审写独立文档（`retrospective-*.md` / `code-review-*.md`）并在 §1 登记；本文只链接。
6. 每次复审或阶段收口，在 §2.1 时间线追加一行（只追加，不覆盖历史），并把新发现按级别加进 §4。
7. §2 的「达成」以验收脚本为准；发现验收未覆盖的缺陷时，不改里程碑状态，在 §2.2 记下盲区、在 §4 立项。
