# Runbook：host-gatekeepers（`docker` / `ragflow` 门实例主机验收）

对应任务：development-tasks.md § S2.5（`gatekeepers/docker`、`gatekeepers/ragflow` 两个预置门实例
+ `docker-compose.yml` 的 `gatekeeper-docker`/`gatekeeper-ragflow` 服务）。占位符取值见
`docs/private/`（不入库）。新增一个本仓库还没有的接入包（第三方系统），走通用步骤，见
`docs/runbooks/add-gatekeeper.md`。

前置：E1–E4（数据目录已建、`.env` 已生成、Postgres 已起）；`scripts/host-bootstrap.sh` /
`scripts/host-env-init.sh` 已跑过且是**这次 S2.5 改动之后的版本**（新增了
`${NEXTTIME_DATA}/gatekeepers/{docker,ragflow}` 目录与 `secrets/gatekeeper-ragflow.env` 的新占位
变量名 `RAGFLOW_BASE_URL`/`GATE_CREDENTIAL_RAGFLOW_API_KEY`——如果这台主机是用旧版本的脚本初始化
的，重新跑一次这两个脚本，幂等，不会破坏已有数据）；`kernel` 容器已起且能连 Postgres（S2.4 已合
并——`packages/gatekeeper-base` 与 kernel 侧 `governance/gatekeepers`/`adapters/gatekeeper-client`
就位）；`scripts/gen-handle-keys.sh` 跑过且是 **fix/gate-protocol-hardening 之后的版本**（额外生成
`${NEXTTIME_DATA}/secrets/gate.token`）——如果这台主机在此之前跑过旧版本，重新跑一次同一个脚本
（幂等，只补 `gate.token`，不动已有的 `handle.key`/`internal.token`）。**`.env` 里的 `DOCKER_GID`
不再是 `gatekeeper-docker` 的前置条件**（fix/gate-docker-socket-proxy，见下方同名段落）——留着不
影响，删不删都行。

**fix/gate-docker-socket-proxy**：`gatekeeper-docker` 不再直接挂载 `/var/run/docker.sock`——
`docker-compose.yml` 新增了专用的第二个 `docker-socket-proxy-gate` 服务（独立的 `dockerapi-gate`
网络，与 `agent-host`/`worker-supervisor` 共用的 `docker-socket-proxy`/`dockerapi` 互不相通），
`gatekeeper-docker` 现在经 `DOCKER_HOST=tcp://docker-socket-proxy-gate:2375` 访问 Docker Engine
API；`group_add`/`DOCKER_GID` 已从这个服务的配置里去掉。`docker compose up` 里 `gatekeeper-docker`
现在 `depends_on: docker-socket-proxy-gate（service_healthy）`，正常 `docker compose up -d
gatekeeper-docker` 会自动先把代理带起来，不需要手动分两步——下面单独列出的顺序仅用于**从旧版本
（直连 socket）切换到这个版本**时验证切换本身生效，不是每次启动都要做的手动步骤：

```bash
cd <CODE_DIR>
git pull   # 或 git checkout 本 fix 分支
set -a; . ./.env; set +a

# 1. 先起新代理（即使不手动跑这一步，下一条命令的 depends_on 也会自动带起它）
docker compose up -d docker-socket-proxy-gate
docker compose ps docker-socket-proxy-gate   # 期望 healthy

# 2. 重新起 gatekeeper-docker（--force-recreate：确保用的是新镜像 + 新 compose 配置，不是复用旧容器）
docker compose up -d --force-recreate gatekeeper-docker

# 3. 验证：容器里已经没有 docker.sock 的挂载了
docker inspect gatekeeper-docker --format '{{json .Mounts}}' | grep -c docker.sock
# 期望：0（旧版本这里会输出 1，形如 [{"Type":"bind",...,"Source":"/var/run/docker.sock",...}]）

# 4. 验证：/gate/health 仍然 200（换了传输层，协议行为不变）——见 §3 的 curl 例子，这里先拿 token
GATE_TOKEN=$(cat "${NEXTTIME_DATA}/secrets/gate.token")
docker compose exec -T kernel node -e "
fetch('http://gatekeeper-docker:8083/gate/health', {headers:{authorization:'Bearer ${GATE_TOKEN}'}}).then(r=>r.text()).then(t=>console.log('docker:',t))
"
# 期望：{"ok":true,"result":{"status":"ok"}}
```

第 4 步之后再验证一次真实的 `container.restart` 生效：要么走 `scripts/accept_s2.sh`（S2.12 step 2/4
——step 2 是"聊天里说'重启测试容器' → entry agent → invoke_worker → 审批卡 → 执行"这条链路，step 4
是同一批验收里对 Worker 断言的 Fact 复核，见该脚本 `connections_step`/相关注释),要么直接走本
runbook §7 手工那一遍（对自建的 `nexttime-gate-test` 容器 `request_action(container.restart)` +
`approve` + 核对 `StartedAt` 变化）——两条路径验证的是同一件事：**门通过新代理也能真的重启容器**，
选哪条取决于这台主机上 accept-s2 fixture 是否已经起了。

**回滚**：`git revert` 这个 fix 的提交（或切回旧分支）后 `docker compose up -d
--force-recreate gatekeeper-docker`——旧版本的 compose 文件里 `gatekeeper-docker` 恢复直接挂载
`/var/run/docker.sock` + `group_add: ["${DOCKER_GID:-999}"]`，`.env` 的 `DOCKER_GID` 需要重新是本
机真实的 `docker` 组 gid（`stat -c '%g' /var/run/docker.sock`）；`docker-socket-proxy-gate` 容器可
以留着不管（`docker compose down docker-socket-proxy-gate` 清理，非必需——它不是 `gatekeeper-
docker` 以外任何服务的依赖）。

**fix/gate-protocol-hardening（P1-1）**：`/gate/*` 的每一个路由现在都要求
`Authorization: Bearer <token>`（`@nexttime/gatekeeper-base` 的 `gate-auth.ts`；缺失或错误的
token → 401 `{"ok":false,"error":{"code":"unauthorized","message":"unauthorized"}}`）。四个门服务
（`gatekeeper-docker`/`gatekeeper-ragflow`/`accept-s2-ssh-gate`/`accept-s2-http-gate`）都从
compose secret `gate_token`（`${NEXTTIME_DATA}/secrets/gate.token`）读取自己的校验副本，容器内默
认路径 `/run/secrets/gate_token`；本 runbook 从 §3 起所有直接打 `/gate/*` 的 `fetch()`/`curl` 例子
都要带这个头——本节起把它取到 shell 变量里：

```bash
GATE_TOKEN=$(cat "${NEXTTIME_DATA}/secrets/gate.token")
```

`kernel` 自己的 `HttpGatekeeperClient`（`register-gatekeeper`、`request_action` 等经内核治理路径
的调用）已经自动带这个头，不需要手动传——只有本 runbook 里**绕过内核、直接打门自己的协议端点**的
例子（§3 的 health/describe_operations 探活、§8 的幂等复核）需要手动加 `authorization` 头。

**不做**：不对现有业务容器 `execute`（`container.restart`/`compose.up`/`compose.down`）——§4 起、
§6 全程操作的是本 runbook 自己创建的测试容器 `nexttime-gate-test`，除它之外不要对任何其它容器跑
这几个 execute 类 Operation。

## 1. 目的

验证两件事：① `gatekeeper-docker`/`gatekeeper-ragflow` 两个镜像能构建、起服务、`/gate/health`
与 `/gate/describe_operations` 可达；② `bootstrap.js register-gatekeeper` 这条主机操作员的手工
注册路径能把一个门实例注册进图、导入并发布它的 Operation 清单，随后从 owner 的 human 通道
`request_action` 走一遍完整的 observe / execute（含审批）/ 幂等 apply 流程。S2.13 落地后新增的
capability 驱动流程（`request_connection` 卡片 → `create_connection` → `connect_gatekeeper`）见
§10，两条路径并存——§5/§10 的区别、什么时候用哪条，见§10 开头一段。

不含：`gatekeeper-ragflow` 对一个真实 RAGFlow 实例的端到端验收（本机大概率没有可用的 RAGFlow 部署
——§7 只验证服务能起、清单能注册，不要求真实调用其 REST API 成功）。

## 2. 构建镜像

```bash
cd <CODE_DIR>
git fetch origin
git checkout task/s2-5-docker-ragflow-gates
docker compose build gatekeeper-docker gatekeeper-ragflow
docker image inspect nexttime-ai-gatekeeper-docker --format '{{.Id}}' 2>/dev/null || \
  docker compose images gatekeeper-docker   # 镜像名由 compose 项目前缀决定，用后一条确认实际 tag
```

## 3. 起两个门服务

```bash
cd <CODE_DIR>
set -a; . ./.env; set +a
docker compose up -d gatekeeper-docker gatekeeper-ragflow
docker compose ps gatekeeper-docker gatekeeper-ragflow
```

`gatekeeper-ragflow` 需要 `${NEXTTIME_DATA}/secrets/gatekeeper-ragflow.env` 里
`RAGFLOW_BASE_URL`/`GATE_CREDENTIAL_RAGFLOW_API_KEY` 有值才能真正连上一个 RAGFlow 实例——本机若
没有可用的 RAGFlow 部署，容器仍会正常起（这两个值只在真正发起 HTTP 调用时才用到），`describe_
operations`/`health` 不需要它们生效。两个服务的 `/gate/*` 协议端口都只在 `control` 网络上暴露
（`gatekeeper-docker` 额外还在 `dockerapi-gate` 网络上，那是它和 `docker-socket-proxy-gate` 之间
的私有通道，不影响这一点——compose 都没有发布任何主机端口），从主机 `curl` 不到；用 `kernel` 容器
自带的 Node `fetch()`：

```bash
# GATE_TOKEN was set at the top of this runbook (§1 前置之后的 fix/gate-protocol-hardening 段落).
docker compose exec -T kernel node -e "
fetch('http://gatekeeper-docker:8083/gate/health', {headers:{authorization:'Bearer ${GATE_TOKEN}'}}).then(r=>r.text()).then(t=>console.log('docker:',t))
"
docker compose exec -T kernel node -e "
fetch('http://gatekeeper-docker:8083/gate/describe_operations', {headers:{authorization:'Bearer ${GATE_TOKEN}'}}).then(r=>r.text()).then(t=>console.log(t))
"
docker compose exec -T kernel node -e "
fetch('http://gatekeeper-ragflow:8083/gate/health', {headers:{authorization:'Bearer ${GATE_TOKEN}'}}).then(r=>r.text()).then(t=>console.log('ragflow:',t))
"
```

期望：两个 `/gate/health` 都 `{"ok":true,"result":{"status":"ok"}}`；`gatekeeper-docker` 的
`describe_operations` 列出 7 个 Operation（`containers.list container.inspect compose.ls
container.logs_tail container.restart compose.up compose.down`）。

## 4. 准备一个 workspace 与 owner（若已有 S1 验收留下的可复用）

```bash
cd <CODE_DIR>
docker compose exec -T kernel node dist/cli/bootstrap.js create-workspace \
  --name "s2-5-host-check" --owner "owner"
# 记下打印的 workspace / owner / key（key 仅这一次可见）：
#   workspace created: <workspace-uuid>
#   owner principal:   <owner-uuid>
#   ...
#   <owner-api-key>
```

```bash
WORKSPACE_ID=<workspace-uuid>
OWNER_ID=<owner-uuid>
OWNER_KEY=<owner-api-key>
```

## 5. 注册 `docker` 门、导入并发布其清单

`bootstrap.js register-gatekeeper`（S2.5 新增子命令）拉该门的 `describe_operations`、把它注册成
一个 Gatekeeper 实例、把返回的每个 Operation 导入为草稿；`--publish true` 额外把每个导入的
Operation 发布（不给这个 flag 时只会留在草稿态，见 `--help` 等价的用法文字）：

```bash
docker compose exec -T kernel node dist/cli/bootstrap.js register-gatekeeper \
  --workspace "${WORKSPACE_ID}" --principal "${OWNER_ID}" \
  --name docker --endpoint http://gatekeeper-docker:8083 --kind cli --publish true
```

期望输出：

```
gatekeeper registered: <gatekeeper-uuid>
imported operations (draft): containers.list, container.inspect, compose.ls, container.logs_tail, container.restart, compose.up, compose.down
published operations: containers.list, container.inspect, compose.ls, container.logs_tail, container.restart, compose.up, compose.down
```

```bash
GATEKEEPER_ID=<gatekeeper-uuid>
```

同样注册 `ragflow` 门（`--kind http`）——即使 §3 提到的真实 RAGFlow 凭证未配置，注册/导入/发布
本身不发起对 RAGFlow 的调用，只调该门自己的 `/gate/describe_operations`：

```bash
docker compose exec -T kernel node dist/cli/bootstrap.js register-gatekeeper \
  --workspace "${WORKSPACE_ID}" --principal "${OWNER_ID}" \
  --name ragflow --endpoint http://gatekeeper-ragflow:8083 --kind http --publish true
```

## 6. `request_action(containers.list)` → observed `Container` facts

`request_action` 声明 `channel:'handle'` 但 human 通道同样放行（`application/gateway/
authorize.ts`——只有 `channel:'human'` 才排斥 handle 通道，反过来不排斥）；owner 角色对任何
`minRole` 门槛都满足，不需要额外 Grant：

```bash
docker compose exec -T kernel node -e "
fetch('http://localhost:8080/api/cap/request_action', {
  method: 'POST',
  headers: {'content-type': 'application/json', authorization: 'Bearer ${OWNER_KEY}'},
  body: JSON.stringify({ gatekeeperId: '${GATEKEEPER_ID}', operation: 'containers.list', params: { all: true } }),
}).then(r => r.json()).then(b => console.log(JSON.stringify(b, null, 2)))
"
```

期望：`{"ok":true,"result":{"status":"ok","data":[...],"observedFactCount":N}}`（`mode:'observe'`
的 Operation 不产生 ActionRequest——见 S2.4 实现说明"判定表"②）。核对图里落了 `Container` Fact：

```bash
psql "$DATABASE_URL" -c \
  "select object_type, identity_key, properties from objects where workspace_id = '${WORKSPACE_ID}' and object_type = 'Container';"
```

期望：每个宿主机上当前存在的容器各一行，`identity_key` 形如 `{"id": "<container-id>"}`，
`properties` 含 `name`/`image`/`state`/`status`。

## 7. 起测试容器，`request_action(container.restart)` 走一遍完整审批

```bash
docker run -d --name nexttime-gate-test alpine sleep 1d
docker inspect nexttime-gate-test --format '{{.Id}}'
```

```bash
GATE_TEST_CONTAINER_ID=<上面打印的完整 id>
```

```bash
docker compose exec -T kernel node -e "
fetch('http://localhost:8080/api/cap/request_action', {
  method: 'POST',
  headers: {'content-type': 'application/json', authorization: 'Bearer ${OWNER_KEY}'},
  body: JSON.stringify({ gatekeeperId: '${GATEKEEPER_ID}', operation: 'container.restart', params: { id: '${GATE_TEST_CONTAINER_ID}' } }),
}).then(r => r.json()).then(b => console.log(JSON.stringify(b, null, 2)))
"
```

期望：`{"ok":true,"result":{"status":"pending_approval","actionRequestId":"...","simulate":
{"description":"would restart container \"nexttime-gate-test\" (...)","detail":{"containers":
[...]}}}}`——`container.restart` 是 `auto_approvable:false`、`await_decision:false`，判定表⑤：
立刻返回 `pending_approval` 与 `simulate`，不等待。记下 `actionRequestId`：

```bash
ACTION_REQUEST_ID=<上面打印的 actionRequestId>
docker inspect nexttime-gate-test --format '{{.State.StartedAt}}'   # 批准前：还是刚 run 的那个时间
```

```bash
docker compose exec -T kernel node -e "
fetch('http://localhost:8080/api/cap/approve', {
  method: 'POST',
  headers: {'content-type': 'application/json', authorization: 'Bearer ${OWNER_KEY}'},
  body: JSON.stringify({ actionRequestId: '${ACTION_REQUEST_ID}' }),
}).then(r => r.json()).then(b => console.log(JSON.stringify(b, null, 2)))
"
```

批准后由 outbox consumer 异步执行（同一提交内的 `ActionRequestUpdated{approved}` 事件几乎立刻
触发，不需要等 `GATEKEEPER_DRAIN_INTERVAL_MS` 那个 1 分钟兜底 tick）；轮询 `get_action` 到
`executed`：

```bash
docker compose exec -T kernel node -e "
fetch('http://localhost:8080/api/cap/get_action', {
  method: 'POST',
  headers: {'content-type': 'application/json', authorization: 'Bearer ${OWNER_KEY}'},
  body: JSON.stringify({ actionRequestId: '${ACTION_REQUEST_ID}' }),
}).then(r => r.json()).then(b => console.log(JSON.stringify(b, null, 2)))
"
```

重复上面这条（隔 1-2 秒）直到 `result.status` 变成 `executed`。期望最终状态：`executed`；

```bash
docker inspect nexttime-gate-test --format '{{.State.StartedAt}}'   # 应已变化（真的重启了一次）
```

## 8. 幂等验证——同一 `actionRequestId` 重复 `apply` 不二次重启

第 7 步已经用 kernel 的治理路径重启过一次；这一步直接对门自己的协议端点验证"重复 `apply` 只执行
一次"（`@nexttime/gatekeeper-base` 的 `GatekeeperBase`/`JsonFileIdempotencyStore` 保证——门本身
的单元测试 `gatekeepers/docker/src/transport.test.ts` 已经用假 dockerode 覆盖了这一点，这里是
对真实门服务的端到端复核）。**注意**：再发一次 `request_action` 不是同一件事——那会产生一个
*新的* `ActionRequestId`，会再重启一次，不是幂等测试；幂等测试必须直接打门自己的 `/gate/apply`，
用同一个 `actionRequestId`（docs/wire-contract-conventions.md §1，2026-09-08 决定：字段名从
`idempotencyKey` 改为 `actionRequestId`——`idempotencyKey` 现在只留给 `request_action` 自己的
调用方去重参数）：

```bash
docker compose exec -T kernel node -e "
fetch('http://gatekeeper-docker:8083/gate/apply', {
  method: 'POST',
  headers: {'content-type': 'application/json', authorization: 'Bearer ${GATE_TOKEN}'},
  body: JSON.stringify({ operation: 'container.restart', params: { id: '${GATE_TEST_CONTAINER_ID}' }, actionRequestId: 'manual-idempotency-check-1' }),
}).then(r => r.json()).then(b => console.log(JSON.stringify(b, null, 2)))
"
docker inspect nexttime-gate-test --format '{{.State.StartedAt}}'
```

期望第一次调用：`{"ok":true,"result":{"data":{...},"observedFacts":[...],"replayed":false}}`，
`StartedAt` 相对第 7 步末尾再次变化（这次是直接打门、绕过了内核审批，允许——门本身对
`onBehalfOf`/审批状态一无所知，治理只在内核这一侧强制）。再发一次**同样的请求体**（同一
`actionRequestId`）：

```bash
docker compose exec -T kernel node -e "
fetch('http://gatekeeper-docker:8083/gate/apply', {
  method: 'POST',
  headers: {'content-type': 'application/json', authorization: 'Bearer ${GATE_TOKEN}'},
  body: JSON.stringify({ operation: 'container.restart', params: { id: '${GATE_TEST_CONTAINER_ID}' }, actionRequestId: 'manual-idempotency-check-1' }),
}).then(r => r.json()).then(b => console.log(JSON.stringify(b, null, 2)))
"
docker inspect nexttime-gate-test --format '{{.State.StartedAt}}'
```

期望第二次调用：`"replayed":true`，`data` 与第一次完全相同；`StartedAt` **不变**（没有二次重
启）——这正是 S2.5 验收原文"对自建测试容器 apply container.restart 生效且重复不重启"的字面验证。

## 9. 收尾

```bash
docker rm -f nexttime-gate-test
# 验收产物，不需要保留；仅在验收前它们不在跑时才停：
docker compose stop gatekeeper-docker gatekeeper-ragflow
```

## 10. S2.13：capability 驱动的连接流程（`request_connection` → `create_connection` → `connect_gatekeeper`）

§5 用的 `bootstrap.js register-gatekeeper` 是主机操作员的命令行路径——直接对着已经跑起来的门容器
操作，不经过任何用户/权限模型，适合"这台主机上先起服务、验证服务本身没问题"这类场景，本 runbook
从 §2 到 §9 全程用的就是它。S2.13 落地的是**同一批底层函数**（`governance/gatekeepers` 的
`registerGatekeeper`/`importManifest`/`publishOperation`）在**capability 层**的封装——`request_
connection`/`create_connection`/`connect_gatekeeper`/`list_connection_requests`（`governance/
connections`）——面向的是"某个用户（可能不是主机操作员本人）想通过对话或 web 的连接系统页接入一个
系统，owner 审核并把它授权给该用户"这个场景，走的是 kernel 的 HTTP/WS capability 接口而不是主机
上的 shell。两条路径背后是同一个 Gatekeeper 注册与清单导入实现，选哪条只取决于"谁在发起、经哪个
入口"。

本节复用 §4 建好的 workspace/owner（`WORKSPACE_ID`/`OWNER_ID`/`OWNER_KEY`），并需要一个第二个用户
（`member` 角色）——没有的话先用 `bootstrap.js add-principal` 建一个：

```bash
docker compose exec -T kernel node dist/cli/bootstrap.js add-principal \
  --workspace "${WORKSPACE_ID}" --name "member" --role member
# 记下 principal id 与 key：
MEMBER_ID=<member-uuid>
MEMBER_KEY=<member-api-key>
```

以下全部经 `POST /api/cap/<name>`（human 通道，`Authorization: Bearer <api-key>`）。`request_
connection` 与 `create_connection` 都可以用 owner 自己的 key 发起（owner 对 Handle 通道 capability
同样放行，见 §6 的既有说明）——这里演示更贴近真实场景的两步：owner 用**已经在跑的** `gatekeeper-
docker` 门容器地址完成连接，而不是像 §5 那样走 CLI：

```bash
# 1. request_connection —— 产生一张连接请求卡片
curl -s http://kernel:8080/api/cap/request_connection \
  -H "Authorization: Bearer ${OWNER_KEY}" -H 'content-type: application/json' \
  -d '{"kind":"cli","target":"docker"}'
# {"ok":true,"result":{"connectionRequestId":"<cr-uuid>","status":"requested"}}
CONNECTION_REQUEST_ID=<cr-uuid>

# 2. list_connection_requests —— owner 的连接队列里能看到这张卡片
curl -s http://kernel:8080/api/cap/list_connection_requests \
  -H "Authorization: Bearer ${OWNER_KEY}" -H 'content-type: application/json' \
  -d '{"status":"requested"}'

# 3. create_connection（本仓库对派发文字 complete_connection 的实现，见 governance/connections/
#    service.ts 头注释的命名对照表）—— 用 docker 门容器自己的地址完成这张请求；docker 门只用共享
#    env 凭证（S2.5 既有配置），credentialKind 传 'shared'，不经过 ConnectedAccount 存储
curl -s http://kernel:8080/api/cap/create_connection \
  -H "Authorization: Bearer ${OWNER_KEY}" -H 'content-type: application/json' \
  -d "{\"connectionRequestId\":\"${CONNECTION_REQUEST_ID}\",\"kind\":\"cli\",\"target\":\"docker\",\"endpoint\":\"http://gatekeeper-docker:8083\",\"credentialKind\":\"shared\"}"
# {"ok":true,"result":{"gatekeeperId":"<gk-uuid>","importedOperationNames":[...7 个...],"connectionRequestId":"<cr-uuid>"}}
GATEKEEPER_ID_2=<gk-uuid>

# 4. publish_manifest —— 一次性发布这份新导入的整份草稿清单（§5 的 register-gatekeeper --publish
#    true 等价物；也可以用 meta 分组的 publish_operation 逐条发）
curl -s http://kernel:8080/api/cap/publish_manifest \
  -H "Authorization: Bearer ${OWNER_KEY}" -H 'content-type: application/json' \
  -d "{\"gatekeeperId\":\"${GATEKEEPER_ID_2}\"}"

# 5. connect_gatekeeper —— 把这个门授予 member 的入口 agent（写一条 capability_grants）
curl -s http://kernel:8080/api/cap/connect_gatekeeper \
  -H "Authorization: Bearer ${OWNER_KEY}" -H 'content-type: application/json' \
  -d "{\"gatekeeperId\":\"${GATEKEEPER_ID_2}\",\"principalId\":\"${MEMBER_ID}\"}"
```

期望：第 3 步 `importedOperationNames` 与 §5 注册 `docker` 门时看到的 7 个 Operation 名字一致；
`docker compose exec -T kernel psql ...` 查 `capability_grants` 表能在第 5 步之后看到
`capability='gatekeeper'`、`scope->>'resourceScope'` 等于 `GATEKEEPER_ID_2` 的一行。

`connect_gatekeeper` 对 `find_operations` 的效果具体落在哪——**只影响 execute 类 Operation**（§11
"观察免审，只有 execute 受凭证门槛"，`application/task/service.ts` 的 `findOperations` 与
`findProcedures` 的 `stepUsableByCaller` 遵守同一条规则）：`containers.list`/`container.inspect`/
`compose.ls`/`container.logs_tail` 这四个 observe 类 Operation，`member` 的入口 agent 在第 5 步
**之前**就已经能通过 `find_operations` 看到（观察不需要门授权）；`container.restart`/`compose.up`/
`compose.down` 这三个 execute 类 Operation，只有第 5 步之后才会出现在 `member` 的
`find_operations` 结果里，且要等 `member` 下一次（重新）签发入口 Handle 才生效——`ensureEntryHandle`
已有的缓存策略（剩余 ttl < 10% 才重签）意味着这不是实时的，要么等自然重签、要么重启该用户的入口
容器强制刷新。

## 11. `ragflow` 门——若本机有可用的 RAGFlow 实例

§5 已注册并发布了 `ragflow` 门的清单（`kb.list kb.documents retrieve document.upload
document.parse`）。若 `${NEXTTIME_DATA}/secrets/gatekeeper-ragflow.env` 已填入真实
`RAGFLOW_BASE_URL`/`GATE_CREDENTIAL_RAGFLOW_API_KEY` 并重启过 `gatekeeper-ragflow`
（`docker compose up -d --force-recreate gatekeeper-ragflow`，env_file 改动不会自动生效），可以
同 §6 的方式跑 `request_action(kb.list)`，核对 `objects` 表出现 `object_type = 'KnowledgeBase'`
的行。本机没有可用 RAGFlow 部署时，跳过本节，§3/§5 的服务可达性 + 清单注册/发布已经是 S2.5 对
`ragflow` 门的完整交付范围；`document.upload` 的真实文件上传 + `ontology/ops-assets-v2.yaml` 见
§13（S3.4）。

### 11.1 RAGFlow 走 https 且证书自签时：用 `GATE_TLS_CA_FILE`，不要关校验

RAGFlow 的 edge（nginx）通常用一张自签证书终止 TLS，且签给某个 DNS 名（CN/SAN 里没有主机 IP）。
`gatekeeper-ragflow.env` 里**不要**写 `NODE_TLS_REJECT_UNAUTHORIZED=0`（它关掉门进程全部出向 TLS
校验）——**fix/gate-protocol-hardening 之后，这不再只是一条 warn**：门在启动阶段（读 manifest/建
transport 之前）就会检测到这个变量并直接拒绝启动（`assertTlsNotDisabled`，
`@nexttime/gatekeeper-base` 的 `tls.ts`），容器进入重启循环而不是带着关闭的证书校验静默跑起来。
正确做法是把那张证书交给门、并告诉门按哪个名字校验：

```bash
set -a; . ./.env; set +a
# 1. 从 edge 抓下证书（本机 443；改成你的 edge 地址），落到门已挂载的数据目录下
mkdir -p "${NEXTTIME_DATA}/gatekeepers/ragflow/tls"
echo | openssl s_client -connect 127.0.0.1:443 2>/dev/null \
  | openssl x509 -out "${NEXTTIME_DATA}/gatekeepers/ragflow/tls/edge.pem"
chown -R 10001:10001 "${NEXTTIME_DATA}/gatekeepers/ragflow/tls"
# 看一眼证书签给了哪个名字（SAN 里的 DNS 名）
openssl x509 -in "${NEXTTIME_DATA}/gatekeepers/ragflow/tls/edge.pem" -noout -subject -ext subjectAltName

# 2. secrets/gatekeeper-ragflow.env 里：去掉 NODE_TLS_REJECT_UNAUTHORIZED，加上
#    GATE_TLS_CA_FILE=/data/gate/tls/edge.pem        （容器内路径：数据目录挂在 /data/gate）
#    GATE_TLS_SERVERNAME=<证书 SAN 里的 DNS 名>       （RAGFLOW_BASE_URL 用 IP 时必需）

# 3. 重启门并验证：health 200；随后 §11 的 kb.list observe 应正常返回，且门日志里无 tls warn
docker compose up -d --force-recreate gatekeeper-ragflow
docker compose logs --since 1m gatekeeper-ragflow | grep -ci 'NODE_TLS_REJECT_UNAUTHORIZED'   # 期望 0
```

证书轮换后重做第 1 步并 `--force-recreate` 即可；CA 文件读不到时门拒绝启动（不会静默退回系统信任库）。
## 12. 已知偏离 / 待确认（PR 中一并说明）

- **`compose.up`/`compose.down` 是"启动/停止该 compose 项目下已存在的容器"，不是完整的
  `docker compose up/down`**：镜像里只有 `dockerode`（Docker Engine API），没有 `docker
  compose` 二进制（任务原文"no docker CLI in the image"）——不拉镜像、不创建/重建服务、不管理
  network/volume。见 `gatekeepers/docker/README.md`"compose.up/compose.down — 已知偏离"。S2.5
  验收原文只要求 `container.restart` 的幂等 apply，没有把 `compose.up`/`compose.down` 的真实语义
  列入验收范围，因此这个简化没有拿掉任何验收覆盖。
- **`document.upload` 不支持真实文件内容（S2.5；S3.4 已修复）**：S2.5 版本只能创建 RAGFlow 的
  `type=empty` 空占位文档——`HttpTransport` 只发 JSON body，RAGFlow 的真实文件上传要求
  `multipart/form-data`。S3.4 加了 `RagflowTransport`（`gatekeepers/ragflow/src/transport.ts`）
  专门处理这一个 Operation，见 §13。
- **RAGFlow 的 `{code, data}` 错误信封对协议不可见**：一次 `code != 0` 的 RAGFlow 响应会被这个
  门当成`ok:true`（HTTP 200），`observedFacts` 为空——调用方需要自己检查 `data.code`/
  `data.message`。见 `gatekeepers/ragflow/README.md`。
- **`register-gatekeeper` 与 S2.13 的 capability 流程并存，不是被取代**：`governance/gatekeepers`
  （S2.4）提供 `registerGatekeeper`/`importManifest`/`publishOperation` 服务函数；S2.13 的
  `governance/connections`（`request_connection`/`create_connection`/`connect_gatekeeper`，§10）
  确实调用的是同一批函数，而不是重新实现——见 `governance/connections/service.ts`/
  `governance/gatekeepers/registry.ts`/`manifest.ts` 的模块注释。`bootstrap.js
  register-gatekeeper` 子命令没有被移除：它是主机操作员在 shell 里直接操作、不经过用户/Grant 模型
  的路径，S2.13 的 capability 流程是面向终端用户、经 owner 审核与 `connect_gatekeeper` 显式授权
  的路径——两者服务不同的角色，§10 开头一段有更完整的对比。
- **`compose.up`/`compose.down` 的 `await_decision` 未在 S2.5 派发文字里明确给出**：本次实现
  设为 `true`（与 `container.restart` 的显式 `false` 不同）——高影响半径的操作默认走同步等待
  批准的路径，更保守；`gatekeepers/docker/manifest.json`/`README.md` 已记录这个判断。
- **`document.upload`/`document.parse` 的 `await_decision` 同理设为 `true`**：S2.5 派发文字只
  给了两者的 `blast_radius`（medium/low），未提及 `await_decision`/`auto_approvable`——沿用
  `@nexttime/gatekeeper-base`'s `importOpenApi` 对新导入 execute 类 Operation 的既有默认
  （`auto_approvable:false, await_decision:true`，owner 必须先审后发布，I17）。**S3.4**：
  `document.parse` 的 `auto_approvable` 改成了 `true`（`await_decision` 不变，仍是 `true`）——见
  §13，这份清单是手写、经过审阅的，不是 `importOpenApi` 草稿，S2.5 保留下来的保守默认在这次审阅
  后不再适用于这一个 Operation；`document.upload` 的 `auto_approvable`/`await_decision` 不变。
- **镜像构建未在本机验证**（Docker 不在这台开发机上）：`docker compose build gatekeeper-docker
  gatekeeper-ragflow`（§2）、`docker compose up`（§3）及之后所有步骤都需要在目标主机上首次跑一
  遍——这正是本 runbook 存在的原因。
- **`docker-socket-proxy-gate` 的 healthcheck/hardening 未在真实主机验证**（fix/gate-docker-
  socket-proxy，同 Docker 不在这台开发机上的限制）：`wget` 是否存在于该镜像的 userland、
  `cap_drop: [ALL]` 是否会让 haproxy 启动失败——两者都是照抄已有 `docker-socket-proxy` 服务自己已
  记录的同一条 UNVERIFIED 说明（该服务的 image/Dockerfile/entrypoint 与新实例完全相同，只是
  environment/network 不同），不是重新验证；第一个实例部署时若已经确认这两点在目标主机上没问题，
  第二个实例大概率也没问题，但仍建议 `docker compose up -d docker-socket-proxy-gate` 后单独确认
  一次 `docker compose ps docker-socket-proxy-gate` 是 `healthy` 而不是重启循环。


## 13. S3.4：`ragflow` v2 清单（真实文件上传 + `document.parse` 自动批准）+ 本体 v2 + 采集器 phase 4

`gatekeepers/ragflow/manifest.json` 的两处变化（`gatekeepers/ragflow/README.md` 有完整推理）：

- `document.upload` 现在真的把文件内容传给 RAGFlow（`?type=local` + `multipart/form-data`），不
  再是 S2.5 版本的 `?type=empty` 空占位——`RagflowTransport`（`src/transport.ts`）替这一个
  Operation 手写 multipart 请求，其余 Operation 不变。
- `document.parse` 现在 `auto_approvable: true`（`blast_radius` 仍是 `low`）——沿用 workspace
  内置的低影响半径自动批准默认（`governance/policy/engine.ts` 的
  `effectiveWorkspaceAutoApprove`），除非该 workspace 显式关闭了它。

### 13.1 验证真实文件上传

```bash
# request_action(document.upload) —— 同 §7 的完整审批流程（medium 半径，仍需人工批准）
curl -s https://<host>:8443/api/cap/request_action \
  -H "Authorization: Bearer ${OWNER_KEY}" -H 'content-type: application/json' \
  -d '{"gatekeeperId":"<ragflow-gatekeeper-id>","operation":"document.upload",
       "params":{"dataset_id":"<dataset-id>","name":"note.txt","content":"hello from S3.4","encoding":"utf8"}}'
# approve_action_request（decisionId 来自上一条的返回）……同 §7，此处从略

# 核对 RAGFlow 那一侧真的收到了文件内容（不是空占位）——GET 这份 Document 或直接在 RAGFlow 自己的
# UI/API 里看 size 字段：应等于 "hello from S3.4" 的字节数（15），不是 0。
```

### 13.2 发布本体 v2 + 采集器 phase 4 验收

`ontology/ops-assets-v2.yaml`（`KnowledgeBase`/`Document`/`part_of`/`served_by`）的发布步骤、
`collector-host-inventory` 的 `RAGFLOW_GATEKEEPER_ID` 配置、`observe_operation` scope、以及
`Document part_of KnowledgeBase`/`KnowledgeBase served_by Gatekeeper` 的 `traverse`/`explain`
验证，全部在 `docs/runbooks/host-collector.md`（§1 "S3.4"、§2 "`observe_operation`"、§3 "S3.4（可
选）"、§4.5）——不在本文件重复，`ragflow` 门本身（本文件 §5/§11）与本体/采集器（
`host-collector.md`）是两个独立的验收面。


## 14. P-B2a：通用门宿主 `gate-host`（`http` / `mcp` 实例不再各起一个容器）

设计与决定：`docs/graph-ai-middle-platform-design.md` §6.3 "通用门宿主"、`docs/development-tasks.md`
P-B "P-B2 再拆与决定" 决定 ⑥–⑬。一句话：**一个** `gatekeeper-base` 容器以 `GATE_MODE=host` 起来，管理员
在集成页建的每个通用 `http` / `mcp` 实例都由它承载；实例定义它自己从内核拉，凭证由浏览器直接投递给它，
内核从头到尾不经手凭证。

### 14.1 主机首次启用（v0.10.0 起，一次性）

```sh
# 1) 补数据目录与新密钥（两个脚本都幂等；gen-handle-keys 只新增 secrets/gate-host-store.key，
#    既有 handle.key / internal.token / gate.token 不动）
NEXTTIME_DATA=<data-dir> sh scripts/host-bootstrap.sh
NEXTTIME_DATA=<data-dir> sh scripts/gen-handle-keys.sh
# 2) 构建并起宿主；caddy 也要重建（Caddyfile 新增 /gate-host/* 路由）
docker compose build gate-host caddy
docker compose up -d gate-host caddy
# 3) 看宿主自己的存活路由（无需 token；只报实例 id / 就绪 / Operation 数，不含任何凭证）
docker compose exec gate-host node -e "fetch('http://127.0.0.1:8083/healthz').then(r=>r.text()).then(console.log)"
```

宿主要的三份 secret 与一个只读挂载：`gate_token`（内核 → 门，与打包门同一份）、`internal_token`（门 →
内核：拉定义 + announce）、`gate_host_store_key`（宿主自己的静态加密密钥，`secrets/gate-host-store.key`）、
`config/handle.pub`（验浏览器带来的 5 分钟平台 JWT——与 llm-proxy 挂的是同一个文件）。全部在
`docker-compose.yml` `gate-host` 服务块里，不需要 `.env` 新变量。

### 14.2 全程在浏览器里（不登主机）

1. 管理 → 集成 → 门实例 → **新建门宿主实例**：填稳定 id（就是 `GATE_ID`，也是宿主上的路径 `/i/<id>`）、
   种类（`http` / `mcp`）、目标地址（compose 内部主机名或内网 URL；例如 fixture MCP 是
   `http://fixture-mcp:8080/`）、凭证模式（`shared` 一份共用 / `connected_account` 每人一份）、`http` 可填
   OpenAPI 文档 URL 让宿主导入 Operation。实例落库即 `enabled`，但显示"等待宿主接管"。
2. 宿主每 `GATE_ANNOUNCE_INTERVAL_SEC`（默认 60 s，首次立刻）拉一次定义：`mcp` 实例对目标发 `tools/list`
   导入工具、`http` 实例拉 OpenAPI，成功即 announce（`endpoint = http://gate-host:8083/i/<id>`），页面上
   出现心跳时间与 Operation 数；目标不可达则**不 announce**，宿主日志一行 warn，下一轮重试。
3. 需要凭证的实例：详情抽屉 → **录入共享凭证** → "获取 5 分钟令牌"（`issue_gate_host_token`）→ 填 Bearer
   token 或原始 JSON → 提交。浏览器把凭证 `POST` 到 `/gate-host/i/<id>/gate/connected-accounts`，caddy 转
   给宿主，宿主验 JWT（`aud` / `typ` / `gate` = 路径 id / 5 分钟）后按 JWT 里的槽位（`__shared__`）落盘。
   `connected_account` 实例由每个成员在工作区"系统接入"页 **录入我的凭证**（`issue_gate_credential_token`，
   槽位 = 自己的 Principal）。
4. 接入包 `mcp` / `http` 设为 **平台预置**（P-B2a 起允许；`cli` / `ssh` 仍不能）→ 工作区"系统接入"从平台
   目录一键启用 → 能力目录出现工具。宿主尚未接管时启用会得到 409 `gate_not_ready`。
5. 删除：只有宿主实例可删，且要先没有工作区链接（否则 409 `gate_in_use`，先在实例上"禁用"）。宿主下一轮
   拉定义时把它从内存表摘掉，`/i/<id>/*` 立即 404；`${NEXTTIME_DATA}/gate-host/<id>/` 里的加密凭证文件不会
   自动删，需要时由维护者手工清理。

### 14.3 信任边界对照

- 宿主上除 `POST` / `DELETE /i/<id>/gate/connected-accounts` 外的每条路由仍只认 `gate_token`——浏览器没有。
- 平台 JWT 用内核的 Handle 私钥签，但 `typ` 独立、带 `aud`、声明形状与 Handle 互斥：它在内核那边过不了
  Handle 校验，真 Handle 在宿主这边也过不了（两条都有单测）。
- 宿主只从 JWT 拿写入槽位，请求体里的 `onBehalfOf` 被忽略；`__shared__` 不是 UUID，撞不上任何 Principal。
- 内核既不知道宿主地址也没有到宿主的凭证：定义是宿主拉的，心跳是宿主发的，与打包门完全一致。
