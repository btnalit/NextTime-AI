# 阶段回顾（2026-09-11）：W7 真实模型验证 + Explorer 按调用者鉴权

> 本文记录 W7 的评估与决定：真实模型第一次跑通 S2 / S3 场景时暴露了什么、数字是多少、
> 哪些是平台缺陷、哪些是验收工具的缺陷。设计见 `graph-ai-middle-platform-design.md`，
> 任务与实现说明见 `development-tasks.md`，进度与遗留见 `STATUS.md`（本文只被它链接）。
> 具体供应商、模型 id、费用只在 `docs/private/`。

## 1. 范围与结果

W7 的两项目标（`retrospective-2026-09-09.md` §4）都已落地：

| 目标 | 结果 |
|---|---|
| Explorer 鉴权改为按调用者身份、caddy 不再持有 key | PR #153：控制台登录后由内核签发同源 `HttpOnly; Secure; SameSite=Strict; Path=/api` 会话 cookie；九个 Explorer 端点先看 `X-API-Key` 再看 cookie，每次请求重读 Principal 与 web 会话；caddy 的注入块与 `EXPLORER_API_KEY` 删除。主机从分支 curl 全流程与 S3 29 PASS 验证后合入。 |
| 真实模型跑 S2 / S3 场景并统计工具调用成功率 | PR #155（`isError` 全链路 + driver 计数）与 PR #156（`--real <provider/model> [--runs N]`）；主机用真实模型各跑 3 轮，数字见 §2。 |

顺带完成：e2e 工作流跑全部 Playwright 用例（#151，审批场景在 CI 里播种）、以及真实模型
一轮就找出来的三个平台缺陷（§3）。

## 2. 真实模型下的数字（主机，第二轮，每场景 3 次）

| 场景 | 成功 | 入口 agent 工具调用 / 报错 | Worker 工具调用 / 报错 |
|---|---|---|---|
| docker_restart（对话 → 委派 → 门 → 审批 → 执行 → 容器真的重启） | 2/3 | 54 / 6 | 16 / 1 |
| api_observe（对话 → 直接 observe → 回复含 fixture 载荷） | 3/3 | 6 / 0 | — |
| ssh_run_approve（自然语言委派 → 待审批 → 批准 → 执行） | 3/3 | — | 19 / 2 |
| ssh_run_auto（always-allow 之后无卡片直接执行） | 1/1 | — | 2 / 0 |
| dependency_chat（S3："哪个服务依赖哪个"） | 2/3 | 33 / 0 | — |

读法：
- **每个场景都至少成功一次，且失败都不是"模型选错工具"**：docker_restart 的失败一次是
  ActionRequest 已 executed、容器已重启、但 Task 最终 failed；dependency_chat 的失败一次是
  新工作区首轮 Turn `interrupted`、0 次工具调用（疑似入口容器冷启动竞态）。两者都记入遗留。
- 报错的工具调用几乎全在"探索"阶段（入口 agent 反复 `find_*`/`propose_procedure`，Worker 先
  用 `bash` 摸索再走 ssh 门），模型都能从报错里恢复并完成；这正是 fake-llm 永远看不到的部分。
- 调用次数波动很大（同一场景 2 到 31 次），成本按 token 计价可控（两轮合计约百次调用，
  费用在 `docs/private/` §38）。

**第一轮**（同一分支、未修 §3.1 之前）：入口 agent 每轮 0 次工具调用、无回复、Turn 却
`completed`；Worker 侧场景 3/4 成功。这一轮的价值是把 §3.1 找出来。

## 3. 真实模型找出的平台缺陷

### 3.1 无参门工具的 schema 让整个入口 agent 失效（P1，已修 #156）

http 门从 OpenAPI 导入的无参 GET 的 `params_schema` 为 `null`，platform-extension 三个模式把它
原样当作 pi 工具的 `parameters` 交给供应商；OpenAI 兼容接口对任一 function schema 不是
`type: "object"` 就拒绝**整个请求**，于是只要工作区里接入过一个这样的 Operation，入口 agent
每一轮都 400。fake-llm 从不校验 schema，所以 S2 66 PASS 了几周。修法是
`gateToolParameters` 统一归一成 object schema。**教训**：凡是"投影给模型"的形状，验收里必须
有一条真实供应商的路径，或者至少在 fake 侧做 schema 校验（#149 只校验了脚本化调用的参数，
没校验工具定义本身）。

### 3.2 非 uuid 的 `resource_scope` 让审批状态播报静默失败（P1，已修 #152）

不是真实模型找到的，是 #151 让 `approvals.spec.ts` 第一次进 CI 才撞上：`capability_grants.
resource_id`（uuid）与 ActionRequest 的 `resource_scope`（text）直接 `=`，非 uuid 的 scope
让持有者计算 22P02 中止，`ActionRequestUpdated` 消费者抛错后被 outbox dispatcher **静默吞掉**
（`index.ts` 构造 dispatcher 时没传 `onError`），对话里永远没有状态行。主机流程的 scope 恰好
都是 gatekeeper id，所以从未暴露。dispatcher 无 `onError` 记为遗留 27。

### 3.3 采集器把 compose 依赖条件当成服务名（P2，已修 #157）

真实模型回答"哪个服务依赖哪个"时主动指出：`depends_on` 边的目标是形如
`<service>:service_healthy:false` 的节点，它自己把它们还原成了服务名。核实是采集器对
`com.docker.compose.depends_on` label 的解析没有切掉 `:<condition>:<required>`。fake 模式的
S3 只断言"从 kernel 出发有一条 depends_on 边"，所以也没发现。已有图里的幻影 Container 要等
采集器下一轮跑过才被 supersede（遗留 28）。

## 4. 验收工具本身的教训

- **判据要按结果，不按过程**：真实模型一轮可能产出多条 assistant 消息，`completed` 元数据
  也可能先于最后一条消息落库；`--real` 模式改为历史稳定后取全部 assistant 文本判定。
- **审批要能在 Turn 进行中给出**：真实入口 agent 会用 `wait:true` 调 `invoke_worker`，Turn
  阻塞在审批上，shell 又阻塞在 driver 上；driver 的 `auto-approve=<gate>` 解决了这个死锁。
- **一次失败是数据点，不是脚本失败**：`--real` 只在某场景 0/N 时失败；成功率进 STATUS。
- **e2e 工作流现在跑全部用例**（含审批与 Explorer 会话），已具备升级为必需检查的条件；
  升级后不能加 `paths` 过滤器，工作流/job 名要保持不变。

## 5. 决定与下一步

- W7 关闭；进入两周稳定期（冻结新能力，真实使用，收问题）。
- 稳定期里值得优先看的：遗留 29（新工作区首轮 `interrupted`）、30（docker_restart 一次
  Task failed 且 result 为空）、27（dispatcher `onError`）。
- 维护者动作：把 `e2e / web-e2e` 加为分支保护的必需检查；处理 CodeQL 对 `hashApiKey` 的
  预存告警（32 字节随机 API key 用 sha256 是合理的，可 dismiss）。
