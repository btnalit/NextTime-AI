# Runbook：host-chaos（不变量监控与混沌演练）

对应任务：development-tasks.md § S3.8（"不变量监控与混沌"）。设计依据：
`docs/graph-ai-middle-platform-design.md` §5.4（I1–I16 不变量表）、§13（故障恢复）。

不含：备份恢复演练（见 `docs/runbooks/backup-restore.md`）、日常重启/健康检查（见
`docs/runbooks/operations.md`）、排查一次具体失败的 Task（见 `docs/runbooks/troubleshoot-task.md`
——本文档只覆盖"主动杀掉一个容器，验证系统按设计文档 §13 自愈"，不是失败诊断流程）。

## 1. 目的

两个操作员脚本，各自主动杀掉一类容器并验证内核按设计文档 §13 的预期状态恢复：

- `scripts/chaos-kill-worker.sh` — 杀一个正在跑的 Worker 容器，验证 Task 回到 `queued`
  （attempt 计数增加，任务 reaper 重试）或 `failed`（重试耗尽）。
- `scripts/chaos-kill-entry.sh` — 杀某个 principal 的常驻入口容器，验证下一轮对话触发
  worker-supervisor 重新拉起同名容器（restarts 计数增加），对话本身可续。

以及一个定时不变量监控器：`packages/kernel/src/substrate/audit/invariant-checks.ts`
（设计文档 §5.4 的 I1–I16），随内核进程常驻运行，不是一次性脚本——本文档 §5 覆盖它的运维面
（如何看当前状态、如何调整频率），验证机制本身的设计见该文件自己的模块级文档注释（I1–I16
逐条映射到查询或说明"为什么不可数据库检查"的表格）。

## 2. 前置条件

- 目标主机 `docker compose` 栈已起（`postgres kernel caddy worker-supervisor agent-host` 至少要
  在跑；`chaos-kill-worker.sh` 还需要一个当前正在跑 Worker 的 Task）。
- 有 `docker`、`docker compose`（v2）、`curl`；**没有** `node`/`corepack` 假设成立
  （worker-supervisor 内部状态探测走一次性 kernel 镜像容器，同 `scripts/accept_s1.sh` 的
  `resident_status()` 助手）。
- 一个 human 通道 API key，角色至少 `member`（`send_chat_message`/`get_task`/`list_tasks` 各自的
  `minRole`）——两个脚本都只用这一种凭证，不需要单独铸造 Handle。
- `chaos-kill-worker.sh` 需要一个已知的、当前正在跑的 `taskId`（例如从 web 控制台的 Task 视图，或
  `scripts/accept_s2.sh` 跑出来的一个 `invoke_worker` 调用）。
- `chaos-kill-entry.sh` 需要一个已知的 `principalId`（其入口容器必须已经在跑——先跟这个 principal
  的账号对过一次话）；`chatId` 可省略，省略时脚本会用 `new_chat` 现造一个。

## 3. 怎么跑

杀 Worker：

```
cd <CODE_DIR>
sh scripts/chaos-kill-worker.sh <taskId> <apiKey>
```

带自定义超时（默认 90 秒——任务 reaper 默认每 30 秒跑一次，`TASK_REAPER_INTERVAL_MS`，给它最多
3 轮）：

```
sh scripts/chaos-kill-worker.sh <taskId> <apiKey> 120
```

杀入口容器（省略 `chatId` 时脚本自己 `new_chat`）：

```
sh scripts/chaos-kill-entry.sh <principalId> <apiKey>
```

带已有的 `chatId` 与自定义超时（默认 60 秒）：

```
sh scripts/chaos-kill-entry.sh <principalId> <apiKey> <chatId> 90
```

经 SSH 跑（同 `scripts/accept_s1.sh` 的既有约定，管道场景必须带 `</dev/null`）：

```
ssh <TARGET_HOST> 'cd <CODE_DIR> && sh scripts/chaos-kill-worker.sh <taskId> <apiKey>' </dev/null
```

## 4. 期望输出（验证）

逐步打印 `PASS <step> <detail>`；任何一步失败打印 `FAIL <step> <detail>` 并以非 0 退出（两个脚本
都不带 `set -e`，每一步显式判断，失败立即退出，不带着已知的错误状态继续往后跑——同
`scripts/accept_s1.sh` 的既有约定）。API key 只打印前 6 位（`redact()`）。

`chaos-kill-worker.sh` 成功时（设计文档 §13 "Worker 崩溃 → Task 回 queued，attempt+1"）：

```
PASS get-task-baseline task status=running running workerRunId=<uuid>
PASS kill-worker-container killed nexttime-task-<uuid>
PASS task-recovered task <taskId> status=queued (design doc §13: Worker 崩溃 -> Task 回 queued attempt+1, 或 failed)
PASS worker-run-retried a new WorkerRun (<uuid>) is already running, distinct from the killed one (<uuid>)
```

`status=failed`（重试耗尽）时最后两行换成：

```
PASS task-recovered task <taskId> status=failed (design doc §13: Worker 崩溃 -> Task 回 queued attempt+1, 或 failed)
```

（`failed` 分支不再检查 `worker-run-retried`——没有新 WorkerRun 可看。）

`chaos-kill-entry.sh` 成功时（设计文档 §13 "入口容器崩溃 → supervisor 以同一工作目录重拉"）：

```
PASS resident-baseline restarts=<N>
PASS kill-entry-container killed nexttime-entry-<principalId>
PASS new-chat created chat <uuid>
PASS send-chat-message sent — turnId=<uuid> (this is the §13 'next turn' that should trigger a respawn)
PASS entry-recovered restarts=<N+1> (was <N>), running=true — design doc §13: 入口容器崩溃 -> supervisor 以同一工作目录重拉
PASS chat-continues get_chat_history on <chatId> still answers after the kill (对话可续)
```

## 5. 定时不变量监控（运维面）

`packages/kernel/src/index.ts` 的 `createBackgroundServices`：每 `INVARIANT_CHECK_INTERVAL_MS`
（默认 10 分钟，`0` 关闭该定时器）跑一遍 `runInvariantChecks`（`substrate/audit/
invariant-checks.ts`），对每条违反的不变量打一条结构化 `warn` 日志（`{invariant, violations,
sample}`）——干净时（每条都是 0）不打印任何行，不是刷屏式地每条都记一次"OK"。

当前状态经 `GET /internal/metrics`（Prometheus 文本格式，同 `/internal/*` 的既有令牌网关认证）
读取——`docker compose logs kernel` 之外的第二个观测面：

```
curl -sk -H "Authorization: Bearer $(cat "${NEXTTIME_DATA}/secrets/internal.token")" \
  "https://<host>:8443/internal/metrics"
```

（若 caddy 未反代 `/internal/*` 到宿主机，改在 kernel 容器所在的 `control` 网络内直接探测，同
`docs/runbooks/operations.md` 记录的其它 `/internal/*` 探测方式。）

```
# HELP nexttime_invariant_violations Current violation count per invariant, from the most recent scheduled check.
# TYPE nexttime_invariant_violations gauge
nexttime_invariant_violations{invariant="I4"} 0
nexttime_invariant_violations{invariant="I6"} 0
...
# HELP nexttime_invariant_check_last_run_timestamp_seconds Unix timestamp of the most recent invariant-check tick.
# TYPE nexttime_invariant_check_last_run_timestamp_seconds gauge
nexttime_invariant_check_last_run_timestamp_seconds 1757310000
```

调整频率（`.env`，同 `OUTBOX_PRUNE_INTERVAL_MS` 的既有约定）：

```
# INVARIANT_CHECK_INTERVAL_MS=600000
```

I1–I16 逐条映射到具体查询、还是"设计上不可数据库检查"（连同各自的理由），见
`invariant-checks.ts` 自己的模块级文档注释——不在本 runbook 里重复一份会随代码漂移的副本。

## 6. 回滚 / 清理

两个脚本本身没有"回滚"概念——它们只是主动制造一次容器崩溃，验证既有的自愈机制，不改变任何
持久化状态本身（Task/WorkerRun/ActionRequest 的状态转移都是内核既有的、受审计的路径，不是这两
个脚本自己写的）。需要清理的只有:

- `chaos-kill-worker.sh` 跑完后若 Task 最终 `status=failed`，需要人工判断是否重新 `invoke_worker`
  ——脚本本身不重试。
- `chaos-kill-entry.sh` 若用省略 `chatId` 的调用方式，会留下一个新建的 Chat（`new_chat` 创建）；
  不需要它了可以直接在 web 控制台里忽略（Chat 没有删除能力，同其它设计上只追加的资源）。
- 两个脚本杀掉的容器都会被各自的既有机制自动重建（Worker 由 reaper 重新排队后新起，入口容器由
  下一次 `ensureEntryHandle` 重建）——不需要手动 `docker compose up` 或 `docker start`。

## 7. 常见问题

- **`chaos-kill-worker.sh` 报 `FAIL get-task-baseline ... no running WorkerRun found`**：给的
  `taskId` 当前没有 `status=running` 的 WorkerRun（可能已经 `completed`/`failed`，或还在
  `pending_approval`/`queued` 排队中还没起容器）——换一个真的正在跑的 Task，或先跑
  `scripts/accept_s2.sh`/手动 `invoke_worker` 造一个。
- **`chaos-kill-worker.sh` 报 `FAIL kill-worker-container ... docker kill ... failed`**：容器名
  `nexttime-task-<workerRunId>` 按 `packages/worker-supervisor/src/task-spawn-spec.ts` 的
  `taskContainerName` 计算——若容器已经不存在（比如两次 chaos 调用之间已经被 reaper 正常回收），
  `docker kill` 自然失败；`docker ps -a --filter name=nexttime-task-` 确认。
- **`chaos-kill-worker.sh` 超时未见 `queued`/`failed`**：确认 worker-supervisor 与内核的 Task
  reaper 都在跑（`docs/runbooks/operations.md` §3 服务依赖图）；`TASK_REAPER_INTERVAL_MS`/
  `TASK_MAX_RUNTIME_SEC` 若被调大过，默认的 90 秒超时可能不够，加大脚本的第三个参数。
- **`chaos-kill-entry.sh` 报 `FAIL resident-baseline ... did not report FOUND=1`**：这个
  `principalId` 当前没有常驻入口容器（还没对过话，或已经因为空闲超时被 supervisor 停掉）——先跟
  这个账号发一条消息，等入口容器起来后再跑本脚本。
- **`chaos-kill-entry.sh` 超时未见 restarts 增加**：确认 agent-host 与 worker-supervisor 都在跑
  （同上，服务依赖图）；`send-chat-message` 这一步本身若已经 `FAIL`，说明触发"下一轮"这一步都没
  成功，先排查那一步的错误信息，不是重建机制本身的问题。
- **`GET /internal/metrics` 里看不到某条 `nexttime_invariant_violations{invariant="..."}`**：
  内核刚重启，第一次 tick 还没跑（`INVARIANT_CHECK_INITIAL_DELAY_MS`，10 秒，比其它 reaper 的
  "等一整个 interval 才跑第一次"更短，但仍需要那几秒）；`nexttime_invariant_check_last_run_
  timestamp_seconds` 为 `0` 也是同一个信号——还没跑过第一次。
