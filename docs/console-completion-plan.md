# 控制台完善与推进方案（S6 候选，2026-09-18）

> 维护者 2026-09-18 首次以管理员身份完整使用控制台后提出七条问题，本文逐条给出**实际根因、类别、
> 方案与验收标准**，并排成可推进的波次。它是"完成与排序方案"，不是第二份管理面设计：模块语义仍以
> `platform-admin-design.md` §6.1–§6.7 为规范，本文只引用、不复述；工作区侧页面以
> `runbooks/web-console.md` 的路由与能力对照为准。凡本文提出的能力 / 页面，除非明确标注"已有"，
> 一律是**目标**，代码里尚不存在。占位符约定同全库：`<provider/model>`、`<TARGET_HOST>`。

## 1. 背景与目标

S5 收口后主机在 v0.13.2，内核 / 门 / 采集 / 审批的链路经三轮真实模型回归验证。控制台是这条链路的
人机界面，但它的完成度落后于内核：P-A1 / P-A2 / P-B1 / P-B2a 交付了用户、工作区、集成、门宿主四块
管理面，设计文档 §6 里的**模型与供应商、模块、运行层、运行状态**四块尚未开工（P-C / P-D），工作区
侧的对话 / 目录 / 审计三页只有"能用"的最小形态。维护者的观感"好多功能不完善"由三类事实叠加：

1. 页面没做（有能力、无界面）；
2. 内核没能力（界面做不了）；
3. 路线图未及（设计有、整块没有）。

目标：把这三类分开，每一条落到"改哪一层、验收标准是什么、排在哪一波"，让下一步可以直接开工。

## 2. 问题梳理表

| # | 观察到的 | 实际根因 | 类别 | 方案 |
|---|---|---|---|---|
| W1 | 对话历史没有删除键，只能不断新增 | 内核只有 `list_chats` / `new_chat` / `send_chat_message` / `get_chat_history` / `subscribe_chat`，没有归档或删除能力；`chat.title` 字段存在但从未写入，所以全是 "Untitled chat" | 内核缺能力 + 页面 | §5.1 |
| W2 | 对话里看不到当前模式 / 模型，也不能在管理区授予的模型里切换 | 模型由 AgentProfile（`/me/agent`）决定，对话页头部不显示生效模型；切换只能去"我的智能体"页；"管理区授予的范围" = 工作区 AgentPolicy 的 `allowedModels`（已有） | 页面未做 | §5.1 |
| W3 | 流式输出时右侧不自动跟随到最新 | 第二轮核对（§2b）**推翻**了"滚动容器写错"的假设：`.chat-scroll`（`pages.css:108-113`，`flex:1; min-height:0; overflow-y:auto`）就是真正滚动的元素，`scrollTop` 写入有效。新的假设：程序写 `scrollTop` 触发的 `scroll` 事件是**异步**的，若在它到达前又提交了一段流式文本 / 一行工具调用，`onScroll`（`ChatPage.tsx:183-190`）量到的"距底距离"就是这段新增高度，一旦超过 `AT_BOTTOM_THRESHOLD_PX = 48`（`:45`）便把 `atBottom` 翻成 false，跟随从此停止——快模型一帧内多行换行即可触发。第二个候选：滚动写入只由 `contentVersion`（`messages.length` / `streamingText.length` / `toolCalls.length`，`:168`）触发，**原地增长**的内容（工具调用行已存在、其结果文本后到，`toolCalls.length` 不变）根本不触发写入，同样表现为"不跟随"，无需竞争。两个候选的修法相同（底部哨兵 + `IntersectionObserver`，或忽略自己触发的 scroll 事件），复现要分别验证 | bug 待复现 | §5.1 |
| A1 | 工作区没有删除键，测试的、临时的删不掉 | 内核只有 `set_workspace_status`（禁用 / 启用）；"行不删"是 P-A1 的审计留痕取舍；一次性工作区靠 `delete-workspaces-matching.sh --expired` 操作员脚本 | 内核缺能力（受治理的清除） | §5.2 |
| A2 | 能力目录连 Skill 新增 / 编辑都没有 | `propose_skill` / `publish_skill` / `deprecate_skill`（Procedure、WorkerDefinition 同）都已有，页面只做了 Publish / Deprecate；草稿只能由 Worker 结果契约的 `proposedSkill` 或 CLI 产生 | 页面未做 | §5.3 |
| A3 | 模型与配额"硬编码了现有供应商"，没有供应商增删改查，至少要兼容 OpenAI 通用、Gemini、Claude、自定义兼容格式 | 没有硬编码：模型清单来自主机上的 `llm-providers.yaml`（`make gen-models` → `models.json`），页面是它的只读投影。平台级供应商管理是设计 §6.2（web → caddy `/api/llm-admin/*` → llm-proxy 管理端点，密钥只在 llm-proxy），属 P-D，未开工。llm-proxy 今天已支持 `openai-completions` / `openai-responses` / `anthropic-messages` 三种 API 与 `authorization` / `x-api-key` 两种鉴权头——OpenAI、Claude、DeepSeek、任何 OpenAI 兼容端点、Gemini 的 OpenAI 兼容端点都覆盖；Gemini 原生 API 需要新增一个适配器 | 路线图 P-D | §5.4 |
| A4 | 审计页只有 id 输入框，没有任何自动关联，像空壳 | `explain` / `reconstruct` / `audit_query` 三个能力都在，页面只做了"按 id 查"，没有从 Task / 审批 / Fact / Turn 详情跳过来的入口，也没有 actor / action 选择器和结构化结果 | 页面未做 | §5.5 |
| A5 | "图"页面一打开就报错 | 打开的是 `/explorer/` 的占位页 "Explorer bundle not built"：Explorer 是第三方静态包，要在主机上 `EXPLORER_BUILD=1` 构建 caddy 镜像才有；本部署没构建过（遗留 8 之后一直如此）。不是运行时错误 | 主机未构建 + 路线图 | §5.7 |
| A6 | 用户页一堆重复的、看不懂的用户和工作区；设计初衷是什么；怎么删 | User = 登录身份（P-A1），Principal = 工作区成员资格；迁移 0019 把每个 human Principal 回填成一个无密码用户（"待激活"），以便管理员设密码。每次跑 S1 / S2 / S3 验收都会新建工作区与 alice / bob / owner 成员 → 每轮多 2–3 个用户；33 个工作区里 30 个、53 个用户里 50 个是验收残留。没有清除能力 | 内核缺能力 + 验收脚本副作用 | §5.2 |
| A7 | 系统接入 / 集成两页到底怎么接 ssh、cli、API、其它系统 | 设计 §6.3 的三层（接入包 → 门实例 → 连接）已实现，但拆在两页（平台"集成"管实例与凭证，工作区"系统接入"管申请 / 连接 / 授权），两页互不引用，也没有按种类的指引：http / mcp 走门宿主实例（P-B2a，页面可建），ssh / cli 是带二进制 / 密钥的打包门，要 compose 服务 + 自注册，页面上没有说明 | 页面未做（引导） | §5.6 |
| B1 | 概览显示 Kernel 0.10.0（主机是 v0.13.2） | 版本来自 `KERNEL_VERSION` 环境变量（`platform-handlers.ts`），主机 `.env` / compose 没随发版更新 | bug | §5.8 |
| B2 | 审批页 Approve / Reject 高影响动作无二次确认；访问页 Revoke、集成页接入包三态切换即改即生效 | 项目已有"抽屉内两步确认"模式（停用用户 / 工作区 / 门实例都用），这三处没用 | 页面未做 | §5.8 |
| B3 | 访问 / 目录 / 系统接入 / 我的智能体显示裸 id（`principal 短id`、`gate 741e…`、Worker 定义 uuid） | `list_principals` / `list_gatekeepers` / `list_worker_definitions` 已在同页表单当下拉，没反过来把展示处的 id 换成名字 | 页面未做 | §5.8 |
| B4 | `work/*` 全英文，`govern/*` / `platform/*` 中英双语；时间戳美式英文 | 两批页面两套文案基线 | 页面未做 | §5.8 |
| B5 | 治理层列表硬顶 50 无分页，平台层已是 keyset "加载更多" | 两套列表成熟度 | 页面未做 | §5.8 |
| B6 | 11 处"该能力尚未上线"分支已是死代码（`ModelsPage` 4、`AgentProfilePage` 2、`lib/errors.ts` 1 等）；任务 / 访问 / 目录 / 模型 / 审计 / 平台设置 / 平台审计 / 我的智能体保存无 e2e（完整覆盖矩阵见 C22） | 代码卫生与覆盖 | 页面未做 | §5.8、§9 |
| B7 | 系统接入页已 `enabled · ok` 的门仍显示"启用"按钮；签发服务 Handle 的 TTL 默认 = 上限、能力名手填 | 页面未做 | §5.6、§5.8 |

### 2b. 第二轮核对（2026-09-18，代码级；维护者七条之外）

> 方法：对 `packages/web/src` 全量（工作区侧 + 治理侧 + 平台侧 + UI kit + libs + hooks）做只读代码审计，
> 每条都以 `file:line` 为证据、与 `packages/shared/src/capabilities.ts` 和内核 handler 交叉核对；同时核对
> `runbooks/web-console.md`"已知缺口"清单在当前代码里的真伪（第 3、4 条已闭合，runbook 已随本次改正）。
> 基线事实：web `tsc` 通过、46 个测试文件 268 个用例全绿；三态（加载 / 空 / 错误）覆盖完整；凭证与一次性密钥
> 的显示、清除、不落盘均正确；`X-Requested-With` CSRF 头在所有写调用上；无 `innerHTML` / `dangerouslySetInnerHTML`。
> 严重度：P1 = 功能不可达或数据错误；P2 = 明确缺陷、误导或必 403；P3 = 卫生、一致性、可达性。
> 复核层级：C1、C2、C9、C10、C21、C25–C29 与 W3 由主会话对照源码二次复核；其余各条为审计线"verified-in-code"
> 且引用了具体行号，开工前由实现者按行号再确认一次即可。

| # | 严重度 | 缺陷 | 证据 | 类别 | 方案 |
|---|---|---|---|---|---|
| C1 | **P1** | 我的账户页两处渲染都没传 `apiKey` / `onClaimed` / `onBound`：API key 登录后"设置密码"按钮永远禁用（`canSubmit` 要求 `apiKey`），cookie 登录后"绑定已有 API key"卡片永不出现（仅平台概览页在有待激活用户时才接了 `onKeyBound`）——登录页折叠项自己承诺的"用 key 登录后可在「我的账户」设置密码"是断的 | `App.tsx:436-452`、`:544-552`；`AccountPage.tsx`（`ClaimPasswordCard` / `BindApiKeyForm` 条件渲染）；`Session` 类型无 `apiKey` 字段 | bug | §5.8 |
| C2 | P2 | `useCapabilityList.loadMore` 把后续页 `mutate` 进缓存，但 `useCapability.run()`（任何 `reloadOn` 推送、`reload()`、`key` 变化都会触发）总是只取第一页并整体覆盖：用户翻过页后一次后台重载就把列表悄悄截回第一页 | `hooks/useCapability.ts:118-145` vs `:200-217` | bug（分页） | §5.8 |
| C3 | P2 | 审批页在 `pending.mutate(rows => …)` 的函数式更新器内部调用另一个 `setDecided(...)`，违反 React 更新器纯函数约定（StrictMode 下双次执行）；今天幂等所以不可见，但是隐患 | `ApprovalQueuePage.tsx:104-121`；`hooks/useResource.ts:72-74` | 代码卫生 | §5.8 |
| C4 | P3 | `AccountPage` 自定义 `LOGIN_PATTERN = /^[a-z0-9._-]{3,64}$/`，比内核 `normalizeLogin`（首字符须字母数字）宽松；`CreateUserForm` 正确引用了共享常量，此处没有；`invalid_login` 也没映射成友好文案 | `AccountPage.tsx:91` vs `lib/platform-errors.ts:80` vs `kernel/.../identity/users.ts:119` | 契约 | §5.8 |
| C5 | P3 | WS JSON-RPC 单次调用没有超时：内核收下请求但不回该 `id` 时，Approve / Reject / Send / Stop 的 `await` 永久挂起，只能刷新页面 | `lib/ws-client.ts:337-351` | ws | §5.8 |
| C6 | P3 | `ActiveSubscription.seenSequences` 每条消息加一项、从不修剪，长开的对话内存无界增长 | `lib/ws-client.ts:240-242`、`:401-408` | 性能 | §5.8 |
| C7 | P3 | 每次 `action.updated` / `task.updated` 推送同时触发单行刷新与全列表重载，同一事件两倍请求 | `ApprovalQueuePage.tsx:104-122`、`TasksPage.tsx:102-110` | 性能 | §5.8 |
| C8 | P3 | 对话内审批卡"总是允许"分支找不到对应 `system.action_pending` 消息时仍调用 `set_auto_approved_action_kind`，`actionKindTag` 为 `undefined`（推送先到、持久化消息未到时可触发） | `ChatPage.tsx:212-217` | bug（疑似） | §5.1 |
| C9 | P2 | 成员与授权、访问两页的 owner-only 写按钮（添加成员 / 服务凭证 / 授予能力 / 签发服务 Handle）对 **operator** 会话可见且可点，点了必 403：`canManage` 从 `create_principal` / `grant_capability` 是否被拒推断，而该拒绝只会在 `list_principals` / `list_grants`（minRole operator）403 时学到——operator 的读成功，闭包永不标记 | `MembersPage.tsx:54`、`AccessPage.tsx:50`；`capabilities.ts:1901/1318` vs `:1890/1423` | 权限（客户端） | §5.8 |
| C10 | P2 | 管理员停用**自己**时看到"最后一位活跃管理员不能停用"：内核对"不能停用自己"和"最后一位管理员"复用同一错误码 `last_admin`，客户端丢掉内核 `message` 只渲染固定文案 | `lib/platform-errors.ts:23-24`、`platform/PlatformError.tsx:21-22`；`kernel/.../gateway/platform-handlers.ts:408-409, 470` | bug（内核码 + 页面） | §5.8 |
| C11 | P2 | AgentPolicy 表单取消勾选当前默认模型后 `defaultModel` 不重置：`<select>` 绑定到一个已不在选项里的值并照样提交；同库 `CreateWorkspaceForm` 已有正确的回退守卫 | `AgentPolicyForm.tsx:126-178` vs `platform/CreateWorkspaceForm.tsx:44-49` | bug（校验） | §5.4 |
| C12 | P2 | 新建门宿主实例：http 类型的 "Manifest source" 标了必填、内核 `superRefine` 也真要求，但客户端 `ready` 不检查它，留空可点 Create，必 400 | `platform/CreateGateInstanceForm.tsx:46-48, 183-198` vs `capabilities.ts:2490-2503` | 校验 | §5.6 |
| C13 | P2 | 集成页门实例表格行 `onClick` / `onKeyDown` 却无 `tabIndex`、行内也没有按钮：键盘用户打不开任何门实例详情；同库 `WorkspaceRow` 明确提供了"配置"按钮作为键盘路径 | `platform/PlatformIntegrationsPage.tsx:410-477` vs `platform/PlatformWorkspacesPage.tsx:210-273` | 可达性 | §5.9 |
| C14 | P2 | 能力目录四个 tab 的发布 / 弃用失败只给通用 toast（`Could not update <name>`），内核真实错误被丢弃；同库其它写路径都用 `ErrorBanner` 显示原文 | `CatalogPage.tsx:162-165, 280-283, 364-367, 451-454` | 吞错 | §5.3 |
| C15 | P3 | 完成连接表单的 "Gatekeeper endpoint" 接受任意非空字串，不校验 URL；同表单 "Manifest source" 有正则校验 | `CompleteConnectionForm.tsx:198-214` vs `:96-98` | 校验 | §5.6 |
| C16 | P3 | `aria-describedby` 悬空：`describedBy(id, true, hasError)` 把 `hasHint` 写死为 true，而 `Field` 有错误时不渲染 hint，指向的 `-hint` id 不在 DOM | `CompleteConnectionForm.tsx:191, 210, 303`；`ui/Field.tsx:42-46` | 可达性 | §5.9 |
| C17 | P3 | `components/platform/` 下 6 个文件的状态 / 健康 / 模式芯片全部手拼 `chip chip-ok` 类名，零处引用 `ui/StatusChip`；`lib/status-tone.ts` 的机器联合体从未扩展到平台面枚举（用户状态、门实例状态、接入包模式、健康） | `PlatformUsersPage.tsx`、`UserDetailPanel.tsx`、`WorkspaceDetailPanel.tsx`、`GateInstanceDetailPanel.tsx`、`PlatformIntegrationsPage.tsx`、`lib/status-tone.ts` | 一致性 | §5.9 |
| C18 | P3 | `GatekeeperCard` 重写了 `isForbidden(err)` 而不引用 `lib/errors.ts` 的 `isForbiddenError`；今天靠 `session.http` 永远是 `HttpClient`（code 为字串）才成立，喂 WS 调用方（`RpcError.code` 是数字）即失效 | `RegisteredSystemsSection.tsx:239-246`；`lib/ws-client.ts:144` | 一致性 | §5.8 |
| C19 | P3 | 授予能力表单的 Scope 字段接受任何合法 JSON（`"foo"`、`42`）并原样提交，而 `GrantRow.scope` 处处按对象处理 | `GrantCapabilityForm.tsx:46-54` | 校验 | §5.8 |
| C20 | P3 | 访问页 principal 筛选在 `list_principals` 首次加载完成时从 `<Input>` 换成 `<Select>`，用户已输入的内容被丢弃 | `AccessPage.tsx:96-119` | UX | §5.8 |
| C21 | P2 | caddy 只发 `X-Content-Type-Options` / `X-Frame-Options` / `Referrer-Policy`，无 `Content-Security-Policy`、无 `Permissions-Policy`（HSTS 的缺席有注释说明是内部 CA 的有意取舍，不算缺陷）。SPA 今天没有任何外部加载，严格 CSP 可立即上；**设计含义**：§5.9 的字体必须随包自托管，不能走外部字体服务 | `deploy/caddy/Caddyfile:61-69`；`packages/web/index.html` | 安全加固 | §5.9、§7 |
| C22 | P3 | 单测缺失：`ChatPage`、`ChatListPage`、`TasksPage`、`TaskDetail`、`AuditPage`、`ActionRequestDetail`、`AppShell`、`WorkspaceDetailPanel`、`UserDetailPanel`、`GateInstanceDetailPanel`；e2e 在 B6 之外还缺我的账户、改密码、接入向导、侧栏 | `packages/web/src/components/**`（无对应 `*.test.tsx`）；`packages/web/e2e/*.spec.ts` | 覆盖 | §9 |
| C23 | P3 | `App.tsx` 673 行（路由 + 会话 + 连接状态机一体）、`ws-client.ts` 604 行；`index.ts` 残留 `console.log` | `packages/web/src/App.tsx`、`lib/ws-client.ts`、`index.ts` | 代码卫生 | §5.8 |
| C24 | P3 | `tokens.css` 没有字号 / 行高刻度令牌（只有字族），68 处手写 `px` 字号散在 `ui.css`（25）/ `pages.css`（22）/ `shell.css`（12）/ `base.css`（9）；1 处硬编码颜色 `#fff`（`ui.css:92`）。对比度实测达标（`--text-3` 对各面 ≥ 5.0:1） | `packages/web/src/styles/*.css` | 设计系统 | §5.9 |
| C25 | P2 | `approve` 没有 `reason` 参数（`reject` 有）：批准高影响动作时无法留下"为什么可以"，审计只有 actor 没有依据 | `capabilities.ts:1225-1231` vs `:1236-1242` | 内核缺能力 | §5.8、§6 |
| C26 | P3 | `cancel_connection_request` 不存在（S2.13 已知偏离仍开放），系统接入页的连接申请没有取消按钮 | `capabilities.ts`（无此名）；runbook 已知缺口 8 | 内核缺能力 | §5.6、§6 |
| C27 | P3 | `export_prov` 能力已注册，审计页只在注释里提到、从未接入 | `capabilities.ts:1849`；`AuditPage.tsx:29` | 页面未做 | §5.5 |
| C28 | P3 | `list_action_requests` 只按 `status` / `gatekeeperId` 过滤，没有 `taskId` / `parentWorkerRunId`：任务详情的"关联审批"仍只能从 `list_pending` 反查 pending 的，已决定的看不到（runbook 缺口 6 仍开放） | `kernel/.../gateway/handlers.ts:768-796`；`capabilities.ts:1272` | 内核缺参数 | §5.5、§6 |
| C29 | P3 | `list_quotas` / `list_policies` 没有公开行结构，模型与配额页只能把 Quota 渲成 key/value、Policy 渲成脱敏 JSON 折叠块（runbook 缺口 9 仍开放）；与 §5.4 的供应商页一起定型 | `ModelsPage.tsx`；runbook 已知缺口 9 | 契约 | §5.4 |

## 3. 现状与约束

- **三条设计底线不降级**：agent / kernel 进程不持凭证（供应商密钥只在 llm-proxy，门凭证只在门 / 门宿主）；
  触及有凭证、内部或有状态系统的动作必经审批；隔离与审计只增不减。本文所有"删除"都是受治理的能力，
  都留平台审计。
- **设计文档 §6 是规范**：§6.2 模型与供应商、§6.3 集成三层、§6.4 模块与 Skill、§6.5 运行层、§6.7 运行状态。
  本文不改它们的语义，只排序与补验收标准。
- **主机现状**：v0.13.2；一个生产工作区加 30 个验收残留工作区；Explorer 未构建；`KERNEL_VERSION` 过时；
  遗留 41–44 开放（`STATUS.md` §4）。
- **路线图**：STATUS §3 的顺序是 P-B2b → P-C → P-D。S6 插在 P-B2b 之前（维护者 2026-09-19 决定，§12 第 4 项）。
- **不做**：不引入新的前端框架或组件库；不做工作区级供应商配置（供应商永远是平台级）；不开放第三方
  pi extension；不做 SaaS 多租户。

## 4. 领域语义补充（只补缺的）

- **Chat 生命周期**：`active → archived`。归档只影响列表可见性，Chat / Turn / Decision / Fact 的溯源链
  （`explain(turn)`）继续可解析；物理删除只随工作区清除发生。`title` 在第一条用户消息落库时自动生成
  （截断），可改名。
- **Workspace 生命周期**：`active → disabled → purged`；`purpose = ephemeral` 的到期后可直接 `purged`。
  `purged` 是终态：行与级联数据删除，平台审计行保留（记录谁、何时、清了什么）。清除级联（顺序即依赖）：
  撤销并删除全部 CapabilityHandle → 删除 Task 与 `workspaces/tasks/<id>` 文件 → Chat / Turn / Activity /
  Decision / Conflict / Fact / Object / Source / Observation / Evidence → 工作区审计 → Principal → 工作区行。
  **两条从主机实战学来的边**：(a) 若存在 service Principal（采集器、外部运行时），清除前必须提示"该
  Handle 仍在被某个进程使用"（遗留 41 的来源：采集器 token 指向已禁用工作区 401 一周）；(b) 仅在被清除
  工作区有成员资格、且从未激活的 User 随之删除——这是"重复用户"的真正修法。
- **User 与 Principal**：User 是登录身份，Principal 是工作区成员资格，一个 User 对多个 Principal。"待激活"
  = 迁移 0019 回填或验收脚本创建、尚无密码的 User。验收脚本创建的 Principal 应带 `ephemeral` 标记，
  **不再回填 User**。
- **Provider（供应商）**：llm-proxy 内的资源（名称、API 种类、base URL、鉴权头、密钥、模型清单、启用），
  内核只持有它的只读投影（`list_platform_models`）；工作区 AgentPolicy 的 `allowedModels` 与 AgentProfile
  的 `model` 只能从平台投影里选。**模式**（entry / interactive / worker）是会话种类，不是可切换的用户选项；
  对话页只显示，不切换。
- **接入三层**：引用 §6.3，不复述。补一条状态语义：一个门实例的"可用"= `announce` 过 + 已启用 +
  健康 `ok`；页面上"启用"按钮只在 `discovered` 状态出现。

## 5. 目标方案（按模块）

### 5.1 对话（W1 / W2 / W3）

- **归档与改名**：新增 `archive_chat`、`unarchive_chat`、`rename_chat`（scope workspace，channel human，
  minRole member，仅本人的 Chat；owner 可归档他人）。列表默认隐藏已归档，带"已归档"筛选。第一条用户消息
  落库时自动写 `title`（前 40 字）。
- **模式与模型显示**：对话页头部显示"模式：入口 agent · 模型：`<provider/model>` · 来源：工作区默认 /
  我的覆盖"，数据来自 `get_agent_profile`（已有）。
- **在授予范围内切换模型**：头部下拉列出工作区 AgentPolicy 的 `allowedModels`（管理区配好并授予的），
  选择即调用 `set_agent_profile`（已有）；提示"下一轮生效"。**约束**：AgentProfile 变化会让常驻容器在下
  一轮 `/resident/spawn` 时重建——正是遗留 44 的竞争点。切换只能在**没有进行中 Turn** 时允许（按钮在
  Turn 进行中禁用），且遗留 44 修复前不做"对话中途切换"。
- **自动跟随**：先复现 W3——确认真正滚动的容器；修法是把对话区做成固定高度内部滚动容器或改用
  `IntersectionObserver` 判底。验收：流式输出中视口贴底时始终跟随；用户上滚后停止跟随并显示"跳到最新 N"。

### 5.2 工作区与用户治理（A1 / A6）

- **`purge_workspace`**（scope platform，管理员，目标）：前置条件 `status = disabled 且 disabled_at <
  now() - 7 天` 或 `purpose = ephemeral 且 expires_at < now()`（保留期与 ephemeral TTL 同一个 7 天；
  `workspaces` 今天只有 `status`、无 `disabled_at`，需一条迁移：`disable_workspace` 落时间戳，既有 `disabled`
  行回填 null 并视为立即可清——§12 第 3 项）；默认工作区拒绝（已有 `default_workspace` 护栏）；两步确认（复用抽屉确认模式），
  确认文案列出将删除的对象计数与"仍在使用的 service Handle"警告；执行 §4 的级联；写平台审计
  `platform.workspace_purged`（含计数）。`delete-workspaces-matching.sh` 改为调用这个能力而不是直接
  SQL，脚本与页面同一条路径。
- **`purge_user`**（scope platform，管理员，目标）：仅允许"从未激活且无活跃成员资格"的 User；批量选择；
  两步确认；平台审计。
- **列表默认过滤**：工作区页默认隐藏 `disabled` 与到期 `ephemeral`，加状态 / 用途筛选与排序，列表显示
  `purpose` / `expires_at`；用户页默认隐藏"待激活且成员资格全在禁用 / 一次性工作区"的用户，加"清理待
  激活用户"批量入口。
- **验收脚本不再污染平台**：`accept_s1/s2/s3.sh`、`demo.sh`、chaos 脚本只改"不造 User"，不做长期验收
  工作区（§12 第 5 项）。0019 的不变量不打破（human Principal 仍对应一个 User，`bootstrap.ts` 的
  `ensureUserForHumanPrincipal` 不动）：ephemeral 工作区里造出的 User 随工作区生灭——从未激活（无密码、无会话）
  且成员资格全在该工作区的 User 由 `purge_workspace` 级联删除，此前由用户页默认过滤藏起来。`audit_records.actor_user_id`、
  `user_sessions.user_id` 与 0021 的 `updated_by` 都引用 `users(id)` 且无 `on delete` 规则——这是护栏而不是障碍：
  从未激活的验收 User 没有这三类引用，可删；任何有引用的 User 内核拒删、留在默认过滤之外（审计只增不减），不需要
  新迁移。工作区本就是 `ephemeral` + TTL，到期由 `purge_workspace` 清。验收：跑一轮 S1–S3 后用户页默认视图不新增行；
  `purge_workspace --expired` 后 `users` 表回到基线、工作区页只剩生产工作区。

### 5.3 能力目录：Skill / Procedure / Worker 编辑器（A2）

- 三个 tab 各加"新建草稿"与"编辑（生成新草稿版本）"：Skill 用 `SKILL.md` 形态（frontmatter 表单 +
  Markdown 正文，§6.4 已定格式），Procedure / WorkerDefinition 用表单 + YAML 视图；提交即 `propose_*`
  （已有），草稿列表可 `publish_*` / `deprecate_*`（已有）。
- 草稿私有于提议者（I16 不变）；发布需 builder 以上。
- "从 git 仓库导入 Skill 集合"仍是 §6.4"之后"，不拉前。
- 验收：在页面新建一个 Skill 草稿并发布，`list_skills` 与"我的智能体"的可选 Skills 立即可见；e2e 覆盖。

### 5.4 模型与供应商（A3）——按设计 §6.2 落地，供应商是平台级

- **平台页"模型与供应商"（P-D 前移到 S6-B）**：列表 / 新增 / 编辑 / 停用供应商（名称、API 种类：
  OpenAI 兼容（completions / responses）、Anthropic messages；base URL；鉴权头；模型清单与显示名；启用），
  "测试调用"按钮，密钥**只写不读**（提交后只显示后 4 位）。
- **路径**：web → caddy `/api/llm-admin/*` → llm-proxy 管理端点；鉴权用内核签发的 5 分钟平台 JWT
  （新增内核能力 `issue_llm_admin_token`，scope platform，管理员）。llm-proxy 热加载并原地重写
  `models.json`；密钥落在 llm-proxy 自己的加密存储 / 密钥文件，**内核与数据库不存密钥**。
- **工作区侧只选不配**（已有）：AgentPolicy `allowedModels` 从平台投影里勾选；`set_allowed_models` 已有；
  对话页的切换（§5.1）只在这个范围内。
- **Gemini**：先用其 OpenAI 兼容端点接入（零改动）；原生 `generateContent` 适配器**不排期**（§12 第 2 项），
  触发条件是出现兼容端点表达不了的具体能力（原生 thinking 预算、上下文缓存之类），不是日期。
- 验收：在页面新增一个 OpenAI 兼容供应商并测试调用成功（"测试调用"含**一次工具调用往返**，不只补全——Worker
  与门工具都依赖它，"兼容零改动"要验过才算）→ 工作区"模型与配额"里能勾选它的模型 → 对话页头部能切到它 →
  `report-usage.sh` 里能按 provider / model 汇总。

### 5.5 审计：上下文关联（A4）

- 从 Task 详情、审批详情、对话里的 Fact / Decision 卡片、目录里的 Operation 加"查看溯源"链接，跳到审计页
  并预填 id、自动执行 `explain` / `reconstruct`。
- actor 用 `list_principals` 做选择器，action 用能力注册表做选择器，resource type 用枚举；结果按
  Activity / Observation / Source / Fact 结构化渲染（时间线 + 树），保留"原始 JSON"折叠。
- `audit_query` 加 keyset 分页（与平台审计页一致）。
- 验收：从一条已执行的审批出发，两次点击内看到 Fact → Activity → WorkerRun → Source 的链。

### 5.6 接入：一个"接入一个系统"入口（A7 / B7）

- 在工作区"系统接入"与平台"集成"两页各放同一个启动器"接入一个系统"，按接入包种类分支：
  - **http / mcp**：门宿主实例路径（已有 P-B2a）：平台侧建实例（目标地址、凭证模式、`vetted`，凭证**直接
    POST 到门宿主**，不经内核）→ 测试连接 → 工作区侧启用 → 导入清单 → 审核 Operation 分类 → 发布 →
    授予成员。向导五步已有，补的是从两页都能进入、以及实例与连接之间的互相链接。
  - **ssh / cli**：打包门，需要二进制与密钥，走 compose 服务 + 自注册。页面**不假装能建**：显示部署清单
    （compose 服务名、`GATE_ID`、密钥目录、启动后自动出现在"发现的门实例"），并在门 `announce` 后自动
    接上后续步骤。
  - **其它系统 / 模块化集成**：同 http（REST）或 mcp（MCP server）；领域包（本体 + Procedure + Worker 模板 +
    Skill）是 §6.4 的模块，不在接入范围。
- 状态一致性：`enabled` 的门不再显示"启用"按钮；服务 Handle 表单换能力选择器（按 Handle 通道可授予的
  能力过滤），TTL 默认 30 天、上限 365。
- 验收：一个新 MCP server 从"接入一个系统"点到入口 agent 可调用，不用改 compose；一个 ssh 门按清单部署后
  自动出现并可完成后续步骤。

### 5.7 图（A5）

- **立即可做（主机）**：`EXPLORER_BUILD=1 docker compose build caddy && docker compose up -d caddy`
  （构建时要拉外网，与今天源码构建撞 registry 的脆弱性相同）。
- **界面**：bundle 未构建时隐藏侧栏"图"入口（caddy 返回占位页可探测），而不是让用户点进去看占位说明。
- **已决定立项（2026-09-19，§12 第 1 项）**：原生"图谱"页——基于已有 `search` / `traverse` / `explain` 做
  对象浏览、邻居展开、Fact 溯源与新鲜度（`last_observed_at`）着色，替代第三方 bundle。鉴权其实已统一（W7
  #153 同源 cookie），收益是设计语言一致 + 去掉构建时拉外网；代价是一个中等规模的前端项目。维护者日常看图，
  值得做：S6-C 先构建 bundle 过渡，原生页单独成波次 S6-D（§10）。

### 5.8 横切（B1–B7）

- **版本号**：构建时把 git tag + commit 注入镜像（构建参数 → 环境变量），概览显示 `v0.13.2 (0fa5a1e)`；
  `.env` 里不再手工维护 `KERNEL_VERSION`。
- **确认态**：Approve（`blast_radius = high`）、Reject、Revoke、接入包三态切换、Cancel task 一律复用抽屉
  两步确认；Approve 高影响时确认文案列出目标资源。`approve.reason`：`blast_radius = high` **必填**、中低可选，
  理由进审计（§12 第 6 项）；在**内核**强制（`approve` 今天只收 `actionRequestId`，加 `reason?` 参数，高影响缺省
  400），只做前端校验会被 API 调用者绕过。今天的 S2 / S3 不受影响：包装门的 `high` 只来自 http 门 `delete`
  动词默认值与 ssh 分类规则，accept-s2 的两个 manifest 都是 low / medium，S3 不走审批；新接带 `delete` 的
  http 门时验收 driver 要传 reason。
- **id → 名称**：统一一个 `<PrincipalName>` / `<GatekeeperName>` / `<WorkerDefinitionName>` 展示组件
  （名字 + `CopyId`），用已有的 list 能力做客户端映射；访问、系统接入、目录、我的智能体全部替换。
- **语言与格式**：`work/*` 与 `govern/*`、`platform/*` 统一为中英双语文案；时间戳统一走 `formatRelative` +
  `formatDateTime`（已有）并用浏览器区域设置。
- **分页**：访问 / 系统接入 / 目录三页改为 keyset "加载更多"（平台层已有的 `useCapabilityList`）。
- **代码卫生**：删除"该能力尚未上线"死分支与过时注释；`App.tsx` 拆出路由表与会话状态机（C23）；去掉
  `index.ts` 的 `console.log`。
- **第二轮核对的修法（C 系列，按文件归组，一个文件一个 PR）**：
  - `App.tsx` + `Session` 类型：`Session` 加 `apiKey`（`connectApiKey` 时捕获），两处 `<AccountPage>` 传
    `apiKey` / `onClaimed`（复用 `proceedAfterCookieAuth`）/ `onBound={handleKeyBound}`（C1，P1，先修）。
  - `hooks/useCapability.ts`：`run()` 重载时按"用户已加载的条数"重取或合并保留后续页，不再截回第一页（C2）。
  - `ApprovalQueuePage.tsx` / `TasksPage.tsx`：`setDecided` 移出 `mutate` 更新器（C3）；推送后只做单行刷新，
    去掉冗余的全列表重载（C7）。
  - `AccountPage.tsx`：引用 `lib/platform-errors.ts` 的 `LOGIN_PATTERN`，映射 `invalid_login`（C4）。
  - `lib/ws-client.ts`：`rpc()` 加可配置的单次调用超时（默认 30s，超时即 reject 并记录）（C5）；
    `seenSequences` 在 `onCaughtUp` 后退化为 `sequence > lastSeenSequence` 判断或定期修剪（C6）。
  - `ChatPage.tsx`：`alwaysAllow` 找不到卡片时跳过调用并 toast（C8）。
  - `MembersPage.tsx` / `AccessPage.tsx`：`canManage` 改用 `useWorkspaceIdentity` 的权威角色（`get_workspace.caller.role`），
    403 推断只作 fallback（C9，与 runbook"角色与可见性"的既定方向一致）。
  - 内核 `platform-handlers.ts` 把"不能停用自己"拆成独立错误码 `self_disable`；`platform-errors.ts` /
    `PlatformError.tsx` 对已映射码也保留内核 `message` 作为副文案（C10）。
  - `AgentPolicyForm.tsx` 镜像 `CreateWorkspaceForm` 的默认模型回退守卫（C11）。
  - `CreateGateInstanceForm.tsx` 的 `ready` 加 http 必填 manifestSource（C12）；`CompleteConnectionForm.tsx` 的
    endpoint 复用 URL 正则（C15）、`describedBy` 的 `hasHint` 按是否真的渲染 hint 传（C16）。
  - `CatalogPage.tsx` 四处 toast 带 `describeError(err).message` 或改 `ErrorBanner`（C14）。
  - `RegisteredSystemsSection.tsx` 引用 `isForbiddenError`（C18）；`GrantCapabilityForm.tsx` 拒绝非对象 JSON（C19）；
    `AccessPage.tsx` 的筛选控件不再中途换类型（C20）。

### 5.9 视觉与交互体系（设计基线，已定稿）

维护者 2026-09-18 审阅重设计 v1 原型后定稿："起码要这样的水准"。原型（十块画板 + 设计系统板，链接在
`docs/private/console-redesign-2026-09-18.md`）是本节的**验收基线**：S6 之后的每个页面改动都对照它，不对照
现状。本节把原型翻译成可实现的规则；实现细节随 S6-A0 落到 `packages/web/src/styles/tokens.css` 与 `ui/*`。

**对现状的批评（定稿依据）**：页面没有主次，卡片、表格、按钮同一层灰，主次操作同色同重；治理语义没有颜色系统，
待审批 / 已执行 / 拒绝 / 归档靠读字区分；裸 uuid 到处出现；破坏性操作与普通按钮长得一样、不分级；系统字体加低对比
深色，中英与等宽混排没有节奏；导航把使用 / 治理 / 平台混排，看不出"我在哪一层"。做对的：三层信息架构与 hash 路由
本身正确；`tokens.css` 已有语义命名与浅色主题（`prefers-color-scheme: light`），只是没被用来表达层级；三态覆盖完整；
`Drawer` 的焦点陷阱 / Escape / 焦点回归正确。

**原则**（每条都可检查）：
1. 中性底面只承载内容；**蓝色只用于"可以点"**（链接、选中、提交）；每页只有一个 ink 主按钮。
2. **治理语义色固定映射、一色一义、不得借作装饰**：观察 observe（青）/ 执行 · 待审批 · warn 模式 · 中影响（琥珀）/
   高影响 · 不可逆 · reject 模式 · 冲突 · 失败 · 清除（红）/ 已执行 · 已发布 · 健康（绿）/ 系统 · 提案 · 生产 · 默认标记
   （蓝）/ 归档 · 被替代 · 验收残留 · 未测试（灰）。色点与图标必须配文字，不能只靠颜色。
3. **id 永不裸露**：名称 + 类型 + 截断 id + 复制；点击进入对象页；找不到名称才回退灰色裸 id（即 B3 的组件）。
4. **确认按影响分级**（同一模式用于 ActionRequest 审批、工作区 / 用户清除、Handle 吊销、供应商密钥覆盖）：
   低 · 可逆 → 直接执行 + Toast 撤销；中 · 可逆 → 对话内审批卡一键批准，显示目标 / 参数 / 代表者；高 · 可逆 → 进审批页，
   列影响范围，确认对话框；**不可逆 → 键入目标名称 + 勾选知情项，危险实心按钮在此之前禁用，写平台审计**。
5. 层级用 1px 边框，不用阴影（抽屉除外）；圆角 6（chip）/ 8（控件）/ 12（卡片）；间距 4 / 8 / 12 / 16 / 24 / 32。
6. 最小点击高 36px，触屏 44px；文字对比 ≥ 4.5:1；所有行级操作有键盘路径（C13 的反例不再出现）。

**令牌（映射到现有 `tokens.css`，不改名、只改值与补缺）**：
- 浅色成为默认，深色改为 `prefers-color-scheme: dark` 覆盖（今天相反）；两套沿同一令牌名，不新增语义。
- 中性：`--bg #f4f5f7`、`--surface-1 #ffffff`、`--surface-2 #f8f9fb`、`--border #e3e6ea`、`--border-strong #cfd4da`、
  `--text #12161c`、`--text-2 #4b5563`、`--text-3 #6b7280`（对白底 4.7:1）。
- 强调：`--accent #1f4fd6`（对白底 6.3:1）、`--accent-soft #e8eefc`；主按钮用 `--text`（ink），不用强调色。
- 语义：`--ok #157347 / --ok-soft #e3f5ea`、`--warn #b45309 / --warn-soft #fdf1e3`、`--danger #b42318 / --danger-soft #fde8e6`、
  `--info #1f4fd6 / --info-soft #e8eefc`；**新增** `--observe #0f766e / --observe-soft #e0f2f1`、`--muted #6b7280 / --muted-soft #f0f1f3`。
- **新增字号 / 行高刻度**（C24 的修法）：`--fs-11 --fs-12 --fs-13 --fs-14 --fs-16 --fs-19 --fs-24`，`--lh-tight 1.3`、
  `--lh-body 1.6`；`ui.css` / `pages.css` / `shell.css` / `base.css` 的 68 处手写字号全部换令牌，`ui.css:92` 的 `#fff` 换
  `--text-on-accent`。
- 字体：`--font-sans: "IBM Plex Sans", "Noto Sans SC", system-ui, …`、`--font-mono: "IBM Plex Mono", ui-monospace, …`；
  **随包自托管**（`packages/web/public/fonts/*.woff2` + `@font-face`，Noto Sans SC 只带常用字子集），不引用外部字体服务——
  这是 C21 严格 CSP 与无外网主机的共同要求。

**组件（`ui/*` 的增补；现有组件不改 API 只改样式）**：
- `RefChip`（= §5.8 的 id → 名称组件）：Principal / Gatekeeper / WorkerDefinition / Object / ActionRequest 五种引用，
  名称 + 类型 + 截断 id + `CopyId`。
- `StatusChip` 扩到平台面枚举（用户状态、门实例状态、接入包模式、健康、Publishable 已有）——即 C17 的修法；
  `lib/status-tone.ts` 的机器联合体加这些机器，`components/platform/` 的手拼 chip 全部替换。
- `ConfirmTier`：分级确认的统一实现（tier = low / medium / high / irreversible），不可逆档内含"键入名称 + 知情勾选"，
  取代 B2 提到的散落两步确认。
- `ApprovalCard`：对话内与审批页共用同一张卡（能力、目标、代表者、策略、影响面、批准 / 拒绝 / 总是允许、"在审批页打开"）。
- `ProvenanceChain`：Fact → Activity → Source 三段时间线 + 原始证据折叠（§5.5 的结构化渲染）。
- `Launcher`：四步接入启动器（选类型 → 连接与凭证 → 能力与策略 → 握手验证），§5.6 两页共用。
- `FollowPill`："跟随最新输出 · N 条新消息"（W3 修法的可见部分）。

**壳与导航**：侧栏三组带分组标签（使用 / 治理 / 平台，成员可见性沿 runbook"角色与可见性"），顶部工作区切换器，
底部连接状态 + **真实版本号**（B1）+ 当前用户；页头统一"面包屑小字 + 标题 + 一句话说明 + 右侧主操作"。

**页面对照原型**：控制塔（平台概览：待处理 / 运行中 / 图谱新鲜度 / 费用四指标、需要人处理列表、服务健康、最近发生、
首次运行清单、验收残留横幅）；对话（列表带归档筛选与状态副标题、头部模式 + 模型下拉、消息流内审批卡、FollowPill、
执行类动作提示）；待我审批（队列 + 详情、影响范围来自图谱、不可逆确认）；工作区（默认隐藏残留、用途 / 来源列、清除抽屉
含级联计数与 Handle 警告）；系统接入（已接入系统卡片 + Launcher）；审计（对象 / 关系筛选芯片、ProvenanceChain、冲突复核、
结构化审计流）；模型与供应商（供应商表 + 添加抽屉 + 工作区可选模型矩阵）；能力目录（Skill 编辑器：frontmatter 表单 +
正文 + 生命周期）。用户页复用工作区页的筛选与清除模式；图页按 §5.7 处理。

**验收**：对照原型逐页走查；`tokens.css` 之外零硬编码颜色与字号（lint 规则：biome 自定义或 stylelint 只拦 `styles/`）；
键盘可达每个行级操作；axe 无严重项；严格 CSP 下页面无违规（C21）。

## 6. 能力 / API 设计（全部为目标，标"已有"者除外）

| 能力 | scope · channel · minRole | 语义 | 审计动作 | 前置 / 护栏 |
|---|---|---|---|---|
| `archive_chat` / `unarchive_chat` | workspace · human · member | Chat `active ↔ archived`，仅可见性 | `chat.archive` / `chat.unarchive` | 本人的 Chat；owner 可归档他人 |
| `rename_chat` | workspace · human · member | 改 `title` | `chat.rename` | 本人的 Chat |
| `set_agent_profile`（已有） | workspace · human · member | 对话页切模型复用 | 已有 | 只能选 AgentPolicy `allowedModels`；无进行中 Turn |
| `purge_workspace` | platform · human · admin | 级联删除（§4）+ 平台审计保留 | `platform.workspace_purged` | disabled 或到期 ephemeral；非默认工作区；两步确认；service Handle 警告 |
| `purge_user` | platform · human · admin | 删除从未激活且无活跃成员资格的 User | `platform.user_purged` | 批量；两步确认 |
| `propose_skill` / `publish_skill`（已有）等六个 | workspace · human · builder | 编辑器复用 | 已有 | 草稿私有（I16） |
| `issue_llm_admin_token` | platform · human · admin | 签发 5 分钟平台 JWT 给 `/api/llm-admin/*` | `platform.llm_admin_token_issued` | 仅管理员；短期；只用于 llm-proxy 管理端点 |
| llm-proxy `/api/llm-admin/providers` CRUD、`/providers/:id/test`、`/providers/:id/secret`（只写） | llm-proxy 内部，经 caddy | 供应商增删改查、测试、密钥写入、热加载 | llm-proxy 自己的审计日志 + 内核平台审计一行（不含密钥） | 密钥不进内核 / 数据库 |
| `explain` / `reconstruct` / `audit_query`（已有） | workspace · human · member / auditor | 审计页上下文入口复用 | 已有 | `audit_query` 加 keyset 分页 |
| `export_prov`（已有，未接） | workspace · human · auditor | 审计页"导出"按钮 | 已有 | 只导出当前筛选范围（C27） |
| `approve{actionRequestId, reason?}` | workspace · human · operator | `approve` 加可选 `reason`；`blast_radius = high` 时前端要求必填 | 已有动作，审计行加 `reason` | 与 `reject` 对称（C25） |
| `list_action_requests{…, taskId?, parentWorkerRunId?}` | workspace · human · operator | 加两个过滤参数，任务详情"关联审批"改用它 | 已有 | I14 可见性不变（C28） |
| `cancel_connection_request` | workspace · human · member（本人）/ owner | ConnectionRequest `requested → cancelled` | `connection.request_cancelled` | 仅 `requested` 状态可取消（C26） |
| 平台错误码 `self_disable` | platform · human · admin | 从 `last_admin` 拆出"不能停用自己" | 无新增审计 | 客户端保留内核 `message`（C10） |

线上契约：每个新能力进 `packages/shared/src/capabilities.ts` 与 wire schema，`pnpm contract:check` 快照
随之更新；`tasks.result` 类已有 `unknown` 字段不动。

## 7. 权限与安全

- 供应商密钥、门凭证的流向不变：浏览器 → caddy → llm-proxy / 门宿主，内核只签短期 JWT；密钥只写不读。
- 清除类能力只在 platform scope、管理员、两步确认、平台审计保留；工作区 owner 没有清除权（只能禁用）。
- 归档不改变可见性策略以外的任何东西；溯源链不被切断。
- 对话页的模型切换受 AgentPolicy 约束，与"我的智能体"页同一条路径，不新开口子。
- **传输层加固（C21）**：caddy 加 `Content-Security-Policy`（`default-src 'self'; connect-src 'self' wss:; img-src 'self'
  data:; font-src 'self'; style-src 'self' 'unsafe-inline'`——内联样式仅因 UI kit 现状，S6-A0 后收紧为 `'self'`）与
  `Permissions-Policy`（关闭摄像头 / 麦克风 / 地理位置等）；HSTS 维持现状与现有注释。Explorer 占位与 `/api/*`
  反代不受影响。
- 客户端角色判断只做展示收窄，权限由内核 `minRole` 与 I14 决定不变；C9 的修法是让展示与权威角色一致，不是放宽。

## 8. 观测与审计

- 新增审计动作见 §6；`purge_workspace` 的审计行含被删对象计数与执行者。
- 新增不变量候选：I-S6-1 "已清除工作区不应残留任何 CapabilityHandle / Task 文件目录"（清除后校验）。
- 采集器与外部运行时的连续 401 / 非零错误进 `/internal/metrics`（遗留 41 的后半）。

## 9. 验证

- 每个新能力：单测 + DB-gated 集成测试；每个改动页面：e2e（补齐今天零覆盖的任务 / 访问 / 目录 / 模型 /
  审计 / 平台设置 / 平台审计 / 我的智能体保存）。
- 验收脚本改造后：一轮 S1–S3 不新增 User；`purge_workspace --expired` 后只剩生产工作区。
- 主机验收：按 §5 各节的验收句逐条做，结果记 `docs/private/`，纯计数进 STATUS。
- 供应商页：新增一个 OpenAI 兼容供应商 → 工作区勾选 → 对话切换 → `report-usage.sh` 按 provider 汇总。
- **第二轮核对项**：C1 用 API key 登录后在我的账户页设密码成功、cookie 登录后能绑定 API key（e2e）；C2 翻两页后触发
  一次推送，行数不减（`useCapability.test.tsx`）；C9 以 operator 登录，成员 / 访问页不出现 owner 按钮（e2e）；C10 非唯一
  管理员停用自己看到"不能停用自己"（集成测试 + e2e）；C12 / C15 / C19 客户端拦住并给出字段级说明；C5 用不回包的
  `WebSocketLike` 桩验证超时 reject；W3 用 Playwright 复现两种情形后再修：(a) 每 10ms 一段、每段两行的假流式（异步 scroll 事件竞争）；(b) 一条工具调用行先出现、其结果文本随后原地增长且 `toolCalls.length` 不变（不触发滚动写入）。
- **覆盖补齐（C22）**：`ChatPage` / `ChatListPage` / `TasksPage` / `TaskDetail` / `AuditPage` / `ActionRequestDetail` /
  `AppShell` / 三个平台详情面板补单测；我的账户 / 改密码 / 接入向导 / 侧栏补 e2e。
- **设计基线（§5.9）**：每个改动页面对照原型走查并截图入 `docs/private/`；`styles/` 令牌 lint 零违规；axe 无严重项；
  严格 CSP 下 e2e 全绿。

## 10. 路线图与波次

| 波次 | 内容 | 关闭 | 依赖 |
|---|---|---|---|
| **S6-A0 视觉体系落地 + 紧急修复** | §5.9 令牌（浅色默认、字号刻度、语义色补缺、字体自托管）与 `ui/*` 增补（`RefChip` / `StatusChip` 平台机器 / `ConfirmTier` / `ApprovalCard` / `ProvenanceChain` / `FollowPill`）、壳与导航、真实版本号；caddy CSP / Permissions-Policy；C1（P1）与 C2 / C3 / C9 / C10 / C11 / C12 / C14 六条 P2 的文件级修复；W3 复现 | B1、B2（模式）、B3（组件）、C1–C3、C9–C14、C16–C21、C24 | 无。**先于一切页面改动**：后续波次的页面都在新令牌与新组件上写，避免改两遍 |
| **S6-A 控制台闭环** | §5.8 全部；§5.1（归档 / 改名 / 自动标题 / 头部显示 + 范围内切换、W3 修复、C8）；§5.2（`purge_workspace` / `purge_user` / 默认过滤 / 验收脚本不造用户）；§5.3 编辑器；§5.5 审计上下文 + `export_prov` + `list_action_requests` 任务过滤；`approve.reason`；C4–C7、C15、C18–C20、C22、C23、C25、C27、C28 | B4–B7、W1–W3、A1 / A2 / A4 / A6、遗留 41 的前半、C 系列剩余 | S6-A0；遗留 44 先修（对话中途切换依赖它），否则切换只在 Turn 间 |
| **S6-B 模型与供应商** | §5.4：llm-proxy 管理端点 + `issue_llm_admin_token` + 平台页；工作区只选不配；C29 定型 Quota / Policy 行结构 | A3、C29 | S6-A0（可与 S6-A 并行，文件互斥） |
| **S6-C 接入与图** | §5.6 启动器与状态一致性 + `cancel_connection_request`；§5.7 主机构建 Explorer bundle（过渡）+ 隐藏入口 | A7、B7、C26、A5（过渡） | S6-A0 的 `RefChip` / `Launcher` |
| **S6-D 原生图谱页** | §5.7：基于 `search` / `traverse` / `explain` 的对象浏览、邻居展开、Fact 溯源与新鲜度着色，替代第三方 bundle；中等规模前端项目 | A5（收尾） | S6-A0 的 `RefChip` / `ProvenanceChain`；S6-C 的 bundle 先行 |
| 之后 | P-B2b → P-C（运行层、运行状态）→ P-D（模块、供应商剩余项）按 STATUS 原顺序 | 设计 §6.4 / §6.5 / §6.7 | — |

波次顺序（维护者 2026-09-19 取定，§12 第 4 项）：S6-A0 → 遗留 44（内核 / supervisor 侧，独立 PR，S6-A 的对话中途
切换依赖它）→ S6-A ∥ S6-B（文件互斥车道，与 W9–W11 同一模式）→ S6-C → S6-D；整个 S6 在 P-B2b 之前。

优先级判断：C1 是唯一的 P1（两条登录后流程不可达），单独一个小 PR 先修，不等波次。S6-A0 放在最前是因为维护者已把
视觉水准定为验收基线，页面若先在旧令牌上改会全部重做一遍。S6-A 里 B2（确认态）与 B1（版本）随 S6-A0 的组件落地；
A6 / A1（残留治理）是维护者每天都会看到的，排 S6-A 第一；其余 P2。S6-B 是维护者最在意的能力缺口，但它是新的服务面
（llm-proxy 管理端点 + JWT），单独成波次更稳。

## 11. 最小当前版本（S6-A0 + S6-A 第一波要交付的闭环）

0. C1 修复合入（我的账户页两条流程可用）；新令牌 + `RefChip` / `StatusChip` / `ConfirmTier` 上线，侧栏三组 +
   真实版本号，caddy 严格 CSP 通过 e2e。
1. 概览显示真实版本；审批 / 撤销 / 接入包切换有确认；四处 id 换名字。
2. 对话：归档 + 自动标题 + 头部显示模式与模型 + 在授予范围内切换（Turn 间）；W3 复现并修。
3. 工作区页 / 用户页默认过滤 + `purge_workspace` / `purge_user` + 验收脚本不再造用户；主机上把 30 个
   验收工作区清掉，用户页只剩真实用户。
4. 目录三个 tab 可新建 / 编辑草稿并发布。
5. 审计页从 Task / 审批 / Fact 一键进入。
验收标准：维护者在主机控制台走一遍 §5 各节的验收句全部成立；e2e 覆盖到每个改动页面。

## 12. 维护者决定（2026-09-19 取定）

七项于 2026-09-19 全部取定：1 / 3 / 4 / 7 由维护者拍板，2 / 5 / 6 按建议缺省取定。每项的落点已回写到 §3 / §5 / §10
对应位置，这里只记结论与理由。三处是记录者按维护者答复推断的落点、维护者可在 PR 里否决：1 的"立项 + S6-D 单独波次"
（维护者只答了"日常看图"）、5 的实现路径（保持 0019 不变量而不是"不回填 User"）、7 的实现形状留给 S6-A0。

1. **Explorer：立项原生图谱页。** 维护者日常看图；S6-C 先构建第三方 bundle 过渡，原生页作为 S6-D 单独成波次。
   bundle 未构建时隐藏侧栏入口，与此决定无关、无论如何都做。（§5.7、§10）
2. **Gemini：原生适配器不排期。** 先走 OpenAI 兼容端点；触发条件是出现兼容端点表达不了的具体能力，不是日期。
   S6-B 的"测试调用"验收含一次工具调用往返。（§5.4）
3. **`purge_workspace` 保留期：禁用满 7 天可清**（与 ephemeral TTL 同一个 7 天）。需一条迁移加 `workspaces.disabled_at`；
   **既有 `disabled` 行回填 null、视为立即可清**——主机上的 30 个验收残留工作区不再等一周。（§5.2、§11 第 3 条）
4. **顺序：S6-A0 → 遗留 44 → S6-A ∥ S6-B → S6-C → S6-D；S6 在 P-B2b 之前。** 理由：控制台是维护者每天要用的面；
   遗留 44 是 S6-A 对话中途切换的硬前置。（§3、§10）
5. **验收脚本：只改"不造 User"，不做长期验收工作区。** 遗留 41 正是跨运行共享状态的事故，S5.3 把工作区改成
   ephemeral + TTL 就是为了杜绝它；S2 / S3 的新鲜度与异源 Conflict 断言也假设图是新的。实现上**不打破 0019 不变量**
   （human Principal 仍对应 User），而是让 ephemeral 工作区的 User 随工作区被 `purge_workspace` 级联清除。（§5.2）
6. **`approve.reason`：高影响必填、中低可选，内核强制，理由进审计。** `blast_radius` 在 ActionRequest 上总有值
   （`request-action-handler` 非空）；accept-s2 的两个 manifest 是 low / medium、S3 不走审批，验收 driver 暂不用改。（§5.8）
7. **字体：接受方案缺省——常用 3500 字子集 + 按需回退系统字体，首屏约 600 KB（一次缓存）。** 内网控制台，体积
   不是问题。实施者注：子集外字符会在同一行里换字形，S6-A0 若觉得明显，可在同一预算内改用 unicode-range 切片，
   字重数一并在实施时定，不另行征求。（§5.9）

**仍待维护者确认（09-19 未答，影响 S6-B 范围）**：管理员在控制台写供应商密钥（§5.4，web → caddy → llm-proxy
管理端点，管理员角色 + 5 分钟 JWT + 平台审计）是否属于底线"触及有凭证系统的动作必经审批"。并行方案隐含"不过审批、
走角色 + JWT + 审计"；若答"要过审批"，S6-B 加审批流、范围重估，与 S6-A 并行与否也要重看。

已定稿（不再征求）：视觉基线按 v1 原型（§5.9），浅色默认、深色覆盖；治理语义色六类固定映射；确认按影响四档分级。
