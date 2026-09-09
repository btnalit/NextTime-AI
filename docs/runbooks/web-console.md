# Runbook：web-console（工作区控制台的使用与排障）

## 目的

`packages/web` 是设计文档 §7.6 的人类入口：登录、对话、审批队列、任务、连接系统，以及（S3.11/S3.14）治理控制面——成员与授权、访问（Grant）、系统接入、能力目录、模型与配额、审计；加上（S3.13）每用户智能体配置「我的智能体」与 AgentPolicy 编辑器、（S3.12）系统接入的接入向导。本文说明每个页面依赖哪些 capability、各角色能看到什么、以及现场报错时先查什么。构建与上线步骤见 `host-caddy.md` §E8.5（`docker compose build caddy`）。

## 路由（S3.14）

`lib/router.ts` 的 hash 路由，未匹配（含所有 S3.14 之前的旧 hash，如 `#/chats`）一律回落到 `#/work/chats`：

| 路径 | 页面 | 导航分组 |
|---|---|---|
| `#/work/chats[/<id>]` | 对话列表 / 对话 | 工作 |
| `#/work/tasks[/<id>]` | 任务 | 工作 |
| `#/work/approvals[/<id>]` | 待我审批 | 工作 |
| `#/me/agent` | 我的智能体（S3.13：模型/Skills/系统接入/Worker 定义/提示词附加/自动批准低风险，均为 Grant∩Policy 的子集投影，owner 可切换查看/编辑其他 principal） | 工作 |
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
| 系统接入（`/govern/systems`） | `list_connection_requests` `search{objectType:Gatekeeper}` `search{objectType:Operation}` `get_gatekeeper`（S3.11，健康与 Operation 详情） | `request_connection` `create_connection` `publish_manifest` `connect_gatekeeper`；接入向导（S3.12，`OnboardingWizard`）额外用 `propose_operation`+`publish_operation`（逐条 Operation 提议重分类，两步，不提供直接改的捷径） | 无 |
| 成员与授权（`/govern/members`） | `list_principals` | `create_principal` `set_principal_role` `rotate_api_key` `disable_principal` | 无 |
| 访问（`/govern/access`） | `list_grants` `list_principals`（填充成员下拉，无则退化为手填 id） | `grant_capability`（已有）`revoke_capability`（已有） | 无 |
| 能力目录（`/govern/catalog`） | `list_operations`（S3.11 新增）`list_skills` `list_procedures` `list_worker_definitions`（均已有） | `publish_operation`/`deprecate_operation`、`publish_skill`/`deprecate_skill`、`publish_procedure`/`deprecate_procedure`、`deprecate_worker_definition`（均已有——两步 propose/publish，控制台不提供"直接改分类"捷径） | 无 |
| 模型与配额（`/govern/models`） | `list_models` `get_agent_policy`（S3.13，member 可读）`list_quotas` `list_policies` | `set_agent_policy`（S3.13，owner——非 owner 只看只读摘要，不渲染可编辑表单） | 无 |
| 审计（`/govern/audit`） | `explain`（已有，member 可用）`reconstruct` `audit_query`（均已有，auditor） | 无 | 无 |
| 我的智能体（`/me/agent`） | `get_agent_profile{principalId?}` `get_agent_policy` `list_models` `list_skills` `list_gatekeepers` `list_worker_definitions` `list_principals`（owner 切换查看对象用） | `set_agent_profile`（member 改自己且 policy 允许；owner 改任何人） | 无 |
| 侧栏徽标 | `list_pending`（计数） | — | `action.pending` `action.updated` |
| 侧栏工作区名 + 角色徽标 | `get_workspace`（S3.11，`caller` 字段是角色的权威来源，S3.13 起启用） | — | 无 |

所有 HTTP 调用都是 `POST /api/cap/<name>`，`Authorization: Bearer <api key>`；WS 为 `/ws` JSON-RPC。API key 只存在 `sessionStorage`，关标签页即失效，"Forget key" 立即清除。

## 内核并行落地：`该能力尚未上线`

**S3.11（已合并——PR #100）**：成员与授权、访问、系统接入的 `get_gatekeeper`、能力目录的 `list_operations`、模型与配额的 `list_quotas`/`list_policies`、`get_workspace`（含 `caller` 字段）均已上线，本节以下内容仅作历史记录：这些 capability 曾由一条并行的内核 PR 实现，与 web 半针对同一份契约（`docs/development-tasks.md` §S3.11）各自开发；若内核尚未部署，调用返回 404 `not_found`，控制台用 `lib/errors.ts` 的 `isNotFoundError` 识别并展示"该能力尚未上线"空状态而不是报错或崩溃——这套识别逻辑仍在，只是现在几乎不会真的触发。

**S3.13（进行中）**：`get_agent_profile`/`set_agent_profile`/`get_agent_policy`/`set_agent_policy`（我的智能体、模型与配额页的 AgentPolicy 编辑器）由另一条并行的内核 PR 实现，与本 PR（web 半，`docs/development-tasks.md` §S3.13）针对同一份契约各自开发。同样的 `not_found` → "该能力尚未上线" 识别逻辑覆盖这四个新 capability；`AgentProfilePage` 的自查视图（不带 `principalId`）把 404 视为"未上线"，但 owner 切到别的 principal 查看时的 404 是真正的歧义（未上线 vs. 无此 principal），改渲染成普通错误横幅而不是"未上线"文案——见该组件自己的注释。两条 PR 合并、内核侧部署后，这些页面无需改动即可正常工作。

## 角色与可见性

`get_workspace` 现在把已解析的调用方回传（`caller: {id, role, displayName, kind}`，S3.11 的一次协调追加）——`hooks/useWorkspaceIdentity.ts` 把它当作**权威**角色来源，一旦这次读取 ready 就用 `{kind:'known', role}`。**下方描述的 403/200 推断现在只是 fallback**：`get_workspace` 尚未 ready、或返回 404（内核早于该字段上线）时才会用到。

按钮级别的可见性仍按**首次 403** 推断（与角色徽标独立，因为具体页面自身的 capability 调用永远是比粗粒度角色标签更精确的证据）：某个 capability 一旦返回 `forbidden`，本会话内它以及注册表里同一 `minRole`（及更高）的 capability 一并视为不可用（`hooks/usePermissions.tsx` 的 `deniedClosure`，按 `@nexttime/shared` 的 `CAPABILITY_REGISTRY` 派生），相关按钮隐藏或替换为说明。

S3.14 起的侧栏角色徽标与"治理"导航分组显隐：角色**已知**（`get_workspace.caller.role`）时徽标直接显示真实角色（复用成员页同一个 `StatusChip machine="role"`，与 owner/builder/operator/member/auditor 同一套色调）；角色仍是**推断**（`lib/role.ts` `inferRole`）时用尽力而为的正面推断——owner-minRole 的 capability 一旦调用成功 → 徽标显示 Owner；operator-minRole 的一旦被拒 → 徽标显示 Member 且"治理"分组隐藏（这是最强的反证：拒绝证明既非 operator 也非 owner）；operator-minRole 成功但尚无 owner-only 被拒的证据 → 显示 Operator+（诚实的区间，而非猜测）；两者都还没有证据 → 显示 "—"（未知）。无论已知还是推断，"治理"分组只在角色被证实为 `member` 时隐藏（`isProvenMember`）；其余情况下**默认展示**给所有人，具体页面按各自 capability 的 403 就地渲染"需要 owner/operator 权限"的说明。

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
| 接入向导第④步"提议重分类"提交后显示 `conflict`（409） | 该 Operation 是否已经 `publish_manifest`/`publish_operation` 发布 | 见"已知缺口"第 11 条——已发布的身份现在会开一条新修订草稿，不再 409；仍是 `origin:'import'` 且尚未发布的草稿再次 propose 依旧 409（I16，内核规则，不是 UI bug） |
| 我的智能体页保存后提示需要 owner 权限 | AgentPolicy 的 `memberCanEditProfile` | member 编辑自己的 AgentProfile 需要该策略开启；owner 可在"模型与配额"页调整 |
| 我的智能体页 autoApproveLow 勾选框被禁用 | AgentPolicy 的 `allowMemberAutoApproveLow` | 该策略关闭时，无论谁在编辑，这个字段都禁用并显示说明 |
| 浏览器反复弹证书警告（点过"继续访问"之后又出现） | 一次性把 Caddy 内部根证书导入客户端信任库：主机 `${NEXTTIME_DATA}/caddy/caddy/pki/authorities/local/root.crt` → Windows「受信任的根证书颁发机构」/ macOS 钥匙串 / Linux `update-ca-certificates` | Caddy 内部 CA 签的叶子证书会轮换（`deploy/caddy/Caddyfile` 已把默认 12h 调到 90 天，并把中间证书寿命从 7 天调到 100 天——不调中间证书时叶子寿命会被钳到 7 天；改 Caddyfile 后要 `docker compose restart caddy`），Chrome 的例外只绑定单张证书指纹，轮换即失效；导入根证书后不再出现 |

## 已知缺口（内核侧，控制台已就地绕过）

1. ~~没有"当前 principal 是谁 / 什么角色"的直接读取能力~~——S3.11 协调追加的 `get_workspace.caller` 填了这个缺口，`hooks/useWorkspaceIdentity.ts` 把它当权威来源；403/200 双向推断（见"角色与可见性"）现在只是该字段尚未 ready/未部署时的 fallback，不再是唯一来源。
2. ~~没有 principal 目录~~——S3.11 的 `list_principals` 填了这个缺口；`connect_gatekeeper`/`GrantCapabilityForm` 的成员下拉在该 capability 部署前仍退化为手填 id。
3. 没有列出已决定 ActionRequest 的能力（`list_pending` 只回 pending，`get_action` 按 id）——"All" 标签只包含本会话观察到的决定。
4. `search` 固定 50 条上限、无分页、无排序参数（Gatekeeper/Operation 的 `search` 路径——`get_gatekeeper`/`list_gatekeepers` 走另一条无此限制的路径，但同样要等 S3.11 内核 PR 部署）。
5. `approve` 没有 `reason` 参数（`reject` 有）——理由只随 Reject 提交。
6. 没有 Task → ActionRequest 的读取——"Linked approvals" 只能从 `list_pending` 按 `parentWorkerRunId` 反查 pending 的。
7. `action.pending` 推送的 `title`/`description` 仍由 `actionKind` 拼出（S2.11 已知偏离），`simulated` 恒为空。
8. `cancel_connection_request` 未交付（S2.13 已知偏离），控制台没有取消按钮。
9. `list_quotas`/`list_policies` 没有公开的行结构（`Policy`/`Quota` 在写侧都是 `set_policy{policy: jsonRecord}`/`set_quota{key,value}` 的不透明结构）——模型与配额页把 Quota 渲染成 key/value 表，Policy 渲染成脱敏后的 JSON 折叠块，不假设列名。
10. `export_prov` 未在审计页接入（范围外，留给后续任务）。
11. ~~（S3.12）接入向导第④步"提议重分类"对刚导入的 Operation 结构性地总是 409~~——**内核侧已修复（fix/operation-revision-via-propose）**：`propose_operation` 的冲突守卫（`governance/gatekeepers/manifest.ts` 的 `isOwnProposalDraft`）过去只允许替换**同一提议者**此前通过 `propose_operation` 自己写的草稿，向导审核页每一行都是 `origin:'import'` 的 Operation（`publish_manifest` 早已把它发布成 `published`），从不满足这个条件，一律撞上 `OperationIdentityConflictError`（HTTP 409 `conflict`）。现在 `propose_operation` 对一个**已发布**的身份会开一条新的修订草稿（`version = 已发布版本 + 1`，`draftOf` 指回已发布行；已发布行本身完全不动，`find_operations`/`list_allowed_operations`/门工具解析/`getPublishedOperation` 在修订发布前继续返回它），owner 再用既有的 `publish_operation` 二次调用发布这条修订草稿——**同一事务**内把旧版本转为 `deprecated`（除非它已经被单独弃用，那时跳过、不报错），发布 Activity 的 `metadata.supersedes` 记下被替换行的 id 供 audit/explain 查询；`list_operations`/`get_gatekeeper.operations` 继续展示完整版本历史（旧版本仍可见，只是 `status` 变成 `deprecated`）。若目标此刻仍是 `origin:'import'` 且尚未 `publish_manifest` 的草稿，`propose_operation` 仍然 409（该草稿不是提议者通过 `propose_operation` 自己写的，与 I16 一致，未变）。控制台一侧未改：按钮仍然调用真实的两个 capability，把内核的原话通过 `ErrorBanner` 显示出来，行为自动跟随内核修复而改善。详见 `governance/gatekeepers/manifest.ts` 模块级注释与 `manifest.test.ts`。
12. ~~（S3.12）目录页与接入向导都没有 Operation 调用/审批统计列~~——**已实现（feat/operation-stats-and-worker-definition-filter）**：`get_operation_stats{gatekeeperId?, days?}`（`connection` 组，`mode: observe`，`minRole: member`）注册在 `packages/shared/src/capabilities.ts`，`handler` 与 `list_operations` 同一模块（`gatekeeper-read-handlers.ts`）。返回 `{items: [{gatekeeperId, operationName, calls, approved, rejected, autoApproved, failed, lastCalledAt}]}`——**execute 类 Operation 专属**：四个分类计数来自 `action_requests` 的 `status` 列，按**当前**状态取（`governance/approval/reads.ts` 的 `getOperationStats`），不是"曾经历过"的累计决策历史；`calls` 是窗口内不限状态的总数。**observe 类 Operation（`<gate>.<op>`/`observe_operation`）未纳入**——`substrate/audit` 的 `queryAudit` 服务接口既无日期范围过滤也无 payload 路径分组，直接查 `audit_records` 表又违反该模块自己的边界（"其它模块不得直接查询其表"），扩展这个查询面超出本次范围；留作已记录的缺口而非编造近似值。`CatalogPage.tsx` 的 Operations tab 已去掉 TODO，加了调用/批准/拒绝/最近四列（独立于 `list_operations` 的 `useCapabilityList` 调用，取不到该 capability 或某一行没有匹配的 stats 时单独显示"—"，不拖垮整个列表）。
13. **（S3.13）`get_agent_profile`/`set_agent_profile`/`get_agent_policy`/`set_agent_policy` 均由并行内核 PR 落地**——见上文"内核并行落地"一节；控制台已按契约把 UI 编完，等待该 PR 合并部署。

## CI（Playwright）

`.github/workflows/e2e.yml`（新增工作流，与 `ci.yml` 完全分离，`ci.yml` 本身未改动）在每个 PR 和
推送到 `main` 时跑一遍本节 e2e 的一个子集——单个 job `web-e2e`：

1. checkout（pinned SHA，与 `ci.yml` 同一约定）、`pnpm/setup`（Node 22）、`pnpm install
   --frozen-lockfile`，`pnpm --filter @nexttime/web exec playwright install --with-deps
   chromium`。
2. 在 runner 自己的临时目录生成一份 `NEXTTIME_DATA`（`deploy/ci/env.ci.template` 套上这个路径写出
   `.env`），依次 `sudo` 跑 `scripts/host-bootstrap.sh` → `scripts/host-env-init.sh` →
   `scripts/gen-handle-keys.sh`（与真实主机部署同一套脚本，未做任何 CI 专用改写——只是加了
   `sudo`，因为这些脚本按设计把 `secrets/*.env`/`secrets/*.key` 写成 `0600`/`0640` 且 root 拥有，
   之后每一条 `docker compose` 调用因此也带 `sudo`），再把 `config/llm-providers.fake.example.yaml`
   复制成 `${NEXTTIME_DATA}/config/llm-providers.yaml` 并给 `secrets/llm-proxy.env` 追加
   `FAKE_LLM_API_KEY=fake`（与 `docs/runbooks/host-agent-host.md` §3 的手工步骤一致）。`.env` 里
   `AGENT_RUNTIME=fake`——见下方"为什么只需要三个常驻容器"。
3. `docker compose -f docker-compose.yml -f deploy/ci/docker-compose.ci.yml build kernel caddy
   llm-proxy`，然后一次性 `docker compose run --rm --no-deps llm-proxy node dist/cli/gen-models.js`
   （与 Makefile `gen-models` target 同一条命令，只是直接内联在工作流里而不经 `make`，见
   `deploy/ci/env.ci.template` 头部注释），把 `llm-providers.yaml` 里的 `fake`/`fake-echo` 投影成
   `models.json`，供治理页的模型列表用。
4. `docker compose ... up -d --wait postgres`，然后**先于 `kernel` 服务**跑
   `docker compose run --rm --no-deps kernel node dist/cli/migrate.js`。顺序是硬约束，不只是习惯：
   `kernel` 自己的启动流程有一个不带 try/catch 的 `await interruptStaleRunningTurns(...)`
   （`packages/kernel/src/index.ts` `BackgroundServices.start()` 第一行；`main()` 外层只把这个
   reject 打个日志，不重新抛出也不重试）——如果这时 `activities` 表还不存在，这一步直接抛错，
   紧跟其后的 `dispatcher.start()` 永远不会执行，`send_chat_message` 仍然返回成功（消息与 Turn
   行都建好了），但没有任何东西驱动这个 Turn 往下走，页面上的 Turn 会永远停在 `running`。第一次真
   实跑通这个工作流时踩到的坑——最初的版本是 `up -d --wait postgres kernel caddy` 在前、migrate
   在后，`chat.spec.ts` 因此稳定失败在"等 Turn completed"这一步。
5. `docker compose ... up -d --wait kernel caddy`（此时数据库已迁移完毕，`kernel` 的启动恢复扫描
   能正常跑完），再对 `https://127.0.0.1:8443/api/health` 轮询 `curl -sk`（caddy 是自签证书，
   Playwright 侧对应 `playwright.config.ts` 的 `use.ignoreHTTPSErrors: true`）直到 200——caddy 本身
   在 `docker-compose.yml` 里没有声明 `healthcheck:`，`--wait` 只能确认它在跑，这一步才是真正的就
   绪门槛。
6. `docker compose run --rm --no-deps kernel node dist/cli/bootstrap.js create-workspace --name
   ci-e2e --owner owner`（与 `scripts/accept_s1.sh` `bootstrap_step` 同一套输出解析）拿到一个
   owner API key（`::add-mask::` 遮蔽，日志里不出现）。
7. `WEB_E2E_BASE_URL=https://127.0.0.1:8443 WEB_E2E_API_KEY=<刚拿到的 key> corepack pnpm
   --filter @nexttime/web e2e`——只跑 `chat.spec.ts` 与 `governance.spec.ts`
   （`approvals.spec.ts` 的两个场景需要种子 ActionRequest 与第二个 principal，`WEB_E2E_
   SEED_ACTION_REQUESTS` 未设置时自动 skip，见该文件自己的注释）。`playwright.config.ts` 强制
   `workers: 1`——这几个 spec 共用同一个 kernel/Postgres，部分场景假设对服务端状态的独占访问
   （如"最近创建的那个 Chat"），跨文件并发跑没有意义，序列化换来的确定性比省下来的几秒钟值。
8. 失败时把 `packages/web/playwright-report/` 与 `packages/web/test-results/`（trace，
   `retain-on-failure`）当 artifact 上传；`docker compose ... down -v` 无论成败都执行。

**为什么只需要三个常驻容器（postgres/kernel/caddy）**：登录/对话/审批队列/治理四类页面全部经
`AGENT_RUNTIME=fake`（`packages/kernel/src/application/host-bridge/fake-runtime.ts`）在内核进程
内直接回显，从不经 agent-host/worker-supervisor/llm-proxy/egress-proxy/docker-socket-proxy 出站——
这正是 `.env.example` 里 `AGENT_RUNTIME=fake` 那条注释说的"跳过整条容器/pi 链路"，也是本工作流刻意
不起这些服务的原因（顺带绕开了 agent-host/worker-supervisor 需要的 docker-in-docker）。`llm-proxy`
只在第 3 步被一次性 `run`（生成 `models.json`），从不 `up`；`fake-llm` 干脆不建——`gen-models.js`
只本地解析 `llm-providers.yaml`，从不请求 `fake-llm`，而聊天走的是内核自己的 FakeAgentRuntime，同样
不请求它。

**耗时**：三个多阶段镜像各自 `pnpm install --frozen-lockfile` + 构建，runner 本地无跨次持久层缓存
（每次全新 VM）——预计几分钟量级；未接入 GitHub 的 Docker layer cache action（`docker compose
build` 走 compose 自身路径，没有直接的 `--cache-from/--cache-to type=gha`，需要额外的 buildx bake
接线，留作后续如果这几分钟成为瓶颈时再做）。

**目前不是必需检查**：`e2e.yml` 与 `ci.yml` 是两个独立工作流，仓库分支保护规则目前只列
`ci.yml` 的三个 job（`quality`/`test`/`guards`）为必需——`e2e / web-e2e` 想升级为必需检查，需要仓库
管理员在 GitHub 仓库设置的 branch protection 里手动把它加进必需状态检查列表（这个仓库里没有别的
地方能声明"必需"，它是 GitHub 项目设置，不是任何 workflow 文件的属性）。建议观察若干次运行确认不
flaky 后再升级。

**已知的不稳定来源**：docker 镜像构建时间随 runner 负载波动；`docker compose up --wait` 与
`/api/health` 轮询给了启动一定余量，但一个明显偏慢的 runner 仍可能需要放宽 job 的
`timeout-minutes`；`gen-models`/`bootstrap`/`migrate` 都是一次性 `docker compose run`，不依赖任何
定时任务或后台重试，失败即报错退出，不会静默重试掩盖问题。

**本地复现**：`deploy/ci/env.ci.template` 头部注释有完整命令；本质上就是上面 1-6 步去掉 checkout/
pnpm setup（本地已有）。

## 验证

```bash
corepack pnpm --filter @nexttime/web lint
corepack pnpm --filter @nexttime/web typecheck
corepack pnpm --filter @nexttime/web test
corepack pnpm --filter @nexttime/web build
# 有内核与浏览器时（README "End-to-end (Playwright)"）：
WEB_E2E_BASE_URL=... WEB_E2E_API_KEY=... corepack pnpm --filter @nexttime/web e2e
```
