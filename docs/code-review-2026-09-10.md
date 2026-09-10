# 代码复审（2026-09-10）：全量通读 + 定向复审

> 本文是 v0.3.0 之后第一次全量通读的结果，不是阶段回顾（回顾见 `retrospective-2026-09-09.md`），
> 也不是任务清单（见 `development-tasks.md`）。它记录**发现与判断**；STATUS 只登记条目与归属，
> 细节在这里。分级沿用 `code-review-2026-09-04.md` 的口径：P0 可越过治理或凭证边界；
> P1 破坏不变量 / 授权 / 可靠性；P2 加固与运维正确性；P3 错误映射、语义漂移、文档漂移。

## 1. 范围与方法

- **通读范围**：内核六层全部源码（substrate / governance / application / adapters / interfaces / cli，
  约 3.45 万行）、`packages/shared` 契约层、35 个迁移、96 条 capability 注册表、11 张转移表、
  `ontology/` 与 `gatekeepers/` 的内容包、`docker-compose.yml`、CI 六道守卫、三份验收脚本；
  其余包（agent-host / worker-supervisor / platform-extension / gatekeeper-base / llm-proxy /
  egress-proxy / web / collectors）逐包通读。
- **方法**：先通读建立结构认识，再按风险分布做三轮定向复审（授权链路与任务生命周期 /
  数据完整性与投递保证 / 边界服务；该工具面向 diff：第三轮首次因这四个包在当前分支无改动而拒绝复审——未编造发现，随后改以 `8112475~1..ed36bec` 为范围重跑）。每条发现都回原文核对过；子代理给出的结论凡与原文不符的
  一律不采信（见 §5）。
- **未做**：本机未跑测试套件（无 pnpm 环境），CI 绿是唯一的健康信号；未在目标主机复现任何一条。

## 2. P1 —— 破坏不变量 / 授权 / 可靠性

### 2.1 Worker 断言的 Fact 永远按 principal 判定来源，同定义两次运行的矛盾会被静默 supersede

- **现状**：`application/task/result.ts` 的 `postWorkerResult` 先在第 157–160 行断言
  `contract.factsToAssert`，之后才在第 198 / 204 行 `registerPrivateSource` +
  `recordSourceObservation`。而 `substrate/epistemic/conflicts.ts` 的 `resolveFactOrigin` 判定来源的
  依据是 `select distinct source_id from observations where workspace_id=$1 and activity_id=$2`
  —— 断言发生时该 Activity 上还没有任何 Observation，因此**永远**落到
  `{kind:'principal', id: assertedBy}` 分支。
- **放大条件**：`application/task/agent-principal.ts` 的 agent principal 粒度是
  **每 (workspace, worker_definition_id) 一个**（唯一索引 + `on conflict do update`），
  同一个 WorkerDefinition 的每次运行共用同一个 principal。
- **后果**：同一 Worker 定义的两次不同运行，对同一 `(linkType, source, target)` 身份得出矛盾结论时，
  `sameFactOrigin` 判为同源，走 supersede，**不开 Conflict**。这正是 S3.2 冲突检测要覆盖的场景。
- **文档反证**：`conflicts.ts` 模块注释明写「Worker 会话流是精确的按 Source 判定的那一类
  （`postWorkerResult` 在断言 `factsToAssert` 的同一个 Activity 上记录了私有 `worker_session` Source）」
  ——文档声称成立的唯一精确路径，恰恰是唯一不成立的路径。
- **为何验收没抓到**：`accept_s3.sh` 里唯一与冲突有关的断言是采集器跑两遍后
  `factsAsserted=0 / factsSuperseded=0 / open Conflict=0`（第 629–640 行）——那是「同源同内容幂等
  no-op」路径。整套验收对 Conflict 的唯一期望就是「零」，因此一个**压制** Conflict 的缺陷无论存在与否，
  验收都表现为通过。缺的是一条「异源矛盾断言 → 期望恰好一个 open Conflict」的正向用例。
- **同仓库里就有正确写法**（codegraph 血缘查证）：`application/gateway/ingest-handlers.ts` 的
  `submitObservationsHandler` 在第 432 行**先** `recordSourceObservation`、第 434–453 行**再**经
  `writeLink` 调 `assertFact`，其第 427–431 行注释把理由写明了——「so `resolveFactOrigin` (S3.2)
  always finds exactly one distinct `source_id` feeding this Activity」。采集器的幂等因此成立，
  Worker 路径顺序相反却声称同一保证。修复有现成模板，不需要新设计。
  （`gateway/observed-facts.ts` 完全不记 Observation，是 `conflicts.ts` 模块注释已列明并接受的一类，
  按 service principal 判定，不在本条范围。）
- **影响面**（codegraph）：`assertFact` 有 18 个调用方（`fact-handlers` / `ingest-handlers` /
  `observed-facts` / `task/result` 等），`registerPrivateSource` 有 7 个。本条的顺序调整只动
  `task/result.ts` 一处的语句次序，不改任何签名，不波及其余调用方。
- **建议**：把 `registerPrivateSource` + `recordSourceObservation` 移到 `assertFact` 循环之前
  （同一事务内，顺序调整即可），并补一条集成测试：同一 WorkerDefinition 两次运行断言矛盾内容 → 期望 Conflict。

### 2.2 并发首次断言同一身份不会开 Conflict

- **现状**：`substrate/graph/sql-store.ts` 的 `assertFact` 用 `FOR UPDATE` 锁既有 Fact 行，但
  首次断言时该行不存在，`FOR UPDATE` 锁不住任何东西；`links` 表上也没有
  `(link_type, source_object_id, target_object_id)` 的唯一约束（`migrations/core/0002_substrate.sql`）。
- **后果**：READ COMMITTED 下，两个来源并发首次断言同一身份，双方都看到「无既有 Fact」，
  各自插入，产生两条活跃 Fact 且不开 Conflict。之后的读会同时看到两条。
- **概率**：需要同一身份的首次断言在两个来源上并发（如采集器与 Worker 同时写同一条边），不高但真实且静默。
- **建议**：加 `(workspace_id, link_type, source_object_id, target_object_id)` 上仅对活跃行生效的
  部分唯一索引，或在身份维度加 `pg_advisory_xact_lock`（`insertQueuedTaskWithQuotaCheck` 已有先例）。

### 2.3 Handle 通道完全不校验 `minRole`

- **现状**：`application/gateway/authorize.ts` 的 handle 分支只检查 scope 成员资格即放行，
  从不比对 `capability.minRole`（该文件有约 40 行注释自认此缺口并说明为何未在该文件修）。
- **后果**：`ENTRY_CEILING_CAPABILITIES` 无条件收进每个 `propose_` 开头的能力，因此 `member` 角色
  principal 的入口 Handle 结构性携带 5 个 `minRole:'builder'` 的 `propose_*` 并可实际调用。
- **边界**：不构成越权发布——草稿对提议者私有，发布仍受 I16 约束只走 human 通道。但 `minRole`
  在 Handle 通道上事实失效，与 §9.3 的能力表读起来不一致。
- **建议**（同代码注释）：在签发时按 `on_behalf_of` 的角色收窄 `entryScope()`，而不是在授权点补查库。

## 3. P2 —— 加固与运维正确性

### 3.1 `llm-proxy` 没有任何预算代码，I18 的 100% 拦截未实现

设计 §5.4 I18 写「到 100% 时 `llm-proxy` 返回预算耗尽错误」。实际 `packages/llm-proxy/src` 全量搜索无
budget / quota 相关逻辑；预算判定全在内核 `application/task/service.ts` 的 `recordWorkerRunUsage`：
收到用量上报后 ≥80% 发 `BudgetWarning`、≥100% 标 `failed: budget_exhausted` 并终止 WorkerRun。
后果是超支只能事后止损，拦不住正在进行的那次调用。要么实现代理侧拦截，要么修正设计文档的表述。

### 3.2 `create_task` 在唯一现实路径上不可达

`create_task` 在 `WORKER_CEILING_EXTRA_CAPABILITY_NAMES` 内、不在 `ENTRY_CEILING_EXTRA_CAPABILITY_NAMES`
内，而 `computeChildHandleScope` 对非 execute 类能力做「父没有就静默丢弃」，两处入口 Handle 签发
（`issue-handle-handler.ts`、`agent-host-runtime.ts` 的 `ensureEntryHandle`）都走固定的 `entryScope()`。
故「入口 agent → `invoke_worker` → Worker」这条链上 Worker 拿不到它。且 `queued` Task 计入每 principal
并发额度、reaper 只扫有 WorkerRun 的 Task、Worker 的 ceiling 里没有 `cancel_task`，额度只能由人回收。
新增的三条测试都直接调 `createTask()`，绕过了 Handle 授权，因此没有覆盖到这一点。
**建议下架**（注册表 + handler + ceiling 三处），接线留到授权衰减模型有结论之后。

### 3.3 两个门容器与 caddy / postgres 没有容器级加固

除这四个外，compose 里每个服务都有 `read_only: true` + `cap_drop: [ALL]` + `no-new-privileges`。
门恰恰是底线一里唯一持外部系统凭证的进程。门需要可写卷可以解释 `read_only` 的缺席，另两项没有代价，
且 compose 里没有任何注释说明这是权衡后的决定。

### 3.4 控制台看不到审批历史

注册表里只有 `list_pending`（仅 pending）与 `get_action`（按 id），没有列出已决 ActionRequest 的能力，
审批队列的「All」标签因此只含本次会话观察到的决定，刷新即失。`audit_query` 能兜住审计视角，
但不是审批视角。（`runbooks/web-console.md`「已知缺口」第 3 条已记，此处标注其产品影响。）

### 3.5 出网拒绝表在 `reconcile()` 后回退到容器创建时的旧值

- **现状**：`EGRESS_DENY_LABEL` 只在容器 (重)创建时打上；`resident-service.ts` 的复用分支每次都用
  当前 `egressDeny` 刷新 `SOURCE_MAP_FILE`（注释：「好让容器启动后才发布的出网列表立即生效」），
  但无法回写标签（Docker 不能给运行中的容器改标签）；`reconcile()` 则从该标签恢复拒绝表。
- **后果**：一份**收紧**的拒绝表经复用生效后，任意一次 `reconcile()` 会把它退回创建时那份更宽的，
  直到该 principal 下一次 `startTurn`。而 `reconcile()` 不只在 supervisor 重启时跑——
  `docker-events.ts` 每次重连都跑（其自身注释：「每次重连都再跑一遍，正是用来补上断连期间漏掉的事件」），
  所以代理连接抖动会反复触发回退。紧邻的代码恰恰为抖动场景保护了 `lastTouchedAt`，却没保护拒绝表。
- **与自身声明冲突**：`spawn-spec.ts` 的 `EGRESS_DENY_LABEL` 文档注释逐字写着「这个列表只能收紧
  平台策略，永不放宽，**哪怕是暂时的**」。
- **边界**（不升级为 P1）：回退的是「上一份已发布的列表」而非「无列表」，且 egress-proxy 自身的
  平台级拒绝（RFC1918 / 链路本地 / 平台子网 / 未知来源）不受影响，设计 §5.4 I10 未被突破。
- **建议**：`reconcile()` 恢复时以「标签值 ∪ 该 WorkerDefinition 当前已发布的 `egressDeny`」为准，
  或在复用分支检测到 `egressDeny` 变化时并入既有的重建判定（与 `HANDLE_JTI_LABEL` /
  `SKILLS_HASH_LABEL` 同一形状）。补一条 reuse-then-reconcile 的测试——现有测试没有覆盖这个序列。

## 4. P3 —— 语义与文档漂移

| # | 项 | 位置 |
|---|---|---|
| 1 | 设计 §5.4 I2 写「内核写入校验 + 触发器」，实际无任何 DB 强制，只有应用层 `validateLink`；`substrate/audit/invariant-checks.ts` 自己已承认 | 设计文档 |
| 2 | 设计 §7.8 把「进程树」列为采集源，但 compose 未给采集器 `pid: host`，`process-tree.ts` 走 skipped 是常态，正式部署下图里不会有 Process 对象（代码与 `runbooks/host-collector.md` 均已写明） | 设计文档 |
| 3 | `substrate/audit/index.ts` 顶部注释仍称 `export_prov`「未实现，HTTP 路由返回 501」，实际 `handlers.ts` 已接线 | 过期注释 |
| 4 | `dispatch.test.ts` 的「`CapabilityNotImplementedError` 在开事务前抛出」用例只构造错误对象、不再调用 `dispatchCapability`，但注释仍声称证明了「从不先开连接」；若 `dispatch.ts` 未来把 DB 触碰提到 handler 查找之前，无人发现 | 测试 |
| 5 | `insertQueuedTaskWithQuotaCheck` 的 `depth_exceeded` 文案丢了能力名前缀，且对 `create_task` 建议「invoke from a shallower WorkerRun」不可操作 | 错误文案 |
| 6 | `README.md` 仍称「设计阶段（v0.2）…仓库只有文档，尚无可运行组件」；设计文档头部仍写「全部为提案…尚无任何组件实现」、§7.6 仍写「当前实现只有『工作』区」、§9.3 把 task 组标 `propose / observe` 而注册表里 `create_task`/`cancel_task` 均为 `write` | 入库文档 |
| 7 | `docker-events.ts` 的 `connect()`：若 `stop()` 与在途的 `getContainerEvents()` 竞争，已解析的事件流被直接丢弃而未 `destroy()`，泄漏一条到 socket 代理的连接。当前唯一调用点是 SIGTERM 后立即 `process.exit(0)`，无实际影响；反复 start/stop 的调用者会累积泄漏 | `worker-supervisor` |
| 8 | `development-tasks.md` 的 S3.6 一节无完成标记，而其代码（`interfaces/mcp/` 五个模块带测试）与 S3 验收的 G6 都已落地 | 任务清单 |

## 5. 已核对无问题 / 推翻的结论

以下是复审过程中出现过、但回原文核对后**不成立**的说法，记录以免再被提起：

- 「S3.5–S3.7 未开始」——文档自 S3.4 起把完成标记从「实现说明」换成「**已完成**」，三项均已完成。
- 「41 个 capability 未接线」——`CAPABILITY_HANDLERS` 有 94 条，注册表 96 条，差的正好是
  `<gate>.<op>` 与 `<gate>.<op>:execute` 两个占位模式；`dispatch.test.ts` 有守卫测试盯着。
- 「`code-review-2026-09-04.md` 说 11 个包与实际 9 个矛盾」——11 = `packages/` 9 个 + 两个门实例，口径自洽。
- 「`web-console.md` 的已知缺口列表过期」——该列表维护良好，已关闭项均已划线并注明修复分支。

另外，以下几处经核对确认**实现是对的**，值得记下来：`egress-proxy` 在代理内解析 DNS（防 rebinding）、
字面 IP 永不进 `trustedResolvedCidrs`、识别 `inet_aton` 变体写法与 NAT64 内嵌地址、未知来源默认拒绝；
I13 由数据库触发器强制（`on_behalf_of` 必须等于会话的、子必须等于父、子过期不得超过父）；
Handle 衰减在两个轴上都做子集校验且失败即拒不做截断；web 端未发现任何客户端自行判权。

## 6. 建议排期与落地状态

编号供 STATUS §4 与后续 PR 引用；「建议归属」是提议，归属由维护者定。

| # | 项 | 级别 | 建议归属 | 状态 |
|---|---|---|---|---|
| G1 | Worker 断言来源判定失效（§2.1）+ 补正向 Conflict 验收用例 | P1 | 建议提前至 W5 | 未开工 |
| G2 | 并发首次断言无唯一约束 / 锁（§2.2） | P1 | 建议提前至 W5 | 未开工 |
| G3 | Handle 通道 `minRole` 失效，按 `on_behalf_of` 角色收窄 `entryScope()`（§2.3） | P1 | 待排 | 未开工 |
| G4 | `llm-proxy` 预算拦截：实现，或修正设计 §5.4 I18 的表述（§3.1） | P2 | 待排 | 未开工 |
| G5 | `create_task` 下架（§3.2） | P2 | W5 | 未开工 |
| G6 | 门 / caddy / postgres 容器加固（§3.3） | P2 | 待排 | 未开工 |
| G7 | 已决 ActionRequest 的列表能力（§3.4） | P2 | 待排 | 未开工 |
| G8 | 出网拒绝表 `reconcile()` 回退（§3.5） | P2 | 待排 | 未开工 |
| G9 | §4 的七条语义与文档漂移 | P3 | 紧随的 docs PR | 未开工 |
