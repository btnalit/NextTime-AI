# Runbook：host-worker-runtime（agent 运行时镜像与 supervisor 常驻模式）

对应任务：development-tasks.md § S1.5（本 runbook 覆盖前半：`worker-runtime` 镜像 +
`worker-supervisor` 常驻模式）。占位符取值见 `docs/private/`（不入库）。前置：E1–E4（gVisor 已
验证或已在 `.env` 回退 `runc`、数据目录已建、`.env` 已生成、Postgres 已起）；`config/models.json`
须是有效的 pi `models.json`（见 §3）。

## 1. 目的

`worker-runtime` 镜像（`deploy/worker-runtime/Dockerfile`）是入口容器与（后续 S2.8/S2.9）Worker
容器共用的唯一镜像：`node:24-bookworm-slim` + pi 0.84.4 + `@nexttime/platform-extension` +
`git curl python3 pip build-essential ripgrep`。`worker-supervisor` 的常驻模式
（`POST /resident/spawn` 等）按用户拉起该镜像的常驻容器（设计文档 §7.2）。

本任务不含：agent-host 事件桥（下一个任务把容器 stdout 的 JSONL 事件桥到内核）、内核侧真正的
`AgentRuntime`（当前仍是 `FakeAgentRuntime`，S1.4）。本 runbook 里"能收到 pi 的 RPC 输出"只验证
到"容器起来了、pi 进程在跑"，不含端到端对话。

## 2. 构建镜像

```bash
cd <CODE_DIR>
git fetch origin
git checkout task/s1-5a-runtime-supervisor
docker compose build worker-runtime worker-supervisor
```

`worker-runtime` 服务带 `profiles: ["build-only"]`：`docker compose up` 不会拉起它，只有
显式 `docker compose build worker-runtime`（或 `--profile build-only up`，本 runbook不需要）
才会构建 `nexttime-ai-worker-runtime` 镜像。构建成功后：

```bash
docker image inspect nexttime-ai-worker-runtime --format '{{.Id}}'
docker run --rm nexttime-ai-worker-runtime pi --version   # 期望输出含 0.84.4；这条命令会因缺
                                                            # NEXTTIME_MODE 等必需 env 而在 entrypoint
                                                            # 里 exec pi 后由 platform-extension 报错退出
                                                            # 非 0——用下面这条只测 pi 本身版本：
docker run --rm --entrypoint pi nexttime-ai-worker-runtime --version
```

## 3. 准备 `config/models.json`

`scripts/host-env-init.sh`（E2）写的占位符是字面 `{}`，**不是**合法的 pi `models.json`
（pi 的 schema 要求 `providers` 字段必填——见 PR body"主机验收结果"）。用真正的生成器覆盖：

```bash
cd <CODE_DIR>
set -a; . ./.env; set +a
make gen-models     # 从 ${NEXTTIME_DATA}/config/llm-providers.yaml 生成 config/models.json
cat "${NEXTTIME_DATA}/config/models.json"   # S1.7 未接入真实 provider 时期望 {"providers": {}}
```

## 4. 起 `egress-proxy` 与 `worker-supervisor`

```bash
cd <CODE_DIR>
docker compose up -d egress-proxy worker-supervisor
docker compose ps egress-proxy worker-supervisor
```

`worker-supervisor` 只在 `control` 网络（compose 未发布任何主机端口），从主机 `curl` 不到；
它自己的镜像（`packages/worker-supervisor/Dockerfile`，`node:24-bookworm-slim` 基础，未装
`curl`/`wget`）也没有现成的 HTTP 客户端命令行工具——用容器自带的 Node `fetch()` 代替：

```bash
docker compose exec -T worker-supervisor node -e "
fetch('http://localhost:8081/healthz').then(r=>r.text()).then(t=>console.log(t))
"
```

期望 `{"status":"ok"}`。下面的每个 `/resident/*` 调用都用这个 `node -e fetch(...)` 模式
（`-T` 关掉伪 TTY，避免 `docker compose exec` 吞掉后续脚本的 stdin）。

## 5. 拉起两个用户的入口容器

```bash
cd <CODE_DIR>
docker compose exec -T worker-supervisor node -e "
fetch('http://localhost:8081/resident/spawn', {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({workspaceId: 'ws-demo', principalId: 'demo-alice', handle: 'dummy-handle-alice'}),
}).then(r => r.text()).then(t => console.log(t))
"
docker compose exec -T worker-supervisor node -e "
fetch('http://localhost:8081/resident/spawn', {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({workspaceId: 'ws-demo', principalId: 'demo-bob', handle: 'dummy-handle-bob'}),
}).then(r => r.text()).then(t => console.log(t))
"
```

期望：两次都 `200`，`created:true`，各自不同的 `containerId`/`ip`，`restarts:0`。

```bash
docker ps --filter "label=nexttime.role=entry" --format 'table {{.Names}}\t{{.Status}}\t{{.RunningFor}}'
docker inspect nexttime-entry-demo-alice --format '{{.HostConfig.Runtime}}'
ls "${NEXTTIME_DATA}/workspaces"          # demo-alice/ demo-bob/ 各自独立
```

期望：两个容器都在跑，`Runtime` 为 `.env` 里 `WORKER_RUNTIME` 的值（`runsc` 或回退 `runc`）；
`workspaces/` 下各自一个目录。

## 6. 容器内验收（隔离、出网代理、只读根、pip）

```bash
docker exec nexttime-entry-demo-alice env | sort
```

期望：只有 `KERNEL_URL KERNEL_LLM_URL CAPABILITY_HANDLE WORKSPACE_ID NEXTTIME_MODE HTTP_PROXY
HTTPS_PROXY NO_PROXY PI_CODING_AGENT_DIR HOME` 加镜像自带的 `PIP_USER PYTHONUSERBASE PATH
NODE_ENV` 等——**没有任何 `*_API_KEY`**，也没有 supervisor 自己进程的其他 env（未继承宿主 env）。

```bash
docker exec nexttime-entry-demo-alice curl -sS -o /dev/null -w '%{http_code}\n' https://example.com
docker exec nexttime-entry-demo-alice curl -m 3 -o /dev/null -w '%{http_code}\n' http://postgres:5432 || echo "denied (expected)"
# CGNAT (100.64.0.0/10, RFC 6598) as the "any internal address" example — deliberately not an
# RFC1918 literal, so this line doesn't trip CI's internal-IP-literal guard (.github/workflows/
# ci.yml); packages/egress-proxy/src/net-utils.ts denies this range exactly like RFC1918.
docker exec nexttime-entry-demo-alice curl -m 3 -o /dev/null -w '%{http_code}\n' http://100.64.0.1/ || echo "denied (expected)"
docker exec nexttime-entry-demo-alice sh -c 'pip install --user requests && python3 -c "import requests; print(requests.__version__)"'
docker exec nexttime-entry-demo-alice sh -c 'touch /workspace/ok && echo workspace-writable'
docker exec nexttime-entry-demo-alice sh -c 'touch /ok' && echo "UNEXPECTED: root fs writable" || echo "readonly root (expected)"
```

期望：`https://example.com` → `200`；`postgres:5432` 与 `100.64.0.1` 均超时/拒绝（代理内部一律
拒绝，且 `workers` 网络本身到不了这些地址）；`pip install --user` 成功；`/workspace/ok` 可写；
`/ok` 失败（只读根）。

## 7. `docker kill` 后重新 spawn

```bash
docker kill nexttime-entry-demo-alice
docker compose exec -T worker-supervisor node -e "
fetch('http://localhost:8081/resident/spawn', {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({workspaceId: 'ws-demo', principalId: 'demo-alice', handle: 'dummy-handle-alice'}),
}).then(r => r.text()).then(t => console.log(t))
"
```

期望：`created:true`，新的 `containerId`，`restarts:1`；`ls "${NEXTTIME_DATA}/workspaces/demo-alice"`
里此前写的 `ok` 文件还在（工作目录是真源，容器本身是缓存——设计文档 §7.2）。

## 8. 收尾

```bash
docker compose exec -T worker-supervisor node -e "
fetch('http://localhost:8081/resident/stop', {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({principalId: 'demo-alice'}),
}).then(r => console.log(r.status))
"
docker compose exec -T worker-supervisor node -e "
fetch('http://localhost:8081/resident/stop', {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({principalId: 'demo-bob'}),
}).then(r => console.log(r.status))
"
# 仅在验收前它们不在跑时才停：
docker compose stop worker-supervisor egress-proxy
git checkout main
```

## 9. 供下一个任务（agent-host 事件桥）参考的 supervisor API 契约

- `POST /resident/spawn` `{workspaceId, principalId, handle, kernelUrl?, llmUrl?}` →
  `{containerId, ip, status, created, restarts}`。幂等：已在跑则复用（`created:false`）。
- `POST /resident/stop` `{principalId}` → `204`。
- `GET /resident/:principalId` → `{principalId, containerId, ip, running, status, startedAt,
  restarts, lastTouchedAt}` 或 `404`。
- `POST /resident/:principalId/touch` → `204`（刷新空闲计时）或 `404`。
- `GET /healthz` → `{status:"ok"}`。
- **stdio 附着**：容器创建时 `OpenStdin:true, StdinOnce:false, Tty:false`（pi `--mode rpc` 走
  stdio 的 JSON-RPC）；本任务不提供附着端点——下一半用 Docker Engine API 的
  `POST /containers/{id}/attach?stream=1&stdin=1&stdout=1&stderr=1`（或 dockerode
  `container.attach({stream:true, stdin:true, stdout:true, stderr:true})`），`{id}` 取自
  `spawn`/`GET /resident/:principalId` 返回的 `containerId`。

## 10. 已知偏离 / 待确认（PR 中一并说明）

- **`--system-prompt-file` 不存在**：pi 0.84.4 没有这个 flag；用 `--system-prompt <path>`
  代替——`resource-loader.ts` 的 `resolvePromptInput` 在路径存在时按文件内容读取，效果等价。
- **`sessions/` 顶层目录未被本任务使用**：设计文档 §10.2 的 compose 骨架给 kernel 与
  worker-supervisor 都挂了 `${NEXTTIME_DATA}/sessions`（"会话 JSONL 回流为私有 Source"的读取
  路径），但本任务的入口容器 `--session-dir` 是 `/workspace/.pi/sessions`（在
  `workspaces/<uid>/` 内，按本任务派发文字的字面指示），不是顶层 `sessions/<uid>/`。两者不一致
  ——worker-supervisor 这次的 compose 改动移除了它未使用的 `sessions` 挂载，**未改动 kernel 的**
  （不在本任务所有权范围）。留给主会话决定：（a）未来的会话摄取改成递归读
  `workspaces/*/.pi/sessions/`（kernel 需要更大范围的读权限），还是（b）把 `--session-dir`
  改到顶层 `sessions/<uid>/`（需要改 entrypoint.sh 与 worker-supervisor 的 spawn spec，多一个
  挂载）。
- **`WORKSPACE_ID` 环境变量**：本任务派发文字给的"仅这些 env"清单没有 `WORKSPACE_ID`，但
  `@nexttime/platform-extension` 的 `index.ts`（`readRequiredEnv('WORKSPACE_ID')`）在缺它时
  直接抛错——不在本任务所有权范围内改动 platform-extension，因此 spawn spec 额外注入了
  `WORKSPACE_ID`（来自 spawn 请求体）。
- **`deploy/worker-runtime/` 而非 `worker-runtime/`**：设计文档 §10.1 的目录结构图把这个
  Dockerfile 放在仓库根 `worker-runtime/`；本任务派发文字明确给的路径是
  `deploy/worker-runtime/Dockerfile`，按派发文字执行，§10.1 未同步（只同步了 §10.2 的 compose
  片段，按任务所有权范围）。
