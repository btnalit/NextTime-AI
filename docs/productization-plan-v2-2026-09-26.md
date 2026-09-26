# 产品化重构方案 v2（2026-09-26）

> 用户要求（原话）：继续理清楚我们内核，功能，调用逻辑，然后对比前端功能不足，继续从产品化，易用性，美化，
> 可模块化接入，pi agent 和底层组件等可以升级，理清前后端做优化。专业设计审查，出重构方案并落地。
>
> v1（`console-redesign-plan-2026-09-25.md`）以一次事故为中心；v2 覆盖要求里的每一个维度，每一项都有
> 「现状 → 目标 → 切片 → 验收」。验收一律在主机上由维护方（我）跑真实场景，不交给用户判断。

## 1. 教训与方法（为什么 v1 没兜住）

| 事故事实 | 暴露的问题 | v2 的规则 |
|---|---|---|
| RagFlow 5 个操作被平台禁用清单全关；控制台说能用，内核每次都拒 | 读模型（可达性）没有调用执行路径的判定，而是「重写一遍」 | **读模型必须调用执行判定本身**（同一个函数），并有一致性测试逐层对照 |
| 智能体看得到 `kb.list` 工具，调用却被拒 | 投射层（`list_allowed_operations`）与执行层判定不一致 | 投射、读模型、执行三处共用一个谓词 |
| 集成页「勾选 = 禁用」，提示写着「不影响已启用的工作区」（事实相反） | 文案与语义未经核对；反向勾选语义 | 影响他人的设置用「允许清单」+ 如实写影响面 + 确认 |
| 我先宣布了错误根因（AgentProfile 冻结） | 没在主机上核实就下结论 | 结论前先在生产库/主机核实；修复以主机真实场景通过为准（S4） |

## 2. 内核调用链地图：一次「智能体调用某系统的某操作」要过的层

| 层 | 事实来源 | 谁设置 | 执行点（拒绝在哪发生） | 展示点（控制台/智能体在哪看到） | 现状缺口 |
|---|---|---|---|---|---|
| L0 连接器模式 | `connectors.mode` | 平台管理员 | 启用门实例时 | 平台 · 集成 | — |
| L0' 连接器禁用清单 | `connectors.disabled_operations` | 平台管理员 | `observe_operation` / `request_action` 每次调用 | 平台 · 集成 | **可达性不看它；投射不过滤它；改动不刷新会话；UI 反向勾选 + 错误提示**（Track A 修） |
| L1 门实例 | `gate_instances.status/health` | 平台 | 门本身 | 平台 · 集成 · 门实例 | 可达性不看实例健康（v2 待补：`gate_unhealthy` 原因，只读展示） |
| L2 工作区启用 | `workspace_gate_links` → Gatekeeper 对象 | 工作区 owner | 未启用即无 Gatekeeper | 系统与授权 | — |
| L3 操作发布 | Operation `status=published`、`mode` | owner / builder | 未发布 404（I17） | 能力目录 · Operation | — |
| L4 成员授权 | `capability_grants(resource_type=gatekeeper)` | owner | 人类通道：`assertHumanGatekeeperAccess`；**handle 通道：只查能力名，不查是哪个门** | 系统与授权 · 谁能用 | **observe 在 handle 通道不校验门范围**（MCP 会话 Handle 可观测任意门）→ Track A2 收紧 |
| L5 工作区策略上限 | `agent_policies.allowed_gatekeepers` | owner | 入口 Handle 签发时 | 我的智能体（生效摘要） | — |
| L6 成员排除 | AgentProfile `excluded_*` | 成员本人 | 入口 Handle 签发时 | 我的智能体 | — |
| L7 入口 Handle | `resources.gatekeeper` = L4 ∩ L5 − L6 | 内核（每轮） | Handle 验证 | — | 授权/Profile/成员变更会吊销；连接器变更不会（Track A 修） |
| L8 工具投射 | `list_allowed_operations` @ session_start | pi 扩展 | 看不到就不会调 | 智能体工具列表 | 不过滤 L0'（Track A 修）；只在会话开始投射（pi 0.86+ 可每轮更新 → P4） |
| L9 执行类 | ActionRequest + 审批 / 策略 | Worker 提出，人审批 | `request_action` → 审批 | 待我审批 | — |
| L10 委派 | `invoke_worker` 子 Handle 衰减 | 入口 agent | `computeChildHandleScope` | 任务 | 未授权的观测门在子 Handle 里被丢掉，但内核执行不看（同 L4，A2 一并） |

**设计决定 D4（本次新增）**：§11「观察免审」指**不需要 ActionRequest 审批**，不等于**不需要授权范围**。observe 调用
在所有通道都必须在调用者的授权范围内（人类：Grant；Handle：`resources.gatekeeper`，未设 = 空）。理由：设计底线
「隔离与审计只增不减」；门持有凭证（如知识库），观测也是读取受保护数据；其余各层（人类通道、投射、可达性、子 Handle
衰减）早已按此语义实现，只有 handle 通道执行点例外。

## 3. 内核能力 × 前端覆盖

盘点结果（全表见 `kernel-console-coverage-2026-09-26.md`：161 个 capability，逐个列通道、读写、控制台调用处、智能体暴露）：

- 161 个 capability 与处理器 1:1，无孤儿；72 observe / 58 write / 25 execute / 6 propose；119 仅人类通道，42 可经 Handle。
- 入口 agent 固定 21 个工具，Worker 运行时 5 个，另约 23 个可经自助 Handle 签发；其余约 120 个只在控制台 / 平台。
- **19 个没有任何控制台调用**：其中 9 个按设计只给智能体（`find_*`、`request_action`、`traverse`、`register_source`、`submit_observations` 等），其余是真缺口：

| 缺口 | capability | 判断 | 去向 |
|---|---|---|---|
| G1 本体治理无界面 | `get_type` `validate` `propose_ontology_change` `publish_ontology_version` | 本体只能由智能体提案，人看不到也批不了 | v2 功能切片 F1：图谱页「类型」抽屉 + 提案审阅（复用审批主从） |
| G2 人不能改事实 | `assert_fact` `supersede_fact` `invalidate_fact` | 只有「验证」和「冲突裁决」 | F2：事实行菜单「作废 / 取代」（高影响确认 + 审计） |
| G3 已部署 Operation 治理字段刷新无入口 | `refresh_operation_governance` | 读半（预览 diff）已接，写半没接 = 遗留 79 的出口 | F3：系统抽屉「与门公告对齐」 |
| G4 死读 | `get_gate_instance` `list_runtime_images` `list_user_memberships` | 前端在客户端筛列表代替 | 用上（深链直接读单个实例）或删除；先核 `UserMembershipsPanel` 数据来源 |
| G5 半成品 | `connect_gatekeeper` | 启动器注释里的待办 | 与「接入包契约」一起定：删或并入启用流程 |
| G6 高影响无确认 | `roll_entry_containers` | 同页两个兄弟都有 `Confirm`，唯独它没有，且影响面最大（无主体时重建全平台空闲入口容器） | 立即修（小 PR） |
| G7 重复读 | `list_gatekeepers` 在 7 个文件各读一遍做名称解析 | 不是缺口，是前端结构债 | P3 期间收成一个共享 hook |

- 旧组件迁移：23 个路由页里 21 个仍引用 `components/ui/*`（只有 系统与授权、平台·残留 已迁完）——P3 各片顺带清零。
- 限制：调用方识别基于字符串检索；确认框审查是抽样（约 15/83 个写/执行能力），P3 各片补全。

## 4. 产品化与易用性（功能先于美化）

- 每个「能不能用」的问题只有一个答案来源：内核读模型（可达性 / 就绪），前端不自算。
- 每个影响他人的设置（禁用清单、策略上限、撤销授权）在保存前显示影响面，并刷新受影响会话。
- 智能体的「为什么不能用」必须指向具体页面与具体开关（原因码 → 文案 → 链接，一张表维护）。

## 5. 美化：P3 视觉重构

规格与审查结论见 `console-visual-p3-spec-2026-09-26.md`。切片 P3-1 壳层 + kit → P3-2 对话三栏 → P3-3 我的智能体 / 系统与授权 / 就绪条
→ P3-4 审批主从 / 任务 / 成员 → P3-5 能力目录 → P3-6 平台页。每片以 1440/1280/768 截图对照已认可画板做 design-critique，
无 🔴 才合入。

## 6. 可模块化接入（连接器 / 门 / 模块）

现状：接入包（connector）→ 门实例（gate instance，平台）→ 工作区启用（link → Gatekeeper + Operation 导入）→ 发布 → 授权；
自助接入（self_serve：ssh / http / mcp / cli）走「接入一个系统」启动器；模块（catalog modules）另成一套。
目标：一个「接入包契约」贯穿：manifest（操作、模式、影响级、参数 schema、描述）→ 平台预检 → 工作区启用预览（diff）→
发布 → 授权 → S4 真实调用验收。缺口（待覆盖地图补全）：遗留 79（已部署 Operation 治理字段落后于 manifest）、
遗留 81（Operation 描述不能补写）、遗留 80（Grant scope 只存不校验）。

## 7. pi agent 与底层组件升级（P4）

| 组件 | 现状 | 目标 | 价值 / 风险 |
|---|---|---|---|
| pi（`@earendil-works/pi-*`） | 0.84.4 | 0.87.1 | 0.86 起扩展可在会话中途更新工具与提示（`before_agent_start`，随恢复保留）。**更正（2026-09-26）**：这只在"授权范围不变、可调用操作清单变了"时省掉重建——授权 / Profile / 连接器变更会轮换 Handle，而 Handle 在容器启动时经环境变量交付，仍需重建容器，除非把 Handle 改为可热更新的挂载文件（另立项）。兼容性已逐条核对（`pi-upgrade.md` §2.1）：我们依赖的面都无需改代码；运维侧另见"pi 运行时"卡片与 `scripts/build-images.sh` |
| vitest / vite | vitest 2.1.9、vite 5/6 | vitest 5、vite 8 | 关闭遗留 91 的 9 条告警（开发链） |
| 关联 ID | 只有内核有指标 | 跨服务 correlation id | 遗留 87 |
| 镜像构建缓存 | 每次全量下载依赖 | 依赖层缓存 | 遗留 93（主机出网被掐断） |

## 8. 前后端优化

- 内核：`handlers.ts` / `platform-handlers.ts` 拆分（按领域）；读模型统一走「执行谓词」。
- 前端：页面只消费读模型；`components/ui/*` 迁完后删除；原生控件清零。

## 9. 路线与验收

| 顺序 | 内容 | 验收 |
|---|---|---|
| 1 | Track A：禁用清单进可达性 + 投射过滤 + 改动刷新会话 + 集成页允许清单 | 一致性测试；主机 S4 |
| 2 | S4 主机验收（每个已接入系统一次受治理的只读调用，读模型与执行对照） | 主机 S4 全过 |
| 3 | Track A2：observe 授权在内核强制（D4） | 一致性测试扩展；S2/S4 |
| 4 | P3-1…P3-6 | 每片截图对照画板无 🔴；axe / copy 不回退 |
| 5 | P4：pi 0.87 + 每轮工具投射；vitest/vite；关联 ID；构建缓存 | 主机 S1–S4；入口 agent 真实对话 |
| 6 | 接入包契约收口（遗留 79/80/81） | S4 覆盖新增连接器 |
