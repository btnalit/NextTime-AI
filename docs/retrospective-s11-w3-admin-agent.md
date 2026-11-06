# 阶段回顾（2026-11-06）：S11 W3 平台管理员智能体（配置层）与 D-W5 证据包

> 本文是 S11 W3 的回顾，也是决策门 D-W5 的证据包（`goal-orchestration-and-admin-agent-plan-2026-10-16.md` §5.5，
> `global-roadmap-2026-10-16.md` §4 的 D-W5 一行）。方案见前一份的 §5.4–§5.9，任务拆分与实现说明见 `development-tasks.md` §5i，
> 进度与遗留见 `STATUS.md`（本文只被它链接）。AA5 的工作计划在项目共享目录，不入库；那份计划给 D-W5 列了六份证据，
> 本文 §2–§7 按它的顺序排，每份写明出处（运行链接、测试文件、审计行）。
>
> **写到哪了**：staging 上 fake-llm 加真 pi 的预演、守卫对照表、审计样本都齐了。staging 付费真实模型跑了第一轮（§2.2），
> 智能体停在第一步；测量补齐（#985）之后再跑第二轮。**还缺两份**：真实模型第二轮和主机一遍（§2.3，主机停在 v0.50.0）。
> 这两处标「待补」，补齐之前本文的结论只到 staging。
> D-W5 由维护者决定，本文只摆证据，§0 第 4 条是 W1a 的看法，不是结论。

## 0. 结论

1. **§5.8 的旅程在 staging 上能走通。** 管理员智能体在真 pi、真管理员容器、真门、真 gate-host 上，把一个测试工单系统从请求接入一路带到
   目标工作区应用、绑门、自动验证；另一条路把应用过的提案导出成能力包，放进附加包目录，在第三个工作区装上（§2.1）。模型是 fake-llm，
   按脚本走，不会自己卡住。真实模型第一轮（§2.2）停在第一步：读了平台状态，没发接入请求。人那句话里少了地址，脚本又看不到
   它回了什么，所以这一轮还说明不了它能走多远；补齐测量（#985）之后再跑一轮。
2. **§5.7 的守卫逐行对到了测试。** 16 行里：
   - 14 行有内核或单元测试，都在 v0.62.0 的 tag 上，那次 CI 全绿；
   - 1 行（试跑的写动作照常审批）只有验收旅程覆盖；
   - 1 行（改 CI 或治理代码）在 W5 之前本来就没有代码层。

   缺口 6 处：4 处结构上成立、没有专门测试；2 处应该补测试，交 steward 登遗留（§3）。
3. **S11 总出口第 3 条要改一个读法。** 那一条写的是「人只做录凭证、按段审变更、点应用」，旅程里人实际做了 14 件事，多出三类：
   - 授权门（试验）：授权是给人的；
   - 批准试验动作：触及有状态系统的动作必经审批；
   - 启用门：目标工作区的门由它的所有者启用。

   这三类都是设计底线的直接后果，不是配置层缺口。建议把出口第 3 条读成 §2.4 的清单，由维护者定。
4. **D-W5：W1a 建议现在不通过，W5 不开工。**
   - **前提 ② 不满足**，而且比方案 §5.5 写的还弱：main 的必需检查对管理员账号不强制（`enforcement_level: non_admins`），main 上没有
     ruleset，所有 agent 会话又都以这个管理员账号行事（§5）。
   - **前提 ①** 的待签文字在 §6。
   - **配置层表达不了的改动**，到目前为止没有一项需要智能体自己写代码（§4）。旅程找出的 3 个缺口和计划内还没做完的导出，都是产品缺口，
     由正常开发在 11-05 到 11-06 补上（导出的内核部分 #976、控制台部分 #977 都已合入）。
   - 所以 W5 现在没有急迫性。重开的条件见 §4 末尾。

## 1. 范围与交付

W3 = 214、P0b、P1、AA1–AA6（`global-roadmap-2026-10-16.md` §4）。AA6（可选的 OpenMetadata 包）没有做。

| 项 | 内容 | PR | 进的版本 |
|---|---|---|---|
| 214 | 自连门重新同步 | #612 | ≤ v0.50.0 |
| P0b | 接入路径统一（`landGatekeeper`） | #620 | ≤ v0.50.0 |
| P1 | ChangePlan 核心与能力包：门宿主实例挂接入包、ChangePlan 核心、安装记录可读可撤销、Pack Contract v1、包带 Skill 与 Worker、安装记录核验与 Operation 改动项、pi 白名单启动（遗留 422）、包里的 Worker 按系统绑门、治理字段收敛、接入预设（RAGFlow）、knowledge 包与包依赖、`document.parse` 每次要人批 | #644、#650、#663、#668、#679、#690、#698、#705、#710、#715、#721、#726 | ≤ v0.50.0 |
| AA1 | 身份、上限与逐次调用检查 | #897 | v0.59.0 |
| AA2 | 读平台状态：门、连接器、近期变更；运行时、更新、不变量 | #900、#903 | v0.59.0、v0.60.0 |
| AA3 | 试验工作区与 I-A6；管理员提案、工作区部分、平台部分、平台依赖 | #914、#916、#920、#921、#923 | v0.61.0 |
| AA4 | 所有者审阅（能力目录）、平台审阅、管理员对话与运行时、控制台入口、CI 旅程、交接入口、staging 真 pi | #929、#933、#936、#937、#941、#943、#945、#947、#949 | v0.61.0、v0.62.0 |
| AA5a–c | 试验里请人接系统与试跑 Worker、反复被拒熔断、控制台、工单旅程 | #954、#956、#961、#959 | v0.62.0 |
| 新装默认开 | `host-env-init.sh` 新装写 `ADMIN_AGENT_ENABLED=1` | #957 | v0.62.0 |
| AA5f | 应用时给 Worker 绑门、应用后自动验证 | #968、#969 | v0.62.0 之后，未发版 |
| AA5d | 附加包目录；导出成能力包与 governance 0039；控制台；staging 预演导出安装段 | #971、#976、#977、#979（已合入） | v0.62.0 之后，未发版 |
| 遗留 | 596 / 610、597、619、628、630 | #924、#927、#951、#964、#966 | v0.61.0、v0.62.0 |

## 2. W3 出口证据（D-W5 证据 1）

### 2.1 staging 预演：fake-llm + 真 pi

预演由 `staging-rehearsal.sh` 跑，从上一个发版 tag 升到被测提交，在新版本上打开管理员智能体再跑整套 S1–S4。工单旅程在 S2 里
（`scripts/lib/accept-s2-admin-agent-tickets.sh`）。

| 运行 | 被测提交 | 结果 | 说明 |
|---|---|---|---|
| #959（AA5c），job 127486737502 | eb217361 | S2 `pass=188 fail=0`，`RESULT ok` | §5.8 第一次端到端走通；人做 15 件事 |
| #979（AA5d-4），run 42144555200，job 127652862358 | d4d3901c | S1 25/0、S2 195/0、S3 34/0、S4 17/0，`RESULT ok` | 在 AA5f 之后：应用时绑门、自动验证；加上导出 → 附加包目录 → 第三个工作区安装 |
| #979 合入前（并上 #977 之后的 main），run 42159572210，job 127701935482 | 5de10f26 | S1 25/0、S2 195/0、S3 34/0、S4 17/0，`RESULT ok` | 同上，控制台导出入口（#977）也在里面 |

旅程里核对的、和 D-W5 有关的事实（每条都是脚本断言，`fail=0` 即全部成立）：

- 试跑开的工单只在批准之后出现，账本多一张 `via: trial`；生产那一半一张也没开。
- 测试凭证和生产凭证都不在内核库里；生产凭证由驱动拿 `issue_gate_host_token` 的令牌直送 gate-host。
- 提案读回（平台面、智能体）不带所有者干跑的内容。
- 审计按会话、`origin: agent` 精确匹配（样本见 §7）。

### 2.2 staging 付费真实模型 —— 第一轮已跑，第二轮待补

- **怎么跑**：`accept_s2.sh --real` 加了一段管理员智能体工单旅程（#981，#488 与 #481 审过，已合入 17613f6c）。
  合入后在 main 上手动触发 staging 工作流的真实模型一轮。
  - 只跑一次（`run=1`）；8M token 上限照旧；单个 Turn 最长 420 秒，到时没结束的先停掉再说下一句。
  - 每一步卡住时只补一句「请直接按刚才说的做」。
  - 人的那几步由脚本扮演，和 fake 路径一样。
- **记什么**：一行 `RUN scenario=admin_tickets`，字段含义见 `runbooks/host-accept-real-model.md` §5。
  - 走到哪一步（`reached`）、卡在哪（`stuck`）；
  - 轮数、补话次数、工具调用与出错数、被拒的调用；
  - token、美元、人做了几件事。
- **不让整轮 FAIL 的情况**：模型没做到只计成败。只有非模型的失败才 FAIL：批准前就开了单，或试验工单比人批过的开单请求多；生产开了单；
  凭证进了内核库；审计记错人；人的那几步失败。
  - 人扮演的确认之前先核对形状：平台部分只能是这个工单系统的 gate-host 实例，工作区部分只能是 Skill、Worker 和工单门上的 Operation。
    模型写了别的就停在那一步，不确认、不录正式凭证。这是 #488 审出来的：脚本替人确认模型写的平台改动，至少要做人肯定会做的那次核对。

| 字段 | 第一轮 | 第二轮（#985 之后） |
|---|---|---|
| 运行 | run 42168783604，main d738bfee（v0.62.0 → v0.63.0-staging.d738bfee），`RESULT ok`；升级前后 S1–S4 全绿，其他真实场景全部 1/1 | 待补 |
| 走到 / 卡在 | `reached=none`，`stuck=connect:no_request` | 待补 |
| Turn / 补话 / 工具调用（出错） | 2 / 1 / 2（0）：`platform_state_connectors`、`platform_state_gates` 各一次；被拒 0 | 待补 |
| token / 美元 | RUN 行 `tokens=39012` 少算了一次调用；llm-proxy 日志三次调用合计约 6 万（缓存读写占绝大部分，输出 1343）。staging 不记价，`cost_usd=0` | 待补 |
| 人做了几件事 | 0 | 待补 |
| 新发现的配置层缺口 | 无（见下面的读法） | 待补（并入 §4） |

**第一轮怎么读**：
- **核实过的**（compose 日志）：
  - 第一个 Turn 11 秒，两次模型调用。先并行读了连接器和门的平台状态，再写了约 680 个输出 token 的文字。
  - 补一句之后，第二个 Turn 5 秒，一次调用，约 430 个输出 token，只有文字。
  - 两次都没调 `request_connection`，没有被拒、报错或超时。不变量和预算两条检查都 PASS。
- **推断，没核实**：智能体两次都选择用文字回答。脚本按公开仓库的规则不记回复原文，所以看不到它说了什么。最可能的原因是人那句话只说了
  「叫作 helpdesk」，没给系统地址，它不肯自己编一个 target，在等人补。其次是它以为平台预设模式下请求会被拒，或者在等确认。
- **如果是缺地址**：停下来问人是该有的行为，不算「走不远」。管理员智能体的提示词（`ontology/admin-agent.yaml`）要它说清楚接的是什么系统、为什么要接，信息不全时说明而不是猜；不编一个地址正合这一条。
- **这一轮算测量的缺口，不算产品缺口。**
  - 扮演人的那句话少了人本来会说的信息。
  - 脚本看不出停下的原因。
  - RUN 行的 token 读得太早：llm-proxy 约 2 秒一批上报用量，最后一批还没进 `llm_usage`。
  - #985 补这三处：第一句带上地址；RUN 行加 `replies=`，记每个 Turn 回复的形状（是否以问题结尾、长度、提到了哪几类事），不记原文；用量等稳定了再读。
- **对 D-W5**：第一轮不提供「真实模型能走多远」的证据，也不提供反证。第二轮出来之前，§0 第 4 条的建议不靠这一节。

### 2.3 主机 —— 待补

- 主机从 2026-10-30 起停在 v0.50.0。它带着 W3 的 214、P0b、P1，那次应用 `RESULT ok`。AA1–AA5 都在 v0.59.0 之后，主机上还没有。
- v0.62.0 的升级与验收由维护者在本地会话里按 `docs/runbooks/` 做，结果记 `docs/private/`。本节只写结论：
  - 升级与 S1–S4；
  - 主机上的工单旅程：会在生产库里留下一个停用的门实例和临时账号，要维护者同意；
  - 主机要不要跑付费真实模型。

| 项 | 结论 |
|---|---|
| v0.62.0 应用 | 待补 |
| 主机上的工单旅程 | 待补 |
| 主机付费真实模型 | 待补（没跑就写「staging 代替，主机未跑」） |

### 2.4 人做了哪些事

AA5f 之后是 14 件（#959 时是 15 件，「验证」那一步变成应用后自动跑）。每一件旅程脚本都用 `tickets_human` 记一行。

| 类 | 次数 | 在哪 | 方案 §5.8 的清单里有吗 | 为什么是人 |
|---|---|---|---|---|
| 录凭证 | 2 | 试验：请求卡（测试凭证）；平台：集成页（生产凭证） | 有 | 智能体不碰凭证 |
| 试验工作区发布 | 4 | 门的 3 个 Operation 一次；2 个 Skill；1 个 Worker | 有（F3(a) 算进「审变更」） | 发布是 human 通道 |
| 授权门（试验） | 1 | 「系统访问」卡 | **没有** | 授权是给人的，智能体不能替自己的人点 |
| 批准试验动作 | 1 | Worker 的 `tickets.create` | 有 | 触及有状态系统的动作必经审批 |
| 按段审阅与逐项确认 | 2 | 平台部分 1 项；工作区部分 4 项 | 有 | — |
| 每段应用 | 2 | 平台部分；工作区部分 | 有 | — |
| 启用门 | 2 | 平台启用实例；目标工作区启用（控制台在管理员提案的审阅页里就地启用） | **没有** | 门在哪个工作区启用是那里所有者的事 |

导出那条路（AA5d）另有四件：

- 平台管理员导出；
- 把包放进主机的附加包目录：这是部署层，维护者做；
- 第三个工作区的所有者启用包要用的门；
- 同一个所有者预览、安装并验证。

**对 S11 总出口第 3 条**：多出来的「授权门」「启用门」两类，加上「批准试验动作」，都是三条设计底线或授权模型的直接后果，没有一件能在
不降低底线的前提下交给智能体。建议出口第 3 条按上表的 7 类读，「人只做录凭证、按段审变更、点应用」改成「人只做上表的事」。由维护者定。

## 3. §5.7 守卫对照表（D-W5 证据 2）

**CI**：v0.62.0 的 tag 在 3f49525b，那次 CI 是 run 42127305208，全绿。其中：

- `guards`（job 127594647320）含「Membership capabilities must never enter a Handle-scope ceiling (S3.11)」一步；
- `test`（job 127594748594）在 Postgres 上跑全部单测和集成测试；
- `quality`（job 127594748681）跑 lint、类型检查和契约快照。

下表每条用例都用 `git show v0.62.0:<文件>` 核对过，在那个 tag 上存在。用例名照抄测试里的英文，便于搜索。

**文件缩写**：
- `HT` = `kernel/src/governance/capability/handles.test.ts`；`CT` = `shared/src/capabilities.test.ts`；`SAP` = `shared/src/admin-proposals.test.ts`；
- `AA`、`TR`、`CH`、`PS`、`ID` = `kernel/src/application/admin-agent/` 下的 `admin-agent.integration`、`admin-agent-trial.integration`、
  `admin-agent-chat.integration`、`platform-state.integration`、`identity`；
- `AP`、`APS`、`APB`、`PSG`、`EN`、`CL` = `kernel/src/application/change-plan/` 下的 `admin-proposals.integration`、
  `admin-proposal-segments.integration`、`admin-proposal-breaker.integration`、`platform-segments.integration`、`engine.integration`、`classify`；
- `HM` = `kernel/src/application/task/handle-mint.test.ts`；
- `RW`、`PAD` = `platform-extension/src/` 下的 `runtime-whitelist`、`pi-agent-dir`。

| # | 风险（方案 §5.7） | 测试 | 缺口 |
|---|---|---|---|
| 1 | agent 批准自己的提议 | CT「keeps the human-only capabilities off the handle channel」；HT `it.each(['approve', 'grant_capability'])`；AA「refuses a person's decisions through the Handle though its Principal is that person, who still passes on the human channel (constraint b)」 | — |
| 2 | 走 service API key 绕过人 | AA「refuses a non-administrator, a service or agent Principal, a disabled user and a disabled Principal」；PS「refuses a person, a service API key and a platform administrator: only a Handle reaches it」；HT「holds only handle-channel observe reads, the seven proposals, …」 | — |
| 3 | 改自己的能力上限 | HT「is exactly this set — widening it is a reviewed change to this test (I-A2)」；HT「refuses, when the ceiling is built, every name that breaks one of its rules」；CI `guards` 的上限守卫 | 没有一条专门断言「没有代码托管类能力」。精确集合那条间接覆盖了：平台本来就没有这类能力。结构上成立 |
| 4 | 改约束自己的配置 | AP「F10 + AA4c: a target the administrator did not choose — unknown, disabled, a trial workspace or a standard one alike — is refused …」；AP「the guards: a proposal never changes; a segment is added only by its proposal's transaction, never to a trial workspace, …」；CH「governance 0036: a row is a platform administrator's own choice of an active standard target …」 | 没有一条直接断言「提案改不了智能体自己的定义、Skill、策略」，因为这些都不是可提议的对象。提案只能带 `skill_version`、`worker_definition_version`、`ontology_version`、`operation_version`（工作区）和 `gate_instance`（平台）。智能体自己的提示词、Skill、扩展由平台按白名单装（第 13 行），上限是代码常量（第 3 行）。结构上成立 |
| 5 | 借合法变更夹带授权扩大 | CL「every schema field has a rule」；EN「unconfirmed: 400 change_confirmation_required with the item and why; confirmed: applied and recorded」；APS「applies what was previewed: the widening item confirmed, suspected credentials reviewed; …」 | — |
| 6 | 审过 A、应用的是 B | EN「the family moved since review: 409 change_plan_changed, nothing applied」；APS「I-A8: what an intent resolves to is part of what was reviewed; …」；PSG「AA3c-2: a workspace segment compares what its platform segment created with the instances now — …」 | — |
| 7 | 借提交或校验结果试探生产工作区 | APS「F12: only the owner of the workspace a segment is addressed to reaches it」；APS「rejecting takes a reason; the owner and the platform read it, the agent reads only that it was rejected」；PSG「another workspace never reads the proposal's platform segment; its target reads only its status」 | — |
| 8 | 管理员降级后 agent 继续工作 | AA「checks the platform role on every call, not at issuance (I-A3)」；AA「update_user demotion revokes the admin agent at once, and a new one gets a new session」；TR「demoting the administrator refuses both at once (I-A3)」 | — |
| 9 | 凭证经过 agent | AP「F9: a credential is refused with where it is, never the value; a [redacted] mark too」；PSG「F6: refused when proposing — … a credential in a target or OpenAPI address」；SAP「takes exactly create_gate_instance's fields, none of them a person, workspace, setting, model, image or token」 | 「凭证页面直达门宿主」没有管理员智能体专门的测试，由 §2.1 的旅程覆盖：两份凭证都不在内核库。结构上成立 |
| 10 | 改 CI 或治理代码偷渡 | W5 之前没有代码层（第 3 行的精确集合） | 方案里本来就是「待定」，W5 才有 |
| 11 | 刷屏、反复提同一个被拒的提议 | APB「a third rejection within seven days closes the target: 429 with when, never why; audited with the rejections; …」；APB「follows ADMIN_PROPOSAL_REJECTION_LIMIT and ADMIN_PROPOSAL_REJECTION_WINDOW_DAYS」；AP「F11: twenty proposals a day per administrator across trial workspaces; …」 | — |
| 12 | 需要立即停下它 | AA「with the switch off, issues nothing and refuses every call of a Handle already issued」；CH「stop_admin_agent revokes the session and its Handles in the platform transaction, then stops the running admin Turns — …」；ID「reads 1/true as on and 0/false as off, …」 | 「被劫持的会话改不了开关」没有测试：开关在 kernel 的环境变量里，智能体没有任何写主机文件或环境的能力。结构上成立 |
| 13 | 运行时自写资源持久化 | RW「loads only the platform's prompt, Skills, extension and built-in tools — at start and in every later conversation」；RW「keeps out what the agent writes into pi's config directory by the flags alone, without the restore hook」；PAD「puts pi's config directory back exactly as entrypoint.sh builds it」 | — |
| 14 | （AA5）管理员发起的 Worker 拿不到管理员能力 | TR「invoke_worker through the Handle starts a published Worker whose Task records the admin agent session; …」；HM「a definition declaring them gets none, from the admin agent's full Handle」；HT「holds every capability only an admin agent calls, and no other ceiling holds one (S11 AA2)」 | — |
| 15 | （AA5）自接例外只在试验工作区 | TR「in a trial workspace a platform administrator self-connects http or mcp while the connector is platform-preset, each use audited; nobody else, no other kind, no other workspace」；TR「a connector the platform disabled stays closed in a trial workspace too: …」。I-A6 本身：TR「outside a trial workspace the handlers refuse an admin agent themselves, …」、TR「a production workspace's Worker or gate cannot be reached from the trial workspace, …」、AA「I-A6 (legacy 585): issues only in a trial workspace, …」 | **要补**：AA5 计划要求覆盖三种情况：普通工作区不受影响、非平台管理员完成被拒、试验工作区被清除之后。最后一种没有测试，现有的只覆盖停用 |
| 16 | （AA5）试跑的写动作照常审批 | 只有验收旅程覆盖：批准前账本不变，批准后多一张 `via: trial`（`accept-s2-admin-agent-tickets.sh`）；真实模型那一段把「批准前就开了单」算 FAIL | **要补**：内核没有测试断言管理员发起的 Task 的执行类动作走普通的 ActionRequest，不另开捷径 |

第 15、16 行的两条测试交 steward 登 P3 遗留。它们不挡 D-W5：路径本身有旅程断言，缺的是更快、更窄的回归。

## 4. 配置层表达不了的改动（D-W5 证据 3）

**记什么**：旅程里智能体做不下去的地方，或者人不得不在提案和试验路径之外动手改的地方。这是判断 W5 有没有
必要的直接依据。

| # | 发现 | 在哪一步 | 性质 | 怎么解决 | 要智能体写代码吗 |
|---|---|---|---|---|---|
| 1 | 提案里的 Worker 应用后没有门；事后去绑就得发下一版，这一段随之验证不通过、撤销不了 | 应用 | 人要绕出提案路径 | AA5f（#968、#969）：Worker 意图写 `systems`，应用时所有者选门 | 否 |
| 2 | 管理员提案的验证不探门，「通过」是假绿灯 | 验证 | 验证语义不对 | 遗留 630（#966） | 否 |
| 3 | 应用后要手动点「验证」 | 验证 | 多一步 | AA5f 应用后自动验证一次 | 否 |
| 4 | 方案 §5.8 第 7 步「导出为能力包」还没有，只能手抄 | 导出 | 计划内（AA5d），已做完 | AA5d-1（#971）、AA5d-2（#976）、AA5d-3（#977）已合入，预演 AA5d-4（#979）也已合入 | 否 |
| — | 授权门（试验） | 试验接入 | 设计如此 | 保留人工；AA5f 在应用时提示「你还没有授权」 | 否 |

- **结论（到 staging fake-llm 为止）**：要智能体自己写代码才能做下去的一项也没有。
  - 第 1–3 条是 11-05 的旅程跑出来的，第 4 条是计划内的。
  - 四条都由正常开发在 11-05 到 11-06 补上，就是方案 §5.5 末尾说的「由人在外部 agent 线程里改」。
- **真实模型那一轮可能再加几项**：模型卡住、工具或提示词不够用。加进来时按同样的列分：是提示词或工具的问题（正常开发），还是只有代码层
  才做得了。第一轮停在第一步，原因落在测量上（§2.2），没有加项；第二轮出来再看。
- **W1a 建议的重开条件**（供维护者参考）：真实使用中，这种「配置层表达不了、要外部线程改代码」的改动，连续四周每周超过两件；或者有一件因为
  等外部线程，挡住生产使用超过一周。到那时再议 D-W5，前提 ② 仍要先满足。

## 5. 前提 ② 的现状核对（D-W5 证据 4）

**事实**（2026-11-06 读到）：

- 所有 agent 会话在 GitHub 上都以维护者同一个账号行事：开 PR、审查评论、合并都记在这个账号名下。审查线程的结论写在 PR 评论里，
  不是 GitHub 的 approving review。例如 #971 合入时 `reviews` 为空。
- main 的分支保护（公开 API `GET /repos/btnalit/NextTime-AI/branches/main`）：
  - 必需检查 `guards`、`quality`、`test`、`web-e2e`；
  - `enforcement_level` 是 `non_admins`：管理员账号可以绕过这 4 个检查，而所有 agent 会话用的正是管理员账号。方案 §5.5 只写了
    「分支保护只要求 4 个检查」，实际还要更弱。
- main 上没有 ruleset（`GET /repos/btnalit/NextTime-AI/rules/branches/main` 返回 `[]`）。
- `CODEOWNERS` 是 `* @btnalit`，就是这个账号。
- 合并线程有维护者 2026-10-16 给的直合授权：审过、UX 过、CI 绿的 PR 自己合，见项目记录。
- 两个 `pull_request_target` 工作流都不检出 PR 头：`auto-merge.yml` 只对 Dependabot 生效，`pr-title.yml` 只检查标题。这和方案 §5.5
  设想的守卫一致，但没有 CI 守卫保证以后也这样。

所以前提 ② 不满足：今天没有任何一个审批身份是 agent 会话拿不到的。

**要满足它，维护者在 GitHub 设置里能做的**（W1a 只列步骤，不做）：

1. 一个只给人用的独立账号 H：不连接 claude.ai，不给任何会话发 PAT，不给 Claude GitHub App 用户授权。
2. 在 main 上建 ruleset：
   - 要求 PR，至少 1 个批准；
   - 要求 code owner 审；
   - 推送后作废旧批准；要求最后一次推送由别人批准；
   - 必需检查照旧；
   - bypass 列表为空。ruleset 对仓库管理员同样生效，除非列进 bypass。
3. 经典分支保护打开「Do not allow bypassing the above settings」，或者删掉经典保护、只留 ruleset。
4. `CODEOWNERS` 指向 H。至少指受保护路径：治理、网关、门、Handle、内部鉴权、supervisor、llm-proxy、gatekeeper-base、`ontology/*.yaml`、
   `.github/workflows/`、迁移。
5. 合并线程的直合授权改写为只覆盖 H 已批准的 PR。

**代价要先看清**（推断，未实测）：
- GitHub 的 ruleset 和分支保护都不能按 PR 作者区分。所以第 2–4 步一旦生效，今天 Claude 线程起草的、改到受保护路径的 PR 也都要 H 批准，
  不只是将来管理员智能体的代码 PR。
- 按现在的节奏，内核 PR 几乎都碰受保护路径，维护者会成为每个内核 PR 的必经一环。
- 这是满足前提 ② 的真实成本，比开 W5 本身大。

**改完之后的核对步骤**（W1a 可以照做，结果写进 STATUS）：

1. `GET /repos/btnalit/NextTime-AI/rules/branches/main` 列出 `pull_request` 规则（`required_approving_review_count ≥ 1`、
   `require_code_owner_review`、`require_last_push_approval`）和必需检查。
2. `GET /repos/btnalit/NextTime-AI/branches/main` 的保护不再是 `non_admins`，或者已经没有经典保护。
3. `CODEOWNERS` 指向 H。
4. 实测：一个 Claude 会话开一个只改文档的 PR，CI 绿后用它能用的工具合并，应当被拒；H 批准之后才能合。
5. bypass 列表是否为空只能由维护者在设置页确认（读 ruleset 详情要管理权限）。

## 6. 前提 ① 的待签文字（D-W5 证据 5）

下面是一段取代 I-N1 的**拟稿**。被取代的是 `s10-evolution-plan-2026-10-04.md` 的三处：§3.3 的 I-N1 一行、§5.1 末段「代码自修改方向本项目明确不做」、§5.7 的「明确不做」一条。
维护者签之前它不生效，本文也不把它当作已定。

> **I-N1′（拟稿）代码层只到「起草」，不到「合入」与「部署」。**
>
> **取代的部分**：平台管理员智能体（只有它，入口 agent 与任何 Worker 都不在内）可以起草平台代码的改动。
> - 形式是通过代码托管门向一个 fork 推分支、开 PR；
> - 推送与开 PR 是执行类 Operation，走 ActionRequest；
> - 每个这样的 PR 只能由前提 ② 的人用身份批准后合入。
>
> **不变的部分**：
> 1. **不自动合入**：agent 会话不能合入或批准任何 agent 起草的代码 PR。
> 2. **受保护路径默认拒绝**：
>    - 智能体起草的 PR 只能改低风险路径白名单里的文件；
>    - 治理、网关、门、Handle、内部鉴权、supervisor、llm-proxy、gatekeeper-base、`ontology/*.yaml`（提示词）、`.github/workflows/`、迁移
>      一律不在白名单；
>    - 它改不了自己的上限、提示词和约束自己的代码（`goal-orchestration-and-admin-agent-plan-2026-10-16.md` 的 O7）。
> 3. **经验不自动改规则**：Policy、Grant、自动批准规则永不因经验自动改变（原 I-N1 后半句不变）；经验只产出提议，发布只经人。
> 4. **配置层不变**：W3 的管理员提案、按段审阅、逐项确认、摘要绑定、熔断与配额照旧；代码层不绕过它们。
> 5. **部署层不变**（方案 §5.6）：发版应用只经 `apply-release.sh`，由维护者执行；智能体最多准备部署请求。
> 6. **三条设计底线不变**：agent 与 kernel 进程不持凭证；触及有凭证、内部或有状态系统的动作必经审批；隔离与审计只增不减。
>
> **生效与失效**：只在前提 ② 落实并按 §5 核对通过之后生效。前提 ② 不再成立时（例如 H 的凭证进了任何 agent 会话，或 bypass 列表里
> 出现 agent 能用的身份），本条自动回到 I-N1，已开的代码 PR 关闭。

## 7. 一次旅程的审计样本与成本（D-W5 证据 6）

**样本**：
- 出处：#979 在 d4d3901c 上的预演，S2 `fail=0`，脚本断言 `admin-agent-tickets-audit` 与 `admin-agent-tickets-audit-production` 都成立。
- 脱敏：只写列的含义，不写 id。
- 旅程里平台管理员和目标工作区所有者是同一个人（方案 §5.8 末句），在两个工作区里是两个 Principal。

| 工作区 | 动作 | 谁（Principal） | 会话 | 其他 |
|---|---|---|---|---|
| 试验 | `request_connection`、`propose_skill` ×2、`propose_worker_definition`、`invoke_worker`、`propose_admin_proposal` | 管理员在试验工作区的 Principal | `admin_agent` 会话 | 起草者是智能体 |
| 试验 | `create_connection`、`publish_skill` ×2、`publish_worker_definition` | 同一个 Principal | 无 | 人录凭证、人发布 |
| 试验 | `action_request.approve` | 同一个 Principal | 无 | 人批准试跑的写动作 |
| 平台 | `apply_platform_segment` | 管理员本人 | 无 | `proposedByUser` = 管理员 |
| 目标 | `change_item.apply` ×4 | 所有者在目标工作区的 Principal | 无 | `origin: agent`，`adminProposal.proposedByUser` = 管理员，`confirmedBy` = 所有者 |
| 目标 | `apply_admin_proposal_segment`、`enable_gate_instance` | 所有者 | 无 | 应用人是所有者 |
| 目标 | `change_segment.verify` | 所有者 | 无 | `trigger: system`：应用自带的验证，没人手动调 |

**读法**：
- 起草者（智能体，带会话）和确认人、应用人（人，不带会话）在每一行上都分得开。
- 确认人和应用人是同一个人：这是设计，所有者逐项确认后自己应用。
- 两个不同的人（管理员 ≠ 所有者）这条路旅程没走，由 APS「F12」等集成测试覆盖。

**成本**：
- fake-llm 不花钱。
- 真实模型：第一轮只走到第一步，三次调用约 6 万 token，staging 不记价（§2.2）；整条旅程的成本等第二轮。
- 预演一整轮（升级加 S1–S4）在 GitHub runner 上约 42 分钟（job 127652862358 的 Rehearse 一步，01:35–02:17 UTC）。

## 8. 过程上学到的

- **端到端旅程找到的是语义缺口，按能力写的测试找不到。**
  - §4 的四个缺口里，三个（Worker 没门、验证不探门、要手动验证）是把各个能力串成一条旅程之后才暴露的。每个能力自己的集成测试都是绿的。
  - 以后一个波次的 fake-llm 旅程要排在最后一个能力 PR 之前写，不要等全部合完。
- **领域名要在第一个迁移之前定。** AA3b-1（#916）审查中途把「ChangePlan 提案」改名为 AdminProposal：表、能力、线上契约、错误码、文案、文档
  一起改，叠在它上面的 #920 也跟着改。好在迁移还没合入；合入之后再改就要一个改名迁移。
- **预演红在脚本自己身上的时候最贵。** AA5c 连红三次都是脚本的错：读错字段名、计数没按自己建的资源收窄、预览键清单写错。每红一次就是
  一整轮约 40 分钟的预演。旅程断言一律按自己建的资源 id 收窄，字段名照 wire schema 读。
- **测量脚本里扮演人的那一段，也得做人会做的核对。** 真实模型旅程（#981）的初稿只在看到待批请求时才数工单，审批要是被整个绕过，
  反而会记成「模型没做到」；它还会把模型写的平台改动全部确认，再把正式凭证录进去。#488 和 #481 各自审出了这两处。
  - 不变量要在旅程停在哪一步都能检查：最后再数一次工单，和人批过的请求数比。
  - 替人确认之前，先核对形状。
  - 扮演人的那句话也要把人会给的信息给全。第一轮只说了名字没给地址，智能体停在第一步，看不出是模型的问题还是题目的问题。
  - 测量要能看出停下的原因。公开仓库不能记回复原文，就记有界的形状标记；读用量要等异步上报落库。
- **方案里写的现状要拿实际配置核对。** 前提 ② 的「分支保护只要求 4 个检查」是对的，但不完整：管理员可以绕过这件事，到写本文读 API 时才看到。
- **主机落后的跨度在变大。** AA1–AA5 横跨 v0.59.0–v0.62.0 和之后未发的版本，主机一个都没有。光 AA1–AA5 的迁移就有 core 0049–0053、
  governance 0032–0039、task 0013、worker 0013，v0.51.0–v0.58.0 的 W1、W4 迁移另算。建议 AA5d 发版后就开一个主机窗口，把 §2.3 补上。

## 9. 遗留与下一步

- 交 steward 登 P3 遗留：§3 第 15 行（试验工作区被清除之后自接例外关闭的测试）、第 16 行（管理员发起的 Task 的执行类动作走普通
  ActionRequest 的内核测试）。
- §2.2：第一轮已记。#985 合入后跑第二轮，结果补进 §2.2 和 §4，由 steward 记 STATUS。
- §2.3：维护者转回主机结果后补结论。
- D-W5：维护者看 §4–§6 定。在那之前不排 AA7–AA10。
