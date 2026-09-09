# Runbook：troubleshoot-task（排查一次失败的 Task）

对应任务：development-tasks.md § S3.10（"`docs/runbooks/`：排查一次失败的 Task（沿 `explain` 与
审计）"；S3 实施波次表 W1-E 行）。设计依据：`docs/graph-ai-middle-platform-design.md` §5.5（状态
机）、§12（可观测与审计）、§13（故障恢复）。

## 1. 目的

给一条排查路径：从"用户报告的一次失败"出发，沿 `get_task`/`list_pending`/审计/`explain`/
worker-supervisor 日志，定位到具体是哪一层出的问题——而不是逐个服务翻日志摸索。附常见根因表。

## 2. 前置条件

- 有能调用 capability 的凭证（owner/operator 的 API key，或知道该 Task 属于哪个 workspace 的
  operator 权限——`list_pending`/`get_action` 要求 `minRole: operator`）。
- 知道以下至少一项：Task id、WorkerRun id、ActionRequest id，或该用户/该 workspace 大概的时间窗口。

## 3. 诊断流程

```
用户报告"某件事没做成/一直卡着"
        │
        ▼
① 先定位是哪一层：这次交互产生过 Task 吗？
   - 有 taskId/workerRunId → 跳到 ③
   - 没有，只知道是"入口 agent 的哪句回复不对" → 见 §3.1（不一定是 Task 问题）
        │
        ▼
② 列出该用户最近的 Task（list_tasks，human 通道，member 可读自己的）
        │
        ▼
③ get_task{taskId} —— 看 status/failureReason，对照 §4 根因表
        │
        ├─ status = waiting_approval → 见 §3.2（审批链路）
        ├─ status = failed → 按 failureReason 查 §4 对应行
        ├─ status = running（但用户说"卡住了"） → 见 §3.3
        └─ status = completed（但结果不对） → 见 §3.4（explain 溯源）
```

### 3.1 没有 Task，只是入口 agent 的回复看起来不对

先确认这次交互本来就不该产生 Task——很多观察类操作（`observe_operation`、`<gate>.<op>` 的
observe 工具、`search`/`get_object`/`explain` 这些查询）从不创建 Task（design §8.4"手段发现"、
`docs/runbooks/host-accept-s2.md` step3 的验收句"observe-class gate tool call via chat never
creates a Task"）。确认方法：

```bash
# 该 workspace 最近是否真的新增过 Task/ActionRequest 行（时间窗口按实际情况调整）：
docker compose exec -T postgres psql -U nexttime -d nexttime -c \
  "select id, status, created_at from tasks where workspace_id = '<ws>' order by created_at desc limit 5;"
```
若确实没有新 Task，问题在入口 agent 的工具选择/回复文本本身，不是 Task 生命周期问题——查
`audit_records` 里这次对话前后的 capability 调用序列（§3.5）。

若用户的诉求是"应该拉起一个 Worker 但没有"，检查是不是在**创建 Task 之前**就被拒绝了——这类拒绝
从不落一行 `tasks`，只会作为一次 capability 调用的错误返回给调用方，`audit_records`
里查不到（这类拒绝目前不写审计——见 §6 已知缺口）：

| 症状 | HTTP 状态/`code` | 原因 |
|---|---|---|
| `invoke_worker` 直接报错，从不见 Task | `429 depth_exceeded` / `429 concurrency_exceeded` / `429 daily_cost_exceeded` | I18 配额检查——`application/task/invoke.ts` 在创建 Task 行之前就拒绝；owner 可调配额（`set_quota`） |
| 同上 | `403 attenuation_denied` | 入口 Handle 的能力天花板不含 `request_action`，或目标 WorkerDefinition 需要的门/Operation 超出了发起人当前的 Grant（`docs/runbooks/host-worker-runtime.md` §12.3 是这个错误的真实主机验收例子） |
| 同上 | `403 worker_definition_not_enabled` | 该 WorkerDefinition 不在发起人 AgentProfile 的 `enabledWorkerDefinitions` 里（S3.13——「我的智能体」页收窄了可用的 Worker 定义） |
| 同上 | `400 invalid_params` | 调用参数本身不满足 `InvokeWorkerRequestSchema`（比如 `definitionId` 不是已发布版本） |

### 3.2 卡在审批（`status = waiting_approval`）

```bash
# operator/owner 视角——这个 workspace 当前所有待审批：
curl -s https://<host>:8443/api/cap/list_pending \
  -H "Authorization: Bearer ${OPERATOR_KEY}" -H 'content-type: application/json' -d '{}'

# 已知 actionRequestId 时，直接读一条：
curl -s https://<host>:8443/api/cap/get_action \
  -H "Authorization: Bearer ${OPERATOR_KEY}" -H 'content-type: application/json' \
  -d '{"actionRequestId":"<id>"}'
```
Web 控制台等价路径："工作 → 待我审批"（`#/work/approvals`，任何 operator/owner）。

若 `list_pending` 里根本看不到这张卡片，但 `get_task` 显示 `waiting_approval`：先确认发起这次
`invoke_worker`/`request_action` 的门是否真的已经 `connect_gatekeeper` 授权给了正确的用户
（`docs/runbooks/add-gatekeeper.md` §7 第 5 步）；再确认卡片没有因为 S2.11 linkage 消费者的时序
问题只是"没有出现在对话里"但审批本身仍是真实待决——`docs/runbooks/host-accept-s2.md`"已知偏离"
最后一条记录过这种视觉层面的 SKIP，不代表治理链路本身有问题：直接用 `get_action` 核对
`status`/`policyDecision` 才是权威判断。

已过期（`expired`）的 ActionRequest：审批超时窗口内没有人决定，Task 会在下一轮通知入口 agent
（design §13"审批超时 → expired；卡片更新；入口 agent 下一轮得知"）——检查该 workspace 是否有
operator/owner 在及时处理审批队列，或该操作是否应该调整为 `auto_approvable`
（`docs/runbooks/add-gatekeeper.md` §6/§8）。

### 3.3 `status = running` 但看起来卡住了

```bash
# 1. 这个 Task 当前的 WorkerRun 状态与容器是否还在跑
psql "$DATABASE_URL" -c "select id, status, container_id, started_at from worker_runs where task_id = '<taskId>' order by started_at desc limit 1;"
docker inspect "nexttime-task-<workerRunId>" --format '{{.State.Status}}' 2>&1

# 2. 容器已经不存在了，但 Task/WorkerRun 还显示 running/provisioning
#    —— 等 worker-supervisor 的 reap 周期（TASK_REAP_INTERVAL_MS，默认 10s）或内核 reaper
#    （TASK_REAPER_INTERVAL_MS，默认 30s）赶上；若长时间不动，见 §6"已知缺口"
```
容器还在跑但长时间没有回应：容器内是 pi 进程本身卡住（模型请求悬挂/工具调用死循环）还是网络问题——
`docker compose exec -T worker-supervisor node -e "fetch('http://localhost:8081/task/<workerRunId>').then(r=>r.text()).then(console.log)"`
查 supervisor 自己记录的状态；`docker logs nexttime-task-<workerRunId>` 看 pi 的 RPC 输出（若容器
还没被 `docker rm`）。

### 3.4 `status = completed` 但结果内容不对——`explain` 溯源

```bash
curl -s https://<host>:8443/api/cap/get_task \
  -H "Authorization: Bearer ${CALLER_KEY}" -H 'content-type: application/json' \
  -d '{"taskId":"<taskId>"}'
# 从 result.result.factIds 里取一个 Fact id，或从 result.result.summary 反推
```
```bash
curl -s https://<host>:8443/api/cap/explain \
  -H "Authorization: Bearer ${CALLER_KEY}" -H 'content-type: application/json' \
  -d '{"nodeId":"<factId 或 turnId 或 decisionId>"}'
```
期望结构：`Fact → Observation → Activity → Source + Principal`（design §5.5、
`docs/runbooks/host-worker-runtime.md` §13.3 是这条链路的真实例子——`result.fact.epistemicStatus`
应为 `"inferred"`、`result.activity.kind` 应为 `"worker_result"`、
`result.activity.metadata.workerRunId` 应对得上这次的 WorkerRun）。`epistemicStatus` 不是
`"inferred"` 而是别的值时，说明这个 Fact 不是这次 Worker 写的——找错了 Fact id，回 `get_task` 的
`result.factIds` 重新核对。

### 3.5 全链路审计——`audit_query`/`reconstruct`

```bash
# 该 workspace 内、这个 Task/ActionRequest 相关的全部 audit 行（auditor 角色）：
curl -s https://<host>:8443/api/cap/audit_query \
  -H "Authorization: Bearer ${AUDITOR_KEY}" -H 'content-type: application/json' \
  -d '{"filter":{"resourceType":"task","resourceId":"<taskId>"}}'

# 一个资源从创建到现在的完整重建（对象当前态 + 相关 Fact + 相关审计行）：
curl -s https://<host>:8443/api/cap/reconstruct \
  -H "Authorization: Bearer ${AUDITOR_KEY}" -H 'content-type: application/json' \
  -d '{"entityId":"<taskId 或其它资源 id>"}'
```
Web 控制台等价路径："治理 → 审计"（`#/govern/audit`，按 principal/capability/时间过滤，点击行可
跳 `explain`）。直接 `psql` 的等价查询（`audit_query` 的 `filter` 目前只是一个不透明的 `jsonRecord`
——过滤能力有限时，直接查表往往更快）：
```bash
docker compose exec -T postgres psql -U nexttime -d nexttime -c \
  "select created_at, actor_principal_id, action, payload from audit_records \
   where workspace_id = '<ws>' and resource_type = 'task' and resource_id = '<taskId>' \
   order by created_at;"
```

## 4. 常见根因表（`tasks.failure_reason`）

| `failure_reason` | 什么时候写这个值 | 排查方向 |
|---|---|---|
| `spawn_failed` | `worker-supervisor` 的 `/task/spawn` 调用本身失败（网络问题、镜像不在 allowlist、`worker-supervisor` 未起） | `docker compose logs worker-supervisor`；`docker compose ps worker-supervisor`（是否健康，见 `docs/runbooks/operations.md` §5）；确认 `WORKER_IMAGE`/`WORKER_IMAGE_ALLOWLIST` 配置 |
| `no_result` | 容器干净退出（退出码 0），但从未调用 `report_result`——`platform-extension` 的 `worker` 模式没有正常工作，或系统提示没有引导模型调用它 | 检查 WorkerDefinition 的 `systemPrompt` 是否明确要求调用 `report_result`；确认容器内 `NEXTTIME_MODE=worker` 且能连上 `KERNEL_LLM_URL`；`fake-llm` 场景下这是**已知的预期现象**（`docs/runbooks/host-worker-runtime.md` §13.2"已知限制"——`fake-llm` 不理解系统提示里的指令） |
| `worker_failed` | WorkerRun 状态变成 `failed`（容器非零退出）且重试已耗尽（`retry_count >= 1`） | `docker logs nexttime-task-<workerRunId>`（若容器已被清理，只能看 `worker_runs` 表本身，或等下次复现时更快捕获）；常见原因：pi 进程崩溃、`entrypoint.sh` 的 "worker-mode self-check" 未通过（`api_key_env`/`egress_no_direct_route`/`egress_via_proxy` 三项之一，见 `docs/runbooks/host-accept-s2.md` step6 说明）、模型请求失败且无重试余地 |
| `budget_exhausted` | I18 预算超限——Task 的 `duration_limit_sec`/`token_budget` 用尽（`application/task/service.ts` 的定时检查） | 检查 WorkerDefinition 或调用方是否设置了偏低的预算；owner 可用 `set_quota` 调整工作区级配额；确认不是任务本身陷入了不该有的长循环（配合 §3.3 看容器是否真的还在做有意义的工作） |

**没有 Task 行就已经被拒绝**（不写 `failure_reason`，见 §3.1 的表）：`depth_exceeded` /
`concurrency_exceeded` / `daily_cost_exceeded`（I18 配额，429）、`attenuation_denied` /
`worker_definition_not_enabled`（403）。

**ActionRequest 侧的终态**（`action_requests.status`，与 `tasks.failure_reason` 是两张表、两套
状态机——一次 Task 内可能包含多个 ActionRequest）：`rejected`（人工拒绝）、`denied`（策略判定拒绝）、
`expired`（审批超时）、`failed`（门 `apply` 本身失败——见下一行）、`compensated`（失败后触发的补偿
路径，design §13"Gatekeeper apply 超时 → 幂等重试；失败 → revert → compensated 或人工队列"）。

| ActionRequest 卡在哪 | 排查方向 |
|---|---|
| 门 `apply` 失败（`action_requests.status = 'failed'`） | 该门自己的容器日志（`docker compose logs gatekeeper-<name>`）；常见原因见目标系统本身的错误——门只是转发者 |
| 一直 `executing` 不变 | 门可能挂起（网络超时未触发）；检查目标系统本身是否可达；`docs/runbooks/add-gatekeeper.md` §12 的门排障表 |

## 5. 验证（确认诊断正确）

- 找到的根因能在 §4 表格里对上号，且 `docker compose logs`/审计记录里能看到与之吻合的具体证据
  （不是"猜测符合模式"）。
- `explain`/`reconstruct` 返回的溯源链完整（没有 `null`/缺失的中间节点）——链路断裂本身也是一种
  信号（见 §6"已知缺口"）。

## 6. 回滚 / 处理

排查本身是只读操作，不需要回滚。确认根因后，视情况：

```bash
# Task 还在 running 且确实该终止（比如确认是死循环）：
curl -s https://<host>:8443/api/cap/cancel_task \
  -H "Authorization: Bearer ${CALLER_KEY}" -H 'content-type: application/json' \
  -d '{"taskId":"<taskId>"}'
# 只在 TaskStatus 转移表里 running 状态有 cancel 出边时才允许（web 控制台"Cancel task"按钮的同一条
# 规则，见 docs/runbooks/web-console.md"状态词表"）。

# 需要重新跑一遍同样的请求：直接对同一个 WorkerDefinition 再调一次 invoke_worker——不是"重试
# 同一个 Task"（Task 没有 retry 的公开接口，重试是 WorkerRun 内部机制、由内核 reaper 决定，见
# packages/kernel/src/application/task/lifecycle.ts 的 retryCount < 1 分支，对调用方不可控）。
```

## 7. 已知缺口（如实记录，不是本文档能修的）

- **I18 配额拒绝不写审计**：`depth_exceeded`/`concurrency_exceeded`/`daily_cost_exceeded`/
  `attenuation_denied`/`worker_definition_not_enabled` 这几类"创建 Task 之前就拒绝"的错误，只
  作为这一次 capability 调用的错误返回给调用方，`audit_records` 里查不到——`audit_query`/
  `reconstruct` 对这类问题无能为力，只能从调用方（entry agent 的回复文本）或 §3.1 表格反推。
- **没有 Task → ActionRequest 的直接读取能力**（`docs/runbooks/web-console.md`"已知缺口"第 6
  条）：`list_pending` 只回当前 pending 的，`get_action` 按 id 查——找一个 Task 关联过的**全部**
  ActionRequest（含已终结的）目前只能直接 `psql` 查 `action_requests` 表按
  `parent_worker_run_id`/时间窗口筛。
- **Prometheus 风格指标/结构化日志字段尚未实现**（design §12 的目标形态）——见
  `docs/runbooks/operations.md` §7，排查时能用的只有本文档列出的这几条：`tasks`/`worker_runs`/
  `action_requests` 表、`audit_records`、`explain`/`reconstruct`、`docker compose logs`。
