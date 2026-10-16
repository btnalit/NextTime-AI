# 目标级编排与平台管理员 Agent：方案（2026-10-16）

> 依据：维护者 2026-10-16 提出的两件事——①「新目标 → 分解任务 → 按需组建多个 Worker → 建立协作依赖 → 根据执行结果调整分工和流程
> → 验证完成」作为核心执行主线（附维护者与 GPT 的分析原文）；② 管理员自己的 AI agent 要有权限、有能力改造优化整个平台（例如自己
> 集成对接一个新系统），不必每次靠外部 AI agent。
> 本文是**方案与待决记录**，不是现状说明书；现状以代码与 `STATUS.md` 为准。提议的组件在本文里一律写作"新增 / 提议"，不写成已存在。
> 标注：**已核实**（读到 main `61d5735` 的代码、迁移或测试，给出 `文件:行`）、**推断**（未运行验证）、**建议**。
> GPT 的分析基于 `07775fe`；两者之间的提交（#550–#576）只动了控制台、部署脚本、敏感值清洗与入口缓存，没有改任务、审批、编排语义，
> 以下核实全部在 `61d5735` 上做。行号以该提交为准。
> 编号：本文不带阶段前缀的 W0–W5 指建议新阶段 S11 的波次，任务号（`G*` 目标级编排线、`A*` 管理员 Agent 线、遗留号）与依赖、验收见
> `global-roadmap-2026-10-16.md`；S10 的波次一律写全称（S10 W2a 等）；目标编号 O1–O8 与任务号是两套。

## 0. 结论先行

1. **方向成立，但问题要重新定性**（已核实）：平台缺的不是"能拉起更多 Worker"，而是**"推进"这件事没有所有者**。今天的计划只活在入口
   agent 的对话里，`TurnStarted` 只在人发消息时产生（`application/chat/service.ts:584`），Task 结束只写一条待读上下文、等用户下次开口
   （`application/linkage/task-consumer.ts:119-147`；`ontology/entry-agent.yaml:184-187`）。所以第一步是让平台持有"目标"和"推进"
   （GoalRun + 确定性推进器），动态组队排第二。
2. **GPT 的事实判断在当前 main 上基本都成立**（§2 逐条），但有三处说轻了，恰好都会让"多 Worker 持续协作"失败：
   - 审批等待最常见的结局不是"崩溃不重试"，而是 Worker 等 25 秒拿到 `pending_approval` 后交结果退出，批准后的动作由排水器脱离 Worker
     执行——**依赖这个动作的后续工作直接丢失**，没有任何东西会续上；
   - Worker 不注册 `invoke_worker` 只是工具列表的约定：内核默认把 `invoke_worker` / `find_workers` 放进 Worker 的 Handle，容器调内核
     不需要凭据（来源绑定），所以容器里的 shell 可以直接派生 Worker（推断，未运行）。"谁来组队"今天不是平台说了算；
   - 第一次执行时的网络错误被记成普通 `failed`，而外部效果可能已经发生——"失败"不等于"没发生"。
   GPT 还漏了：崩溃重试沿用旧 Handle 的范围、不重查当前授权；outbox 没有延时投递，消费者在投递事务里同步执行。
3. **管理员 Agent 不能做成"给 agent 管理员权限"**，而是"能提议平台变更的 agent + 一条把提议变成生效的受治理通道"。分三层：
   **配置层**（数据：接入、Operation 分类、WorkerDefinition、Skill、本体，走一个可干跑、可整体回滚的变更计划 ChangePlan）、**代码层**
   （生成代码、开 PR，进现有 CI + 审查 + 合并管道）、**部署层**（主机与生产仍由维护者执行，S10 决定 3 不变）。今天的系统边界正好是它的
   地基：Handle 结构上带不了 human 通道能力（`governance/capability/handles.ts:82-94`），平台面只认管理员的控制台会话
   （`application/gateway/authorize.ts:89-98`）。唯一的捷径陷阱是 owner 角色的 service API key——它走 human 通道，能直接改策略和授权
   （`governance/approval/decide.ts:162-179` 的注释自己承认），管理员 Agent **明确不走这条**。
4. **两件事其实是一件事**：管理员 Agent "接入一个新系统"本身就是一个多步目标（探索 → 分类 → 起草 → 试验 → 评测 → 提交变更 → 等批 →
   应用 → 验证），它跑在 GoalRun 上，产出是 ChangePlan。所以顺序是：GoalRun 可靠执行（S11 W1）→ 动态组队（W2）与 ChangePlan + 管理员
   Agent 配置层（W3，由 S10 W2b 的 Pack v1 改造而来）→ 经验沉淀（W4）→ 代码层（W5）。
5. **与现有路线**（§6）：在途的 #575（遗留 229）与控制台阶段收尾不变；S11 W1 接在它们之后成为下一个内核主线；S10 W2a（48 ② + E2）可并行；
   S10 W2b 的 Pack v1 改造为 ChangePlan 核心并承接管理员 Agent 配置层；P2 knowledge 包、P3 OpenMetadata 包让路为 W3 的验收场景，E4 个人
   记忆推迟；E3 评测排到 W2 之后；设计文档 P5 的"Workflow 引擎 / turn 挂起式审批"由 GoalRun 吸收，Trigger 仍按遗留 10 推迟。
   排号、依赖与每项验收见 `global-roadmap-2026-10-16.md`（阶段名 S11 是 §10 F1 的推荐项）。
6. 待维护者拍板的分叉见 §10，每条都有推荐项。

## 1. 背景与目标

维护者原话要点（2026-10-16）：

- "新目标 → 分解任务 → 按需组建多个 Worker → 建立协作依赖 → 根据执行结果调整分工和流程 → 验证完成……这个是我要的一个非常重要功能。"
- "管理员的独立 AI agent 应该要有权限和能力去改造优化我们整个平台的，比如让它集成对接某个系统，不能每次都要用外部 AI agent 去改造它。"

目标（可验证）：

| # | 目标 | 验证 |
|---|---|---|
| O1 | 一个目标在用户不再发消息时也能推进到结束（完成、暂停待人或取消），不依赖某次对话或某个容器活着 | §7.2 场景 S1、S2 |
| O2 | 每一步为什么开始、在等什么、用了什么配置、花了多少，平台能答出来；计划改过几次、为什么改，有版本 | 控制台目标详情页；读模型 |
| O3 | 外部动作在同一个业务步骤里至多执行一次，除非有留痕的"重新执行"决定；结果未知时先核对再决定 | 场景 S3、S4 |
| O4 | 目标"做完了"只由平台执行的验收证据判定，执行者的自报不能宣布达成 | 场景 S6 |
| O5 | 任务专用的 Worker 组合（WorkerSpec）只在不扩大权限时直接运行，扩大权限的部分走审批或发布 | S11 W2 验收（G8） |
| O6 | 管理员 Agent 能在对话里把一个有 OpenAPI 或 MCP 的新系统接进来：从探索到生产工作区可用，人只做三件事——录凭证、审变更、点应用 | S11 W3 验收旅程（A5） |
| O7 | 管理员 Agent 提的代码改动以 PR 进入现有管道，CI 与审查不可绕过，合并与部署仍由人 | S11 W5 验收（A8、A9） |
| O8 | 管理员 Agent 不能扩大自己的权限：改它自己的能力上限、策略或授权都需要人、且需要不止一道人工关口 | §5.7 的守卫测试（A1、A3） |

非目标（本方案内不做）：代码 / prompt 的自修改与自动合入（S10 I-N1 继续有效）；控制台内一键升级平台（S10 决定 3）；agent 改 Policy / Grant；
多部署控制面与应用市场（`development-tasks.md` §5f"明确不做"）。

## 2. 现状（Current Reality）：逐条核对 GPT 的结论

### 2.1 核对表

| # | GPT 的结论 | 核对 | 证据（`packages/` 下，除非另注） | 判断 |
|---|---|---|---|---|
| 1 | Task 绑定一个 WorkerDefinition，WorkerRun 是一次执行尝试；`parent_worker_run_id` 记谁派生谁，表达不了"C 等 A、B" | 已核实 | `kernel/migrations/task/0001_tasks.sql:55-56,101-102`；`0003_task_worker_run_lineage.sql:43,48`（depth ≤ 3、attempt ≤ 2） | 对。另有一个静态的 Procedure（有序步骤，`shared/src/procedure.ts`），步骤间没有依赖与数据绑定，**没有任何东西执行它**（注释写明是 P5 的 Workflow 引擎） |
| 2 | `invoke_worker` 只接受已发布定义 | 已核实 | `kernel/src/application/task/invoke.ts:481`；`application/worker/definitions.ts:411-425`；参数 `.strict()` 无内联配置（`shared/src/capabilities.ts:2187-2215`） | 对 |
| 3 | 结果契约有 summary / findings / 事实 / 证据 / 产物；产物是路径加可选内联文本，单个 32,000 字符、最多 8 个；没有步骤级输入输出 Schema 与下游绑定 | 已核实 | `shared/src/worker-result.ts:112-126,148-158` | 对；上限是每个产物各 32,000。补充：产物路径随容器消失，下游拿不到文件本身 |
| 4 | Task 的目标结果与执行状态分开，由入口 agent 上报，`agent_reported` | 已核实 | `kernel/migrations/task/0006_objective_outcome.sql`；`report_task_outcome` 只在入口上限内（`governance/capability/handles.ts:131-134`）；`application/task/attribution.ts:408,420` | 对；且**没有任何东西据此行动**：没有事件、不拦完成、不触发重排，只能在 Task 终态后标注 |
| 5 | 动作幂等键含会话身份，崩溃重试换新会话，所以不能跨 WorkerRun 去重 | 已核实 | `application/gateway/action-executor.ts:125,139`；`request-action-handler.ts:1263-1280`；`kernel/migrations/governance/0014_action_request_idempotency_window.sql:36-44` | 对；显式键也带 `sid` 前缀，派生键只在动作未终结时去重 |
| 6 | 重试重新解析 Skill、模型、平台指令、运行镜像，同一任务的不同尝试可能配置不同 | 已核实 | `application/task/lifecycle.ts:670-697` | 对；WorkerDefinition 版本是钉住的。补充：只在非零退出时重试一次；**授权沿用旧 Handle 的范围，不重查当前 Grant**（`lifecycle.ts:639-713`） |
| 7 | 有 `waiting_approval`，但审批等待不是持久的流程挂起；Worker 受运行时限约束；等待中崩溃不走普通重试 | 已核实 | `lifecycle.ts:508-513`；`task/reaper.ts:343-358`（计时不因等待暂停）；`gateway/request-action-handler.ts:224`（等 25 s） | 对，但**说轻了**：常见路径是 Worker 25 s 后拿到 `pending_approval` 交结果退出（`platform-extension/src/modes/worker.ts:42-47,88`），批准后动作由排水器执行（`gateway/action-request-drain-consumer.ts:60-75`），`resumeTaskFromWaitingApproval` 见 Task 已终结直接返回（`reaper.ts:115`）——后续工作丢失。WorkerRun 的 `suspended` 状态无生产代码使用 |
| 8 | `find_workers` 主要按名称、描述关键词匹配，再过滤发布状态与权限；找不到时没有原因 | 已核实 | `kernel/src/substrate/graph/find-means.ts:186,214-239`；`application/task/service.ts:565-604`；`gateway/handlers.ts:1787` | 对。补充：SQL 的 `limit 20` 在过滤之前执行；WorkerDefinition 没有输入输出类型、成本、成效字段（`shared/src/worker-definition.ts:50-64,141-146`） |
| 9 | 默认 Worker 扩展只暴露门工具与 `report_result`，没把 `find_workers` / `invoke_worker` 注册成 Worker 工具 | 已核实 | `platform-extension/src/modes/worker.ts:411,519`；`worker.test.ts:103,135` | 工具层面对，**治理含义说反了**：内核把两者放进 Worker 默认能力（`governance/capability/handles.ts:208-213`；`application/task/handle-mint.ts:399-401`），深度到 3 都合法（`invoke.integration.test.ts:254-288`）；容器调内核不带凭据（`shared/src/handle-binding.ts` 文档注释第 2 条），shell 可直接调（推断，未运行） |
| 10 | 有单 Task token、时长、用户并发、工作区每日预算；没有整个目标的预算 | 已核实 | `application/task/quotas.ts:29-57`（200k token、3600 s、每用户 5 个、日费用默认不限）；`BudgetWarning.scope='turn'` 定义了但从不产生（`linkage/budget-consumer.ts:17-21`） | 对 |
| 11 | 同一个门的执行队列会被前面的待审批或执行中动作阻塞 | 已核实 | `kernel/src/governance/approval/drainer.ts:139-140`；`approval/reads.ts:362-375` | 对；队列按（工作区 × 门），待审批的队头最长挡 24 h（`approval/execution.ts:83`），结果不明的执行中队头最长约 25 min |
| 12 | 门主要收窄执行权限，观察另走工作区与个人策略；没有任务级观察范围 | 已核实 | `application/gates/observe-access.ts:11-42,120-135` | 对。S10 I-E1 为评测设计的 `purpose=evaluation` 观察允许集合同一缺口，**设计了未实现**（E3 未开工），应只做一次 |
| 13 | 入口的 `precedents` 返回空数组 | 已核实 | `gateway/handlers.ts:789-797`（注释 `:751`） | 对；`find_precedents` 存在但不在入口上限内。设计文档 §7.4 曾写入口上下文含"可用的门与 Procedure 摘要"，实际没有（文档漂移，随本方案的 PR 改正） |
| 14 | PostgreSQL、Outbox、Task 状态机可作为第一版基础 | 已核实 | `kernel/migrations/core/0005_outbox.sql`；`application/outbox/dispatcher.ts:106-108` | 对，有三个限制：outbox 没有延时投递列；消费者在投递事务里执行，慢消费者拖住全平台投递；假定内核单进程（遗留 130） |
| 15 | 现有代码已有发现、委派、容器执行、审批与结果记录 | 已核实 | 同上各项 | 对 |

### 2.2 GPT 没提到、但会直接影响设计的事实

| 事实 | 证据 | 影响 |
|---|---|---|
| 没有任何路径能在没有用户消息时启动入口 agent 的 Turn；一个对话同一时刻只有一个 Turn | `chat/service.ts:76,584`；`send_chat_message` 是 human 通道 | 推进不能靠"唤醒入口 agent"，要么合成 Turn（新增生产者 + 处理对话并发），要么推进器不依赖入口 agent（§4.1 选后者） |
| 结果不明的动作：门超时 → `executing`（障碍）→ 经门的幂等存储重放至多 3 次 → `failed`，原因 `outcome_unknown` 只在审计负载里，没有列；没有"查询原动作"的能力；`compensate` / `verify` 转移没有生产调用者 | `action-executor.ts:221-224,339-349,371-419,475-522`；`approval/execution.ts:216,377-379,386`；`gatekeeper-base/src/errors.ts:55-70` | 业务层的"先核对再决定"要新建；门协议里没有"查询某次 apply 的结果"，只能用领域观察核对 |
| 第一次执行时 apply 中途的网络错误记成普通 `failed`，效果可能已发生 | `action-executor.ts:353`；`gateway/gatekeeper-client/index.ts:455,487` | 推进器不能把 `failed` 读成"没发生"；应修成 `in_doubt`（列为新遗留，§6.2） |
| 提议的作者记成人：agent 经 Handle 提的草稿 `proposed_by` 是 `on_behalf_of` | `gateway/dispatch.ts:147`；`task/result.ts:433-434` | 管理员 Agent 的产出在溯源上与人自己写的分不开；要加"由哪个 agent 运行时起草"的字段 |
| service Principal 的 API key 走 human 通道、按角色授权；可以建 owner 角色的 service Principal | `gateway/resolve-caller.ts`；`shared/src/capabilities.ts:2680-2688`；`approval/decide.ts:162-179` | 这是"agent 绕过人"的唯一现成捷径，管理员 Agent 必须不走它（I-A1） |
| 观察类调用有副作用：写 Observation、Fact、Activity | `shared/src/capabilities.ts:740-753` | 管理员 Agent 的试探性观察会写进工作区图——试验应放在试验工作区（§5.2） |
| 审计 append-only 由触发器保证，与被审计的写同事务 | `kernel/migrations/core/0004_audit.sql:37-52`；`gateway/dispatch.ts:352-398` | 新对象的每次转移直接复用 |
| 只有 I4、I6、I7、I11–I14、I16（加 I2 静态）有定时检查；I17–I19 没有 | `kernel/src/substrate/audit/invariant-checks.ts:686-740` | 新不变量要同时给出定时检查，不能只写在文档里 |

### 2.3 可以直接复用的基础（已核实）

Task / WorkerRun 与转移日志（每次转移发 `TaskUpdated`，`task/transition-log.ts:41,71`）；ActionRequest 状态机、按门串行的排水器、审批按范围路由
（I14）、R-17"人才能批高影响与不可自动批准的动作"；结果契约与 `propose_*` 提议链；E1 归因（`worker_run_skills`、Turn 的 Procedure 声明、
Turn / Task 目标结果）；outbox 至少一次投递；审计同事务；来源绑定的 Handle（I19，Handle 不进容器）；`platform_settings` 保留上一版；
控制台的确认分级与「已核对凭据」二次确认（#526）。

## 3. 领域模型

不重开 `graph-ai-middle-platform-design.md` §5 的模型，只在执行层与治理层增量。命名沿用现有词汇；新增概念均为**提议**。

### 3.1 新概念

| 概念 | 属于 | 含义 | 与现有概念的边界 |
|---|---|---|---|
| **GoalRun** | Governance（执行） | 一个被接受的目标：目标陈述、约束、验收条件、预算、请求者（`on_behalf_of`）、当前计划版本、执行状态与目标结果 | Turn 是一次对话轮次；GoalRun 的寿命独立于对话和容器。一个 Turn 可以发起 0..1 个 GoalRun |
| **PlanRevision** | Governance | 计划的一个不可变版本：步骤、依赖、每步的 WorkerSpec 与输入绑定、验收检查；记基于哪个版本、谁提的、为什么、平台校验结果 | 不复用 Decision：计划修订有自己的校验与 fencing 语义；重大修订另记一条 Decision 供 `explain` |
| **StepRun** | Governance | 计划里的一个业务步骤：依赖、输入绑定、输出 Schema、状态、尝试次数、失败分类；由 0..N 个 Task 执行 | Task 是一次委派（含至多两次 WorkerRun 尝试）；StepRun 是业务步骤，跨 Task 保持身份 |
| **WorkerSpec** | Governance | 一次 Task 实际生效的 Worker 配置快照：来源（`definition@version` 或组合）、职责说明、Skill `id@version`、门与 Operation 子集、模型、`instanceInstructions` 摘要、运行镜像 digest、预算、停止条件、输出 Schema | WorkerDefinition 是可复用、经发布的模板；WorkerSpec 是这一次的快照。**W1 就引入**（重试用快照而不是重新解析），W2 才允许"组合"来源 |
| **AcceptanceCheck** | Epistemic | 验收条件的一项：`observe_predicate`（一个观察类 Operation + 参数 + 对结果的判定式）、`fact_predicate`（图上事实 + 新鲜度）、`requester_confirm`、`review`（独立评审，W4） | 执行者自报不是一种验收（I-G5） |
| **业务动作身份** | Governance | StepRun 内一个外部动作的稳定身份：（GoalRun, StepRun, 门, Operation, 目标）；关联到它产生的 ActionRequest | 现有幂等键是"同一会话同一调用"，不是业务身份 |
| **ChangePlan / ChangeItem** | Governance | 一组对平台或工作区配置的意图变更：每项 ChangeItem 是对一个现有发布 / 配置能力的调用意图（参数不含凭证）、干跑差异、权限影响分类、逆操作；整体审阅、整体应用 | 能力包安装计划是 ChangePlan 的一种来源；管理员 Agent 的提案是另一种 |
| **ChangeProposal（代码层）** | Governance | 一个代码改动提议的平台侧记录：仓库、分支、PR 引用、头提交、CI 与审查状态、关联的 GoalRun | Git 与 PR 是真源；平台只存引用与状态快照 |
| **管理员 Agent** | 主体 | 由平台管理员启动、代表该管理员（`on_behalf_of`）运行的 agent 实例；能力上限是代码里的常量 `ADMIN_AGENT_CEILING` | 与入口 agent 同一运行时与镜像，不同的能力上限、不同的对话与容器 |
| **试验工作区** | World | 管理员 Agent 探索与试运行用的普通工作区（RLS 隔离），生产工作区的变化只经 ChangePlan 进入 | 不是 2026-09 否决的"平台工作区"（那是身份方案）；它没有特权 |

### 3.2 关系

- `GoalRun requested_by Principal`（人）；`GoalRun originated_in Turn`（0..1）；`GoalRun current PlanRevision`（1）；`PlanRevision based_on PlanRevision`（0..1）。
- `StepRun introduced_in PlanRevision`；`StepRun superseded_in PlanRevision`（0..1）；`StepRun depends_on StepRun`（N:M，无环）；`StepRun input_from StepRun.output`（带路径）。
- `Task executes StepRun`（N:1，带 `plan_revision`）；`Task ran_with WorkerSpec`（1:1）；`ActionRequest raised_in StepRun`（经 Task）。
- `AcceptanceCheck belongs_to GoalRun | StepRun`；`AcceptanceCheck evidenced_by Observation`（平台执行检查时产生）。
- `ChangePlan proposed_by 管理员 Agent`（运行时）`on_behalf_of` 人；`ChangePlan approved_by` 人；`ChangePlan applied_by` 人的会话；`ChangeItem targets` 对象（门实例、Operation、WorkerDefinition、Skill、本体族、平台设置项）。
- `Object changed_by ChangeItem`（溯源，与 S10 的 `installed_from` 同构）。

**永不允许**：
- 执行某步骤的 Task 给同一 GoalRun 的验收检查打分（执行者 ≠ 验收者）；
- WorkerSpec 的能力范围超出请求者当前的入口范围与 Grant 的交集；
- ChangePlan 含凭证值、Grant 或 Handle；
- 管理员 Agent 的 ChangePlan 修改约束它自己的定义、能力上限、策略或其所在的试验工作区授权（自指）；
- 管理员 Agent 持有 human 通道能力或 `scope:'platform'` 的写能力；
- 晚到的、属于已被取代计划版本的 Task 结果推进新版本的步骤。

### 3.3 不变量（新增）

| # | 不变量 | 机制 |
|---|---|---|
| I-G1 | 每个 StepRun 的每次尝试至多对应一个 Task | `tasks (step_run_id, attempt)` 唯一索引；推进在同一事务里写 StepRun 转移与 Task |
| I-G2 | 只有当前计划版本的步骤能被推进；旧版本 Task 的结果入库、入审计，但不改变步骤状态 | Task 带 `plan_revision`；推进时比较（fencing），不一致只记录 |
| I-G3 | 计划修订基于当前版本（乐观并发），无环、引用可解析、在预算内 | 修订校验函数；`based_on ≠ current` 拒绝（同本体 R-60 的做法） |
| I-G4 | 同一步骤内，一个业务动作至多执行一次，除非有显式、留痕的"重新执行"决定 | 步骤范围的动作去重（跨 WorkerRun、跨状态）；`outcome_unknown` 先核对；重新执行需要人或（W2）规划器提议 + 平台接受 |
| I-G5 | 目标结果 `achieved` 只能由平台执行的验收检查或请求者确认给出，执行者自报只记为 `agent_reported` | 验收由推进器发起，用请求者的观察权限；`report_task_outcome` 继续只在入口上限内 |
| I-G6 | GoalRun 累计花费、步骤数、修订次数、墙钟时长不超过预算；超出即暂停，不是失败 | 推进前检查；`paused(budget_exhausted)` |
| I-G7 | 每一步开始时按请求者**当前**授权铸 Handle；授权缩小后不再开始新步骤 | 铸 Handle 时重算（修正重试沿用旧范围的问题）；`paused(authority_lost)` |
| I-G8 | WorkerSpec 组合不增权：直接运行的组合只能由已发布组件、请求者已有的门与模型构成 | 准入函数（§4.4），拒绝或转审批 |
| I-A1 | 管理员 Agent 永远是提议者，不是授权者：它的 Handle 不含 human 通道能力，不能调 `scope:'platform'` 写能力；它不是 service API key | 现有 `assertValidScope` 与 `authorizeCapabilityCall`；新增守卫测试；身份用 Handle（来源绑定），不签 API key |
| I-A2 | 管理员 Agent 的能力上限只在代码里，改它需要代码层 + 维护者审 + 维护者部署三道人工关口 | `ADMIN_AGENT_CEILING` 常量 + CI 守卫断言上限不含 human 通道 / 审批 / 授权 / 策略类能力 |
| I-A3 | 管理员 Agent 的权力随人：每次调用检查其 `on_behalf_of` 的用户当前仍是平台管理员 | 调用时检查（不是签发时）；降级或停用立即失效 |
| I-A4 | ChangePlan 里的授权扩大项（策略、「始终允许」、`auto_approvable`、MCP `vetted`、连接器三态放宽、允许模型、出网放行、`instanceInstructions`）逐项人工确认，且不能随其他项一键应用 | 确定性分类器给 ChangeItem 打 `authority_widening`（不信 agent 自己的标注）；应用接口要求逐项确认，审计记录 |
| I-A5 | ChangePlan 不含凭证值；凭证只由人直接录入门宿主或 llm-proxy | ChangePlan schema 无凭证字段 + #526 的疑似凭据计数 |
| I-A6 | 管理员 Agent 的探索只发生在试验工作区；生产工作区只经已应用的 ChangePlan 改变 | 它在生产工作区没有 Principal |
| I-A7 | agent 起草的东西在溯源上可区分：作者运行时与批准人分开记录 | 草稿与 ChangePlan 加 `drafted_by_runtime`；审计记录两者 |

### 3.4 状态机

**GoalRun**（执行状态与目标结果分开，沿用 S10 的做法）：

```
proposed ──confirm(人)──▶ running ⇄ paused ──▶ verifying ──▶ completed
    │                       │  (原因：人要求 / 预算 / 无进展 / 授权失效 /      │
    └─expire / reject─▶ cancelled   需要决定 / 待核对)                       └─验收未过─▶ paused(needs_decision)
                    running / paused ──cancel(人)──▶ cancelling ──▶ cancelled
                    任意非终态 ──引擎不可恢复错误──▶ failed
```

目标结果 `unknown → achieved | not_achieved`，带依据（`verified_by_check` / `requester` / `reviewer_assessed`）；`completed` 可以是
`not_achieved`（人选择按未达成结束），但 `achieved` 只能来自 I-G5 的依据。

**StepRun**：`pending`（依赖未满足）→ `ready` → `running`（有 Task 在跑）→ `waiting`（子原因：`approval` / `reconcile` / `external`）→
`running` → `succeeded`（输出通过 Schema 校验）| `failed`（带失败分类，§4.7）；`superseded`（被修订移除、尚未开始或已取消）、
`cancelled`、`skipped`。`failed` 且分类为可重试、尝试次数未满 → 回到 `ready`。

**ChangePlan**：`draft → submitted → validated | invalid → approved | rejected | expired → applying → applied | apply_failed（整体回滚）
→ verifying → verified | verification_failed → rolled_back`；任何非终态可 `withdrawn`。数据层项在一个事务里应用（同 S10 PackInstallation
的论证）；需要人录凭证的项落成"待配置"，属于验证状态，不是应用失败。

## 4. 目标架构 A：目标级编排

### 4.1 三个角色的分工

```
            人（请求者）──确认 / 暂停 / 取消 / 改目标──▶ ┌───────────────────────────┐
  入口 agent ──propose_goal（计划 v1）──────────────────▶ │ 确定性推进器（内核，新增） │──推进事件──▶ 对话里的系统消息 / 控制台
                                                         │  · 持有 GoalRun 与计划      │
  outbox 事件（TaskUpdated、ActionRequestUpdated）──────▶ │  · 依赖满足 → 开下一步       │──invoke（内部入口）──▶ Task / WorkerRun（现有）
  定时（next_tick_at）──────────────────────────────────▶ │  · 预算、fencing、熔断       │
                                                         │  · 执行验收检查（观察）       │──observe（请求者权限）──▶ 门（现有）
                                                         └──────────┬────────────────┘
                                                                    │ 需要判断时（W2）
                                                                    ▼
                                                      规划 Worker（一次性，提 PlanRevision，不执行）
```

- **推进器不调用模型**。依赖满足就开下一步、结果不合 Schema 就判失败、预算超了就暂停、验收不过就不宣布完成——这些全是确定性规则，
  放在内核；内核进程本来就不持凭证，也不该持模型调用。
- **入口 agent 负责发起与汇报**：在对话里理解目标、提计划 v1（W1 起）、回答"进展如何"。它不负责推进，所以用户走开不影响目标。
- **规划器（W2）是一次性 Worker**：推进器在需要判断时（步骤失败需要换路、验收不过、出现新信息）拉起它，输入是目标、当前计划、各步
  输出与失败原因；它只能提 PlanRevision，没有执行类能力；它的花费计入 GoalRun 预算。W1 里这些判断点改为"暂停 + 通知人"。

### 4.2 推进循环

1. outbox 消费者只做一件事：把相关 GoalRun 的 `next_tick_at` 置为现在（同事务、O(1)），立即返回——不在投递事务里推进，避免拖住全平台
   投递（§2.1 #14）。
2. 推进循环按 `next_tick_at` 认领到期的 GoalRun（`for update skip locked` + 租约到期时间），在自己的事务里推进一步；崩溃后租约过期，
   别的循环或重启后的内核接手。全部状态在库里，不依赖进程内状态（与遗留 130 的方向一致）。
3. 定时：`next_tick_at` 同时承担超时、退避重试、审批截止提醒——补上 outbox 没有延时投递的缺口，不需要新的调度基础设施。
4. 每次推进写转移日志、发 `GoalRunUpdated` / `StepRunUpdated`（新事件），审计同事务。

### 4.3 计划与修订

- **计划来源**（W1）：入口 agent 经新增的 `propose_goal`（handle 通道）提交目标与计划 v1；或从一个已发布的 Procedure 生成计划。请求者在控制台
  （或对话卡片）确认后才开始——GoalRun 会在人不在场时花钱、发起动作，按 propose → authorize → execute 处理。
- **Procedure 成为计划模板**：现有 Procedure 是有序步骤、`verify` 只是文字描述。扩展为可选的依赖、输入绑定与验收判定式；没有这些字段的
  Procedure 按顺序依赖执行。这就是设计文档 P5"Procedure 的持久执行"，不另建 Workflow 引擎。
- **修订**：W1 只允许人（或经人确认的入口 agent）在暂停点改计划；W2 允许规划器提修订，平台校验 I-G3、预算与授权后接受，重大修订
  （扩大预算、加执行类步骤）仍要请求者确认。已执行的步骤保留历史；被移除的待执行步骤标 `superseded`。

### 4.4 WorkerSpec 与准入（W2）

**原则：组合不增权**。准入函数对一个 WorkerSpec 给出三种结论：

| 结论 | 条件 |
|---|---|
| 直接运行 | Skill 全部已发布；门与 Operation ⊆ 请求者当前范围 ∩ 工作区已启用；模型在 AgentProfile 允许范围内；预算 ≤ GoalRun 剩余；职责说明里无疑似凭据（#526 计数） |
| 需要审批 | 引用了草稿 Skill（试用）、需要新的门或 Operation、预算超过工作区设定的单步阈值 |
| 拒绝 | 超出请求者授权；引用已弃用组件；能力含执行类而计划未声明执行步骤 |

准入只决定"能不能起这个 Worker"；Worker 运行中的每个执行类动作仍按现有 ActionRequest、策略与审批走，准入不预先批准任何动作。
执行入口：新增内核内部的 `invokeStep`（与 `invoke.ts` 同一建 Task 路径，Task 改为引用 WorkerSpec；`worker_definition_id` 对组合来源
可空或指向基础模板——迁移细节随 W2 定）。被多次验证有效的组合，由 W4 提议沉淀为 WorkerDefinition，走现有发布。

**先修一处**（遗留 283，排在 W0）：Worker 默认能力去掉 `invoke_worker` / `find_workers`，只有定义里显式声明时才给——组队由推进器与规划器负责，预算与依赖
才有单一的管理者（§2.1 #9）。

### 4.5 步骤之间的数据交接

- 每步可声明 `outputSchema`（JSON Schema 子集，限大小）；结果契约新增可选的结构化 `output`，在 `report_result` 时校验，不合格判
  `contract_violation`（允许一次返工）。
- 下游步骤的输入由推进器按绑定（`{from: stepId, path}`）从上游 `output` 组装，不再靠模型阅读摘要转述。
- **ArtifactRef（W2）**：内核管理的产物存储，按内容摘要寻址、带大小上限、工作区 RLS、访问范围限于本 GoalRun；Worker 经新增能力上传，
  下游按引用读取。解决"产物路径随容器消失"。W1 只用结构化 `output` 与现有内联产物。

### 4.6 验收

- GoalRun 与 StepRun 都可带验收检查。推进器在步骤或目标结束时执行：`observe_predicate` 用请求者的观察权限调门、对结果求判定式
  （复用接口清单已有的 JMESPath 映射能力），检查结果写成一条 Observation 作为证据；`fact_predicate` 查图并检查新鲜度。
- 例："修复服务"的验收是"重启后 2 分钟内健康检查为 healthy、错误率指标低于阈值"，由平台观察，不看 Worker 怎么说。
- 验收不过：W1 → `paused(needs_decision)`，附证据通知人；W2 → 拉起规划器提修订（返工、补观察、换路），受修订次数预算约束。
- `review`（独立评审模型按评分标准判定）放 W4，与 E3 评测共用评审与判定推导的展示。

### 4.7 恢复：失败分类与业务动作

| 失败分类 | 来源（现有信号） | 处理 |
|---|---|---|
| 暂时性（spawn 失败、网络、容器崩溃） | `spawn_failed`、`spawn_lost`、`worker_failed` | 同步骤新尝试，指数退避，次数上限 |
| 授权不足 | 铸 Handle 失败、403 | `paused(authority_lost)`，通知人 |
| 契约不合格 | 输出 Schema 校验失败、`no_result` | 返工一次；再失败 → 需要决定 |
| 业务验证失败 | 验收检查为假 | 需要决定（W1 人，W2 规划器） |
| 结果未知 | ActionRequest `failed` 且原因 `outcome_unknown`，或第一次执行即网络错误（修复后为 `in_doubt`） | `waiting(reconcile)`：执行该步骤声明的核对观察；看到效果 → 视为已执行并记 Decision（附证据）；看不到 → 人决定是否重新执行 |
| 被拒绝 | ActionRequest `rejected` / `expired` | 需要决定 |
| 预算耗尽 | 步骤或目标预算 | `paused(budget_exhausted)` |

业务动作去重（I-G4）：ActionRequest 记录所属 StepRun；同一 StepRun 内对同一门、同一 Operation、同一目标已有已执行或结果未知的动作时，
新的同类请求被拒绝并把已有动作的状态告诉 Worker，除非该步骤这次尝试带着"重新执行"标记（由人或 W2 的已接受修订产生）。门侧的
幂等存储继续按 ActionRequest id 工作，不需要改协议。核对用的观察可以在 Operation 上声明（新增可选的 `reconcileWith`，指向一个观察类
Operation 与判定式），W1 先由步骤或验收检查提供。

**配置快照**：每个 Task 写 WorkerSpec 快照；崩溃重试读快照（Skill 版本、模型、指令摘要、镜像 digest 不变），而不是重新解析。要换配置
就是一次计划修订，留痕。

### 4.8 等待、取消、重启与迟到结果

- **等待挂在步骤上，不挂在 Worker 上**。Worker 拿到 `pending_approval` 照常交结果退出；步骤进入 `waiting(approval)`，等的是那条
  ActionRequest。`ActionRequestUpdated` 到达后：已执行 → 步骤带着动作结果判成功（或按声明开一次续作 Task 做后续动作）；被拒 → 需要决定。
  这样审批等多久都不受 Task 时长限制，也不需要 WorkerRun 的 `suspended`。
- **恢复时复查**：从等待恢复、开始新步骤前，检查计划版本仍是当前、目标未取消、请求者授权仍在（I-G2、I-G7）。
- **取消**：GoalRun 进入 `cancelling`，不再开新步骤，运行中的 Task 走现有 `terminateTask`；本 GoalRun 待审批的 ActionRequest 需要一个
  "撤回"终态——现有状态里没有合适的（`expired` / `rejected` 语义不对），W1 新增 `pending_approval → withdrawn` 转移（共享转移表 +
  DB 约束 + I6 检查同步）。已执行的外部动作不自动回滚；补偿是一个新计划步骤，按普通执行动作审批。
- **迟到结果**：属于被取代版本或已取消步骤的 Task 结果照常入库、入审计，不推进（I-G2）。
- **重启**：推进状态全在库里，租约过期即被重新认领；outbox 至少一次投递导致的重复事件被 I-G1 与状态守卫的 UPDATE 吸收。

### 4.9 预算与熔断

GoalRun 预算：累计 token / 费用（各 Task 的 `tokens_used` + 规划器用量）、步骤总数、修订次数、墙钟时长、最大并行 Task 数。默认值来自工作区
配额（owner 可调，平台设上限，与 S10 决定 8 同一处）。**无进展熔断**：连续 K 个判断点没有步骤成功、没有验收项变好 → `paused(no_progress)`。
现有单 Task 预算、每用户并发 5、工作区每日预算继续生效；GoalRun 的并行受两者中较小者约束，排队是推进器的事。

### 4.10 并发与资源冲突（W2）

现有排水器按（工作区 × 门）串行，待审批队头会挡住同门后续动作（§2.1 #11）。一个 GoalRun 里一步等审批，会挡住别的步骤乃至别人。
W2 细化为按"门 × 目标资源"排序：Operation 已有 `reads` / `writes` 的 ObjectType 声明，结合参数里的目标身份决定冲突域；不同目标的写可并行，
同一目标保持顺序（保留 R-50 / D-10 的顺序保证在冲突域内成立）。改动在治理核心，单独一个 PR、xhigh 审查。

### 4.11 任务级观察范围（W2，与 E3 共用）

WorkerSpec 可声明观察允许的门集合，推进器把它作为 Task 级的 `ObserveExclusions` 与现有谓词取交（`observe-access.ts` 的
`observeRefusal` 不改判定逻辑，只多一个来源）。S10 E3 的 `purpose=evaluation`（I-E1）是同一机制的一个用法——**只实现一次**。

### 4.12 能力发现（W2）

`find_workers` 补：过滤后再截断（修正 `limit` 在过滤前）；空结果给原因（无匹配 / 被权限过滤 / 被个人设置排除，同 `find_operations` 的
`reachability`）；返回结构化字段——输入输出契约（WorkerDefinition 新增可选的 `inputSchema` / `outputSchema`）、所需门与可达性、历史成本
中位数、版本成效（E2 的统计扩到 WorkerDefinition 版本）。成效只作提示字段、不作排序键（S10 C3 的冷启动理由不变）。

### 4.13 上下文

每步的上下文由推进器组装：目标与约束、本步职责、已绑定的上游输出、相关 Fact（带 `observed_at`）、未决问题。**写前复核**作为建议规则：
执行类动作所在的步骤，若目标对象的最近观察早于新鲜度窗口，先观察再提交（W2 起可在准入里强制）。`precedents` 与历史经验召回放 W4。

### 4.14 控制台（随各阶段交付，不允许"后端先上、界面以后补"）

- **我的目标**（新页，使用组）：列表显示状态、目标结果、预算消耗、在等什么。
- **目标详情**：步骤依赖图与状态（等待原因直接链到审批卡片或核对项）；计划版本时间线（谁、为什么、差异）；验收检查与证据（观察结果、时间）；
  费用对预算；操作：确认计划、暂停、继续、取消、改目标（= 由人提一个修订）、按未达成结束。
- **对话**：发起目标的对话里，里程碑以系统消息出现（复用 `system.task_update` 的通道），用户不用来回切页面。
- W2 加：WorkerSpec 详情（与 WorkerDefinition 的差异、准入结论与理由）；W4 加：评审判定推导。

## 5. 目标架构 B：平台管理员 Agent

### 5.1 定位

**内置的管理员 Agent 与外部 agent（例如经 MCP 接入的 Claude Code）的区别只在运行位置，不在权限。** 维护者要的是"不必每次去外面开一个
agent 会话来改平台"，不是"给平台里的 agent 更大的权"。所以它复用同一套治理：agent 提议、平台校验、人授权、平台执行、平台验证。
今天外部 agent 能做的（提议草稿、开 PR）它都能做，并且多两样外部 agent 没有的东西：读平台状态的只读投影，和把多项配置打成一个
ChangePlan 整体提交的通道。

### 5.2 身份与运行

- 平台管理员在控制台启动它（独立于个人入口 agent 的对话与容器）；它的 Principal 在**试验工作区**，`on_behalf_of` 是该管理员在试验工作区的
  human Principal，并记下对应的平台用户——每次调用检查该用户当前仍是平台管理员（I-A3）。
- Handle 用来源绑定（I19），不出容器；不签 API key、不用 service Principal（I-A1）。
- 能力上限 `ADMIN_AGENT_CEILING`（新增常量，与入口、Worker 上限并列）：入口上限 + 只读的平台状态投影（门实例与健康、连接器三态、运行层盘点、
  版本提醒、不变量指标、脱敏后的平台审计）+ 读定义类能力（`list_worker_definitions`、`get_skill` 等）+ `propose_change_plan` +
  在试验工作区内的 `invoke_worker` 与 GoalRun。**不含**：任何 human 通道能力、`scope:'platform'` 写能力、生产工作区的任何动作。
- 平台状态投影是新增的 handle 通道只读能力，字段按"不含凭证、不含内网地址细节"另定投影，不复用管理员页面的读接口（那些是 cookie 专用）。

### 5.3 三层能力

| 层 | 管理员 Agent 能做 | 生效需要谁 | 证据 | 回滚 | 审计 |
|---|---|---|---|---|---|
| **配置层** | 在试验工作区：`request_connection`、导入 OpenAPI / MCP 工具清单、观察试探、试跑 Worker；起草 Operation 分类、WorkerDefinition、Skill、Procedure、本体变更、门实例配置（无凭证）、连接器预设；组装 ChangePlan 提交 | 工作区项：该工作区 owner；平台项：平台管理员。授权扩大项逐项确认（I-A4）；凭证由人直接录入门宿主（I-A5） | 试验工作区里的 Task、观察、审计；ChangePlan 干跑差异与权限影响分类；（W4 后）评测判定；应用后的验证检查 | 弃用组件（只弃用不删，I-P4 同义）、停用门实例、平台设置回到上一版（`platform_settings` 已保留上一版）；ChangePlan 记录每项的逆操作 | 每个 ChangeItem 一条审计：起草者（agent 运行时）、批准人、应用人分开记录（I-A7） |
| **代码层** | 在一个代码 Worker 容器里检出公开仓库、改代码、跑 `pnpm lint` / `typecheck` / 相关测试；经"代码托管门"推到 fork 的分支并开 PR，PR 描述带 GoalRun / ChangeProposal 溯源与试验证据 | CI `guards / quality / test / web-e2e` 绿；审查线程；合并由人（治理路径必须维护者本人审）；release-please 发版 | PR diff、CI、审查记录、对应的试验运行 | revert PR；发版按 `release.md` 回滚 | Git 历史 + PR；平台侧记录 ChangeProposal 与推送用的 ActionRequest |
| **部署层** | 只读准备：目标版本、迁移、breaking、对应 runbook 小节、前置检查（备份新鲜度、预发运行链接），生成部署请求 | 维护者在主机执行（S10 决定 3：不做一键升级；无 docker socket） | 主机输出按 runbook 记 `docs/private/` | `apply-release.sh` 与 `release.md` 的回滚 | 主机记录 + STATUS |

### 5.4 配置层：ChangePlan（与能力包共用）

- S10 的 Pack v1 安装计划（读清单 → 干跑 → owner 确认 → 单事务发布 → `verify_pack`）就是 ChangePlan 的一种来源。**把"干跑、分类、单事务应用、
  验证、逆操作"做成一个核心，包与管理员 Agent 共用**，不建两套。
- ChangeItem 只能是对现有发布 / 配置能力的调用意图（`publish_operation`、`publish_worker_definition`、`publish_skill`、`publish_ontology_version`、
  `create_gate_instance`、`enable_gate_instance`、`set_connector_mode`……），应用时由人的会话在一个事务里调用这些能力的内部函数——agent
  没有新的写路径，人点"应用"等于逐项替 agent 调了一遍已有能力。
- 校验：引用可解析、命名空间不冲突（I-P1）、无凭证（I-A5）、非自指（§3.2）、权限影响分类（确定性，基于目标对象类型与字段）。
- 一个验证有效的 ChangePlan 可以"导出为能力包"——管理员 Agent 接进来的系统，能变成别的部署可以装的包。这是产品化的出口。

### 5.5 代码层

- **什么时候需要代码层**：数据表达不了的改动——新的门传输种类（`db` / `browser`）、需要二进制的打包门、采集器、内核缺陷、控制台页面。
- **管道**：与今天的外部 agent 线程同一条——PR → CI → 审查线程 → 合并 → release-please。管理员 Agent 不建平行管道。
- **令牌与仓库**（建议）：代码托管门持有的令牌只对一个 fork 有写权限、**没有 workflow 权限**（GitHub 拒绝无该权限的令牌推送
  `.github/workflows/` 改动——来源声明，未在本仓库实测）、没有合并与管理权限。fork 发来的 PR 在上游跑 CI 时默认拿不到仓库 secrets。
  推送与开 PR 是执行类 Operation，走 ActionRequest；首次之后可按策略自动批准（可逆、不影响生产）。
- **受保护路径**：`CODEOWNERS` 现在是 `* @btnalit`；分支保护是否要求 code owner 审批未核实。建议对 agent 起草的 PR：触及
  `packages/kernel/src/governance/`、`packages/shared/src/capabilities.ts`、`packages/kernel/migrations/`、`.github/`、`scripts/ci/`、`deploy/`
  的，必须维护者本人审查后合并——合并线程"审查与 UX 都过、CI 全绿即合"的授权不覆盖这一类（§10 F5）。
- **运行位置的现实约束**（推断）：主机拉 GitHub 慢（主机已用 git bundle 导入 tag），代码 Worker 在主机上检出与装依赖可能很慢；
  W5 的 A7 立项时要先定代码 Worker 跑在哪（主机 + 缓存镜像，或另一台能访问 GitHub 的运行环境）。

### 5.6 部署层

不变：发版应用只经 `apply-release.sh`，由维护者执行或由主机操作会话在维护者明确同意后执行。管理员 Agent 最多准备部署请求与检查单，
控制台的版本提醒已经给出命令（遗留 140 的旧副本问题照旧要修）。

### 5.7 防止自扩权（机制，不靠 prompt）

| 风险 | 机制 | 现状 |
|---|---|---|
| agent 批准自己的提议 | Handle 结构上不能带 human 通道能力；`publish_*` / `approve` / `grant_capability` / `set_policy` 都是 human 通道 | 已有（`handles.ts:82-94`；`authorize.ts:101-103`） |
| 走 service API key 绕过人 | 管理员 Agent 只用来源绑定的 Handle；守卫测试断言其身份不是 API key、上限不含 human 通道能力 | 新增 |
| 改自己的能力上限 | 上限是代码常量；改它 = 代码层 PR + 维护者审 + 维护者部署 | 新增常量与 CI 守卫 |
| 改约束自己的配置 | ChangePlan 自指校验：不能改它自己的定义、Skill、试验工作区授权、策略 | 新增 |
| 借合法变更夹带授权扩大 | 确定性分类器 + 逐项确认 + 不能与其他项一键应用；被确认的项写审计 | 新增（模式同 #526「已核对凭据」） |
| 管理员降级后 agent 继续工作 | 每次调用检查 `on_behalf_of` 用户的当前平台角色 | 新增（签发时检查不够） |
| 凭证经过 agent | ChangePlan 无凭证字段；凭证页面直达门宿主 | 已有路径（`platform-admin-design.md` §6.3）+ 新 schema |
| 代码层改 CI 或治理代码偷渡 | fork + 无 workflow 权限 + 受保护路径必须维护者审 + agent 不能合并 | 新增（令牌与规则） |
| 刷屏、反复提同一个被拒的提议 | 每天提议配额；同一目标多次被拒后熔断，被拒记录对它可见 | 新增（S10 E3 的防噪规则同源） |
| 需要立即停下它 | 停止开关放在环境变量（被劫持的管理员会话改不了，同 `platform-admin-design.md` §6.6 的原则）+ 吊销其 Handle | 新增 |

### 5.8 走一遍：让它接入一个有 OpenAPI 的工单系统

1. 管理员在管理员 Agent 的对话里说"把工单系统接进来，运维工作区要能查工单、建工单"。它创建 GoalRun（试验工作区）。
2. 它在试验工作区 `request_connection(http, 工单系统地址)` → 管理员在卡片里录入一个测试账号的凭证（直达门）。
3. 它导入 OpenAPI，起草 Operation 分类：`GET /tickets` 观察类、`POST /tickets` 执行类中影响；跑几次观察核对映射与字段。
4. 它起草一个"工单助手"WorkerDefinition 与两个 Skill，在试验工作区试跑（建单的动作照常走审批，管理员在试验工作区批）。
5. 它组装 ChangePlan：平台项（`http` 门实例配置，无凭证）+ 运维工作区项（启用门、发布 Operation 分类、发布 WorkerDefinition 与 Skill）；
   分类器标出"`POST /tickets` 的 `auto_approvable=false`"无授权扩大项。
6. 管理员在控制台看差异、试验证据、权限影响，录入生产凭证，点应用；单事务发布；验证检查跑一次观察 → `verified`。
7. （可选）把这个 ChangePlan 导出为 `tickets` 能力包。

人做的事：录两次凭证、批一次试验动作、审一次变更、点一次应用。其余由它完成，全程有审计与溯源。

### 5.9 控制台

管理组新增：**管理员 Agent**（对话 + 它的目标与在途提案）、**变更计划**（列表与详情：差异、权限影响分类、逐项确认、证据、应用、验证、回滚）、
**代码提案**（PR 链接、CI、审查状态、关联目标）。生产工作区的 owner 在"能力目录"里看到待自己确认的工作区项。

## 6. 与现有路线的关系

### 6.1 排序

下表的 S10 波次写全称（S10 W2a 等）；本文其余处不带阶段前缀的 W0–W5 都指 S11 的波次，排号见 `global-roadmap-2026-10-16.md`。

| 现有项（`STATUS.md` §3） | 处理 | 理由 |
|---|---|---|
| 控制台阶段收尾（出口标准 1、4 随主机窗口） | **不变**，主机窗口仍由维护者定 | 已在收尾 |
| #575 / 遗留 229（+228）与付费实测 | **不变**，在途（S11 W0） | 也是 W1 规划与验收花费的前提 |
| 治理 P1 181、P2 218、232 | **保留并前移到 W0** | 218（「始终允许」不绑定定义摘要）在自动推进下影响放大；232 的未知动作名同理 |
| S10 W2a：48 ② 族 id → E2 统计 → 详情页 | **保留，作为 W1a 与 W1 并行**（文件不重叠） | W2 的准入与发现要用同族版本与成效统计 |
| S10 W2b：214、P0b → Pack v1 + ops-base | **改造为 W3 的前半**：Pack v1 的安装计划做成 ChangePlan 核心（P1 改造） | 一个机制两种来源，不建两套 |
| S10 W2b：U2 运行时一致性套件、U1 余项 | **保留，常驻低优先级车道 L** | 与主线独立 |
| S10 W3：P2 knowledge 包 | **让路**，改为 W3 验收场景 A5（由管理员 Agent 产出） | 同时证明通用性与管理员 Agent |
| S10 W3：E3 评测 MVP | **排到 W4**（W2 之后） | 任务级观察范围在 W2（G11）一次做好；评测成本依赖 229 |
| S10 W4：P3 OpenMetadata 包 | **让路**为 W3 的可选验收场景 A6 | 收敛优先 |
| S10 W4：E4 个人记忆 | **推迟**，W3 完成后重评 | 收敛优先 |
| 设计文档 P5：Workflow 引擎、turn 挂起式审批 | **由 GoalRun 吸收** | §4.3、§4.8 |
| 遗留 10：Trigger、`extension_ui_request`、CLI 清单解析 | **仍推迟**；Trigger 将来直接创建 GoalRun | GoalRun 提供了它缺的持久执行半边 |
| 遗留 230：主机上的真实日常旅程 | **保留**；建议维护者选的旅程直接做成 W1 的第一个真实 GoalRun（G7） | 评测与验收共用真实数据 |

### 6.2 本次核对发现、建议新增的遗留（由合并线程写入 STATUS，编号为建议）

1. **282** 第一次执行时 apply 中途的网络错误记成普通 `failed`，效果可能已发生，应为 `in_doubt`（`action-executor.ts:353`）——P1（可靠性，外部动作）。
2. **283** Worker 默认 Handle 含 `invoke_worker` / `find_workers`，worker 模式不注册工具但容器内可直接调用（后半句为推断，需一个集成测试确认）——P2。
3. **284** 崩溃重试沿用失败 WorkerRun 的 Handle 范围，不重查请求者当前 Grant（`lifecycle.ts:639-713`）——P2。
4. **285** Task 时长计时不因 `waiting_approval` 暂停，长审批会让 Task 超时失败（`reaper.ts:343-358`）——P3（W1 的 G3 由"等待挂在步骤上"消除）。
5. **286** `find_workers` 的 `limit` 在权限与状态过滤之前执行，被过滤的行占名额（`find-means.ts`、`service.ts:565-604`）——P3。
6. **287** 文档漂移：设计文档 §7.4 说入口上下文含门与 Procedure 摘要及先例，实际没有；`platform-extension` 的 README 与 `entry.ts:55-57` 仍说
   `find_workers` / `invoke_worker` 尚未注册——P3。设计文档 §7.4 的入口上下文一行已在本 PR 改正，余下两处随 L 车道。
7. **288** agent 经 Handle 起草的草稿 `proposed_by` 记成人，溯源上分不出 agent 起草（`dispatch.ts:147`）——P3（随 W3 的 A3 收掉）。

## 7. 迁移路线

### 7.1 波次

阶段建议记为 **S11「目标级执行与平台管理员 Agent」**（§10 F1）。每个波次都是"合入 → 发版 → 主机应用 → STATUS 更新"的闭环；任务编号、
依赖与逐项验收见 `global-roadmap-2026-10-16.md`，这里只给每波的内容与出口。

| 波次 | 内容（任务号） | 前置 | 出口 |
|---|---|---|---|
| **W0 收尾与前置**（小，可与在途并行） | 229（+228）；治理 181、218、232；新遗留 282、283、284、286；主机窗口 H1 与控制台阶段关闭 | 无 | 各自的回归测试；282、284 是 W1 的硬前置 |
| **W1 可靠多步执行** | G1 数据与转移、G2 推进器、G3 恢复 / 等待 / 取消、G4 验收、G5 能力与入口 prompt、G6 控制台、G7 主机验收与第一个真实目标；并行车道 W1a：48 ②、E2 | W0 的 282、284 | §7.2 场景 S1–S10 在主机通过 |
| **W2 动态组队与改计划** | G8 WorkerSpec 组合与准入、G9 规划 Worker 与自主修订、G10 预算全量与无进展熔断、G11 任务级观察范围（与 E3 共用）、G12 按目标资源的执行队列、G13 能力发现增强、G14 ArtifactRef、G15 控制台 | W1；48 ② | 一个目标中途一步失败，规划器换路后达成；组合 Worker 在授权内直接运行、越权的被拒或转审批；一步等审批不挡同门其他目标资源的动作 |
| **W3 管理员 Agent 配置层** | 214、P0b、P1（改造为 ChangePlan 核心 + Pack v1 + ops-base）；A1 身份与上限、A2 平台状态投影、A3 试验工作区与 `propose_change_plan`、A4 控制台、A5 验收旅程、A6（可选）OpenMetadata 包 | W1（不依赖 W2） | §5.8 的旅程端到端；knowledge（RAGFlow）由管理员 Agent 产出为包；§5.7 的守卫测试全部通过 |
| **W4 经验沉淀** | E3 Skill 评测 MVP；G16 组合沉淀提议；G17 先例与经验召回；G18 `review` 类验收 | W2；229 落地 | S10 G4；一个反复验证有效的组合被提议为定义并经人发布 |
| **W5 管理员 Agent 代码层** | A7 代码 Worker 与运行位置、A8 代码托管门与 PR 溯源、A9 受保护路径规则、A10 部署请求准备 | W3 | 管理员 Agent 为一个新传输种类或一个缺陷开出 PR，CI 与审查照常，合并与部署由人 |

### 7.2 W1 的最小可交付版本

**做**：

1. **数据与状态**：GoalRun、PlanRevision、StepRun 三张表（新内核模块，迁移归该模块）；转移表进 `shared/src/transitions.ts`，DB 约束与定时
   不变量检查同步加（I-G1、I-G2、I-G6）；Task 新增 `goal_run_id`、`step_run_id`、`plan_revision` 与 WorkerSpec 快照；ActionRequest 新增
   所属 StepRun；`pending_approval → withdrawn` 转移。
2. **能力**：`propose_goal`（handle，入口上限；计划只能引用已发布的 WorkerDefinition@version 或已发布 Procedure）、`confirm_goal` /
   `pause_goal` / `resume_goal` / `cancel_goal` / `revise_goal`（human）、`get_goal` / `list_goals`（读，入口上限内可读自己的）。
3. **推进器**：`next_tick_at` + 租约认领；outbox 消费者只置到期；步骤用内部 `invokeStep` 建 Task（同一事务写 StepRun 转移，I-G1）；
   每步按请求者当前授权铸 Handle（I-G7）；重试读快照；步骤范围的动作去重与 `waiting(reconcile)`；等待挂在步骤上；取消、暂停、继续；
   迟到结果 fencing；GoalRun 预算（token、步骤数、墙钟）超出即暂停。
4. **验收**：`observe_predicate`、`fact_predicate`、`requester_confirm`；不过即 `paused(needs_decision)`。
5. **控制台**：我的目标、目标详情（步骤图、等待原因、版本时间线、验收证据、费用、操作按钮）、对话里的里程碑消息。
6. **入口 agent 的 prompt**：何时提目标（多步、跨系统、需要等待）而不是逐轮推进；怎么写验收检查。

**不做（留 W2 及以后）**：规划器自主修订、组合 WorkerSpec、ArtifactRef、按目标资源的队列、任务级观察范围、`review` 类验收。

**验收场景**（CI 集成测试 + fake-llm e2e 旅程 + 主机验收脚本，主机脚本命名随 runbook 惯例在实现时定）：

| # | 场景 | 断言 |
|---|---|---|
| S1 | 用户发起目标（A、B 并行，C 依赖 A、B）后不再发消息 | 三步全部完成；期间没有产生新的 `TurnStarted`；对话里出现里程碑消息 |
| S2 | 某步 Task 运行中、以及推进事务进行中分别杀掉内核 | 重启后继续；每步每次尝试恰好一个 Task；没有步骤被跳过 |
| S3 | 同一 `TaskUpdated` / `ActionRequestUpdated` 事件投递两次 | 不重复建 Task，不重复推进 |
| S4 | 夹具门执行成功但丢掉响应（超时） | 步骤进入 `waiting(reconcile)`；核对观察看到效果后判成功；门侧该动作执行计数为 1 |
| S5 | 一步含需审批的执行动作，审批时间超过 Task 时长上限（测试里调短） | Worker 退出后步骤 `waiting(approval)`，目标不失败；批准并执行后下一步自动开始 |
| S6 | 各步都报告成功，但验收观察为假 | 目标不进入 `completed`、结果不是 `achieved`；暂停并附证据 |
| S7 | 运行中取消目标 | 不再开新 Task；运行中的被终止；待审批动作变 `withdrawn`、不会被执行 |
| S8 | 人改计划时旧版本某步的 Task 仍在跑 | 旧结果入库入审计，不推进新版本 |
| S9 | 运行中把请求者降为无该门授权的角色 | 下一步不开始，目标 `paused(authority_lost)` |
| S10 | 累计 token 超出目标预算 | 目标 `paused(budget_exhausted)`，不是失败 |

真实模型：W1 的 S1–S10 全部可在 fake-llm 上跑；合入后按惯例做一次付费真实模型回归，需维护者届时在线程里亲口批准。

**估计规模**（推断）：内核两到三个 PR（数据与转移 → 推进器与恢复 → 验收与取消），控制台一个 PR，入口 prompt 与 e2e 随最后一个；每个内核
PR 走 xhigh 审查（状态完整性与授权）。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| 新主线让范围再次膨胀，违背收敛优先 | W1 只用已发布 Worker、不调模型的推进器；P2 / P3 / E4 明确让路；每阶段有可验收的出口 |
| 自动推进放大治理缺口（「始终允许」不绑摘要、未知动作名） | 218、232 与 `in_doubt`（282）都在 W0，先于 W1 |
| 推进器成为新的单点与复杂度来源 | 状态全在库、租约认领、无进程内状态；推进规则全部确定性、可单测 |
| 目标在人不在场时花钱 | 计划需确认；GoalRun 预算与无进展熔断；超出即暂停不重试 |
| 一步等审批挡住同门其他动作 | W1 接受（与今天一致），在目标详情里写明"在等谁"；W2 按目标资源细化 |
| 管理员 Agent 被注入后提出看似合理的变更 | 它只能提议；授权扩大项逐项确认；自指拒绝；试验与生产分离；变更有逆操作 |
| 人对 ChangePlan 走过场 | 权限影响分类由平台算、差异与证据同页；授权扩大项不能一键通过；（W4 后）评测判定 |
| 代码层令牌泄露或滥用 | 只对 fork 有写权限、无 workflow 与合并权限；令牌只在门里（agent 不持凭证） |
| 代码 Worker 在主机上拉 GitHub 慢 | W5 的 A7 立项时先定运行位置 |
| 计划 / 验收写得不好导致"通过了但没做对" | 验收证据对人可见；请求者可标未达成；W4 用真实达成率校准 |

## 9. 验证

- **功能**：§7.2 场景 S1–S10；W2、W3、W5 各自的出口与 `global-roadmap-2026-10-16.md` 的逐项验收。
- **状态**：GoalRun、StepRun、ChangePlan 只沿 §3.4 的转移走（转移表 + DB 约束 + 定时检查 + 测试）。
- **授权**：每步的 Handle 是请求者当前授权与 WorkerSpec 的交集（集成测试改角色后断言）；管理员 Agent 的 Handle 调任何 human 通道或平台写能力
  得 403（守卫测试）；上限常量不含禁止类能力（CI 守卫）。
- **溯源**：任一外部动作能答出"属于哪个目标的哪一步、哪个计划版本、谁批的"；任一经 ChangePlan 进入生产的对象能答出"哪个 agent 起草、
  谁批准、谁应用、证据在哪"。
- **失败**：结果未知的动作在核对前不会被重新执行（门侧计数断言）；取消后不会有新动作执行。
- **语义一致**：控制台、读模型、能力描述与本文对"目标 / 步骤 / 任务""执行状态 / 目标结果""起草者 / 批准人"用同一套词。

## 10. 待维护者拍板的分叉

| # | 问题 | 选项 | 推荐 |
|---|---|---|---|
| F1 | 新主线的位置与命名 | (a) 记为 S11「目标级执行与平台管理员 Agent」，S10 未完成项按 §6.1 归并；(b) 作为 S10 W2 起的新车道 | **(a)**：S10 的主题是可升级运行时、自进化与能力包，新主线是执行模型本身，分开记更清楚；控制台收尾与 #575 不受影响 |
| F2 | W1 是否要求请求者确认计划才开始 | (a) 要，一张卡片显示步骤与预算；(b) 只读计划免确认 | **(a)**；W2 起按工作区策略允许只读计划免确认 |
| F3 | 规划器放在哪 | (a) 内核按需拉起的一次性规划 Worker；(b) 唤醒用户的入口 agent（需要合成 Turn 并处理对话并发） | **(a)**：目标寿命不依赖入口容器与对话，规划器的权限与预算单独可控 |
| F4 | 能力包安装与管理员 Agent 配置层是否共用一个 ChangePlan 机制 | 共用 / 各建一套 | **共用**：一个机制两种来源，S10 W2b 的 Pack v1 改造为它的第一个来源 |
| F5 | 管理员 Agent 的代码层 PR | (a) 走 fork + 无 workflow 权限的令牌，触及治理路径的必须维护者本人审；(b) 同仓库分支，按普通 PR 处理 | **(a)**；合并线程的直合授权对 agent 起草、触及治理路径的 PR 不适用 |
| F6 | P2 knowledge 包、P3 OpenMetadata 包、E4 个人记忆 | (a) P2、P3 让路为 W3 验收场景（A5、A6），E4 推迟到 W3 之后重评；(b) 按原 S10 W3–W4 | **(a)** |

## 附录 A：证据清单

均在 main `61d5735`，路径相对 `packages/`（另注者除外）。

- 任务与尝试：`kernel/migrations/task/0001_tasks.sql`、`0003_task_worker_run_lineage.sql`、`0006_objective_outcome.sql`；
  `kernel/src/application/task/{invoke.ts,lifecycle.ts,reaper.ts,quotas.ts,service.ts,spawn.ts,handle-mint.ts,attribution.ts,result.ts}`；
  `shared/src/{transitions.ts,enums.ts,worker-result.ts,worker-definition.ts,procedure.ts}`。
- 唤醒与投递：`kernel/src/application/chat/service.ts`、`application/linkage/{task-consumer.ts,store.ts}`、`application/outbox/dispatcher.ts`、
  `kernel/migrations/core/0005_outbox.sql`、`shared/src/events.ts`；`ontology/entry-agent.yaml`（仓库根）。
- 审批与执行：`kernel/src/governance/approval/{drainer.ts,decide.ts,execution.ts,reads.ts}`、`application/gateway/{action-executor.ts,
  request-action-handler.ts,action-request-drain-consumer.ts}`、`kernel/migrations/governance/0014_action_request_idempotency_window.sql`、
  `gatekeeper-base/src/{gatekeeper-base.ts,idempotency-store.ts,errors.ts}`。
- 观察与发现：`kernel/src/application/gates/observe-access.ts`、`kernel/src/substrate/graph/find-means.ts`、`application/gateway/handlers.ts`。
- 能力与授权：`shared/src/capabilities.ts`、`shared/src/roles.ts`、`kernel/src/governance/capability/handles.ts`、
  `application/gateway/{authorize.ts,resolve-caller.ts,dispatch.ts}`、`shared/src/handle-binding.ts`。
- 扩展模式：`platform-extension/src/modes/{entry.ts,worker.ts,interactive.ts}`。
- 审计与不变量：`kernel/migrations/core/0004_audit.sql`、`kernel/src/substrate/audit/invariant-checks.ts`。
- 仓库治理：`.github/CODEOWNERS`（`* @btnalit`）、`.github/workflows/ci.yml`（`pull_request` 触发）；分支保护是否要求 code owner 审批未核实。
- 外部：GitHub 对缺少 workflow 权限的令牌拒绝推送 `.github/workflows/` 改动、fork PR 默认拿不到仓库 secrets——来源声明，本次未实测。
