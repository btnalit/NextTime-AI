# Runbook：pi-upgrade（pi 版本升级契约）

对应任务：development-tasks.md § S3.10（"升级 pi 版本（契约测试流程）"，本手册即该条交付物）与
§ S3.15（"pi 升级契约与漂移检测"，本手册连同 §6/§7 描述的自动化是该条的交付物）。回答的问题是
"pi agent 解耦，可以跟随主线更新吗"——本手册把答案变成一份可执行流程：耦合面清单、单一版本源、
升级步骤、兼容性测试清单、漂移检测、回滚。

前置阅读：根目录 `pi.version`；`packages/platform-extension/src/{index,modes/entry,
modes/worker}.ts`；`deploy/worker-runtime/{Dockerfile,entrypoint.sh}`；
`packages/agent-host/src/bridge.ts`。

## 1. 现状：pi 是怎么被锁住的

`@earendil-works/pi-coding-agent`（以及配套的 `@earendil-works/pi-ai`）当前锁定 **0.87.1**（2026-09-26
从 0.84.4 升上来，逐行核对记录见 2.1），精确版本号（不是 `^0.87.1`），原因见
`docs/development-tasks.md` §0.3。这不是随意的保守——pi 没有
稳定的公开 ABI 承诺，本仓库依赖它的 CLI flag 名字、RPC 事件词表、扩展 hook 名字、`models.json`
schema、Agent Skills 校验规则等一整套*未版本化的行为契约*，其中一部分是读 pi 自己的源码验证出来
的（Dockerfile 与 `bridge.ts` 的头部注释逐条列了验证过的源文件路径），不是读它的公开文档猜的。

"冻结"和"锁定"是两回事：锁定一个精确版本没问题，冻结是指*没有人知道升级要改哪些地方、升级坏了怎么
知道、升级失败了怎么回退*。S3.10 修的是后者，不改前者——那个 PR 不升级 pi，只交付契约、检测、
自动化；第一次按本手册走完的升级是 0.84.4 → 0.87.1。

## 2. 耦合面清单

下表是本仓库里每一处依赖 pi *具体行为*（而不只是把它当一个黑盒子进程跑）的位置。"覆盖它的测试/
校验"一栏空白或标注"人工"的行，是升级时必须手工走一遍主机验收的地方——这正是本清单存在的意义：
升级前先把这张表过一遍，而不是等生产环境炸了才发现某个 flag 改名了。

| 文件/位置 | 用到的 pi API / flag / 格式 | 变更后果 | 覆盖它的测试/校验 |
|---|---|---|---|
| `packages/platform-extension/package.json` | `dependencies["@earendil-works/pi-coding-agent"]`、`devDependencies["@earendil-works/pi-ai"]` 精确版本号 | 两者不同步会导致类型定义（编译期）与运行时安装的版本（容器内）不一致 | `scripts/check-pi-version-consistency.sh`（`pnpm ci:guards`） |
| `packages/platform-extension/src/index.ts` | 默认导出签名 `(pi: ExtensionAPI) => void`（pi 扩展加载约定：`pi -e <path>` 对每个扩展模块调用一次其默认导出） | pi 改扩展加载约定（比如改成要求具名导出）会让整个扩展在容器启动时直接报错退出 | `index.test.ts`（假 `ExtensionAPI` 桩）+ `entry.sdk.test.ts`/`worker.sdk.test.ts`（真实 pi SDK 通过 `additionalExtensionPaths` 加载真实模块） |
| `packages/platform-extension/src/modes/{entry,worker}.ts` | `ExtensionAPI.registerTool`；`pi.on(event, handler)` 的事件名 `session_start`/`input`/`context`/`agent_start`/`agent_end`/`agent_settled` 与各自 payload 形状；`ToolDefinition.execute()` 的返回契约（`{content, details, terminate?}`，抛出即映射为 `isError:true`）；`pi.appendEntry`；`pi.sendUserMessage`；`ExtensionContext.hasUI`/`ui.notify`/`sessionManager.getSessionFile` | 任一 hook 改名/去掉，或 `execute()` 返回契约变化，entry/worker 两种模式的工具注册与生命周期整体失效——这是耦合面里*最大*的一块 | `modes/entry.test.ts`/`modes/worker.test.ts`（假桩）+ `entry.sdk.test.ts`/`worker.sdk.test.ts`（真实 SDK，唯一能证明 pi 真的把 `execute()` 的 throw 映射成 `isError:true`、`context` 消息真的不落盘的测试） |
| `packages/platform-extension/src/tool-schema.ts` | 假设 pi 的 `ToolDefinition.parameters`（typebox `TSchema`）在运行时只是被当 JSON-Schema 形状的普通对象读（`.type`/`.properties`/`.required`），从不针对 typebox 的 `Kind` symbol 做校验；0.86.0 起注册时额外要求 `parameters` 是非 null、非数组的对象（`core/extensions/loader.js` `registerTool`，否则抛错）——`toToolParameters`/`gateToolParameters` 恒产出 object schema | pi 若开始严格校验 typebox schema，每一个用 `zod-to-json-schema` 转换出来、cast 成 `TSchema` 的工具（`report_result` 等）会在注册时报错 | 间接由 `entry.sdk.test.ts`/`worker.sdk.test.ts` 覆盖（真实工具注册+调用会触发真实校验路径） |
| `packages/platform-extension/src/{entry,worker}.sdk.test.ts` | 直接 import pi SDK 面：`createAgentSession`、`DefaultResourceLoader`、`ModelRuntime`（含 `.create`/`.registerProvider`）、`SessionManager`、`SettingsManager`、`additionalExtensionPaths`/`noExtensions` 选项、`session.subscribe`/`.prompt`/`.messages`/`.agent.state.tools`/`.dispose`、`AgentSessionEvent`（`tool_execution_end` 的 `isError`/`result`/`toolName`）；`@earendil-works/pi-ai` 的 `InMemoryCredentialStore`、`Context` 类型、`pi-ai/compat` 的 `registerFauxProvider`/`fauxAssistantMessage`/`fauxToolCall` | 这两个文件本身**就是**"pi 有没有变"的探针——任何一个具名导出被改名/删除，这两个测试直接编译或运行失败，不会静默通过 | 就是它们自己（`pnpm --filter @nexttime/platform-extension test`，也是 `pi-drift.yml` 每晚对 `@latest` 跑的那两个文件） |
| `worker.sdk.test.ts` 里记录的一个真实坑 | `createAgentSession()` 本身不触发 pi 的 `session_start` 事件——那是 `AgentSession.bindExtensions(bindings)` 内部才 `emit` 的；worker 模式的自驱动机制（`pi.sendUserMessage` 在 `session_start` 里调用）必须显式 `await session.bindExtensions({mode:'rpc'})` 才会真的跑起来（`docs/development-tasks.md` 行~691 已记录） | pi 若改变 `bindExtensions` 的签名或触发时机，worker 模式在真实 RPC 进程里可能仍然工作（因为真实 CLI 会调 `bindExtensions`），但这个测试可能测不出问题——升级时需要手工确认这条注释是否还成立 | `worker.sdk.test.ts`（部分——见左侧说明，测试本身依赖这个行为，不是独立校验它） |
| `deploy/worker-runtime/Dockerfile` | `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@<pi.version>`；CLI flags `--mode rpc`/`--session-dir <dir>`/`-e <path>`/`--system-prompt <path-or-text>`（**没有** `--system-prompt-file`，靠 `resolvePromptInput` 在路径存在时按文件内容读取）；`getAgentDir()`/`PI_CODING_AGENT_DIR`/`getModelsPath()` = `<agentDir>/models.json`；内置工具集 bash/edit/find/grep/ls/powershell/read/write，没传任何 `--tools`/`--no-tools`/`--no-builtin-tools`/`--exclude-tools` 时 pi 的默认*激活*集是 `read`/`bash`/`edit`/`write`（`core/sdk.js` `defaultActiveToolNames`，0.84.4 与 0.87.1 相同；find/grep/ls 经 bash 使用——本表此前写"全开"不准确，0.87.1 核对时更正） | pi 改任一 flag 名、去掉 `--system-prompt` 的"路径存在则读文件"回退、改 agent-dir 解析、改默认工具集——容器启动失败或工具集意外变化 | **人工**：`docs/runbooks/host-worker-runtime.md`（`docker run --rm nexttime-ai-worker-runtime pi --version`、容器内工具可用性）；无自动化测试（需要真实 Docker，仅主机验收覆盖） |
| `deploy/worker-runtime/entrypoint.sh` | 同上 CLI flags；额外假设 pi 在 RPC 模式下把事件写到 stdout、别的诊断信息不混进同一个流（否则 `container-io.ts` 的 JSONL 逐行解析会读到非 JSON 行） | flag 改名同上；stdout 混入非 JSONL 内容会让 `agent-host` 的行解析静默丢弃（`JSON.parse` 失败即 `return`，不报错） | **人工**：同上；`scripts/*.sh` 的 shell 语法/权限由 `pnpm ci:guards` 校验，但不校验 pi 自身行为 |
| `packages/agent-host/src/bridge.ts` | 对照 pi 0.84.4 源码验证、0.87.1 用真实 RPC 进程复核过的 RPC 事件词表：`message_update`（`assistantMessageEvent.type==='text_delta'`）、`tool_execution_start`/`tool_execution_end`（`toolCallId`/`toolName`/`args`/`result`）、`message_end`（`message.role==='assistant'`，`content` 数组的 `text` 段）、`agent_settled`；RPC 命令 `{"type":"prompt","id":<turnId>,"message":...}` 及响应 `{"type":"response","command":"prompt","id":...,"success":bool,"error"?}`；`{"type":"abort"}` | pi 改事件名/字段——`translatePiEvent` 把无法识别的类型**静默**降级为 `{kind:'none'}`（不抛错），后果是对话在平台侧看起来"卡住不动"而不是报错，属于最隐蔽的一类耦合失效 | `bridge.test.ts`（针对字面量 JSON fixture 的单元测试，fixture 是手写的、按 pi 0.84.4 文档/源码构造的，**不是**跑真实 pi 进程产出的——升级时这些 fixture 本身也需要对照新版本复核，见下节步骤 4；0.87.1 已对照真实 `pi --mode rpc` 捕获复核，见 2.1） |
| `packages/agent-host/src/host.ts` | 同一份 prompt/response 关联契约（`record.type==='response' && record.command==='prompt' && record.id===turn.turnId`）；`extension_error` 事件形状（`extensionPath`/`event`/`error`） | 同上，关联失败会导致 `turnAccepted`/`turnRejected` 永远等不到，Turn 挂起直到超时 | `host.test.ts`（同样基于手写 fixture，非真实 pi 进程） |
| `packages/agent-host/src/container-io.ts` | 假设 pi 的 RPC stdout 是严格 JSONL：LF 分隔、每行一个 JSON 对象、不会因为遇到 U+2028/U+2029 而拆行（`docs/rpc.md` framing 契约，本模块特意不用 `node:readline` 就是因为它不满足这条） | pi 若改变 framing（比如 stdout 混入非 JSONL 诊断行），手写的 buffer+`indexOf('\n')` 分帧逻辑可能拆出坏行，静默被 `JSON.parse` 失败吞掉 | 无专门针对 pi framing 变化的测试；仅有通用的分行单元覆盖 |
| `packages/worker-supervisor/src/{spawn-spec,task-spawn-spec}.ts` | 入口/Worker 容器 env 契约：`KERNEL_URL`/`KERNEL_LLM_URL`/`CAPABILITY_HANDLE`/`WORKSPACE_ID`/`NEXTTIME_MODE`/`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`（+小写镜像）；常驻模式额外要 `PI_CODING_AGENT_DIR`/`HOME`；`models.json` 只读挂载到 pi 默认 agent dir 下 | pi 改 env var 名字（比如 `PI_CODING_AGENT_DIR`）或 `getAgentDir()`/`getModelsPath()` 解析逻辑，会让容器读不到 `models.json`，模型路由整体失效 | `spawn-spec.test.ts`/`task-spawn-spec.test.ts`（纯 builder 单元测试，断言 env 数组内容，不跑真实 pi 进程） |
| `packages/llm-proxy/src/gen-models-json.ts` | 生成 pi 的 `models.json`，对照 pi 0.84.4（0.87.1 复核未变）的 `ModelsConfigSchema`/`ProviderConfigSchema`：`{providers:{<id>:{baseUrl,apiKey,api,models:[{id,cost?}]}}}`；`api` 取值 `openai-completions`/`openai-responses`/`anthropic-messages`；`apiKey` 的 `$VAR`/`${VAR}` 模板由 pi 自己的 `resolveConfigValue` 在容器内解析 | pi 改这个 schema（新增必填字段、改 `api` 枚举值、去掉 `$VAR` 模板支持）会让每个 agent 容器拿到内核，但模型请求全部失败 | `gen-models-json.test.ts`（对照固定 fixture 的 schema 形状单元测试，不跑真实 pi 解析 `models.json`） |
| `packages/shared/src/skill.ts` | Skill 名称/描述校验规则镜像自 pi 0.84.4（0.87.1 复核未变）`core/skills.ts` 的 `validateName`/`validateDescription`（1–64 位小写字母数字+单连字符；描述 ≤1024 字符） | pi 改校验规则，本仓库这边校验通过的 Skill 挂载到真实 pi 容器时可能被拒绝（或反过来，pi 放宽了但这边仍然拒绝合法输入） | `skill.test.ts`（镜像规则的单元测试，不对照 pi 自己的校验器跑） |
| `deploy/accept/driver.mjs` `transcript-stats`（0.87.1 核对时补入本表） | 直接读 Worker 的 pi 会话 JSONL：`type:"message"` 条目，`message.role` 为 `assistant`（`content[]` 里的 `toolCall` 块、`model`）或 `toolResult`（`toolCallId`/`isError`） | pi 改会话条目格式，验收脚本的 `TOOL_*`/`MODEL` 统计会静默归零（验收误判，不影响运行时） | 无自动测试；升级时拿同一轮真实运行的两版会话文件各跑一次对比 |
| 文档中写明当前 pi 版本的位置 | `docs/development-tasks.md` §0.3 与风险表、`docs/runbooks/host-agent-host.md`、`docs/runbooks/host-worker-runtime.md`、`docs/graph-ai-middle-platform-design.md`、本手册第 1 节；`deploy/worker-runtime/{Dockerfile,entrypoint.sh}` 与 `bridge.ts` 的头部核对注释（`README.md` 已不写具体版本；`docs/design-review-2026-09-01.md`、`docs/reference-projects-and-oss-landscape.md`、各任务"实现说明"里的 0.84.4 是历史记录，不改） | 纯文档漂移，不影响运行时，但升级后不改会误导下一个读者 | 无自动校验；升级步骤里作为一步手工 `grep` |

### 2.1 0.84.4 → 0.87.1 核对结果（2026-09-26）

核对方法：把 0.84.4 与 0.87.1 两个 npm 包装进仓库外的临时目录，逐文件 diff 对应的 `dist/*.js`/
`*.d.ts`/`docs/`，并跑 `pi --help`、`pi --version`；另外用 `deploy/fake-llm` 做上游、按 entrypoint.sh
的 flag 真实启动两个版本的 `pi --mode rpc`（不带扩展、带 `-e` 真实平台扩展 entry 模式、worker 模式各
一轮），把捕获的 stdout 喂给 `bridge.ts` 的 `translatePiEvent` 对比。结论取值：**未变**（行为与
本仓库依赖的形状一致）/ **已适配**（本 PR 有改动）/ **需主机验收**（本机无 Docker，镜像内行为只能
在主机上确认）。

| 行 | 结论 | 证据 |
|---|---|---|
| `platform-extension/package.json` | 已适配 | 两个字段改为 `0.87.1`；`check-pi-version-consistency.sh` 通过 |
| `index.ts` 默认导出 | 未变 | `loader.js` 仍是 `jiti.import(path, {default: true})` + `typeof === 'function'`；SDK 测试与真实 CLI `-e` 均加载成功 |
| `modes/{entry,worker}.ts` | 未变 | 用到的六个事件仍在 `ExtensionEvent`；`pi.on()` 改为返回退订函数（兼容）；0.87 `context` 处理器不再看到 system 消息——本仓库只在末尾追加 `custom` 消息，不受影响（真实 CLI 跑完 session 文件里无 `nexttime-*-context`）；0.87 `agent_settled` 中请求的新 run 延后执行——本仓库不在该钩子里发 prompt；`terminate` 仍由 `agent-loop.js` 处理；0.86 `details` 限定 JSON 兼容值——`typecheck` 通过 |
| `tool-schema.ts` | 未变（新增校验已满足） | 0.86 注册时要求 object 形状 `parameters`，本仓库两个转换函数恒产出 object；strict-prefer 采样只作用于内置工具；0.87 对未声明支持的 OpenAI 兼容端点不再发 strict schema（对 llm-proxy 是放宽） |
| `{entry,worker,interactive}.sdk.test.ts` | 未变 | 所有具名导出仍在；`pnpm --filter @nexttime/platform-extension test` 102/102 通过（与 `pi-drift.yml` 09-24/25/26 对 `@latest`=0.87.1 的结果一致） |
| `bindExtensions` 的坑 | 未变 | `bindExtensions` 仍在内部 `emit(session_start)`，`rpc-mode.js` 仍调用它；真实 CLI worker 模式自驱动一轮后 `exit 0` |
| `Dockerfile` | 未变；需主机验收 | `pi --help` 两版 diff 只多一行 `META_API_KEY`；`resolvePromptInput`、`config.js` 的 agent-dir/`models.json` 解析、`containerization.md` 配方逐字相同；0.86 去掉了原生 clipboard 依赖，无 install script；`PI_OFFLINE` 仍关掉版本检查与 RPC 模式的目录刷新。默认激活工具集表述已更正（见上表） |
| `entrypoint.sh` | 未变；需主机验收 | flag 同上；0.87.1 对缺失/非法 `--mode` 报错退出（`rpc` 合法）；0.87.1 `docs/rpc.md` 明文"stdout 只放协议记录，诊断走 stderr"，真实运行 stdout 0 行非 JSON、扩展的 `console.*` 输出都在 stderr |
| `bridge.ts` | 未变（新记录已覆盖、fixture 已补） | 真实 RPC 流对比：0.87.1 唯一新增是首轮开头一对 `message_start`/`message_end`（`message.role === 'system'`，0.86 起系统提示进 transcript），非 assistant 角色，本来就被丢弃；两版经 `translatePiEvent` 输出逐行相同；RPC 流上的 `turn_end` 仍是 `{message, toolResults}`（0.87 扩展的是扩展钩子的 `TurnEndEvent`，不是这条流）；`bridge.test.ts` 加了 system 消息用例 |
| `host.ts` | 未变 | `rpc-mode.js` 只改了 steer/follow_up 的 `source` 标记；`prompt`/`switch_session`/`abort` 响应与 `extension_error` 形状不变，真实运行三种响应都回显 `id` |
| `container-io.ts` | 未变 | `dist/modes/rpc/jsonl.js` 逐字相同 |
| `worker-supervisor` spawn spec | 未变 | `PI_CODING_AGENT_DIR`、`getAgentDir`/`getModelsPath`、`<agentDir>/skills` 不变 |
| `gen-models-json.ts` | 未变 | 本仓库写出的字段不变，`$VAR` 解析文件逐字相同；新增字段均为可选（`inputLimits`/`promptCache`/新 `compat` 键）；不写 `promptCache` 让 0.86 的 prompt 缓存保温（默认 `streaming`）对平台模型保持不触发；真实运行不传 `--model` 时 pi 从 `models.json` 选中了模型 |
| `skill.ts` | 未变 | `validateName`/`validateDescription` 与 64/1024 上限逐字相同 |
| `driver.mjs` `transcript-stats` | 未变 | 同一轮真实运行的 0.84.4/0.87.1 会话文件输出逐字相同；0.87.1 多出的 `role: system` 消息条目被跳过 |
| 文档 | 已适配 | 见上表最后一行 |

0.85–0.87 里本仓库不依赖、但值得知道的变化：pi 会话 JSONL 里多了一条 `role: system` 的消息条目
（内核只把 `sessionJsonlPath` 记成 Source URI，不解析内容）；新增的 `/bug` 上报与崩溃日志只在交互
模式生效（容器用的是 RPC 模式），遥测/provider attribution 代码与 0.84.4 逐字相同；未传 `--model`
时的初始模型选择逻辑（`findInitialModel`）逐字相同，只是"已知 provider 的首选默认模型"表改了
`radius`/`xai` 两项、加了 `meta`——只有平台 provider 恰好叫这几个名字且同时列出新旧默认 id 时，
初始模型才会变。

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
6. `grep -rn "<旧版本号>"` 全仓库（排除 `CHANGELOG.md` 与 `pnpm-lock.yaml`），把上表"文档中写明
   当前 pi 版本的位置"一行列出的文件都改掉（含本文件自己第 1 节），并在第 2 节补一张"旧 → 新核对
   结果"表（格式见 2.1）；历史记录与测试数据里的旧版本号不改。
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

**与控制台"运行层"页的 pi 漂移卡片是两回事（S8 leftover 59）**。本节上面说的"漂移"是"pinned
`pi.version` vs npm 上的 `@latest`"（升级值不值得做）；控制台运行层页的"pi 版本漂移"卡片问的是另一
件事——"主机当前跑的 worker-runtime 镜像，是不是拿最新的 `pi.version` 构建的"（有没有忘记在改
`pi.version` 之后重新构建/切换镜像），由内核 `pi_drift` 能力读取 `PI_DRIFT_FILE`（缺省
`/data/config/pi-drift.json`，形状 `{"pinnedPiVersion": "...", "checkedAt": "<ISO>"}`）与已部署镜像
自带的 `ai.nexttime.pi-version` label 比较得出。

`pi-drift.yml` 现在额外把这份 JSON（内容就是触发这次 run 的那个提交上 `pi.version` 的值，与
上面 pi@latest 测试是否通过无关）写成一个工作流 artifact（`pi-drift`，保留 14 天）——但**没有任何
主机自动去拉取它**（本仓库不给主机引入新的、从 GitHub 主动出网取产物的基础设施，见
`docs/runbooks/backup-restore.md` 同类"不为了单个 P3 需求加新基础设施"的取舍）。想让控制台的这张
卡片显示真实状态而不是"由 CI 夜间检测，见仓库 pi-drift 相关内容，见本节"，运维手动做一次：

```bash
# 在能访问 GitHub 的机器上（不必是目标主机本身）：
gh run list --repo <owner>/<repo> --workflow pi-drift.yml --limit 1
gh run download <run-id> --repo <owner>/<repo> --name pi-drift -D /tmp/pi-drift

# 把产物放到目标主机的 ${NEXTTIME_DATA}/config/pi-drift.json（scp / 手动拷贝均可）：
scp /tmp/pi-drift/pi-drift.json <目标主机>:${NEXTTIME_DATA}/config/pi-drift.json
```

不是发版流程的强制步骤——运行层页在没有这份文件时如实显示"由 CI 夜间检测，见仓库 pi-drift 相关
内容，见本手册 §6"而不是裸的"未知"，链接回本节；放了这份文件之后，`pi_drift` 才会给出
`consistent`/`drifted` 的真实判断（而不是永远 `unknown`）。文件不会被自动清理，下次想刷新按上面
两条命令重新放一份（`checkedAt` 一起更新）即可，主机侧没有过期机制。

**依赖更新**：pi（`@earendil-works/*`，`packages/platform-extension` 下那两个包）不接受任何 bot 版本更新——
2026-09-25 起仓库不再用 Renovate，也没有 Dependabot 版本更新配置（见 `docs/runbooks/automation.md`
"依赖更新怎么做"）；万一 Dependabot 安全更新碰到这两个包，`.github/workflows/auto-merge.yml` 会打
`needs-review` 标签、不自动合并——仍然要走上面第 4 节的升级步骤和第 5 节的测试清单。`deploy/worker-runtime`
的 Docker 基础镜像（`node:24-bookworm-slim`）锁定在 24.x，升级时手动改。

## 7. 回滚

pi 本身没有运行时"回滚"的概念（它不是一个常驻服务，是每次 spawn 容器时装进镜像的 CLI）——回滚
单位是**镜像 tag**：

1. `deploy/worker-runtime` 镜像每次构建都应该打上包含 `pi.version` 值的 tag（例如
   `nexttime-ai-worker-runtime:pi-0.87.1`），而不只是浮动的 `nexttime-ai-worker-runtime:latest`
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
