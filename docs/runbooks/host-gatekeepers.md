# Runbook：host-gatekeepers（`docker` / `ragflow` 门实例主机验收）

对应任务：development-tasks.md § S2.5（`gatekeepers/docker`、`gatekeepers/ragflow` 两个预置门实例
+ `docker-compose.yml` 的 `gatekeeper-docker`/`gatekeeper-ragflow` 服务）。占位符取值见
`docs/private/`（不入库）。

前置：E1–E4（数据目录已建、`.env` 已生成、Postgres 已起）；`scripts/host-bootstrap.sh` /
`scripts/host-env-init.sh` 已跑过且是**这次 S2.5 改动之后的版本**（新增了
`${NEXTTIME_DATA}/gatekeepers/{docker,ragflow}` 目录与 `secrets/gatekeeper-ragflow.env` 的新占位
变量名 `RAGFLOW_BASE_URL`/`GATE_CREDENTIAL_RAGFLOW_API_KEY`——如果这台主机是用旧版本的脚本初始化
的，重新跑一次这两个脚本，幂等，不会破坏已有数据）；`.env` 里 `DOCKER_GID` 是本机真实的 `docker`
组 gid（`stat -c '%g' /var/run/docker.sock`）；`kernel` 容器已起且能连 Postgres（S2.4 已合并——
`packages/gatekeeper-base` 与 kernel 侧 `governance/gatekeepers`/`adapters/gatekeeper-client` 就位）。

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
operations`/`health` 不需要它们生效。两个服务都只在 `control` 网络（compose 未发布任何主机端
口），从主机 `curl` 不到；用 `kernel` 容器自带的 Node `fetch()`：

```bash
docker compose exec -T kernel node -e "
fetch('http://gatekeeper-docker:8083/gate/health').then(r=>r.text()).then(t=>console.log('docker:',t))
"
docker compose exec -T kernel node -e "
fetch('http://gatekeeper-docker:8083/gate/describe_operations').then(r=>r.text()).then(t=>console.log(t))
"
docker compose exec -T kernel node -e "
fetch('http://gatekeeper-ragflow:8083/gate/health').then(r=>r.text()).then(t=>console.log('ragflow:',t))
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

## 8. 幂等验证——同一 `idempotencyKey` 重复 `apply` 不二次重启

第 7 步已经用 kernel 的治理路径重启过一次；这一步直接对门自己的协议端点验证"重复 `apply` 只执行
一次"（`@nexttime/gatekeeper-base` 的 `GatekeeperBase`/`JsonFileIdempotencyStore` 保证——门本身
的单元测试 `gatekeepers/docker/src/transport.test.ts` 已经用假 dockerode 覆盖了这一点，这里是
对真实门服务的端到端复核）。**注意**：再发一次 `request_action` 不是同一件事——那会产生一个
*新的* `ActionRequestId`（=新的 `idempotencyKey`），会再重启一次，不是幂等测试；幂等测试必须直接
打门自己的 `/gate/apply`，用同一个 `idempotencyKey`：

```bash
docker compose exec -T kernel node -e "
fetch('http://gatekeeper-docker:8083/gate/apply', {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({ operation: 'container.restart', params: { id: '${GATE_TEST_CONTAINER_ID}' }, idempotencyKey: 'manual-idempotency-check-1' }),
}).then(r => r.json()).then(b => console.log(JSON.stringify(b, null, 2)))
"
docker inspect nexttime-gate-test --format '{{.State.StartedAt}}'
```

期望第一次调用：`{"ok":true,"result":{"data":{...},"observedFacts":[...],"replayed":false}}`，
`StartedAt` 相对第 7 步末尾再次变化（这次是直接打门、绕过了内核审批，允许——门本身对
`onBehalfOf`/审批状态一无所知，治理只在内核这一侧强制）。再发一次**同样的请求体**（同一
`idempotencyKey`）：

```bash
docker compose exec -T kernel node -e "
fetch('http://gatekeeper-docker:8083/gate/apply', {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({ operation: 'container.restart', params: { id: '${GATE_TEST_CONTAINER_ID}' }, idempotencyKey: 'manual-idempotency-check-1' }),
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
第 5 步之后，`member` 下一次开启对话（其入口容器重新签发入口 Handle 时——已缓存的 Handle 要么等
自然重签、要么重启该用户的入口容器强制刷新）能对 `find_operations("container")`
之类的查询看到这个门暴露的已发布 Operation；`docker compose exec -T kernel psql ...` 查
`capability_grants` 表能看到 `capability='gatekeeper'`、`scope->>'resourceScope'` 等于
`GATEKEEPER_ID_2` 的一行。

## 11. `ragflow` 门——若本机有可用的 RAGFlow 实例

§5 已注册并发布了 `ragflow` 门的清单（`kb.list kb.documents retrieve document.upload
document.parse`）。若 `${NEXTTIME_DATA}/secrets/gatekeeper-ragflow.env` 已填入真实
`RAGFLOW_BASE_URL`/`GATE_CREDENTIAL_RAGFLOW_API_KEY` 并重启过 `gatekeeper-ragflow`
（`docker compose up -d --force-recreate gatekeeper-ragflow`，env_file 改动不会自动生效），可以
同 §6 的方式跑 `request_action(kb.list)`，核对 `objects` 表出现 `object_type = 'KnowledgeBase'`
的行。**不要**用 `document.upload` 验证"真实上传文件"——见
`gatekeepers/ragflow/README.md`"已知限制"：这个 Operation 目前只能创建 RAGFlow 的
`type=empty` 空占位文档，不支持真实文件内容（`HttpTransport` 只发 JSON body，RAGFlow 的真实文件
上传要求 `multipart/form-data`）。本机没有可用 RAGFlow 部署时，跳过本节，§3/§5 的服务可达性 +
清单注册/发布已经是 S2.5 对 `ragflow` 门的完整交付范围。

## 12. 已知偏离 / 待确认（PR 中一并说明）

- **`compose.up`/`compose.down` 是"启动/停止该 compose 项目下已存在的容器"，不是完整的
  `docker compose up/down`**：镜像里只有 `dockerode`（Docker Engine API），没有 `docker
  compose` 二进制（任务原文"no docker CLI in the image"）——不拉镜像、不创建/重建服务、不管理
  network/volume。见 `gatekeepers/docker/README.md`"compose.up/compose.down — 已知偏离"。S2.5
  验收原文只要求 `container.restart` 的幂等 apply，没有把 `compose.up`/`compose.down` 的真实语义
  列入验收范围，因此这个简化没有拿掉任何验收覆盖。
- **`document.upload` 不支持真实文件内容**：见 §11 与 `gatekeepers/ragflow/README.md`。
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
  （`auto_approvable:false, await_decision:true`，owner 必须先审后发布，I17）。
- **镜像构建未在本机验证**（Docker 不在这台开发机上）：`docker compose build gatekeeper-docker
  gatekeeper-ragflow`（§2）、`docker compose up`（§3）及之后所有步骤都需要在目标主机上首次跑一
  遍——这正是本 runbook 存在的原因。
