# NextTime-AI — 基于 Graph 的 AI 中台

[![CI](https://github.com/btnalit/NextTime-AI/actions/workflows/ci.yml/badge.svg)](https://github.com/btnalit/NextTime-AI/actions/workflows/ci.yml)

一个 Web 中台入口。每个用户有自己的、隔离的 AI agent（pi）和一个对话框；说出需求，agent 在图上找到能干活的 Worker（也是 pi），动态拉起它们，各自通过统一的门（Gatekeeper）对接不同系统，把结果和决策带着来龙去脉写回图里，再决定下一步。所有 agent 共享同一份带类型、双时态、逐边溯源的图，受同一套规则约束，每一步可追溯、可审批、可重建。

**状态**：设计阶段（v0.2）。仓库只有文档，尚无可运行组件。技术栈：全 TypeScript（Node + Postgres），pi 为 agent 运行底层。

## 文档

| 文件 | 内容 |
|------|------|
| `docs/graph-ai-middle-platform-design.md` | 架构设计 v0.2：领域模型与不变量、用户隔离模型、组件、一轮对话的数据流、存储 / API / WS 协议、部署、安全、路线图 |
| `docs/development-tasks.md` | 开发任务清单 v0.2：按 S1 / S2 / S3 三条切片，含验收命令，可直接交给 Codex / Claude Code |
| `docs/design-review-2026-09-01.md` | 对照原始需求的复盘、重心校验、v0.1 → v0.2 的变化与依据 |
| `docs/reference-projects-and-oss-landscape.md` | 参考项目源码分析（Semantica / cloudflare-os / pi，两轮）与开源生态调研 |

环境相关的具体值（目标主机地址、网段、路径、盘点结果）放在 `docs/private/`，已被 `.gitignore` 排除；入库文档一律使用 `<TARGET_HOST>`、`${NEXTTIME_DATA}` 等占位符。改动走分支与 PR。

## 参考项目

借概念与协议，不 fork 代码。本地阅读副本位于仓库根目录、已被 `.gitignore` 排除：

- pi 0.84.4（MIT）：入口 agent 与 Worker 的运行底层，RPC 子进程模式、扩展事件、JSONL 会话树、pi-ai 多 provider
- cloudflare-os（Apache-2.0）：产品形态与治理蓝本，聊天 RPC 面、审批卡片与 `awaitDecision`、自动批准 drain、内核 / 门 / Worker 分权
- Semantica 0.6.7（MIT）：Decision / Conflict / PROV-O / 双时态一等对象、Explorer 前端复用、MCP 工具契约

## 许可

MIT，见 `LICENSE`。
