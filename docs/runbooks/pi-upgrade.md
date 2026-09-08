# Runbook：pi-upgrade（pi 版本升级契约）

对应任务：development-tasks.md § S3.10（"升级 pi 版本（契约测试流程）"）。回答的问题是"pi agent
解耦，可以跟随主线更新吗"——本手册把答案变成一份可执行流程：耦合面清单、单一版本源、升级步骤、
兼容性测试清单、漂移检测、回滚。

前置阅读：`README.md`"pi 0.84.4（MIT）"条目；`packages/platform-extension/src/{index,modes/entry,
modes/worker}.ts`；`deploy/worker-runtime/{Dockerfile,entrypoint.sh}`；
`packages/agent-host/src/bridge.ts`。

## 1. 现状：pi 是怎么被锁住的

`@earendil-works/pi-coding-agent`（以及配套的 `@earendil-works/pi-ai`）当前锁定 **0.84.4**，精确
版本号（不是 `^0.84.4`），原因见 `docs/development-tasks.md` §0.3。这不是随意的保守——pi 没有
稳定的公开 ABI 承诺，本仓库依赖它的 CLI flag 名字、RPC 事件词表、扩展 hook 名字、`models.json`
schema、Agent Skills 校验规则等一整套*未版本化的行为契约*，其中一部分是读 pi 自己的源码验证出来
的（Dockerfile 与 `bridge.ts` 的头部注释逐条列了验证过的源文件路径），不是读它的公开文档猜的。

"冻结"和"锁定"是两回事：锁定一个精确版本没问题，冻结是指*没有人知道升级要改哪些地方、升级坏了怎么
知道、升级失败了怎么回退*。本任务修的是后者，不改前者——本 PR 不升级 pi，只交付契约、检测、
自动化。

## 2. 耦合面清单

下表是本仓库里每一处依赖 pi *具体行为*（而不只是把它当一个黑盒子进程跑）的位置。"覆盖它的测试/
校验"一栏空白或标注"人工"的行，是升级时必须手工走一遍主机验收的地方——这正是本清单存在的意义：
升级前先把这张表过一遍，而不是等生产环境炸了才发现某个 flag 改名了。

| 文件/位置 | 用到的 pi API / flag / 格式 | 变更后果 | 覆盖它的测试/校验 |
|---|---|---|---|
| `packages/platform-extension/package.json` | `dependencies["@earendil-works/pi-coding-agent"]`、`devDependencies["@earendil-works/pi-ai"]` 精确版本号 | 两者不同步会导致类型定义（编译期）与运行时安装的版本（容器内）不一致 | `scripts/check-pi-version-consistency.sh`（`pnpm ci:guards`） |
| `packages/platform-extension/src/index.ts` | 默认导出签名 `(pi: ExtensionAPI) => void`（pi 扩展加载约定：`pi -e <path>` 对每个扩展模块调用一次其默认导出） | pi 改扩展加载约定（比如改成要求具名导出）会让整个扩展在容器启动时直接报错退出 | `index.test.ts`（假 `ExtensionAPI` 桩）+ `entry.sdk.test.ts`/`worker.sdk.test.ts`（真实 pi SDK 通过 `additionalExtensionPaths` 加载真实模块） |
| `packages/platform-extension/src/modes/{entry,worker}.ts` | `ExtensionAPI.registerTool`；`pi.on(event, handler)` 的事件名 `session_start`/`input`/`context`/`agent_start`/`agent_end`/`agent_settled` 与各自 payload 形状；`ToolDefinition.execute()` 的返回契约（`{content, details, terminate?}`，抛出即映射为 `isError:true`）；`pi.appendEntry`；`pi.sendUserMessage`；`ExtensionContext.hasUI`/`ui.notify`/`sessionManager.getSessionFile` | 任一 hook 改名/去掉，或 `execute()` 返回契约变化，entry/worker 两种模式的工具注册与生命周期整体失效——这是耦合面里*最大*的一块 | `modes/entry.test.ts`/`modes/worker.test.ts`（假桩）+ `entry.sdk.test.ts`/`worker.sdk.test.ts`（真实 SDK，唯一能证明 pi 真的把 `execute()` 的 throw 映射成 `isError:true`、`context` 消息真的不落盘的测试） |
| `packages/platform-extension/src/tool-schema.ts` | 假设 pi 的 `ToolDefinition.parameters`（typebox `TSchema`）在运行时只是被当 JSON-Schema 形状的普通对象读（`.type`/`.properties`/`.required`），从不针对 typebox 的 `Kind` symbol 做校验 | pi 若开始严格校验 typebox schema，每一个用 `zod-to-json-schema` 转换出来、cast 成 `TSchema` 的工具（`report_result` 等）会在注册时报错 | 间接由 `entry.sdk.test.ts`/`worker.sdk.test.ts` 覆盖（真实工具注册+调用会触发真实校验路径） |
| `packages/platform-extension/src/{entry,worker}.sdk.test.ts` | 直接 import pi SDK 面：`createAgentSession`、`DefaultResourceLoader`、`ModelRuntime`（含 `.create`/`.registerProvider`）、`SessionManager`、`SettingsManager`、`additionalExtensionPaths`/`noExtensions` 选项、`session.subscribe`/`.prompt`/`.messages`/`.agent.state.tools`/`.dispose`、`AgentSessionEvent`（`tool_execution_end` 的 `isError`/`result`/`toolName`）；`@earendil-works/pi-ai` 的 `InMemoryCredentialStore`、`Context` 类型、`pi-ai/compat` 的 `registerFauxProvider`/`fauxAssistantMessage`/`fauxToolCall` | 这两个文件本身**就是**"pi 有没有变"的探针——任何一个具名导出被改名/删除，这两个测试直接编译或运行失败，不会静默通过 | 就是它们自己（`pnpm --filter @nexttime/platform-extension test`，也是 `pi-drift.yml` 每晚对 `@latest` 跑的那两个文件） |
| `worker.sdk.test.ts` 里记录的一个真实坑 | `createAgentSession()` 本身不触发 pi 的 `session_start` 事件——那是 `AgentSession.bindExtensions(bindings)` 内部才 `emit` 的；worker 模式的自驱动机制（`pi.sendUserMessage` 在 `session_start` 里调用）必须显式 `await session.bindExtensions({mode:'rpc'})` 才会真的跑起来（`docs/development-tasks.md` 行~691 已记录） | pi 若改变 `bindExtensions` 的签名或触发时机，worker 模式在真实 RPC 进程里可能仍然工作（因为真实 CLI 会调 `bindExtensions`），但这个测试可能测不出问题——升级时需要手工确认这条注释是否还成立 | `worker.sdk.test.ts`（部分——见左侧说明，测试本身依赖这个行为，不是独立校验它） |
| `deploy/worker-runtime/Dockerfile` | `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@<pi.version>`；CLI flags `--mode rpc`/`--session-dir <dir>`/`-e <path>`/`--system-prompt <path-or-text>`（**没有** `--system-prompt-file`，靠 `resolvePromptInput` 在路径存在时按文件内容读取）；`getAgentDir()`/`PI_CODING_AGENT_DIR`/`getModelsPath()` = `<agentDir>/models.json`；默认内置工具集 bash/edit/find/grep/ls/powershell/read/write 全开（没传任何 `--tools`/`--no-tools`/`--no-builtin-tools`/`--exclude-tools`） | pi 改任一 flag 名、去掉 `--system-prompt` 的"路径存在则读文件"回退、改 agent-dir 解析、改默认工具集——容器启动失败或工具集意外变化 | **人工**：`docs/runbooks/host-worker-runtime.md`（`docker run --rm nexttime-ai-worker-runtime pi --version`、容器内工具可用性）；无自动化测试（需要真实 Docker，仅主机验收覆盖） |
| `deploy/worker-runtime/entrypoint.sh` | 同上 CLI flags；额外假设 pi 在 RPC 模式下把事件写到 stdout、别的诊断信息不混进同一个流（否则 `container-io.ts` 的 JSONL 逐行解析会读到非 JSON 行） | flag 改名同上；stdout 混入非 JSONL 内容会让 `agent-host` 的行解析静默丢弃（`JSON.parse` 失败即 `return`，不报错） | **人工**：同上；`scripts/*.sh` 的 shell 语法/权限由 `pnpm ci:guards` 校验，但不校验 pi 自身行为 |
| `packages/agent-host/src/bridge.ts` | 对照 pi 0.84.4 源码验证过的 RPC 事件词表：`message_update`（`assistantMessageEvent.type==='text_delta'`）、`tool_execution_start`/`tool_execution_end`（`toolCallId`/`toolName`/`args`/`result`）、`message_end`（`message.role==='assistant'`，`content` 数组的 `text` 段）、`agent_settled`；RPC 命令 `{"type":"prompt","id":<turnId>,"message":...}` 及响应 `{"type":"response","command":"prompt","id":...,"success":bool,"error"?}`；`{"type":"abort"}` | pi 改事件名/字段——`translatePiEvent` 把无法识别的类型**静默**降级为 `{kind:'none'}`（不抛错），后果是对话在平台侧看起来"卡住不动"而不是报错，属于最隐蔽的一类耦合失效 | `bridge.test.ts`（针对字面量 JSON fixture 的单元测试，fixture 是手写的、按 pi 0.84.4 文档/源码构造的，**不是**跑真实 pi 进程产出的——升级时这些 fixture 本身也需要对照新版本复核，见下节步骤 4） |
| `packages/agent-host/src/host.ts` | 同一份 prompt/response 关联契约（`record.type==='response' && record.command==='prompt' && record.id===turn.turnId`）；`extension_error` 事件形状（`extensionPath`/`event`/`error`） | 同上，关联失败会导致 `turnAccepted`/`turnRejected` 永远等不到，Turn 挂起直到超时 | `host.test.ts`（同样基于手写 fixture，非真实 pi 进程） |
| `packages/agent-host/src/container-io.ts` | 假设 pi 的 RPC stdout 是严格 JSONL：LF 分隔、每行一个 JSON 对象、不会因为遇到 U+2028/U+2029 而拆行（`docs/rpc.md` framing 契约，本模块特意不用 `node:readline` 就是因为它不满足这条） | pi 若改变 framing（比如 stdout 混入非 JSONL 诊断行），手写的 buffer+`indexOf('\n')` 分帧逻辑可能拆出坏行，静默被 `JSON.parse` 失败吞掉 | 无专门针对 pi framing 变化的测试；仅有通用的分行单元覆盖 |
| `packages/worker-supervisor/src/{spawn-spec,task-spawn-spec}.ts` | 入口/Worker 容器 env 契约：`KERNEL_URL`/`KERNEL_LLM_URL`/`CAPABILITY_HANDLE`/`WORKSPACE_ID`/`NEXTTIME_MODE`/`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`（+小写镜像）；常驻模式额外要 `PI_CODING_AGENT_DIR`/`HOME`；`models.json` 只读挂载到 pi 默认 agent dir 下 | pi 改 env var 名字（比如 `PI_CODING_AGENT_DIR`）或 `getAgentDir()`/`getModelsPath()` 解析逻辑，会让容器读不到 `models.json`，模型路由整体失效 | `spawn-spec.test.ts`/`task-spawn-spec.test.ts`（纯 builder 单元测试，断言 env 数组内容，不跑真实 pi 进程） |
| `packages/llm-proxy/src/gen-models-json.ts` | 生成 pi 的 `models.json`，对照 pi 0.84.4 的 `ModelsConfigSchema`/`ProviderConfigSchema`：`{providers:{<id>:{baseUrl,apiKey,api,models:[{id,cost?}]}}}`；`api` 取值 `openai-completions`/`openai-responses`/`anthropic-messages`；`apiKey` 的 `$VAR`/`${VAR}` 模板由 pi 自己的 `resolveConfigValue` 在容器内解析 | pi 改这个 schema（新增必填字段、改 `api` 枚举值、去掉 `$VAR` 模板支持）会让每个 agent 容器拿到内核，但模型请求全部失败 | `gen-models-json.test.ts`（对照固定 fixture 的 schema 形状单元测试，不跑真实 pi 解析 `models.json`） |
| `packages/shared/src/skill.ts` | Skill 名称/描述校验规则镜像自 pi 0.84.4 `core/skills.ts` 的 `validateName`/`validateDescription`（1–64 位小写字母数字+单连字符；描述 ≤1024 字符） | pi 改校验规则，本仓库这边校验通过的 Skill 挂载到真实 pi 容器时可能被拒绝（或反过来，pi 放宽了但这边仍然拒绝合法输入） | `skill.test.ts`（镜像规则的单元测试，不对照 pi 自己的校验器跑） |
| 文档中明确写 `0.84.4` 的位置 | `docs/development-tasks.md`、`README.md`、`docs/runbooks/host-agent-host.md`、`docs/runbooks/host-worker-runtime.md`、`docs/design-review-2026-09-01.md`、`docs/graph-ai-middle-platform-design.md`、`docs/reference-projects-and-oss-landscape.md` | 纯文档漂移，不影响运行时，但升级后不改会误导下一个读者 | 无自动校验；升级步骤里作为一步手工 `grep` |

## 3. 单一版本源

`pi.version`（仓库根目录，纯文本，一行版本号）是**唯一**手改的地方：

- `deploy/worker-runtime/Dockerfile`：`runtime` 阶段 `COPY pi.version /tmp/pi.version`，
  `RUN PI_VERSION="$(cat /tmp/pi.version)" && npm install -g --ignore-scripts
  "@earendil-works/pi-coding-agent@${PI_VERSION}"`——直接读文件内容，机制上不可能跟 `pi.version`
  漂移。
- `packages/platform-extension/package.json` 的 `dependencies["@earendil-works/pi-coding-
  agent"]` 与 `devDependencies["@earendil-works/pi-ai"]`：**没有**做成自动读取——pnpm/npm 的
  package.json 字段只接受字面量版本号，没有"从另一个文件读值"的语法，人为造一个 `postinstall`
  脚本去改写 package.json 会把版本号和 `pnpm-lock.yaml` 的一致性绑到一个额外的构建步骤上，
  超出"机械化"的范围，也可能影响 `--frozen-lockfile` 的可重复性。这两处仍是独立字面量，但由
  `scripts/check-pi-version-consistency.sh` 保证三处（`pi.version`、两个 package.json 字段、
  Dockerfile 是否还在读 `pi.version`）永远一致——`pnpm ci:guards` 与 CI 的 `guards` job
  都跑它，任何一处漏改都会直接挂红，不会静默漂移。

这也是为什么没有用派发文字建议的"Dockerfile ARG"方案：ARG 的默认值仍然是硬编码字面量（除非
再改 `docker-compose.yml` 的 build args，把版本号从 shell 传进去），并没有真正减少一份拷贝，
反而多了一条"构建调用方式必须同步改"的隐性契约，且 Dockerfile 头部注释已经明确"本机无 Docker，
构建未在本机验证"——改变构建调用方式需要主机重新验收，超出本任务范围。`COPY` + `cat`
不需要改任何构建调用（`docker compose build worker-runtime` 还是原来那条命令），风险更小。

## 4. 升级步骤

1. 过一遍上面的耦合面清单，逐条确认新版本是否动了对应的 flag/事件名/schema/校验规则——pi 若发
   CHANGELOG，优先对照 CHANGELOG；没有的话，去 pi 的参考项目源码里核对本清单"用到的 pi API"一列
   列出的具体文件路径（Dockerfile/`bridge.ts` 头部注释里的路径就是上一次这么做时用的坐标）。
2. 改 `pi.version` 一个文件（唯一手改点），跟着改
   `packages/platform-extension/package.json` 的两个版本号字段（`check-pi-version-
   consistency.sh` 会在下一步提醒你，如果忘了）。
3. `pnpm install`（更新 lockfile）→ `pnpm ci:guards`（含新版本一致性校验）→
   `pnpm -r typecheck`（pi 的 TS 类型变化会在这里先炸，早于运行时）。
4. 跑第 5 节"兼容性测试清单"。`entry.sdk.test.ts`/`worker.sdk.test.ts` 失败时，先看是不是清单里
   "已知的坑"那一条（`bindExtensions`）；确认不是的话，再对照耦合面清单逐条排查具体是哪个 hook/
   API 变了。`bridge.test.ts`/`host.test.ts` 的 fixture 是手写的——即使它们全绿，也不代表 pi 真实
   RPC 输出没变，只代表这两个文件对*假设的*输出格式仍然处理正确；这两个测试没有对应的
   `*.sdk.test.ts` 去跑真实 pi 进程验证 RPC 输出格式本身，是本清单记录在案的已知缺口（S3.10 之后
   如果要补，应该在 `packages/agent-host` 下加一个真正启动 pi RPC 子进程、把输出灌进
   `bridge.ts` 的集成测试，而不是继续扩大手写 fixture）。
5. `deploy/worker-runtime/Dockerfile`/`entrypoint.sh` 那两行"人工"标注的行——本机没有 Docker，
   必须在目标主机走一遍 `docs/runbooks/host-worker-runtime.md` 的验收步骤（`docker run --rm
   nexttime-ai-worker-runtime pi --version` 确认版本号、容器内工具可用性、`models.json`
   路径仍然正确）。这是升级流程里唯一不能在 CI 里做完的一步。
6. `grep -rn "0\.84\.4"` 全仓库，把上表"文档中明确写 0.84.4 的位置"一列列出的文件都改掉（含
   本文件自己第 1 节）。
7. 提 PR，附上：本清单里哪些行验证过、哪些行因为环境限制跳过（比如没有目标主机访问权限时，
   第 5 步只能标记"未验证，需主机验收"而不是假装通过）。

## 5. 兼容性测试清单

升级 PR 至少要跑这些（`pnpm --filter @nexttime/platform-extension test` 覆盖前六个）：

- `packages/platform-extension/src/index.test.ts` —— 扩展加载与模式分发
- `packages/platform-extension/src/kernel-client.test.ts` —— 与 pi 无关的对照组（不应该受升级影响，若这个也炸说明改动范围出了这个包）
- `packages/platform-extension/src/modes/entry.test.ts`、`modes/worker.test.ts` —— 假 `ExtensionAPI` 桩，快、但不接触真实 pi
- `packages/platform-extension/src/entry.sdk.test.ts`、`worker.sdk.test.ts` —— **真实 pi SDK**，本清单里权重最高的两个文件，也是 `.github/workflows/pi-drift.yml` 每晚对 `@latest` 跑的对象
- `packages/agent-host/src/bridge.test.ts`、`host.test.ts` —— RPC 事件/命令映射的 fixture 测试（见第 4 节第 4 条的已知缺口说明）
- `packages/worker-supervisor/src/spawn-spec.test.ts`、`task-spawn-spec.test.ts` —— 容器 env/挂载契约
- `packages/llm-proxy/src/gen-models-json.test.ts` —— `models.json` schema 形状
- `packages/shared/src/skill.test.ts` —— Skill 名称/描述校验规则
- 全仓库门禁：`pnpm -r lint`、`pnpm -r typecheck`、`pnpm -r build`、`pnpm depcruise`、`pnpm ci:guards`
- 人工（见第 4 节第 5 条）：目标主机上 `docker run --rm nexttime-ai-worker-runtime pi --version`
  与 `docs/runbooks/host-worker-runtime.md` 的验收步骤

## 6. 漂移检测（自动化）

`.github/workflows/pi-drift.yml`：每晚（UTC 03:17）+ 手动 `workflow_dispatch`，在一次性 checkout
里把 `@earendil-works/pi-coding-agent`/`@earendil-works/pi-ai` 覆盖成 `@latest`（**只在这个
runner 自己的工作目录里改，从不 `git commit`/`git push`——`pi.version` 与仓库里的 package.json
版本号完全不受影响**），跑 `packages/platform-extension` 的完整测试套件（含上面两个 `*.sdk.
test.ts`），打印 pinned/latest 版本 diff 到 job summary。失败时开/更新**同一个**带
`pi-drift` label 的 issue（标题 `pi drift: <latest 版本号> breaks <n> tests`；用 `gh issue
list --label pi-drift` 查是否已有未关闭的，有就编辑标题/正文+追加评论，没有才新建）；转绿时自动
关闭该 issue。这个 workflow **没有** `pull_request`/`push` 触发器，永远不会出现在任何 PR 的
required checks 里，`ci.yml` 完全不受影响。

`.github/dependabot.yml`：`packages/platform-extension` 下的 npm 依赖按周检查，
`@earendil-works/*` 分组为 `pi`（两个包一次 PR，避免两个包各自升级到不兼容的组合），整个目录下的
PR 都打 `pi-upgrade` label（这个目录依赖很少，其余几个——`typebox`/`zod`/`zod-to-json-schema`
——一起打同一个 label 是可接受的，没有单独设 `ignore` 排除它们）；`deploy/worker-runtime`
下的 Docker 基础镜像（`node:24-bookworm-slim`，按 tag 锁定）单独一条按周检查。两者都只是开 PR，
不自动合并——仍然要走上面第 4 节的升级步骤和第 5 节的测试清单。

## 7. 回滚

pi 本身没有运行时"回滚"的概念（它不是一个常驻服务，是每次 spawn 容器时装进镜像的 CLI）——回滚
单位是**镜像 tag**：

1. `deploy/worker-runtime` 镜像每次构建都应该打上包含 `pi.version` 值的 tag（例如
   `nexttime-ai-worker-runtime:pi-0.84.4`），而不只是浮动的 `nexttime-ai-worker-runtime:latest`
   ——本仓库当前 `docker-compose.yml` 的 `worker-runtime` 服务只打了不带版本号的
   `image: nexttime-ai-worker-runtime`（build-only, 见该服务自己的注释），升级 PR 落地时应该
   在主机验收步骤里手动把新镜像也打一个带版本号的 tag 再切换 `worker-supervisor` 的
   `WORKER_IMAGE` 引用，保留旧 tag 至少一个发布周期，坏了直接把 `WORKER_IMAGE`
   改回旧 tag、重启 `worker-supervisor`——常驻入口容器与一次性 Worker 容器都是下次 spawn 才
   用新镜像，不需要重建正在跑的容器。
2. 代码侧回滚：`git revert` 升级 PR（`pi.version`、两个 package.json 字段、`pnpm-lock.yaml`
   一起回退），重新构建镜像。
3. `.github/workflows/pi-drift.yml`/`.github/dependabot.yml` 本身不涉及运行时，不需要回滚
   流程——它们只在还没合并升级 PR 时持续提醒"什么时候能升"。
