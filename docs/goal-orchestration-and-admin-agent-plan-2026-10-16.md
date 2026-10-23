# 目标级编排与平台管理员 Agent：方案（2026-10-16）

> 依据：维护者 2026-10-16 提出的两件事——①「新目标 → 分解任务 → 按需组建多个 Worker → 建立协作依赖 → 根据执行结果调整分工和流程
> → 验证完成」作为核心执行主线（附维护者与 GPT 的分析原文）；② 管理员自己的 AI agent 要有权限、有能力改造优化整个平台（例如自己
> 集成对接一个新系统），不必每次靠外部 AI agent。
> 本文是**方案与待决记录**，不是现状说明书；现状以代码与 `STATUS.md` 为准。提议的组件在本文里一律写作"新增 / 提议"，不写成已存在。
> 标注：**已核实**（读到 main 的代码、迁移或测试，给出 `文件:行`）、**推断**（未运行验证）、**建议**。
> GPT 的分析基于 `07775fe`；核实在 `61d5735` 上做，行号以该提交为准（之后到 `0390041` 的提交只动控制台与 STATUS，不影响本文引用的代码）。
> **修订（2026-10-16，同日）**：按独立审查（#580 的 PR 评论）修订——变更计划按授权分段应用（§5.4）、授权扩大改为白名单分类（I-A4）、
> 新增"旧步骤不能产生动作"不变量 I-G9、代码层改为 W5 开工前的决策门（§5.5）、遗留改用 287–293、任务号改用 `GO*` / `AA*` 前缀，
> 并改正 K2 / K5 / K6 与产物、溯源两处事实表述。增量复审后再修订：白名单写明逐字段比较、治理三字段的方向只是其中一部分（I-A4）；
> 段间依赖绑定平台段摘要、回滚按反向依赖、工作区段的差异只在该工作区可见（§3.4、§5.4）；I-G9 补上执行中动作的例外，撤回与步骤转移同事务、
> 执行侧只靠行状态；ActionRequest 加结构化失败类别。
> 编号：本文不带阶段前缀的 W0–W5 指建议新阶段 S11 的波次；任务号（`GO*` 目标级编排线、`AA*` 管理员 Agent 线、遗留号）与依赖、验收见
> `global-roadmap-2026-10-16.md`；S10 的波次与目标一律写全称（S10 W2a、S10 G4）；本文的目标编号 O1–O8 与任务号是两套。

## 0. 结论先行

1. **方向成立，但问题要重新定性**（已核实）：平台缺的不是"能拉起更多 Worker"，而是**"推进"这件事没有所有者**。今天的计划只活在入口
   agent 的对话里，`TurnStarted` 只在人发消息时产生（`application/chat/service.ts:584`），Task 结束只写一条系统消息和待读上下文
   （`application/linkage/task-consumer.ts:119-147`；`ontology/entry-agent.yaml:184-187`）。所以第一步是让平台持有"目标"和"推进"
   （GoalRun + 确定性推进器），动态组队排第二。
2. **GPT 的事实判断在当前 main 上基本都成立**（§2 逐条），但有两处说轻了，都会让"多 Worker 持续协作"失败：
   - 审批等待最常见的结局不是"崩溃不重试"，而是 Worker 交结果退出、批准后的动作由排水器脱离 Worker 执行——**依赖这个动作的后续工作
     直接丢失**。两条路径都会走到：`await_decision:true` 时 Worker 等 25 秒拿到 `pending_approval`；`await_decision:false` 时立刻拿到
     `pending_approval` 和 simulate，Task 根本不进 `waiting_approval`（`task/reaper.ts:153-166`）；
   - 第一次执行时的网络错误被记成普通 `failed`，而请求可能已经发出、外部效果可能已经发生——"失败"不等于"没发生"（但连接被拒这类
     发送前失败确实没发生，修法要分情况，§4.7）。
   另外，GPT 说的"重试重新解析配置"属实；它没提的是重试沿用旧 Handle 范围——但执行时 R-37 / D-20 会按当前授权复核
   （`gateway/request-action-handler.ts:1343-1359`），所以影响只在非执行类能力（遗留 289，P3）。outbox 没有延时投递，消费者在投递后
   逐个串行执行、不与投递共用事务，失败 10 次进死信——推进器不能只靠事件（§4.2）。
3. **管理员 Agent 不能做成"给 agent 管理员权限"**，而是"能提议平台变更的 agent + 一条把提议变成生效的受治理通道"。分三层：
   **配置层**（数据：接入、Operation 分类、WorkerDefinition、Skill、本体；走按授权分段、可干跑、可逆的变更计划 ChangePlan）、
   **代码层**（**待定**：要推翻 S10 的 I-N1"代码自修改明确不做"，并且需要一个任何 agent 会话都拿不到的审批身份，所以列为 W5 开工前的
   决策门，W5 之前的路线不依赖它）、**部署层**（主机与生产仍由维护者执行，S10 决定 3 不变）。今天的系统边界正好是它的地基：Handle
   结构上带不了 human 通道能力（`governance/capability/handles.ts:82-94`），平台面只认平台调用者（`application/gateway/authorize.ts:84-98`）。
   唯一的捷径陷阱是 owner 角色的 service API key——它走 human 通道，R-17 只拦高影响和不可自动批准的动作（`governance/approval/decide.ts:162-171`），
   管理员 Agent **明确不走这条**。
4. **两件事概念上是一件**：管理员 Agent "接入一个新系统"本身是一个多步目标（探索 → 分类 → 起草 → 试验 → 提交变更 → 等批 → 应用 → 验证），
   产出是 ChangePlan；能力包安装与它共用 ChangePlan 核心。但**工程上不互相等**：W3（配置层）真正依赖的是 ChangePlan 核心（P1）与管理员
   Agent 身份（AA1），不依赖 W1 的 GoalRun；管理员 Agent 的旅程本身是交互式的，W1 合入后再让它的长任务跑在 GoalRun 上。
5. **与现有路线**（§6）：控制台阶段收尾不变；S11 W1 成为下一个内核主线；S10 W2a（48 ② + E2）作为 W1a 并行；S10 W2b 的 Pack v1 改造为
   ChangePlan 核心，**P2 knowledge 包仍是 P1 的验收**（手写包走变更计划，不依赖管理员 Agent）；P3 OpenMetadata 包让路为 W3 的可选验收；
   E4 个人记忆推迟；E3 评测排到 W2 之后；设计文档 P5 的"Workflow 引擎 / turn 挂起式审批"由 GoalRun 吸收，Trigger 仍按遗留 10 推迟。
6. 分叉 F1–F4、F6 已由协调方按独立审查的意见定下（工程决定），F5（代码层）留作 W5 开工前由维护者决定（§10）。

## 1. 背景与目标

维护者原话要点（2026-10-16）：

- "新目标 → 分解任务 → 按需组建多个 Worker → 建立协作依赖 → 根据执行结果调整分工和流程 → 验证完成……这个是我要的一个非常重要功能。"
- "管理员的独立 AI agent 应该要有权限和能力去改造优化我们整个平台的，比如让它集成对接某个系统，不能每次都要用外部 AI agent 去改造它。"

目标（可验证）：

| # | 目标 | 验证 |
|---|---|---|
| O1 | 一个目标在用户不再发消息时也能推进到结束（完成、暂停待人或取消），不依赖某次对话或某个容器活着 | §7.2 场景 S1、S2、S12 |
| O2 | 每一步为什么开始、在等什么、用了什么配置、花了多少，平台能答出来；计划改过几次、为什么改，有版本 | 控制台目标详情页；读模型 |
| O3 | 外部动作在同一个业务步骤里至多执行一次，除非有留痕的"重新执行"决定；结果未知时先核对再决定；被取消或被修订掉的步骤不再产生动作 | 场景 S3、S4、S7、S8 |
| O4 | 目标"达成"只由平台执行的验收证据或请求者确认判定，执行者的自报不能宣布达成；验收条件本身经人确认 | 场景 S6；F2 |
| O5 | 任务专用的 Worker 组合（WorkerSpec）只在不扩大权限时直接运行，扩大权限的部分走审批或发布 | S11 W2 验收（GO8） |
| O6 | 管理员 Agent 能在对话里把一个有 OpenAPI 或 MCP 的新系统接进来：从探索到生产工作区可用，人只做录凭证、审变更、按授权分段点应用 | S11 W3 验收旅程（AA5） |
| O7 | 管理员 Agent 不能扩大自己的权限：它没有任何写平台代码、策略、授权或自身上限的能力；改它的上限只能经人合入代码并由维护者部署 | §5.7 的守卫测试（AA1、AA3） |
| O8 | （待定，W5 决策门）管理员 Agent 提的代码改动以 PR 进入现有管道，CI 与人的审查不可绕过 | 决策门通过后再定验收 |

非目标（本方案内不做）：在 W5 决策门通过之前，S10 I-N1 继续有效——管理员 Agent 没有任何写平台代码、prompt、迁移的能力；控制台内一键升级
平台（S10 决定 3）；agent 改 Policy / Grant；多部署控制面与应用市场（`development-tasks.md` §5f"明确不做"）。

## 2. 现状（Current Reality）：逐条核对 GPT 的结论

### 2.1 核对表

| # | GPT 的结论 | 核对 | 证据（`packages/` 下，除非另注） | 判断 |
|---|---|---|---|---|
| 1 | Task 绑定一个 WorkerDefinition，WorkerRun 是一次执行尝试；`parent_worker_run_id` 记谁派生谁，表达不了"C 等 A、B" | 已核实 | `kernel/migrations/task/0001_tasks.sql:55-56,101-102`；`0003_task_worker_run_lineage.sql:43,48`（depth ≤ 3、attempt ≤ 2） | 对。另有一个静态的 Procedure（有序步骤，`shared/src/procedure.ts`），步骤间没有依赖与数据绑定，**没有任何东西执行它**（注释写明是 P5 的 Workflow 引擎） |
| 2 | `invoke_worker` 只接受已发布定义 | 已核实 | `kernel/src/application/task/invoke.ts:481`；`application/worker/definitions.ts:411-425`；参数 `.strict()` 无内联配置（`shared/src/capabilities.ts:2187-2215`） | 对 |
| 3 | 结果契约有 summary / findings / 事实 / 证据 / 产物；产物是路径加可选内联文本，单个 32,000 字符、最多 8 个；没有步骤级输入输出 Schema 与下游绑定 | 已核实 | `shared/src/worker-result.ts:112-126,148-158` | 对。补充：文件本身留在主机上该 Task 的工作目录里（保留 72 小时，`worker-result.ts:115-117`；`worker-supervisor/src/config.ts`），但平台没有任何读取路径（`:94-111`，内核不碰文件系统是有意的边界）——下游拿不到 |
| 4 | Task 的目标结果与执行状态分开，由入口 agent 上报，`agent_reported` | 已核实 | `kernel/migrations/task/0006_objective_outcome.sql`；`report_task_outcome` 只在入口上限内（`governance/capability/handles.ts:131-134`）；`application/task/attribution.ts:408,420`；`shared/src/wire/attribution.ts:16` | 对；且**没有任何东西据此行动**：没有事件、不拦完成、不触发重排，只能在 Task 终态后标注 |
| 5 | 动作幂等键含会话身份，崩溃重试换新会话，所以不能跨 WorkerRun 去重 | 已核实 | `application/gateway/action-executor.ts:125,139`；`request-action-handler.ts:1263-1280`；`kernel/migrations/governance/0014_action_request_idempotency_window.sql:36-44` | 对；显式键也带 `sid` 前缀，派生键只在动作未终结时去重 |
| 6 | 重试重新解析 Skill、模型、平台指令、运行镜像，同一任务的不同尝试可能配置不同 | 已核实 | `application/task/lifecycle.ts:670-697` | 对；WorkerDefinition 版本是钉住的；重新解析 Skill 是 E1 有意的（`:677-679`）。补充：只在非零退出时重试一次；Handle 范围读失败那次 run 的（`:611-713`），但执行时 R-37 / D-20 按请求者当前授权复核（`gateway/request-action-handler.ts:1343-1359`；`application/gates/execute-access.ts:56-73`），所以收回的门执行不了，残余只在非执行类能力与工具列表（遗留 289） |
| 7 | 有 `waiting_approval`，但审批等待不是持久的流程挂起；Worker 受运行时限约束；等待中崩溃不走普通重试 | 已核实 | `lifecycle.ts:508-513`；`task/reaper.ts:153-166,343-358`；`gateway/request-action-handler.ts:111-131,224` | 对，但**说轻了**：`await_decision:true`（及未分类草稿）时 Worker 等 25 s；`await_decision:false` 时立刻拿到 `pending_approval` 与 simulate，Task 不进 `waiting_approval`。两条路径都会走到：Worker 按提示引用动作 id 后交结果退出（`platform-extension/src/modes/worker.ts:46-51` 的 `PENDING_APPROVAL_GUIDANCE`），批准后动作由排水器执行（`gateway/action-request-drain-consumer.ts:60-75`），`resumeTaskFromWaitingApproval` 见 Task 已终结直接返回（`reaper.ts:115`）——后续工作丢失。WorkerRun 的 `suspended` 状态无生产代码使用 |
| 8 | `find_workers` 主要按名称、描述关键词匹配，再过滤发布状态与权限；找不到时没有原因 | 已核实 | `kernel/src/substrate/graph/find-means.ts:186,214-239`；`application/task/service.ts:565-604`；`gateway/handlers.ts:1787` | 对。补充：SQL 的 `limit 20` 在过滤之前执行；WorkerDefinition 没有输入输出类型、成本、成效字段（`shared/src/worker-definition.ts:50-64,141-146`） |
| 9 | 默认 Worker 扩展只暴露门工具与 `report_result`，没把 `find_workers` / `invoke_worker` 注册成 Worker 工具 | 已核实 | `platform-extension/src/modes/worker.ts:411,519`；`worker.test.ts:103,135` | 工具层面对。治理上：内核把两者放进 Worker 默认能力（`governance/capability/handles.ts:208-213`；`application/task/handle-mint.ts:399-401`），这是 S2.7 有意设计的嵌套派生（深度 ≤ 3，`invoke.integration.test.ts:254-288`；E1 实现了嵌套 Turn 继承）；容器内置工具全开（`deploy/worker-runtime/Dockerfile`），容器调内核不带凭据（`shared/src/handle-binding.ts` 文档注释第 2 条），shell 可直接调（推断，未运行）。所以"谁来组队"今天不只由平台决定——这是设计选择，不是缺陷，是否改见遗留 288 |
| 10 | 有单 Task token、时长、用户并发、工作区每日预算；没有整个目标的预算 | 已核实 | `application/task/quotas.ts:29-57`（200k token、3600 s、每用户 5 个、日费用默认不限）；`BudgetWarning.scope='turn'` 定义了但从不产生（`linkage/budget-consumer.ts:17-21`） | 对 |
| 11 | 同一个门的执行队列会被前面的待审批或执行中动作阻塞 | 已核实 | `kernel/src/governance/approval/drainer.ts:136-140`；`approval/reads.ts:362-375` | 对；队列按（工作区 × 门），待审批的队头最长挡 24 h（`approval/execution.ts:83`），结果不明的执行中队头最长约 25 min |
| 12 | 门主要收窄执行权限，观察另走工作区与个人策略；没有任务级观察范围 | 已核实 | `application/gates/observe-access.ts:11-42,120-135` | 对。S10 I-E1 为评测设计的 `purpose=evaluation` 观察允许集合同一缺口，**设计了未实现**（E3 未开工），应只做一次 |
| 13 | 入口的 `precedents` 返回空数组 | 已核实 | `gateway/handlers.ts:789-797`（注释 `:751`） | 对；`find_precedents` 存在但不在入口上限内。设计文档 §7.4 曾写入口上下文含"可用的门与 Procedure 摘要"，实际没有（文档漂移，随本方案的 PR 改正） |
| 14 | PostgreSQL、Outbox、Task 状态机可作为第一版基础 | 已核实 | `kernel/migrations/core/0005_outbox.sql`；`application/outbox/dispatcher.ts:256-330`（`processOneRow`，`:321` 逐个 `await consumer`） | 对，有四个限制：outbox 没有延时投递列；一行一行串行投递，慢消费者拖住全平台投递；消费者拿到的是事件与元数据、不是投递事务，各自开事务；失败 10 次（`DEFAULT_MAX_ATTEMPTS`）进死信、不再投递。另外假定内核单进程（遗留 130） |
| 15 | 现有代码已有发现、委派、容器执行、审批与结果记录 | 已核实 | 同上各项 | 对 |

### 2.2 GPT 没提到、但会直接影响设计的事实

| 事实 | 证据 | 影响 |
|---|---|---|
| 没有任何路径能在没有用户消息时启动入口 agent 的 Turn；一个对话同一时刻只有一个 Turn | `chat/service.ts:76,584`；`send_chat_message` 是 human 通道 | 推进不能靠"唤醒入口 agent"，要么合成 Turn（新增生产者 + 处理对话并发），要么推进器不依赖入口 agent（§4.1 选后者） |
| 结果不明的动作：门超时 → `executing`（障碍）→ 经门的幂等存储重放至多 3 次 → `failed`，原因 `outcome_unknown` 只在审计负载里，没有列；没有"查询原动作"的能力；`compensate` / `verify` 转移没有生产调用者 | `action-executor.ts:221-224,339-349,371-419,475-522`；`approval/execution.ts:216,377-379,386`；`gatekeeper-base/src/errors.ts:55-70` | 业务层的"先核对再决定"要新建；门协议里没有"查询某次 apply 的结果"，只能用领域观察核对 |
| 第一次执行时的网络错误一律记成 `network_error` → `failed`：`fetch` 抛错（`:455`）同时覆盖"连接被拒、请求没发出"和"发出后连接被重置"，收到响应头后读响应体失败（`:487`）也是同一个码 | `action-executor.ts:219-235,353`；`kernel/src/adapters/gatekeeper-client/index.ts:455,487` | 推进器不能把 `failed` 读成"没发生"；修法要区分发送前与发送后（遗留 287，§4.7） |
| 溯源：Operation 草稿记 `origin`（`human` / `agent` / `import`），本体草稿记 `proposer_kind`，审计负载记 `channel`；`proposed_by = on_behalf_of` 是 I13 的设计。缺的只是 Skill / Procedure / WorkerDefinition 草稿分不出 agent 起草 | `governance/gatekeepers/manifest.ts:400`；`substrate/ontology/registry.ts:559`；`gateway/dispatch.ts:140-141,407` | 管理员 Agent 起草的 Skill / Procedure / WorkerDefinition 要沿用同一字段（遗留 293），不另建 |
| service Principal 的 API key 走 human 通道、按角色授权；可以建 owner 角色的 service Principal | `gateway/resolve-caller.ts`；`shared/src/capabilities.ts:2680-2688`；`approval/decide.ts:162-171` | 这是"agent 绕过人"的唯一现成捷径，管理员 Agent 必须不走它（I-A1） |
| 本项目所有 agent 会话在 GitHub 上都以同一个维护者账号行事；分支保护只要求 4 个检查；合并线程有"审查 + UX 通过、CI 全绿即合"的常设授权 | `.github/CODEOWNERS`；项目记录；#580 自身的作者 | "必须维护者本人审"在今天没有系统机制能强制——代码层的前提之一（§5.5） |
| 观察类调用有副作用：写 Observation、Fact、Activity | `shared/src/capabilities.ts:740-753` | 管理员 Agent 的试探性观察会写进工作区图——试验应放在试验工作区（§5.2） |
| 审计 append-only 由触发器保证，与被审计的写同事务 | `kernel/migrations/core/0004_audit.sql:37-52`；`gateway/dispatch.ts:352-398` | 新对象的每次转移直接复用 |
| 只有 I4、I6、I7、I11–I14、I16（加 I2 静态）有定时检查；I17–I19 没有 | `kernel/src/substrate/audit/invariant-checks.ts:686-740` | 新不变量要同时给出定时检查，不能只写在文档里 |

### 2.3 可以直接复用的基础（已核实）

Task / WorkerRun 与转移日志（每次转移发 `TaskUpdated`，`task/transition-log.ts:41,71`）；ActionRequest 状态机、按门串行的排水器、审批按范围路由
（I14）、R-17"人才能批高影响与不可自动批准的动作"；执行时按当前授权复核（R-37 / D-20）；Handle 的子范围计算（`entryGatekeeperIds`，
`gates/execute-access.ts:78`；`computeChildHandleScope`，`task/handle-mint.ts:171`）；治理字段的宽松 / 收紧分类（`OperationGovernanceDirection`，
`governance/gatekeepers/manifest.ts:1124-1160`）；"审过的内容摘要 ≠ 当前内容就拒绝"的模式（门清单的 `manifestDigest` 与 409 `manifest_changed`，
`gateway/gate-instance-handlers.ts:79-100`；ActionRequest 的 `operation_digest`，`governance/0019`）；结果契约与 `propose_*` 提议链；E1 归因
（`worker_run_skills`、Turn 的 Procedure 声明、`ObjectiveOutcome`）；outbox 至少一次投递；审计同事务；来源绑定的 Handle（I19，Handle 不进容器）；
`platform_settings` 保留上一版；控制台的确认分级与「已核对凭据」二次确认（#526）。

## 3. 领域模型

不重开 `graph-ai-middle-platform-design.md` §5 的模型，只在执行层与治理层增量。命名沿用现有词汇；新增概念均为**提议**。

### 3.1 新概念

| 概念 | 属于 | 含义 | 与现有概念的边界 |
|---|---|---|---|
| **GoalRun** | Governance（执行） | 一个被接受的目标：目标陈述、约束、验收条件、预算、请求者（`on_behalf_of`）、当前计划版本、执行状态与目标结果 | Turn 是一次对话轮次；GoalRun 的寿命独立于对话和容器。一个 Turn 可以发起 0..1 个 GoalRun |
| **PlanRevision** | Governance | 计划的一个不可变版本：步骤、依赖、每步的 Worker 来源与输入绑定、验收检查；记基于哪个版本、谁提的、为什么、平台校验结果 | 不复用 Decision：计划修订有自己的校验与 fencing 语义；重大修订另记一条 Decision 供 `explain` |
| **StepRun** | Governance | 计划里的一个业务步骤：依赖、输入绑定、输出 Schema、状态、尝试次数、失败分类；由 0..N 个 Task 执行（每次尝试一个） | Task 是一次委派；StepRun 是业务步骤，跨 Task 保持身份。**尝试只在 StepRun 这一层**：推进器建的 Task 关掉 Task 内部的崩溃重试 |
| **RunConfigSnapshot**（运行配置快照，W1） | Governance | 一个 Task 实际生效的配置：`definition@version`、Skill `id@version`、模型、`instanceInstructions` 摘要、运行镜像 digest、步骤 Handle 的门与能力、预算 | 已解析的事实记录；重试读它而不是重新解析。钉住的组件被弃用或吊销时，该次尝试失败，不静默换新 |
| **WorkerSpec**（期望组合，W2） | Governance | 规划者想要的 Worker 组合：职责说明、Skill、门与 Operation 子集、模型、预算、停止条件、输出 Schema；经准入（§4.4）后解析成一份 RunConfigSnapshot | WorkerDefinition 是经发布的可复用模板；WorkerSpec 是这一次想要的组合；RunConfigSnapshot 是准入后实际跑的 |
| **AcceptanceCheck** | Epistemic | 验收条件的一项：`observe_predicate`（一个观察类 Operation + 参数 + 对结果的判定式）、`fact_predicate`（图上事实 + 新鲜度）、`requester_confirm`、`review`（独立评审，W4） | 判定式由入口 agent 或规划器起草，**经请求者确认后才生效**（F2）；执行者自报不是一种验收（I-G5） |
| **业务动作身份** | Governance | StepRun 内一个外部动作的去重键：（`step_run_id`, 门, Operation, 参数摘要） | 现有幂等键（`action-executor.ts:125,139`）里的会话身份 `sid` 换成 `step_run_id`；连续创建三张工单这类参数不同的合法调用不受影响 |
| **ChangePlan / ChangeSegment / ChangeItem** | Governance | 一组意图变更，按授权分段：**平台段**（平台管理员应用）与**每个工作区一段**（该工作区 owner 应用）；每项 ChangeItem 是对一个现有发布 / 配置能力的调用意图（参数不含凭证）、干跑差异、授权影响分类、逆操作；每段绑定审阅时的内容摘要，工作区段还绑定它所依赖平台段应用时的摘要 | 能力包安装计划是 ChangePlan 的一种来源；管理员 Agent 的提案是另一种 |
| **ChangeProposal（代码层，待定）** | Governance | 一个代码改动提议的平台侧记录：仓库、分支、PR 引用、头提交、CI 与审查状态、关联的 GoalRun | W5 决策门通过后才引入；Git 与 PR 是真源，平台只存引用与状态快照 |
| **管理员 Agent** | 主体 | 由平台管理员启动、代表该管理员（`on_behalf_of`）运行的 agent 实例；能力上限是代码里的常量 `ADMIN_AGENT_CEILING` | 与入口 agent 同一运行时与镜像，不同的能力上限、不同的对话与容器 |
| **试验工作区** | World | 管理员 Agent 探索与试运行用的普通工作区（RLS 隔离），生产工作区的变化只经 ChangePlan 进入 | 不是 2026-09 否决的"平台工作区"（那是身份方案）；它没有特权 |

### 3.2 关系

- `GoalRun requested_by Principal`（人）；`GoalRun originated_in Turn`（0..1）；`GoalRun current PlanRevision`（1）；`PlanRevision based_on PlanRevision`（0..1）。
- `StepRun introduced_in PlanRevision`；`StepRun superseded_in PlanRevision`（0..1）；`StepRun depends_on StepRun`（N:M，无环）；`StepRun input_from StepRun.output`（带路径）。
- `Task executes StepRun`（N:1，带 `plan_revision` 与尝试号）；`Task ran_with RunConfigSnapshot`（1:1）；`ActionRequest raised_in StepRun`（经 Task）。
- `AcceptanceCheck belongs_to GoalRun | StepRun`；`AcceptanceCheck confirmed_by` 人；`AcceptanceCheck evidenced_by Observation`（平台执行检查时产生）。
- `ChangePlan proposed_by` 管理员 Agent（或能力包清单）`on_behalf_of` 人；`ChangePlan contains ChangeSegment`（1..N，按授权排序）；`ChangeSegment approved_by` / `applied_by` 该段的有权者；
  `ChangeSegment requires ChangeSegment@digest`（工作区段依赖平台段的某个已应用版本，按摘要绑定；回滚按反向依赖）；`ChangeItem targets` 对象（门实例、Operation、WorkerDefinition、Skill、本体族、平台设置项）。
- `Object changed_by ChangeItem`（溯源，与 S10 的 `installed_from` 同构）。

**永不允许**：
- 执行某步骤的 Task 给同一 GoalRun 的验收检查打分（执行者 ≠ 验收者）；
- 非当前计划版本或已取消的步骤所属的 Task 提交新的外部动作，或其已批准未执行的动作被执行（I-G9）；
- 步骤 Handle 的能力范围超出请求者当前的入口范围与 Grant 的交集；
- ChangePlan 含凭证值、Grant 或 Handle；一个 ChangeSegment 跨越两个授权主体（平台与工作区，或两个工作区）；
- 管理员 Agent 的 ChangePlan 修改约束它自己的定义、能力上限、策略或其所在的试验工作区授权（自指）；
- 管理员 Agent 持有 human 通道能力、`scope:'platform'` 的写能力，或任何写平台代码仓库的能力（W5 决策门之前）；
- 晚到的、属于已被取代计划版本的 Task 结果推进新版本的步骤。

### 3.3 不变量（新增）

| # | 不变量 | 机制 |
|---|---|---|
| I-G1 | 每个 StepRun 的每次尝试至多对应一个 Task | `tasks (step_run_id, attempt)` 唯一索引（只约束推进器直接建的 Task；步骤声明的嵌套子 Task 记录所属 `step_run_id`，不占尝试号）；推进在同一事务里写 StepRun 转移与 Task；推进器建的 Task 关掉 Task 内部重试 |
| I-G2 | 只有当前计划版本的步骤能被推进；旧版本 Task 的结果入库、入审计，但不改变步骤状态 | Task 带 `plan_revision`；推进时比较（fencing），不一致只记录 |
| I-G3 | 计划修订基于当前版本（乐观并发），无环、引用可解析、在预算内 | 修订校验函数；`based_on ≠ current` 拒绝（同本体 R-60 的做法） |
| I-G4 | 同一步骤内，同一业务动作身份（§3.1）至多执行一次，除非有显式、留痕的"重新执行"决定；同一 Operation 在本步骤有结果不明的动作时，先核对完再放行同类请求 | 步骤范围的去重键（跨 WorkerRun、跨状态）；`outcome_unknown` / `in_doubt` 先核对；重新执行需要人或（W2）规划器提议 + 平台接受 |
| I-G5 | GoalRun 的目标结果 `achieved` 只能来自平台执行的、经请求者确认过的验收检查，或请求者本人确认；执行步骤的 Worker 自报与入口 agent 的 `agent_reported` 都不能给出它 | 验收由推进器发起，用请求者的观察权限；依据词表扩展现有 `OBJECTIVE_OUTCOME_BASIS_VALUES`（`requester` / `agent_reported`）加 `verified_by_check` / `reviewer_assessed`；`report_task_outcome` 继续只在入口上限内 |
| I-G6 | GoalRun 累计花费、步骤数、修订次数、墙钟时长不超过预算；超出即暂停，不是失败 | 推进前检查；`paused(budget_exhausted)` |
| I-G7 | 每一步开始时按请求者**当前**授权铸 Handle；授权缩小后不再开始新步骤 | 复用现有函数：`entryGatekeeperIds` 现算请求者入口范围作父 Handle，再 `computeChildHandleScope`；执行时 R-37 照常复核；`paused(authority_lost)` |
| I-G8 | WorkerSpec 组合不增权：直接运行的组合只能由已发布组件、请求者已有的门与模型构成 | 准入函数（§4.4），拒绝或转审批 |
| I-G9 | 只有属于当前计划版本、且 GoalRun 未取消的步骤能产生外部动作，它的动作才能开始执行：被修订移除或取消的步骤，其 Task 默认被终止（子孙 Handle 一并吊销）；若选择"让它跑完"，它和它声明的嵌套子 Task 的新 `request_action` 被拒绝；它名下 `pending_approval` 与 `approved` 的动作改为 `withdrawn`（"让它跑完"时人逐条放行的除外）。**例外**：已经 `executing` 的动作不能撤回，按 R-48 收尾——首个请求若没到达门，重放会真正执行一次（`action-executor.ts:368-369`）；GoalRun 要等它们到终态（§4.8） | 入口：`request_action` 查所属 StepRun 是否当前且未取消（嵌套子 Task 记录所属 `step_run_id`）。执行侧只靠行状态：撤回在写 StepRun 转移的**同一事务**里完成，`startActionRequestExecution` 本来就 `FOR UPDATE` 锁行并按转移表检查（`approval/execution.ts:253-259`），见 `withdrawn` 即拒绝；排水器不读 StepRun（governance 不能依赖 application，`.dependency-cruiser.cjs:46-51`），也就没有先读再执行的竞态。新增转移 `pending_approval → withdrawn`、`approved → withdrawn`（共享转移表 + DB 约束 + I6 检查同步）；撤回后发 `ActionRequestUpdated` 触发该门重新排水；场景 S7、S8 |
| I-A1 | 管理员 Agent 永远是提议者，不是授权者：它的 Handle 不含 human 通道能力，不能调 `scope:'platform'` 写能力；它不是 service API key | 现有 `assertValidScope` 与 `authorizeCapabilityCall`；新增守卫测试；身份用 Handle（来源绑定），不签 API key |
| I-A2 | 管理员 Agent 的能力上限只在代码里，且它没有任何写平台代码的能力；改上限只能经人合入代码、由维护者部署 | `ADMIN_AGENT_CEILING` 常量 + CI 守卫断言上限不含 human 通道 / 审批 / 授权 / 策略类能力与代码托管类能力。今天唯一只能由人做的关口是部署；W5 若开工，前提是有 agent 拿不到的审批身份（§5.5） |
| I-A3 | 管理员 Agent 的权力随人：每次调用检查其 `on_behalf_of` 的用户当前仍是平台管理员 | 调用时检查（不是签发时）；降级或停用立即失效 |
| I-A4 | 凡是无法确定性证明"不扩大授权"的 ChangeItem，一律标 `authority_widening`，逐项人工确认，不能随其他项一键应用 | **白名单**分类器（§5.4）：对 ChangeItem 的全部字段逐字段比较，只有落在"已证明不扩大"集合里的变化才放行，不信 agent 自己的标注。`operationGovernanceChangeDirection` 只是其中一部分，只判 `mode` / `blast_radius` / `auto_approvable` 三个字段的方向；它返回 `neutral` 不证明任何事。应用接口要求逐项确认，审计记录 |
| I-A5 | ChangePlan 不含凭证值；凭证只由人直接录入门宿主或 llm-proxy | ChangePlan schema 无凭证字段 + #526 的疑似凭据计数 |
| I-A6 | 管理员 Agent 的探索只发生在试验工作区；生产工作区只经已应用的 ChangePlan 改变 | 它在生产工作区没有 Principal |
| I-A7 | agent 起草的东西在溯源上可区分：起草者种类与批准人分开记录 | 扩展现有 `origin` / `proposer_kind` 到 Skill / Procedure / WorkerDefinition 草稿与 ChangePlan（遗留 293），不新增平行字段；审计记录两者 |
| I-A8 | 应用的必须是人审过的那一份：每段应用时重算干跑，内容摘要与审阅时不同即拒绝；工作区段的摘要包含它依赖的平台段 id 与该段应用时的摘要，平台段之后改过即拒绝 | 段级 `reviewedDigest`，在该段的应用事务里复查；沿用 `enable_gate_instance` 已有的 `manifestDigest` 同事务校验（`gate-instance-handlers.ts:306,337`，R-18）与 ActionRequest `operation_digest` 的模式 |

### 3.4 状态机

**GoalRun**（执行状态与目标结果分开，沿用 S10 的做法）：

```
proposed ──confirm(人：计划 + 验收检查 + 预算)──▶ running ⇄ paused ──▶ verifying ──▶ completed(achieved)
    │                                              │  (原因：人要求 / 预算 / 无进展 / 授权失效 /        │
    └─expire / reject─▶ cancelled                    需要决定 / 待核对)                         └─验收未过─▶ paused(needs_decision)
                    paused(needs_decision) ──人：按未达成结束──▶ completed(not_achieved)
                    running / paused ──cancel(人)──▶ cancelling ──(Task 已终止、待批与已批动作已撤回、执行中动作已到终态)──▶ cancelled
                    cancelling ──截止时间到、仍有 Task 未终止或执行中动作未到终态──▶ cancelled(cleanup_pending)（告警，逐条列出残留项）
                    任意非终态 ──引擎不可恢复错误──▶ failed
```

目标结果 `unknown → achieved | not_achieved`，带依据（`verified_by_check` / `requester` / `reviewer_assessed`）；`completed` 可以是
`not_achieved`（人选择按未达成结束），但 `achieved` 只能来自 I-G5 的依据。`cleanup_pending` 不等于"不会再有动作"：吊销了 Handle 的 Worker
提不了新动作，`withdrawn` 的行执行不了，但列出的 `executing` 行仍会按 R-48 收尾，结果照常入审计并显示在目标详情里。

**StepRun**：`pending`（依赖未满足）→ `ready` → `running`（有 Task 在跑）→ `waiting`（子原因：`approval` / `reconcile` / `external`）→
`running` → `succeeded`（输出通过 Schema 校验、名下所有 ActionRequest 都到终态、步骤验收通过）| `failed`（带失败分类，§4.7）；`superseded`
（被修订移除）、`cancelled`、`skipped`。`failed` 且分类为可重试、尝试次数未满 → 回到 `ready`。

**ChangePlan**（按段）：每个 ChangeSegment 走 `draft → submitted → validated | invalid → approved | rejected | expired → applying → applied |
apply_failed（本段整体回滚）→ verifying → verified | verification_failed → rolled_back`；段内单事务。整份 ChangePlan 的状态由各段派生：
`partially_applied`（有段已应用、有段未应用）是合法状态，按段显示。**段间依赖绑定版本**：工作区段依赖平台段时，它的审阅摘要包含平台段 id
与平台段应用时的摘要（对门实例就是 manifest 摘要），在工作区段 `applying` 的同一事务里复查——"平台段已生效"不够，平台段之后改过再应用
（例如换了地址），owner 的批准就会落到他没看过的版本上，所以摘要对不上即 409，要求重新审阅。**回滚按反向依赖**：有依赖它的工作区段处于
`approved` / `applied` / `verified` 时，平台段不能 `rolled_back`，要先按应用的相反顺序回滚这些工作区段。任何未应用的段可 `withdrawn`。需要人
录凭证的项落成"待配置"，属于验证状态，不是应用失败。

## 4. 目标架构 A：目标级编排

### 4.1 三个角色的分工

```
            人（请求者）──确认（计划 + 验收 + 预算）/ 暂停 / 取消 / 改目标──▶ ┌───────────────────────────┐
  入口 agent ──propose_goal（计划 v1 + 验收检查草案）──────────────────────▶ │ 确定性推进器（内核，新增） │──推进事件──▶ 对话里的系统消息 / 控制台
                                                                           │  · 持有 GoalRun 与计划      │
  outbox 事件（TaskUpdated、ActionRequestUpdated）──只置到期──────────────▶ │  · 依赖满足 → 开下一步       │──invoke（内部入口）──▶ Task / WorkerRun（现有）
  定时（next_tick_at）+ 周期对账扫描──────────────────────────────────────▶ │  · 预算、fencing、熔断       │
                                                                           │  · 执行验收检查（观察）       │──observe（请求者权限）──▶ 门（现有）
                                                                           └──────────┬────────────────┘
                                                                                      │ 需要判断时（W2）
                                                                                      ▼
                                                                        规划 Worker（一次性，提 PlanRevision，不执行）
```

- **推进器不调用模型**。依赖满足就开下一步、结果不合 Schema 就判失败、预算超了就暂停、验收不过就不宣布达成——这些全是确定性规则，
  放在内核；内核进程本来就不持凭证，也不该持模型调用。前提是验收检查经人确认（F2）、推进有周期对账（§4.2）。
- **入口 agent 负责发起与汇报**：在对话里理解目标、提计划 v1 与验收检查草案、回答"进展如何"。它不负责推进，所以用户走开不影响目标。
- **规划器（W2）是一次性 Worker**：推进器在需要判断时（步骤失败需要换路、验收不过、出现新信息）拉起它，输入是目标、当前计划、各步
  输出与失败原因；它只能提 PlanRevision，没有执行类能力；它的花费计入 GoalRun 预算。W1 里这些判断点改为"暂停 + 通知人"。

### 4.2 推进循环

1. outbox 消费者只做一件事：在它自己的短事务里把相关 GoalRun 的 `next_tick_at` 置为现在，立即返回——消费者拿不到投递事务
   （`dispatcher.ts:321`），也不应在投递路径上做推进，避免拖住全平台串行投递（§2.1 #14）。
2. 推进循环按 `next_tick_at` 认领到期的 GoalRun（`for update skip locked` + 租约到期时间），在自己的事务里推进一步；崩溃后租约过期，
   别的循环或重启后的内核接手。全部状态在库里，不依赖进程内状态（与遗留 130 的方向一致）。
3. **周期对账**：事件会进死信、消费者也可能在置到期前失败，所以推进器定期按状态扫描不一致——StepRun 在 `running` 但它的 Task 已终结；
   步骤在 `waiting(approval)` 但它的 ActionRequest 已终结；GoalRun 在 `cancelling` 但 Task 都已终止——命中即置到期。丢一个事件最多晚一个
   扫描周期，不会永久卡住（场景 S12）。
4. 定时：`next_tick_at` 同时承担超时、退避重试、审批截止提醒、`cancelling` 截止——补上 outbox 没有延时投递的缺口，不需要新的调度基础设施。
5. 每次推进写转移日志、发 `GoalRunUpdated` / `StepRunUpdated`（新事件），审计同事务。

### 4.3 计划与修订

- **计划来源**（W1）：入口 agent 经新增的 `propose_goal`（handle 通道，带幂等键）提交目标、计划 v1 与验收检查草案；或从一个已发布的
  Procedure 生成计划。请求者在控制台（或对话卡片）**确认**后才开始——GoalRun 会在人不在场时花钱、发起动作，按 propose → authorize → execute 处理。
- **确认卡片必须让人读懂验收检查**（F2）：判定式是 agent 写的，可以写成恒真。卡片把每条检查渲染成人能读的句子（"在 X 门上观察 Y，
  期望 Z"）、显示预算；对恒真、或不引用任何观察结果的判定式直接告警、不能确认。W2 起"只读计划免确认"也**不免**验收检查的确认。
- **Procedure 成为计划模板**：现有 Procedure 是有序步骤、`verify` 只是文字描述。扩展为可选的依赖、输入绑定与验收判定式；没有这些字段的
  Procedure 按顺序依赖执行。这就是设计文档 P5"Procedure 的持久执行"，不另建 Workflow 引擎。
- **修订**：W1 只允许人（或经人确认的入口 agent）在暂停点改计划；W2 允许规划器提修订，平台校验 I-G3、预算与授权后接受，重大修订
  （扩大预算、加执行类步骤、改验收检查）仍要请求者确认。已执行的步骤保留历史；被移除的步骤标 `superseded`，其 Task 按 I-G9 处理。

### 4.4 步骤的 Handle、WorkerSpec 与准入

**步骤 Handle（W1）**：推进器为每次尝试铸一个 Handle：用 `entryGatekeeperIds` 现算请求者此刻的入口范围作父 Handle，再用
`computeChildHandleScope` 收窄到步骤所需的门（I-G7）。不引入新的计算公式。步骤 Handle 默认**不含** `invoke_worker` / `find_workers`——
组队由推进器与规划器负责，预算与依赖才有单一的管理者；需要嵌套派生的步骤在计划里显式声明，并计入同一 GoalRun 预算；嵌套子 Task 记录所属 `step_run_id`，动作去重（I-G4）与 I-G9 都按它判断。目标之外的 Task
是否也改默认值是另一个决定（遗留 288），不阻塞 W1。

**WorkerSpec 与准入（W2）——原则：组合不增权**。准入函数对一个 WorkerSpec 给出三种结论：

| 结论 | 条件 |
|---|---|
| 直接运行 | Skill 全部已发布；门与 Operation ⊆ 请求者当前范围 ∩ 工作区已启用；模型在 AgentProfile 允许范围内；预算 ≤ GoalRun 剩余；职责说明里无疑似凭据（#526 计数） |
| 需要审批 | 引用了草稿 Skill（试用）、需要新的门或 Operation、预算超过工作区设定的单步阈值 |
| 拒绝 | 超出请求者授权；引用已弃用组件；能力含执行类而计划未声明执行步骤 |

准入只决定"能不能起这个 Worker"；Worker 运行中的每个执行类动作仍按现有 ActionRequest、策略与审批走，准入不预先批准任何动作。
准入通过后解析成 RunConfigSnapshot，经新增的内核内部 `invokeStep`（与 `invoke.ts` 同一建 Task 路径）建 Task；`worker_definition_id`
对组合来源可空或指向基础模板——迁移细节随 W2 定。被多次验证有效的组合，由 W4 提议沉淀为 WorkerDefinition，走现有发布。

### 4.5 步骤之间的数据交接

- 每步可声明 `outputSchema`（JSON Schema 子集，限大小）；结果契约新增可选的结构化 `output`，在 `report_result` 时校验，不合格判
  `contract_violation`（允许一次返工）。
- **Worker 的 `output` 在它名下的动作都到终态之前只是暂定的**：Worker 交结果时，被审批挡住的动作还没执行。步骤要等名下所有 ActionRequest
  到终态、步骤验收通过才算 `succeeded`，下游才能读它的输出。
- 下游步骤的输入由推进器按绑定（`{from: stepId, path}`）从上游 `output` 组装，不再靠模型阅读摘要转述。
- **产物文件（W2，GO14）**：先比较两个方案。(a) worker-supervisor 把同一 GoalRun 上游 Task 的工作目录只读挂进下游容器，保留期跟随
  GoalRun——文件本来就在主机上，且与"内核不碰文件系统"的既有边界一致（`worker-result.ts:99-111`）；(b) 内核管理的产物存储（按内容摘要
  寻址、大小上限、工作区 RLS、范围限本目标）。**建议先做 (a)**，跨主机或长期保留的需求出现再评 (b)。W1 只用结构化 `output` 与现有内联产物。
  (a) 的挂载点必须在下游 cwd 的上级链与 agentDir 之外，测试断言下游 pi 不会从中加载 `AGENTS.md`、扩展或 skills（2026-10-23 补，见 §5.7 最后一行）。

### 4.6 验收

- GoalRun 与 StepRun 都可带验收检查（经请求者确认，§4.3）。推进器在步骤或目标结束时执行：`observe_predicate` 用请求者的观察权限调门、
  对结果求判定式（复用接口清单已有的 JMESPath 映射能力），检查结果写成一条 Observation 作为证据；`fact_predicate` 查图并检查新鲜度。
- 例："修复服务"的验收是"重启后 2 分钟内健康检查为 healthy、错误率指标低于阈值"，由平台观察，不看 Worker 怎么说。
- 验收不过：W1 → `paused(needs_decision)`，附证据通知人；W2 → 拉起规划器提修订（返工、补观察、换路），受修订次数预算约束。
- `review`（独立评审模型按评分标准判定）放 W4，与 E3 评测共用评审与判定推导的展示。评分标准是代理指标，对执行该目标的 Worker 封闭；评审模型与执行
  模型分开记录，同模型时标出（GO18，2026-10-23 补）。验收检查不同：它是对真实世界状态的观察，执行者知道它就是知道目标本身。

### 4.7 恢复：失败分类与业务动作

| 失败分类 | 来源（现有信号） | 处理 |
|---|---|---|
| 暂时性（spawn 失败、网络、容器崩溃） | `spawn_failed`、`spawn_lost`、`worker_failed` | 同步骤新一次尝试（新 Task），指数退避，次数上限；Task 内部不再重试 |
| 授权不足 | 铸 Handle 失败、403 | `paused(authority_lost)`，通知人 |
| 契约不合格 | 输出 Schema 校验失败、`no_result` | 返工一次；再失败 → 需要决定 |
| 业务验证失败 | 验收检查为假 | 需要决定（W1 人，W2 规划器） |
| 结果未知 | ActionRequest 的结构化失败类别为"结果不明"（GO1 新增，见下），或发送后断开（287 修复后为 `in_doubt`） | `waiting(reconcile)`：执行该步骤声明的核对观察；看到效果 → 视为已执行并记 Decision（附证据）；看不到 → `paused(needs_decision)`，由人决定是否重新执行，**不自动重新执行** |
| 被拒绝或过期 | ActionRequest `rejected` / `expired` | 需要决定（场景 S11） |
| 预算耗尽 | 步骤或目标预算 | `paused(budget_exhausted)` |

**结果类别要可查询**（GO1）：今天 `outcome_unknown: …` 只写在审计负载里（`approval/execution.ts:372-379`；`action-executor.ts:239-241`），行上只有
`failed`；让推进器读审计负载来驱动状态是错的。GO1 在 ActionRequest 上加结构化的失败类别（列，或独立的终态，实现时定），至少区分三种：门明确
拒绝、结果不明、发送前就失败（287），推进器按它分流。

**发送前与发送后要分开**（遗留 287）：连接被拒、DNS 解析失败这类请求根本没发出的错误，可以安全判 `failed`；只有请求发出后断开、或收到
响应头后读响应体失败，才是 `in_doubt`。一律改成 `in_doubt` 会让门一宕机，每个动作都在队头当约 25 分钟的屏障。

**业务动作去重（I-G4）**：ActionRequest 记录所属 StepRun；去重键为（`step_run_id`, 门, Operation, 参数摘要）——把现有幂等键里的会话身份
`sid` 换成 `step_run_id`。同一步骤里同一 Operation 有结果不明的动作时，同类新请求先等核对完成。"重新执行"标记由人或 W2 的已接受修订
产生。门侧的幂等存储继续按 ActionRequest id 工作，不需要改协议。核对用的观察可以在 Operation 上声明（新增可选的 `reconcileWith`，指向
一个观察类 Operation 与判定式），W1 先由步骤或验收检查提供。

**一层重试 + 配置快照**：推进器建的 Task 关掉 Task 内部的崩溃重试，尝试只在 StepRun 一层，避免 StepRun × Task × WorkerRun 三层叠加；
"读快照"与"按当前授权铸 Handle"因此只在一处实现。每个 Task 写 RunConfigSnapshot；新一次尝试读快照（Skill 版本、模型、指令摘要、镜像 digest
不变）。这对目标内的 Task 推翻了 E1"重试重新解析 Skill"的做法（`lifecycle.ts:677-679`），取舍是：钉住的组件已被弃用或吊销时，这次尝试
失败并说明原因，不静默换成新组件；要换配置就是一次计划修订，留痕。目标之外的 Task 维持现状。

### 4.8 等待、取消、修订、重启与迟到结果

- **等待挂在步骤上，不挂在 Worker 上**。Worker 拿到 `pending_approval`（`await_decision` 为 true 时等 25 s 后，为 false 时立刻）照常交结果
  退出；步骤进入 `waiting(approval)`，等的是那条 ActionRequest。`ActionRequestUpdated` 到达（或周期对账发现）后：已执行 → 步骤带着动作结果
  继续（按 §4.5 的条件判成功，或按声明开一次续作 Task 做后续动作）；被拒或过期 → 需要决定。这样审批等多久都不受 Task 时长限制，也不需要
  WorkerRun 的 `suspended`。
- **恢复时复查**：从等待恢复、开始新步骤前，检查计划版本仍是当前、目标未取消、请求者授权仍在（I-G2、I-G7）。
- **取消**：GoalRun 进入 `cancelling`，不再开新步骤；运行中的 Task 走现有 `terminateTask`（`revokeWorkerRunAndDescendants` 把子孙 Handle 一并
  吊销，`task/lifecycle.ts:68-90`）。在写 StepRun 转移的**同一个事务**里，把本 GoalRun 名下 `pending_approval` 的动作和**已批准、还在门队列里
  排队**的动作改为 `withdrawn`（新增 `pending_approval → withdrawn`、`approved → withdrawn`）。执行侧不另加检查：`startActionRequestExecution`
  锁行后按转移表判断，见 `withdrawn` 即拒绝，排水器不需要知道步骤的存在。撤回后发 `ActionRequestUpdated`，让消费者立刻重新排水这个门——
  撤回的若是队头的待审批动作，不这样做同门后续动作要等下一次周期 tick（`drainer.ts:139-140`）。**已经 `executing` 的动作不能撤回**：它们按
  R-48 收尾，首个请求若没到达门，重放会真正执行一次（`action-executor.ts:368-369`）；所以 `cancelling` 要等本 GoalRun 名下的 Task 与 `executing`
  行都到终态才进 `cancelled`，截止时间到仍未到终态 → `cancelled(cleanup_pending)` 并告警，逐条列出残留项。已执行的外部动作不自动回滚；补偿是
  一个新计划步骤，按普通执行动作审批。
- **修订移除步骤**：被移除步骤的 Task 默认终止，待批与已批未执行的动作在修订生效的同一事务里撤回，`executing` 的按 R-48 收尾（同取消）。人可以
  对某一步选择"让它跑完"：它的结果照常入库，但它的新 `request_action` 被拒绝（I-G9）；它声明过的嵌套子 Task 记录同一 `step_run_id`，同样被拒
  （"让它跑完"不吊销 Handle，不这样做子 Task 会绕过检查）。已提交的动作在**确认修订的同一步**逐条决定：放行的行保持原状态，其余改为
  `withdrawn`——不新增"放行"状态，放行记审计。
- **迟到结果**：属于被取代版本或已取消步骤的 Task 结果照常入库、入审计，不推进（I-G2）。
- **重启**：推进状态全在库里，租约过期即被重新认领；outbox 至少一次投递导致的重复事件被 I-G1 与状态守卫的 UPDATE 吸收；丢失的事件由周期
  对账补上。

### 4.9 预算与熔断

GoalRun 预算：累计 token / 费用（各 Task 的 `tokens_used` + 规划器用量）、步骤总数、修订次数、墙钟时长、最大并行 Task 数。默认值来自工作区
配额（owner 可调，平台设上限，与 S10 决定 8 同一处），确认卡片上显示。**无进展熔断**：连续 K 个判断点没有步骤成功、没有验收项变好 →
`paused(no_progress)`。现有单 Task 预算、每用户并发 5、工作区每日预算继续生效；GoalRun 的并行受两者中较小者约束，排队是推进器的事。

### 4.10 并发与资源冲突（W2）

现有排水器按（工作区 × 门）串行，待审批队头会挡住同门后续动作（§2.1 #11）。一个 GoalRun 里一步等审批，会挡住别的步骤乃至别人。
W2 细化为按"门 × 目标资源"排序：Operation 已有 `reads` / `writes` 的 ObjectType 声明，结合参数里的目标身份决定冲突域；不同目标的写可并行，
同一目标保持顺序（保留 R-50 / D-10 的顺序保证在冲突域内成立）。改动在治理核心，单独一个 PR、xhigh 审查。

### 4.11 任务级观察范围（W2，与 E3 共用）

WorkerSpec 可声明观察允许的门集合，推进器把它作为 Task 级的 `ObserveExclusions` 与现有谓词取交（`observe-access.ts` 的
`observeRefusal` 不改判定逻辑，只多一个来源）。S10 E3 的 `purpose=evaluation`（I-E1）是同一机制的一个用法——**只实现一次**。

### 4.12 能力发现（W2）

`find_workers` 补：过滤后再截断（遗留 291）；空结果给原因（无匹配 / 被权限过滤 / 被个人设置排除，同 `find_operations` 的
`reachability`）；返回结构化字段——输入输出契约（WorkerDefinition 新增可选的 `inputSchema` / `outputSchema`）、所需门与可达性、历史成本
中位数、版本成效（E2 的统计扩到 WorkerDefinition 版本）。成效只作提示字段、不作排序键（S10 C3 的冷启动理由不变）。

### 4.13 上下文

每步的上下文由推进器组装：目标与约束、本步职责、已绑定的上游输出、相关 Fact（带 `observed_at`）、未决问题。**写前复核**作为建议规则：
执行类动作所在的步骤，若目标对象的最近观察早于新鲜度窗口，先观察再提交（W2 起可在准入里强制）。`precedents` 与历史经验召回放 W4。
先例（GO17）引用完整记录而不是摘要：PlanRevision、目标结果与 `basis`、证据 Observation id；只有 `verified_by_check` 且未被覆盖的作为正例，
`overriddenChecks` 与 `not_achieved` 标为反例（2026-10-23 补）。

### 4.14 控制台（随各波次交付，不允许"后端先上、界面以后补"）

- **我的目标**（新页，使用组）：列表显示状态、目标结果、预算消耗、在等什么。
- **确认卡片**：步骤与依赖、每条验收检查的可读句子与告警、预算；确认 / 修改 / 拒绝。
- **目标详情**：步骤依赖图与状态（等待原因直接链到审批卡片或核对项）；计划版本时间线（谁、为什么、差异）；验收检查与证据（观察结果、时间）；
  费用对预算；操作：暂停、继续、取消、改目标（= 由人提一个修订）、按未达成结束；`cleanup_pending` 时显示残留项。
- **对话**：发起目标的对话里，里程碑以系统消息出现（复用 `system.task_update` 的通道），用户不用来回切页面。
- W2 加：WorkerSpec 详情（与 WorkerDefinition 的差异、准入结论与理由）；W4 加：评审判定推导。

## 5. 目标架构 B：平台管理员 Agent

### 5.1 定位

**内置的管理员 Agent 与外部 agent（例如经 MCP 接入的 Claude Code）的区别只在运行位置，不在权限。** 维护者要的是"不必每次去外面开一个
agent 会话来改平台"，不是"给平台里的 agent 更大的权"。所以它复用同一套治理：agent 提议、平台校验、人授权、平台执行、平台验证。
在配置层，外部 agent 今天能做的（起草 Operation 分类、Skill、WorkerDefinition、本体提议）它都能做，并且多两样：读平台状态的只读投影，
和把多项配置打成一个按授权分段的 ChangePlan 提交的通道。代码层（开 PR）今天外部 agent 线程能做，但让平台内置的 agent 做，是推翻 S10 的
I-N1，列为待定（§5.5）。

### 5.2 身份与运行

- 平台管理员在控制台启动它（独立于个人入口 agent 的对话与容器）；它的 Principal 在**试验工作区**，`on_behalf_of` 是该管理员在试验工作区的
  human Principal，并记下对应的平台用户——每次调用检查该用户当前仍是平台管理员（I-A3）。
- Handle 用来源绑定（I19），不出容器；不签 API key、不用 service Principal（I-A1）。
- 能力上限 `ADMIN_AGENT_CEILING`（新增常量，与入口、Worker 上限并列）：入口上限 + 只读的平台状态投影（门实例与健康、连接器三态、运行层盘点、
  版本提醒、不变量指标、脱敏后的平台审计）+ 读定义类能力（`list_worker_definitions`、`get_skill` 等）+ `propose_change_plan` +
  在试验工作区内的 `invoke_worker`（W1 之后可用 GoalRun）。**不含**：任何 human 通道能力、`scope:'platform'` 写能力、生产工作区的任何动作、
  任何代码托管类能力。
- 平台状态投影是新增的 handle 通道只读能力，字段按"不含凭证、不含内网地址细节"另定投影，不复用管理员页面的读接口（那些是 cookie 专用）。

### 5.3 三层能力

| 层 | 管理员 Agent 能做 | 生效需要谁 | 证据 | 回滚 | 审计 |
|---|---|---|---|---|---|
| **配置层** | 在试验工作区：`request_connection`、导入 OpenAPI / MCP 工具清单、观察试探、试跑 Worker；起草 Operation 分类、WorkerDefinition、Skill、Procedure、本体变更、门实例配置（无凭证）、连接器预设；组装 ChangePlan 提交 | 按段：平台段由平台管理员应用，每个工作区段由该工作区 owner 应用。授权扩大项逐项确认（I-A4）；凭证由人直接录入门宿主（I-A5）；应用的必须是审过的那份（I-A8） | 试验工作区里的 Task、观察、审计；授权影响分类；平台段的干跑差异在平台面，工作区段的干跑差异只在该工作区 owner 的会话里生成和显示（§5.4）；（W4 后）评测判定；应用后的验证检查 | 弃用组件（只弃用不删，I-P4 同义）、停用门实例、平台设置回到上一版（`platform_settings` 已保留上一版）；每项记录逆操作，**先比较再写**：只在当前版本仍是本段写入的版本时才回退，中间有人改过就停下交人；段内整体回滚；有依赖段已应用时平台段不能先回滚（§3.4） | 每个 ChangeItem 一条审计：起草者种类、批准人、应用人分开记录（I-A7） |
| **代码层（待定）** | W5 决策门通过之前：**无**。通过之后的设想见 §5.5 | — | — | — | — |
| **部署层** | 只读准备：目标版本、迁移、breaking、对应 runbook 小节、前置检查（备份新鲜度、预发运行链接），生成部署请求 | 维护者在主机执行（S10 决定 3：不做一键升级；无 docker socket） | 主机输出按 runbook 记 `docs/private/` | `apply-release.sh` 与 `release.md` 的回滚 | 主机记录 + STATUS |

### 5.4 配置层：ChangePlan（与能力包共用核心，按授权分段应用）

- **一个核心，两种来源**：S10 的 Pack v1 安装计划（读清单 → 干跑 → owner 确认 → 发布 → `verify_pack`）与管理员 Agent 的提案共用"干跑、分类、
  分段应用、验证、逆操作"。不建两套。
- **必须分段**（已核实）：平台调用者只能调 `scope:'platform'` 的能力、够不到任何工作区能力；工作区 Principal 也调不到平台能力
  （`authorize.ts:84-98`，P-A1）。S10 的 PackInstallation 本来就是"每个工作区 × 包族一行"，单事务只在一个工作区内成立，平台级组件只做
  "是否已就位"检查（S10 方案 §3.1、§3.3、§6.3）。所以一个 ChangePlan 拆成按授权排序的段：先平台段（平台管理员在平台面应用），再每个工作区一段
  （该工作区 owner 在该工作区应用）；**段内单事务、段间不单事务**；工作区段绑定它依赖的平台段的版本与摘要，在应用事务里复查（§3.4、I-A8）；
  整份计划可以处于"部分应用"。
- **工作区段的内容只在该工作区可见**（隔离只增不减）：工作区段的校验与干跑要读生产工作区的内容（引用能否解析、命名空间是否冲突），而平台面
  今天只看得到工作区的 id 与名称（`shared/src/wire/platform.ts:618-627`；P-A1）。所以工作区段的校验、干跑与差异只在该工作区 owner 的会话里执行
  和显示；平台面与管理员 Agent 只看到段的状态（已提交、已应用、被拒等）和 owner 愿意写下的理由，不回传校验细节——否则就开了一条跨租户的读
  通道，管理员 Agent 也能借提交或校验结果试探生产工作区里有什么。平台把一个段递给工作区，沿用"平台提供、工作区自取"的模式（同
  `list_available_gate_instances` / `enable_gate_instance`）。管理员 Agent 起草时的引用检查只针对试验工作区与平台目录。
- **ChangeItem 只能是对现有发布 / 配置能力的调用意图**（`publish_operation`、`publish_worker_definition`、`publish_skill`、`publish_ontology_version`、
  `create_gate_instance`、`enable_gate_instance`、`set_connector_mode`……），应用时由该段有权者的会话在一个事务里调用这些能力的内部函数——agent
  没有新的写路径，人点"应用"等于逐项替 agent 调了一遍已有能力，授权仍按那个人的角色判。
- **应用绑定摘要**（I-A8）：人审阅时记下该段的内容摘要；应用时重跑干跑，摘要不同就拒绝（409，提示重新审阅）。
- **授权扩大分类器是白名单**（I-A4）：对 ChangeItem 的**全部字段**逐字段比较，只有落在"已证明不扩大授权"集合里的变化才放行，其余一律
  `authority_widening`。现有的 `operationGovernanceChangeDirection` / `classifyOperationGovernanceChange` 只是其中一部分：它只比较 `mode`、
  `blast_radius`、`auto_approvable` 三个字段（`manifest.ts:1086-1121`，注释写明有意不含 `await_decision`、`reversibility` 与 MCP 提示），三者都
  不变时返回 `neutral`（`:1185-1194`）——`neutral` 不证明任何事，`loosened` / `mixed` 算扩大。至少下列变化必须逐项确认：
  - **Operation**：三个治理字段的放宽（execute → observe 即免审，`MODE_STRICTNESS`；`blast_radius` 降级；`auto_approvable`）；已有执行类 Operation
    的 `binding`（ssh 的命令模板 / 命令模式，http 的路径与方法）；`params_schema` 放宽；门侧固定参数（gate-owned params，遗留 J）；`reversibility`；
    `await_decision`；MCP 的 `destructive_hint` / `idempotent_hint`（MCP 执行动作能否免审正取决于这两个提示，`request-action-handler.ts:1405-1425`）；
    **新建执行类 Operation 的分类**本身（分类就是审批边界，且是 agent 起草的）。反例：一个 `auto_approvable`、低影响的 Operation，名字和三个治理
    字段都不变、只换了命令——不逐项确认，新命令就会在没人审的情况下执行。
  - **门实例与组件**：已有门实例的地址或传输（凭证会随之发往新地址）；WorkerDefinition 的执行类 `capabilities` 与 `egressDeny`；Skill 正文（会进入
    所有加载它的 Worker 的 prompt）。
  - **策略与平台设置**：工作区策略的 `requester_can_approve`（它是工作区策略与本体 ActionType 的字段，不是 Operation 字段，
    `governance/policy/engine.ts:64`）、「始终允许」、MCP `vetted`、连接器三态放宽、允许模型、出网放行、`instanceInstructions`。
  mode 的权威在内核登记的已发布定义：门侧按摘要绑定的定义校验 mode（`gatekeeper-base.ts:161,210`，#538），所以门侧拒绝是第二道，不是分类器
  可以省掉的理由。
- **校验**：引用可解析、命名空间不冲突（I-P1）、无凭证（I-A5）、非自指（§3.2）、段内只含一个授权主体；工作区段的校验在该工作区 owner 的会话里
  执行（见上）。
- **第一版收窄**（建议）：P1 先做工作区段（含"平台组件是否已就位"检查），平台项保留为人工清单（S10 原本就是这么做的）；平台段随 AA3 再做。
- 一个验证有效的 ChangePlan 可以"导出为能力包"——管理员 Agent 接进来的系统，能变成别的部署可以装的包。这是产品化的出口。

### 5.5 代码层：W5 开工前的决策门（待定）

**为什么不能现在定**（已核实 / 项目记录）：

- S10 明确记录"代码自修改方向本项目明确不做"（S10 方案 §5.1 末段、§5.7；I-N1："无任何写这些对象的 agent 能力"）。管理员 Agent 往平台自己的
  仓库推分支、开 PR，是**推翻**这条决定，需要维护者明确取代 I-N1。
- "维护者本人审"今天没有系统机制兜底：本项目所有 agent 会话在 GitHub 上都以同一个维护者账号行事，CODEOWNERS 或"要求 code owner 审"
  任何一个 Claude 审查会话都能满足；分支保护只要求 4 个检查；合并线程有常设的直合授权。真正只能由人做的只剩部署，而部署窗口成批上线，
  不逐个读 diff。

**决策门的前提**（两条都满足才开 W5）：

1. 维护者明确取代 I-N1 与本节的"明确不做"，写进 S10 方案与 STATUS 的决定记录。
2. 有一个任何 agent 会话都拿不到的审批身份，并由仓库规则强制：例如只给人用的独立 GitHub 账号作为必需审查者，或 ruleset 的 bypass 列表排除
   所有 agent 令牌；合并线程的直合授权不覆盖 agent 起草的代码 PR。

**通过之后的设想**（供决策时参考，不是承诺）：代码托管门持有的令牌只对一个 fork 有写权限、没有 workflow 权限（GitHub 拒绝无该权限的令牌推送
`.github/workflows/`——来源声明，未实测）、没有合并与管理权限；推送与开 PR 是执行类 Operation，走 ActionRequest；**受保护路径默认拒绝**——
agent 起草的 PR 默认都要人审，只对低风险路径白名单放行（治理、网关、门、Handle、内部鉴权、supervisor、llm-proxy、gatekeeper-base、
`ontology/*.yaml` 这类 prompt 一律不在白名单）；`pull_request_target` 触发的工作流（今天有 `auto-merge.yml`、`pr-title.yml`）加守卫：任何此类
工作流都不检出 PR 头。运行位置的现实约束（推断）：主机拉 GitHub 慢，代码 Worker 跑在哪要在决策时一起定。

W5 之前的路线（W0–W4）不依赖这一层；管理员 Agent 在配置层表达不了的改动，照今天的做法由人在外部 agent 线程里改。

### 5.6 部署层

不变：发版应用只经 `apply-release.sh`，由维护者执行或由主机操作会话在维护者明确同意后执行。管理员 Agent 最多准备部署请求与检查单，
控制台的版本提醒已经给出命令（遗留 140 的旧副本问题照旧要修）。

### 5.7 防止自扩权（机制，不靠 prompt）

| 风险 | 机制 | 现状 |
|---|---|---|
| agent 批准自己的提议 | Handle 结构上不能带 human 通道能力；`publish_*` / `approve` / `grant_capability` / `set_policy` 都是 human 通道 | 已有（`handles.ts:82-94`；`authorize.ts:101-103`） |
| 走 service API key 绕过人 | 管理员 Agent 只用来源绑定的 Handle；守卫测试断言其身份不是 API key、上限不含 human 通道能力 | 新增 |
| 改自己的能力上限 | 上限是代码常量；它没有代码托管类能力；改上限 = 人合入代码 + 维护者部署 | 新增常量与 CI 守卫 |
| 改约束自己的配置 | ChangePlan 自指校验：不能改它自己的定义、Skill、试验工作区授权、策略 | 新增 |
| 借合法变更夹带授权扩大 | 白名单分类器（全字段比较，治理三字段的方向只是其中一部分）+ 逐项确认 + 不能与其他项一键应用；被确认的项写审计 | 新增（模式同 #526「已核对凭据」；三字段方向复用 `operationGovernanceChangeDirection`，`neutral` 不算证明） |
| 审过 A、应用的是 B | 段级内容摘要绑定，应用时重跑干跑，不同即 409；工作区段还绑定所依赖平台段的摘要 | 新增（模式同 `enable_gate_instance` 的 `manifestDigest` / `manifest_changed`） |
| 借提交或校验结果试探生产工作区 | 工作区段的校验、干跑与差异只在该工作区 owner 的会话里；平台面与管理员 Agent 只见段状态 | 新增 |
| 管理员降级后 agent 继续工作 | 每次调用检查 `on_behalf_of` 用户的当前平台角色 | 新增（签发时检查不够） |
| 凭证经过 agent | ChangePlan 无凭证字段；凭证页面直达门宿主 | 已有路径（`platform-admin-design.md` §6.3）+ 新 schema |
| 改 CI 或治理代码偷渡 | W5 决策门之前没有代码层；之后见 §5.5 的前提与默认拒绝 | 待定 |
| 刷屏、反复提同一个被拒的提议 | 每天提议配额；同一目标多次被拒后熔断，被拒记录对它可见 | 新增（S10 E3 的防噪规则同源） |
| 需要立即停下它 | 停止开关放在环境变量（被劫持的管理员会话改不了，同 `platform-admin-design.md` §6.6 的原则）+ 吊销其 Handle | 新增 |
| 运行时自写资源持久化（在持久工作目录写 `AGENTS.md`、扩展、MCP 配置，下次会话自动加载，等于不经 ChangePlan 改自己的行为） | 白名单启动：关掉 pi 的全部资源发现，`settings.json` 由平台整份写入，平台扩展与 Skill 显式传入；守卫测试在 U2 套件 | 遗留 422，AA5 之前关闭（2026-10-23 补） |

### 5.8 走一遍：让它接入一个有 OpenAPI 的工单系统

1. 管理员在管理员 Agent 的对话里说"把工单系统接进来，运维工作区要能查工单、建工单"。
2. 它在试验工作区 `request_connection(http, 工单系统地址)` → 管理员在卡片里录入一个测试账号的凭证（直达门）。
3. 它导入 OpenAPI，起草 Operation 分类：`GET /tickets` 观察类、`POST /tickets` 执行类中影响；跑几次观察核对映射与字段。
4. 它起草一个"工单助手"WorkerDefinition 与两个 Skill，在试验工作区试跑（建单的动作照常走审批，管理员在试验工作区批）。
5. 它组装 ChangePlan，分两段：**平台段**（`http` 门实例配置，无凭证）；**运维工作区段**（启用门、发布 Operation 分类、发布 WorkerDefinition 与 Skill）。
   分类器把"新建执行类 Operation `POST /tickets` 的分类"和 Skill 正文标为需要逐项确认。
6. 平台管理员在平台面审阅平台段、录入生产凭证、应用；运维工作区 owner 在该工作区审阅工作区段（差异在他的会话里生成；看差异、试验证据、逐项
   确认）、应用——工作区段的审阅摘要绑定平台段应用时的摘要，在应用事务里复查；验证检查跑一次观察 → `verified`。平台面与管理员 Agent 只看到
   工作区段"已应用"。管理员本人若也是该工作区 owner，就是同一个人在两个面上各点一次。
7. （可选）把这个 ChangePlan 导出为 `tickets` 能力包。

人做的事：录两次凭证、批一次试验动作、按段审阅与逐项确认、每段点一次应用。其余由它完成，全程有审计与溯源。

### 5.9 控制台

管理组新增：**管理员 Agent**（对话 + 它的目标与在途提案）、**变更计划**（列表与详情：平台段显示差异、授权影响分类、逐项确认、证据、应用、验证、
回滚；工作区段只显示状态与 owner 写下的理由；部分应用状态）。生产工作区的 owner 在"能力目录"里看到待自己确认的工作区段，它的差异、校验结果与
逐项确认只在这里生成和显示。代码提案页随 W5 决策门再定。

## 6. 与现有路线的关系

### 6.1 排序

下表的 S10 波次写全称；本文其余处不带阶段前缀的 W0–W5 都指 S11 的波次，排号见 `global-roadmap-2026-10-16.md`。

| 现有项（`STATUS.md` §3） | 处理 | 理由 |
|---|---|---|
| 控制台阶段收尾（出口标准 1、4 随主机窗口） | **不变**，主机窗口仍由维护者定 | 已在收尾 |
| 遗留 229（+228）入口实时上下文缓存 | **已完成**（#575 合入，#578 关闭），付费实测按维护者已批的一次执行 | 也是 W1 规划与验收花费的前提 |
| 治理 P1 181、P2 218、232 | **保留并前移到 W0** | 218（「始终允许」不绑定定义摘要）在自动推进下影响放大；232 的未知动作名同理 |
| S10 W2a：48 ② 族 id → E2 统计 → 详情页 | **保留，作为 W1a 与 W1 并行**（文件不重叠） | W2 的准入与发现要用同族版本与成效统计 |
| S10 W2b：214、P0b → Pack v1 + ops-base | **成为 W3 的前半**：Pack v1 的安装计划做成 ChangePlan 核心（P1 改造，按授权分段） | 一个机制两种来源，不建两套 |
| S10 W2b：U2 运行时一致性套件、U1 余项 | **保留，常驻低优先级车道 L** | 与主线独立 |
| S10 W3：P2 knowledge 包 | **仍是 P1 的验收**：手写包走 ChangePlan 核心 | S10 G5"第二个非运维领域包"不依赖管理员 Agent 能否成功 |
| S10 W3：E3 评测 MVP | **排到 W4**（W2 之后） | 任务级观察范围在 W2（GO11）一次做好；评测成本依赖 229 |
| S10 W4：P3 OpenMetadata 包 | **让路**为 W3 的可选验收场景 AA6 | 收敛优先 |
| S10 W4：E4 个人记忆 | **推迟**，W3 完成后重评 | 收敛优先 |
| 设计文档 P5：Workflow 引擎、turn 挂起式审批 | **由 GoalRun 吸收** | §4.3、§4.8 |
| 遗留 10：Trigger、`extension_ui_request`、CLI 清单解析 | **仍推迟**；Trigger 将来直接创建 GoalRun | GoalRun 提供了它缺的持久执行半边 |
| 遗留 230：主机上的真实日常旅程 | **保留**；建议维护者选的旅程直接做成 W1 的第一个真实 GoalRun（GO7） | 评测与验收共用真实数据 |

### 6.2 本次核对发现、建议新增的遗留（由合并线程写入 STATUS；287–293 已预留给本方案）

1. **287** 第一次执行时的网络错误一律记成普通 `failed`：发送前失败（连接被拒、DNS）可以安全判失败，发送后断开与收到响应头后读失败应为
   `in_doubt`（`action-executor.ts:219-235,353`；`adapters/gatekeeper-client/index.ts:455,487`）——P1（可靠性，外部动作）。
2. **288** 决定：Worker 默认能力是否保留 `invoke_worker` / `find_workers`（`handles.ts:208-213`；`handle-mint.ts:399-401`）。这是 S2.7 有意的嵌套
   派生设计，不是缺陷；容器内可直接调用为推断。若改，迁移语义要写明：没写 `capabilities` 的已有定义会少掉 `invoke_worker`。目标内的步骤 Handle
   已按 §4.4 默认不含，不阻塞 W1——P3。
3. **289** 崩溃重试的 Handle 沿用失败那次 run 的能力与门列表（`lifecycle.ts:611-713`）；执行已由 R-37 / D-20 按当前授权复核
   （`request-action-handler.ts:1343-1359`），残余是非执行类能力与工具列表里会出现已收回的门（调用时被拒）——P3；目标内的 Task 不用 Task 内部重试，不受影响。
4. **290** Task 时长计时不因 `waiting_approval` 暂停（只影响 `await_decision:true` 的路径），长审批让 Task 超时失败（`reaper.ts:343-358`）——P3；目标内的步骤
   等待挂在 StepRun 上（GO3），不受影响，目标之外的 Task 仍在。
5. **291** `find_workers` 的 `limit` 在权限与状态过滤之前执行，被过滤的行占名额（`find-means.ts`、`service.ts:565-604`）——P3。
6. **292** 文档漂移：`packages/platform-extension/README.md` 与 `modes/entry.ts:55-57` 仍说 `find_workers` / `invoke_worker` 尚未注册；`kernel/src/index.ts:274`
   的注释说 `await_decision` 默认超时 90 s，常量是 25 s——P3。设计文档 §7.4 的两行已在本 PR 改正。
7. **293** Skill / Procedure / WorkerDefinition 草稿分不出 agent 起草：Operation 有 `origin`、本体有 `proposer_kind`，这三类没有
   （`dispatch.ts:140-141,147`）——P3（随 W3 的 AA3 收掉，沿用现有字段）。

## 7. 迁移路线

### 7.1 波次

阶段记为 **S11「目标级执行与平台管理员 Agent」**（F1）。每个波次都是"合入 → 发版 → 主机应用 → STATUS 更新"的闭环；任务编号、
依赖与逐项验收见 `global-roadmap-2026-10-16.md`，这里只给每波的内容与出口。

| 波次 | 内容（任务号） | 前置 | 出口 |
|---|---|---|---|
| **W0 收尾与前置**（小，可与在途并行） | 治理 181、218、232；新遗留 287、291；主机窗口 H1 与控制台阶段关闭 | 无 | 各自的回归测试；287 是 W1 的硬前置 |
| **W1 可靠多步执行** | GO1 数据与转移、GO2 推进器与对账、GO3 恢复 / 等待 / 取消 / 修订、GO4 验收、GO5 能力与入口 prompt、GO6 控制台、GO7 主机验收与第一个真实目标；并行车道 W1a：48 ②、E2 | W0 的 287 | §7.2 场景 S1–S12 在主机通过 |
| **W2 动态组队与改计划** | GO8 WorkerSpec 组合与准入（含决定 288）、GO9 规划 Worker 与自主修订、GO10 预算全量与无进展熔断、GO11 任务级观察范围（与 E3 共用）、GO12 按目标资源的执行队列、GO13 能力发现增强、GO14 产物交接、GO15 控制台 | W1；48 ② | 一个目标中途一步失败，规划器换路后达成；组合 Worker 在授权内直接运行、越权的被拒或转审批；一步等审批不挡同门其他目标资源的动作 |
| **W3 管理员 Agent 配置层** | 214、P0b、P1（ChangePlan 核心，按授权分段 + 摘要绑定 + 白名单分类；验收 = ops-base + 手写 knowledge 包）；AA1 身份与上限、AA2 平台状态投影、AA3 试验工作区、`propose_change_plan` 与平台段、AA4 控制台、AA5 验收旅程（工单夹具）、AA6（可选）OpenMetadata 包 | P0b → P1；AA1；**不依赖 W1**（与 W1 并行受并发上限约束） | §5.8 的旅程端到端；§5.7 的守卫测试全部通过 |
| **W4 经验沉淀** | E3 Skill 评测 MVP；GO16 组合沉淀提议；GO17 先例与经验召回；GO18 `review` 类验收 | W2；229 已落地 | S10 G4；一个反复验证有效的组合被提议为定义并经人发布 |
| **W5 管理员 Agent 代码层（待定）** | 决策门 D-W5（§5.5 的两条前提）；通过后再排 AA7–AA10 | W3；维护者决定 | 决策门通过前不开工；W0–W4 不依赖它 |

### 7.2 W1 的最小可交付版本

**做**：

1. **数据与状态**：GoalRun、PlanRevision、StepRun 三张表（新内核模块，迁移归该模块）；转移表进 `shared/src/transitions.ts`，DB 约束与定时
   不变量检查同步加（I-G1、I-G2、I-G6、I-G9）；Task 新增 `goal_run_id`、`step_run_id`、`plan_revision`、尝试号与 RunConfigSnapshot；ActionRequest
   新增所属 StepRun 与结构化失败类别（门明确拒绝 / 结果不明 / 发送前失败）；`pending_approval → withdrawn`、`approved → withdrawn` 转移。
2. **能力**：`propose_goal`（handle，入口上限，带幂等键；计划只能引用已发布的 WorkerDefinition@version 或已发布 Procedure）、`confirm_goal`（带幂等键）/
   `pause_goal` / `resume_goal` / `cancel_goal` / `revise_goal`（human）、`get_goal` / `list_goals`（读，入口上限内可读自己的）。
3. **推进器**：`next_tick_at` + 租约认领；outbox 消费者只在自己的短事务里置到期；周期对账扫描；步骤用内部 `invokeStep` 建 Task（同一事务写 StepRun
   转移，I-G1），Task 关掉内部重试；每步按 I-G7 铸 Handle（默认不含派生能力）；新尝试读快照；步骤范围的动作去重与 `waiting(reconcile)`；等待挂在
   步骤上；取消、修订移除、暂停、继续；`request_action` 的 I-G9 检查，撤回与 StepRun 转移同事务、执行侧靠行状态，撤回后发 `ActionRequestUpdated`
   触发重新排水；`cancelling` 等执行中动作到终态；迟到结果 fencing；GoalRun 预算（token、步骤数、墙钟）超出即暂停。
4. **验收**：`observe_predicate`、`fact_predicate`、`requester_confirm`；确认卡片的可读渲染与恒真告警；不过即 `paused(needs_decision)`。
5. **控制台**：我的目标、确认卡片、目标详情（步骤图、等待原因、版本时间线、验收证据、费用、操作按钮）、对话里的里程碑消息。
6. **入口 agent 的 prompt**：何时提目标（多步、跨系统、需要等待）而不是逐轮推进；怎么写人能确认的验收检查。

**不做（留 W2 及以后）**：规划器自主修订、组合 WorkerSpec、产物文件交接、按目标资源的队列、任务级观察范围、`review` 类验收。

**验收场景**（CI 集成测试 + fake-llm e2e 旅程 + 主机验收脚本，主机脚本命名随 runbook 惯例在实现时定）。维护者列的 6 个失败场景对应
S1（用户不再发消息）、S2（服务重启）、S3（重复事件）、S4（响应丢失先核对）、S5（审批后继续）、S6（验证失败不宣布完成）；S7–S12 是审查补的。

| # | 场景 | 断言 |
|---|---|---|
| S1 | 用户发起目标（A、B 并行，C 依赖 A、B）并确认后不再发消息 | 三步全部完成；期间没有产生新的 `TurnStarted`；对话里出现里程碑消息 |
| S2 | 某步 Task 运行中、推进事务进行中分别杀掉内核；另跑一次重启 worker-supervisor | 重启后继续；每步每次尝试恰好一个 Task；没有步骤被跳过 |
| S3 | 同一 `TaskUpdated` / `ActionRequestUpdated` 事件投递两次；同一 `propose_goal` / `confirm_goal` 以同一幂等键重发 | 不重复建 Task、不重复推进；不重复建 GoalRun、不重复确认 |
| S4 | 夹具门执行成功但丢掉响应，且门的幂等重放也返回 `apply_outcome_unknown`（绕过 R-48 重放，否则走不到核对路径） | 步骤进入 `waiting(reconcile)`；核对观察看到效果后判成功；门侧该动作执行计数为 1。反向：核对观察看不到效果 → `paused(needs_decision)`，不自动重新执行，门侧计数仍为 1 |
| S5 | 一步含需审批的执行动作，审批时间超过 Task 时长上限（测试里调短）；`await_decision` 为 true 与 false 各跑一次 | Worker 退出后步骤 `waiting(approval)`，目标不失败；批准并执行后，名下动作都到终态、步骤验收通过才判成功，下一步自动开始 |
| S6 | 各步都报告成功，但验收观察为假 | 目标不进入 `completed(achieved)`；暂停并附证据；人选"按未达成结束"后为 `completed(not_achieved)` |
| S7 | 运行中取消目标，此时有一条待审批动作（在门队列队头）、一条已批准还在门队列里排队的动作；另一次取消时，有一条动作处于 `executing` 且结果不明 | 不再开新 Task；运行中的被终止；两条动作都变 `withdrawn`，门侧执行计数为 0；同门里别的目标的后续动作随即被排水，不等周期 tick。另一次：目标停在 `cancelling`，截止后为 `cleanup_pending` 并列出那条 `executing` 动作；它按 R-48 收尾，结果入审计 |
| S8 | 人改计划移除一个运行中的步骤；另一次对该步骤选"让它跑完"，并在确认修订时放行一条已提交的动作 | 默认：其 Task 与子孙被终止、动作撤回；"让它跑完"：结果入库入审计但不推进，它和它的嵌套子 Task 的新 `request_action` 被拒绝；放行的那条照常走审批与执行，其余变 `withdrawn` |
| S9 | 运行中把请求者降为无该门授权的角色 | 下一步不开始，目标 `paused(authority_lost)` |
| S10 | 累计 token 超出目标预算 | 目标 `paused(budget_exhausted)`，不是失败 |
| S11 | 一步的执行动作被拒绝；另一次审批过期 | 步骤与目标进入需要决定，不自动重试同一动作 |
| S12 | 丢掉一个 `TaskUpdated`（让消费者失败直到进死信） | 周期对账在一个扫描周期内发现并推进；目标不卡住 |

真实模型：W1 的 S1–S12 全部可在 fake-llm 上跑；合入后按惯例做一次付费真实模型回归，需维护者届时在线程里亲口批准。

**估计规模**（推断）：内核三个 PR（数据与转移 → 推进器、对账与恢复 → 验收、取消与 I-G9），控制台一个 PR，入口 prompt 与 e2e 随最后一个；每个内核
PR 走 xhigh 审查（状态完整性与授权）。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| 新主线让范围再次膨胀，违背收敛优先 | W1 只用已发布 Worker、不调模型的推进器、一层重试；P3 / E4 明确让路；代码层推迟到决策门；每波有可验收的出口 |
| 自动推进放大治理缺口（「始终允许」不绑摘要、未知动作名） | 218、232 与 287 都在 W0，先于 W1 |
| 推进器成为新的单点与复杂度来源 | 状态全在库、租约认领、周期对账、无进程内状态；推进规则全部确定性、可单测 |
| 目标在人不在场时花钱，或"通过了但没做对" | 计划、验收检查、预算都需确认；恒真判定式告警；GoalRun 预算与无进展熔断；超出即暂停不重试；请求者可标未达成；W4 用真实达成率校准 |
| 被取消或被修订掉的步骤仍产生动作 | I-G9：`request_action` 入口检查；撤回与步骤转移同事务，执行侧靠行状态；`executing` 的按 R-48 收尾并在 `cleanup_pending` 列出；场景 S7、S8 |
| 一步等审批挡住同门其他动作 | W1 接受（与今天一致），在目标详情里写明"在等谁"；W2 按目标资源细化 |
| 管理员 Agent 被注入后提出看似合理的变更 | 它只能提议；白名单分类 + 逐项确认；摘要绑定；自指拒绝；试验与生产分离；变更有逆操作 |
| 人对 ChangePlan 走过场 | 授权影响分类由平台算、差异与证据同页；授权扩大项不能一键通过；（W4 后）评测判定 |
| 变更计划部分应用后不一致 | 段间依赖绑定平台段摘要；部分应用是可见状态；回滚按反向依赖，逆操作先比较再写 |
| 代码层在没有可强制的人审身份时被打开 | W5 决策门的两条前提；W0–W4 不依赖它 |

## 9. 验证

- **功能**：§7.2 场景 S1–S12；W2、W3 各自的出口与 `global-roadmap-2026-10-16.md` 的逐项验收。
- **状态**：GoalRun、StepRun、ChangeSegment 只沿 §3.4 的转移走（转移表 + DB 约束 + 定时检查 + 测试）。
- **授权**：每步的 Handle 是请求者当前授权与步骤所需的交集（集成测试改角色后断言）；非当前步骤的 Task（含其嵌套子 Task）提交动作得 403（I-G9）；管理员 Agent 的
  Handle 调任何 human 通道或平台写能力得 403（守卫测试）；上限常量不含禁止类能力（CI 守卫）；分类器对未列入白名单的字段变化一律给出
  `authority_widening`（表驱动测试，至少覆盖 `binding`、`params_schema`、门侧固定参数、`reversibility`、`await_decision`、MCP 两个提示各自单独变化、
  治理三字段 `neutral` 时）。
- **隔离**：工作区段的校验结果与差异在平台面与管理员 Agent 的任何读接口里不可见（测试）。
- **溯源**：任一外部动作能答出"属于哪个目标的哪一步、哪个计划版本、谁批的"；任一经 ChangePlan 进入生产的对象能答出"哪类起草者、
  谁批准、谁应用、证据在哪、应用的是哪个摘要"。
- **失败**：结果未知的动作在核对前不会被重新执行（门侧计数断言）；取消或修订后 `withdrawn` 的动作不会执行，`executing` 的只经 R-48 收尾；
  丢事件不会让目标永久卡住。
- **语义一致**：控制台、读模型、能力描述与本文对"目标 / 步骤 / 任务""执行状态 / 目标结果""运行配置快照 / WorkerSpec""起草者 / 批准人"用同一套词，
  目标结果依据沿用 `OBJECTIVE_OUTCOME_BASIS_VALUES`。

## 10. 分叉

| # | 问题 | 结论 |
|---|---|---|
| F1 | 新主线的位置与命名 | **已定（协调方，2026-10-16）**：记为 S11「目标级执行与平台管理员 Agent」，S10 未完成项按 §6.1 归并 |
| F2 | W1 是否要求请求者确认计划才开始 | **已定**：要；确认内容必须包含可读的验收检查与预算；W2 起"只读计划免确认"也不免验收检查的确认 |
| F3 | 规划器放在哪 | **已定**：内核按需拉起的一次性规划 Worker；不唤醒入口 agent（那需要合成 Turn 并处理对话并发） |
| F4 | 能力包安装与管理员 Agent 配置层是否共用 ChangePlan | **已定**：共用核心，按授权分段应用，不做跨段单事务（§5.4） |
| F5 | 管理员 Agent 的代码层 | **待定（维护者）**：W5 开工前的决策门，前提是维护者明确取代 I-N1、且有 agent 拿不到的审批身份（§5.5）；W5 之前的路线不依赖它 |
| F6 | P2 knowledge 包、P3 OpenMetadata 包、E4 个人记忆 | **已定**：P2 仍作为 P1 的验收（手写包走 ChangePlan，不依赖管理员 Agent）；P3 让路为 W3 可选验收 AA6；E4 推迟到 W3 之后重评 |

## 附录 A：证据清单

均在 main `61d5735`（与 `0390041` 的代码相同），路径相对 `packages/`（另注者除外）。

- 任务与尝试：`kernel/migrations/task/0001_tasks.sql`、`0003_task_worker_run_lineage.sql`、`0006_objective_outcome.sql`；
  `kernel/src/application/task/{invoke.ts,lifecycle.ts,reaper.ts,quotas.ts,service.ts,spawn.ts,handle-mint.ts,attribution.ts,result.ts}`；
  `shared/src/{transitions.ts,enums.ts,worker-result.ts,worker-definition.ts,procedure.ts}`；`shared/src/wire/attribution.ts`。
- 唤醒与投递：`kernel/src/application/chat/service.ts`、`application/linkage/{task-consumer.ts,store.ts}`、`application/outbox/dispatcher.ts`、
  `kernel/migrations/core/0005_outbox.sql`、`shared/src/events.ts`；`ontology/entry-agent.yaml`（仓库根）。
- 审批与执行：`kernel/src/governance/approval/{drainer.ts,decide.ts,execution.ts,reads.ts}`、`application/gateway/{action-executor.ts,
  request-action-handler.ts,action-request-drain-consumer.ts}`、`kernel/src/adapters/gatekeeper-client/index.ts`、
  `kernel/migrations/governance/{0014_action_request_idempotency_window.sql,0019_action_request_operation_digest.sql}`、
  `gatekeeper-base/src/{gatekeeper-base.ts,idempotency-store.ts,errors.ts}`。
- 观察、执行授权与发现：`kernel/src/application/gates/{observe-access.ts,execute-access.ts}`、`kernel/src/substrate/graph/find-means.ts`、
  `application/gateway/handlers.ts`。
- 能力与授权：`shared/src/capabilities.ts`、`shared/src/roles.ts`、`kernel/src/governance/capability/handles.ts`、
  `application/gateway/{authorize.ts,resolve-caller.ts,dispatch.ts,gate-instance-handlers.ts}`、`shared/src/handle-binding.ts`。
- 治理字段与溯源：`kernel/src/governance/gatekeepers/manifest.ts`（`origin`、`OperationGovernanceDirection`）、`kernel/src/substrate/ontology/registry.ts`（`proposer_kind`）。
- 扩展模式：`platform-extension/src/modes/{entry.ts,worker.ts,interactive.ts}`。
- 审计与不变量：`kernel/migrations/core/0004_audit.sql`、`kernel/src/substrate/audit/invariant-checks.ts`。
- 仓库治理：`.github/CODEOWNERS`、`.github/workflows/{ci.yml,auto-merge.yml,pr-title.yml}`；分支保护的要求以项目记录为准，未用 API 核实。
- 外部：GitHub 对缺少 workflow 权限的令牌拒绝推送 `.github/workflows/` 改动、fork PR 默认拿不到仓库 secrets——来源声明，本次未实测。
- 独立审查：#580 的 PR 评论（2026-10-16），本次修订逐条处理，K2 / K5 / K6 / 产物 / 溯源的改正均已对照代码复核。
