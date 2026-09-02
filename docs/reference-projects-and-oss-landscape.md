# 参考项目分析与开源生态调研（附录）

> 配套主文档：`graph-ai-middle-platform-design.md`。
> 本文是三个本地参考项目的源码级分析（只读，未修改任何文件）与开源生态的联网调研结果。分析由子代理完成、主会话审阅，调研中未能从一手来源核实的事实已标注 `(unverified)`。
> 日期：2026-09-01

---

## 第一部分：三个本地参考项目

### 1. Semantica 0.6.7（`D:\NextTime AI\semantica-0.6.7`）

**一句话**：MIT 许可、自托管、确定性的「图原生中间件」，位于企业原始数据 / LLM agent 与受治理知识基底之间。自称「open-source Palantir for AI Agents」。核心卖点是用可审计、可解释、可查询的图取代不透明的向量相似度「记忆」，让 agent 决策能经受「为什么这么决定」的审计。

**在本设计中的角色**：摄取 / 抽取 / 冲突 / 溯源 Worker；概念词表来源。不作主存储、不作主 API。

#### 1.1 一等领域概念

| 概念 | 定义位置 | 说明 |
|------|---------|------|
| Entity | `semantica/kg/entity_resolver.py` | 已消歧的现实对象 |
| Relationship / Edge | `semantica/kg/temporal_model.py` | 带类型、权重、双时态 |
| **Decision** | `semantica/context/decision_models.py:88-108` | `category / scenario / reasoning / outcome / confidence / decision_maker / valid_from / valid_until / metadata`，是完整生命周期对象 |
| Policy / Exception / Precedent / ApprovalChain | `semantica/context/decision_models.py` | 与 Decision 绑定的治理对象 |
| **ProvenanceEntry** | `semantica/provenance/schemas.py:39-99` | W3C PROV-O 兼容（entity / activity / agent / role / source / checksum / confidence）；invalidation 是 tombstone 而非硬删 |
| **Conflict** | `semantica/conflicts/conflict_detector.py:63-79` | 类型 `VALUE / TYPE / RELATIONSHIP / TEMPORAL / LOGICAL`，带严重度与置信度，不是静默覆盖 |
| **BiTemporalFact** | `semantica/kg/temporal_model.py:28-63` | `valid_from / valid_until`（业务时间）+ `recorded_at / superseded_at`（系统时间） |

非一等 / 派生：Triple / EntityOut / RelationOut 是抽取阶段 DTO（`semantica/semantic_extract/schemas.py`）；Ontology 是生成产物（OWL 类 / 属性），治理靠 SHACL 校验器外挂，不是运行时强制的 schema 权威；`AgentMemory` 是向量 + KG 的检索包装，没有 Episode 一等对象（`semantica/context/agent_memory.py`）；没有 SQL / BI 语义层。

#### 1.2 流水线

`Sources → Ingest → Parse → Normalize → Split → Extract → Conflict Detection → Deduplication → KG Construction → [Ontology · Reasoning · Provenance · Decisions] → Enriched KG → Vector Store + Polyglot Graph Store → Export / Visualize / REST / MCP / CLI`（`ARCHITECTURE.md:11-68`）。

关键类：Ingest 层 `FileIngestor / WebIngestor / DBIngestor / RepoIngestor / EmailIngestor / MCPIngestor / SAPIngestor` 等；抽取 `NamedEntityRecognizer / RelationExtractor / EventDetector / TripletExtractor / CoreferenceResolver`；冲突 `ConflictDetector / ConflictResolver / SourceTracker`；构图 `GraphBuilder`（`semantica/kg/graph_builder.py:29-90`）、`GraphValidator`；智能层 `OntologyEngine`（`semantica/ontology/engine.py`）、`Reasoner`（Rete / Datalog / SPARQL / Abductive / Deductive，`semantica/reasoning/reasoner.py`）、`ProvenanceManager`、`ContextGraph / DecisionRecorder / CausalChainAnalyzer / PolicyEngine`（`semantica/context/`）；编排 `Semantica`（`semantica/core/orchestrator.py`）与声明式 `Pipeline` DSL（`semantica/pipeline/`）。

#### 1.3 存储抽象（值得直接借用）

- 图库（LPG / Cypher）：Neo4j、FalkorDB、Apache AGE、AWS Neptune，统一在 `GraphStore / NodeManager / RelationshipManager / QueryEngine` 后（`semantica/graph_store/graph_store.py:14-38`）。
- 三元组库（RDF / SPARQL）：Oxigraph（嵌入）、Blazegraph、Jena、RDF4J、Anzo（`semantica/triplet_store/`）。
- 向量库：FAISS、Qdrant、Weaviate、Milvus、Pinecone、PgVector、sqlite-vec，统一在 `VectorStore` facade（`semantica/vector_store/vector_store.py`），`HybridSearch` 结合向量与 KG 结构信号。
- 模式一致：每种存储一个 facade，字符串选后端，每个后端一个 adapter 文件 + `registry.py`。这是「存储可换、领域模型不动」的干净实现。

#### 1.4 溯源 / 冲突 / 时态 / 置信度

- PROV-O 显式映射（`prov:Entity / Activity / Agent / wasDerivedFrom / used / generatedAtTime / Invalidation`）；`agent_type` 区分 person / software_agent / organization。
- 冲突有类型学、严重度评分、来源可信度评分；被标记而非覆盖。
- 真正的双时态；`state_at()` 时点快照；Allen 区间代数。
- **置信度只是一个 float 属性**，没有区分观察 / 推理 / 主张 / 已验证的认知模型——这是主文档 §5.6 补的部分。

#### 1.5 治理 / 校验

`GraphValidator`（悬边、自环、孤点、severity 分级 `ValidationIssue`）；`OntologyValidator` + SHACL（`pyshacl`）；`PolicyEngine`（版本化策略、合规检查、违规检测、例外处理，`semantica/context/policy_engine.py`）——这是最接近权限层的东西，但它是合规检查器，不是状态转移治理器；`change_management/` 有本体版本管理。

#### 1.6 MCP server

`mcp/server.py`，JSON-RPC 2.0 over stdio（协议 `2024-11-05`），17 个工具：decisions（`record_decision / query_decisions / find_precedents / get_causal_chain / analyze_decision_impact`）、graph（`add_entity / add_relationship / search_graph / get_graph_summary / get_graph_analytics`）、extraction（`extract_entities / extract_relations / extract_all`）、reasoning（`run_reasoning / abductive_reasoning`）、export（`export_graph / get_provenance`）。主文档 §9.3 的 epistemic 分组直接沿用了这里的动词。

#### 1.7 插件 / 分发

- 运行时 `PluginRegistry`（`semantica/core/plugin_registry.py`）：文件系统发现、依赖解析、生命周期——通用动态加载器，没有 capability / 前置条件 / policy 契约。
- `plugins/`：面向 Claude / Cline / Codex / Continue / Cursor / VS Code / Windsurf / OpenClaw 的插件清单 + 一组 skills（`ingest / extract / ontology / reason / temporal / provenance / policy / validate / ...`）+ agents（`decision-advisor / explainability / kg-assistant`）。「同一能力、N 个运行时适配」模式与你的多工具协作目标直接相关。

#### 1.8 Explorer

React / TS / Vite SPA，FastAPI 后端（`semantica/server.py`，可选 `SEMANTICA_API_KEY` 单 key 鉴权）。工作区：Graph / Ontology / Vocabulary / Reasoning / Decision / Lineage / DiffMerge / Enrich / ImportExport / Sparql / Manage。另有 Streamlit 版 `explorer-lite`。

#### 1.9 优势与缺口

**借**：Decision 一等 + 因果链；双时态作为默认不变量；Conflict 对象化；facade + adapter 存储抽象；PROV-O 而非自造审计日志；`plugins/` 多运行时分发。

**缺口**：无 RBAC / 授权模型（单 API key）；无真多租户（只有 `VectorNamespaceManager` 的简单 ACL，未贯通图 / 三元组 / 决策）；置信度不是受治理认知状态；Decision / Entity 无显式状态机；本体是建议性生成物而非运行时强制；插件注册表无 capability 契约。

#### 1.10 技术栈与成熟度

MIT；0.6.7（CHANGELOG 2026-08-28）；Python ≥ 3.8；spaCy / transformers / torch / networkx / rdflib / pyoxigraph / FastAPI；约 186,800 行核心代码，297 个测试文件，9 个 GitHub Actions 工作流含 CodeQL 与安全扫描；CHANGELOG 按 PR 记录测试通过数。

---

### 2. cloudflare-os（`D:\NextTime AI\cloudflare-os-main`）

**一句话**：Apache-2.0、Cloudflare Workers 原生的「AI 生产力操作系统」。每个用户有沙箱化的应用实例（Gadget ≈ 进程），由写代码的 AI agent 构建；每个外部集成（Gatekeeper ≈ 设备驱动）是单独部署的 Worker，经 capability 审批 / 审计层中介。显式 OS 类比：内核 = `packages/workshop-backend`，驱动 = `packages/gatekeeper-*`，shell = `packages/workshop-frontend`，进程 = gadgets，可执行文件 = blueprints。v2 重写，early access，不接受外部贡献。**agent loop 直接使用 pi 的 `pi-agent-core` / `pi-ai`。**

**在本设计中的角色**：治理模型与分权结构的蓝本。借概念，不借代码（机制锁死在 workerd）。

#### 2.1 包地图

| 包 | 职责 | 关键文件 |
|----|------|---------|
| `workshop-backend` | **内核**：工作区状态机、agent loop、capability 签发、审批队列、gadget 生命周期 | `src/overseer.ts`（11.3k 行，Workspace DO）、`src/user.ts`（User DO）、`src/agent.ts`、`src/access.ts` |
| `workshop-shared` | Cap'n Web RPC 契约 | `src/api.ts`（4k 行）、`src/gatekeeper.ts`（capability 接口） |
| `workshop-frontend` | 纯客户端 SPA，持久 WebSocket RPC | — |
| `gatekeeper-*`（github / google / slack / notion / confluence / cloudflare / supabase / spotify / zoominfo / homeassistant / linear / email / scheduler / context / mcp / mcp-portal） | 每个是独立部署 Worker，中介一个外部服务；自持 OAuth、存储、scope | 各包 `src/` |
| `mcp-shared` | `gatekeeper-mcp` 共用库：MCP client、OAuth 链、资源 URL scope 语法、排队动作存储 | `src/tools.ts`（**信任边界**）、`src/oauth.ts` |
| `router` | 公共入口；`/api/*` → backend，`/gatekeeper/<name>/*` → 扫描 `GATEKEEPER_*` 绑定 | `src/index.ts` |
| `typed-storage` | DO SQLite 之上的类型化集合 / 索引层，内核唯一持久化抽象 | `src/index.ts` |

#### 2.2 OS 领域模型

一等概念：**Workspace**（一个 `OverseerDurableObject`）→ 包含 **Workpiece**（共享顺序 ID 命名空间）：**Gadget**（沙箱应用实例）与 **Gatekeeper connection**；**User**（`UserDurableObject`）拥有 **ConnectedAccount**；**Chat / AiChat**；**Action**（排队的副作用操作，审计行）；**Observation**（读，数据返回前同步授权）；**Hook**（gatekeeper → workspace 的入站事件订阅）；**Blueprint**（可分享模板）；**Collaborator** + **Role**（`"build" | "use"`，`api.ts:4005`）。

#### 2.3 Worker 调用模型

- **没有运行时服务注册表**。注册在部署期：`router` 扫描自身 `GATEKEEPER_*` service binding。运行时发现是基于 capability 而不是名字查找：资源 URL 只经 `UserDurableObject.getGatekeeperClassFor()` 变成绑定的 `Fetcher<Gatekeeper>`。
- 两种调用都是同步 RPC（Cap'n Web / Workers RPC），无消息总线：
  - **Gatekeeper 调用**：每次读经 `ApprovalQueue.authorizeObservation()`；每次写经 `ApprovalQueue.submit()` 排队，之后 `Gatekeeper.applyAction()` 应用；鼓励 gatekeeper **模拟**待审批动作，让调用方不阻塞（`gatekeeper.ts:698-855`）。
  - **Code Mode**：`OverseerImpl.executeCodeMode()`（`overseer.ts:7243`）把 agent 写的代码作为临时 **Dynamic Worker** 加载（`env.LOADER.load`，`globalOutbound: null`，只含该 chat 显式引入的绑定），一次性、隔离。
  - Gadget 作为 Overseer DO 内的 Dynamic Worker **Facet** 运行（`overseer.ts:4069-4079`）。
  - **多 agent**：`AgentSpawnerBinding.spawn(title, prompt)` fire-and-forget；`spawnCallable()` 返回**可存储的 RPC stub**，像可调用的子 Worker，每次调用在 turn 完成时 resolve——最接近「按需调用独立 AI Worker 并拿到返回值」。
  - **Hook** 是异步 / 事件路径（`HookController.enable` / `HookInitiator.startHook`，`gatekeeper.ts:1244-1283`）。
- 可移植洞见：capability 是**不可伪造的 RPC stub**，不是 token 字符串；经 `ctx.restore()` 持久化，不发放 bearer secret。

#### 2.4 权限模型（强制阶梯）

1. 边缘：Cloudflare Access JWT（`access.ts`）+ `router` 路径路由。
2. 后端入口：`AuthenticatedApi / AdminApi` 登录时一次签发。
3. **User DO**：`getGatekeeperClassFor()`（`user.ts:1666`）是**唯一收口点**——资源 URL 在此变成 capability；管理员的 `disabledGatekeepers` 在签发前检查；gadget / agent 代码不可达。
4. **Overseer DO**：`ApprovalQueueImpl / ObservationAuthorizer` 拦每次读写；`AutoApprovalDrainer` 需要**两个独立信号**（gatekeeper 作者标 `autoApprovable: true` **且** 用户为该 `ActionKind.tag` 开启规则），按 id 严格升序、每 gatekeeper 单飞 drain，保证不会跳过人工审批（`auto-approval.ts`）；`SharingManager` 强制 `build / use`；`addObserver()` 对新共享用户重验历史观察。
5. **Gatekeeper Worker**：独立信任域；`mcp-shared/src/tools.ts` 明文注释为信任边界——只有 MCP server 声明 `readOnlyHint: true` 才视为只读，自动应用写操作还需 `vetted` 端点。
6. Dynamic Worker 沙箱：`globalOutbound: null`，env 只含显式引入的绑定。
7. 浏览器：gadget 客户端在沙箱 iframe，CSP + `postMessage`。

凭证：OAuth token 只在各 gatekeeper 包自己的存储里，`workshop-backend` 只持 stub。认证配置（`AUTH_GATEKEEPERS`、`DISABLE_PASSWORD_AUTH`）刻意走 env var 而非管理员可编辑的 `AdminConfig`，防止管理员会话被劫持后放宽登录（REVIEW.md）。HITL：`ActionDescription.awaitDecision` 让不能模拟效果的 gatekeeper 挂起 agent turn 直到人批（`gatekeeper.ts:1129-1200`）；超越单个 `autoApprovable` 布尔值的策略引擎是同文件的 TODO。

#### 2.5 状态与持久化

产品代码里**不用** D1 / Queues / Vectorize / Workflows。三种原语：DO（SQLite）经 `typed-storage`，是内核全部状态的唯一一致性 / 持久化原语，gadget 源码以 git 对象存在 DO 里（`git-store.ts`）；KV 存不可变 / 缓存型 blob；R2 存大对象。每租户隔离 = 一个 Workspace 一个 Overseer DO；gatekeeper 经 `sharingDomain` 命名空间多租户。Context Library（RAG 式集合检索）是纯 DO SQLite，仓库里没有向量索引。

#### 2.6 编排、可观测

无 Workflows / Queues 编排器；DO 状态机式；`do-retry.ts` 处理 DO 重置；定时用 DO alarm（`gatekeeper-scheduler`）；幂等靠严格顺序 drain + 单飞。结构化日志固定字段（`WorkshopObservabilityFields`：`chatId / gatekeeperId / actionId / outcome / durationMs`）、OTel 风格 span；每条审批队列动作是持久可查审计行（`ActionHistoryFilter / ActionLogEntry`）；规则：不记 secret / token / prompt 正文。

#### 2.7 优势与缺口

**借（可移植的概念）**：capability 作为不可伪造句柄而非 ACL / token；Observation / Action 读写分离 + 模拟待审批写不阻塞 agent；双信号自动批准（作者安全判断 × 用户规则）按稳定 `ActionKind` tag；单一收口点而非散落检查；一次性沙箱化计算 + 最小显式 env；`build / use` 两级刻意粗粒度角色。

**缺口**：`overseer.ts` 11k 行 god object（项目自己在 REVIEW.md 标为「kernel bar」）；策略引擎是 TODO（单布尔值，无严重度 / 可逆性分类）；DO hibernation 不支持；裸 `workerd` 自托管「COMING SOON」；整套 capability / facet / dynamic worker 模型是**运行时锁定**——这些 Workers Runtime 特性是为此项目新增的，概念可移植、代码不可移植；不接受外部贡献。

#### 2.8 技术栈

TypeScript；Cap'n Web RPC；`pi-agent-core / pi-ai`；Yjs；isomorphic-git；CodeMirror；Vite；`minimumReleaseAge` 供应链策略；Apache-2.0；early access，内部重度 dogfooding，严格 review 门槛（REVIEW.md）。

---

### 3. pi 0.84.4（`D:\NextTime AI\pi-0.84.4`）

**一句话**：MIT 许可的 TypeScript monorepo（`@earendil-works/pi-*`），三层：provider 无关的 LLM API（`packages/ai`）、有状态 agent 运行时（`packages/agent`）、其上的交互式编码 agent CLI / SDK（`packages/coding-agent`）。设计哲学（`packages/coding-agent/docs/usage.md:307-310`）：「Pi keeps the core small and pushes workflow-specific behavior into extensions, skills, prompt templates, and packages. It intentionally does not include built-in MCP, sub-agents, permission popups, plan mode, to-dos, or background bash.」安全立场（`docs/security.md`）：「Pi does not include a built-in sandbox... Real isolation needs to come from the operating system or a virtualization/container boundary.」——**机制不含策略**的最小内核 + 丰富的类型化扩展面。

**在本设计中的角色**：Worker 的 agent 执行内核（RPC 子进程嵌入）。

#### 3.1 包地图

| 包 | 职责 | 入口 |
|----|------|------|
| `packages/ai` | 统一多 provider LLM API（30+ provider），OAuth，成本 / 用量，流式事件协议 | `src/index.ts` |
| `packages/agent` | 传输无关 agent 运行时：状态机、工具调用循环、steering / follow-up 队列、harness 层 | `src/agent.ts`、`src/agent-loop.ts`、`src/harness/*` |
| `packages/coding-agent` | pi 产品：CLI、TUI、工具（read / bash / edit / write / grep / find / ls / powershell）、会话管理、压缩、扩展、RPC / SDK 模式 | `src/core/*`、`src/modes/*`、`docs/*` |
| `packages/tui` | 自研差分渲染终端 UI | `src/index.ts` |
| `packages/protocol` | 传输中立 CBOR 二进制协议（远程会话） | `README.md` |
| `packages/client` | `PiClient` 远程客户端，会话租约 | `README.md` |
| `packages/server` | **实验性** `PiServer`，应用提供存储 | `README.md` |
| `packages/session-backends/sqlite-node` | SQLite 会话后端 | `package.json` |
| `packages/telemetry` / `evals` | 遥测契约 / eval harness | — |

#### 3.2 领域模型

**Agent**（`AgentState`：systemPrompt / model / thinkingLevel / tools / messages / isStreaming / pendingToolCalls）→ 在 **AgentLoop** 中运行 **Turn**（一次 LLM 调用 + 其工具执行）。**AgentMessage** 泛化 LLM `Message` 并允许应用自定义角色。**AgentTool** = name / label / description / parameters(TypeBox) / `executionMode` / `execute()`。**AgentContext** = `{systemPrompt, messages, tools}`，每次 provider 调用前经 `transformContext → convertToLlm`——**这是压缩 / 剪裁 / 治理注入的接缝**。coding-agent 层：**AgentSession** 包装 Agent + SessionManager + ModelRuntime；**SessionEntry**（message / compaction / branch_summary / custom / label / model_change / thinking_level_change）是持久单元，`parentId` 成树，`leafId` 指当前分支。另有 Skill、PromptTemplate、Provider / Model、Extension。

#### 3.3 Agent loop

`agent_start → turn_start → user message → assistant message（流式 update）→ message_end（屏障点）→ 每个工具：tool_execution_start → 校验参数 → beforeToolCall（可阻断）→ execute()（抛错即 isError 工具结果）→ afterToolCall → tool_execution_end → toolResult → turn_end`。工具执行 `parallel`（默认）或 `sequential`，混合批次降级为 sequential。`shouldStopAfterTurn` 可提前结束。之后先查 steering（当前工具批次结束后打断），再查 follow-up。`agent.abort()` 经 `AbortSignal` 贯穿流式与每个 `execute()`。`continue()` 从现有上下文恢复。

#### 3.4 工具模型

`ToolDefinition / AgentTool`：name、label、TypeBox `parameters`、`executionMode`、`execute(toolCallId, params, signal, onUpdate, ctx)`，流式局部结果。**核心没有内置审批 / 权限闸门**——扩展点（Agent 层 `beforeToolCall / afterToolCall`；扩展层 `tool_call / tool_result` 事件，`src/core/extensions/types.ts:1125-1149`）是应用实现审批 / 阻断 / 参数改写 / 审计的地方。输出截断是约定而非强制（`src/core/tools/truncate.ts`：2000 行 / 50KB）。扩展经 `pi.registerTool()` 注册工具。

#### 3.5 会话持久化

append-only **JSONL**，一会话一文件（`<timestamp>_<sessionId>.jsonl`，`session-manager.ts:954`）。每行 `SessionEntry{type, id, parentId, timestamp, ...}`——**树**而非平面日志。`buildSessionPath()` 沿父指针到根；`buildContextEntries()` 折入最新 `CompactionEntry`；`sessionEntryToContextMessages()` 投影为 `AgentMessage[]`。分支 / fork 创建新 leaf 或新文件；`navigateTree / fork` 暴露给扩展与 RPC。压缩（`src/core/compaction/compaction.ts`）在 `contextTokens > contextWindow - reserveTokens` 时触发，LLM 摘要，跟踪跨压缩的读 / 改文件，可被 `session_before_compact / session_compact` 拦截。恢复 = 重载 JSONL 重建。

#### 3.6 扩展 API

`ExtensionAPI`（`src/core/extensions/types.ts`，约 1800 行），约 30 个生命周期事件：session（`session_start / before_switch / before_fork / before_compact / compact / compact_failed / shutdown / before_tree / tree`）、agent（`before_agent_start / agent_start / end / settled`）、turn / message / tool（`turn_start / end`、`message_*`、`tool_execution_*`）、provider（`before_provider_request / before_provider_headers / after_provider_response`）、按工具类型化的 `tool_call / tool_result`（阻断、原地改参、替换内容）、`context`（LLM 前重写消息）、`input`、`user_bash`、`model_select`、`project_trust`、`resources_discover`。能力：注册工具 / 命令 / 快捷键 / CLI flag / provider（含自定义 OAuth）、消息 / 条目渲染器、完整 TUI 控制、发送消息、追加自定义会话条目、`exec` 子进程。相当于无头 VS Code 扩展宿主。

#### 3.7 Provider 抽象

`packages/ai`：`Context{systemPrompt, messages, tools}` / `Message{role, content, timestamp}` 跨约 25 个 provider；`models.stream()` 产出统一事件联合（`start / text_delta / thinking_delta / toolcall_delta / ...`）；支持会话中途跨 provider 切换、可序列化 `Context`、自定义 `createProvider()`、faux provider 做确定性测试。

#### 3.8 嵌入方式

1. **SDK**：`createAgentSession()` 作为库嵌入 Node 进程（`docs/sdk.md`，13 个渐进示例）。
2. **RPC 模式**：`pi --mode rpc`，stdin / stdout 上的 JSON-lines 命令 / 事件（`src/modes/rpc/rpc-types.ts`：prompt / steer / follow_up / abort / compact / fork / get_tree / ...）——**子进程即 Worker，语言无关**。
3. **Protocol / Client / Server**：实验性 CBOR 协议 + 传输中立 `PiClient`（独占 / 共享会话租约）+ 可组合 `PiServer`；标注 experimental / unstable。

#### 3.9 优势与缺口

**借**：JSONL 父指针会话树（便宜、可审计、可 git diff，分支 / fork / 压缩全从一个结构派生）；`transformContext → convertToLlm` 作为注入治理 / 上下文的标准位置；类型化穷举的扩展事件 ABI 作为平台「capability + hook」契约的范本；进程级子 agent 隔离（每个子 agent 一个 `pi` 子进程，`examples/extensions/subagent`）；CBOR 协议的独占 / 共享会话租约模型。

**缺口**：无 auth / RBAC；无多租户会话所有权；无内置审批（by design）；无沙箱（必须靠容器 / micro-VM）；无跨会话长期记忆（只有会话 JSONL + `AGENTS.md` 等静态文件）；无审计（会话日志之外）；`packages/server` 实验性；无原生 MCP / 子 agent 编排（仅扩展）。

#### 3.10 技术栈

TypeScript（Node ≥ 22.19，erasable-syntax-only）；Bun 编译独立二进制 + npm 分发；Biome；`tsgo`；Vitest；原生 TUI addon（win32 / darwin）；MIT；0.84.4，全包锁步版本；`CHANGELOG.md` 5619 行；pinned deps / shrinkwrap / `min-release-age` 供应链加固。

---

## 第二部分：开源生态调研（2026-09）

> 星数为近似值且波动大；`(unverified)` 表示未能从一手来源核实。**采用任何标注 `(unverified)` 许可的项目前，直接读其 LICENSE 文件。**

### A. Ontology / 语义层 / 领域建模

| 项目 | URL | 许可 | 星数≈ | 活跃度 | 对本设计的意义 |
|------|-----|------|-------|--------|---------------|
| **LinkML** — YAML 优先的 linked-data schema 语言，编译到 JSON Schema / OWL / SHACL / SQL | github.com/linkml/linkml | Apache-2.0 | 数百–数千 (unverified) | 活跃，2026 有发布 | 「一次定义、多目标投影」——本体层同时投影 DB schema / API / 校验的模板 |
| **TypeDB** — 强类型图库，原生实体 / 关系 / 属性类型层级 + 规则推理 | github.com/typedb/typedb | MPL-2.0 | 数千 (unverified) | 活跃 | 唯一让**类型系统本身**强制本体级不变量的 OSS 系统 |
| **Cube** — headless 语义层，metrics over SQL / REST / GraphQL / MCP，内置缓存与访问控制 | github.com/cube-js/cube | MIT | 数万 | 活跃 | 需要 BI 语义层时直接接，不自研 |
| **Malloy** — 语义建模 + 查询语言 | github.com/malloydata/malloy | Apache-2.0 | 数千 (unverified) | 活跃 | 语义模型与物理 schema 分离的紧凑范例 |
| **dbt MetricFlow** | github.com/dbt-labs/metricflow | 混合 (unverified) | 数千 (unverified) | 活跃 | 指标 DSL 与服务层解耦 |
| **Palantir Foundry Ontology**（闭源，仅参考） | palantir.com/docs/foundry/ontology | 专有 | — | — | Objects / Properties / Links（语义）+ Actions / Functions（动能）：本设计 ActionType 概念的直接来源 |

### B. Knowledge Graph + GraphRAG

| 项目 | URL | 许可 | 星数≈ | 活跃度 | 意义 |
|------|-----|------|-------|--------|------|
| **Microsoft GraphRAG** | github.com/microsoft/graphrag | MIT | 数万 (unverified) | v3.1.1（2026-07-18）后**维护模式**，只修 CVE | Leiden 社区 + 分层摘要仍是「全局问答」参考算法 |
| **LightRAG** | github.com/HKUDS/LightRAG | MIT | ~34k | 活跃 | 增量更新成本低，生产 KG-RAG 的实用默认 |
| **nano-graphrag** | github.com/gusye1234/nano-graphrag | MIT (unverified) | 数千 (unverified) | 维护中 | 最小可读参考实现 |
| **Graphiti**（Zep） | github.com/getzep/graphiti | Apache-2.0 | **30.5k**（已核实） | 活跃 | 每条边显式 valid-time + ingestion-time——双时态 / 溯源边的最佳 OSS 参考 |
| **neo4j-graphrag-python** | github.com/neo4j/neo4j-graphrag-python | Apache-2.0 | 数千 (unverified) | 活跃 | 属性图上的 hybrid 检索模式 |
| **Cognee** | github.com/topoteretes/cognee | Apache-2.0 | ~29.7k | 活跃 | ECL（extract-cognify-load）流水线，带本体支持 |
| **LlamaIndex PropertyGraphIndex** | github.com/run-llama/llama_index | MIT | （包含于 llama_index） | 活跃 | 可组合 KG extractor + 多 retriever |

图库后端：FalkorDB（SSPL v1）、Memgraph（BSL-1.1）、Apache AGE（Apache-2.0，Cypher-on-Postgres，~4.8k）、NebulaGraph（Apache-2.0 核心，分布式，~12.3k）、Oxigraph（Apache-2.0 / MIT，嵌入式 RDF / SPARQL，~1.8k）、Kùzu → LadybugDB（见 Q2）。

### C. Context Graph / Agent Memory / 决策轨迹

| 项目 | URL | 许可 | 星数≈ | 活跃度 | 意义 |
|------|-----|------|-------|--------|------|
| **Graphiti** | 同上 | Apache-2.0 | 30.5k | 活跃 | README 自称「temporal context graphs for AI agents」 |
| **Mem0** | github.com/mem0ai/mem0 | Apache-2.0 | **64.5k**（已核实） | 活跃 | memory-as-a-service API 与存储解耦 |
| **Letta (MemGPT)** | github.com/letta-ai/letta | Apache-2.0 | ~23–24k | 活跃 | 记忆作为显式分页状态机（core / archival / recall），最贴近「受治理状态转移」 |
| **OpenLineage** | github.com/OpenLineage/OpenLineage | Apache-2.0 | 数千 (unverified) | 活跃 | Job / Run / Dataset facet 事件规范——把决策轨迹记成生产者 / 消费者事实的模板 |
| **Marquez** | github.com/MarquezProject/marquez | Apache-2.0 | 数千 (unverified) | 2023 后放缓 | OpenLineage 参考实现 |
| **DataHub** | github.com/datahub-project/datahub | Apache-2.0 | 数万 (unverified) | 活跃 | Dataset / Dashboard / Pipeline / Owner / Term 实体模型是 Context Graph 节点类型模板；2026 有 MCP「Agent Context Kit」 |
| **W3C PROV-O** | w3.org/TR/prov-o | W3C Rec.（2013-04-30） | — | 仍是标准 | 溯源词表；不要自造 |

### D. Code Graph

| 项目 | URL | 许可 | 星数≈ | 活跃度 | 意义 |
|------|-----|------|-------|--------|------|
| **Joern** — Code Property Graph（AST + CFG + PDG） | github.com/joernio/joern | Apache-2.0 | ~3.4k+ (unverified) | 活跃 | 最严谨的开源代码图形式化，适合安全 / 审计角度 |
| **Sourcegraph SCIP** — 语言无关代码智能索引协议 | github.com/sourcegraph/scip | Apache-2.0 | 数千 (unverified) | 活跃，2026 成立 Steering Committee（Uber / Meta） | 标准符号 / 引用 schema，避免每语言重造 |
| **CodeQL** | github.com/github/codeql | **非 OSI**：OSS / 研究免费，商用受限 | 数万 (unverified) | 活跃 | Datalog 查询范式强，但许可阻止商用嵌入 |
| **Meta Glean** | github.com/facebookincubator/Glean | 需直接确认 (unverified) | 数千 (unverified) | 活跃 | 类型化「facts」（Angle 查询）而非原始图 |
| **code-graph-rag** | github.com/vitali87/code-graph-rag | (unverified) | ~2.7k | 活跃 | tree-sitter → Memgraph → NL 查询 / MCP，与目标最近的架构模板 |
| **Serena** — LSP 驱动的语义编码工具 / MCP server | github.com/oraios/serena | MIT (unverified) | ~24k | v1.5.1（2026-05-18） | 真实 language server 的符号解析，补充 tree-sitter 图 |
| **Aider repo-map** | github.com/Aider-AI/aider | Apache-2.0 | ~43k | 活跃 | tree-sitter + PageRank 排序，无 DB 的 token 预算内相关代码选择 |

**本设计的取舍**：本机已有 `codegraph` MCP 工具（SQLite 索引），主文档 §7.1 / §8.3 选择联邦它，而非引入上述任何新 indexer。

### E. Graph Engineering / 编排 / 持久执行 / 协议

| 项目 | URL | 许可 | 星数≈ | 活跃度 | 意义 |
|------|-----|------|-------|--------|------|
| **LangGraph** | github.com/langchain-ai/langgraph | MIT | **40.9k**（已核实） | 活跃 | 图即代码（nodes / edges / conditional edges）+ checkpoint + HITL，最接近「Graph Engineering」层本身 |
| **Temporal** | github.com/temporalio/temporal | MIT | 数万 (unverified) | 活跃 | 事件溯源 workflow history 的成熟先例 |
| **DBOS** | github.com/dbos-inc/dbos-transact-{python,ts} | MIT | ~1.2–1.3k | 活跃 | Postgres 内的持久执行库，无独立编排服务——与本设计「Postgres 唯一 SoR」契合 |
| **Restate** | github.com/restatedev/restate | (unverified) | 数千 (unverified) | 活跃 | virtual object 抽象 ≈ 有状态 agent 节点 |
| **MCP** | github.com/modelcontextprotocol | MIT（SDK） | — | **规范 2026-07-28**：stateless core、多轮请求、header 路由、可缓存 list、认证加固、扩展框架 | 工具互操作层，基础设施 |
| **A2A** | github.com/a2aproject/A2A | Apache-2.0 | — | **v1.0（2026-04-09）**，Linux Foundation，150+ 组织 | 跨 agent / 跨厂商任务委派信封 |
| **Google ADK** | github.com/google/adk-python | Apache-2.0 | 数千 (unverified) | v2.0 alpha（2026） | 图为原生执行原语，原生 A2A |
| **n8n / Dify** | github.com/n8n-io/n8n · github.com/langgenius/dify | n8n：Sustainable Use（**非 OSI**）；Dify：Apache-2.0 + 商用多租户限制 | n8n ~198.7k；Dify ~100–139k（来源冲突） | 活跃 | 集成目录庞大，但许可限制转售 / SaaS 嵌入 |

### F. Agent 治理 / 策略 / 审计

| 项目 | URL | 许可 | 星数≈ | 活跃度 | 意义 |
|------|-----|------|-------|--------|------|
| **OPA** | github.com/open-policy-agent/opa | Apache-2.0 | 数万 (unverified) | 活跃（CNCF graduated） | policy-as-code，可作本设计 policy 模块的可选引擎 |
| **Cedar** | github.com/cedar-policy/cedar | Apache-2.0 | **1.7k**（已核实） | 活跃 | 可形式化验证的授权策略语言 |
| **OpenFGA** | github.com/openfga/openfga | Apache-2.0 | 数千 (unverified) | 活跃（CNCF incubating） | Zanzibar 式 ReBAC——元组即图边，与图中台同构 |
| **SpiceDB** | github.com/authzed/spicedb | Apache-2.0 | 数千 (unverified) | 活跃 | 同上，超大规模验证，Watch API |
| **Casbin** | github.com/casbin/casbin | Apache-2.0 | 数万 (unverified) | 活跃 | 嵌入式多模型授权库 |
| **agentgateway**（Solo.io） | github.com/agentgateway/agentgateway | (unverified) | 数千 (unverified) | 活跃 | MCP / A2A 流量的 AI 原生代理 |
| **Obot** | github.com/obot-platform/obot | MIT | (unverified) | 活跃 | MCP gateway + catalog + hosting + chat 打包 |
| **NVIDIA NeMo Guardrails** | github.com/NVIDIA/NeMo-Guardrails | Apache-2.0 | ~6.5k | 活跃 | execution rail 概念 ≈ 工具调用前后闸门 |

### Q1. 「五类图」框架的出处？

未找到把这五类合在一起的单一 2025–2026 公开来源。两个相邻但不同的「五图」说法：(1) Jason Stanley 在 HackerNoon 的《Context Graphs, Ontologies, and the Race to Fix Enterprise AI》主张 agent 需要 **Access / Security / Context / Action / Knowledge** 五图——治理导向，与本框架不同；(2) agent / 决策轨迹意义上的「Context Graph」由 **Foundation Capital 的 Jaya Gupta 与 Ashu Garg** 在《Context Graphs: AI's Trillion-Dollar Opportunity》（2025-12-23）提出。Code graph（Joern / CPG、Glean）与 graph-as-orchestration（LangGraph）各是独立社区。结论：**把五类图当作你自己的工作分类法，而不是行业标准术语**——这也是主文档 §4 把它重新映射为三模型的原因。

### Q2. 2026 年可自托管的开源图数据库与许可

- **服务型、copyleft / source-available**：Neo4j Community（GPLv3；Enterprise 闭源）、Memgraph（BSL-1.1，延时转 Apache）、FalkorDB（SSPL v1，非 OSI，限制托管转售）。
- **服务型、真宽松**：Apache AGE（Apache-2.0，Cypher-on-Postgres——Postgres 已是 SoR 时最契合；**但需核对其对当前 PG 大版本的支持，本次未核实**）、NebulaGraph（Apache-2.0 核心，分布式）。
- **嵌入式**：Kùzu 2025-10 被原团队归档（团队据 EU 文件被 Apple 收购 (unverified)），社区分支 **LadybugDB**（宽松许可，首发约 2025-11-05）是活跃继任者；Oxigraph（Apache-2.0 / MIT，嵌入式 SPARQL / RDF，需要真 OWL 语义时选它）；DuckPGQ（SQL:2023 SQL/PGQ 的 DuckDB 扩展）仍是研究级。
- **对本设计的读法**：主存用 Postgres（主文档 §9.1 选项 A），升级路径 Apache AGE（选项 B）；嵌入式引擎用于导出 PROV-O 或随仓库 / 会话走的本地索引；Neo4j / Memgraph / FalkorDB 可用但需许可签核。

### 核实说明

- **已从一手来源核实**（本会话直接抓取 GitHub 仓库页或官方规范页）：LangGraph（40.9k，MIT）、Graphiti（30.5k，Apache-2.0）、Mem0（64.5k，Apache-2.0）、Cedar（1.7k，Apache-2.0）、Neo4j Community 许可（GPLv3）、MCP 规范版本（2026-07-28）、PROV-O（W3C Rec. 2013-04-30）。
- **来自可信二手 / 媒体来源，未直接抓取仓库**：Microsoft GraphRAG 维护模式与 v3.1.1 日期；LightRAG；Kùzu 归档与 LadybugDB 时间线；A2A v1.0；Foundation Capital 文章作者与日期；AGE / NebulaGraph / Oxigraph 星数；n8n / Dify 许可；Cognee、Letta、Serena、Aider 数据。
- 表中 `(unverified)`：来源冲突、LICENSE 未直接确认（Glean、code-graph-rag、Restate、agentgateway、Obot）、或星数无法锚定到单一时间戳。

---

## 第三部分：面向 v0.2 MVP 形态的第二轮源码研究（2026-09-01）

> 问题：Web 入口 + 每用户一个常驻 pi agent + 动态 Worker 经门对接系统。三个项目里直接决定这个形态的部分。

### 1. pi：服务端托管多用户会话的三种方式

| 方式 | 隔离 | Web 接入 | 认证 / 租约 | 稳定性 | 结论 |
|------|------|---------|------------|--------|------|
| A 进程内 `createAgentSession` 每用户一个 | 只有逻辑隔离：同进程、同 OS 用户、同文件系统；内置 bash / edit / write 以宿主 UID 运行；`DefaultResourceLoader` 沿 `cwd` 向上自动加载 `.pi/extensions/*.ts`（`docs/sdk.md:344-350`），不覆盖即任意代码执行 | `session.subscribe(listener)` 自行桥接 WS | 无 | 文档化但非 semver 稳定 | 后期优化，不用于 MVP |
| **B 每用户一个 `pi --mode rpc` 子进程** | 真进程隔离；`PI_CODING_AGENT_DIR`（`src/config.ts:503-505`）与 `--session-dir` 按用户分目录；可独立 OS 用户 / cgroup | 宿主转发 stdout 的 JSONL 事件（`message_update` / `tool_execution_*` / `bash_execution_update`，`docs/rpc.md:855-1055`） | 宿主管理 | RPC 协议有文档、有版本 | **MVP 采用** |
| C `packages/server` PiServer + PiClient | 自标实验性（`packages/server/README.md:3`）；到 coding-agent 零桥接（grep `PiSessionRuntime` 零命中）；只有 Unix socket 监听器；`openSession(sessionId)` 无调用者身份，任何连接报 sessionId 即可附着（`sessions.ts:66-74`）；租约只在客户端本地（`client.ts:56-58`），服务端 `locked: true` 硬编码 | 需自写 WS 监听与认证 | 无 | 实验性 | 不用 |

每用户定制：`--system-prompt` / `--append-system-prompt`（`src/cli/args.ts:110-112`）；`-e 扩展`（`args.ts:166`）注册工具并从 env 读 Handle；`--tools` 白名单；`context` 事件在每次 LLM 调用前注入且不持久化（`docs/extensions.md:675-685`），`before_agent_start` 持久化注入。子 Worker：`examples/extensions/subagent/index.ts:346-350` 用 `child_process.spawn` 拉起 `pi --mode json -p --no-session …`，NDJSON 读回结果，可不同工具集 / cwd / 模型；**默认继承父进程 env**，Handle 必须显式注入、父 env 不能含密钥。pi 不提供：认证、多租户存储、Web UI、审批 UI（RPC 有 `extension_ui_request/response` 子协议，`docs/rpc.md:1184-1375`）。

### 2. cloudflare-os：Web 聊天 → 每用户 agent → 门与审批

- **一轮请求路径**：`workshop-frontend/src/main.tsx` 一个 `newWebSocketRpcSession`（Cap'n Web）；`ChatInterface.tsx` 调 `overseer.sendChatMessage(chatId, message, modelId, capsules, attachments, formats)`；`overseer.ts:5344` `assertChatNotActive` → 落用户消息 → `startAgent` → `agent.ts` 用 `runAgentLoopContinue`（pi-agent-core）；两段式 system prompt（`agent.ts:2061-2203`）；工具 `executeCode`（`agent.ts:2722`）里调用门的写方法 → `submitAction`（`overseer.ts:4666`）→ `ActionRecord(pending)` → 自动批准则 `AutoApprovalDrainer.drain()`；`approveAction`（`overseer.ts:9479`）→ `applyPendingAction`（`overseer.ts:4281`）→ `#maybeResumeAfterActionDecision`（`overseer.ts:9578`）恢复挂起的 turn；流事件经 `AiChatSubscriber.stream`（`api.ts:3255+`：`textDelta` / `toolCallStarted` / `toolCodeDelta` / …）。
- **聊天 RPC 面**（`api.ts:1598` 起）：`listChats / newChat / sendChatMessage / stopAgent / retryAgent / getChatHistory / subscribeToChat / listActions / approveAction / rejectAction / subscribeToActions / setAutoApprovedActionKind / listAutoApprovedActionKinds / acceptConnectionRequest / denyConnectionRequest / newGatekeeper / listHooks …`。**没有 `steer`**：turn 进行中再发消息被拒，只能 `stopAgent`。**先订阅再翻页**避免丢事件。
- **审批 UX**：`ActionLogEntry{id, gatekeeperId, resourceTitle, state, description: ActionDescription{title, description(Markdown), implementsRevert, awaitDecision?, autoApprovable?, actionKind?{tag,label}}}`（`gatekeeper.ts:1129`）。没有 `simulatedEffect` 字段；`awaitDecision=true` 表示门不模拟效果，turn 挂起、卡片阻塞样式，所有 awaited 动作批准后才恢复；否则 agent 基于模拟状态继续。「总是批准此类」按 `actionKind.tag` 落到连接级规则。
- **工具集组成**：每 chat 一个 `chatBindings` 映射，工具含 `executeCode / describeBinding / requestConnection / createGadget / webFetch …`；被 spawn 的 agent 只有 `describeBinding + executeCode`。用户以「capsule」把系统授予 chat（`overseer.newGatekeeper(accountId, url)`），或 agent 用 `requestConnection` 发起、用户接受。
- **多 agent**：`AgentSpawnerBinding.spawn` 即发即忘；`spawnCallable` 返回可调用 stub，promise 在子 agent turn 结束时 resolve。
- **可移植**：RPC 面形状、`AiChatMessageBody` 日志 schema、`ActionDescription` 审批 schema、`AutoApprovalDrainer`（纯函数，Postgres 行 + 每门互斥即可）、`awaitDecision` 挂起状态机、先订阅再翻页。**替代**：DO → Postgres 行 + 每工作区 advisory lock；Cap'n Web → JSON-RPC over `ws`；`openSession() → RpcStub` → 服务端函数网关；`spawnCallable` stub → 任务表 + 相关 id 的完成事件；DO 事务 → Postgres 事务。

### 3. Semantica：Explorer、REST 契约、MCP、skills

- **Explorer**：React 19 + Vite 6 + TS，sigma / graphology、@xyflow/react、react-query；构建输出到 `semantica/static`，dev 代理 `/api` 与 `/ws`；**不 import 任何 Semantica 内部**，只依赖 HTTP 契约与 `X-API-Key`。Graph 工作区：`GET /api/graph/nodes?limit&cursor`、`GET /api/graph/edges`、`POST /api/graph/search`、`GET /api/temporal/bounds`、`GET /api/temporal/snapshot?at=`、`GET /api/provenance/report`；Decision：`GET /api/decisions`、`GET /api/decisions/{id}/chain`（含 `207` 部分成功约定）；Lineage：`GET /api/provenance?node_id=` → React Flow 节点 / 边；Ontology：约 30 个端点、路由 3540 行（不承诺）。服务端难点是 `GraphSession` 式 facade（分页游标、图算法）而非前端。
- **MCP 17 工具**：`add_entity(id)`、`add_relationship(source, target)`、`search_graph(query)`、`get_graph_summary`、`get_graph_analytics`、`record_decision(category, scenario, reasoning, outcome, confidence)`、`query_decisions`、`find_precedents(scenario)`、`get_causal_chain(decision_id)`、`analyze_decision_impact(decision_id)`、`extract_entities(text)`、`extract_relations(text)`、`extract_all(text)`、`run_reasoning(facts, rules)`、`abductive_reasoning(observations)`、`export_graph`、`get_provenance(entity_id)`。
- **skills**：`plugins/skills/decision` 与 `query` 是直接 `import semantica.context / semantica.query` 的 Python 脚本，不调 MCP、REST 或 CLI；插件清单没有 MCP 绑定。**换端点不能复用**，只能借子命令与输出格式。
- **字段**：`Decision`：`decision_id, category, scenario, reasoning, outcome, confidence, timestamp, decision_maker, reasoning_embedding, node2vec_embedding, valid_from, valid_until, metadata`。`ProvenanceEntry`（PROV-O）：`entity_id, entity_type, activity_id, agent_id, agent_type, is_automated, role, source_document, source_location, source_quote, timestamp, first_seen, last_updated, confidence, checksum, sequence_id, previous_checksum, parent_entity_id, used_entities, previous_version_id, derived_from_id, activity_started_at_time, activity_ended_at_time, acted_on_behalf_of, informed_by_activities, valid_from, valid_until, revision_type, supersedes, bundle_id, invalidated, invalidated_at_time, invalidated_by, invalidation_reason, start_index, end_index, credibility, metadata, version`。本平台 schema 采用这两组字段名的超集。
