# 接入指南：把你本机的 pi 接到本平台的图（`interactive` 模式）

对应任务：development-tasks.md §S3.6（`interactive` 模式）。设计文档 §7.4 表格里的
`interactive | 你本机的 pi | 同 entry 或按 Handle | 同 entry | 默认不回传`——这条讲的就是本文档。

跟 `docs/howto-connect-claude-code.md` 是同一个"拿 Handle"前置步骤，区别在于**接入方式**：
Claude Code 经 `/mcp`（MCP streamable HTTP）；`interactive` 模式是让你自己机器上的 `pi`
（`@earendil-works/pi-coding-agent`，本仓库用的版本见根目录 `pi.version`）直接加载本仓库的
`@nexttime/platform-extension`，走 `KERNEL_URL` 的 HTTP 能力路由（`/api/cap/<name>`）——跟
入口/Worker 容器内部用的是**同一份扩展代码**，只是 `NEXTTIME_MODE=interactive`，且不在容器里跑。

## 前提

- 你能访问本仓库（`git clone` + `pnpm install`）——`platform-extension` 是私有 workspace 包，没有
  发到 npm，pi 通过文件路径（`-e <path>`）而不是包名加载它。
- 本机已安装 `pi`（版本对齐根目录 `pi.version`），且**已经配置好你自己的模型/provider
  凭证**——`interactive` 模式只接管"图/能力"这一半（`KERNEL_URL`/`CAPABILITY_HANDLE`），模型调用
  走你本机 pi 自己的 provider 配置，**不经过平台的 `llm-proxy`**（跟 `entry`/`worker`
  两个跑在平台容器里、经 `KERNEL_LLM_URL` 走预算/用量上报的模式不同——`interactive`
  模式的模型开销、模型选择都是你自己的事，内核看不到也不管）。
- 你是这个 workspace 的 owner，能调 `issue_handle`（见下方"拿 Handle"，跟 Claude Code 那篇文档的
  步骤完全一样）。

## 第 1 步：拿一个 Handle

跟 `docs/howto-connect-claude-code.md` 第 1 步完全相同：

```bash
curl -sk -X POST "https://<host>:8443/api/cap/issue_handle" \
  -H "Authorization: Bearer <YOUR_OWNER_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"sessionKind": "interactive"}'
```

保存 `result.handle`（只出现这一次）。想要更窄的能力范围、ttl 上限、撤销方式——同一篇文档，不重复。

## 第 2 步：本机构建 platform-extension

```bash
cd <你 clone 的 NextTime-AI 目录>
pnpm install
pnpm --filter @nexttime/shared build
pnpm --filter @nexttime/platform-extension build
```

产物在 `packages/platform-extension/dist/index.js`（`pi -e` 也能直接指到 `src/index.ts`，pi
自带的加载器认 TS——本地开发迭代时更方便，省去每次改动都重新 build 这一步；两条路径下面都给出）。

## 第 3 步：设置环境变量，启动 pi

```bash
export NEXTTIME_MODE=interactive
export KERNEL_URL="https://<host>:8443"   # 或本机直连 kernel 端口，跳过 caddy/TLS
export CAPABILITY_HANDLE="<第 1 步拿到的 handle>"

# 用构建产物：
pi -e <你 clone 的 NextTime-AI 目录>/packages/platform-extension/dist/index.js

# 或直接用源码（开发迭代用）：
pi -e <你 clone 的 NextTime-AI 目录>/packages/platform-extension/src/index.ts
```

- **`interactive` 模式不需要 `WORKSPACE_ID`**——跟 `entry`/`worker` 两个模式不同（那两个模式的
  `pi.appendEntry('nexttime_turn', {workspaceId, ...})` 需要它来关联 Turn）；每次内核调用都从
  Handle 自己的 `ws` claim 解出 workspace，不需要你显式传。忘了设它不会报错、也不影响任何调用。
- 不要把 `CAPABILITY_HANDLE` 写进 shell 历史或提交进任何文件——它是明文承载权限的 bearer token，
  等同于密码。

## 你会得到什么工具

跟 `entry` 模式**同一份**能力清单（design doc §7.4"同 entry"）：图的 observe 组
（`get_object`/`traverse`/`search`/`explain`/`get_task`/`state_at`）、`find_operations`/
`find_workers`/`find_procedures`、`invoke_worker`、`request_connection`、`record_decision`、
`propose_worker_definition`/`propose_operation`/`propose_skill`/`propose_procedure`/
`propose_ontology_change`，外加 `session_start` 时按你 Handle 的 `resources.gatekeeper`
动态发现的 `<gate>.<op>` 观察类工具（跟 `entry`/`worker` 用同一套 `gate-tools.ts` 命名规则）。

**跟 `entry` 模式不同的地方**（design doc §7.4"默认不回传"）：

- 没有 `report_turn`——你本机这个 `pi` 进程前面没有 `agent-host` 的 RPC 桥（那套机制才会给每条
  prompt 打上 `<!--nexttime:turn_id=...-->` 标记），内核里也就没有一个"Turn"可以回传结果；
  不会尝试也不会失败，直接不调用。
- 没有 `agent_start`/`agent_end`/`agent_settled` 订阅，不写 `pi.appendEntry('nexttime_turn',
  ...)`——同样是因为没有 Turn 需要关联。
- `context` 事件仍然会注入 `get_entry_context`（待审批 / 进行中任务 / 相关 Fact）——这个读能力
  只按你的 Principal 走，跟 Turn/Chat 无关，`interactive` 模式一样有意义、一样会注入。

## 排障

| 现象 | 原因 |
|---|---|
| pi 启动就报 `NEXTTIME_MODE`/`KERNEL_URL`/`CAPABILITY_HANDLE` 未设置 | 三个环境变量都是必需的，检查拼写；`WORKSPACE_ID` 不需要设（见上）。 |
| 工具调用返回 `unauthorized`/401 | Handle 过期或被间接撤销（disable_principal 撤销了你的账号，或它绑定的 workspace 出了问题）——回到第 1 步重新拿一个。 |
| 某个工具报 `forbidden: ...` | 这个能力不在你 Handle 的 scope 里——回 `issue_handle` 那一步检查返回的 `scope` 字段，不是"发什么就给什么"（详见 `docs/howto-connect-claude-code.md`）。 |
| 想要的 `<gate>.<op>` 工具没出现 | 你在这个 workspace 没有对应门的 `connect_gatekeeper` Grant，或 `list_allowed_operations` 内部调用失败（内核日志里找 `interactive` 相关的错误行——`[nexttime:interactive] kernel call "list_allowed_operations" failed: ...`）。 |
| pi 报"扩展加载失败"/模块找不到 | 检查 `-e` 后面的路径是不是真的存在、是不是先跑过 `pnpm --filter @nexttime/shared build`（`platform-extension` 依赖 `@nexttime/shared` 的构建产物做类型解析，源码路径下 `development` export condition 会自动指回 `src/`，一般不需要单独 build shared，但排障时先确认一遍）。 |
