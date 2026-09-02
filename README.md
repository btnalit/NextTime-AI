# NextTime-AI — 基于 Graph 的 AI 中台

自托管、可审计、以领域模型为中心的 AI 中台。把企业知识（Ontology / Knowledge Graph / Code Graph）、运行上下文（Context Graph）与治理（Capability / Policy / Approval / Audit）放进同一套带溯源、双时态的图模型，让多个 agent 运行时（pi / Claude Code / Codex / Hermes）经同一个 MCP gateway 共享状态、受同一套策略约束。

**状态**：设计阶段。目前仓库只有文档，尚无任何可运行组件。

## 文档

| 文件 | 内容 |
|------|------|
| `docs/graph-ai-middle-platform-design.md` | 架构设计（领域模型、不变量、状态机、存储 / API / 部署 / 安全 / 路线图） |
| `docs/reference-projects-and-oss-landscape.md` | 参考项目源码分析（Semantica / cloudflare-os / pi）与开源生态调研 |
| `docs/development-tasks.md` | 开发任务清单（按里程碑拆分、含验收标准与命令，可直接交给 Codex / Claude Code） |
| `docs/design-review-2026-09-01.md` | 设计对照原始需求的复盘，以及由此产生的修订 |

环境相关的具体值（目标主机地址、网段、路径、盘点结果）放在 `docs/private/`，已被 `.gitignore` 排除，不入库；入库文档一律使用 `<TARGET_HOST>`、`${NEXTTIME_DATA}` 等占位符。

## 参考项目

设计借鉴了三个开源项目的概念（借概念与协议，不 fork 代码）。本地阅读副本位于仓库根目录、已被 `.gitignore` 排除：

- pi 0.84.4（MIT）：agent 执行内核、扩展 ABI、JSONL 会话树
- cloudflare-os（Apache-2.0）：内核 / Gatekeeper / Worker 分权模型、审批队列
- Semantica 0.6.7（MIT）：Decision / Conflict / PROV-O / 双时态一等对象、存储 facade

## 许可

MIT，见 `LICENSE`。
