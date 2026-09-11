# STATUS — 项目入口与进度（唯一真相）

> 这是"现在到哪了"的唯一入口。任何会话、任何阶段开始先读这里；波次合入、主机验收、发版
> 之后在同一 PR 或紧随的 docs PR 里更新这里。它只放三块内容：里程碑状态（含时间线与验收边界）、当前波次、遗留清单。
> 拆解与实现说明在 `development-tasks.md`，评估在 `retrospective-*.md` / `code-review-*.md`，
> 本文只链接不复制。与代码冲突时以代码为准，并修正本文。

最后更新：2026-09-11（W7 真实模型验证 + Explorer 按调用者鉴权完成并发 v0.5.0；当前波次：两周稳定期）

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
| S1 | 登录 → 对话 → 自己的 pi 回答 → Turn 入图 | 达成 | `accept_s1.sh` 22 PASS + 1 SKIP（2026-09-10，v0.4.2） |
| S2 | 说需求 → find_workers → invoke_worker → 门动作 → 审批 → 执行 → 写回 | 达成 | `accept_s2.sh` 66 PASS（2026-09-10，v0.4.2） |
| S3 | 本体 v1 + 采集器 + Explorer + MCP gateway | 达成 | `accept_s3.sh` 29 PASS（2026-09-11，新增 explorer-no-credentials 断言，PR #153，从分支在主机验证） |
| S3.11–S3.15 | 控制面、接入向导、AgentProfile、web 控制台、pi 漂移 | 达成 | `development-tasks.md` 各节实现说明 |
| 真实模型验证 | 真实模型跑 S2 / S3 场景，统计工具调用成功率 | 达成 | docker_restart 2/3、api_observe 3/3、ssh_run_approve 3/3、ssh_run_auto 1/1、dependency_chat 2/3（`retrospective-2026-09-11.md` §2） |
| 发布 | — | v0.5.0（PR #154） | `CHANGELOG.md` |

> S1–S3 的「达成」以各自验收脚本为准。2026-09-10 复审曾发现 S3.2 的冲突检测在 Worker 断言主路径上不生效
> （`code-review-2026-09-10.md` §2.1），当时验收对 Conflict 的唯一断言是「采集器跑两遍后为零」，压制 Conflict 的缺陷
> 无论存在与否都表现为通过。该缺陷已按 §4 第 16 项修复（PR #137），`accept_s3.sh` 加了异源 Conflict 正向断言
> （PR #136）并于 2026-09-10 在主机通过。
>
> v0.5.0 已于 2026-09-11 在主机应用（无新迁移，全部镜像重建）：S1 22 PASS + 1 SKIP、S2 66 PASS、S3 29 PASS。

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
| 2026-09-10 | W5.5：P1 三项关闭（#137 Worker run 作为自己的 Source、#140 并发首次断言加锁、#138 入口 ceiling 按角色收窄），`accept_s3.sh` 加异源 Conflict 正向断言（#136）；发布 v0.4.1（PR #139）。复审新增遗留 24、25 | `CHANGELOG.md`、本文 §4 |
| 2026-09-10 | 产品决定：Worker 结果 Fact 默认工作区可见、转录另作私有 Source（#142），发布 v0.4.2（PR #143）。主机应用 v0.4.2（迁移 0018）并复跑三份验收：S1 22 PASS + 1 SKIP、S2 66 PASS、S3 28 PASS（Conflict 正向断言首次在主机通过）；发现 S2 cleanup 会把基础栈一起停掉（遗留 26） | `docs/private/` §34、本文 §2 |
| 2026-09-10 | W6 验收工具链治理：四份 heredoc driver 抽成 `deploy/accept/driver.mjs` + `scripts/lib/accept-common.sh`（#145，14 例 vitest）；fake provider 改 compose override，验收不再改生产配置（#146）；`accept_s1.sh --lite` 进 e2e 工作流（#148，CI 首跑 13 PASS + 6 SKIP）；fake-llm 场景参数按注册表 paramsSchema 校验（#149）；发布 v0.4.3（PR #147）。每个脚本 PR 都先在主机从分支连跑 S1→S2→S3 验证 | `CHANGELOG.md`、本文 §3 |
| 2026-09-11 | W7 开发：e2e 全量进 CI（#151）；Explorer 按调用者鉴权、caddy 不再持有 key（#153，遗留 8 关闭）；工具调用 `isError` 全链路 + driver 计数（#155）；真实模型验证模式 `--real`（#156）；顺带修复 grants 作用域比对（#152）与采集器 `depends_on` 解析（#157） | `retrospective-2026-09-11.md`、`CHANGELOG.md` |
| 2026-09-11 | 主机应用 v0.5.0：删除主机 `.env` 的 `EXPLORER_API_KEY`，全部镜像重建，无新迁移；首轮 S1 首次对话被入口容器冷启动打断（遗留 29）、S2 夹具镜像拉包超时（网络），重跑后 S1 22 PASS + 1 SKIP、S2 66 PASS，S3 首轮即 29 PASS；栈回到停栈状态 | `docs/private/` §39 |

### 2.2 验收证明了什么，没证明什么

三份验收脚本证明的是**内核 / 门 / 扩展这一侧的链路成立**。两处已知盲区，排期时按此判断，不要把
「验收通过」读成「功能可用」：

- **真实模型的路径现在存在了**（`--real <provider/model> [--runs N]`，PR #156）。W7 主机上用
  真实模型各场景跑 3 次，证明了「模型自己选对工具」在 docker_restart 2/3、api_observe 3/3、
  ssh_run_approve 3/3、ssh_run_auto 1/1、dependency_chat 2/3 上成立，且失败都不是选错工具
  （`retrospective-2026-09-11.md` §2）。盲区：每场景只跑 3 次、只用了一个真实供应商和一个模型，
  样本量和覆盖面都远不足以下"稳定可用"的结论。
- **对 Conflict 的唯一断言是「采集器跑两遍后为零」**，因此任何**压制** Conflict 的缺陷，
  存在与否验收都表现为通过（§4 第 16 项即属此类）。缺一条「异源矛盾断言 → 恰好一个 open Conflict」
  的正向用例。**PR #136**：`accept_s3.sh` 已加入 `collector_conflict_positive_step`，把这条正向用例
  接了进脚本（`docs/runbooks/host-accept-s3.md` §3/§4）；本条盲区在代码层面已补，但 §2 表格 S3 那行
  的验收证据仍是主机跑通新脚本之前的旧结果，未随此 PR 更新——里程碑状态与证据在下次主机验收前不改。
- **CI e2e 现在跑全部 Playwright 用例**（#151，含审批场景与 Explorer 会话，审批场景在 CI 里播种），
  加上 `accept_s1.sh --lite`；但 S2 / S3 全链路与真实模型跑的场景仍只在主机验收，发版与主机验收
  之间的空窗依旧存在（主机检出在 main（含 v0.4.3），仅 supervisor 镜像是从 #146 分支重建的，内容与合入提交相同）

## 3. 当前波次

**W5 收口：完成**（2026-09-10，一天）。六项里五项关闭（PR #128 文档漂移、#129 fake-llm 自检、#131 `create_task` 下架、#132 `explain` 收敛 + `search` 分页、仓库设置只留 squash、Renovate 决定暂不装），E7 仍待决定；各项细节见 §4 第 1–6 项与 `development-tasks.md` 的 W5 实现说明。复审新发现一条（§4 第 23 项：`query_decisions` / `list_conflicts` 的 cursor 精度）。

**W5.5 P1 修复：完成**（2026-09-10，与 W5 同日）。三项各有正向用例并在 CI 的真 Postgres 上通过（#137 / #140 / #138），`accept_s3.sh` 的异源 Conflict 正向断言已加（#136，待主机复跑）。分工：核心代码与迁移由主会话写，测试 / 文档由 builder 子代理写，每个 PR 经 reviewer 子代理复查；两次复查各抓到真问题并已在合入前修正（16 的可见性副作用与跨用户佐证、18 的缓存吊销与 mcp_session Handle）。

**W6 验收工具链治理：完成**（2026-09-10；范围与完成标准见 `retrospective-2026-09-09.md` §4，四项全部达成：脚本里不再有 JS、CI 有一条 S1 通路、验收不碰 `${NEXTTIME_DATA}/config`、S1→S2→S3 可在主机连跑）

| 项 | 范围 | 状态 |
|---|---|---|
| 四份 heredoc driver 抽成一份 | `deploy/accept/driver.mjs` + `scripts/lib/accept-common.sh`，四份脚本只做编排 | 完成（PR #145；driver 有 14 例 vitest；主机从分支连跑 S1 22 / S2 66 / S3 28 全过） |
| fake provider 切换改为 compose override，不再改生产 provider 配置 | `deploy/accept/docker-compose.fake.yml`、`accept_provider_up/restore`、worker-supervisor `MODELS_JSON_HOST_PATH` | 完成（PR #146；主机从分支连跑 S1 22 / S2 66 / S3 28 全过，生产 `llm-providers.yaml` / `models.json` 前后校验和不变） |
| 至少 S1 精简版进 CI | `scripts/accept_s1.sh --lite` + `.github/workflows/e2e.yml` 末尾一步（复用已起的 postgres/kernel/caddy + fake agent runtime） | 完成（PR #148；CI 首跑 13 PASS + 6 SKIP，跳过的是需要入口容器的步骤） |
| fake-llm 场景参数按注册表校验 | `deploy/accept-s2/fake-llm-scenario-selftest.mjs` 读 `docs/contracts/capabilities.json` | 完成（PR #149；含两条验证器自检） |

**W7 真实模型验证 + Explorer 按调用者鉴权：完成**（2026-09-11；范围见 `retrospective-2026-09-09.md` §4，评估与数字见 `retrospective-2026-09-11.md`）

| 项 | 范围 | 状态 |
|---|---|---|
| e2e 全量进 CI | 三个 Playwright 套件都跑，审批场景在 CI 里播种、允许一次重试，报告总是上传 | 完成（PR #151） |
| Explorer 按调用者身份鉴权 | 内核签发同源会话 cookie，caddy 不再持有 key | 完成（PR #153；遗留 8 关闭；主机从分支验证，curl 全流程 + S3 29 PASS） |
| 工具调用结果可观测 | `isError` 全链路 + driver 的 `TOOL_*` 计数 + transcript-stats | 完成（PR #155） |
| 真实模型验证模式 | `--real <provider/model> [--runs N]` | 完成（PR #156；主机验证，数字见 `retrospective-2026-09-11.md` §2） |
| 顺带修复 | grants 作用域按文本比对（#152）；采集器 `depends_on` 条件后缀（#157），均由真实模型或 CI 首次发现 | 完成 |

**当前波次：两周稳定期**（冻结新能力，真实使用，收集问题；优先看遗留 27/29/30）。运维决定项（E7 备份定时器，§4 第 6 项）按维护者意见排在所有开发波次之后。

**产品决定已做**（2026-09-10，PR #142）：Worker 经结果契约写回的 Fact 默认全工作区可见，会话 JSONL 转录另作 `private` Source 挂在自己的 `worker_session` Activity 上，不再牵连结果 Fact 的可见性。此前带转录的运行其 Fact 只对派发人可见，是实现细节而非产品规则（`development-tasks.md` S2.9 实现说明）。由 CI 的 Postgres 集成测试覆盖，三份验收脚本不断言可见性（加断言属 W6 范围）。

目标主机：2026-09-11 已应用 v0.5.0（S1 22+1 / S2 66 / S3 29），主机 `.env` 不再含 Explorer key；验收后回到停栈状态（仅 llm-proxy 与 fake-llm 在跑）。

后续：两周稳定期 → 镜像发布与 P5。

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
| 6 | E7 主机备份定时器"S3 后重评" | — | 运维，最后 | 待决定（2026-09-10 维护者：运维项排在开发波次之后） |
| 7 | 验收 harness：四份 heredoc driver、验收改生产 provider 配置、fake-llm 硬编码场景（§5.2–5.4） | P2 | W6 | 关闭（W6：#145 driver 抽成一份、#146 provider 改 compose override、#148 S1 精简版进 CI、#149 场景参数按注册表校验） |
| 8 | Explorer 由 caddy 注入 key 的信任边界（§5.8） | P2 | W7 | 关闭（PR #153：改为按调用者身份的内核签发会话 cookie，caddy 不再持有 key） |
| 9 | 领域包烤进 kernel 镜像（§5.7）；采集器 Source 状态按文件缓存（§5.9） | P3 | 待排 | 开放 |
| 10 | `extension_ui_request` 子协议；Trigger；CLI help 清单解析 | 功能缺口 | P5 | 开放 |
| 11 | 容器运行时访问面收敛（§5.10）；备份 root + capability（§5.11）；清理靠名字正则（§5.12） | P2 | 长期 | 记债 |
| 12 | bot PR 的 CI 需人工批准 run（决定：暂维持人工） | — | 决定 | 关闭 |
| 13 | 容器镜像不发布到 GitHub（决定：稳定后再做） | — | 决定 | 关闭 |
| 14 | 主机验收记录断档：09-09 的 S3 验收与 v0.2.0 / v0.3.0 发版都没有 `docs/private/` 记录（主机上也没有该目录），最新一份记录停在 09-04；§2 的 22 / 66 / 24 目前只有 retrospective 与 PR 正文为据 | P2 | W5 / 流程 | 关闭（2026-09-10：v0.4.2 主机应用与三份验收记录写入 `docs/private/` §34，§2 的 22 / 66 / 28 有据） |
| 15 | 入库文档与代码状态漂移：`README.md` 仍称「设计阶段（v0.2）…仓库只有文档，尚无可运行组件」；设计文档头部仍写「全部为提案…尚无任何组件实现」、§7.6 仍写「当前实现只有『工作』区」、§9.3 把 task 组标 `propose / observe` 而注册表里 `create_task` / `cancel_task` 均为 `write`；`development-tasks.md` 的 S3.6 一节没有完成标记，而其代码与验收都已落地 | P3 | docs PR | 关闭（PR #128：README 重写、设计文档头部 / §7.6 / §9.3 修正、S3.6 完成标记） |
| 16 | **Worker 断言的 Fact 永远按 principal 判定来源**：`postWorkerResult` 先断言后记 Observation，`resolveFactOrigin` 因此拿不到 Source；叠加 agent principal 每 WorkerDefinition 一个，同一定义两次运行的矛盾断言被静默 supersede 而非开 Conflict —— S3.2 的核心场景（`code-review-2026-09-10.md` §2.1） | **P1** | W5.5 | 关闭（PR #137：`postWorkerResult` 先注册私有 `worker_session` Source/Observation 再断言，`assertFact` 异源同内容视为佐证、异源异内容开 Conflict，见 `development-tasks.md` S2.9 W5.5 实现说明） |
| 17 | 并发首次断言同一身份不开 Conflict：`FOR UPDATE` 锁不住不存在的行，`links` 上也无 `(link_type, source, target)` 唯一约束（`code-review-2026-09-10.md` §2.2） | **P1** | W5.5 | 关闭（PR #140：`assertFact` 在无既有 Fact 时按身份取事务级 advisory lock 并重读，`substrate/epistemic/conflicts.test.ts` 加两条并发正向用例） |
| 18 | Handle 通道不校验 `minRole`，`member` 的入口 Handle 结构性携带 5 个 `minRole:'builder'` 的 `propose_*` 并可调用；不构成越权发布（草稿私有 + I16），但 `minRole` 在该通道事实失效（`code-review-2026-09-10.md` §2.3；代码已自认并写明修法） | **P1** | W5.5 | 关闭（PR #138：`entryScope({role})` 按 on_behalf_of 角色收窄入口 Handle 的 ceiling，`roleSatisfiesMinRole` 下沉到 `governance/capability`，`set_principal_role` 变更角色时吊销入口会话 Handle） |
| 19 | `llm-proxy` 无任何预算代码，设计 §5.4 I18 的「100% 时代理返回预算耗尽错误」未实现，超支只能由内核事后止损（`code-review-2026-09-10.md` §3.1） | P2 | 待排 | 开放 |
| 20 | 两个门容器与 caddy / postgres 无 `read_only` / `cap_drop:[ALL]` / `no-new-privileges`，其余服务均有；门是唯一持外部凭证的进程（`code-review-2026-09-10.md` §3.3） | P2 | 待排 | 开放 |
| 21 | 控制台看不到审批历史：注册表只有 `list_pending` 与 `get_action`，无列出已决 ActionRequest 的能力（`code-review-2026-09-10.md` §3.4） | P2 | 待排 | 开放 |
| 22 | 出网拒绝表在 `reconcile()` 后回退到容器创建时的旧值：标签只在创建时打，复用分支刷新 source map 却回写不了标签，而 `reconcile()` 每次 docker-events 重连都跑；与 `EGRESS_DENY_LABEL` 自称的「永不放宽，哪怕暂时」冲突（`code-review-2026-09-10.md` §3.5；平台级拒绝不受影响） | P2 | 待排 | 开放 |
| 23 | `query_decisions` / `list_conflicts` 的 keyset cursor 与 `search` 修复前同一模式：`created_at` 经 JS `Date` 只剩毫秒，回传后与微秒精度的列做 `<` 比较，同一毫秒内（同事务写入）的行会在翻页边界被漏掉；`search` 在 PR #132 里改为 `date_trunc('milliseconds', …)` 作排序键，这两处未改 | P2 | 待排 | 开放 |
| 24 | `find_active_fact_for_identity`（0017）的 `for update` 在被阻塞期间若持锁方 supersede 了该行，重查按 `superseded_at is null` 过滤后返回 0 行而非后继行；PR 17 的 advisory lock + 重读封住了两事务形态，三事务交错（第二个等锁者的重读又阻塞在第三个事务的 supersede 上）仍可能插入一条多余的活跃 Fact。0017 既有机制的局限，复审 17 时发现 | P3 | 待排 | 开放 |
| 25 | CI 偶发：`interfaces/ws/server.test.ts` 的 WS 端到端用例在 PR #140 首跑时 5 秒超时，重跑通过（其余 1100 用例均过）；疑为 runner 争用，若复现需给该用例单独 `testTimeout` 或查 listener 启动时序 | P3 | 待排 | 开放 |
| 26 | `accept_s2.sh` 的 cleanup 对 accept-s2 profile 做 `down` 时连基础栈一起停掉，S1→S2→S3 无法一次连跑；应改为只 `rm -sf` 五个夹具服务，或由统一 driver 在 S3 前重新拉起（2026-09-10 主机实测） | P2 | W6 | 关闭（PR #145：cleanup 改为只 `rm -sf` 六个夹具容器，主机 S1→S2→S3 连跑通过） |
| 27 | outbox dispatcher 构造时未传 `onError`，消费者异常被静默吞掉（#152 的根因之所以晚发现） | P2 | 待排 | 开放 |
| 28 | 已有图里 `depends_on` 指向的幻影 Container（`<service>:service_healthy:false`）要等采集器下一轮 supersede；旧对象留作历史 | P3 | 稳定期 | 开放 |
| 29 | 真实模型下新工作区首轮 Turn `interrupted`、0 次工具调用（入口容器冷启动 / Handle 就绪竞态，S3 real 1/3 的失败） | P2 | 稳定期 | 开放 |
| 30 | 真实模型下 docker_restart 一次 ActionRequest executed、容器已重启但 Task failed 且 result 为空（S2 real 1/3 的失败） | P2 | 稳定期 | 开放 |
| 31 | Explorer 会话 cookie 不随 `rotate_api_key` 失效（8 小时 TTL 为界；`disable_principal` 即时生效） | P3 | 记债 | 开放 |
| 32 | CodeQL 预存告警：`hashApiKey` 用 sha256（32 字节随机 key，判定为合理）需维护者 dismiss；`e2e / web-e2e` 需维护者加为必需检查 | — | 决定 | 待维护者 |
| 33 | 入口容器的 pi 会话跨 chat 延续（真实模型第三轮回复"这已经是你第三次问同一个问题"）——是否应按 chat 隔离上下文是产品问题 | P3 | 待决定 | 开放 |

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
