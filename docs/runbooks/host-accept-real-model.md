# Runbook：host-accept-real-model（W7 真实模型验收）

对应任务：`docs/development-tasks.md` § S2.12 "W7 实现说明（真实模型模式）"。前置：
`docs/runbooks/host-accept-s2.md`、`docs/runbooks/host-accept-s3.md`（本文档只讲两者共用的
`--real`/`--runs` 模式，两个脚本各自的 fake-provider 默认路径、前提、fixture 仍按各自 runbook
执行）。

## 1. 目的

`scripts/accept_s2.sh`/`scripts/accept_s3.sh` 默认路径把 llm-proxy/worker-supervisor/fake-llm
切到 fake provider，用脚本化场景（scripted tool sequence）逐字节断言"入口 agent 依次调了哪些
工具、参数是什么"——这条路径证明的是**内核/门/供应线路的接线是对的**：只要工具真的按预期顺序被
调用，网关、审批、执行、审计这一整条链路就是通的。它证明不了"一个真实模型面对这句中文提问，
真的会自己选中正确的工具"——fake provider 从不做决策，只是回放。

W7（本 runbook 覆盖的部分）反过来：保留主机上已部署的**真实**供应商/模型，让真实模型在同一批
S2/S3 场景里自己决定调用哪些工具、以什么参数调用，脚本只在**结果**层面判定成败（容器真的重启了、
Task 真的 completed、回复真的读起来像依赖关系陈述），并把每次尝试的工具调用出入统计出来。跑
`--real` 会消耗真实供应商的 token、产生真实费用——这是本 runbook 单独成篇、而不是塞进
host-accept-s2.md/host-accept-s3.md 正文的原因。

## 2. 前提

- 主机上完整技术栈已起，与不带 `--real` 时跑 S2/S3 的前提完全一致（见
  `docs/runbooks/host-accept-s2.md` §1、`docs/runbooks/host-accept-s3.md` §1）——**区别只在于
  provider 这一项**：`--real` 模式下主机上部署的必须是**真实**供应商（不是 fake-llm），且它的
  `models.json` 已经生成（`make gen-models` 或部署流程自带的等价步骤）。
- `docker compose --profile accept-s2 build` 已跑过一次（S2 fixture/gate 镜像已构建）；跑
  `accept_s3.sh --real` 同样要求 S3 自己的 preflight（collector 镜像已构建等）已满足。
- `gatekeeper-docker` 已起（`docker compose up -d gatekeeper-docker`）。
- 要用的 `<provider/model>` 必须是**当前已部署供应商** `models.json` 里真实存在的一个 id——脚本
  从不替调用者选默认模型，传一个不存在的 id 会在第一次真实调用时才暴露成 LLM 网关的错误，而不是
  preflight 阶段的检查项。
- **红线：真实的供应商名字、模型 id 与本次验收产生的费用，只写进 `docs/private/`，永远不进入本
  仓库任何入库文件、commit message、PR 描述——本文档正文自始至终只用 `<provider/model>`
  占位符。**

## 3. 怎么跑

```
cd <CODE_DIR>
sh scripts/accept_s2.sh --real <provider/model> --runs 3
sh scripts/accept_s3.sh --real <provider/model> --runs 3
```

经 SSH 跑（`</dev/null`，同其余 accept 脚本的既有约定）：

```
ssh <TARGET_HOST> 'cd <CODE_DIR> && sh scripts/accept_s2.sh --real <provider/model> --runs 3' </dev/null
ssh <TARGET_HOST> 'cd <CODE_DIR> && sh scripts/accept_s3.sh --real <provider/model> --runs 3' </dev/null
```

`--runs N` 省略时默认 3；两个脚本跑完各自 `--real` 场景后都会继续跑该脚本里与 provider 无关的
其余步骤（S2 的 step6 env/egress 探测、S8 mcp connect；S3 的 explorer/mcp 步骤），跟不带
`--real` 时一样，是同一批 PASS/FAIL 断言。**两个脚本之间不需要任何切换动作**——两者都直接使用
主机上已部署的真实 provider，跑完 `accept_s2.sh --real` 紧接着跑 `accept_s3.sh --real` 不需要
恢复或重新配置任何东西（`--real` 模式下两个脚本都完全跳过 fake-provider 的 up/restore 那一步，
`${NEXTTIME_DATA}/config/llm-providers.yaml`/`models.json` 全程不被触碰）。

**`--runs 3` 与 `--runs 10` 两种用法（S5.7）：** `--runs 3` 是开发期/单次改动后的快速冒烟——验证
某个具体修复没有让某个场景整体失效，不追求统计意义上的成功率。**`--runs 10` 是每次发版后的例行
回归**（见 §8），每个场景独立看 `ok=k/10`：**`k < 8`（低于 8/10）记为该版本的一条已知问题**——写进
`docs/private/real-model-<date>.md` 的已知问题小节，并把计数（不带供应商/模型名、不带原因分析，
只有次数）粘贴进 `STATUS.md` §2.2 对应行。`k=0`（全军覆没）本就是 `real-summary`/`real-chat-
dependency` 判定脚本本身失败的条件（§5）；`1 ≤ k < 8` 不会让脚本非 0 退出，只能靠人工读这一行记账
——**验收脚本的退出码永远不是"发现已知问题"的信号来源，§8 的例行回归必须人工读完整的 `REAL`
汇总行**。

## 4. 每个场景判定什么

每个场景重复 `--runs` 次；单次运行失败只是一个数据点，只有**一个场景在全部 runs 里都失败**才会
让脚本本身以非 0 退出——真实模型不保证每次都选对工具，这是本模式存在的意义。判定标准照抄自
`scripts/accept_s2.sh`/`scripts/accept_s3.sh` 里 `real_*_run`/`real_*_step` 各自的模块注释：

| 场景 (脚本) | 判定什么 | ok 的充要条件 |
|---|---|---|
| `docker_restart`（accept_s2.sh，`real_docker_restart_run`） | "重启测试容器" 这句中文提问 → 入口 agent 自己找到 Worker → 派工 → 门上出现 ActionRequest → 批准 → 执行 → 容器真的重启 → Task 真的 completed。**驱动脚本（`deploy/accept/driver.mjs` 的 `send-and-wait auto-approve=<gatekeeperId>`）以 alice 自己的身份，在 Turn 进行期间监听 `action.pending` 推送并当场批准**——不是这个 runbook 之外另有人工审批 | `action_requests.status=executed` 且 fixture 容器的 `StartedAt` 真的变化且对应 Task 的终态是 `completed` |
| `api_observe`（accept_s2.sh，`real_api_observe_run`） | "测试 API 的 GET 返回什么" → 入口 agent 走观察类 gate 工具（`observe_operation`，不建 Task/ActionRequest）→ 回复文本里带真实返回的 payload | Turn `completed` 且回复文本含真实 payload 的可识别片段（`NXT`）且 `audit_records.action='observe_operation'` 新增一行且 `tasks` 表行数前后不变 |
| `ssh_run_approve`（accept_s2.sh，`real_ssh_run i approve`） | Worker 在连接的 SSH 主机上跑一条未分类命令 → 产生一张卡片 → **脚本自己**（不是驱动）轮询 `list_pending`/`approve` 批准 → 执行 → Task completed | ActionRequest 走到 `executed`、期间确实观察到过 `pending_approval`、Task 终态 `completed` |
| `ssh_run_auto`（accept_s2.sh，`real_ssh_run 1 auto`） | 在 `set_auto_approved_action_kind('ssh.run_command')` 之后再触发同一条命令，验证"总是允许"生效——**这一次必须全程不出现任何卡片，直接自动批准** | ActionRequest 走到 `executed`、期间**从未**观察到 `pending_approval`、`policy_decision='allow'`、Task 终态 `completed` |
| `dependency_chat`（accept_s3.sh，`real_chat_dependency_step`） | "哪个服务依赖哪个" → 入口 agent 自己决定调 `search`/`traverse`（或等价工具）→ 回复读起来像一句依赖关系陈述，并且点名真实存在的那条边（kernel depends_on postgres） | Turn `completed` 且回复文本命中 `depends_on`/"依赖" 且命中 `postgres` |

## 5. 怎么读输出

每一次尝试打印一行：

```
RUN scenario=<key> run=<i> outcome=ok|fail <detail>
```

`<detail>` 里的字段随场景不同（见脚本内 `real_run_line` 调用处），但共同包含
`turn_tools=<calls>/<errors>[<names>]`（该 Turn 期间 `chat.stream` 统计出的工具调用数/出错数/
名字列表）；docker/ssh 两类场景还带 `worker_tools=<calls>/<errors>[<names>]`——这是 Worker 自己
那次运行的 pi 会话 JSONL 统计（见 §6），值为 `?` 说明 transcript 尚未落盘或不可读，不代表调用
失败。

每个场景跑完全部 `--runs` 次后打印一行汇总：

```
REAL scenario=<key> ok=<k>/<n> turn_tool_calls=<sum> turn_tool_errors=<sum> worker_tool_calls=<sum> worker_tool_errors=<sum>
```

`real-summary`（accept_s2.sh）/`real-chat-dependency`（accept_s3.sh）**只有当某个场景
`ok=0/<n>`（全军覆没）才会 FAIL**；`k<n`（部分失败）仍然是 PASS，脚本会在这一行旁边把
`ok=k/n` 原样打印出来，供人工判断这个真实模型在这批场景上的成功率,而不是把它当成脚本本身的
缺陷。

## 6. 数字记录在哪

`STATUS.md` § 2 / § 3 只记录**次数**（例如"W7 真实模型验收：`<provider/model>`，docker_restart
3/3、api_observe 3/3、ssh_run_approve 2/3、ssh_run_auto 1/1、dependency_chat 3/3"这类聚合行）——
供应商名字、模型 id、单次调用的实际费用、`RUN`/`REAL` 逐行原始输出，一律只落 `docs/private/`
（对应主机验收记录文件），不进入任何入库文件。

## 7. 排障

| 现象 | 根因 | 排查 |
|---|---|---|
| `task=none` | 入口 agent 这一轮根本没有派 Worker（没调 `find_workers`/`invoke_worker`，或调了但没有真的创建 Task） | 用 `get-history` 读这条 chat 的完整历史，看模型这一轮实际调了哪些工具、参数是什么 |
| `action=none` | Worker 起了、但从未真的调用门上的能力（`request_action`） | 检查 Worker 的 pi transcript（§ "worker_tools=?/?" 一行）看它这一轮到底调了什么 |
| `restarted=0` 但 `action=executed` | 门确实执行了，但 fixture 容器 id 传错/过期 | 核对本次调用里实际传给门的 `CONTAINER_ID` 与 `docker inspect` 里 fixture 容器的真实 id 是否一致 |
| `TURN_STATUS` 为空 | Turn 在脚本给的超时窗口内没有结算——真实模型比 fake provider 慢，或者卡在某次工具调用上 | 调大调用侧的超时预期，或者查 `llm-proxy` 日志确认是不是这次调用本身卡住/被限流 |
| `worker_tools=?/?` | Worker 自己的 pi 会话 transcript 还没落盘，或者当前用户读不到 | 检查 `${NEXTTIME_DATA}/workspaces/tasks/<taskId>/.pi/sessions/` 下有没有对应文件、文件权限是否允许挂载进驱动容器读取（`chmod a+r`，参照 `scripts/lib/accept-common.sh` 的 `require_world_readable`） |

## 8. 每次发版后的例行回归（S5.7）

`docs/development-tasks.md`§"S5.7 真实模型回归常态化"的设计：每次发版后在目标主机跑一轮
`--runs 10`，把成功率、平均轮数、平均 token / 成本写进 `docs/private/real-model-<date>.md`
（模板见 §9），摘要（只有次数）进 `STATUS.md` §2.2。步骤如下，均在 `<CODE_DIR>` 下执行；经 SSH
时按其余 accept 脚本的约定加 `</dev/null`。

**(1) 在主机上应用这次发版**——按 `docs/runbooks/release.md` §3 检出新版 tag，按
`docs/runbooks/operations.md` §4.1 跑容器化迁移（主机没有 Node，不能用 `make migrate`）、重建
镜像；这一步不属于本 runbook 范围，只是例行回归的前置条件。

**(2) 用 `--real --runs 10 --keep` 各跑一遍 S2 / S3**，`--keep` 是关键——不加它 `cleanup_step`
会把这次跑出来的 workspace 之外的 fixture 拆掉（workspace 行本身两个脚本无论加不加 `--keep` 都
保留，见 §6/`host-accept-s2.md`/`host-accept-s3.md` 各自的 cleanup 说明），但不传 `--keep` 时
S2 还会把 alice/bob 入口容器一并停掉、S3 会停 owner 的常驻入口容器——例行回归要紧接着用
`report-usage.sh` 查同一批 Turn 的用量，加 `--keep` 更省心，也不影响判定结果：

```
sh scripts/accept_s2.sh --real <provider/model> --runs 10 --keep 2>&1 | tee /tmp/accept-s2-real.log
sh scripts/accept_s3.sh --real <provider/model> --runs 10 --keep 2>&1 | tee /tmp/accept-s3-real.log
```

从各自的日志里取出这次跑出来的 workspace id——两个脚本都在 `bootstrap-workspace` 这一步打印
`workspace=<uuid>`（`accept_s2.sh`/`accept_s3.sh` 源码同一行）：

```
WS_S2=$(grep -m1 '^PASS bootstrap-workspace' /tmp/accept-s2-real.log | sed -n 's/.*workspace=\([0-9a-fA-F-]*\).*/\1/p')
WS_S3=$(grep -m1 '^PASS bootstrap-workspace' /tmp/accept-s3-real.log | sed -n 's/.*workspace=\([0-9a-fA-F-]*\).*/\1/p')
echo "S2 workspace: $WS_S2"
echo "S3 workspace: $WS_S3"
```

**(3) 对每个 workspace 跑 `report-usage.sh`**，`--markdown --summary` 给整份 workspace 的
token / 成本总量（进 §9 模板的"report-usage 输出"小节）；再用 `--by turn --markdown` 拿到按
Turn 排序的明细，用来倒推每个场景的 avg tokens/turn、avg cost/turn（见下方"怎么把两份输出拼进
一条记录"）：

```
sh scripts/report-usage.sh --workspace "$WS_S2" --markdown --summary
sh scripts/report-usage.sh --workspace "$WS_S2" --by turn --markdown
sh scripts/report-usage.sh --workspace "$WS_S3" --markdown --summary
sh scripts/report-usage.sh --workspace "$WS_S3" --by turn --markdown
```

**怎么把两份输出拼进一条记录**——`report-usage.sh` 完全不知道"哪一行属于哪个场景"（`llm_usage`
表里没有场景这个概念，见 `scripts/report-usage.sh` 自己的头注释）；场景边界只存在于 accept 脚本
自己的执行顺序里。两个真实场景批次都是**逐场景顺序跑完 `--runs` 次再进下一个场景**（S2：
`docker_restart` → `api_observe` → `ssh_run_approve` → `ssh_run_auto`，各 10 次；S3：
`dependency_chat` 单独 10 次），所以 `--by turn --markdown` 按 `first_started_at` 排序的输出，
天然分成与场景顺序一一对应的连续区块：S2 的前 10 行 Turn 属于 `docker_restart`、接下来 10 行属于
`api_observe`，以此类推；S3 的 10 行全属于 `dependency_chat`。按场景取出对应区块，对
`total_tokens`/`cost_usd` 两列取平均，填进 §9 模板每个场景那一行的 avg tokens/turn、avg
cost/turn。**核对边界**：每个区块的行数应等于该场景自己 `REAL scenario=<key> ok=<k>/<n> ...`
行里的 `<n>`；如果某个区块行数少于 `<n>`，说明该场景至少有一次 run 没有产生带 `turn_id` 的
`llm_usage` 行（典型原因：那次 Turn 在拿到任何工具调用之前就 `interrupted`，`retrospective-
2026-09-11.md` §2 记录过这个模式）——这本身就是一条诊断线索，照实记进 §9 模板的备注列，不要
硬凑平均。avg turn tool calls 这一列不经过 `report-usage.sh`：直接取该场景 `REAL` 行里的
`turn_tool_calls=<sum>` 除以 `<n>`。

**(4) 把 (2)/(3) 的原始输出填进 `docs/private/real-model-<date>.md`**（模板见 §9；文件已在
`.gitignore` 里，不进任何入库文件）。

**(5) 把计数摘要粘进 `STATUS.md` §2.2 的表**——只有次数，不带供应商/模型名、不带 token/成本
数字，格式照抄 §6 那一行的例子（`docker_restart 8/10、api_observe 10/10、...`），任一场景
`k<8` 额外注明"（已知问题，见 §4/遗留清单）"。**这一步不在本 runbook 的可改动文件范围内**——
`docs/STATUS.md` 由发起本轮回归的会话自己去改，本 runbook 只规定粘贴的格式与来源。

**(6) 清理 `--keep` 留下的 fixture / workspace**——两个脚本各自的 cleanup 手续见
`docs/runbooks/host-accept-s2.md` §"清理"与 `docs/runbooks/host-accept-s3.md` 对应小节（停掉
`--keep` 保留的 alice/bob 或 owner 入口容器、`docker compose --profile accept-s2 down` 等）。
workspace 行本身按设计文档 §12 的审计留痕原则不必立即删——两个脚本从 S5.3 起都以
`--purpose ephemeral --ttl 7d` 建 workspace，到期后批量清：

```
sh scripts/delete-workspaces-matching.sh --expired --yes
```

**(7) `make demo`（`scripts/demo.sh`，S5.8 交付物，由另一条车道添加）算第六个场景**——它同样是
一次真实模型跑一轮固定问题的验收，产出可以按同样的方式计入 `docs/private/real-model-<date>.md`
与 STATUS 摘要行的第六项；`demo.sh` 自己的内部实现、判定标准不属于本 runbook 范围，见
`docs/development-tasks.md`§S5.8 与 `scripts/demo.sh` 自己的头注释。

## 9. `docs/private/real-model-<date>.md` 记录模板

````markdown
# 真实模型回归记录 — <date>

- 版本：<version tag>（例如 v0.13.0）
- Provider/Model：<provider/model>
- 主机：<TARGET_HOST>（仅本文件，不进入库文件）
- 跑法：`accept_s2.sh --real <provider/model> --runs 10 --keep`、
  `accept_s3.sh --real <provider/model> --runs 10 --keep`、`make demo`
- workspace：S2=<uuid> S3=<uuid>

## 场景数字

| 场景 | ok/n | avg turn tool calls | avg tokens/turn | avg cost/turn | 备注 |
|---|---|---|---|---|---|
| docker_restart | k/10 | | | | |
| api_observe | k/10 | | | | |
| ssh_run_approve | k/10 | | | | |
| ssh_run_auto | k/10 | | | | |
| dependency_chat | k/10 | | | | |
| make demo（第六场景） | k/1 | | | | |

## 原始 RUN / REAL 行

```
（粘贴 accept_s2.sh / accept_s3.sh 完整的 RUN scenario=... / REAL scenario=... 输出）
```

## report-usage.sh 输出

```
（粘贴 --workspace <S2> --markdown --summary、--by turn --markdown 与
  --workspace <S3> --markdown --summary、--by turn --markdown 四段输出）
```

## 已知问题（本版本）

- <场景> ok=k/10（k<8）：<simple 描述，不下结论，留给 §4/遗留清单跟进>

## 进 STATUS §2.2 的摘要行（只有次数）

docker_restart k/10、api_observe k/10、ssh_run_approve k/10、ssh_run_auto k/10、
dependency_chat k/10、make demo k/1（`docs/private/real-model-<date>.md`）
````
