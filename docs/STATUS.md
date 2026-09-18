# STATUS — 项目入口与进度（唯一真相）

> 这是"现在到哪了"的唯一入口。任何会话、任何阶段开始先读这里；波次合入、主机验收、发版
> 之后在同一 PR 或紧随的 docs PR 里更新这里。它只放三块内容：里程碑状态（含时间线与验收边界）、当前波次、遗留清单。
> 拆解与实现说明在 `development-tasks.md`，评估在 `retrospective-*.md` / `code-review-*.md`，
> 本文只链接不复制。与代码冲突时以代码为准，并修正本文。

最后更新：2026-09-18（W11 本地部分完成：S5.7 `report-usage.sh` + 例行回归流程 #202、S5.8 `make demo` #204、`drill-install.sh` / `drill-upgrade.sh` + release.md 迁移可逆性 #205，遗留 25 复现小修 #206，回顾 `retrospective-2026-09-18.md`；发布 v0.13.0；主机侧——三版应用、`--runs 10` 数字、三个演练实跑——待做。同日 W10 完成：S5.3 #195、S5.5 后五项 #197 / #198 / #199、S5.6 #200，遗留 9 / 21 / 23 / 24 / 25 / 30 / 31 / 34 / 40 关闭、11 部分关闭；发布 v0.12.0，主机未应用（v0.10.1 + v0.11.0 + v0.12.0 一起）。上一版同日 W9 完成：S5.1 #191 / #192、S5.2 #193、S5.4 #190、S5.5 前三项 #186 / #187 / #188，遗留 20 / 22 / 28 / 36 / 37 / 38 关闭，新增遗留 40；四项待决按推荐缺省取定（见 §3 与 `development-tasks.md` §5b 波次表头）；发布 v0.11.0，主机未应用。上一版 2026-09-16：S5 基座打磨立项：`development-tasks.md` §5b 八项（S5.8 交付与演示闭环同日补入）、W9–W11 波次、四项待维护者决定；新增遗留 37 / 38，遗留 9 / 11 / 20–24 / 28 / 30 / 31 / 34 / 36 归属改为 S5 车道。上一版 2026-09-12：W8 P-B2a 合入 PR #179 并发 v0.10.0，P-B1 #175 v0.9.0，P-A2 #171 v0.8.0，P-A1 #168 v0.7.0）

## 1. 入口指引

| 想知道 | 去哪 |
|---|---|
| 系统是什么、领域模型、三条底线 | `graph-ai-middle-platform-design.md`、`design-review-2026-09-01.md` |
| 平台怎么配置、怎么用起来、怎么维护（使用面 / 管理面 / 维护面） | `platform-admin-design.md`（§7.11 的上位文档） |
| 任务拆解、依赖图、每个任务怎么实现的 | `development-tasks.md`（"实现说明"随合入追加） |
| 线上契约与语义约定 | `wire-contract-conventions.md`、`contracts/*.json`（`pnpm contract:check`） |
| 怎么部署、验收、演练、排障 | `runbooks/README.md` 起步；验收 `runbooks/accept-s1.md`、`runbooks/host-accept-s2.md`、`runbooks/host-accept-s3.md` |
| 测试分层与命令 | `testing.md` |
| 自动化与发布 | `runbooks/automation.md`、`runbooks/release.md`、`CHANGELOG.md` |
| 阶段评估与设计反思 | `retrospective-2026-09-09.md`、`code-review-2026-09-04.md`、`code-review-2026-09-10.md` |
| 接入 Claude Code / pi | `howto-connect-claude-code.md`、`howto-connect-pi.md` |

## 2. 里程碑状态

| 里程碑 | 目标 | 状态 | 证据 |
|---|---|---|---|
| E | 目标主机可跑全部服务 | 达成 | `runbooks/host-*.md` |
| R | monorepo lint / test / build / migrate | 达成 | CI `guards / quality / test` |
| S1 | 登录 → 对话 → 自己的 pi 回答 → Turn 入图 | 达成 | `accept_s1.sh` 22 PASS + 1 SKIP（2026-09-10，v0.4.2） |
| S2 | 说需求 → find_workers → invoke_worker → 门动作 → 审批 → 执行 → 写回 | 达成 | `accept_s2.sh` 66 PASS（2026-09-10，v0.4.2） |
| S3 | 本体 v1 + 采集器 + Explorer + MCP gateway | 达成 | `accept_s3.sh` 29 PASS（2026-09-11，新增 explorer-no-credentials 断言，PR #153，从分支在主机验证） |
| S3.11–S3.15 | 控制面、接入向导、AgentProfile、web 控制台、pi 漂移 | 达成 | `development-tasks.md` 各节实现说明 |
| 真实模型验证 | 真实模型跑 S2 / S3 场景，统计工具调用成功率 | 达成；S5.7 例行化 | W7（各 3 次）：docker_restart 2/3、api_observe 3/3、ssh_run_approve 3/3、ssh_run_auto 1/1、dependency_chat 2/3（`retrospective-2026-09-11.md` §2）。2026-09-18 v0.13.0（各 10 次）：docker_restart 0/10、api_observe 10/10、ssh_run_approve 3/10、ssh_run_auto 1/1、dependency_chat 10/10、make demo 0/1——两条新根因（遗留 30 第二根因 #208、遗留 44 / #210）；v0.13.1 复跑见 §2.2 |
| S5 | 基座打磨：I2 写入点强制、新鲜度与失效、数据与代码分离、prompt 契约守卫、加固批次、稳定性、真实模型回归、交付与演示闭环（S5.8，W11 最后） | W9 + W10 完成（2026-09-18：S5.1–S5.6）；W11 本地部分完成（S5.7 工具与流程 #202、S5.8 `make demo` #204、两个演练脚本 + 迁移可逆性表 #205），主机侧待做；主机未应用 | `development-tasks.md` §5b 各节实现说明；CI guards / quality / test（含 Postgres 集成套件）/ e2e 全绿 |
| 发布 | — | v0.13.0（W11 本地部分：#202 / #204 / #205 / #206，只有脚本、runbook 与一条测试放宽，无迁移；随本次收口发布）；其下 v0.12.0（W10：#195 / #197 / #198 / #199 / #200；再其下 v0.11.0 含 W9 #186 / #187 / #188 / #190 / #191 / #192 / #193、v0.10.1 含 #183、v0.10.0 含 P-B2a、v0.9.0 含 P-B1、v0.8.0 含 P-A2、v0.7.0 含 P-A1、v0.6.0 含 S4.1）。主机仍在 v0.10.0，v0.10.1 + v0.11.0 + v0.12.0 一起应用（迁移 core 0025–0029，全部镜像重建，见 §3 W9 / W10 主机应用注意） | `CHANGELOG.md` |

> S1–S3 的「达成」以各自验收脚本为准。2026-09-10 复审曾发现 S3.2 的冲突检测在 Worker 断言主路径上不生效
> （`code-review-2026-09-10.md` §2.1），当时验收对 Conflict 的唯一断言是「采集器跑两遍后为零」，压制 Conflict 的缺陷
> 无论存在与否都表现为通过。该缺陷已按 §4 第 16 项修复（PR #137），`accept_s3.sh` 加了异源 Conflict 正向断言
> （PR #136）并于 2026-09-10 在主机通过。
>
> v0.5.0 已于 2026-09-11 在主机应用（无新迁移，全部镜像重建）：S1 22 PASS + 1 SKIP、S2 66 PASS、S3 29 PASS。

### 2.1 时间线（每阶段一行，追加不覆盖）

| 日期 | 发生了什么 | 依据 |
|---|---|---|
| 2026-09-01 | 架构设计 v0.3 定稿；对照原始需求复盘 | `graph-ai-middle-platform-design.md`、`design-review-2026-09-01.md` |
| 2026-09-02 | 目标主机上线（里程碑 E）：检出、密钥、Postgres、caddy | `runbooks/host-*.md` |
| 2026-09-04 | 首次代码复审，列出 P0 三条与 F1–F10 修复计划 | `code-review-2026-09-04.md` |
| 2026-09-08 | F1–F10 全部合入并在目标主机验证；排定 S3 实施波次 | `development-tasks.md`「S3 实施波次」 |
| 2026-09-09 | S3 波次 W1–W4 合入，主机三份验收通过；发布 v0.2.0、v0.3.0；本文建立 | `retrospective-2026-09-09.md`、`CHANGELOG.md` |
| 2026-09-10 | 全量通读（约 6.2 万行源码）+ 三轮定向复审；新增 P1 三条 | `code-review-2026-09-10.md` |
| 2026-09-10 | W5 收口：遗留 1–5、15 关闭（PR #128 / #129 / #131 / #132），fake-llm 自检进 CI，仓库只留 squash；发布 v0.4.0（PR #130）。主机未应用（停栈中），迁移 0018 待下次起栈时随 `make migrate` 落地 | `CHANGELOG.md`、本文 §4 |
| 2026-09-10 | W5.5：P1 三项关闭（#137 Worker run 作为自己的 Source、#140 并发首次断言加锁、#138 入口 ceiling 按角色收窄），`accept_s3.sh` 加异源 Conflict 正向断言（#136）；发布 v0.4.1（PR #139）。复审新增遗留 24、25 | `CHANGELOG.md`、本文 §4 |
| 2026-09-10 | 产品决定：Worker 结果 Fact 默认工作区可见、转录另作私有 Source（#142），发布 v0.4.2（PR #143）。主机应用 v0.4.2（迁移 0018）并复跑三份验收：S1 22 PASS + 1 SKIP、S2 66 PASS、S3 28 PASS（Conflict 正向断言首次在主机通过）；发现 S2 cleanup 会把基础栈一起停掉（遗留 26） | `docs/private/` §34、本文 §2 |
| 2026-09-10 | W6 验收工具链治理：四份 heredoc driver 抽成 `deploy/accept/driver.mjs` + `scripts/lib/accept-common.sh`（#145，14 例 vitest）；fake provider 改 compose override，验收不再改生产配置（#146）；`accept_s1.sh --lite` 进 e2e 工作流（#148，CI 首跑 13 PASS + 6 SKIP）；fake-llm 场景参数按注册表 paramsSchema 校验（#149）；发布 v0.4.3（PR #147）。每个脚本 PR 都先在主机从分支连跑 S1→S2→S3 验证 | `CHANGELOG.md`、本文 §3 |
| 2026-09-11 | W7 开发：e2e 全量进 CI（#151）；Explorer 按调用者鉴权、caddy 不再持有 key（#153，遗留 8 关闭）；工具调用 `isError` 全链路 + driver 计数（#155）；真实模型验证模式 `--real`（#156）；顺带修复 grants 作用域比对（#152）与采集器 `depends_on` 解析（#157） | `retrospective-2026-09-11.md`、`CHANGELOG.md` |
| 2026-09-11 | 主机应用 v0.5.0：删除主机 `.env` 的 `EXPLORER_API_KEY`，全部镜像重建，无新迁移；首轮 S1 首次对话被入口容器冷启动打断（遗留 29）、S2 夹具镜像拉包超时（网络），重跑后 S1 22 PASS + 1 SKIP、S2 66 PASS，S3 首轮即 29 PASS；栈回到停栈状态 | `docs/private/` §39 |
| 2026-09-11 | W8 S4.1 用户目录与登录（PR #164）：迁移 0019 平台级 `users` / `user_sessions` / `platform_setup`、用户名 + 密码登录与控制台会话 cookie、一次性初始化令牌、web 初始化页 / 强制改密 / 工作区切换 / 我的账户、Explorer 改认控制台 cookie；API key 路径不变。两个 reviewer 子代理复查：内核半修正两处（初始化令牌失败计数被回滚、`workspaces` 多余授权），web 半修正会话前状态机的三处竞态（重复切换工作区泄漏 socket、切换时过早关旧 socket、改密在途时登出可复活会话）。主机未应用 | `development-tasks.md` S4.1 实现说明 |
| 2026-09-11 | W8 P-A1 身份、用户与管理面骨架（PR #168，v0.7.0）：维护者否决 S4.1 的令牌首登并要求先设计——`platform-admin-design.md` v3（使用面 / 管理面 / 维护面，对照本地克隆的 cloudflare-os 源码）经 docs PR #167 合入；随后一个波次交付预置 `admin` + 默认工作区、`scope:'platform'` 通道与 `withPlatform` 事务、15 个平台能力 + `add_member`、迁移 0020 / 0021（`users` RLS、`platform_settings`）、侧栏三组与概览 / 用户 / 平台设置 / 平台审计页、e2e 改为 admin 首登。CI 集成套件首次覆盖平台能力、RLS 与默认工作区；opus reviewer 抓到五处（停用不切断 API key / Handle、改角色不吊销 Handle、env 管理员可被重置、env 管理员未被视为管理员、初始密码文件顺序）均在合入前修正。三个 sonnet builder 中途撞会话限额，剩余工作改由 opus builder 与主会话完成。主机未应用 | `development-tasks.md` P-A1 实现说明 |
| 2026-09-12 | W8 P-A2 使用面收口（PR #171，v0.8.0）：六个平台工作区能力与工作区页（建区 / 改名 / 入口模型 / 允许的模型 / 停用 / 委托 owner）、迁移 core 0022 + governance 0011、允许的模型改为解析期上限且两个面共用一条一致性规则、禁用工作区按调用关全部通道并停入口容器（顺带补上停用用户停容器）、`instanceInstructions` 进入口与 Worker 的 system prompt（一次性 Worker 首次拿到 WorkerDefinition 的 `systemPrompt`，`/task/spawn` 新增 `systemPrompt`）、遗留 33 由 agent-host 按 chat `switch_session` 关闭。内核核心与四处审查修正由主会话完成，web / 测试 / e2e / agent-host / supervisor 由 opus builder 完成；opus reviewer 抓到四处（已认证 WS 在禁用后仍可调用并重签会话、owner `set_agent_policy` 绕过管理员模型上限、`entryModel:null` 清不掉入口定义模型、`switch_session` 回包 id 未核实）均在合入前修正。主机未应用 | `development-tasks.md` P-A2 实现说明 |
| 2026-09-12 | W8 P-B1 门与集成目录（PR #175，v0.9.0）：P-B 按 design §9 一行拆成 P-B1 / P-B2 两个波次并记录五条开工前决定；门自注册（`/internal/gates/announce` + 心跳 + 失联扫描）、接入包三态与按 Operation 禁用（建请求与执行两处卡口）、门实例（发现 / 启用 / 禁用 / 失联 / vetted）、工作区一键启用、MCP 信任规则、外部运行时盘点 + 页面签发 service Handle、集成页。内核核心、gatekeeper-base 自注册与审查修正由主会话完成（两个 opus builder 开工即撞会话限额，web 改由 sonnet builder 完成，e2e / reviewer 亦为 sonnet）；e2e 抓出并修掉一个既有 bug（系统接入页 `search` 信封）。主机未应用 | `development-tasks.md` P-B 实现说明（P-B1） |
| 2026-09-12 | W8 P-B2a 门宿主与页面直达凭证（PR #179，v0.10.0）：P-B2 再拆为 P-B2a / P-B2b 并记录决定 ⑥–⑬；通用门宿主（一个容器承载 N 个 http / mcp 实例，定义由宿主从内核拉、逐个 announce 复用 P-B1 全部机制）、凭证由浏览器经 5 分钟平台 JWT 直达宿主（内核第一次做到不经手门凭证）、集成页新建 / 录入凭证 / 删除、成员录入自己的凭证、fake MCP 全链路 e2e 进 CI。内核 / 共享契约 / 宿主模式 / 部署接线由主会话完成，测试 / web / e2e 各一个 sonnet builder，sonnet reviewer 抓到一条 P1（凭证路由接受共享 gate_token）与两条 P2，CodeQL 抓到两条 high，均合入前修正。主机同日应用（迁移 core 0024，`gate-host` healthy、每 60 s 拉定义，caddy `/gate-host/*` 路由通；尚无真实宿主实例） | `development-tasks.md` P-B 实现说明（P-B2a） |
| 2026-09-16 | 维护者决定先打磨基座、场景层推后；对 main 核实后立项 S5 基座打磨（八项含 S5.8 交付与演示闭环、W9–W11、四项待决），新增遗留 37 / 38；#182 合入后 main 的 CI 因 pg Pool 无 `error` 监听而失败，PR #183 修复并关闭遗留 39 | `development-tasks.md` §5b、PR #182 / #183 |
| 2026-09-17 → 18 | W9 三车道并行完成（v0.11.0）：**W9-C** 遗留 36 `create_connection` 拒绝命中平台门端点 + S2 脚本改走目录路径（#186）、遗留 22 supervisor `reconcile()` 出网拒绝表回退（#187，agent 抓到的真 bug）、遗留 20 五个服务补 `read_only` / `cap_drop` / `no-new-privileges`（#188，caddy 文件 capability 一并修）；**W9-B** S5.4 prompt 契约修复 + `prompt-contract` 守卫 + fake-llm 工具形状校验（#190）；**W9-A** S5.1 I2 在写入点强制、工作区 `reject` / `warn`、I-S5-1（#191）+ 平台工作区页开关（#192），S5.2 新鲜度与失效：迁移 0026 / 0027、观察窗口 `not_reobserved`、门观察带 Source（I-S5-2）、`assertFact` 同源优先（#193，关闭 28 / 38）。四项待决按推荐缺省取定。内核核心（S5.1 / S5.2 / 遗留 36）由主会话完成，其余三条车道各一个 sonnet 子代理；S5.2 的 0027 是实现窗口时暴露的 S3.2 边界。主机未应用 | `development-tasks.md` §5b 各节实现说明、`CHANGELOG.md` |
| 2026-09-18 | W10 三车道完成（v0.12.0）：**W10-A** S5.3 数据与代码分离（#195：迁移 core 0028 `sources.name` + 唯一索引、`register_source` 按 (kind, name) 幂等、采集器无本地状态、领域包放主机 `config/ontology/` 即 seed、ephemeral 工作区 + `--expired` 清理；关闭 9、11 部分）；**W10-B** S5.5 后五项（#197 `list_action_requests` + 控制台审批历史、遗留 31 核实关闭；#198 遗留 24 `assertFact` 有界重读到链尾 + core 0029；#199 遗留 23 cursor 毫秒截断、遗留 34 十五处同 client 并发 query 顺序化 + pg 警告变测试失败）；**W10-C** S5.6（#200：`queued` 崩溃缺口清扫 `spawn_lost` + I-S5-3 + chaos 脚本，遗留 25 / 40 testTimeout，**遗留 30 根因**：`ActionRequestPending` 路由不读 `await_decision`、把不阻塞的 Worker 的 Task 挂成 `waiting_approval`，其 `report_result` 撞无边转移被整体回滚——修为只在 `await_decision: true` 时挂起，主机 `--real` 复跑留 S5.7）。过程：三个 sonnet 车道同时撞会话限额，主会话先把三条车道收尾都揽了下来（B2 验证开 PR、B1 补集成测试与 23 / 34、C 的遗留 30 修复），维护者指出违背"智能分配任务与模型"的约定；之后 C 代理恢复自己收尾，教训记 memory。顾问在 S5.3 完成审查里抓到主机过渡风险（生产工作区重名采集器 Source 回填不命名 → 采集器另起谱系）——已写成应用前三步核对。主机未应用 | `development-tasks.md` §5b 各节实现说明、`CHANGELOG.md` |
| 2026-09-18 | W11 本地部分（三条 sonnet 车道并行，主会话审 diff 后各补一处；本机无 Docker / 主机，脚本只做 `bash -n` / shellcheck / guards 静态验证）：**E** S5.7 `scripts/report-usage.sh`（`llm_usage` 按 turn / handle / task 聚合，`--by task` 走 `worker_runs.session_id` 的真实 join，参数先正则再进 SQL）+ `host-accept-real-model.md` 例行回归七步与私有记录模板（#202）；**D2** S5.8 `make demo`（ephemeral 工作区 + 采集 + 三问 + Markdown 结果页；审出 demo 覆盖生产采集器 token 的问题 → 改为 demo 私有 token 文件 + `NEXTTIME_HANDLE_TOKEN_FILE`）（#204）；**D1** S5.8 `drill-install.sh`（操作机经 SSH 编排、拒绝已部署主机、发现 runbook 顺序不自洽的交付缺口）+ `drill-upgrade.sh`（升级 → 三份验收 → 可逆性 PROBE → 先回代码再活库 restore → S1；审后加自我复制 `exec` 与回到原分支）+ `release.md` §6 迁移可逆性表（core 0025–0029 全部可逆，0027 经核实旧调用方只取首行）（#205）。W9–W10 回顾写成 `retrospective-2026-09-18.md`。主机侧待做，见 §3 | `development-tasks.md` §5b S5.7 / S5.8 实现说明、`retrospective-2026-09-18.md` |

### 2.2 验收证明了什么，没证明什么

三份验收脚本证明的是**内核 / 门 / 扩展这一侧的链路成立**。两处已知盲区，排期时按此判断，不要把
「验收通过」读成「功能可用」：

- **真实模型的路径现在存在了**（`--real <provider/model> [--runs N]`，PR #156）。W7 主机上用
  真实模型各场景跑 3 次，证明了「模型自己选对工具」在 docker_restart 2/3、api_observe 3/3、
  ssh_run_approve 3/3、ssh_run_auto 1/1、dependency_chat 2/3 上成立，且失败都不是选错工具
  （`retrospective-2026-09-11.md` §2）。盲区：每场景只跑 3 次、只用了一个真实供应商和一个模型，
  样本量和覆盖面都远不足以下"稳定可用"的结论。**S5.7（#202）把它变成例行**：每次发版后
  `--runs 10`、`report-usage.sh` 汇总 token / 费用、`make demo` 作第六场景，任一场景 `<8/10` 记为该
  版本已知问题（`host-accept-real-model.md` §8 / §9）。首轮（2026-09-18，目标主机，各 10 次；
  供应商 / 模型与费用只在 `docs/private/real-model-2026-09-18.md`）：

  | 场景 | v0.13.0 | v0.13.1（#208 + #210 之后复跑） |
  |---|---|---|
  | docker_restart | 0/10（动作已执行、Task `no_result`：S5.1 `reject` 拒绝 Worker 附带的 Fact 断言、整份结果契约被拒——遗留 30 第二根因） | 待填 |
  | api_observe | 10/10 | — |
  | ssh_run_approve | 3/10（7 次同一根因） | 待填 |
  | ssh_run_auto | 1/1 | — |
  | dependency_chat | 10/10 | — |
  | make demo | 0/1（Q3 `interrupted`：门在对话后才连接，常驻容器重建撞上 Turn——遗留 44） | 待填 |

  真实模型一轮把两条 fake 路径永远测不到的平台缺陷逼了出来（fake-llm 的脚本化 Worker 从不附带
  越界断言、fake 场景的门都在首轮对话前接好）——这正是 S5.7 要常态化的原因。
- **对 Conflict 的唯一断言是「采集器跑两遍后为零」**，因此任何**压制** Conflict 的缺陷，
  存在与否验收都表现为通过（§4 第 16 项即属此类）。缺一条「异源矛盾断言 → 恰好一个 open Conflict」
  的正向用例。**PR #136**：`accept_s3.sh` 已加入 `collector_conflict_positive_step`，把这条正向用例
  接了进脚本（`docs/runbooks/host-accept-s3.md` §3/§4）；本条盲区在代码层面已补，但 §2 表格 S3 那行
  的验收证据仍是主机跑通新脚本之前的旧结果，未随此 PR 更新——里程碑状态与证据在下次主机验收前不改。
- **CI e2e 现在跑全部 Playwright 用例**（#151，含审批场景与 Explorer 会话，审批场景在 CI 里播种），
  加上 `accept_s1.sh --lite`；但 S2 / S3 全链路与真实模型跑的场景仍只在主机验收，发版与主机验收
  之间的空窗依旧存在（主机检出在 main（含 v0.4.3），仅 supervisor 镜像是从 #146 分支重建的，内容与合入提交相同）

## 3. 当前波次

**W5 收口：完成**（2026-09-10，一天）。六项里五项关闭（PR #128 文档漂移、#129 fake-llm 自检、#131 `create_task` 下架、#132 `explain` 收敛 + `search` 分页、仓库设置只留 squash、Renovate 决定暂不装），E7 仍待决定；各项细节见 §4 第 1–6 项与 `development-tasks.md` 的 W5 实现说明。复审新发现一条（§4 第 23 项：`query_decisions` / `list_conflicts` 的 cursor 精度）。

**W5.5 P1 修复：完成**（2026-09-10，与 W5 同日）。三项各有正向用例并在 CI 的真 Postgres 上通过（#137 / #140 / #138），`accept_s3.sh` 的异源 Conflict 正向断言已加（#136，待主机复跑）。分工：核心代码与迁移由主会话写，测试 / 文档由 builder 子代理写，每个 PR 经 reviewer 子代理复查；两次复查各抓到真问题并已在合入前修正（16 的可见性副作用与跨用户佐证、18 的缓存吊销与 mcp_session Handle）。

**W6 验收工具链治理：完成**（2026-09-10；范围与完成标准见 `retrospective-2026-09-09.md` §4，四项全部达成：脚本里不再有 JS、CI 有一条 S1 通路、验收不碰 `${NEXTTIME_DATA}/config`、S1→S2→S3 可在主机连跑）

| 项 | 范围 | 状态 |
|---|---|---|
| 四份 heredoc driver 抽成一份 | `deploy/accept/driver.mjs` + `scripts/lib/accept-common.sh`，四份脚本只做编排 | 完成（PR #145；driver 有 14 例 vitest；主机从分支连跑 S1 22 / S2 66 / S3 28 全过） |
| fake provider 切换改为 compose override，不再改生产 provider 配置 | `deploy/accept/docker-compose.fake.yml`、`accept_provider_up/restore`、worker-supervisor `MODELS_JSON_HOST_PATH` | 完成（PR #146；主机从分支连跑 S1 22 / S2 66 / S3 28 全过，生产 `llm-providers.yaml` / `models.json` 前后校验和不变） |
| 至少 S1 精简版进 CI | `scripts/accept_s1.sh --lite` + `.github/workflows/e2e.yml` 末尾一步（复用已起的 postgres/kernel/caddy + fake agent runtime） | 完成（PR #148；CI 首跑 13 PASS + 6 SKIP，跳过的是需要入口容器的步骤） |
| fake-llm 场景参数按注册表校验 | `deploy/accept-s2/fake-llm-scenario-selftest.mjs` 读 `docs/contracts/capabilities.json` | 完成（PR #149；含两条验证器自检） |

**W7 真实模型验证 + Explorer 按调用者鉴权：完成**（2026-09-11；范围见 `retrospective-2026-09-09.md` §4，评估与数字见 `retrospective-2026-09-11.md`）

| 项 | 范围 | 状态 |
|---|---|---|
| e2e 全量进 CI | 三个 Playwright 套件都跑，审批场景在 CI 里播种、允许一次重试，报告总是上传 | 完成（PR #151） |
| Explorer 按调用者身份鉴权 | 内核签发同源会话 cookie，caddy 不再持有 key | 完成（PR #153；遗留 8 关闭；主机从分支验证，curl 全流程 + S3 29 PASS） |
| 工具调用结果可观测 | `isError` 全链路 + driver 的 `TOOL_*` 计数 + transcript-stats | 完成（PR #155） |
| 真实模型验证模式 | `--real <provider/model> [--runs N]` | 完成（PR #156；主机验证，数字见 `retrospective-2026-09-11.md` §2） |
| 顺带修复 | grants 作用域按文本比对（#152）；采集器 `depends_on` 条件后缀（#157），均由真实模型或 CI 首次发现 | 完成 |

**当前波次：W8 平台管理 + 稳定期**（2026-09-11 起。维护者同日先指出：装好的主机上没有任何能登录的账户，登录后也没有地方建工作区、加用户、配模型；S4.1 合入后又否决其"读令牌 + 初始化页、查表设密码"的首登路径，并要求**先想清楚再做**：S1–S3 交付的是使用面与内核，"做完之后我怎么配置这个平台、怎么用起来、怎么维护"没有答案。答案是 `platform-admin-design.md` v3（对照本地克隆的 cloudflare-os 源码逐文件核对过）：**使用面**——普通用户登录即落在自己的对话页，选自己的模型、有自己的上下文，不配置任何东西；**管理面**——用户、工作区配置（今天的 owner 页面搬家）、模型与供应商、集成、模块、平台设置；**维护面**——概览与首次运行清单、运行层升级、运行状态、平台审计。个人区在共享图内自动就位，不做"每用户一个工作区"，也不做多租户管理页。S4.2–S4.5 作废，改为 P-A1 → P-A2 → P-B → P-C → P-D（`development-tasks.md` 同名小节）。主机整栈常驻供真实使用；已关 27（#159）、29（#160）；33 按 chat 隔离已决定、并入 P-A2；其后 30 / 23 / 21 / 20 / 22。）

| 项 | 状态 |
|---|---|
| S4.1 用户目录与登录 | 完成（PR #164，2026-09-11；e2e `login.spec.ts` 进 CI；迁移 0019 待主机 `make migrate`）。其"一次性令牌 + 初始化页"首登路径被否决，由 P-A1 的预置 `admin` 取代；身份模型、登录、cookie 会话、API key 路径沿用 |
| P-A1 身份、用户与管理面骨架 | 完成（PR #168 → v0.7.0，2026-09-11；CI guards / quality / test（含 Postgres 集成套件）/ web-e2e 全绿，e2e 已在真实栈上跑通 admin 首登 → 改密 → 概览 → 用户页）：预置 `admin` + 默认工作区、`scope:'platform'` 通道与 `withPlatform` 事务、15 个平台能力 + `add_member`、迁移 0020 / 0021（`users` RLS、`platform_settings`）、侧栏三组 + 概览 / 用户 / 平台设置 / 平台审计页、e2e 改为 admin 首登；实现说明见 `development-tasks.md` P-A1。主机已应用（v0.8.0，2026-09-12） |
| P-A2 使用面收口 | 完成（PR #171 → v0.8.0，2026-09-12；CI guards / quality / test（含 Postgres 集成套件）/ web-e2e 全绿，新 e2e 在真实栈上跑通建部门工作区 → 委托 owner → owner 侧栏只见工作区配置、模型下拉收窄）：六个平台能力（`list_workspaces` / `list_platform_models` / `create_workspace` / `update_workspace` / `set_workspace_status` / `set_allowed_models`）、迁移 core 0022 + governance 0011、允许的模型改为解析期上限、禁用工作区关 API key / Handle 通道并停入口容器、`instanceInstructions` 进入口与 Worker 的 system prompt（一次性 Worker 首次拿到 WorkerDefinition 的 `systemPrompt`）、遗留 33 按 chat 分 pi 会话（agent-host `switch_session`）、web 工作区页与 e2e（建部门工作区 → 委托 owner → owner 只见自己工作区配置、模型下拉收窄）；实现说明见 `development-tasks.md` P-A2。主机已应用（v0.8.0，2026-09-12） |
| P-B1 门与集成目录 | 完成（PR #175 → v0.9.0，2026-09-12；CI 全绿，新 e2e 在真实栈上跑通：CI 播种一个"发现的门实例" → 集成页启用 / vetted / 测试连接 → 工作区"系统接入"一键启用注册 Gatekeeper 并发布 2 个 Operation → 接入包禁用 `restart_thing` 后能力目录隐藏 → 访问页签发 service Handle → 集成页外部运行时吊销）：迁移 core 0023（`connectors` 三态 + 禁用名单、`gate_instances`、`workspace_gate_links`）、`POST /internal/gates/announce` + kernel 失联扫描、gatekeeper-base 自注册心跳（docker / ragflow 门经 compose 接入）、平台能力 `list_connectors` / `set_connector_mode` / `list_gate_instances` / `get_gate_instance` / `update_gate_instance` / `test_gate_instance` / `list_external_runtimes` / `revoke_external_runtime`、工作区 `list_available_gate_instances` / `enable_gate_instance` / `issue_service_handle`、按 Operation 禁用在建请求与执行两处卡口、MCP 提示位入 Operation 与决策期信任规则（`mcp_gate_not_vetted`）、web 集成页 + 系统接入"从平台目录启用" + 访问页签发凭证；顺带修了 e2e 抓出的既有 bug（系统接入页把 `search` 信封当数组，"已注册的系统"一直加载失败）。sonnet reviewer 五条（执行期不复查禁用名单、吊销运行时不吊销 Handle、同名 announce 可改已启用实例的身份、失联恢复丢管理员决定、并发启用竞态）均在合入前修正；实现说明见 `development-tasks.md` P-B 实现说明（P-B1）。主机已应用（v0.9.0，2026-09-12） |
| P-B2a 门宿主与页面直达凭证 | 完成（PR #179 → v0.10.0，2026-09-12；CI guards / quality / test（含 Postgres 集成套件）/ web-e2e 全绿，新 e2e 在真实栈上跑通：建 mcp 宿主实例 → 宿主接管（≤ 90 s）→ 浏览器经 JWT 直达路存共享凭证 → 测试连接 ok → 启用 → 接入包 `mcp` 设平台预置 → owner 一键启用、目录出现两个工具 → vetted → 禁用其一目录隐藏）：迁移 core 0024（`gate_instances.hosted / definition`）、`GET /internal/gate-host/instances`、平台能力 `create_gate_instance` / `delete_gate_instance` / `issue_gate_host_token`、工作区 `issue_gate_credential_token`、共享 `gate-host-token.ts`（5 分钟 EdDSA JWT，与 Handle / 控制台会话双向互斥）、gatekeeper-base `GATE_MODE=host`（拉定义 → 建实例 → 逐个 announce；`/i/<id>/gate/*`；凭证路由只认平台 JWT）、compose `gate-host` + secret `gate_host_store_key` + Caddy `/gate-host/*`、web 新建实例 / 录入共享凭证 / 录入我的凭证。sonnet reviewer 四条（凭证路由接受 `gate_token` 等于让任何工作区经内核改写任何槽位；删后同名新建继承旧凭证；建即 `enabled` 可被内部 token 抢填端点；`http` 无 manifest 永远 not-ready）与测试 builder 一条（首次 announce 可改种类）均在合入前修正；CodeQL 另促成“按注册路由分类 + 凭证路由限速”。实现说明见 `development-tasks.md` P-B 实现说明（P-B2a）。主机已应用（v0.10.0，2026-09-12） |
| P-B2b 模块 / P-C 运行层与运行状态 / P-D 模型与供应商 | 待做（P-B2b 内容见 `development-tasks.md` P-B "P-B2 再拆与决定"） |

**主机应用注意**（v0.8.0 已按此完成，记录在 `docs/private/host-apply-2026-09-02.md` §41）：v0.6.0 **不单独应用**——它的首登路径已作废；直接应用 v0.8.0（含 v0.6.0 的迁移 0019 与 v0.7.0 / v0.8.0 的全部迁移），顺序：① 重跑 `host-env-init.sh`（幂等，补建 `secrets/setup`，否则 Docker 代建目录为 root 所有、kernel 写不出初始密码）；② `make migrate`（0019 回填 + 0020 + P-A1 的迁移）；③ 重建 kernel + caddy + web（P-A2 合入后还要重建 worker-supervisor 与 agent-host：`/task/spawn` 多了 `systemPrompt` 字段、按 chat 切 pi 会话在 agent-host；迁移多 core 0022 + governance 0011；P-B1 合入后还要重建 gatekeeper-docker 与 gatekeeper-ragflow——它们启动即向内核自注册，compose 给它们新挂了 `internal_token`；迁移多 core 0023；P-B2a 合入后先重跑 `host-bootstrap.sh` / `host-env-init.sh` / `gen-handle-keys.sh`（新目录 `gate-host/` 归 10001、新 secret `gate-host-store.key`），再 `build gate-host caddy` 并 `up -d gate-host caddy`（Caddyfile 新增 `/gate-host/*`）；迁移多 core 0024）。之后全部在浏览器里：用 `secrets/setup/initial-admin-password` 里的临时密码登录 `admin` → 改密 → 概览页"绑定已有 API key"贴上手里的 owner key → 原工作区归到 `admin`；其他既有成员由管理员在用户页重置临时密码，或自己用 key 登录一次设密码。不需要查表、不需要 CLI。

**产品决定已做**（2026-09-10，PR #142）：Worker 经结果契约写回的 Fact 默认全工作区可见，会话 JSONL 转录另作 `private` Source 挂在自己的 `worker_session` Activity 上，不再牵连结果 Fact 的可见性。此前带转录的运行其 Fact 只对派发人可见，是实现细节而非产品规则（`development-tasks.md` S2.9 实现说明）。由 CI 的 Postgres 集成测试覆盖，三份验收脚本不断言可见性（加断言属 W6 范围）。

目标主机：2026-09-12 已应用 v0.10.0（08:59Z；迁移 core 0024，三个主机脚本重跑补 `gate-host/` 目录与 `gate-host-store.key`，全量重建，16 个服务 Up 含新 `gate-host`，`KERNEL_VERSION=0.10.0`；此前同日 06:49Z 应用 v0.9.0：迁移 core 0023，全量重建，两个打包门启动即自注册并以 `discovered` 出现在集成页，`test_gate_instance` 均 ok；此前同日 08:00 前后应用 v0.8.0——直接从 v0.5.1 升上来：备份 → 全量重建含 worker-supervisor / agent-host / worker-runtime → 迁移 core 0019–0022 + governance 0011 → 整栈拉起，中断约 30 秒）；kernel 首启预置 `admin`，管理员经 API 首登改密、绑定既有 owner key 接管 `stability` 工作区并设为默认工作区、入口模型设为生产模型，首次运行清单五项全 done；控制台凭证只在本机 `docs/private/`。此前 2026-09-11 应用过 v0.5.0（S1 22+1 / S2 66 / S3 29）与 v0.5.1；稳定期内整栈常驻（生产 provider 配置，无 fake 覆盖），建了一个真实使用的工作区并注册两个门；不再在验收后停栈。

后续（2026-09-17 决定：S5 先于 W8 剩余项）：S5 W10 → W11 → P-B2b 模块 → P-C 运行层与运行状态 → P-D 模型与供应商 → 镜像发布与 P5（P-A1 / P-A2 / P-B1 / P-B2a 已完成）。

**当前波次：S5 基座打磨 W9：完成**（2026-09-17 → 18，v0.11.0；范围与波次表见 `development-tasks.md` §5b "S5 实施波次"，四项待决按推荐缺省取定并记在该表头）。三条车道文件互斥并行：内核核心由主会话完成，W9-B / W9-C 各一个 sonnet 子代理在自己的 worktree 里做、主会话审 diff 后开 PR。

| 车道 | 项 | 状态 |
|---|---|---|
| W9-C | 遗留 36 `create_connection` 拒绝命中任何 `gate_instances.endpoint` 的地址（400 `endpoint_is_platform_gate`）；`accept_s2.sh` 的 docker 门改走 P-B1 目录路径 | 完成（PR #186；关闭 36） |
| W9-C | 遗留 22 supervisor `reconcile()` 以标签 ∪ 当前已发布 egressDeny 为准，复用分支 egressDeny 变化并入重建判定 | 完成（PR #187；关闭 22） |
| W9-C | 遗留 20 postgres / 两个打包门 / gate-host / caddy 补 `read_only` + `cap_drop:[ALL]` + `no-new-privileges`（caddy 文件 capability 改 `cap_add: [NET_BIND_SERVICE]`） | 完成（PR #188；关闭 20；打包门的加固只能在主机验证） |
| W9-B | S5.4 prompt 与工具描述对齐契约（09-09 审计 15 条）、`scripts/guards/prompt-contract.mjs` 进 `ci:guards`、fake-llm 拒绝非对象工具 schema | 完成（PR #190） |
| W9-A | S5.1 I2 在 `SqlGraphStore.assertFact` / `supersedeFact` 写入点强制（覆盖全部八处写入者），工作区 `ontology_enforcement`（迁移 core 0025：既有行 `warn`、新建 `reject`），I-S5-1 进 `/internal/metrics`，`platform-meta` 补声明 `observed`，S2 / S3 脚本各加一步 | 完成（PR #191 + 平台工作区页开关 #192；关闭 37） |
| W9-A | S5.2 迁移 core 0026（`last_observation_id / last_observed_at`）、`submit_observations` 观察窗口退休 `not_reobserved`、门观察带 Source（I-S5-2）、core 0027 `assertFact` 同源优先（实现窗口时暴露的 S3.2 边界：异源反驳后采集器会落在对方的行上、再开 Conflict 并误退休自己的行）、采集器每轮最后一次提交声明窗口、S3 脚本三段式 freshness 步 | 完成（PR #193；关闭 28 / 38） |

**W9 主机应用注意**（v0.10.1 + v0.11.0 一起应用；迁移 core 0025 / 0026 / 0027；全部镜像重建）：① 先重跑 `host-env-init.sh`（#188 后 postgres 非 root、`pg_password` 权限）再 `docker compose up -d`；② `make migrate`；③ 重建 kernel / web / worker-supervisor / collector-host-inventory / gatekeeper-docker / gatekeeper-ragflow / gate-host / caddy / postgres / worker-runtime / fake-llm；④ **S5.1 推出**：0025 把所有既有工作区回填为 `warn`，先跑一轮采集与 S1 → S2 → S3 验收（S2 新增 `ontology_step` 与门端点拦截断言，S3 新增 `ontology_guard_step` 与 `collector_freshness_step`），看 `/internal/metrics` 的 `nexttime_invariant_violations{invariant="I-S5-1"}` 为 0 后，在平台"工作区"页把每个工作区切到 `reject`；⑤ **S5.2 首轮**：第一次带窗口的采集运行会退休遗留 28 的幻影 `depends_on` 边（`run complete` 的 `factsInvalidated`），S5.2 之前写入的门 Fact 保持旧溯源、要迁移就 `invalidate_fact`；`I-S5-2` 应为 0（非 0 即有 service Handle 直接 `assert_fact`）；⑥ 两个打包门的 `read_only` / `cap_drop` 只能在主机验证——三份验收复跑通过即算；⑦ 结果记 `docs/private/`，并回填本文 §2 的验收证据行。

**S5 W10：完成**（2026-09-18，v0.12.0；四条车道文件互斥并行——S5.3 内核核心由主会话完成，B1 / B2 / C 各一个 sonnet 子代理）。

| 车道 | 项 | 状态 |
|---|---|---|
| W10-A | S5.3 数据与代码分离：迁移 core 0028（`sources.name` + 唯一索引、`workspaces.purpose / expires_at`）、`register_source` 按 (kind, name) 幂等（409 `source_identity_conflict`）、采集器每轮注册无本地状态、kernel `DOMAIN_PACK_DIR=/data/config/ontology` 放文件即 seed、`create-workspace --purpose ephemeral --ttl`、`delete-workspaces-matching.sh --expired`、工作区抽屉只读显示 | 完成（PR #195；关闭 9、11 部分） |
| W10-B2 | 遗留 21 `list_action_requests` + 控制台审批页 History 标签；遗留 31 核实 Explorer 专属会话已退役 | 完成（PR #197；关闭 21 / 31） |
| W10-B1 | 遗留 24 `assertFact` advisory lock 重读仍为空时有界循环到链尾（core 0029 `latest_fact_invalidated_for_identity`）；遗留 23 `queryDecisions` / `listConflicts` cursor 毫秒截断；遗留 34 十五处同 client `Promise.all` 顺序化 + `vitest.setup.ts` 把 pg 警告变测试失败 | 完成（PR #198 / #199；关闭 23 / 24 / 34） |
| W10-C | S5.6：`queued` 崩溃缺口清扫 `spawn_lost` + I-S5-3 + `chaos-kill-kernel-mid-invoke.sh`；遗留 25 / 40 单独 testTimeout（40 顺带把固定 sleep 改轮询）；遗留 30 根因与修复（`await_decision: false` 的 ActionRequest 不再把 Task 挂 `waiting_approval`）；遗留 26 核实无回归 | 完成（PR #200；关闭 25 / 30 / 40） |

**W10 主机应用注意**（与 W9 的注意一起做，v0.10.1 + v0.11.0 + v0.12.0 一次应用；新增迁移 core 0028 / 0029）：① **先按 S5.3 实现说明核对采集器 Source 谱系**——记下状态文件里的 `sourceId`，`make migrate` 后若生产工作区有重名 `host-inventory-collector` Source、记下的那行 `name` 为空，手动 `update sources set name = 'host-inventory' where id = <记下的 id>`，否则采集器另起谱系、S5.2 窗口接不上旧 Fact；② 重跑 `host-env-init.sh`（建 `config/ontology/`），把 `ontology/ops-assets-v1.yaml` / `v2.yaml` 放进去；③ 重建 kernel / web / collector-host-inventory（采集器不再挂 `/data/state`）；④ 应用后 `/internal/metrics` 看 `I-S5-2` / `I-S5-3` 为 0，`delete-workspaces-matching.sh --expired` 先 dry-run 一次；⑤ 跑一次 `scripts/chaos-kill-kernel-mid-invoke.sh`（两种 PASS 都算）；⑥ S1 → S2 → S3 复跑（工作区现在是 ephemeral、7 天到期）；⑦ 遗留 30 的主机验证归 S5.7（`accept_s2.sh --real --runs 10` 复跑 docker_restart 场景）。

**S5 W11：本地部分完成，主机侧待做**（2026-09-18；三条 sonnet 车道并行，主会话审 diff；回顾见 `retrospective-2026-09-18.md`）。

| 车道 | 项 | 状态 |
|---|---|---|
| W11-E | S5.7 `scripts/report-usage.sh`（`--workspace` / `--since` / `--until`、`--by turn\|handle\|task`、`--markdown`、`--summary`）+ `runbooks/host-accept-real-model.md` §3 阈值（`--runs 10` 例行、任一场景 `<8/10` 记已知问题）、§8 例行回归七步、§9 `docs/private/real-model-<date>.md` 模板 | 完成（PR #202）；五场景各 10 次的数字待主机 |
| W11-D2 | S5.8 item 3 `make demo` / `scripts/demo.sh` + `runbooks/demo.md`：不碰生产采集器密钥，Q3 复用 `accept-s2-restart-target` fixture | 完成（PR #204）；15 分钟预算待主机实测 |
| W11-D1 | S5.8 item 1 / 2 `scripts/drill-install.sh`、`scripts/drill-upgrade.sh`、`runbooks/host-drills.md`、`runbooks/release.md` §6 迁移可逆性 | 完成（PR #205）；干净主机安装 / 升级回滚演练待主机实跑 |

**W11 主机侧（2026-09-18 实做，目标主机）**：① `drill-upgrade.sh --to v0.13.0` 从 v0.10.0 演练：第一次在 `build-to` 因 npm registry 瞬断失败（迁移前、无副作用，切回 `main` 重跑），第二次全绿——三份验收在 v0.13.0 上通过、`PROBE old-code-on-new-schema ok`（实证 core 0025–0029 可逆）、回滚后 S1 通过，总计约 21 分钟（构建 174 s、三份验收 304 s、探针 646 s），细节与耗时表见 `runbooks/host-drills.md` "首次实跑记录"；② 真实升级到 v0.13.0（`main` = tag，迁移 5 条，16 服务），手动步骤：`host-env-init.sh`、`config/ontology/` 放入两个领域包、给生产工作区重铸采集器 Handle + `seed-domain-pack` 发布 ops-assets v1（发现遗留 41：生产采集器已 401 一周）、首轮采集 578 对象 / 181 事实；③ 升级后 S1 冒烟 22 PASS，chaos 脚本命中窗口（`spawn_lost`），`/internal/metrics` 全部不变量 0（含 I-S5-1 / 2 / 3；caddy 不反代 `/internal/*`，走 control 网络读）；S2 / S3 的 v0.13.0 证据取自演练那一轮，未在 fake 模式下重复跑；④ S5.7 真实模型回归（`--runs 10 --keep` ×2 + `make demo`，v0.13.0）：api_observe 10/10、dependency_chat 10/10、ssh_run_auto 1/1，但 docker_restart 0/10、ssh_run_approve 3/10——同一签名（动作已执行、Task `failed / no_result`），Task 未被挂 `waiting_approval`（#200 生效），内核日志给出 `report_task_result` 400 `OntologyViolationError` ×15：真实模型的 Worker 在结果契约里附带越界 Fact，S5.1 `reject` 拒绝后整份契约回滚、扩展以 0 退出——遗留 30 的第二根因，#208 修（本体拒绝改为单条拒绝 + 审计 + `factsRejected`）；`make demo` 到 Q3 `interrupted`——门在 Q1 / Q2 之后才连接，Q3 开始时 supervisor 重建常驻容器撞上 Turn（遗留 44），#210 把门连接挪到首轮对话前。两个修复合入后主机重建 kernel 复跑，数字见 §2.2；token / 费用见私有记录；⑤ `drill-install.sh` 无干净主机，未实跑；⑥ S5.1 `warn → reject` 在真实模型一轮观察后切换。原待办清单如下，留作下次主机应用的模板：① 主机检出还在 v0.10.0、里面没有演练脚本，先从新 tag 取出来再跑：`git fetch origin --tags && git show v0.13.0:scripts/drill-upgrade.sh > /tmp/drill-upgrade.sh && sh /tmp/drill-upgrade.sh --to v0.13.0 --ack-live-restore`（从 v0.10.0 演练升级 → 三份验收 → PROBE → 回滚，结束回到 v0.10.0，升级前 dump 保留；脚本本就把自己复制到检出外运行，从 `/tmp` 起跑与从检出起跑等价）——注意先做 W10 注意 ① 的 Source 谱系核对，演练的 restore 会撤销手动步骤；② 按脚本末尾打印的命令真实升级到 v0.13.0（v0.13.0 只有脚本与 runbook、无迁移，迁移仍是 core 0025–0029），再补做 W9 / W10 主机应用注意里的手动步骤（`host-env-init.sh`、`config/ontology/`、Source `name`、S5.1 先 `warn` 后 `reject`）；③ S1 → S2 → S3 复跑、chaos 脚本、`/internal/metrics` 看 I-S5-1 / 2 / 3；④ S5.7：`accept_s2.sh` / `accept_s3.sh --real <provider/model> --runs 10 --keep` + `DEMO_MODEL=<provider/model> make demo` + `report-usage.sh`，按 `host-accept-real-model.md` §8 / §9 写 `docs/private/real-model-<date>.md`，纯计数进本文 §2.2 与 §2 "真实模型验证"行，遗留 30 的 docker_restart 复跑在此验证；⑤ 有干净主机时跑 `drill-install.sh`（`REF=v0.12.0`），耗时与交付缺口回填 `host-drills.md`；⑥ 数字齐后补 `retrospective-2026-09-18.md` §6，并按 S5.8 item 4 重评镜像发布（五场景均 ≥ 8/10 则排期）。

**下一波**：W11 主机侧完成后按原顺序 P-B2b → P-C → P-D。

**S5 立项记录（2026-09-16，`development-tasks.md` §5b）**。
维护者 2026-09-16 决定暂不做场景层、先打磨基座。对 main（v0.10.0）逐项核实后，2026-09-09 回顾 §5 的 12 个非最优点已关闭 7 个；仍开放且属基座的归为 S5 七项：S5.1 本体约束在写入点强制（I2 目前只是 `validate` 能力，复审 §4-1）→ S5.2 新鲜度与失效（`last_observed_at`、`not_reobserved` 观察窗口，关闭 28）→ S5.3 数据与代码分离（关闭 9、11 部分）→ S5.4 prompt 契约修复与守卫（09-09 审计 15 条 + `prompt-contract` 守卫 + fake 侧工具形状校验）→ S5.5 加固批次（36 / 22 / 20 先做，再 23 / 24 / 34 / 31 / 21）→ S5.6 稳定性（30、`queued` 崩溃缺口、26、25）→ S5.7 真实模型回归常态化（五场景各 10 次）→ S5.8 交付与演示闭环（W11 最后一项，2026-09-16 维护者确认：陌生主机安装演练、升级 / 回滚演练、15 分钟 `make demo`、镜像发布重评；不扩大基座边界）。
波次 W9-A / W9-B / W9-C 文件互斥、与 P-B2b 互斥，可立即并行；W10 三车道随后；W11 收口。四项待决：与 W8 的先后、S5.1 先 `warn` 再 `reject`、失效语义放内核还是采集器、遗留 36 的修法。明确不做：socket-proxy 收敛（三套特权集，保持）、备份 root+cap（保持）、Object 逐属性溯源（推后）、场景层与 P5（推后）。

## 4. 遗留清单

每条要么链接到关闭它的 PR，要么标明归属波次。关闭遗留的 PR 必须同时改本表。
级别沿用复审口径：P1 破坏不变量 / 授权 / 可靠性；P2 加固与运维正确性；P3 语义与文档漂移。

| # | 项 | 级别 | 归属 | 状态 |
|---|---|---|---|---|
| 1 | `explain` 对 collector Fact 返回整批 Observation（>400KB）；根因是 Fact 与 Observation 无直接关系（`retrospective-2026-09-09.md` §5.1） | P2 | W5 | 关闭（PR #132：迁移 0018 加 `links.observation_id`，`explain(factId)` 收窄到该 Fact 自己的 Observation） |
| 2 | `search` 无 `limit` / `cursor`，硬上限 50（§5.5） | P2 | W5 | 关闭（PR #132：加 `limit`/`cursor` 与 `GraphStore.searchPage`，`MAX_SEARCH_LIMIT=200` 截断标 `truncated:true`） |
| 3 | `create_task` 的 Task 永远 `queued`；2026-09-10 复审确认它在唯一现实路径上不可达，**建议下架**（`code-review-2026-09-10.md` §3.2） | P2 | W5 | 关闭（PR #131：下架，接线留到授权衰减模型有结论之后） |
| 4 | fake-llm 自检 `entry-restart-chat-turn2/3` 预存失败 | P3 | W5 | 关闭（PR #129：自检夹具对齐线上契约形状，自检进 CI `quality`） |
| 5 | Renovate 首跑未见 | P3 | W5 | 关闭（决定：暂不安装；Dependabot 告警暂不处理，见 §3） |
| 6 | E7 主机备份定时器"S3 后重评" | — | 运维，最后 | 待决定（2026-09-10 维护者：运维项排在开发波次之后） |
| 7 | 验收 harness：四份 heredoc driver、验收改生产 provider 配置、fake-llm 硬编码场景（§5.2–5.4） | P2 | W6 | 关闭（W6：#145 driver 抽成一份、#146 provider 改 compose override、#148 S1 精简版进 CI、#149 场景参数按注册表校验） |
| 8 | Explorer 由 caddy 注入 key 的信任边界（§5.8） | P2 | W7 | 关闭（PR #153：改为按调用者身份的内核签发会话 cookie，caddy 不再持有 key） |
| 9 | 领域包烤进 kernel 镜像（§5.7）；采集器 Source 状态按文件缓存（§5.9） | P3 | S5.3（W10-A） | 关闭（PR #195：`seed-domain-pack` 缺省从主机 `config/ontology/`（kernel `DOMAIN_PACK_DIR`，经既有只读 `config/` 挂载）读，放文件即 seed、不重建 kernel；`register_source` 按 (kind, name) 幂等（迁移 core 0028 `sources.name` + 唯一索引），采集器每轮注册、无本地状态。**主机应用前先按 S5.3 实现说明核对采集器 Source 谱系**——生产工作区若有重名 Source，回填不填 `name`，要手动把状态文件里记的那行命名，否则 S5.2 窗口接不上旧 Fact） |
| 10 | `extension_ui_request` 子协议；Trigger；CLI help 清单解析 | 功能缺口 | P5 | 开放 |
| 11 | 容器运行时访问面收敛（§5.10）；备份 root + capability（§5.11）；清理靠名字正则（§5.12） | P2 | S5.3 关名字正则；socket-proxy 与备份决定保持（§5b"不做"） | 部分关闭（PR #195：`workspaces.purpose` / `expires_at`（迁移 core 0028），`create-workspace --purpose ephemeral --ttl`，验收 / 演练脚本全部改用，`delete-workspaces-matching.sh --expired` 按到期清理；§5.10 / §5.11 按 §5b"不做"决定保持，本行余下部分记债） |
| 12 | bot PR 的 CI 需人工批准 run（决定：暂维持人工） | — | 决定 | 关闭 |
| 13 | 容器镜像不发布到 GitHub（决定：稳定后再做） | — | 决定 | 关闭 |
| 14 | 主机验收记录断档：09-09 的 S3 验收与 v0.2.0 / v0.3.0 发版都没有 `docs/private/` 记录（主机上也没有该目录），最新一份记录停在 09-04；§2 的 22 / 66 / 24 目前只有 retrospective 与 PR 正文为据 | P2 | W5 / 流程 | 关闭（2026-09-10：v0.4.2 主机应用与三份验收记录写入 `docs/private/` §34，§2 的 22 / 66 / 28 有据） |
| 15 | 入库文档与代码状态漂移：`README.md` 仍称「设计阶段（v0.2）…仓库只有文档，尚无可运行组件」；设计文档头部仍写「全部为提案…尚无任何组件实现」、§7.6 仍写「当前实现只有『工作』区」、§9.3 把 task 组标 `propose / observe` 而注册表里 `create_task` / `cancel_task` 均为 `write`；`development-tasks.md` 的 S3.6 一节没有完成标记，而其代码与验收都已落地 | P3 | docs PR | 关闭（PR #128：README 重写、设计文档头部 / §7.6 / §9.3 修正、S3.6 完成标记） |
| 16 | **Worker 断言的 Fact 永远按 principal 判定来源**：`postWorkerResult` 先断言后记 Observation，`resolveFactOrigin` 因此拿不到 Source；叠加 agent principal 每 WorkerDefinition 一个，同一定义两次运行的矛盾断言被静默 supersede 而非开 Conflict —— S3.2 的核心场景（`code-review-2026-09-10.md` §2.1） | **P1** | W5.5 | 关闭（PR #137：`postWorkerResult` 先注册私有 `worker_session` Source/Observation 再断言，`assertFact` 异源同内容视为佐证、异源异内容开 Conflict，见 `development-tasks.md` S2.9 W5.5 实现说明） |
| 17 | 并发首次断言同一身份不开 Conflict：`FOR UPDATE` 锁不住不存在的行，`links` 上也无 `(link_type, source, target)` 唯一约束（`code-review-2026-09-10.md` §2.2） | **P1** | W5.5 | 关闭（PR #140：`assertFact` 在无既有 Fact 时按身份取事务级 advisory lock 并重读，`substrate/epistemic/conflicts.test.ts` 加两条并发正向用例） |
| 18 | Handle 通道不校验 `minRole`，`member` 的入口 Handle 结构性携带 5 个 `minRole:'builder'` 的 `propose_*` 并可调用；不构成越权发布（草稿私有 + I16），但 `minRole` 在该通道事实失效（`code-review-2026-09-10.md` §2.3；代码已自认并写明修法） | **P1** | W5.5 | 关闭（PR #138：`entryScope({role})` 按 on_behalf_of 角色收窄入口 Handle 的 ceiling，`roleSatisfiesMinRole` 下沉到 `governance/capability`，`set_principal_role` 变更角色时吊销入口会话 Handle） |
| 19 | `llm-proxy` 无任何预算代码，设计 §5.4 I18 的「100% 时代理返回预算耗尽错误」未实现，超支只能由内核事后止损（`code-review-2026-09-10.md` §3.1） | P2 | P-D | 开放 |
| 20 | 两个门容器与 caddy / postgres 无 `read_only` / `cap_drop:[ALL]` / `no-new-privileges`，其余服务均有；门是唯一持外部凭证的进程（`code-review-2026-09-10.md` §3.3） | P2 | S5.5（W9-C） | 关闭（PR #188：五个服务补齐三项 + 最小 tmpfs / cap_add；postgres / caddy / gate-host 由 CI e2e 真栈验证，gatekeeper-docker / gatekeeper-ragflow 待主机应用后三份验收复跑） |
| 21 | 控制台看不到审批历史：注册表只有 `list_pending` 与 `get_action`，无列出已决 ActionRequest 的能力（`code-review-2026-09-10.md` §3.4） | P2 | S5.5（W10-B） | 关闭（PR #197：新增能力 `list_action_requests`（`status`/`gatekeeperId` 过滤、keyset 游标分页，同 `list_pending` 的 I14 可见性），`governance/approval/reads.ts` `listActionRequestsForApprover`；控制台 Approvals 页（`/work/approvals`）加"History"标签页，替换原会话级"All"标签的占位说明，详见 `development-tasks.md` S5.5 实现说明） |
| 22 | 出网拒绝表在 `reconcile()` 后回退到容器创建时的旧值：标签只在创建时打，复用分支刷新 source map 却回写不了标签，而 `reconcile()` 每次 docker-events 重连都跑；与 `EGRESS_DENY_LABEL` 自称的「永不放宽，哪怕暂时」冲突（`code-review-2026-09-10.md` §3.5；平台级拒绝不受影响） | P2 | S5.5（W9-C） | 关闭（PR #187：reconcile 以标签 ∪ 当前已发布 egressDeny 为准，复用分支 egressDeny 变化并入重建判定；reuse-then-reconcile 测试） |
| 23 | `query_decisions` / `list_conflicts` 的 keyset cursor 与 `search` 修复前同一模式：`created_at` 经 JS `Date` 只剩毫秒，回传后与微秒精度的列做 `<` 比较，同一毫秒内（同事务写入）的行会在翻页边界被漏掉；`search` 在 PR #132 里改为 `date_trunc('milliseconds', …)` 作排序键，这两处未改 | P2 | S5.5（W10-B） | 关闭（PR #199：`queryDecisions` / `listConflicts` 改为按 `(date_trunc('milliseconds', <ts>), id)` 排序与比较，cursor 的 id 半段也校验为 uuid；同毫秒两行 `limit:1` 翻页不漏的集成测试） |
| 24 | `find_active_fact_for_identity`（0017）的 `for update` 在被阻塞期间若持锁方 supersede 了该行，重查按 `superseded_at is null` 过滤后返回 0 行而非后继行；PR 17 的 advisory lock + 重读封住了两事务形态，三事务交错（第二个等锁者的重读又阻塞在第三个事务的 supersede 上）仍可能插入一条多余的活跃 Fact。0017 既有机制的局限，复审 17 时发现 | P3 | S5.5（W10-B） | 关闭（PR #198：迁移 core 0029 `latest_fact_invalidated_for_identity`（security definer，只答"该身份最新一行是否已失效"）；`assertFact` 在 advisory lock 重读仍为空时有界循环——最新行存在且未失效（`recorded` 或 `superseded`，后继可能尚不可见）就再读一次，最多 5 次；判 `invalidated_at` 而非 `superseded_at`，因为连续两次 supersede 会让最新行本身就是未被 supersede 的链尾。四事务确定性集成测试（advisory lock 占位 + 第二个 superseder）复现原缺陷并证明修复） |
| 25 | CI 偶发：`interfaces/ws/server.test.ts` 的 WS 端到端用例在 PR #140 首跑时 5 秒超时，重跑通过（其余 1100 用例均过）；疑为 runner 争用，若复现需给该用例单独 `testTimeout` 或查 listener 启动时序 | P3 | S5.6（W10-C） | 关闭（PR #200：该用例单独给 `testTimeout: 15000`，vitest 默认 5s 与其自身 `waitUntil` 的 5s 内部超时几乎无余量；未改用例语义。2026-09-18 在 #204 的 CI 重跑里复现一次——`waitUntil timed out` 5.2s，说明只放宽 `testTimeout` 不够、用例自己的 `waitUntil` 仍是 5s 默认；PR #206 给那一处 `waitUntil` 单独 12s 预算，仍在 15s 之内。再复现则查 listener / outbox 派发时序而不是继续放宽） |
| 26 | `accept_s2.sh` 的 cleanup 对 accept-s2 profile 做 `down` 时连基础栈一起停掉，S1→S2→S3 无法一次连跑；应改为只 `rm -sf` 五个夹具服务，或由统一 driver 在 S3 前重新拉起（2026-09-10 主机实测） | P2 | W6 | 关闭（PR #145：cleanup 改为只 `rm -sf` 六个夹具容器，主机 S1→S2→S3 连跑通过） |
| 27 | outbox dispatcher 构造时未传 `onError`，消费者异常被静默吞掉（#152 的根因之所以晚发现） | P2 | W8 | 关闭（PR #159：`createBackgroundServices` 加 `onOutboxError`，`main()` 传 `app.log.error`；投递失败以 `OutboxDeliveryError` 带 outbox id / 事件类型 / 次数 / 是否 dead-letter 记日志） |
| 28 | 已有图里 `depends_on` 指向的幻影 Container（`<service>:service_healthy:false`）要等采集器下一轮 supersede；旧对象留作历史 | P3 | S5.2（W9-A） | 关闭（PR #193：采集器每轮最后一次提交声明观察窗口，同一 Source 本轮未再观察到的活跃 Fact 置 `invalidated_at` / `not_reobserved`；0018 之前无 Observation 的行按 Activity 的 Source 回退匹配，主机首个带窗口的运行即退休幻影边；Object 留作历史） |
| 29 | 新工作区首轮 Turn `interrupted`、0 次工具调用（S3 real 1/3 与 v0.5.0 应用时 fake S1 各一次；后者有容器日志实证，前者容器已重建、只有 egress-proxy 的同型 CONNECT 记录为据）。根因不是冷启动 / Handle 竞态：入口容器启动自检的"经代理公网通"探测（5 秒）在弱网下超时且致命退出，容器 spawn 后 5 秒死亡；30 秒后内核 accept 超时再记一次 `failed` | P2 | W8 | 关闭（PR #160：探测改 `result=warn` 不退出，I9 / I10 仍致命；`AgentHostRuntime` 在 `turnEnded` 先到时结清 accept 等待。`development-tasks.md` S2.9 W8 修订） |
| 30 | 真实模型下 docker_restart 一次 ActionRequest executed、容器已重启但 Task failed 且 result 为空（S2 real 1/3 的失败） | P2 | S5.6（W10-C） | 关闭（PR #200：根因经代码通读确认——`application/task/reaper.ts` 的 `ActionRequestPending` 路由消费者不论 `await_decision` 一律把 Task 挂 `waiting_approval`；`container.restart`（docker 门，`await_decision:false`，`gatekeepers/docker` 自己的 manifest）的门工具本就设计成不阻塞 agent loop——模型看到"pending approval"后可以立刻 `report_result`，此时 Task 还是 `waiting_approval`，`completeTaskWithResult` 的 `transition(TASK_TRANSITIONS, 'waiting_approval', 'complete')` 无此边直接抛 `IllegalTransition`，整个 `report_task_result` 事务（含本该写入的 Facts）回滚，Worker 只记日志退出；ActionRequest 稍后独立被批准 / 执行，Task 被 `ActionRequestUpdated` 恢复回 `running` 后其 WorkerRun 早已不在，被 reaper 判 `no_result` 收尾——正是"ActionRequest executed、Task failed、result 为空"。修法：路由消费者只在 `awaitDecision===true` 时才挂起 Task（`governance/approval/await-decision.ts` 自己的模块文档已写明 S2.3 原始验收标准就是"await_decision=true 时 Task 进 waiting_approval"，这里此前一直没读这个字段）；`reaper.integration.test.ts` 新增一例正向断言（`await_decision:false` 不挂起）、既有例改 `await_decision:true`（它测的本来就是真正阻塞场景）。主机 `accept_s2.sh --real --runs 10` 复跑验证留给 S5.7）。**2026-09-18 主机复跑（v0.13.0）：docker_restart 0/10、ssh_run_approve 3/10——第二根因**：Task 已不再被挂起（#200 生效），但真实模型 Worker 的结果契约附带越界 Fact（`observed_state_of`、未声明的端点类型），S5.1 `reject` 在写入点拒绝后 `report_task_result` 400 `OntologyViolationError`（该工作区 16 次上报 15 次如此）、整份契约回滚、扩展按设计以 0 退出、reaper 判 `no_result`。PR #208：本体拒绝改为单条 savepoint 回滚 + `task.result_fact_rejected` 审计 + `tasks.result.factsRejected[]`，Task 照常完成，其它错误仍整单回滚；v0.13.1 复跑数字见 §2.2。扩展侧"模型看不到拒绝"另记遗留 42 |
| 31 | Explorer 会话 cookie 不随 `rotate_api_key` 失效（8 小时 TTL 为界；`disable_principal` 即时生效） | P3 | S5.5（W10-B，先核实是否已被控制台会话取代） | 关闭（核实：W7 的 Explorer 专属会话已在 S4.1 退役——`interfaces/explorer-contract/index.ts` 的 `registerExplorerRoutes` 自身注释"W7's POST/DELETE /api/explorer/session were retired in S4.1"，`authenticateExplorerCaller` 现只认 `X-API-Key` 或控制台会话 cookie（`resolveRequestCaller`），无第二套 Explorer 会话可失效。控制台会话按用户（`user_sessions`）而非按 Principal：`logout`（`interfaces/http/auth-routes.ts` 调 `revokeUserSession`）与 `disable_principal`（`application/gateway/auth.ts` `lookupMembershipPrincipal` 每请求重查 `disabled_at is null`，非缓存）都即时生效；`rotate_api_key`（`application/gateway/members-handlers.ts`）只更新 `principals.api_key_hash`，不触碰 `user_sessions` 或 Handle 会话，因此确实不影响控制台会话——原遗留描述的前提（Explorer 有独立会话）已不成立，按既定拟修关闭，未改代码） |
| 32 | CodeQL 预存告警：`hashApiKey` 用 sha256（32 字节随机 key，判定为合理）需维护者 dismiss；`e2e / web-e2e` 需维护者加为必需检查 | — | 决定 | 关闭（2026-09-11 维护者已把 `e2e / web-e2e` 加为必需检查并 dismiss 告警 57） |
| 33 | 入口容器的 pi 会话跨 chat 延续（真实模型第三轮回复"这已经是你第三次问同一个问题"）——是否应按 chat 隔离上下文是产品问题 | P3 | W8 | **已关（PR #171，P-A2）**：agent-host 在 chat 变化时先发 `switch_session`（路径按 `chatId` 派生、不存在即新建）再发 `prompt`，容器重建后必切；跨对话记忆仍靠 `context` 注入。原决定（2026-09-11 维护者）：按 chat 隔离——每个 Chat 一份 pi 会话（pi RPC `new_session` / `switch_session`），跨对话记忆靠 `context` 注入而非 pi 会话文件。已核实 pi 0.84.4 源码：`switch_session` 对不存在的路径会新建、`new_session` 后 `get_state` 立即有 `sessionFile`、`session_start` 在切换时重触发且 `registerTool` 同名覆盖——因此可以由 agent-host 单方面按 `chatId` 派生会话文件路径实现，不需要内核新列或新帧 |
| 34 | kernel 日志有 pg `DeprecationWarning: Calling client.query() when the client is already executing a query`（2026-09-11 主机 v0.5.0 首轮对话时出现）——同一 client 上并发 query，pg@9 将不再允许；需定位是哪条路径在 `withWorkspace` 的 client 上不等待就发第二条语句 | P2 | S5.5（W10-B） | 关闭（PR #199：不是一条路径而是十五处在同一 client 上 `Promise.all` 并发查询（`explain` 三处、`decisions` 两处、agent-profile 三处、审批 routing / stats、平台工作区读、Explorer 读、门读两处、`get_entry_context`），全部改为顺序 await（门健康探测是网络调用，保持并行）；`packages/kernel/vitest.setup.ts` 把 pg 这条 DeprecationWarning 提升为测试失败） |
| 35 | 用 API key 登录控制台的会话没有控制台 cookie，浏览器里打不开 Explorer（S4.1 起 Explorer 只认 `X-API-Key` 或控制台 cookie）；API key 是给自动化与过渡期的，人用密码登录即可——记为已知行为，随"验收 harness 迁到 service Principal"一起看 | P3 | 记债 | 开放 |
| 36 | `create_connection` 的 `endpoint` 由调用者给出且无白名单，内核对每个门调用都带同一把 `gate_token`：工作区 owner 可把自连的 http 门指向 `http://gate-host:8083/i/<id>`，在本工作区得到一个绕过 `workspace_gate_links`（禁用名单、`vetted`）的 Gatekeeper，并用管理员录入的共享凭证驱动宿主实例（P-B2a 审查提出前提、只封住了写凭证一半；打包门此前同样暴露，宿主的共享凭证使之实质变重）。拟修：`create_connection` 拒绝命中任何 `gate_instances.endpoint`（或宿主 `/i/` 路径）的端点 + 集成测试；单独 PR / 审查 / 发版 | P1 | S5.5（W9-C，单独 PR，P-B2b 前） | 关闭（PR #186：`create_connection` 在任何网络调用前按解析后的 host 拒绝命中任何 `gate_instances.endpoint` 的地址（400 `endpoint_is_platform_gate`；一个已宣告的宿主实例即覆盖 `gate-host` 整个 `/i/*`）；`platform-gates` 集成测试三例；`accept_s2.sh` 的 docker 门改走 P-B1 目录路径（先断言旧自连被拒，再 discovered→enabled + `enable_gate_instance`），fake-llm 的 docker 场景改从请求 `tools` 里挑重启工具；残余：同一容器的 IP / 别名不在检测内，靠 compose 网络边界；S2 主机复跑待应用） |
| 37 | I2 只是能力不是不变量：`validateLink` 只被 `validate` 能力调用，`assertFact` / `supersedeFact` / `submit_observations` 的 link 写入不校验 LinkType 声明与 domain / range（`code-review-2026-09-10.md` §4-1；设计 §5.4 写"内核写入校验 + 触发器"） | P2 | S5.1（W9-A） | 关闭（PR #191：`SqlGraphStore.assertFact` / `supersedeFact` 写前按工作区已发布本体校验 LinkType 与 domain / range，覆盖全部八处写入者；工作区 `ontology_enforcement`（迁移 core 0025：既有行回填 `warn`，新建缺省 `reject`）决定 400 `ontology_violation`（`details` 带四字段）还是写入 + `ontology_violation` 审计；`platform-meta` 补声明 `observed`；`update_workspace` / `create_workspace` 可设；S2 脚本先发布 AcceptS2 本体族，S3 脚本加故意违规步；已知边界：没有任何已发布本体的工作区不强制——只有测试夹具处于该状态。主机：v(next) 应用后先 `warn` 跑一轮采集与 S2 / S3，I-S5-1 为 0 再切 `reject`） |
| 38 | Fact 有起源 Observation（0018）但无新鲜度与失效：幂等 no-op 不记录再次确认，`links` / `objects` 无 `last_observed_at`，采集器对消失对象无失效语义（遗留 28 的根因） | P2 | S5.2（W9-A） | 关闭（PR #193：迁移 core 0026 加 `links.last_observation_id / last_observed_at`、`objects.last_observed_at`，同源再观察推进时钟；`submit_observations` 的 `window` 退休未再观察的 Fact；门的 `observe` / `apply` 结果记 Observation（I-S5-2）；core 0027 让 `assertFact` 建立在调用者自己的活跃行上，修掉窗口下"异源反驳后自己的行被误退休"；S3 脚本加三段式 freshness 步；主机：首个带窗口的采集运行会退休遗留 28 的幻影边，S5.2 前的门 Fact 保持旧溯源、要迁移需 `invalidate_fact`） |
| 39 | `createPool` 从不给 pg Pool 挂 `error` 监听：空闲连接被终止（Postgres 重启 / failover / `drop database … with (force)`）即成为未捕获异常打崩进程。main 上 #182 合入后的 CI（run 35079054627）以 `FATAL 57P01` 暴露——五个隔离库集成测试的 `pool.end()` 在 socket 关闭前就 resolve，随后的强制 drop 终止了自己的后端 | P2 | 2026-09-16 | 关闭（PR #183：`createPool` 总挂监听 + `main()` 接到 Fastify 日志；五个测试在强制 drop 前等 `pg_stat_activity` 清零） |
| 40 | CI 偶发：`packages/llm-proxy` 的 "kernel down then up" 用例（内核先不可达再恢复）在 PR #187 首跑超时，重跑通过；与遗留 25 同型（runner 争用 / 起停时序），若复现给该用例单独 `testTimeout` 或查恢复探测的时序 | P3 | S5.6（W10-C） | 关闭（PR #200：该用例单独给 `testTimeout: 15000`；确认根因之一是一个固定 150ms `sleep` 赌"kernel down 期间至少一次失败 flush 已入队"，在 runner 争用下不够——改成轮询 `reporter.pending > 0` 而不是猜一个固定延迟，语义不变，实测更快（161ms 内全部通过）） |

| 41 | `accept_s3.sh` 每次运行都把新铸的采集器 Handle 写进生产的 `secrets/collector-host-inventory.token`（脚本头注释里承认的"共享状态取舍"）。主机实测后果：生产采集器自 09-11 最后一次 S3 验收起一直 401（token 指向已禁用的 accept-s3 工作区），生产工作区一周没有采集数据、没人发现。升级 v0.13.0 时重铸 Handle 并发布 ops-assets 才恢复。拟修：改成 `demo.sh` 的做法——铸到私有文件、`docker compose run -e NEXTTIME_HANDLE_TOKEN_FILE -v …:ro` 只对本次 `--once` 生效、结束即删；另加一条不变量或告警：采集器连续 N 轮 401 / 非零错误要在 `/internal/metrics` 可见 | P2 | S6 / 下次验收改造 | 开放 |

| 42 | 扩展 `modes/worker.ts`：`report_result` 工具立刻回复 "Result contract recorded."，真正的 `report_task_result` 在 `agent_settled` 才 POST；内核拒绝（400 / 403）时只记日志、以 0 退出（避免触发 S2.7 重跑），模型永远看不到拒绝、无法改正。拟修：`report_result` 时同步上报并把内核错误作为 `isError` 回给模型（保留 `agent_settled` 兜底），或至少把 `factsRejected` 回显给模型；I16 的 403（元本体类型）仍整单拒绝，同样需要回显 | P2 | S6 | 开放（2026-09-18 主机 `--real` 发现） |
| 43 | `await_decision: false` 的门工具下，真实模型 Worker 在请求动作后立刻 inspect、看到"还没执行"就 `report_result`，摘要写"未执行、待审批"——两秒后动作才落地；`tasks.result.summary` 与事实不符（#208 之后 Task 已能完成，但摘要仍是过时的）。属 Worker prompt 契约：Worker 应在 `report_result` 前对未决 ActionRequest 轮询 `get_action` 或明确交代"结果以 ActionRequest 状态为准"；进 S5.4 的 prompt-contract 守卫范围 | P3 | S6 | 开放 |
| 44 | 常驻入口容器重建与进行中 Turn 竞争：`connect_gatekeeper` 等改变工作区门集合 / egress 后，下一轮 Turn 开始时内核 `POST /resident/spawn`，supervisor（#187 reconcile）发现规格已变而 `docker stop` 旧容器重建——这一轮 Turn 已派给旧容器，agent-host 报 `interrupted`。主机首次 `make demo` 在 Q3 撞上（#210 把 demo 的门连接挪到首轮对话前规避）；真实用户在对话中途接入门也会撞上。拟修：spawn 路径里"需要重建"时先完成重建再派发 Turn（或把重建推迟到当前 Turn 结算后），并加集成测试 | P2 | S6 | 开放 |

## 5. 更新规则

1. 会话开始：读本文；再读与本次任务相关的 `development-tasks.md` 小节与 runbook。
2. 波次合入、主机验收、发版之后：更新 §2 状态与证据、§3 进度、§4 增删；同一 PR 或紧随的
   docs PR 完成。
3. 关闭遗留的 PR 必须同时把 §4 对应行改为"关闭 + PR 号"。
4. 不写主机别名、IP、路径、密钥、外部系统 ID（公开仓库）；主机应用细节记在 gitignored 的
   `docs/private/`。
5. 评估、反思、复审写独立文档（`retrospective-*.md` / `code-review-*.md`）并在 §1 登记；本文只链接。
6. 每次复审或阶段收口，在 §2.1 时间线追加一行（只追加，不覆盖历史），并把新发现按级别加进 §4。
7. §2 的「达成」以验收脚本为准；发现验收未覆盖的缺陷时，不改里程碑状态，在 §2.2 记下盲区、在 §4 立项。
