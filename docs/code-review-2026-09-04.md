# 全项目代码复审（2026-09-04）与修复记录

> 公开版摘要。复审在 S2 主机验收（`scripts/accept_s2.sh` 第十五轮 **S2 OK**）之后进行，目标是在进入 S3 之前把 S1/S2 积累的安全、正确性与语义债一次性收口。主机地址、数据路径、密钥等运维细节不在本文件中（见私有运维记录）。

## 1. 范围与方法

- **范围**：仓库全部 11 个包与部署面——`kernel`（substrate / governance / application / interfaces 四层）、`platform-extension` + `agent-host` + `worker-supervisor`（Agent 运行时）、`gatekeeper-base` 与两个门实例、`llm-proxy` / `egress-proxy`、`docker-compose.yml` + `deploy/` + 脚本、`web`。
- **方法**：7 条并行复审通道（每条一个独立子代理），统一输出格式：P0/P1/P2/P3 分级 + 语义漂移清单 + "已核对无问题"清单；主会话合并去重后形成按 PR 切分的修复计划 F1–F10。修复由独立子代理在各自分支上完成，主会话只审真实 diff、合并、上主机验证。
- **分级口径**：P0 = 可越过治理边界或凭证边界；P1 = 破坏不变量 / 授权 / 可靠性；P2 = 加固与运维正确性；P3 = 错误映射、语义漂移、文档漂移。

## 2. 总体结论

- 三条底线（Agent/kernel 进程内无凭证；触及凭证化/内部/有状态系统必经审批；隔离与审计不降级）在架构上成立，但实现层有 **3 个 P0** 直接击穿边界，均已修复并在主机验证。
- P1/P2 集中在：授权收口（人类调用者绕过 Grant 检查、自批）、执行可靠性（幂等/超时/卡死状态）、数据层不变量只在代码不在数据库、运行时 fail-open 默认值、compose 服务权限过宽。
- 语义漂移是最大的一类技术债：同一概念在不同层用不同字段名/词表（见 §5），软件能跑但契约不稳定。

## 3. P0 及处置

| # | 问题 | 处置 |
|---|------|------|
| P0-A | ssh 传输：远端命令可以 `-o ProxyCommand=…` 形式被 OpenSSH 当作**客户端**选项在门进程内本地执行；模板参数未做词级隔离；策略表分类算完即丢弃（observe 级 Operation 可执行任意命令） | PR #69：`--` 终止选项解析、拒绝以 `-` 开头/多行命令、模板值 POSIX 单引号词化、分类结果强制校验（observe 只能跑 observe，爆炸半径不得高于声明） |
| P0-B | 内部面（kernel `/internal/*`、agent-host WS）无鉴权，workers 子网内任何容器可直接调用 | PR #73：共享 `internal_token` compose secret；kernel 校验 Bearer 并拒绝 workers 子网来源；agent-host / llm-proxy / egress-proxy / kernel→worker-supervisor 客户端全部携带（后者在 PR #78 补齐） |
| P0-C | `propose_operation` 可以对已发布 Operation 同名覆写并降级为草稿，绕过 I17 冻结 | PR #71：identity 冲突 409、`draft_of` 引用、`publish_manifest` 只发布导入草稿并给出 diff |

## 4. 修复计划 F1–F10 与落地状态

| 项 | 内容 | PR | 状态 |
|----|------|----|------|
| F1 内部面鉴权 | 见 P0-B | #73 | 已合并、主机已应用 |
| F2 元本体草稿隔离 | 见 P0-C | #71 | 已合并、主机已应用 |
| F3 授权收口 | 人类 `request_action` 查 Grant/minRole；`resource_scope` 写入；自批拒绝 + `requester_can_approve` 持久化（governance/0007）；Grant 变更即撤销入口会话；`set_auto_approved_action_kind` 范围检查 | #77 | 已合并、主机已应用（2026-09-08 批次） |
| F4 执行可靠性 | `request_action` 幂等键 + 超时对齐；`invoke_worker` 两阶段；Task 可从 waiting_approval 失败；stale-executing reaper（governance/0006 `executing_at`）；denied 留痕 | #72 | 已合并、主机已应用 |
| F5 聊天/联动可靠性 | outbox at-least-once + 持久去重（core/0009 `source_outbox_id`）；启动时中断遗留 running Turn；`stop_agent` 回退；`/ws` 拒绝 Handle 鉴权 | #74 | 已合并、主机已应用 |
| F6 运行时 | llm-proxy 按 provider `api` 类型的路径白名单（其余 404/405）；worker-supervisor `/task/spawn` `/resident/*` 共享密钥鉴权；`skills[].hostPath` 删除（kernel 早已改为内联内容）；常驻容器按 Handle jti 轮换；agent-host 同 principal turn 竞态；egress 未注册来源默认拒绝（`EGRESS_DENY_UNKNOWN_SOURCE`，fail-closed）；`NanoCpus`/`MemorySwap` 限额；入口模式 `invoke_worker` 强制 `wait:false` | #78 | 已合并、主机已应用（2026-09-08 批次） |
| F7 门协议 | 门共享 token（`gate_token` secret）；幂等键作用域 + 预占；redirect/MCP isError/OpenAPI `in`/ajv `$ref` 修正；ConnectedAccount 写队列；TLS 显式信任（`GATE_TLS_CA_FILE`/`GATE_TLS_SERVERNAME`，设了 `NODE_TLS_REJECT_UNAUTHORIZED=0` 拒绝启动） | #75 | 已合并、主机已应用 |
| F8 数据层 | Fact 可见性 RLS 谓词（core/0010，改为 `security definer` 函数以避免 RLS 嵌套盲区，core/0013）；`ontology_versions` 状态机触发器（core/0011）；`links` 生命周期回归触发器（core/0012）；子 Handle 继承触发器（governance/0008：`on_behalf_of` 必须等于会话与父 Handle，`expires_at` 不得超过父）；`CallerPrincipal.kind` 由 principals 派生（回归：Worker 写回的 Fact 因 `on_behalf_of` 是人类而变成 `asserted`，`accept_s2.sh` 第 7 步失败；跟进修复加 `CallerPrincipal.viaAgent`，只能降为 `inferred`、不能升格，Worker 结果契约路径置 true——**2026-09 后续 PR 用 (workspace, WorkerDefinition) 级真实 agent 类 principal 替换了这个降级标记，见下方 §7 更新**）；`TurnStarted` 只带 `chatMessageId` 不再带全文；outbox `attempts` 先提交再投递 + `maxAttempts` 死信 | #76 | 已合并、主机已应用（2026-09-08 批次） |
| F9 compose/运维 | 所有 `${NEXTTIME_DATA}`/子网/绑定地址改 `:?`（空值直接失败而非挂载宿主根或绑 0.0.0.0）；kernel healthcheck + `depends_on: service_healthy`；kernel/agent-host/worker-supervisor/llm-proxy/egress-proxy `read_only` + `cap_drop: ALL` + `no-new-privileges`；backup 容器挂载收窄到只读源 + 唯一可写 `backups/`，备份纳入 `caddy/`、排除 `store.key`；live restore 先停服务；CI action 全部钉 SHA；docker.sock `:ro` 注释改为如实描述（不是权限边界） | #76 | 同上 |
| F10 错误映射与漂移 | 未映射错误类 HTTP/WS 对齐（`HandleIssuanceError` → 400 / `INVALID_PARAMS`，`TaskRuntimeNotConfiguredError` → 503 / 新增 `SERVICE_UNAVAILABLE -32015`；TurnNotFound / NoActiveTurn 已在早前 PR 映射）；`chat.message` 全部生产者（用户推送、助手/工具推送、系统推送、历史行）统一带顶层 `kind` + `content` | #79 | 已合并；列表信封与 id 命名统一**需设计决定**，未纳入 |

复审期间顺手修掉、未列入 F 编号的：#55 入口模式 17 个能力工具 + `observe_operation`；#56 `request_action` 随门资源委派给 Worker；#60 `get_task` 归入 Worker 基础设施能力；#61 Postgres 22P02 → 400；#63 历史消息带 `content`；#65 ssh/cli 传输免凭证、simulate 失败不回滚请求；#66/#70 Caddy 内部 CA 叶子 90 天（含 `intermediate_lifetime`）；#67 ssh 主机密钥策略 + stderr 透出；#68 sshd 夹具账户解锁。

## 5. 语义漂移清单（登记，未全部处理）

以下在多条复审通道被独立指出，属于契约级技术债，处理需要一次设计决定而非局部修补：

- `idempotencyKey` 三种含义（请求去重键 / ActionRequest 业务键 / 门侧预占键）。
- `actionKind` 在不同层分别是裸字符串与 `{tag,label}`。
- `capability_grants.capability` 与能力注册表使用两套词表。
- `mode: propose` 标在若干即时写操作上（语义应为"提出待批"）。
- 返回体中 `id` / `taskId` / `actionRequestId` / `connectionRequestId` / 原始行混用；列表信封裸数组与 `{skills: [...]}` 并存。
- `chat.message` 三种生产者形状（F10 处理顶层 `kind`；其余待定）。

## 6. 验证

- 每个修复 PR：CI 三道门（`guards` 含 gitleaks / 内网字面量守卫、`quality` 含 typecheck/lint/depcruise/compose 校验、`test` 含 Postgres 集成测试）全绿后合并。
- 主机应用（2026-09-08 批次：#77 + #78 + #76）：迁移 core/0010–0013、governance/0007–0008；kernel、agent-host、worker-supervisor、llm-proxy、egress-proxy、worker-runtime 重建；加固后全部服务运行、kernel healthcheck 通过；门与 worker-supervisor 无 token 401 / 带 token 通过；备份容器在收窄挂载 + 只读根下一次性运行成功；`accept_s2.sh` 回归结果见私有记录。
- 数据层触发器上线前核对：现有 `capability_handles` 无子 Handle 过期晚于父的行；outbox 无未投递的 `TurnStarted`（其 payload 形状在本批次变化）。

## 7. 遗留与后续

- **需要设计决定**：§5 漂移清单的统一词表与信封；`invoke_worker` 的 kernel 侧超时窗口与 `wait` 语义对齐；~~WorkerRun / WorkerDefinition 的 agent 类 principal（让 `asserted_by` 指向真正的断言者、`on_behalf_of` 留在 Activity/Session，替代当前 `viaAgent` 降级标记）~~ **已实现**（`feat/agent-principals` 分支）：每 (workspace, WorkerDefinition) 一个 `kind='agent'` principal（`migrations/core/0014_worker_agent_principals.sql`，`application/task/agent-principal.ts` 的 `ensureWorkerAgentPrincipal` 幂等创建/复用），`worker_runs.agent_principal_id`（`migrations/task/0004_worker_run_agent_principal.sql`）在 spawn 时落定，`postWorkerResult` 用它做 Fact `asserted_by` 与 Activity `started_by`，人类 `on_behalf_of` principal 降级为 `activity.metadata.onBehalfOf` provenance（`explain()` 新增 `ExplainActivityRef.onBehalfOfPrincipal` 解析出来）；`CallerPrincipal.viaAgent`/`epistemicStatusForCaller` 已删除。提议（`proposedOperations`/`proposedSkill`）仍然 owned by 人类，不随 Fact 一起改（I16 私有草稿可见性）。
- **验收脚本随加固同步**（2026-09-08 回归四轮）：门探活要带 `gate_token`（#81）；egress 按来源 fail-closed 后第 6 步改为"未注册容器 403 + 已注册入口容器 200"（#82，curl 不读大写 `HTTP_PROXY`，探测显式 `-x`，#83）；第 7 步 Worker Fact `inferred` 回归见 F8 行。
- **加固（2026-09-08 收口状态，fix/gate-docker-socket-proxy 更新）**：agent-host / worker-supervisor 已改经 `docker-socket-proxy`（按实际调用面 allowlist：CONTAINERS/POST/NETWORKS/ALLOW_START/ALLOW_STOP）访问 Engine API，不再挂载 socket；`gatekeeper-docker` 不再直连 socket——已用第二个专用 proxy 实例 `docker-socket-proxy-gate`（独立 `dockerapi-gate` 网络，不与前一实例共享 allowlist）收口，按该门自己源码的实际调用面：CONTAINERS/POST/ALLOW_RESTARTS/ALLOW_START/ALLOW_STOP（`compose.up`/`compose.down` 会调 dockerode 的 `start()`/`stop()`，不是当初设想的"仅 CONTAINERS + ALLOW_RESTARTS"）。backup 容器：root + `cap_drop: [ALL]` + 仅 `DAC_READ_SEARCH`（非 root 方案实测 `cap_add` 不进 effective set，见 `docs/runbooks/backup-restore.md`）。WorkerDefinition 级 egress deny 列表**已接线**（⑤b，PR #97 `feat/egress-definition-lists`：`worker-definition.ts` 的 `EntryWorkerDefinitionContentSchema`/`WorkerWorkerDefinitionContentSchema` 均带 `egressDeny`，`application/task/spawn.ts` 转发进 WorkerRun 容器的 egress 源映射注册，见该文件 `egressDeny` 字段自己的注释）；基于 Docker 事件的 egress 反注册仍未做。
- **小项**：~~`OutboxDispatcher.pruneDispatched` 已实现未调度~~ **已调度**（PR #93 `fix/invoke-worker-wait-and-outbox-prune`：`packages/kernel/src/index.ts` 的 composition root 起一个定时 tick 调 `dispatcher.pruneDispatched(outboxPruneDays)`，`outboxPruneDays === 0` 是显式关闭选项，其余值——含编译期默认——都会跑）；DNS sinkhole 选项仅规格级测试；19 个已注册无 handler 的 capability——`docs/development-tasks.md` S3.7 落地时（feat/contract-guards，2026-09-08+）逐个核对 `packages/shared/src/capabilities.ts` 与 `packages/kernel/src/application/gateway/handlers.ts` 的 `CAPABILITY_HANDLERS`，此条"19 个"的计数与当前状态一致，具体名单：`get_type`、`list_types`、`validate`、`propose_ontology_change`、`publish_ontology_version`（ontology 组）、~~`causal_chain`、`decision_impact`、`find_precedents`、`list_conflicts`、`query_decisions`、`resolve_conflict`、`verify_fact`~~ **已实现**（S3.2 `feat/s3-2-conflicts-epistemic`：七个 handler 落在 `application/gateway/epistemic-handlers.ts`，注册进 `CAPABILITY_HANDLERS`；`resolve_conflict`/`verify_fact` 顺带把 `channel` 从占位的 `'handle'` 改成 `'human'`，见 `docs/development-tasks.md` S3.2 自己的实现说明）、~~`supersede_fact`、`invalidate_fact`（epistemic 组，`assert_fact` 例外——已挂 handler 但 handler 内部自己抛"未实现"）、`register_source`、`submit_observations`（ingest 组）~~ **已实现**（S3.3 `feat/s3-3-host-inventory`：`supersede_fact`/`invalidate_fact`/`assert_fact` 三个落在新 `application/gateway/fact-handlers.ts`——`assert_fact`/`supersede_fact` 的 `paramsSchema` 顺带从占位的 `{objectId,value,sourceId?}`/`{factId,value}` 换成真实的 `{sourceObjectId,targetObjectId,linkType,...}`，移除了 `AssertFactWriteNotImplementedError` 桩；`register_source`/`submit_observations` 落在新 `application/gateway/ingest-handlers.ts`，详见 `docs/development-tasks.md` S3.3 自己的实现说明）、~~`export_prov`（audit 组）~~ **已实现**（`docs/development-tasks.md` S3.5，`feat/s3-5-explorer`：`application/gateway/export-prov-handler.ts`，注册进 `CAPABILITY_HANDLERS`；`paramsSchema`/`resultSchema` 从占位的 `jsonRecord` 换成 `{factId|decisionId|activityId, depth?}` / `{format:'prov-json', document}`，见该任务自己的实现说明）、`create_task`（task 组，S2.7 的既有决定）、`issue_handle`（governance 组）——仍需清理或实现，本次未做（超出 S3.7/S3.3/S3.5 范围）。
