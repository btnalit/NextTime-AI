# Runbook：host-agent-host（agent-host 事件桥 + 内核真正的 AgentRuntime）

对应任务：development-tasks.md § S1.5（本 runbook 覆盖后半：agent-host 事件桥、内核侧
`AgentHostRuntime`、假 LLM 上游）。前置：`docs/runbooks/host-worker-runtime.md`（S1.5a，前半——
`worker-runtime` 镜像与 `worker-supervisor` 常驻模式必须已经过主机验收）。占位符取值见
`docs/private/`（不入库）。

## 1. 目的

`packages/agent-host` 是纯事件桥：向 `worker-supervisor` 申请/复用某用户的入口容器、attach 到它
的 stdio（Docker Engine API，`DOCKER_SOCKET_PATH` 只读挂载）、把 pi 的 RPC stdout 翻译成平台
`AgentRuntimeEvent` 词表（唯一的翻译点：`packages/agent-host/src/bridge.ts`）、经一条长连接
WebSocket（`/internal/agent-host`）转发给内核。内核侧 `AgentHostRuntime`
（`packages/kernel/src/application/host-bridge/agent-host-runtime.ts`）实现 `AgentRuntime`
端口，为每个 Turn 申请/复用入口 Handle 并发 `startTurn`/`stopTurn` 命令。

`deploy/fake-llm` 是一个确定性的 OpenAI 兼容假上游（`config/llm-providers.fake.example.yaml`），
让整条链路（kernel → agent-host → 容器里的 pi → llm-proxy → fake-llm）不需要任何真实 provider key
就能跑通端到端对话——这正是本任务验收要用到的路径。

## 2. 契约摘要

### 2.1 kernel ⇄ agent-host（WebSocket `/internal/agent-host`）

只在 `control` 网络可达，内核不发布任何主机端口（设计文档 §11）——与 `/internal/llm-usage`、
`/internal/handle-revocations` 同一信任边界，本协议不带额外鉴权。Schema 定义在
`@nexttime/shared` 的 `agent-host-protocol.ts`（kernel 与 agent-host 共享同一份，不会漂移）。

agent-host → kernel：
- `{"type":"hello","instanceId":"<uuid>"}`：每次连接建立后立即发送。`instanceId` 是 agent-host
  **进程**级别（不是每次连接）生成一次的 `randomUUID()`——kernel 用它区分"同一进程的重连"（网络
  抖动，不打扰任何仍在跑的 Turn）与"进程真的重启了"（放弃所有它认为还 active 的 Turn，标记
  `interrupted`，因为不会再有任何事件回报了）。
- `{"type":"turnAccepted","turnId":"..."}`：agent-host 已经真正拿到 pi 自己对 `prompt` 命令的
  `success:true` 确认（不是"字节写进了 stdin"这么弱的信号）。
- `{"type":"turnRejected","turnId":"...","reason":"..."}`
- `{"type":"runtimeEvent","event":{...}}`：`event` 就是 `AgentRuntimeEvent`
  （`textDelta`/`toolCallStarted`/`toolCallEnded`/`message`/`turnEnded`）。

kernel → agent-host：
- `{"type":"startTurn","workspaceId","chatId","turnId","principalId","prompt","handle","kernelLlmUrl"}`
  ——`handle` 是刚签发/复用的入口 Capability Handle，两端都绝不记日志；只经这一条命令从 kernel 流向
  agent-host 再流向 `worker-supervisor` 的 `/resident/spawn` 请求体，再到容器 env。
- `{"type":"stopTurn","turnId","principalId"}`

### 2.2 pi 事件 → 平台事件映射表（唯一翻译点：`packages/agent-host/src/bridge.ts`）

验证依据（非凭空猜测——见 bridge.ts 自己的模块注释引用的具体源码路径）：
`pi-0.84.4/packages/coding-agent/docs/rpc.md`、`.../src/modes/rpc/{rpc-mode,rpc-types}.ts`，以及
本仓库 `packages/platform-extension/src/modes/entry.ts`（同一份事件流的另一个消费者，其
`agent_start`/`agent_settled` 定义"一个平台 Turn"的先例，本模块照抄同一约定）。

| pi RPC 事件 | 平台事件 | 备注 |
|---|---|---|
| `message_update` 且 `assistantMessageEvent.type==='text_delta'` | `textDelta` | 其余 sub-type（`thinking_*`/`toolcall_*`/`text_start`/`text_end`）丢弃 |
| `tool_execution_start` | `toolCallStarted` | |
| `tool_execution_end` | `toolCallEnded` | |
| `message_end` 且 `message.role==='assistant'` 且有文本 | `message {role:'assistant'}` | 纯 tool-call、无文本的助手消息不落库；`role` 非 assistant（`user`/`toolResult`/`bashExecution`）一律丢弃——`FakeAgentRuntime`（S1.4）也从不发 `role:'tool'`，两个 runtime 的持久化历史形状保持一致 |
| `agent_settled` | `turnEnded`（`completed` 或 `interrupted`，取决于 host.ts 是否记录过 `stopTurn`） | 不是 `agent_end`——同一个 Turn 内可能有多次 `agent_end`（自动重试/自动压缩/排队续问） |
| `{"type":"response","command":"prompt","id":<turnId>,"success":...}` | `turnAccepted` / `turnRejected` | 不算进 bridge.ts 的翻译表——由 `host.ts` 直接处理这条 pi 自己的确认帧，因为它是"这条 prompt 命令"的响应，不是事件流 |
| `extension_error` | （无平台事件，仅记日志） | |
| 其余（`agent_start`/`turn_start`/`turn_end`/`message_start`/`bash_execution_update`/`queue_update`/`compaction_*`/`auto_retry_*`/`summarization_retry_*`/`extension_ui_request`） | 丢弃 | S1 平台词表没有对应槽位 |

### 2.3 agent-host 自身的编排

- 每个 principal 至多一个 in-flight Turn（`host.ts`）：pi RPC 一个进程一次只能跑一个 prompt
  （没有 `streamingBehavior` 就会被拒），一个入口容器就是一个用户的一个 pi 进程——同一用户第二个
  Chat 并发发消息会被直接 `turnRejected`（reason 明确写出原因），不会破坏第一个 Turn 的事件归属。
  这是本任务的已知限制，不是本任务或之前任何 S1 任务解决的"一个入口容器怎么服务多个并发 Chat"
  问题——留给以后。
- 每个 `startTurn` 都调用一次 `POST /resident/spawn`（幂等——复用在跑的容器，或在容器已死时重建，
  这正是"崩溃自动重拉"）+ 一次 `POST /resident/:principalId/touch`（best-effort，spawn 本身也已经
  刷新了空闲计时，touch 失败不阻塞 Turn）。
- 容器 stdio attach 崩溃/被 `docker kill`：mid-turn 触发 `turnEnded {status:'interrupted'}`；下次
  `startTurn` 重新 spawn + 重新 attach（因为 supervisor 返回了不同的 `containerId`）。

## 3. 主机验收步骤

```bash
cd <CODE_DIR>
fetch origin
checkout task/s1-5b-agent-host
docker compose build kernel agent-host llm-proxy fake-llm
```

准备（host-only 配置，绝不提交进仓库）：

```bash
cp config/llm-providers.fake.example.yaml "${NEXTTIME_DATA}/config/llm-providers.yaml"
echo 'FAKE_LLM_API_KEY=fake' >> "${NEXTTIME_DATA}/secrets/llm-proxy.env"
make gen-models   # 容器化生成 models.json——见 Makefile 自己的注释；本机不需要 corepack/node
```

起服务（`AGENT_RUNTIME=agent-host` 现在是 compose 默认值——见 docker-compose.yml 的 `kernel`
服务；仍可用 `.env` 里的 `AGENT_RUNTIME=fake` 切回旧行为）：

```bash
docker compose --profile test up -d fake-llm llm-proxy egress-proxy worker-supervisor agent-host
docker compose up -d kernel
docker compose ps
```

Bootstrap 一个 workspace 与两个用户，逐条驱动 WS 协议（`authenticate → new_chat → subscribe_chat →
send_chat_message → 观察 chat.stream/chat.message/chat.metadata`），验证隔离、`docker kill` 续聊、
`llm_usage` 落库、`explain` 溯源——具体命令与实测结果记在 `docs/private/host-s1-5b-<date>.md`
（不入库；见 PR body）。

## 4. 已知偏离 / 假设（详见 PR body "假设与偏离"）

- **worker-supervisor 保持不动**：容器 stdio attach 放在 agent-host 自己（只读挂载
  `DOCKER_SOCKET_PATH`），没有给 `worker-supervisor` 新增 `/resident/:principalId/attach`
  端点——理由见 `packages/agent-host/src/container-io.ts` 模块注释：保持已经过 S1.5a 主机验收的
  `worker-supervisor` 完全不动，代价是两个组件都摸 docker.sock（agent-host 只读挂载、只做
  attach，不 create/start/stop 容器）。
- **入口 Session 的 Principal**：`AgentHostRuntime.ensureEntrySession` 让 `kind='entry'` 会话的
  `principal_id` 就是那个人类 Principal 自己（照抄 `kind='web'` 会话的既有做法），没有为"这个用户
  的入口 agent 实例"单独铸造一个 `kind='agent'` Principal——`packages/shared/src/enums.ts` 里
  `agent` 这个 Principal kind 的字面定义确实是"一个 WorkerRun 或一个入口 agent 实例"，但铸造这个
  身份需要新的建模决策（它自己的 role、创建时机），不在本任务单方面决定的范围内，留给以后。
- **`KERNEL_LLM_URL` 出现两次**：`startTurn` 命令自带 `kernelLlmUrl` 字段（kernel 自己配置的
  值），agent-host 自己的 env 也有一份同名 `KERNEL_LLM_URL`（仅作兜底默认值，实际以命令里的值为
  准）——两处都留着是为了同时满足协议文字（点 1 给的 JSON 形状）与 agent-host 环境变量清单（"只有
  这四个"）两份措辞，见 `packages/agent-host/src/host.ts` 的 `HostOptions.defaultKernelLlmUrl`
  文档注释。
- **`prompt` 的确认口径**：agent-host 不是"字节写进容器 stdin 就算 accepted"，而是等 pi 自己对
  那条 `prompt` 命令（用 `id=turnId` 关联）的 `{"success":true}` 响应——更贴近"pi 真的接受了这个
  提示"，代价是多一跳往返，仍在内核侧 30s 的 `turnAccepted` 超时预算内（`AgentHostRuntime` 的
  `turnAcceptedTimeoutMs`，架构点 2 原文的"e.g. 30s"）。
