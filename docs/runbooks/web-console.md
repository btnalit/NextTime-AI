# Runbook：web-console（工作区控制台的使用与排障）

## 目的

`packages/web` 是设计文档 §7.6 的人类入口：登录、对话、审批队列、任务、连接系统。本文说明每个页面依赖哪些 capability、各角色能看到什么、以及现场报错时先查什么。构建与上线步骤见 `host-caddy.md` §E8.5（`docker compose build caddy`）。

## 页面与 capability 对照

| 页面 | 读 | 写 | 实时推送 |
|---|---|---|---|
| Chats / Chat | `list_chats` `get_chat_history` `subscribe_chat`（WS） | `new_chat` `send_chat_message` `stop_agent`（WS）；卡片内 `approve` `reject` `set_auto_approved_action_kind`（HTTP） | `chat.message` `chat.stream` `chat.metadata` `action.updated` |
| Approvals | `list_pending` `get_action` | `approve` `reject` `set_auto_approved_action_kind` | `action.pending` `action.updated` |
| Tasks | `list_tasks` `get_task` `list_worker_definitions`（名字）`list_pending`（关联审批） | `cancel_task` | `task.updated` `action.pending/updated` |
| Connections | `list_connection_requests` `search{objectType:Gatekeeper}` `search{objectType:Operation}` | `request_connection` `create_connection` `publish_manifest` `connect_gatekeeper` | 无 |
| 侧栏徽标 | `list_pending`（计数） | — | `action.pending` `action.updated` |

所有 HTTP 调用都是 `POST /api/cap/<name>`，`Authorization: Bearer <api key>`；WS 为 `/ws` JSON-RPC。API key 只存在 `sessionStorage`，关标签页即失效，"Forget key" 立即清除。

## 角色与可见性（内核目前不回传当前 principal 的角色）

- `member`：Chats / Tasks 正常；Approvals 页显示"需要 operator 角色"的说明（`list_pending` 返回 403 `forbidden`），侧栏不显示徽标；Connections 页可发起 `request_connection`，"Connection requests" 区显示 owner-only 说明。
- `operator`：以上加审批队列与"Always allow this kind"。
- `owner`：以上加 Connections 全部（完成连接、发布清单、授予门）。

控制台没有角色读取能力，一切按 **首次 403** 推断：某个 capability 一旦返回 `forbidden`，本会话内它以及注册表里同一 `minRole`（及更高）的 capability 一并视为不可用（`hooks/usePermissions.tsx` 的 `deniedClosure`，按 `@nexttime/shared` 的 `CAPABILITY_REGISTRY` 派生），相关按钮隐藏或替换为说明；"Forget key" 重新登录后重置。

## 状态词表

芯片（StatusChip）的颜色与文字来自 `@nexttime/shared` 的枚举（`enums.ts`）与转移表（`transitions.ts`）：ActionRequest 13 态、Task、WorkerRun、ConnectionRequest（`requested|completed|cancelled`）、Publishable（`draft|published|deprecated`）。内核新增一个状态而 web 没有配色时 `tsc` 与 `StatusChip.test.tsx` 都会失败；线上若出现未知值，芯片以虚线边框 + 原始字符串显示，不会被误染成别的语义。Tasks 页的"Cancel task"只在 `TASK_TRANSITIONS` 有 `cancel` 出边的状态（`running`）下出现。

## 排障

| 现象 | 先查 | 说明 |
|---|---|---|
| 登录页提示"This key was not accepted" | key 是否来自本工作区的 `bootstrap add-principal` | WS `authenticate` 返回 `-32001 unauthorized` |
| 页面红色横幅显示 `network` | caddy → kernel 的 `/api` 反代、kernel 是否在跑 | `fetch` 本身失败（不是内核错误码） |
| 横幅显示 `Illegal invocation` | 已在本 PR 修复（`lib/http-client.ts`） | 旧构建的 bug：全局 `fetch` 被当方法调用；重新 `docker compose build caddy` |
| Approvals 显示"需要 operator 角色" | 该 principal 的 `role` | `list_pending` 的 `minRole: 'operator'` |
| 侧栏连接点为黄色 Reconnecting | kernel 是否重启、caddy `/ws` 反代 | `WsClient` 自动重连并从最后 sequence 续订 |
| Connections 提交后 `manifest_fetch_failed` / `gatekeeper_timeout` / `gatekeeper_error` | 横幅里门的原文 | 502/504：门或 manifest URL 未响应；修 endpoint/manifestSource 后重试 |
| Connections 提交后字段变红（400） | 字段下的说明 | `invalid_params`：例如选了 connected_account 却没填凭证 |
| "Registered systems" 只显示 50 个 | 无解，内核 `search` 无分页 | 见"已知缺口" |
| 浏览器反复弹证书警告（点过"继续访问"之后又出现） | 一次性把 Caddy 内部根证书导入客户端信任库：主机 `${NEXTTIME_DATA}/caddy/caddy/pki/authorities/local/root.crt` → Windows「受信任的根证书颁发机构」/ macOS 钥匙串 / Linux `update-ca-certificates` | Caddy 内部 CA 签的叶子证书会轮换（`deploy/caddy/Caddyfile` 已把默认 12h 调到 90 天，并把中间证书寿命从 7 天调到 100 天——不调中间证书时叶子寿命会被钳到 7 天；改 Caddyfile 后要 `docker compose restart caddy`），Chrome 的例外只绑定单张证书指纹，轮换即失效；导入根证书后不再出现 |

## 已知缺口（内核侧，控制台已就地绕过）

1. 没有"当前 principal 是谁 / 什么角色"的读取能力——按 403 推断。
2. 没有 principal 目录——`connect_gatekeeper` 需要手工粘贴 principal id。
3. 没有列出已决定 ActionRequest 的能力（`list_pending` 只回 pending，`get_action` 按 id）——"All" 标签只包含本会话观察到的决定。
4. `search` 固定 50 条上限、无分页、无排序参数。
5. `approve` 没有 `reason` 参数（`reject` 有）——理由只随 Reject 提交。
6. 没有 Task → ActionRequest 的读取——"Linked approvals" 只能从 `list_pending` 按 `parentWorkerRunId` 反查 pending 的。
7. `action.pending` 推送的 `title`/`description` 仍由 `actionKind` 拼出（S2.11 已知偏离），`simulated` 恒为空。
8. `cancel_connection_request` 未交付（S2.13 已知偏离），控制台没有取消按钮。

## 验证

```bash
corepack pnpm --filter @nexttime/web lint
corepack pnpm --filter @nexttime/web typecheck
corepack pnpm --filter @nexttime/web test
corepack pnpm --filter @nexttime/web build
# 有内核与浏览器时（README "End-to-end (Playwright)"）：
WEB_E2E_BASE_URL=... WEB_E2E_API_KEY=... corepack pnpm --filter @nexttime/web e2e
```
