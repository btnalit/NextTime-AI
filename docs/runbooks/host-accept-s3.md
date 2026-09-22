# Runbook：host-accept-s3（S3 验收脚本）

对应任务：`docs/development-tasks.md` § S3.9。前置：`docs/runbooks/accept-s1.md`（S1 全套已跑通，
`scripts/accept_s3.sh` 复用其 preflight/bootstrap/driver 约定）、`docs/runbooks/host-collector.md`
（本脚本自动化的正是该文档 §1/§2 的两个手动步骤：发布 `ops-assets-v1` 域包、铸造采集器的 service
Handle）、`docs/runbooks/host-explorer.md`（Explorer 九个端点里本脚本抽了三个直接验证）、
`docs/howto-connect-claude-code.md`（MCP 接入的用户侧文档，本脚本验证的是同一条协议路径）。

## 1. 前提

- `docker compose up -d`（或至少 `postgres kernel llm-proxy egress-proxy worker-supervisor
  agent-host docker-socket-proxy-collector`）已起。
- 不需要手动切换 provider：脚本自己会通过 `deploy/accept/docker-compose.fake.yml` 把 llm-proxy /
  worker-supervisor / fake-llm 切到 fake provider，并在退出时用 EXIT trap 恢复生产配置——
  `${NEXTTIME_DATA}/config/llm-providers.yaml` 与 `${NEXTTIME_DATA}/models/models.json`
  全程不会被改动，跑前跑后都不用重跑
  `make gen-models`；唯一要求是 llm-proxy、worker-supervisor、fake-llm 镜像已经构建好。
- `fake-llm` 镜像是用当前代码构建的（本任务在 `deploy/fake-llm/server.mjs` 新增了
  `entryDependencyChatScenario`——见 §4）：`docker compose --profile test build fake-llm && docker
  compose --profile test up -d --force-recreate fake-llm`，否则"哪个服务依赖哪个"这句话不会命中新
  场景，入口 agent 只会回 echo。
- 迁移已跑到最新（脚本自己的 `preflight-migrations` 步骤会再核实一遍）。
- `${NEXTTIME_DATA}/secrets/gate_token` 等 `docs/runbooks/host-bootstrap.md` 的首次引导已完成
  （本脚本不生成这些）。
- 主机上有 `docker`、`docker compose`；**没有** `node`/`corepack`——脚本把每一次 kernel/Explorer/MCP
  交互都放进一次性 kernel 镜像容器里跑（见脚本头注释）。

**生产采集器的 token 不再被触碰（S6，遗留 41）。** 本脚本把本次验收用的采集器 Handle 铸到
`${NEXTTIME_DATA}/accept/collector-s3-<时间戳>-<pid>.token`（目录 0750、文件 0644，与 `scripts/demo.sh`
同一做法），只对那一次 `collector-host-inventory --once` 用 `docker compose run -e
NEXTTIME_HANDLE_TOKEN_FILE=… -v <文件>:…:ro` 指过去，退出时（成功、失败、ssh 断开都经 EXIT / HUP trap）
删除。`${NEXTTIME_DATA}/secrets/collector-host-inventory.token` 与常驻的 `collector-host-inventory`
服务全程用自己的 token 继续跑——S6 之前本脚本覆盖那个文件，真实采集器随即对着已禁用的验收工作区 401
了一周没人发现，就是遗留 41。（S5.3 之前采集器还在磁盘缓存 Source id、本脚本要先删它；`register_source`
现在按 (kind, name) 幂等，采集器不再有任何本地状态。）

## 2. 怎么跑

```
cd <CODE_DIR>
sh scripts/accept_s3.sh
```

经 SSH 跑（`</dev/null`，同 accept_s1.sh 的既有约定）：

```
ssh <TARGET_HOST> 'cd <CODE_DIR> && sh scripts/accept_s3.sh' </dev/null
```

`--keep`：跳过停止 owner 的常驻入口容器（排障用；workspace 行无论如何都保留）：

```
sh scripts/accept_s3.sh --keep
```

`--real <provider/model> [--runs N]`（W7）：保留主机上已部署的真实 provider，把
`chat_dependency_step` 换成用真实模型跑、按结果判定的 `real_chat_dependency_step`，重复
`--runs` 次（默认 3）——不切换到 fake provider，也不需要跑完后切回来。用法、判定标准、怎么读
`RUN`/`REAL` 输出，见专门的 `docs/runbooks/host-accept-real-model.md`。

## 3. 期望输出

逐步打印 `PASS <step> <detail>`；任何一步真失败打印 `FAIL <step> <detail>` 到 stderr 并立即以非 0
退出。全部通过后打印 `S3 OK` 并退出 0（development-tasks.md § S3.9 的验收句原文）。示例（真实
id/key 已脱敏）：

```
PASS preflight-services running: postgres kernel llm-proxy egress-proxy worker-supervisor agent-host fake-llm docker-socket-proxy-collector
PASS preflight-fake-provider fake provider configured in .../config/llm-providers.yaml
PASS preflight-migrations up to date
PASS preflight-collector-build collector-host-inventory image built
PASS bootstrap-workspace workspace=<uuid> owner=<uuid> key=abc123...(redacted)
PASS seed-domain-pack domain pack published: ops-assets (id=<uuid>, version=1)
PASS collector-issue-service-handle token minted into a run-private file (never ${NEXTTIME_DATA}/secrets/collector-host-inventory.token): 9f3a1c...(redacted)
PASS collector-first-run objectsUpserted=<N> factsAsserted=<N>
PASS collector-container-search containerId=<uuid>
PASS collector-runs-on-host Container <uuid> runs_on Host — 1 edge(s)
PASS collector-second-run-idempotent factsAsserted=0 factsSuperseded=0 (every observation resolved unchanged)
PASS collector-no-open-conflicts 0 open Conflicts
PASS collector-conflict-positive-source second Source=<uuid>
PASS collector-conflict-positive-identity container={"composeProjectId":"<uuid>","serviceName":"<name>"} host={"hostname":"<hostname>"}
PASS collector-conflict-positive-submit second Source's contradicting runs_on assertion: factsAsserted=1
PASS collector-conflict-positive-open-count 1 open Conflict: {"count":1,"factAId":"<uuid>","factBId":"<uuid>"}
PASS chat-dependency-reply entry agent replied: kernel 依赖（depends_on）服务 postgres。
PASS chat-dependency-search-kernel kernel containerId=<uuid>
PASS chat-dependency-traverse depends_on Fact=<uuid> (kernel -> postgres)
PASS chat-dependency-explain explain(depends_on Fact) resolves to the collector's own Source (kind=host-inventory-collector)
PASS explorer-graph-nodes 200 (graph returned)
PASS explorer-decisions 200
PASS explorer-provenance 200 (provenance graph for the depends_on Fact returned)
PASS explorer-no-credentials no X-API-Key and no session cookie -> 401
PASS mcp-issue-handle interactive Handle minted: eyJhbGc...(redacted)
PASS mcp-tools-list tools=explain,get_object,get_task,search,state_at,traverse,...
PASS mcp-traverse MCP traverse sees the same graph: {"isError":false,"edges":1}
PASS mcp-no-handle no Handle -> 401
cleanup: deleted the run-private collector token (${NEXTTIME_DATA}/accept/collector-s3-<ts>-<pid>.token) — the production collector's own secret was never touched
PASS cleanup workspace retained: <uuid> (purged by: sh scripts/delete-workspaces-matching.sh --expired --yes once its 7-day TTL passes)
S3 OK
```

## 4. 每一步对应 S3.9 派单文字的哪一部分

| 脚本步骤 | 对应派单文字 |
|---|---|
| `seed_domain_pack_step` | "(a) seed `ops-assets` v1 (`bootstrap.js seed-domain-pack`) into a fresh workspace" |
| `collector_fixtures_step`/`collector_first_run_step`/`collector_second_run_step` | "(b) run the collector once ... assert `Container runs_on Host` Facts exist and a second run yields ... no open conflicts" |
| `collector_conflict_positive_step` | 补 §2.2 已知盲区的正向用例：异源、内容矛盾的断言针对同一 `(linkType, sourceObjectId, targetObjectId)` 身份必须恰好开一个 `open` Conflict（不在 S3.9 派单原文里，W5.5 遗留项 16/17 完成标准新增） |
| `chat_dependency_step`（`--real` 模式下换成 `real_chat_dependency_step`：同一句"哪个服务依赖哪个"改由真实模型作答，重复 N 次，按结果判定；每次打印一行 `RUN scenario=dependency_chat run=… outcome=ok\|fail …`，跑完打印一行 `REAL scenario=dependency_chat ok=k/n …` 汇总，见 `docs/runbooks/host-accept-real-model.md`） | "(c) chat: the entry agent ... answers with a dependency statement and `explain` on one returned Fact resolves to the collector's Source" |
| `explorer_step` | "(d) Explorer endpoints ... return the graph with `X-API-Key` of the workspace owner ... not via caddy" + a no-credentials call must 401 (W7) |
| `mcp_step` | "(e) MCP: `issue_handle` for an `interactive` session, then a JSON-RPC `tools/list` + `traverse` call ... no-Handle → 401" |

`entryDependencyChatScenario`（`deploy/fake-llm/server.mjs`）是本任务新增的脚本化场景——见该文件自
己的模块级文档注释，`deploy/accept-s2/fake-llm-scenario-selftest.mjs` 有 6 条纯 Node（无需 Docker）
的自检用例覆盖它的四轮对话逻辑（`node deploy/accept-s2/fake-llm-scenario-selftest.mjs`）。

**"factsUnchanged>0" 的验收句怎么落地的**：`submit_observations` 的真实线上结果确实带一个
`factsUnchanged` 字段（`application/gateway/ingest-handlers.ts`），但采集器自己的
`consoleLogger`（`collectors/host-inventory/src/run.ts`，S3.4 并行任务当前拥有的目录，本任务未碰）
只记录/打印 `objectsUpserted`/`factsAsserted`/`factsSuperseded`，没有转发 `factsUnchanged`。
`collector_second_run_step` 因此断言等价的、真正可观察的信号：第二次运行
`factsAsserted===0 && factsSuperseded===0`——这种结果只有在这次运行的每一次 `assertFact` 调用都走
了 `unchanged:true` 的 no-op 分支（`substrate/graph/sql-store.ts`）时才可能出现，等价于"每条事实的
`factsUnchanged` 都 > 0、`factsSuperseded` = 0"，只是没有印在这个字段名下。

## 5. 已知偏离 / 已知限制

- **`explain` 定位的 Fact 不是从聊天记录里解析出来的**：`chat_dependency_step` 里 `explain` 的目标
  Fact 是脚本自己另外走一次直接的 `traverse` 找到的（同 `collector_first_run_step` 用的同一条
  `search`→`traverse` 路径，只是过滤到 `kernel` 这个 Container），不是从
  `entryDependencyChatScenario` 那一轮聊天的工具调用结果里解析出来的——聊天消息 `content` 里工具调
  用/工具结果的具体结构是内部实现细节，本脚本不想依赖它。两者验证的是同一件事："这个门/采集器写的
  `depends_on` Fact，`explain` 能溯源到采集器自己的 Source"，只是取 Fact id 的路径不同。
- **依赖关系固定用 `kernel depends_on postgres`**：本仓库自己的 `docker-compose.yml` 里
  `kernel: depends_on: {postgres: ...}` 是一条真实、在任何正在跑的技术栈上都成立的关系（Docker
  Compose 会把它写进 `com.docker.compose.depends_on` 标签，采集器据此读出），不是为验收编的 fixture
  ——但也意味着如果未来 `docker-compose.yml` 把 kernel 对 postgres 的 `depends_on` 移除或改名，
  `chat_dependency_step`/`mcp_step` 都要跟着调整目标关系。
- **`docker-socket-proxy-collector` 的 healthcheck 用 `wget`**：`docker-compose.yml` 自己的注释已经
  标注"本机没有 Docker，无法确认该镜像用户态真的有 wget"——这条留给目标主机验收，同
  `docs/runbooks/host-collector.md` 的既有说明。
- **`collector_conflict_positive_step` 故意留一个 open Conflict**：该步骤用第二个 Source 对
  `collector_first_run_step` 已写入的同一条 `runs_on` Fact 提交矛盾内容，验证会开且只开一个 Conflict
  ——这个 Conflict 不会被本脚本关闭（workspace 本身按设计文档 §12 审计留痕原则保留，不复用于下一次
  验收）。`chat_dependency_step` 之后的 `explain` 目标是 `depends_on` Fact（kernel -> postgres），
  与这条 `runs_on` Fact 无关，不受影响。
- **共享 fixture**：不要与一次正在跑的 `scripts/accept_s2.sh` 并发执行——两者都会各自重建自己用到
  的 compose 服务；两者用到的 compose 服务集合本身不重叠（`accept_s3.sh` 不碰 `accept-s2-*`
  fixture），但都会打断/重启对方尚未跑完时依赖的入口容器状态，实际观察到的唯一冲突面是"同一台主机
  上的 worker-supervisor/agent-host 常驻进程"，建议顺序跑而非并发跑。

## 6. 清理

`--keep` 不传时，`cleanup_step` 经 `worker-supervisor` 的 `/resident/stop` 停 owner 的入口容器。
workspace/principal/chat/activity/graph 行按设计文档 §12 的审计留痕原则保留，不清理——批量清理：

```
sh scripts/delete-workspaces-matching.sh '^accept-s3' --yes
```

验收工作区自 S5.3 起以 `--purpose ephemeral --ttl 7d` 创建，到期后 `sh scripts/delete-workspaces-matching.sh
--expired --yes` 按策略清掉（S6 起走受治理的 `purge-workspace`：级联删除、从未激活的 owner / alice / bob
用户一并删除、平台审计行 `platform.workspace_purged` 保留——见 `docs/runbooks/operations.md` "工作区清除"），
不必再靠名字正则；名字正则仍可用，但未到期的验收工作区会被内核拒绝（按名字批量删只对已到期 / 已禁用满 7 天
的生效，`--force` 是操作员越权路径）。S6 起本脚本不再动 `${NEXTTIME_DATA}/secrets/collector-host-inventory.token`，
验收之后不需要重铸生产采集器的 Handle（见 §1）。
