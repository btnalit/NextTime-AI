# 接入指南：把 Claude Code 接到本平台的图

对应任务：development-tasks.md §S3.6（MCP gateway）。把 Claude Code（或任何支持 streamable HTTP
的 MCP 客户端）接到内核的 `/mcp` 端点，经同一套 Handle/Grant 机制观察图、调用你被授权的能力。

## 前提

- 平台已部署，`caddy` 已经把 `/mcp` 反代到 `kernel:8080`（`deploy/caddy/Caddyfile`；本机开发直连
  `kernel` 自己的端口也可以，跳过 caddy/TLS）。
- 你是这个 workspace 的 **owner**：`issue_handle` 当前是 `channel:'human'`、`minRole:'owner'`
  能力（design doc §9.3 governance 行），还没有对应的控制台按钮（S3.11 web 侧未落地这一步），需要
  owner 自己的 API key 直接调用一次能力接口。
- 若走公网面（`https://<host>:8443`），Caddy 用内网自签 CA——先按
  `docs/runbooks/host-caddy.md` §E8.2 把根证书导入本机信任库，否则 TLS 握手会失败（或临时用
  `curl -k`/客户端的"忽略证书"选项验证连通性，正式接入前仍建议导入 CA）。

## 第 1 步：拿一个 Handle

用你的 API key 调用 `issue_handle`（`sessionKind` 目前只接受字面量 `'interactive'`）：

```bash
curl -sk -X POST "https://<host>:8443/api/cap/issue_handle" \
  -H "Authorization: Bearer <YOUR_OWNER_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"sessionKind": "interactive"}'
```

返回（示例，字段已按 `docs/wire-contract-conventions.md` 的形状）：

```json
{
  "ok": true,
  "result": {
    "handle": "eyJhbGciOiJFZERTQSJ9....",
    "sessionId": "b7b6b8b2-....",
    "onBehalfOf": "3f9a2e10-....",
    "expiresAt": "2026-10-07T12:00:00.000Z",
    "scope": { "capabilities": ["get_object", "traverse", "search", "..."], "resources": {} }
  }
}
```

`result.handle` **只在这一次响应里出现，内核不会再返回明文**——立刻把它保存到密码管理器或
`.env`，不要提交进仓库、不要贴进聊天记录。

- 不传 `scope` 时，默认拿到"入口 agent 上限 ∩ 你的 Grant"的全集（S3.6 registry-entry 的
  `intersectScope`，`packages/kernel/src/application/gateway/issue-handle-handler.ts`）——即
  `entry` 模式能看到的观察类能力全集，加上你已 `connect_gatekeeper` 授权的门。
- 想要更窄的范围，显式传 `scope.capabilities`（子集）/`scope.resources.gatekeeper`
  （子集）——请求超出你自己上限的部分会被静默丢弃，返回的 `scope` 字段就是实际拿到的范围，据此核
  对，不是"发什么就给什么"。
- `ttlSeconds` 默认 24 小时，上限 30 天（`ISSUE_HANDLE_MAX_TTL_SECONDS`）；到期后这个 Handle 上的
  一切调用都是 401，需要重新走本步骤拿新 Handle（没有"续期"接口）。
- 撤销：目前没有单独的"撤销这一个 Handle"能力（任务范围内未新增）——`disable_principal`
  （控制台"成员与授权"页，或直接调用能力）禁用你自己账号会级联撤销，这条路径不适合用来撤销单个
  开发工具的 Handle；到期前唯一的收紧手段是等 ttl 自然过期，或让 owner 撤销你相关的
  `connect_gatekeeper` Grant（这会在下一次 `issue_handle` 时收窄新 Handle 的范围，但不撤销已经
  签发的旧 Handle）。

## 第 2 步：把 Handle 配成 Claude Code 的 MCP server

```bash
claude mcp add --transport http nexttime "https://<host>:8443/mcp" \
  --header "Authorization: Bearer <上一步拿到的 handle>"
```

等价的 `.mcp.json`（项目级）写法：

```json
{
  "mcpServers": {
    "nexttime": {
      "type": "http",
      "url": "https://<host>:8443/mcp",
      "headers": { "Authorization": "Bearer <上一步拿到的 handle>" }
    }
  }
}
```

- **只接受 Handle，不接受 API key**：`/mcp` 是纯 Handle 通道（`interfaces/mcp/index.ts` 自己的
  模块注释），把 API key 填进 `Authorization` 头一样会 401——这不是"人类通道"，是给外部工具/agent
  用的。
- 没有 `Authorization` 头、Bearer 格式不对、Handle 过期/被撤销/签名校验失败，都是 401，MCP 握手
  在协议层之前就被拒绝（不会看到一个"假的" `tools/list` 空列表）。

## 第 3 步：核对与使用

Claude Code 连上后，`tools/list` 应该正好是这个 Handle 自己 `scope.capabilities` 里的 Handle 通道
能力（`listByChannel('handle')` 过滤），外加 Semantica 兼容别名（下表）——不是整个平台的能力清单，
也不会包含 `issue_handle`/`grant_capability` 这类 `channel:'human'` 的治理能力（这类能力永远不会
出现在任何 Handle 的 scope 里，也永远不会被投影成 MCP 工具）。

在 Claude Code 里直接问图，比如：

> 用 `traverse` 从某个 Object 出发，看看它依赖哪些服务

模型会调用 `traverse` 工具，内核按这个 Handle 的 `on_behalf_of` 记审计、按 scope 校验授权——跟
你自己在 web 控制台里点出来的是同一张图、同一套 Grant。

## Semantica 工具名兼容表

Semantica 0.6.7（本平台图基底的参考项目，只借概念/契约，不复用实现）的 17 个 MCP 工具里，5 个跟
本平台某条能力语义相同，作为别名额外挂出（`packages/kernel/src/interfaces/mcp/reference-tool-
aliases.ts`，别名工具只在其目标能力在你的 Handle scope 内时才出现）：

| Semantica 工具名 | 本平台能力 | 必填参数改名 |
|---|---|---|
| `get_provenance` | `explain` | `entity_id` → `nodeId` |
| `get_causal_chain` | `causal_chain` | `decision_id` → `decisionId`（`direction`/`max_depth` 无对应，忽略） |
| `analyze_decision_impact` | `decision_impact` | `decision_id` → `decisionId` |
| `search_graph` | `search` | `query` 原样；可选 `node_type` → `objectType`（`limit` 无对应，忽略） |
| `add_relationship` | `assert_fact` | `source` → `objectId`，`target` → `value`，可选 `type` → `linkType`（本平台 `linkType` 必填，省略会在底层 `assert_fact` 校验失败，不会被悄悄补默认值） |

`record_decision`/`query_decisions`/`find_precedents` 三个 Semantica 工具名跟本平台同名能力**撞
名**，不会挂出第二个同名工具——直接用原生工具（本平台自己的参数形状：`record_decision` 是
`{summary, relatedFactIds?, relatedTaskId?}`，不是 Semantica 的
`{category,scenario,reasoning,outcome,confidence}`；`find_precedents` 是 `{need}` 不是
`{scenario}`）。其余 9 个 Semantica 工具（`extract_*` 三个文本抽取、`add_entity`、
`get_graph_summary`/`get_graph_analytics`、`run_reasoning`/`abductive_reasoning`、
`export_graph`）在本平台没有语义对应的能力，按任务要求不编造——完整理由见
`reference-tool-aliases.ts` 自己的模块注释表。

## 排障

| 现象 | 原因 |
|---|---|
| 连接时 401 | 没传 `Authorization`、传了 API key 而不是 Handle、Handle 已过期/被撤销，或内核没配 Handle 签名密钥（后者是 500，不是 401——出现 500 找 kernel 日志的 `HandleKeyConfigError`）。 |
| `tools/list` 是空的 | Handle 的 `scope.capabilities` 是空数组——检查 `issue_handle` 调用时的 `scope` 参数，或你自己在这个 workspace 的 Grant 是否覆盖你请求的门。 |
| 某个工具调用失败，内容是 `forbidden: ...` | 那个能力不在这个 Handle 的 scope 里——`tools/list` 本该不会列出它；如果列出来了却还 403，是一个需要上报的 bug。 |
| 某个 `<gate>.<op>` 风格的工具没出现 | 你的 Handle 没有 `<gate>.<op>`（observe）在 scope 里，或者你在这个 workspace 没有对应门的 `connect_gatekeeper` Grant——`list_allowed_operations` 内部调用失败也会静默退化成"这次没有门工具"，不会让整个 `tools/list` 失败。 |
| TLS 握手失败 | 内网自签 CA 没导入客户端信任库——见前提里的 `host-caddy.md` §E8.2，或本机开发直连 kernel 端口跳过 TLS。 |
