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
| W3 | 流式输出时右侧不自动跟随到最新 | `ChatPage.tsx` 的跟随逻辑（`atBottom` 初值 true、贴底时 `scrollTop = scrollHeight`）本身没错；待复核的假设：实际滚动的是页面 `main` 而不是 `scrollRef` 容器，写 `scrollTop` 落空 | bug 待复核 | §5.1 |
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
| B6 | 13 处"该能力尚未上线"分支已是死代码；任务 / 访问 / 目录 / 模型 / 审计 / 平台设置 / 平台审计 / 我的智能体保存无 e2e | 代码卫生与覆盖 | 页面未做 | §5.8、§9 |
| B7 | 系统接入页已 `enabled · ok` 的门仍显示"启用"按钮；签发服务 Handle 的 TTL 默认 = 上限、能力名手填 | 页面未做 | §5.6、§5.8 |

## 3. 现状与约束

- **三条设计底线不降级**：agent / kernel 进程不持凭证（供应商密钥只在 llm-proxy，门凭证只在门 / 门宿主）；
  触及有凭证、内部或有状态系统的动作必经审批；隔离与审计只增不减。本文所有"删除"都是受治理的能力，
  都留平台审计。
- **设计文档 §6 是规范**：§6.2 模型与供应商、§6.3 集成三层、§6.4 模块与 Skill、§6.5 运行层、§6.7 运行状态。
  本文不改它们的语义，只排序与补验收标准。
- **主机现状**：v0.13.2；一个生产工作区加 30 个验收残留工作区；Explorer 未构建；`KERNEL_VERSION` 过时；
  遗留 41–44 开放（`STATUS.md` §4）。
- **路线图**：STATUS §3 的顺序是 P-B2b → P-C → P-D。本文的 S6 波次插在 P-B2b 之前或与之并行，由维护者定。
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

- **`purge_workspace`**（scope platform，管理员，目标）：前置条件 `status = disabled` 或 `purpose = ephemeral
  且 expires_at < now()`；默认工作区拒绝（已有 `default_workspace` 护栏）；两步确认（复用抽屉确认模式），
  确认文案列出将删除的对象计数与"仍在使用的 service Handle"警告；执行 §4 的级联；写平台审计
  `platform.workspace_purged`（含计数）。`delete-workspaces-matching.sh` 改为调用这个能力而不是直接
  SQL，脚本与页面同一条路径。
- **`purge_user`**（scope platform，管理员，目标）：仅允许"从未激活且无活跃成员资格"的 User；批量选择；
  两步确认；平台审计。
- **列表默认过滤**：工作区页默认隐藏 `disabled` 与到期 `ephemeral`，加状态 / 用途筛选与排序，列表显示
  `purpose` / `expires_at`；用户页默认隐藏"待激活且成员资格全在禁用 / 一次性工作区"的用户，加"清理待
  激活用户"批量入口。
- **验收脚本不再污染平台**：`accept_s1/s2/s3.sh`、`demo.sh`、chaos 脚本创建的 Principal 带 `ephemeral`
  标记，不回填 User；工作区本就是 `ephemeral` + TTL，到期由 `purge_workspace` 清。验收：跑一轮 S1–S3
  后用户页不新增行；`purge_workspace --expired` 后工作区页只剩生产工作区。

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
- **Gemini**：先用其 OpenAI 兼容端点接入（零改动）；原生 `generateContent` 适配器作为 llm-proxy 的
  可选项单列（估算与排期见 §10）。
- 验收：在页面新增一个 OpenAI 兼容供应商并测试调用成功 → 工作区"模型与配额"里能勾选它的模型 →
  对话页头部能切到它 → `report-usage.sh` 里能按 provider / model 汇总。

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
- **待维护者决定**：原生"图谱"页——基于已有 `search` / `traverse` / `explain` 做对象浏览、邻居展开、
  Fact 溯源与新鲜度（`last_observed_at`）着色，替代第三方 bundle。收益是与控制台同一套鉴权与设计语言，
  代价是一个中等规模的前端项目；本文只列，不承诺。

### 5.8 横切（B1–B7）

- **版本号**：构建时把 git tag + commit 注入镜像（构建参数 → 环境变量），概览显示 `v0.13.2 (0fa5a1e)`；
  `.env` 里不再手工维护 `KERNEL_VERSION`。
- **确认态**：Approve（`blast_radius = high`）、Reject、Revoke、接入包三态切换、Cancel task 一律复用抽屉
  两步确认；Approve 高影响时确认文案列出目标资源。
- **id → 名称**：统一一个 `<PrincipalName>` / `<GatekeeperName>` / `<WorkerDefinitionName>` 展示组件
  （名字 + `CopyId`），用已有的 list 能力做客户端映射；访问、系统接入、目录、我的智能体全部替换。
- **语言与格式**：`work/*` 与 `govern/*`、`platform/*` 统一为中英双语文案；时间戳统一走 `formatRelative` +
  `formatDateTime`（已有）并用浏览器区域设置。
- **分页**：访问 / 系统接入 / 目录三页改为 keyset "加载更多"（平台层已有的 `useCapabilityList`）。
- **代码卫生**：删除"该能力尚未上线"死分支与过时注释。

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

线上契约：每个新能力进 `packages/shared/src/capabilities.ts` 与 wire schema，`pnpm contract:check` 快照
随之更新；`tasks.result` 类已有 `unknown` 字段不动。

## 7. 权限与安全

- 供应商密钥、门凭证的流向不变：浏览器 → caddy → llm-proxy / 门宿主，内核只签短期 JWT；密钥只写不读。
- 清除类能力只在 platform scope、管理员、两步确认、平台审计保留；工作区 owner 没有清除权（只能禁用）。
- 归档不改变可见性策略以外的任何东西；溯源链不被切断。
- 对话页的模型切换受 AgentPolicy 约束，与"我的智能体"页同一条路径，不新开口子。

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

## 10. 路线图与波次

| 波次 | 内容 | 关闭 | 依赖 |
|---|---|---|---|
| **S6-A 控制台闭环** | §5.8 全部；§5.1（归档 / 改名 / 自动标题 / 头部显示 + 范围内切换、W3 修复）；§5.2（`purge_workspace` / `purge_user` / 默认过滤 / 验收脚本不造用户）；§5.3 编辑器；§5.5 审计上下文 | B1–B7、W1–W3、A1 / A2 / A4 / A6、遗留 41 的前半 | 遗留 44 先修（对话中途切换依赖它），否则切换只在 Turn 间 |
| **S6-B 模型与供应商** | §5.4：llm-proxy 管理端点 + `issue_llm_admin_token` + 平台页；工作区只选不配 | A3 | 无（可与 S6-A 并行，文件互斥） |
| **S6-C 接入与图** | §5.6 启动器与状态一致性；§5.7 主机构建 Explorer + 隐藏入口；原生图谱页由维护者决定 | A7、B7、A5 | S6-A 的 id → 名称组件 |
| 之后 | P-B2b → P-C（运行层、运行状态）→ P-D（模块、供应商剩余项）按 STATUS 原顺序 | 设计 §6.4 / §6.5 / §6.7 | — |

优先级判断：S6-A 里 B2（确认态）与 B1（版本）是 P1；A6 / A1（残留治理）是维护者每天都会看到的，排第二；
其余 P2。S6-B 是维护者最在意的能力缺口，但它是新的服务面（llm-proxy 管理端点 + JWT），单独成波次更稳。

## 11. 最小当前版本（S6-A 第一波要交付的闭环）

1. 概览显示真实版本；审批 / 撤销 / 接入包切换有确认；四处 id 换名字。
2. 对话：归档 + 自动标题 + 头部显示模式与模型 + 在授予范围内切换（Turn 间）；W3 复现并修。
3. 工作区页 / 用户页默认过滤 + `purge_workspace` / `purge_user` + 验收脚本不再造用户；主机上把 30 个
   验收工作区清掉，用户页只剩真实用户。
4. 目录三个 tab 可新建 / 编辑草稿并发布。
5. 审计页从 Task / 审批 / Fact 一键进入。
验收标准：维护者在主机控制台走一遍 §5 各节的验收句全部成立；e2e 覆盖到每个改动页面。

## 12. 请维护者决定

1. Explorer：主机构建第三方 bundle 就够，还是立项原生图谱页（中等规模）。
2. Gemini：先走 OpenAI 兼容端点，原生适配器是否排期。
3. `purge_workspace` 对 `disabled` 工作区的保留期：立即可清，还是禁用满 N 天才可清（建议 7 天）。
4. S6-A 与 S6-B 并行还是串行；S6 插在 P-B2b 之前还是之后。
5. 验收脚本改造范围：只改"不造用户"，还是连同把验收工作区统一收进一个长期"验收工作区"复用。
