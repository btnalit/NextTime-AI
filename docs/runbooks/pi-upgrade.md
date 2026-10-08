# Runbook：pi-upgrade（pi 版本升级契约）

对应任务：development-tasks.md § S3.10（"升级 pi 版本（契约测试流程）"，本手册即该条交付物）与
§ S3.15（"pi 升级契约与漂移检测"，本手册连同 §6/§7 描述的自动化是该条的交付物）。回答的问题是
"pi agent 解耦，可以跟随主线更新吗"——本手册把答案变成一份可执行流程：耦合面清单、单一版本源、
升级步骤、兼容性测试清单、漂移检测、回滚。

前置阅读：根目录 `pi.version`；`packages/platform-extension/src/{index,modes/entry,
modes/worker}.ts`；`deploy/worker-runtime/{Dockerfile,entrypoint.sh}`；
`packages/agent-host/src/bridge.ts`。

## 1. 现状：pi 是怎么被锁住的

`@earendil-works/pi-coding-agent`（以及配套的 `@earendil-works/pi-ai`）当前锁定 **1.1.0**（2026-10-08
从 0.99.2 升上来，逐行核对记录见 2.5；之前 0.87.1 → 0.99.2 见 2.4、0.84.4 → 0.87.1 见 2.1），精确版本号（不是 `^0.99.2`），原因见
`docs/development-tasks.md` §0.3。这不是随意的保守——pi 没有
稳定的公开 ABI 承诺，本仓库依赖它的 CLI flag 名字、RPC 事件词表、扩展 hook 名字、`models.json`
schema、Agent Skills 校验规则等一整套*未版本化的行为契约*，其中一部分是读 pi 自己的源码验证出来
的（Dockerfile 与 `bridge.ts` 的头部注释逐条列了验证过的源文件路径），不是读它的公开文档猜的。

"冻结"和"锁定"是两回事：锁定一个精确版本没问题，冻结是指*没有人知道升级要改哪些地方、升级坏了怎么
知道、升级失败了怎么回退*。S3.10 修的是后者，不改前者——那个 PR 不升级 pi，只交付契约、检测、
自动化；按本手册走完的升级依次是 0.84.4 → 0.87.1、0.87.1 → 0.99.2、0.99.2 → 1.1.0。

## 2. 耦合面清单

下表是本仓库里每一处依赖 pi *具体行为*（而不只是把它当一个黑盒子进程跑）的位置。"覆盖它的测试/
校验"一栏空白或标注"人工"的行，是升级时必须手工走一遍主机验收的地方——这正是本清单存在的意义：
升级前先把这张表过一遍，而不是等生产环境炸了才发现某个 flag 改名了。

| 文件/位置 | 用到的 pi API / flag / 格式 | 变更后果 | 覆盖它的测试/校验 |
|---|---|---|---|
| `packages/platform-extension/package.json` | `dependencies["@earendil-works/pi-coding-agent"]`、`devDependencies["@earendil-works/pi-ai"]` 精确版本号 | 两者不同步会导致类型定义（编译期）与运行时安装的版本（容器内）不一致 | `scripts/check-pi-version-consistency.sh`（`pnpm ci:guards`） |
| `packages/platform-extension/src/index.ts` | 默认导出签名 `(pi: ExtensionAPI) => void`（pi 扩展加载约定：`pi -e <path>` 对每个扩展模块调用一次其默认导出） | pi 改扩展加载约定（比如改成要求具名导出）会让整个扩展在容器启动时直接报错退出 | `index.test.ts`（假 `ExtensionAPI` 桩）+ `entry.sdk.test.ts`/`worker.sdk.test.ts`（真实 pi SDK 通过 `additionalExtensionPaths` 加载真实模块） |
| `packages/platform-extension/src/modes/{entry,worker}.ts`、`modes/gate-tool-projection.ts` | `ExtensionAPI.registerTool`（含 `session_start` 之后的注册，见 2.3）；`getActiveTools`/`getAllTools`/`setActiveTools`（入口逐轮工具投射，2.3）；`pi.on(event, handler)` 的事件名 `session_start`/`input`/`before_agent_start`/`context`/`agent_start`/`agent_end`/`agent_settled` 与各自 payload 形状；`ToolDefinition.execute()` 的返回契约（`{content, details, terminate?}`，抛出即映射为 `isError:true`）；`pi.appendEntry`；`pi.sendUserMessage`；`ExtensionContext.hasUI`/`ui.notify`/`sessionManager.getSessionFile` | 任一 hook 改名/去掉，或 `execute()` 返回契约变化，entry/worker 两种模式的工具注册与生命周期整体失效——这是耦合面里*最大*的一块 | `modes/entry.test.ts`/`modes/worker.test.ts`（假桩）+ `entry.sdk.test.ts`/`worker.sdk.test.ts`（真实 SDK，唯一能证明 pi 真的把 `execute()` 的 throw 映射成 `isError:true`、`context` 消息真的不落盘的测试） |
| `packages/platform-extension/src/tool-schema.ts` | 假设 pi 的 `ToolDefinition.parameters`（typebox `TSchema`）在运行时只是被当 JSON-Schema 形状的普通对象读（`.type`/`.properties`/`.required`），从不针对 typebox 的 `Kind` symbol 做校验；0.86.0 起注册时额外要求 `parameters` 是非 null、非数组的对象（`core/extensions/loader.js` `registerTool`，否则抛错）——`toToolParameters`/`gateToolParameters` 恒产出 object schema | pi 若开始严格校验 typebox schema，每一个用 `zod-to-json-schema` 转换出来、cast 成 `TSchema` 的工具（`report_result` 等）会在注册时报错 | 间接由 `entry.sdk.test.ts`/`worker.sdk.test.ts` 覆盖（真实工具注册+调用会触发真实校验路径） |
| `packages/platform-extension/src/{entry,worker}.sdk.test.ts` | 直接 import pi SDK 面：`createAgentSession`、`DefaultResourceLoader`、`ModelRuntime`（含 `.create`/`.registerProvider`）、`SessionManager`、`SettingsManager`、`additionalExtensionPaths`/`noExtensions` 选项、`session.subscribe`/`.prompt`/`.messages`/`.agent.state.tools`/`.dispose`、`AgentSessionEvent`（`tool_execution_end` 的 `isError`/`result`/`toolName`）；`@earendil-works/pi-ai` 的 `InMemoryCredentialStore`、`Context` 类型、`pi-ai/compat` 的 `registerFauxProvider`/`fauxAssistantMessage`/`fauxToolCall` | 这两个文件本身**就是**"pi 有没有变"的探针——任何一个具名导出被改名/删除，这两个测试直接编译或运行失败，不会静默通过 | 就是它们自己（`pnpm --filter @nexttime/platform-extension test`，也是 `pi-drift.yml` 每晚对 `@latest` 跑的那两个文件） |
| `worker.sdk.test.ts` 里记录的一个真实坑 | `createAgentSession()` 本身不触发 pi 的 `session_start` 事件——那是 `AgentSession.bindExtensions(bindings)` 内部才 `emit` 的；worker 模式的自驱动机制（`pi.sendUserMessage` 在 `session_start` 里调用）必须显式 `await session.bindExtensions({mode:'rpc'})` 才会真的跑起来（`docs/development-tasks.md` 行~691 已记录） | pi 若改变 `bindExtensions` 的签名或触发时机，worker 模式在真实 RPC 进程里可能仍然工作（因为真实 CLI 会调 `bindExtensions`），但这个测试可能测不出问题——升级时需要手工确认这条注释是否还成立 | `worker.sdk.test.ts`（部分——见左侧说明，测试本身依赖这个行为，不是独立校验它） |
| `deploy/worker-runtime/Dockerfile` + `deploy/worker-runtime/pi/` | 安装：`deploy/worker-runtime/pi/{package.json,package-lock.json}` 经 `npm ci --omit=dev --ignore-scripts` 装进 `/opt/pi`，`/usr/local/bin/pi` 软链（1.1.0 起；此前是 `npm install -g`，靠 pi 自带的 shrinkwrap 钉传递依赖，1.0.1 去掉了 shrinkwrap，见 2.5）；CLI flags `--mode rpc`/`--session-dir <dir>`/`-e <path>`/`--system-prompt <path-or-text>`（**没有** `--system-prompt-file`，靠 `resolvePromptInput` 在路径存在时按文件内容读取）；`getAgentDir()`/`PI_CODING_AGENT_DIR`/`getModelsPath()` = `<agentDir>/models.json`；内置工具集 bash/edit/find/grep/ls/powershell/read/write，没传任何 `--tools`/`--no-tools`/`--no-builtin-tools`/`--exclude-tools` 时 pi 的默认*激活*集是 `read`/`bash`/`edit`/`write`（`core/sdk.js` `defaultActiveToolNames`，0.84.4 与 0.87.1 相同；0.99.2 移到 `core/settings-manager.js` `DEFAULT_TOOL_NAMES`，值不变；find/grep/ls 经 bash 使用——本表此前写"全开"不准确，0.87.1 核对时更正）；0.99 起 CLI 默认加载内置扩展 `codemode`/`tool-search`/`mcp`，它们注册的 `codemode`/`tool_search` 工具 `defaultActive: false`，不写进 `defaultTools` 就不激活（见 2.4） | pi 改任一 flag 名、去掉 `--system-prompt` 的"路径存在则读文件"回退、改 agent-dir 解析、改默认工具集——容器启动失败或工具集意外变化 | **人工**：`docs/runbooks/host-worker-runtime.md`（`docker run --rm nexttime-ai-worker-runtime pi --version`、容器内工具可用性）；无自动化测试（需要真实 Docker，仅主机验收覆盖） |
| `deploy/worker-runtime/entrypoint.sh` | 同上 CLI flags；额外假设 pi 在 RPC 模式下把事件写到 stdout、别的诊断信息不混进同一个流（否则 `container-io.ts` 的 JSONL 逐行解析会读到非 JSON 行） | flag 改名同上；stdout 混入非 JSONL 内容会让 `agent-host` 的行解析静默丢弃（`JSON.parse` 失败即 `return`，不报错） | **人工**：同上；`scripts/*.sh` 的 shell 语法/权限由 `pnpm ci:guards` 校验，但不校验 pi 自身行为 |
| `packages/agent-host/src/bridge.ts` | 对照 pi 0.84.4 源码验证、0.87.1 用真实 RPC 进程复核过的 RPC 事件词表：`message_update`（`assistantMessageEvent.type==='text_delta'`）、`tool_execution_start`/`tool_execution_end`（`toolCallId`/`toolName`/`args`/`result`）、`message_end`（`message.role==='assistant'`，`content` 数组的 `text` 段）、`agent_settled`；RPC 命令 `{"type":"prompt","id":<turnId>,"message":...}` 及响应 `{"type":"response","command":"prompt","id":...,"success":bool,"error"?}`；`{"type":"abort"}` | pi 改事件名/字段——`translatePiEvent` 把无法识别的类型**静默**降级为 `{kind:'none'}`（不抛错），后果是对话在平台侧看起来"卡住不动"而不是报错，属于最隐蔽的一类耦合失效 | `bridge.test.ts`（针对字面量 JSON fixture 的单元测试，fixture 是手写的、按 pi 0.84.4 文档/源码构造的，**不是**跑真实 pi 进程产出的——升级时这些 fixture 本身也需要对照新版本复核，见下节步骤 4；0.87.1 已对照真实 `pi --mode rpc` 捕获复核，见 2.1；0.99.2 同样复核，见 2.4；1.1.0 在开发机与镜像内复核，见 2.5） |
| `packages/agent-host/src/host.ts` | 同一份 prompt/response 关联契约（`record.type==='response' && record.command==='prompt' && record.id===turn.turnId`）；`extension_error` 事件形状（`extensionPath`/`event`/`error`） | 同上，关联失败会导致 `turnAccepted`/`turnRejected` 永远等不到，Turn 挂起直到超时 | `host.test.ts`（同样基于手写 fixture，非真实 pi 进程） |
| `packages/agent-host/src/container-io.ts` | 假设 pi 的 RPC stdout 是严格 JSONL：LF 分隔、每行一个 JSON 对象、不会因为遇到 U+2028/U+2029 而拆行（`docs/rpc.md` framing 契约，本模块特意不用 `node:readline` 就是因为它不满足这条） | pi 若改变 framing（比如 stdout 混入非 JSONL 诊断行），手写的 buffer+`indexOf('\n')` 分帧逻辑可能拆出坏行，静默被 `JSON.parse` 失败吞掉 | 无专门针对 pi framing 变化的测试；仅有通用的分行单元覆盖 |
| `packages/worker-supervisor/src/{spawn-spec,task-spawn-spec}.ts` | 入口/Worker 容器 env 契约：`KERNEL_URL`/`KERNEL_LLM_URL`/`CAPABILITY_HANDLE`/`WORKSPACE_ID`/`NEXTTIME_MODE`/`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`（+小写镜像）；常驻模式额外要 `PI_CODING_AGENT_DIR`/`HOME`；`models.json` 只读挂载到 pi 默认 agent dir 下 | pi 改 env var 名字（比如 `PI_CODING_AGENT_DIR`）或 `getAgentDir()`/`getModelsPath()` 解析逻辑，会让容器读不到 `models.json`，模型路由整体失效 | `spawn-spec.test.ts`/`task-spawn-spec.test.ts`（纯 builder 单元测试，断言 env 数组内容，不跑真实 pi 进程） |
| `packages/llm-proxy/src/gen-models-json.ts` | 生成 pi 的 `models.json`，对照 pi 0.84.4（0.87.1、0.99.2、1.1.0 复核未变）的 `ModelsConfigSchema`/`ProviderConfigSchema`：`{providers:{<id>:{baseUrl,apiKey,api,models:[{id,cost?}]}}}`；`api` 取值 `openai-completions`/`openai-responses`/`anthropic-messages`；`apiKey` 的 `$VAR`/`${VAR}` 模板由 pi 自己的 `resolveConfigValue` 在容器内解析 | pi 改这个 schema（新增必填字段、改 `api` 枚举值、去掉 `$VAR` 模板支持）会让每个 agent 容器拿到内核，但模型请求全部失败 | `gen-models-json.test.ts`（对照固定 fixture 的 schema 形状单元测试，不跑真实 pi 解析 `models.json`） |
| `packages/shared/src/skill.ts` | Skill 名称/描述校验规则镜像自 pi 0.84.4（0.87.1、0.99.2、1.1.0 复核未变）`core/skills.ts` 的 `validateName`/`validateDescription`（1–64 位小写字母数字+单连字符；描述 ≤1024 字符） | pi 改校验规则，本仓库这边校验通过的 Skill 挂载到真实 pi 容器时可能被拒绝（或反过来，pi 放宽了但这边仍然拒绝合法输入） | `skill.test.ts`（镜像规则的单元测试，不对照 pi 自己的校验器跑） |
| `deploy/accept/driver.mjs` `transcript-stats`（0.87.1 核对时补入本表） | 直接读 Worker 的 pi 会话 JSONL：`type:"message"` 条目，`message.role` 为 `assistant`（`content[]` 里的 `toolCall` 块、`model`）或 `toolResult`（`toolCallId`/`isError`） | pi 改会话条目格式，验收脚本的 `TOOL_*`/`MODEL` 统计会静默归零（验收误判，不影响运行时） | 无自动测试；升级时拿同一轮真实运行的两版会话文件各跑一次对比 |
| `packages/llm-proxy/src/outbound-policy.ts`（1.1.0 核对时补入本表） | `FORWARDED_ANTHROPIC_BETAS` = pi-ai `api/anthropic-messages.js` `getBetaFeatures` 可能发的值；`stripProviderServerTools` 认识的 pi 工具声明位置：顶层 `tools`、OpenAI 两种 api 消息 / input 项里的 `tools`、Anthropic 消息里 `tool_addition` 的 `tool_definition` | pi 新增一个 beta 值 → 该值被丢弃并记日志，用到它的请求在供应商侧失败；pi 新增一个工具声明位置而过滤器不认识 → 服务端工具绕过 R-30 / D-29 的剥离 | `outbound-policy.test.ts`（含真实 pi 1.1 请求形状的用例）；**人工**：升级时 diff `getBetaFeatures` 与各 api 的工具转换（2.5 的做法） |
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

### 2.2 内置工具全开（2026-09-27，STATUS 遗留 95）

维护者决定："pi agent 本身的权限其实不需要限制的，主要限制是访问其他系统"。落地在
`deploy/worker-runtime/entrypoint.sh`：启动前把 `defaultTools` =
`read,bash,edit,write,grep,find,ls` 合并写入 pi 全局设置 `<agentDir>/settings.json`（入口与
Worker 都是 `/workspace/.pi/agent`），日志行 `nexttime-selfcheck check=pi_default_tools`。

| 事实（0.87.1 已安装包） | 位置 |
|---|---|
| 内置工具全集 read/bash/powershell/edit/write/grep/find/ls；默认只激活 read/bash/edit/write | `dist/core/tools/index.js` `allToolNames`；`dist/core/sdk.js:140` `defaultActiveToolNames` |
| 设置里的 `defaultTools` 替换默认激活清单，不形成允许清单 | `dist/core/sdk.js:141-145`；`dist/core/settings-manager.js` `getDefaultTools()` |
| **`--tools` 是覆盖所有工具的允许清单**，扩展注册的工具不在清单里就被过滤掉——用它会关掉平台扩展的内核工具 | `dist/core/agent-session.js:2496-2504`（`isAllowedTool` 同时过滤 `getAllRegisteredTools()`） |
| 无允许清单时扩展工具全部激活 | `dist/core/agent-session.js:176-177`（`includeAllExtensionTools: true`） |

`powershell` 不开：镜像里没有 pwsh，开了只会多一个用不了的工具。升级 pi 时核对上表各行仍成立
（尤其 `defaultTools` 的键名与"`--tools` 过滤扩展工具"；上表行号是 0.87.1 的，0.99.2 的复核与新位置见
2.4）。主机核对：入口容器日志有
`check=pi_default_tools result=ok`；真跑一轮后，会话 JSONL 的 system 消息 `toolsAdded` 同时含
这 7 个内置工具与平台扩展工具（`find_operations`、`request_action` 等）。

### 2.3 入口逐轮工具投射（2026-09-27，收尾波次 C3，原 P4）

**做什么**：入口 agent 的门工具（`<gate>.<op>` → `observe_operation`）过去只在 `session_start` 读一次
`list_allowed_operations`，之后在工作区启用的门、发布 / 弃用的 Operation 要等容器重建才进入 / 退出
智能体的工具列表。现在每轮开始（pi 的 `before_agent_start`，每条用户消息一次）再读一次同一个读模型
（`modes/gate-tool-projection.ts`，入口模式调用），新出现的注册并激活、不再列出的停用，下一条消息即
生效、不重启容器。**投射只是展示，不是授权**：内核对每次调用照常执行 `observeRefusal` 等检查，
工具列表过期只会得到一次被拒的调用，内核侧一处未放宽。

| 事实（0.87.1 已安装包） | 位置 | 本仓库怎么用 |
|---|---|---|
| `on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>)`；处理器被逐个 `await`，在 `input` 之后、构建本次运行的第一个请求之前 | `dist/core/extensions/types.d.ts:555,997`；`dist/core/extensions/runner.js` `emitBeforeAgentStart`；`dist/core/agent-session.js:1230,1283` | 刷新点；`input` 先跑，所以日志里的 `turn_id` 是本轮的 |
| `registerTool(tool)` 在 bind 之后也可调：按名字存入（同名覆盖定义）后 `refreshTools()`；对注册表是新名字的自动激活，原来激活的保持激活 | `dist/core/extensions/loader.js:220-230`；`agent-session.js` `_refreshToolRegistry` | 新允许的 Operation 在刷新时注册；定义变了（描述 / schema / blast radius）同名重注册 |
| 没有 `unregisterTool`；`setActiveTools(toolNames: string[]): void` **整体替换**激活集（含内置工具），未知名字忽略；`getActiveTools(): string[]`、`getAllTools(): ToolInfo[]` | `types.d.ts:1070-1074`；`agent-session.js` `setActiveToolsByName` | 下一集 = 当前激活集去掉"本投射分配过、这次不再列出"的名字 + 追加新名字；只动自己分配的名字，内置工具与 17 个静态能力工具原样保留、顺序不变 |
| 处理器调了 `setActiveTools()` 且没改 `event.systemPromptOptions.selectedTools` 时，本次运行用实时装载（工具声明 + 系统提示分节据此重建）；同一运行里后续每个请求也读实时装载 | `agent-session.js:1282-1290`、`_installAgentNextTurnRefresh`（`selectedTools: this.getActiveToolNames()`） | 本扩展只调 `setActiveTools`、不改 `selectedTools`，返回 `undefined`（不覆盖系统提示、不注入消息） |
| 工具集随 transcript 走：变化记成一条 `role: system` 消息的 `toolsAdded` / `toolsRemoved`；系统提示的工具段只列带 `promptSnippet` 的工具 | pi-ai `dist/types.d.ts` `SystemMessage`、`dist/utils/transcript.d.ts` `getCurrentTools`；`dist/core/system-prompt.js` `buildSystemPromptSections` | 门工具不带 `promptSnippet`，模型经工具声明看到它们；主机上看会话 JSONL 的这条 system 消息即可核对 |

**行为约定**：

- 每轮至多一次内核读：`session_start` 一次 + 每条用户消息一次；同一轮里的多次 LLM 请求、排队的
  follow-up / steer 不再读（它们没有新的 `before_agent_start`，沿用本轮开始时的工具集）。
- 读取超时 2 s（`GATE_TOOL_REFRESH_TIMEOUT_MS`）；超时 / 内核报错 / 响应里没有 `items` 数组 →
  保留上一轮的工具集并记一条警告，不阻塞这一轮、不会因瞬时错误掉到零个门工具。`{items: []}` 才是
  "什么都不允许"。
- 名字在一个会话内稳定：同一 `(gatekeeperId, operation)` 始终是同一个工具名，一个名字不会改指另一
  个 Operation；会撞上别人已注册名字（内置、静态能力工具，例如门 `get` 的 `object` → `get_object`）
  的 Operation 改用 `gateToolName` 的 `gatekeeperId` 兜底名，不会覆盖或停用别人的工具。
- 哪些变更**不重启**就在下一条消息生效：在工作区启用门实例（`enable_gate_instance`）、发布 / 弃用
  观察类 Operation（含智能体 `propose_operation` 经审阅后发布的）——它们不轮换 Handle。哪些变更
  **仍会重建容器**：授权、
  「我的智能体」排除（AgentProfile）、AgentPolicy、连接器禁用清单 / 模式、成员角色——它们吊销入口
  Handle，下一轮 agent-host 拿到新 Handle，worker-supervisor 按 jti 不同重建容器（`resident-service.ts`）；
  这是授权交付（Handle 经环境变量在容器启动时注入），不是投射，本项未改。要让这些也免重启，需要
  Handle 可热更新（`productization-plan-v2` §7 已记"另立项"）。

**日志**（入口容器 stderr，`docker logs` 可见；一行一条，`key=value`）：

```text
nexttime-entry check=tool_projection result=changed trigger=turn turn_id=<turnId> added=<名字,…|-> removed=<名字,…|-> redefined=<名字,…|-> gate_tools=<N>
nexttime-entry check=tool_projection result=kept_previous trigger=turn turn_id=<turnId> reason=<timeout|network|capability_error|invalid_response> [code=<code>] message="…"
```

没有变化的轮次不打日志；`trigger=session_start` 那条是容器启动时的首次投射。

**主机核对**（不改主机上项目目录之外的任何东西；结果记 `docs/private/`）。在一个验收用工作区里做
（S4 探针同款的临时工作区即可）——第 3 步的弃用不可逆（Operation 只有 `draft → published`，弃用后
不能再发布），**不要在日常使用的工作区里弃用真实 Operation**：

1. 在该工作区用一个成员发第一条消息拉起入口容器，记下身份：
   `docker inspect -f '{{.Id}} {{.State.StartedAt}}' nexttime-entry-<principalId>`。
2. **出现**：owner 在控制台给该工作区启用一个它尚未启用的门实例（`enable_gate_instance`，会连带
   发布该门的 Operation），然后在对话里发一条消息（可以直接问"你现在能读哪些系统"）。期望：
   `docker logs nexttime-entry-<principalId> 2>&1 | grep 'check=tool_projection' | tail -3` 有一条
   `result=changed trigger=turn turn_id=<这一轮> added=<gate>_<op>…`；第 1 步的 Id 与 StartedAt 不变
   （没有重建）；会话 JSONL（容器内 `/workspace/.pi/sessions/`）最新一条带 `toolsAdded` 的 `role: system`
   消息含这些名字；agent 能真的调用其中一个（审计有一条 `observe_operation`）。
3. **消失**：在该工作区的能力目录弃用刚才那个门的一个观察类 Operation，再发一条消息。期望：日志
   `removed=<gate>_<op>`、`toolsRemoved` 含该名字、容器仍未重建；agent 若按旧记忆去调，得到的是
   pi 的 `Tool <name> not found` 错误结果（`pi-agent-core` `agent-loop.js`），不是一次成功调用。
4. **对照**（预期仍重建）：在「我的智能体」勾掉一个门再发消息——容器 StartedAt 变化（supervisor
   `restarts` +1），新容器 `trigger=session_start` 那条日志的工具集已不含该门。这是 Handle 轮换的既有
   行为，不是回归。

**升级 pi 时核对**：上表五行逐条仍成立（尤其 `before_agent_start` 的"实时装载优先"判定、`registerTool`
在 bind 后可用且新名字自动激活、`setActiveTools` 整体替换语义）；`entry.sdk.test.ts` 的
"per-turn projection" 用例用真实 SDK 从每个请求的 transcript 回放出模型实际看到的工具，是这几条
的自动探针（`pi-drift.yml` 每晚也跑它）。上表行号是 0.87.1 的；0.99.2 逐条复核与新位置见 2.4。

### 2.4 0.87.1 → 0.99.2 核对结果（2026-10-01）

npm 上 0.87.1 之后直接是 0.99.0 / 0.99.1 / 0.99.2（没有 0.88–0.98），变更以 0.99.2 包自带的
`CHANGELOG.md` 为准。核对方法：把两版 `pi-coding-agent`/`pi-ai`/`pi-agent-core`（0.99.2 另有新依赖
`pi-mcp`/`pi-codemode`）装进仓库外的临时目录，逐文件 diff `dist/*.js`/`*.d.ts`/`docs/`，跑两版
`pi --help`、`pi --version`；按 Dockerfile 的方式（`npm install --ignore-scripts`）装两版 CLI，用
`deploy/fake-llm` 做上游、`packages/platform-extension/src/test-support/fake-kernel.ts` 做内核，按
entrypoint.sh 的 flag 与环境（`--mode rpc --session-dir -e --system-prompt <文件>`、`PI_OFFLINE=1`、
`PI_CODING_AGENT_DIR`、`settings.json` 写七个 `defaultTools`、与 `gen-models-json.ts` 同形的
`models.json`）真实启动 `pi --mode rpc` 三种运行：不带扩展；带真实平台扩展 entry 模式（普通一轮、
调用一次逐轮投射出的门工具 `accept_s2_api_stock_get`、`switch_session` 后再一轮、`abort`）；worker
模式（自驱动一轮后退出）。stdout 喂给 `translatePiEvent` 对比，会话文件喂给 `driver.mjs
transcript-stats` 对比。注意：这些真实进程跑在 Windows 开发机的 node 22.19 上，不是镜像里的
Linux + node 24；镜像内行为仍需主机验收。结论取值同 2.1，另加 **测试已适配**（只改测试代码）。

| 行 | 结论 | 证据 |
|---|---|---|
| `platform-extension/package.json` | 已适配 | 两个字段改为 `0.99.2`，`pnpm-lock.yaml` 随 `pnpm install` 更新；`check-pi-version-consistency.sh` 通过。新依赖 `pi-mcp`/`pi-codemode`（含 `quickjs-wasi` 的 wasm）在 `npm install --ignore-scripts` 下没有 install script |
| `index.ts` 默认导出 | 未变 | `core/extensions/loader.js` 的加载与默认导出约定未改（diff 只多了 `registerMcpServer`/`registerVirtualModel`/`getSettings` 与 `registerCommand` 参数校验）；SDK 测试与真实 CLI `-e` 均加载成功 |
| `modes/{entry,worker}.ts` | 未变；测试已适配 | 用到的事件名仍在 `ExtensionEvent`；工具 `execute()` 的 `ctx` 参数类型改为 `ExtensionContext` 的子类型 `ExtensionToolContext`（多 `tools`/`executeTool()`，`core/extensions/types.d.ts:269,492`）——生产代码不受影响，但 `modes/{entry,worker,interactive}.test.ts` 的 `fakeCtx()` 声明为 `ExtensionContext` 再传给 `execute()`，`tsc` 报 34 个 TS2345；本次只把三个桩的类型标注改成 `ExtensionToolContext`。`pi-agent-core` `agent-loop.js:579` 起把 `execute()` 返回值上的顶层 `isError: true` 也当失败——本仓库失败一律 throw、从不在返回值上设 `isError`，不受影响；`terminate`、`context` 消息不落盘（真实运行会话文件无 `nexttime-*-context`）均未变 |
| `tool-schema.ts` | 未变 | 注册时 object 形状 `parameters` 校验未变（`loader.js:233-235`）；新增的 `exposure`（默认 `direct`）、`defaultActive`、`outputSchema` 均可选，本仓库不设 |
| `{entry,worker,interactive}.sdk.test.ts` | 未变 | 具名导出仍在；`pnpm --filter @nexttime/platform-extension test` 117/117（与 `pi-drift.yml` 09-29/30、10-01 对 `@latest` 的结果一致）。**此前 `pi-drift.yml` 只跑 vitest、不跑 `tsc`**，上一行的类型破坏它连续三晚都没看见——本次升级 PR 已给它补上 `typecheck`（§6）；升级本身仍以本地 `pnpm -r typecheck` 为准 |
| `bindExtensions` 的坑 | 未变 | `modes/rpc/rpc-mode.js:230` 仍调 `bindExtensions`，`core/agent-session.js:2536` 起仍在内部 `emit(session_start)`；真实 CLI worker 模式两版都自驱动一轮、`report_task_result` 后 `exit 0` |
| `Dockerfile` | 未变；需主机验收 | `pi --help` 两版 diff 只有新增的 `pi mcp` 子命令与 `-e`/`-ne` 的说明（`-e` 可加载 `builtin:<name>`；`-ne` 也关内置扩展）；`--mode`/`--session-dir`/`-e`/`--system-prompt` 不变（`dist/cli/args.js`）；`resolvePromptInput` 逐字相同（真实运行 system 消息里有提示文件内容）；`config.js` 的 agent-dir / `PI_CODING_AGENT_DIR` / `models.json` 解析未变（diff 只加了 codemode 的 QuickJS/worker 路径）；`docs/containerization.md` 逐字相同；`engines.node` 仍 `>=22.19.0`；`PI_OFFLINE` 仍关掉版本检查（`utils/version-check.js:37`）与 RPC 模式目录刷新（`main.js:758`）；默认激活四件套搬到 `core/settings-manager.js:35` `DEFAULT_TOOL_NAMES`，值不变 |
| `entrypoint.sh` | 未变；需主机验收 | flag 同上；真实运行两版 stdout 都是 0 行非 JSON，扩展日志都在 stderr；`defaultTools` 纯名字列表仍整体替换默认集（`settings-manager.js:55` `resolveDefaultTools`；0.99 新增的 `+name`/`-name` 修饰语法本仓库不用）；真实运行首条 system 消息 `toolsAdded` 两版逐项相同：7 个内置 + 17 个静态能力工具 + 投射出的门工具，没有 `codemode`/`tool_search` |
| `bridge.ts` | 未变 | 真实 RPC 流对比：三种运行的事件类型序列逐条相同，`translatePiEvent` 输出逐条相同，`tool_execution_start`/`_end` 字段集合不变。唯一差异是 prompt 成功响应多了 `data: {disposition: "started"|"queued"|"handled"}`（`rpc-mode.js:298` 起的 `case "prompt"`，0.99.0 "per-input disposition"）——`bridge.ts` 不读响应 |
| `host.ts` | 未变 | 关联条件（`type`/`command`/`id`/`success`）不变，多出的 `data` 被忽略，三种响应仍回显 `id`；`switch_session`/`abort` 响应与 `extension_error` 形状不变（`rpc-mode.js` diff 只动了 prompt/steer/follow_up）。prompt 失败：0.87.1 先 `preflightResult(false)` 再由 `catch` 回错误响应，0.99.2 直接 throw 进同一个 `catch`，对外仍是 `success:false` + `error`。`disposition: "handled"`（扩展命令或 `input` 处理器吞掉了 prompt，不会有 `agent_settled`）本仓库遇不到：下发的 prompt 以 `<!--nexttime:turn_id=…-->` 开头而不是 `/`，入口扩展的 `input` 处理器只做 `transform` |
| `container-io.ts` | 未变 | `dist/modes/rpc/jsonl.js` 逐字相同 |
| `worker-supervisor` spawn spec | 未变 | `PI_CODING_AGENT_DIR`、`getAgentDir`/`getModelsPath`、`<agentDir>/skills` 不变；真实运行从 `PI_CODING_AGENT_DIR` 下的 `models.json` 选中了模型 |
| `gen-models-json.ts` | 未变 | `core/model-config.js`（`ModelsConfigSchema`）与 `resolve-config-value.js` 逐字相同；`provider-composer.js` 把 `models.json` 里的定义限定为 chat 模型（不写 `type` 即 chat，本仓库不写）；真实运行不传 `--model` 时选中 `platform/fake-echo`，`$CAPABILITY_HANDLE` 模板解析成功（否则 prompt 会因无 key 被拒） |
| `skill.ts` | 未变 | `core/skills.js` 逐字相同 |
| `driver.mjs` `transcript-stats` | 未变 | 同一轮真实运行（entry、worker）的两版会话文件输出逐字相同；条目序列相同，0.99.2 的 assistant 消息多一个 `thinkingLevel` 字段（不读）|
| 2.2 内置工具全开 | 未变 | 见 `entrypoint.sh` 行；`--tools` 仍是覆盖扩展工具的允许清单（`agent-session.js:2753-2761`）；无允许清单时扩展工具注册即激活，条件变为"exposure 是 `direct`/`model-only` 且 `defaultActive !== false`"（`:2814-2818`、`:2835`）——平台扩展工具两个字段都不设，默认 `direct`，行为不变 |
| 2.3 逐轮工具投射 | 未变 | `before_agent_start`（`types.d.ts:1164`；`runner.js:1115` `emitBeforeAgentStart`）；"处理器没改 `selectedTools` 就用实时装载"判定逐字相同（`agent-session.js:1528-1536`），同一运行后续请求仍读实时装载（`:516-528`）；`registerTool` 在 bind 后可调、新名字自动激活（`loader.js:231-241` → 无参 `_refreshToolRegistry()`，`:2820-2826`）；`setActiveTools` 仍整体替换、未知名字忽略，另外忽略 `hidden` 工具（`:1078` → `_applyToolLoadout`）；transcript 的 `toolsAdded`/`toolsRemoved` 不变（pi-ai `dist/types.d.ts:350`）；`Tool <name> not found`（pi-agent-core `agent-loop.js:486`）。内置 MCP 扩展也挂了 `before_agent_start`（`extensions/mcp/index.js:893`），只改 `systemPromptOptions.sections`、不改 `selectedTools`，不影响上面的判定。`entry.sdk.test.ts` per-turn projection 通过；真实 CLI 里门工具在 `session_start` 投射并被调用一次 |
| 文档 | 已适配 | 见 2 节表最后一行 |

0.88–0.99 里本仓库不依赖、但值得知道的变化：

- **内置扩展**：0.99.0 起 CLI 默认加载 `llama.cpp`（0.87.1 已有）、`codemode`、`tool-search`、`mcp`
  四个内置扩展（`dist/extensions/index.js`）。`codemode`/`tool_search` 两个工具 `defaultActive: false`
  （`extensions/codemode/index.js:26`、`extensions/tool-search/index.js:11`），不写进 `defaultTools`
  就不激活。MCP 扩展只读 `<agentDir>/mcp.json`（项目级 `.pi/mcp.json` 需项目受信任，
  `trust-manager.js` 已把它列入 `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES`）；容器里没有这个文件时 `session_start` 直接返回
  （`extensions/mcp/index.js:848`）——不连接、不激活 codemode、系统提示没有 `mcp_servers` 段。新增
  斜杠命令 `/mcp`（以前只有 `/llama`）；下发的 prompt 以 turn 标记开头，触发不到。
- **治理含义**（未改，留给维护者）：智能体能写自己的 `/workspace/.pi/agent/mcp.json`，下次容器启动
  时 pi 会按它连 MCP 服务器（stdio 子进程或 HTTP）。这不是新能力——它本来就能往
  `<agentDir>/extensions/` 写扩展让 pi 自动加载，也能直接用 bash 起进程；出网仍只走 egress 代理，
  内核侧的门与审批不受影响。若要收紧，entrypoint 加 `-ne`（关掉扩展自动发现与内置扩展，`-e`
  显式加载的平台扩展照常）即可，但这与 2.2 "pi 自身权限不限制"的决定相反，需要另行决定。
- 会话文件改为首条 user 消息时就落盘（以前是首条 assistant 回复，`session-manager.js`
  `_hasConversation`）；assistant 消息多 `thinkingLevel`。内核只把 `sessionJsonlPath` 记成 Source URI。
- `-e` 加载的扩展若在自己 `package.json` 的 `dependencies` 里写了 `@earendil-works/pi-*`，0.99 会出一条
  "应改为 peerDependencies" 的警告（`resource-loader.js` `collectExtensionPackageWarnings`，只对带包
  元数据的扩展）；本机真实运行以文件路径 `-e` 加载平台扩展，stderr 没有这条。
- 未传 `--model` 时的初始模型选择逻辑不变，"已知 provider 的默认模型"表改了 `openai-codex`/`fireworks`/
  `together`/`opencode-go` 四项（`model-resolver.js`）——同 2.1 的说明，只有平台 provider 恰好叫这些
  名字时才相关。
- pnpm 11 的 `minimumReleaseAge`：对发布不满一天的版本，`pnpm install` 会自动往 `pnpm-workspace.yaml`
  写 `minimumReleaseAgeExclude`。本次升级时 0.99.2 刚发布不到一天，这段自动写入没有保留（锁文件不记录
  它，`pnpm install --frozen-lockfile` 照常通过）；下次升级若遇到，同样处理或等满一天再装。

### 2.5 0.99.2 → 1.1.0 核对结果（2026-10-08，S10 U0）

S10 方案写的目标是 1.0.2；开工时 npm `latest` 已是 **1.1.0**（1.0.0 10-01、1.0.1 10-03、1.0.2 10-04、1.0.3 / 1.0.4
10-05、1.1.0 10-07T22:16Z），直接升到 1.1.0，下表覆盖 1.0.0–1.1.0 的全部变更（以 1.1.0 包自带 `CHANGELOG.md` 为准）。
核对方法同 2.4，环境比上一次更接近生产：

- **静态**：两版 `pi-coding-agent` 及其 `@earendil-works/*` 依赖装进仓库外临时目录，逐文件 diff `dist/*.js`/`*.d.ts`/`docs/`，
  跑两版 `pi --help`、`pi --version`。`dist/modes/rpc/{rpc-mode,jsonl,rpc-types}.js`、`modes/json-event.js`、
  `core/session-manager.js`、`core/resolve-config-value.js`、`extensions/index.js`、`utils/version-check.js`、
  `docs/{containerization,rpc,rpc-commands,session-format}.md` 两版逐字相同。下表引用的 `dist/**.js` 行号都是包里
  **模块化**那份（`dist/index.js` 一侧）；CLI 实际跑的是 `dist/bundle/` 里的同源代码。`entry/worker.sdk.test.ts` 与
  `pi-drift.yml` 测的也是模块化运行时加 pnpm 依赖树，不是容器里执行的 bundle——行为结论靠下面两种真实 `pi --mode rpc`
  运行支撑。bundle 里 `chunks/anthropic-messages-*.js` 的 beta 常量集合与 `node_modules` 里 pi-ai 1.1.0 相同。
- **真实运行（开发机）**：Linux + node 22.22，两版 CLI 各跑三种：不带扩展（两轮）；带真实平台扩展 entry 模式（普通一轮、
  调用逐轮投射出的门工具 `accept_s2_api_stock_get` 一轮、`switch_session` 后再一轮、`abort`）；worker 模式（自驱动一轮后
  退出）。上游 `deploy/fake-llm`，内核用一个只实现扩展所调能力的假内核，`settings.json` 写七个 `defaultTools`，
  `models.json` 与 `gen-models-json.ts` 同形。stdout 喂给 `translatePiEvent`，会话文件喂给 `driver.mjs transcript-stats`。
- **真实运行（镜像内）**：用本 PR 的 `deploy/worker-runtime/Dockerfile` 构建 `nexttime-ai-worker-runtime:pi-1.1.0`
  （node 24.21，pi 1.1.0，`npm ci` 装入 `/opt/pi`），在 `--internal` docker 网络上以真实 `entrypoint.sh` 启动 entry / worker
  （不带扩展那一轮用 `--entrypoint pi`），假内核与 fake-llm 跑在同网络的另一个容器里，同样三种运行。这补上了 2.1 / 2.4
  里"需主机验收"行的大部分：镜像内的 flag、`models.json` 路径、默认工具、扩展加载都在 Linux + node 24 上真实跑过；
  仍需主机的是真实模型、真实内核与 egress 代理（见下"主机验收"）。
- 注意：探针进程必须用干净的环境变量启动。开发机环境里有 `AWS_ACCESS_KEY_ID` 时，两版 pi 在未传 `--model` 时都会先选
  `amazon-bedrock` 的模型而不是 `models.json` 里的平台模型（初始模型选择逻辑，两版相同，不是 1.x 的变化）；生产容器的
  环境由 spawn spec 决定，没有这些变量。

结论取值同 2.4。

| 行 | 结论 | 证据 |
|---|---|---|
| `platform-extension/package.json` | 已适配 | 两个字段改为 `1.1.0`，`pnpm-lock.yaml` 随 `pnpm install` 更新（`@anthropic-ai/sdk` 0.124 → 0.129 等传递依赖随之变化）；`check-pi-version-consistency.sh` 通过。pnpm 的 `minimumReleaseAge` 在 1.1.0 发布不满一天时自动写入的 `minimumReleaseAgeExclude` 没有保留（同 2.4 末条） |
| `Dockerfile` 安装方式 | **已适配** | **1.0.1 起 npm 包不再带 `npm-shrinkwrap.json`**（CHANGELOG 1.0.1 "Removed"）。此前 `npm install -g pi@<v>` 的整棵依赖树由 shrinkwrap 钉死；之后全局安装会把 pi 自己的 `^1.x` 范围解析成构建当时的最新版。`pi --mode rpc` 实际执行的代码不受影响：0.99.2 起 `bin.pi` 是 `dist/bundle/cli.js`，自包含的 esbuild bundle，`pi-ai`/`pi-agent-core`/`pi-tui` 已内联，扩展对 `@earendil-works/*` 的 import 由 bundle 的 `virtualModules` 提供；会漂的是 `/opt/pi` 其余部分——bundle 真正的外部依赖（`photon-node`、`typebox`、可选的 aws-sdk crt 签名器）、上游哪天不再打 bundle 时会从 `node_modules` 加载的文件、镜像扫描与审计看到的那棵树。为了同一 commit 两次构建得到相同的文件树，改为 `deploy/worker-runtime/pi/{package.json,package-lock.json}` + `npm ci --omit=dev --ignore-scripts` 装入 `/opt/pi`、`/usr/local/bin/pi` 软链；构建时校验已装 pi 等于 `pi.version`；`check-pi-version-consistency.sh` 增加两条（`pi/package.json` 依赖与锁文件的 pi 版本都等于 `pi.version`）。镜像内 `pi --version` = 1.1.0，`pi-ai`/`pi-agent-core`/`pi-mcp`/`pi-codemode`/`pi-tui`/`chord` 均为锁文件里的 1.1.0。两棵依赖树有小漂移：npm 锁里 `ws` 8.22.0、`@aws-sdk/credential-provider-node` 3.972.84，pnpm 树里 8.21.3、3.972.82（pi 家族两边一致；运行路径是 bundle，影响很小） |
| `index.ts` 默认导出 | 未变 | `core/extensions/loader.js:481-486` 仍是 jiti `{default: true}` + `typeof factory === 'function'`；新增 `ExtensionAPI.registerToolRenderer`（只影响 TUI）；三处真实运行 `-e` 均加载成功，镜像内 `@earendil-works/*` 由 bundle 的 `virtualModules` 提供 |
| `modes/{entry,worker}.ts` | 未变 | 所用事件仍在 `ExtensionEvent`（`types.d.ts:1057`）；`AgentSettledEvent` 新增必填 `aborted: boolean`（`:777-780`）、`ToolExecutionEndEvent` 新增可选 `durationMs`（`:848-857`）——本仓库都不读；`execute()` 返回契约与 `ExtensionToolContext` 不变；`pnpm -r typecheck` 无需改任何代码；真实运行会话文件里没有 `nexttime-*-context` |
| `tool-schema.ts` | 未变 | `loader.js:231-241` object 形状 `parameters` 校验不变 |
| `{entry,worker,interactive}.sdk.test.ts` | 未变 | 具名导出全在；`pnpm --filter @nexttime/platform-extension test` 124/124（与 `pi-drift.yml` 10-04 对 1.0.2 的 124 / 124 一致，S10 方案 §1） |
| `bindExtensions` 的坑 | 未变 | `rpc-mode.js:230` 仍调用，`agent-session.js:2618` 仍在内部 `emit(session_start)`；worker 模式三处真实运行都自驱动一轮、`report_task_result` 后 `exit 0` |
| `Dockerfile` CLI / 环境 | 未变；镜像内已跑 | `--mode`/`--session-dir`/`-e`/`--system-prompt` 不变（`cli/args.js:41,72,99,156`），`resolvePromptInput` 逐字相同（真实运行 system 消息含提示文件标记）；`pi --help` 差异只有 `--tools`/`--exclude-tools` 的 `*` 模式与 `+name`/`-name`、新 `--no-mcp`、`--tui-mode` 默认改 fullscreen、`--provider` 必须配 `--model`（`main.js:360-365`，本仓库两者都不传）；`config.js` agent-dir / `PI_CODING_AGENT_DIR` / `models.json` 解析不变；`engines.node` 仍 `>=22.19.0`；`PI_OFFLINE` 仍关版本检查（`version-check.js:37`）与 RPC 目录刷新（`main.js:765`） |
| `entrypoint.sh` | 未变；镜像内已跑 | `defaultTools` 纯名字列表仍整体替换默认集（`settings-manager.js:90-93`，`DEFAULT_TOOL_NAMES` 仍是四件套）；首条 system 消息 `toolsAdded` 两版逐项相同：7 个内置 + 17 个静态能力工具 + 投射出的门工具，没有 `codemode`/`tool_search`。1.1.0 的 OSC 7501 程序状态只由交互模式的 `ProcessTerminal` 写（`pi-tui/dist/terminal.js`），RPC 模式在加载扩展前就接管 stdout（`main.js:518-523`、`rpc-mode.js:24`），强制 `PI_PROGRAM_STATUS=1` 时 stdout 也没有 ESC 字节。**更正**：2.1 / 2.4 说"stdout 0 行非 JSON"是直接跑 pi 的结果；经 `entrypoint.sh` 启动时，exec pi 之前的四条 `nexttime-selfcheck` 日志在 stdout（不是 pi 写的，两版相同），`container-io.ts` 按非 JSON 行丢弃——这是既有行为，记在这里以免下次误判为 pi 回归 |
| `bridge.ts` | 未变（fixture 已补） | 三种运行、两版、开发机与镜像内：事件类型序列逐条相同，`translatePiEvent` 输出逐条相同，各事件字段集合只多 `agent_settled.aborted` 与 `tool_execution_end.durationMs`；`bridge.test.ts` 加了这两个形状的用例 |
| `host.ts` | 未变 | `rpc-mode.js` 逐字相同：`prompt` / `switch_session` 响应回显 `id`（`data.disposition` / `data.cancelled` 不变），`abort` 响应形状不变；三种运行 `extension_error` 均为 0 |
| `container-io.ts` | 未变 | `dist/modes/rpc/jsonl.js` 逐字相同 |
| `worker-supervisor` spawn spec | 未变 | `PI_CODING_AGENT_DIR`、`getAgentDir`/`getModelsPath`、`<agentDir>/skills`（`resource-loader.js:753`）不变；镜像内从挂进来的 `models.json` 选中 `platform/fake-echo` |
| `gen-models-json.ts` | 未变 | `ProviderConfigSchema` 全部字段可选，`api` 是自由字符串（`model-config.js:171,211`）；唯一新增是可选 `samplingParamsByThinkingLevel`（1.0.2）；1.0.3 的 `azure-openai-responses` → `azure` 只改 provider id，`api` 值不变；`$CAPABILITY_HANDLE` 模板解析成功 |
| `skill.ts` | 未变 | `core/skills.js:9,11` 上限 64 / 1024，`validateName` 不变 |
| `driver.mjs` `transcript-stats` | 未变 | 同一轮真实运行（entry、worker）两版会话文件输出逐字相同（镜像内亦同）；assistant / toolResult 消息多可选 `durationMs`，`read` 结果可能带 `structuredContent`（都不读） |
| 2.2 内置工具全开 | 未变 | `--tools` 仍是覆盖扩展工具的允许清单，1.0.4 起另加 MCP 工具例外与 `*` 模式（本仓库不用 `--tools`）；扩展工具激活条件不变（`agent-session.js:2898-2900`） |
| 2.3 逐轮工具投射 | 未变 | "处理器没改 `selectedTools` 就用实时装载"（`agent-session.js:1590-1598`）、`setActiveTools` 整体替换并忽略未知 / hidden（`:1099-1108`）、`registerTool` bind 后可用且新名字自动激活均不变。新增 `_pendingToolNames`：恢复 / 重载的 transcript 里列着但尚未注册的工具名，注册时重新激活；它在每次 `_runAgentPrompt` 开头清空（`:1387`），早于 `before_agent_start`，不影响投射。真实运行里 `switch_session` 后新会话 `session_start` 再投射一次、门工具照常被调用 |
| **`llm-proxy` `outbound-policy.ts`**（本次补入第 2 节表） | **已适配** | 遗留 123 记的"`anthropic-beta` 白名单绑定 pi 0.99 的取值"。1.0.1 起 pi 对 Anthropic 的中途工具变更改为**按值内联定义**：beta 由 `mid-conversation-tool-changes-2026-07-01` 换成 `inline-tools-2026-09-15`，`tool_addition` 块从 `{tool:{type:'tool_reference', name}}` 变成 `{tool:{type:'tool_definition', definition}}`（pi-ai `api/anthropic-messages.js:119,855,1039-1040`）。只在模型 `compat` 声明 `supportsMidConvoSystemMessages` 与 `supportsMidConvoToolChanges` 时才走这条路；`gen-models-json.ts` 不写 `compat`，所以平台流量今天不发这个 beta（用真实 pi-ai 1.1.0 抓包确认：不开 compat 时请求里没有 beta、工具整表下发；开了时请求带 `inline-tools-2026-09-15` 与内联定义）。但内联定义是一条新的工具声明通道：若只放行 beta 而不看消息里的定义，agent 可以把 `web_fetch` / `mcp_toolset` 之类服务端工具塞进 `tool_addition` 绕过 R-30 / D-29。本 PR：白名单加 `inline-tools-2026-09-15`（保留旧值，给回滚到 `:pi-0.99.2` 镜像用）；`stripProviderServerTools` 对 Anthropic 消息里（以及数组形态的顶层 `system` 里——pi 不往那放，但 R-30 防的是持 Handle 自己拼请求体的进程）的 `tool_addition` 同样只保留客户端工具定义，`tool_reference` 原样保留，其它形状一律剥离并记日志；一条消息的块被剥光会剩 `content: []`、供应商回 400，属于 fail-closed；抓到的真实 pi 1.1 请求经过滤后逐字节不变。OpenAI 两种 api 的工具列表形状 1.x 未变 |
| 文档 | 已适配 | 见 2 节表最后一行 |

1.0–1.1 里本仓库不依赖、但值得知道的变化：

- 交互模式默认 fullscreen（1.0.0）、OSC 7501 程序状态（1.1.0）、codemode 提示词瘦身与 `models.generateImages()`、MCP
  OAuth 加固、`/login` Radius 等，全部只在交互模式或内置扩展里生效；容器里没有 `mcp.json`，MCP 扩展在 `session_start`
  直接返回（`extensions/mcp/index.js:988-991`）。2.4 记的"智能体能写自己的 `<agentDir>/mcp.json`"治理含义不变；1.0.1 新增的
  项目级 `.pi/mcp.json` 覆盖仍要求项目受信任。
- 1.0.1 起 bash / MCP / codemode 的完整输出临时文件以 0600 创建（容器内单用户，无影响）。
- 1.0.1 / 1.1.0 把若干供应商错误（"model at capacity"、`server_busy`）改为自动重试，1.1.0 按 3.5 字符 / token 估算输入，
  上下文超限失败更少——对平台是放宽。
- pnpm 11 的 `minimumReleaseAge`：本机 `pnpm install` 自动写了 `minimumReleaseAgeExclude`（未保留）；**容器内的
  `pnpm fetch --frozen-lockfile`（worker-runtime 等镜像的 build 阶段）在 1.1.0 发布满 24 小时（2026-10-08 22:16Z）之前
  拒绝这份锁文件**（实测；本次镜像探针构建临时加了 `pnpm_config_minimum_release_age=0`，不入库），CI 的
  `pnpm install --frozen-lockfile` 预计同样；满一天后自然通过，不需要改仓库。

**主机验收**（本 PR 合入、随发版应用之后；结果记 `docs/private/`）：`build-images.sh` 日志里 worker-runtime 那段出现
`npm ci` 且没有 "installs pi … pi.version says …" 报错；`docker run --rm --entrypoint pi nexttime-ai-worker-runtime:pi-1.1.0
--version` 为 1.1.0；运行层页「pi 运行时」一键升级常驻智能体；S1–S4 全过；S5.7 真实模型回归各场景不低于 v0.34.0 一轮的
计数（`host-accept-real-model.md`）。回滚目标是保留的 `nexttime-ai-worker-runtime:pi-0.99.2`（第 7 节）。

## 3. 单一版本源

`pi.version`（仓库根目录，纯文本，一行版本号）是**唯一**手改的地方：

- `deploy/worker-runtime/Dockerfile`：`runtime` 阶段 `COPY pi.version` 与 `deploy/worker-runtime/pi/` 的
  `package.json` + `package-lock.json`，`npm ci` 装锁文件里的整棵树，然后比对已装 pi 的版本与 `pi.version`，不等就构建
  失败——镜像机制上不可能装进别的 pi。之所以要一份锁文件而不是 `npm install -g pi@<pi.version>`：1.0.1 起 pi 不再发布
  `npm-shrinkwrap.json`，全局安装的依赖树会随构建时间漂移。pi CLI 本身是自包含 bundle，所以漂的不是它执行的代码，而是
  bundle 的外部依赖与 `/opt/pi` 的文件树（2.5）；锁文件让同一 commit 的两次构建得到同一棵树。锁文件与它的 `package.json` 是
  `pi.version` 之外的两份拷贝，同样由下面的守卫保证一致。
- `packages/platform-extension/package.json` 的 `dependencies["@earendil-works/pi-coding-
  agent"]` 与 `devDependencies["@earendil-works/pi-ai"]`：**没有**做成自动读取——pnpm/npm 的
  package.json 字段只接受字面量版本号，没有"从另一个文件读值"的语法，人为造一个 `postinstall`
  脚本去改写 package.json 会把版本号和 `pnpm-lock.yaml` 的一致性绑到一个额外的构建步骤上，
  超出"机械化"的范围，也可能影响 `--frozen-lockfile` 的可重复性。这两处仍是独立字面量，但由
  `scripts/check-pi-version-consistency.sh` 保证几处（`pi.version`、两个 package.json 字段、
  `deploy/worker-runtime/pi/` 的依赖与锁文件、Dockerfile 是否还在读 `pi.version`）永远一致——`pnpm ci:guards` 与 CI 的 `guards` job
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
   `packages/platform-extension/package.json` 的两个版本号字段与 `deploy/worker-runtime/pi/package.json`，再
   `cd deploy/worker-runtime/pi && npm install --package-lock-only --ignore-scripts` 重新生成锁文件
   （`check-pi-version-consistency.sh` 会在下一步提醒你，如果忘了）。
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
- `packages/platform-extension/src/entry.sdk.test.ts`、`worker.sdk.test.ts` —— **真实 pi SDK**，本清单里权重最高的两个文件，也是 `.github/workflows/pi-drift.yml` 每晚对 `@latest` 跑的对象（`entry.sdk.test.ts` 含逐轮工具投射用例，见 2.3）
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
版本号完全不受影响**），跑 `packages/platform-extension` 的 `typecheck`（2026-10-01 起；vitest 剥掉类型，
只改类型的破坏它看不见）与完整测试套件（含上面两个 `*.sdk.test.ts`），任一失败即算漂移，打印 pinned/latest 版本 diff 到 job summary。失败时开/更新**同一个**带
`pi-drift` label 的 issue（标题 `pi drift: <latest 版本号> breaks <n> tests`；用 `gh issue
list --label pi-drift` 查是否已有未关闭的，有就编辑标题/正文+追加评论，没有才新建）；转绿时自动
关闭该 issue。这个 workflow **没有** `pull_request`/`push` 触发器，永远不会出现在任何 PR 的
required checks 里，`ci.yml` 完全不受影响。

**成功路径（S10 U1）**：上游 `@latest` ≠ `pi.version` 且全部通过时，开 / 更新**同一个**带 `pi-upgrade-available`
label 的 issue（"pi X 可升级、兼容测试通过"——它只是提醒，不开 PR；升级仍走第 4 节）；`pi.version` 追上后自动关闭。
每次检查（通过或失败）的结论还会写进 ReleaseChannel 记录（`operations.md` §16），控制台据此在概览提醒"pi 待发版"或
"pi 不兼容"，并在运行层「pi 运行时」卡片显示「上游最新 pi」。

**与控制台运行层页的「pi 运行时」卡片是两回事**。本节上面说的"漂移"是"pinned `pi.version` vs npm 上的
`@latest`"（升级值不值得做，由 nightly workflow 的 issue 提醒——一个 pi 版本要进生产，必须走第 4 节
的升级 PR，随发版一起交付）；控制台卡片问的是另一件事——"主机上的常驻智能体，是不是已经跑在**本版**
期望的 pi 上"，并给出把它们升上去的一步操作：

- **本版期望的 pi**：内核镜像内置的 `pi.version`（`packages/kernel/Dockerfile` 拷到 `/app/pi.version`，
  `PI_VERSION_FILE` 指向它）——与 `deploy/worker-runtime/Dockerfile` 安装 pi 用的是同一个文件，同一次发版
  构建出来，**不出网、不需要人工拷贝任何 CI 产物**（2026-09-26 之前读的是需要人工拷贝的
  `pi-drift.json`，从未有人拷过，卡片因此永远显示"未知"——已删除）。
- **活动镜像里的 pi**：活动运行时镜像自带的 `ai.nexttime.pi-version` label。它只有经
  `scripts/build-images.sh` 构建才是真实版本（否则是 `dev`，卡片会直接给出构建命令）。
- **一键升级**：两者一致时，卡片按 `runtime_inventory` 的 `needsRebuild` 显示"一键升级 N 个常驻智能体"
  （中影响确认 → `roll_entry_containers` 全量：空闲的立即停止、下一轮对话时用新镜像重建，会话历史与工作
  目录保留；正在跑一轮的不打断，在它下一轮开始时收敛）。
- **镜像还不是本版的 pi**：卡片给出 `sh scripts/build-images.sh worker-runtime`（发版应用脚本已包含）。

所以一次 pi 升级在主机上的完整路径是：升级 PR 合入 → 发版 → 主机按 `release.md` 应用（`build-images.sh`
构建带真实标签的运行时镜像）→ 运行层页「pi 运行时」一键升级常驻智能体 → S1–S4 验收。

**依赖更新**：pi（`@earendil-works/*`，`packages/platform-extension` 下那两个包）不接受任何 bot 版本更新——
2026-09-25 起仓库不再用 Renovate，也没有 Dependabot 版本更新配置（见 `docs/runbooks/automation.md`
"依赖更新怎么做"）；万一 Dependabot 安全更新碰到这两个包，`.github/workflows/auto-merge.yml` 会打
`needs-review` 标签、不自动合并——仍然要走上面第 4 节的升级步骤和第 5 节的测试清单。`deploy/worker-runtime`
的 Docker 基础镜像（`node:24-bookworm-slim`）锁定在 24.x，升级时手动改。

## 7. 回滚

pi 本身没有运行时"回滚"的概念（它不是一个常驻服务，是每次 spawn 容器时装进镜像的 CLI）——回滚
单位是**镜像 tag**：

1. `deploy/worker-runtime` 镜像每次构建都应该打上包含 `pi.version` 值的 tag（例如
   `nexttime-ai-worker-runtime:pi-1.1.0`），而不只是浮动的 `nexttime-ai-worker-runtime:latest`
   ——本仓库当前 `docker-compose.yml` 的 `worker-runtime` 服务只打了不带版本号的
   `image: nexttime-ai-worker-runtime`（build-only, 见该服务自己的注释），升级 PR 落地时应该
   在主机验收步骤里手动把新镜像也打一个带版本号的 tag 再切换 `worker-supervisor` 的
   `WORKER_IMAGE` 引用，保留旧 tag 至少一个发布周期，坏了直接把 `WORKER_IMAGE`
   改回旧 tag、重启 `worker-supervisor`——常驻入口容器与一次性 Worker 容器都是下次 spawn 才
   用新镜像，不需要重建正在跑的容器。
   - **平台设置 `activeRuntimeImage` 才是"当前用哪个镜像"的权威**（设置值；未设时才回落到
     worker-supervisor 的 `WORKER_IMAGE` env 缺省）。有活动镜像设置时，改回旧 tag 的正路是
     `rollback_runtime_image`（改回上一个 `platform_settings` 版本）或
     `set_active_runtime_image '{"image":"nexttime-ai-worker-runtime:pi-<旧版本>"}'`——两者都要求目标
     在 `list_runtime_images` 的清单里、且在 `WORKER_IMAGE_ALLOWLIST` 里（否则 409
     `image_not_in_inventory` / `image_not_allowed`），所以**旧 tag 要先留着并加进 allowlist**，
     只剩 digest 的旧 build 回不去；只改 `WORKER_IMAGE` env 在已设过活动镜像的平台上不生效。
     已运行的入口容器在自己的下一次 Turn 自然重建，`roll_entry_containers` 可加速空闲容器；
     `pi_drift`（运行层页「pi 运行时」卡片）会显示活动镜像的 pi 版本与本版期望是否一致。细节见
     `operations.md` §13。
2. 代码侧回滚：`git revert` 升级 PR（`pi.version`、两个 package.json 字段、`pnpm-lock.yaml`
   一起回退），重新构建镜像。
3. `.github/workflows/pi-drift.yml` 本身不涉及运行时，不需要回滚流程——它只在还没合并升级 PR 时
   持续提醒"什么时候能升"。（`.github/dependabot.yml` 已不存在，#287 决定不恢复：常规依赖升级不交给
   bot、按波次手动做，见 `development-tasks.md` §S3.15；这里不再有 bot 提醒。）
