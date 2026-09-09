# Runbooks 索引

对应任务：development-tasks.md § S3.10（"`docs/runbooks/README.md`：index of all runbooks"）。
本页只做导航——每份 runbook 具体怎么做，见各自文件；不在这里重复内容。

## 怎么读

- 全新主机从零上线：按下表"① 主机初始化"顺序从上到下走一遍。
- 已上线主机的日常运维：直接查"② 日常运维"对应场景。
- 扩展平台能力（接新系统、加新领域概念）：查"③ 扩展平台"。
- 出问题了：先查"④ 排障"。
- 每份 runbook 都遵循同一结构：目的 → 前置条件 → 步骤（命令块）→ 验证 → 回滚 → 常见问题；命令都是
  从本仓库实际脚本/capability 核实过的，不是设计文档的转述。

## ① 主机初始化（按依赖顺序）

| Runbook | 一句话 |
|---|---|
| [`host-preflight.md`](./host-preflight.md) | 部署前只读体检：Docker/Compose 版本、`runsc`（gVisor）实测、端口/磁盘/内存/网段冲突 |
| [`host-checkout.md`](./host-checkout.md) | 代码检出、生成 `.env`、密钥/配置占位文件、起 Postgres |
| [`host-bootstrap.md`](./host-bootstrap.md) | `${NEXTTIME_DATA}` 数据目录树与 `secrets/pg_password`；另含"删除 Workspace"的操作员清理脚本 |
| [`host-caddy.md`](./host-caddy.md) | TLS（内网 CA 自签）与 web 静态产物上线，平台唯一公网面 |
| [`host-explorer.md`](./host-explorer.md) | Explorer 静态包构建与挂载（`/explorer`）、专用 API key 配置、Graph/Decision/Lineage 三工作区验证 |
| [`host-worker-runtime.md`](./host-worker-runtime.md) | `worker-runtime` 镜像 + `worker-supervisor` 常驻/一次性两种模式 |
| [`host-agent-host.md`](./host-agent-host.md) | `agent-host` 事件桥 + 内核 `AgentHostRuntime`；`fake-llm` 端到端对话链路 |
| [`host-gatekeepers.md`](./host-gatekeepers.md) | 预置的 `docker`/`ragflow` 两个门实例主机验收（CLI 与 capability 两条注册路径） |

密钥生成本身（`scripts/gen-handle-keys.sh`：Handle 签名密钥对、`internal.token`、`gate.token`）
穿插在 `host-checkout.md`/`host-gatekeepers.md` 的前置条件里说明；轮换（而非首次生成）见
`key-rotation.md`。

## ② 日常运维

| Runbook | 一句话 |
|---|---|
| [`operations.md`](./operations.md) | 服务依赖图、重启/恢复顺序、健康检查清单、日志与指标现状 |
| [`key-rotation.md`](./key-rotation.md) | 五种密钥/令牌各自的轮换机制：Handle 签名密钥（硬切换）、`internal_token`/`gate_token`（同步重启）、provider key、平台用户 API key（`rotate_api_key`） |
| [`backup-restore.md`](./backup-restore.md) | 每日备份内容、`backup` 容器的 root+单一 capability 权限模型、`scripts/restore.sh` 恢复演练 |
| [`pi-upgrade.md`](./pi-upgrade.md) | pi 版本升级契约：耦合面清单、单一版本源、升级步骤、漂移检测（`pi-drift.yml`）、回滚 |
| [`web-console.md`](./web-console.md) | web 控制台每个页面依赖哪些 capability、角色可见性、排障表 |

## ③ 扩展平台

| Runbook | 一句话 |
|---|---|
| [`add-gatekeeper.md`](./add-gatekeeper.md) | 新增一个接入包：通用门 vs 专属包、清单编写与 Operation 分类、`request_connection → create_connection → publish_manifest → connect_gatekeeper`、MCP 门的一个已核实陷阱 |
| [`add-domain-pack.md`](./add-domain-pack.md) | 新增一个领域包：`ontology/<domain>.yaml` 的当前 schema 与真实发布路径缺口（S3.1 未落地部分已标注）；Skill/Procedure/WorkerDefinition 今天已可用 |

## ④ 排障

| Runbook | 一句话 |
|---|---|
| [`troubleshoot-task.md`](./troubleshoot-task.md) | 从一次失败/卡住的 Task 出发的诊断流程，含 `failure_reason`/ActionRequest 状态的根因表 |
| [`accept-s1.md`](./accept-s1.md) | S1 验收脚本 `scripts/accept_s1.sh`：一轮对话、隔离、崩溃恢复、出网代理端到端验证 |
| [`host-accept-s2.md`](./host-accept-s2.md) | S2 验收脚本 `scripts/accept_s2.sh`：卡片审批全链路、SSH/HTTP/Docker/MCP 四类连接、Worker 结果契约 |
| [`host-chaos.md`](./host-chaos.md) | 不变量监控（I1–I16 定时校验、`/internal/metrics`）与混沌演练脚本：杀 Worker 容器验证 Task 重试、杀入口容器验证自愈重建 |

两份验收脚本 runbook 既是"怎么跑验收"的操作手册，也是理解"平台在这一层应该长什么样"的参照——
`troubleshoot-task.md` 的诊断流程大量引用它们记录过的真实命令与已知偏离。

## 其它相关文档（不在 `docs/runbooks/` 下）

- [`../testing.md`](../testing.md)：测试分层（design §7.10）与每层的运行命令、CI 位置、无 Docker
  时能跑什么。
- [`../development-tasks.md`](../development-tasks.md)：任务清单，每个 runbook 开头都标注对应的
  任务编号。
- [`../graph-ai-middle-platform-design.md`](../graph-ai-middle-platform-design.md)：设计文档，每个
  runbook 开头都标注对应的章节。
