# Runbook：web-console（工作区控制台的使用与排障）

## 目的

`packages/web` 是设计文档 §7.6 的人类入口：登录、对话、审批队列、任务、连接系统，以及（S3.11/S3.14）治理控制面——成员与授权、访问（Grant）、系统接入、能力目录、模型与配额、审计。本文说明每个页面依赖哪些 capability、各角色能看到什么、以及现场报错时先查什么。构建与上线步骤见 `host-caddy.md` §E8.5（`docker compose build caddy`）。

## 路由（S3.14）

`lib/router.ts` 的 hash 路由，未匹配（含所有 S3.14 之前的旧 hash，如 `#/chats`）一律回落到 `#/work/chats`：

| 路径 | 页面 | 导航分组 |
|---|---|---|
| `#/work/chats[/<id>]` | 对话列表 / 对话 | 工作 |
| `#/work/tasks[/<id>]` | 任务 | 工作 |
| `#/work/approvals[/<id>]` | 待我审批 | 工作 |
| `#/me/agent` | 我的智能体（S3.13 占位，只读展示 `list_models`） | 工作 |
| `#/govern/members` | 成员与授权 | 治理 |
| `#/govern/access` | 访问（Grant 矩阵） | 治理 |
| `#/govern/systems[/<gatekeeperId>]` | 系统接入（原 Connections 页；健康与 Operation 详情抽屉新增） | 治理 |
| `#/govern/catalog[/<tab>]` | 能力目录（operations/skills/procedures/workers 四个 tab） | 治理 |
| `#/govern/models` | 模型与配额 | 治理 |
| `#/govern/audit` | 审计（explain / reconstruct / audit_query） | 治理 |

## 页面与 capability 对照

| 页面 | 读 | 写 | 实时推送 |
|---|---|---|---|
| Chats / Chat | `list_chats` `get_chat_history` `subscribe_chat`（WS） | `new_chat` `send_chat_message` `stop_agent`（WS）；卡片内 `approve` `reject` `set_auto_approved_action_kind`（HTTP） | `chat.message` `chat.stream` `chat.metadata` `action.updated` |
| Approvals | `list_pending` `get_action` | `approve` `reject` `set_auto_approved_action_kind` | `action.pending` `action.updated` |
| Tasks | `list_tasks` `get_task` `list_worker_definitions`（名字）`list_pending`（关联审批） | `cancel_task` | `task.updated` `action.pending/updated` |
| 系统接入（`/govern/systems`） | `list_connection_requests` `search{objectType:Gatekeeper}` `search{objectType:Operation}` `get_gatekeeper`（S3.11，健康与 Operation 详情） | `request_connection` `create_connection` `publish_manifest` `connect_gatekeeper` | 无 |
| 成员与授权（`/govern/members`） | `list_principals` | `create_principal` `set_principal_role` `rotate_api_key` `disable_principal` | 无 |
| 访问（`/govern/access`） | `list_grants` `list_principals`（填充成员下拉，无则退化为手填 id） | `grant_capability`（已有）`revoke_capability`（已有） | 无 |
| 能力目录（`/govern/catalog`） | `list_operations`（S3.11 新增）`list_skills` `list_procedures` `list_worker_definitions`（均已有） | `publish_operation`/`deprecate_operation`、`publish_skill`/`deprecate_skill`、`publish_procedure`/`deprecate_procedure`、`deprecate_worker_definition`（均已有——两步 propose/publish，控制台不提供"直接改分类"捷径） | 无 |
| 模型与配额（`/govern/models`） | `list_models` `list_quotas` `list_policies` | 无（只读；S3.13 前无编辑能力） | 无 |
| 审计（`/govern/audit`） | `explain`（已有，member 可用）`reconstruct` `audit_query`（均已有，auditor） | 无 | 无 |
| 侧栏徽标 | `list_pending`（计数） | — | `action.pending` `action.updated` |
| 侧栏工作区名 + 角色徽标 | `get_workspace`（S3.11） | — | 无 |

所有 HTTP 调用都是 `POST /api/cap/<name>`，`Authorization: Bearer <api key>`；WS 为 `/ws` JSON-RPC。API key 只存在 `sessionStorage`，关标签页即失效，"Forget key" 立即清除。

## S3.11 内核并行落地：`该能力尚未上线`

成员与授权、访问、系统接入的 `get_gatekeeper`、能力目录的 `list_operations`、模型与配额的 `list_quotas`/`list_policies`——这些 capability 由另一条并行的内核 PR 实现，与本 PR 针对同一份契约（`docs/development-tasks.md` §S3.11）各自开发。若内核尚未部署这些 capability，调用返回 404 `not_found`（`CapabilityNotFoundError`）；控制台用 `lib/errors.ts` 的 `isNotFoundError` 识别这一情况，展示"该能力尚未上线 Not live yet"的空状态，而不是报错或崩溃。两条 PR 合并、内核侧部署后，这些页面无需改动即可正常工作。

## 角色与可见性

控制台没有直接读取"当前 principal 是谁 / 什么角色"的 capability（`list_principals` 也不回传调用方自己的 API key，无法据此反查自身）。按钮级别的可见性仍按**首次 403** 推断：某个 capability 一旦返回 `forbidden`，本会话内它以及注册表里同一 `minRole`（及更高）的 capability 一并视为不可用（`hooks/usePermissions.tsx` 的 `deniedClosure`，按 `@nexttime/shared` 的 `CAPABILITY_REGISTRY` 派生），相关按钮隐藏或替换为说明。

S3.14 新增侧栏角色徽标与"治理"导航分组的显隐，用同一份证据做**尽力而为**的正面推断（`lib/role.ts` `inferRole`）：owner-minRole 的 capability 一旦调用成功 → 徽标显示 Owner；operator-minRole 的一旦被拒 → 徽标显示 Member 且"治理"分组隐藏（这是最强的反证：拒绝证明既非 operator 也非 owner）；operator-minRole 成功但尚无 owner-only 被拒的证据 → 显示 Operator+（诚实的区间，而非猜测）；两者都还没有证据 → 显示 "—"（未知），此时"治理"分组**默认展示**给所有人，具体页面按各自 capability 的 403 就地渲染"需要 owner/operator 权限"的说明——绝不臆造一个 `whoami` capability。

- `member`：Chats / Tasks 正常；Approvals 页显示"需要 operator 角色"的说明（`list_pending` 返回 403 `forbidden`），侧栏不显示徽标；系统接入页可发起 `request_connection`，"Connection requests" 区显示 owner-only 说明；"治理"导航分组一旦角色被证实为 member 即隐藏（在此之前仍可见，进入后各页自行按 403 收窄）。
- `operator`：以上加审批队列、"Always allow this kind"、模型与配额页的配额小节。
- `owner`：以上加成员与授权、访问、系统接入全部、能力目录的发布/弃用操作。
- `auditor`：审计页的 `reconstruct`/`audit_query`（`explain` 对所有角色开放）。

## 状态词表

芯片（StatusChip）的颜色与文字来自 `@nexttime/shared` 的枚举（`enums.ts`）与转移表（`transitions.ts`）：ActionRequest 13 态、Task、WorkerRun、ConnectionRequest（`requested|completed|cancelled`）、Publishable（`draft|published|deprecated`）、Grant（`active|revoked|expired`，S3.14 新增）、Role（`owner|builder|operator|member|auditor`，S3.14 新增，非真正状态机，复用同一套色调以保持视觉一致）。内核新增一个状态而 web 没有配色时 `tsc` 与 `StatusChip.test.tsx` 都会失败；线上若出现未知值，芯片以虚线边框 + 原始字符串显示，不会被误染成别的语义。Tasks 页的"Cancel task"只在 `TASK_TRANSITIONS` 有 `cancel` 出边的状态（`running`）下出现。

## 排障

| 现象 | 先查 | 说明 |
|---|---|---|
| 登录页提示"This key was not accepted" | key 是否来自本工作区的 `bootstrap add-principal` 或治理页新建的成员 | WS `authenticate` 返回 `-32001 unauthorized` |
| 页面红色横幅显示 `network` | caddy → kernel 的 `/api` 反代、kernel 是否在跑 | `fetch` 本身失败（不是内核错误码） |
| 横幅显示 `Illegal invocation` | 已在本 PR 修复（`lib/http-client.ts`） | 旧构建的 bug：全局 `fetch` 被当方法调用；重新 `docker compose build caddy` |
| Approvals 显示"需要 operator 角色" | 该 principal 的 `role` | `list_pending` 的 `minRole: 'operator'` |
| 治理页显示"该能力尚未上线 Not live yet" | S3.11 内核 PR 是否已合并部署 | `isNotFoundError`——不是配置错误，是两条并行 PR 尚未都上线 |
| 治理页显示"需要 owner/operator 权限" | 该 principal 的角色；侧栏角色徽标 | 对应 capability 的 `minRole` |
| 成员页创建/轮换后密钥找不到了 | 密钥只显示一次，关闭抽屉前是否已复制 | 设计如此（S3.11："API key 只显示一次"）；忘记复制需再次 `rotate_api_key` |
| 侧栏连接点为黄色 Reconnecting | kernel 是否重启、caddy `/ws` 反代 | `WsClient` 自动重连并从最后 sequence 续订 |
| 系统接入提交后 `manifest_fetch_failed` / `gatekeeper_timeout` / `gatekeeper_error` | 横幅里门的原文 | 502/504：门或 manifest URL 未响应；修 endpoint/manifestSource 后重试 |
| 系统接入提交后字段变红（400） | 字段下的说明 | `invalid_params`：例如选了 connected_account 却没填凭证 |
| "Registered systems" 只显示 50 个 | 无解，内核 `search` 无分页 | 见"已知缺口"；"Health & operations" 详情抽屉（`get_gatekeeper`）不受此限制，但需要该 capability 已部署 |
| 浏览器反复弹证书警告（点过"继续访问"之后又出现） | 一次性把 Caddy 内部根证书导入客户端信任库：主机 `${NEXTTIME_DATA}/caddy/caddy/pki/authorities/local/root.crt` → Windows「受信任的根证书颁发机构」/ macOS 钥匙串 / Linux `update-ca-certificates` | Caddy 内部 CA 签的叶子证书会轮换（`deploy/caddy/Caddyfile` 已把默认 12h 调到 90 天，并把中间证书寿命从 7 天调到 100 天——不调中间证书时叶子寿命会被钳到 7 天；改 Caddyfile 后要 `docker compose restart caddy`），Chrome 的例外只绑定单张证书指纹，轮换即失效；导入根证书后不再出现 |

## 已知缺口（内核侧，控制台已就地绕过）

1. 没有"当前 principal 是谁 / 什么角色"的直接读取能力——`list_principals` 也无法据此反查自身（不回传 API key）；按 403/200 双向推断（见"角色与可见性"），S3.14 起有一个尽力而为的角色徽标，但不是权威来源。
2. ~~没有 principal 目录~~——S3.11 的 `list_principals` 填了这个缺口；`connect_gatekeeper`/`GrantCapabilityForm` 的成员下拉在该 capability 部署前仍退化为手填 id。
3. 没有列出已决定 ActionRequest 的能力（`list_pending` 只回 pending，`get_action` 按 id）——"All" 标签只包含本会话观察到的决定。
4. `search` 固定 50 条上限、无分页、无排序参数（Gatekeeper/Operation 的 `search` 路径——`get_gatekeeper`/`list_gatekeepers` 走另一条无此限制的路径，但同样要等 S3.11 内核 PR 部署）。
5. `approve` 没有 `reason` 参数（`reject` 有）——理由只随 Reject 提交。
6. 没有 Task → ActionRequest 的读取——"Linked approvals" 只能从 `list_pending` 按 `parentWorkerRunId` 反查 pending 的。
7. `action.pending` 推送的 `title`/`description` 仍由 `actionKind` 拼出（S2.11 已知偏离），`simulated` 恒为空。
8. `cancel_connection_request` 未交付（S2.13 已知偏离），控制台没有取消按钮。
9. `list_quotas`/`list_policies` 没有公开的行结构（`Policy`/`Quota` 在写侧都是 `set_policy{policy: jsonRecord}`/`set_quota{key,value}` 的不透明结构）——模型与配额页把 Quota 渲染成 key/value 表，Policy 渲染成脱敏后的 JSON 折叠块，不假设列名。
10. `export_prov` 未在审计页接入（范围外，留给后续任务）。

## 验证

```bash
corepack pnpm --filter @nexttime/web lint
corepack pnpm --filter @nexttime/web typecheck
corepack pnpm --filter @nexttime/web test
corepack pnpm --filter @nexttime/web build
# 有内核与浏览器时（README "End-to-end (Playwright)"）：
WEB_E2E_BASE_URL=... WEB_E2E_API_KEY=... corepack pnpm --filter @nexttime/web e2e
```
