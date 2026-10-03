# 代码复审（2026-10-02）：v0.35.1 全项目审查 + 遗留盘点

> 本文是 S9 D4 之后的第三次全量复审，同时做一次遗留盘点。它记录**发现、判断与修复排期建议**；
> STATUS §4 只登记条目与归属，细节在这里。
>
> - 分级沿用 STATUS §4 的口径：
>   - P1：破坏不变量、授权、公开仓库红线、数据完整性、可靠性；
>   - P2：加固、运维正确性、失败处理；
>   - P3：语义漂移与文档漂移。
> - 文中 `file:line` 一律以审查基线 `d498a2d` 为准（v0.35.1 + D4 探针；之后合入的只有 D4 文档、#392 的 CI 配置（一行配置加两行注释）与 #394 的一行提示文字，不影响任何行号引用）。
> - 根因簇编号 R-01…R-71、决策编号 D-01…D-30 供 STATUS 与后续 PR 引用。

## 1. 范围与方法

- **车道**：12 条只读审查车道，每条由一个 opus 子代理通读，并自报覆盖面（"略读冒充通读比如实写没读更糟"）。
  - L1：kernel `governance/`、`interfaces/`、`adapters/`、`cli/`；
  - L2：`application/gateway/`，44 个文件，约 1.44 万行；
  - L3：`substrate/*`、`application/task/`、`application/worker/`；
  - L4：其余 `application/*` 与**全部迁移**；
  - L5：`shared`、`platform-extension`、`agent-host`；
  - L6：supervisor、llm-proxy、egress-proxy、gatekeeper-base、两个门、采集器；
  - L7a / L7b / L8a / L8b：web 控制台四块；
  - L9：脚本、部署、compose、Dockerfile、CI workflow；
  - L10：STATUS、runbooks、线上契约文档、发版 / 恢复脚本，以及全仓红线扫描（1397 个入库文件）。
- **复核**：190 条原始发现里，88 条 P1 / P2 由另外四个复核代理（V1–V4）逐条回到代码独立复核：
  **79 条确认、9 条可能（前提条件不确定）、0 条推翻**。复核者改判过严重度，并修正过部分修法（见 §4、§5 各条）。
  - 升为 P1：L1-7、L2-6、L2-10、L10-4；
  - P3 升为 P2：L2-14、L6-14、L10-11；
  - 降为 P2：L2-3、L6-3；
  - 降为 P3：L2-11、L3-7、L7a-3、L7b-1、L8a-4、L9-3、L10-2。
- **合并**：同一根因的发现合成根因簇，结果是 **71 个根因簇**（11 个 P1、60 个 P2）、**98 条 P3**、
  **30 项待维护者决策**（产品或语义选择，而不是纯 bug）。
  - 判定以复核者为准：复核者的结论、严重度和对修法的修正覆盖车道原文。
  - P3 没有复核，复核者明确改判或合并过的标"(V)"。
- **没有做的**：
  - 本机没有跑测试套件，也没有在主机复现任何一条；
  - 测试文件（`*.test.*`）按设计不在审查范围内，只在核对某条发现时读过。
- **跨车道缺口**，即没有任何车道端到端读过的部分：
  - 17 份 runbook（add-* / host-* / demo / key-rotation / observability / troubleshoot-task / web-console）；
  - `ontology/*.yaml`，其中入口与 ops-runner 的 prompt 是 agent 能力边界的一部分；
  - `shared/src/wire/readiness.ts`（未读）与 `wire/platform.ts`（略读）；
  - `fake-invoke-worker.ts`、web 样式、`accept_s3.sh` / `demo.sh` / 两个 chaos 脚本（只 grep 过）；
  - 两份设计文档只按车道相关部分读过。
- **备注**：L9 审查 `reversibility-probe.yml` 时它还在分支 `1f7b156` 上，没有发现问题。合入版与之相比只多了 #392 的
  `package-json-file: head/package.json` 三行（已用 `git diff` 核对）。
- 完整的英文工作底稿（逐条失败场景、各车道报告、复核表）保存在维护者本地的 `docs/private/review-2026-10-02/`，不入库。

## 2. 总体判断

**核心治理闭环成立。** 前两次复审的修复绝大多数仍然成立（§3.2），具体包括：

- 内部平面鉴权、自批拦截、`request_action` 幂等、`entryScope` 按角色收窄；
- 出网在代理内解析、门凭证不经内核；
- web 端四条车道都没有发现客户端自行判权。

问题集中在六类结构性弱点。都不是"某处少一个 if"，而是**同一个概念在系统里有多种含义**：

1. **内部信任是平的。**
   - 一把 `internal_token` 被 7 个服务持有，包括全部门，路由不分调用方（R-03）。
   - 一把 `gate_token` 会发往 owner 自填的地址（R-01）。
   - 内核会抓取 owner 给的 URL，而且没有出站目标谓词（R-27）。
   - llm-admin 改上游即可外带供应商 key（R-23）。
   - 这是 P-B1 / P-B2a 以后的累积债：`gate-token.ts` 写明的"拆分 token"理由已经不成立。
2. **"已吊销"有多种含义。**
   - HTTP 每请求重新认证，WS 只认证一次（R-05）。
   - 重置密码写的是 `sessions.status`，而校验从不读它（R-12）。
   - 改密什么都不吊销（R-13）；吊销列表在 5000 行处截断（R-14）。
   - 客户端既检测不到被吊销（R-16），登出失败时也不清会话（R-15）。
3. **"人类通道"不等于"一个人"。**
   - service principal 可以批准、核实、裁决（R-17）；
   - 却不能被停用、轮换或改角色（R-06）；
   - `issue_service_handle` 接受内部主体（R-36）；
   - auditor 并不只读（R-35）。
   - 底线 2 的"必经审批"是否意味着"必经一个人"，需要维护者明确（D-06）。
4. **失败路径不收敛到已知状态。**
   - spawn 失败后 Handle 仍然有效（R-09）；`restore.sh` 部分失败也报成功（R-11）。
   - 遗留 104 的修复不完整（R-48–R-51）。
   - Turn 停了还会跑，终态还会被覆盖（R-55）；`apply-release.sh` 失败后不留回退点（R-71）。
5. **读模型与执行谓词分叉。**
   - 就绪度显示"已排除"，执行照样成功（R-37）；
   - owner 的收窄显示为生效，运行时却忽略（R-21）；
   - 连接器"禁用"的确认文案承诺了内核并不做的切断（R-41）；
   - 通配授权在控制台既看不到也撤不掉（R-26）。
6. **控制台的人控边界披露不足。**
   - "总是允许"实际作用于整个工作区（R-20）；
   - 治理放宽被低报（R-19）；授权会静默附带审批权（R-39）；
   - 不可逆确认会保留上次输入（R-44）；冲突裁决看不到证据（R-47）。

**红线**：全仓扫描只发现一处，即 `scripts/restore.sh:126` 的提示文字写着主机检出路径（R-07），已由 #394 改成 `<CODE_DIR>`。
该字符串仍留在 `6ce0400` 之后的 git 历史里，不建议改写历史，记录在 `docs/private/`。
三条设计底线**没有被直接突破**，但下面几条构成可绕过的路径，按 P1 处理：

- R-01 绕过审批与审计；
- R-02 伪造溯源、绕过 I5；
- R-03 劫持 agent-host 链路；
- R-04 跨工作区读取他人 agent 会话。

## 3. 遗留盘点：前两次复审与已关闭遗留的回归结果

对照对象：

- `code-review-2026-09-04.md`（F1–F10、P0-A/B/C）；
- `code-review-2026-09-10.md`（§2–§6、G1–G9）；
- STATUS §4 已关闭的行，以及今天关闭的遗留 99、104、105。

### 3.1 已回归或修复不完整（价值最高）

| 已记录的修复 | 结论 | 证据 | 新编号 |
|---|---|---|---|
| **遗留 104**（今天关闭）：apply 超时 → indeterminate → reaper 重放 | **不完整** | ① 60 s 预算只覆盖响应头，不覆盖响应体（L1-6）；② drain 遇到 indeterminate 行会继续往下跑，`executing` 不是屏障（L1-4、L2-14）；③ reaper 重放会先跑前置检查，可能不问门就标 `failed`；重放遇到 409 也标 `failed`；重放抛异常会无限循环（L1-5、L2-4）；④ 门侧：预留从不释放，门崩溃后重放会再执行一次副作用（L6-5）。STATUS 只写了 `network_error` 未覆盖 | R-48–R-51 |
| **遗留 64**（#293 关闭）：`roll_entry_containers` 与新 Turn 的竞态 | **不完整** | advisory lock 仍然成立，但 `hasInFlightTurn` 在 RLS 下以 NIL principal 运行，看不到私聊 Turn；CI 测试播种的 Turn 不带 chat，与真实 Turn 不同（L4-1） | R-59 |
| **遗留 88**（#292）：内部主体不可签发 | **内核侧回归**（当时只修了 UI） | `issue_service_handle` 仍接受 `__gatekeeper_service__` / `__draft_reaper__`（L2-12） | R-36 |
| **09-10 G3 / 遗留 18**：Handle 通道按角色收窄 `entryScope` | `ensureEntryHandle` 与 `issue_handle` 成立；**第三个签发者不成立** | `issue_service_handle` 忽略 service principal 的角色；`authorize.ts:63-66` 所说"每个签发者都传角色"不属实（L2-12） | R-36 |
| **遗留 36**：`create_connection` 拒绝平台门地址 | 按原文成立，但**威胁模型划窄了** | 平台 `gate_token` 仍会发往 owner 自填的任意 endpoint，caddy 也对外暴露 `/gate-host/i/*`（L1-1、L2-10）；`manifestSource` 完全不检查（L10-1） | R-01、R-27 |
| **遗留 85**（#372）：i18n 基线清零 | **没有被强制** | `i18n-pairs.mjs` 及其测试从不在 CI 里跑（L9-9）；确认层、`ApprovalCard`、`FollowPill` 仍有双语拼接（L7b-8） | P3 |
| **遗留 58**：llm-proxy / models 纳入备份 | **同类问题重开** | `gate-host/`（凭证与幂等存储）仍不在备份里（L9-3） | P3 |
| **09-10 §4 #3**：`export_prov` "501 / 未实现"的过期注释 | **未修** | `substrate/audit/index.ts:9-10`、`reference-tool-aliases.ts:32`、`handlers.ts:256-258`、`operations.md:224` | P3 |
| **09-10 §4 #7**：docker-events 流在 stop 竞态时不销毁 | **仍未修** | `worker-supervisor/src/docker-events.ts:168`；唯一调用方会退出进程，生产无影响 | P3 |
| **内核 `884d764`**：按订阅去重聊天推送 | 服务端成立；**客户端又套用了已删除的规则**（`ws-client.ts:478-489`） | 潜在的契约错配：目前没有任何生产者组合会乱序推送（V4 判为"可能" / P3） | P3 L7b-1 |
| **遗留 25**（标为关闭） | **状态有误** | 2026-09-19 的复现及其后续"查派发时序"记录了但没做（L10-6） | STATUS |

另有三条不是"修复回归"，而是后来的改动让当初的前提失效：

- **P-A1（#168）**：`create_principal` 改为建 `kind='service'`，`assertHumanTarget` 与模块文档却仍假定"人类"，导致 service principal 无法吊销（R-06）。
- **P-B1 / P-B2a**：三个门都挂了 `internal_token`，与 `gate-token.ts:23-28` 写明的拆分理由矛盾（R-03）。
- **#312（控制台重设计 P2）**：删掉了 `AccessPage`，那是唯一能列出并撤销通配授权与非 gatekeeper 授权的界面（R-26）。

### 3.2 核对后仍成立的修复（摘要）

- **内核**：
  - 09-04 P0-B / F1：内部平面 bearer、workers 子网对端拒绝、未配置即拒；
  - F3：自批拦截、授权变更吊销入口 Handle、`set_auto_approved_action_kind` 范围检查；
  - F4：`request_action` 幂等与 stale-executing reaper，其漏洞即 R-48；
  - F5 / F10；09-10 §2.1–§2.3（G1–G3，第三签发者除外）；
  - I11 审计与派发同事务；
  - 遗留 16、17、21、24、31、39、54、96–100、105（内核侧）。
- **运行时服务**：
  - F6：llm-proxy 路径白名单、未知来源拒绝出网、resident 按 jti 轮换；
  - F7：门 token、预留再调用、`redirect:'error'`、TLS 开关拒绝；
  - G4：预算拦截，但被 R-10、R-67 削弱；
  - G6：门容器加固；G8：reconcile 后的拒绝表。
- **web**：
  - 四条车道都确认"所有角色门只隐藏入口，由内核判权"；
  - S4.1 尝试栅栏、Markdown XSS 策略、认证材料只放 sessionStorage、切换工作区与登出的竞态栅栏；
  - S2.13：凭证从不进入 `audit_records`。
- **运维**：
  - F9：`:?` 插值守卫、healthcheck、全部非测试服务三项加固、备份挂载收窄、在线恢复先停服务；
  - CI action 按 SHA 固定；
  - 今天修的 apply-release 拉取退出码。
- **迁移**：v0.10.1 之后每个迁移在 release.md §6 可逆性表里都有一行，没有"实际不可逆却标为可逆"的。
- **STATUS 已关闭行抽查**：6、11、59、70、79、83、85、87、89、91、93、94、96–101、104、105，代码里都在。
  - 70 号写错了组件名；97 号对 `request_action` 的描述有误；104 号不完整，见上表。

### 3.3 STATUS §4 行文需要更正的（本 PR 已改）

- **6**：已关闭，但 `platform_status.backup` 在内核、契约文档、`operations.md` 和控制台四处仍写"未配置"，见 D-28。
- **45**：离职流程依赖停用，而停用目前切不断在线 WS（R-05）。
- **49**：内联样式计数从 131 漂到 136。
- **70**：概览用的是 `GraphFreshnessTile`，不是 `GraphFreshnessNotice`。
- **97**：只有执行类与未分类的人类 `request_action` 需要 Grant，观察类不需要。
- **103**：补充缺失索引一事（R-66）。
- **105**：内核侧成立；agent 侧的提示与 prompt 不完整（P3 L5-6）。

## 4. P1：11 个根因簇

每条的"修法"已并入复核者的修正。"决策"一栏指向 §7，带决策的条目要等维护者拍板后再动。

### R-01 共享 `gate_token` 会发往 owner 自填的地址，caddy 又暴露 gate-host `/i/*`，可以绕过审批与内核审计

- **成员**：L1-1、L2-10（V1 升为 P1 并合并）。**量级**：L（其中 caddy 收窄是 S）。**决策**：D-01。
- **现状**：
  - 内核对每个门请求都带同一把平台 `gate_token`（`adapters/gatekeeper-client/index.ts:167,182`）；
  - `create_connection` 只拒绝目录里已知的门地址（`connection-handlers.ts:248,270-272`）；
  - `deploy/caddy/Caddyfile:157-161` 把 `/gate-host/i/*` 整段对外转发。
- **失败场景**：
  1. 工作区 owner（不是平台管理员）把 `endpoint` 指向自己的服务器，就能拿到 token。事务随后回滚，什么记录都不留。
  2. 拿着这把 token 经 caddy 直接 POST `/gate-host/i/<id>/gate/apply`，管理员配置的实例凭证就会执行：没有 ActionRequest、没有 Policy、没有审批，也没有内核审计。
- **修法**：
  1. **立即**：caddy 只转发 `/gate-host/i/*/gate/connected-accounts`。
  2. 平台 `gate_token` 绝不发往内核没有供给的 endpoint。自连 / BYO 门在 `create_connection` 时铸一把每连接独立的密钥。
     V1 指出这是**必需**的：`registerGateAuthGuard` 只认平台 token。
  3. 对 `endpoint` 套用 R-27 的出站目标谓词。
- **依赖**：R-27（共用谓词），与 R-03 协调。

### R-02 溯源锚点（Source、Activity）不核对归属：任何主体（含 auditor）都能往别人的 Source 写入、挂到别人的 Activity 上

- **成员**：L2-1、L3-1、L2-6（V1、V2 升为 P1）。**量级**：M。**决策**：D-03。
- **现状**：
  - `submit_observations` 不检查 Source 的 owner（`ingest-handlers.ts:426-447,474-477,512-524`）；
  - 观测表 RLS 的 `with check` 只看可见性（core 0002）；
  - `assert_fact` / `supersede_fact` 接受调用方给的 `activityId`（`fact-handlers.ts:75-85`）。
- **失败场景**：
  - 用采集器的 `activityId` 往自己的私有 Source 提交一条 Observation，该 Activity 上的全部 Fact 就对所有人隐藏，包括采集器自己；采集器从此永远报告"无变化"。
  - 用采集器的 `activityId` 断言，会不开 Conflict 直接 supersede 采集器的 Fact（绕过 I5），`explain` 还会把它归到采集器名下。
- **修法**：两道检查同一个 PR 发，只修一道另一条路仍开着。
  - (A) `submit_observations` 要求 Source 的 owner 是调用者，并通过迁移把 `with check` 收紧为 owner-only。
  - (B) 调用方给的 `activityId` 必须满足 `activities.started_by = caller`；或者按 D-03 推荐，从临时写入里删掉这个参数。
  - 先在主机跑一个检测查询（同一 Activity 上出现多个 Source owner 的 Observation），再决定是否修数据。

### R-03 一把不分路由的 `internal_token` 被 7 个服务持有（含全部三个门）；第二条 agent-host 连接会顶掉第一条

- **成员**：L1-7（V1 升为 P1）、L6-1。**量级**：L。**决策**：D-02。
- **性质**：纵深防御，前提是某个持有方先被攻破。但它让 P-B1 实际降低了隔离，违背 `gate-token.ts:23-28` 写明的设计。
- **失败场景**：被攻破的 gate-host 打开 `/internal/agent-host`，就能收到所有用户的下一个 `startTurn`（prompt + 入口 Handle）。同一把 token 还能：
  - 注入运行时事件；
  - 伪造 `/internal/llm-usage`（对全体做预算 DoS）、llm-admin 审计行和出网行；
  - announce manifest，为 R-18 提供入口；
  - 调用 supervisor `/resident/reclaim`。
- **修法**：
  - 按调用方类别分 token，或从一个根密钥 HMAC 派生每服务 token；
  - `internal-auth.ts` 按路由设调用方白名单；
  - 第二条 agent-host 连接按 `instanceId` 固定或直接拒绝，不再替换；
  - 订正 `gate-token.ts` 与 `internal/llm-admin-audit.ts:25-27` 的注释。
- **是 R-18 的前置**。

### R-04 docker 门让任何关联它的工作区能读别人的 agent 会话（对入口 / 任务容器 `container.logs_tail`），且自动批准

- **成员**：L6-2。**量级**：S。**决策**：D-04。
- **现状**：
  - pi 的 RPC 走容器 stdout（`deploy/worker-runtime/entrypoint.sh:165`）；
  - supervisor 建容器时不设 `LogConfig`，日志进 docker 默认的 json-file；
  - docker 门对目标容器不做任何筛选。
- **失败场景**：关联了 `gatekeeper-docker` 的工作区成员列出容器，再 tail `nexttime-entry-<B>`，就能跨工作区拿到 B 的 prompt、工具调用和工具结果，全程没有 ActionRequest。
- **修法（V3）**：
  - 门拒绝对带 `nexttime.role` 标签的容器、以及平台自身 compose 项目的容器做 `logs_tail` / `inspect`，并从 `containers.list` / `compose.ls` 的结果里滤掉。
  - 仅把 `logs_tail` 改成不可自动批准**不够**：工作区 A 的审批人照样能批准读取 B。

### R-05 停用、登出、重置密码都切不断已建立的 `/ws` 会话

- **成员**：L1-2。**量级**：M。**决策**：无。
- **语义漂移**：HTTP 每请求重新认证，WS 只在建连时认证一次（`interfaces/ws/server.ts:519-520,577-578`）。这也削弱了遗留 45 的离职流程。
- **失败场景**：owner 停用成员 B 之后：
  - B 已打开的标签页继续收到审批与任务推送；
  - B 仍能 `send_chat_message`，Turn 会拿到一个新的、未被吊销的入口 Handle，LLM 经 llm-proxy 照常回答；
  - B 正在跑的 Worker 直到 Task 结束都保有 LLM 访问。
- **修法**：
  - 人类 WS 通道每次调用都复查 `principals.disabled_at`、`users.status` 和控制台 `user_sessions` 行；
  - 增加一条 kick 总线：停用、登出、重置、`set_user_status` 时关闭对应 socket 并退订推送；
  - `ensureEntryHandle` 拒绝已停用的主体；
  - `disable_principal` 吊销所有 `on_behalf_of` 该主体的会话（entry、`mcp_session`、`worker_run`）。
- **必须与 R-16 同发**：否则每次强制断开都会变成客户端每秒一次的无限重连。

### R-06 `create_principal` 建出的 service principal 永远不能停用、轮换 key 或改角色

- **成员**：L2-2、L8a-1。**量级**：S。**决策**：D-05。
- **现状**：`members-handlers.ts` 的停用、轮换、改角色都走 `assertHumanTarget`，对 service 一律返回 409 `not_human`。
- **失败场景**：
  - owner 角色的 CI key 泄露后，只能停用整个工作区或直接改库。
  - 另外，"最后一个 owner"的判定两边不一致：工作区侧数任意类型的 owner，平台侧只数人类。结果是一个 service owner 能让最后一个**人类** owner 被移除。
- **修法**：
  - 允许对 `kind='service'` 执行 `disable_principal`、`rotate_api_key`，以及按 D-05 执行 `set_principal_role`；继续拒绝 agent 与内部主体；
  - 两边统一使用一个 last-owner 谓词；
  - 订正模块文档，补 service 类型的集成测试；
  - 内核修复上线前，UI 先隐藏会被拒绝的按钮。

### R-07 公开仓库红线：`scripts/restore.sh:126` 写着主机检出路径（已修）

- **成员**：L10-4、L9-12（V3 按类别升为 P1，实际影响低）。**量级**：S。
- **修法**：#394 已改成 `<CODE_DIR>`。
  - 待议：加一个 CI 守卫，检查**通用的**绝对主机路径模式。不能把私有路径本身写进守卫，否则守卫本身就泄露了它。
  - 历史里的字符串不改写，记录在 `docs/private/`。

### R-08 在待审的修订草稿上导入 manifest 会丢掉 `draftOf`，发布后同一个 Operation 身份出现两条 `published`

- **成员**：L1-3。P3 L4-13（同一 Gatekeeper 能有两条 `workspace_gate_links`）让触发更容易。**量级**：M。
- **失败场景**：
  1. X v1 已发布，agent 的 v2 修订草稿在待审。
  2. 启用关联到这个 Gatekeeper 的门实例时，`importManifest` 覆盖 v2 并把它发布，于是 v1、v2 同时是 `published`。
  3. `getPublishedOperation` 是 `limit 1` 且没有 ORDER BY，会返回其中任意一条。过期的、更宽松的分级可能被用来自动执行，遗留 79 的刷新审查也就被绕过了。
- **修法**：
  - `importManifest` 带上 `draftOf`；
  - `publishOperation` 把同一身份的其他 published 行全部 deprecate；
  - 查询加 `order by version desc`；
  - 给已发布的 Operation 身份加部分唯一索引：先查主机有没有既有重复，并在 release.md §6 补一行可逆性记录。

### R-09 spawn 失败与 `spawn_lost` 扫描会让 Task 失败，但 WorkerRun 的 Handle（可能还有容器）仍然有效

- **成员**：L3-2、L3-4；相关 P3：L6-18（create 成功、start 失败的容器 env 里留着 `CAPABILITY_HANDLE`）。**量级**：M。
- **破坏的不变量**：§5.5"terminated 吊销全部 Handle"。
- **失败场景**：
  - supervisor 客户端 30 s 后放弃，但 supervisor 还在启动容器。run 被标 `terminated`，Handle 却没吊销，reaper 也不会再扫已终止的 run。
  - 内核恰好在 run 进入 `running` 与 Task 状态翻转之间崩溃，Task 变成 `failed: spawn_lost`，Worker 却继续跑最多 3600 s。
- **修法**：spawn 的 catch 与 `spawn_lost` 扫描共用一个"Task 失败 + 回收其 run"的 helper：
  - 在事务内调用 `revokeWorkerRunAndDescendants`，即使带条件的 UPDATE 没抢到也照样执行（吊销是幂等的）；
  - 事务外尽力调用一次 `supervisorClient.terminate`。

### R-10（潜在）`openai-responses` 的用量永远被解析为 0，I18 预算与成本核算失效

- **成员**：L6-4。**复核**：可能，前提是配置了 `openai-responses` 供应商。**量级**：S。**决策**：D-09。
- **现状**：`llm-proxy/src/usage.ts` 按 Chat Completions 的格式解析 Responses 的用量；测试夹具形状也是错的（`usage.test.ts:83-93`）。
- **失败场景**：每次请求都记为 0/0、没有 `costUsd`，`llm-budget-exhausted` 永远不会触发。
- **修法**：二选一：
  - 写一个 Responses 用量解析器（读 `response.completed` 里的 `response.usage`、不再注入 `include_usage`），并修正夹具；
  - 按 D-09 推荐，先把这个 kind 从枚举里删掉。

### R-11 `restore.sh` 在失败或部分恢复时仍报成功，不是可靠的跨版本回滚

- **成员**：L9-1；叠加 P3 L9-7（升级前 dump 用目标 tag 命名）与 L9-8（EXIT trap 不响应信号）。**量级**：M。
- **影响**：release.md §6 的可逆性表依赖这个脚本。
- **失败场景**：
  - 跨一个"给已 dump 的表加了 FK"的版本回滚：DROP 被挡，CREATE 和 COPY 跟着失败，库里混着升级前后两种状态，脚本却打印 `restore: done` 和 `PASS rollback-restore`。
  - pg_dump 版本不兼容时什么都没恢复，表数量看起来却正常。
- **修法**：
  - 在线恢复先重建目标库（`DROP DATABASE … WITH (FORCE)` + `CREATE`），此时服务已停；
  - `pg_restore --exit-on-error --single-transaction`，任何非零退出即致命；
  - drill-restore 按 `pg_restore -l` 比对表与行数；
  - 补 L9-8 的 trap，修 L9-7 的命名。

## 5. P2：60 个根因簇（按主题）

量级：S 约一天或一个 PR；M 需要几天，可能带迁移；L 涉及跨服务或契约改动。"成员"列的是车道发现编号。
标 `*` 的两条，在对应决策取严格解释时升为 P1。

### 5A. 红线与安全：凭证、审批、隔离、供应链

| 编号 | 问题 | 修法要点 | 量级 | 决策 / 依赖 |
|---|---|---|---|---|
| R-12 | 吊销根因 c：重置密码与"吊销工作区会话"写的是 `sessions.status`，校验从不读它；API key 与 `mcp_session` Handle 存活，`mcp_session` 也不在可吊销清单里（L2-3、L4-18） | 重置时吊销该用户全部会话的 `capability_handles`，并清掉人类主体的 `api_key_hash`；`mcp_session` 列入可吊销清单；吊销函数只留一份；统一会话状态词表（`starting` / `active`） | M | D-25 |
| R-13 | 吊销根因 b：改密什么都不吊销；自助改密绕过密码策略（12 位最小长度不生效）；当前密码可以无限猜（L1-10、L4-7） | 两个改密路径都接上 `revokeAllUserSessions`（自助改密保留当前会话）；`assertPasswordStrength` 读平台设置；当前密码错误计入锁定 | S | — |
| R-14 | 吊销根因 d：`/internal/handle-revocations` 在 5000 行处截断，llm-proxy 把游标直接跳到 now（L1-12，可能） | 截断时返回 `nextSince`，代理循环拉取 | S | — |
| R-15 | 客户端吊销 1：登出失败时 HttpOnly 会话 cookie 仍存活，共用机器的下一个人刷新就进了上一个人的控制台（L7a-2） | 显示"登出未完成，重试"；内核在登出的每条响应路径上都清 cookie | S | — |
| R-16 | 客户端吊销 2：会话过期或被吊销后检测不到，WS 每秒重连一次直到永远（L7b-3） | -32001 停止重连并回登录页；-32002（成员关系没了）重读 `/api/auth/me`；瞬时故障用指数退避加抖动 | S | 与 R-05 同发 |
| R-17* | service principal 可以在"人类通道"上批准、拒绝、`verify_fact`、`resolve_conflict`，形成 agent → bot 的闭环（L2-7） | 四个能力共用一个 `principal.kind === 'human'` 检查；验收脚本走显式、有审计、受配置开关控制的例外 | S | D-06（若认定"必经一个人"即升 P1） |
| R-18 | 门 manifest 信任根：带 `identityMismatch` 的 announce 仍会覆盖已存 manifest；启用 / 刷新发布的是执行那一刻的公告，不是预览时看到的（L4-6、L8b-3） | mismatch 时不写 operations / target，也不算心跳；决定实例时固定 manifest 哈希，变更须管理员确认；刷新请求带上预览时的哈希，不一致则拒绝 | M | D-18；依赖 R-03 |
| R-19 | 刷新治理字段的确认框低报放宽（blast radius 降级、execute→observe），还声称"不会改变谁能调用"（L8b-3） | 内核预览按 op 返回 `direction`（复用 `classifyOperationGovernanceChange`）；放宽用 danger 层级并逐条写明后果 | S | D-17；依赖 R-18 |
| R-22 | HTTP transport 的路径参数 `.` / `..` 能把模板路径改到未发布的上级端点；`document.parse` 可以无人审批地 `POST /api/v1/chunks`（L6-8） | 拒绝空串、`.`、`..`；断言渲染后的路径保留模板的静态前缀；修正 base-path 前缀处理 | S | — |
| R-23 | llm-admin：改 `upstream_base_url` 或指定任意 `apiKeyEnv`，就能把存储的或 env 里的供应商 key 外带（L6-7、L6-19） | `api` 或上游一变就清掉存储的 key（与 gate-host 规则一致）；`apiKeyEnv` 走运维声明的白名单；审计上游的 old→new；`redirect:'error'` | S | — |
| R-24 | 供应商与 RAGFlow 的 key 以容器 env 传递，只读的采集器 socket proxy 能 inspect 读到，连同运行中的 `CAPABILITY_HANDLE`（L6-12） | 改用 compose `secrets:` 文件；收窄采集器 proxy（采集器从不 inspect） | M | — |
| R-25 | （潜在）采集器会把带凭证的 git remote URL 当作 Repository 身份（L6-3；现有 compose 下不可达） | 现在就剥掉 userinfo 与 query，`redact.ts` 清洗 `scheme://user:pass@` | S | D-27 |
| R-26* | 通配授权与非 gatekeeper 授权自 #312 起在控制台既看不到也撤不掉，却仍赋予 I14 审批权与自动批准规则资格（L8b-2） | 加"其他 / 通配授权"列表与撤销；按 D-14 收窄 `grant_capability` | S | D-14（若算底线 3 即升 P1） |
| R-27 | supervisor 的 `/task/:id` 路由不鉴权，内核抓取 owner 给的 `manifestSource` 就能打到它（终止别人的 Worker，审计行随事务回滚）；没有出站目标谓词（L10-1、L6-14） | 两条路由加 `requireInternal`；内核对 owner 给的 URL（`manifestSource`、`endpoint`）的所有抓取共用一个谓词，拒绝 compose 服务名与平台网段 | S+M | 与 R-01 共用谓词 |
| R-28 | `bindPrincipalToUser` / `claimIdentityOnClient` 搬移成员关系、改身份，都不写 AuditRecord（L4-5、L1-14） | 事务内写平台审计 `principal.user_rebound` 与 `user.identity_claimed`；CLI 子命令同样补上 | S | — |
| R-29 | 数据库没有按设计假设的那样约束写入：DELETE / UPDATE 授权多给了，吊销不是单调的（`revoked_at` 可以被清空），平台表没有 RLS（L4-10） | 回收不用的授权，按需配守卫触发器重新授予；`before update` 触发器保证吊销单调；`workspaces` / `platform_settings` 上 RLS；补可逆性行 | M | — |
| R-30 | llm-proxy 原样转发 agent 选的 header 与 body，供应商侧工具成了绕过 egress-proxy 的出网通道（L6-6，可能） | 入站 header 白名单；服务端工具类型默认剥离，除非 WorkerDefinition 显式开启并留审计 | M | D-29 |
| R-31 | 出网策略把 `0.0.0.0/8`、`::` 判为公网，agent 能打到 egress-proxy 的回环管理口（L6-11） | 这些地址连同组播、`240/4`、广播一起判为非公网 | S | — |
| R-32 | `host-env-init.sh` 让 Caddy 内部根 CA 私钥变得所有人可读（L9-2；主机侧状态从仓库无法核实） | 删掉 `:328`；下次主机应用时一次性执行 `chmod -R o-rwx`；订正 runbook；按 D-30 决定是否轮换 CA，结果记 `docs/private/` | S+主机 | D-30 |
| R-33 | 镜像签名 job 让第三方 action 拿到 OIDC 与推送 token，可以推送并 keyless 签名 `pull-images.sh` 会信任的镜像（L9-4） | 拆成 `build-sign` job（只有 checkout / buildx / push / cosign）和不带 `id-token` 的 `scan` job | S | — |
| R-34 | 真实 API key 与 Handle 走进程 argv：验收套件在生产主机上跑，chaos 脚本按位置参数收 key（L9-5） | 改用 `docker compose run -e`，driver 从 env 读；chaos 脚本从 0600 文件读并用 `curl -H @file`；清理阶段吊销验收 key | S | — |

### 5B. 授权与治理语义

| 编号 | 问题 | 修法要点 | 量级 | 决策 / 依赖 |
|---|---|---|---|---|
| R-35 | auditor 不是只读：满足 `minRole:'member'`，能调写能力（`invalidate_fact`、`deprecate_operation`、`invoke_worker`…）；它的 agent 在 Handle 通道上能观察所有门（L1-9、L5-5） | `authorize`、`entryScope`、门路径共用一个角色谓词；**不能**拿 `mode === 'observe'` 当只读判据 | M | D-07、D-08 |
| R-36 | `issue_service_handle` 接受内部主体，并忽略 service principal 的角色（遗留 88 / G3 在第三个签发者上回归）（L2-12） | 拒绝内部主体；按主体角色收窄 scope；订正 `authorize.ts:63-66` | S | — |
| R-37 | 执行权不按当前 AgentProfile / AgentPolicy 复查：`set_agent_policy` 不吊销任何东西，`issue_handle` 也不收窄（L2-8、L2-17） | Handle 通道执行时与 `onBehalfOf` 当前的 `effective.enabledGatekeepers` 取交集；`set_agent_policy` 吊销入口会话；`issue_handle` 同样收窄 | M | D-20 |
| R-38 | 审批推送的持有者扇出不看角色，也不看停用状态，无权审批的 member 会收到别人的审批卡（L1-8） | 持有者 = 角色满足 `approve` 的 `minRole` + 状态有效 + 持有匹配 scope，与审批人共用一个谓词；owner 查询过滤 `disabled_at` | S | D-13 |
| R-39 | 给 operator+ 授权一个门，会静默让他成为该门所有动作的审批人，界面不告知（L8b-4） | 按 D-13：在授权提示、卡片、撤销文案里写明审批效果；或在内核拆开两种权限 | S/L | D-13 |
| R-40 | 连接器三态在 `create_connection` / `request_connection` 上不生效，ssh 设为 `disabled` 后 owner 仍能直接自连（L2-9） | 连接器不是 `self_serve` 就拒绝 | S | D-19 |
| R-41 | 连接器"禁用"的确认框告诉管理员"所有工作区都会被切断"，内核却让既有关联照常可调（L7a-1） | 按 D-19(a) 订正文案，并在同一个确认框里提供"禁用全部 Operation"（拒绝名单）作为真正的切断手段 | S | D-19 |
| R-42 | `get_action` 把任意 ActionRequest（含 `params`，例如 ssh 命令行）返回给任意 operator；注册表与设计都声称 I14 可见性（L10-3） | 与 `list_action_requests` 同一谓词，并允许请求者本人查看；对齐注册表与设计表 | S | D-22 |
| R-43 | 并发请求能绕过登录锁定，C 个并发就是每 5 分钟 C 次猜测（L4-4） | 验证前原子预留一次尝试（带条件的 `update … returning`），或按 login 取事务级 advisory lock；考虑给登录接口限速 | S | — |

### 5C. 控制台的人控边界

| 编号 | 问题 | 修法要点 | 量级 | 决策 / 依赖 |
|---|---|---|---|---|
| R-20 | "总是允许"写的是按裸 Operation 名、整个工作区、跨所有门与请求者生效的规则；界面却说成"这个请求"，`high` 也提供这个选项（L8a-3） | 按 D-15 改为以 `(gatekeeper_id, action_kind)` 为键并迁移既有行；先发文案与确认的修正，并对 `high` 隐藏 | S/M | D-15 |
| R-21 | `allowMemberAutoApproveLow`：owner 的收窄显示为生效，运行时却忽略；画像表单会把"继承"写成显式值，还可能把画像锁死，再也存不了（L8a-2） | 按 D-16 统一一个语义，运行时、resolve、UI、两份文档一起改；若定为强制收窄，**同一改动里**把编译默认值翻成 `true` | M | D-16 |
| R-44 | 不可逆确认框关闭再打开后，保留着上次输入的目标、勾选的确认和错误信息，一次点击就能删除（L7b-4） | `open` 变 true 时重置状态，或按打开次数给 key | S | — |
| R-45 | `merge_user` 硬删除用户，只有行内两次点击确认，目标可以是任意账号（L7a-4） | 用 `irreversible` 层级并输入目标 login；列出将要搬移的工作区与角色 | S | — |
| R-46 | 删除门实例会销毁其存储的凭证，只有两次点击确认；内核会拒绝时按钮也照样显示（L7a-5） | `enabledWorkspaceCount > 0` 时禁用按钮；否则用 irreversible 层级并写明"凭证将被销毁" | S | — |
| R-47 | 冲突裁决是盲选：面板不显示两条 Fact 的值、来源和对象（L8b-5） | 渲染两条 Fact（`explain` / `state_at`），至少给每一边链接到对象视图或溯源抽屉 | M | — |

### 5D. 遗留 104 后续与执行可靠性

V1 把遗留 104 拆成四个可以分开修的子问题（R-48…R-51）。V3 要求重放语义的内核半边与门半边（R-48 + R-51）同发。

| 编号 | 问题 | 修法要点 | 量级 | 决策 / 依赖 |
|---|---|---|---|---|
| R-48 | 104-1：reaper 重放可能不问门就标 `failed`（先跑了拒绝名单等前置检查）；把 409"仍在执行"当作失败；抛异常的行会被无限重放（L1-5、L2-4、L6-5 内核侧） | 专用重放路径：跳过前置检查，总是去问门；409 时保持 `executing`；持久化尝试计数，N 次后标 `failed: outcome_unknown`；订正注释 | M | D-11；与 R-51 同发 |
| R-49 | 104-2：门客户端的超时不覆盖响应体；owner 的端点慢慢吐 body 就能耗尽 pg 连接池（L1-6） | abort 一直挂到 `json()` 结束；读 body 期间的 abort 映射为 `GatekeeperTimeoutError`；限制 body 大小 | S | — |
| R-50 | 104-3：按 Gatekeeper 单飞、升序执行并没有被保证，`executing` 不是屏障，后面的行会越过它先执行（L1-4、L2-14） | 队列读取包含 `executing` 并在它处停下，遇到 `indeterminate` 也停；配合带条件的 `start_execution`，不需要锁 | S | D-10 |
| R-51 | 104-4（门侧）：apply 预留失败后从不释放；ssh / cli 没有执行超时；预留只在内存里，门崩溃后重放会再执行一次（L6-5 门侧、L6-15、L6-17） | 传输或凭证失败时以失败结果完成该键；执行超时低于内核的 60 s；ssh 加 `-n`、`ConnectTimeout`、`ServerAliveInterval`；拒绝映射为 4xx 并释放预留 | M | D-11；与 R-48 同发 |
| R-52 | outbox 派发器是单条串行循环，审批 drain 的消费者在循环里内联执行门 `apply`，一个 restart 就堵住全平台 `TurnStarted` 约 30 s（L4-3） | drain 改为 fire-and-forget 并带 `onError`（周期 drain 兜底），或给它单独一个 worker | S | — |
| R-53 | `request_action` 的默认幂等键让任何更早的终态行变成永久答案：失败后重试会重放旧行，合法的重复请求拿到第一次的 `executed`（L2-5） | 按 D-12 把默认键限定在非终态行（部分唯一索引 + 同条件查询）；可选的客户端 nonce | M | D-12 |
| R-54 | `invoke_worker` 没有幂等键，客户端超时也不算第一阶段的 spawn 时间，超时后模型再调一次就起第二个 Worker（L5-4，可能） | 加 `idempotencyKey` 并派生默认值；客户端超时 = 第一阶段预算 + wait + 余量 | M | D-12 |
| R-58 | 崩溃重试路径没有守卫：并发反应会重复 spawn，Task 被取消后仍可能重试 spawn（L3-3） | 带条件地递增 `retry_count`；只有本次 terminate 真的移动了 run 才 spawn；`spawnWorkerRun` 复查 Task 非终态 | S | — |

### 5E. 运行时状态与生命周期

| 编号 | 问题 | 修法要点 | 量级 | 决策 / 依赖 |
|---|---|---|---|---|
| R-55 | 已停止、中断或失败的 Turn 仍可能开始或结束，终态会被覆盖；用户在 `TurnStarted` 投递前按 Stop，agent 照跑（L4-2、L5-3） | 带条件地结束（`where status='running'`）；消费者与 `startTurn` 跳过非 running 的 Turn；accept 超时时发 `stopTurn`，且 accept 超时大于 spawn 预算；三个写入方共用一张 Turn 转移表 | M | — |
| R-56 | WS 抖动时 agent-host → 内核的帧被静默丢弃，聊天卡死直到内核重启（L5-2） | 每个 Turn 一个有界缓冲，`hello` 后刷出；至少在重连后重放终态；双向 ping/pong | M | — |
| R-57 | `get_entry_context` 读即消费，但注入是逐次 LLM 调用、不持久化的：Task 结果与审批更新会丢，或者落到别的聊天里（L5-1） | 按 D-23 在 `report_turn` 时确认；条目归属发起它的聊天；交互 / MCP 调用方用 `peek` | M | D-23 |
| R-59 | `roll_entry_containers` 的进行中检查在 RLS 下看不到真实 Turn，遗留 64 的修复无效（L4-1） | 用 `setWorkspaceContext(client, ws, residentPrincipalId)` 做检查；测试改用 `newChat` + `sendChatMessage` 造 Turn | S | — |
| R-60 | 本体发布没有基线版本检查：两份同基线的草稿，过期的那份会静默删掉别人已发布的 LinkType（L3-5） | 草稿保存基线版本；基线之后已有更高版本发布时返回 409 | M | — |
| R-61 | 本体提案的 diff 是对照调用者视角的命名空间算的，提案人的真实改动被隐藏，其他族的类型全显示为"已删除"（L8b-1） | 内核给出该族的已发布基线；UI 只在草稿所属的族内做 diff | M | 依赖 R-60 |
| R-62 | `record_decision` 存非 UUID 的 id，一个坏值就让全工作区按 objectId 过滤的决策查询永久报错（L3-6） | 写入时校验 UUID，**并**在 SQL 里先按 UUID 模式过滤再 cast，让已存的坏行不再拖垮读取 | S | — |
| R-63 | WS 断线期间丢失的按主体推送，重连后不会补同步：新审批不出现，已决审批仍显示可点（L7b-2） | 重连后发出"已重新同步"信号，能力 hook、待办计数、审批队列、Tasks 页据此重载 | M | — |
| R-64 | 切换工作区失败会静默登出一个正常的会话；成员关系是登录时的快照（L7a-6） | 切换失败时保留当前会话，只关闭新 socket 并提示错误；自己的成员关系变化后重读 `/api/auth/me` | S | — |

### 5F. 数据、计量、运维

| 编号 | 问题 | 修法要点 | 量级 | 决策 / 依赖 |
|---|---|---|---|---|
| R-65 | 工作区清除用 `ALTER TABLE … DISABLE TRIGGER`，清除期间冻结全平台的 `audit_records` 与 `links` 写入（L4-8） | 改用 `set local session_replication_role = replica` | S | — |
| R-66 | `observations(workspace_id, activity_id)` 与若干 FK 子列没有索引（L4-9，关联遗留 103） | `create index concurrently` 建四个索引；在主机上用 `EXPLAIN ANALYZE` 确认效果；补可逆性行 | S | — |
| R-67 | 用量去重键 `(workspace_id, jti, started_at)` 是毫秒精度，同一 Handle 下的并发请求会被合并（L6-13） | llm-proxy 为每个请求生成 UUID，内核按它去重 | S | — |
| R-68 | `/internal/llm-usage` 里一个有毒的工作区分组会让整个 POST 失败，所有工作区的计量一起卡住（L1-11，可能） | 按组隔离并返回逐组结果；工作区已不存在导致的 FK 违例视为永久拒绝，确认后记日志 | S | — |
| R-69 | `tools/list` 需要认证的托管 MCP 门永远无法接入（L6-9） | 凭证路由按 `table.get(gateId)` 解析；凭证存储成功后重建实例；补一个需要认证的测试夹具 | S | — |
| R-70 | 采集器的 RAGFlow 阶段把"读不到"当成"不存在"，一个完整窗口就让全部 KB / Document Fact 退役（L6-10） | 解包失败直接抛错，中止该阶段且不提交窗口；只有每一页、每个 KB 都读成功才提交窗口 | S | — |
| R-71 | `apply-release.sh` 失败后检出停在新 tag 上，可能留下一批提交了一半的迁移，且没有记录之前的 ref（L9-6、L10-11） | checkout 前记下 `HEAD` 与分支，`up` 之前失败就切回并打印；迁移失败后打印哪些文件已提交 | S | — |

## 6. P3：98 条（按区域，未复核）

P3 都没有复核，复核者改判或合并过的标 (V)。已被某个 P1 / P2 修法覆盖的不再重复列出，例如：

- L2-14 → R-50、L2-17 → R-37、L6-15 / L6-17 → R-51、L9-12 → R-07、L10-11 → R-71；
- 各簇修法会顺带订正的注释漂移。

建议随所在模块的修复波次顺手修，剩下的集中到 §8 的文档漂移波次。

### 6.1 内核（35）

- **契约与错误映射**：
  - L1-13：MCP `add_relationship` 别名映射到 `assert_fact` 已退役的参数，永远 `invalid_params`；
  - L2-13：`propose_*` 嵌套 `ZodError` 变成 500；
  - L5-13：拒绝时模型看不到 `code` / `details`；
  - L1-16 / L5-12(b) / L5-17：`/ws` 与 `/internal/agent-host` 没设 `maxPayload`（默认 100 MiB），`/ws` 没有认证截止时间，注册表文本字段没有 `.max()`。
- **可见性与权限语义**：
  - L2-11 (V，待 D-21)：`get_task` 对任意成员返回任意 Task 的 input / result；
  - L2-15 (D-26)：Operation 草稿对所有成员可见；
  - L2-16：`list_allowed_operations` 向没有 `request_action` 的 Handle 宣称可执行；
  - L5-9：`report_turn` 不绑定调用者正在运行的 Turn；
  - L3 §4 / L5-5 / V2 #6 (D-24)：各 registry 的发布权限不统一；
  - L1 §4：两种"持有该 action kind"的定义，operator 点"总是允许"实际上总是 403；
  - L5-7：入口模式静态注册了 5 个对非 builder 必然 403 的 `propose_*` 工具。
- **认知层与本体**：
  - L3-8：`verify_fact` 会提升已 superseded / invalidated 的 Fact；
  - L3-9：Procedure 两步指向同一目标时会 supersede 自己的 `steps` link；
  - L3-10：I-S5-1 把已退役的 Link 也计入，warn→reject 的切换条件永远达不到；
  - L3-13：discard 后下一个提案复用 `(id, version)`，是遗留 99 的副作用；
  - L3-14：同源并发断言在既有异源行时产生重复行；
  - L3-15：`find_workers` / `find_procedures` 先 `limit` 后过滤；
  - L3-12：I16 监控漏了 `publish_manifest`；
  - L3-7 (V)：Task 停车前不复查请求是否仍 pending。
- **数据库**：
  - L4-11：security-definer 函数信任调用方给的 `p_workspace_id`，`search_path` 缺 `pg_temp`；
  - L4-12 / L5-16：没有在库里强制"Fact 不能同时 superseded 与 invalidated"、"deprecated 本体定义不可改"、"人类主体必有 user"；
  - L4-13：同一 Gatekeeper 能有两条 `workspace_gate_links`，应加唯一索引；
  - L4-17：0021 自带 `begin/commit`，部分迁移没有取头注释所说的 advisory lock；
  - L4-16：`platform_settings_history.updated_by` 错位一版。
- **运行时与并发**：
  - L1-15：`expireOverduePendingApprovals` 第一行失败就中止整批；
  - L4-14：`roll_entry_containers` 的 session 级 advisory lock 在 DB 错误时泄漏；
  - L4-15：聊天自动标题、改名、归档、`stop_agent` 在事务提交前推送；
  - L4-18：几个"有界"去重 Set 实际无界；
  - L3-11：`ops.outbox_stuck` 分不清死信与派发器卡住，也没有死信 runbook。
- **审计**：
  - L1-14：CLI 变更不写 AuditRecord（`add-principal`、一年期 `issue-service-handle`、`set-password` 等），随 R-28 一起修；
  - L6 内核侧：`sourceId:'unknown'` 的出网拒绝只进 egress-proxy 的 stdout，不进平台审计。
- **注释与文档漂移**：
  - L10-7 等：`export_prov` "501 / 未实现"（09-10 §4 #3 一直没修）；
  - L2-18：explorer-read-service 的说法与 `authorize.ts` 相反；
  - `meta-objects.ts:239-243`、`invariant-checks.ts:44`；
  - `tasks.updated_at` 从不更新；
  - `users.ts:220-226`；core 0033 头注释把 I16 写成 RLS 属性；
  - I14 谓词在 SQL 里重复写了四遍，目前一致，但没有任何机制保证。

### 6.2 运行时服务（16）

- **agent 侧**：
  - L5-6：遗留 105 的超时状态到达 Worker 时没有"不要重复请求"的提示，`gate-tools.ts` 与 ops-runner prompt 仍写"超时报 `pending_approval`"；
  - L5-8：`report_turn` 复用上一个 Turn 的摘要；
  - L5-11：stop 不取消在途内核调用，中断最长约 100 s；
  - L5-12(a)：门的原始输出经 `toolCallEnded.result` 不截断地到达内核与浏览器；
  - L5-14：交互模式落后（不截断、只在 `session_start` 投影）。
- **词表**：
  - L5-10 (D-08)：部分 `mode:'observe'` 能力有副作用，审计默认视图把它们藏了；
  - L5-15 / L10-15 (D-08)：约 22 个平台内管理写入标成 `mode:'execute'`；契约文档写"96 covered"，实际 165 条；设计 §9.3 把三个 fact 写入标成 `propose`。
- **门与代理**：
  - L6-16：gate-host `/healthz` 经 caddy 公开（列出实例与 `buildError`），凭证限速是全局一个桶；
  - L6-18：supervisor 扫描不按 entry 隔离、注册表只增不减、llm-proxy 吊销 jti 集合只增不减。
- **遗留旧账**：L10-16，docker-events 流在 stop 竞态时不销毁（09-10 §4 #7）。
- **漂移**：
  - 决定 ⑩ 已过时；
  - `SpawnRequestSchema.egressDeny` 注释与替换语义矛盾；
  - 标签键 `nexttime.workspace` / `nexttime.workspace-id` 不一致；
  - 采集器 Dockerfile 还在描述已删除的 `/data/state`；
  - per-source `egressDeny` 只匹配主机名，未写入文档。

### 6.3 web 控制台（39）

- **确认与人控**：
  - L7a-3 (V)：重置密码一键执行、没有确认；
  - L7a-13："标为 vetted"一键放宽 MCP 审批；
  - L8a-6：聊天里的 high 批准与所有拒绝跳过确认层级；
  - L8a-11 (D-25)："轮换 API key"没有确认，对人类成员会铸出一把 owner 能代用的 key；
  - L8a-4 (V，D-17)：接入向导把 propose + publish 合成一次点击；
  - L8b-11：Fact 失效写着"不可恢复"，却只用 `medium` 层级。
- **文案与事实不符**：
  - L7a-7：公告设置承诺"显示在顶栏"，但没有渲染；
  - L8a-7：输入框提示"每个执行都等**你**批准"；
  - L8a-10：审批的"目标资源"显示的是 gatekeeper id；
  - L8a-14："写入 N 条 Fact"按 `factsToAssert` 计；
  - L8b-6 (D-14)：通配授权的语义漂移；
  - L8b-7："N 个可调用的读操作"把平台禁用的也算进去；
  - L8b-9："可委派"承诺写委派，内核的 `ready` 却不要求有能 `request_action` 的 Worker；
  - L8b-13：启动器"至少授予一名成员 ✓"沿用到另一个门；
  - L8a-13：登录页永久披露管理员登录名与初始密钥位置。
- **状态与刷新**：
  - L7a-16 / L8a-15：待办计数丢失刷新期间到达的推送，审批历史页从不刷新（R-63 同族）；
  - L8b-8：授权或撤销后，系统页的可达性过期；
  - L8b-10：三个"Turn 是否在跑"的来源互相矛盾；
  - L7a-11：`loadMore` 可能把旧页追加到别的过滤器的列表；
  - L7a-10：默认模块 toast 的撤销会连带撤销后面的切换；
  - L7b-1 (V)：客户端聊天水位线套用了服务端已删除的规则，目前是潜在问题。
- **表单与选择器**：
  - L7a-8：已不在目录里的模型显示成别的值；
  - L7a-9：`UserPicker` 保留隐藏的选择；
  - L7a-14：供应商 key 表单不看 `storeWritable`；
  - L7a-15：审计按操作者过滤只列前 50 个用户；
  - L8a-5：过期的显式模型让 My Agent 保存失败；
  - L8a-9：推理链工具按所按的按钮静默忽略已填字段；
  - L8b-12：Procedure 编辑器选不了旧版本 Worker；
  - L8b-14：本体提案列表只读第一页。
- **健壮性**：
  - L7b-7：URL hash 里畸形的 `%` 转义会让整个控制台白屏（没有根错误边界）；
  - L7b-5：每个 403 都被当成角色证据，auditor / builder 可能丢失治理导航；
  - L7b-6：`kit/sheet` 丢掉了 `size`；
  - L7b-9：`kit/toast` 是未挂载的重复 context；
  - L7a-12：两个平台链接被重定向回概览；
  - L8a-8：导出静默丢掉隐藏的读取行。
- **其他与漂移**：
  - L7b-8：双语拼接残留（遗留 85）；
  - L7b-10：错误码 / 审计词表镜像漂移；
  - L8a-12：`ActionRequestDetail.tsx` 是死代码，还对 `high` 提供"总是允许"；
  - 八处 web 注释或文案漂移（MembersPage、ModelsPage、AvailableGateInstancesSection、PlatformModulesPage、概览、CreateWorkspaceForm、ui/Skeleton、`lib/audit.ts`）。

### 6.4 脚本、CI、文档（8 行，有的合并了多条）

- L9-3 (V)：`gate-host/`（凭证与幂等存储）不在备份里，见遗留 58；注意密文不配套 `secrets/` 就没用。
- L9-7 / L9-8：升级前 dump 用目标 tag 命名；`restore.sh` 的 EXIT trap 不响应信号。两条都随 R-11 修。
- L9-9 / L9-15：i18n-pairs 守卫从不在 CI 跑（遗留 85 的回归网失效）；`check-kernel-purity.sh` 在 grep 出错时静默通过。
- L9-10 / L9-11：`gen-handle-keys.sh` 可能在新 key 旁留下旧 `handle.pub`；`delete-workspace.sh` 在 `rm -rf` 失败时仍报告清理完成。
- 供应链与配置：
  - L9-13 / L9-14 / L9-16：构建输入没有按 digest 固定；签名证明的是 workflow 而不是源码（`pull-images.sh` 不校验 revision 标签，tag 也不受保护）；`.dockerignore` 的密钥模式只锚在根目录；
  - `image-scan.yml` 声称没有 build arg，而且从不扫描 gate-host；
  - compose secrets 注释里的属组与实际不符。
- L10-2 (V，D-28)：`platform_status.backup` 在四处硬编码为"未配置"，控制台因此没有备份新鲜度信号。
- L10-8：`operations.md` 漂移：
  - §3 的依赖图；
  - §7 / §11 "没有 metrics 端点"；
  - §10 "无 actor 的 purge 不写审计"，连同 `bootstrap.ts:755-760`；
  - §13 "镜像从不推送"。
- L10-9 / L10-10 / L10-12 / L10-13 / L10-14：
  - 验收 runbook 描述的是过时的缺口；
  - `release.md` 的 `--pull` 在 `EXPLORER_BUILD=1` 主机上会静默丢掉 Explorer 包，还引用了不存在的 `docker-preflight.md`；
  - `pi-upgrade.md` §7 的回滚早于 `activeRuntimeImage`；
  - STATUS 有四个"当前波次"标题，缺 host-accept-s4；README 停在 v0.3.0；
  - platform-extension README 说 worker / 交互模式未实现。

## 7. 待维护者决策（D-01…D-30）

这些是产品或语义选择，不是纯 bug，所以每项都给出推荐，等维护者拍板。

**2026-10-02 落定。** 维护者确认全部按推荐执行，原则是"只在关键点做门禁或限制，不能因为过程防御失去平台的易用性"。

- 标 ★ 的 8 项按这条原则、并对照生产库的只读计数复议了一轮。下表是落定后的版本：4 项改轻（D-03、D-05、D-06、D-14），1 项收窄（D-04），3 项不变（D-01、D-02、D-09 改为修而不删）。
- 生产数据（只取计数，明细在维护者本地 `docs/private/`）：
  - 正式工作区 2 个，验收临时工作区 77 个；
  - 65 次审批全部由人类做出；
  - 通配授权与非 gatekeeper 授权为 0；
  - 被篡改的溯源为 0；
  - 自连门只有 S2 验收在用。
- **对 §4 / §5 修法的覆盖**：
  - R-02 只在 handler 层检查，不收紧 observations 的 RLS——正式库 30 条跨 owner 的观测全部来自内核内部流程，收紧 RLS 会误伤它们；
  - R-04 只排除 agent 容器；
  - R-17、R-26 保持 P2，不升 P1。
- 其余 22 项按推荐执行，每个波次开工前用同一原则复查一遍，有改动记在本节。

| 编号 | 问题 | 涉及 | 推荐（理由） |
|---|---|---|---|
| ★ D-01 | 自连 / BYO 门拿什么凭证？ | R-01、R-27 | **已定（不变）**：每连接独立密钥，平台 token 只给内核供给的门，caddy 收窄立即发。代价只是 BYO 接入时复制一次密钥；`accept_s2.sh` 要给 fake 门喂它的 token |
| ★ D-02 | 内部平面凭证架构，以及 token 共享按 P1 还是 P2 算 | R-03、R-18 | **已定（不变，P1）**：从一个根密钥 HMAC 派生每服务 token（不新增密钥文件，运维无感），加按路由的调用方白名单，第二条 agent-host 连接不再顶替第一条。门是唯一碰外部系统的进程，正是该隔离的关键点 |
| ★ D-03 | 谁能写 Source？调用方能否自带 `activityId`？ | R-02 | **已定（改轻）**：只在 `submit_observations` / `assert_fact` / `supersede_fact` 的 handler 层检查——Source 必须归调用者；自带的 `activityId` 必须满足 `started_by = caller`。保留 `activityId` 参数（把自己的写入挂在自己的 Activity 下是正当用法）；**不**收紧 RLS；主机检测查询为 0，不修数据 |
| ★ D-04 | docker 运维门能不能碰平台自己的容器？ | R-04 | **已定（收窄）**：只排除带 `nexttime.role` 的 agent 容器（入口与任务），`logs_tail` / `inspect` 都排除，并从列表里滤掉；平台服务容器保留可见（`inspect` 只返回摘要，不含 env） |
| ★ D-05 | service principal 的生命周期、能否当 owner、是否计入最后一个 owner | R-06 | **已定（改轻）**：允许停用、轮换、改角色；最后一个 owner 必须是人；控制台可直接建 owner 级 service，用 `irreversible` 层级的确认框写明它拥有的权限（不再只走 CLI） |
| ★ D-06 | 底线 2 的"必经审批"是否意味着"必经一个人"？ | R-17（保持 P2） | **已定（改轻）**：`high` 与 `auto_approvable:false` 的请求必须由人批准 / 拒绝；更低级别允许 service 审批（权力等同一条自动批准规则，审计记为 service）；`verify_fact` / `resolve_conflict` 不限制（溯源已记录主体类型），`attest_fact` 照旧只限人类 |
| D-07 | auditor 是什么？ | R-35 | 严格只读：显式白名单（读能力 + 审计与溯源工具），没有门访问、没有 `invoke_worker`；入口 agent 同一上限 |
| D-08 | 注册表 `mode` 词表（observe 有副作用、execute 含义太宽） | R-35、P3 | 增加显式 `sideEffects` 标志，供角色检查与审计默认视图使用；放宽 execute 的定义文本（改标签会同时改变多个消费方的行为） |
| ★ D-09 | `openai-responses` 供应商类型 | R-10 | **已定（改为修，不删）**：写 Responses 用量解析器（`response.completed` 的 `response.usage`，不再注入 `include_usage`），夹具按官方 API 文档核实；删掉这个类型等于删掉一项能力。主机未配置该类供应商，所以是潜在问题 |
| D-10 | 按门串行执行是不是保证？ | R-50 | 是，以 `executing` 作为屏障（同一目标上的运维动作对顺序敏感，改动也小） |
| D-11 | indeterminate apply 或门崩溃后怎么重放？ | R-48、R-51 | 持久化的 pending 预留；声明为幂等的 Operation 自动重放，其余标 `failed: outcome_unknown` 交给人（绝不静默重跑非幂等副作用） |
| D-12 | 默认幂等去重窗口 | R-53、R-54 | 只对非终态行生效，另加可选的客户端 nonce（行一旦终态，重复请求就是新意图） |
| D-13 | gatekeeper 授权是否同时赋予审批权？ | R-38、R-39 | 暂时保持耦合：持有者 = 审批人，同一谓词，并在 UI 披露；等 owner 提出"能用但不能批"的需求再拆 |
| ★ D-14 | 通配授权与非 gatekeeper 授权算不算底线 3？ | R-26（保持 P2） | **已定（只防不建）**：`grant_capability` 只接受控制台能展示的 `resource_type='gatekeeper'` + 必填 `resource_id`；生产没有这类授权，不为不存在的数据建列表界面 |
| D-15 | "总是允许"的范围 | R-20 | 以 `(gatekeeper_id, action_kind)` 为键，先发文案与确认的修正（两个 docker 实例就足以让操作名撞车） |
| D-16 | `allowMemberAutoApproveLow` 的语义 | R-21 | 强制收窄，同一改动里把编译默认值翻成 `true`（标着"允许"、实际却不收窄审批的 owner 开关，削弱了底线 2） |
| D-17 | 分级变化要不要确认？ | R-19、P3 L8a-4 | 向导、目录、刷新三处凡改 mode / blastRadius / autoApprovable，都显示 old→new 并确认；内核统一给出 `direction` |
| D-18 | 门重新 announce 的 manifest 是否须确认后才生效？ | R-18 | 要，并与 D-02 一起做（凭证证明**谁**发的，确认证明有人看过**改了什么**） |
| D-19 | 连接器 `disabled` 的语义 | R-40、R-41 | 保持设计（目录可见性 + 新连接的闸门），切断手段用拒绝名单；订正控制台文案 |
| D-20 | AgentProfile / Policy 收窄是否约束运行中的 Worker 与 MCP Handle？ | R-37 | 约束，执行时取交集（读模型与执行必须用同一谓词） |
| D-21 | 谁能读 Task？ | P3 L2-11 | owner、请求者、Task 自己的 WorkerRun Handle（与 `cancel_task` 一致，也符合私聊隔离） |
| D-22 | `get_action` 的可见性 | R-42 | 与 `list_action_requests` 同一 I14 谓词，并允许请求者查看（单行读取不应比列表读取暴露更多） |
| D-23 | 入口上下文的投递语义与归属 | R-57 | `report_turn` 时确认；条目归属发起它的聊天（投递状态应该在内核，而不是容器本地缓存） |
| D-24 | 各 registry 统一发布权限 | P3（遗留 100） | 所有 `publish_*` / `deprecate_*`：`minRole:'builder'`，发布人 = 提案人或 owner |
| D-25 | P-A1 之后人类主体还该有 API key 吗？ | R-12、P3 L8a-11 | 不该：拒绝给人类新铸 key，重置时清掉遗留 key（个人自动化用 service principal 或 MCP Handle） |
| D-26 | Operation 草稿是否私有（I16）？ | P3 L2-15 | 私有，与 skill / procedure 一致 |
| D-27 | Repository 观测：接上还是删掉？ | R-25 | 现在先清洗，保持不接线，并在文档里写明已禁用 |
| D-28 | 控制台的备份状态 | P3 L10-2 | 只读挂载 `backups/last-success`，派生 `lastSuccessAt` 与 `stale`（补上缺失的新鲜度信号） |
| D-29 | 经 llm-proxy 使用供应商侧工具 | R-30 | header 白名单；服务端工具默认剥离，WorkerDefinition 显式开启并留审计 |
| D-30 | 已暴露 CA 私钥的主机侧处置 | R-32 | 先 chmod；只有存在非管理员本地账户、或暴露窗口无法界定时才轮换 CA，证据记 `docs/private/` |

## 8. 修复波次计划（2026-10-02 维护者确认，执行中）

**排序原则**：

- 先做不需要决策的 P1，再做决策后的 P1；
- 刚关闭就发现不完整的遗留（104、64）优先于一般加固；
- 每个波次：发版 → 主机按 runbook 应用 → 验收 → 更新 STATUS；
- 带迁移的条目要在 release.md §6 补可逆性行，CI 可逆性探针会自动对这些 PR 跑。带迁移的有 R-08、R-20、R-29、R-53、R-60、R-66（R-02 按 D-03 只在 handler 层检查，不需要迁移）。

**必须同发或有依赖的组合**（单独挑着做会出问题）：

- R-05 + R-16 同发：只发服务端，每次强制断开都会变成客户端每秒一次的无限重连。
- R-48 + R-51 同发：重放语义的内核半边与门半边。
- R-01 与 R-27 共用一个出站目标谓词。
- R-03 → R-18 → R-19：先有每门 announce 凭证，再做 manifest 确认，再改确认框。
- R-60 → R-61：先在草稿上存基线，UI 才能按族 diff。
- R-21 若按 D-16 定为强制收窄，必须在同一改动里翻转编译默认值，否则所有没有 policy 行的工作区都会失去低风险自动批准。

| 波次 | 内容 | 前置 | 粗估 |
|---|---|---|---|
| **0 无需决策的 P1** | R-07 ✅（#394）；R-01 的 caddy 收窄；R-09；R-11（含 L9-7 / L9-8）；R-08（主机先查重复）；R-05 + R-16；R-32 代码修复 + 下次应用时主机 chmod | 无 | 约 1–1.5 周 |
| **1 决策后的 P1** | R-02（D-03）、R-04（D-04）、R-06（D-05）、R-10（D-09）、R-17（D-06）、R-26（D-14）；R-01 完整修法 + R-27（D-01）；R-03（D-02，最大的一块，L） | ★ 决策 | 约 2 周 |
| **2 遗留 104 后续与执行可靠性** | R-48 + R-51（D-11）、R-49、R-50（D-10）、R-52、R-53 / R-54（D-12）、R-58；R-55、R-56、R-57（D-23）、R-59（遗留 64） | 波次 0 | 约 1.5–2 周 |
| **3 吊销与凭证加固** | R-12（D-25）、R-13、R-14、R-15；R-18 + R-19（D-18、D-17）；R-22、R-23、R-24、R-25（D-27）、R-28、R-29、R-30（D-29）、R-31、R-33、R-34、R-36、R-43 | R-03 | 约 2 周 |
| **4 授权语义与控制台人控边界** | R-20（D-15）、R-21（D-16）、R-35（D-07、D-08）、R-37（D-20）、R-38 + R-39（D-13）、R-40 + R-41（D-19）、R-42（D-22）、R-44–R-47、R-60 → R-61、R-62、R-63、R-64 | 相关决策 | 约 2 周 |
| **5 数据、计量、运维与文档漂移** | R-65–R-71；其余 P3（D-21、D-24、D-26、D-28 相关）；STATUS 结构整理（只留一个"当前波次"标题，补 host-accept-s4 行，刷新 09-10 §6） | 无 | 约 1 周 |

### 8.1 波次 0 / 1 / 2 的 PR 拆分与顺序

**PR 拆分原则**：

- 一个 PR 对应一个根因簇，或者一组必须同发的簇。
- 同时在跑的 PR 不碰同一批文件。内核与 web 的实现交给 opus 子代理，各在独立 worktree 里做；部署与脚本类由主会话做。
- 每个 PR 必须 CI `guards / quality / test`（含 Postgres 集成套件）全绿，主会话审过 diff 才合并；合并按严格 up-to-date 串行进行。
- 迁移编号由主会话统一分配，避免撞号：

  | 迁移 | 用途 |
  |---|---|
  | core 0034 或 governance 0013 | R-08（波次 0 唯一的迁移） |
  | 依次往后排 | 波次 2–5 的 R-20、R-29、R-53、R-60、R-66 |

| 顺序 | PR | 内容 | 执行 |
|---|---|---|---|
| 0-1 | caddy + host-env-init | R-01 的 caddy 收窄：`/gate-host/*` 只放行 `/i/*/gate/connected-accounts`，`/healthz` 不再对外；R-32：`chmod -R o+rX` 改为 `o-rwx`，并订正 runbook | 主会话 |
| 0-2 | R-09 | 新增"Task 失败 + 回收其 run"的共用 helper；spawn 失败路径与 `spawn_lost` 扫描共用 | 子代理 |
| 0-3 | R-08 | `draftOf` 保留；一个身份只留一条 published；**迁移自愈**（建索引前先把多余的 published 行 deprecate）。合并前在主机跑检测查询 | 子代理 |
| 0-4 | R-05 + R-16 | 人类 WS 每次调用复查；进程内 kick 总线；`ensureEntryHandle` 拒绝已停用主体；停用时吊销该主体的全部会话；控制台识别 -32001 / -32002，改用退避重连 | 子代理 |
| 0-5 | R-11 | `restore.sh` 在线恢复：先把现库改名留作回退（不用 `DROP … FORCE`），再建新库，用 `--exit-on-error --single-transaction` 恢复，非零退出即失败并打印改名回退命令；含 L9-7 / L9-8。只有演练路径能在主机上验证，这一点写进 release.md §6 | 主会话 |
| 0-H | 发版 + 主机应用 | apply-release 按 runbook 走；主机侧执行 caddy 数据目录的 `o-rwx`（`stat` 核对）；D-30 检查有没有非管理员的本地账户，结论记 `docs/private/` | 主会话 |
| 1-a | R-02 / R-04 / R-10 / R-17 / R-26 | 五个小 PR，文件互不相交，R-05 还在 CI 时就可以开工 | 子代理 |
| 1-b | R-06 | 等 R-05 合入后再做（两者都改 `disable_principal`） | 子代理 |
| 1-c | R-03 → R-01 完整修法 + R-27 | 先做内部凭证（R-03），再做每连接密钥 + 出站目标谓词 + supervisor `requireInternal`；R-18 等 R-03 | 子代理 |
| 1-H₁ | 发版 + 主机应用（v0.37.0） | R-03 首次上主机单独成一版，不与第二次凭证改动叠在一起（v0.36.0 caddy 事故的教训）：用新 tag 的 apply-release（含派生步骤），S1–S4 照原流程 | 主会话 |
| 1-H₂ | 发版 + 主机应用 | R-01 完整修法 + R-27；S2 验收换成每连接密钥的流程 | 主会话 |
| 2-a | R-48 + R-50 + R-51 | 重放语义（内核 + 门）与每门屏障同发；governance 0013 | 子代理（#414） |
| 2-b | R-49 + R-52 | 门客户端响应体超时；drain 不阻塞 outbox；排在 2-a 之后合 | 子代理（#415） |
| 2-c | R-53 + R-54 | D-12 幂等窗口；governance 0014、task 0005 | 子代理（#413） |
| 2-d | R-58 + R-59 | 崩溃重试守卫；滚动检查在 RLS 下看见私聊 Turn | 子代理（#416） |
| 2-e | R-57 | D-23 入口上下文按 `report_turn` 确认；等 2-c 合入（同改 platform-extension） | 子代理 |
| 2-f | R-55 + R-56 | Turn 终态守卫与帧重放；等 R-03 合入（同改 agent-host / `agent-host-runtime.ts`），一个代理两个 PR | 子代理 |

仍然推迟的：S9 D3（干净主机安装，等一台干净虚拟机）、遗留 102 异地备份（2026-10-02 决定先不做）。

## 9. 本次 STATUS 改动

- §1 链接本文。
- §4 新增遗留 106–123：
  - 106–116：11 个 P1，每簇一行；
  - 117–122：P2 按 §5A–§5F 分组，每组一行；
  - 123：P3 与决策清单的指针行。
- 遗留 36、64、88、104 的状态改为"重开（2026-10-02 复审 → 新编号）"，原关闭说明保留。
- 按 §3.3 订正遗留 6、45、49、70、97、103、105 的行文。
