# @nexttime/worker-supervisor

docker socket 上的容器生命周期管理服务（设计文档 §7.2、§7.3、§7.9、§10.1、§10.2）：一个进程、一个
Fastify server、一个 `/var/run/docker.sock`，同时承载两种模式——每用户常驻的入口容器（`/resident/*`，
S1.5a）与一次性 Task/Worker 容器（`/task/*`，S2.8）。两者共享同一个 `DockerClient`
（`docker-client.ts`）、同一套安全基线（`--read-only`、`--cap-drop ALL`、`no-new-privileges`、
tmpfs `/tmp`、非 root uid 10001、只挂 `workers` 网络）与同一个出网代理来源映射文件
（`egress-map.ts`）。`control` 网络内部服务，不发布主机端口——所有路由信任调用方（agent-host / 内核的
`task/service.ts`，S2.7），不做独立鉴权（同一信任边界见内核自己的 internal 路由）。

## 常驻模式（S1.5a）

`POST /resident/spawn|stop`、`GET /resident/:principalId`、`POST /resident/:principalId/touch`。
每用户一个容器，挂载 `${NEXTTIME_DATA}/workspaces/<principalId>` 到 `/workspace`；崩溃/`kill`/空闲
超时后下次 spawn 整体重建容器，`nexttime.restarts` label 记数；`workers` 网络名按 Compose 的
`com.docker.compose.network=workers` 标签在启动时解析。细节见 `src/resident-service.ts`、
`src/spawn-spec.ts` 的模块注释，以及 `docs/runbooks/host-worker-runtime.md` §1–§8（含主机验收记录）。

## Task 模式（S2.8）

一次性 Worker 容器：`POST /task/spawn`、`POST /task/:workerRunId/terminate`、
`GET /task/:workerRunId`。

### `POST /task/spawn`

请求体（Zod `strict`，`src/config.ts` `TaskSpawnRequestSchema`）：

```jsonc
{
  "taskId": "...",           // UUID；Task 的工作目录键——workspaces/tasks/<taskId>
  "workerRunId": "...",      // UUID；这次执行的容器身份键——nexttime-task-<workerRunId>
  "workspaceId": "...",      // UUID
  "onBehalfOf": "...",       // UUID；principalId；I13 的 on_behalf_of 已经编码进 capabilityHandle
                              // 本身，这里只做协议校验，不再单独使用（见 task-service.ts 模块注释）
  "capabilityHandle": "...",
  "image": "...",            // 可选，默认 WORKER_IMAGE；不在 allowlist 里 -> 403
  "model": "...",            // 可选，容器 CMD 变成 ["--model", model]
  "skills": [{ "name": "...", "hostPath": "..." }], // 可选，只读挂载到 <agentDir>/skills/<name>；
                              // hostPath 必须是绝对路径，经 path.posix.normalize 后落在
                              // ${NEXTTIME_DATA}/ 之下——否则 400（见下方"挂载"一条）
  "skillsInline": [           // 可选（S2.14）；见下方"skillsInline"一条
    { "name": "...", "files": { "SKILL.md": "..." } }
  ],
  "timeoutSec": 90,          // 可选，默认 TASK_MAX_RUNTIME_SEC
}
```

#### `skillsInline`（S2.14）

`skills[]`（上面）挂载的是**已经在宿主机上的文件**——内核没有可写的数据挂载（`config:ro` 是它唯一的
数据挂载，I9 相邻），没法先把一个已发布 Skill 的内容写成宿主机文件再传 `hostPath` 进来。
`skillsInline[]` 因此换一种方式：内核（`application/worker/skills.ts` `renderSkillMarkdownFile`）
把已发布 Skill 渲染成 pi 的 `SKILL.md` 格式文本，随 spawn 请求体本身传过来；这个服务在
`docker.createAndStart` **之前**把每个条目的 `files` 写进这个 Task 自己已经会挂载的
`<agentDir>/skills/<name>/` 目录（`task-service.ts` `spawn()`）——不需要新增挂载，整个 Task 工作目录
本来就整体挂在 `/workspace`。

- `name`：与 `skills[].name` 同一条"安全单段路径"规则（`config.ts`，未合并成共享 schema——两者故意
  独立校验，其中一条以后改动不会悄悄影响另一条）。
- `files`：文件名 → 内容的映射；文件名必须是安全的相对路径（无前导 `/`、无 `.`/`..` 段，
  `isSafeSkillInlineFileName`），必须包含一个 `"SKILL.md"` 键（pi 的必需入口文件，`docs/skills.md`
  "Skill Structure"）；单文件 ≤ 512 KiB（`MAX_SKILL_INLINE_FILE_BYTES`），一个条目全部文件合计
  ≤ 2 MiB（`MAX_SKILL_INLINE_TOTAL_BYTES`）——都在 `config.ts` `TaskSkillInlineSchema` 里用
  `superRefine` 校验，不合规直接 `400`，不落到文件系统。
- 两种挂载方式（`skills[]`/`skillsInline[]`）互不冲突，可以在同一次 spawn 里都出现。

`taskId`/`workerRunId`/`workspaceId`/`onBehalfOf` 校验为 UUID（`z.string().uuid()`）而非任意
`min(1)` 字符串：`taskId` 会成为 bind-mount 的 host 路径片段，`workerRunId` 会成为容器名——不校验
的话 `taskId` 传 `../../pgdata` 这类值就能把宿主机上另一个数据目录挂进 Worker 容器。`workspaceId`/
`onBehalfOf` 按同一规则一起收紧，与平台其它地方（`packages/shared/src/handle-token.ts`
`uuidClaim`、`packages/kernel/src/governance/llm-usage/service.ts`）对同类 id 的校验方式一致——
resident 模式自己的 `SpawnRequestSchema`/`StopRequestSchema`（`workspaceId`/`principalId`）以及
`GET /resident/:principalId`、`POST /resident/:principalId/touch` 的路径参数已在后续改动里收紧为同一
条 UUID 规则（`config.ts` `IdClaimSchema`）：`principalId` 是每用户工作目录 bind-mount 的 host 路径
片段与容器名，同样不能接受 `../` 形状的值；非 UUID → `400`（body：`invalid_body`；路径参数：
`invalid_principal_id`），不落到 docker 客户端。

返回 `200 {containerId, ip}`；镜像不在 allowlist（默认只有 `WORKER_IMAGE`，可用
`WORKER_IMAGE_ALLOWLIST` 逗号列表追加，不会替换默认值）返回 `403`；`skills[].hostPath` 逃出
`${NEXTTIME_DATA}/` 之外返回 `400`；请求体（含上述两类校验）不合法 `400`。

### Spawn spec 关键决策（`src/task-spawn-spec.ts`）

- **env 恰好是** `KERNEL_URL / KERNEL_LLM_URL / CAPABILITY_HANDLE / TASK_ID / WORKSPACE_ID /
  WORKER_RUN_ID / NEXTTIME_MODE=worker / HTTP_PROXY / HTTPS_PROXY / http_proxy / https_proxy /
  NO_PROXY / no_proxy`——大小写代理变量都设的原因见 `spawn-spec.ts`（resident 模式）已经记录的
  "httpoxy" 规避说明，同一理由，不重复验证。**没有** `PI_CODING_AGENT_DIR` 与 `HOME`：`HOME=/workspace`
  烘焙在 `deploy/worker-runtime/Dockerfile` 镜像层（不受本包 `Env` 数组影响），pi 0.84.4 未设
  `PI_CODING_AGENT_DIR` 时的默认值是 `join(homedir(), '.pi', 'agent')`（对照
  `packages/coding-agent/src/config.ts` 验证）——`homedir()` 读 `HOME`，两者结合后默认值恰好等于
  resident 模式显式设置的那个路径，不需要重复设置。
- **挂载**：`${NEXTTIME_DATA}/workspaces/tasks/<taskId>` → `/workspace`（读写）；`models.json` 只读
  挂到 `/workspace/.pi/agent/models.json`（与 resident 模式同一目标路径，理由同上）；每个
  `skills[]` 只读挂到 `/workspace/.pi/agent/skills/<name>`——该路径是 pi 0.84.4 的默认全局 skills
  目录（`packages/coding-agent/src/core/skills.ts` `loadSkills`: `join(resolvedAgentDir,
  'skills')`），对照参考项目验证过，不是猜测。**从不**挂载任何用户的入口工作区（I15）。
  **`skills[].hostPath` 本身也受限**（`config.ts` `isSkillHostPathAllowed`，`server.ts` 在
  `/task/spawn` 里对每个 skill 调用，任何一个不满足就整体 `400`，不落到 docker 客户端）：必须是
  绝对路径，且经 `path.posix.normalize` 之后落在这个 supervisor 自己已知的
  `${config.nextTimeData}/` 之下——否则一个调用方可以把 `/var/run/docker.sock`、`/etc` 之类任意
  宿主机路径只读挂进 Worker 容器。`name` 字段本身另有校验（安全单段路径，见上一条），两者合起来
  才能保证最终的挂载目标既不会逃出 skills 目录，来源也不会逃出这台主机的数据根。
- **CMD**：给了 `model` 就是 `['--model', model]`；`entrypoint.sh` 把容器 CMD 接在它自己固定的 pi
  flags 之后，不需要改那个脚本。
- **镜像 allowlist** 校验在 `server.ts`（不在这个纯函数里）——`buildTaskSpawnSpec` 只管把已校验过的
  `image` 放进 spec。

### 生命周期与状态机（`src/task-service.ts`）

`running -> exited | terminated | failed`——四态划分不是任务原文逐字给出的，是本次实现的显式假设
（见 PR body"假设与偏离"）：`terminated` = 本服务主动结束的（显式 `terminate` 或超时 reaper），
不看退出码（SIGKILL 后的退出码往往非 0，不该被误读成 failed）；其余按 Docker 退出码分类，`0` →
`exited`，非 0 → `failed`（借鉴 Kubernetes Job 的 Complete/Failed 划分）。

- **超时**：`timeoutSec`（或默认 `TASK_MAX_RUNTIME_SEC`，默认 3600）到期由周期性 `reap()`（每 30s
  一次，`index.ts`）杀掉，标 `terminated` + `reason:"timeout"`。
- **自然退出**：`reap()` 同一循环里也会发现自己退出的容器（无需等 `GET` 被轮询）；`GET
  /task/:workerRunId` 也会做一次同样的即时核对，所以刚退出就查询也能立刻看到终态，不用等下一次
  `reap()` tick。
- **`/workspace` 保留为 artifact**：容器结束后被 remove，但工作目录不删——退休策略见下。
- **egress 来源映射**：spawn 时写 `worker:<workspaceId>:<workerRunId>`（`egress-map.ts`
  `taskSourceId`），退出/`terminate` 时摘除。内核 host-bridge 目前只认 `entry:` 前缀（见
  `packages/kernel/src/application/host-bridge/egress-observations.ts` 的模块注释）——教它解析
  `worker:` 前缀、把 Task 的出网流量记到对应 Activity 上，是 S2.7/S2.11 的工作，不在本任务范围。
- **`reconcile()`**：supervisor 重启后按 `nexttime.role=worker` label 把仍在跑的容器重新纳入登记表、
  补上 egress 登记；原始 `timeoutSec` 不会跨重启保留（从没持久化过），重新按配置默认值起算。

### 工作目录退休（retention sweep）

`TASK_WORKDIR_RETENTION_HOURS`（默认 72）——每小时一次，删除 `workspaces/tasks/` 下 mtime 超过窗口、
且登记表里没有标记为 `running` 的目录。小、朴素、可配置、每次删除都打一行日志
（`task-service.ts` `sweepRetention`）。

## Env vars

除常驻模式已有的那些（见 `src/config.ts` 顶部文档注释）外，Task 模式新增：

| Var | Default | Meaning |
|---|---|---|
| `TASK_MAX_RUNTIME_SEC` | `3600` | 单个 Task 容器的默认超时（秒），可被请求体 `timeoutSec` 覆盖。 |
| `TASK_WORKDIR_RETENTION_HOURS` | `72` | 已结束 Task 工作目录保留多久后清理。 |
| `WORKER_IMAGE_ALLOWLIST` | 空 | 逗号分隔的额外允许镜像列表；**追加**在默认 `WORKER_IMAGE` 之上，不会替换它。 |

## 测试

`src/test-support/fake-docker-client.ts` 是内存版 `DockerClient`（两种模式共用），从不碰真实 socket。
`docker-client.ts` 本身（`dockerode` 实现）与两个 Dockerfile 都未在本机验证——本机没有 Docker（见
两个 Dockerfile 头部注释）；镜像构建与容器级行为在目标主机上验收，见
`docs/runbooks/host-worker-runtime.md`。
