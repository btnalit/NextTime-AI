# Runbook：add-gatekeeper（新增一个接入包）

对应任务：development-tasks.md § S3.10（"`docs/runbooks/`：新增一个接入包（含清单导入与发布）"；
S3 实施波次表 W1-E 行）。设计依据：`docs/graph-ai-middle-platform-design.md` §5.1.4（Gatekeeper/
Operation/Connection）、§7.5（通用传输种类 + 接口清单）、§7.10（"接入包 `gatekeepers/<system>/`"）。

已有的完整工作示例：`docs/runbooks/host-gatekeepers.md`（`docker`/`ragflow` 两个预置接入包的主机
验收，含 CLI 路径与 S2.13 capability 路径的完整命令）——本文档不重复那份文档已经跑通的具体命令，
只讲"新增一个（本仓库还没有的）接入包"该怎么做，在需要具体命令时链接过去。

## 1. 目的

把一个新的外部系统（内部工具、SaaS API、MCP server、SSH 可达的主机……）接入平台，让 agent 能观察
它、并在审批之后对它执行受治理的写操作。完成后：一个已发布的 Gatekeeper 实例 + 已分类
（mode/blast_radius/auto_approvable/await_decision）并发布的 Operation 清单 + 授予目标用户的
Grant。

## 2. 先讲清楚三个容易混的概念（少走弯路）

**门（Gatekeeper）不等于"专属代码包"。** `@nexttime/gatekeeper-base` 的 `main()`
（`packages/gatekeeper-base/src/index.ts`）是一个完全由环境变量驱动的通用单传输门（README
"Building a concrete gate"）——`http`/`mcp`/`cli`/`ssh` 四种传输种类都能直接用它起一个 compose
服务，**不需要**写代码、不需要一个专属的 `gatekeepers/<system>/` 包。`accept-s2-ssh-gate`/
`accept-s2-http-gate`（`docker-compose.yml`）就是这么起的。只有当需要非文件形式的 manifest 来源、
多传输组合、或自定义凭证/映射逻辑时（`gatekeepers/docker`、`gatekeepers/ragflow` 均属此类），才需要
写一个专属包——见 §5。**先假设不需要**，往下走，撞到真正需要自定义逻辑时再回头看 §5。

**清单有两份拷贝，必须保持一致。** `GatekeeperBase`（`packages/gatekeeper-base/src/gatekeeper-
base.ts`）在**门自己的进程里**按 `Operation.name` 建一个 Map（`operationsByName`）——门服务实际处理
`/gate/observe`/`/gate/apply` 时，只认**它自己启动时通过 `GATE_MANIFEST_FILE` 加载的那份清单**，
请求体里只有 `{operation: "<name>", params}`，没有 `binding` 之类的额外信息。内核这边的
`create_connection{manifestSource}` 导入的是**图里的 Operation 草稿**（`find_operations`/审核向导
看到的那份），两者是**两份独立的拷贝**——只有 `manifestSource` 省略、走"直接问门要 `describe_
operations`"这条路径时，两份才**保证**是同一份（因为图里导入的就是门自己吐出来的那份）。见 §6 的
详细说明与 §9 的已知陷阱——这是本文档写作时在代码里核实到的一个真实、容易踩的坑。

**两条互补的注册路径，不是二选一淘汰关系。** ①主机操作员的 CLI 路径（`bootstrap.js
register-gatekeeper`，不经过任何用户/权限模型，见 `docs/runbooks/host-gatekeepers.md` §5）；
②面向终端用户的 capability 路径（`request_connection` 卡片 → owner `create_connection` →
`publish_manifest` → `connect_gatekeeper` 授权，见 `docs/runbooks/host-gatekeepers.md` §10）。
新增一个门实例本身（起服务、验证协议端点）用哪条都行；本文档默认走②，因为它同时覆盖了"给谁用"这一
步（①需要额外手动查 `capability_grants` 表或另跑一遍连接流程）。

## 3. 前置条件

- 目标主机已完成 `docs/runbooks/host-gatekeepers.md` §0 的全部前置（数据目录、`.env`、
  `secrets/gate.token` 已生成——`docs/runbooks/key-rotation.md` §3 有该密钥的完整说明）。
- 有一个 workspace 与至少一个 owner Principal（`docs/runbooks/host-gatekeepers.md` §4，或复用已有
  的）。
- 目标系统的地址与凭证：`http`/`mcp` 需要一个可达的 base URL；`ssh` 需要主机、用户、私钥；`cli`
  需要门进程能执行的命令模板。
- 若目标系统凭证是"每用户各自持有"（而不是整个门共享一份服务账号），确认这一点——决定 §6 里
  `credentialKind: 'connected_account'` 还是 `'shared'`。

## 4. 步骤 A：起一个通用门实例（最快路径，无需写代码）

以 `http` 为例（`mcp`/`cli`/`ssh` 的 env 变量对照见 `packages/gatekeeper-base/README.md`"Building
a concrete gate"与"Manifest format"两节；`accept-s2-ssh-gate`/`accept-s2-http-gate` 在
`docker-compose.yml` 里是两个可直接抄的完整样板）：

1. 写清单 `deploy/gatekeepers/<system>-manifest.json`（数组，元素形状见 §6）。
2. 在 `docker-compose.yml` 追加一个服务（新增文件，additive-only，不改已有服务块）：

```yaml
  gatekeeper-<system>:
    build: { context: ., dockerfile: packages/gatekeeper-base/Dockerfile }   # 通用镜像——
                                                                              # `accept-s2-ssh-gate`/
                                                                              # `accept-s2-http-gate`
                                                                              # 两个 compose 服务块
                                                                              # 就是这么复用它的
    secrets: [gate_token]
    environment:
      {
        GATE_TRANSPORT_KIND: http,                       # 或 mcp / cli / ssh
        GATE_TARGET_BASE_URL: http://<system>:8080,       # http 用这个；mcp 换成 GATE_TARGET_ENDPOINT
        GATE_CREDENTIAL_MODE: shared,                     # 或 connected_account（见 §3 判断）
        GATE_MANIFEST_FILE: /data/gate-manifest.json,
        GATE_PORT: "8090",
      }
    volumes:
      [
        "${NEXTTIME_DATA}/gatekeepers/<system>:/data/gate",
        "./deploy/gatekeepers/<system>-manifest.json:/data/gate-manifest.json:ro",
      ]
    networks: [control]
    restart: unless-stopped
```

3. 主机侧建数据目录（`GATE_DATA_DIR` 承载幂等 apply 存储/`ConnectedAccountStore`）：
   ```bash
   mkdir -p "${NEXTTIME_DATA}/gatekeepers/<system>"
   ```
4. 起服务并验证协议端点（`GATE_TOKEN` 取值见 `docs/runbooks/key-rotation.md` §3）：
   ```bash
   docker compose up -d gatekeeper-<system>
   GATE_TOKEN=$(cat "${NEXTTIME_DATA}/secrets/gate.token")
   docker compose exec -T kernel node -e "
   fetch('http://gatekeeper-<system>:8090/gate/health', {headers:{authorization:'Bearer ${GATE_TOKEN}'}}).then(r=>r.text()).then(console.log)
   "
   docker compose exec -T kernel node -e "
   fetch('http://gatekeeper-<system>:8090/gate/describe_operations', {headers:{authorization:'Bearer ${GATE_TOKEN}'}}).then(r=>r.text()).then(console.log)
   "
   ```
   期望：`health` 返回 `{"ok":true,"result":{"status":"ok"}}`；`describe_operations` 返回 §6 写的
   清单原样。

若目标系统走 `https` 且证书自签，见 `docs/runbooks/host-gatekeepers.md` §11.1（`GATE_TLS_CA_FILE`/
`GATE_TLS_SERVERNAME`——**不要**用 `NODE_TLS_REJECT_UNAUTHORIZED=0`，`fix/gate-protocol-hardening`
之后门会直接拒绝启动）。

## 5. 步骤 B：需要自定义逻辑时——写一个专属 `gatekeepers/<system>/` 包

以 `gatekeepers/docker`（`packages/gatekeeper-base`README"Building a concrete gate"提到的、绕开
env 驱动 `main()`、直接组合 `GatekeeperBase`/`createGatekeeperServer` 的路径）为模板：

```
gatekeepers/<system>/
├── Dockerfile
├── package.json          # workspace 成员，见 pnpm-workspace.yaml 的 "gatekeepers/*"
├── manifest.json          # 或代码内联生成（gatekeepers/ragflow 的方式）
├── src/
│   ├── index.ts           # 组合 GatekeeperBase + createGatekeeperServer + 自定义 transport/凭证
│   ├── transport.ts        # 若目标系统的调用逻辑比 http/mcp/cli/ssh 四种通用传输更复杂
│   └── *.test.ts
├── tsconfig.json
└── vitest.config.ts
```

在 `docker-compose.yml` 里新增对应服务块（additive-only）。何时需要走这条路而不是 §4：
`gatekeepers/docker` 需要 dockerode 而非通用 http/cli 传输；`gatekeepers/ragflow` 需要自定义
TLS/错误信封处理（README"RAGFlow 的 `{code, data}` 错误信封对协议不可见"）。若目标系统能用一个
`GET`/`POST` + 固定 base URL、或一个 MCP `tools/list`、或 SSH 命令模板描述，走 §4 更快。

## 6. 清单编写（Operation 分类）

一个 `Operation`（`@nexttime/shared` 的 `OperationSchema`，`gatekeepers/docker/manifest.json`是最
简短的真实例子）：

```json
{
  "name": "widgets.list",
  "binding": { "kind": "http", "method": "GET", "path": "/widgets" },
  "params_schema": { "type": "object", "properties": {}, "additionalProperties": false },
  "mode": "observe",
  "blast_radius": "low",
  "reversibility": false,
  "auto_approvable": true,
  "await_decision": false,
  "reads": ["Widget"],
  "writes": []
}
```

| 字段 | 怎么定 |
|---|---|
| `mode` | `observe`（只读，不产生 ActionRequest）或 `execute`（治理写操作） |
| `blast_radius` | `low`（默认自动批准，design §11）/ `medium` / `high`——影响半径，不是"敏感度" |
| `auto_approvable` | `false` 一旦设定，任何工作区策略都不能把它转成自动批准（`governance/policy/engine.ts` 的 `operation_not_auto_approvable` 分支无条件先于策略检查——见 `docs/runbooks/host-accept-s2.md`"已知偏离"关于 `ssh.run_command` 的说明，这是一处容易踩的反直觉行为：想要"默认要审、但 owner 可以设成总是允许"，`auto_approvable` 必须是 `true`，靠 `blast_radius` 不是 `low`（默认仍会 `require_approval`）来保证初始状态需要审批，而不是靠 `auto_approvable:false`） |
| `await_decision` | `true`：调用方等到有决定（或超时）才返回；`false`：立即返回 `pending_approval` + `simulate`，调用方下一轮再看结果。执行类操作默认建议 `true`（更保守，`docs/runbooks/host-gatekeepers.md`"已知偏离"里 `compose.up`/`compose.down` 的选择） |
| `reversibility` | 是否实现了 `/gate/revert`（门自己的 transport 是否提供 `revert`） |
| `reads`/`writes` | 该 Operation 观察/影响哪些图 ObjectType——若这些类型还不存在，先走 `docs/runbooks/add-domain-pack.md` |
| `binding` | 与门自己的 `GATE_TRANSPORT_KIND` 匹配：`http` → `{method,path}`；`mcp` → `{tool_name}`；`cli` → `{command_template}`；`ssh` → `{command_template}` 或 `{command_pattern}` |

`importOpenApi(document)`/`importMcpTools(toolsListResponse)`（`@nexttime/gatekeeper-base`）能从一
份 OpenAPI 3.x 文档或 MCP `tools/list` 响应**自动**推导出草稿清单（`GET`/`readOnlyHint` →
`observe`，其余 → `execute`，且新导入的 `execute` 一律 `auto_approvable:false, await_decision:
true`，等 owner 逐条审核后再发布，I17）——不需要手写每一行，见 §7 的导入路径。

## 7. 注册、导入清单、发布——capability 路径

同 `docs/runbooks/host-gatekeepers.md` §10 完整走一遍（`WORKSPACE_ID`/`OWNER_ID`/`OWNER_KEY`
的取得方式见该文档 §4），本文档只给出针对**新**门实例的调用骨架：

```bash
# 1. request_connection —— 任何 member 都能发起
curl -s https://<host>:8443/api/cap/request_connection \
  -H "Authorization: Bearer ${MEMBER_OR_OWNER_KEY}" -H 'content-type: application/json' \
  -d '{"kind":"http","target":"<system>"}'
# {"ok":true,"result":{"id":"<cr-uuid>","status":"requested",...}}   —— 主键统一叫 id
#   （docs/wire-contract-conventions.md §1"单资源结果主键一律 id"），第 3 步 create_connection
#   参数里的 connectionRequestId 字段名不变，只是这里取的是 result.id 这个值。

# 2. owner 在 web 控制台"治理 → 系统接入"（#/govern/systems）能看到这张卡片；或 CLI/curl：
curl -s https://<host>:8443/api/cap/list_connection_requests \
  -H "Authorization: Bearer ${OWNER_KEY}" -H 'content-type: application/json' -d '{"status":"requested"}'

# 3. create_connection —— owner 完成这张卡片。两种导入方式二选一：
#    (a) 省略 manifestSource：直接问门要 describe_operations（§2 的"保证一致"路径，推荐）
curl -s https://<host>:8443/api/cap/create_connection \
  -H "Authorization: Bearer ${OWNER_KEY}" -H 'content-type: application/json' \
  -d "{\"connectionRequestId\":\"<cr-uuid>\",\"kind\":\"http\",\"target\":\"<system>\",\"endpoint\":\"http://gatekeeper-<system>:8090\",\"credentialKind\":\"shared\"}"
#    (b) 给 manifestSource（http: OpenAPI 文档 URL；mcp: tools/list 端点）——从目标系统直接导入，
#        见 §9 的一致性陷阱，只在你确认门自己的 GATE_MANIFEST_FILE 与这份导入结果一致时才用：
#    -d "{...,\"manifestSource\":\"http://<system>:8080/openapi.json\"}"

# 4. publish_manifest —— 逐条 Operation 分类审核之前，先把导入的草稿整体或逐条看一遍（web 控制台
#    "系统接入"页的接入向导第④步——mode/blast_radius/auto_approvable 预览，见 §8）；确认无误后发布：
curl -s https://<host>:8443/api/cap/publish_manifest \
  -H "Authorization: Bearer ${OWNER_KEY}" -H 'content-type: application/json' \
  -d "{\"gatekeeperId\":\"<gk-uuid>\"}"

# 5. connect_gatekeeper —— 授予某个用户的入口 agent 使用权（写一条 CapabilityGrant）
curl -s https://<host>:8443/api/cap/connect_gatekeeper \
  -H "Authorization: Bearer ${OWNER_KEY}" -H 'content-type: application/json' \
  -d "{\"gatekeeperId\":\"<gk-uuid>\",\"principalId\":\"<target-principal-uuid>\"}"
```

`observe` 类 Operation 在第 5 步**之前**就已经能被目标用户的 `find_operations` 看到（观察不需要门
授权，`docs/runbooks/host-gatekeepers.md` §10 末段）；`execute` 类只有第 5 步之后、且目标用户下一次
（重新）签发入口 Handle 才生效。

## 8. Operation 分类审核——Web 控制台路径

"治理 → 系统接入"（`#/govern/systems`）→ 目标门 → **接入向导**（`OnboardingWizardReview.tsx`）第④
步：逐条列出导入的 Operation（数据源是 `search{objectType:'Operation'}`，不是 `list_operations`——
后者的投影函数不带 `propose_operation` 需要的 `binding`/`params_schema` 等字段），每行可预览
`mode`/`blast_radius`/`auto_approvable`/`await_decision`/参数 schema，点击提交走
`propose_operation` → `publish_operation` 两步（不提供"直接改分类"的捷径——分类决定审批边界，见
`docs/graph-ai-middle-platform-design.md` §7.10"机制与内容分离"）。

**已知内核限制（写本文档时仍成立，2026-09 已有一次修复）**：`propose_operation` 对一个仍是
`origin:'import'` 且**尚未** `publish_manifest`/`publish_operation` 发布过的草稿再次提议会
409 `conflict`（I16——该草稿不是提议者自己通过 `propose_operation` 写的）；对一个**已发布**的身份
再提议则会开一条新修订草稿（`fix/operation-revision-via-propose` 已修复这条，见
`docs/runbooks/web-console.md`"已知缺口"第 11 条的完整说明，这里不重复）。实践含义：**先
`publish_manifest` 整批发布，再对个别需要重新分类的 Operation 走 propose/publish 修订**，不要在
`publish_manifest` 之前就尝试对某一条单独 `propose_operation`。

## 9. MCP 门——已核实的一个陷阱

`create_connection{kind:'mcp', manifestSource:'<mcp端点>', credentialKind:'shared'}` **不需要**
任何前置门进程——内核自己直接调 `McpTransport.listTools` 拉取 `tools/list` 并导入
（`deploy/accept-s2/mcp/` 这个验收 fixture 就是这么接的，见 `docker-compose.yml`
`accept-s2-mcp` 服务块自己的注释）。这条路径能让 `find_operations` 命中，**但不能让实际的
`observe`/`execute` 调用工作**——`endpoint` 字段被要求非空，但它只在 `credentialKind:
'connected_account'` 时才会真的被 POST 凭证；若 `endpoint` 指向的不是一个实现了 `/gate/*` 协议的
真实门进程（而是 MCP 服务器自己的地址，如 fixture 那样），任何后续 `request_action` 都会找不到路由
（`HttpGatekeeperClient` 只认 `/gate/*`，从不直接说 MCP）。

**结论**：`manifestSource` 直连导入只适合**目录预览/快速看一眼这个 MCP server 有什么工具**；要让
它真正可用（observe/execute 都能跑），必须按 §4 起一个 `GATE_TRANSPORT_KIND: mcp,
GATE_TARGET_ENDPOINT: <mcp端点>` 的真实门实例，`endpoint` 填**这个门自己的地址**（不是 MCP
服务器本身的地址），清单走 §2 的"省略 manifestSource、直接问门要 describe_operations"这条一致
路径。

## 10. 验证

```bash
# observe 类：走一次 request_action，确认落 Fact
curl -s https://<host>:8443/api/cap/request_action \
  -H "Authorization: Bearer ${TARGET_USER_KEY}" -H 'content-type: application/json' \
  -d "{\"gatekeeperId\":\"<gk-uuid>\",\"operation\":\"<observe-operation-name>\",\"params\":{}}"
# 期望 {"ok":true,"result":{"status":"ok","data":[...],"observedFactCount":N}}

# execute 类：完整审批链，同 docs/runbooks/host-gatekeepers.md §7 的写法（request_action → 拿
# actionRequestId → approve → 轮询 get_action 到 executed）

# explain 溯源：确认新写入的 Fact 能沿 explain 追到这个门
curl -s https://<host>:8443/api/cap/explain \
  -H "Authorization: Bearer ${TARGET_USER_KEY}" -H 'content-type: application/json' \
  -d '{"nodeId":"<fact-id>"}'
```

### 10.1 自动化演练：`scripts/drill-add-gatekeeper.sh`

S3.10 交付物——把本文档 §7 request → create → publish_manifest → grant 与本节 observe 验证这五步
自动化成一个 PASS/FAIL 分明、可重复跑的脚本，对应 `docs/development-tasks.md` § S3.10 的验收句
"按「新增接入包」手册接入一个 fake 系统成功"：

```bash
cd <CODE_DIR>
sh scripts/drill-add-gatekeeper.sh
```

用的"fake 系统"就是 §9 之外这份文档里反复提到的 accept-s2 OpenAPI fixture
（`deploy/accept-s2/openapi-fixture/`，一个 `stock.get` observe Operation）——不是另起一套新
fixture，与 `scripts/accept_s2.sh` 自己的 http 连接那一段共用同一对 compose 服务
（`accept-s2-openapi`/`accept-s2-http-gate`）与同一个 `${NEXTTIME_DATA}/accept-s2/http-gate/`
目录，因此**不要**与一次正在跑的 `accept_s2.sh` 并发执行（两者都会重新生成令牌并让 compose 重建
这两个容器，谁先起的就会被谁后起的顶掉——脚本自己的头部注释也记了这条）。

脚本自己新建一个 `drill-add-gatekeeper-<ts>` workspace（owner + member 两个 Principal），member
发起 `request_connection`，owner 完成 `create_connection`（`manifestSource` 指向 fixture 的
`openapi.json`，走§2 的自动导入路径）→ `publish_manifest` → `connect_gatekeeper`（把门授权给
member，不是 owner 自己），最后由 **member**（被授权的那个人，不是 owner）调用 `request_action`
观察 `stock.get`，断言 `result.status === "ok"` 且 `observedFactCount >= 1`——真的证明了这条授权
链本身生效，不只是"owner 反正什么都能调"。

期望输出（末尾）：
```
PASS preflight-services postgres, kernel running
PASS preflight-build accept-s2-openapi, accept-s2-http-gate images built
PASS bootstrap-workspace workspace=... owner=... key=...(redacted)
PASS bootstrap-member member=... key=...(redacted)
PASS fixtures-store-key ...
PASS fixtures-api-token bearer token generated: ...(redacted)
PASS fixtures-up accept-s2-openapi, accept-s2-http-gate up and healthy
PASS request-connection connectionRequestId=...
PASS create-connection gatekeeperId=... (imported stock.get from OpenAPI manifest)
PASS publish-manifest manifest published
PASS connect-gatekeeper gatekeeper granted to member ...
PASS observe-operation stock.get -> status=ok observedFactCount=1 (member observed through the granted gatekeeper)
PASS cleanup workspace retained: ...
DRILL-ADD-GATEKEEPER OK
```
任何一步失败都打印 `FAIL <step> <detail>` 到 stderr 并以非零退出。默认跑完会 `docker compose
--profile accept-s2 stop accept-s2-openapi accept-s2-http-gate`（不影响 §4/§5 起的其它门实例，
只停这两个 fixture 容器）；创建的 workspace 按 accept_s1.sh/accept_s2.sh 同样的约定保留作审计
轨迹，`sh scripts/delete-workspaces-matching.sh '^drill-add-gatekeeper' --yes` 定期清理。想跑完
之后保留 fixture 容器方便手动继续探查，加 `--keep`。

## 11. 回滚

```bash
# 撤销某个用户的授权（不删除门本身）：
curl -s https://<host>:8443/api/cap/revoke_capability \
  -H "Authorization: Bearer ${OWNER_KEY}" -H 'content-type: application/json' \
  -d '{"grantId":"<grant-id-from-connect_gatekeeper-result>"}'

# 弃用某个已发布的 Operation（不影响门实例本身与其它 Operation）：
curl -s https://<host>:8443/api/cap/deprecate_operation \
  -H "Authorization: Bearer ${OWNER_KEY}" -H 'content-type: application/json' \
  -d '{"gatekeeperId":"<gk-uuid>","name":"<operation-name>"}'

# 彻底下线门服务（数据留存，与 docs/runbooks/host-bootstrap.md"删除 Workspace"不是一回事——
# 这里不删任何 Workspace/图数据，只是停止/移除这一个门容器与它的 compose 服务定义）：
docker compose stop gatekeeper-<system>
# 从 docker-compose.yml 移除该服务块、git revert 对应的 manifest/compose 改动，再
docker compose rm -f gatekeeper-<system>
```
门实例本身在图里留下的 Gatekeeper/Operation 对象、已产生的 Fact/ActionRequest/AuditRecord 均不会
被这几步删除——design §12"审计 append-only"，这是刻意的。

## 12. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `describe_operations` 返回空数组 | `GATE_MANIFEST_FILE` 没设置或路径不对——`loadManifest(undefined)` 直接返回 `[]`（`packages/gatekeeper-base/src/index.ts`），不会报错 | 确认 compose 服务块的 `GATE_MANIFEST_FILE` 与实际挂载路径一致 |
| `find_operations` 命中，但 `request_action` 对同一个 Operation 报 `OperationNotFoundError`/门返回 404 | §9 的陷阱——图里的 Operation 是从 `manifestSource` 导入的，门自己的 `GATE_MANIFEST_FILE` 里没有同名条目 | 让门自己也加载同一份清单（§4 步骤 1，`GATE_MANIFEST_FILE` 指向和导入源一致的文件），或改用省略 `manifestSource` 的导入路径 |
| 门服务一直重启循环，日志里有 `NODE_TLS_REJECT_UNAUTHORIZED` 相关警告后进程退出 | `fix/gate-protocol-hardening` 后门在启动阶段检测到这个变量直接拒绝启动 | 按 `docs/runbooks/host-gatekeepers.md` §11.1 用 `GATE_TLS_CA_FILE`/`GATE_TLS_SERVERNAME`，不要关闭证书校验 |
| `create_connection` 一直 `manifest_fetch_failed`/`gatekeeper_timeout` | `endpoint`/`manifestSource` 不可达，或门还没起（`docker compose ps gatekeeper-<system>`） | 先按 §4 步骤 4 单独验证门自己的 `/gate/health`/`describe_operations`，确认门本身没问题再重试 `create_connection` |
| 想设置"默认要审、owner 可以一键设为总是允许"，结果 `set_auto_approved_action_kind` 之后仍然每次都要审 | Operation 发布时 `auto_approvable` 写成了 `false`——见 §6 表格 | 改清单把该 Operation 的 `auto_approvable` 设为 `true`，走 `propose_operation`/`publish_operation` 发一个修订版本（§8） |
| `propose_operation` 报 409 `conflict` | 目标 Operation 还是 `origin:'import'` 且从未 `publish_manifest`/`publish_operation` 过（I16） | 先 `publish_manifest` 把它变成 `published`，再对已发布身份提议修订（§8） |
