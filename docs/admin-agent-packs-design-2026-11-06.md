# 管理员智能体看见能力包、提议安装能力包（S11 AA5g 设计）

> 状态：协调 2026-11-06 已批 D1–D4，D5 推迟；按 AA5g-1 → AA5g-2 → AA5g-3 实现（§9）。
> 起因：维护者 2026-11-06 在主机 v0.63.0 的试验工作区让管理员智能体「看看能力包是不是有两个未安装，
> 在两个工作区里装上」。智能体如实回答它看不见能力包、没有安装这条路，且提案目标只剩一个工作区。
> 上位文档：`goal-orchestration-and-admin-agent-plan-2026-10-16.md` §3、§5.4（一个核心，两种来源）、I-A2 / I-A4 / I-A7 / I-A8，
> `s10-evolution-plan-2026-10-04.md` §6（Pack Contract v1）。

## 1. 三个缺口，逐条核实（Current Reality）

| # | 智能体说的 | 核实结论 | 依据 |
|---|---|---|---|
| 1 | 看不见「能力包」，也没有「安装」动作 | **属实，是产品缺口。** 能力包的读写全在 `modules` 组：`list_packs`（human，member）、`preview_pack_install` / `install_pack`（human，owner，`actsForPerson`）。管理员智能体的上限（`ADMIN_AGENT_CEILING_CAPABILITY_NAMES`）一个都没有，`modules` 组也不在 `ADMIN_AGENT_CEILING_GROUPS` 里。管理员提案的工作区段只有四种意图（`skill_version` / `worker_definition_version` / `ontology_version` / `operation_version`），没有「装某个包」。 | `kernel/src/governance/capability/handles.ts`、`shared/src/capabilities.ts` 的 `list_packs` 等、`shared/src/wire/admin-proposal.ts` |
| 2 | 目标只剩一个；审计里 `set_admin_agent_targets` 17:05–17:08 改了三次，记录方「本管理员 / self」 | **不是缺陷，归属正确。** `platform_state_audit` 的 `actor: 'self'` 意思是「这个智能体所属的管理员本人」（`actorOf`：`actorUserId === selfUserId`），不是智能体。`set_admin_agent_targets` 是 human 通道、平台面的能力，不在管理员智能体上限里，智能体调不到；三行都是维护者本人在控制台「管理员智能体 → 选择目标工作区」里保存的（时间与维护者 11-06 17:02Z 起做控制台核对吻合）。每行审计带 `added` / `removed`，维护者在「平台 · 审计」按动作筛 `set_admin_agent_targets` 就能看到第二个工作区是哪一次去掉的，或者从来没加过。顺带：目标对话框按「整张列表替换」保存，若在保存后状态还没刷新时又打开对话框再保存，会用旧列表覆盖（窗口只有一次请求的时长，三次保存间隔 26 秒和 2.5 分钟，不像是这个原因；协调定为遗留 648，P3，控制台，修法：版本号 / ETag 或改成增量 add / remove）。 | `kernel/src/application/admin-agent/platform-state.ts` `actorOf`、`targets.ts`、`web/.../AdminAgentTargetsDialog.tsx` |
| 3 | 读不到目标工作区的内容 | **按设计如此，不改。** F5 与协调 2026-11-02 的决定：提案的意图与工作区无关，由目标工作区自己的干跑解析；智能体只读得到段的状态。平台面也没有读工作区内容的 RLS 策略（skill / worker / ontology 版本表都没有 `*_platform_admin` 策略）。给智能体开跨工作区的内容读，等于在平台面开一个所有工作区都没有的口子。能力包场景真正需要的只是「目标装没装、装的哪版」，见 §4 D5，推迟。 | 0032 / 0033 迁移头注释、`admin-proposal-segments.ts` 模块注释 |

缺口 2 的措辞问题：`platform_state_audit` 的描述只说 "whether this administrator, another administrator or nobody recorded made it"，模型把 `self` 译成「本管理员 / self」后又推断「可能是我自己的改动」。

#484 复核补正：`actorOf` 只比 user id（`platform-state.ts`）。智能体自己在平台面写的审计行，`actor_user_id` 也是管理员本人，只是 payload 里带 `channel: 'handle'`（`platform-state.ts` 131–145 行）。今天这些行没有混进 `self`，只是因为智能体在平台面只有读，读被 `READ_ACTIONS` 滤掉了。这不是结构上的保证。所以描述照实写：

> `self` = 你的管理员账号做的：管理员本人在控制台做的，以及经由你在平台面做的写（也记在管理员账号下）；今天你在平台面能做的都是读，这里不列；你改不了自己的目标。

按 `channel` 拆出「你自己」作为结构保证，等智能体第一次有平台面写动作时再做。

## 2. 领域模型（只列本次涉及的）

| 概念 | 是什么 | 一等 / 派生 | 归属与权威 |
|---|---|---|---|
| Pack / PackVersion | 部署自带（镜像 `packs/`）或附加（`EXTRA_PACKS_DIR`）的一组组件（本体族、Skill、Worker），不可变版本 | 一等，存在文件里，不入库 | 部署（维护者）|
| PackState（某工作区对某包） | not_installed / up_to_date / outdated / customized + installedVersion | **派生**：由各组件族的发布头内容摘要推出，不存 | 读者是该工作区成员 |
| 安装记录 | `change_segments`（`source_kind = 'pack'`，源名 / 版本 / 摘要）| 一等，审计与回滚的依据 | 工作区 owner 应用 |
| AdminProposal / 段 | 管理员智能体从试验工作区提出、按目标工作区分段、由各 owner 决定的提案 | 一等（governance 0032）| 提：智能体；定：目标 owner |
| **新：装包建议段**（pack_install segment）| 一个工作区段，内容只有一项「在这里安装包 P 的版本 N」 | 一等，复用 0032 的段 | 同上 |

**关键语义区分**：现有管理员提案的段是「智能体起草的内容」，应用后发布的版本记 `origin = 'agent'`（I-A7）。能力包的内容不是智能体起草的，是部署发布的。所以「智能体建议装包」**不能**走 `source_kind = 'admin_proposal'` 那条（那会把包的内容记成智能体写的，也会让包的状态推导与安装记录对不上）。正确的投影是：

> 装包这件事的**内容来源**仍是包（`source_kind = 'pack'`，源摘要是包版本的摘要），由 owner 安装；
> **为什么装**是一条溯源：这次安装应某个管理员提案段的建议（`admin_proposal_segment_id` 等 0033 已有的四列）。

即「一个核心，两种来源」不变，只是 pack 来源的安装记录可以带一条「应谁的建议」。代码依据：`change-plan/engine.ts` 的 `itemOriginOf` 只对 `admin_proposal` 来源的条目记 `origin = 'agent'`，pack 来源的条目记 `human`，带不带提案溯源都一样。

`agent_list_packs` 复用的 `PackWire` 只有来源类别（`source: 'builtin' | 'extra'`），没有附加包目录在主机上的路径。

## 3. 不变量

- I-G1 智能体不能安装：装包只经 `install_pack`（human 通道、owner、`actsForPerson`）。新能力 `propose_pack_install` 只写提案。
- I-G2 一个装包建议段只含一项 `pack_install`，不与内容意图混在一个段里；一个提案只建议一个包（每个目标一段）。数据库约束保证前者（段的 `items` 含 `pack_install` 时长度为 1）。
- I-G3 一条 pack 来源的安装记录若带提案溯源，则该提案段存在、指向本工作区、状态为 `proposed`（在同一事务里转 `applied`）、其唯一一项的包名与版本等于记录的 `source_name` / `source_version`，段的 `content_digest` 等于记录的 `source_digest`。数据库触发器保证（仿 0033 `change_segments_admin_proposal_guard`）。装包建议段的 `content_digest` 就是建议时那个包版本的摘要（`PackVersion.digest`，即这一版每次安装的源摘要）。
- I-G4 一条安装记录最多回应一个提案段，一个提案段最多由一条记录回应（0033 已有唯一索引）。
- I-G5 回滚这条安装记录，同一事务把提案段转 `rolled_back`（`rollback.ts` 已按 `segment.adminProposal` 处理，不区分来源，只要该列有值）。
- I-G6 包版本以 owner 审阅时为准：建议的版本不是当前最新版时，不能按这个建议装（`install_pack` 本来就只装最新版并核对 `version`）。版本号相同但摘要不同（附加包目录里同一版本号被换了内容）也不能按这条建议装：内核在安装前比对，返回 409 `admin_proposal_pack_mismatch`，I-G3 的触发器再兜底。
- I-G8 装包建议提案的 `source_name` 不表示「哪个包」。0032 把源名定义为提案新组件的命名空间（`derivePackComponentId(source_name, …)`），装包建议不派生任何组件，所以它的源名固定为 `pack-install`。包名和版本只放在段的那一项里。`checkAdminProposal` 的「源名不能是本部署自带包的名字」规则照旧，对它也成立：若部署真有一个叫 `pack-install` 的包，`propose_pack_install` 一律拒绝并说明。
- I-G7 智能体对目标工作区仍只读得到段状态（F5 不变）。

## 4. 决定（每条：结论、理由、被否的替代）

**D1 读：新增 `agent_list_packs`（`admin_proposal` 组，`adminAgentOnly`，handle，observe）。**
返回与 `list_packs` 同一个 wire（`PackWire`），读的是试验工作区自己的状态：注册表里每个包、各版本与组件、来源（镜像 / 附加）、在试验工作区的安装状态、最新版需要的系统与依赖的包。
理由：同一个概念只有一个投影（避免语义漂移）；通道是二值的（human / handle），现有做法就是给智能体单开一个 `agent_*` 能力（`agent_list_admin_proposals` 对 `list_admin_proposals`）。
否：把 `list_packs` 改成两个通道都可用——要动 `modules` 组进上限组、动 I-A2 的守卫，收益为零。

**D2 提：新增 `propose_pack_install`（`admin_proposal` 组，`adminAgentOnly`，handle，propose）。**
参数：`pack`、`version`（智能体看到的最新版）、`targetWorkspaceIds`（1–20，必须都在已选目标里）、`title`、`description`（为什么装）。
写一条管理员提案：`source_name = 'pack-install'`（I-G8，#484 复核改；原稿写的 `source_name = pack` 与「源名不能是自带包名」的规则冲突）、`origin = 'agent'`，段的 `content_digest` 是包版本的摘要（I-G3），每个目标一段，段的 `items = [{ kind: 'pack_install', pack, version }]`。复用提案的全部治理：每日限额、目标必须已选（`admin_proposal_target_not_chosen` 先查）、不可用目标一律同码拒绝、熔断（被同一目标频繁拒绝）、撤回、回读、平台面列表。
提案时校验：包在注册表里、版本是它的最新版、源名不能是自带包名的规则照旧（I-G8）；源名没有唯一约束（0032），同一时间可以有多份装包建议。
理由：显式的领域能力，工具描述短、模型不容易拼错（遗留 645 就是参数结构让模型首轮被拒）。
否：在 `propose_admin_proposal` 里加第五种意图——要在一个段里禁止混用、apply 路径分叉，模型也更容易拼出被拒的组合。

**D3 应用：在目标工作区走现有的装包路径，`install_pack` 加可选参数 `adminProposalSegmentId`。**
owner 在「收到的管理员提案」里看到「建议安装能力包 P 第 N 版」和理由，点「查看并安装」进入能力目录 · 能力包里同一个安装审阅（干跑、逐项确认扩权、选 Worker 绑的门），确认后 `install_pack` 带上这个段 id：同一事务里写 pack 来源的安装记录（带 0033 的四列溯源）并把段转 `applied`。拒绝沿用 `reject_admin_proposal_segment`。
`preview_admin_proposal_segment` / `apply_admin_proposal_segment` 遇到装包建议段返回 409 `admin_proposal_segment_is_pack_install`（指向 `preview_pack_install` / `install_pack`），不另做一套干跑。
理由：「装包」只有一个能力、一个审阅界面、一套数字（I-A8 摘要、I-A4 确认、绑门）；提案只是「为什么」。
否：在提案段里再包一层装包干跑——两套审阅界面，语义重复。

**D4 安装记录的提案人列。** pack 来源的记录 `proposed_by` 照旧是 owner（装包的提出者与发布者都是 owner，与今天一致），另有四列溯源记录建议它的提案、段、平台用户与当时的显示名。迁移 governance 0040 放宽 `change_segments_proposer`：`pack` 来源允许四列全空或全有，并加 I-G3 的触发器、I-G2 的检查约束。旧代码读这些行不受影响（`proposed_by` 仍非空）。

**D5 智能体看目标的安装状态：推迟，不在本次。** 若要做，做法是一个定义者函数，只返回「已选目标 × 包」的**最近一条 pack 来源安装记录**（包名、版本、时间、是否已回滚），标明它是「安装记录」不是「当前状态」（定制过的不反映）。不读任何内容。先看第一、二片上线后「建议了已经装好的包、被拒」的频率再定。
已装好的包被建议时：owner 的安装审阅显示「已是最新，无需安装」，拒绝时理由选「已安装」。这会计入熔断，是已知代价。

**D6 不做：**智能体直接安装；在一个段里装多个包；平台面替工作区装包；导出装包建议段为包（`export_admin_proposal_pack` 对它返回 `segment_not_exportable` 的一种）。

## 5. 状态机（复用 0032，不加状态）

装包建议段：`proposed` →（owner `install_pack` 带段 id）`applied` →（回滚安装记录）`rolled_back`；
`proposed` →（owner 拒绝）`rejected`；`proposed` →（智能体或平台管理员撤回）`withdrawn`。
提案的派生状态（`adminProposalStatusOf`）不变。

## 6. 能力 / API 变更

| 能力 | 变化 | 线上契约 |
|---|---|---|
| `agent_list_packs` | 新增，`adminAgentOnly`，result 复用 `listEnvelope(PackWireSchema)` | 新 |
| `propose_pack_install` | 新增，`adminAgentOnly`，result 复用 `AgentAdminProposalWire` | 新 |
| `install_pack` | params 加可选 `adminProposalSegmentId`；新增拒绝码 `admin_proposal_segment_not_found` / `admin_proposal_segment_not_open` / `admin_proposal_target_no_longer_chosen`（沿用现有码）与 `admin_proposal_pack_mismatch`（段建议的包或版本与本次安装不同） | 加字段（向后兼容）|
| `preview_/apply_admin_proposal_segment` | 对装包建议段 409 `admin_proposal_segment_is_pack_install` | 新码 |
| `AdminProposalItemIntent` 读回 | 加 `pack_install` 一种（只出现在读回里，`propose_admin_proposal` 的入参不收它） | 加枚举成员 |
| `platform_state_audit` | 只改描述（`self` 的含义）| 无 |

## 7. 控制台（随第二片同 PR，或紧随，UX 验收）

- 收到的管理员提案：装包建议段的卡片——包名、版本、包的摘要、提案理由、「查看并安装」（跳到能力目录 · 能力包的安装审阅，带段 id）、「拒绝」。
- 能力包安装审阅：从提案进入时顶部说明「应管理员 X 的提案」，确认后回到提案页看到「已应用」。
- 平台 · 管理员提案、智能体侧回读：意图渲染器认识 `pack_install`。
- 安装记录详情：显示「应管理员提案 …」溯源（0033 的四列已有展示，确认 pack 来源时也显示）。

## 8. 验证

- 内核单测 / 集成：`propose_pack_install` 的每条拒绝（未选目标、不可用目标、包不存在、版本非最新、限额、熔断）；`install_pack` 带段 id 的成功路径（记录四列、段转 applied、一行审计）与每条拒绝；I-G2 / I-G3 的数据库约束直接用 SQL 越过内核去撞；回滚安装记录连带段 `rolled_back`；不带段 id 的安装行为与今天逐字节一致。
- 守卫：`handles.test.ts` 上限名单与 `ADMIN_TOOL_CAPABILITY_NAMES` 同步；`pnpm contract:check` 快照；`ci:guards` 词表。
- 迁移可逆性探针（#482 的声明式核对）。
- 验收旅程（staging / 主机）：智能体列包 → 建议把一个未装的包装进两个目标 → 两个 owner 各自审阅安装 → 一个装、一个拒 → 智能体回读状态正确；再回滚那次安装，段转 `rolled_back`。

## 9. 切片与顺序

| 片 | 内容 | 审查 | 依赖 |
|---|---|---|---|
| AA5g-1 | `agent_list_packs`（内核 + shared + platform-extension 工具名单 + 控制台能力标签）；`platform_state_audit` 描述；`admin-agent.yaml` 加一段「能力包」 | #493 | 无，可先做 |
| AA5g-2 | `propose_pack_install`、`install_pack` 的 `adminProposalSegmentId`、governance 0040、回滚 / 导出 / 预览的分支、`admin-agent.yaml` 补「提议安装」 | #493，迁移另看可逆性 | AA5g-1 |
| AA5g-3 | 控制台 §7 | UX 验收、web-e2e | AA5g-2（可同 PR）|
| （推迟）AA5g-4 | D5 目标安装记录读 | — | 看 AA5g-2 上线后的数据 |

## 10. 风险

- 建议已装好的包会被拒，计入熔断（D5 推迟的代价）。缓解：智能体的提示词要求先问管理员目标里的情况，或说明「不知道目标是否已装」。
- 附加包（`EXTRA_PACKS_DIR`）可在提案与安装之间被拿走：安装时 `pack_not_found`，owner 拒绝即可。
- 0040 放宽了 `change_segments_proposer` 的 pack 分支：回退代码前，若已有带溯源的 pack 记录，旧代码读它们无碍（只多四列），回退迁移前需先确认没有这类行。
