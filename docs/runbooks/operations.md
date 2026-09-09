# Runbook：operations（日常运维——重启顺序、恢复顺序、健康检查、日志与指标）

对应任务：development-tasks.md § S3.10（"`docs/runbooks/`：重启各服务与恢复顺序...健康检查清单、
日志与指标位置"）。设计依据：`docs/graph-ai-middle-platform-design.md` §10.2（docker-compose 骨架）、
§12（可观测与审计）、§13（故障恢复）。

不含：从备份恢复数据库/文件（见 `docs/runbooks/backup-restore.md`）、轮换密钥（见
`docs/runbooks/key-rotation.md`）、排查一次失败的 Task（见 `docs/runbooks/troubleshoot-task.md`）——
本文档只覆盖"服务本身"层面的运维，三份姊妹 runbook 各自覆盖更窄的场景，本文档在相关小节末尾链接过去。

**当前现实与设计文档的差距（先说明，避免误导）**：设计文档 §12 描述的结构化日志固定字段
（`workspace_id/principal_id/.../duration_ms`）、OpenTelemetry trace、待批准数/Conflict 数/token
成本这类业务级 Prometheus 指标**均未实现**——写本文档时 `packages/kernel/src` 下没有任何模块产出
这些指标，`docker compose logs` 看到的是每个服务各自的、未统一格式的 stdout/stderr（`kernel` 服务
用 Fastify 自带的请求日志，`logger: true`；其余服务多数是零散 `console.log`/`console.error`）。
`invariant-checks.ts` 定时校验（development-tasks.md S3.8）**已实现**（`GET /internal/metrics`，
Prometheus 文本格式——见 `docs/runbooks/host-chaos.md` §5），是当前唯一产出真正 Prometheus 格式
指标的模块，规模仅限 I1–I16 违反计数，不覆盖上面这几项业务指标。本文档记录的是**能用的现状**：
`docker compose logs`、`/internal/metrics`、`audit_records` 表、`tasks`/`worker_runs`/
`action_requests` 表——不是 §12 描述的目标形态。

## 1. 目的

- 给出**服务依赖图**（源自 `docker-compose.yml` 的 `depends_on`/`healthcheck`），据此定义"整体冷启动
  顺序"与"单个服务重启不影响其它服务"两种场景该怎么做。
- 给出**健康检查清单**：每个服务怎么确认"起来了且真的可用"。
- 给出**日志与指标位置**：当前唯一可用的观测面是 `docker compose logs <service>` 与内核数据库里的
  `audit_records`/`tasks`/`worker_runs`/`action_requests` 几张表。

## 2. 前置条件

- 目标主机已完成 `docs/runbooks/host-checkout.md`（E3/E4：代码检出、`.env`、密钥占位、Postgres 已建）
  与 `docs/runbooks/host-bootstrap.md`（E2：数据目录树）——即 `${NEXTTIME_DATA}` 与 `.env` 已存在。
- `scripts/gen-handle-keys.sh` 已跑过（`secrets/handle.key`、`secrets/internal.token`、
  `secrets/gate.token` 均已生成——三者具体用途见 `docs/runbooks/key-rotation.md`）。
- 有 `docker`、`docker compose`（v2）。

## 3. 服务依赖图

来自 `docker-compose.yml` 的 `depends_on`（`condition: service_healthy` 的边才会真的等待，其余只
决定创建顺序）：

```
postgres ──(healthy)──> kernel ──(healthy)──> agent-host
                             │                     ↑(healthy)
                             │                docker-socket-proxy
                             └──(healthy)──> caddy

docker-socket-proxy ──(healthy)──> agent-host
                     ──(healthy)──> worker-supervisor

docker-socket-proxy-gate ──(healthy)──> gatekeeper-docker

postgres ──(healthy)──> backup
```

**没有 `depends_on` 声明、compose 只按文件顺序创建、彼此无强制等待关系**的服务：
`llm-proxy`、`egress-proxy`、`gatekeeper-ragflow`——这三个不等任何其它服务健康，也没有其它服务等
它们健康（它们的消费者是运行时 HTTP 调用失败重试，不是 compose 级别的启动顺序）。

带 `healthcheck:` 的服务（`docker compose ps` 会显示 `healthy`/`unhealthy`/`starting`）：
`postgres`、`kernel`、`docker-socket-proxy`、`docker-socket-proxy-gate`。其余服务（`agent-host`、
`worker-supervisor`、`gatekeeper-docker`、`gatekeeper-ragflow`、`caddy`、`llm-proxy`、
`egress-proxy`、`backup`）**没有** compose `healthcheck:`——`docker compose ps` 只能看到
`running`/`exited`，"真的可用"要按 §5 的清单逐个探测。

`fake-llm`（`profiles: ["test"]`）与全部 `accept-s2-*`（`profiles: ["accept-s2"]`）、
`worker-runtime`（`profiles: ["build-only"]`）默认 `docker compose up` 不会拉起，不在下面的常驻
服务清单里。

## 4. 服务重启顺序

### 4.1 整体冷启动（主机重启后、或首次 `docker compose up -d`）

```bash
cd <CODE_DIR>
set -a; . ./.env; set +a

# 1. 数据层
docker compose up -d postgres
docker compose ps postgres          # 等 healthy

# 2. Docker socket 代理（agent-host / worker-supervisor / gatekeeper-docker 依赖它们健康才起）
docker compose up -d docker-socket-proxy docker-socket-proxy-gate
docker compose ps docker-socket-proxy docker-socket-proxy-gate   # 等 healthy

# 3. 内核（若数据库是全新的或刚从备份恢复，先跑一次迁移——幂等，可安全重复跑）
# 目标主机通常没有 node/corepack（docs/runbooks/accept-s1.md §1 "主机上有 docker、curl；没有
# node/corepack"）——用容器化的方式跑，同 scripts/accept_s1.sh/accept_s2.sh 自己的 preflight 步骤：
docker compose run --rm --no-deps -T kernel node dist/cli/migrate.js --dry-run   # 先看有没有待跑的迁移
docker compose run --rm --no-deps -T kernel node dist/cli/migrate.js            # 真正应用
# 若这台机器上确实装了 Node/corepack（例如开发机），`make migrate` 是等价的本地路径（Makefile 自己
# 会先跑一次 `pnpm --filter @nexttime/kernel build`）。
docker compose up -d kernel
docker compose ps kernel            # 等 healthy（healthcheck 打 GET /api/health）

# 4. 其余全部服务——compose 自己会按 depends_on 图等 kernel/两个 socket 代理健康后再起
#    对应的消费者；一次性 up 即可，不需要再手动分批：
docker compose up -d
docker compose ps
```

`docker compose up -d`（不带服务名）默认只拉起没有 `profiles:` 标签的服务——`fake-llm`/
`accept-s2-*`/`worker-runtime` 不会被这一条命令拉起，这是设计如此，不是遗漏。

### 4.2 局部重启（改了某个服务的配置/env_file/镜像，其它服务不受影响）

**默认 `docker compose restart <service>` 不会重新读 `env_file`/挂载内容的变化**——它只是重启同一个
容器进程，容器本身的 env/挂载在创建时就已经固化。任何改了 `secrets/*.env`、`config/*.yaml`、或需要
换新镜像的场景，用 `up -d --force-recreate`：

```bash
docker compose up -d --force-recreate <service>
```

已知需要 `--force-recreate` 而不是普通 `restart` 的场景（本仓库其它 runbook 已踩过的坑，这里汇总）：

| 改了什么 | 服务 | 命令 |
|---|---|---|
| `secrets/llm-proxy.env`（换 provider key） | `llm-proxy` | `docker compose up -d --force-recreate llm-proxy` |
| `secrets/gatekeeper-ragflow.env` | `gatekeeper-ragflow` | `docker compose up -d --force-recreate gatekeeper-ragflow` |
| `config/llm-providers.yaml`（换 provider，随后必须 `make gen-models` 重生成 `models.json`——见 §6 常见问题） | `worker-supervisor` 消费的是重新生成的 `models.json` 文件本身（bind mount 内容变了，不需要重建容器），但换 provider 后新拉起的入口/Worker 容器才会用上新值 | 见 `docs/runbooks/host-worker-runtime.md` §3、`docs/runbooks/host-accept-s2.md` §1 |
| `deploy/caddy/Caddyfile` | `caddy` | 普通 `docker compose restart caddy` 即可（bind mount，不需要重建镜像） |
| `packages/web` 代码改动 | `caddy`（静态产物随镜像走，见 `docs/runbooks/host-caddy.md` §E8.5） | `docker compose build caddy && docker compose up -d caddy` |
| `secrets/handle.key` / `secrets/internal.token` / `secrets/gate.token` | 见 `docs/runbooks/key-rotation.md`（涉及多个服务协同重启，不是单服务局部重启） | — |

### 4.3 恢复顺序（主机崩溃/意外重启后）

Docker 与本仓库每个常驻服务都设了 `restart: unless-stopped`——主机重启、`dockerd` 重启后，
Docker 会自动按它自己记录的容器状态把它们重新拉起，**不需要人工干预**，但顺序不受 `depends_on`
约束（Docker 自身的容器自启动不重新计算 compose 依赖图）。因此主机计划外重启后应该做的是**验证**
而非手工重跑 §4.1：

```bash
cd <CODE_DIR>
docker compose ps                      # 是否所有预期服务都在跑、健康检查是否通过
docker compose ps postgres kernel docker-socket-proxy docker-socket-proxy-gate
```

若 `kernel` 起来时 `postgres` 还没就绪（`unhealthy`/连接失败），Fastify 进程会在健康检查上体现为
`unhealthy`——按 §4.1 的顺序手动 `docker compose up -d kernel` 一次即可（compose 会等
`postgres: service_healthy` 再真正重建/启动它，若 postgres 已经 healthy 则立即返回）。同理，若
`agent-host`/`worker-supervisor`/`gatekeeper-docker` 起来时它们各自依赖的 socket 代理还没
healthy，重新 `docker compose up -d <service>` 一次即可，不需要 `--force-recreate`（配置没变，
只是等待顺序问题）。

若数据库本身损坏（不是"还没起来"，是数据丢失/损坏），走 `docs/runbooks/backup-restore.md` 的恢复
演练，而不是本节的"验证并等待"路径。

### 4.4 全部停止 / 全部启动

```bash
docker compose down          # 不加 -v：保留 pgdata/、workspaces/ 等所有持久卷（都是 host bind mount，
                              # 不受 down 影响；-v 只清 compose 自己管理的匿名卷，本仓库没有这类卷）
docker compose up -d         # 见 §4.1，若数据库不是全新的可跳过迁移步骤
```

## 5. 健康检查清单

| 服务 | 检查方式 | 期望 |
|---|---|---|
| `postgres` | `docker compose ps postgres`（`healthcheck` 用 `pg_isready`） | `healthy` |
| `kernel` | `docker compose ps kernel`（`healthcheck` 打容器内 `GET /api/health`）；从主机：`curl -sk "https://${KERNEL_BIND_ADDR}:8443/api/health"`（经 caddy 反代） | `healthy`；curl 返回 `200` |
| `docker-socket-proxy` / `docker-socket-proxy-gate` | `docker compose ps docker-socket-proxy docker-socket-proxy-gate`（`healthcheck` 打 `/_ping`） | `healthy` |
| `agent-host` | 无 compose healthcheck；`docker compose logs --tail 50 agent-host` 里应能看到它已经连上 kernel 的 `/internal/agent-host` WS（不应有持续的连接失败/重连日志） | 无异常重连日志 |
| `worker-supervisor` | 无 compose healthcheck；容器只在 `control` 网络，主机 curl 不到——用 `docker compose exec -T worker-supervisor node -e "fetch('http://localhost:8081/healthz').then(r=>r.text()).then(console.log)"` | `{"status":"ok"}` |
| `gatekeeper-docker` / `gatekeeper-ragflow` | 无 compose healthcheck；用 `kernel` 容器内 `fetch` 打 `/gate/health`（需要 `gate_token`，见 `docs/runbooks/host-gatekeepers.md` §3 的完整命令） | `{"ok":true,"result":{"status":"ok"}}` |
| `caddy` | `curl -sk -o /dev/null -w '%{http_code}\n' "https://${KERNEL_BIND_ADDR}:8443/"` | `200` |
| `llm-proxy` | 无 compose healthcheck；有 `/healthz`（`proxy.ts`），未发布到主机——从同网络的另一个容器打：`docker compose exec -T kernel node -e "fetch('http://llm-proxy:8082/healthz').then(r=>r.text()).then(console.log)"` | `{"status":"ok"}` |
| `egress-proxy` | 无 compose healthcheck；有 `/healthz`（`admin.ts`），但只绑定 `127.0.0.1`（design §7.9 任务原文），从容器自己内部打：`docker compose exec -T egress-proxy node -e "fetch('http://127.0.0.1:3129/healthz').then(r=>r.text()).then(console.log)"`；功能性验证（代理真的放行/拒绝）见 `docs/runbooks/host-worker-runtime.md` §6 | `{"status":"ok"}`（`ADMIN_PORT` 默认 `3129`，`.env`/compose 有覆盖时以实际值为准） |
| `backup` | `cat "${NEXTTIME_DATA}/backups/last-success"` | 有内容且时间戳是最近一次 `BACKUP_TIME` 之后 |

一次性看全部服务的粗粒度状态：

```bash
docker compose ps --format 'table {{.Name}}\t{{.Status}}\t{{.Health}}'
```

## 6. 日志位置

- **每个服务的 stdout/stderr**（当前唯一的日志来源）：
  ```bash
  docker compose logs -f <service>          # 实时跟随
  docker compose logs --since 1h <service>  # 最近一小时
  docker compose logs --tail 200 <service>
  ```
  没有集中式日志收集（无 ELK/Loki 之类的 sidecar）——每个服务的日志只存在于该容器自己的日志驱动
  （Docker 默认 `json-file`）里，容器被 `docker rm` 后日志随之消失，除非在那之前已经 `docs compose
  logs` 导出。
- **`audit_records` 表**（内核里唯一的持久化、可查询的操作记录，design §12"append-only"）：每次
  `dispatchCapability` 的成功调用、每次 Task/WorkerRun/ActionRequest 的领域状态转移都在这里落一行
  （`workspace_id`/`actor_principal_id`/`action`/`resource_type`/`resource_id`/`payload`/
  `created_at`）。经 `audit_query`/`reconstruct` capability（human 通道，`minRole: auditor`）读，
  或直接 `psql`：
  ```bash
  docker compose exec -T postgres psql -U nexttime -d nexttime -c \
    "select created_at, actor_principal_id, action, resource_type, resource_id \
     from audit_records where workspace_id = '<workspace-uuid>' order by created_at desc limit 50;"
  ```
  Web 控制台的"审计"页（`#/govern/audit`，见 `docs/runbooks/web-console.md`）是这张表的 UI。
- **`tasks` / `worker_runs` / `action_requests` 表**：一次 Task/审批的完整状态与失败原因——用于
  排查一次失败的 Task 时，见 `docs/runbooks/troubleshoot-task.md`（不在本文档重复）。
- **`explain` capability**：某个 Fact/Decision/Turn 的溯源链（Observation → Activity → Source +
  Principal），同样在 `docs/runbooks/troubleshoot-task.md` 展开。

## 7. 指标位置

**现状：没有指标端点。** 设计文档 §12 列出的指标（待审批数与等待时长、ActionRequest 终态计数、
open Conflict 数、Fact 按状态分布、每 Task/每 Turn 的 token 成本、入口 agent 重启次数、Worker 失败
率）目前**没有**任何服务暴露 Prometheus 风格的 `/metrics` 端点，也没有 OpenTelemetry
exporter/collector 接入（`packages/kernel/src` 下没有 `prom-client`/`opentelemetry` 依赖）。能拿到
的近似替代：

| 想看的东西 | 现在怎么拿 |
|---|---|
| 待审批数 | `list_pending`（human 通道，`minRole: operator`）——web 控制台侧栏徽标就是这个；或 `select count(*) from action_requests where status = 'pending_approval' and workspace_id = '<ws>';` |
| ActionRequest 终态分布 | `select status, count(*) from action_requests where workspace_id = '<ws>' group by status;`（`get_operation_stats{gatekeeperId?, days?}` 是一个更窄的、只覆盖 execute 类 Operation 的聚合读能力，见 `docs/runbooks/web-console.md` 已知缺口第 12 条） |
| open Conflict 数 | `select count(*) from conflicts where status = 'open' and workspace_id = '<ws>';`（`list_conflicts` capability 已注册但**无 handler**，见 development-tasks.md S3.7 实现说明——只能直接查表） |
| 每 Task 的 token 成本 | `select id, tokens_used from tasks where workspace_id = '<ws>' order by created_at desc;`；更细的 `llm_usage` 表按 provider/model 记录每次调用的 token 与估算成本 |
| 入口 agent 重启次数 | `docker compose exec -T worker-supervisor node -e "fetch('http://localhost:8081/resident/<principalId>', {headers:{authorization:'Bearer '+require('fs').readFileSync('/run/secrets/internal_token','utf8').trim()}}).then(r=>r.json()).then(b=>console.log(b.restarts))"`（见 `docs/runbooks/host-worker-runtime.md` §9） |
| Worker 失败率 | `select failure_reason, count(*) from tasks where workspace_id = '<ws>' and status = 'failed' group by failure_reason;`（`failure_reason` 取值见 `docs/runbooks/troubleshoot-task.md`） |

`invariant-checks.ts`（development-tasks.md S3.8，I1–I16 定时校验 → 指标与日志）已实现——
`packages/kernel/src/substrate/audit/invariant-checks.ts`，随内核进程按 `INVARIANT_CHECK_INTERVAL_MS`
（默认 10 分钟）定时跑，违反的不变量打结构化 `warn` 日志、`GET /internal/metrics` 暴露当前计数；
混沌演练脚本（主动杀容器验证 §13 自愈）与这个监控器的运维面见 `docs/runbooks/host-chaos.md`。

## 8. 验证

```bash
docker compose ps --format 'table {{.Name}}\t{{.Status}}\t{{.Health}}'
curl -sk -o /dev/null -w '%{http_code}\n' "https://${KERNEL_BIND_ADDR}:8443/api/health"
```
期望：全部预期服务 `running`（有 healthcheck 的额外要求 `healthy`）；curl 返回 `200`。

## 9. 回滚

- 单服务局部改动：见 §4.2 表格——多数场景是"改回旧的 `secrets/*.env`/`config/*.yaml` 再
  `--force-recreate`"；`caddy`/`kernel` 等有镜像版本概念的服务可以 `docker image ls
  nexttime-ai-<service>` 找回上一个镜像 id，`docker compose build` 前先 `git checkout <上一个
  commit>`。
- 整体回滚：`git checkout <上一个已知良好的 commit/tag>` → 按 §4.1 重新走一遍冷启动顺序（`make
  migrate` 对回滚同样安全——迁移只增不减，回滚代码不会自动回滚 schema；若确实需要回滚一次迁移，
  这是数据层面的操作，超出本文档范围，评估前先做一次 `docs/runbooks/backup-restore.md` 的完整
  备份）。
- 不确定改动是否安全时，优先用 §4.2 的 `--force-recreate` 而不是 `docker compose down`
  再 `up`——前者只重建目标服务，后者会短暂中断所有服务（即使随后立刻 `up -d` 拉回来）。

## 10. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `kernel` 起来后 `docker compose ps` 一直显示 `starting`，很久都不变 `healthy` | healthcheck 的 `start_period` 是 10s、`retries: 5`、`interval: 10s`——最长到 60s 才会判定 `unhealthy`；正常冷启动（尤其是 postgres 刚建库、还没跑迁移）可能确实需要这么久 | 等到 60s 再判断；若之后仍不健康，`docker compose logs kernel` 看是否是数据库连接失败或迁移未跑 |
| 改了 `secrets/*.env` 之后重启了服务，行为看起来还是旧值 | 用了 `docker compose restart` 而不是 `--force-recreate`（§4.2） | `docker compose up -d --force-recreate <service>` |
| `docker compose logs <service>` 什么都看不到，或只有很少几行 | 容器刚被 `--force-recreate` 过（旧容器的日志随旧容器一起没了），或该服务本身就没有多少输出（如 `egress-proxy`/`llm-proxy` 空闲时几乎不打印） | 正常；需要持续观测时用 `docker compose logs -f`，从这次重建之后开始跟随 |
| `caddy` 起来了，但 `/api/*` 反代一直 502 | `caddy` 的 `depends_on: kernel` 只保证启动顺序，不等待 kernel 的健康检查（compose 定义如此——`kernel` 有 `condition: service_healthy` 边，`caddy` 自己那条也是，见 `docker-compose.yml`，实际仍可能出现短暂窗口） | 重试几次；若持续 502，按 §5 单独验证 `kernel` 是否真的 `healthy` |
| 想看 Prometheus 风格的指标面板，发现没有任何端点 | 见 §7——设计文档 §12 的指标体系尚未实现，这不是本次文档遗漏，是代码现状 | 用 §7 表格里的 SQL/capability 近似替代；若确实需要真正的指标端点，那是一项新的实现任务（development-tasks.md S3.8），不是本 runbook 能补的文档缺口 |
| 目标主机上跑 `make migrate` 报 `corepack`/`pnpm` 不存在 | 目标主机通常没有 Node/corepack（`docs/runbooks/accept-s1.md` §1） | 用容器化命令 `docker compose run --rm --no-deps -T kernel node dist/cli/migrate.js`（见 §4.1）；`make migrate` 只在装了 Node/corepack 的机器（如开发机、CI）上直接可用 |
| `docker compose run --rm --no-deps -T kernel node dist/cli/migrate.js` 报找不到该文件 | `kernel` 镜像还没构建，或构建的是旧代码 | `docker compose build kernel` 后重试 |
