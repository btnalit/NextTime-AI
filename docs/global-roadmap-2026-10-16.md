# 全局推进计划（2026-10-16 起）

> 这是项目从 2026-10-16 起的**排号推进计划**：阶段、波次、任务编号、依赖与验收。它回答"接下来按什么顺序做什么、做到什么算完"；
> "现在到哪了"仍只看 `STATUS.md`，任务的实现说明仍随合入写进 `development-tasks.md`。
> 依据：`goal-orchestration-and-admin-agent-plan-2026-10-16.md`（新主线的设计，下称"方案"）、`s10-evolution-plan-2026-10-04.md`（S10）、
> `STATUS.md` §3 / §4（main `0390041` 时的状态）。
> 编号沿用仓库现有风格：阶段 `S11`、波次 `W0…W5`；任务号按线分前缀——S10 已有的 `E2` / `E3` / `P0b` / `P1` / `U1` / `U2` 原号保留，新增
> 目标级编排线 `GO1…`、管理员 Agent 线 `AA1…`（不用单字母 `G` / `A`：S10 的目标 G1–G7、控制台批次 G1–G4 与 `development-tasks.md`
> 的 A1–A12 已占用）；遗留沿用 `STATUS.md` §4 的编号，本计划新增 287–293（已为本计划预留）。
> 阶段名 `S11` 已由协调方定下（方案 §10 F1）；若维护者改为"作为 S10 的新车道"，波次改记为 S10 W3 起，**任务号不变**。
> 本文不带阶段前缀的 W0–W5 都指 S11 的波次；S10 的波次写全称（S10 W2a）。

## 1. 阶段总览

| 阶段 | 主题 | 状态（2026-10-16） | 出口 |
|---|---|---|---|
| 控制台阶段 | 控制台产品化可用 | 进行中：出口标准 2、3 已满足；1、4 随主机窗口（维护者 10-16 决定暂缓） | `STATUS.md` §3 的四条出口标准 |
| S10 | 可升级运行时 · 受治理的自进化 · 能力包 | S10 W1 完成并上主机；S10 W2–W4 未开工的项按 §4 并入 S11 | 本计划接管排序，S10 方案仍是这些项的设计依据 |
| **S11** | 目标级执行与平台管理员 Agent | 待开工 | W1–W4 各自的验收；总出口见 §3；W5 先过决策门 |

## 2. 排序与并发

```
W0 收尾与前置 ──(287)──▶ W1 可靠多步执行 ──▶ W2 动态组队与改计划 ──▶ W4 经验沉淀
                           ║
                 W1a 统计车道（原 S10 W2a，与 W1 并行）

214 ──▶ P0b ──▶ P1（ChangePlan 核心）──┐
                 AA1（身份与上限）──────┴──▶ W3 管理员 Agent 配置层 ──▶ 决策门 D-W5 ──▶（通过后）W5 代码层
                                     （不依赖 W1，与 W1 并行受并发上限约束）
常驻低优先级车道 L：U2、U1 余项、控制台开放遗留、遗留 123 车道余项、288 / 289 / 290 / 292
```

- 同时在跑的车道不超过三条（周用量上限是硬约束）；内核主线（W1 → W2）一次只开一个 PR 车道，W1a、W3 与 L 车道文件不重叠才并行。
- W3 依赖 ChangePlan 核心（P1）与管理员 Agent 身份（AA1），**不依赖 W1**；管理员 Agent 的长任务在 W1 合入后再跑到 GoalRun 上。
  建议顺序：W0 → W1 与 214 / P0b 并行 → W1 收尾时开 P1 → W2 与 W3 按并发余量交错。
- 每个波次都是"合入 → 发版 → 主机应用 → `STATUS.md` 更新"的闭环；主机窗口时间由维护者定。
- 内核状态、授权、治理核心的 PR 走 xhigh 审查；控制台 PR 走 UX 验收（CI `web-e2e` 绿是前提）；行为在审查后变化的要增量审查。

## 3. S11 总出口（四条都满足才算关闭）

1. 用户发起的多步目标在用户离开、内核重启、重复事件、外部响应丢失、审批跨小时、验收不过、取消与修订、事件进死信这些情况下都走到
   已知状态（W1 场景 S1–S12 在主机通过）；
2. 任务专用的 Worker 组合在授权内直接运行、越权的被拒或转审批，一步失败后规划器换路达成（W2 验收）；
3. 管理员 Agent 在对话里把一个新系统接进生产工作区，人只做录凭证、按段审变更、点应用，且方案 §5.7 的防自扩权守卫全部通过（W3 验收）；
4. `STATUS.md` §3 记一行「S11 关闭」，W4 余项与 W5 决策门的结论按触发条件挂到下一阶段。

## 4. 任务表

### W0 — 收尾与前置

| 编号 | 内容 | 依赖 | 验收 | 审查 |
|---|---|---|---|---|
| 181 | 第三方镜像 digest 每周比对工作流 | 无 | 工作流在 CI 里跑通一次，落后的钉值开 issue | 常规 |
| 218 | 「始终允许」策略与 Operation 定义摘要绑定，修订发布后失效 | 无 | 修订发布后同一动作重新要审批的集成测试 | xhigh |
| 232 | `request_action` 在边界拒绝未知动作名，回显经转义与限长 | 无 | 未知动作名得结构化错误；控制台与审计无原样回显 | 常规 |
| 287（新） | 第一次执行时的网络错误分开处理：发送前失败（连接被拒、DNS）仍判 `failed`；发送后断开、收到响应头后读失败记为结果不明（`in_doubt`），进入重放 | 无 | 夹具门在执行后断开：ActionRequest 停在执行中并进入重放，不判失败；门拒绝连接：判 `failed`，不在队头当屏障 | xhigh |
| 291（新） | `find_workers` 先过滤后截断 | 无 | 被过滤的定义不再占结果名额 | 常规 |
| H1 | 主机窗口：升到当时最新发版，含控制台核对 | 维护者定时间 | `release.md` 对应小节 RESULT ok；控制台核对清单通过 | 主机 |
| C-exit | 控制台阶段关闭 | H1 | `STATUS.md` §3 记「阶段关闭」，余项挂 L 车道 | — |

287 是 W1 的硬前置（推进器要靠 `in_doubt` 区分"没发生"与"不知道"）；其余 W0 项与 W1 并行即可。遗留 229（+228）已由 #575 完成（#578 关闭），
付费实测按维护者已批的一次执行，不再列入本计划。

### W1 — 可靠多步执行（方案 §4、§7.2）

| 编号 | 内容 | 依赖 | 验收 | 审查 |
|---|---|---|---|---|
| GO1 | 数据模型与转移：GoalRun、PlanRevision、StepRun 表与新内核模块；转移表进 `shared/src/transitions.ts`；Task 加 `goal_run_id` / `step_run_id` / `plan_revision` / 尝试号与 RunConfigSnapshot；ActionRequest 记所属 StepRun 与结构化失败类别（门明确拒绝 / 结果不明 / 发送前失败，替代今天只在审计负载里的 `outcome_unknown` 原因）；嵌套子 Task 记录所属 `step_run_id`；新增 `pending_approval → withdrawn`、`approved → withdrawn`；DB 约束与 I-G1 / I-G2 / I-G6 / I-G9 的定时检查 | W0 的 287 | 转移表测试；非法转移被 DB 拒绝；三种失败类别各有一条测试且推进器只按列分流；定时检查有指标输出 | xhigh |
| GO2 | 确定性推进器：`next_tick_at` + 租约认领；outbox 消费者只在自己的短事务里置到期；周期对账扫描；内部 `invokeStep`（与写 StepRun 转移同事务）；推进器建的 Task 关掉 Task 内部重试；每步用 `entryGatekeeperIds` + `computeChildHandleScope` 按请求者当前授权铸 Handle（默认不含派生能力）；新尝试读快照，钉住组件被弃用即本次尝试失败；计划版本 fencing；目标预算（token、步骤数、墙钟）超出即暂停 | GO1 | 场景 S1、S2、S3、S9、S10、S12 的集成测试 | xhigh |
| GO3 | 恢复、等待、取消与修订：步骤范围的动作去重（I-G4，键里 `sid` 换成 `step_run_id`）；`waiting(reconcile)` 与核对观察；等待挂在步骤上（`await_decision` 两条路径）；步骤成功要求名下动作都到终态；暂停 / 继续 / 取消；I-G9：`request_action` 入口检查（含嵌套子 Task），待批与已批动作在写 StepRun 转移的同一事务里改 `withdrawn`，执行侧只靠行状态（`startActionRequestExecution` 的 `FOR UPDATE` + 转移表，排水器不读 StepRun），撤回后发 `ActionRequestUpdated` 触发该门重新排水；`executing` 的动作按 R-48 收尾，`cancelling` 等它们到终态，截止后 `cleanup_pending` 逐条列出；修订移除步骤的默认终止与"让它跑完"（确认修订时逐条放行，其余撤回） | GO2 | 场景 S4、S5、S7（含队头撤回后立即排水、`executing` 结果不明进 `cleanup_pending`）、S8（含嵌套子 Task 被拒、放行一条）、S11 | xhigh |
| GO4 | 验收检查：`observe_predicate`、`fact_predicate`、`requester_confirm`；检查结果写 Observation 作证据；不过即 `paused(needs_decision)`，人可按未达成结束；目标结果依据扩展 `OBJECTIVE_OUTCOME_BASIS_VALUES` | GO2 | 场景 S6；执行者自报与 `agent_reported` 不能给出 `achieved` 的测试 | xhigh |
| GO5 | 能力与入口 prompt：`propose_goal`（handle，带幂等键）、`confirm_goal`（带幂等键）/ `pause_goal` / `resume_goal` / `cancel_goal` / `revise_goal`（human）、`get_goal` / `list_goals`；Procedure 作为计划模板（可选依赖、输入绑定、验收判定式）；入口 prompt 教"何时发起目标、怎么写人能确认的验收" | GO2–GO4 | `pnpm contract:check` 快照更新；fake-llm 旅程：对话发起目标 → 确认 → 完成；同一幂等键重发不重复建、不重复确认 | 常规 |
| GO6 | 控制台：我的目标、确认卡片（验收检查的可读句子、恒真判定式告警、预算）、目标详情（步骤图、等待原因直链审批、版本时间线、验收证据、费用、操作、`cleanup_pending` 残留项）、对话里程碑消息 | GO5 的线上契约 | UX 验收；旅程进 CI（`web-e2e`）；四态与零 403；恒真判定式不能确认 | UX |
| GO7 | 验收与真实数据：主机验收脚本覆盖 S1–S12；维护者选一条自己的日常旅程（遗留 230）作为第一个真实目标；一次付费真实模型回归 | GO1–GO6、H1 后的主机窗口 | 主机脚本全过；真实目标跑完并在控制台可查；付费运行需维护者届时亲口批准 | 主机 |

**W1a — 统计车道（原 S10 W2a，与 W1 并行，文件不重叠）**

| 编号 | 内容 | 依赖 | 验收 | 审查 |
|---|---|---|---|---|
| 48 ② | `propose_skill` / `propose_procedure` 带族 id：修改已发布的 = 同族新版本（S10 决定 10） | 无 | 修改一个已发布 Skill 得到同族 v2；控制台"编辑"预填 | 常规 |
| E2 | Skill / Procedure 版本统计读模型 + 详情页（S10 §5.4） | 48 ② | Skill 页显示使用次数、完成 / 失败、达成率、最近使用 | 常规 + UX |

### W2 — 动态组队与改计划（方案 §4.4、§4.5、§4.10–§4.12）

| 编号 | 内容 | 依赖 | 验收 | 审查 |
|---|---|---|---|---|
| GO8 | WorkerSpec 组合与准入（组合不增权，I-G8）：直接运行 / 需要审批 / 拒绝三种结论与理由；准入后解析成 RunConfigSnapshot；随之决定遗留 288（目标之外的 Worker 默认派生能力） | W1；48 ② | 授权内的组合直接运行；引用草稿 Skill 的转审批；越权的被拒并给原因 | xhigh |
| GO9 | 规划 Worker 与自主修订：推进器在判断点拉起一次性规划 Worker；修订经 I-G3、预算、授权校验后接受；重大修订（扩大预算、加执行类步骤、改验收检查）仍要请求者确认 | GO4、GO8 | 一步失败后规划器提修订换路并达成；修订基于旧版本被拒；改验收检查的修订不经确认不生效 | xhigh |
| GO10 | 目标预算全量：规划器用量计入、修订次数上限、无进展熔断 | GO9 | 连续无进展达到阈值后 `paused(no_progress)` | 常规 |
| GO11 | 任务级观察范围：WorkerSpec 声明的观察允许门集合作为 Task 级排除来源；同一机制供 E3 的 `purpose=evaluation`（S10 I-E1） | W1 | Worker 观察范围外的门得 `excluded_by_policy`（集成测试） | xhigh |
| GO12 | 按"门 × 目标资源"的执行队列：不同目标的写可并行，同一目标保持顺序 | W1 | 一步等审批不挡同门其他目标资源的动作；同一目标顺序不变（R-50 / D-10 测试仍过） | xhigh |
| GO13 | 能力发现增强：`find_workers` 空结果给原因；返回输入输出契约、所需门与可达性、历史成本、版本成效（提示字段，不作排序键）；WorkerDefinition 可选 `inputSchema` / `outputSchema` | E2、291 | 规划器能按契约选 Worker；空结果说明是无匹配、被权限过滤还是被个人设置排除 | 常规 |
| GO14 | 步骤间产物交接：先比较方案 (a) worker-supervisor 只读挂载上游 Task 目录、保留期跟随 GoalRun 与 (b) 内核管理的产物存储，建议先做 (a) | GO1 | 上游 Worker 产出的文件下游可读；其他目标读不到；保留期到期后清理 | xhigh |
| GO15 | 控制台：WorkerSpec 详情（与定义的差异、准入结论与理由）、规划修订差异 | GO8、GO9 | UX 验收 | UX |

### W3 — 管理员 Agent 配置层（方案 §5，含原 S10 W2b）

| 编号 | 内容 | 依赖 | 验收 | 审查 |
|---|---|---|---|---|
| 214 | 自连门的"重新描述 → 预览差异 → 开修订"路径 | 无 | 门用新 base 重建后可在产品内同步，不再一律 409 | 常规 |
| P0b | 连接器接入路径统一 + 评测用夹具门重设计 + 遗留 118 残余 ①（S10 §7） | 214 | 只剩一条落地路径；验收夹具改用新路径后 S2 / S3 仍过 | xhigh |
| P1 | **（改造）ChangePlan 核心**：按授权分段（工作区段先做，平台组件做"是否已就位"检查）、段内单事务、干跑差异、白名单授权扩大分类器（对 ChangeItem 全字段逐字段比较；`operationGovernanceChangeDirection` 只判治理三字段的方向，`neutral` 不算证明）、段级内容摘要绑定（I-A8；工作区段绑定所依赖平台段的摘要，在应用事务里复查，沿用 `enable_gate_instance` 的 `manifestDigest`）、工作区段的校验与差异只在该工作区 owner 的会话里、验证、逆操作（先比较再写；回滚按反向依赖）；Pack Contract v1 作为第一种来源 + ops-base 包；模块成为单组件包（S10 §6）。**验收含 P2 knowledge 包（原 S10 W3）**：手写包走同一 ChangePlan | P0b | 一个包经计划 → 段内单事务安装 → 验证；手写 knowledge 包走同一路径；失败本段整体回滚；审阅后内容变化的段、或所依赖平台段之后改过的工作区段，应用得 409；逆操作遇到中间被别人改过的版本时停下不覆盖；有已应用的依赖段时平台段回滚被拒；表驱动测试：执行类 Operation 的 `binding`、`params_schema`、门侧固定参数、`reversibility`、`await_decision`、MCP `destructive_hint` / `idempotent_hint` 各自单独变化（治理三字段 `neutral`）时都标授权扩大；平台面与管理员 Agent 的读接口看不到工作区段的校验细节 | xhigh |
| AA1 | 管理员 Agent 身份与上限：`ADMIN_AGENT_CEILING` 常量、来源绑定 Handle、每次调用检查平台管理员身份（I-A1–I-A3）；CI 守卫断言上限不含 human 通道 / 审批 / 授权 / 策略类与代码托管类能力 | 无 | 守卫测试：其 Handle 调 human 通道与平台写能力得 403；管理员降级后下一次调用即失效 | xhigh |
| AA2 | 平台状态只读投影（handle 通道，脱敏）：门实例与健康、连接器三态、运行层盘点、版本提醒、不变量指标、平台审计摘要 | AA1 | 投影字段无凭证与内网地址细节（测试）；非管理员 Agent 的 Handle 调不到 | xhigh |
| AA3 | 试验工作区 + `propose_change_plan` + 平台段：自指校验、无凭证 schema、段内单一授权主体、平台段由平台管理员在平台面应用、工作区段绑定平台段应用时的摘要并在应用事务里复查、平台段回滚按反向依赖；起草者溯源沿用 `origin` / `proposer_kind`（关闭遗留 293） | P1、AA1、AA2 | 自指与含凭证的 ChangePlan 被拒；跨授权主体的段被拒；授权扩大项不能一键应用；部分应用状态可见；审计里起草者与批准人分开 | xhigh |
| AA4 | 控制台：管理员 Agent（对话、目标、在途提案）、变更计划（平台段的差异、分类、逐项确认、证据、应用、验证、回滚；工作区段在平台面只显示状态与理由；部分应用）；生产工作区 owner 在该工作区看到待自己确认的工作区段，差异与逐项确认只在这里 | AA3 的线上契约 | UX 验收；旅程进 CI；平台面页面不出现工作区段的差异 | UX |
| AA5 | 验收旅程：管理员 Agent 接入一个有 OpenAPI 的夹具工单系统（方案 §5.8，平台段 + 工作区段） | AA1–AA4 | 端到端：人只录凭证、按段审变更、点应用；产出的 ChangePlan 可导出为包并在另一工作区安装 | 主机 |
| AA6（可选） | OpenMetadata 包（原 S10 P3），由管理员 Agent 产出 | AA5 | 在 OM 测试实例上跑一条血缘影响分析旅程 | 常规 |

### W4 — 经验沉淀

| 编号 | 内容 | 依赖 | 验收 | 审查 |
|---|---|---|---|---|
| E3 | Skill 评测 MVP（S10 §5.5），观察隔离用 GO11 | GO11、E2 | S10 G4：草稿发布页显示判定；评测期间真实门零调用 | xhigh |
| GO16 | 沉淀提议：反复验证有效的 WorkerSpec 组合提议为 WorkerDefinition（带成效统计），走现有发布 | GO8、E2 | 一个组合被提议并经人发布，之后 `find_workers` 能找到 | 常规 |
| GO17 | 先例与经验召回：入口上下文的 `precedents`、规划器可读的同类目标历史 | W2 | 同类目标第二次规划时引用了第一次的计划与结果 | 常规 |
| GO18 | `review` 类验收：独立评审 Worker 按评分标准判定，判定推导对人可见 | E3 | 一个质量类目标由评审判定，推导在控制台可查 | 常规 |

### W5 — 管理员 Agent 代码层（待定，方案 §5.5）

| 编号 | 内容 | 依赖 | 验收 | 审查 |
|---|---|---|---|---|
| D-W5 | **决策门**（维护者）：① 明确取代 S10 I-N1 与"代码自修改明确不做"，写进 S10 方案与 STATUS 的决定记录；② 有一个任何 agent 会话都拿不到的审批身份，并由仓库规则强制（只给人用的独立账号作为必需审查者，或 ruleset 的 bypass 列表排除所有 agent 令牌；合并线程的直合授权不覆盖 agent 起草的代码 PR） | W3 | 两条前提都满足并记录；任一不满足则 W5 不开工 | 维护者 |
| AA7–AA10 | 通过后再排：代码 Worker 与运行位置；代码托管门（fork 写权限、无 workflow 与合并权限）与 ChangeProposal；受保护路径默认拒绝 + 低风险白名单 + `pull_request_target` 工作流守卫；部署请求准备 | D-W5 | 决策门通过后另定 | — |

W0–W4 不依赖 W5；在此之前，管理员 Agent 在配置层表达不了的改动，照今天的做法由人在外部 agent 线程里改。

### L — 常驻低优先级车道

| 编号 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| U2 | 运行时一致性套件（S10 §4.3） | 无 | 进 CI；下次 pi 升级手册的"人工"行有 CI 证据 |
| U1 余项 | 侧栏提醒点、四版本并排（S10 §4.2） | 无 | UX 验收 |
| 控制台余项 | 控制台开放遗留以 `STATUS.md` §4 为准（当前含 278、294–297 等）与字段缺口 | 无 | 各自的 UX 验收 |
| 123 车道余项 | 按文件跟随改到同一批文件的任务（S10 §7.1） | — | 车道清空后关 123 |
| 288（新） | 决定目标之外的 Worker 默认是否保留 `invoke_worker` / `find_workers`；若改，写明迁移语义 | 随 GO8 决定 | 决定记入 STATUS；若改，集成测试覆盖未声明的定义 |
| 289（新） | 崩溃重试的 Handle 沿用失败那次 run 的能力与门列表（执行已由 R-37 复核） | 无 | 重试后工具列表不含已收回的门 |
| 290（新） | Task 计时不因 `waiting_approval` 暂停（目标之外的 Task） | 无 | 长审批的 `await_decision:true` Task 不因计时超时失败，或文档写明这是有意 |
| 292（新） | 文档漂移余项：`platform-extension` README 与 `entry.ts:55-57` 注释、`kernel/src/index.ts:274` 的 90 s 注释 | 无 | 文档与代码一致 |

### 推迟（触发后再做）

| 编号 | 内容 | 触发条件 |
|---|---|---|
| E4 | 入口 agent 个人记忆试点（S10 §5.7） | W3 完成后重评 |
| E5 / E6 | 治理调优建议、本体缺口提议 | E2 跑满两个波次 |
| 10 | Trigger（届时直接创建 GoalRun）、`extension_ui_request`、CLI 清单解析 | 出现需要定时或事件发起的目标 |
| S9 D3 | 干净主机安装首跑 | 第一个外部企业部署之前 |
| 102 | 异地备份 | 维护者重新决定 |

## 5. 新增遗留（287–293 已为本计划预留，合入后由合并线程写入 `STATUS.md` §4）

| # | 项 | 级别 | 归属 |
|---|---|---|---|
| 287 | 第一次执行时的网络错误一律记成普通 `failed`：发送前失败可以安全判失败，发送后断开与收到响应头后读失败应为 `in_doubt`（`application/gateway/action-executor.ts:219-235,353`；`adapters/gatekeeper-client/index.ts:455,487`） | P1 | S11 W0（W1 硬前置） |
| 288 | 决定：Worker 默认能力是否保留 `invoke_worker` / `find_workers`（`governance/capability/handles.ts:208-213`；`application/task/handle-mint.ts:399-401`）。S2.7 有意的嵌套派生设计，不是缺陷；容器内可直接调用为推断；若改，写明没写 `capabilities` 的已有定义会少掉 `invoke_worker`。目标内的步骤 Handle 已默认不含 | P3 | S11 W2 GO8 决定 |
| 289 | 崩溃重试的 Handle 沿用失败那次 run 的能力与门列表（`application/task/lifecycle.ts:611-713`）；执行已由 R-37 / D-20 按当前授权复核（`application/gateway/request-action-handler.ts:1343-1359`），残余是非执行类能力与工具列表 | P3 | L |
| 290 | Task 时长计时不因 `waiting_approval` 暂停（只影响 `await_decision:true`），长审批让 Task 超时失败（`application/task/reaper.ts:343-358`）；目标内步骤不受影响 | P3 | L |
| 291 | `find_workers` 的 `limit` 在权限与状态过滤之前执行（`substrate/graph/find-means.ts`；`application/task/service.ts:565-604`） | P3 | S11 W0 |
| 292 | 文档漂移：`packages/platform-extension/README.md` 与 `modes/entry.ts:55-57` 说 `find_workers` / `invoke_worker` 尚未注册；`kernel/src/index.ts:274` 注释说 `await_decision` 默认超时 90 s，常量是 25 s。设计文档 §7.4 的两行已随本计划的 PR 改正 | P3 | L |
| 293 | Skill / Procedure / WorkerDefinition 草稿分不出 agent 起草（Operation 有 `origin`、本体有 `proposer_kind`，这三类没有；`application/gateway/dispatch.ts:140-141,147`） | P3 | S11 W3 AA3 |
