# 阶段回顾（2026-09-09）：S3 收口、v0.3.0、设计反思

> 本文是 E / R / S1 / S2 / S3 五个里程碑走完后的回顾：进展、遗留、后续排期、以及整个过程里
> 暴露出来的"设计上不是最优"的点。它不是设计文档（设计见
> `graph-ai-middle-platform-design.md`），也不是任务清单（任务见 `development-tasks.md`）；
> 它记录的是**评估与决定**。凡是"建议"都是提议，未落地的不当作现状。

## 1. 背景与目标

- 2026-09-01 设计文档定稿（`graph-ai-middle-platform-design.md`、`design-review-2026-09-01.md`）。
- 2026-09-04 代码复审（`code-review-2026-09-04.md`），列出七项整改与遗留。
- 2026-09-08 七项整改全部合入并在目标主机验证；同日排定 S3 实施波次（`development-tasks.md`
  "S3 实施波次"）。
- 2026-09-09 S3 波次 W1–W4 全部合入，目标主机 `accept_s3.sh` 通过；release-please 发布
  v0.2.0、v0.3.0。

三条设计底线在整个过程中没有被突破过：agent / kernel 进程不持凭证；触及有凭证、内部或有状态
系统的动作必经审批；隔离与审计只增不减。

## 2. 进展

### 2.1 里程碑与数字

| 项 | 状态 |
|---|---|
| E 目标主机可跑全部服务 | 达成 |
| R monorepo lint / test / build / migrate | 达成 |
| S1 登录 → 对话 → 自己的 pi 回答 → Turn 入图 | 达成，`accept_s1.sh` 22 PASS + 1 SKIP（由单测覆盖） |
| S2 说需求 → find_workers → invoke_worker → 门动作 → 审批 → 执行 → 写回 | 达成，`accept_s2.sh` 66 PASS |
| S3 本体 v1 + 采集器 + Explorer + MCP gateway | 达成，`accept_s3.sh` 24 PASS |

| 指标 | 数值（2026-09-09） |
|---|---|
| main 提交数 | 474 |
| 近 6 天合入 PR | 60 |
| 发布 | v0.2.0、v0.3.0 |
| capability 结果契约 | 96 个 `resultSchema`，契约快照 + 词表守卫 |

### 2.2 S3 交付物

- 本体注册表与 `ops-assets` v1 / v2 领域包；`get_type / list_types / validate /
  propose_ontology_change / publish_ontology_version`。
- 冲突检测与 epistemic 七能力（`list_conflicts / resolve_conflict / verify_fact /
  query_decisions / causal_chain / decision_impact / find_precedents`）；同源同内容再断言为
  幂等 no-op（`factContentEquals`）。
- `collectors/host-inventory` 采集器：目标主机一跑 480 对象 / 173 事实，二跑 0 断言 0 覆盖
  0 冲突；经只读 socket 代理读 Docker，服务 Handle 由 `issue-service-handle` 签发。
- `gatekeeper-ragflow` v2；Explorer 九端点契约与真实 Semantica 包（caddy 构建期打包）；
  MCP gateway（Handle-only、`issue_handle`、`interactive` 模式）。
- 语义一致性：`docs/wire-contract-conventions.md`、`docs/contracts/*.json` 快照、
  `scripts/guards/vocabulary.mjs`、测试与 CI 下 `KERNEL_VALIDATE_RESULTS=1`。
- 不变量监控、`/internal/metrics`、混沌脚本；运行手册（`docs/runbooks/`）与演练脚本
  （`drill-restore.sh`、`drill-add-gatekeeper.sh`）；`create_task`（仅创建，见 §3）。

### 2.3 控制面（S3.11–S3.15）

- 成员管理 13 个 capability（`members` 组，全部 `channel:'human'`，CI 守卫保证不进任何 Handle
  scope）；治理区页面：成员、授权、审计、模型、目录、系统接入向导、审批队列。
- AgentProfile / AgentPolicy：内核四能力 + 六处运行时投影（模型、门、Skill、提示词附加、
  autoApproveLow、变更传播）+「我的智能体」页；Profile 只收窄不扩权。
- pi 解耦：`docs/runbooks/pi-upgrade.md`、版本一致性守卫、`pi-drift.yml` 夜间漂移检测。

### 2.4 加固与自动化

- 加固：三套 `docker-socket-proxy`（supervisor / docker 门 / 采集器各一）取代 socket 挂载；
  备份容器 root + `cap_drop ALL` + 仅 `DAC_READ_SEARCH`；egress 按 Docker 事件反注册；
  WorkerDefinition 级 egress 拒绝表；Worker 以 agent principal 断言 Fact；Operation 分类
  propose → publish 版本化；`pruneDispatched` 已调度。
- 自动化：CI（guards / quality / test）+ web e2e + CodeQL + Scorecard + Trivy +
  release-please + Renovate + auto-merge + PR 标题守卫；main 分支保护三门必过。
- 决定：bot PR（release-please）的 workflow 运行暂维持人工批准，不引入 GitHub App token；
  暂不构建 / 发布容器镜像到 GitHub，等真实验证稳定后再做。

## 3. 遗留

按影响排序。

| # | 项 | 影响 | 归属 |
|---|---|---|---|
| 1 | `explain` 对 collector 断言的 Fact 返回该 ingest Activity 的全部 Observation（数百条，>400KB） | 溯源不可用于批量数据；见 §5.1 | 内核 epistemic |
| 2 | `search` 硬上限 50、无 `limit` / `cursor`，信封里 `nextCursor` 恒空 | 480 对象的工作区已会漏结果 | 内核 graph 读 |
| 3 | `create_task` 建的 Task 永远停在 `queued`，无 spawner | 能力存在但不做事 | 内核 task |
| 4 | fake-llm 自检两个预存失败（`entry-restart-chat-turn2/3`） | 自检信号被噪声淹没 | deploy/accept-s2 |
| 5 | Renovate 首跑未见（无 PR、无 Dependency Dashboard） | 依赖更新链路未验证 | 自动化 |
| 6 | E7 主机备份定时器"S3 后重评"到期 | 备份只在 compose 内 | 运维 |
| 7 | `extension_ui_request` 子协议无任务承接；Trigger、CLI help 清单解析仍在 P5 | 功能缺口 | 规划 |
| 8 | CHANGELOG 出现重复条目（merge commit 正文带原标题，release-please 各算一条） | 发布说明噪声 | 流程 |

## 4. 后续排期

| 波次 | 时间 | 内容 | 完成标准 |
|---|---|---|---|
| W5 收口 | 1–2 天 | `explain` 收敛到喂给该 Fact 的 Observation + `search` 分页（同一 PR）；`create_task` 接现有 spawn 路径或先下架；修 fake-llm 两个失败；单 commit PR 改 squash；确认 Renovate 首跑；E7 决定 | 遗留 1–6、8 关闭 |
| W6 验收工具链治理 | 本周 | 四份 heredoc driver 抽成一份；fake provider 切换改为 compose override，不再改生产配置；至少 S1 精简版进 CI | `accept_s*.sh` 只做编排；CI 有一条 S1 通路 |
| W7 真实验证 | 下周 | 真实模型跑 S2 / S3 场景并统计工具调用成功率；Explorer 鉴权改为按调用者身份 | 有真实模型下的成功率数据；caddy 不再持有 Explorer key |
| 稳定期 | 两周 | 冻结新能力，真实使用，收集问题 | 问题清单 |
| 之后 | — | 容器镜像发布；P5（Trigger、`extension_ui_request`、CLI 清单解析） | 另行排定 |

## 5. 设计上不是最优的点

按严重程度排，每条都有本轮实证；"建议"是提议，不是现状。

### 5.1 溯源粒度停在 Activity 级

- **现状**：Fact 只持 `activity_id`；`explain` 走 Fact → Activity → 该 Activity 的全部
  Observation。Observation 与 Fact 之间没有直接关系。
- **实证**：采集器三个阶段共用一个 Activity，一次 ingest 数百条 Observation；`explain` 一条
  `depends_on` Fact 返回整批 Observation，响应体超过 400KB。
- **判断**：这是 provenance 模型缺口，不只是性能问题。批量 ingest 下溯源只能回答"这批采集"，
  答不出"哪条观察"。
- **建议**：加 Fact → Observation 的显式关系（`fact_observations` 或 Fact 上记 `observation_id`），
  `explain` 按它取；Activity 级仍保留为上下文。

### 5.2 验收 harness 违反"全 TS"约定

- **现状**：`accept_s1 / s2 / s3.sh` 与 `drill-add-gatekeeper.sh` 各嵌一份 heredoc JS driver，
  四份几乎相同。
- **实证**：driver 在容器内 `process.exit()` 前不 flush stdout，大响应体丢尾行；修复要同时改
  四处。fake-llm 场景漏改 `search` 参数也是同类问题。
- **建议**：driver 抽成一个包（`deploy/accept/driver.mjs` 或 TS），脚本只做编排；场景与
  夹具进同一包并有自检。

### 5.3 验收会改生产配置

- **现状**：每次 S1 / S2 / S3 覆盖 `llm-providers.yaml`、重生成 `models.json`、重启 llm-proxy，
  结束再还原。
- **实证**：脚本中途失败即留在 fake provider 上，需人工还原。
- **建议**：fake provider 用独立 compose override / profile 挂不同配置目录；或内核支持
  workspace 级 provider 覆盖，验收工作区自带 provider。

### 5.4 fake-llm 场景是硬编码调用序列

- **现状**：`deploy/fake-llm/server.mjs` 以 if / else 状态机写死每轮工具调用与参数。
- **实证**：`search` 少一个必填字段，agent 侧 400 后走兜底文案，自检没抓到，直到主机验收
  才暴露。
- **建议**：场景参数对注册表 `paramsSchema` 校验（fake-llm 或 selftest 任一侧），契约漂移在
  自检里失败。

### 5.5 查询能力分页语义不一致

- **现状**：`list_*` 有 cursor；`search` 无 `limit` / `cursor`，命名也不在 `list_* / find_*`
  词表里（代码注释已承认）。
- **建议**：`search` 补 `limit` / `cursor`，与信封约定对齐；或改名进词表。

### 5.6 `create_task` 让无效状态可表示

- **现状**：能力已注册，Task 进 `queued` 后没有消费者。
- **判断**：违反"无效状态不可表示"的设计底线：`queued` 成了永久态。
- **建议**：接 `invoke_worker` 已有的 spawn 路径；接不上就先不注册该能力。

### 5.7 领域包烤进 kernel 镜像

- **现状**：`ontology/*.yaml` 随 kernel 镜像分发，`seed-domain-pack` 从镜像内读。
- **实证**：换 v2 必须重建 kernel。
- **建议**：领域包是数据不是代码；从数据目录挂载，或经 `publish_ontology_version` 上传。

### 5.8 Explorer 鉴权由 caddy 注入 key

- **现状**：caddy 为 `/explorer` 注入 `EXPLORER_API_KEY`，局域网内任何人都是 auditor；
  与 API key / Handle 并列成三套鉴权面（已在 `docs/runbooks/host-explorer.md` 记为信任边界）。
- **建议**：统一到调用者身份（浏览器登录态或 auditor principal 自己的 key），caddy 不持密钥。

### 5.9 采集器 Source 状态按文件路径缓存

- **现状**：`sourceId` 缓存在状态文件，与 workspace 无关；换 workspace 必须手动重置（验收
  脚本因此多一步）。
- **建议**：Source 身份由 (workspace, kind, name) 幂等派生，`register_source` 做 upsert，
  不需要本地状态文件。

### 5.10 容器运行时访问面分散

- **现状**：三个 socket 代理实例、三个网络，各自 allowlist。
- **判断**：隔离到位，但运维复杂度上升；每个新消费者都要再加一套。
- **建议**：长期收敛成内核侧一个只暴露 spawn / stop / restart 领域动作的运行时服务，不暴露
  Engine API。

### 5.11 备份走 root + capability

- **现状**：备份容器 root + 仅 `DAC_READ_SEARCH`，因各服务数据目录 uid 不一致。
- **建议**：统一数据目录 gid 并让备份用户入组，或改为 Postgres 逻辑备份 + 文件级归档；
  现方案可用，记为债。

### 5.12 清理靠名字正则

- **现状**：验收工作区用 `^accept-s3` 这类名字约定清理。
- **建议**：workspace 增加 `purpose`（如 `ephemeral`）或 TTL 属性，按属性清理。

### 5.13 做对了的地方

- 注册表 + 契约快照 + 词表守卫确实拦住了漂移（19 个"已注册未实现"的 capability 被逐个核清）。
- agent principal 与 propose → publish 版本化让 provenance 与授权语义变实，不再靠标记位降级。
- 主机验收脚本是本轮发现真问题最多的环节：幂等再断言、explain 溯源、egress fail-closed 都是
  它先暴露的。

## 6. 进度跟踪现状与建议

**现状**：仓库没有专用的进度跟踪文件。进度散在四处：

| 位置 | 记录什么 |
|---|---|
| `docs/development-tasks.md` | 任务拆解、波次表、每个任务的"实现说明"（合入后追加） |
| `docs/code-review-2026-09-04.md` §7 | 复审遗留与其关闭状态 |
| `CHANGELOG.md` | release-please 按 Conventional Commits 自动生成 |
| `docs/private/`（不入库） | 目标主机应用与验收记录 |

**建议**：加一个 `docs/STATUS.md` 作为唯一的"现在到哪了"入口，只放三块：里程碑状态表、
当前波次与负责范围、遗留清单（每条链接到任务或 PR）。每次合入波次更新它一次；
`development-tasks.md` 继续放拆解与实现说明，`code-review-*.md` / `retrospective-*.md`
放评估。是否建立由维护者决定，本文不代为创建。
