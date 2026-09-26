# Runbook：host-accept-s4（S4 验收脚本 — 每个已接入系统，走真实内核路径）

对应背景：一次生产事故——某成员的入口 agent 调不到一个已接入系统（RagFlow），根因是平台连接器的
Operation 禁用名单把该连接器下的全部 Operation 都禁了，而控制台的"执行就绪"视图（`execution_readiness`）
却显示这个门没问题——`execution_readiness`/`find_operations` 的可达性计算
（`application/gateway/capability-reachability.ts`，2026-09-25 控制台重构 P0，PR #307）复现的是
Grant / AgentProfile / 工作区策略这一半的判定，从不读连接器的禁用名单；真正拒绝调用的是
`observe_operation`/`request_action` 自己另一处独立的检查
（`application/gateway/request-action-handler.ts` 的 `assertOperationEnabled`，403 `operation_disabled`）。
S1–S3 从未对"每一个已接入系统，走一遍真实内核路径"做过端到端验证——`scripts/accept_s4.sh` 补这一层：
对工作区能启用的每一个平台门实例，启用 + 授权，读一遍内核自己的就绪读模型与入口 agent 自己的
per-Operation 可达性标注，再通过与入口 agent 相同的 Handle 通道真做一次只读调用，比对"内核说能不能用"
和"内核实际让不让用"是否一致，不一致时指出是哪一层在拦。

脚本命名沿用 `accept_s1.sh`/`accept_s2.sh`/`accept_s3.sh` 的编号顺序（第四个验收脚本），**与
`docs/development-tasks.md` §5a"S4 — 平台管理"是同名不同指**——那是用户目录 / 登录里程碑，与本脚本验证的
连接器 / 门实例（P-B1、控制台重构 P0/P2）毫不相干；本脚本不验证也不依赖 §5a 的任何验收句。

## 1. 前提

- `docker compose up -d`（或至少 `postgres kernel`）已起——本脚本从不发一次聊天 Turn、不需要任何
  LLM，因此不像 `accept_s1.sh`/`accept_s2.sh`/`accept_s3.sh` 那样需要 `llm-proxy`/`worker-supervisor`/
  `agent-host`/`fake-llm`，也不touch `deploy/accept/docker-compose.fake.yml`。
- 迁移已跑到最新（脚本自己的 `preflight-migrations` 步骤会再核实一遍）。
- 至少一个平台门实例处于"平台管理员已启用"状态（`集成` 页，`#/platform/integrations`，
  `set_connector_mode` 已切到 `platform_preset` 且门自己已 announce 过 Operation）——本仓库自带
  `gatekeeper-docker`/`gatekeeper-ragflow` 两个门服务，`docker compose up -d` 默认拉起。若平台还没有
  任何已启用的门实例，脚本会打印一行清楚的 PASS 说明并以 0 退出（见 §3）。
- 主机上有 `docker`、`docker compose`；**没有** `node`/`corepack`——脚本把每一次 kernel 交互都放进一次性
  kernel 镜像容器里跑（见脚本头注释）。

## 2. 怎么跑

```
cd <CODE_DIR>
sh scripts/accept_s4.sh
```

经 SSH 跑（`</dev/null`，同 accept_s1.sh 的既有约定）：

```
ssh <TARGET_HOST> 'cd <CODE_DIR> && sh scripts/accept_s4.sh' </dev/null
```

`--connector <name>`：只测一个连接器（技术名，如 `docker`/`ragflow`，不是显示名）：

```
sh scripts/accept_s4.sh --connector ragflow
```

`--keep`：为与 `accept_s1.sh`/`accept_s2.sh`/`accept_s3.sh` 的命令行保持一致而接受，但本脚本从不启动
常驻入口容器（从不发聊天 Turn），实际上没有东西可留可停——工作区本身无论 `--keep` 与否都会保留
（见 §5"清理"）。

## 3. 怎么读输出

逐步打印标准的 `PASS <step> <detail>`/`FAIL <step> <detail>`（stderr）——这些是"能不能把这个门接进
工作区"的**装配**步骤（`enable-gate-instance:<gateId>`/`grant-gatekeeper:<gatekeeperId>` 等），装配失败
只影响这一个门，不会中止整个脚本，也不会拖累其它门的验证。

每个门真正的验证结论是单独一行，格式固定，便于 grep：

```
S4 gate=<门显示名> connector=<连接器技术名> readiness=<direct|via_worker|unreachable>/<原因或-> op=<挑中的 Operation 或 -> call=<HTTP 状态 [+ 错误码/消息前缀] 或 -> verdict=PASS|FAIL|SKIP
```

- **`verdict=PASS`**：要么"就绪读模型说能用，调用也真的成功"（`readiness=direct` 或 `via_worker`，
  `call=200`），要么"就绪读模型说不能用，调用也真的被平台禁用名单拒绝"（`readiness=unreachable`，
  `call=403 forbidden operation_disabled`）——后一种情况脚本还会另打一行
  `S4 NOTE gate=<门> connector=<连接器> all operations disabled by platform connector deny list`，
  这是运维需要人工确认的信号（"两边一致，但一致在'都不能用'上"），不是这个门本身坏了。
- **`verdict=FAIL`**：`readiness` 与实际调用结果不一致（本 runbook 开头那次生产事故的确切复现），或
  调用因为门 / 连接器不可达而失败（5xx/超时）。stderr 上紧跟一行 `FAIL verify:<gateId> <原因>`
  说明具体是哪一层：
  - `readiness/enforcement disagree: ... but observe_operation(...) succeeded`——就绪读模型把一个
    **其实能用**的门标成了 `unreachable`（读模型侧的 bug，`capability-reachability.ts`）。
  - `readiness/enforcement disagree: ... but observe_operation(...) was refused operation_disabled`——
    就绪读模型把一个**被平台禁用名单挡住**的门标成了 `direct`/`via_worker`（本 runbook 开头那次事故
    的确切信号）：去 **`集成`**（`#/platform/integrations`，平台管理员）确认该连接器的 Operation
    禁用名单，把这个门/连接器需要的 Operation 从禁用名单里放出来，或者告诉受影响的成员改用别的门。
  - `gate unreachable: HTTP 502/503/504 ...`——门进程本身连不上（容器没起来、网络分区、门自己挂了）：
    先 `docker compose ps gatekeeper-<connector>`/看门自己的日志，不是权限问题。
  - `could not enable this platform gate instance` / `could not grant the workspace owner a
    gatekeeper Grant`——装配阶段就失败了，见上面 stderr 的 `enable-gate-instance:<gateId>`/
    `grant-gatekeeper:<gatekeeperId>` 那行的详细 HTTP 状态与响应体。
- **`verdict=SKIP`**：这个门没有一个"observe 类、params_schema 无必填字段"的 Operation 可供本脚本
  安全调用（`op=-`）——不是这个门坏了，是这个门的清单里每个 observe Operation 都要求参数，本脚本不猜
  参数值；stderr 上的 `SKIP verify:<gateId> <原因>` 会报 `find_operations` 一共为这个门返回了几个
  Operation。人工验证：去 **`系统与授权`**（`#/govern/systems`，工作区成员/owner）挑一个带默认值的
  Operation 手动调一次；或去 **`我的智能体`**（`#/me/agent`，受影响成员）确认这个门本就不在
  该成员 agent 的授权清单里（如果是这样，这个门从一开始就不是这次事故的候选）。

最终一行：

```
S4 OK (<n> gates pass, <m> skipped)      # 无 FAIL，退出 0
S4 FAIL (<n> pass, <m> skip, <f> fail)   # 有 FAIL，退出 1
```

工作区没有任何平台门实例可测时（罕见——平台管理员还没在 `集成` 页启用任何连接器实例），脚本打印
`PASS list-gate-instances no platform gate instances available to this workspace` 后直接
`S4 OK (0 gates pass, 0 skipped)` 退出 0——这本身不是失败，但值得运维确认是否符合预期（平台是不是
真的还没接任何系统）。

## 4. 每个门内部走的路径（对应哪个 capability）

| 阶段 | capability | 通道 | 说明 |
|---|---|---|---|
| 列出候选 | `list_available_gate_instances` | human（owner） | 平台已启用且 `platform_preset` 的门实例，含本工作区是否已链接 |
| 启用 | `enable_gate_instance` | human（owner） | 注册/复用 Gatekeeper，导入并**自动发布**其宣告的 Operation |
| 保险检查 | `list_operations` + `publish_operation` | human（owner） | 极少数情况下补发布——正常情况下 `enable_gate_instance` 已经发布完了，不会有活干 |
| 授权 | `grant_capability` | human（owner） | 给 owner 自己发一个 `gatekeeper` Grant——不做这一步，就绪读模型会对每个门都报 `not_granted`，把真正的事故信号淹没在自造的假阳性里（脚本自己的头注释有完整推理） |
| 铸造 Handle | `issue_handle` | human（owner） | 铸一个 `interactive` 会话的根 Handle——所有授权到位**之后**才铸，`find_operations` 的可达性标注只在"根 Handle（无 `par`）"这个形状下才会附带 |
| 读就绪 | `execution_readiness` | human（owner） | 一次调用覆盖工作区里注册过的每一个 Gatekeeper |
| 读可达性 + 挑 Operation | `find_operations` | **handle**（刚铸的 Handle） | 入口 agent 自己会看到的同一份可达性标注；本脚本额外用它挑一个参数 schema 无必填字段的 observe Operation |
| 真调用 | `observe_operation` | **handle**（刚铸的 Handle） | 与入口 agent 的 `<gate>.<op>` 工具投影调用的是同一个 capability，同一条门禁（连接器禁用名单在这一步生效） |

`find_operations`/`observe_operation` 特意不用 owner 的人类身份直接调（虽然内核允许——
`application/gateway/authorize.ts` 的 channel 准入规则："channel:'handle' 的能力两个通道都能调"）：
只有 Handle 通道、且是一个没有 `par` 声明的根 Handle，`find_operations` 才会附带可达性标注
（`findOperationsHandler` 的判断），这也正是入口 agent 自己的 Handle 形状——保证本脚本测的是"入口
agent 会走的那条路"，而不是 owner 的旁路。

## 5. 清理

工作区/Principal/Gatekeeper/Grant/审计行按设计文档 §12 的审计留痕原则保留，不清理——批量清理：

```
sh scripts/delete-workspaces-matching.sh '^accept-s4' --yes
```

验收工作区以 `--purpose ephemeral --ttl 7d` 创建，到期后
`sh scripts/delete-workspaces-matching.sh --expired --yes` 按策略清掉，不必再靠名字正则。

## 6. 已知限制

- **入口 agent 在 `session_start` 时的真实工具投影不受本脚本验证**：`find_operations`/
  `observe_operation` 走的是同一条 capability 与同一条门禁，但入口 agent 自己在会话开始时把
  `<gate>.<op>` 投影成具体工具名的那一步（`packages/platform-extension` 的 `modes/entry.ts`）不在
  本脚本覆盖范围——如果未来那一层自己引入了额外的过滤逻辑（例如按 AgentProfile 清单二次过滤工具
  列表），本脚本不会发现。目前没有找到一个人类可调的 capability 能直接读出"入口 agent 这次会话实际
  拿到的工具列表"；`get_entry_context`（入口 ceiling 里的能力）读的是入口自己的上下文快照，不是这次
  session_start 的工具投影结果，两者是否等价未经验证。
- **一个门可能没有任何"无必填参数"的 observe Operation**：这种门会被记 SKIP，而不是 PASS/FAIL——
  SKIP 不代表这个门没问题，只代表本脚本选不出一个能安全裸调的 Operation；§3 的 SKIP 一节给了人工
  验证路径。
- **`params_schema` 的必填字段只按 JSON Schema 的顶层 `required` 数组判断**：一个通过 `anyOf`/`oneOf`/
  嵌套 `if`/`then` 表达"某些字段组合下才必填"的复杂 schema，本脚本只看得到顶层 `required`，可能选中一个
  实际仍需要参数的 Operation——真调用失败会体现为 `verify:<gateId>` 的 stderr 诊断里出现门自己返回的
  参数校验错误，而不是 `operation_disabled`，读的时候按 §3 的"call 失败，非 403/5xx"分支处理即可。
