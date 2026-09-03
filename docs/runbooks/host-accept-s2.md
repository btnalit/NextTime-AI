# Runbook：host-accept-s2（S2 验收脚本）

对应任务：development-tasks.md § S2.12。前置：`docs/runbooks/accept-s1.md`（S1 全套已跑通，
`scripts/accept_s2.sh` 复用其 preflight/bootstrap/driver 约定）、`docs/runbooks/host-gatekeepers.md`
（§5 CLI 注册路径、§10 S2.13 capability 驱动的连接流程——本脚本走的正是 §10 那条路径，对三个门各走
一遍）。占位符取值见 `docs/private/`（不入库）。

## 1. 前提

- `docker compose --profile test up -d` 已起（`postgres kernel caddy llm-proxy egress-proxy
  worker-supervisor agent-host fake-llm`），且 `docker compose up -d gatekeeper-docker` 已起（这个
  服务不在任何 profile 下，`docker compose up -d` 默认就会拉起，只是显式点名确保）。
- `${NEXTTIME_DATA}/config/llm-providers.yaml` 已指向 `fake` provider（同 accept-s1.md §1）。
- 迁移已跑到最新。
- `docker compose --profile build-only build worker-runtime` 已跑过一次，产出
  `nexttime-ai-worker-runtime` 镜像（step 6 直接跑这个镜像做 env/egress 探测，见 §5 "已知偏离"）。
- `docker compose --profile accept-s2 build` 未跑过也没关系——`scripts/accept_s2.sh` 自己的
  preflight 步骤会构建 `accept-s2-sshd`/`accept-s2-openapi`/`accept-s2-ssh-gate`/
  `accept-s2-http-gate` 四个镜像（`accept-s2-restart-target` 直接用官方 `alpine:3.20`，无需构建）。
- 主机上有 `docker`、`docker compose`、`curl`、`psql`（经 `docker compose exec postgres`）；**没有**
  `node`/`corepack`/`ssh-keygen`——脚本把每一次 JSON-RPC 交互、每一次密钥生成都放进一次性容器里跑
  （见脚本头注释）。

## 2. 怎么跑

```
cd <CODE_DIR>
sh scripts/accept_s2.sh
```

经 SSH 跑（`</dev/null`，同 accept_s1.sh 的既有约定）：

```
ssh <TARGET_HOST> 'cd <CODE_DIR> && sh scripts/accept_s2.sh' </dev/null
```

`--keep`：跳过 `accept-s2` profile 的清理，保留 sshd/openapi 两个测试系统与两个门容器、workspace
（排障用）：

```
sh scripts/accept_s2.sh --keep
```

## 3. 期望输出

逐步打印 `PASS <step> <detail>` / `SKIP <step> <detail>`；任何一步真失败打印 `FAIL <step> <detail>`
并立即以非 0 退出。**全部 PASS/FAIL 判定跑完后，如果期间出现过任何 SKIP，脚本打印 SKIP 汇总并以非 0
退出，不打印 `S2 OK`**（这是本任务派发文字自己的约定："a script that finishes with `SKIP:<reason>`
still exits non-zero"——见 §5 "已知偏离"，本次运行确实会以 SKIP 收尾，原因是一个真实存在的
`packages/platform-extension` 缺口，不是脚本本身的缺陷）。示例（真实 id/key 已脱敏）：

```
PASS preflight-services running: postgres kernel caddy llm-proxy egress-proxy worker-supervisor agent-host fake-llm gatekeeper-docker
PASS preflight-fake-provider fake provider configured in .../config/llm-providers.yaml
PASS preflight-migrations up to date
PASS preflight-worker-runtime-image nexttime-ai-worker-runtime present
PASS preflight-accept-s2-build accept-s2 fixture/gate images built
PASS bootstrap-workspace workspace=<uuid> alice=<uuid> key=abc123...(redacted)
PASS bootstrap-bob bob=<uuid> (member) key=def456...(redacted)
PASS fixtures-ssh-keygen keypair generated into ${NEXTTIME_DATA}/accept-s2/ssh/
PASS fixtures-store-key ConnectedAccount store key generated into ${NEXTTIME_DATA}/accept-s2/http-gate/
PASS fixtures-api-token bearer token generated: 9f3a1c...(redacted)
PASS fixtures-up accept-s2-sshd, accept-s2-openapi, accept-s2-restart-target up
PASS fixtures-gates-up accept-s2-ssh-gate, accept-s2-http-gate healthy
PASS fixtures-restart-target restart target container id=<64-hex-id>
PASS connect-ssh-request connectionRequestId=<uuid>
PASS connect-ssh-create gatekeeperId=<uuid>
PASS connect-ssh-publish ssh manifest published
PASS connect-ssh-grant ssh gatekeeper granted to alice
PASS connect-http-request connectionRequestId=<uuid>
PASS connect-http-create gatekeeperId=<uuid> (imported from manifestSource OpenAPI doc)
PASS s213-find-operations-pre-publish find_operations('stock') misses before publish_manifest, as required
PASS connect-http-publish http manifest published
PASS s213-find-operations-post-publish find_operations('stock') hits after publish_manifest (1 result(s))
PASS connect-http-grant http gatekeeper granted to alice
PASS s213-no-token-leak bearer token appears in 0 rows across all NN public tables
PASS connect-docker-request connectionRequestId=<uuid>
PASS connect-docker-create gatekeeperId=<uuid>
PASS connect-docker-publish docker manifest published
PASS connect-docker-grant docker gatekeeper granted to alice
PASS ops-runner-propose definitionId=<uuid> version=1
PASS ops-runner-publish ops-runner@1 published
PASS step2-chat-no-task-created tasks count unchanged (0) after '重启测试容器' — confirms entry mode never actually called invoke_worker via chat
SKIP step2-chat-find-and-invoke entry agent cannot call find_*/invoke_worker via chat (platform-extension gap, see docs/runbooks/host-accept-s2.md 已知偏离) — chat turn status was 'completed'
PASS step2-invoke-worker invoke_worker(ops-runner, docker_restart) -> ["completed","<task-uuid>"]
PASS step2-list-pending actionRequestId=<uuid>
PASS step2-approval-card system.action_pending card for <uuid> landed in alice's chat
PASS step2-approve alice approved <uuid>
PASS step2-executed ActionRequest <uuid> executed
PASS step2-explain explain(Fact) -> Observation -> Activity -> Source + Principal chain resolved for the whole find_workers-less docker-restart run
PASS step3-chat-no-task tasks count unchanged (1) after the chat message (trivially true given the platform-extension gap — see SKIP below)
SKIP step3-chat-observe entry agent has no registered tool for any gate observe-class Operation (platform-extension gap, see docs/runbooks/host-accept-s2.md 已知偏离)
PASS step3-direct-observe request_action(stock.get) -> ["ok",{"symbol":"NXT","quantity":42,"asOf":"..."}]
PASS step3-no-task-created tasks count unchanged (1) — observe-class operation never creates a Task/Worker
PASS step4-invoke-worker-1 first ssh Worker run -> pending_approval
PASS step4-list-pending-1 actionRequestId=<uuid> (unclassified command, no auto-approve policy yet)
PASS step4-approval-card system.action_pending card for <uuid> landed in alice's chat
PASS step5-bob-forbidden bob (member) approve(<uuid>) -> 403
PASS step5-still-pending ActionRequest <uuid> unaffected by bob's forbidden attempt
PASS step4-approve-1 alice approved <uuid>
PASS step4-executed-1 first ssh run executed
PASS step4-always-allow workspace policy: ssh.run_command auto-approved from now on
PASS step4-invoke-worker-2 second ssh Worker run -> auto_approved
PASS step4-no-second-card list_pending unchanged (0) — second identical run produced no approval card
PASS step4-second-auto-approved second ActionRequest (<uuid>) resolved policy_decision=allow (auto_approved) directly, no human decision required
PASS step6-no-api-key-env 0 api_key-shaped env vars in the Worker image's env
PASS step6-direct-lan-fails direct curl to an internal address failed as expected (curl rc=..., http_code='000')
PASS step6-proxied-egress-ok https://example.com -> 200 via egress-proxy
PASS step7-fact-inferred Fact <uuid> (accept_s2_restarted, from the docker-restart Worker's report_result) has epistemic_status=inferred
PASS step7-fact-asserted-by-agent Fact asserted_by principal kind='agent' (kernel records the assertion itself as kind='agent' per application/task/result.ts, deriving inferred — see docs/runbooks/host-accept-s2.md)
PASS cleanup stopped alice/bob entry containers, tore down the accept-s2 profile; workspace retained: <uuid>

accept_s2: 2 step(s) skipped — see SKIP lines above for exact reasons:
SKIP step2-chat-find-and-invoke ...
SKIP step3-chat-observe ...
accept_s2: known, documented platform gaps (docs/runbooks/host-accept-s2.md 已知偏离), not script defects — see that runbook before re-running.
```

（`step2-approval-card`/`step4-approval-card` 两行如果 S2.11 的 linkage 消费者在本次主机上因为某种
时序原因没赶上，脚本会把它们降级成 `SKIP`——approval 链路本身（`list_pending`/`approve`/
`get_action`）不受影响，仍然全部 PASS，只是"卡片出现在对话里"这一条视觉断言单独 SKIP，见脚本内注释。）

## 4. 每一步对应 S2.12 七条验收的哪一条

| 脚本步骤 | S2.12 验收条目 | 证明什么 |
|---|---|---|
| `connect-ssh-*` / `connect-http-*` / `s213-*` | (1) A 用连接卡片接入测试 SSH 主机与测试 OpenAPI 服务 | `request_connection` → `create_connection`（ssh 走 `credentialKind:'shared'`，http 走 `credentialKind:'connected_account'` + 真实 `manifestSource` OpenAPI 导入）→ `publish_manifest` → `connect_gatekeeper`，与 `docs/runbooks/host-gatekeepers.md` §10 同一条路径；`s213-find-operations-*` 与 `s213-no-token-leak` 是折进本任务的 S2.13 验收句 |
| `connect-docker-*` | (2) 的前置——把已部署的 `gatekeeper-docker` 接进本次测试 workspace | 同一条 S2.13 流程，`target:"docker"` |
| `ops-runner-*` | (2)/(4) 的前置——`ops-runner` WorkerDefinition 存在且发布 | 读取真实 `ontology/ops-runner.yaml`（经 kernel 镜像里已有的 `yaml` 包解析，不是脚本自己编的提示词），补上 `capabilities:['request_action']` 与三个门的 `gates` |
| `step2-chat-*` / `step2-invoke-worker` / `step2-list-pending` / `step2-approval-card` / `step2-approve` / `step2-executed` / `step2-explain` | (2) A 对话「重启测试容器」→ find_\* → invoke_worker → 卡片 → A 批准 → 执行 → explain 全链 | 见 §5 "已知偏离"——chat 驱动的 find_\*/invoke_worker 半条链路 SKIP；`invoke_worker`→卡片→批准→执行→`explain` 半条链路直接经 human 通道验证，链路本身完整无缺口 |
| `step3-chat-*` / `step3-direct-observe` / `step3-no-task-created` | (3) A 问「测试 API 的 GET 返回什么」→ 入口 agent 直接观察，不拉 Worker（task 数不变） | 同上：chat 驱动的观察半条链路 SKIP；`request_action(mode=observe)` 从不创建 Task 这条机制本身直接验证 |
| `step4-invoke-worker-1` … `step4-second-auto-approved` | (4) Worker 跑一条未分类命令 → 卡片 → 总是允许 → 第二次不再出卡片 | 两次 `invoke_worker`（同一条 `uptime` 命令）夹一次 `set_auto_approved_action_kind('ssh.run_command')`；`list_pending` 计数与 `action_requests.policy_decision` 分别从应用层与 DB 层双重验证第二次是 `auto_approved` |
| `step5-bob-forbidden` / `step5-still-pending` | (5) 用户 B 尝试批准 A 范围的动作 403 | bob（member）对 step 4 第一次调用产生的、真实处于 `pending_approval` 的 ActionRequest 调 `approve` → 403；随后确认该行状态未被这次失败尝试改变 |
| `step6-*` | (6) Worker 容器 `env | grep -ci api_key` 为 0；经代理 `curl https://example.com` 成功、直连内网失败 | 直接跑 `nexttime-ai-worker-runtime` 镜像（`workers` 网络 + 与真实 Worker 相同的 `HTTP(S)_PROXY`），见 §5 "已知偏离"关于为什么不经 Worker 自己的工具调用 |
| `step7-*` | (7) Worker 结果契约里的 Fact 入图为 `inferred` | 查 `links` 表 `epistemic_status` 列，`link_type='accept_s2_restarted'`（step 2 的 docker-restart Worker 通过 `report_result` 写入） |
| `cleanup` | — | 停 alice/bob 入口容器、`docker compose --profile accept-s2 down`；workspace 行留作审计留痕 |

## 5. 已知偏离

- **核心缺口：`packages/platform-extension` 的 entry 模式从未注册 S2 新增的任何工具**（这是本次运行
  两条 SKIP 的唯一根因，也是本任务交付范围内**不允许自己动手修**的一处 `packages/platform-extension`
  缺口——task brief 明确"Do not modify … packages/platform-extension … source"，且要求"do not hack
  around it … the main session fixes kernel code"）：
  - `packages/platform-extension/src/modes/entry.ts` 的 `OBSERVE_CAPABILITY_NAMES` 硬编码成 S1 的
    五个观察类工具（`get_object`/`traverse`/`search`/`explain`/`get_task`），整个文件只有这一处
    `pi.registerTool()` 调用点（`grep -n registerTool` 可自行核对）。`find_operations`/
    `find_workers`/`find_procedures`/`invoke_worker`/`request_connection`/`record_decision`/
    `propose_*` 一个都没有注册成 pi 工具——尽管 `ontology/entry-agent.yaml`（S2.6 种下、`create-
    workspace` 自动发布）的 `capabilities` 列表明确把它们全部列为"S2 additions"，且它自己的
    `systemPrompt`（"## Three-tier orchestration"一节）逐字指导模型去调用 `find_operations`/
    `find_workers`/`find_procedures`/`invoke_worker`/`request_connection`。
  - `<gate>.<op>` 观察类工具投影（`packages/shared/src/capabilities.ts` 自己的注释："Available to
    entry and Worker Handles"）同样只在 **Worker** 模式实现了（`modes/worker.ts` 的
    `session_start` 调 `list_allowed_operations` 动态注册）；entry 模式没有任何等价机制，甚至
    `request_action` 本身（唯一能触达门的能力）在 `governance/capability/handles.ts` 的
    `ENTRY_CEILING_CAPABILITIES` 里就结构性地不存在（它是 `mode:'execute'` 的 capability，S2.7
    实现说明原话："`ENTRY_CEILING_CAPABILITIES` 结构上从不包含任何 execute 类名字"）——即使只是想
    观察，entry Handle 也没有一条能打到门上的路径。
  - 这不是一个"入口 agent 偶尔调用失败"的边缘情况，是**入口 agent 完全没有能调用这些工具的手段**：
    `packages/platform-extension/src/entry.sdk.test.ts`（真实 pi SDK 驱动的契约测试，本任务运行时
    确认仍然只覆盖"the five S1 tools"）与 `entry.test.ts` 都没有任何一条用例覆盖这些工具。
  - **影响范围**：S2.12 验收条目 (2)"chats「重启测试容器」→ find_\* → invoke_worker"与 (3)"问
    「测试 API 的 GET 返回什么」→ 入口 agent 直接观察"里"由入口 agent 在对话中自己决定调用这些工具"
    这一半，在当前代码库上无法真正发生。`scripts/accept_s2.sh` 的 `step2_docker_restart`/
    `step3_observe_no_worker` 两个函数各自：① 仍然把这两句中文原样发进 alice 的对话（`deploy/
    fake-llm/server.mjs` 的 `entryRestartChatScenario`/`entryObserveChatScenario` 两个已经写好、
    随时可用的 scripted scenario，脚本第一天就在跑它们，只是它们注定打不到任何真实工具）；② 用
    `tasks` 表行数在消息前后不变佐证"入口 agent 确实什么都没触发"；③ 显式 `skip` 并原样打印这条
    根因；④ 紧接着用**同一批门/同一个 ops-runner WorkerDefinition**、经 human 通道直接调
    `invoke_worker`/`request_action`（与 `docs/runbooks/host-gatekeepers.md` §6/§10 已经确立的
    "owner 直接测试"惯例完全一致——`request_action`/`invoke_worker` 声明 `channel:'handle'`，但
    human 通道对任何 `channel:'handle'` capability 都放行），把"卡片 → 批准 → 执行 → explain"与
    "观察不建 Task"这两条**链路本身**完整、真实地验证一遍——这两条链路在内核/门这一侧没有任何缺口，
    缺的只是"入口 agent 自己决定调用它们"这一层，而这一层的落点明确是
    `packages/platform-extension`，不是本任务允许触碰的文件。
  - **修复方向供参考**（不是本任务交付物，留给主机之外的下一个任务）：`entry.ts` 需要一个类似
    `worker.ts` 的 `list_allowed_operations` → 动态注册 `<gate>.<op>` 工具 的机制（用哪个 capability
    描述"entry Handle 当前能观察哪些门"目前也不存在，需要先补一个），并把 `OBSERVE_CAPABILITY_NAMES`
    扩成 `entry-agent.yaml` 已经声明的完整 S2 列表（`find_operations`/`find_workers`/
    `find_procedures`/`invoke_worker`/`request_connection`/`record_decision`/`propose_*`）。

- **`ssh.run_command` 的 `auto_approvable:true`（而非字面"未分类"对应的 `false`）—— 一处刻意的、有
  文档说明的设计选择，不是偏离原意，而是把任务原文的"未分类命令"落到代码库唯一能让"总是批准此类"
  真正生效的形状上**：`governance/policy/engine.ts` 的 `evaluate()` 对 `operationAutoApprovable:
  false` 的判断（`operation_not_auto_approvable` 分支）**无条件**先于任何工作区策略检查——I17 的
  "未分类操作"在这套实现里就是"永远不可能被任何工作区策略自动批准"，`request-action-handler.ts`
  自己的模块注释原话："operationAutoApprovable=false forces require_approval … regardless of
  workspace policy"。如果把 `deploy/accept-s2/ssh-gate-manifest.json` 的 `ssh.run_command` 声明成
  `auto_approvable:false`，S2.12 验收条目 (4) 要求的"勾『总是允许』→ 第二次不再出卡片"在当前代码库上
  永远不可能发生（不是脚本没写对，是这条规则本身结构性地禁止它）。因此本任务把它声明成
  `auto_approvable:true, blast_radius:medium`——默认（无工作区策略时）仍然 `require_approval`（因为
  `medium` 不是 `low`，S2.3 的默认策略表"low 自动批准、medium/high 与未分类要人批"依然生效），第一次
  调用确实产生一张卡片；`set_auto_approved_action_kind('ssh.run_command')` 之后第二次调用才真正解析
  成 `allow`。"未分类"这个词在本次实现里对应的是 `accept-s2-ssh-gate` 自己的 `GATE_SSH_POLICY_FILE`
  故意留空（`[]`）——该门的 `SshTransport.classifyCommand`（`packages/gatekeeper-base/src/kinds/
  ssh.ts`）因此把每一条命令都判成 `unclassified:true`，写进 `apply`/`simulate` 返回的
  `detail.classification` 里；这条运行期分类是**信息性的**（供人审批时参考），从未被
  `governance/policy` 读取或影响治理判定——治理判定的唯一输入是已发布 Operation 自己的
  `auto_approvable`/`blast_radius`（`request-action-handler.ts` 的 `getPublishedOperation`）。

- **五个 accept-s2 fixture/gate 服务共用既有的 `control` 网络，未新建专属网络**：
  `application/gateway/connection-handlers.ts` 的 `create_connection` 由**内核进程自己**发起
  `manifestSource`（OpenAPI 文档）的 HTTP 抓取（`resolveManifestOperations`），因此 openapi
  fixture 必须能被 `kernel` 直接触达；`kernel` 现有的网络列表（`[control, workers]`）是既有服务的
  一部分，本任务的 docker-compose.yml 改动被要求"additive only"（只加新服务/网络/卷，不改已有服务
  字段）——给 `kernel` 追加第三个网络会改写它已有的 `networks:` 字段，超出这条边界。把五个 fixture/
  gate 放进 `control`（而不是一个只有两个门能进的专属网络）不会削弱"Worker 直连失败"这条验收：
  `worker-supervisor` 的 spawn spec（S2.8）只给 Worker 容器挂 `internal:true` 的 `workers` 网络，
  一个 Worker 物理上就没有到 `control` 上任何服务（含 postgres/kernel/两个门/两个 fixture）的路由，
  这条隔离边界与 fixture 具体挂在哪个 `control` 子网无关——`scripts/accept_s1.sh` 早就用同一个事实
  验证过一次（`http://postgres:5432` 直连失败）。`step6_env_and_egress` 额外直接对 `http://
  postgres:5432` 做了同款探测（借道 `--noproxy '*'`），佐证这条边界本身与本任务是否新建专属网络
  无关。

- **step 6 不经真实 Worker 的工具调用，改用 `docker compose run` 直接跑 `nexttime-ai-worker-runtime`
  镜像**：`packages/platform-extension` 的 `worker` 模式（`modes/worker.ts`）只注册两类工具——
  `list_allowed_operations` 动态生成的门工具、以及 `report_result`——不存在任何通用 shell/bash 工具
  可以让一个 fake-llm scripted scenario 要求 Worker 自己跑 `env | grep -ci api_key` 或
  `curl`。task brief 本身列出了这条回退路径（"if the worker runtime exposes no shell tool, fall
  back to `docker compose run --rm --no-deps -T worker-runtime sh -c '…'` with the same network as
  real Workers and document the deviation"）——本任务采用它：`--entrypoint sh` 绕过
  `deploy/worker-runtime/entrypoint.sh`（否则 `sh -c '…'` 会被当成 `pi` 自己的 CLI 参数，见该
  entrypoint 脚本尾部的 `exec pi … "$@"`），显式设置 `HTTP_PROXY`/`HTTPS_PROXY=http://
  egress-proxy:3128`（`worker-supervisor` 给真实 Worker 注入的同一个值，`docker-compose.yml`
  `HTTP_PROXY_FOR_WORKERS`），`--network workers`。**附带证据**（非本步骤的主断言，只是佐证）：
  `deploy/worker-runtime/entrypoint.sh` 自己的 S2.9 "worker-mode self-check" 在**每一个**真实
  Worker 容器启动时（`NEXTTIME_MODE=worker`）已经无条件跑过一遍等价检查（`check=api_key_env`/
  `check=egress_no_direct_route`/`check=egress_via_proxy`，任何一项失败该容器直接非零退出、拒绝
  启动 pi）——step 2/4 已经真实 spawn 过的 Worker 容器如果这条自检没通过，那两步会先失败在别处，
  step 6 因此不是这条边界在本次运行里唯一被验证到的地方，只是唯一一处用**字面**
  `env | grep -ci api_key`（而不是 entrypoint.sh 自己更窄的 `_API_KEY=` 正则）断言的地方。

- **`step2-approval-card`/`step4-approval-card` 可能 SKIP 而非 FAIL**：S2.11 的
  `application/linkage` 消费者是异步的（订阅 outbox 的 `ActionRequestPending` 事件，`AGENT_RUNTIME
  =fake` 下走 kernel 自己的 200ms 轮询捡走）——脚本在 `invoke_worker` 返回之后立即查 `list_pending`
  （同步、确定性），但对话里出现卡片消息理论上可能还差最后一次轮询节拍。脚本对这条视觉断言单独降级
  为 SKIP（不是 FAIL）而不是重试到超时，是因为 `list_pending`/`approve`/`get_action` 这条**真正的
  治理链路**从不依赖它——即使这一行真的因为时序 SKIP，approve/execute/explain 仍然全部真实通过。

## 6. 清理

`--keep` 不传时，`cleanup_step` 会：`docker compose --profile accept-s2 down`（移除
`accept-s2-sshd`/`accept-s2-openapi`/`accept-s2-ssh-gate`/`accept-s2-http-gate`/
`accept-s2-restart-target` 五个容器）、经 `worker-supervisor` 的 `/resident/stop` 停 alice/bob 的
入口容器。workspace/principal/chat/activity/graph 行按设计文档 §12 的审计留痕原则保留，不清理。

`${NEXTTIME_DATA}/accept-s2/`（生成的 ssh 密钥对、ConnectedAccount store key）**不会**被这次清理
删除——它不是仓库内容，重复运行脚本时如果这些文件已存在会直接复用（`fixtures_secrets_step` 的
`if [ ! -f ... ]` 判断），不会每次都重新生成一套新密钥。需要彻底清场时手动
`rm -rf "${NEXTTIME_DATA}/accept-s2"`。
