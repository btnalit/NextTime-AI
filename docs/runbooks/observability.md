# Runbook：observability（关联 ID 与各服务指标）

对应遗留 87（`docs/STATUS.md` §4）与重构方案 v2 §7 "关联 ID"。姊妹文档：`operations.md`（日志与指标位置
总表）、`host-chaos.md` §5（内核不变量指标）、`troubleshoot-task.md`（一次失败 Task 的诊断）。

## 1. 关联 ID：一次委派凭一个 ID 串起所有服务

**规则**（`packages/shared/src/correlation.ts`）：HTTP 头 `x-correlation-id`，8–64 位 `[A-Za-z0-9_-]`；
不合法或缺失时第一个看到它的服务自己铸一个（UUID）。它**不是凭证**：永远不从 Handle / 密钥派生，
不进 Handle 的 scope；调用方可自带（未认证即读取，只作追踪用），所以别往里放任何秘密。

**来源——对一轮对话，关联 ID 就是 Turn 的 id**（`activities.id`，`kind='agent_turn'`），不另造：

| 跳 | 怎么拿到 ID | 写进哪里 |
|---|---|---|
| 控制台 → kernel（`send_chat_message` 等） | 请求头，或 WS 帧的可选 `correlationId`；都没有就铸一个 | kernel 请求日志 `correlationId`、审计 `payload.correlationId`、响应头 |
| kernel → agent-host | `startTurn` 帧本来就带 `turnId` | agent-host `turn started` / `turn ended` 行 |
| agent-host → worker-supervisor `/resident/spawn`、`touch` | 头 = Turn id | supervisor 请求日志 |
| agent-host → pi（入口容器） | 提示词首行的 turn 标记（既有机制） | — |
| 入口 agent（平台扩展）→ kernel | 头 = 当前 Turn id | kernel 请求日志、审计 |
| 入口 agent（pi）→ llm-proxy | pi `before_provider_headers` 注入同一个头 | llm-proxy 每行日志与用量行 `correlationId` |
| kernel → 门（observe / apply …） | 头 = 当前调用的 ID | 门的 `gate call` 行 |
| kernel `invoke_worker` → supervisor `/task/spawn` | 头 = 当前调用的 ID（入口 agent 的即 Turn id）；reaper 重试时用 Task 的 `created_by_activity_id` | Worker 容器 env `NEXTTIME_CORRELATION_ID`、标签 `nexttime.correlation-id`、egress 源映射 |
| Worker（平台扩展）→ kernel / llm-proxy | env `NEXTTIME_CORRELATION_ID` | 同上两行 |
| Worker 出网 → egress-proxy | 源映射里的 `correlationId` | egress 每条观测日志行（上报内核的 `EgressObserved` 不变） |
| Worker 结束 | supervisor 登记表 | `task container finished` 行 |

语义：一行日志 / 一条审计上的 `correlationId` = **写下它时正在服务的那次入站调用**。由此有三处边界：

- 入口容器常驻、跨多个 Turn，所以它的出网行只按 `sourceId=entry:<ws>:<principal>` 与时间归属，不带 Turn id。
- 需审批的执行在"批准"那次调用里发生：门的 `apply` 与执行审计带的是审批者那次调用的 ID——按审计的
  `resource_id`（ActionRequest id）关联回提出它的委派（`request_action` 那行带委派的 ID）。
- 没有请求上下文的后台工作（outbox、审批 drainer 的定时 tick、门健康巡检）不带 ID，下游自己铸。

门协议调用会带 ID（门是平台协议的一方，包括 workspace 自己接入的 http / mcp 门）；内核直接抓外部 OpenAPI /
MCP 清单、llm-proxy 调上游模型供应商时不带。

**拿到 ID**：`send_chat_message` 的结果与 `chat.stream` 事件都有 `turnId`；一个 Task 的
`created_by_activity_id` 就是派它的 Turn；任何一次 API 调用的响应头 `x-correlation-id`。

**串日志**（在检出目录）：

```sh
ID=<turn-id>
docker compose logs --since 6h --no-color \
  kernel agent-host worker-supervisor llm-proxy egress-proxy \
  gatekeeper-docker gatekeeper-ragflow gate-host 2>/dev/null | grep -F "$ID"
# 这次委派仍在运行的 Worker 容器（结束后由 supervisor 删除）
docker ps -a --filter "label=nexttime.correlation-id=$ID"
```

**串审计**（该 ID 下该工作区的审计行，按时间）：

```sh
WS=<workspace-id>
docker compose exec -T postgres psql -U nexttime -d nexttime -c \
  "select created_at, actor_principal_id, action, resource_type, resource_id from audit_records
   where workspace_id = '$WS' and payload->>'correlationId' = '$ID' order by created_at"
```

`payload.correlationId` 是**调用方自报**的追踪线索，不是权威溯源：任何调用方都能在请求头里填任意合法 ID
（包括别人的 Turn ID），所以查询一定按工作区过滤、并同时看 `actor_principal_id`；它不证明因果——"谁做的、
凭什么"仍以审计行本身的主体、ActionRequest / Task 关联与 `explain` 为准。

覆盖缺口（按 ID 查会漏的，属已知、非缺陷）：控制台发起一轮对话时，`send_chat_message` 那条审计行带的是这次
请求 / WS 帧自己的 ID，不是随后建立的 Turn ID（按 Turn ID 查从下一跳开始）；WS 响应不回显实际采用的 ID；
agent-host 经 `/internal/agent-host` WS 上报的事件、以及在 preHandler 之前就写入的审计行不带 ID。审批触发的
门 `apply` 记的是批准人那次调用的 ID——经 ActionRequest ID 连回委派。

## 2. 各服务 `/internal/metrics`

全部是 Prometheus 文本格式（`@nexttime/shared` 的 `metrics.ts`），**都不经 caddy 发布**（caddy 只反代
`/api/* /ws /mcp /llm/*`、`/api/llm-admin/*`→`/admin/*`，以及 gate-host 唯一的浏览器路由
`/gate-host/i/<id>/gate/connected-accounts`（POST / DELETE）；`/gate-host/` 下其余路径一律 404）。
每个服务只认自己持有的那份凭证（R-03：internal plane 每个服务一份派生凭证，根 `internal_token` 只在
kernel 里），所以在一个本来就挂着对的凭证的容器里读：kernel 容器里有根（kernel 自己的
`/internal/metrics` 只认根）、kernel 给 worker-supervisor 的凭证与 `gate_token`；agent-host 与
llm-proxy 进它们自己的容器、用自己的 `/run/secrets/internal_token`：

```sh
metrics() {  # $1 = 在哪个服务的容器里读，$2 = 该容器里的 token 文件名，$3 = URL
  docker compose exec -T "$1" node -e '
    const t = require("fs").readFileSync("/run/secrets/" + process.argv[1], "utf8").trim();
    fetch(process.argv[2], { headers: { authorization: "Bearer " + t } })
      .then((r) => r.text()).then((s) => process.stdout.write(s));' "$2" "$3"
}
metrics kernel     internal_token                   http://localhost:8080/internal/metrics   # kernel（不变量）
metrics kernel     internal_token_worker_supervisor http://worker-supervisor:8081/internal/metrics
metrics agent-host internal_token                   http://localhost:8090/internal/metrics
metrics llm-proxy  internal_token                   http://localhost:8082/internal/metrics
metrics kernel     gate_token                       http://gatekeeper-docker:8083/internal/metrics
metrics kernel     gate_token                       http://gatekeeper-ragflow:8083/internal/metrics
metrics kernel     gate_token                       http://gate-host:8083/internal/metrics
# egress-proxy 的管理口只绑 127.0.0.1（不让 workers 网络碰到），所以进它自己的容器读，无需令牌：
docker compose exec -T egress-proxy node -e \
  'fetch("http://127.0.0.1:3129/internal/metrics").then((r)=>r.text()).then((s)=>process.stdout.write(s))'
```

| 服务 | 认证 | 指标（标签） |
|---|---|---|
| kernel | 根 `internal_token`（kernel 容器内） | `nexttime_invariant_violations{invariant}` 等（`host-chaos.md` §5） |
| worker-supervisor | kernel 给它的凭证（kernel 容器的 `internal_token_worker_supervisor`） | `nexttime_supervisor_operations_total{operation,outcome}`、`nexttime_supervisor_operation_duration_seconds{operation}`、`nexttime_supervisor_task_exits_total{state}` |
| agent-host | 它自己的凭证（agent-host 容器的 `internal_token`） | `nexttime_agent_host_turns_started_total`、`nexttime_agent_host_turns_ended_total{status}`、`nexttime_agent_host_turn_duration_seconds{status}`、`nexttime_agent_host_active_turns`、`nexttime_agent_host_kernel_link_up` |
| llm-proxy | 它自己的凭证（llm-proxy 容器的 `internal_token`；未配 `KERNEL_URL` 时恒 401） | `nexttime_llm_proxy_requests_total{provider,model,status}`、`nexttime_llm_proxy_upstream_duration_seconds{provider,model,outcome}`、`nexttime_llm_proxy_tokens_total{provider,model,direction}` |
| egress-proxy | 仅 loopback | `nexttime_egress_requests_total{protocol,decision,reason}`、`nexttime_egress_bytes_total{protocol,direction}` |
| 门（单门 / gate-host） | gate_token | `nexttime_gate_calls_total{gate,route,operation,status}`、`nexttime_gate_call_duration_seconds{gate,route,operation}` |

标签值都是有界集合：`operation` 只取门确实发布的 Operation 名，`provider`/`model` 只取已配置的
供应商与白名单模型（其余记 `unknown` / 空串），`outcome` / `status` / `reason` 是固定枚举或 HTTP 状态码。
计数器在进程内存里，服务重启归零——这是"最小闭环"，还没有 Prometheus 抓取与告警（后续再定）。

## 3. 常见问题

- **grep 不到 llm-proxy 行**：入口 / Worker 容器还是旧镜像（pi 扩展没注入头）——llm-proxy 仍会为每个
  请求铸一个 ID，只是和 Turn 对不上；按 `sessionId`（Handle 的 `sid`）找。重建 worker-runtime 镜像
  （`sh scripts/build-images.sh`）后生效。
- **kernel 日志里还是 `reqId`**：kernel 镜像未重建；新镜像的请求日志键名是 `correlationId`。
- **`/internal/metrics` 401**：容器或 token 文件名对错（门用 `gate_token`；其余见 §2 表"认证"列——
  R-03 起每个服务只认自己那份，kernel 容器里的根读不了 agent-host / llm-proxy / worker-supervisor）。
