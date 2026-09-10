# NextTime-AI

[![CI](https://github.com/btnalit/NextTime-AI/actions/workflows/ci.yml/badge.svg)](https://github.com/btnalit/NextTime-AI/actions/workflows/ci.yml)
[![CodeQL](https://github.com/btnalit/NextTime-AI/actions/workflows/codeql.yml/badge.svg)](https://github.com/btnalit/NextTime-AI/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/btnalit/NextTime-AI/badge)](https://scorecard.dev/viewer/?uri=github.com/btnalit/NextTime-AI)
[![Release](https://img.shields.io/github/v/release/btnalit/NextTime-AI)](https://github.com/btnalit/NextTime-AI/releases)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

基于 Graph 的 AI 中台。每个用户有自己的、隔离的 AI agent（[pi](https://pi.dev)）和一个对话框；
说出需求，agent 在图上找到能干活的 Worker（也是 pi），动态拉起它们，各自通过统一的门
（Gatekeeper）对接不同系统，把结果和决策带着来龙去脉写回图里，再决定下一步。所有 agent 共享
同一份带类型、双时态、逐边溯源的图，受同一套规则约束，每一步可追溯、可审批、可重建。

## 特性

- **图既是记忆也是控制面。** Object / Fact / Link 带类型与双时态，每条边记录来源；Decision、
  Conflict、Activity 是一等对象，`explain` 能从任一结论回溯到证据链。
- **每用户一个隔离的常驻 agent。** 入口 agent 跑在自己的容器里，靠 Handle 与 Grant 拿到能力，
  进程不持任何外部凭证。
- **Worker 在图上可发现、按需拉起。** `find_workers` / `invoke_worker` 是一等能力；Worker 结果
  与决策带溯源写回图。
- **门与审批。** 每个外部系统经一个 Gatekeeper 接入（SSH / HTTP / Docker / MCP 四种传输）；
  触及凭证、内部或有状态系统的动作生成审批卡片，审批通过后才执行，可自动批准的种类由 owner 配置。
- **看得见、接得上。** 图有 Explorer（Graph / Decision / Lineage 三工作区）与 MCP gateway：
  Claude Code 或任何 MCP 客户端凭 Handle 接到同一份图。

## 状态

当前版本 **v0.3.0**。S1（对话入图）、S2（审批执行写回）、S3（本体、采集器、Explorer、MCP）三个
切片均已由验收脚本在目标主机通过。进度、当前波次与遗留清单只在一处维护：
**[`docs/STATUS.md`](docs/STATUS.md)**。任何会话从那里开始；agent 会话的约束见
[`CLAUDE.md`](CLAUDE.md)。

验收证明的是内核 / 门 / 扩展这一侧的链路成立。三份验收全部跑在 `deploy/fake-llm`（硬编码的
状态机）上，真实模型自己选对工具这件事尚未验证，是下一阶段的内容。

## 部署

按 [`docs/runbooks/README.md`](docs/runbooks/README.md) 的「① 主机初始化」从上到下走一遍。
前置条件：

- Docker 与 Docker Compose，容器运行时需可用 gVisor（`runsc`）
- Postgres（compose 内起）
- 构建与 CLI：Node.js 22 与 pnpm（版本由 `package.json` 的 `packageManager` 钉死）

环境相关的具体值（主机、网段、数据目录、密钥）只放在 gitignored 的 `docs/private/` 与主机的
`.env` / `secrets/`；入库文档一律用 `<TARGET_HOST>`、`${NEXTTIME_DATA}` 这类占位符。

## 使用

登录 web 控制台，在对话框里说出需求。入口 agent 会在图上找 Worker 并拉起；需要审批的动作以卡片
形式出现在「待我审批」，通过后执行，结果与决策写回图。图的内容在 `/explorer` 查看。

把外部工具接到同一份图：

- Claude Code：[`docs/howto-connect-claude-code.md`](docs/howto-connect-claude-code.md)
- 本地 pi：[`docs/howto-connect-pi.md`](docs/howto-connect-pi.md)

接入新系统或新领域概念：`docs/runbooks/add-gatekeeper.md`、`docs/runbooks/add-domain-pack.md`。

## 组件

全 TypeScript pnpm monorepo。

| 目录 | 内容 |
|---|---|
| `packages/shared` | 领域类型、状态转移表、capability 注册表、线上契约 schema |
| `packages/kernel` | 内核：图存储、本体、epistemic、治理（Policy / 审批 / Grant / Handle）、chat、MCP gateway、Explorer 契约 |
| `packages/agent-host` | 入口容器与内核之间的事件桥 |
| `packages/worker-supervisor` | 拉起与回收 Worker 容器，维护出网白名单 |
| `packages/platform-extension` | 跑在 pi 内的平台扩展，`entry` / `worker` / `interactive` 三种模式 |
| `packages/gatekeeper-base` | 门的协议、基类、四种传输与命令策略表 |
| `packages/llm-proxy` | 模型调用统一出口，agent 不直接持 provider key |
| `packages/egress-proxy` | 容器出网代理，按 Worker 来源放行 |
| `packages/web` | 控制台：对话、任务、审批、治理 |
| `gatekeepers/` | 预置门实例（`docker`、`ragflow`） |
| `collectors/` | 采集器（`host-inventory`） |
| `ontology/` | 领域包（`ops-assets-v1`） |
| `explorer/` | Explorer 静态包构建脚本 |
| `deploy/` | caddy、worker-runtime、fake-llm、备份、验收夹具 |
| `scripts/` | 验收脚本 `accept_s{1,2,3}.sh`、运维演练、CI 守卫 |

## 安全边界

三条设计底线不可降级：

1. agent 与 kernel 进程不持凭证；凭证只到门。
2. 触及有凭证、内部或有状态系统的动作必经审批。
3. 隔离与审计只增不减。

不变量 I1–I16 由内核定时校验并输出指标；混沌演练见 `docs/runbooks/host-chaos.md`。

## 开发

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test            # 有 DATABASE_URL 时跑内核的 Postgres 集成套件
pnpm build
pnpm ci:guards       # 内核纯度、pi 版本一致性、词表守卫（先构建 shared）
pnpm contract:check  # capability 注册表快照
```

CI 三个 job：`guards` / `quality` / `test`；另有 e2e、CodeQL、Scorecard、镜像扫描与 pi 漂移检测。
改动走分支加 PR，Conventional Commits，单 commit 的 PR 用 squash 合并；release-please 据此生成
CHANGELOG 与版本，Renovate 处理依赖更新。测试分层与每层的命令见 [`docs/testing.md`](docs/testing.md)，
线上契约约定见 [`docs/wire-contract-conventions.md`](docs/wire-contract-conventions.md)。

## 文档

[进度入口](docs/STATUS.md) · [架构设计](docs/graph-ai-middle-platform-design.md) ·
[任务清单](docs/development-tasks.md) · [Runbooks](docs/runbooks/README.md) ·
[测试](docs/testing.md) · [Changelog](CHANGELOG.md)

参考项目借概念与协议，不 fork 代码：pi（agent 运行底层）、cloudflare-os（审批与分权蓝本）、
Semantica（Decision / Conflict / PROV-O 一等对象，Explorer 前端与 MCP 工具契约）。分析见
`docs/reference-projects-and-oss-landscape.md`。

## 许可

[MIT](LICENSE)
