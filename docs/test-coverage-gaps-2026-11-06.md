# 测试覆盖缺口清单与"功能—测试同步"强制机制（2026-11-06）

状态：**方案**（本文件只盘点与设计，没有改任何代码、CI 或守卫）。实施按 §6 分批开 PR。
负责：测试守门人线程（长期在岗，见 §5.6）。

## 1. 背景与结论

v0.63.0 上主机后，维护者当天撞到三个 bug，而 CI（`guards / quality / test / web-e2e`）全绿：

| 现象 | 根因类型 | 为什么测试没拦住 |
|---|---|---|
| 「系统与授权」点授权后「成员」选不了（遗留 646，修复 #997） | **路径替身**：测试走的不是用户的路 | `journeys/01-entry-agent.spec.ts` 用 `getByTestId('ggf-member-select')` 直接对一个没有可见标签的 `<select>` 做 `selectOption`；用户操作的是标着「成员」的搜索框，那条路径没有任何测试 |
| 后端重启后前端连接不恢复（切到管理面 `connection_closed`） | **环境替身**：测试只在理想环境里跑（直接原因已确认：升级时 kernel / caddy 重建、旧标签页一直开着；与 G3 旧 bundle 的关系待核实） | 所有 e2e 都在全新启动、全程不中断的 fake 栈上跑；没有一个 spec 在页面开着时重启 kernel、断网或换版本 |
| 管理员智能体看不到能力包 | **投影缺失**：同一领域动作在各层的投影没人对账 | `list_packs` / `extra_packs_status` 是 `channel: human`，只投影到控制台；`ADMIN_TOOL_CAPABILITY_NAMES` 里没有任何能力包读能力。没有一张表要求"新 capability 必须声明它投影到哪些入口" |

**结论**：现有测试体系不弱（下节），问题是三类系统性盲区——①测试可以绕开用户的真实操作路径；②测试环境从不模拟"活着的系统"会遇到的扰动；③capability 在控制台 / API / agent 工具三层的投影没有声明，也没有对账。靠 PR 作者自觉补测试已经证明不可靠，要把"功能和测试同步"做成 CI 能拒绝的规则（§5）。

## 2. 现状：已经有什么（不重复建设）

| 层 | 已有 | 落点 |
|---|---|---|
| 领域单元 | `packages/shared` 转移表、注册表一致性（`assertRegistryConsistent`） | CI `test` |
| 内核集成 | DB-gated 套件；`roles.test.ts` 遍历 `CAPABILITY_REGISTRY` 做角色×capability 授权表 | CI `test` |
| 契约 | `pnpm contract:check`（capability / event 快照）、词表守卫、prompt-contract 守卫 | CI `quality` |
| 控制台 e2e | 39 个 spec，含 9 条旅程（`e2e/journeys/`）、`00-gates` 截图 / axe / 文案基线、`08-least-privilege` 四种角色走查 | `web-e2e`（必需检查） |
| 升级 | `staging.yml` 预演：`--from` 版本带数据跑 S3/S1/S2/S4 → apply → 目标版本全套验收（含会中断服务的 S12、S2）；`reversibility-probe.yml`：BASE 内核测试跑在 HEAD schema 上 | 迁移 / 部署相关 PR 自动触发 + 发版前手动 |
| 真实模型 | staging `--real`（云上的模型），主机窗口真实模型回归（主机的模型） | 手动 |
| 运维演练 | `drill-restore.sh` / `drill-upgrade.sh` / `chaos-kill-*.sh` | 只在主机，手动 |
| 控制台可用性 | DoD 六条底线、`disabled-reason` / `i18n-pairs` / `css-tokens` 守卫、UX 验收线程 | CI `quality` + 人工 |

## 3. 盘点方法

- 扫描对象：`docs/contracts/capabilities.json` 里 265 个具名 capability（不含 `<gate>.<op>` 两个模板行）。
- 控制台投影：`packages/web/src` 非测试文件里出现 `'<name>'`；agent 投影：`ontology/entry-agent.yaml` 的 `capabilities`、`modes/worker.ts`、`modes/admin.ts` 的 `ADMIN_TOOL_CAPABILITY_NAMES`；测试：内核 `*.test.ts`、web 单测、`e2e/`、验收脚本里出现该名字。
- 这是**静态名字匹配**，对 e2e 是严重低估（e2e 按 `data-testid` 操作，名字很少出现在 spec 里）。所以 §5.3 用运行时采集替代，本节 e2e 数字只作量级参考。

扫描结果（2026-11-06，main 3eab767）：

| 指标 | 数值 |
|---|---|
| capability 总数 | 265（observe 126 / 非 observe 139） |
| 有控制台调用方 | 246 |
| 投影到任一 agent（entry / worker / admin） | 54 |
| 内核测试没有引用 | 6：`deprecate_procedure` `list_capability_names` `mark_turn_outcome` `report_task_outcome` `set_default_modules` `set_user_budget` |
| 既无控制台也无 agent 投影 | 6：`install_module` `upgrade_module` `list_workspace_modules` `list_user_memberships` `register_source` `submit_observations`（大多是 CLI / collector 专用，需显式声明） |
| 非 observe 且有控制台入口 | 134，其中 e2e spec 里能找到名字的只有 37（低估，见上） |
| e2e 直接交互的定位方式（单行匹配，近似） | `getByTestId` 251 次、CSS `locator()` 102 次、`getByRole`/`getByLabel` 75 次、`getByPlaceholder` 9 次 |

最后一行是第一类盲区的量化：**这类直接交互的定位器调用中约 80% 不经过用户可见的角色或标签**（单行匹配，作为上限看）。

## 4. 缺口清单

优先级：**P1** = 已在主机上咬过人，或同类问题会再咬；**P2** = 有明确风险、尚未出事；**P3** = 改善项。

| # | 维度 | 现状 | 缺口 | 优先级 | 落点 / 审查 |
|---|---|---|---|---|---|
| G1 | 用户旅程 e2e 走真实路径 | 9 条旅程，但交互主要靠 testid / CSS id | 没有规则禁止"绕开可见控件"；同一字段存在两个控件时测试可以选错的那个（646） | **P1** | e2e 定位器守卫（§5.2）+ 旅程逐条改写；#488 + UX 验收 |
| G2 | 后端重启 / 断线恢复 | `WsClient` 有 R-63 重连；`connection_closed` 有中文文案；e2e 0 个中断场景；chaos 脚本只在主机 | 页面开着时 kernel 重启、短暂断网、caddy 重启，前端能否自动恢复或明确提示，无任何自动化断言 | **P1** | 新 e2e 项目 `resilience`（§5.4）；#488 + UX 验收 |
| G3 | 升级后旧前端 bundle | `packages/web/src` 没找到版本探测 | 主机升级后已打开的标签页继续跑旧 JS 调新内核；没有"发现新版本、请刷新"的机制，也没有测试。v0.63.0 当天切到管理面报 `connection_closed`，已确认是升级时 kernel / caddy 重建、旧标签页一直开着，那一刻浏览器所有请求都失败，F5 即恢复（修复在 #1003）；旧 bundle 是相关缺口，不是已证实的根因 | **P1** | 先产品决定（内核在握手里回版本、控制台比对提示刷新），再加 e2e；控制台 + #493 |
| G4 | capability 投影对账（控制台 / API / agent） | 2026-09-26 有一次性人工对账文档 `kernel-console-coverage-2026-09-26.md`，之后没人维护 | 新 capability 不需要声明投影到哪；admin agent 看不到能力包就是这样漏的 | **P1** | capability matrix + 守卫（§5.1）；#488（守卫）+ #493（如需内核改动） |
| G5 | 写操作的 e2e 覆盖 | 134 个有控制台入口的非 observe capability，e2e 覆盖面未知 | 没有"每个控制台写入口至少被 e2e 通过 UI 调到一次"的度量 | **P1** | e2e 运行时 capability 采集（§5.3）+ matrix 豁免棘轮 |
| G6 | 写操作幂等 / 重复提交 | 46 个内核测试文件提到 idempotent；没有系统性规则 | `grant_capability` 不去重（647）；没有"每个 write capability 重复调用一次行为确定"的遍历测试 | **P2** | 内核遍历测试：matrix 给每个 write 声明 `repeat: idempotent / conflict / creates`，测试按声明断言；#493 |
| G7 | 主机升级预演的起点 | staging 默认 `from` = 目标之下最新 tag；主机升级攒到大版本统一做一次（维护者 2026-11-06 决定），v0.50.0 → v0.63.0 那次维护者手动填了 `from`（staging run 452，绿） | 日常预演的 `from` 不需要等于主机版本（维护者决定，不做 CI 强制）；只有**主机升级前的那次预演**必须 `from` = 主机当前版本，目前靠人记得，`release.md` 没写成规则 | **P3** | `release.md` §1 第 5 步：主机升级窗口前的预演必须填 `from` = 主机当前版本，主机窗口检查表核对 run 名；#484 |
| G8 | 回滚演练 | `reversibility-probe` 证明旧代码能跑新 schema（空库）；`drill-upgrade.sh` 只在主机手动 | 云上没有"带数据升级 → 代码回滚到 n-1 → 验收"的预演 | **P2** | staging 加 `rollback` 阶段（升级后切回 `from` 镜像跑 S1）；#488 |
| G9 | 能力包全生命周期 | `install_pack` 有 e2e；`preview_pack_install` / `list_packs` / `extra_packs_status` / `export_admin_proposal_pack` 只有内核测试 + accept_s2 | 安装 → 升级（同包新版本）→ 回滚安装记录 → 导出 → 放进 `config/packs/` 导入 → 第二个工作区安装：没有一条控制台旅程；维护者"手动导出导入"仍待人工确认 | **P2** | 新旅程 `10-pack-lifecycle.spec.ts`；UX 验收 |
| G10 | 权限矩阵（含拒绝路径） | `roles.test.ts` 单元级遍历；`08-least-privilege` 只验"看得到的页不 403" | 没有按角色×写 capability 走真实 HTTP 的拒绝断言；没有"控制台对无权角色隐藏 / 禁用并说明"的遍历 | **P2** | 内核集成测试遍历 registry 经 dispatch 断言 403 + 审计记 refused；#493 |
| G11 | 审计 actor 正确性 | 审计写入在 `dispatch.ts`；遗留 644（`raw_secrets_scrubbed` 记 unattributed） | 没有"每个有副作用 capability 的审计行 actor = 实际调用者"的遍历断言。`set_admin_agent_targets` 记成 self 是对的（维护者本人在控制台保存）。真正的缺口（#1002 上 #484 指出）：管理员智能体在平台面的审计行，actor 也记成管理员本人，人和智能体的操作目前只能靠 `payload.channel` 区分；actor 应能直接区分人、管理员智能体会话与服务 Handle，并有遍历断言 | **P2** | 内核遍历测试（与 G10 同一夹具，调用后读 `audit_records` 断言 actor / 工作区 / outcome）；#493 |
| G12 | 多工作区隔离 | 37 个内核测试文件涉及跨工作区 | 没有"在 A 工作区建的每类对象，B 工作区的成员经任一 observe capability 都读不到"的遍历；没有 e2e 双工作区串读场景 | **P2** | 内核遍历测试 + e2e 一条双工作区旅程；#493 / UX |
| G13 | 真实模型与 fake-llm 差异 | fake-llm 场景脚本化；staging `--real` 用云上的模型，主机用主机的模型，两者不同 | 工具参数首次被拒 7 次（645），只在主机窗口才看到；云上跑不到主机的模型（付费预算只覆盖云上的模型） | **P2** | 不加付费跑：把"首次被拒率"做成主机真实模型回归的固定输出并设阈值；工具 schema 加一条"与 strict JSON schema 子集兼容"的静态检查；#481 |
| G14 | 备份恢复演练 | `drill-restore.sh` 只在主机；staging 只做文件探针 | 云上没有 `backup → 清库 → restore → 验收` 的完整一轮 | **P2** | staging 加 `restore` 阶段；#488 |
| G15 | 配置组合 | 新装默认 `ADMIN_AGENT_ENABLED=1`，老主机不自动翻；staging 预演强制打开 | "开关关着的升级主机"这条组合只在 S2 打一行 NOTE，没有断言控制台在关闭时的呈现 | **P3** | e2e 在 fake 栈加一个开关关闭的变体（或单测覆盖控制台分支）；UX |
| G16 | 会话过期 / 长开页面 | 没有测试 | 页面开很久、登录过期后第一个写操作的表现（是否丢输入、是否给出重新登录入口）未覆盖 | **P3** | 并入 G2 的 `resilience` 项目 |
| G17 | 列表规模 / 分页 | fixtures 数据量小 | 超过 `*_DEFAULT_LIMIT` 的列表、加载更多、筛选组合几乎没测（623 审计流被读操作占满即此类） | **P3** | e2e 种子加一个大数据量工作区；UX |
| G18 | flaky 被重试掩盖 | CI Playwright `retries: 1` | 第二次才过的用例不报警 | **P3** | e2e job 摘要列出 retried 用例并在 >0 时打 warning；守门人周报 |
| G19 | 测试文档漂移 | `docs/testing.md` 仍写 Playwright "opt-in、不在 CI" | 文档与 CI 不一致 | **P3** | 随 §6 批次 A 一起改；#484 |

## 5. 强制机制

原则：**声明在仓库里、观测由工具产生、二者不一致时 CI 拒绝**；已有缺口用棘轮基线（只减不增）承接，不要求一次补齐，也不允许新增。仓库已有同类先例（`i18n-pairs-baseline.json`、`legacy-ui-importers.json`、`reversibility-deltas.json`），新守卫沿用同一形态：`scripts/guards/<name>.mjs` + `<name>.test.mjs`，挂进 `ci:guards` 与 CI `quality`。

### 5.1 Capability matrix（G4 / G5 / G6 的根）

**领域模型**：一个 capability 就是一个领域动作；注册表（`packages/shared/src/capabilities.ts`）是它存在与授权的唯一事实源。控制台入口、`/api/cap/<name>`、agent 工具都是它的**投影**；测试是对投影的**证据**。matrix 记录的是"这个动作**应该**投影到哪里"——这是一个人要做的决定，不能从代码推出来，所以必须写下来。

文件：`docs/contracts/capability-matrix.yaml`（与契约快照同目录，变更在 PR diff 里可见，由守门人审查）。

```yaml
# 每个注册表 capability 一行，不允许缺省继承——新增一行就是一次显式决定
ratchet:
  console_unexplained: 10      # 下面 console 写「none: 待说明…」的行数，只减不增
  kernel_test_missing: 6       # 下面 kernel_test: missing 的行数，只减不增
capabilities:
  install_pack:
    console: required          # required | "indirect: <文件>" | "none: <理由>"
    agents: []                 # entry / admin 的子集，必须与代码里注册的工具一致
  deprecate_skill:
    console: "indirect: packages/web/src/components/CatalogPage.tsx"   # 经变量调用
    agents: []
  traverse:
    console: "none: agent 的图遍历；控制台的对象页用 get_object / state_at 呈现同样的关系"
    agents: [entry, admin]
```

`install_pack` 的 `agents: []` 本身就是决定：管理员智能体不调人用的 `install_pack`，读已装包走另开的 `agent_list_packs`（AA5g D1），加进去的那个 PR 会在矩阵里多一行 `agent_list_packs`，`agents: [admin]`。

守卫 `scripts/guards/capability-matrix.mjs`（读 `packages/shared/dist`，与词表守卫同前提；批次 A 实现 M1–M3、M5、R，批次 B2 实现 M4）：

| 规则 | 断言 | 拦住什么 |
|---|---|---|
| M1 | 注册表 ↔ matrix 一一对应（不缺不多） | 新增 capability 却没回答"投影到哪" |
| M2 | `console: required` ⇔ `packages/web/src` 非测试代码以调用 helper 的写法调它（`http.call('<name>'`、`call<T>('<name>'`、`useCapability*(http, '<name>'`）；文案、标签表、`can('<name>')` 权限探测、注释都不算。经变量调用的写 `indirect: <文件>`，守卫只核对该文件存在且以引号写着这个名字（不核对它真的被调用，那一层由人审查与批次 B 的运行时采集补上） | 声称有入口却没做；做了入口却没声明 |
| M3 | `agents` 等于 `modes/entry.ts` 的 `ENTRY_TOOL_CAPABILITY_NAMES` 与 `modes/admin.ts` 的 `ADMIN_TOOL_CAPABILITY_NAMES` 实际注册为 pi 工具的集合（扩展自己调的 `get_entry_context` / `report_turn` 与经投影门工具到达的 `observe_operation` 在 Handle 天花板上、不是工具，不算）（Worker 的工具按 WorkerDefinition 在 ceiling 内声明，不是固定集合，暂不进矩阵） | agent 工具面与声明漂移（能力包那一类） |
| M4 | 非 observe 且有控制台入口（`console: required` 或 `indirect:`）的行必须写 `e2e: observed` 或 `e2e: "waived: <遗留编号>"`，其他行不许有 `e2e`（静态半边，`quality`）；`web-e2e` 末尾按 §5.3 的采集核对：`observed` 的行本次必须有页面调到且返回 ok，`waived` 的行若被页面调通必须改成 `observed` 并调低棘轮（运行时半边）。waived 计入棘轮 `e2e_waived`，存量记遗留 657 | 新写入口不带 e2e 就合并；e2e 不再走到某入口却没人发现 |
| M5 | `kernel_test: missing` ⇔ 没有内核 `*.test.ts` 写着这个名字（补了测试却不删豁免也失败） | 内核实现没有任何测试 |
| R | `ratchet:` 两个数必须等于实际计数：新增豁免要在同一 diff 里调高并由审查同意，修掉一个必须调低 | 豁免悄悄变多 |

M1–M3、M5、R 与 M4 的静态半边是纯静态检查，在 `quality` 与 `pnpm ci:guards` 里跑；M4 的运行时半边在 `web-e2e` 末尾（`--e2e-observed`）。初版 matrix 由 `node scripts/guards/capability-matrix.mjs --bootstrap` 从当前代码扫出（保留已有理由），41 行没有控制台调用的 capability 里 31 行人工写了理由，剩 10 行「待说明」进棘轮。G6 的 `repeat` 字段随批次 D 加。

**为什么不把这些字段加进注册表本身**：注册表是线上契约（快照进 `docs/contracts/capabilities.json`），投影意图和测试豁免会频繁变，混进去会让契约快照随测试状态抖动；独立文件 + 双向一一对应的守卫，强度与"必填字段"等价。

### 5.2 e2e 定位器守卫（G1）

规则（`scripts/guards/e2e-locators.mjs`，扫 `packages/web/e2e/**/*.ts`）：

- **交互动作**（`click` / `fill` / `selectOption` / `check` / `uncheck` / `press` / `type` / `setInputFiles`）的目标必须由 `getByRole` / `getByLabel` / `getByText` / `getByPlaceholder` 取得。`getByTestId` 与 CSS `locator()` 只允许用来**圈定范围**（如 `drawer.getByRole('combobox', { name: '成员' })`）和**断言**。
- 禁止 `page.locator('#…')`、`locator('option…')`、`locator('input[type=…]')` 后直接交互。
- 现有违规按"文件:行内容哈希"进基线，只减不增；改到的文件里的旧违规不强制当场修，但守门人会在 PR 里指出。

与现有 DoD「e2e 用 data-testid 定位」的关系：DoD 那一条的本意是**不用易变的文案和样式类做定位**，它仍然成立于圈定范围和断言；本守卫补的是"最后被点的那个控件必须是用户能看见、读屏能读出名字的那个"。两条一起改进 `docs/console-usability-dod.md` 与 PR 模板措辞，避免两份规则互相矛盾。附带收益：交互控件拿不到可访问名字时测试写不出来，等于把 a11y 标签变成了硬要求——646 的那个无标签 `<select>` 在这条规则下根本无法被测试使用。

### 5.3 e2e capability 调用采集（G5）

- `e2e/lib/test.ts`：`test = base.extend(...)`，自动 fixture 在 browser context 上记录 `POST /api/cap/<name>` 的响应与对话 WebSocket 上 JSON-RPC 请求的应答（`authenticate` 不算），每个测试把 `{name, via, ok, status}` 逐行写进自己输出目录的 `test-results/<test>/cap-calls.jsonl`。测试自己伪造的应答（`route.fulfill` 没有服务器地址；`routeWebSocket` 之后开的 socket 整条不区分转发与伪造）记成 `via: "stub"`，守卫不计入——"用户能从界面完成"要求真实内核回答了它。
- 守卫规则 E1（`scripts/guards/e2e-fixture.mjs`，`quality` 与 `pnpm ci:guards`）：`packages/web/e2e` 下除 `lib/test.ts` 外不得从 `@playwright/test` 取值 `test`（含 `test as x`、命名空间 / 默认导入、`require`、动态 `import()`）；类型与 `expect` 不限。存量一次性机械替换 40 个文件。规则 E2（同一守卫）：在页面里执行的代码（`evaluate` / `evaluateHandle` / `evaluateAll` / `$eval` / `$$eval` / `addInitScript`）不许写 `/api/cap`，否则绕过界面的调用会被当成页面发出的记下来。
- `web-e2e` 末尾：`node scripts/guards/capability-matrix.mjs --e2e-observed packages/web/test-results` 汇总"经 UI 成功调到过"的集合，按 M4 逐行核对（一个 `cap-calls.jsonl` 都没有直接失败）；`test-results/` 随 playwright-report 产物上传，作为覆盖报告。只在全部 spec 通过时跑（有失败时缺调用是噪声）。
- 只统计页面发出的请求，测试辅助代码绕过 UI 直接调 API 的不算——这正是我们要的语义："用户能从界面完成这个动作"。

### 5.4 resilience 项目（G2 / G16，G3 定案后并入）

- Playwright 新项目 `resilience`，排在最后跑（沿用 `playwright.config.ts` 已有的按项目钉顺序做法），只在 CI 设了 `E2E_RESTART_KERNEL_CMD`（`docker compose restart kernel`）时启用，本地缺省跳过。
- 场景：①对话页与一个列表页开着 → 重启 kernel → 断言 N 秒内页面自动恢复（下一次写操作成功、推送重新到达），或出现带"重新加载"按钮的中文提示，二者之一，不允许静默失效；②`context.setOffline(true/false)` 模拟断网；③切换工作区 / 切到管理面恰好在重启窗口内（复现主机上的 `connection_closed`）；④登录过期后第一次写操作给出重新登录入口且不丢已填内容。
- 成本：重启约 20 秒，项目总时长预计 2–3 分钟，在 `web-e2e` 20 分钟预算内。
- 实现（批次 C1）：Playwright 项目 `resilience`（`packages/web/e2e/resilience/`）排在 `chromium-login` 之后；`web-e2e` 写 `$RUNNER_TEMP/restart-kernel.sh`（`docker compose up -d --no-deps --force-recreate kernel`，和主机升级一样换掉容器而不是原地 restart；等 caddy 的 `/api/health` 回 200 才返回；套件之后再确认 gate-host 仍 healthy）并以 `E2E_RESTART_KERNEL_CMD` 传给 spec，未设置则整文件跳过。已覆盖场景①的两种会话：API key 会话的对话页、密码（cookie）会话的列表页，各自断言重启期间连接状态显示「重连中 / 已断开」、不刷新页面自行回到「已连接」、之后的下一次写操作（发消息 / 新对话）拿到推送的回复，且历史不丢不重。②断网（Chromium 的 `setOffline` 不关已建立的 WebSocket，要换成经 caddy 的断流手段）、③重启窗口内切换工作区 / 切面、④会话过期留给 C2。
- 实现（批次 C2）：再加两个脚本——`E2E_STOP_KERNEL_CMD`（`docker compose stop kernel`，spec 在 `finally` 里用重启脚本拉回）与 `E2E_EXPIRE_SESSIONS_CMD <login>`（把该登录名未撤销的 `user_sessions` 置为已过期，一行都没改到就失败）。新增两个用例：内核停着时按发送——出现「连接已断开」的错误、输入框里的字还在、不出现用户消息，恢复后重发只出现一轮；打开的对话页底下会话过期——下一次发送回到登录页（不是一张不响应的页面），重新登录可用。C1 的恢复断言补上文字「已连接」。会话过期后草稿丢失、登录页不说明原因，记遗留 658（控制台）；用例只断言回到登录，修好后在同一用例里加断言。②断网与③切换工作区仍待做：③需要一个属于两个工作区的所有者，与 `workspaces.spec.ts` 的数据安排一起做。

### 5.5 PR 模板「测试覆盖」一栏

在 `.github/PULL_REQUEST_TEMPLATE.md` 检查清单里加一项（并把现有「e2e 定位器」一项改成与 §5.2 一致）：

> - [ ] **测试覆盖**：新增 / 改变的每个用户可见动作，列出覆盖它的测试（内核测试、e2e 旅程或 spec）。改了 capability 的，同一 PR 更新 `capability-matrix.yaml`；需要豁免的写明遗留编号。e2e 的交互按可见角色 / 标签定位。

模板只是提示，真正的拦截在 M1–M5、E1 和定位器守卫。

### 5.6 守门人流程（长期）

- 每个功能 PR（触及 `packages/*/src`、`ontology/`、`packs/`）：核对 matrix 变更是否合理（尤其 `agents: []` 与 `console: none` 的理由）、新写入口是否被 e2e 经 UI 调到、交互定位是否走可见控件；缺了在 PR 里给出具体缺哪条测试，不代写。
- 每周一次：读 `web-e2e` 的覆盖产物与 retried 列表，基线能收紧就开 PR 收紧（棘轮往下拧）。
- 补测试按 §6 批次开 PR，并发不超过 3。

### 5.7 内核遍历测试（批次 D，G6 / G10 / G11 / G12）

按注册表遍历，不按 capability 点名：新注册的 capability 自动被走到。

- **D1（G12，已落地）** `packages/kernel/src/application/gateway/workspace-isolation-traversal.integration.test.ts`：工作区 A 经 `new_chat` / `rename_chat` 建一个对话，再写入一个 Gatekeeper、一个已发布 Operation 和一个待审批 ActionRequest，每一行的可见字段都带一个唯一标记串。B 的 owner（最宽角色）经 `dispatchCapability` 调全部工作区 `observe` capability，跑两遍。第一遍不带参数，答复里不得出现标记、A 的工作区 id 或 A 的任何行 id。第二遍按参数 schema 把 id 形字段（`chatId`、`gatekeeperId`、`objectId`、`entityId` 等）指向 A 的行，自由文本参数（搜索词、名称过滤）填标记的前半段，让跨工作区的搜索能命中 A 的行，而被查的完整标记从不出现在参数里。第二遍里，答复不得出现完整标记或 A 的工作区 id，成功的答复里也不得出现 A 的任何行 id（一个只回 `{id, status}` 的串读不带标记）；错误信息可以回显本次调用自己传入的 id（例如「某 id 不存在」），但不得出现其他 A 的 id。审计组的读（`group: audit`）不查行 id，因为 B 的每次调用都按原参数审计进 B 自己的审计表，审计读回显的是 B 问过什么的记录，不是 A 的数据。两遍都同时查结果和错误：被拒或失败的调用，按 `mapCapabilityError` 得到客户端实际收到的 message 和 details，做同样的检查。调用可以失败，失败不算泄漏，但两遍合计至少要有 50 个 capability 正常答复（今天是 64 个）。同一遍历以 A 的 owner 跑一次作正向对照：`list_chats`、`list_gatekeepers`、`list_pending`、`get_object`、`get_action` 和按前半段搜索的 `find_operations` 必须读到标记，证明种子可达、检查会触发。e2e 双工作区串读旅程仍待做（UX）。#493 审查提的后续项（不阻塞）：存在性旁路对照（A 的 id 与随机 uuid 两次结果比对）、Handle channel 各走一遍、更多种子（Skill、WorkerDefinition、Fact、task、goal、change segment、memory）、`security definer` 函数设闸的静态检查。
- **D2（G10，已落地）** `role-refusal-traversal.integration.test.ts`：一个工作区里五个角色各一个 Principal，并按 D1 的方式造好数据。对每个工作区 capability（不含平台面和 `adminAgentOnly`）× 每个 `roleMayUseCapability` 不放行的角色，经 `dispatchCapability` 调用，参数按 schema 指向真实的行。每次调用都必须抛 `ForbiddenError`，且错误信息点名该角色；今天共 325 对，下限 100。整轮遍历前后，对工作区在 62 张带 `workspace_id` 的表里的全部行各做一次摘要，前后必须一致，即没有写入、没有审计行、没有 outbox 事件。角色拒绝今天不写审计，本测试把这一点钉住；是否该记一条 `refused` 审计，交 D3 由 #493 定。放行一侧不遍历：用编造的参数以有权角色调每个写，只会白跑真实 handler。
- 两个测试共用 `traversal-fixture.ts`（造工作区、造数据、按 schema 生成参数、工作区摘要），D3 / D4 接着用。

## 6. 分批路线

| 批次 | 内容 | 关闭缺口 | 审查 | 前置 |
|---|---|---|---|---|
| A | matrix 文件 + `capability-matrix.mjs`（M1–M3、M5，含 `--bootstrap`）+ 基线 + PR 模板一栏 + `testing.md` 订正 | G4、G19，G5/G6 的骨架 | #488（守卫 / CI）、#484（文档） | 本方案确认 |
| B | e2e 定位器守卫 + 基线；`e2e/lib/test.ts` 采集 fixture + E1；`web-e2e` 末尾核对 M4 | G1、G5 | #488；UX 验收（触 `packages/web/e2e`） | A |
| C | `resilience` 项目（重启 / 断网 / 切面 / 会话过期） | G2、G16 | #488 + UX 验收；如需改重连逻辑走控制台 PR | B 的 fixture |
| D | 内核遍历测试：角色×写 capability 经 dispatch 的拒绝路径 + 审计 actor / outcome + 重复调用按 `repeat` 声明断言 + 跨工作区读隔离 | G6、G10、G11、G12 | #493 | A（读 matrix 的 `repeat`） |
| E | 旅程 `10-pack-lifecycle`；旧旅程按定位器守卫改写（先 646 所在的 01、06、08）；遗留 657 里先补所有者关键动作的真实旅程：`confirm_goal`、`release_goal_hold`、`revise_goal`、`publish_operation`、`refresh_operation_governance`（B2 之前只被伪造应答走到过，见 §5.3） | G9、G1 存量、G5 存量 | UX 验收 | B |
| F | staging 加 rollback 与 restore 阶段；`release.md` 写明主机升级前那次预演的 `from` = 主机当前版本（日常预演不限） | G7、G8、G14 | #488、#484 | 无 |
| G | 产品决定后：前端版本探测 + e2e | G3 | 控制台、#493 | 维护者 / 协调定 |
| — | G13、G15、G17、G18 | — | 随相关波次 | — |

A、F 可以马上并行；B 依赖 A 的 matrix；C、E 依赖 B 的 fixture；D 独立于 B。

## 7. 风险与不做的事

- **基线变成垃圾场**：豁免只减不增，新增豁免必须改基线文件并带遗留编号，守门人在 PR 里逐条问。
- **守卫误报拖慢开发**：所有守卫先带自测（`*.test.mjs`），首版只对新增代码生效；静态扫描规则保持保守，宁可漏报靠守门人补，不做猜测性拦截。M2 只认调用 helper 的写法，经变量调用的要人写 `indirect:`，这是有意的：宁可让作者多写一行，也不让文案里出现的名字被当成入口。
- **matrix 声明与真实意图脱节**（填表应付）：M2、M3 是双向一致性检查，填错会直接失败；`none:` 的理由由守门人审查。
- **CI 时长**：`resilience` 约 2–3 分钟；遍历测试在已有 DB 套件里，增加量级为秒到分钟。
- **不做**：不引入 mutation testing、不加第二个浏览器、不在云上跑主机的模型（付费预算只覆盖云上的模型，G13 用主机回归的固定输出代替）。

## 8. 待核实

1. G3：旧 bundle 无版本探测是否需要单独修（#1003 修的是断线后的恢复；版本探测是否另做由协调 / 维护者定）。

已核实（2026-11-06）：G7 的 v0.63.0 预演 `from` = v0.50.0（staging run 452，绿）；G11 的 `set_admin_agent_targets` 记成 self 是正确行为（维护者本人操作），缺口改为 #1002 指出的平台面智能体审计行 actor 记成管理员、只能靠 `payload.channel` 区分。
