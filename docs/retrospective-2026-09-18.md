# 阶段回顾（2026-09-18）：S5 基座打磨 W9 + W10

> 本文记录 S5 前六项（S5.1–S5.6）两个波次的评估与决定：实现时暴露了哪些设计边界、
> 哪些遗留的根因与最初的假设不同、并行车道的流程教训、W11 要做什么。设计见
> `graph-ai-middle-platform-design.md`，任务与实现说明见 `development-tasks.md` §5b，
> 进度与遗留见 `STATUS.md`（本文只被它链接）。主机侧的验证数字（S5.7）尚未产生，见 §6。

## 1. 范围与结果

S5 八项中的六项在两个波次、两个发布（v0.11.0、v0.12.0）里合入 `main`；主机仍在 v0.10.0，
三个版本待一次应用（`STATUS.md` §3 的两段"主机应用注意"）。

| 项 | 交付 | PR | 关闭遗留 |
|---|---|---|---|
| S5.1 本体写入点强制 | I2 在 `assertFact` / `supersedeFact` 写入点强制（覆盖八处写入者）；工作区级 `ontology_enforcement`（core 0025：既有行 `warn`、新建 `reject`）；I-S5-1 | #191、#192 | 37 |
| S5.2 新鲜度与失效 | core 0026 `last_observation_id / last_observed_at`；观察窗口退休 `not_reobserved`；门观察带 Source（I-S5-2）；core 0027 同源优先；S3 三段式 freshness 步 | #193 | 28、38 |
| S5.3 数据与代码分离 | core 0028 `sources.name` + 唯一索引、`register_source` 幂等；采集器无本地状态；领域包放主机 `config/ontology/` 即 seed；ephemeral 工作区 + `--expired` 清理 | #195 | 9；11 部分 |
| S5.4 prompt 契约守卫 | 09-09 审计 15 条对齐；`prompt-contract.mjs` 进 `ci:guards`；fake-llm 拒绝非对象工具 schema | #190 | — |
| S5.5 加固批次 | 36 门端点拦截 → 22 supervisor reconcile → 20 容器加固；21 审批历史；24 重读链尾（core 0029）；23 cursor 毫秒；34 pg 同 client 并发；31 核实 | #186、#187、#188、#197、#198、#199 | 20、21、22、23、24、31、34、36 |
| S5.6 稳定性 | `queued` 崩溃缺口清扫 `spawn_lost` + I-S5-3；chaos 脚本；遗留 30 根因修复；25 / 40 testTimeout | #200 | 25、30、40 |

四项待决按推荐缺省取定（S5 先于 W8 剩余项；S5.1 主机先 `warn` 再 `reject`；失效语义在内核
`window.complete`；遗留 36 按端点拦截修），没有一项在实现中被推翻。

## 2. 实现时暴露的设计边界

三处都不是新需求，而是既有语义在并发或多源条件下的未定义行为。共同点：只靠"最新一行"
或"再读一次"这类隐含假设，多一个参与者就失效。

### 2.1 同一身份、多个来源：`limit 1` 选错行（core 0027）

S3.2 的 `find_active_fact_for_identity` 只返回最新一行。S5.2 实现观察窗口时发现：第二个
Source 反驳同一 Fact 后，采集器下一轮会落在对方的行上、再开一个 Conflict、并把自己的行误退休。
修法是返回全部活跃行、`assertFact` 优先在同源行上续写（`resolveFactOrigin`：Source 为主，
否则 Principal），窗口退休只针对本源。教训：**身份 ≠ 唯一活跃行**，多源共存是常态，不是异常。

### 2.2 三事务交错：advisory lock 后重读仍为空（core 0029，遗留 24）

`assertFact` 拿 advisory lock 后重读活跃行，本以为足够；但第三个事务可以在两次读之间把链尾
失效，重读到空、再插入就形成第二条链头。修法是 `latest_fact_invalidated_for_identity` + 有界
循环沿 `invalidated_at` 走到链尾再决定续写还是新建；四事务集成测试固定住这个交错。教训：
**"再读一次"不是并发正确性**，需要明确的链尾语义与可测的交错用例。

### 2.3 遗留 30 的根因与三个假设都不同

W7 观察到"ActionRequest 已执行、容器已重启、Task failed 且 result 为空"。任务简报里的三个
假设（reaper 误判、容器退出码、结果写入竞争）逐条核过都不是字面根因。真正的链条：
`container.restart` 是 `await_decision: false` 的门工具，但 `ActionRequestPending` 路由不读这个
字段、一律把 Task 挂成 `waiting_approval`；Worker 随后 `report_result`，`waiting_approval →
complete` 在转移表里没有边，整个结果事务回滚、Worker 退出；稍后审批通过、`ActionRequestUpdated`
把 Task 恢复 `running`，reaper 看到容器已退出，判 `no_result`。修法一行：只在
`await_decision: true` 时挂起。既有集成测试的夹具是 `false`，却一直在测阻塞场景——它能通过，
正是因为路由从不读这个字段。教训：**状态机的边是事实，日志里的现象只是投影**；一个"稳定
通过"的测试可能在测一个不存在的分支。

### 2.4 顾问审查抓到的主机过渡风险（S5.3）

`sources.name` 回填只给每个工作区最早的一行命名；生产工作区若有重名的采集器 Source，
记录在状态文件里的那行可能不是被命名的那行，采集器升级后会另起谱系、S5.2 的观察窗口接不上
旧 Fact。已写成升级前三步核对（`STATUS.md` §3 W10 主机应用注意 ①）。教训：**去状态化迁移要
核对旧状态指向的到底是哪一行**，不能假设"最早的一行"就是"当前在用的一行"。

## 3. 其它值得记录的修复

- 遗留 34：十五处对同一个 pg client 的 `Promise.all` 并发 query 顺序化；`vitest.setup.ts` 把
  pg 的 DeprecationWarning 变成测试失败，防止回潮。
- 遗留 23：`queryDecisions` / `listConflicts` 的 keyset cursor 用 `date_trunc('milliseconds', …)`
  与 JS `Date` 的精度对齐，边界行不再重复或丢失。
- 遗留 25 / 40：两条 CI 偶发用例单独 `testTimeout`；llm-proxy 那条把固定 sleep 改成轮询。
- S5.6 的 `queued` 清扫走既有 `failTaskRow`（转移表、审计、outbox 都在治理路径上），
  不重新 spawn；I-S5-3 的 5 分钟阈值远宽于清扫的 60 秒，非零即清扫本身退化。

## 4. 流程教训（并行车道）

- **文件互斥并行有效，共享锚点仍会冲突**：四条车道代码零冲突，但 `STATUS.md` 与
  `development-tasks.md` 各自在同一锚点追加，解冲突时留下重复行（#200 去重）。W11 起车道不写这
  两份文档与 runbooks 索引，实现说明随最终报告回传，由主会话在收口时统一写一次。
- **文档先于代码是缺陷**：C 车道的实现说明先写了遗留 30 的修法、代码里却还没有那一行，
  且既有夹具与说明矛盾；主会话审 diff 时发现并补上。审子代理产出以 diff 为准，不以报告为准。
- **限额不是揽活的理由**：三条车道同时撞会话限额时，主会话把三条车道的收尾都揽了下来，
  违背"智能分配任务与模型"的约定；维护者指出后改为探测-恢复子代理、机械工作走轻量模型。
  已记入长期记忆。
- **CI 不在 CONFLICTING 的 PR 上跑**：#198 rebase 前 `pull_request` 工作流根本没触发；分支保护
  又要求 head 与 base 同步。流程固定为：rebase → push → `--auto` 合并，release PR 用
  `update-branch`。
- **内核纯度守卫也管注释**：`packages/kernel/src` 里连注释都不能出现具体系统名（"docker"），
  两次被守卫拦下；措辞改为"container-restart"。

## 5. 决定与下一步（W11）

- **主机一次应用三个版本**（v0.10.1 + v0.11.0 + v0.12.0，迁移 core 0025–0029），先做 S5.3 的
  Source 谱系核对，再按两段"主机应用注意"执行；S5.1 先 `warn` 观察一轮再切 `reject`。
- **S5.7 常态化**：每次发版后 `accept_s2.sh` / `accept_s3.sh --real --runs 10`，`report-usage.sh`
  汇总 token / 费用，数字进 `docs/private/real-model-<date>.md`，计数进 `STATUS.md` §2.2；任一
  场景低于 8/10 记为该版本已知问题。遗留 30 的主机验证（docker_restart 复跑）归这里。
- **S5.8 三个演练脚本**：`drill-install.sh`（操作机经 SSH 编排、拒绝指向已有部署的主机）、
  `drill-upgrade.sh`（真实栈上升级 → 三份验收 → 回退代码 → 活库 restore → S1；结束于回退态）、
  `make demo`（ephemeral 工作区 + 采集 + 三问 + Markdown 结果页，15 分钟预算）。本地只能语法
  检查与审查，端到端由主机跑；跑不通的地方即交付缺口，回填 runbook。
- **镜像发布重评点**：S5.7 五场景 10 次的数字出来后，若均 ≥ 8/10，把"构建 / 发布容器镜像"
  从"稳定后再做"改为排期。
- 之后按 `STATUS.md` 顺序：P-B2b → P-C → P-D。

## 6. 主机侧（2026-09-18 下午，目标主机，v0.10.0 → v0.13.0 → v0.13.1）

### 6.1 升级演练与真实升级

- `drill-upgrade.sh --to v0.13.0` 从 tag 取出脚本首跑。第一次在 `build-to` 因 npm registry 瞬断失败
  （迁移前、无副作用），第二次全绿：三份验收在 v0.13.0 上通过、`PROBE old-code-on-new-schema ok`
  （v0.10.0 代码在 v0.13.0 schema 上 S1 全过，实证 core 0025–0029 可逆）、回滚后 S1 通过；约 21
  分钟（构建 174 s、三份验收 304 s、探针 646 s）。**交付缺口**：源码构建依赖 registry 实时可达，
  是 S5.8 第 4 项"发布镜像"的现实依据。
- 真实升级：`main` = v0.13.0，迁移 5 条，16 服务；手动步骤 `host-env-init.sh`、`config/ontology/`
  放入领域包、给生产工作区重铸采集器 Handle + 发布 ops-assets v1。**发现遗留 41**：生产采集器自
  09-11 最后一次 S3 验收覆盖了 token 后一直 401，生产工作区一周没有采集数据、没人发现——采集器
  错误率没有进指标。首轮采集 578 对象 / 181 事实。
- 升级后 S1 冒烟 22 PASS；chaos 脚本命中窗口（`spawn_lost`）；`/internal/metrics` 全部不变量 0
  （含 I-S5-1 / 2 / 3；caddy 不反代 `/internal/*`，走 control 网络读）。

### 6.2 真实模型一轮找出的两条平台缺陷

| 场景 | v0.13.0 | 根因 | 修复 |
|---|---|---|---|
| docker_restart | 0/10 | 动作已执行、Task `no_result`。Task 未被挂起（#200 生效），但 Worker 结果契约附带越界 Fact，S5.1 `reject` 在写入点拒绝 → `report_task_result` 400 → 整份契约回滚 → 扩展以 0 退出（避免触发重跑）→ reaper `no_result`。16 次上报 15 次如此 | #208：本体拒绝改为单条 savepoint 回滚 + 独立审计 + `factsRejected[]`，Task 照常完成；其它错误仍整单回滚 |
| ssh_run_approve | 3/10 | 同上（7 次） | 同上 |
| api_observe / dependency_chat / ssh_run_auto | 10/10、10/10、1/1 | — | — |
| make demo | 0/1，Q3 `interrupted` | demo 在 Q1 / Q2 之后才 `connect_gatekeeper`，Q3 开始时内核 `POST /resident/spawn`，supervisor（#187 reconcile）发现规格已变而 `docker stop` 旧容器——那一轮 Turn 已派给旧容器 | #210 把门连接挪到首轮对话前；平台侧竞争记遗留 44 |

教训：**fake 路径永远测不到这两条**——fake-llm 的脚本化 Worker 从不附带越界断言、fake 场景的门都在
首轮对话前接好。S5.7 常态化的价值就在这里。两条修复都是当天定根因、当天合入，`--real` 复跑是
唯一的验收方式。另记遗留 42（扩展让模型看不到内核拒绝）、43（Worker 摘要在动作落地前就写"未执
行"，prompt 契约）。

### 6.3 v0.13.1 复跑与费用

- 复跑数字：见 `STATUS.md` §2.2 的表（本节不复制）。v0.13.1 复跑把同一家族的另一半逼了出来：
  handler 预校验（I16 元本体引用、模型编的 `gatekeeperId`）仍整单拒绝，ssh 两场景 6 次 `no_result`
  皆此——#211 把预校验也改为单条记录 + 跳过（被拒条目从不写入，I16 不变）。教训：**同一原则要在
  每一层落地**——写入点改了、预校验没改，结果就是"修好了一半"；`--real` 复跑是发现这一半的唯一方式。
- `make demo` 在 v0.13.1 上首次全绿：402 s（其中 267 s 是镜像构建——发版改了根 `package.json` 版本号，
  `pnpm install` 层缓存失效、每次发版都要重新拉 registry；前两次尝试正是在这一步撞上 registry
  ECONNRESET）。这是 S5.8 第 4 项"发布镜像"的第二条现实依据。
- 费用量级（供应商 / 模型 id 只在 `docs/private/real-model-2026-09-18.md`）：S2 四场景 31 次约
  6.1M token、不到 1 美元；S3 十次约 1.5M token、约 0.36 美元；单轮平均 0.03–0.05 美元。
- `drill-install.sh` 无干净主机，未实跑。
