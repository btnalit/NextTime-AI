# Runbook：host-accept-s2（S2 验收脚本）

对应任务：development-tasks.md § S2.12。前置：`docs/runbooks/accept-s1.md`（S1 全套已跑通，
`scripts/accept_s2.sh` 复用其 preflight/bootstrap/driver 约定）、`docs/runbooks/host-gatekeepers.md`
（§5 CLI 注册路径、§10 S2.13 capability 驱动的连接流程——本脚本走的正是 §10 那条路径，对三个门各走
一遍）。占位符取值见 `docs/private/`（不入库）。

## 1. 前提

- `docker compose --profile test up -d` 已起（`postgres kernel caddy llm-proxy egress-proxy
  worker-supervisor agent-host fake-llm`），且 `docker compose up -d gatekeeper-docker` 已起（这个
  服务不在任何 profile 下，`docker compose up -d` 默认就会拉起，只是显式点名确保）。
- 不需要手动切换 provider：脚本自己会通过 `deploy/accept/docker-compose.fake.yml` 把 llm-proxy /
  worker-supervisor / fake-llm 切到 fake provider，kernel 也随之重启到 fake 的模型目录（发布
  WorkerDefinition、设模型时 kernel 按目录校验模型，legacy 302），并在退出时用 EXIT trap 恢复生产配置
  （kernel 再重启一次）——
  `${NEXTTIME_DATA}/config/llm-providers.yaml` 与 `${NEXTTIME_DATA}/models/models.json`
  全程不会被改动，跑前跑后都不用重跑
  `make gen-models`（同 accept-s1.md §1）。
- 切换和恢复之后脚本会等 agent-host 重新连上 kernel；切换期间生产目标里指定了模型的步骤会停下（遗留 545）；恢复失败按 P1 处理（遗留 548）。三条的做法见 accept-s1.md §1。
- `fake-llm` 镜像不用手动重建：`deploy/fake-llm/server.mjs` 的脚本化场景烤在镜像里，脚本切 fake provider 时（`accept_provider_up`）先用当前检出 `docker compose --profile test build fake-llm`，再重建容器。之前要手动重建，`apply-release.sh` 也不建它（`build-images.sh` 不建 `test` profile），主机和预发的 apply 阶段会一直用最早那次构建的镜像，新增的场景匹配不上，入口 agent 只会回 echo（#728 第 9 步在预发上就是这样失败的）。
- 迁移已跑到最新。
- `docker compose --profile build-only build worker-runtime` 已跑过一次，产出
  `nexttime-ai-worker-runtime` 镜像（step 6 直接跑这个镜像做 env/egress 探测，见 §5 "已知偏离"）。
- `docker compose --profile accept-s2 build` 未跑过也没关系——`scripts/accept_s2.sh` 自己的
  preflight 步骤会构建 `accept-s2-sshd`/`accept-s2-openapi`/`accept-s2-mcp` 三个裸 fixture 镜像
  （基础镜像 + COPY；sshd 另有一层 `apk add openssh-server`）。基础镜像、BuildKit frontend 和
  构建缓存都在主机上时不出网；但新主机或 `docker builder prune` 之后，sshd 那一层要重新访问
  Alpine CDN——这是遗留 137 之后验收仍剩的出网点，不是"完全离线"。
  `accept-s2-ssh-gate`/`accept-s2-http-gate` 两个门**不再**在主机上源码构建（遗留 137）：它们与
  `gate-host` 是同一个 `packages/gatekeeper-base/Dockerfile`、同一个 context、没有 build args，
  preflight 直接把本次发布装上的 `gate-host` 镜像（`pull-images.sh` 验过签的，或 `build-images.sh`
  的）重打成这两个 compose 名字（`preflight-accept-s2-gate-image`，核对规则同
  `host-accept-s3.md` 的 `preflight-collector-image`）。源码构建它们要现场走 npm 出网，
  而且验收的会是一份没验过签的主机构建，而不是发布的门代码。
  `accept-s2-restart-target` 直接用官方 `alpine:3.20`，无需构建。
  `accept-s2-mcp`（S3.12 新增）是 `connect-mcp-*` 步骤用的最小 MCP fixture（`initialize`/
  `tools/list`/`tools/call`，两个工具），没有独立前置门——`create_connection` 对 `kind:'mcp'` 的清单
  导入直接由内核进程调 `manifestSource`（`McpTransport.listTools`），不经过门；两个工具不需要凭证，
  这一步用 `credentialKind:'shared'`（也是唯一不触发 `create_connection` 向 `endpoint` POST
  ConnectedAccount 凭证的取值），因此不需要像 http/ssh 那样另建一个 `gatekeeper-base` 前置门实例。
- **自连门的连接密钥与出站目标判定（R-01 / R-27，维护者决定 D-01）**：`accept-s2-ssh-gate` /
  `accept-s2-http-gate` 是自连门（经 `create_connection` 接入），不再挂 `gate_token`——脚本用 alice
  的 key 调 `mint_connection_secret` 给每个门各签一把连接密钥，写进
  `${NEXTTIME_DATA}/accept-s2/<门>/kernel.token`（门的 `GATE_KERNEL_TOKEN_FILE`）再起门，健康检查用这把
  密钥，并断言平台 `gate_token` 被这个门拒绝；`create_connection` 带同一把 `connectionSecret`。验收夹具都
  在平台自己的 `control` 网络上、用裸服务名，内核的出站目标判定默认拒绝这种地址——除了 `docker-compose.yml`
  固定写给 kernel 的验收夹具清单 `NEXTTIME_CONNECTION_FIXTURE_HOSTS`（`accept-s2-ssh-gate,accept-s2-http-gate,
  accept-s2-openapi,accept-s2-mcp`，常量，`validate-compose.mjs` 保证全是 `accept-*` 夹具、都不挂
  `gate_token`）。永久放行它们不授予任何东西：名字只在 `accept-s2` profile 起着时才解析得到，夹具门只认绑定到
  验收工作区的连接密钥。**脚本不重启 kernel**；`worker-supervisor` 等平台服务不在清单里，照样被拒
  （`connect-mcp-target-refused` 验的就是这个）。
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

`--real <provider/model> [--runs N]`（W7）：保留主机上已部署的真实 provider，把 step2/3/4/5/7
换成用真实模型跑、按结果判定的场景，重复 `--runs` 次（默认 3）——不切换到 fake provider，也不需要
跑完后切回来。用法、每个场景判定什么、怎么读 `RUN`/`REAL` 输出，见专门的
`docs/runbooks/host-accept-real-model.md`。

fake 路径在第 9 步之后还跑目标场景 S1、S2、S4–S14（S11 GO7a，`scripts/lib/accept-s2-goals.sh`；S13 是 GO9a/GO9b
的目标规划器，遗留 549；S14 是 GO14 的步骤间文件交接），比以前多 20 到 25 分钟：S6 的验收检查和 S4 反向的核对检查故意不成立，平台按各自的
重试上限（默认 5 次、约 7.5 分钟）重试完才暂停，S1、S11、S13、S14、S5、S4、S7、S9、S10、S12、S8 在这段时间里依次
跑完；S2 最后单独跑。

**S12 和 S2 会中断服务，默认不跑，只在环境变量 `ACCEPT_DISRUPTIVE=1` 时跑。** S2 `SIGKILL` 内核两次、重启
`worker-supervisor` 一次（都是本项目自己的服务，脚本随即拉起并等健康检查通过，每次中断约 20 秒：这期间控制台和
API 不可用，正在跑的入口 agent 会断线重连，每个 Task 容器短暂失去 supervisor）；S12 和 S2 还在 postgres 里锁住
自己目标的一行（S12 至多 90 秒，S2 至多 180 秒）。不设这个变量时两者都不跑，日志里只有一行
`NOTE goal-disruptive S12 (…) and S2 (…) not run: ACCEPT_DISRUPTIVE=unset, not 1 …`（`apply-release.sh` 的 S2
摘要也打印这一行）；这是 NOTE 不是 SKIP，其余场景照常判定，最后照样打印 `S2 OK`。

- **staging 预演打开**：`scripts/staging-rehearsal.sh` 跑在一次性的 runner 上，自己 `export ACCEPT_DISRUPTIVE=1`，
  经目标版本的 `apply-release.sh` 传到它的 `accept_s2.sh`，所以每次预演都跑 S12 和 S2。
- **生产主机默认关闭**：`apply-release.sh` 不设这个变量，主机 apply 里的 S2 不跑这两个场景。**要在主机上跑，必须在
  维护窗口里、victor 当场明确同意之后**，由维护者在 apply 报 `RESULT ok` 之后单独再跑一遍
  `ACCEPT_DISRUPTIVE=1 sh scripts/accept_s2.sh`（整套 S2，约 35–45 分钟，期间按上面说的中断两次），结果照常记
  `docs/private/`。没有当场同意就不跑；这两项每次 staging 预演都跑。

不要在别人正用这台主机上的栈时跑 fake 路径（`ACCEPT_DISRUPTIVE=1` 时尤其如此）。`--real` 不跑这些场景，并且在发布 http 门的清单之前把夹具测试账本的
两个草稿（`ledger.get` / `ledger.add`）丢弃，发布后用 `real-ledger-withheld` 证明门上已发布的只有
`stock.get`：真实模型的工具列表和加账本之前一样，`api_observe` 不会多一个 GET 可选。

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
entry-mode-tools` 并立即退出，而不是含糊地继续跑或悄悄 SKIP。**该修复早已落地**（entry 模式注册 S2 工具与 `observe_operation`，
`packages/platform-extension/src/modes/entry.ts`），当前 `main` 在主机上整条链路通过（S2 71 项，见
`docs/STATUS.md`）；`step2-chat-entry-tools` 的 FAIL 现在只会出现在入口镜像过旧（没有重建）时，
这是脚本设计的一部分，不是 bug。下面的失败输出是**该修复落地之前**的历史示例（真实
id/key 已脱敏）：

```
PASS preflight-services running: postgres kernel caddy llm-proxy egress-proxy worker-supervisor agent-host fake-llm gatekeeper-docker
PASS preflight-fake-provider fake provider configured in .../config/llm-providers.yaml
PASS preflight-migrations up to date
PASS preflight-worker-runtime-image nexttime-ai-worker-runtime present
PASS preflight-accept-s2-build accept-s2 fixture images built (sshd, openapi, mcp)
PASS preflight-accept-s2-gate-image accept-s2-ssh-gate / accept-s2-http-gate run nexttime-ai-gate-host 5e1d2c3b4a59 published vX.Y.Z 4d6eead1a2b3
PASS bootstrap-workspace workspace=<uuid> alice=<uuid> key=abc123...(redacted)
PASS bootstrap-bob bob=<uuid> (member) key=def456...(redacted)
PASS fixtures-ssh-keygen keypair generated into ${NEXTTIME_DATA}/accept-s2/ssh/
PASS fixtures-store-key ConnectedAccount store key generated into ${NEXTTIME_DATA}/accept-s2/http-gate/
PASS fixtures-api-token bearer token generated: 9f3a1c...(redacted)
PASS fixtures-up accept-s2-sshd, accept-s2-openapi, accept-s2-restart-target up
PASS fixtures-gate-secrets ssh/http gates' own connection secrets minted: ntgc1_...(redacted), ntgc1_...(redacted)
PASS fixtures-gates-up accept-s2-ssh-gate, accept-s2-http-gate healthy on their own connection secrets; the platform gate token is refused
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
PASS connect-docker-guard self-connect to http://gatekeeper-docker:8083 refused with endpoint_is_platform_gate
PASS connect-docker-platform-enable gate instance gatekeeper-docker already enabled by the administrator
PASS connect-docker-ready gatekeeper-docker has announced its Operations
PASS connect-docker-enable gatekeeperId=<uuid> (Operations published by enable_gate_instance)
PASS connect-docker-grant docker gatekeeper granted to alice
PASS landing-origins ssh + http: self connections; docker: catalog link; no Gatekeeper without an origin
PASS landing-duplicate-refused a second connection to http://accept-s2-http-gate:8090/ refused with endpoint_already_connected; no Gatekeeper written
PASS landing-suspend-baseline alice observes stock.get through the http self connection
PASS landing-suspend-refuses suspended: observe refused as disabled by the platform (the connection is suspended)
PASS landing-resume-restores resumed: the same observe goes through again
PASS ontology-propose accept-s2 ontology drafted: <uuid> v1
PASS ontology-publish accept-s2 ontology published (AcceptS2Container, AcceptS2Observation, accept_s2_restarted)
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
PASS step4-always-allow gate policy: ssh.run_command on the ssh gate auto-approved from now on
PASS step4-invoke-worker-2 second ssh Worker run -> auto_approved
PASS step4-no-second-card list_pending unchanged (0) — second identical run produced no approval card
PASS step4-second-auto-approved second ActionRequest (<uuid>) resolved policy_decision=allow (auto_approved) directly, no human decision required
PASS step6-no-api-key-env 0 api_key-shaped env vars in the Worker image's env
PASS step6-direct-lan-fails direct curl to an internal address failed as expected (curl rc=..., http_code='000')
PASS step6-unregistered-source-denied unregistered container -> 403 from egress-proxy (fail-closed per source)
PASS step6-registered-egress-ok registered entry container -> https://example.com 200 via egress-proxy
PASS step7-fact-inferred Fact <uuid> (accept_s2_restarted, from the docker-restart Worker's report_result) has epistemic_status=inferred
PASS step7-fact-asserted-by-agent Fact asserted_by principal kind='agent' display_name='worker:<name>' (application/task/agent-principal.ts's ensureWorkerAgentPrincipal, one per (workspace, WorkerDefinition) — see docs/runbooks/host-accept-s2.md)
PASS step7-fact-on-behalf-of-alice worker_result Activity metadata.onBehalfOf=<alice's principal id> (human kept as provenance alongside the agent asserted_by — application/task/result.ts)
PASS connect-mcp-fixture-up accept-s2-mcp up
PASS connect-mcp-request connectionRequestId=<uuid>
PASS connect-mcp-target-refused manifestSource http://worker-supervisor:8081/... refused with connection_target_refused, nothing fetched
PASS connect-mcp-create gatekeeperId=<uuid> (imported both fixture tools from manifestSource tools/list)
PASS connect-mcp-find-operations-pre-publish find_operations('accept_s2_mcp') misses before publish_manifest, as required
PASS connect-mcp-publish mcp manifest published
PASS connect-mcp-find-operations-post-publish find_operations('accept_s2_mcp') sees both fixture tools after publish_manifest (2 result(s))
PASS step9-goal-proposed the entry agent proposed goal <uuid> in chat <uuid>
PASS step9-agent-cannot-confirm the agent's confirm_goal attempt confirmed nothing: goal <uuid> still proposed, its origin the Turn <uuid>
PASS step9-goal-idempotent asking again in the same chat answered the same run <uuid> (changed=false); one goal for the request
PASS step9-goal-confirm alice confirmed goal <uuid> (one StepRun); confirming again changed nothing
PASS step9-goal-achieved goal <uuid> completed(achieved, verified_by_check): the step succeeded, the platform's own observation of stock.get passed
PASS step9-goal-one-task one Task for the goal's one step
PASS step9-goal-milestones chat <uuid> shows the goal's milestones (proposed, confirmed, checking, completed: achieved) and its step's Task under 'report'; the next turn gets the three after the proposal, not the Task
PASS s6-verifying goal <uuid>: its step reported success, the platform is checking the stock API for a symbol it never shows
PASS s4u-approved alice approved the write <uuid> under lose-s4u-<hex>; it ran and its answer was lost: failed(outcome_unknown), never run again by the gate
PASS s4u-waiting-reconcile goal <uuid> still running, its step waiting(reconcile): the platform checks the ledger before anything else happens to the step
PASS s1-goal-proposed the entry agent proposed goal <uuid> in chat <uuid>: a and b side by side, c after both
PASS s1-goal-confirmed alice confirmed goal <uuid> outside the chat; nobody writes in any chat from here on
PASS s1-goal-achieved goal <uuid> completed(achieved, verified_by_check) on its own: three steps, one attempt and one Task each
PASS s1-goal-order c started only after a and b had both ended (c-after-both,a-b-overlapped)
PASS s1-no-new-turn no Turn started anywhere in the workspace while goal <uuid> ran (1 in its chat, the proposal's)
PASS s1-goal-milestones chat <uuid> shows the goal's milestones (proposed, confirmed, checking, completed) and a completed Task under each of a, b, c
PASS s11-confirmed alice proposed and confirmed goal <uuid> (one step writing to the test ledger under s11-<hex>)
PASS s11-rejected alice rejected the step's write <uuid>
PASS s11-needs-decision goal <uuid> paused needs_decision; the step failed action_refused
PASS s11-no-retry 15s later still paused: one attempt, one Task, the write still rejected; the ledger holds nothing under s11-<hex> (the gate never ran it)
PASS s11-cancelled alice cancelled goal <uuid>, the decision S11 leaves to a person
PASS s13-report-runner report-runner@1 published (<uuid>): no gate, nothing it can execute
PASS s13-planner-model alice's AgentProfile model set to fake/fake-echo, the model her goal planner runs on
PASS s13a-confirmed alice confirmed goal <uuid> with the planner's leave 'propose' (one step writing to the test ledger under s13a-<hex>)
PASS s13a-rejected alice rejected the step's write <uuid>
PASS s13a-proposed goal <uuid> paused needs_decision; the planner proposed revision 2 (minor), which waits for alice
PASS s13a-accepted alice accepted the planner's revision 2 and resumed the run in one call
PASS s13a-achieved goal <uuid> completed achieved, verified by the platform's own check, the planner's way
PASS s13a-planner-task one planner Task on goal <uuid>: purpose planning, completed, observing nothing
PASS s13a-other-way the step ran on ops-runner (its write refused), then on report-runner; the ledger holds nothing under s13a-<hex>
PASS s13b-confirmed alice confirmed goal <uuid> with the planner's leave 'apply_minor' (one step writing to the test ledger under s13b-<hex>)
PASS s13b-rejected alice rejected the step's write <uuid>
PASS s13b-applied goal <uuid> never paused: an autonomous round's minor revision 2 was adopted by the platform for alice, and the goal completed achieved
PASS s13b-planner-task one planner Task on goal <uuid>: purpose planning, completed, observing nothing
PASS s13b-other-way the step ran on ops-runner (its write refused), then on report-runner; the ledger holds nothing under s13b-<hex>
PASS s13-planner-model-reset alice's AgentProfile model back to the workspace's
PASS s5-confirmed alice proposed and confirmed goal <uuid> (write to the test ledger under s5-<hex>, then a step after it)
PASS s5-waiting-approval the Worker exited with its write still pending: step waiting(approval), goal still running, the next step not started, the ledger empty (1 Task)
PASS s5-approved alice approved the write <uuid> after its Worker had gone ('approved')
PASS s5-achieved goal <uuid> completed(achieved): the write ran once (ledger count 1 at the gate), the step's check passed on an Observation, then the next step started on its own and succeeded
PASS s4-approved alice approved the write <uuid> under lose-s4-<hex>; it ran and its answer was lost: failed(outcome_unknown), never run again by the gate
PASS s4-reconciled goal <uuid> completed(achieved): the platform's reconcile observation saw the lost write's effect (effect_seen), the step went on; one attempt, one Task, the write ran once (ledger count 1 at the gate)
PASS s7-queued the http gate's queue: goal <uuid>'s write <uuid> pending at its head, its approved write <uuid> behind it, goal <uuid>'s approved write <uuid> behind both; nothing has run
PASS s7-drained goal <uuid>'s write <uuid> ran <n>s after the cancel: the withdrawal drained the gate at once, not at the next periodic drain
PASS s7-cancelled goal <uuid> cancelled (cancelling → cancelled, nothing left to clean up): both writes withdrawn and never run (ledger counts 0 at the gate), the step after them never started, no new Task
PASS s7-other-goal goal <uuid> completed(achieved): its write ran once (ledger count 1 at the gate)
PASS s9-confirmed alice granted bob the ssh, http and docker gates the ops-runner Worker declares; bob proposed and confirmed goal <uuid> (a restarts the test container through the docker gate, b after a)
PASS s9-revoked alice revoked bob's ssh gate (<uuid>) while step a's write waited, then approved the write <uuid>
PASS s9-authority-lost goal <uuid> paused authority_lost: a succeeded (the docker gate ran its write), b is ready but never started — bob no longer holds the ssh gate its Worker declares; one Task
PASS s9-cancelled bob cancelled goal <uuid>; alice revoked bob's other two grants: bob holds no gate again, as after bootstrap
PASS s10-confirmed alice proposed and confirmed goal <uuid> with maxTokens 1 (a writes to the test ledger under s10-<hex>, b after a)
PASS s10-budget-exhausted goal <uuid> paused budget_exhausted, not failed: a's one attempt, capped at 1 token, spent <n> and failed budget_exhausted; b never started — its write had reached the gate first and is left pending for a person
PASS s10-cancelled alice cancelled goal <uuid>, the decision a spent budget leaves to a person: a's pending write withdrawn, nothing written (ledger count 0 at the gate)
PASS s12-confirmed alice proposed and confirmed goal <uuid> (a, held at fake-llm until released, then b after a)
PASS s12-locked goal <uuid>'s row is locked (for no key update, its own transaction) while a's Worker is held mid model call, its Task <uuid> running
PASS s12-wake-lost a's Task <uuid> completed with the held turn's report while the row was held; its TaskUpdated took <n>s to dispatch — the wake's update waited on the row and gave up (seen waiting, then gone, the lock still held) — and the run's next tick was <n>s away (its wall-clock deadline); lock ended (1)
PASS s12-reconciled the reconcile scan found the run: a succeeded <n>s after the lock ended (one scan period is 60s), its Task having ended with that one, lost, TaskUpdated
PASS s12-achieved goal <uuid> completed(achieved) on its own: b ran after a, one attempt and one Task each
PASS s8t-confirmed alice proposed and confirmed goal <uuid> (a asks for s8t-<hex>-1, -2, -3; b after a)
PASS s8t-running a's Worker asked for s8t-<hex>-1 (<uuid>) and s8t-<hex>-2 (<uuid>), both pending approval, and is held before the third; its Task <uuid> is waiting_approval
PASS s8t-revised alice paused goal <uuid> and revised it to c alone: a and b superseded, a's writes <uuid> and <uuid> withdrawn in the same revision
PASS s8t-terminated a's Task <uuid> was terminated (cancelled, WorkerRun terminated) while its Worker was held; its two writes stay withdrawn, it never asked for the third, the ledger holds nothing under s8t-<hex>
PASS s8t-achieved alice resumed goal <uuid>; it completed(achieved) on c alone — a superseded after its one attempt, b never started
PASS s8l-confirmed alice proposed and confirmed goal <uuid> (a asks for s8l-<hex>-1, -2, -3; b after a)
PASS s8l-running a's Worker asked for s8l-<hex>-1 (<uuid>) and s8l-<hex>-2 (<uuid>), both pending approval, and is held before the third; its Task <uuid> is waiting_approval
PASS s8l-revised alice paused goal <uuid> and revised it to c alone, letting a finish: s8l-<hex>-2 (<uuid>) withdrawn, s8l-<hex>-1 (<uuid>) released and audited
PASS s8l-finished a's Worker asked for s8l-<hex>-3 after the revision and the kernel refused it (I-G9, audited on a; the Worker reported '<the refusal as its tool saw it>'); its Task completed with its result recorded, a stays superseded with no third request
PASS s8l-released-holds c succeeded, and the goal stays running: it does not verify while the released s8l-<hex>-1 still awaits a decision
PASS s8l-achieved alice approved the released s8l-<hex>-1; it ran once (ledger 1 at the gate) and goal <uuid> completed(achieved); s8l-<hex>-2 and s8l-<hex>-3 never ran (ledger 0 and 0)
PASS s6-not-achieved goal <uuid> paused needs_decision, not completed: its check failed on an Observation after 5 attempts
PASS s6-ended-not-achieved alice ended goal <uuid> as not achieved: completed,not_achieved,requester,
PASS s4u-awaiting-reconcile goal <uuid> paused awaiting_reconcile: the platform's check did not see the effect after retrying, recorded nothing, ran nothing again (ledger count still 1 at the gate)
PASS s4u-cancelled alice cancelled goal <uuid>, the decision a not-seen effect leaves to a person
PASS s2-confirmed alice proposed and confirmed goal <uuid> (a, b, c in turn; a and b held at fake-llm until released)
PASS s2-kernel-killed-task the kernel was killed (SIGKILL) while a's Worker was held mid model call and was healthy again in <n>s: a's Task <uuid> and its WorkerRun <uuid> are the same, still running, the run has one Task; its model call stayed held throughout (held=1 dropped=0)
PASS s2-kernel-killed-advance a's Task completed with its held turn's report; the advance its end set off stopped on b's locked row with its transaction open; the kernel was killed in it and healthy again in <n>s; the dead advance still waited on the row (1 waiting) until the lock was ended (1); b had no Task
PASS s2-advance-redone the new kernel advanced the run <n>s after the lock ended: a succeeded on its one attempt, b started once (Task <uuid>), one Task per attempt
PASS s2-supervisor-restarted worker-supervisor restarted while b's Worker was held and answered /healthz in <n>s; 35s later (past one Task-reaper look) b's Task <uuid> and its WorkerRun <uuid> are the same, still running
PASS s2-achieved goal <uuid> completed(achieved) through two kernel crashes and a worker-supervisor restart: a, b, c each succeeded on one attempt, each after the one before, one Task each; b's Task <uuid> completed with its held turn's report
PASS cleanup reclaimed alice/bob entry containers, removed the accept-s2 fixture containers; workspace retained: <uuid>

S2 OK
```

（`step2-approval-card`/`step4-approval-card` 两行如果 S2.11 的 linkage 消费者在本次主机上因为某种
时序原因没赶上，脚本会把它们降级成 `SKIP`——approval 链路本身（`list_pending`/`approve`/
`get_action`）不受影响，仍然全部 PASS，只是"卡片出现在对话里"这一条视觉断言单独 SKIP，见脚本内注释。
若确实出现，最后不会打印 `S2 OK`，而是打印 SKIP 汇总并以非 0 退出。）

上面是 `ACCEPT_DISRUPTIVE=1` 时的输出。不设它时没有 `s12-*` 和 `s2-*` 这 11 行，`s4u-cancelled` 之后是一行
`NOTE goal-disruptive S12 (row lock on a goal) and S2 (kernel killed twice, worker-supervisor restarted) not run: ACCEPT_DISRUPTIVE=unset, not 1 — …`，
其余不变，最后仍是 `S2 OK`。

**在 `packages/platform-extension` 的 entry-mode 工具注册修复落地之前**，对着当前 `main` 跑这个脚本，
预期在 `ops-runner-publish` 之后很快看到：

```
PASS ops-runner-publish ops-runner@1 published
FAIL step2-chat-entry-tools kernel/platform-extension entry tools not deployed — needs PR fix/entry-mode-tools (last assistant reply: 'echo: 重启测试容器 CONTAINER_ID=<id> (find_workers did not resolve — see docs/runbooks/host-accept-s2.md)')
```

脚本立即以非 0 退出（`fail()` 的既有行为，同 accept_s1.sh）——这是预期行为，不是脚本的 bug。
见 §5 "已知偏离"里这条 FAIL 的历史根因（核心缺口 1 / 2，均已修复）；今天再看到它，先核对入口镜像是否已重建。

## 4. 每一步对应 S2.12 七条验收的哪一条

| 脚本步骤 | S2.12 验收条目 | 证明什么 |
|---|---|---|
| `connect-ssh-*` / `connect-http-*` / `s213-*` | (1) A 用连接卡片接入测试 SSH 主机与测试 OpenAPI 服务 | `request_connection` → `create_connection`（ssh 走 `credentialKind:'shared'`，http 走 `credentialKind:'connected_account'` + 真实 `manifestSource` OpenAPI 导入）→ `publish_manifest` → `connect_gatekeeper`，与 `docs/runbooks/host-gatekeepers.md` §10 同一条路径；`s213-find-operations-*` 与 `s213-no-token-leak` 是折进本任务的 S2.13 验收句 |
| `connect-docker-guard` / `connect-docker-platform-enable` / `connect-docker-ready` / `connect-docker-enable` / `connect-docker-grant` | (2) 的前置——把已部署的 `gatekeeper-docker` 经 P-B1 目录路径接进本次测试 workspace（STATUS 遗留 36 / S5.5 之后，不再 `create_connection` 到它的地址） | `guard`：对目录门地址 `create_connection` 必须 400 且 body 含 `endpoint_is_platform_gate`（目录里的门不允许工作区自连一份，否则绕过目录的拒绝清单 / trust / enabled 状态）；`platform-enable`：断言 `gate_instances` 里 `gatekeeper-docker` 已 `enabled`（`discovered` 则脚本代管理员 SQL 置为 `enabled`——这台脚本没有管理员登录；`disabled`、无行、或 `connectors.docker` 不是 `platform_preset` 都直接 FAIL，那是管理员的决定，脚本不覆盖）；`ready`：轮询至多 60s，等该行 `last_seen_at` 非空且 `operations` 非空（`enable_gate_instance` 对尚未宣告 Operation 的实例报 `gate_not_ready`）；`enable`：alice 调 `enable_gate_instance{gateId:'gatekeeper-docker'}`，返回 `gatekeeperId`（同时发布其 Operation，不需要 `publish_manifest`）；`grant`：`connect_gatekeeper` 授权给 alice |
| `landing-origins` / `landing-duplicate-refused` / `landing-suspend-*` / `landing-resume-restores` | P0b 唯一落地路径与自接门的平台切断（`docs/global-roadmap-2026-10-16.md` W3，STATUS 遗留 118 残余 ①） | `origins`：本次接入的门各有且只有一条来源记录——ssh / http 是工作区自接（`workspace_self_connections`），docker 是目录关联（`workspace_gate_links`），没有无来源的门；`duplicate-refused`：对已接入的地址（带尾斜杠）再 `create_connection` 必须 409 `endpoint_already_connected`，不碰门、不写门；`suspend-*`：alice 经 http 门观察 `stock.get` 先通，平台暂停这条自接连接后被拒（403，`operation_disabled`，说明连接被暂停），恢复后再通。脚本没有管理员登录，暂停 / 恢复由脚本代管理员 SQL 改 `workspace_self_connections`（同 `connect-docker-platform-enable` 的做法）；能力本身（平台审计行、入口凭证重签）由内核集成测试覆盖。`suspend-refuses` 失败时脚本已先把连接恢复；恢复也失败会明说，到「平台 · 集成 → 自己接入的门」手动恢复 |
| `ontology-propose` / `ontology-publish` | S5.1 本体守卫的前置——docker-restart Worker 的结果契约写 `AcceptS2Container --accept_s2_restarted--> AcceptS2Observation`，没有任何领域包声明这些类型，而内核对未在已发布本体里声明的 LinkType 拒绝写入（400 `ontology_violation`） | `propose_ontology_change` 起草两个 ObjectType（`identityKey` 与场景提交的身份一致）与一个 LinkType，`publish_ontology_version` 发布；两步各断言 HTTP 200。守卫本身（故意违规 → 400）由 `accept_s3.sh` 的 `ontology-guard-*` 断言，这里不重复 |
| `ops-runner-*` | (2)/(4) 的前置——`ops-runner` WorkerDefinition 存在且发布 | 读取真实 `ontology/ops-runner.yaml`（经 kernel 镜像里已有的 `yaml` 包解析，不是脚本自己编的提示词），补上 `capabilities:['request_action']` 与三个门的 `gates` |
| `step2-chat-reply` / `step2-chat-task-created` / `step2-list-pending` / `step2-approval-card` / `step2-approve` / `step2-executed` / `step2-explain` | (2) A 对话「重启测试容器」→ find_\* → invoke_worker → 卡片 → A 批准 → 执行 → explain 全链 | 真实 chat 驱动链路：`entryRestartChatScenario`（fake-llm）驱动入口 agent 依次调 `find_workers`/`invoke_worker`（真实工具结果链式传递，非硬编码 id），`step2-chat-task-created` 核对新 Task 的 `worker_definition_id` 确实是 ops-runner；`step2-chat-entry-tools`（未列在正常路径里，只在链路未解析时触发）FAIL 而非 SKIP——见 §5 "已知偏离" |
| `step2-request-target` | (2) 的排队范围（S11 GO12） | 重启请求按**已发布**的 `container.restart` 记下目标：已发布版本声明了 `Container` / `id` 时，请求的 `target` 是 `Container` 和它自己参数里的 `id`；已发布版本还没有目标（刚从 GO12 之前的版本升级、owner 还没确认 docker 门的治理刷新）时，请求作用于整个门，和升级前一样，也是 PASS——这时 `list_operations` 必须读到已发布版本确实没有目标，否则 FAIL（目标声明了却没记下是插入路径坏了）。不用 SKIP：任何 SKIP 都让 S2 非零退出，`apply-release.sh` 记作验收失败 |
| `step3-chat-reply` / `step3-observe-operation-audited` / `step3-chat-no-task` / `step3-no-action-request` | (3) A 问「测试 API 的 GET 返回什么」→ 入口 agent 直接观察，不拉 Worker（task 数不变） | 真实 chat 驱动链路：`entryObserveChatScenario` 驱动入口 agent 调 `accept_s2_api_stock_get`（观察类 gate 投影工具，内部调 `observe_operation`——一个专门的、observe-only 的 capability，不是 `request_action`），回复文本回显该工具的**真实**返回数据（断言含 `NXT`）；`step3-observe-operation-audited` 核对 `audit_records` 确实记了一条 `observe_operation`；`step3-chat-no-task`/`step3-no-action-request` 核对 `tasks`/`action_requests` 表行数在消息前后都不变 |
| `step4-invoke-worker-1` … `step4-second-auto-approved` | (4) Worker 跑一条未分类命令 → 卡片 → 总是允许 → 第二次不再出卡片 | 两次 `invoke_worker`（同一条 `uptime` 命令）夹一次 `set_auto_approved_action_kind('ssh.run_command')`；`list_pending` 计数与 `action_requests.policy_decision` 分别从应用层与 DB 层双重验证第二次是 `auto_approved` |
| `step5-bob-forbidden` / `step5-still-pending` | (5) 用户 B 尝试批准 A 范围的动作 403 | bob（member）对 step 4 第一次调用产生的、真实处于 `pending_approval` 的 ActionRequest 调 `approve` → 403；随后确认该行状态未被这次失败尝试改变 |
| `step6-*` | (6) Worker 容器 `env | grep -ci api_key` 为 0；直连内网失败；**未注册来源**经代理访问 `http://example.com` 被拒 403（egress 按来源 fail-closed，`EGRESS_DENY_UNKNOWN_SOURCE` 默认开）；**已注册**的 alice 常驻入口容器经代理 `curl https://example.com` 得 200 | 前三项直接跑 `nexttime-ai-worker-runtime` 镜像（`workers` 网络 + 与真实 Worker 相同的 `HTTP(S)_PROXY`，但无来源注册），见 §5 "已知偏离"关于为什么不经 Worker 自己的工具调用；正向探测 `docker exec` 进 `nexttime-entry-<alice>`（步骤 2–3 由 worker-supervisor 拉起并注册） |
| `step7-*` | (7) Worker 结果契约里的 Fact 入图为 `inferred`，`asserted_by` 是真实 agent 类 principal（非 `viaAgent` 降级标记），alice 作为 provenance 留在 Activity `metadata.onBehalfOf` 上 | 查 `links` 表 `epistemic_status` 列，`link_type='accept_s2_restarted'`（step 2 的 docker-restart Worker 通过 `report_result` 写入）；再查 `asserted_by` 关联的 `principals.kind='agent'`/`display_name` 以 `worker:` 开头；再查 `activities.metadata->>'onBehalfOf'` 等于 alice 的 principal id |
| `connect-mcp-target-refused` | R-27（2026-10-02 评审）：owner 提供的 `manifestSource` 指向平台服务（`http://worker-supervisor:8081/task/<id>/terminate`）→ 内核出站目标判定在任何抓取前拒绝，400 `connection_target_refused` | 同一个 `create_connection`，换一个指向 worker-supervisor 的 `manifestSource`；不带 `connectionRequestId`，不消耗随后那张连接请求卡 |
| `connect-mcp-*` | S3.12 自己的验收句——"通过 UI 接入一个 fixture MCP server ... publish 后 find_operations 命中其工具"（本脚本覆盖 capability 层这一半，不覆盖对话内 `<gate>.<op>` 工具出现这一半——那是 S3.13 入口 `session_start` 投影的范围，见 `docs/runbooks/web-console.md`） | 同一条 `request_connection → create_connection → publish_manifest` 路径，`kind:'mcp'`；`create_connection` 的 `manifestSource` 指向 `accept-s2-mcp` 自己的 JSON-RPC 端点，导入两个工具（`accept_s2_mcp_echo` 观察类、`accept_s2_mcp_note` 执行类）；`find_operations('accept_s2_mcp')` 发布前 0 命中、发布后 2 命中，与 `s213-find-operations-*` 同一条 I16/I17 不变量 |
| `step9-*` | S11 GO5e-1：前后依赖、要在对话之外跑完的一串委派步骤，在对话里发起成目标（`docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md`） | 真实 chat 驱动链路：`entryGoalChatScenario`（fake-llm）驱动入口 agent 依次调 `find_workers` → `find_operations('stock')` → `propose_goal`（一步跑在 ops-runner 上；验收是平台自己对 http 门 `stock.get` 的观察 `observe_predicate`，`symbol` 等于 `NXT`；带 `idempotencyKey`），再自己试一次 `confirm_goal`。`agent-cannot-confirm`：回复里 `CONFIRM_GOAL=unavailable`，且 `get_goal` 读到的仍是 `proposed`、未确认、来源 Turn 就是这一轮——入口模式不注册 `confirm_goal`，内核对任何 Handle 也拒绝它（仅人通道）；`idempotent`：同一对话再问一次，回同一个目标、`changed=false`，`list_goals` 里这次请求只有一个目标；`confirm`：alice 以人通道确认（一个 StepRun），再确认一次 `changed=false`；`achieved`：轮询 `get_goal` 至 `completed / achieved / verified_by_check`，唯一一步成功、首次尝试，`stock-visible` 检查 `passed` 且有 Observation——Worker 不写任何 Fact，验收不靠它的话；`one-task`：`tasks` 里这个目标恰好一行；`milestones`（S11 GO5e-2）：发起目标的那个对话里依次出现 `propose`、`confirm`、`verify`、`complete` 四条 `system.goal_update` 状态行，最后一条带 `completed / achieved / verified_by_check`；那一步的 Task 在同一个对话里报告，带 `stepKey`=`report`；除发起那条之外的三条在这个对话下一轮的上下文里等着，那一步的 Task 不进上下文 |
| `s1-*` | S11 §7.2 S1：用户发起目标（a、b 并行，c 依赖 a、b）并确认后不再发消息（GO7a，`scripts/lib/accept-s2-goals.sh`） | 新对话里发「发起三步验收目标 GOAL_NONCE=…」，`entryGoalDagChatScenario`（fake-llm）驱动入口 agent `find_workers` → `find_operations('stock')` → `propose_goal`（三步都跑 ops-runner 的 `goal_step` 剧本，c 的 `dependsOn` 是 a、b；验收同第 9 步）。`proposed`：计划读出来 a、b 无依赖、c 依赖两者；`confirmed`：alice 在对话外以人通道确认，一次建出三个 StepRun；`achieved`：轮询至多 360s 到 `completed / achieved / verified_by_check`，三步各成功一次、各一个 Task；`order`：c 的尝试建于 a、b 都结束之后（a、b 是否真的重叠取决于请求者的并发配额，只报告不判定）；`no-new-turn`：从确认到结束，整个 workspace 没有新的 `agent_turn` Activity；`milestones`：发起对话里依次是 `propose`、`confirm`、`verify`、`complete`，a、b、c 各一条完成的 Task 状态行 |
| `s11-*` | S11 §7.2 S11：一步的执行动作被拒绝 → 步骤与目标进入需要决定，不自动重试同一动作 | alice 以人通道提一步目标（ops-runner 的 `goal_ledger` 剧本：经 http 门调 `ledger.add` 往夹具账本写一条，`await_decision: true`；`maxAttempts` 2，留一次尝试不用），确认；等这条写入 `pending_approval` 后 alice `reject`。`needs-decision`：目标 `paused(needs_decision)`，步骤 `failed / action_refused`、一次尝试、那条写入 `rejected`；`no-retry`：15s 后状态不变、仍一次尝试一个 Task，夹具账本在这个键下计数 0（门侧根本没执行）；`cancelled`：alice `cancel_goal` 收尾 |
| `s13*-*` | S11 GO9a/GO9b（遗留 549）：一步的执行动作被拒绝后，目标规划器换一条路；只提议（`propose`）时请求人决定，`apply_minor` 时平台按请求人的授权采用小修订、目标不停 | `report-runner`：alice 发布一个没有门、不能执行任何动作的 Worker（不写 `capabilities` 即 Worker 上限去掉所有执行类能力）；`planner-model`：把 alice 的 AgentProfile 模型设成 fake 模型——规划器自己不定模型、跑请求人的模型，accept_s2 只给入口定义钉了模型，不设的话规划器会跑在栈的默认提供方上（主机上是真实模型），S13 结束时设回 `null`。两个目标都是一步 `write`（ops-runner 的 `goal_ledger` 剧本，`maxAttempts` 1），验收同第 9 步；确认时带规划器授权；写入 `pending_approval` 后 alice `reject`。规划器跑 fake-llm 的 `goalPlannerScenario`：从任务输入（`kind: goal_planning`）里取失败的步骤和 `workers`，把这一步换到 `report-runner` 上、输入换成 `goal_step` 剧本，其余不变——按平台规则是小修订。`s13a`（`propose`）：`proposed`：目标 `paused(needs_decision)`，一轮 `proposal` 规划提了修订 2、分级 `minor`，修订 2 由规划器提出、等人决定；`accepted`：alice `decide_plan_revision`（accept、resume）一次接受并恢复，修订 2 `acceptedBy` 为 `person`；`achieved`：到 `completed / achieved / verified_by_check`。`s13b`（`apply_minor`）：`applied`：没人再操作，目标走到 `completed / achieved / verified_by_check`；一轮 `autonomous` 规划 `applied` 修订 2、分级 `minor`，修订 2 `acceptedBy` 为 `platform`，审计里这个目标没有一次进入 `paused`。两个都查：`planner-task`：目标上恰好一个 `purpose = planning` 的 Task，`completed`，`observe_scope` 为空（什么都不观察）；`other-way`：这一步的 Task 依次是 ops-runner（写入被拒）、report-runner，都 `completed`，账本在这个键下计数 0（门侧从没执行） |
| `s14-*` | S11 GO14：后一步读前一步留下的文件——同一目标里，计划条目在 `filesFrom` 里点名的上游步骤，其 Worker 留在 `/workspace/out` 的文件只读挂到 `/upstream/<步骤>` | 两步都在 ops-runner 上跑 fake-llm 的 `goal_handoff` 剧本：`a` 用 pi 的 `write` 把本次运行的令牌写进 `/workspace/out/handoff.txt`；`b` 依赖 `a`、`filesFrom: ["a"]`，输入里没有令牌、也没有绑定取 `a` 的输出，用 `read` 读 `/upstream/a/handoff.txt`，再用 `bash` 试着在旁边写一个文件。`handoff`：目标自己走到 `completed / achieved / verified_by_check`，`b` 的 Task 存下的 summary 里 `HANDOFF_READ=[…]` 正是 `a` 写的令牌，旁边的写入退出码非 0（挂载只读）；`handoff-audit`：`b` 的 Task 的 `task.queue` 审计在 `upstreamFiles` 里恰好点名 `a` 那次尝试的 Task，`b` 这一步的 `step_run.start` 审计 `filesFrom` 是 `["a"]`；`handoff-owner`：从内核容器里用内核自己的内部令牌直接调 worker-supervisor 的 `POST /task-dirs/keep`，问 `a` 的 Task 目录：按本目标问答 `kept`，按同一工作区的另一个目标（S1 的）问答 `not_owned`——supervisor 在 `a` spawn 时写下的 `owner.json` 是内核选择之外的第二道线。挂载时的 409 `upstream_unavailable`、上游把 `out` 换成符号链接或 FIFO 时的拒绝，由 `packages/worker-supervisor/src/upstream-files.test.ts` 覆盖 |
| `s5-*` | S11 §7.2 S5：一步含需审批的执行动作，审批晚于 Worker 退出 → 步骤 `waiting(approval)`，目标不失败；批准并执行后，步骤验收通过才判成功，下一步自动开始 | 两步：`write`（`goal_ledger`，步骤验收是平台对 `ledger.get` 的观察 `count` 等于 1）与 `after`（`goal_step`，依赖 `write`）。Worker 的写入等决定到内核的等待上限（25s）后拿到 `pending_approval`、报告、退出；`waiting-approval`：此时目标 `running`、`write` 是 `waiting(approval)` 且那条写入仍 `pending_approval`、`after` 仍 `pending` 未开始、账本计数 0；alice 批准；`achieved`：轮询至多 300s 到 `completed / achieved / verified_by_check`，`write` 一次尝试、写入 `executed`、步骤检查 `passed` 且有 Observation，`after` 的尝试建于 `write` 结束之后并成功，账本计数 1（门侧恰好执行一次） |
| `s6-*` | S11 §7.2 S6：各步都报告成功，但验收观察为假 → 不进入 `completed(achieved)`；暂停并附证据；人选「按未达成结束」后为 `completed(not_achieved)` | 一步 `goal_step`，验收是 `stock.get` 的 `symbol` 等于一个它永远不会返回的值。`verifying`：最先启动，步骤成功后目标进入 `verifying`；平台按重试上限在后台重试这条检查，期间跑 S1、S11、S5、S4、S7、S9、S10、S12、S8；`not-achieved`：最后回来，轮询至多 960s（默认上限 15 分钟加余量）到 `paused(needs_decision)`、无结果，检查 `failed` 且有 Observation、至少重试过一次；`ended-not-achieved`：alice `end_goal(not_achieved)` 后为 `completed / not_achieved` |
| `s4-*` / `s4u-*` | S11 §7.2 S4：门执行了写入但丢掉响应，且门的幂等重放也答 `apply_outcome_unknown` → 步骤 `waiting(reconcile)`；核对观察看到效果后判成功，门侧计数 1。反向：看不到效果 → `paused(awaiting_reconcile)`，不自动重新执行，门侧计数仍为 1 | 一步 `goal_ledger`，键以 `lose-` 开头：夹具记下这一条后不回答、直接断开连接，门无法判断是否执行，把这次调用记成结果不明，同一幂等键的重放也这样回答（R-51）。步骤声明了怎么核对（`reconcile`：观察 `ledger.get` 同一个键的 `count`）。alice 在 Worker 等决定时批准；`approved`：那条写入 `failed / outcome_unknown`。`s4u` 最先启动（与 S6 一起在后台），核对检查要 `count` 等于 2，永远不成立：`waiting-reconcile`：目标仍 `running`、步骤 `waiting(reconcile)`；最后回来，`awaiting-reconcile`：轮询至多 960s 到 `paused(awaiting_reconcile)`，写入仍只是结果不明、平台什么都没记下，核对检查 `not_seen` 且有 Observation、重试过，一个 Task，账本计数仍 1；`cancelled`：alice 取消。`s4` 在中间跑，核对要 `count` 等于 1：`reconciled`：轮询至多 300s 到 `completed / achieved / verified_by_check`，写入 `failed / outcome_unknown / effect_seen`，核对检查 `seen` 且有 Observation，一次尝试、一个 Task，账本计数 1 |
| `s7-*` | S11 §7.2 S7（第一种）：运行中取消目标，此时有一条待审批写入在门队列队头、一条已批准还在队列里排队 → 两条都 `withdrawn`、门侧计数 0；同门里别的目标的后续写入随即被排水，不等周期 tick | 目标 A：`a1`、`a2` 两步并行写账本，`later` 依赖两者。两个 Worker 等决定超时退出后，两条写入都 `pending_approval`；按门自己的顺序（`requested_at`、id）取后一条批准，它排在队头后面不执行。目标 B：一步写账本，等它的写入也 `pending_approval` 后批准。`queued`：5s 后读门的队列（与排水器同一条件），恰好是「A 的待审批 → A 的已批准 → B 的已批准」，三个键的账本计数都是 0；alice `cancel_goal` A，回答 `cancelling`、三步取消、同一次调用撤回 A 的两条写入。`drained`：B 的写入在取消后 10s 内 `executed`（周期排水每 60s 一次、相位随机，10s 让撤回事件这条路坏了时误报 PASS 的机会约六分之一），报告实际秒数；`cancelled`：A 到 `cancelled`、`cleanupPending` 为假，两步各一次尝试、写入 `withdrawn`，`later` 没有尝试，两个 Task，A 的两个键账本计数 0，门队列空；`other-goal`：B `completed / achieved / verified_by_check`，账本计数 1 |
| `s9-*` | S11 §7.2 S9：运行中请求者失去该门的授权 → 下一步不开始，目标 `paused(authority_lost)` | alice 把 ops-runner 声明的 ssh、http、docker 三扇门授权给 bob（`connect_gatekeeper`）；bob 以人通道提两步目标并确认：`a` 经 docker 门重启 accept-s2 测试容器（`docker_restart`），`b` 依赖 `a`。`a` 的写入待审批时，alice `revoke_capability` 撤掉 bob 的 ssh 门授权（`a` 用不到这扇门），再批准 `a` 的写入。`authority-lost`：目标 `paused(authority_lost)`，`a` 成功、写入 `executed`，`b` 为 `ready` 但没有尝试，一个 Task；`cancelled`：bob 取消自己的目标，alice 撤掉 bob 另外两条授权 |
| `s10-*` | S11 §7.2 S10：累计 token 超出目标预算 → 目标 `paused(budget_exhausted)`，不是失败 | alice 提两步目标，`maxTokens` 为 1：`a` 写账本，`b` 依赖 `a`。`a` 这次尝试的 token 预算被限到目标剩下的 1；fake 模型第一次回答就超过，llm-proxy 上报用量（约每 2s）后内核把 Task 判 `failed / budget_exhausted` 并终止 Worker（写入已到门、Task 在 `waiting_approval` 时也一样：这次回答的用量往往在写入把 Task 移到等审批之后才上报），下一次推进发现目标的 token 用完，暂停。`budget-exhausted`：轮询至多 180s 到 `paused(budget_exhausted)`，`a` 一次尝试 `failed / budget_exhausted`，`b` 没有尝试，一个 Task、它的 `token_budget` 是 1，目标已用 token ≥ 1；`a` 的写入通常已先到门、仍待审批（`a` 是 `waiting(approval)`），偶尔 Worker 在写入到门之前就被停掉（`a` 是 `failed / transient`、没有写入），两种都接受并在 PASS 行里说明是哪一种；`cancelled`：alice 取消，那条写入（若有）`withdrawn`，账本计数 0 |
| `s12-*` | S11 §7.2 S12：丢一次唤醒 → 周期核对扫描发现，在一个扫描周期内推进（只在 `ACCEPT_DISRUPTIVE=1` 时跑，见 §2） | 两步：`a`（`goal_step`，输入带 `HOLD=`：fake-llm 扣住它这一轮模型回答，等脚本放行）、`b` 依赖 `a`。`locked`：`a` 的 Worker 被扣住、Task `running` 时，脚本在 postgres 容器里另开一个 psql 会话，按推进锁行的同一方式锁住这个目标在 `goal_runs` 里的那一行（`for no key update`，只锁这一行、自己的事务；最多等 5s 拿锁，最多持有 90s 后自己提交（脚本带着锁最多等 55s），`client_connection_check_interval` 让死掉的 psql 进程 1s 内回滚；只杀掉这边的 `docker compose exec` 不会结束容器里的 psql，那时靠持有上限结束）。`wake-lost`：放行 `a`（放行前 `a` 的 Task 必须仍 `running`，放行恰好放出一次请求）；它报告、Task `completed`，且 Task 存下的 summary 必须是 fake-llm 为这一轮写好的那句（`accept_s2: goal step <nonce> done; …`），`TaskUpdated` 在锁住期间被派发，唤醒消费者的 `update goal_runs set next_tick_at = now() …` 被看到卡在这行锁上、等满自己的 `lock_timeout`（5s）后放弃（先看到等待、再看到消失，锁一直在），这时目标的下一次 tick 是它的墙钟截止（≥120s 之后，否则判失败：那样推进会自己到来，证明不了扫描）；然后 `pg_terminate_backend` 结束这把锁。`reconciled`：90s 内 `a` 成功、一次尝试，且离锁结束不超过 75s（扫描每 60s 一次，加推进器 1s 的 tick 和脚本 3s 的轮询）；结束这个 Task 的 `TaskUpdated` 只有那一条（丢掉的那条）。`achieved`：`completed / achieved / verified_by_check`，两步各一次尝试、一个 Task |
| `s8t-*` / `s8l-*` | S11 §7.2 S8：修订移除一个正在运行的步骤 → 默认终止它的 Task 并撤回它的动作；选「让它跑完」时结果记录但不推进、新的执行请求被拒；修订时放行的那条照常审批执行，其余撤回 | 两步：`a` 跑 `goal_three_writes`（fake-llm：依次请求往账本写 `<k>-1`、`<k>-2`、`<k>-3`，第三次之前那一轮被扣住），`b` 依赖 `a`。前两条各等满内核的等待上限（25s）后都 `pending_approval`，`a` 的 Worker 被扣住、Task 仍活着。`running`：此时目标与 `a` 都是 `running`，两条写入待审批，`b` 没开始。alice `pause_goal`，再 `revise_goal`（基于修订 1，新计划只有一步 `c`，丢掉 `a`、`b`）。`s8t`（默认 `terminate`）：`revised`：修订 2，`a`、`b` 被取代、`c` 新建，`a` 的两条写入在同一次调用里撤回、没有放行；`terminated`：60s 内 `a` 的 Task `cancelled`、WorkerRun `terminated`，`a` 没有第三条请求，账本三个键都是 0；`achieved`：alice 恢复后只靠 `c` 到 `completed / achieved`，`a` 一次尝试后被取代，`b` 从没开始。`s8l`（`a` 设 `let_finish`，放行 `<k>-1`）：`revised`：`<k>-2` 撤回、`<k>-1` 放行，审计里恰好一条 `action_request.release`；`finished`：放行 `a` 的那一轮，Worker 请求 `<k>-3`，内核拒绝（I-G9：被取代的步骤不收新活；审计里 `a` 这个 StepRun 恰好一条 `request_action` 被拒、`refusal.code` 为 `goal_step_closed`、`stepStatus` 为 `superseded`），Worker 报告、Task `completed` 且审计记下，`a` 仍是被取代、没有第三条请求；`released-holds`：恢复后 `c` 成功，10s 后目标仍是 `running`——放行的 `<k>-1` 还没人决定，不进验收，账本仍 0；`achieved`：alice 批准 `<k>-1` 后它执行一次（账本 1），目标 `completed / achieved`，`<k>-2`、`<k>-3` 账本都是 0 |
| `s2-*` | S11 §7.2 S2：运行中杀内核、重启 worker-supervisor → 恢复后继续，每次尝试恰好一个 Task，不跳步（只在 `ACCEPT_DISRUPTIVE=1` 时跑，见 §2） | 三步依次：`a`、`b`（都带 `HOLD=`）、`c`。`kernel-killed-task`：`a` 的 Worker 被扣住时 `docker compose kill -s SIGKILL kernel` 再 `start`，至多 120s 等新容器健康检查通过；之后 fake-llm 仍扣着 `a`（最多等 30s，容 fake-llm 在重启后刚开始应答 `docker compose exec` 慢），且它对这个名字的计数必须是 `held=1 dropped=0`：只扣住过一次请求、没有一次断开。Worker 的模型调用走 llm-proxy、不经内核，杀内核不能把它切断；`a` 的 Task 与 WorkerRun 还是原来那个、仍 `running`，目标只有一个 Task。（fake-llm 扣住一轮之前先发出响应头：llm-proxy 等上游响应头最多 10s（`UPSTREAM_CONNECT_TIMEOUT_MS`），超时就给 Worker 回 502、这一轮以错误结束；staging 前两轮就是这样在扣住 10s 后断开的，与杀内核无关。）`kernel-killed-advance`：先锁住 `b` 在 `step_runs` 里的那一行（同 S12 的锁，但最多持有 180s，内核恢复最长要 120s，锁不能在内核停着时自己结束），再放行 `a`（放行前 Task 仍 `running`）；`a` 报告、Task `completed`、存下的 summary 是 fake-llm 写好的那句，它触发的那次推进（先锁目标行、再按顺序锁每一步的行）卡在 `b` 这行上、事务开着——这时再杀内核、拉起；内核回来后断言锁仍在、死掉的那次推进的会话仍在等这行（等锁的会话察觉不到客户端已断，它还拿着先锁的目标行）；然后结束这把锁，死掉的那次推进拿到行锁、回结果时发现客户端不在了，事务回滚，`b` 在锁结束前没有 Task。`advance-redone`：新内核的推进器在那次死掉的认领租期（60s）过后接手，150s 内 `b` 被扣住：`a` 一次尝试成功、`b` 只开始一次、`c` 未开始，每次尝试一个 Task。`supervisor-restarted`：`b` 被扣住时 `docker compose restart worker-supervisor`，至多 90s 等它重新回答 `/healthz`（它在开始监听前接管仍在跑的 Task 容器），再等 35s（内核的 Task 回收器每 30s 看一次）：`b` 的 Task 与 WorkerRun 还是原来那个、仍 `running`。`achieved`：放行 `b`（放行前 Task 仍 `running`），`completed / achieved / verified_by_check`，三步各一次尝试、依次开始，每步一个 Task，`b` 的 Task 存下的 summary 是 fake-llm 写好的那句。fake-llm 的计数只看得到 llm-proxy 到 fake-llm 这一段：Worker 到 llm-proxy 那段断了时，Worker 会自己以兜底 summary 结束 Task，fake-llm 却仍扣着 llm-proxy 发来的请求，放行也放得出 1 次；所以 S12 与 S2 每次放行前看 Task 仍 `running`、结束后看 summary，从 Worker 这一侧确认被扣住的回答确实到了它手里 |
| `real-ledger-withheld`（只在 `--real`） | 审查 #488 对 #806：夹具账本只给 fake 路径的目标场景用，不进真实模型的工具列表 | `connect-http-publish` 之前，alice 用 `discard_operation_draft` 丢弃 http 门的 `ledger.get` / `ledger.add` 两个导入草稿（`publish_manifest` 必须点名每个草稿，所以先丢弃再发布）；发布后按 `list_allowed_operations` 读工具时用的同一条件（`status` 为 `published`）查这扇门，已发布的恰好只有 `stock.get`，`find_operations("ledger")` 也查不到账本 |
| `cleanup` | — | 最先（`--keep` 也一样）：S2 杀掉还没拉起的服务先拉起，S12、S2 还持有的行锁结束掉，fake-llm 还扣着的回答放行（都只记日志）；然后第 9 步与目标场景里没走到结束的目标先收尾（`proposed` 用 `reject_goal`，`running` / `paused` / `verifying` 用 `cancel_goal`，只记日志；alice 是 owner，bob 的目标也由 alice 取消）；S9 给 bob 的授权没来得及撤的，`revoke_capability` 撤掉（只记日志）；回收 alice/bob 入口容器；`docker compose --profile accept-s2 rm -sf` 六个 accept-s2 容器（不是 `down`，见 §6）；workspace 行留作审计留痕 |

## 5. 已知偏离

- **目标场景（S11 GO7a）在主机上不覆盖的部分**：S5 的 `await_decision: false` 一半与 S11 的「审批过期」一半——
  前者要一个不等决定的执行类 Operation 且没有任何「总是允许」，后者要把审批过期时间调到秒级，在跑着的
  栈上都只能改内核配置才做得到，脚本不改主机配置；两者由 `advancer.integration.test.ts` 的 S5、S11 用例
  对真实 Postgres 覆盖。S7 只跑第一种，而且取消时没有还在运行的 Worker：`goal_ledger` 的 Worker 只活到内核的
  等待决定上限（25s），等它退出才排得出那个队列；第二种（一条 `executing`、结果不明的动作让目标停在
  `cancelling`，截止后 `cleanup_pending`）的截止时间默认 30 分钟、没有配置项，过期 `executing` 回收器会先把
  那条动作收尾，跑着的栈上只能看到 `cancelling → cancelled`——运行中 Task 被终止与第二种都由
  `advancer.integration.test.ts` 的两个 S7 用例覆盖。S9 用撤掉一扇门的授权来做，和计划写的「降为无该门授权的
  角色」走同一处检查（`resolveStepAuthority`）；降角色与禁用请求者由集成测试覆盖。S9 的 `a` 写 docker 门而不写账本：
  动作以目标请求者的身份执行，http 门以 `connected_account` 接入、只存了 alice 的令牌，bob 在那里的写入会被门以
  `credential_unavailable` 拒绝（这是正确行为），docker 门不按人取凭证。S8 不覆盖被取代步骤的嵌套子 Task
  （fake Worker 不派子 Task）和修订时已在 `executing` 的请求（门收到批准的写入就立即执行，停不住）——两者由
  `advancer.integration.test.ts` 的 S8 用例覆盖。S12 计划里写的「重试直到死信」与内核不符：唤醒消费者从不抛错（抛错会把
  事件重投给它的每个消费者），失败的唤醒就丢了，不重试、没有死信；把目标带回来的是周期核对扫描，`s12-*` 证明的就是这个。
  S12 和 S2 默认不跑（§2）：生产主机上只有维护窗口里 victor 当场同意后、设 `ACCEPT_DISRUPTIVE=1` 才跑，平时由 staging 预演覆盖。
  S2 杀内核是 `SIGKILL`（模拟崩溃，不是正常停机），重启 `worker-supervisor` 走它自己的 SIGTERM 停机（不停 Task 容器）；
  `kernel-killed-advance` 靠一把行锁让推进停在事务中间，`s2-*` 失败时脚本退出前会先拉起内核、结束行锁再收尾。目标场景失败时 FAIL 行末尾带 `evidence:`，是那个目标的
  `get_goal` 摘要（状态、暂停原因、每步的尝试与动作、每条验收检查的尝试次数与最后错误），再跟 `actions:`：目标
  每条动作的状态、失败类别和审计里记下的失败原因（`get_goal` 只给类别，不给原因）；脚本退出前
  `cleanup` 会把没结束的目标取消掉，要留着现场排障就加 `--keep`（目标不取消，夹具也不删）。
  `s6-not-achieved` 的 960s 是按内核默认的验收重试上限算的（`GOAL_ACCEPTANCE_CHECK_MAX_ATTEMPTS` 5 次、
  `GOAL_ACCEPTANCE_CHECK_MAX_DURATION_MS` 15 分钟）：它超时失败、证据里检查仍是 `pending` 且尝试次数还在涨时，
  先看内核这两个环境变量是不是被调大了，那是配置与脚本不匹配，不是平台问题。`s4u-awaiting-reconcile` 的
  960s 同理，对应 `GOAL_RECONCILE_CHECK_MAX_ATTEMPTS` / `GOAL_RECONCILE_CHECK_MAX_DURATION_MS`。`s7-drained`
  的 10s 是给「撤回立即触发排水」留的上限；没赶上时脚本再等过一次周期排水（到取消后 75s）才判失败，FAIL 行
  报出那时 B 的写入状态：`executed` 说明撤回的事件没有触发排水、是周期排水接住的，要查
  `ActionRequestUpdated` 的排水消费者；仍是 `approved` 说明队列卡住了，先看门队列里排在它前面的是什么。
  `s4` / `s4u` 的「丢响应」依赖门的 HTTP 客户端在连接断开后不重发 POST（结果不明就记成结果不明）：`s4u`
  读到账本计数 2、或目标没有暂停而是完成了，先查门这一侧是否重发了写入，那是门的问题，不是平台的核对问题。

- **核心缺口 1（已修复——`fix/entry-mode-tools` 已合入，entry 模式现在注册 S2 的工具与 `observe_operation`；
  以下为当时的根因记录）：`packages/platform-extension` 的 entry 模式当时从未注册 S2 新增的任何工具**——
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

  gate 工具在 `session_start` 首次投射，此后每条用户消息开始时（`before_agent_start`）重读一次
  `list_allowed_operations`（收尾波次 C3，`pi-upgrade.md` §2.3）——它的执行类部分只列出
  entry Handle **签发那一刻**的 `resources.gatekeeper` 已经覆盖的门（来自 `connect_gatekeeper` Grant）；
  观察类部分自 2026-09-27 起不看授权（设计文档 §11"门上的观察"），本工作区启用的门都会列出。
  本脚本的 `connections_step`（三个 `connect_gatekeeper` 调用）本来就排在 `step2_docker_restart`
  的第一条聊天消息之前，所以 alice 的入口容器不会在这些 Grant 存在之前就被首次发消息拉起、拿到一个
  过期的 Handle；`step2_docker_restart` 开头仍然显式加了一次防御性 `resident_stop`（该函数自己的
  头注释有完整说明），只为兜底"重跑同一 workspace/容器复用"这类边缘情形，正常路径下是空操作。

- **核心缺口 2（已全部解决：观察路径用专门的 `observe_operation`，执行路径由 `invoke_worker` 的
  `delegatedRequestAction` 把 `request_action` 交给子 Handle，见 `application/task/handle-mint.ts`；
  以下为当时的记录）**：本次实现过程中发现，一个真实入口 Handle 无法调用任何声明了 `request_action`
  需求的 WorkerDefinition/工具——`governance/capability/handles.ts` 的 `ENTRY_CEILING_CAPABILITIES`
  按**capability 名字本身**（不是按目标 Operation 的 observe/execute 模式）永久排除 `request_action`
  （I11/§5.3 item 11 的字面机制：`authorize.ts` 的 `authorizeCapabilityCall` 在 handler 被调用之前
  就检查 `scope.capabilities.includes('request_action')`）。协调者的修复给 entry 模式的观察类 gate
  工具引入了一个**专门的、observe-only 的新 capability `observe_operation`**（而不是让它像 worker
  模式一样直接调 `request_action`），这条新路径不受上面这条限制——`step3_observe_no_worker`
  因此断言 `audit_records.action='observe_operation'`（而非 `request_action`）、Activity kind 仍是
  `gatekeeper_observe`、且 `tasks`/`action_requests` 两张表都不新增行。
  - **（历史，已过时）这条修复当时只覆盖 step 3（观察路径），不覆盖 step 2（执行路径）；其后
    `delegatedRequestAction` 补上了执行路径，step 2 在主机上通过**：`ops-runner`
    WorkerDefinition 声明的 `capabilities:['request_action']`（Worker 自己需要用它触达
    `container.restart` 这个 **execute** 类 Operation，`observe_operation` 不适用于 execute
    路径）仍然会撞上同一条 `ENTRY_CEILING_CAPABILITIES` 限制——`application/task/service.ts` 的
    `findWorkers` 用 `computeChildHandleScope` 空跑一遍来筛选候选，会把声明了 `request_action`
    的 `ops-runner` 从结果里筛掉；即使强行拿到 definitionId，`invoke_worker` 也会抛
    `InvokeWorkerAttenuationError`。这条限制是 S2.7 落地时**特意加上的**（"入口 Handle 请求含
    execute 的子 Handle 被拒"是 S2.7 自己的验收条目），本 runbook 记录下来供后续判断，不代为决定
    要不要、或如何放开它——那是 `packages/kernel` 的治理模型决定。
  - （历史）`scripts/accept_s2.sh` 当时**无法**从 alice 的最终回复文本单独区分"核心缺口 1 未修"和"核心缺口
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

- **六个 accept-s2 fixture/gate 服务（S3.12 新增 `accept-s2-mcp` 后由五个变六个）共用既有的
  `control` 网络，未新建专属网络**：
  `application/gateway/connection-handlers.ts` 的 `create_connection` 由**内核进程自己**发起
  `manifestSource`（OpenAPI 文档、或 mcp 的 `tools/list`）的 HTTP 抓取（`resolveManifestOperations`），
  因此 openapi/mcp 两个 fixture 都必须能被 `kernel` 直接触达；`kernel` 现有的网络列表
  （`[control, workers]`）是既有服务的一部分，本任务的 docker-compose.yml 改动被要求"additive
  only"（只加新服务/网络/卷，不改已有服务字段）——给 `kernel` 追加第三个网络会改写它已有的
  `networks:` 字段，超出这条边界。把六个 fixture/gate 放进 `control`（而不是一个只有两个门能进的
  专属网络）不会削弱"Worker 直连失败"这条验收：
  `worker-supervisor` 的 spawn spec（S2.8）只给 Worker 容器挂 `internal:true` 的 `workers` 网络，
  一个 Worker 物理上就没有到 `control` 上任何服务（含 postgres/kernel/两个门/三个 fixture）的路由，
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
  `check=egress_no_direct_route`/`check=egress_via_proxy`，前两项或 `no_proxy_configured` 失败该容器直接非零退出、拒绝
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

`cleanup_step` 最先做的一件事不看 `--keep`：S2 杀掉的服务若还没拉起就拉起（并等内核健康检查通过，至多
120s），S12、S2 还持有的行锁用 `pg_terminate_backend` 结束（只结束 `application_name` 为 `accept_s2_lock_<名字>`
的那个会话），fake-llm 还扣着的回答放行——这些都不是要留着排障的夹具，留着只会让内核不可用、让别的推进卡在锁上；
只打日志（`cleanup: …`），不判失败。行锁即使脚本被直接杀掉、这一步没跑，也会在各自的上限（S12 90s、S2 180s）后自己提交结束。

`--keep` 不传时，`cleanup_step` 接着会：先收尾第 9 步与目标场景确认过、却没看到结束的目标（轮询超时、断言失败）——
否则它在脚本退出后还会继续：推进器在恢复生产 provider 之后重试那一步，平台验收对已删的门重试，
最后停在等人决定的状态。`proposed` 的用 `reject_goal`，`running` / `paused` / `verifying` 的用
`cancel_goal`，结果只打日志（`cleanup: goal <uuid> was … — cancel_goal answered HTTP 200, now
'cancelling'`），不判失败；S9 给 bob 的门授权没来得及撤的也撤掉（`cleanup: bob's grant <uuid> — …`）。
成功路径上每个目标都已结束（`completed` 或 `cancelled`）、授权都已撤回，这一步什么都不做。然后
`docker compose --profile accept-s2 rm -sf`（移除
`accept-s2-sshd`/`accept-s2-openapi`/`accept-s2-mcp`/`accept-s2-ssh-gate`/`accept-s2-http-gate`/
`accept-s2-restart-target` 六个容器，只 `rm` 这六个而不是整体 `down`，避免连基础栈一起停掉——
遗留 26）、经 `worker-supervisor` 的 `POST /resident/reclaim`（收尾波次 C9："验收残留自动清理"；
不是旧的 `/resident/stop`）**回收**（强制删容器 + 删数据目录）alice/bob 的入口容器，而不只是停掉。
这一步现在也挂在统一的 `on_exit` EXIT trap 上：脚本中途 `fail()` 或 ssh 会话中断都会先跑一次
`cleanup_step` 才退出（此前只有成功路径末尾会跑——`on_exit` 是这次一并修的既有缺口，之前遗留 76
只把这条 trap 接到了本脚本本身的 EXIT 上，没有改成 reclaim）。顺带修的一个 bug：`resident_stop`
此前从不带 `Authorization: Bearer` 头，对 `/resident/*` 的每次调用都直接 401——`cleanup_step`
自己的停容器调用和 `step2_docker_restart`/`real_docker_restart_run` 里"强制换一个新 Handle"的
防御性调用因此从未真正生效过；现在两个函数都补上了内核容器自带的 kernel 给 worker-supervisor 的凭证
`/run/secrets/internal_token_worker_supervisor`（R-03；同 accept_s1.sh/accept_s3.sh 自己的
`resident_status`/`resident_stop` 一样）。
workspace/principal/chat/activity/graph 行按设计文档 §12 的审计留痕原则保留，不清理；到期后仍是
`sh scripts/delete-workspaces-matching.sh --expired --yes`。历史残留（本次改动之前跑过的、还停在
`Exited` 的 `nexttime-entry-*`）：`sh scripts/sweep-accept-entry-containers.sh [--yes]`（默认
dry run，见 `docs/runbooks/accept-s1.md` §7）。

`${NEXTTIME_DATA}/accept-s2/`（生成的 ssh 密钥对、ConnectedAccount store key）**不会**被这次清理
删除——它不是仓库内容，重复运行脚本时如果这些文件已存在会直接复用（`fixtures_secrets_step` 的
`if [ ! -f ... ]` 判断），不会每次都重新生成一套新密钥。需要彻底清场时手动
`rm -rf "${NEXTTIME_DATA}/accept-s2"`。
