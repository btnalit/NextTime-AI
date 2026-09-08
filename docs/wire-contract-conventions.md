# 线上契约约定（Wire Contract Conventions）

> 2026-09-08 决定。解决全项目复审（`docs/code-review-2026-09-04.md` §5）登记的语义漂移：同一个词在不同层有不同形状，或同一个概念在不同层用不同的词。软件能跑，但契约不稳定，web / platform-extension / 验收脚本 / 门协议各自猜。以下是**规则**，实现 PR 按此逐项对齐；此后新增 capability 必须遵守，S3.7「语义一致性校验」把它做成 CI 检查。

## 1. 词表（Vocabulary）

| 词 | 唯一含义 | 禁止的用法 |
|----|----------|-----------|
| `idempotencyKey` | **调用方**为一次 capability 调用提供的去重键（`request_action` 等的参数；落库为 `action_requests.idempotency_key`）。同键重放返回同一结果。 | 不得用于门协议里由 ActionRequest 派生的执行键 |
| `actionRequestId` | 一个 ActionRequest 的 id。门协议 `/gate/apply` 的执行预占键就是它——字段名就叫 `actionRequestId`，不叫 `idempotencyKey`。 | — |
| `actionKind` | **仅** ActionDescription 里的展示对象 `{ tag, label }`（cloudflare-os 类型原样）。 | 不得把裸字符串叫 `actionKind` |
| `actionKindTag` | 动作种类的裸标识字符串（= `actionKind.tag`）。策略（`set_auto_approved_action_kind`）、事件、聊天卡片、审计里承载的都是它。 | — |
| `resourceType` / `resourceId` | Grant 指向的资源种类与 id（当前 `'gatekeeper'`；将来 `'worker_definition'`、`'skill'`）。`capability_grants.capability` 改名为 `resource_type`；`grant_capability` / `revoke_capability` 参数改为 `resourceType` + `resourceId`（原 `scope` 里的 id 提为一等字段，`scope` 只留真正的范围限定）。 | Grant 不再借用「capability」这个词——capability 只指注册表里的能力名 |
| `mode`（capability 注册表） | 治理类别，四值：`observe`（只读）、`write`（平台内即时状态变更，审计、无审批）、`propose`（产生**待人类发布/批准**的草稿或请求：`propose_*`、`request_connection`、`propose_ontology_change`）、`execute`（经门作用于外部系统，按策略审批）。 | `assert_fact` / `record_decision` / `create_task` / `invoke_worker` / `report_*` / `cancel_task` / `register_source` / `submit_observations` 等即时写操作不得标 `propose`，改 `write` |
| `mode`（Operation，门侧） | 不变：`observe` / `execute`（设计 §7.4）。两处 `mode` 的取值集合不同，靠类型名区分：`CapabilityMode` vs `OperationMode`。 | — |
| `kind` | 只用于**类型判别**字段（`principals.kind`、`chat.message.kind`、`ChatMessageContent.kind`）。 | 不得用作"种类描述"的自由文本 |
| `*At` | 时间戳一律 ISO 8601 UTC 字符串（`createdAt`、`expiresAt`、`observedAt`）。 | 线上不得出现 epoch 数字或 `Date` 对象序列化差异 |

## 2. 标识（Identity）

- 单资源结果返回**资源对象**，其主键字段一律叫 `id`；不再在顶层重复 `taskId` / `actionRequestId` / `connectionRequestId`。
- 结果里**引用另一资源**时用 `<resource>Id`（`taskId`、`workerRunId`、`gatekeeperId`、`chatId`）。
- 创建/提议类 capability 的结果 = 被创建的资源对象（含 `id`、状态字段、`createdAt`）。
- 不返回数据库原始行：snake_case 列名不出现在线上；投影函数在 application 层，一处定义。

## 3. 信封（Envelopes）

- 列表类 capability（`list_*`、`find_*`、`get_chat_history`、`query_*`）统一返回 `{ items: T[], nextCursor?: string }`。不返回裸数组，不返回 `{ skills: [...] }` 这类按资源命名的键。
- 分页参数统一 `limit`（有上限，超出按上限截断并在结果 `truncated: true` 标记，而非静默）、`cursor`。
- 成功响应：HTTP `200 { ok: true, result }`，WS JSON-RPC `result`；错误：HTTP `{ ok: false, error: { code, message } }` 与 WS `error: { code, message, data? }`，两侧的 `code` 词表一致（F10 已对齐）。
- 服务端推送事件的 payload 与对应资源对象**同形**（`task.updated` 推的就是 Task 对象或其精确子集，不另造形状）。

## 4. 版本与兼容

- 1.0 之前：破坏性对齐一次到位，同一 PR 内更新全部消费者（web、platform-extension 两种模式、fake-llm 场景、`accept_s1.sh` / `accept_s2.sh`、运行手册），主机验收通过后合入。
- 1.0 之后：线上契约改动走 `docs/` 下的变更记录 + 兼容期；S3.7 的校验脚本从 `packages/shared` 的 Zod schema 生成"契约快照"，PR 中的快照差异必须在描述里逐条说明。

## 5. 校验（S3.7 落地方式）

- `packages/shared`：为每个 capability 增加 `resultSchema`（现在只有 `paramsSchema`），列表结果复用 `listEnvelope(itemSchema)`。
- 契约快照：`pnpm contract:snapshot` 把所有 params/result schema 序列化到 `docs/contracts/*.json`，CI 比对。
- 词表守卫：`scripts/guards/vocabulary.mjs` 在 `packages/shared` 与 kernel `interfaces/` 中禁止：裸字符串字段名 `actionKind`、`idempotencyKey` 出现在 gatekeeper 协议、注册表里 `mode: 'propose'` 的能力名不以 `propose_` / `request_` 开头。

## 6. 实施顺序

1. `packages/shared`：`CapabilityMode` 四值、`resultSchema` + `listEnvelope`、字段改名（`actionKindTag`、`resourceType`/`resourceId`、门协议 `actionRequestId`）。
2. kernel：注册表 mode 重标、handlers 投影函数统一、grants 迁移（列改名）、门客户端字段改名。
3. gatekeeper-base 与两个门实例：`/gate/apply` 字段改名。
4. platform-extension、web、fake-llm、验收脚本、运行手册同 PR 更新。
5. 主机跑 `accept_s1.sh` + `accept_s2.sh`。
6. 契约快照 + 词表守卫进 CI（S3.7）。
