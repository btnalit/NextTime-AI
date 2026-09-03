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
still exits non-zero"）。

`step2_docker_restart`/`step3_observe_no_worker` 断言的是**真实的 chat 驱动链路**（entry agent 自己
在对话里调 `find_workers`/`invoke_worker`/gate 观察工具）——这两步不再 SKIP，而是硬 `FAIL`：如果入口
agent 的最终回复文本命中 `"did not resolve"`（或整段回复为空），脚本判定为
`packages/platform-extension` 的 entry-mode 工具注册尚未部署（或部署了但被 §5 "已知偏离"里另一条更
深的架构限制挡住），打印 `kernel/platform-extension entry tools not deployed — needs PR fix/
entry-mode-tools` 并立即退出，而不是含糊地继续跑或悄悄 SKIP。换句话说：**本 runbook 描述的是"修复
落地后"应有的行为**；在修复落地前对着当前 `main` 跑这个脚本，预期结果是 step 2 在
`step2-chat-entry-tools` 上 FAIL（而不是给出 `S2 OK`），这是脚本设计的一部分，不是 bug。示例（真实
id/key 已脱敏）：

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
PASS step2-chat-reply entry agent replied: Started a Worker to restart the container — task <task-uuid> is now running, I will follow up once it reports back.
PASS step2-chat-task-created Task <task-uuid> created via chat, worker_definition_id=ops-runner (<uuid>)
PASS step2-list-pending actionRequestId=<uuid>
PASS step2-approval-card system.action_pending card for <uuid> landed in alice's chat
PASS step2-approve alice approved <uuid>
PASS step2-executed ActionRequest <uuid> executed
PASS step2-explain explain(Fact) -> Observation -> Activity -> Source + Principal chain resolved for the whole chat-driven docker-restart run
PASS step3-chat-reply entry agent replied with the fixture's real stock payload: The GET returned: {"symbol":"NXT","quantity":42,"asOf":"..."}
PASS step3-observe-operation-audited audit_records shows 1 observe_operation call(s)
PASS step3-chat-no-task tasks count unchanged (1) — observe-class gate tool call via chat never creates a Task/Worker
PASS step3-no-action-request action_requests count unchanged (N) — observe_operation never creates an ActionRequest
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

S2 OK
```

（`step2-approval-card`/`step4-approval-card` 两行如果 S2.11 的 linkage 消费者在本次主机上因为某种
时序原因没赶上，脚本会把它们降级成 `SKIP`——approval 链路本身（`list_pending`/`approve`/
`get_action`）不受影响，仍然全部 PASS，只是"卡片出现在对话里"这一条视觉断言单独 SKIP，见脚本内注释。
若确实出现，最后不会打印 `S2 OK`，而是打印 SKIP 汇总并以非 0 退出。）

**在 `packages/platform-extension` 的 entry-mode 工具注册修复落地之前**，对着当前 `main` 跑这个脚本，
预期在 `ops-runner-publish` 之后很快看到：

```
PASS ops-runner-publish ops-runner@1 published
FAIL step2-chat-entry-tools kernel/platform-extension entry tools not deployed — needs PR fix/entry-mode-tools (last assistant reply: 'echo: 重启测试容器 CONTAINER_ID=<id> (find_workers did not resolve — see docs/runbooks/host-accept-s2.md)')
```

脚本立即以非 0 退出（`fail()` 的既有行为，同 accept_s1.sh）——这是预期行为，不是本次改动的 bug，见
§5 "已知偏离"关于这条 FAIL 的两种可能根因。

## 4. 每一步对应 S2.12 七条验收的哪一条

| 脚本步骤 | S2.12 验收条目 | 证明什么 |
|---|---|---|
| `connect-ssh-*` / `connect-http-*` / `s213-*` | (1) A 用连接卡片接入测试 SSH 主机与测试 OpenAPI 服务 | `request_connection` → `create_connection`（ssh 走 `credentialKind:'shared'`，http 走 `credentialKind:'connected_account'` + 真实 `manifestSource` OpenAPI 导入）→ `publish_manifest` → `connect_gatekeeper`，与 `docs/runbooks/host-gatekeepers.md` §10 同一条路径；`s213-find-operations-*` 与 `s213-no-token-leak` 是折进本任务的 S2.13 验收句 |
| `connect-docker-*` | (2) 的前置——把已部署的 `gatekeeper-docker` 接进本次测试 workspace | 同一条 S2.13 流程，`target:"docker"` |
| `ops-runner-*` | (2)/(4) 的前置——`ops-runner` WorkerDefinition 存在且发布 | 读取真实 `ontology/ops-runner.yaml`（经 kernel 镜像里已有的 `yaml` 包解析，不是脚本自己编的提示词），补上 `capabilities:['request_action']` 与三个门的 `gates` |
| `step2-chat-reply` / `step2-chat-task-created` / `step2-list-pending` / `step2-approval-card` / `step2-approve` / `step2-executed` / `step2-explain` | (2) A 对话「重启测试容器」→ find_\* → invoke_worker → 卡片 → A 批准 → 执行 → explain 全链 | 真实 chat 驱动链路：`entryRestartChatScenario`（fake-llm）驱动入口 agent 依次调 `find_workers`/`invoke_worker`（真实工具结果链式传递，非硬编码 id），`step2-chat-task-created` 核对新 Task 的 `worker_definition_id` 确实是 ops-runner；`step2-chat-entry-tools`（未列在正常路径里，只在链路未解析时触发）FAIL 而非 SKIP——见 §5 "已知偏离" |
| `step3-chat-reply` / `step3-observe-operation-audited` / `step3-chat-no-task` / `step3-no-action-request` | (3) A 问「测试 API 的 GET 返回什么」→ 入口 agent 直接观察，不拉 Worker（task 数不变） | 真实 chat 驱动链路：`entryObserveChatScenario` 驱动入口 agent 调 `accept_s2_api_stock_get`（观察类 gate 投影工具，内部调 `observe_operation`——一个专门的、observe-only 的 capability，不是 `request_action`），回复文本回显该工具的**真实**返回数据（断言含 `NXT`）；`step3-observe-operation-audited` 核对 `audit_records` 确实记了一条 `observe_operation`；`step3-chat-no-task`/`step3-no-action-request` 核对 `tasks`/`action_requests` 表行数在消息前后都不变 |
| `step4-invoke-worker-1` … `step4-second-auto-approved` | (4) Worker 跑一条未分类命令 → 卡片 → 总是允许 → 第二次不再出卡片 | 两次 `invoke_worker`（同一条 `uptime` 命令）夹一次 `set_auto_approved_action_kind('ssh.run_command')`；`list_pending` 计数与 `action_requests.policy_decision` 分别从应用层与 DB 层双重验证第二次是 `auto_approved` |
| `step5-bob-forbidden` / `step5-still-pending` | (5) 用户 B 尝试批准 A 范围的动作 403 | bob（member）对 step 4 第一次调用产生的、真实处于 `pending_approval` 的 ActionRequest 调 `approve` → 403；随后确认该行状态未被这次失败尝试改变 |
| `step6-*` | (6) Worker 容器 `env | grep -ci api_key` 为 0；经代理 `curl https://example.com` 成功、直连内网失败 | 直接跑 `nexttime-ai-worker-runtime` 镜像（`workers` 网络 + 与真实 Worker 相同的 `HTTP(S)_PROXY`），见 §5 "已知偏离"关于为什么不经 Worker 自己的工具调用 |
| `step7-*` | (7) Worker 结果契约里的 Fact 入图为 `inferred` | 查 `links` 表 `epistemic_status` 列，`link_type='accept_s2_restarted'`（step 2 的 docker-restart Worker 通过 `report_result` 写入） |
| `cleanup` | — | 停 alice/bob 入口容器、`docker compose --profile accept-s2 down`；workspace 行留作审计留痕 |

## 5. 已知偏离

- **核心缺口 1（正在修——`fix/entry-mode-tools` 分支，draft PR "fix(entry): register S2 entry tools
  + observe_operation"）：`packages/platform-extension` 的 entry 模式从未注册 S2 新增的任何工具**——
  `packages/platform-extension/src/modes/entry.ts` 的 `OBSERVE_CAPABILITY_NAMES` 硬编码成 S1 的五个
  观察类工具（`get_object`/`traverse`/`search`/`explain`/`get_task`），整个文件只有这一处
  `pi.registerTool()` 调用点。`find_operations`/`find_workers`/`find_procedures`/`invoke_worker`/
  `request_connection`/`record_decision`/`propose_*`/观察类 gate 投影工具一个都没有注册成 pi
  工具——尽管 `ontology/entry-agent.yaml` 的 `capabilities` 列表与 `systemPrompt` 都明确要求它们。
  `scripts/accept_s2.sh` 的 `step2_docker_restart`/`step3_observe_no_worker` 现在断言的是**修复
  落地后**应有的真实 chat 驱动链路（不再 SKIP，见上方"期望输出"两种场景）：向 alice 的对话原样发送
  中文提问，读入口 agent 最终回复文本，若含 `"did not resolve"`（或为空）判定为该修复尚未部署，
  `FAIL step2-chat-entry-tools` / `step3-chat-entry-tools` 并给出可操作的错误信息，而不是含糊地继续
  跑或悄悄降级。`deploy/fake-llm/server.mjs` 的 `entryRestartChatScenario`/`entryObserveChatScenario`
  两个 scripted scenario 驱动真实的三段链路：`find_workers({need:'restart'})` →（用它的**真实**返回
  结果，而不是脚本预先猜的 id）`invoke_worker({definitionId, version, input, wait:false})` → 提到
  `taskId` 的收尾文本；`accept_s2_api_stock_get({})` →回显它的**真实**返回数据的收尾文本。

  gate 工具的注册时机是 `session_start`，只读一次 `list_allowed_operations`——而它只列出entry
  Handle **签发那一刻**的 `resources.gatekeeper` 已经覆盖的门（来自 `connect_gatekeeper` Grant）。
  本脚本的 `connections_step`（三个 `connect_gatekeeper` 调用）本来就排在 `step2_docker_restart`
  的第一条聊天消息之前，所以 alice 的入口容器不会在这些 Grant 存在之前就被首次发消息拉起、拿到一个
  过期的 Handle；`step2_docker_restart` 开头仍然显式加了一次防御性 `resident_stop`（该函数自己的
  头注释有完整说明），只为兜底"重跑同一 workspace/容器复用"这类边缘情形，正常路径下是空操作。

- **核心缺口 2（协调者已用一个专门的新 capability 部分解决——`observe_operation`，不是
  `request_action`）**：本次实现过程中发现，一个真实入口 Handle 无法调用任何声明了 `request_action`
  需求的 WorkerDefinition/工具——`governance/capability/handles.ts` 的 `ENTRY_CEILING_CAPABILITIES`
  按**capability 名字本身**（不是按目标 Operation 的 observe/execute 模式）永久排除 `request_action`
  （I11/§5.3 item 11 的字面机制：`authorize.ts` 的 `authorizeCapabilityCall` 在 handler 被调用之前
  就检查 `scope.capabilities.includes('request_action')`）。协调者的修复给 entry 模式的观察类 gate
  工具引入了一个**专门的、observe-only 的新 capability `observe_operation`**（而不是让它像 worker
  模式一样直接调 `request_action`），这条新路径不受上面这条限制——`step3_observe_no_worker`
  因此断言 `audit_records.action='observe_operation'`（而非 `request_action`）、Activity kind 仍是
  `gatekeeper_observe`、且 `tasks`/`action_requests` 两张表都不新增行。
  - **这条修复目前只覆盖 step 3（观察路径），不覆盖 step 2（执行路径）**：`ops-runner`
    WorkerDefinition 声明的 `capabilities:['request_action']`（Worker 自己需要用它触达
    `container.restart` 这个 **execute** 类 Operation，`observe_operation` 不适用于 execute
    路径）仍然会撞上同一条 `ENTRY_CEILING_CAPABILITIES` 限制——`application/task/service.ts` 的
    `findWorkers` 用 `computeChildHandleScope` 空跑一遍来筛选候选，会把声明了 `request_action`
    的 `ops-runner` 从结果里筛掉；即使强行拿到 definitionId，`invoke_worker` 也会抛
    `InvokeWorkerAttenuationError`。这条限制是 S2.7 落地时**特意加上的**（"入口 Handle 请求含
    execute 的子 Handle 被拒"是 S2.7 自己的验收条目），本 runbook 记录下来供后续判断，不代为决定
    要不要、或如何放开它——那是 `packages/kernel` 的治理模型决定。
  - `scripts/accept_s2.sh` 目前**无法**从 alice 的最终回复文本单独区分"核心缺口 1 未修"和"核心缺口
    2 仍然挡住 step 2 的执行路径"——两种情况下 `entryRestartChatScenario` 的 fallback 分支都会产出
    含 `"did not resolve"` 的文本，`step2-chat-entry-tools` 因此用同一条 FAIL 信息覆盖两种根因；
    哪一种是真实原因需要看 kernel 日志/`docker exec` 进入口容器核对。step 3 不受此影响——见上一段。

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
