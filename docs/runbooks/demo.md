# Runbook：demo（`make demo` / `scripts/demo.sh`，交付与演示闭环）

对应任务：`docs/development-tasks.md` §S5.8 "交付与演示闭环" 交付物 3。设计依据：
`docs/graph-ai-middle-platform-design.md`（Source/Observation/Fact/Activity 溯源模型、审批闭环）。

已有的相邻文档：`docs/runbooks/host-collector.md`（本脚本的采集器发布/铸造 Handle 步骤逐字复用）、
`docs/runbooks/host-accept-s2.md` / `host-accept-s3.md`（本脚本的 workspace/domain-pack/
gatekeeper-docker 接入/ops-runner 机制均照抄自这两个验收脚本，本文档只讲差异）、
`docs/runbooks/host-accept-real-model.md`（真实模型判定标准与占位符约定，本演示同样适用）、
`docs/runbooks/add-domain-pack.md`。

## 1. 目的

`make demo`（`scripts/demo.sh`）不是第四份验收脚本——它是"从零到能演示"的最短路径：起一个
一次性（ephemeral）workspace → 让 host-inventory 采集器观察当前主机一次 → 通过**真实**入口
agent 问三句预置问题（谁依赖谁；一条边从哪来、最近何时确认；重启一个测试容器并走审批）→ 产出
一页 Markdown 结果（对象数、事实数、依赖链回答、审批卡片与执行状态、`explain` 的溯源链，附
每一步耗时与总耗时）。它同时是 S5.7 真实模型回归的一个场景，一份脚本两用——运行时消耗真实
供应商的 token、产生真实费用。

要求 15 分钟（900 秒）内完成；脚本自己在结果页与标准输出上报告 `BUDGET ok|exceeded`，超时不是
脚本失败，只是这次运行不满足验收目标。

## 2. 前置条件

- 主机上完整技术栈已起：`docker compose up -d`（postgres / kernel / llm-proxy / egress-proxy /
  worker-supervisor / agent-host / docker-socket-proxy-collector / gatekeeper-docker 均为默认
  profile 服务，无需 `--profile test`）。
- 主机上部署的是**真实**供应商（不是 fake-llm），且其 `models.json` 已生成（`make gen-models`
  或部署流程自带的等价步骤）——`--model`/`DEMO_MODEL` 必须是这个 `models.json` 里真实存在的一个
  id，脚本从不替调用者选默认模型。
- `gatekeeper-docker` 已经向平台目录（`gate_instances`）announce 过自己，且 `connectors` 表里
  `docker` 连接器处于 `platform_preset` 模式——本脚本会在自己的一次性 workspace 里 enable 这个
  已有的目录条目，但不会创建这条目录记录本身；未满足时先按
  `docs/runbooks/host-gatekeepers.md` 把 gatekeeper-docker 接入平台目录。
- `${NEXTTIME_DATA}/secrets/gate_token` 与其余主机 bootstrap 密钥已存在
  （`docs/runbooks/host-bootstrap.md`）。
- `docker-compose.yml` 已包含 `accept-s2-restart-target`（profile `accept-s2`，Q3 用作可丢弃的
  重启目标——与 `scripts/accept_s2.sh` 共用同一个 fixture，行为上互不影响：两者各自起自己的一
  次性 workspace）。

**红线：真实的供应商名字、模型 id 与本次演示产生的费用，只写进 `docs/private/`，永远不进入
本仓库任何入库文件、commit message、PR 描述——本文档正文自始至终只用 `<provider/model>`
占位符。**

**不会动到生产采集器的密钥**：与 `scripts/accept_s3.sh` 不同（那个脚本会直接覆写
`${NEXTTIME_DATA}/secrets/collector-host-inventory.token`——主机上一个真实
`collector-host-inventory` 部署使用的同一个 Docker 文件型密钥路径），本脚本把这次演示铸造的
采集器 Handle 写进一个演示专用文件（`${NEXTTIME_DATA}/demo/collector-<UTC 时间戳>.token`，
`collector_handle_mint_step` 铸造，`cleanup_step` 结束时无条件删除——它是凭证，`--keep` 也不
保留），用 `NEXTTIME_HANDLE_TOKEN_FILE` 环境变量让 `collector-host-inventory --once` 这一次运行
读它（`collectors/host-inventory/src/config.ts` 每次运行都重新读这个环境变量，未设置时才回落到
生产路径）。`make demo` 是给交付主机上随手跑的命令，不是专用验证环境的脚本——如果它像
`accept_s3.sh` 那样悄悄把生产采集器重定向到一次性 workspace，直到人工重新铸造密钥为止，这在
交付场景下不可接受；因此本脚本自始至终不读、不写生产密钥路径。

## 3. 步骤

```bash
cd <CODE_DIR>
DEMO_MODEL=<provider/model> make demo
```

或直接跑脚本（等价，`make demo` 只是把 `DEMO_MODEL` 校验非空后转成这一句）：

```bash
sh scripts/demo.sh --model <provider/model>
```

经 SSH 跑（`</dev/null`，同其余 accept/demo 脚本的既有约定）：

```bash
ssh <TARGET_HOST> 'cd <CODE_DIR> && DEMO_MODEL=<provider/model> make demo' </dev/null
```

可选参数（直接调用 `scripts/demo.sh` 时）：

- `--keep`：跳过清理——保留 `accept-s2-restart-target` fixture 容器与 owner 的常驻入口容器；
  一次性 workspace 本身无论是否传 `--keep` 都会保留（见 §5）。
- `--out <path>`：覆盖结果页默认路径 `${NEXTTIME_DATA}/demo/demo-<UTC 时间戳>.md`；给的路径解析
  到检出目录以内会被拒绝——结果页必须落在 `${NEXTTIME_DATA}` 下，不进仓库。

脚本内部顺序（每一步打印 `STEP <name> ok (<耗时>s)`，第一处失败打印 `FAIL <name> <detail>` 并以
非 0 退出）：

1. **preflight**——技术栈 + `gatekeeper-docker` 在跑、`collector-host-inventory` 镜像已构建、
   `accept-s2-restart-target` fixture 已起（取得它的完整容器 id）。driver 可读性在这之前已由
   `require_driver`（`scripts/lib/accept-common.sh`）硬性检查过一次。
2. **workspace-create**——`bootstrap.js create-workspace --purpose ephemeral --ttl 1d
   --entry-model <provider/model>`。
3. **domain-pack-seed**——发布 `ops-assets` v1 域包（采集器写入前必须存在，否则
   `unknown_object_type`）。
4. **collector-handle-mint**——铸造采集器自己的 service Handle，写入演示专用文件
   `${NEXTTIME_DATA}/demo/collector-<UTC 时间戳>.token`（**不是**生产的
   `${NEXTTIME_DATA}/secrets/collector-host-inventory.token`，见 §2）。文件权限 644（目录
   0750）——这是一次 `-v` bind mount 而非 compose 的 `secrets:` 条目，容器内运行采集器的是
   uid 10001（`collectors/host-inventory/Dockerfile` 的 `USER nexttime`），bind mount 直接照搬
   宿主机文件自己的权限位，所以必须显式给 "other" 读权限——同
   `scripts/lib/accept-common.sh` 的 `require_world_readable` 对 driver 脚本的既有处理方式一样
   的原因；目录本身收紧到 0750 不影响容器读取（容器只看到被挂载文件自己的 inode，不遍历宿主机
   目录树）。
5. **collector-run**——`docker compose run ... -e NEXTTIME_HANDLE_TOKEN_FILE=/run/demo-collector-token
   -v <演示专用 token 文件>:/run/demo-collector-token:ro collector-host-inventory node dist/index.js
   --once`；本次运行的 `objectsUpserted`/`factsAsserted` 成为结果页的对象数/事实数（内核没有专门
   的计数能力，`search`/`list_*` 都是 keyset 分页信封，没有总数字段——采集器自己那行
   `run complete` 摘要是权威来源）。
6. **q1-dependency**——中文提问"哪个服务依赖哪个"，真实入口 agent 自主决定调哪些工具作答。
7. **q2-provenance**——中文提问"kernel 依赖 postgres 这条边，它的来源是什么？最近一次确认是
   什么时候？"，随后脚本独立（不解析聊天记录）重新走 `search`→`traverse` 找到同一条
   `depends_on` Fact，直接调 `explain` 取溯源链（来源 kind/uri、起源观测时间、
   `lastObservation.createdAt`——这正是"最近一次确认"在 wire 层的字段）。
8. **worker-setup**——Q3 的准备工作，不是第三句提问本身：在 catalog 里 enable 已部署的
   `gatekeeper-docker`（同 `scripts/accept_s2.sh` 的"管理员点一下"= SQL 的既有先例）、把它
   `connect_gatekeeper` 授权给 owner、发布一个只声明 `request_action` + 这一个 gate 的临时
   `demo-ops-runner` WorkerDefinition（`model` 同样锁定 `<provider/model>`）。
9. **q3-restart**——中文提问"重启测试容器 CONTAINER_ID=<fixture 容器 id>"，
   `send-and-wait ... auto-approve=<gatekeeperId>`（脚本自己在 Turn 进行期间监听
   `action.pending` 并当场批准，同 `scripts/accept_s2.sh` 的 `real_docker_restart_run` 机制）；
   Turn 结算后再轮询 `list_action_requests`/`get_action`/`approve` 兜底（覆盖 Worker
   `invoke_worker(wait:false)` 在 Turn 结算之后才真正发起门调用的情形），直到
   ActionRequest 到达 `executed` 且 fixture 容器的 `StartedAt` 真的变化。
10. **report-write**——把上面每一步的耗时、对象/事实数、三句问答与 explain 溯源链写成一页
    Markdown（`${NEXTTIME_DATA}/demo/demo-<UTC 时间戳>.md` 或 `--out` 指定的路径）。
11. **cleanup**——除非 `--keep`：停掉 owner 的常驻入口容器、删除 `accept-s2-restart-target`
    fixture 容器；一次性 workspace 本身保留（见 §5）。

## 4. 验证

- 标准输出应以：
  ```
  demo: result written to <path>
  TOTAL <N>s BUDGET ok|exceeded
  demo OK
  ```
  结束，退出码 0。
- 打开结果页（`${NEXTTIME_DATA}/demo/demo-*.md` 或 `--out` 给的路径），核对：标题下的模型行
  与本次传入的 `<provider/model>` 一致；步骤耗时表里 11 行都有非空耗时；对象数/事实数非零；
  Q1 回复读起来像一句依赖关系陈述；Q2 回复 + explain 溯源链都点名同一条 `depends_on` Fact 的
  来源与最近确认时间；Q3 的 ActionRequest 状态为 `executed`，`StartedAt` 前后两个时间戳不同。
- `TOTAL <N>s BUDGET`：`ok` 即 15 分钟验收目标达成；`exceeded` 不是脚本缺陷，是这次真实模型
  跑得比预期慢——参考 §6 的排障方向，或直接换一个更快的模型重跑。

## 5. 回滚 / 清理

- 没有需要回滚的写入——本脚本只创建，不修改任何已存在的生产数据（一次性 workspace 与其图谱
  内容都是全新的，不触碰其它 workspace）。
- 一次性 workspace **不会**被本脚本删除：图谱/聊天/审计行是这次演示的证据链，且它带
  `purpose=ephemeral --ttl 1d`，到期由内核自己的一次性 workspace 回收机制处理。需要立即清掉一批
  演示 workspace 时：
  ```bash
  sh scripts/delete-workspaces-matching.sh '^demo-' --yes
  ```
- 演示专用的采集器 token 文件（`${NEXTTIME_DATA}/demo/collector-*.token`）——**无论是否传
  `--keep`**——脚本自己都会在 `cleanup_step` 删除：它是凭证，不是可保留检查的 fixture。标准输出
  会打印一行确认：`cleanup: deleted the demo-private collector token (...) — the production
  collector's own secret was never touched`。不需要、也不应该手动撤销或重新铸造生产采集器的
  Handle——本脚本从未读写过那个路径。
- 不带 `--keep` 时，脚本自己还会：停掉 owner 的常驻入口容器（`worker-supervisor` 的
  `/resident/stop`）、`docker compose rm -sf accept-s2-restart-target`。
- 带了 `--keep`：上面两条手动收尾，或直接：
  ```bash
  docker compose --profile accept-s2 rm -sf accept-s2-restart-target
  ```

## 6. 常见问题

| 现象 | 根因 | 排查 |
|---|---|---|
| `FAIL preflight ...not running:...` | 技术栈没完整起，或 `gatekeeper-docker` 没起 | `docker compose up -d`，确认 §2 列出的每个服务都在跑 |
| `FAIL worker-setup ...gate instance gatekeeper-docker is '<status>'...` | `gatekeeper-docker` 在目录里被管理员标记为 disabled，或连接器不是 `platform_preset` | 按 `docs/runbooks/host-gatekeepers.md` 检查目录状态，这是管理员的决定，脚本不会覆盖 |
| `FAIL q1-dependency ...turn status=...` 或 Q2/Q3 同类失败 | 真实模型这一轮没有在超时窗口内把 Turn 带到 `completed`——模型慢、被限流，或没找到正确工具 | 加大预期、检查 `llm-proxy` 日志确认没有被限流；参考 `docs/runbooks/host-accept-real-model.md` §7 同类排障表（`TURN_STATUS` 为空一行） |
| `FAIL q3-restart ...no ActionRequest appeared...` | 入口 agent 这一轮没有真的派工（没调 `find_workers`/`invoke_worker`），或调了但没创建 Task | 用 `get-history` 读这条 chat 的完整历史看模型这一轮实际调了什么；参考 `host-accept-real-model.md` §7 的 `task=none` 一行 |
| `FAIL q3-restart ...StartedAt did not change...` | ActionRequest 执行了，但 fixture 容器 id 传错/过期 | 核对本次调用里实际传给门的 `CONTAINER_ID` 与 `docker inspect accept-s2-restart-target` 的真实 id 是否一致 |
| `TOTAL <N>s BUDGET exceeded` | 真实模型三句提问加起来比预期慢，不是脚本缺陷 | 参考结果页里每一步的耗时表定位慢在哪一步；必要时换一个更快的模型重跑 |
| `demo: --out must not resolve under the checkout root` | 传了一个落在仓库检出目录内的 `--out` 路径 | 换一个 `${NEXTTIME_DATA}` 下的路径，或不传 `--out` 用默认路径 |
| `FAIL collector-run ...` 且日志里能看到 401/token 读取失败 | 演示专用 token 文件权限不对（不是 644）或路径被外部删掉——容器内运行采集器的是 uid 10001，bind mount 需要 "other" 读权限 | 检查 `${NEXTTIME_DATA}/demo/collector-*.token` 是否存在、`ls -l` 确认权限含 `r` 给 other；不要手动 `chmod` 收紧它，让脚本重新跑一遍铸造新文件 |
