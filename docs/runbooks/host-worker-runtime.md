# Runbook：host-worker-runtime（agent 运行时镜像与 supervisor 常驻模式）

对应任务：development-tasks.md § S1.5（本 runbook 覆盖前半：`worker-runtime` 镜像 +
`worker-supervisor` 常驻模式）。占位符取值见 `docs/private/`（不入库）。前置：E1–E4（gVisor 已
验证或已在 `.env` 回退 `runc`、数据目录已建、`.env` 已生成、Postgres 已起）；`config/models.json`
须是有效的 pi `models.json`（见 §3）；`.env` 里 `DOCKER_GID` 须是本机真实的 `docker` 组 gid
（`stat -c '%g' /var/run/docker.sock`）——`worker-supervisor` 以非 root uid 10001 运行，缺这个
补充组会导致连接 socket 时 `EACCES` 而 crash loop（S1.5a 主机验收时发现，见 §10）；
`${NEXTTIME_DATA}/config/egress-sources.json` 建议 `chown 10001:10001`（同一原因——写入会
`EACCES`，但 S1.5a 已把这个失败改成 best-effort，不会挡住 spawn，只是那次 egress 登记不生效，
见 §10）。

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
set -a; . ./.env; set +a
# 让 worker-supervisor（非 root uid 10001）能写 egress 登记文件 —— 不做这步 spawn 仍会成功
# （S1.5a 把这个失败改成了 best-effort），只是那次的 egress 来源登记不会真的写进去。
chown 10001:10001 "${NEXTTIME_DATA}/config/egress-sources.json" || true
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
HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy PI_CODING_AGENT_DIR HOME`（大小写代理变量
都设，见 §10 "httpoxy" 说明）加镜像自带的 `PIP_USER PYTHONUSERBASE PATH NODE_ENV` 等
——**没有任何 `*_API_KEY`**，也没有 supervisor 自己进程的其他 env（未继承宿主 env）。

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

期望：`https://example.com` → `200`；`postgres:5432` 与 `100.64.0.1` 均拒绝（`403`，代理判定为
内部/私有地址）；`pip install --user` 成功；`/workspace/ok` 可写；`/ok` 失败（只读根）。

**若 `https://example.com` 不是 `200` 而是 `403`，且 `docker compose logs egress-proxy` 显示
`"reason":"private-address"`，这大概率是目标主机自己的网络的问题，不是这几个服务的 bug**——见
§10 "目标主机 DNS 会把公网域名解析成内网地址" 这条，S1.5a 主机验收时实测遇到过；换一个真正把
公网域名解析到公网地址的主机/网络再测一次。

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

## 10. 一次性 Task 模式（S2.8）

前置：§2 已构建 `nexttime-ai-worker-runtime` 镜像，`worker-supervisor` 已在跑（§4）。这里验证的是
`worker-supervisor` 自己那一半——容器 spec（挂载、env、labels、镜像 allowlist）、生命周期（spawn /
status / terminate / 超时 / 退休清理）——**不是**端到端"Worker 真的能干活"：`platform-extension` 的
`worker` 模式扩展是 S2.9 的交付物，还没实现，所以下面 spawn 出来的容器里 pi 大概率会因为扩展不认识
`NEXTTIME_MODE=worker` 而很快非零退出（`status` 从 `running` 很快变成 `failed`）——这是预期中的、
S2.9 之前的正常现象，不是本任务的 bug。因为这个原因，"docker inspect 看 env" 这一步要在 spawn 后
**立刻**做（容器一退出，`GET /task/:workerRunId` 或下一次周期性 `reap()`——至多 30 秒——就会把它
`docker rm` 掉）。

```bash
cd <CODE_DIR>
docker compose exec -T worker-supervisor node -e "
fetch('http://localhost:8081/task/spawn', {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({
    taskId: 'demo-task-1',
    workerRunId: 'demo-run-1',
    workspaceId: 'ws-demo',
    onBehalfOf: 'demo-alice',
    capabilityHandle: 'dummy-worker-handle',
  }),
}).then(r => r.text()).then(t => console.log(t))
"
```

期望：`200 {containerId, ip}`。**立刻**（不要先查 status）检查容器 spec：

```bash
docker inspect nexttime-task-demo-run-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | sort
docker inspect nexttime-task-demo-run-1 --format '{{json .HostConfig.Binds}}'
docker inspect nexttime-task-demo-run-1 --format '{{json .Config.Labels}}'
docker inspect nexttime-task-demo-run-1 --format '{{.HostConfig.ReadonlyRootfs}} {{json .HostConfig.CapDrop}} {{json .HostConfig.SecurityOpt}}'
```

期望：env 恰好是 `KERNEL_URL KERNEL_LLM_URL CAPABILITY_HANDLE TASK_ID WORKSPACE_ID WORKER_RUN_ID
NEXTTIME_MODE HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy` 加镜像自带的
`PIP_USER PYTHONUSERBASE PATH NODE_ENV HOME` 等——**没有任何 `*_API_KEY`**，也没有
`PI_CODING_AGENT_DIR`（见 README"Spawn spec 关键决策"，默认值已经落在同一路径，不需要这个变量）；
`Binds` 含 `.../workspaces/tasks/demo-task-1:/workspace` 与只读的 `models.json`；`Labels` 含
`nexttime.role=worker`、`nexttime.task-id=demo-task-1`、`nexttime.worker-run-id=demo-run-1`、
`nexttime.workspace-id=ws-demo`；`ReadonlyRootfs=true`、`CapDrop=["ALL"]`、
`SecurityOpt=["no-new-privileges"]`。

```bash
docker compose exec -T worker-supervisor node -e "
fetch('http://localhost:8081/task/demo-run-1')
  .then(r => r.text()).then(t => console.log(t))
"
```

期望：`200`，`status` 是 `running`（若查询够快）或 `exited`/`failed`（S2.9 前的预期现象，见上）；
无论哪种，这次查询之后容器都已被 `docker rm`（`docker ps -a --filter name=nexttime-task-demo-run-1`
应为空）——`/workspace` 本身没有被删，仍是 Task 的 artifact：

```bash
ls "${NEXTTIME_DATA}/workspaces/tasks/demo-task-1"   # 目录还在（entrypoint.sh 写入的 .pi/ 等）
```

`terminate`（无论容器此时是否还在跑，都应 `204`——已结束的 Task 上调用是幂等成功，不是错误；用一个
更长的 `timeoutSec` 重新 spawn 一次能提高"容器仍在跑时调用"的命中概率，但完整验证"杀掉一个真正还在
跑的 Worker"要等 S2.9 落地、pi 真的能在 `worker` 模式下跑起来之后）：

```bash
docker compose exec -T worker-supervisor node -e "
fetch('http://localhost:8081/task/demo-run-1/terminate', {method: 'POST'})
  .then(r => console.log(r.status))
"
```

期望：`204`。非允许镜像应 `403`：

```bash
docker compose exec -T worker-supervisor node -e "
fetch('http://localhost:8081/task/spawn', {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({
    taskId: 'demo-task-2', workerRunId: 'demo-run-2', workspaceId: 'ws-demo',
    onBehalfOf: 'demo-alice', capabilityHandle: 'h', image: 'some-unapproved-image',
  }),
}).then(r => console.log(r.status))
"
```

期望：`403`。收尾同 §8——`docker compose stop worker-supervisor egress-proxy`、
`rm -rf "${NEXTTIME_DATA}/workspaces/tasks/demo-task-1" "${NEXTTIME_DATA}/workspaces/tasks/demo-task-2"`
（验收产物，不需要保留）。

## 11. 已知偏离 / 待确认（PR 中一并说明）

- **纯 `HTTP_PROXY`（大写）对 plain `http://` 请求不可靠（主机验收才发现）**：`curl`（以及很多
  遵循同一惯例的 HTTP 客户端）出于历史上的 "httpoxy" CGI 环境变量注入漏洞规避考虑，plain
  `http://` 请求只认小写 `http_proxy`，大写 `HTTP_PROXY` 会被忽略——`HTTPS_PROXY` 没有这个问题
  （`https://` 两种大小写都认）。实测：容器内 `curl http://postgres:5432`（只设了大写）直接本地
  DNS 解析失败，从没走到代理；额外 export 小写 `http_proxy` 后才正确经代理拿到 `403`。修法：
  `spawn-spec.ts` 现在给每个入口容器同时注入大写与小写三对（`HTTP_PROXY`/`http_proxy`、
  `HTTPS_PROXY`/`https_proxy`、`NO_PROXY`/`no_proxy`）——这是本任务派发文字给的 env 清单之外的
  第二个必要追加项（第一个是 `WORKSPACE_ID`，见下）。
- **目标主机 DNS 会把公网域名解析成内网地址（主机验收才发现，不是本任务代码的 bug）**：S1.5a
  主机验收时，目标主机的 DNS 把 `example.com`、`google.com`、`github.com` 等公网域名统一解析成
  该主机自己网络里的一个内网段地址（这段地址本身是可达的、host 直接 curl 这些域名能拿到
  `200`——这台主机的网络看起来是靠 DNS 把公网域名指向一层内部网关/透明代理，再由那层转发到真正
  的公网，而不是普通的公网直连）；直连任何真正的公网 IP（如 `1.1.1.1`）反而超时。`egress-proxy`
  按 I10 的既定设计"代理自己解析域名，解析出的地址若落在 RFC1918/CGNAT/loopback 等私有段就拒绝
  （防 DNS rebinding）"——这段代理逻辑没有错，是它正确地把这台主机 DNS 解析出的私有段地址判定
  为"私有"并拒绝了（日志 `"reason":"private-address"`），所以从这几个入口容器里
  `curl https://example.com` 会拿到 `403` 而不是 `200`。这是**这台主机网络本身的特性**，不是
  `worker-runtime` / `worker-supervisor` / `egress-proxy` 的缺陷，也不在本任务所有权范围内可以
  修——放宽 `egress-proxy` 的私网判定会真的削弱 I10 的 DNS-rebinding 防护，不能为了适配这一台
  主机就做。留给主会话与后续任务判断：换一台网络更"标准"的主机验收，或者如果这确实是量产环境
  的常态网络拓扑，需要专门评审 I10 的私网判定策略该怎么和这类透明代理网络共存。
- **`worker-supervisor` 需要 `DOCKER_GID`（主机验收才发现）**：`packages/worker-supervisor/
  Dockerfile` 是 R1 就有的、非本任务写的既有文件，以非 root uid 10001 运行；但目标主机
  `/var/run/docker.sock` 是 `root:docker`（组 gid 因主机而异）660——两者原来对不上，容器一起来
  就 `EACCES` crash loop。修的位置是 `docker-compose.yml` 的 `worker-supervisor.group_add:
  ["${DOCKER_GID:-999}"]`（`.env.example` 新增 `DOCKER_GID` 占位符与说明），不是改
  Dockerfile——本任务 `packages/worker-supervisor/**` 所有权范围内的最小修复。
- **`.pi/agent` 必须由 supervisor 自己先建好，不能让 Docker 隐式建（主机验收才发现）**：
  bind-mount `models.json` 到 `/workspace/.pi/agent/models.json` 时，若 `.pi/agent` 目录还不
  存在，Docker（准备挂载点这一步本身以 root 跑）会以 root 身份建出 `.pi/`——entrypoint.sh 随后
  以 uid 10001 身份 `mkdir -p /workspace/.pi/sessions`（`.pi/` 的兄弟目录）就会 `Permission
  denied`，容器立刻退出（exitcode 1）。修法：`resident-service.ts` 的 `spawn()` 在起容器前，用
  自己的 uid（同样是 10001）先 `mkdirSync` 好 `<workspace>/.pi/agent`，这样 Docker 看到目标已
  存在、属主已经正确，不会再自己建。`host-paths.ts` 新增 `localPiAgentDir` 承载这个路径。
- **egress 登记失败不应该拖垮 spawn（主机验收才发现）**：目标主机上
  `${NEXTTIME_DATA}/config/egress-sources.json` 是 `root:root 644`（`scripts/host-env-init.sh`
  只把 `config/` 设成 world-**readable**，没有单独给这个后来才需要写的文件设属主/组）——非 root
  的 worker-supervisor 写它会 `EACCES`。这暴露了一个真实的健壮性缺口，不只是这台主机的权限问题：
  `resident-service.ts` 原来让这个失败直接冒泡成整个 `spawn`/`stop` 的 500，现在改成 best-effort
  （记警告日志、继续）——与平台其它 egress/用量上报模块的既有做法一致（`llm-proxy`、
  `egress-proxy` 自己的 reporter 都是排队重试、不阻塞调用方）。**主机侧仍需要**
  `chown 10001:10001 "${NEXTTIME_DATA}/config/egress-sources.json"`（或等价的组可写方案）egress
  登记才会真正生效——这条留给 `scripts/host-env-init.sh`（E2，不在本任务所有权范围）或主会话决定
  是否把这个文件也纳入它现有的 chown 列表（`workspaces/ artifacts/ caddy/`）。
- **`--system-prompt-file` 不存在**：pi 0.84.4 没有这个 flag；用 `--system-prompt <path>`
  代替——`resource-loader.ts` 的 `resolvePromptInput` 在路径存在时按文件内容读取，效果等价。
- **`sessions/` 顶层目录已废弃（2026-09-02 决定）**：入口容器的 `--session-dir` 是
  `/workspace/.pi/sessions`（在 `workspaces/<uid>/` 内），一个用户只有一个挂载点（I15）。顶层
  `${NEXTTIME_DATA}/sessions`、kernel 的 `sessions:ro` 挂载、备份里的 `sessions/` 已随清理 PR 去掉；
  `scripts/host-bootstrap.sh` 不再创建它，已有主机上可以直接 `rmdir`（空目录）。将来若需要内核读
  会话 JSONL，走 `workspaces/*/.pi/sessions/` 的只读挂载。
- **`WORKSPACE_ID` 环境变量**：本任务派发文字给的"仅这些 env"清单没有 `WORKSPACE_ID`，但
  `@nexttime/platform-extension` 的 `index.ts`（`readRequiredEnv('WORKSPACE_ID')`）在缺它时
  直接抛错——不在本任务所有权范围内改动 platform-extension，因此 spawn spec 额外注入了
  `WORKSPACE_ID`（来自 spawn 请求体）。
- **`deploy/worker-runtime/` 而非 `worker-runtime/`**：设计文档 §10.1 的目录结构图把这个
  Dockerfile 放在仓库根 `worker-runtime/`；本任务派发文字明确给的路径是
  `deploy/worker-runtime/Dockerfile`，按派发文字执行，§10.1 未同步（只同步了 §10.2 的 compose
  片段，按任务所有权范围）。
- **S2.8：Task 状态四态划分是本次实现的显式假设，非任务原文逐字给出**：`running -> exited |
  terminated | failed`——`terminated` 是本服务主动结束的（显式 `terminate` 或超时 reaper），不看
  退出码；其余按 Docker 退出码分类（`0` → `exited`，非 0 → `failed`）。理由与借鉴对象见
  `packages/worker-supervisor/src/task-service.ts` 模块注释与该包 README。
- **S2.8：Task 模式 env 清单没有 `PI_CODING_AGENT_DIR`/`HOME`，且这是刻意的，不是遗漏**：对照
  `D:\NextTime AI\pi-0.84.4`（参考项目，未拷入本仓库）的 `packages/coding-agent/src/config.ts`
  验证，pi 未设 `PI_CODING_AGENT_DIR` 时的默认值是 `join(homedir(), '.pi', 'agent')`；
  `homedir()` 读 `HOME`，而 `HOME=/workspace` 已经烘焙在 `deploy/worker-runtime/Dockerfile`
  镜像层（`ENV HOME=/workspace`），不受本包 `Env` 数组影响——默认值因此恰好落在
  `host-paths.ts` `taskWorkspacePaths` 挂载 `models.json`/skills 的同一路径，不需要重复设置。
- **S2.8：skills 挂载目标目录已对照 pi 源码验证，不是派发文字给的兜底猜测**：对照同一参考项目的
  `packages/coding-agent/src/core/skills.ts` `loadSkills`（`join(resolvedAgentDir, 'skills')`），
  `/workspace/.pi/agent/skills/<name>` 就是 pi 0.84.4 的默认全局 skills 目录，非猜测的兜底路径。
- **S2.8：`no-new-privileges` 加在 `docker-client.ts` 共享的 `createAndStart` 里，同时影响 resident
  模式**：派发文字把它列为 Task 模式的容器 flag，但 `--read-only`/`--cap-drop ALL`/tmpfs `/tmp`
  这几项本来就是这个共享函数无条件加给所有容器的（不是每个 spec 各自的字段）——按同一模式加
  `SecurityOpt:['no-new-privileges']`，比在 `ContainerSpec` 上加一个只有 Task 用的布尔字段更一致，
  代价是 resident 模式的入口容器现在也会带这个 flag。这是纯粹的加固（两种模式都已经以非 root 运行，
  `no-new-privileges` 只挡 setuid/setgid 提权，两者都不依赖），不改变任何已测行为，本 PR 未把它做成
  可关闭的选项。
- **S2.8：`WORKER_IMAGE_ALLOWLIST` 是追加式，不是替换式**：设默认值以外的允许镜像列表时，默认
  `WORKER_IMAGE` 始终保留在 allowlist 里——不会因为设置了这个变量就意外把默认镜像也挡在外面。
  派发文字本身没有明确这一点，属于本次实现做出的、偏保守的工程判断。
- **S2.8：`reconcile()`、周期性 `reap()`、工作目录退休 sweep 是任务原文未逐字要求、本次主动补上的
  健壮性机制**：`reconcile()`（supervisor 重启后按 label 重新登记仍在跑的 Worker 容器）参照
  resident 模式已有的同名机制；`reap()`（超时踢除 + 发现自然退出）与 sweep（清理过期工作目录）是
  "Lifecycle" 那段落描述的行为落地成的具体机制，细节（各自的轮询周期、`docker.remove` 失败时的
  best-effort 处理）都是本次实现的选择，不是照抄任务原文的字面步骤。
- **S2.8：Task 模式容器目前大概率很快非零退出**：`platform-extension` 的 `worker` 模式扩展是 S2.9
  的交付物，还没实现——`NEXTTIME_MODE=worker` 启动的容器里 pi 大概率因为扩展不认识这个模式而很快
  退出。本任务只交付 `worker-supervisor` 这一半（容器 spec、生命周期、状态机、注册表），不含端到端
  "Worker 真的能干活"的验证，见本文档 §10 开头的说明。
- **S2.8：`(worker_run_id, container_id, ip)` 的"注册"就是登记表 + egress 来源映射，没有单独的查询
  端点**：派发文字"注册 (worker_run_id, container_id, ip) 供 gateway 来源绑定与出网代理解析"里的
  "出网代理解析"就是 `worker:<workspaceId>:<workerRunId>` 写入 `SOURCE_MAP_FILE`（egress-proxy 直接
  用得上）；"gateway 来源绑定"目前只能通过 `GET /task/:workerRunId` 拿到 `containerId`/`ip`——没有
  另开一个按 `containerId` 或 `ip` 反查的端点，因为派发文字与 S2.7/S2.9 都没有提出这个查询方向的
  具体需求；如果 S2.7 的 gateway 侧确实需要按来源 IP 反查 `workerRunId`（例如做门的来源校验），
  留给那个任务评估是否需要在这里加一个索引，而不是这里预先猜测接口形状。
