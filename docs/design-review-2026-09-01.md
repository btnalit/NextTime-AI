# 设计复盘 —— 对照原始需求（2026-09-01）

> 目的：把 v0.1 设计放回最初的需求里检验，记录哪些判断成立、哪些偏离了、由此改了什么。设计文档描述目标态，本文描述差量。
> 配套：`graph-ai-middle-platform-design.md`、`development-tasks.md`。

---

## 1. 原始需求（原文）

> 基于 Graph 的 AI 中台，我想你帮忙设计一下，我找到了三个项目：`semantica-0.6.7` 是我觉得概念非常好的形式；`cloudflare-os-main` 模块化，分权，随时调用独立的 AI Workers；`pi-0.84.4` 这个 pi 我是非常喜欢的 AI agent。你也可以帮我看看那些相应好的开源项目参考一下。

外加「五类图」（Ontology / Knowledge Graph / Context Graph / Code Graph / Graph Engineering）的框架，以及后续补充的约束：Python 内核；第一领域是目标主机上的业务；部署在该主机；开源、暂不商用；不与 Hermes 强绑定；LLM 全部外部、厂商中立、**能利用的就不要重复造车**。

拆成六个可检验的要求：

| # | 要求 | 检验问题 |
|---|------|---------|
| Q1 | 基于 Graph 的中台 | 图是领域模型的形状，还是只是一个图数据库？多个消费者能否共享同一份状态与治理？ |
| Q2 | Semantica 的「形式」 | 它的一等概念（Decision / Conflict / Provenance / 双时态 / 本体治理）和体验层（Explorer / MCP 工具 / 多运行时 plugins）有没有对应物？ |
| Q3 | cloudflare-os 的模块化、分权、随时调用独立 Worker | 三个词各自落在哪个机制上？「随时调用」是不是一个一等能力？ |
| Q4 | pi 是最喜欢的 agent | pi 只是被当作执行内核，还是用户日常用的 pi 本身也成为平台的一部分？ |
| Q5 | 开源参考 | 有没有交付可核实的参考清单？ |
| Q6 | 不重复造车 | 哪些地方自建了本可复用的东西？哪些地方复用了不该复用的东西？ |

---

## 2. 总体评价

方向成立，骨架正确，三处偏离：

- **Q2 偏离**：Semantica 只借了词汇，体验层没有对应物，且「不 fork 代码」的理由当时没有给出证据。现在补了证据（§3.2），结论不变，但补上了对其 MCP 工具与 plugin 生态的兼容。
- **Q3 偏离**：「随时调用独立 AI Worker」被拆成 Task / WorkerRun 状态机，没有一等的调用能力，WorkerDefinition 也没有生命周期。已补。
- **Q4 偏离**：pi 只被当作容器里的执行内核，用户日常交互用的 pi 不在设计里。已补。

Q1、Q5 成立；Q6 在 LLM 层曾经偏离（先绑 Anthropic），已按你的纠正改为复用 pi-ai 与 OpenAI SDK。

---

## 3. 逐项对照

### 3.1 Q1 基于 Graph 的中台 —— 成立

- 「基于 Graph」被定义为领域模型的形状（带类型对象 + 带类型有向关系 + 双时态 + 逐边溯源），不是图数据库指令；Postgres 是唯一真源，图库是可后加的投影。这与你「不要因为理论优雅引入基础设施」的偏好一致。
- 五类图收敛为一个 Domain Model 的三种视图（World / Epistemic / Governance），避免了五个子系统。
- 「中台」的多消费者语义落在同一个 gateway：human 通道与 Handle 通道，Claude Code / Codex / pi / Hermes 共享同一份 Context Graph 与同一套策略（G3）。

### 3.2 Q2 Semantica 的形式 —— 概念成立，实现不可作内核，体验层需补

**借到的概念**：Decision / Conflict / ProvenanceEntry（PROV-O）/ BiTemporalFact 作为一等对象；`state_at(t)`；一个 facade 多后端的存储抽象；把 `confidence` float 升级为受治理的 `epistemic_status`。

**为什么不把 Semantica 直接当内核**（本轮补的证据，来自源码）：

- `pyproject.toml` 的 `[project].dependencies` 有 **43 个强制依赖**，含 `torch`、`transformers`、`spacy`、`sentence-transformers`、`opencv-python`、`librosa`、`faiss-cpu`、`gensim`、`umap-learn`、`matplotlib`、`plotly`、`ipywidgets`。内核进程内嵌它 = 内核镜像背上数 GB 的 ML 与可视化栈。
- `semantica/context/context_graph.py`（5466 行）的 ContextGraph 是内存 / 文件优先的结构（含 markdown 目录持久化），不是 Postgres 上受治理的存储。
- `semantica/context`、`semantica/kg`、`semantica/graph_store` 三个包里 `workspace` / `tenant` 合计只出现 1 次，没有租户概念；补租户边界需要改它的模型，而不是配置。

结论：**概念形式复用，实现作为 P3 的独立抽取 Worker（只持 `ingest` Handle，经内核写入）**，这一判断保留。

**当时漏掉的体验层**，本轮补法：

| Semantica 体验层 | v0.1 对应物 | 本轮修订 |
|-----------------|------------|---------|
| 17 个 MCP 工具（decisions / graph / extraction / reasoning / export） | 内核 MCP 只有自己的 capability 名 | epistemic 组同时暴露 Semantica 的工具名与必填参数（已对照 `mcp/schemas.py` 核实：`record_decision(category, scenario, reasoning, outcome, confidence)`、`query_decisions`、`find_precedents(scenario)`、`get_causal_chain(decision_id, direction, max_depth)`、`analyze_decision_impact(decision_id)`、`get_provenance(entity_id)`），差异仅两点：`decision_maker` 由认证 Principal 决定；Decision 以 `proposed` 入库。目的：Semantica 已有的面向 Claude Code / Codex / Cursor / Windsurf 的 skills 只换端点即可复用 —— 这是真正的「不重复造车」 |
| Explorer（Graph / Ontology / Decision / Lineage / DiffMerge 工作区） | P1 只有审批队列 / 冲突 / explain 的表格页 | 记入设计 §17：P3 做一次 spike，看其前端能否经适配层读本平台 API；不承诺 |
| 从数据推断本体（`OntologyEngine` 的 inferrer / LLM generator） | 本体只能人工 YAML | OntologyVersion 的 `draft` 允许由 Worker / 摄取经 `propose_ontology_change` 提议，`publish` 仍只能 human 通道（设计 §5.5、§9.3） |
| 推理（Rete / Datalog / SPARQL / abductive） | 无 | 不在 MVP；P3 随 Semantica 一起评估，作为 `search` / `explain` 的另一实现 |

### 3.3 Q3 cloudflare-os 的模块化、分权、随时调用 —— 前两者成立，第三者补上

| 词 | 落点 | 状态 |
|----|------|------|
| 模块化 | 内核 = 模块化单体（§7.1 每模块拥有自己的状态）；Gatekeeper = 独立部署单元；Worker = 独立失效域 | 成立 |
| 分权 | Observation / Action 读写分离；ActionRequest 状态机；双信号自动批准；单一收口点；human 通道与 Handle 通道分离且 Handle 永不能审批；凭证只在 Gatekeeper | 成立 |
| 随时调用独立 AI Worker | v0.1 只有 `create_task` + Task 状态机，没有「像调函数一样调一个 Worker 拿结果」的能力；WorkerDefinition 只是镜像里的 YAML | **补**：`invoke_worker(definition@version, input, wait, timeout) → result | task_id` 成为一等 capability；WorkerDefinition 入库、有版本与生命周期（cloudflare-os 的 Blueprint 类比）；Worker 调用它时子 Handle 是自身 Handle 的衰减，子 WorkerRun 记 `parent_worker_run_id`，审计链父子可追溯（设计 §5.1.4、§5.5、§9.2、§9.3；任务 T1.12） |

cloudflare-os 的 `spawnCallable()`（返回可存储的 RPC stub）在 workerd 之外没有等价物，`invoke_worker` + 衰减 Handle 是自托管栈上最接近的表达。

### 3.4 Q4 pi —— 执行内核成立，日常客户端补上

- 成立：pi 以 RPC 子进程嵌入，平台扩展只依赖文档化事件，`transformContext` 接缝注入上下文，JSONL 会话树回流为 Source；LLM 层复用 pi-ai 的多 provider 实现。
- **补**：同一个平台扩展装进你本机 pi 的 `~/.pi/agent/extensions/`，配一个 human 通道签发的 Handle，交互式 pi 就拥有与 Worker 相同的 capability 工具与 Context Graph 上下文注入（默认不回传会话）。这是「非常喜欢的 agent」在平台里最直接的位置，也是 G3 对 pi 的落点（设计 §7.2；任务 T2.3 的交互模式）。

### 3.5 Q5 开源参考 —— 成立

`reference-projects-and-oss-landscape.md` 第二部分：六大类、约 40 个项目，许可与活跃度标注，未核实项显式标注 `(unverified)`。

### 3.6 Q6 不重复造车 —— 一处已纠正，一处本轮纠正

- 已纠正：LLM 层从「绑 Anthropic + 自写透传」改为「内核 OpenAI SDK + Worker 复用 pi-ai + 内核只按 provider 透传」。
- 本轮纠正：MCP 工具名与 Semantica 兼容，复用其 plugin 生态（§3.2）。
- 未变且有证据：内核图基底自建（§3.2 的依赖与租户证据）；Gatekeeper 协议自定（cloudflare-os 的机制锁死在 workerd）。

---

## 4. 执行节奏的反思

v0.1 到第一个端到端闭环要 29 个任务。任务清单本轮增加「推荐执行顺序（垂直切片）」：S1 观察链（采集 → 图 → Claude Code / pi 经 MCP 读图与 explain）、S2 治理链（发起 docker 动作 → 审批 → 执行 → 审计重建）、S3 Worker 链（`invoke_worker` → pi Worker → 外部 LLM → 会话回流），其余任务作为补厚。S1 完成即可让你日常的 pi / Claude Code 通过同一个 gateway 看见目标主机的服务与依赖图。

---

## 5. 本轮四项决策的落点

| 决策 | 落点 |
|------|------|
| 环境整改不做 | 任务 E5 / E6 标为「已决定不做」，编号保留；E7（平台自身备份）按你的答复暂不做，但设计 §10.4 的回滚依赖它，建议 P2 后重新评估 |
| TLS 新起 caddy | 设计 §11.2、任务 E8：新增 `caddy` 容器，不复用主机 nginx |
| 采集器纳入自行拉起的非 systemd 子进程 | 本体 v1 增加 `Process` 与 `spawned_by`；采集器新增进程树数据源；**命令行在形成 Observation 之前脱敏，`environ` 完全不读**（任务 T0.9 的验收与「不做」） |
| MIT | 仓库根目录 `LICENSE`；README |

---

## 6. 重心校验（2026-09-01 补）

你在复盘后重申：**重心不能偏移——Graph 的 AI 中台，模块化，分权，随时调用独立的 AI Workers，pi 是 agent 运行底层**。对照：

| 重心 | 设计中的承载 | 本轮补强 |
|------|-------------|---------|
| Graph 的 AI 中台 | 一份带类型、双时态、逐边溯源的共享图 = 所有 agent 的记忆 + 控制面；同一 gateway 服务 human / Handle 两类通道 | §1 增加「设计重心」段；§4 把 Graph Engineering 展开为四部分并加「执行本身也是图」原则 |
| 模块化 | 内核模块化单体、Gatekeeper 独立部署、Worker 独立失效域 | 无变化 |
| 分权 | 读写分离、capability、双信号自动批准、审批只走 human 通道、凭证只在 Gatekeeper | 无变化 |
| 随时调用独立的 AI Worker | `invoke_worker` 一等能力；WorkerDefinition 版本化注册表；子 Handle 衰减；父子审计链 | 本轮新增（§3.3） |
| pi 是运行底层 | Worker 内 pi RPC 子进程 + 平台扩展；交互式 pi 作为客户端；LLM 协议复用 pi-ai | 本轮新增交互式客户端（§3.4） |

容易被误读为重心的两样东西，明确降级为手段：目标主机的运维资产只是第一份数据集；Semantica MCP 工具兼容只是复用其 skills 生态。

## 7. 未变的判断（避免反复）

- Postgres 唯一真源，图库只作投影。
- 内核 Python，模块化单体，不拆微服务。
- Semantica 是 P3 的抽取 Worker，不是内核。
- cloudflare-os 借概念不借代码。
- 治理靠系统边界（DB 约束、网络、gateway 收口），不靠 prompt。
- 公开仓库不含任何环境具体值。
