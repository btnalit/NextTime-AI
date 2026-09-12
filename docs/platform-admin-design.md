# 平台管理面（中台管理）设计 —— 从"平台为了实现什么"推出来

> 性质：设计提案，2026-09-11，第 3 版。第 3 版按维护者的澄清把整份文档按**三个面**重组：**使用面**（普通用户
> 只负责用：自己的 agent、选模型、自己的上下文，发出的任务由后端动态 Worker 按全局图串起来）、**管理面**
> （怎么把这个平台配置起来）、**维护面**（怎么把这套东西维护住）。S1–S3 交付的是使用面与内核，管理面与维护面
> 此前不存在——这就是"做了 S1–S3，我要怎么配置、怎么用起来、怎么维护"没有答案的原因。
> 第 2 版：维护者对第 1 版的三点意见已吸收：**（1）中台不管"租户"**——
> 用户即租户，工作区在用户名下自助产生，管理面集中管的是平台本身；**（2）补上运行层升级管理**（pi /
> 运行时镜像 / 平台扩展的版本、滚动重建与回滚）；**（3）补上外部集成管理**（RAGFlow、任意 MCP server、
> HTTP API、CLI / SSH 工具、外部运行时）与**模块管理**（领域包、Worker 模板、Skill）。第 1 版没有对照
> cloudflare-os 的管理面，本版补做了（§10）：`admin-config.ts` 的可配置项、gatekeeper 的
> 禁用 / 可选 / 预置三态、`gatekeeper-mcp` 与 `gatekeeper-mcp-portal` 的信任分级、Blueprint 的平台级
> 策展，凡适用者已并入。
>
> 对照依据是本地克隆的 cloudflare-os 源码（`packages/workshop-backend/src/admin-settings.ts`、`admin-config.ts`、
> `provisioning-policy.ts`、`server.ts#isAdmin`、`workshop-frontend/src/AdminPage.tsx`、`routes/{gatekeepers,providers,
> workspaces,explore}.tsx`、`gatekeeper-mcp*`、`mcp-shared/src/tools.ts`、`plans/gatekeeper-kit.md`），不是 README。
> 它的管理面很薄：AdminPage 只有 General（站点 / 公告 / 横幅 / agent 附加指令）、Gatekeepers（按 vendor 与按
> resource 开关、ambient 三态）、Formats（策展 Blueprint）、Access（是否开放注册）四个标签；管理员由 env `ADMINS`
> 指定；用户、工作区、连接器账户、AI 供应商全部是**用户自助**（`/workspaces` 自建、`/gatekeepers` 自连、
> `/providers` 自带 key）。这正是维护者说的"用户即租户，中台只管平台"。
>
> 本文是 `graph-ai-middle-platform-design.md` §7.11 的上位文档：§7.11 保留身份模型、安全约束与生效表
> 细节；两者冲突时以本文为准并回改 §7.11。S4.1 已合入的登录与身份模型沿用；"一次性令牌 + 初始化页"作废。

## 1. 我们在做什么，管理面因此要管什么

平台的权威表述（设计文档 §1）：**一个 Web 中台入口，每个用户有自己隔离的 AI agent 和对话框；说出需求，
agent 在图上找到 Worker、拉起它们、经统一的门对接各系统，把结果与决策带着来龙去脉写回图；所有 agent
共享一份图、受同一套规则约束，每一步可追溯、可审批、可重建。**

把这句话拆开，平台要"跑起来并被一群人用起来"，需要有人集中管好八件事。每一件今天都要登主机、改
文件或跑 CLI；管理面就是把它们收进页面——**凭证仍只进门与 `llm-proxy`，agent 触及有凭证 / 内网 / 有状态
系统的动作仍走门与审批，隔离与审计只增不减**。管理员在页面上做的是人直接操作平台自身：审计、不审批。

| 平台要成立的前提 | 领域概念 | 今天怎么做（v0.6.0） | 管理面模块 |
|---|---|---|---|
| ① 有人能进门 | `users`、`platform_role`、成员资格 | 读令牌、填初始化页；没有管理页 | **用户**：装好即有 `admin`；建人、停用、重置、看成员资格 |
| ② agent 能思考 | `llm-proxy`（唯一持 provider key）、`models.json`、白名单 | 主机改 YAML + env、重启、`make gen-models` | **模型与供应商**：增 / 测 / 热加载；平台默认模型 |
| ③ agent 能接系统 | Gatekeeper 实例（`http` / `mcp` / `cli` / `ssh`）、接口清单、ConnectedAccount | 每个门实例一个 compose 服务 + `register-gatekeeper` CLI；工作区的 `request_connection` 也依赖已起好的门容器 | **集成**：接入包目录、门实例、连接；RAGFlow / 任意 MCP / HTTP API / CLI 工具 / 外部运行时 |
| ④ 图有本体、agent 有模板 | OntologyVersion、领域包、WorkerDefinition、Skill、Procedure | `ontology/*.yaml` 入库靠 `seed-domain-pack` CLI；模板随镜像 | **模块**：领域包安装 / 升级、默认模块、跨工作区策展 Worker 模板与 Skill |
| ⑤ 运行层可升级 | `pi.version`、`nexttime-ai-worker-runtime` 镜像、platform-extension、入口容器 | 改 `pi.version` → CI 守卫 → `docker compose build` → 手工 `/resident/stop` 让入口容器换镜像 | **运行层**：活动镜像、入口容器版本盘点、滚动重建、回滚、pi 漂移 |
| ⑥ 花的钱有人管 | `llm_usage`、工作区 quota、`llm-proxy` 预算（100% 拒绝未实现，遗留 19） | owner 自设 quota；管理员无处设上限 | **平台设置 / 用户**：默认预算与按用户预算；`llm-proxy` 100% 拒绝 |
| ⑦ 有人看得见它在跑 | 服务健康、入口容器、outbox、审计流、备份 | `docker compose ps` + 日志 + `/internal/metrics` | **概览 / 运行状态 / 平台审计** |
| ⑧ 平台有自己的策略 | 站点名、公告、agent 全局附加指令、默认工作区、连接器三态 | 无 | **平台设置** |

**工作区在这张表里的位置**：它是一个组织（或部门）的**共享图**——RLS 数据边界、Worker 与门的授权范围，
一个部署通常只有一个，最多几个。它属于管理面（"工作区配置"，§2），不属于普通用户。普通用户看到的
"个人区"是他在这张共享图上的**自己的 agent、自己的对话与上下文、自己选的模型**，建人时自动就位。
## 2. 三个面与工作区的定位

| 面 | 谁 | 做什么 | 今天（S1–S3） |
|---|---|---|---|
| **使用面** | 普通用户 | 登录 → 看到自己的 agent → 选自己要的模型 → 对话；任务发出后由后端 Worker 按全局图动态串起来；待我审批、我的任务、我的账户。**不配置任何东西** | 已落地：对话、审批卡片、任务、我的智能体（S3.11 AgentProfile 按用户选模型）、我的账户 |
| **管理面** | 管理员（可把某工作区委托给其 owner） | 把平台配置起来：用户、模型与供应商、集成（门）、模块（本体 / Worker / Skill）、工作区配置、平台设置 | 不存在；靠 CLI 与主机文件 |
| **维护面** | 管理员 | 把平台维护住：概览与首次运行清单、运行层升级、运行状态、平台审计、备份 | 不存在；靠 `docker compose ps` 与日志 |

**个人区自动就位（方案甲，维护者已确认）**，但它不是一个独立的 RLS 工作区：

- Worker 要"根据全局信息图自己串起来"，图就必须是共享的；给每个用户一个空图的隔离工作区，Worker 在里面
  什么都找不到。所以**个人区 = 用户在组织工作区里的私有部分**：自己的入口 agent（每用户一个容器，S1 已如此）、
  自己的对话与上下文（Chat 归 Principal、`private` 可见性，S1 已如此；按 chat 分会话是遗留 33）、自己的模型
  选择（AgentProfile，S3.11 已如此，可选范围由管理员在工作区配置里限定）、自己的任务与审批。
- 建人时自动：加入**默认工作区**（平台设置指定；单工作区部署就是那一个）为 `member`，AgentProfile 取工作区
  默认模型，入口容器在首次发言时惰性拉起。登录即对话。管理员建人时也可以选别的工作区或多个。
- 因此**不需要**"每用户一个工作区"的迁移、不需要用户自建工作区、不需要"我的工作区"页。cloudflare-os 的
  "登录即有自己的 workspace"不取——它的 workspace 里没有共享图，我们的价值恰恰在共享图。

**工作区配置归管理面**。今天工作区组里 owner 才能打开的页面——成员与授权、访问、系统接入、能力目录、模型与
配额、审计——就是缺失的"配置这个平台"的一半，只是它们藏在业务侧栏里、需要 owner 角色、并且假设 owner
会跑 CLI 起门容器。本设计把它们**原样搬进管理组的"工作区配置"**（按工作区选择；单工作区部署不显示选择器），
普通 `member` 的侧栏里不再出现任何配置页。工作区 `owner` 角色保留为**委托**：管理员可把某部门工作区的配置交给
其 owner，owner 只在管理组看到自己那个工作区。多工作区只在组织需要隔离图时由管理员在"工作区配置"里新建
（名称、入口模型、允许的模型、安装的模块、启用的门、成员），删除仍只在 CLI。

## 3. 怎样才算好用（验收标准，不是形容词）

1. **零 CLI 的主路径**。从 `docker compose up` 到第一个成员发出第一句对话、接上第一个系统、装上第一个
   领域包、换一次运行时镜像，中间每一步都在浏览器里；`bootstrap.js` 只剩灾备（丢初始密码、删工作区）。
   验收：`docs/runbooks/host-bootstrap.md`"首次登录"一节不出现 `docker compose run`；`add-gatekeeper.md`
   与 `pi-upgrade.md` 的"主机步骤"只剩构建镜像。
2. **一个人一个账户，用的人不配置**。管理权（`platform_role`）与数据权（成员资格）是同一账户上的两层；
   管理员没有任何工作区的天然数据权，要看某团队的数据就得被加为成员。普通 `member` 的侧栏里没有任何配置页。
3. **登录即可用，首次运行是清单不是向导**。概览页按平台真实状态打勾（供应商、集成、用户、模块、运行层
   各一项），每项只是对应页面入口，做完自然变绿。
4. **每个对象都有状态和"为什么"**。用户、门实例、供应商、镜像、领域包都有状态与最近一次检查结果，每行
   能点到它的平台审计——平台自己的运维也 `explain`。
5. **生效时机写在按钮旁边**。立即 / 之后启动的容器 / 需滚动重建 / 需重启，来自 §8 生效表。
6. **默认安全，破坏性动作有护栏**。最后一个活跃管理员不可停用；删除 = 停用 + 吊销，行不删；凭证只写不
   回读、管理员也看不到；鉴权方式（密码 / 未来 OIDC）留在环境变量层，被劫持的管理员会话改不了它
   （借 cloudflare-os 的纪律）；每个写操作一条平台审计。
7. **已有部署一次点击接管**。既有工作区就是默认工作区，既有成员的个人区原样保留。管理员用手里的 owner API key 一步绑到自己账户，成员用 key 登录一次设密码；
   已起好的门容器在升级后自动出现在集成目录里。
8. **管理面自己也在 capability 体系里**。平台能力 `scope:'platform'`，走同一个 gateway、同一份注册表、
   同一条审计流；不另起"后台接口"。

## 4. 身份与首次运行

身份模型沿用 S4.1（§7.11"身份模型"）。**预置管理员**：kernel 启动发现没有活跃管理员 → 建 `admin`
（`platform_role='admin'`），随机临时密码写 `${NEXTTIME_DATA}/secrets/setup/initial-admin-password`
（0600；`host-env-init.sh` 建目录并在结尾提示），日志只提示路径；首登强制改密；有管理员后文件删除、
永不重生成。§7.11 否决的是**写死的**默认口令，这里的初始密码不可猜、只在主机上。

**首次运行（管理员）——"怎么配置这个平台"**：登录 `admin` → 改密 → 落在概览页 → 清单：① 模型供应商可用、
默认模型已选 → ② 默认工作区存在且装了默认模块（全新安装时 kernel 启动即建一个，名字取站点名，`admin` 是
owner）→ ③ 至少一个门实例健康并在默认工作区启用（集成页 → 工作区配置）→ ④ 除我之外有用户 → ⑤ 运行层
活动镜像与 `pi.version` 一致。全绿后折叠成一行。`admin` 自己也在默认工作区里，立刻能聊一轮验证。

**首次运行（成员）——"怎么用起来"**：登录名 + 临时密码 → 改密 → 直接落在对话页，侧栏是自己的 agent、待我
审批、我的任务、我的账户；在"我的智能体"里从管理员允许的模型中选一个；说需求，后端按图找 Worker、走门、
回卡片。属于多个工作区时才出现切换器。
API key 不是人的登录方式，是成员资格的自动化凭证（"我的账户"里签发 / 轮换）；登录页的"用 API key 登录"
折叠项只为过渡期与验收脚本。

**升级接管**（v0.5.x → 本设计）：迁移 0019 给既有 human Principal 回填无密码用户（用户页"待激活"）；`admin`
照常预置；管理员在概览页"绑定已有 API key"把那把 key 的成员资格归到自己（`principals.user_id` 改指、空壳删除）；
其他待激活用户由管理员重置临时密码或"合并到某用户"；成员也可 key 登录一次自设密码。三条路都只在目标
用户还没有密码时允许。

## 5. 控制台信息架构

侧栏按三个面分组，按角色显隐：

| 组 | 谁看到 | 页 |
|---|---|---|
| **使用** | 所有人 | 对话、待我审批、我的任务、我的智能体（选模型、看会话与上下文）、我的账户 |
| **管理** | 管理员；owner 只见"工作区配置"里自己的工作区 | 用户、工作区配置（成员与角色、入口模型与允许的模型、启用的门、安装的模块、配额、工作区审计——即今天的 owner 页面搬家）、模型与供应商、集成、模块、平台设置 |
| **维护** | 管理员 | 概览（首次运行清单）、运行层、运行状态、平台审计、备份 |

平台级页面的能力（`scope:'platform'`）：

| 平台页 | 回答的问题 | 能力 |
|---|---|---|
| 概览 | 现在能不能用？下一步做什么？ | `platform_overview`：版本 / 迁移；服务健康摘要；用户 / 入口容器 / 门实例数；30 天用量与费用；开始使用清单；最近平台审计；绑定已有 API key（`POST /api/auth/bind-api-key`，auth 路由而非 capability） |
| 用户 | 谁能进来、在哪些工作区、还能不能进、花了多少 | `list_users` / `create_user`（含默认工作区成员资格）/ `update_user` / `set_user_status` / `reset_user_password` / `list_user_memberships` / `add_membership` / `set_membership_role` / `remove_membership` / `merge_user` / `set_user_budget` |
| 工作区配置 | 这张图给谁用、agent 能用什么模型、能走哪些门、装了哪些模块 | 复用现有 `scope:'workspace'` 能力（`list_principals` / `set_quota` / `enable_gatekeeper` / `set_entry_model` / 能力目录 / 审计），管理员经 `X-Workspace-Id` 切换；新增 `create_workspace` / `update_workspace` / `set_workspace_status` / `set_allowed_models`（`scope:'platform'`） |
| 模型与供应商 | agent 用什么模型、key 好不好、花在哪 | 经 `llm-proxy` 管理端点（§7.11"供应商配置与 I9"）；`set_platform_default_model` |
| 集成 | 平台能接哪些系统、哪些门在跑、健康吗、谁在用 | §6.3：`list_connectors` / `set_connector_mode` / `list_gate_instances` / `create_gate_instance` / `test_gate_instance` / `set_gate_instance_status` / `vet_mcp_endpoint` / `list_external_runtimes` |
| 模块 | 图里有哪些本体与模板可装、装到哪了、有没有新版 | §6.4：`list_modules` / `install_module` / `upgrade_module` / `set_default_modules` / `promote_template` |
| 运行层 | 跑的是哪个版本的 pi / 镜像 / 扩展，谁过期了，怎么升 | §6.5：`runtime_inventory` / `list_runtime_images` / `set_active_runtime_image` / `roll_entry_containers` / `rollback_runtime_image` |
| 运行状态 | 哪个服务不健康、队列积压、备份多久了 | `platform_status` |
| 平台审计 | 谁在什么时候改了什么 | `platform_audit_query` |
| 平台设置 | 这台平台的默认值与策略 | §6.6：`get_platform_settings` / `update_platform_settings` |

工作区配置里的"成员"页语义变为从平台用户中添加（按登录名搜索 → 选角色）；`create_principal` 只剩 agent /
service。"系统接入"页变为从平台集成目录**启用**门实例（管理员或受委托的 owner），普通用户不再有
`request_connection` 卡片的入口——门由后台接好，用户只管用；`request_connection` 能力保留给 owner 与
`connected_account` 模式下用户绑定本人账号的场景。

## 6. 模块设计

### 6.1 用户

列表列：登录名、显示名、平台角色、状态（active / disabled / 待激活）、工作区（个人 + 团队@角色胶囊）、
本月用量 / 预算、最近登录。行动作：编辑、重置密码（临时密码只显示一次）、停用 / 启用、成员资格抽屉
（加入 / 改角色 / 移出）、设预算、合并（仅待激活用户）。新建：登录名、显示名、平台角色、密码（默认自动
生成）、工作区与角色（缺省 = 默认工作区 `member`）→ AgentProfile 取该工作区默认模型。护栏：最后一个活跃
管理员不可停用 / 降级；停用即吊销全部 `user_sessions` 与其各 Principal 的工作区会话，其对话与上下文保留
（行不删）。

### 6.2 模型与供应商

不变（§7.11"供应商配置与 I9"）：web → caddy `/api/llm-admin/*` → `llm-proxy` 管理端点，鉴权用内核签发的
5 分钟平台 JWT；`llm-proxy` 热加载并原地重写 `models.json`。本版新增：平台默认入口模型（新工作区与新用户的 AgentProfile
取它）；预算 100% 拒绝在 `llm-proxy` 落地（遗留 19），预算来源是平台设置默认值 → 用户预算 → 工作区 quota。

### 6.3 集成（外部系统、MCP、API、CLI、外部运行时）

三层对象，对应今天代码里已有的三样东西：

| 层 | 是什么 | 今天 | 管理面 |
|---|---|---|---|
| **接入包（connector）** | 一种可部署的门：预置包 `gatekeepers/docker`、`gatekeepers/ragflow`，或通用种类 `http` / `mcp` / `cli` / `ssh` | 源码目录 + Dockerfile | 目录页列出本部署带的接入包（名、种类、Operation 数、版本、说明），每个有**三态**：禁用 / 可自连（工作区 owner 可自己连）/ 平台预置（管理员建实例、工作区一键启用）——借 cloudflare-os `ambientGatekeeperModes` |
| **门实例（gate instance）** | 一个在跑的门进程 + 它指向的目标（RAGFlow 地址、某个 MCP server、某台 SSH 主机） | 每实例一个 compose 服务，`register-gatekeeper` CLI 注册 | 见下文两条路径；实例有健康、最近检查、启用它的工作区数 |
| **连接（connection）** | 某工作区 / 某用户对一个门实例的使用关系 + 凭证（凭证只在门内） | `request_connection` 卡片 → 门存 ConnectedAccount → 图里生成 `Gatekeeper` 与系统对象 | 不变；集成页只看"谁在用"，不看凭证 |

**门实例的两条路径。**
- **打包门自注册。**`gatekeepers/<system>` 与通用门容器启动时向内核 `POST /internal/gates/announce`
  （内部面 token，同 supervisor），带**稳定的门身份**（`GATE_ID`，随 compose 服务配置，非显示名——防止第二个
  容器用同名顶替已启用的门）、种类、`describe_operations`、健康端点 → 出现在集成页"发现的门实例"，状态
  "未启用"；管理员启用 / 命名 / 分配三态；下线的门实例标"失联"。这替代 `register-gatekeeper`
  CLI，也让升级接管时已起好的 docker / ragflow 门自动出现。
- **通用门宿主（`http` / `mcp`）。**`gatekeeper-base` 增加多实例模式：一个长驻容器承载 N 个 `http` / `mcp`
  实例，实例定义（目标地址、传输种类、凭证模式、`vetted`）由管理员在集成页创建、门宿主经内部面从内核**拉取**（P-B2a
  决定 ⑥：推需要一条内核 → 宿主的凭证，今天不存在；拉与门自注册同一信任方向，措辞偏离于此记录），
  **凭证由页面直接 POST 到门宿主**（与 `request_connection` 同一条"凭证直达门、不经内核"的路；浏览器对门宿主
  的鉴权用内核按需签发的 5 分钟平台 JWT，与 `/api/llm-admin/*` 同一机制），门宿主用已有的 ConnectedAccount
  本地加密存储。这样接一个新 MCP server 或一个 REST API 不再需要 compose 服务。
  `cli` / `ssh` 门要带二进制与密钥，仍是打包门（走自注册）。
- **MCP 信任分级**（照 cloudflare-os `mcp-shared/src/tools.ts#classifyTool` 的规则，不自创）：`readOnlyHint`
  为真 → observe，直接执行；否则 → execute，进审批；**自动批准**只在 `trust='vetted'` 且 `destructiveHint=false`
  且 `idempotentHint=true` 时允许。`vetted` 是管理员在集成页给平台预置 MCP 实例打的标，随时可撤且立即生效
  （每次决策时读，不冻结在连接上）；工作区 owner 自连的 MCP 端点一律 `byo`，永不自动批准。cloudflare-os 的
  portal 服务器清单来自 env 与 portal 的 `list_servers`，我们改为管理员在页面维护——因为我们没有一个上游 portal。
- **按 Operation 开关**（借 cloudflare-os 按 resource 的 `setResourceEnabled`）：集成页对每个接入包除三态外，还能
  逐个禁用 Operation（例如禁掉 `docker.compose_down`），在 gateway 签发 Handle 时过滤，`create_connection`
  与工作区能力目录都看不到被禁的 Operation。
- **外部运行时**（Claude Code、本机 pi 经 `/mcp`；未来 A2A）：签发仍在工作区"访问"页（service Principal +
  Handle，替代 `issue-service-handle` CLI，本设计把它搬进页面）；集成页"外部运行时"标签只做跨工作区盘点
  与吊销。

### 6.4 模块（领域包、Worker 模板、Skill）

**模块 = 一个版本化的领域包**：本体类型 + Procedure + WorkerDefinition 模板 + Skill，今天就是
`ontology/ops-assets-v1.yaml` / `-v2.yaml` 这样的文件，随 kernel 镜像发布。参考项目的对应物：Semantica 的
`plugins/` 是面向各 IDE agent 的清单 + 一组 skills（`ingest / extract / ontology / reason / ...`），但其 skill 直接
`import` 内部 Python 类、不能换端点复用（`reference-projects-and-oss-landscape.md` §1、§3），我们只借"模块 =
可安装的一组能力"的形态；cloudflare-os 的 Context Library 把 git 集合里的 `SKILL.md` 装成 slash 命令；pi 的
skills 也是 `SKILL.md` frontmatter。**三家共用 `SKILL.md` 格式**，我们的 Skill 对象（S2.14）就是它，所以
"从 git 仓库导入 Skill 集合"在格式上零成本，排在"之后"。模块页：
- 列表：本部署带的模块与版本（读镜像内 `ontology/`），每个显示"已安装到 n 个工作区 / 其中 m 个有新版"。
- **安装 / 升级到工作区**：复用 `seed-domain-pack` 逻辑生成新的 OntologyVersion，页面显示迁移说明与
  不兼容变更；owner 也能在自己工作区的"能力目录"里做同样的事（`scope:'workspace'`）。
- **默认模块**：新建工作区自动安装的集合（平台设置）。
- **策展**（借 cloudflare-os Blueprint 的 `formats` 策展）：owner 在某工作区里 `propose_*` 出的 Worker 模板 /
  Skill / Procedure，管理员可"推荐到平台"，其他工作区在能力目录里看到并一键装入；只复制定义，不复制数据
  与凭证。
- 上传模块文件、外部模块仓库：P5（§9"之后"）。第三方能力来源仍只有门与 Skill，不开放第三方 pi extension。

### 6.5 运行层（pi / 运行时镜像 / 平台扩展）

运行层由四样东西组成：`pi.version`（唯一真源，CI 守卫三处一致）、`nexttime-ai-worker-runtime` 镜像
（入口与 Worker 同一镜像，pi 版本烘在里面）、platform-extension（在镜像里）、agent-host 与 supervisor
（compose 服务）。**构建镜像仍在 CI / 主机**（需要 Docker 构建权限，不进内核）；管理面负责**选择、盘点、
滚动、回滚**：

- **盘点**：活动镜像（tag / digest / 内含 pi 版本与扩展版本，读镜像 label）；已构建镜像列表（supervisor 新增
  `GET /images`，只列带平台 label 的镜像）；入口容器列表（用户、工作区、镜像 digest、启动时间、是否空闲），
  与活动镜像不一致的标"待重建"；Worker 一次性容器天然用最新活动镜像。
- **设为活动镜像**：`WORKER_IMAGE` 从 env 变为平台设置（env 仍作缺省），supervisor 每次 spawn 读取；
  白名单 `WORKER_IMAGE_ALLOWLIST` 仍在 env（安全边界不进页面）。
- **滚动重建**：内核先把目标入口容器标为 **draining**（agent-host 对它拒绝新 Turn，返回"正在升级，请稍候"），
  当前 Turn 结束后 `/resident/stop`，下次该用户发言时 supervisor 以活动镜像 `spawn`；页面显示进度与仍在
  Turn 中的容器，可"全部 / 选中 / 仅我自己"。不用"只停空闲的"——那有竞态。
- **回滚**：活动镜像改回上一个 digest + 同样的滚动重建；镜像列表保留最近 N 个。
- **pi 漂移**：显示 `pi.version`、镜像内 pi 版本、平台扩展版本三者是否一致，以及 `pi-drift.yml` 最近一次
  结果（由 CI 把结果写进发布说明 / 一个静态 JSON，页面读；不出网查 npm）。
- 镜像 label：`deploy/worker-runtime/Dockerfile` 加 `LABEL ai.nexttime.pi-version / platform-extension-version /
  built-from`，supervisor `GET /images` 只列带这些 label 的镜像（P-C 的第一项）。
- 平台自身版本与待执行迁移在概览页；kernel / llm-proxy / caddy 的升级仍是 `docker compose pull && up`，
  运行状态页显示各服务镜像版本以便核对。

### 6.6 平台设置

借 cloudflare-os `AdminConfig` 的取舍：**软策略进页面，鉴权配置留 env**。

| 设置 | 用途 | 生效 |
|---|---|---|
| 站点名、公告（Markdown）、横幅 | 让人知道自己在哪、发生了什么 | 立即 |
| agent 全局附加指令（`instanceInstructions`） | 追加到每个入口与 Worker 的 system prompt（公司背景、禁忌、语气） | 之后启动的容器；可从运行层页一键滚动 |
| 默认工作区 | 建人时自动加入的工作区（单工作区部署就是它） | 立即（对新建用户） |
| 平台默认入口模型、默认预算 | 新工作区与新用户的 AgentProfile 取值；预算上限约束 owner 自设 quota | 立即（对新建） |
| 默认模块 | 新工作区自动安装 | 立即（对新建） |
| 连接器三态 | 见 §6.3 | 立即（已连的不受影响） |
| 新用户默认平台角色、密码策略（最短长度、临时密码有效期） | 用户目录策略 | 立即 |
| 每用户每日调用上限（缺省 100 次，借 cloudflare-os `ai-gateway-billing` 的免费层做法） | 比 token 预算更直觉的第一道闸；与月度预算并存 | 立即 |

不进页面（留 env / 主机）：鉴权方式与 OIDC 配置、内部面 token、`WORKER_IMAGE_ALLOWLIST`、出网代理白名单、
数据目录。理由同 cloudflare-os：被劫持的管理员会话不能放大自己的权限。同理再加一条保险：env
`NEXTTIME_PLATFORM_ADMINS`（登录名列表，可空）里的用户**始终**是管理员，页面上不可停用或降级——cloudflare-os 的
`ADMINS` 就是这么做的，我们保留数据库 `platform_role` 以便页面授权，用 env 名单兜底防锁死。

### 6.7 概览、运行状态、平台审计

概览是管理员的落地页；普通用户落在对话页（"你还不属于任何工作区"只在成员资格被全部移除时出现）。
运行状态复用 `/internal/metrics` 与 supervisor 数据。平台审计是 `workspace_id is null` 的审计流，
`metadata.target_*` 可过滤；每个平台写操作一条。

## 7. 内核与安全落点

- 注册表 `scope: 'workspace' | 'platform'`；gateway 对 `scope:'platform'` 只放行 cookie 会话且
  `platform_role='admin'`，业务 Principal / Handle 一律 403；平台能力事务显式 `set_config('app.platform','on',true)`，
  写目标工作区时再切该工作区 GUC；内核不获得通用 RLS 绕过。
- 门自注册与门宿主拉取实例定义走内部面 token（同 supervisor），只在 compose 网络内；页面向门宿主 POST 凭证
  经 caddy 直达门宿主（同 `request_connection`），内核只拿到"已存"回执。
- 运行层动作只经 supervisor 已有 / 新增的内部端点（`/images`、`/resident/stop`），内核不碰 Docker socket；
  镜像必须在白名单内。
- `instanceInstructions` 是 prompt 的一部分：仅管理员可改、每次改动审计、页面提示"这会进入所有 agent 的
  system prompt"。
- 平台设置存 `platform_settings`（单行 JSONB + 版本号），每次写审计并保留上一版以便回滚。

## 8. 生效表

| 操作 | 生效 |
|---|---|
| 首次安装 | kernel 首次启动即有 `admin` 与默认工作区（`admin` 为 owner），登录后强制改密 |
| 建用户（页面） | 立即；默认工作区成员资格与 AgentProfile 同时就位，入口容器首次发言时拉起 |
| 停用用户 | 立即：全部会话吊销、入口容器 `stop`；对话与上下文保留 |
| 加入 / 移出工作区、改角色 | 立即（入口 Handle 下一轮 Turn 重签） |
| 绑定 / 合并既有 API key | 立即（key 继续有效，归属变了） |
| 新增 / 修改供应商与 key | `llm-proxy` 热加载，立即；agent 容器：之后启动的 |
| 门实例启用 / 三态 | 立即；已建立的连接不受三态变更影响 |
| 通用门宿主新增实例 | 下一轮拉取（默认 ≤ 60 s；宿主接管前页面显示“等待宿主接管”） |
| 安装 / 升级模块到工作区 | 立即产生新 OntologyVersion；运行中 Worker 用旧版直到结束 |
| 设活动镜像 | 之后启动的 Worker 与入口容器；已运行的入口容器需滚动重建 |
| 滚动重建 | 空闲容器立即；忙的在其 Turn 结束后 |
| 平台设置 | 见 §6.6 |

## 9. 交付顺序（每一步结束时产品都处于可用状态，各带 CI e2e）

| 步 | 内容 | 结束时能做什么 / e2e |
|---|---|---|
| **P-A1 身份、用户与管理面骨架** | 预置 `admin` + 默认工作区 + 绑定 / 合并 API key；`scope:'platform'` 与平台审计；侧栏按使用 / 管理 / 维护三组重排，owner 页面搬进"工作区配置"、普通 member 不见配置页；概览（清单 + 数字 + 健康 + 最近审计）；用户页全部（建人默认进默认工作区）；平台设置基础项（站点 / 公告 / 默认工作区 / 默认模型 / 默认预算 / 每日上限 / 密码策略 / env 管理员名单）；成员页改为从用户中添加 | 装好即登录即对话；建人、加进工作区、停用全在页面；用的人只看到使用组。e2e：admin 首登 → 改密 → 直接聊一轮 → 建用户 B → B 登录直接落在对话页、侧栏无配置页、能在"我的智能体"选模型 → 停用 B → cookie 与 WS 立即失效 |
| **P-A2 使用面收口** | 允许的模型列表（工作区配置）约束 AgentProfile；按 chat 分 pi 会话（遗留 33）；`instanceInstructions` 进 system prompt；"工作区配置"新建 / 禁用工作区与 owner 委托 | 用户的上下文按对话独立保存；管理员可为一个部门另开一张图并委托 owner |
| **P-B 集成与模块** | 门自注册 + 集成目录与三态；通用门宿主（`http` / `mcp`）+ 页面直达门的凭证录入；`vetted` MCP；外部运行时盘点 + 工作区"访问"页签发 service Handle；模块页（列 / 安装 / 升级 / 默认 / 推荐到平台） | 接 RAGFlow、接任意 MCP server、装领域包不再登主机。e2e：起一个 fake MCP → 集成页新增实例 → 测试 → 工作区启用 → 入口 agent 的工具里出现它；模块页把 `ops-assets-v2` 装进 B 的工作区 |
| **P-C 运行层与运行状态** | supervisor `GET /images` + label；活动镜像成为平台设置；运行层页（盘点 / 设活动 / 滚动 / 回滚 / 漂移）；运行状态页 | 换 pi 版本 = CI 构建 + 页面点两下。e2e：构建带新 label 的镜像 → 设为活动 → 滚动 → 入口容器 digest 变化 → 回滚 |
| **P-D 模型与供应商** | `llm-proxy` 管理端点 + 热加载 + `models.json` 重写 + 平台 JWT；供应商页；预算 100% 拒绝 | 换模型 / 换 key 不再登主机 |
| 之后 | OIDC；下掉登录页 API key 折叠项；模块上传与外部模块仓库；Blueprint 式跨部署导出；E7 备份定时器接进运行状态页 | — |

每一步一个 PR 波次（内核 + web + e2e 一起合入），避免"能登录但没地方管"的中间态。P-A 拆成两个 PR：P-A1 合入后
管理员已经能在页面里配置用户与工作区、普通用户只看到使用面，没有死角；P-A2 收口使用面细节，各自可独立回滚。
顺序理由：P-A 是一切的前提；P-B 是维护者点名的两块缺口且用户价值最高；P-C 让升级不再手工；P-D 今天有主机
YAML 兜底，排最后。

## 10. 对照 cloudflare-os 的管理面（按源码，不按 README）

| cloudflare-os（文件） | 它怎么做 | 本项目的对应 | 取舍 |
|---|---|---|---|
| `server.ts#isAdmin`、`env.d.ts ADMINS` | 管理员 = env 里的用户名数组；没有页面授权、没有"第一个用户即管理员" | 数据库 `platform_role` + 预置 `admin`；env `NEXTTIME_PLATFORM_ADMINS` 兜底 | **取其兜底**，页面授权保留（我们没有自注册，需要页面建人） |
| `AdminPage.tsx` 四标签：General / Gatekeepers / Formats / Access | 只管策略与策展；没有用户、工作区、健康、审计、版本 | 平台设置 §6.6 + 集成三态与按 Operation 开关 + 模块策展；用户 / 运行层 / 运行状态 / 审计是我们自建 | **取其"薄"**：不做多租户管理；补它没有而自托管中台必须有的部分（用户、工作区配置、运行层、运行状态、审计） |
| `admin-config.ts`：`instanceInstructions` / `announcement` / `banner` / `siteName` / `disabledGatekeepers` / `disabledResources` / `ambientGatekeeperModes` / `formats` | 单例 DO 持有、KV 镜像给热路径 | `platform_settings` 单行 + 内核缓存 | **取** |
| `provisioning-policy.ts` | ambient 门三态 disabled / optional（缺省）/ enabled（强制给所有人） | 接入包三态 禁用 / 可自连（缺省）/ 平台预置 | **取**，语义对齐 |
| `user.ts#getGatekeeperClassFor` | 签发 capability 前的唯一 chokepoint 检查禁用 | gateway 签发 Handle 时按三态与 Operation 开关过滤 | **取** |
| `routes/workspaces.tsx`、`/gatekeepers`、`/providers` | 用户自建 workspace、自连 connector 账户、自带 AI provider key | 不取：我们的工作区是共享图，个人区在图内；门由后台接好；BYOK 列入"之后" | **不取**（产品定位不同：它是个人生产力，我们是组织中台） |
| `router/src/index.ts` | 扫 `GATEKEEPER_*` binding 发现门；一包一 Worker | 打包门启动时向内核自注册（内部面 token） | **取概念**，机制换成自注册 |
| `plans/gatekeeper-kit.md`、`gatekeeper-kit/src` | 门包导出 vendor 描述、resources、configurator；凭证只在门的 DO；action journal / simulation / cache 由 kit 提供 | `gatekeeper-base`：manifest 的 Operation 列表、`describe_operations` / `simulate` / `apply`、ConnectedAccount 本地加密存储 | 已对齐；本版补"多实例宿主"与 configurator 式的连接表单 |
| `gatekeeper-mcp` vs `gatekeeper-mcp-portal`、`mcp-shared/src/tools.ts` | 用户贴端点 = `byo`；portal（env 配置）= 可 `vetted`；自动批准需 readOnly 之外再满足 vetted ∧ 非破坏 ∧ 幂等；OAuth 用 MCP SDK | 门宿主里的 MCP 实例；管理员打 `vetted`；同一分类规则；MCP OAuth 在 P5 | **取规则原文** |
| `routes/explore.tsx` = Blueprints；`formats` 策展 | 用户发布 Blueprint，管理员推荐为"标准格式" | 模块页 + "推荐到平台"的 Worker 模板 / Skill / Procedure | **取概念** |
| `gatekeeper-context`（Context & Skills，ambient 门；git 集合 + `SKILL.md`） | 知识集合与技能作为一个门提供，技能进 slash 命令 | 我们的知识库走 RAGFlow 门，Skill 走模块；"从 git 仓库导入 Skill 集合"列入"之后" | 部分取 |
| `ai-gateway-billing`（每用户每日 100 次；余额够则走 BYOK） | 简单的免费层 + BYOK | 每用户每日调用上限 + 月度预算；BYOK 之后 | **取上限** |
| `agent.ts` 内嵌 `pi-agent-core`（exact pin） | 运行时随后端一起发版；无版本页 | 运行层 §6.5 自建 | 无可参考 |
| `observers.md`、`sharing.md` | Gadget 级共享与逐门读权限校验 | 工作区 RLS + 角色已覆盖 | 不取 |

## 11. 否决与取舍

- **每用户一个 RLS 工作区**（第 2 版方案）：否决——Worker 要按全局图串任务，图必须共享；个人区是图内的私有部分。
- **多租户 SaaS 式的"租户管理"页**：否决——一个部署一到几张图，"工作区配置"足够。
- **让普通用户接系统、跑 CLI**：否决——用的人只用；门、模型、模块由管理面配置好。
- **固定默认口令** `admin`/`admin`：否决（§7.11）。**一次性令牌 + 初始化页**：否决——多读一次文件、多一页表单，
  且建完管理员没有任何管理页。
- **管理员天然拥有全部工作区数据权**：否决——违反"隔离只增"，且让管理员账户成为最高价值目标。
- **在页面里构建运行时镜像**：否决——需要 Docker 构建权限进入服务进程；构建留 CI / 主机，页面只做选择与滚动。
- **在内核里存 provider key 或门的凭证以便页面配置**：否决（I9、"凭证只在门"）；供应商走 `llm-proxy` 管理端点，
  门凭证由页面直达门宿主。
- **开放第三方 pi extension 作为模块**：否决（§3.11）；第三方能力只有门与 Skill 两种来源。
- **删除工作区进页面**：暂否——破坏性且不可逆，留 CLI 的 `--yes` 门槛。
