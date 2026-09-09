# @nexttime/worker-supervisor

docker socket 上的容器生命周期管理服务（设计文档 §7.2、§7.3、§7.9、§10.1、§10.2）：一个进程、一个
Fastify server、一个 `/var/run/docker.sock`，同时承载两种模式——每用户常驻的入口容器（`/resident/*`，
S1.5a）与一次性 Task/Worker 容器（`/task/*`，S2.8）。两者共享同一个 `DockerClient`
（`docker-client.ts`）、同一套安全基线（`--read-only`、`--cap-drop ALL`、`no-new-privileges`、
tmpfs `/tmp`、非 root uid 10001、只挂 `workers` 网络）与同一个出网代理来源映射文件
（`egress-map.ts`）。`control` 网络内部服务，不发布主机端口，也从不挂 `workers` 网络（不像
kernel/llm-proxy/egress-proxy）——所以没有任何 agent 容器能直接到达它。但 `POST /task/spawn` 与全部
`/resident/*` 路由现在要求 `Authorization: Bearer <internal_token>`（`src/internal-auth.ts`，
fix/runtime-hardening，lane-6 review P1-3）：早前这两组路由完全不鉴权，"信任调用方"只是约定，任何
`control` 网络上的其它服务都能直接调用；token 与 kernel/agent-host 共用同一份
`${NEXTTIME_DATA}/secrets/internal.token`（`@nexttime/shared` `DEFAULT_INTERNAL_TOKEN_FILE`）。
kernel 自己的 `packages/kernel/src/adapters/supervisor-client`（`TaskSupervisorClient`）已同步更新
带上这个头（复用 kernel 自己 `/internal/*` 守卫已经加载的同一份 token，见该文件顶部注释）。
`GET /healthz`、`POST /task/:workerRunId/terminate`、`GET /task/:workerRunId` 不受影响，仍不需要
token。

## 常驻模式（S1.5a）

`POST /resident/spawn|stop`、`GET /resident/:principalId`、`POST /resident/:principalId/touch`。
每用户一个容器，挂载 `${NEXTTIME_DATA}/workspaces/<principalId>` 到 `/workspace`；崩溃/`kill`/空闲
超时后下次 spawn 整体重建容器，`nexttime.restarts` label 记数；`workers` 网络名按 Compose 的
`com.docker.compose.network=workers` 标签在启动时解析。细节见 `src/resident-service.ts`、
`src/spawn-spec.ts` 的模块注释，以及 `docs/runbooks/host-worker-runtime.md` §1–§8（含主机验收记录）。

`POST /resident/spawn` 的请求体（`SpawnRequestSchema`）额外接受 `systemPrompt?`/`model?`
（S2.6，来自已发布入口 WorkerDefinition，agent-host 在每个 `startTurn` 上重新解析并转发）与
`egressDeny?`（feat/egress-definition-lists，同一个已发布入口 WorkerDefinition 的
`egressDeny`）——语义与上面 Task 模式的 `egressDeny` 完全一致：每次 spawn（无论新建还是复用一个仍在
跑的容器）都会重新写入来源映射，所以一个新发布的 WorkerDefinition 版本的拒绝名单，下一次
`startTurn` 就生效，不必等容器重启；`reconcile()` 同样从 `nexttime.egress-deny` label 恢复。

**`skillsInline?`（S3.13）**：调用方（AgentProfile 的 `effective.enabledSkills`，内核解析并渲染）
自己的 Skill 挂载——复用 Task 模式上面那条 `skillsInline` 的**同一个** Zod schema（`config.ts`
`TaskSkillInlineSchema`）与写盘机制（`<agentDir>/skills/<name>/<fileName>`），但触发方式不同：
Task 容器每次都是全新工作目录，天然每次都写；常驻入口容器的工作目录跨重建持久化，所以：

- 只在这次 spawn 真的要（重）建容器时才写（`resident-service.ts` `writeSkillsInline`）——单纯复用
  一个仍在跑的容器不写，因为 Skill 集合有变化本身就是下面这条判定强制重建的原因，"仍在复用"意味着
  集合本来就没变。
- 写之前先把整个 `skills/` 子目录删掉再重建——与 Task 模式的"永远全新目录"不同，一个从 AgentProfile
  移除的 Skill 绝不能因为目录从未被删过而继续留在磁盘上、下次重启又被 pi 重新挂载（S3.13"永不扩权"
  的同一条不变量，落到这里）。
- Skill 集合变化会强制重建容器，即使 Handle 的 `jti` 没变：`spawn-spec.ts` 新增
  `SKILLS_HASH_LABEL`（`nexttime.skills-hash`）与纯函数 `hashSkillsInline`（对 Skill 列表本身、以及
  每个 Skill 自己的 `files` 映射都做顺序无关的规范化），`resident-service.ts` 的 `spawn()` 把这个
  哈希的比对结果并入原有的 `rotated`（Handle jti 不匹配）判定——pi 只在容器启动时加载 Skill，所以
  集合变化和 Handle 轮换需要完全相同的处理：不能靠"仍在跑的容器"继续用旧的挂载内容。

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
  "skillsInline": [           // 可选（S2.14）；见下方"skillsInline"一条
    { "name": "...", "files": { "SKILL.md": "..." } }
  ],
  "timeoutSec": 90,          // 可选，默认 TASK_MAX_RUNTIME_SEC
  "egressDeny": ["blocked.example.com"], // 可选（feat/egress-definition-lists），见下方一条
}
```

`egressDeny`（feat/egress-definition-lists）：被调用的 WorkerDefinition 自己的 `egressDeny`
（`packages/shared/src/worker-definition.ts`，`kind='worker'` 内容现在也可声明这个字段，不再仅限
entry）——写进这个 WorkerRun 在 `SOURCE_MAP_FILE` 里的条目（`deny`），使
`@nexttime/egress-proxy` 在平台固定拒绝名单之上再收窄这一个来源的出网；只narrow，从不放宽。同时
以逗号拼接写进容器的 `nexttime.egress-deny` label，供 supervisor 重启后 `reconcile()` 从容器本身
恢复这份名单（否则重启会把这个字段静默清空，短暂放宽出网，直到该 Task 结束——见
`task-spawn-spec.ts`/`task-service.ts` 的模块注释）。省略时不注册任何每来源拒绝名单，行为与该字段
存在前完全一致。`/resident/spawn`（常驻入口容器）走同一套机制，见下一节。

**已删除**：早前这里还有一个 `skills: [{name, hostPath}]` 字段（只读 bind-mount 一个"已经在宿主机上
的文件"）。已随 fix/runtime-hardening（lane-6 review P1-3）整个删除，不再是请求体的合法字段——
S2.14 上线 `skillsInline` 之后，这个代码库里从未有任何调用方真正发送过它（kernel 只发
`skillsInline`），但它的允许路径校验（`isSkillHostPathAllowed`）覆盖的是**整个** `${NEXTTIME_DATA}/`
——包括 `secrets/handle.key`（Handle 签名私钥，0640 组 10001，Worker uid 可读）。删掉整个字段
（`TaskSkillSchema`/`TaskSkillMount`/`isSkillHostPathAllowed`）比只是把允许路径收紧到
`${NEXTTIME_DATA}/skills/` 更彻底：没有任何行为需要保留。

#### `skillsInline`（S2.14）

内核没有可写的数据挂载（`config:ro` 是它唯一的数据挂载，I9 相邻），没法先把一个已发布 Skill 的内容
写成宿主机文件再传路径进来。`skillsInline[]` 因此按内容传：内核
（`application/worker/skills.ts` `renderSkillMarkdownFile`）把已发布 Skill 渲染成 pi 的
`SKILL.md` 格式文本，随 spawn 请求体本身传过来；这个服务在 `docker.createAndStart` **之前**把每个
条目的 `files` 写进这个 Task 自己已经会挂载的 `<agentDir>/skills/<name>/` 目录（`task-service.ts`
`spawn()`）——不需要新增挂载，整个 Task 工作目录本来就整体挂在 `/workspace`。这是现在**唯一**能把
Skill 放进 Worker 容器的方式。

- `name`：安全单段路径规则（`config.ts`）。
- `files`：文件名 → 内容的映射；文件名必须是安全的相对路径（无前导 `/`、无 `.`/`..` 段，
  `isSafeSkillInlineFileName`），必须包含一个 `"SKILL.md"` 键（pi 的必需入口文件，`docs/skills.md`
  "Skill Structure"）；单文件 ≤ 512 KiB（`MAX_SKILL_INLINE_FILE_BYTES`），一个条目全部文件合计
  ≤ 2 MiB（`MAX_SKILL_INLINE_TOTAL_BYTES`）——都在 `config.ts` `TaskSkillInlineSchema` 里用
  `superRefine` 校验，不合规直接 `400`，不落到文件系统。

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
`WORKER_IMAGE_ALLOWLIST` 逗号列表追加，不会替换默认值）返回 `403`；请求体（含上述校验）不合法
`400`；`Authorization` 缺失或不对 `401`（见本文件顶部"内部认证"说明）。

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
  挂到 `/workspace/.pi/agent/models.json`（与 resident 模式同一目标路径，理由同上）。`skillsInline[]`
  条目按内容**写入**（不是 bind mount）到 `/workspace/.pi/agent/skills/<name>`——该路径是 pi 0.84.4
  的默认全局 skills 目录（`packages/coding-agent/src/core/skills.ts` `loadSkills`:
  `join(resolvedAgentDir, 'skills')`），对照参考项目验证过，不是猜测。**从不**挂载任何用户的入口
  工作区（I15）。**没有**任何调用方能再指定一个任意宿主机路径只读挂进 Worker 容器——早前的
  `skills[].hostPath` 字段本身已随 fix/runtime-hardening 整个删除（见上文"已删除"一条）。
- **CMD**：给了 `model` 就是 `['--model', model]`；`entrypoint.sh` 把容器 CMD 接在它自己固定的 pi
  flags 之后，不需要改那个脚本。
- **镜像 allowlist** 校验在 `server.ts`（不在这个纯函数里）——`buildTaskSpawnSpec` 只管把已校验过的
  `image` 放进 spec。

### 生命周期与状态机（`src/task-service.ts`）

`running -> exited | terminated | failed`——四态划分不是任务原文逐字给出的，是本次实现的显式假设
（见 PR body"假设与偏离"）：`terminated` = 本服务主动结束的（显式 `terminate` 或超时 reaper），
不看退出码（SIGKILL 后的退出码往往非 0，不该被误读成 failed）；其余按 Docker 退出码分类，`0` →
`exited`，非 0 → `failed`（借鉴 Kubernetes Job 的 Complete/Failed 划分）。

- **超时**：`timeoutSec`（或默认 `TASK_MAX_RUNTIME_SEC`，默认 3600）到期由周期性 `reap()`（默认
  10s 一次，`TASK_REAP_INTERVAL_MS`，`index.ts`——lane-6 review P2-7 从最初的固定 30s 收紧，见该
  字段自己在 `config.ts` 的文档注释；本文件早前这里写的"每 30s 一次"是过期表述，随
  feat/egress-docker-events 一并订正）杀掉，标 `terminated` + `reason:"timeout"`。
- **自然退出**：`reap()` 同一循环里也会发现自己退出的容器（无需等 `GET` 被轮询）；`GET
  /task/:workerRunId` 也会做一次同样的即时核对，所以刚退出就查询也能立刻看到终态，不用等下一次
  `reap()` tick。**feat/egress-docker-events**：容器真正死亡（`die`/`destroy`/`kill`/`stop`）现在
  还会经 Docker 自己的事件流（见下方独立一节）在约 1 秒内触发同一条 `reconcileOne` 路径——`reap()`
  仍然原样保留、作为这条事件流断线或从未连上时的兜底，不是被取代。
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

## 事件驱动的 egress 来源反注册（`src/docker-events.ts`，feat/egress-docker-events）

**背景/问题**：常驻入口容器与 Task/Worker 容器崩溃或被 `docker kill` 后，`SOURCE_MAP_FILE`
里那条 egress 来源登记（`egress-map.ts`）只有下一次周期性动作（resident 模式：下一次
`spawn()`/`sweepIdle()`；Task 模式：下一次 `reap()` tick，默认 `TASK_REAP_INTERVAL_MS=10s`）才会
摘除——这段窗口内，若 Docker 把这个已死容器的 IP 重新分配给另一个容器，egress-proxy 会把新容器的
流量误记到旧来源的 `sourceId` 上（fail-open）。

**修法**：`worker-supervisor` 现在同时经既有的 `dockerode` 客户端订阅 Docker Engine 自己的容器生命
周期事件流（`GET /events`，`docker-client.ts` `getContainerEvents`，经 `docker-socket-proxy`，见
docker-compose.yml 该服务块的 `EVENTS` flag 与其注释）——服务端过滤 `type=container`、
`event=die|destroy|kill|stop`、`label=nexttime.role`（裸 key，同时匹配 resident 模式的
`nexttime.role=entry` 与 Task 模式的 `nexttime.role=worker`，宿主机上其它容器的事件根本不会送达这
个进程）。匹配到一个已知容器（`ResidentService`/`TaskService` 各自新增的
`notifyContainerExited(containerId, action)`）时：

- **先核实容器真的死了**——Docker 的 `kill` 事件是"信号已发送"，不是"进程已退出"（`docker stop`
  的优雅 SIGTERM 最多可以等 `STOP_TIMEOUT_SECONDS` 秒才真正退出）；两个方法都会重新
  `docker.inspectByName`（Task 模式直接复用 `reconcileOne`），仍在跑就直接返回 `false`，不摘除、
  不动登记表——否则会把一个仍在合法运行、可能正在处理请求的容器提前判死。
- 走与 `reap()`/崩溃检测完全相同的 `unregisterEgress` 路径与登记表更新，只是触发时机提前到事件
  到达的那一刻（约 1 秒内），不是等下一次轮询。
- 打一行结构化日志（`level:'info', msg:'... container exited (docker event)', ...`）。
- 天然幂等——一次容器退出，Docker 可能连续发出 `kill` → `die` → `destroy`/`stop` 好几个事件，
  只有第一个"容器确认已死"的事件真正摘除，其余返回 `false`。

**这是既有轮询机制之上的补充，不是替代**：`reap()`（Task 模式）、`sweepIdle()`/`spawn()` 自身的崩溃
检测（resident 模式）原样保留、原有周期不变——事件流断线，或（`docker-socket-proxy` 的 `EVENTS`
flag 被设成 `0`，例如回滚）从未连上，`subscribeToContainerEvents`（`docker-events.ts`）只打**一条**
警告日志、之后带着封顶退避（初始 1s，倍增，封顶 30s）在后台无限重试，从不让整个 supervisor 崩溃——
上面这条 fail-open 窗口的上界回退到轮询机制原有的间隔，不会更差。

**断线重连**：事件流断开后按上面的退避重连；每次成功（re）连接之后（含启动时的第一次）都会重新跑一
遍 `residentService.reconcile()` + `taskService.reconcile()`——这两个方法本身对"已经认识的容器"是幂
等的，所以补这一趟不会有副作用；它真正的作用是补上断线期间可能错过的事件。**已知需要注意的一点**：
resident 模式的 `reconcile()` 原本只在进程启动时跑一次（那时登记表是空的），本次改动前它会无条件把
每个仍在跑的容器 `lastTouchedAt` 重置为"现在"——事件流频繁重连的极端情况下，重复调用 `reconcile()`
会不断刷新这个时间戳，等于悄悄关掉 `sweepIdle()` 的空闲超时。已在这次改动里修：`reconcile()` 现在
保留已知 principal 原有的 `lastTouchedAt`，只有真正首次发现（进程重启后的登记表为空）才写"现在"。

**启动顺序**：`index.ts` 的 `main()` 里，两个 `reconcile()` 先跑完，再启动事件订阅，再 `app.listen`
——与 `sweepIdle`/`reap`/`sweepRetention` 三个既有定时器完全并列，互不替代。

## Env vars

除常驻模式已有的那些（见 `src/config.ts` 顶部文档注释）外，Task 模式新增：

| Var | Default | Meaning |
|---|---|---|
| `TASK_MAX_RUNTIME_SEC` | `3600` | 单个 Task 容器的默认超时（秒），可被请求体 `timeoutSec` 覆盖。 |
| `TASK_WORKDIR_RETENTION_HOURS` | `72` | 已结束 Task 工作目录保留多久后清理。 |
| `WORKER_IMAGE_ALLOWLIST` | 空 | 逗号分隔的额外允许镜像列表；**追加**在默认 `WORKER_IMAGE` 之上，不会替换它。 |

## 测试

`src/test-support/fake-docker-client.ts` 是内存版 `DockerClient`（两种模式共用），从不碰真实 socket；
它的 `getContainerEvents()` 故意只是个 `throw`（哪个既有测试都不驱动事件流，见该方法自己的注释）——
`src/docker-events.test.ts` 单独用一个最小的、只实现 `getContainerEvents` 的假 docker（配一个可以
`.emit()` 的 `EventEmitter` 充当假事件流）来驱动 `subscribeToContainerEvents` 本身：已知容器
`die`→反注册+登记表更新、未知/畸形事件被忽略、流 `error` 触发重连+补一次 `reconcile()`、订阅本身建
不起来只打一条警告并在后台持续重试（`vi.useFakeTimers()` 驱动退避）。`ResidentService`/
`TaskService` 各自新增的 `notifyContainerExited` 在 `resident-service.test.ts`/
`task-service.test.ts` 里单独测（含"容器其实还在跑，不该被摘除"与"同一次退出的重复事件必须幂等"两条）。
`docker-client.ts` 本身（`dockerode` 实现）与两个 Dockerfile 都未在本机验证——本机没有 Docker（见
两个 Dockerfile 头部注释）；镜像构建与容器级行为在目标主机上验收，见
`docs/runbooks/host-worker-runtime.md`。
