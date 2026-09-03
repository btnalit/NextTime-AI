# Runbook：accept-s1（S1 验收脚本）

对应任务：development-tasks.md § S1.10。设计 §14（验证表）、§15（S1 验收句）。前置：
`docs/runbooks/host-worker-runtime.md`（S1.5a）、`docs/runbooks/host-agent-host.md`（S1.5b）—
`scripts/accept_s1.sh` 复用这两份 runbook 已经跑通的入口容器 / agent-host / fake-llm 链路，不重
新发明一套驱动方式。占位符取值见 `docs/private/`（不入库）。

## 1. 前提

- 目标主机上 `docker compose --profile test` 全部服务已起（`postgres kernel caddy llm-proxy
  egress-proxy worker-supervisor agent-host fake-llm`）——脚本第一步只检查，不负责拉起。
- `${NEXTTIME_DATA}/config/llm-providers.yaml` 已指向 `fake` provider（`docs/runbooks/
  host-agent-host.md` §3：`cp config/llm-providers.fake.example.yaml
  "$NEXTTIME_DATA/config/llm-providers.yaml"`，`secrets/llm-proxy.env` 加
  `FAKE_LLM_API_KEY=fake`，`make gen-models`）。
- 迁移已跑到最新（`make migrate` 或已随 `kernel` 容器启动流程跑过）。
- 主机上有 `docker`、`curl`；**没有** `node`/`corepack`（`scripts/accept_s1.sh` 因此把每一次
  JSON-RPC 交互都放进一次性的 kernel 镜像容器里跑，见脚本头注释）。

## 2. 怎么跑

```
cd <CODE_DIR>
sh scripts/accept_s1.sh
```

经 SSH 跑（管道场景必须带 `</dev/null`，否则 `docker compose run/exec` 会挂在等待 stdin 上）：

```
ssh <TARGET_HOST> 'cd <CODE_DIR> && sh scripts/accept_s1.sh' </dev/null
```

`--keep`：跳过最后的清理步骤，保留 alice/bob 的入口容器（排障用）：

```
sh scripts/accept_s1.sh --keep
```

## 3. 期望输出

逐步打印 `PASS <step> <detail>`；任何一步失败打印 `FAIL <step> <detail>` 并以非 0 退出（脚本
不带 `set -e`，每个检查显式判断，失败立即 `exit 1`，不会带着已知的错误状态继续往后跑）。全部
通过后最后一行 `S1 OK`，退出码 0。示例（真实 id / key 已脱敏，key 只打印前 6 位）：

```
PASS preflight-services running: postgres kernel caddy llm-proxy egress-proxy worker-supervisor agent-host fake-llm
PASS preflight-fake-provider fake provider configured in .../config/llm-providers.yaml
PASS preflight-migrations up to date
PASS bootstrap-workspace workspace=<uuid> alice=<uuid> key=abc123...(redacted)
PASS bootstrap-bob bob=<uuid> (member) key=def456...(redacted)
PASS entry-worker-definition-seeded workspace <uuid> has a published entry WorkerDefinition (<uuid>@1)
PASS entry-worker-definition-propose-v2 proposed <uuid>@2 (draft)
PASS entry-worker-definition-publish-v2 published <uuid>@2
SKIP entry-worker-definition-handle-403 (asserted by a kernel unit test — see docs/runbooks/accept-s1.md)
PASS chat-alice chat=<uuid> turn=<uuid> status=completed history=2
PASS chat-bob chat=<uuid> status=completed history=2
PASS isolation-history bob get_chat_history(alice's chat) -> JSON-RPC error -32004
PASS isolation-list bob's list_chats does not include alice's chat
PASS kill-alice-entry killed nexttime-entry-<uuid>
PASS continue-alice second turn=<uuid> status=completed history=4
PASS continue-restarts GET /resident/<uuid> restarts=1
PASS explain principal <uuid> reached via explain(turn=<uuid>)
PASS egress-public-allowed https://example.com -> 200
PASS egress-internal-denied http://postgres:5432 -> denied (curl rc=..., http_code='...')
PASS egress-domain-recorded example.com recorded in metadata.egress for turn <uuid>
PASS env-no-api-keys 0 *_API_KEY= vars in entry container env
PASS env-capability-handle CAPABILITY_HANDLE present exactly once (value never printed)
PASS cleanup stopped alice/bob entry containers via the supervisor API; workspace retained: <uuid>
S1 OK
```

## 4. 每一步对应设计 §14 的哪一行

| 脚本步骤 | §14 维度 | 证明什么 |
|---|---|---|
| `preflight-*` | — | 环境就绪：所需服务在跑、fake provider 已配置、迁移无待执行项 |
| `bootstrap-*` | — | 一个 workspace、两个用户（owner alice、member bob），走 `bootstrap.js`（S1.3）与新增的 `add-principal` 子命令 |
| `entry-worker-definition-seeded` | — | `create-workspace`（S2.6）在同一事务内种下并发布了 v1 entry WorkerDefinition |
| `entry-worker-definition-propose-v2` / `-publish-v2` | — | 经 caddy、owner 的 human 通道 `propose_worker_definition`/`publish_worker_definition`（同 `explain` 的传输方式），验证注册表的 propose→publish 流程真的可用 |
| `entry-worker-definition-handle-403` | I16：Handle 通道不能发布 | 如实标注"由内核单测断言"，不在本脚本里伪造一个 Handle |
| `chat-alice` / `chat-bob` | 功能：一轮对话端到端 | 登录 → 对话 → 自己的入口容器回答（`echo:` 来自 fake-llm，链路含真实 pi + agent-host） |
| `isolation-*` | 隔离：B 看不到 A 的 Chat | -32004、`list_chats` 不含对方会话 |
| `kill-alice-entry` / `continue-alice` | 失效：杀入口容器后对话可续 | `docker kill` 该用户入口容器，历史不丢，第二轮仍完整（S1.5 验收原文） |
| `continue-restarts` | — | `worker-supervisor` 的 `GET /resident/:id` 记到这次重建（`restarts>=1`） |
| `explain` | 溯源：`explain` 到 Source 与 Principal | 经 caddy（`alice` 的 API key）对第二个 Turn 调 `explain`，结果含 alice 的 principal id |
| `egress-public-allowed` / `egress-internal-denied` | Agent：容器直连内网失败、经代理公网通 | 入口容器内 `curl` 公网通、内网/平台内部服务被拒（S1.11 既有能力） |
| `egress-domain-recorded` | 出网代理记录目标域名到 Activity（设计 §7.9） | 新增的 `POST /internal/egress`（本任务的内核缺口）把 `example.com` 写进该 Turn 的 `activities.metadata.egress`；直接 `psql` 读（见下） |
| `env-*` | Agent：入口容器内无凭证 | 无 `*_API_KEY=`；`CAPABILITY_HANDLE` 存在但从不打印 |
| `cleanup` | — | 停容器，保留 workspace 行作审计留痕 |

## 5. 已知缺口

- **`entry-worker-definition-handle-403` SKIP**：I16 要求"Handle 通道调用 `publish_worker_definition`
  必须 403"，但从这个 POSIX shell 脚本铸造一个真正签名的 Capability Handle 并不便宜——主机上没有
  `node`/`corepack`（`docs/runbooks/host-worker-runtime.md` §10），也没有任何面向任意 shell 调用
  的"签发 Handle"capability（Handle 签发是 `agent-host` 向内核内部链路要来的，不是一个公开
  capability）。这条规则改由内核单测在真实 gateway 管线上断言：
  `packages/kernel/src/application/gateway/handlers.test.ts` 的
  `"gateway/handlers — S2.6 worker-definition registry + I16"` 套件，具体是
  `"publish_worker_definition is rejected on the handle channel (I16, human-only)"`（以及
  `deprecate_worker_definition`、`assert_fact(WorkerDefinition …)` 的同类断言），CI 跑
  `DATABASE_URL` 打开时的完整套件。脚本本身如实 SKIP 并指回这份 runbook，不伪造一次 Handle 调用。
  （S2.6 之前：WorkerDefinition 注册表本身都还没交付，`entry-worker-definition` 整步都是 SKIP —
  见本文件的历史版本；S2.6 落地后，seed/propose/publish 三步已经是真实断言，只有 I16 的 403 这一
  半留在内核单测里。）
- **`packages/web` 的 Playwright e2e 是独立的 opt-in**（`pnpm --filter @nexttime/web e2e`，需要
  `WEB_E2E_BASE_URL`/`WEB_E2E_API_KEY`，且要求内核以 `AGENT_RUNTIME=fake` 启动——见
  `packages/web/README.md`"已知偏离"一节）：本脚本验收的是 `AGENT_RUNTIME=agent-host` 的真实链路
  （kernel → agent-host → 入口容器里的 pi → llm-proxy → fake-llm），不含 web UI 本身；两者互补，
  不是本脚本没做完。
- **`egress-domain-recorded` 用直接 `psql` 读，不是走某个 capability**：`audit_query` 看不到这次
  写入（`/internal/egress` 不经 `dispatchCapability`/`writeAudit`，是内核 host-bridge 收到
  `egress-proxy` 上报后的服务间写入，见 `packages/kernel/src/application/host-bridge/
  egress-observations.ts` 模块注释）；`explain` 的返回形状本身不含 `metadata` 原始字段
  （`substrate/epistemic/explain.ts` 的 `ExplainActivityRef` 只挑了几个字段投影出来）。三者里
  `psql` 是唯一能直接看到 `activities.metadata.egress` 内容的路径，任务派发文字本身也把它列为
  可选项之一。
- **"send 后立即 curl" 不是真正的后台并发**：`scripts/accept_s1.sh` 的 `egress_step` 用
  `send-only`（不等待 Turn 结束）紧跟着做 `docker exec curl`，两者顺序执行而非用 shell 后台任务
  并发——足够让 curl 大概率落在 Turn 仍在跑的窗口内，且内核侧新增的"最近一个 Turn"回退归因窗口
  （`recordEgressObservations` 的 `recentTurnWindowMinutes`，默认 5 分钟）让这一步即使时机没对上
  也不会误判失败。真正的并发（`&`/`wait`）会让脚本明显更复杂，权衡后未做。

## 6. `POST /internal/egress`（本任务在内核侧补的缺口）

`packages/egress-proxy`（S1.11）早就在向 `${KERNEL_URL}/internal/egress` 上报出网观测
（`packages/egress-proxy/src/report.ts` 的 `EgressReporter`），但内核侧此前没有这个路由接收它
——`scripts/accept_s1.sh` 要断言"目标域名出现在 Activity"，必须先把这个缺口补上，这也是本任务
（S1.10）除验收脚本本身之外唯一改动生产代码的地方：

- 路由：`packages/kernel/src/interfaces/http/internal/egress.ts`（`POST /internal/egress`，同
  `/internal/llm-usage`/`/internal/handle-revocations` 一样只在 `control` 网络可达、无额外鉴权）。
- 服务逻辑：`packages/kernel/src/application/host-bridge/egress-observations.ts`——解析
  `sourceId`（`entry:<workspaceId>:<principalId>`，格式定义在 `packages/worker-supervisor/src/
  egress-map.ts`）、找该 principal 当前在跑的 Turn（没有则回退到最近 5 分钟内的 Turn，找不到则
  丢弃并记日志——两种情形都不 500）、把观测追加进该 Turn 的 `metadata.egress`（jsonb，有界，最多
  200 条）、发一条 `EgressObserved` 领域事件到 outbox。
- `docs/development-tasks.md` S1.11 的验收文字（"Activity 记录含 example.com"）此前一直没有内核
  侧实现能兑现；本任务补上后，`scripts/accept_s1.sh` 才第一次真正验证这一条。
