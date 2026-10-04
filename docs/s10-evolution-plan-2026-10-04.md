# S10 底座演进方案：可升级运行时 · 受治理的自进化 · 能力包（2026-10-04）

> 依据：维护者 2026-10-04 提出的三件事（pi 模块化可升级、平台自进化、可插拔扩展包）+ 当天三路只读调研
> （本仓库代码盘点；8 个自进化项目源码阅读，其中 2 个是维护者私有仓库）+ 外部核实（npm、GitHub、OpenMetadata）
> + 顾问讨论。本文是**方案与待决清单**，不是现状说明书；现状以代码与 `STATUS.md` 为准。
> 标注：**已核实**（读到代码 / 命令输出 / 官方来源）、**推断**、**建议**。

## 0. 结论先行

1. **pi 1.0.2 不是"没识别"，而是"识别了没有出口"**（已核实）。每晚 `pi-drift.yml` 10-02 / 10-03 / 10-04 依次对
   1.0.0 / 1.0.1 / 1.0.2 跑了平台扩展的 typecheck + pi SDK 测试，10-04 那次 124 / 124 通过——但这个工作流**只在失败时**开
   issue，通过时只写 job summary；控制台「pi 运行时」卡片按设计决定 E3 "不出网"，只比较"本版内置的 pi"与"在跑的镜像"，
   不知道上游有新版。缺的不是兼容性检测，是**版本感知的所有者**——没有任何组件负责"有新版本了"这件事。
2. **自进化最该补的不是更聪明的生成，是结果归因与评测**（已核实）。平台已有"Worker 提议 Skill / Procedure / Operation
   草稿 → 人发布"的提议链，但 Task / WorkerRun 只钉住了 WorkerDefinition 的版本（`tasks.worker_definition_id` /
   `worker_definition_version`），**没有记录用了哪个 Skill / Procedure 版本、结果好不好**；草稿发布前也没有任何客观评测。
   8 个参考项目里，价值最高的是评测与度量机制（penguin-harness、Meristem、rrsi），不是代码自修改（ouroboros）。
3. **"通用内核 + 能力包"方向成立，且内核已经是领域无关的**（已核实：`packages/kernel/src` 里 ragflow / docker / routeros
   零命中，`ssh` 只作为通用传输种类出现）。但 GPT 方案有四处要改：包**不能自授权**、包**不带 SQL 迁移**、
   **代码组件与数据组件分两个信任层**、ContextProvider 抽象**等到第二个真实提供方再做**。另外调研发现一个会被包机制
   立刻放大的现存缺陷：**同名 ObjectType 跨本体族静默覆盖**（`registry.ts:313-332`），它是能力包的第一个前置项。
4. **第一波只做小而全的一刀**：U0 按手册升 pi 1.0.2、U1 版本感知与提醒、P0 命名空间不变量与接入路径统一、E1 结果归因。
   其余按触发条件排到后续波次。待维护者决定的事集中在 §10。
5. **开放遗留全部排进波次**（§7.1）：复审剩下的 89 条 P3 按已切好的 11 条文件车道，跟着改到同一批文件的 S10 项走；
   S10 的前置项与隔离纵深项进 W1；维护者已推迟的（异地备份、P5、干净主机首跑）保持推迟并写明重启条件。

## 1. 背景与目标

维护者原话要点（2026-10-04）：

- "PI 模块化可升级……pi agent 主线已经是 1.0.2 版本了，但我们平台上的升级功能完全没有识别和弹出提醒。"
- "平台的自进化设计，除了图谱自更新，研究一下有没有其他的增加方案"，参考 8 个项目，"哪个最适合我们项目、最有潜力结合"。
- "可插拔扩展包化，这个非常重要"：NextTime-AI = Enterprise Agent & Operational Graph OS，OpenMetadata = Enterprise
  Context & Semantic Graph Layer，"这样能成为一个通用底座么"。

目标（可验证）：

| # | 目标 | 验证 |
|---|---|---|
| G1 | 上游 pi 或平台有新版时，管理员在控制台 24 小时内看到提醒，且提醒里写明兼容性证据 | 人为把 channel feed 的 `piUpstream.latest` 设高一版，控制台出现提醒与证据链接 |
| G2 | pi 升级的人工核对项大部分转为 CI 自动证据，一个 pi 版本从"可用"到"候选镜像"不需要人读源码 | `pi-upgrade.md` §2 标"人工"的行有对应 CI 步骤 |
| G3 | 每次 Worker 运行都能回答"用了哪个 Skill / Procedure 的哪个版本、结果如何" | 新 Task 的 Skill 版本与结果可在控制台与读模型查到 |
| G4 | Worker 提议的草稿在发布前附带客观评测证据，发布人看得到 | 一个 Skill 草稿走完评测 → 发布审阅页显示判定与证据 |
| G5 | 一个新领域能以"包"的形式装进工作区，内核零改动 | 第二个非运维领域包装进工作区并跑通一条旅程 |
| G6 | 包装卸不破坏三条设计底线 | 包无法携带凭证、无法自授权、代码组件只经平台管理员 |

## 2. 现状与证据

### 2.1 pi 与平台版本（已核实）

| 事实 | 证据 |
|---|---|
| 仓库锁定 pi 0.99.2；npm `latest` = 1.0.2（2026-10-04 00:56Z 发布），1.0.0 发布于 10-01 | `pi.version`；npm registry `dist-tags` |
| 每晚漂移检查对 `@latest` 跑平台扩展 typecheck + SDK 测试；10-04 对 1.0.2：typecheck 通过、124 / 124 | `.github/workflows/pi-drift.yml`；run 37193298285 日志 |
| 漂移检查失败时开 / 更新一个 `pi-drift` issue，通过时自动关 issue、只写 job summary；产出的 `pi-drift.json` 无人消费 | `pi-drift.yml` |
| 控制台「pi 运行时」卡片：`pi_drift` 比较本版内置 pi 与活动镜像 label；`roll_entry_containers` 只把**本版已有**的镜像推到常驻入口容器 | `packages/kernel/src/application/platform/runtime.ts:467,598`；`PlatformRuntimePage.tsx` |
| 设计决定 E3：控制台不查询 npm / GitHub（"不出网"）；内核与 web 无 docker socket | `docs/runbooks/pi-upgrade.md:320`；`docker-compose.yml` |
| 内核只知道自己的版本（`KERNEL_VERSION`），没有任何"平台有新版本"的逻辑 | `platform-handlers.ts:1786`；全仓 grep |
| 发版应用是主机上的 shell 脚本（备份 → 拉镜像验签 → 迁移 → up → 验收），需要主机 git / compose / `.env` | `scripts/apply-release.sh` |
| `pi-upgrade.md` §2 耦合面清单里 Dockerfile flag、entrypoint、bridge RPC 夹具、stdout 分帧、`models.json` 解析等行标"人工 / 需主机验收"——SDK 测试绿 ≠ 可以直接升 | `docs/runbooks/pi-upgrade.md` §2 |
| 文档漂移：`pi_drift` 能力描述仍写"读 CI 产物 JSON"（09-26 起已改读镜像内文件）；S3.15 交付物列了 `dependabot.yml`，仓库里不存在 | `capabilities.ts:3399-3408`；`development-tasks.md:1364` |

**判断**：pi 1.0 是大版本号。SDK 面兼容不代表 CLI flag、RPC 事件流、`models.json` 解析都没变，这些只能按手册在真实
`pi --mode rpc` 上核对。所以 1.0.2 要按 `pi-upgrade.md` 走一次正式升级（U0），同时把"有新版本了"做成有出口的信号（U1），
再把手册里的人工核对项尽量自动化（U2），pi 才算真正"模块化可升级"。

### 2.2 自进化相关的现有机制（已核实）

| 机制 | 触发 | 谁提议 / 谁批准 | 存在哪 |
|---|---|---|---|
| 图谱自更新：采集器与门观察写 Observation / Fact，窗口完整时未再观察到的 Fact 失效（`not_reobserved`），异源矛盾成 Conflict | 采集周期、门调用 | 采集器 / 门；人处理 Conflict、`verify_fact` / `attest_fact` | 图谱表 |
| Skill / Procedure / Operation / WorkerDefinition 草稿 | agent 调 `propose_*`（"成功 WorkerRun 结束时"是 prompt 约定） | agent 提议；builder / owner 经 human 通道发布（I16、D-24） | `skills` / `procedures` / `worker_definitions` / Operation 表；草稿 30 天过期 |
| 本体提议 | `propose_ontology_change` | builder 发布，基线移动则拒绝（R-60） | `ontology_versions` |
| 用量与质量 | `report-usage.sh`（token / 费用）；`get_operation_stats`（每 Operation 调用 / 批准 / 拒绝 / 失败）；真实模型回归 `REAL scenario=… ok=k/n` 只打到 stdout | — | `llm_usage`；回归结果不入库 |
| 入口 agent 跨会话连续性 | 每个 chat 一个 pi 会话文件；`get_entry_context` + `report_turn` 摘要；`pending_context_items` | — | 用户私有工作目录；Turn 入图 |

**缺失的反馈信号**（已核实）：

1. Task / WorkerRun 不记录用了哪个 Skill / Procedure 版本。WorkerDefinition 按**名字**列 Skill，启动时解析到最新已发布版本，
   实际装载的版本没有记录；`find_procedures` 只作为提示，跟随了哪个 Procedure 无从查起。
2. Skill / Procedure 没有使用次数、成功率、最近使用时间；没有据此弃用或推荐的规则。
3. Task 只有执行状态（`completed` / `failed`），没有"目标达成与否"——"跑完了"与"做对了"混在一起。
4. 草稿被人丢弃（discard）不作为信号记录。
5. 真实模型回归的结果不入库，没有跨版本趋势。

### 2.3 扩展面现状（已核实）

| 可扩展物 | 定义在 | 数据还是代码 | 谁能装 | 版本 / 卸载 / 溯源 |
|---|---|---|---|---|
| 本体包（= 现在的"模块"，D1） | `ontology/*.yaml` + `ontology/modules.yaml` 索引；主机 `config/ontology/` | 数据（`ontology_versions`） | owner（`install_module` / `upgrade_module`） | 哈希判定已装版本（D2）；**无卸载**；来源只能靠哈希推断 |
| WorkerDefinition 模板 | `ontology/ops-runner.yaml` | 数据 | builder（从模板预填后提议、发布） | 发布后不可改、可弃用；与模块无关联 |
| Skill / Procedure | `skills` / `procedures` 表 + 图投影 | 数据 | builder 发布 | `id@version`、只弃用不删；不随模块装 |
| Operation（接口清单） | 门 manifest；`propose_operation` / `publish_manifest` | 数据 | owner / builder | 只弃用；平台级可按 Operation 禁用 |
| 门（Gatekeeper） | `gatekeeper-base` 通用 http / mcp / cli / ssh；`gatekeepers/docker`、`gatekeepers/ragflow` 专用镜像 | **代码（镜像）** + 数据行 | 平台管理员建实例；owner 启用 / 授权 | 门自注册；专用门随镜像 |
| 采集器 | `collectors/host-inventory`（compose 服务 + 服务 token） | **代码（镜像）** | 主机运维 | 无安装 / 卸载面 |

两个结构性问题：

- **同名 ObjectType 跨本体族静默覆盖**（已核实）：`mergeVisibleOntology` 把工作区可见的所有族合并成一个扁平命名空间，
  ObjectType / ActionType 同名时"按族 id 排序靠后的覆盖"——代码注释自己写明这是"任意但确定的决胜，不是有意义的优先级"。
  今天只有一个运维领域包所以没触发；两个包同时定义 `Service` / `Dataset` 时，写入校验会按被覆盖后的类型执行。
- **两条连接器接入路径仍在**：遗留 73 由 #251 消除了重复注册，但旧 `request_connection` / `create_connection` / CLI
  `register-gatekeeper` 与控制台平台门实例路径并存。连接器预设要成为包组件，必须只有一条落地路径。

### 2.4 外部核实：OpenMetadata

最新 2.0.3（2026-09-30），Apache-2.0，约 1.5 万星，仍活跃。自带 MCP server：端点 `{OM 地址}/mcp`，Streamable HTTP，
OAuth 2.0 或 JWT Bearer 认证；工具含 `search_metadata`（`query` / `entityType` / `size`）、`get_entity_details`、血缘查询，
以及术语表**管理**（写操作）。另有 REST / GraphQL 与事件订阅（webhook）。**推断**：它能作为一个 `mcp` 门实例接进来
（复审 R-69 / #453 已支持需认证的托管 MCP 门；Bearer 方式是否直接可用要在 W4 实测），观察类工具经现有治理路径调用、
审计在案，**内核零改动**；术语表管理类工具在 Operation 分类里是执行类、走审批。来源：
[OpenMetadata releases](https://github.com/open-metadata/OpenMetadata/releases)、
[OpenMetadata MCP 接入文档](https://docs.open-metadata.org/v2.0.x/how-to-guides/mcp/connect.md)。

## 3. 领域模型（本阶段新增与扩展）

本阶段**不重开**已稳定的领域模型（`graph-ai-middle-platform-design.md` §5），只在三处做增量。命名沿用现有词汇。

### 3.1 新概念

| 概念 | 属于 | 含义 | 是一等概念还是投影 |
|---|---|---|---|
| **ReleaseChannel 记录** | 运维面 | CI 签名发布的版本清单：平台各发布版本（内置 pi、迁移、breaking、说明）+ pi 上游最新版与漂移检查结论 | 外部来源的只读快照；内核把它当 Observation 读，不是内核自有的真相 |
| **RuntimeCandidate** | 运维面 | 一个 worker-runtime 候选镜像：本版平台扩展 × 某个 pi 版本，带一致性测试证据与签名 | 镜像 + 证据；仅在决定 1 选 (b) 时存在 |
| **Skill / Procedure 使用记录** | Governance | WorkerRun 实际装载的 Skill `id@version`；Task 跟随的 Procedure `id@version` | 一等关系（与 `Task pins WorkerDefinition@version` 同构） |
| **目标结果（objective outcome）** | Epistemic | Task 的"做对了吗"：`achieved` / `not_achieved` / `unknown`，与执行状态分开；由请求者或验证步骤给出 | Task 上的独立字段，带给出者与时间 |
| **EvalSuite / EvalRun** | Epistemic | 冻结的评测用例集（输入、假门夹具、判定规则，对提议者不可见）；一次评测运行是 `kind=evaluation` 的 Activity，产出 Observation 作为草稿的 Evidence | EvalSuite 是一等对象；EvalRun 复用 Activity |
| **Pack / PackVersion** | 平台元本体 | 能力包与其不可变版本（清单 + 内容摘要） | 一等概念；PackVersion 发布后不可改（同 I12） |
| **PackInstallation** | Governance | 工作区 × PackVersion 的安装记录，有状态机 | 一等概念 |
| **组件来源（installed_from）** | 溯源 | 每个经包发布的对象（本体版本、WorkerDefinition、Skill、Procedure、Operation、门实例配置）指向来源 PackVersion 与组件摘要 | 关系 |

### 3.2 关系

- `WorkerRun loaded SkillVersion`（N:M，启动时写入）；`Task followed ProcedureVersion`（0..1，入口 agent 自报，标 `claimed`）。
- `EvalRun evaluated Draft`、`EvalRun compared_to PublishedVersion`、`EvalRun used EvalSuite@version`、`EvalRun generated Observation`，
  该 Observation 作为 Draft 发布审阅的 Evidence。
- `PackVersion contains Component`；`Workspace installed PackVersion`（经 PackInstallation）；`Object installed_from PackVersion`；
  `PackVersion requires PackVersion`（只做版本检查，见决定 4）。
- **永不允许**：PackVersion 携带凭证或 Grant；EvalRun 持有真实门的 Handle；提议者读取 EvalSuite 的判定规则；
  包组件绕过 human 通道发布。

### 3.3 不变量（新增）

| # | 不变量 | 机制 |
|---|---|---|
| I-P1 | 工作区内可见的 ObjectType / ActionType 名唯一；只有在被 `requires` 的族里声明的类型可以被引用、不可重定义（LinkType 可同名，签名累加——保持现状） | `publish_ontology_version` 与包安装计划同一处检查；拒绝而不是覆盖 |
| I-P2 | 包不携带凭证、不创建 Grant、不含 SQL 迁移；包只**声明**需要哪些门 / 连接器 / 能力 | 清单 schema 不含这些字段；安装只调用现有发布能力 |
| I-P3 | 代码组件（门镜像、采集器镜像）只能由平台管理员引入，按 digest 引用并验签；内核进程内永不加载包代码 | 清单里代码组件只有镜像引用；安装计划对代码组件只做"是否已就位"检查 |
| I-P4 | 卸载只弃用组件、停用门实例配置，不删除已写入的 Fact / Decision / 审计 | 卸载路径只调 `deprecate_*` / 停用 |
| I-E1 | 评测由平台执行，不由提议者执行；评测运行只能碰假门 / 回放夹具 | 评测 Handle 的门范围只含评测夹具门；供应 Handle 的是内核评测作业 |
| I-E2 | 评测环境（模型、运行时镜像、用例集版本）与基线不一致时，判定只能是 `unmeasured`，不能是"更好" | 判定函数按环境指纹比较（Meristem `fitness.pair` 的做法） |
| I-E3 | 发布审阅绑定草稿内容摘要：审阅后草稿再改，原审阅失效 | 发布请求带摘要，不一致即拒 |
| I-N1 | **非进化不变量**：平台代码、内核、门与采集器镜像、迁移**永不**因经验改变；Policy / Grant / 自动批准规则**永不**因经验**自动**改变——经验可以产出调整提议（E5），发布仍只经人 | 无任何写这些对象的 agent 能力；提议走现有 human 通道；见 §5.6 |

### 3.4 状态机

- **PackInstallation**：`planned → applying → installed | partially_installed`；`installed → upgrading → installed`；
  `installed → deprecated`。`partially_installed` 可重试（按组件摘要幂等）。
- **草稿的评测子状态**（不改草稿主状态机 `draft → published → deprecated`）：`unevaluated → evaluating → evaluated(verdict)`，
  `verdict ∈ better | within_noise | worse | unmeasured`；草稿内容一改即回到 `unevaluated`。
- **目标结果**：`unknown → achieved | not_achieved`，可被同一给出者更正一次，更正写审计。

## 4. 线 U：可升级的运行时

### 4.1 U0 — 按手册把 pi 升到 1.0.2（立即）

- 按 `pi-upgrade.md` §2 / §3 逐行核对 0.99.2 → 1.0.2：两个 npm 包放仓库外临时目录 diff `dist/` 与 `docs/`；按 entrypoint
  的 flag 用 `deploy/fake-llm` 真实启动 `pi --mode rpc`（无扩展 / entry / worker 三种），把捕获的 stdout 喂给
  `translatePiEvent`；核对记录写成 §2.5 一节（同 0.87.1 / 0.99.2 的做法）。
- 合入后随下一个发版上主机，主机 S1–S4 + S5.7 真实模型回归（入口 agent 的工具面随 pi 大版本可能变化）。
- **验收**：核对表无"未核实"行；主机 S1–S4 全过；真实模型各场景不低于 v0.34.0 一轮的计数（§2.2）。

### 4.2 U1 — 版本感知与提醒（有出口的信号）

**设计**：保持 E3（内核不出网），由 CI 产出、由一个无凭证的取数组件带进来。

1. **CI 产出 ReleaseChannel 记录**：发版工作流与 `pi-drift.yml` 都更新一份 `channel.json`，作为 GitHub Release 资产发布，
   并用 cosign keyless 签名（身份钉到本仓库工作流，与镜像签名同一套）。内容：

   ```json
   {
     "schema": 1,
     "generatedAt": "…",
     "platform": { "latest": "v0.43.0", "releases": [ { "version": "v0.43.0", "pi": "1.0.2", "migrations": ["core 0041"], "breaking": false, "notes": "…" } ] },
     "piUpstream": { "latest": "1.0.2", "checkedAt": "…", "sdkSuite": "pass", "bundledIn": "v0.43.0" }
   }
   ```

2. **漂移检查的成功路径也要出声**：`latest ≠ pinned` 且通过时，开 / 更新一个 `pi-upgrade-available` issue
   （"pi 1.0.2 可用，SDK 套件通过，人工核对项待做"），并写入 channel 记录；不自动开升级 PR（与"常规依赖升级不交给 bot"
   的决定一致，pi 升级必须按手册核对）。
3. **主机侧取数组件 `update-feed`**：一个 compose 服务，只读根文件系统、无 docker socket、无凭证；每天经出网代理只访问
   GitHub 取 `channel.json` 并验签，写进一个只读挂载给内核的目录。验签失败只记日志与状态，不覆盖上一份。
4. **内核读模型 `platform_updates`**：读本地 `channel.json`，与 `KERNEL_VERSION`、`pi.version`、活动运行时镜像对照，返回
   `platformUpdate`（有无新版、跨越的迁移 / breaking）、`piUpdate`（上游最新、兼容性证据、是否已有发布版内置它）、
   `feedFreshness`（取数是否新鲜、验签状态）。
5. **控制台**：平台概览与「pi 运行时」卡片显示四个版本——**在跑 / 本版内置 / 最新发布版内置 / 上游最新**——与证据；
   有新版时侧栏版本号旁出现提醒点。动作是**给出准确的升级命令与检查单**（`apply-release.sh --pull vX.Y.Z`），
   不是控制台里直接升级平台（见决定 3）。

**验收**：channel 记录的签名在主机验证通过；人为构造一份上游更高版本的记录，控制台出现提醒与证据；取数断网 48 小时后
`feedFreshness` 变陈旧并在运行状态页可见。

### 4.3 U2 — pi 作为独立升级的运行时模块（取决于决定 1）

把"pi 模块化可升级"做实的关键，是把手册里的人工核对项变成 CI 证据，让一个新 pi 版本能**自动**变成带证据的候选：

1. **运行时一致性套件（CI）**：在 CI 里构建 worker-runtime 镜像，用 fake-llm 真实启动 `pi --mode rpc`（三种模式），断言：
   CLI flag 可用、stdout 严格 JSONL、事件经 `translatePiEvent` 无 `kind:none` 丢弃、`models.json` 被解析、默认激活工具集、
   扩展加载与工具注册、worker 模式自驱动一轮后退出。这覆盖 `pi-upgrade.md` §2 大部分"人工"行。
2. **候选镜像**：漂移检查对新 pi 版本通过 SDK 套件后，CI 以**本发布版的平台扩展** × 新 pi 构建
   `nexttime-ai-worker-runtime:vX.Y.Z-pi<ver>`，跑一致性套件，通过则签名推到 GHCR，写进 channel 记录的 `runtimeCandidates`。
3. **主机采用**：第一步仍由主机命令拉取（`pull-images.sh --runtime <tag>`，验签、重打本地名），控制台给出命令；
   拉取后用现有 `set_active_runtime_image` → `roll_entry_containers` 切换，`rollback_runtime_image` 回退——这三个能力已存在。
   控制台内直接拉镜像需要给平台加一个"只能拉本仓库签名镜像"的拉取代理（IMAGES + POST），是信任边界扩张，单列决定 2。
4. **兼容边界**：候选只换 pi，不换平台扩展；平台扩展与内核的契约仍随平台发版。候选镜像 label 写明
   `platform-extension-version`，内核拒绝把扩展版本不等于本版的镜像设为活动镜像。

**验收**：pi 发新版后 24 小时内，channel 记录出现带一致性证据的候选；主机拉取、切换、回退各一次，入口会话延续、审计在案。

### 4.4 U3 — 控制台内一键升级整个平台（建议不做，决定 3）

平台升级要动 git 检出、迁移、全部服务重建、备份与验收，需要一个持有 docker socket 与主机文件权限的更新器——这是全平台
最大的影响半径，也与"agent / kernel 进程不持凭证"同方向的隔离原则相冲突。建议保持 `apply-release.sh` 作为唯一入口，
控制台只做到"发现 → 说明影响 → 给出命令与检查单"。若将来要做，前提是 S9 D3（干净主机安装）与升级可逆性探针齐备。

## 5. 线 E：受治理的自进化

### 5.1 对 8 个项目的判断

| 项目 | 进化的对象 | 适应度信号 | 治理 | 对本项目 | 取什么 |
|---|---|---|---|---|---|
| penguin-harness（公开，Apache-2.0） | agent 的行为说明、Skill、安全配置项 | 隐藏评分规则 + 冻结基准，严格更好才接受 | 评测者与优化者隔离、快照、版本单调；环内无人审批 | **高** | 评测框架：冻结用例、隐藏判定、同环境重复运行、严格更好才推荐 |
| Meristem（公开，MIT） | 种子代码与 prompt | 基座侧隐藏探针；环境指纹不一致即 `unmeasured` | 最强：度量权与被测代码分离、单一账本写入者、崩溃安全的晋升序列 | **高**（取不变量，不取代码） | I-E1 / I-E2；晋升意图 → 提交的崩溃安全序列；无效循环熔断 |
| rrsi（google-research，Apache-2.0） | harness 代码 / prompt / 工具 | k 次评测、噪声带下限、成本规则、留出集 | 预评测审查（防泄题、防空改动）、编辑预算 | **高**（评测与选择算法） | 噪声带 δ、成本规则、草稿审查器、"已证伪假设"历史防重复提议、单草稿改动上限 |
| pi-memory-evolution（公开，MIT，pi 扩展） | 记忆断言（事实 / 偏好 / 决定 / 项目状态） | 用户反馈 + 证据等级 + 强化与衰减 | 模型给出的断言一律暂定、证据等级由宿主赋予、事务性取代、可撤销 | **中高**（直接可用的同运行时扩展） | 入口 agent 的个人记忆（E4）；证据等级取代规则 |
| hermes-self-evolution（公开，MIT） | 提议、议程、会话摘要（不自动应用） | 启发式成熟度 + 人的批准 / 拒绝 | 提议状态机、强制审批、白名单验证、打扰配额 | **中高**（生命周期） | 提议的 `expired` / `deferred` / `rollback_required` 状态；"该出现的信号没出现"；打扰配额与重复惩罚 |
| ouroboros（公开，MIT） | 自身代码、prompt、工具、记忆 | 多模型审查 + 测试 + 重启验证 | 活动授权、连续失败熔断、同目标重复熔断、紧急停止；高级模式下取消否决 | **中**（只取控制面模式） | 执行状态与目标结果分开；连续失败 / 重复目标熔断；"每周期一个改动"；**不取代码自修改** |
| 私有仓库 ①（RouterOS 运维平台） | 运维规则、经验、修复模式 | 弱（评审分、点赞、工具成败） | 学到的修复模式默认禁用待批准 | **中**（经验教训更值钱） | "学到的修复 = 默认禁用的草稿"；LLM 抽取的规则 schema 校验失败就丢；按稳定身份分区；它自己审计出的反模式清单 |
| 私有仓库 ②（工作流注册表） | 无进化环 | — | 审批绑定计划摘要、不可变计划、租约与围栏 | **低中** | I-E3 摘要绑定审批 |

**结论**：最有潜力的组合是 **penguin-harness 的评测框架 + Meristem 的度量权分离 + rrsi 的选择算法**，落在本项目已有的
"提议 → 人发布"链上；pi-memory-evolution 是唯一可以近乎直接装进来的代码（同一个 pi 运行时）。ouroboros 与 Meristem 的
代码自修改方向本项目**明确不做**（I-N1）。

### 5.2 进化环（本项目的版本）

```
观察(Observe) → 归因(Attribute) → 提议(Propose) → 评测(Evaluate) → 人发布(Approve & Publish) → 度量(Measure) → 弃用 / 取代
   采集器、门、      E1：Task / WorkerRun     Worker propose_*      E3：平台执行，     I16 human 通道，       E2：使用统计、       deprecate /
   Task 结果         → Skill / Procedure 版本  （已有）             只碰假门           摘要绑定（I-E3）       目标达成率           新版本
```

与现有链的差别只有三处：**归因**、**评测**、**度量**。提议与发布都复用现有能力。

### 5.3 E1 — 结果归因（第一波，其余都依赖它）

- `worker_runs` 记录启动时实际装载的 Skill `(id, version)` 列表（supervisor 解析 Skill 名时就知道版本，回报给内核）。
- `invoke_worker` 增加可选 `procedureRef`（入口 agent 从 `find_procedures` 拿到的 `id@version`），写进 Task，标
  `claimed`（agent 自报，非权威——与 Turn id"调用方自报"同一口径）。
- Task 增加**目标结果**（§3.4）：请求者在对话里对 Task 结果点"达成 / 未达成"，或 Procedure 的验证步骤给出；默认 `unknown`。
- 草稿被丢弃时记录原因（可选文本）作为信号。
- **验收**：新 Task 在读模型里能查到 WorkerDefinition / Skill / Procedure 三个版本与目标结果；旧数据保持 `null`，读模型如实显示"未记录"。

### 5.4 E2 — 度量与可见性

- 读模型 `skill_version_stats` / `procedure_version_stats`：使用次数、执行完成 / 失败（按失败原因）、目标达成率、最近使用。
  是投影，不是新的真相。
- 控制台 Skill / Procedure 页显示这些数字；`find_procedures` 的结果带上达成率，让入口 agent 优先成熟的流程。
- 提示而不是自动：连续 N 次未达成的版本在页面上标"建议复核"，由 builder 决定是否弃用；真实模型回归结果入库，看跨版本趋势。

### 5.5 E3 — 评测框架（核心增量）

- **用例从哪来**：第一批直接复用现有资产——`accept_s2.sh` / `accept_s3.sh` 的真实模型场景（docker_restart、api_observe、
  ssh_run_approve…）与 S2 验收夹具里的假门；第二批从真实 Task 回放（记录下来的观察类门输出作为夹具，执行类动作只模拟）。
- **怎么跑**：内核评测作业向 worker-supervisor 申请评测容器（同一 worker-runtime 镜像），发一个**只含评测夹具门**的 Handle，
  模型经 llm-proxy、走单独的评测预算；候选（草稿）与基线（当前已发布版本）各跑 k 次，同模型、同运行时镜像、同用例集版本。
- **怎么判**：每个用例的判定规则（结构化断言为主，必要时由独立的评审模型打分）对提议者不可见；按 rrsi 的规则判定——
  候选得分低于基线减噪声带 δ 为 `worse`；在噪声带内只有"更省 token"或"新增结构性能力"才算 `within_noise` 可推荐；
  高于噪声带但成本增长没被收益覆盖也不推荐；环境指纹不一致为 `unmeasured`（I-E2）。
- **审查器**：评测前对草稿做确定性检查——不含凭证样式字符串、不含工作区内部 id、步骤有界、不是空改动——不通过直接退回提议者。
- **结果去哪**：EvalRun 是 `kind=evaluation` 的 Activity，产出 Observation 作为草稿的 Evidence；发布审阅页显示判定、
  各用例得分与成本差，发布请求绑定草稿摘要（I-E3）。**评测只给证据，不替人发布**。
- **防噪**：每个工作区每天提议进入评测的配额；同一目标被重复提议且多次 `worse` 时熔断（ouroboros），被证伪的假设记入历史，
  提议者再次提议时看得到（rrsi）。
- **验收**：一个 Skill 草稿经评测在发布页显示判定；评测期间任何真实门零调用（审计可证）；改模型后同一对比判 `unmeasured`。

### 5.6 E4–E6 与明确不做

- **E4 入口 agent 的个人记忆**（决定 6）：建议以 pi-memory-evolution 作为入口模式的受审扩展试点——随 worker-runtime 镜像
  固定版本、配置锁定；模型调用只走 llm-proxy（`models.json` 已指向它，容器内无凭证），**关闭跨供应商回退**；存储在用户私有
  工作目录（I15，只挂给本人的入口容器）；记忆断言只是该用户的私有上下文，**不进图谱、不成为 Fact**。第二步再考虑把断言作为
  私有 Source 的 Observation（`epistemic_status=inferred`）导出到图谱。
- **E5 治理调优建议**：从 `get_operation_stats` 发现"某 Operation 近 30 天人工批准 50 / 50"之类模式，**提议**调整
  `auto_approvable` 或沉淀 Procedure——只产提议，由 owner 决定（呼应"只在关键点设门"）。这与 I-N1 不冲突：I-N1 禁止的是
  治理规则**自动**改变，E5 产出的是待人审阅的提议。
- **E6 本体缺口提议**：持续出现、无法映射到现有类型的观察聚类，产出 `propose_ontology_change` 草稿（hermes 的"未匹配信号"）。
- **明确不做**（I-N1）：代码 / prompt 的自修改与自动合入；agent 改 Policy / Grant；评测结果自动发布；未经人工的记忆晋升为
  工作区事实。

## 6. 线 P：能力包（Pack Contract v1）

### 6.1 对 GPT 方案的评审

| GPT 方案的主张 | 判断 | 处理 |
|---|---|---|
| Kernel 永远通用，不认识 HR / 汽车 / RouterOS | **同意，且已成立**（内核零命中） | 写成 I-P2 / I-P3 的前提，守住 |
| 六层结构（Agent / Operational Graph / Ontology / Governance / Integration / Extension Runtime） | **基本同意**：前五层都已存在，只有 Extension Runtime（包管理）是新的 | 不改名现有模块，只新增包管理（§6.3 对照表） |
| OpenMetadata 是可选的 Context Provider，不是必选内核 | **同意** | §6.6 |
| 在内核定义 `ContextProvider` 接口（search / get_entity / traverse / lineage …） | **暂不做**：今天只有一个提供方；门的观察类 Operation + `find_operations` + Skill 已经给了 agent 一层间接 | 第二个真实提供方（DataHub / Atlas）出现时再引入"Operation 规约"（一组标准观察操作签名），Skill 面向规约而非厂商 |
| ExternalResourceProvider（HTTP / MCP / SSH / CLI / DB / Browser） | **已存在**：就是 Gatekeeper 的通用传输种类 + InterfaceManifest | 无新增；`db` / `browser` 仍按原路线图 |
| `package.yaml` 里 `permissions: [context.read, metadata.read]` | **不同意**：包不能自授权 | 改为 `requires`（声明需要的门 / 连接器 / 能力），安装产出计划，由 owner 经现有 `authorize` / `connect_gatekeeper` 授权（I-P2） |
| 包里带 `migrations/` | **不同意**：包不能对内核库跑 SQL | 本体演进走本体版本 + `breaking`；数据转换由 Worker 经治理路径 supersede（I-P2） |
| 包里带 `gatekeepers/`、`collectors/`、`workers/` 代码 | **部分同意**：要分信任层 | 数据组件 owner 可装；代码组件只按镜像 digest 引用、平台管理员引入、验签（I-P3） |
| 目录叫 `packages/` | **改名** | 与 monorepo 的 `packages/` 冲突，用 `packs/` |
| `nexttime install openmetadata` | **同意，作为运维通道** | 控制台为主、CLI 为运维与批量；不做应用市场与远程仓库（§5f"明确不做"继续有效） |

### 6.2 包清单（`packs/<name>/pack.yaml`）

```yaml
schema: 1
name: openmetadata              # 族名，也是命名空间前缀的来源
version: 1.0.0                  # PackVersion；发布后内容摘要固定
summary: 企业数据目录与血缘（联邦查询）
requires:
  platform: ">=0.X.0"            # 占位：首个支持 Pack Contract v1 的平台版本，P1 合入时确定
  packs: []                     # 决定 4：只做版本检查，不自动安装依赖
  connectors:
    - kind: mcp                 # 需要一个 mcp 门；凭证由人在门里录入
      preset: openmetadata-mcp
components:
  ontology:      [ontology/data-catalog-v1.yaml]
  operations:    [operations/openmetadata-mcp.yaml]   # 对 OM MCP 工具的分类：观察 / 执行、影响半径
  connectorPresets: [connectors/openmetadata-mcp.yaml] # 无凭证：kind、endpoint 占位、出网放行、manifest 引用
  workerTemplates:  [workers/data-steward.yaml]
  skills:        [skills/lineage-impact/, skills/data-discovery/]
  procedures:    []
  evalSuites:    [eval/data-steward-v1.yaml]
  images:        []             # 代码组件：只写镜像 digest；本包没有
checks:                         # 安装后验证
  - gate.health: openmetadata-mcp
  - operation.observe: { op: search_metadata, params: { query: "*", size: 1 } }
```

**组件信任层**：

| 层 | 组件 | 谁能装 | 怎么装 |
|---|---|---|---|
| 数据层 | 本体族、Operation 分类、连接器预设、WorkerDefinition 模板、Skill、Procedure、评测用例集 | 工作区 owner | 经现有发布能力，human 通道，带 `installed_from` |
| 代码层 | 门镜像、采集器镜像 | 平台管理员 | 按 digest 引用、验签；包安装计划只检查"是否已就位"，缺失则提示管理员 |

**包从哪来**：镜像内 `packs/`（官方包，随发版）+ 主机 `config/packs/`（企业私有包，沿用 `config/ontology/` 的先例）。
不做远程包仓库；以后若要分发，用签名的 OCI 制品，复用镜像签名链。

### 6.3 六层对照

| GPT 层 | 本项目现有模块 | 本阶段 |
|---|---|---|
| Agent Runtime | 入口 agent / Worker / Task / `invoke_worker`（pi 运行时） | U 线（版本与升级）、E1（归因） |
| Operational Graph | Object / Fact / Link / Source / Observation / Activity / Decision / Conflict | E3 的 EvalRun 复用 Activity |
| Ontology Runtime | ObjectType / LinkType / ActionType、本体族与版本 | P0：I-P1 命名空间不变量 |
| Governance Runtime | Capability / Grant / Handle / Policy / ActionRequest / Approval / 审计 | 不变；包只调用它 |
| Integration Runtime | Gatekeeper 通用传输 + InterfaceManifest + 门宿主 + 采集器 | P0：接入路径统一 |
| Extension Runtime | 只有"模块 = 本体包" | **新增**：Pack / PackVersion / PackInstallation、安装计划器 |

### 6.4 安装、升级、卸载

- **安装**：读清单 → **计划**（干跑：新增 / 更新 / 已定制 / 命名冲突 / 缺少的门与代码组件 / 依赖版本）→ owner 确认
  （breaking 或含已定制组件时走 ConfirmTier）→ 逐组件调用现有发布能力（human 通道，发布人 = owner，同 D4 先例）并写
  `installed_from` → 跑 `checks` → `installed` 或 `partially_installed`（按组件摘要幂等，可重试）。
- **升级**：逐组件按 D2 推广后的哈希判定——未定制则升级，已定制则跳过并标"需人工合并"，breaking 须确认。
- **卸载**：弃用 `installed_from` 该包且未定制的组件，停用由预设创建的门实例配置；已写入的 Fact / Decision / 审计一律保留（I-P4）。
- **术语**：沿用现有词汇——"领域包 / domain pack"仍指一个本体族文件（`publishOntologyDomainPack`、`add-domain-pack.md`），
  是能力包的一种组件；"能力包 / Pack"指整个可装卸的组合（§5f 已用此词）。两者不混用。
- **与现有"模块"的关系**：模块是只含本体组件的包。`ontology/modules.yaml` 迁到 `packs/<name>/pack.yaml`；
  `install_module` / `upgrade_module` 过渡期作为 `install_pack` / `upgrade_pack` 的别名保留，控制台模块页改为包页。

### 6.5 验证用的三个包

1. **ops-base**：ops-assets 本体 + ops-runner 模板 + docker / ssh 连接器预设 + 运维 Skill + 主机采集器镜像引用（代码层）——全是现成件，证明能打包。
2. **knowledge**：RAGFlow 连接器预设 + KnowledgeBase 本体 + 检索 Worker 模板——证明非运维领域也成立（§5f 原定）。
3. **openmetadata**：§6.6——证明"企业上下文层"可以作为可选包接入，内核零改动。

### 6.6 OpenMetadata 的定位与真相边界

- **定位**：可选能力包，不是内核依赖。不装它，平台照常运行；装了，agent 多一个数据上下文来源。
- **真相边界**：**元数据的权威在 OpenMetadata**（表、列、血缘、负责人、术语表）；**运营状态、决策与动作的权威在 NextTime**。
  v1 只做**联邦查询**：agent 经 `mcp` 门的观察类 Operation 实时查 OM，调用经治理、审计在案，结果不复制进图谱。
- **锚点镜像（决定 5）**：若需要把数据资产与运营对象连起来（例如某张表 `hosted_on` 某个数据库服务容器），只镜像这些锚点
  对象：`Source = openmetadata`，靠观察窗口与 `not_reobserved` 保持新鲜，绝不复制整个目录。实现上倾向"门驱动的采集"
  （定时运行观察类 Operation + 结果映射 → `submit_observations`），这样同步也是数据层组件、不需要专用采集器镜像——
  但它依赖 Trigger（设计 §5.1.4 的 P5 概念），所以排在后面。
- **写回**：对 OM 的任何写（打标签、改负责人）是执行类 Operation，经 ActionRequest 与审批。
- **ContextProvider 的触发条件**：第二个目录类提供方在真实部署里出现时，引入"Operation 规约"，让 Skill 面向规约而非厂商。

### 6.7 回答维护者的问题："这样能成为通用底座么"

能，前提是守住三件事：

1. **内核不认识任何领域**（今天已成立，靠 I-P1–I-P3 继续守住）；
2. **扩展是数据，代码在门后**——企业定制主要是装包与配连接器，不改内核、不在内核里加载包代码；
3. **包不绕过治理**——安装只是"批量走一遍现有的提议 → 发布"，授权、审批、审计一条不少。

这样不同企业的差异落在"装哪些包、接哪些系统"，内核与治理保持同一套——这正是每个企业一套自托管（§5f 决定）下
能复用、能升级的形态。

## 7. 波次

| 波次 | 内容 | 验收 |
|---|---|---|
| **W1（建议马上开）** | **U0** pi 1.0.2 按手册升级；**U1** channel 记录 + 漂移成功路径出声 + `update-feed` + `platform_updates` 读模型 + 控制台提醒；**P0** I-P1 命名空间不变量（先在主机只读预检现有工作区有无同名类型）+ 连接器接入路径统一；**E1** 结果归因（Skill / Procedure 版本、目标结果、丢弃原因）；遗留 126 文档漂移 | 各节验收；主机 S1–S4 全过 |
| W2 | **P1** Pack Contract v1（数据层）+ 模块迁移 + ops-base 包；**E2** 度量与可见性；**U2** 运行时一致性套件（若决定 1 选 b，再加候选镜像） | 第一个包经计划 → 安装 → checks；Skill 页有统计；一致性套件进 CI |
| W3 | **P2** knowledge 包（通用性证明）；**E3** 评测框架 MVP（第一批用例 = S2 真实模型场景 + 假门） | G4、G5 |
| W4 | **P3** openmetadata 包（联邦查询）；**E4** 入口记忆试点（若决定 6 同意） | 在 OM 测试实例上跑一条血缘影响分析旅程 |
| 触发后再做 | 代码层组件在控制台安装；ContextProvider / Operation 规约（第二个提供方）；门驱动采集与 Trigger；E5 / E6；控制台内拉取镜像（决定 2）；控制台内平台升级（决定 3） | 各自立项时定 |

每个波次都是"合入 → 发版 → 主机应用 → STATUS 更新"的完整闭环，沿用现有发版流程。

### 7.1 遗留线 L：开放遗留随波次收敛

原则：S10 不另开"修遗留"阶段，**遗留跟着改到同一批文件的 S10 项一起修**（`code-review-2026-10-02.md` §6.5 已按文件把
89 条 P3 切成 11 条车道，本节把车道挂到波次上）；S10 的前置项与安全纵深项放进 W1；维护者已决定推迟的保持推迟，写明重启条件。
状态以 2026-10-04 的 `STATUS.md` §4 为准（已核实逐行读过）。

| 遗留 | 内容（摘要） | 排进 | 理由 |
|---|---|---|---|
| 124 / 125 / 126 | 同名类型静默覆盖 / 无版本感知 / pi 文档漂移 | W1（P0 / U1） | 本方案新立 |
| 88 | 内部服务主体可被签 Handle | **本 PR 关闭** | 内核半边已由 #432（R-36，`service-handle-handler.ts`）修复，遗留表状态未同步 |
| 118 残余 ① | 自连的门没有平台侧切断手段 | W1（P0） | 与连接器接入路径统一是同一件事 |
| 118 残余 ② | 审批推送持有者未纳入 R-17"只有人能批" | W2（随 K1） | 治理读模型，同车道 |
| 48 ② | `propose_skill` / `propose_procedure` 没有族 id，改一个已发布 Skill 会变成新族 | W2（E2 前置），**决定 10** | E3 评测要比较"候选 vs 同族已发布版本"，没有族就没有基线；需先定"编辑 = 同族新版本"的产品语义 |
| 48 ① | 观察窗口没有能力暴露（图谱页写死 2h） | 记债，触发：门驱动采集 / 锚点镜像（决定 5 选 b） | 新鲜度语义与它同一处设计 |
| 123 · 车道 K2 认知层与 Worker | L3-8 / 9 / 13 / 14 / 15 | W1 | E1、P0 改的就是 `substrate/graph`、`application/worker`、`task/service`、`substrate/ontology` |
| 123 · 车道 K4 数据库与身份纵深 | L4-11 余项（security-definer 函数信任 `p_workspace_id`、`find_active_fact_for_identity` 可跨工作区读）、L5-16、L4-13、L1-14 余项 | W1 | 隔离只增不减；E1 本就带迁移，迁移号一次分配 |
| 123 · 车道 S1 脚本与 CI | L9-3（`gate-host/` 是否备份，**决定 11**）、L9-9…L9-16、image-scan；`i18n-pairs` 守卫在 `ci:guards` 里但 CI 不跑 | W1 | U1 改发版与漂移工作流 |
| 123 · 车道 D1 文档 | L10-7…L10-14 余项、L5-15 余项 | W1 | 与 126 同批 |
| 123 · 跟进项（S10 前置） | `anthropic-beta` 白名单绑定 pi 0.99 的取值；嵌套 Worker 的 Task 没有 Turn 归属；`sources` 每个 WorkerRun 一行无上限增长；`list_ontology_versions` 的 keyset 同毫秒不唯一；R-29 留的"工作区事务可改自己的 `ontology_enforcement`"例外（可逆性探针基线已越过 v0.38.x，可删） | W1（依次随 U0 / E1 / E1 / P0 / P0） | 不先修，U0 / E1 / P0 会直接踩到 |
| 123 · 车道 K1 网关与读模型 | L1-13、L2-13 / 16 / 18、L5-9、I14 谓词四份副本；跟进：`causal_chain` / `decision_impact` / `explain(activityId)` / Explorer 溯源无 viewer 过滤、工作区级 `requesterCanApprove` 跨门生效 | W2 | P1 在网关加包能力；溯源过滤是纵深防御 |
| 123 · 车道 K3 监控与运行时 | L3-7 / 10 / 11 / 12、L1-15、L4-14…L4-18 | W2 | U2 / E2 改 `application/platform` |
| 123 · 车道 R1 agent 侧 | L5-6 / 7 / 8 / 11、L5-12(a)、L5-13、L5-14（含入口工具列表静态、门输出截断后再降 agent-host 100 MiB 帧上限） | W2 | U2 一致性套件改 `bridge.ts` 与平台扩展 |
| 123 · 车道 W1 控制台确认与人控 | L7a-3、L7a-13、L8a-6、L8a-11 余项、L8b-11 | W2 | 包安装确认用同一套 ConfirmTier |
| 123 · 车道 R2 运行时服务 | L6-16 余项、L6-18、L10-16 | W3 | E3 评测容器改 worker-supervisor |
| 123 · 车道 W2 控制台状态与表单 | L7a-8…L8b-14 共 16 条（含审批历史不随推送刷新 L8a-15） | W3 | E2 统计页、包页的状态处理同批 |
| 123 · 车道 W3 控制台文案与健壮性 | L7a-7…L7b-10 共 16 条、web 漂移八处 | W4 | 随 openmetadata 包的页面 |
| 123 · 其余跟进 | 已认证 `/ws` 每连接速率、caddy 单来源连接数；`CAPABILITY_HANDLE` 经 env 传入（R-24 后续）；`disable_principal` 不标会话 revoked；CLI `issue-service-handle` 不按角色收窄、`register-gatekeeper --publish` 不写审计；收回 Grant 只吊销入口会话；Turn 生命周期四处（`latestTurnSummary` 不重置、`interruptStaleRunningTurns` 不入队、消息与结束并行落库、`report_turn` 不核 `started_by`）；测试抖动与含 NUL 字节的测试文件；改密页写死 8 位；D-29 按 WorkerDefinition 开供应商侧工具 | 按文件归入上面车道；`register-gatekeeper` 随 W1 P0；D-29 随 W2 P1（WorkerDefinition 模板字段一并定） | — |
| 49 余项 | 行内 `style` 136 处、`style-src 'unsafe-inline'` | 随 W2–W4 控制台车道顺手迁 kit | 无单独车道，维持既定做法 |
| 10 | Trigger、`extension_ui_request`、CLI 清单解析（P5） | 维持维护者决定"不动"；触发：决定 5 选 b 或门驱动采集立项 | Trigger 是锚点镜像的前提 |
| 102 | 异地备份 | 维持推迟（2026-10-02 决定） | — |
| 53 | 本机运维残留 | 维护者本机自查，不进计划 | — |
| S9 D3 | 干净主机安装首跑 | 维持推迟；建议在**第一个外部企业部署之前**做 | 能力包与 U2 会提高它的价值 |

完成口径：每个波次关闭的遗留在同一 PR 里改 `STATUS.md` §4；遗留 123 在 11 条车道全部清空后关闭。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| 三条线同时推，范围膨胀，违背"收敛优先" | W1 每条线只做一小块；后续波次有明确触发条件；不加触发外的新概念 |
| pi 1.0 大版本破坏 RPC / CLI 行为 | U0 按手册真实运行核对；主机真实模型回归；`:pi-0.99.2` 镜像留作回滚 |
| channel 记录被篡改 | cosign keyless 验签，身份钉到本仓库工作流；验签失败不覆盖旧记录 |
| I-P1 落地时现有工作区已有同名类型 | 先在主机只读预检；若有，迁移方案单独评审（改名为带前缀的新版本，旧版本保留可读） |
| 评测成本（LLM 花费）失控 | 评测独立预算、每工作区每日配额、k 与用例数有上限，`report-usage.sh` 可按评测汇总 |
| 评测噪声导致误判 | 噪声带 δ、k 次重复、环境不一致即 `unmeasured`；评测只给证据，最终由人发布 |
| 包安装半途失败 | 计划先行、按组件摘要幂等、`partially_installed` 可重试 |
| 记忆扩展泄露隐私 | 只在本人入口容器、私有工作目录；关闭跨供应商回退；不进图谱 |
| 包机制被当成"能装任意代码" | I-P3：代码组件只经平台管理员、按 digest 验签；内核永不加载包代码 |

## 9. 验证

- **功能**：每节"验收"条目；W1 结束主机 S1–S4 全过、真实模型回归不低于 v0.34.0 计数。
- **领域**：PackInstallation、评测子状态、目标结果只沿 §3.4 的转移走（转移表 + 测试）。
- **授权**：包安装只能 owner；代码层只能平台管理员；评测 Handle 碰不到真实门（集成测试 + 审计核对）。
- **溯源**：任一经包发布的对象能答出"来自哪个包的哪个版本"；任一草稿的评测判定能答出"用哪套用例、和哪个版本比、在什么环境下"。
- **语义一致**：控制台、读模型、能力描述、本文对"模块 / 包""执行状态 / 目标结果""候选 / 活动镜像"用同一套词。

## 10. 待维护者决定

| # | 问题 | 选项 | 建议 |
|---|---|---|---|
| 1 | pi 的升级轨道 | (a) 继续随平台发版内置，只加版本感知（U1）；(b) 另开运行时候选轨道，pi 新版自动出带证据的候选镜像（U2） | **W1 做 (a)，W2 做 (b) 的 CI 半段**（一致性套件 + 候选镜像），主机仍用命令拉取 |
| 2 | 是否给平台加"拉取本仓库签名镜像"的权限，让控制台直接拉候选镜像 | 加（新拉取代理，IMAGES + POST，只许本仓库 digest，验签）/ 不加（控制台给命令） | **暂不加**；U2 跑顺后再议 |
| 3 | 是否做控制台内一键升级整个平台 | 做（持有 docker socket 与主机文件权限的更新器）/ 不做（`apply-release.sh` 唯一入口，控制台给命令与检查单） | **不做**；前提条件见 §4.4 |
| 4 | 包之间的依赖 | (a) 清单 `requires.packs` + 版本检查，不做求解、不自动装依赖；(b) 共享词汇只放平台元本体，包之间不互相引用 | **(a)**；配合 I-P1，被依赖包的类型可引用不可重定义 |
| 5 | OpenMetadata 的数据怎么进来 | (a) v1 只联邦查询；(b) 同时镜像锚点对象 | **(a)**；锚点镜像等门驱动采集 / Trigger |
| 6 | 入口 agent 的个人记忆 | (a) pi-memory-evolution 扩展试点（私有、走 llm-proxy、不进图谱）；(b) 直接做进图谱的私有断言；(c) 暂不做 | **(a)，放在 W4** |
| 7 | 目标结果谁来标 | 请求者在对话里标 / 只由 Procedure 验证步骤给 / 两者都可 | **两者都可**，默认 `unknown`，不强制 |
| 8 | 评测预算 | 平台级上限 / 工作区 owner 可调 | **工作区配额由 owner 调，平台设上限**（与现有配额同一处） |
| 9 | 阶段命名与开工 | 本阶段记为 S10；W1 是否马上开 | **S10，W1 马上开**；U0 不依赖其他决定，可先行 |
| 10 | 修改一个已发布的 Skill / Procedure，提议的是什么（遗留 48 ②） | 同族新版本（带族 id，与 WorkerDefinition 一致）/ 另起新族 | **同族新版本**——E3 的"候选 vs 基线"与 E2 的按族统计都依赖它 |
| 11 | `gate-host/`（门实例配置与凭证）是否进每日备份（复审 L9-3） | 进（与含供应商 key 的 `files-*.tgz` 同等对待：本机、同权限）/ 不进（丢失后重新录入凭证） | **进**；异地转存时与遗留 58 / 102 一并加密 |

## 附录 A：证据清单

- pi 版本：`pi.version`；`packages/platform-extension/package.json`；`deploy/worker-runtime/Dockerfile`；`scripts/build-images.sh`；
  `scripts/pull-images.sh`；`.github/workflows/pi-drift.yml`；`docs/runbooks/pi-upgrade.md`。
- 运行时读模型与动作：`packages/kernel/src/application/platform/runtime.ts`（`pi_drift`、`runtime_inventory`、`roll_entry_containers`）；
  `packages/shared/src/capabilities.ts`（`set_active_runtime_image`、`rollback_runtime_image`）；
  `packages/web/src/components/platform/PlatformRuntimePage.tsx`。
- 模块：`ontology/modules.yaml`；`packages/kernel/src/application/platform/modules.ts`；`development-tasks.md` §5d 决定 D1–D4。
- 本体合并：`packages/kernel/src/substrate/ontology/registry.ts` `mergeVisibleOntology`。
- 归因缺口：`packages/kernel/migrations/task/0001_tasks.sql`（只有 `worker_definition_id` / `worker_definition_version`）；
  `packages/shared/src/worker-definition.ts`（Skill 按名字列出）；`packages/kernel/migrations/worker/0002_skills_procedures.sql`。
- 外部：npm `@earendil-works/pi-coding-agent` dist-tags；GitHub `open-metadata/OpenMetadata` releases（2.0.3，2026-09-30）；
  8 个参考仓库的源码阅读（2026-10-04，未运行；论文与基准数字是来源方声明，未复现）。
