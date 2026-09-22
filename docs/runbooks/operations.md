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
服务清单里。`accept_s1.sh`/`accept_s2.sh`/`accept_s3.sh`、`scripts/drill-install.sh`、
`scripts/drill-upgrade.sh` 用的是 `docker compose --profile test up -d`，会把 `fake-llm` 一起拉
起来，验收完不会自己停掉它——验收/演练结束后如果不想让它继续常驻，手动
`docker compose --profile test stop fake-llm`。

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
| `config/llm-providers.yaml`（换 provider，随后必须 `make gen-models` 重生成 `models.json`——见 §6 常见问题） | `worker-supervisor` 消费的是重新生成的 `models.json` 文件本身（bind mount 内容变了，不需要重建容器），但换 provider 后新拉起的入口/Worker 容器才会用上新值 | 见 `docs/runbooks/host-worker-runtime.md` §3（验收脚本 `accept_s1/s2/s3.sh` 不走这条路径——它们经 `deploy/accept/docker-compose.fake.yml` 自行切到 fake provider，不改这份生产文件，见 `docs/runbooks/accept-s1.md` §1） |
| `deploy/caddy/Caddyfile` | `caddy` | 普通 `docker compose restart caddy` 即可（bind mount，不需要重建镜像） |
| `packages/web` 代码改动 | `caddy`（静态产物随镜像走，见 `docs/runbooks/host-caddy.md` §E8.5） | `docker compose build caddy && docker compose up -d caddy` |
| 发版 / 切 tag 后重建 `kernel`（概览的版本号随镜像走，B1） | `kernel` | 先 `export KERNEL_VERSION="$(git describe --tags --abbrev=0) ($(git rev-parse --short HEAD))"`，再 `docker compose build kernel && docker compose up -d kernel`——版本是**构建参数**烙进镜像的 ENV，不是 `.env` 里的值（`.env` 里的 `KERNEL_VERSION` 已不被读取，可删）；漏了 export 概览会显示 `dev`。见 `docs/runbooks/release.md` §3.1 |
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

**采集器 / 外部运行时的失联（S6，遗留 41 后半）**：`nexttime_invariant_violations{invariant="ops.collector_silent"}`
——`active` 且 `standard` 工作区里、由 `service` Principal 拥有、曾经提交过观察、但最近一次观察距今超过
2 小时（`collectorSilenceThresholdMs` 缺省；约 8 个采集周期）的 Source 数。内核听不到被它拒掉的采集器
（401 不落任何行），所以能看见的信号是随之而来的**沉默**：token 指向了错的工作区、Handle 被撤销、采集器
容器停了，都表现为这一项 > 0。`sample` 里给出 `<workspaceId>:<sourceId> (<name>, last observed <时间>)`。
ephemeral 与 disabled 工作区的 Source 不计（本就该安静）。采集器自己那一侧：interval 模式每轮失败的日志行
带 `consecutiveFailures`，内核拒绝时还带 `kernelStatus` / `kernelErrorCode`；连续
`HOST_INVENTORY_FAILURE_STREAK_ALERT`（缺省 3）轮后变成 `level: "error", message: "collector failing
repeatedly"`——`docker compose logs collector-host-inventory | grep 'failing repeatedly'` 即可。

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

## 10. 工作区清除（purge，S6）

工作区的生命周期是 `active → disabled → purged`（`docs/console-completion-plan.md` §4）；`purged`
是终态：行与级联数据删除，平台审计行 `platform.workspace_purged`（谁、何时、清了什么——按表计数、
撤销的 Handle 数、随之删除的用户、service Handle 警告）保留。控制台"工作区"页的清除入口与下面的脚本
是**同一条路径**（`application/platform/purge-workspace.ts`）。

**前置条件（内核强制，脚本与页面一致）**：`disabled` 满 7 天（`workspaces.disabled_at`，迁移 core
0030；0030 之前就已 `disabled` 的行 `disabled_at` 为空、视为立即可清），或 `ephemeral` 且 `expires_at`
已过（此时哪怕仍 `active` 也可清——S5.3 `--expired` 的语义不变）；平台默认工作区永远拒绝。

**级联（一个事务）**：撤销并删除全部 CapabilityHandle → Task → Chat / Turn / Activity / Decision /
Conflict / Fact / Object / Source / Observation / Evidence → 该工作区自己的审计行 → Principal →
工作区行；再加上"成员资格全在该工作区、且从未激活（无密码、无控制台登录、无平台审计 / 设置版本引用、
不是管理员）"的 User——这是验收残留用户（A6）的真正修法；有任何引用的 User 内核留下不删（审计只增不减），
用户页的 `hideResidual` 缺省过滤把它们藏起来。主机侧的入口容器与 `${NEXTTIME_DATA}/workspaces/<principalId>`、
`workspaces/tasks/<taskId>` 目录内核不碰，脚本按内核打印的 `PRINCIPAL=` / `TASK=` 行清理。

**两条从主机实战学来的边**：(a) 工作区里若还有 `service` Principal（采集器、外部运行时），预览与结果都带
`service_handle_in_use` 警告——它的 Handle 还在被某个进程用，清除后那个进程立刻 401（遗留 41 的来源），
先把那个进程指回正确的工作区；(b) 上面的 User 级联。

```bash
# 列出现在就能清的（到期 ephemeral；加 --include-disabled 含禁用满 7 天的）——不删任何东西
sh scripts/delete-workspaces-matching.sh --expired
sh scripts/delete-workspaces-matching.sh --expired --include-disabled

# 真删：每个工作区走 scripts/delete-workspace.sh（内核 purge-workspace + 主机侧目录 / 容器清理）
sh scripts/delete-workspaces-matching.sh --expired --yes
sh scripts/delete-workspaces-matching.sh --expired --include-disabled --yes

# 单个：预览（dry run）→ 执行
docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js purge-workspace <workspaceId>
sh scripts/delete-workspace.sh <workspaceId> --name <expected name>

# 名字正则仍可用，但不满足前置条件的会被内核拒绝（计入失败、继续下一个）
sh scripts/delete-workspaces-matching.sh '^accept-s3' --yes
```

- `--actor <login>`：审计行记录的管理员。不传时取 `.env` 里 `NEXTTIME_PLATFORM_ADMINS` 的第一个；
  两者都解析不到用户时**不写审计行**，内核在 stderr 打一行 `workspace_purged` 事件并明说。
- `--force`（仅 `delete-workspace.sh` / 正则模式）：操作员越权，走旧的 `delete-workspace` 子命令跳过
  前置条件——只用于"建错了、不想等 7 天"的情形；审计行 `forced: true`。
- 从未激活且已无活跃成员资格的残留用户（例如已 `remove_membership` 的），控制台用户页的"清理待激活用户"
  批量入口（`purge_user`）处理；每个 id 各自给出 `purged` / `skipped` 与原因。
- 备份里的旧 dump 不受影响（`docs/runbooks/backup-restore.md`）。

## 11. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `kernel` 起来后 `docker compose ps` 一直显示 `starting`，很久都不变 `healthy` | healthcheck 的 `start_period` 是 10s、`retries: 5`、`interval: 10s`——最长到 60s 才会判定 `unhealthy`；正常冷启动（尤其是 postgres 刚建库、还没跑迁移）可能确实需要这么久 | 等到 60s 再判断；若之后仍不健康，`docker compose logs kernel` 看是否是数据库连接失败或迁移未跑 |
| 改了 `secrets/*.env` 之后重启了服务，行为看起来还是旧值 | 用了 `docker compose restart` 而不是 `--force-recreate`（§4.2） | `docker compose up -d --force-recreate <service>` |
| `docker compose logs <service>` 什么都看不到，或只有很少几行 | 容器刚被 `--force-recreate` 过（旧容器的日志随旧容器一起没了），或该服务本身就没有多少输出（如 `egress-proxy`/`llm-proxy` 空闲时几乎不打印） | 正常；需要持续观测时用 `docker compose logs -f`，从这次重建之后开始跟随 |
| `caddy` 起来了，但 `/api/*` 反代一直 502 | `caddy` 的 `depends_on: kernel` 只保证启动顺序，不等待 kernel 的健康检查（compose 定义如此——`kernel` 有 `condition: service_healthy` 边，`caddy` 自己那条也是，见 `docker-compose.yml`，实际仍可能出现短暂窗口） | 重试几次；若持续 502，按 §5 单独验证 `kernel` 是否真的 `healthy` |
| 想看 Prometheus 风格的指标面板，发现没有任何端点 | 见 §7——设计文档 §12 的指标体系尚未实现，这不是本次文档遗漏，是代码现状 | 用 §7 表格里的 SQL/capability 近似替代；若确实需要真正的指标端点，那是一项新的实现任务（development-tasks.md S3.8），不是本 runbook 能补的文档缺口 |
| 目标主机上跑 `make migrate` 报 `corepack`/`pnpm` 不存在 | 目标主机通常没有 Node/corepack（`docs/runbooks/accept-s1.md` §1） | 用容器化命令 `docker compose run --rm --no-deps -T kernel node dist/cli/migrate.js`（见 §4.1）；`make migrate` 只在装了 Node/corepack 的机器（如开发机、CI）上直接可用 |
| `docker compose run --rm --no-deps -T kernel node dist/cli/migrate.js` 报找不到该文件 | `kernel` 镜像还没构建，或构建的是旧代码 | `docker compose build kernel` 后重试 |

## 12. 供应商管理（S6-B / S7-A）

`docs/console-completion-plan.md` §5.4 / §6；`docs/platform-admin-design.md` §6.2；`docs/STATUS.md`
维护者决定（2026-09-22）① 控制台写供应商密钥不走审批 / ⑤ 不改 `${NEXTTIME_DATA}/config/` 属主。平台页
「模型与供应商」（`#/platform/models`，仅管理员）管理 llm-proxy 里的供应商：名称、API 种类
（`openai-completions` / `openai-responses` / `anthropic-messages`——Gemini 走其 OpenAI 兼容端点，§12
第 2 项）、Base URL、鉴权头、密钥环境变量名（可选，见下）、模型清单与显示名、启用；「测试调用」= 一次
补全 **+ 一次强制工具调用往返**；密钥可在详情抽屉里直接设置/更换/清除。

**路径**：浏览器 → caddy `/api/llm-admin/*`（`deploy/caddy/Caddyfile`，去掉前缀后改写为 llm-proxy 的
`/admin/*`，边缘先要求 `X-Requested-With: nexttime`）→ llm-proxy 管理端点（`packages/llm-proxy/src/admin-api.ts`）。
鉴权是内核 `issue_llm_admin_token` 签发的 5 分钟平台 JWT（Handle 密钥签名，`typ` / `aud` 不同——Handle 永远进不了
管理端点，管理令牌也永远不是 Handle）。内核只签令牌、只记审计，**不存供应商记录、不见密钥**。

**三处状态**：

| 主机路径 | 容器内 | 内容 | 谁写 |
|---|---|---|---|
| `${NEXTTIME_DATA}/llm-proxy/providers.json` | `/data/state/providers.json`（rw） | 控制台写入的供应商（`provider-store.ts`，原子写：`.tmp` + rename） | llm-proxy（uid 10001） |
| `${NEXTTIME_DATA}/llm-proxy/keys.json` | `/data/state/keys.json`（rw，mode 0600） | 控制台写入的供应商密钥（`key-store.ts`，S7-A，按 provider id）——**从不出现在响应 / 日志 / 审计里** | llm-proxy（uid 10001） |
| `${NEXTTIME_DATA}/config/llm-providers.yaml` | `/data/config/llm-providers.yaml`（**ro**） | 操作员的基础配置，不变 | 操作员 |
| `${NEXTTIME_DATA}/models/models.json` | `/data/models/models.json`（`models/` 目录 rw） | 合并目录（yaml + store，仅启用的），每次变更后原子重写 | llm-proxy 与 `make gen-models` |

`models.json` 自 S7-A 起单独一个目录（不再挂在 `config/` 下）——维护者决定 ⑤ 不给 `${NEXTTIME_DATA}/config/`
换属主，所以 llm-proxy 原子重写的目标挪到它自己能拿到写权限的 `${NEXTTIME_DATA}/models/`（`host-env-init.sh`
创建，0755，归 10001）；这也顺带避免了内核 / worker-supervisor 因为要读 `models.json` 而被迫挂进
`llm-proxy/`（那个目录现在还多了 `keys.json`）。

合并规则按名字：store 条目**整体**覆盖同名 yaml 条目（页面来源列显示「覆盖 yaml override」）；yaml 条目永远
视为启用，「停用」一个 yaml 供应商就是写一条 `enabled:false` 的覆盖；删除覆盖 = 恢复 yaml 条目；纯 yaml
条目不能在页面删除（409 `provider_from_file`，改 yaml）。`admin` / `healthz` / `internal` 是保留名。

**一次性主机步骤**（新目录；否则页面每次写入 503 `store_unwritable`，或 models.json 重写失败并在列表里以
`modelsJsonError` 显示）：

```bash
set -a; . ./.env; set +a
sudo -E sh scripts/host-env-init.sh                        # 幂等；补建 models/（0755，归 10001）
sudo -E sh scripts/host-llm-proxy-init.sh                   # mkdir+chown llm-proxy/ 归 10001（providers.json / keys.json）
export KERNEL_VERSION="$(git describe --tags --abbrev=0) ($(git rev-parse --short HEAD))"   # release.md §3.1
docker compose build kernel llm-proxy caddy                # kernel：新能力 + 两条内部路由 + 新挂载；caddy：新路由 + 新页面
docker compose up -d kernel                                # 无新迁移；等 healthy（§4.1）
docker compose up -d --force-recreate llm-proxy            # 新挂载 + 新环境变量（restart 不重读，§4.2）
docker compose up -d caddy                                 # 新镜像（Caddyfile 是 bind mount，但页面在镜像里）
```

不重建 kernel 的后果：页面 `issue_llm_admin_token` 返回 `not_found`，llm-proxy 的预算轮询与审计回写一直 404；
`list_models`/`list_platform_models` 仍读旧的 `/data/config` 挂载，找不到 `models.json`。

`${NEXTTIME_DATA}/config/` **不再**因为供应商管理而改属主（S7-A 维护者决定 ⑤，取代了 S6-B 原来"把 config/
属主改成 10001"的方案；`host-llm-proxy-init.sh` 现在只 chown `llm-proxy/`）。容器内 `llm-providers.yaml`、
`handle.pub`、`egress-sources.json`、`ontology/` 仍以 `:ro` 单独挂载（不再是"整体 rw 目录 + ro 覆盖"的嵌套
挂载技巧）——llm-proxy 的写面现在是 `llm-proxy/`（providers.json、keys.json）与 `models/`（models.json）两个
独立目录，`config/` 全程只读。

**密钥（S7-A，2026-09-22 维护者决定 ①：不走审批，优先可用性）**：控制台现在可以直接写供应商密钥——详情
抽屉里的密钥表单：设置 / 更换是普通提交（不需要二次确认），清除走 `ConfirmTier` 的 `medium` 级（一次点击
确认，不需要重新输入密钥）。解析顺序：**控制台密钥 → `apiKeyEnv` 指向的环境变量 → 无**（同一优先级用于
真实转发请求、「测试调用」与页面显示的 `credentialSource`）。密钥环境变量名现在是**可选**字段——纯控制台
密钥的供应商可以完全不配置它。传统路径仍然可用（会被控制台密钥覆盖）：

```bash
# 主机上，追加一行到 secrets/llm-proxy.env（变量名 = 页面里该供应商的 apiKeyEnv，若配置了的话）
ACME_API_KEY=...
docker compose up -d --force-recreate llm-proxy   # §4.2：restart 不重读 env_file
```

接口：`PUT /api/llm-admin/providers/:id/secret {key}`（设置/替换；`POST` 同义，兼容原设计）、
`DELETE /api/llm-admin/providers/:id/secret`（清除，回退到环境变量或无）。密钥值**从不**出现在任何响应、
日志行、错误信息、审计记录或 `models.json` 里——`models.json` 自己的 `apiKey` 字段永远是字面模板字符串
`$CAPABILITY_HANDLE`，从不是真实密钥。密钥未配置时「测试调用」被拒绝（409 `credential_missing`），不会
向上游发空头。密钥写入 / 清除**不**重写 `models.json`（内容不受密钥影响）。

**`make gen-models` 的关系**：仍然可用，且 `cli/gen-models.ts` 现在也合并 store（`docker compose run` 复用同一
服务定义，`/data/state` 同样挂着），输出与代理自己重写的一致；不再会把控制台加的供应商丢掉。llm-proxy
**启动时不写** models.json（只在不一致时记一行 warn 日志）——验收覆盖 `deploy/accept/docker-compose.fake.yml`
把它的 yaml 换成假 provider，必须不能覆盖生产 models.json。改了 yaml 仍需重建 llm-proxy（yaml 不热加载）+
`make gen-models`（或在页面里随便保存一个供应商，也会重写）。

**审计（只增不减）**：每次变更两条记录——llm-proxy 自己的 `level: "audit"` 结构化日志行（`docker compose logs
llm-proxy | grep '"level":"audit"'`），和内核平台审计一行（llm-proxy 经内部面 `POST /internal/llm-admin-audit`
写入，动作 `platform.llm_provider_created / _updated / _deleted / _tested / _secret_set / _secret_cleared`，
`resourceType: llm_provider`），两者都带令牌的 `jti`，与 `issue_llm_admin_token` 留下的
`platform.llm_admin_token_issued` 行对得上；均不含密钥。`report-usage.sh --by provider` 按 provider / model
汇总用量（§5.4 验收）。

**遗留 19（I18「100% 时代理返回预算耗尽错误」）**：llm-proxy 每 `BUDGET_SYNC_INTERVAL_MS`（缺省 15 s）拉一次
`GET /internal/llm-budget-exhausted`——内核列出今天（UTC）已超 `task.daily_cost_budget_usd` 配额（jsonb 数字；
`null` = 不限）或 `LLM_DAILY_TOKEN_BUDGET` 的工作区——对这些工作区的每次补全在验证 Handle 后、接触上游前直接回
**402 `budget_exhausted`**（body 含 `scope` / `budget` / `spent` / `resetsAt`；用 402 不用 429 是因为两家 SDK 都会
对 429 自动重试）。每行带 `until`（下一个 UTC 零点），内核不可达时代理沿用上次集合但到点自动放行。内核事后止损
（Task `failed: budget_exhausted` + 撤销 Handle → 401）仍是兜底。

| 现象 | 原因 | 处理 |
|---|---|---|
| 页面顶部「状态目录不可写」 / 写入 503 `store_unwritable` | `${NEXTTIME_DATA}/llm-proxy` 不存在或不归 10001（Docker 代建的是 root） | 运行 `scripts/host-llm-proxy-init.sh`，`--force-recreate llm-proxy` |
| 保存成功但列表显示 `modelsJsonError: EACCES` | `${NEXTTIME_DATA}/models` 不存在或不归 10001（Docker 代建的是 root） | 重跑 `scripts/host-env-init.sh`，`--force-recreate llm-proxy`；临时用 `make gen-models` 手动重写 |
| 「测试调用」409 `credential_missing` | 该供应商既没有控制台密钥，`apiKeyEnv`（若配置了）在 `secrets/llm-proxy.env` 里也没设 | 在详情抽屉设置控制台密钥，或加一行环境变量并 `--force-recreate llm-proxy` |
| 测试：补全 ok、工具调用 error | 上游不支持函数调用 / 该模型不支持 `tool_choice` | Worker 与门工具依赖工具调用，换模型或换端点；补全 ok 只说明鉴权与路由对了 |
| 新供应商在工作区「模型与配额」里看不到 | models.json 未重写（见 `modelsJsonError`）或浏览器缓存 | 刷新平台页看 `models.json 已于 … 重写`；内核每次调用都重读该文件，无需重启 |
| `/api/llm-admin/*` 403 | 缺 `X-Requested-With` 头（非控制台调用） | 只有控制台会调这些端点；脚本化管理请用 `issue_llm_admin_token` 拿令牌并带上该头 |
| `/api/llm-admin/*` 401 `token_expired` | 令牌 5 分钟到期 | 控制台自动重取一次；持续 401 检查 caddy → llm-proxy 与 `config/handle.pub` 是否同一密钥对 |
| 从旧版本升级后密钥表单一直显示「待配置」 | 主机仍是升级前的目录布局（`models.json` 还在 `config/` 下） | 按 `docs/runbooks/release.md` §3.2 做一次性目录迁移 |

## 13. 运行层（S7-E，P-C；docs/platform-admin-design.md §6.5 / §6.7）

`docs/development-tasks.md` §5d S7-E。本节是**后端车道**（S7-E-backend）落的能力——`runtime_inventory` /
`list_runtime_images` / `set_active_runtime_image` / `rollback_runtime_image` / `roll_entry_containers` /
`pi_drift` / `platform_status`（`application/platform/runtime.ts`），均 `scope:'platform'`、仅管理员。**页面
（"运行层" / "运行状态"）是后续车道（S7-E-page），本节给的是能力本身与 `curl` 调用方式**——在页面落地前，
这是唯一的操作入口。

**构建镜像仍在主机 / CI**（已否决在页面里构建，design §11）：

```bash
export PI_VERSION="$(cat pi.version)"
export PLATFORM_EXTENSION_VERSION="$(node -p "require('./packages/platform-extension/package.json').version")"
export BUILT_FROM="$(git describe --tags --abbrev=0) ($(git rev-parse --short HEAD))"
docker compose build worker-runtime   # 打 ai.nexttime.pi-version / platform-extension-version / built-from 三个 label
```

**调用方式**（`scope:'platform'`：登录拿 cookie，不带 `X-Workspace-Id`——见 `web-console.md` §"凭证"）：

```bash
COOKIE=$(curl -s -i https://<host>:8443/api/auth/login \
  -H 'content-type: application/json' -H 'X-Requested-With: nexttime' \
  -d '{"login":"admin","password":"<密码>"}' \
  | grep -i '^set-cookie:' | sed -E 's/^[Ss]et-[Cc]ookie: ([^;]+);.*/\1/')

cap() { # $1 = capability 名, $2 = JSON 参数（缺省 {}）
  curl -s https://<host>:8443/api/cap/"$1" \
    -H "cookie: ${COOKIE}" -H 'X-Requested-With: nexttime' -H 'content-type: application/json' \
    -d "${2:-{}}"
}
```

**盘点**（`runtime_inventory`）：活动镜像（设置值，或未设时 worker-supervisor 自己的 `WORKER_IMAGE` env 缺省，
`activeImageSource: "setting" | "env_default"`）、镜像清单（`list_runtime_images`，只列带上面三个 label 的
镜像）、每个入口容器（用户、工作区、启动时间、是否空闲 `lastTouchedAt`）及其 `needsRebuild`：

```bash
cap runtime_inventory | jq '{activeImage, activeImageSource, images: [.images[]|.tags], residentContainers}'
```

**"待重建"是什么（决定 E2）**：`needsRebuild` 比较的是**镜像 id**（`docker inspect` 的 `Image`/`Id` 字段，
`sha256:...`），不是 tag——这些镜像从不推到 registry，同一个 tag 重新构建也会换一个 id，只比 tag 会漏判。
派生是**实时**的（每次调用现算，never 存表），不建任何"待重建"状态列。

**滚动重建不是"拒绝新 Turn"（决定 E2）**：入口容器在自己的**下一次** Turn 开始时，`spawn()` 发现请求的镜像
和容器当前标签不一致就自然重建（跟 Handle 轮换、Skill 集合变化走同一条"规格漂移重建"逻辑）——正在进行的
Turn 不受影响。**没有 draining 状态**，也不会拒绝新 Turn；只有测试证明存在缝（例如"待重建"的容器长期无人
发言）才会加更强的机制，S7-E 尚未加。

**设为活动镜像 / 回滚**：

```bash
cap set_active_runtime_image '{"image":"nexttime-ai-worker-runtime:<tag或digest>"}'   # 必须在 list_runtime_images 里，否则 409 image_not_in_inventory
cap rollback_runtime_image                                                             # 改回上一个 platform_settings 版本的值；无历史则 409 no_previous_settings_version
```

设置本身立即生效于*之后*的 spawn（design §8）；已运行的入口容器按上一段"下一次 Turn 自然重建"收敛。

**`roll_entry_containers`（加速项，仅此而已）**：只停"待重建 **且** 内核自己的 Turn 台账（`activities`
`kind='agent_turn' and status='running'`）里没有进行中 Turn"的容器；忙的容器永远跳过（`skipped_in_flight`），
已经最新的跳过（`skipped_up_to_date`）。不给参数 = 处理当前每一个"待重建"的容器；给 `principalIds` 只处理
这些：

```bash
cap roll_entry_containers                                   # 全部待重建且空闲的
cap roll_entry_containers '{"principalIds":["<uuid>"]}'     # 只处理这些
```

**`pi_drift`（决定 E3）**：比较 `pi.version`（仓库锁定值）与活动镜像自带的 pi 版本 label；`pinnedPiVersion`
读一个 CI 产出的静态 JSON（**不出网**，见 `application/platform/runtime.ts` 顶部注释）——本仓库当前的
`.github/workflows/pi-drift.yml`（nightly，检查 pi@latest 是否破坏测试）**还没有**产出这个文件，所以
`status` 现在总是 `"unknown"`。落地路径（未来工作，不在本车道）：`PI_DRIFT_FILE` env（缺省
`/data/config/pi-drift.json`，走已有的 `config:ro` 挂载），内容 `{"pinnedPiVersion":"0.84.4","checkedAt":"<ISO>"}`。

**`platform_status`（决定 E4）**：内核直接探测（2 秒超时）`llm-proxy` / `worker-supervisor` 的 `/healthz`；
`egress-proxy` 的 healthz 按设计是 loopback-only（隔离边界，`packages/egress-proxy/src/index.ts`），**不探测**，
固定报 `unknown`；门实例健康读的是已有的 `list_gate_instances` 最近一次检查结果，不重新探测；30 天跨工作区
`llm_usage` 汇总（成本 + token）；最近 50 条平台审计。`backup` 字段如实报"未配置"——遗留 6 落地前没有备份
定时器，这不是缺陷。

```bash
cap platform_status | jq '{health, backup, llmUsage30d}'
```

| 现象 | 原因 | 处理 |
|---|---|---|
| `set_active_runtime_image` 返回 409 `image_not_in_inventory` | 镜像没建，或建的 tag/digest 和传的不一致 | 先 `list_runtime_images` 核对，再 `docker compose build worker-runtime`（记得先 export 三个版本变量） |
| `rollback_runtime_image` 返回 409 `no_previous_settings_version` | `platform_settings` 从未写过第二次 | 正常——第一次设置活动镜像后没有"上一个值"可回滚 |
| `runtime_inventory` 里 `activeImageInfo` 是 `null` | 活动镜像的 tag/digest 不在 `list_runtime_images` 里（自定义镜像没打三个 label，或 worker-supervisor 连不上） | 检查镜像是否带 `ai.nexttime.*` label；`residentContainers[].needsRebuild` 此时恒为 `false`（不猜） |
| `platform_status.health` 里 `llm-proxy` / `worker-supervisor` 是 `down` | 服务没起，或内核到不了 `KERNEL_LLM_URL` / `SUPERVISOR_URL` | `docker compose ps`；确认内核与这两个服务同在 `control` 网络 |
| `roll_entry_containers` 全是 `skipped_in_flight` | 用户确实在用 | 符合预期——加速项不抢占正在进行的 Turn；等 Turn 结束，或等其自然下一次 spawn 收敛 |

## 14. 模块管理（P-B2b）

`docs/platform-admin-design.md` §6.4；`docs/development-tasks.md` §5d S7-D。**模块 = 一个版本化的
领域包**——`ontology/<pack>-v<N>.yaml`（`add-domain-pack.md` 讲的同一种文件），外加 `ontology/modules.yaml`
这一份索引给它的每个版本记一行 `{file, version, notes, breaking}`。平台页「模块」（`#/platform/modules`，
仅管理员）按这份索引列出本部署带的模块、装到了几个工作区、哪些工作区有新版可用，并设「默认模块」
（新建工作区自动装哪些）；工作区 owner 在自己的「能力目录 → 模块」标签页里装 / 升级。

**这与 `add-domain-pack.md` 的关系**：那份手册讲的 `seed-domain-pack` CLI（主机 `config/ontology/`，
`DOMAIN_PACK_DIR`）是操作员手动往**某一个**工作区塞一个领域包的旁路，不经过 `ontology/modules.yaml` 这份索引，
控制台的「模块」页也看不到它（除非它恰好按哈希匹配上索引里的某个版本，见下）。凡是要出现在「模块」页、
能被 owner 在控制台里点「安装 / 升级」的领域包，都必须走本节——进 `ontology/modules.yaml` 并随镜像发布。

**"已安装版本" 怎么判定**：内核不存哈希，每次调用都现算——对索引里每个版本的文件跑与发布时相同的
`parseOntologyDefinition`，键排序规范化后 sha256；工作区当前发布的定义算出的哈希，能对上索引里哪个版本就是
哪个版本，对不上算「已定制」。这意味着**改一个版本号对应的文件内容，等价于让所有已装这个版本的工作区
立刻变成「已定制」**——不要这样做；要改内容，发布成新版本号。

**两套版本号，不要混用**：`ontology_versions.version` 是每个工作区自己的发布计数（每 `publish` 一次 +1，
同内容重复发布也占号），和 `modules.yaml` 里模块自己的版本号是两回事——控制台「已装版本」显示的永远是
按哈希匹配到的**索引**版本号（对不上任何索引版本就是「已定制」，不显示数字）。`install_module`/
`upgrade_module` 都是**直接发布到最新索引版本**（一次调用一次发布，不会先装 v1 再一级一级升级）；从当前
已装版本到最新版本之间只要有一个 `breaking: true`，不管是不是最新版本本身，都需要 `confirm: true`。

### 14.1 加一个模块的新版本

```bash
# 1. 写新版本文件（identityKey / linkType domain-range 等，见 add-domain-pack.md §2）
cp <pack>-v3.yaml ontology/<pack>-v3.yaml

# 2. 在 ontology/modules.yaml 给这个 family 追加一行（版本号紧接上一个，不建议跳号——
#    install_module/upgrade_module 总是直接发布到最新版本，不逐级走，跳号本身不影响功能，
#    只是容易让人误以为中间版本被撤回了）
#    - file: <pack>-v3.yaml
#      version: 3
#      notes: 这版加了什么、owner 升级前要注意什么
#      breaking: true   # 已有的 ObjectType/LinkType 形状变了，旧 Fact/Link 不一定还满足，
#                        # owner 从任何早于这版的已装版本升级到（或跨过）这版都需要 confirm；
#                        # 新增内容不影响旧数据就填 false

# 3. 重建并滚动 kernel（镜像内 ontology/ 是这两个文件的唯一来源，DOMAIN_PACK_DIR 无关）
docker compose build kernel
docker compose up -d kernel   # 无新迁移；等 healthy（§4.1）
```

不重建 kernel 的后果：`list_modules` / `list_workspace_modules` 仍按旧镜像里的 `ontology/` 回答，新版本对
控制台不可见，`install_module`/`upgrade_module` 目标该版本会 404 `module_not_found`。

**首次给一个全新 family 建模块**：`ontology/modules.yaml` 加一条 `name` 全新的条目，`versions` 只有一条
`version: 1`（`breaking` 随意——D3：v1 永远不需要 confirm，没有更早的版本可破坏）；同上重建 kernel。

### 14.2 设默认模块

平台页「模块」每行一个「默认安装」勾选框，勾上即调用 `set_default_modules`（立即生效，仅对**之后新建**的
工作区）——`create_workspace` 在同一事务里以新 owner Principal 把每个默认模块装到它**当前的最新索引版本**
（先例见 `create.ts` `seedPlatformMetaOntology` 那段）。已存在的工作区不受影响，也没有批量补装的入口——
owner 自己在能力目录里点。

### 14.3 验证

```bash
# 1. 索引与哈希对得上（本机跑单测，不需要数据库）
pnpm --filter @nexttime/kernel exec vitest run src/application/platform/modules.test.ts

# 2. 控制台：平台页「模块」能看到新版本 + notes + breaking 标记；某工作区的能力目录「模块」标签页
#    显示「有新版」，点升级：非 breaking 直接过，breaking 或该工作区「已定制」会先弹确认（ConfirmTier）
```

### 14.4 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 新版本在「模块」页看不到 | 没重建 kernel（镜像内 `ontology/` 才是来源），或 `modules.yaml` 版本号跳号（校验会在 `list_modules` 时抛 `ModuleIndexParseError`，模块整体从列表消失） | `docker compose build kernel && docker compose up -d kernel`；检查 `modules.yaml` 该 family 的 `version` 是否从 1 连续 |
| `install_module`/`upgrade_module` 返回 400 `module_confirm_required` | 该工作区当前是「已定制」，或从当前已装版本到最新版本之间（含最新版本本身）存在 `breaking: true` 的版本——升级会直接跳到最新版本，中间跨过的 breaking 版本也算 | 页面会弹确认（notes / 当前状态 / 目标版本），带 `confirm: true` 重试；CLI/脚本同理自己带上 `confirm: true` |
| 升级后版本号（`installedVersion`）没变 | 目标（最新）版本文件内容与当前已装内容完全一致（哈希相同）——D3 的去重，`ontology_versions` 不新增一行 | 预期行为，不是 bug；要真正推进，改文件内容后发布成新的索引版本 |
| 一个工作区显示「已定制」 | 有人绕过 `install_module`/`upgrade_module`，直接用 `propose_ontology_change`/`publish_ontology_version` 发到了这个模块 family 的 id（`deriveOntologyPackId(name)`），或同一索引版本的内容被重复发布导致 `ontology_versions.version`（DB 发布计数）与索引版本号不再一一对应——两者本来就是两套编号，见 §14 开头 | 预期能检测到的情况，不是错误；「已装版本」显示的是按哈希匹配到的**索引**版本（匹配不上就是 `null`/已定制），不是 `ontology_versions` 的行号；owner 升级时会被要求 confirm |
