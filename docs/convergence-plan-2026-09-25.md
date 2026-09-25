# 收敛期方案（2026-09-25，S8 W2 之后）

> 依据：2026-09-25 三路只读调研（内核能力与调用链 / web 控制台 / 运行时与底层组件）+ 主会话核对。
> 本文是"接下来怎么收敛"的方案，不是现状说明书；现状以代码与 `STATUS.md` 为准。标注：**已核实**（读到代码 / 命令输出）、**推断**。

## 1. 背景与目标

S8 W0–W2 已完成：统一授权、启用预览、Worker 编辑器与模板、执行就绪、旅程①在 CI 真跑，v0.19.0 已在主机（S1–S3 全过）。
维护者 2026-09-25 的要求：理清内核能力与调用逻辑，对比前端的不足；从产品化、易用性、美化、模块化、pi 与底层组件升级几个方面
理清前后端的优化；**进入收敛期，允许局部重构，不做推倒重来**。

目标（按优先级）：

1. 关掉真实缺口——人需要却只能靠 API / SQL 做的事、会误导人的状态、会丢数据的路径。
2. 降低维护成本——拆上帝文件、补齐组件地基、一种写法只留一种。
3. 可观测、可升级——跨服务能追一条请求；依赖升级有节奏、有探测。
4. 不加新领域概念（S8 F1 继续有效）；内核变更以读模型和已决定的写能力为限。

## 2. 现状（数字，已核实）

### 2.1 内核

- 能力 158 个，控制台调用了 123 个。未调用的 35 个里：**agent 专用 16**（`find_*`、`invoke_worker`、`request_action`、`assert_fact` 等，
  本就不该有按钮）、**平台 / CLI 专用 6**（本体发布、采集器写入）、**真实界面缺口 12**：

  | 能力 | 缺什么 | 归属 |
  |---|---|---|
  | `verify_fact` | 人把 Fact 提升为已核实——`epistemic_status` 的人工一半没有入口 | 图谱 / 溯源 |
  | `resolve_conflict` | Conflict 只能看不能处理（`open → resolved / accepted_both / dismissed`） | 图谱 / 溯源 |
  | `query_decisions`、`find_precedents`、`causal_chain`、`decision_impact` | 旅程④"agent 为什么这么说"的推理链 | 旅程④ |
  | `set_policy`、`set_quota` | 模型页只读策略与配额表，owner 改不了 | 模型 / 治理 |
  | `issue_handle` | 接 Claude Code / MCP 仍要手写 curl（`howto-connect-claude-code.md` 自述） | 访问 |
  | `get_skill` | Skill "编辑"读不回原文，只能另起一族 | 能力目录 |
  | `list_user_memberships`、`get_gate_instance` | 无调用方，可能已被列表内嵌数据取代（推断，待核） | 平台 |

  另：`list_runtime_images` 零调用方，运行层页用的是 `runtime_inventory`（疑似重复登记）。
- 四条核心调用链：**审批**与**门接入**全程持久、状态机完整；**对话**的 pi 会话文件在入口容器里（设计如此，跨对话靠 `context` 注入）；
  **委派**有两处非持久：Worker 产物指向容器内路径（遗留 74）、观测不强制回写图谱（遗留 75）。
- 分层干净（`substrate` / `governance` 不反向依赖 `application` / `interfaces`），非测试代码 0 个 TODO；
  上帝文件两个：`application/gateway/platform-handlers.ts`（1703 行，23 个处理器）、`application/gateway/handlers.ts`（1621 行，
  图读 / 对话 / Worker 定义 / 审批 / 任务 / `find_*` 混在一起，而同目录其他领域早已各自成文件）。

### 2.2 web 控制台

- 7 个页面文件超过 600 行：`CatalogPage` 1274、`PlatformIntegrationsPage` 853、`ApprovalQueuePage` 731、`PlatformModelsPage` 703、
  `ConnectionsPage` 647、`PlatformRuntimePage` 638、`ChatPage` 607。前五个都是"多个标签页内联在一个文件"。
- 组件地基：`kit/*` 13 个原语；旧 `ui/*` 20 个，其中 16 个还没有 kit 对应（`Notice`、`Field`、`ErrorBanner`、`StatusChip`、`Toast`、
  `EmptyState`、`Icon`、`CopyId`、`Card`、`Skeleton`、`Tabs`、`Kbd`、`Launcher`、`ProvenanceChain`、`ApprovalCard`、`FollowPill`）；
  仍引用 `ui/*` 的文件 106 个（守卫只减不增）；因边界规则而各自复刻原语的新文件 4 个（`GrantGateForm`、`EnableGateConfirm`、
  `ExecutionPrerequisiteBar`、`ExecutionReadinessCard`）。
- 取数两套：旧页面（审批 / 任务 / 对话）用 `useResource`，S3.11 之后用 `useCapability*`；没有迁移约定。
- 体积：`platform` 分块 522 kB（gzip 146 kB），又超过 Vite 500 kB 警告（遗留 49 曾记为已消失）；`dist` 14 MB，其中 Noto Sans SC
  字体 414 个文件约 12 MB。**注意**：@fontsource 按 `unicode-range` 切片，浏览器只下载用到的区段，这 12 MB 是镜像 / 磁盘体积而非
  首屏下载量；可削的是同时打包的旧 `.woff`（与 `.woff2` 重复）。
- 旅程：③ 审批、⑥ 添加成员真跑；① 止于三项前提齐备（CI 触发不了委派，遗留 83）；② 只到打开向导；④ 缺对话内可点的引用（J8）；
  ⑤ 整条 `fixme`（没有跨类别的"残留"视图）。
- 门槛余量：axe 2 条（访问页 1 条链接样式、平台集成页 5 个无标签下拉 = PI1）；文案守卫 1 组（平台审计页 UUID 输入 = AU1）；
  i18n 基线 1 条。新发现的中英混排：访问页 "No service Principal yet — 先在成员与授权创建一个"（未在遗留 85）。

### 2.3 运行时与底层组件

- pi：`pi.version` 0.84.4，上游 0.87.1；每晚的 `pi-drift.yml` 对 `@latest` 跑扩展全测试，近 5 次全绿；0.87 移除的
  `shouldStopAfterTurn` 本仓库未用。升级代码风险低，成本在 `runbooks/pi-upgrade.md` 的人工步骤与两处无自动测试的耦合面
  （worker-runtime 的 CLI 参数假设、agent-host 手写的 RPC 事件 fixture）。
- Worker：门工具结果 `JSON.stringify` 全量回给模型，不截断（`platform-extension/src/modes/worker.ts:97-100`）——遗留 75 里
  "一次盘点 12 万 token"的代码现场。资源限制与环境变量白名单完善。
- 可观测：只有内核有 `/internal/metrics`（不变量计数）；agent-host / supervisor / llm-proxy / egress-proxy / 门均无指标，
  没有跨服务关联 ID，日志只在主机 `docker logs`。
- 供应链：`renovate.json` 写得很细，但 **Renovate 从未开过 PR（App 未装）**，实际在跑的是 Dependabot（最近一批 09-09）；
  `pgvector/pgvector:pg17`、`postgres:17-alpine`、`alpine:3.20` 未钉 digest，与 renovate.json 自己的规则不一致。
- 依赖：TypeScript 5.8（上游 7.x）、Biome 1.9（2.x）、React 18.3（19.x）、Vite 6.0（7.x）、Playwright 1.49（1.62）、vitest 2.1、
  zod 3（4.x，已有意延后）。
- CI 委派：e2e 栈 `AGENT_RUNTIME=fake` 在内核进程内回显，不经 agent-host / supervisor；而"真实 pi + fake-llm 脚本化工具调用"
  的整套设施已经存在（`accept_s2.sh` 在主机就这么跑），只是没接进 Actions。

## 3. 领域与语义要点（只列本轮会动到的）

- **门的三个概念**：Gatekeeper（已登记的传输实例）、GateInstance（自公告、有自己生命周期的运行实例）、ConnectedSystem（目标系统
  占位对象）。代码区分严谨，中文统称"门"；混淆曾导致重复注册（遗留 73）。控制台仍并存"旧路径直接注册"——生产的旧注册已全部
  关联到平台实例后退役它。
- **CapabilityMode**（observe / write / propose / execute）与 **OperationMode**（observe / execute）是两套类型，共用两个字面量，
  保持分离，在文档里写清。
- **草稿生命周期（新，遗留 82）**：WorkerDefinition / Skill / Procedure 的草稿都是"提议者私有"（I16），目前只有
  `draft → published` 一条出路。新增 `draft → discarded`（仅提议者本人手动——I16 下别人看不见草稿，2026-09-25 实现时收紧）与 `draft → expired`（定期清理），三类共用一套规则。
  不引入新实体，只是给已有状态机补终态；每次丢弃 / 过期写审计。
- **治理字段刷新（新，遗留 79）**：门的公告 manifest 是"门自己声明的"，部署在工作区里的 Operation 治理字段是"工作区当前生效的"。
  刷新是一次显式的 owner 治理动作：预览差异（复用 `preview_gate_instance_enable` 的 `differs`）→ 选择 → 应用，before / after 写审计；
  **放松**（影响级降低、变为可自动批准、execute 改 observe）与**收紧**分开标注，放松走不可逆档确认。这是人的直接治理动作（与
  `grant_capability` 同类），不走 ActionRequest。

## 4. 已决定事项的落地设计

| 遗留 | 维护者决定（2026-09-25） | 设计 | 位置 | 规模 |
|---|---|---|---|---|
| 79 | 按公告刷新部署的治理字段 | 新写能力 `refresh_operation_governance{gatekeeperId, operationNames?}`（owner）；只读预览沿用 `preview_gate_instance_enable`；按 Operation 应用、审计 before / after 与"放松 / 收紧"标记；web 在门卡片与启用确认里给"按公告刷新"入口 | `gate-instance-handlers.ts` + `governance/gatekeepers/manifest.ts` | M |
| 80 | 不做按 Operation 收窄授权，不过度约束 | 关闭为"不做"。界面已如实（#269）。可选小清理：`grant_capability` 不再接受新的 `scope`，历史行继续显示为"范围备注"——去掉一个会让人误解的入参，不增加约束 | `governance/capability/grants.ts` | S（可选） |
| 81 | 控制台补写 Operation 描述 | 新写能力 `update_operation_description{gatekeeperId, name, description}`，与 `publish_operation` 同级角色；描述是文档不是治理字段，原地更新当前版本、审计 before / after；`find_*` 分词匹配立即受益 | 与 `publish_operation` 同处（先随 §6 W6 拆分落到新文件） | S |
| 82 | 草稿到期删除 + 手动删除 | `discard_draft{kind: worker_definition \| skill \| procedure, id, version}`（仅提议者本人）；定期清理 `updated_at` 超过 N 天（建议 30，平台设置可调）的草稿，与 `reaper` 同类的周期任务；"我的草稿"区给"丢弃"，并显示"N 天后自动清理" | `application/worker/definitions.ts`、skill / procedure 同层 + 周期任务 | M |
| 84 | 按主会话推荐 | **推荐默认带 `request_action`**：模板自己的 systemPrompt 就在讲"经审批提出动作"，而执行类动作仍受策略 / 人工审批约束（设计底线不变）。实现不写死能力清单：web 从模板创建时，用 `list_capability_names` 的 mode 选中"全部非执行类 + `request_action`"，等价于"默认集合 + 执行申请"；编辑器里写明"执行类动作仍需审批"。YAML 模板加注释说明 | `lib/catalog.ts` `opsRunnerTemplateForm`、`ontology/ops-runner.yaml` 注释 | S |

## 5. 问题清单（按层，P0–P3）

没有 P0。

**内核**
- P1 遗留 75：门工具输出截断（先做，S）+ 观测回写图谱（M）。
- P1 遗留 74：Worker 产物落到工作区存储，不随容器消失（M）。
- P2 遗留 67：Task 其余无条件状态更新改为按转移表校验（M，需并发回归测试）。
- P2 遗留 78：`system.action_update` 钉在收到 `action_pending` 的那个对话（S）。
- P2 12 个界面缺口（§2.1）。
- P2 上帝文件拆分：`handlers.ts`、`platform-handlers.ts` 按领域拆，只动文件组织不动行为（M×2）。
- P3 `list_runtime_images` 删或接；`list_user_memberships` / `get_gate_instance` 核实去留。

**web**
- P1 组件地基收尾：`kit/notice`、`kit/field`、`kit/error-banner`、`kit/status-chip`、`kit/select`，删掉 4 个复刻文件（M）。
- P1 旅程②④⑤ 与审计 P1（G1 图谱新鲜度告警、S11 审计流默认过滤读操作、L1 概览布局、S15 成员与身份）。
- P2 上帝页面拆成功能目录（`catalog/`、`platform/integrations/`、`approvals/`、`platform/runtime/` 等），页面文件控制在约 300 行。
- P2 体积：`platform` 分块回到预算内（按页拆分块或记录理由调阈值）；只打包 `.woff2`。
- P2 文案：遗留 85 + 访问页新发现的混排；一次母语审校。
- P3 取数约定：新代码只用 `useCapability*`，旧页面"碰到再迁"，写成一条约定而不是一次性重写。
- P3 视觉：L7 运行层镜像卡片重复、ST1 备份卡片占位文案、PI1 下拉无标签、O1 控制塔缺"待处理 / 运行中 / 图谱新鲜度"（需要平台级读模型，
  属 F6 允许范围）。

**运行时 / 组件**
- P2 可观测：关联 ID（Turn / Task / ActionRequest 贯穿 kernel → agent-host → supervisor → 门的日志）；agent-host、supervisor、
  llm-proxy 暴露最小指标（请求数、失败数、时延）。
- P2 供应链：决定 Renovate（装 App，或删 `renovate.json` 只留 Dependabot）；数据库与 alpine 镜像钉 digest。
- P2 遗留 58 备份含 llm-proxy 密钥与模型目录（加密与权限先定）；遗留 59 pi 漂移页接真实数据源；遗留 60 演练失败提示回滚；
  遗留 61 egress 映射写入容错；遗留 77 清除工作区时回收入口容器。
- P3 pi 升到 0.87.x（按 runbook）；Playwright / Vite / vitest 小步升级；TypeScript 7、Biome 2、React 19 各起一个评估分支。
- P3 遗留 83：新增**非必过、定时跑**的委派 e2e 工作流，复用 `accept_s2.sh` 与 fake-llm 场景，在 Actions 里起真实 agent-host /
  supervisor / worker-runtime（不进 PR 必过检查，避免拖慢反馈）。

## 6. 波次

车道文件互斥、各自 worktree + PR，同时 ≤ 3 条；界面改动照 S8 的截图 / axe / 文案门槛与批量设计评审。

| 波次 | 内容 | 完成判据 |
|---|---|---|
| **W3 已决遗留 + 地基** | 内核：79 刷新、81 描述、82 草稿丢弃与过期（三类草稿）、84 模板默认 `request_action`、75 前半（门输出截断）。web：`kit/notice / field / error-banner / status-chip / select`，删 4 个复刻文件；遗留 85 与新发现的混排；只打包 `.woff2` | 四项遗留关闭并有正向测试；复刻文件 0；`legacy-ui-importers.json` 数量下降；i18n / 文案基线不增 |
| **W4 旅程与页面**（原 S8 W3） | 旅程②④⑤；审计 P1：G1、S11、L1、S15；12 个界面缺口（`verify_fact` / `resolve_conflict` / 旅程④推理链 / `set_policy` / `set_quota` / `issue_handle` / `get_skill` 预填）；O1 控制塔缺的三项读模型；L7、ST1、PI1 | 六条旅程 CI 真跑（或写明阻塞原因）；审计 P0 / P1 关闭或经维护者标"不修" |
| **W5 运行时与数据正确性**（原 S8 W4） | 74、75 后半（观测回写）、67、78、77、76、60、61、62–66、58 | 每项有正向测试；主机 S1 / S2 / S3 复跑全过 |
| **W6 结构收敛（局部重构）** | 内核 `handlers.ts` / `platform-handlers.ts` 按领域拆；web 七个上帝页面拆功能目录；`platform` 分块回预算；退役旧直接注册路径（先核实生产已无仅旧注册的门）；`list_runtime_images` 去留；取数约定写进 `packages/web/README` | 行为零变化：截图零差异、全量 e2e 绿、契约快照不变；页面文件约 300 行内 |
| **W7 升级与可观测** | pi 0.87.x；Playwright / Vite / vitest；关联 ID + 三个服务的最小指标；遗留 59；镜像 digest；Renovate 决定；委派 e2e 定时工作流（83）；TS 7 / Biome 2 / React 19 评估分支（只出报告） | 升级后 S1–S3 与 pi-drift 全绿；一次委派可凭同一个关联 ID 在各服务日志串起来 |

顺序：W3 先行（决定已做、地基是后面所有页面的前提）；W4 与 W5 并行（文件基本不交叉）；W6 穿插在 W4 之后（避免与页面改动撞文件）；
W7 的小项随时可插，三个大版本升级放在 W6 之后。每个波次结束发一个版本、主机应用、写 STATUS。

## 7. 验证与门槛

- 沿用：CI `guards / quality / test / web-e2e`；三档截图、axe、文案、i18n 守卫；每个 UI PR 批量设计评审。
- 新增：内核写能力（79 / 81 / 82）都要有集成测试覆盖授权、审计记录与非法状态被拒；82 的周期清理要有"只删过期草稿、不碰已发布"
  的测试；W6 的拆分 PR 必须零截图差异、零契约差异。
- 主机：每个波次版本在主机跑 S1–S3；W5 额外人工核对产物可读、观测入图。

## 8. 风险

- **W6 拆分与 W4 页面改动撞文件**——W6 放在 W4 之后，且拆分 PR 只搬代码不改行为。
- **79 的"放松"刷新会降低审批强度**——按 Operation 显式选择、不可逆档确认、审计标记"放松"；不提供"一键全部刷新"之外的静默路径。
- **82 过期清理误删**——只作用于 `draft`；清理前记审计；默认 30 天可调；首次上线先"只报告不删除"跑一轮。
- **委派 e2e 工作流不稳定**（主机网络抖动的同类问题会出现在 runner 上）——不设为必过，失败开 issue。
- **大版本升级**（TS 7 / React 19 / Biome 2）生态兼容未知——只出评估报告，维护者决定后再做。

## 9. 不做

- 按 Operation 收窄授权（遗留 80，维护者 2026-09-25 决定）。
- zod 4 全仓迁移（已有意延后）。
- 拆微服务、引入图数据库、重写路由或状态管理。
- S8 F1 之外的新功能（`promote_template` 等继续推后）。

## 10. 维护者决定（2026-09-25，均按推荐）

1. Renovate：删掉 `renovate.json`（App 从未安装），常规依赖升级按 W7 波次手动做；Dependabot 只做安全告警 /
   安全更新 PR（npm 的 PR 在 pnpm workspace 里可能因 lockfile 失败，失败即在波次里手动处理）。
2. 草稿过期天数：30 天（内核 `DRAFT_EXPIRY_DAYS` 默认值）。
3. 遗留 80 的清理：`grant_capability` 不再接受 `scope`。
4. 三个大版本升级：W6 之后先出评估报告再定。
