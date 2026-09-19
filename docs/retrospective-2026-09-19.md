# 阶段回顾（2026-09-19）：S6 控制台完善（无人值守实施）

> 本文记录 S6 一次无人值守实施的范围、验证数字、暴露的边界与流程教训。方案与决定见
> `console-completion-plan.md`（§12 七项于同日取定），实现说明见 `development-tasks.md` §5c，进度与遗留见
> `STATUS.md` §3 / §4（本文只被它链接）。**本次产物是本地分支 `s6/console-completion`，未推送、未开 PR、
> 未合入、未发版、未应用到主机**——合入与发版由维护者决定。

## 1. 范围与结果

维护者要求"完成遗留问题并落实 `console-completion-plan.md` 已规划的全部任务"，无人值守。实施方式：主会话
读 STATUS / 方案 / 回顾后排出两波共十一条文件互斥车道（每条一个 git worktree + 一个私有 Postgres 测试库），
车道并行实现、各自验证并提交；主会话审 diff（不审报告）、按序 cherry-pick 到集成分支、补车道间的接线（路由、
侧栏、错误映射、契约快照）、跑全量验证、统一写文档。

| 波次 | 车道 | 交付 | 关闭 |
|---|---|---|---|
| 1 | A0-visual | §5.9 令牌 / 字体 / UI kit / 壳 / CSP / `css-tokens` 守卫 | B1（显示侧）、B2 / B3（组件）、C13、C17、C21、C24 |
| 1 | A0-fixes | C 系列文件级修复、B6、C23 拆 `App.tsx`、W3 复现 | C1–C12、C14–C16、C18–C20、C23、B6 |
| 1 | K1-runtime | 遗留 44 / 42 / 43、B1 版本注入 | 44、42、43、B1 |
| 1 | K2-caps | 对话生命周期、`approve.reason`、审批过滤、审计分页、取消申请、`export_prov nodeId` | C25、C26、C27（内核半）、C28 |
| 1 | K3-purge | core 0030、`purge_workspace` / `purge_user`、列表过滤、`self_disable`、遗留 41、脚本 | A1 / A6（内核半）、C10（内核半）、41 |
| 2 | W-chat | W1 / W2 / W3 修复、内联 ApprovalCard、双语、C22 | W1、W2、W3 |
| 2 | W-govern-a | 审批页、任务页、审计页、能力目录编辑器 | A2、A4、B2、C22、C25 / C27 / C28（页面半） |
| 2 | W-govern-b | 工作区 / 用户页清除与过滤、成员 / 访问 B3 / B4 / B7、概览横幅 | A1、A6、B7（TTL / 能力清单）、C17 余项 |
| 2 | C-connect | 接入启动器、实例 ↔ 连接互链、B7 状态语义、取消按钮、Explorer 探测 | A7、B7、C26（页面半）、§5.7 入口 |
| 2 | B-providers | llm-proxy 管理面、`issue_llm_admin_token`、平台页、C29、遗留 19 | A3（除密钥写入）、C29、19 |
| 2 | D-graph | 原生图谱页 | A5（首版） |

方案 §11"最小当前版本"六条全部达成（本地）；§10 五个波次全部落地。**没有做的**：控制台写供应商密钥
（维护者待决，见 §4）；主机侧任何事。

## 2. 验证数字（本机，集成分支）

（由主会话在全部车道合入后一次运行，测试库为全新库；数字在 §2.1 由实际输出填入。）

### 2.1 全量（集成分支最终提交，全新测试库 `nexttime_test_final`）

- `pnpm -r build` ✓、`pnpm -r lint` ✓（12 包）、`pnpm -r typecheck` ✓、`pnpm depcruise` ✓（478 模块 / 2413 依赖，
  第一次跑出 1 条违规：S6-B 的内部路由直接引 `substrate/audit`，已把写入挪到 `application/platform/llm-admin-audit.ts`）、
  `pnpm ci:guards` ✓（纯度 / pi 版本 / Handle 通道清单（加了 `purge_workspace` / `purge_user` /
  `issue_llm_admin_token`）/ 词表 / prompt 契约 / 脚本 LF+x / 新增 `css-tokens`）、`pnpm contract:check` ✓。
- 全包 `vitest`：web **89 文件 / 570 用例**（基线 46 / 268）；kernel **131 文件 / 1400 用例**（基线 123 / 1336）——
  全量并行时 `application/outbox/dispatcher.integration.test.ts` 两例 5 s 超时，隔离重跑 3/3；llm-proxy 14 / 119
  （基线 8 / 74）；agent-host 6 / 81（78）；platform-extension 10 / 95（87）；shared 17 / 275（266）；worker-supervisor
  11 / 227；egress-proxy 7 / 127；gatekeeper-base 17 / 138；两个打包门 29 + 28；collector 10 / 98。
- 已知负载敏感文件（`interfaces/ws/server.test.ts`、`application/outbox/dispatcher.integration.test.ts`）在并行
  车道跑测试时会超时，隔离重跑全过；`reaper.integration.test.ts` 的 crash-gap 用例在复用的测试库上会撞上其它
  文件遗留的 `running` Task（遗留 51），全新库通过。
- **Playwright e2e 在本机 compose 栈上跑了全套**（`.github/workflows/e2e.yml` 的步骤原样搬到本机：`.env` 取
  `deploy/ci/env.ci.template`，`host-bootstrap.sh` / `host-env-init.sh` / `gen-handle-keys.sh` 在 root 辅助容器里跑
  （本机无免密 sudo），构建 kernel / caddy / llm-proxy / gate-host / fixture-mcp，播种门实例、admin 密码、工作区、
  operator、两条 ActionRequest）：**36 / 36 通过**（含 S6 新增的 chat 生命周期、workspaces 残留预设 + 清除流程、
  integrations 启动器、explorer 显隐严格检查、tasks / catalog / audit / graph）。首轮 35 / 36：`catalog.spec.ts`
  的"新发布的 Skill 出现在我的智能体"断言没先取消"继承"（继承时清单不渲染选项）——测试过度断言，已修，复跑通过。
  之后 `scripts/accept_s1.sh --lite` 13 PASS + 6 SKIP（与 CI 同形）。栈上抽查：caddy 已发 CSP / Permissions-Policy，
  `/api/llm-admin/*` 无 `X-Requested-With` 403、无 token 401（llm-proxy 带 S6-B 新挂载启动正常），`/explorer/`
  占位页被探测到，容器内 `KERNEL_VERSION = v0.13.2 (dea136b)`。

### 2.2 契约

`docs/contracts/capabilities.json` 三次再生：+4 能力（`archive_chat` / `unarchive_chat` / `rename_chat` /
`cancel_connection_request`）+ `purge_workspace` / `purge_user` + `issue_llm_admin_token`；`list_chats` /
`approve` / `list_action_requests` / `audit_query` / `export_prov` / `list_workspaces` / `list_users` 参数扩展；
`ChatWire` / `ActionRequestWire` / `PlatformWorkspaceWire` 加字段。`events.json` 不变。

## 3. 实现时暴露的边界（与方案假设不同的地方）

1. **遗留 44 的根因不在 supervisor**。方案与 STATUS 都写"spawn 路径先重建再派发"；实际 `resident-service.ts` 的
   `spawn()` 本就在返回新容器 id 前完成 stop → remove → createAndStart，`reconcile()` 从不停容器。缺口在
   agent-host：`handleContainerClosed` 只按 principal 查 Turn，把旧容器（正在被同一次 spawn 替换）的流关闭记到
   尚未派发的新 Turn 上。修法是 Turn 绑定容器 id。教训与 09-18 回顾 §2.3 相同：**状态机的边是事实**，先读
   派发路径再改。
2. **`get_action` 对 Worker 不可达**（human-only、`minRole: operator`），遗留 43"轮询 `get_action`"不成立，改为
   prompt 契约"结果以 ActionRequest 状态为准"；且 #211 之后 I16 已是单条拒绝而非 403，遗留 42 的"回显 403"改为
   回显 `factsRejected`。
3. **`export_prov` 不是审计范围导出**，是围绕一个节点的 PROV 图；方案 §6 把两者混了。审计页"导出本页"由前端序列化。
4. **owner 归档他人 Chat 只达 RLS 已可见的 Chat**；私有 Chat 对 owner 是 404，覆盖它要放宽隔离——记为遗留 45
   交维护者，未自行做。
5. **`traverse` 渲染不了 Fact 行**（线上只有 id、无 `direction`），图谱页改用 `state_at`，顺带得到时间旅行；
   一批内核缺口记为遗留 48。
6. **C29 的前提过时**：`QuotaListEntryWire` / `PolicyWire` 早已公开，只是页面没用。
7. **S6-B 的写路径要 `config/` 可写**：llm-proxy 原子重写 `models.json` 需要目录 rw（rename 不能覆盖单文件
   bind），因此 `config/` owner 改 10001（遗留 50 交维护者取舍）。
8. **`reason_required` 一度是 500**：车道在 `decide.ts` 抛了新错误类，两个传输层的 `instanceof` 映射在车道外；
   合入时补。同类：`ChatArchivedError`（主会话补的内核侧拒绝）。**新错误类必须同 PR 落传输层映射**。

## 4. 待维护者决定

1. **S6-B 密钥写入**：控制台写供应商密钥是否属于"触及有凭证系统的动作必经审批"。代码里没有任何路径接受密钥
   （501 stub）。P-B2a"页面直接录入门凭证"是既有先例，本次没有据此推断。
2. **镜像发布**（S5.8 第 4 项重评），本次未动。
3. **遗留 45**（owner 归档私有 Chat）、**遗留 50**（`config/` owner）。
4. **合入策略**：分支有 100+ 个 Conventional Commits（按车道分组、可按车道 squash）；`pnpm-lock.yaml` 只因三个
   @fontsource 包变动；两条迁移（core 0030 / 0031）可加可空。

## 5. 流程教训

- **文件互斥 + 私有测试库 + 主会话接线**跑通了十一条车道零代码冲突；唯一冲突是 `docs/runbooks/web-console.md`
  的能力对照表（三条车道各改一行）。车道外的接线（路由、侧栏、错误映射、契约快照、e2e `fixme`）由主会话统一做，
  比让车道互相等待便宜。
- **共享测试库跨运行累积状态**会制造假阳性（遗留 51）；全量验证要用全新库。并行车道让两个负载敏感文件必然超时，
  隔离重跑是常规而不是异常。
- **报告不是 diff**：车道报告里"已应用在车道外"的改动（例如测试标签）要在 diff 里核实；一处车道报告的"页面接入
  排在 S6-A web 波次"措辞在集成后仍留在 runbook 里，靠合入后统一改写。
- **无人值守下"需要人决定"的边界**：凡是触及三条设计底线解释的（密钥写入、隔离放宽），记为阻塞并继续其它工作，
  不据先例推断；凡是产品语义级的小取舍（TTL 缺省、402 vs 429、`lost` 保留启用按钮），车道自行决定并在报告里
  标注，主会话写进 §5c 供否决。

## 6. 运行记录（主会话，集成分支最终一次）

顺序：`pnpm -r build` → `pnpm -r lint` → `pnpm -r typecheck` → `pnpm depcruise` → `pnpm ci:guards` →
`pnpm contract:check` → `DATABASE_URL=<全新库> KERNEL_VALIDATE_RESULTS=1 pnpm -r test`（数字见 §2.1）→ e2e 栈
构建与 36 例 Playwright → `accept_s1.sh --lite`。全部在 2026-09-19 本机完成，产物未推送。集成分支上主会话自己的
提交（车道之外）：字体不内联 + CSP `font-src 'self'`、演练脚本导出 `KERNEL_VERSION`、C13 单测、a0-fixes 的车道外
收尾（mcp 建实例测试、最后一处 B6、`describedBy`、shell `user`）、`reason_required` 与 `chat_archived` 的传输层
映射、归档 Chat 拒绝发送、契约快照 ×3、路由 / 侧栏 / 深链接线 ×3、S6-B 守卫与验收覆盖、depcruise 分层修正、
e2e 断言修正、文档。
