# release.md 归档：§3.133–§3.220 主机步骤（0.64.0 到 0.70.1，2026-11-27 移出）

> 2026-11-27 从 `../runbooks/release.md` 原文搬来，节号与标题不变，内容未改一字。文中的相对链接以原文件所在的 `docs/runbooks/` 为基准。主机升级读的是**目标 tag 上**的 release.md，这次搬动不影响已发版本的步骤。主机 2026-11-27 已升到 v0.70.1，这些步骤都走过了。

### 3.133 `propose_goal` 的描述写清验收放哪、路径是 JMESPath（#1000，遗留 645，0.64.0 起）

只改工具描述：没有迁移，不改 compose，没有新环境变量，线上契约 schema 不变（只改 `propose_goal` 的 description）。

- **发版说明可写**：`propose_goal` 的描述先写清参数（`statement`、`budget`、可选 `idempotencyKey`，`plan` 与 `fromProcedure` 恰好一个）、验收放在 `plan.acceptance`（放顶层会被拒）、plan 里所有 path 都是 JMESPath（如 `state`、`data.items[0].id`，不是带 `$` 的 JSONPath）。校验行为不变，这两种写法本来就会被拒，现在模型事先就知道。
- **主机升级步骤不变**。效果看下一次真实模型回归 goal 场景的首次被拒次数。
- **回滚**：只回滚代码。

### 3.134 切换工作区连不上平台时提供「刷新并进入」，`/ws` 认证记日志（#1003，遗留 649，0.64.0 起）

控制台与内核日志：没有迁移，不改 compose，没有新环境变量，线上契约不变。

- **发版说明可写**：切换工作区时如果是传输层失败（`connection_closed`，平台并没有拒绝），提示不再自动消失，带「刷新页面并进入「X」」按钮，点了把 X 设为本标签页的工作区再刷新；内核拒绝（forbidden 等）不出这个按钮。内核 `/ws` 每次 authenticate 记一行结果（`success` / `refused` / `too_late` / `error`）和耗时，超时关闭、没认证就关闭的 socket 记关闭码与 `authenticated:false`；意外错误只记错误名和 SQLSTATE，不记 message。
- **主机**：升级后可以用内核日志里 `"ws":"authenticate"` 的行复核切换问题。日志量随 `/ws` 连接数增加（每次认证、每次关闭各一行）。
- **回滚**：只回滚代码。

### 3.135 「系统与授权」授权时「成员」是可搜索的下拉框，已授权的成员不能再选（#997，遗留 646，0.64.0 起）

只改控制台：没有迁移，不改 compose，没有新环境变量，线上契约不变。

- **发版说明可写**：授权抽屉里的「成员」就是一个可搜索的下拉框（点开看全部成员、输入缩小范围、点选或回车选中），内部服务主体不列出；门上已有有效授权的成员标「已授权」、不能再选（系统卡片和接入向导第 3 步都是）。删掉了必然 400 的「全部门（含未来新增）」。内核侧授权仍不去重（遗留 647）。
- **回滚**：只回滚代码。

### 3.136 单独跑验收脚本后停掉 fake-llm（#1001，遗留 643，0.64.0 起）

只改验收脚本和 runbook：没有迁移，不改 compose，没有新环境变量，线上契约和运行时都不变。

- **发版说明可写**：单独跑 `accept_s1` / `accept_s2` / `accept_s3` 时，脚本把 llm-proxy 恢复回生产供应商之后，会把它为验收起的 fake-llm 停掉，不再一直开着（fake-llm 是不带认证的测试端点）；停不掉时只打一行 WARNING，不让验收失败。`apply-release.sh` 里连着跑的 S3→S1→S2→S4 不受影响（staging 预演 34/0、25/0、195/0、17/0，`acceptance-fixtures none left running`）。
- **主机升级步骤不变**。
- **回滚**：只回滚脚本。

### 3.137 管理员智能体能看到能力包、提议所有者安装（#1002，S11 AA5g，0.64.0 起）

带一个迁移，随 `apply-release.sh` 自动应用：governance `0040_pack_installs_from_admin_proposals`（可逆，见 §6）。不改 compose，没有新环境变量，主机不需要操作。线上契约新增：管理员智能体能力 `agent_list_packs`（只读）与 `propose_pack_install`，`install_pack` 多一个可选参数 `adminProposalSegmentId`，以及两个新的 409 错误码：`admin_proposal_segment_is_pack_install`（把装包段当普通段预览或应用）、`admin_proposal_pack_mismatch`（安装与段请求的包、版本或摘要不一致）。

- **发版说明可写**：平台管理员的管理员智能体能列出部署里的能力包，并向某个工作区的所有者提议安装其中一个（一份只有工作区段、段里只有一项 `pack_install` 的管理员提案）。所有者在提案里或「能力包」页安装，两条路径是同一个 `install_pack`、同一套权限；装完提案记为已应用，安装记录能回到提案。装不了时（包已不在、版本已不是最新、已在「能力包」页装上）只能拒绝，控制台写明原因。装进来的内容仍记 `origin: human`（它是部署的包，不是智能体写的）。
- **主机**：`ADMIN_AGENT_ENABLED` 已在主机上打开，所以升级后主机的管理员智能体就能用这两个新工具；不打开时没有影响。
- **回滚**：只回滚代码即可，见 §6 的 0040 一行。

### 3.138 审计行记下经由什么做的，被拒的 Handle 调用写审计（#1028，批次 D3，0.64.0 起）

带一个迁移，随 `apply-release.sh` 自动应用：core `0054_audit_acting_through`（可逆，见 §6）。不改 compose，没有新环境变量，主机不需要操作。线上契约：`audit_query`、`platform_audit_query`、`platform_overview` / `platform_status` 的 `recentAudit`、`reconstruct` 返回的审计行多 `actingThrough` 与 `actingSessionId`（可为 null）。

- **发版说明可写**：审计记录现在写明每条操作是人本人做的，还是经由管理员智能体、入口智能体、Worker、服务或成员的 Handle 做的，或是系统自己的后台工作。智能体被拒绝的调用也会进审计，每个会话每种拒绝每小时最多 20 条，其余只计数。升级前的旧记录这一项为空。
- **控制台**：新字段暂不显示，见遗留 666。
- **回滚**：只回滚代码即可，见 §6 的 0054 一行。

### 3.139 重复停止不再改写停止请求时间（#1031，批次 D4，0.64.0 起）

内核一行 SQL 条件：`requestTurnStop` 只在尚未请求过停止时写 `metadata.stopRequestedAt`，第二次 `stop_agent` 保留第一次的时间。读这个字段的地方只看键是否存在，行为不变。没有迁移，不改 compose，没有新环境变量，主机不需要操作。

- **发版说明**：不必单写，用户看不到区别。
- **回滚**：只回滚代码即可。

### 3.140 技能、流程、目标计划编辑器在会话过期时保留没保存的内容（#1029，遗留 662，0.64.0 起）

只改控制台。会话过期时，这三个编辑器里没保存的内容存在本标签页（按身份隔离，换人登录清掉上一个人的），重新登录后回到同一编辑器并恢复；在抽屉里放弃编辑会清掉草稿。没有迁移，不改 compose，没有新环境变量，主机不需要操作。

- **发版说明可写**：编辑技能、流程或目标计划时登录过期，重新登录后会回到原来的编辑器，没保存的内容还在。
- **回滚**：只回滚代码即可。

### 3.141 两个审计页显示「经由」并能按它筛选（#1035，遗留 666 第一部分，0.64.0 起）

控制台加内核查询：没有迁移，不改 compose，没有新环境变量，主机不需要操作。线上契约：`audit_query` 的 `filter.actingThrough` 与 `platform_audit_query` 的 `actingThrough`（可选，只增）；「管理员智能体」筛选同时收 `acting_through` 为空、负载里标着管理员智能体代为的旧行（#1028 之前写下的）。

- **发版说明可写**：工作区与平台两个审计页每行显示「经由」（本人、管理员智能体、入口智能体、Worker、服务、成员 Handle、平台后台任务；升级前的旧行显示「未记录」并说明原因），并能用下拉在服务端按它筛选。
- **已知问题**：还不显示是哪个 Handle、被拦下的行还不写具体原因（遗留 666）；选「本人」时第一页可能全是被隐藏的读操作（遗留 669）。
- **回滚**：只回滚代码即可。

### 3.142 被拦下的审计行写出原因，Worker 与服务账号的行写出名字（#1038，遗留 666 第二部分、670，0.64.0 起）

控制台加内核查询：没有迁移，不改 compose，没有新环境变量，主机不需要操作。线上契约：`AuditRecordWire` 新增 `actingName: string | null`（`audit_query` 与 `reconstruct` 的结果，只增）；Worker run 的行取 Task 固定版本的 Worker 定义名（草稿定义不出名字），服务 Handle 的行取服务账号名，成员 Handle 的行为 `null`。`PlatformAuditRecordWire` 不变。

- **发版说明可写**：审计页上被拦下的行用中文写出 8 种原因之一（与控制台其他地方的错误文案共用一份）；经由 Worker 或服务账号做的事写出它的名字（如「经由 Worker ticket-triage」），取不到时写类别名。审计页的筛选排成同一网格；英文界面写 "In person" / "Via …"。
- **回滚**：只回滚代码即可。

### 3.143 同一范围只保留一条有效授权，升级前先查存量重复（#1036，遗留 647，governance 0041，0.65.0 起）

带一个迁移，随 `apply-release.sh` 自动应用：governance `0041_one_active_grant_per_scope`，是可逆的，见 §6。不改 compose，没有新环境变量。线上契约不变（`CapabilityGrantWire` 没加字段，只是两条能力的描述写明「再授予返回同一条」）。

- **窗口前（主机，必做，只读）**：在 Postgres 里跑一次查重，看有没有同一成员通过两条以上有效授权持有同一范围：

  ```sql
  select workspace_id, principal_id, resource_type, resource_id, count(*)
  from capability_grants
  where status = 'active'
  group by 1, 2, 3, 4
  having count(*) > 1;
  ```

  - **没有行**：照常升级。
  - **有行**：先别升级。迁移遇到这种数据会报错停下，并带出数量，什么都不改；`apply-release.sh` 会在迁移这一步失败。每个重复的范围要由维护者决定保留哪一条，在控制台「系统与授权」或经 `revoke_capability` 撤销其余几条，然后再升级。撤销是终态（0015），所以这一步不能交给脚本自动做。
  - 已过 `expires_at` 但仍标 `active` 的行也算重复。线上入口从不设 `expires_at`，主机上本不该有这种行；真查出来了，按上一条同样处理。
  - 结果记 `docs/private/`。
- **发版说明可写**：给同一成员再授予已持有的访问（`grant_capability` 或 `connect_gatekeeper`），会返回原来那条授权，不新增行，也不重签入口 Handle。这次调用照常写审计，payload 带 `alreadyGranted: true`。撤销或过期之后再授予，就是一条新授权。之前重复授予会多出一条有效授权，撤销一条后另一条仍然生效。
- **回滚**：只回滚代码时，旧代码对已持有的范围再插一行会被索引拒掉，这次调用返回 500，不会写出重复行；其他调用不受影响。要撤迁移，见 §6 的 0041 一行。

### 3.144 审计页的读操作改由内核在分页前去掉（#1040，遗留 669，0.65.0 起）

控制台加内核查询：没有迁移，不改 compose，没有新环境变量，主机不需要操作。线上契约只增不改：`platform_audit_query` 多一个可选参数 `excludeReads: boolean`；`audit_query` 的 `filter` 本来就是开放记录，多认一个 `filter.excludeReads`，schema 没改。两者都是不传时结果与以前相同。控制台与内核同版升级，按 §3.112。

- **发版说明可写**：两个审计页没勾「显示读操作」时，一页 50 条都是写操作和决定，选「经由 本人」等筛选后第一页不再全是被藏起来的读操作（0.64.0 的已知问题，遗留 669）。被拦下的读操作照旧列出。读操作隐藏时什么也没查到，空状态会提示「读操作默认不列出」，旁边有「显示读操作」按钮；按名字筛一个读操作时开关自动勾上。导出的文件多一个 `readsShown` 字段。
- **回滚**：只回滚代码即可。

### 3.145 同一条消息只发一次：`send_chat_message` 认客户端幂等键（#1050，遗留 673 内核部分，core 0055，0.65.0 起）

带一个迁移，随 `apply-release.sh` 自动应用：core `0055_chat_message_idempotency_key`（可逆，见 §6）。不改 compose，没有新环境变量，主机不需要操作。线上契约只增：`send_chat_message` 多一个可选参数 `idempotencyKey`，结果多 `changed`、`turnStatus`；新错误 409 `idempotency_key_reused`（WS `-32020`）。

- **发版说明可写**：同一个对话里，带同一个幂等键、同样文字的重发，会返回原来那条消息和它的那一轮，不会再开一轮；同一个键换了文字或换了发送人，会被拒绝（409）。控制台在同一版里带上了这个键（#1053，见 §3.147），遗留 673 随之关闭。
- **回滚**：只回滚代码即可，见 §6 的 0055 一行。

### 3.146 所有者能看到门被平台暂停、什么时候、为什么（#1051，遗留 674，0.65.0 起）

控制台加内核查询：没有迁移，不改 compose，没有新环境变量。线上契约只增：`get_gatekeeper` 的结果多一个可选字段 `platformSuspension`（`reason`、`suspendedAt`）。

- **窗口前（主机，只读）**：平台暂停自接入门时写下的原因，以前的提示是「只在列表和平台审计里可见」。升级到这一版后，这些原因会显示给对应工作区的成员。升级前先数一下已有的暂停原因：

  ```sql
  select count(*) from workspace_self_connections
  where suspended_at is not null and suspension_reason is not null;
  ```

  结果是 0 就照常升级。不是 0 的话，先请维护者看过这些原因，确认可以给工作区成员看，再升级；结果记 `docs/private/`。
- **发版说明可写**：自接入的门被平台暂停后，所有者在「健康与操作」里能看到暂停的时间、原因，以及要找平台管理员；门的 Operation 照常列出，抽屉与系统卡片的计数一致。原因里的疑似凭据仍然遮住。之前写下的暂停原因升级后也会给工作区成员看到。
- **回滚**：只回滚代码即可。

### 3.147 发送结果不确定时可以安全重发；断线很快能看出来；会话到期即断开推送（#1053、#1054、#1057，遗留 673、672、677，0.65.0 起）

没有迁移，不改 compose，没有新环境变量，主机不需要操作。线上契约只增：WS 多一个 `ping` 方法（认证后可调，`{}` → `{}`）。

- **发版说明可写**：发送后没有收到答复时，对话页会说结果不确定，并给「再发一次」；重发不会多出一轮（内核按 §3.145 的幂等键去重）。网络静默断开后十几秒内，连接状态就会显示「重连中」，网络恢复后马上重连。控制台会话到期后，已打开的页面不会再收到推送，要重新登录。
- **回滚**：只回滚代码即可。

### 3.148 重复归档、取消归档或改成同一标题不再多记一笔（#1060，遗留 665，0.65.0 起）

只改内核：没有迁移，不改 compose，没有新环境变量，主机不需要操作。线上契约不变。

- **发版说明可写**：对已归档的对话再归档、对未归档的再取消归档，或把对话改成它现在的标题，只写 dispatch 行，不再写 `chat.archive` / `chat.unarchive` / `chat.rename` 领域行，也不推送。比较前锁行读旧状态。能力矩阵这三行的 repeat 改为 `idempotent`。
- **回滚**：只回滚代码即可。

### 3.149 编辑器草稿不再撑满标签页的存储（#1062，遗留 667，0.66.0 起）

只改控制台：没有迁移，不改 compose，没有新环境变量，主机不需要操作。

- **发版说明可写**：一个标签页里所有编辑器草稿加起来不超过 100 万字符，超出时先丢最旧的。浏览器拒绝写入时，也从最旧的开始丢，已经发出或放弃的草稿不会再回来。Skill 编辑器恢复草稿后，把正文改回原样就不再保留草稿。恢复的草稿里有异常大的行编号时，之后新加的行也不会撞成同一个 key。
- **回滚**：只回滚代码即可。

### 3.150 Worker 详情的「使用情况」（#1064，S11 GO16a，遗留 569，0.66.0 起）

内核加只读查询，控制台加页面：没有迁移，不改 compose，没有新环境变量，主机不需要操作。线上契约只增：新的只读能力 `get_worker_definition_stats`（human，builder 起）。

- **同版收紧（#1069，遗留 681）**：#1064 原样返回组合指纹，也就是对 WorkerSpec 做的无盐 sha256，旁边还写着调整了哪些字段。看不到来源目标的 builder 可以拿它确认别人私有目标用了什么低熵设置（模型、token 上限）。#1069 在同一版里收紧了：指纹只给能读到这份调整所在目标的调用者（请求人与 workspace owner，规则同 `get_goal`）；每个组合和失败分组都新增 `specRef`，给了指纹的是指纹前 12 位，否则是只在本次响应里有效的 `#n`，原样是 `null`。控制台写成「调整了职责说明、Skill · 编号 …」。线上契约只增 `specRef`，`specDigest` 类型不变。两者要一起发：**不要只发 #1064 而不带 #1069**。
- **发版说明可写**：Worker 详情新增「使用情况」，按版本、运行环境和组合（原样，或带步骤调整）统计运行次数、Task 结果、达成率和失败分组。
- **回滚**：只回滚代码即可。#1064 和 #1069 要一起回滚；只回滚 #1069 会让所有 builder 重新拿到完整指纹。

### 3.151 可沉淀的组合（#1071，S11 GO16b，0.66.0 起）

有迁移：worker `0014_definition_derivations`。它新建 `worker_definition_derivations` 表和插入触发器，不改已有数据。不改 compose，没有新环境变量。线上契约只增。rehearsal 已绿。

- **主机**：升级后可选核对 `select count(*) from worker_definition_derivations`，应为 0。
- **发版说明可写**：Worker 详情新增「可沉淀的组合」。同一个 Worker 版本配同一份步骤调整，近 90 天里达成至少 3 次（请求人确认或平台判定），来自至少 2 个目标，达成率至少 80%，满足这些条件时，能读到那些目标的人可以把它沉淀为新的 Worker 定义草稿。确认前会提示：内容发布后全工作区可见。新定义会记下自己从哪来。猜测指纹的调用一律返回 404，不能借此确认别人的私有设置。
- **回滚**：只回退代码即可。上一版不读也不写这张表，沉淀出的家族在那边就是普通的 WorkerDefinition，只是不再显示来历。要连表一起删，按迁移文件头的三条语句操作；删表会丢掉来历，审计仍在。

### 3.152 写计划前能看到请求人以前的同类目标（#1080，S11 GO17a，0.67.0 起）

没有迁移，不改 compose，没有新环境变量。线上契约只增：新能力 `find_goal_precedents`（observe，Handle 与人工通道，member 起，只给入口 agent），入口上下文的 `precedents` 有了内容，规划器输入多一个 `precedents` 字段。

- **入口模板**：`entry-agent.yaml` 改了，已部署的工作区升级后会按遗留 145 的提示看到「入口模板可升级」，由所有者在控制台确认升级。
- **发版说明可写**：入口 agent 写目标的第一版计划、规划器在一步失败后写修订时，能看到同一个请求人以前做过、已有结果的同类目标（当时的计划、每步最后怎样、最后一轮验收、是正例还是反例）。先例只按结构认同类，不证明这次能成。
- **回滚**：只回退代码。入口上下文回到空数组，规划器输入少一个字段，入口模板回到上一版，已升级的工作区再提示一次升级即可。

### 3.153 计划记下参考了哪些先例（#1087，S11 GO17b，0.67.0 起）

有迁移：goal `0018_plan_revision_cited_precedents`。它给 `plan_revisions` 加可空列 `cited_precedents uuid[]`，加一条形状 CHECK 和一个 BEFORE INSERT 触发器，不回填、不改已有数据。不改 compose，没有新环境变量。线上契约只增：`propose_goal` 多一个可选参数 `precedents`，`get_goal` 与 `get_goal_revision` 的每一版多 `citedPrecedents`，规划器 revise 输出多可选的 `precedents`。rehearsal 已绿。

- **入口模板**：`entry-agent.yaml` 又改了一次（与 §3.152 同一次升级提示里一起确认即可）。规划器定义照旧，在下一次规划时由内核发布新版本。
- **主机**：升级不需要额外步骤。
- **发版说明可写**：目标详情的修订列表里，参考了先例的那一版多一行「参考了先例」，每个先例链到它的目标页，括号里写结果。引用只说明计划从哪来，不授权任何东西，也不改变计划受的检查。
- **回滚**：只回退代码即可，上一版不读也不写这一列。要连 schema 一起去掉，在内核停着时按迁移文件头的步骤在一个事务里删除触发器、函数和列，再删 `schema_migrations` 里的 goal 18；删掉的内容在每一版 `*.propose` 审计 payload 里还有一份。

### 3.154 service Handle 带上它的 Principal 被授的门（#1091，遗留 690，0.67.0 起）

没有迁移，不改 compose，没有新环境变量，线上契约不变（只改了 `issue_service_handle` 的能力描述）。

- **行为变化**：`issue_service_handle` 与 CLI `issue-service-handle` 签发时，按 `issue_handle` 的规则填 `resources.gatekeeper`：取这个 service Principal 当前有效的门（门 Grant 减去 AgentProfile 排除的，再受 AgentPolicy 上限约束），只在 Handle 带了会用门的能力（`request_action`、`invoke_worker`、`list_allowed_operations`）时才带。调用时 R-37 的交集照旧是上限，签发后撤销的 Grant 立即生效。
- **要告诉所有者的**：授了门的 service Principal 用 `request_action` 时，和其他成员一样判定：要审批的等人批准；低风险、可自动批准的操作在默认 AgentPolicy 下直接执行，所有者可以关掉 AgentPolicy 的 `allowMemberAutoApproveLow`，让这类操作也等人批准。升级前就签出的 service Handle 仍是空门集，要用 `request_action` 得重新签一个。
- **发版说明可写**：给 service Principal 授了门之后，外部运行时用它的 Handle 调 `request_action` 不再总是被拒。
- **回滚**：只回退代码。已签出的带门 Handle 回退后仍有效，并继续受每次调用时的 R-37 交集约束；要收回，在集成页「外部运行时」吊销。

### 3.155 目标验收加「独立评审」（#1102，S11 GO18a，0.68.0 起）

有三个迁移：goal `0019_review_acceptance`、task `0014_task_review`，以及跟进 PR #1108 的 task `0015_task_review_result`。goal/0019 给验收检查表加 `review_check` 列和 `review` 种类，新建只许插入的 `goal_review_assessments`，并整份重写 `goal_acceptance_checks_guard`、`goal_runs_status_guard`；task/0014 给 `tasks` 加可空列 `review_round`、`review_check_key`，`purpose` 多 `review`。两个都不回填、不改已有数据。不改 compose，没有新环境变量。线上契约只增：计划 schema 多 `review` 检查，`get_goal` 多评审的读模型，计划提示多 `review_only`，任务 `purpose` 多 `review`。rehearsal 已绿。

- **入口模板**：`entry-agent.yaml` 加了一句（质量类目标可以加评审；只靠评审的目标要跟用户说清楚），已部署的工作区升级后会看到「入口模板可升级」，所有者确认一次即可。规划器与新的评审器（`goal-reviewer.yaml`）由内核在下次用到时发布。
- **跟进（#1108）**：task/0015 加一个触发器 `tasks_review_result_guard`，评审 Task 的报告只能由完成它的那次更新写，之后不能改（assessment 按这份报告重算）；规划器挑步骤 Worker 时不再把评审器当候选。内核写报告本来就只在完成时，行为不变。
- **主机**：升级不需要额外步骤。评审 Task 的 token 从目标预算里扣（每次 10k 到 100k），时长上限 600 秒，没有出网。
- **发版说明可写**：目标计划里可以加一条「独立评审」：写几条标准和通过线，平台在其他验收检查都过了以后起一个评审 Worker 打分，过不过由平台按分数算。只靠评审达成的目标记为「评审评估」，确认卡事先提示这一点。评审没过或判断不了，目标停下等请求人决定。控制台的计划编辑与逐条分数在 GO18b。
- **回滚**：先让正在验收的目标的评审跑完（`select count(*) from tasks where purpose = 'review' and status in ('created', 'queued', 'running');` 为 0），再数一下已按评审达成的目标（`select count(*) from goal_runs where outcome_basis = 'reviewer_assessed';`）。之后只回退代码即可：上一版不认带评审的计划，遇到会把目标停下等人（`needs_decision`），已经达成的目标保留原样。要连 schema 一起撤，在内核停着时按两个迁移文件头的说明恢复 goal/0011 的两个函数，表与列可以留着。

### 3.156 评审员只读、受目标预算约束；运行时契约升到 3（#1123，S11 GO18a 两条 P3，0.69.0 起）

无迁移，线上契约不变。worker-runtime 镜像与 worker-supervisor 随本版一起换，**运行时契约 2 → 3**。和 §3.48（遗留 422）是同一类边界：主机从 v0.63.0 升上来会跨过它。

- **应用**：`apply-release.sh` 本身会构建或拉取 worker-runtime 并重打 tag，supervisor 和内核在同一次 `docker compose up -d` 里换，不要另跑 `build-images.sh`。worker-runtime 必须和 worker-supervisor 同版。
- **窗口前只读核对**（结果记 `docs/private/`，写进给主机的升级提示词）：活动运行时镜像（`activeRuntimeImage`）是跟着 tag 走，还是被手动固定成了某个旧 tag。被固定的话，升级后**所有**入口和 Worker 都会被 409 `runtime_image_incompatible` 拒绝，不只是评审员；这时要先重建契约 3 的镜像，再在运行层页设为活动。
- **应用过程中**：拉完镜像、服务还没全部重建的这段时间，旧 supervisor（契约 2）拒绝新镜像，入口容器回 409；内核先换、supervisor 后换时，评审 spawn 回 400（旧 supervisor 的 schema 不认 `builtinTools`）。维护窗口内可以接受。评审 spawn 被拒时，评审 Task 以 `spawn_failed` 失败、不重试，评审检查结算为 `unavailable`（`reviewer_failed`），目标暂停；升级完成后请求人 `resume_goal`，新的一轮会重新开评审。窗口内最好避开正在 verifying 的目标。
- **应用后核对**：
  - 镜像 label 应为 `3`：

    ```bash
    docker image inspect nexttime-ai-worker-runtime --format '{{index .Config.Labels "ai.nexttime.runtime-contract"}}'
    ```

  - 应用之后新开的评审员容器：日志里有 `nexttime-selfcheck check=builtin_tools result=ok set=read_only`，容器带 label `nexttime.builtin-tools=read_only`；入口容器不应带这个 label。
  - 入口容器收敛同 §3.48：下一轮对话自动重建，或在运行层页点「现在重建」。
- **行为变化**：评审员只有 read、grep、find、ls 和平台的三个能力。评审受目标预算约束：过了墙钟不再开评审员，目标暂停 `budget_exhausted`；请求人的 agent 被评测封存时不开，目标暂停 `needs_decision` 并写 `evaluation.seal_hold_refused` 审计；token 不够立即 `no_budget`；开出的评审员时长上限取 600 秒、工作区默认值、墙钟剩余秒数三者最小。
- **回滚**：只能整版做，代码、worker-runtime 镜像、worker-supervisor 一起回。只回滚运行时镜像不可行：新 supervisor 拒绝契约 2 及更早的镜像，控制台也不让设为活动；只回滚 supervisor，它会拒绝契约 3 的镜像，并对评审 spawn 回 400。内核部分本身没有迁移。`pi-upgrade.md` 的回滚一节已写明。
- **演练**：下一次主机大版本升级的 staging 演练（起点等于主机当前版本）把「label 3、selfcheck 日志行、入口容器收敛」列进验收项。

### 3.157 公网门必须 https；JSON 键名里的凭据也拒收和遮蔽（#1129，遗留 413、444，0.69.0 起）

无迁移。线上契约只多了 `400 connection_target_refused` 的 `details.reason` 和 `details.field`（`contract:check` 快照不变）。这是一次**收紧**：主机上已经接入、endpoint 是 `http://` 公网地址的自连门，升级后会立刻失效。

- **升级前只读核对**（**主机动作**，结果记 `docs/private/`，写进给主机的升级提示词）：列出未挂起、endpoint 以 `http://` 开头的自连门。用 release.md 惯例的 `psql -U nexttime`（compose 的 `POSTGRES_USER`，超级用户）跑；`workspace_self_connections` 开了 forced RLS，换成应用角色会**静默返回 0 行**，读出来就成了「没有受影响的门」：

  ```sql
  select workspace_id, gatekeeper_object_id, connector, endpoint
  from workspace_self_connections
  where endpoint ilike 'http://%' and suspended_at is null;
  ```

  逐个看地址：内网地址（RFC 1918、CGNAT 100.64/10、IPv6 ULA）不受影响；解析出公网地址的（一个名字只要有一个公网答案就算），升级后这个门的每次调用都以 `target_refused` 失败、请求不发出。apply 按确定的 `refused` 失败处理，不重试，不会留下要人工对账的 in doubt 调用。
- **处理方式**：让 owner 把门改成 `https://` 后重新接入。确实不能改的，由操作员把主机名加进 `.env` 的 `NEXTTIME_CONNECTION_ALLOW_HOSTS` 并重建 kernel，作为临时兜底，记进 `docs/private/`。注意：这个名单**按后缀匹配**，加一个上级域名会把它下面所有子域名一起放行；而且它**跳过全部检查**（含平台子网、回环），不只这条 https 规则。所以只加最窄的主机名。
- **升级后的表现**：存量 http 公网门经 capability 路由调用得到 `502 gatekeeper_error`，控制台主文案是「目标系统返回了错误」，原因（`not sent — … use https://`）只在「技术细节」里。这是遗留 700，修好之前遇到这种报错先按上一条处理。
- **444 没有主机动作**：已存储的数据不改写，只在读出时遮蔽键名里的凭据；计划按读出原样回传时保留存储的原值。
- **回滚**：回代码即可，没有迁移。
- **演练**：下一次主机大版本升级的 staging 演练把「升级前核对 SQL 用超级用户跑、对 http 公网门调用以 `target_refused` 失败」列进验收项。

### 3.158 门的地址不允许调用时回 424 `target_refused`（#1131，遗留 700，0.69.0 起）

无迁移，**无主机动作**。线上契约变化：门的地址不是允许的目标时，调用的错误由 502 `gatekeeper_error` 变为 424 `target_refused`，带 `details.reason`。控制台与内核同版发布，不会出现旧控制台遇到新码。

- **行为变化**：接在 `http://` 公网地址上的自接门（§3.157），调用在发出前以 424 `target_refused` 拒绝，控制台标题「门的地址不允许调用」，说明用 https:// 重新接入；审计多一行 refused（不含地址）。
- **升级前后**：§3.157 的升级前只读核对照旧执行；查到的门，升级后由工作区所有者用 https:// 重新接入。自接门不能改地址（遗留 701），重新接入会成为一扇新门，操作要重新导入、发布，引用旧门的目标和流程要改。
- **回滚**：回代码即可，没有迁移。

### 3.159 reaper 结束已决 Task 下的活 WorkerRun（#1133，遗留 206、207，0.69.0 起）

无迁移，线上契约不变。

- **行为变化**：升级后第一个 reaper tick（30 秒内）会结束已决（cancelled / failed / completed）Task 下仍是活状态的 WorkerRun，撤销 Handle 并停掉容器，审计 `worker_run.terminate`、`reason: task_ended`；Task 保持原终态。以前这些 run 要等到时长上限。对终态 Task 再调一次 `cancel_task` 也会立刻收掉残留 run。
- **升级前只读核对**（可选，结果记 `docs/private/`）：想事先知道会被结束哪些，跑 §3.22 的 Q3。主机从 v0.46 起已按 §3.22 处置过，预计为空。
- **回滚**：回代码即可，没有迁移。

### 3.160 崩溃重试按这个人现在的授权收窄（#1135，遗留 289、290、292，0.69.0 起）

无迁移，**无主机动作**，线上契约不变。

- **行为变化**：Worker 崩溃后的那一次重试，Handle 只带这个人现在还能用的能力和还能执行的门；被停用、已不存在或不能再启动 Worker 的人，Task 不再重试，直接失败为 `worker_failed`。`waiting_approval` 期间 Task 计时照常走（遗留 290 决定不暂停）。
- **回滚**：回代码即可，没有迁移。

### 3.161 worker-runtime 镜像装 fd，pi 的 `find` 离线可用（#1137，遗留 698，0.69.0 起）

无迁移，运行时契约不变（仍是 3）。

- **应用**：主机照常拉取发布的镜像，不需要额外出网。只有从源码构建镜像（不带 `--pull`）时，才需要能访问 GitHub 的 release 下载 fd；构建时会离线自检 pi 的 `find` / `grep`，失败即构建失败并写明是哪个工具。
- **窗口前只读核对**：§3.156 那条照旧：`activeRuntimeImage` 不能钉在旧 tag 上，否则 Worker 仍用没有 fd 的旧镜像。
- **应用后核对**：

  ```bash
  docker run --rm --entrypoint fd nexttime-ai-worker-runtime --version
  ```

  应显示 10.5.2；或者入口 / Worker 用 pi 的 `find` 能返回结果。
- **回滚**：回代码、重建镜像即可，没有迁移。旧镜像照旧能用，只是 `find` 不可用。

### 3.162 事实检查的身份写错时当场拒绝（#1139，遗留 466，0.69.0 起）

无迁移，**无主机动作**，线上契约不变（`details.problems` 里多了几种说明）。

- **行为变化**：目标计划里事实检查按身份指定的对象，身份写错（字段多了或少了、类型不对，如 `"3"` 写成 `3`）时，提出就被拒绝。已提出、还没确认的目标，确认时会复核，写错的确认不了，需要重新提出。已经在跑的目标不受影响，要改只能修订。
- **回滚**：回代码即可，没有迁移。

### 3.163 LinkType 端点必须指向已声明的 ObjectType（#1141，遗留 303，0.69.0 起）

无迁移，不改已有数据。线上契约：撤销预览的 `blocker` 枚举加 `link_endpoint_undeclared`，本体撤销项加 `linkEnds`（控制台同版更新）。

- **行为变化**：发布、装包、管理员提案、撤销一个本体时，LinkType 的 `domain` / `range` 指向没有任何已发布本体声明的类型，会被 409 `ontology_link_endpoint_undeclared` 拒绝；巡检多一项 I-P1-LINK。
- **升级前只读预检**（**主机动作**，结果记 `docs/private/`，写进给主机的升级提示词）：查现有的悬空端点，用和 I-P1-LINK（`invariant-checks.ts` 的 `checkIP1Link`）相同的 SQL，按 release.md 惯例用 `psql -U nexttime` 跑：

  ```sql
  with heads as (
    select t.workspace_id, t.id, t.definition
    from ontology_versions t
    where t.status = 'published'
      and t.version = (
        select max(t2.version) from ontology_versions t2
        where t2.workspace_id = t.workspace_id and t2.id = t.id and t2.status = 'published'
      )
  ),
  declared as (
    select distinct workspace_id, e ->> 'name' as name
    from heads, jsonb_array_elements(coalesce(definition -> 'objectTypes', '[]'::jsonb)) e
  ),
  ends as (
    select workspace_id, id, l ->> 'name' as link_type, 'domain' as side, l ->> 'domain' as object_type
    from heads, jsonb_array_elements(coalesce(definition -> 'linkTypes', '[]'::jsonb)) l
    union
    select workspace_id, id, l ->> 'name', 'range', l ->> 'range'
    from heads, jsonb_array_elements(coalesce(definition -> 'linkTypes', '[]'::jsonb)) l
  )
  select e.workspace_id, e.id, e.link_type, e.side, e.object_type
  from ends e
  where e.object_type <> '*'
    and not exists (select 1 from declared d where d.workspace_id = e.workspace_id and d.name = e.object_type)
  order by 1, 2, 3, 4, 5;
  ```

  预期为空：本仓库自带的本体和验收脚本发布的本体都能解析；手工发布过的本体以查询结果为准。不为空时，那些版本照常可用，也不挡别的本体发布，但它们所在的族下一次发布必须先改正；升级后巡检会把它们报为 I-P1-LINK。
- **回滚**：回代码即可，没有迁移。

### 3.164 启用门必须带预览给出的清单摘要（#1143，遗留 311，0.69.0 起）

无迁移，无主机动作。线上契约：`enable_gate_instance` 的 `manifestDigest` 由可选改为必填。

- **行为变化**：直接调 API 启用门实例时，必须先调 `preview_gate_instance_enable`，再把它返回的 `manifestDigest` 带给 `enable_gate_instance`；不带返回 400，预览之后清单变了返回 409 `manifest_changed`，重新预览即可。控制台本来就先预览，不受影响。
- **升级前**：主机上自己写的脚本或集成如果直接调 `enable_gate_instance`，升级前改成先预览再带摘要。仓库自带的 `demo.sh`、`accept_s2.sh`、`accept_s4.sh` 已改。
- **回滚**：回代码即可，没有迁移。

### 3.165 事实检查读对象按发起人过滤 Operation 草稿（#1146，遗留 704，0.69.0 起）

无迁移，无主机动作，线上契约不变。

- **行为变化**：事实验收检查在提议时（按 id、按身份、按类型取样）和判定时（解析两端）读 Object，都按发起人过滤 Operation 草稿，和图上其它读取一致。发起人看不到的草稿，在检查里当作不存在：提议时引用会被拒，提议后发起人被降级的，判定报 `fact_not_observed` 并重试。
- **回滚**：回代码即可，没有迁移。

### 3.166 目标规划器的 pi 工具改为只读（#1148，遗留 697，0.69.0 起）

无迁移，无主机动作，运行时契约不变（仍为 3）。

- **行为变化**：目标规划 Task 和评审 Task 一样，以只读的 pi 内置工具启动（read、grep、find、ls）。
- **升级后确认**：规划 Task 的容器日志里应有 `nexttime-selfcheck check=builtin_tools result=ok set=read_only`。
- **回滚**：回代码即可，没有迁移。

### 3.167 已撤销的会话下没有有效 Handle（#1150，遗留 699、707，0.69.0 起）

迁移 governance 0042：`sessions` 上新触发器（会话转为 revoked 时撤销它的 Handle）、部分索引、重写 0008 的签发触发器（已撤销的会话或父 Handle 拒签），并补救存量。可逆，回退代码即可。没有主机手工步骤。

- **升级前只读预检**（**主机动作**，结果记 `docs/private/`）：按工作区统计已撤销会话下仍然有效的 Handle 数。迁移会把它们撤掉，并按人各写一条审计（`principal.revoked_session_handles_revoked`）；它们本来就该撤。按 release.md 惯例用 `psql -U nexttime` 跑：

  ```sql
  select h.workspace_id, count(*) as live_handles_under_revoked_sessions
  from capability_handles h
  join sessions s on s.workspace_id = h.workspace_id and s.id = h.session_id
  where s.status = 'revoked'
    and h.revoked_at is null
    and h.expires_at > now()
  group by h.workspace_id
  order by 1;
  ```

- **行为变化**：
  - 停用工作区、换角色等撤销会话的操作，现在连带撤销会话下的 Handle；llm-proxy 随撤销表生效，不再放行到 TTL。
  - 平台侧换角色不再结束这个人的控制台会话（与工作区侧一致）。正在跑的 Worker 只在新角色覆盖不了它的 Handle 时被结束，走原有的崩溃重试。
  - 工作区侧换角色现在也结束这个人的 admin_agent 会话（以前只有平台侧会）。旧会话下已排队、还没开始的 Turn 以 `admin_agent_session_ended` 结束；这个人之后再发消息（仍有权使用时）会开新会话。
  - 服务主体降级时，带新角色不能用的能力的 key 被撤销，需要 owner 重新签发；只用新角色能用的能力的 key 不受影响。
  - 已撤销的会话或父 Handle 在 HTTP 与 WS 上都返回 401。
- **回滚**：回退代码即可；迁移已撤销的 Handle 不会恢复（撤销是单向的）。

### 3.168 签发与改权限串行，停用的权威名下没有有效 Handle（#1152，遗留 702，0.69.0 起）

迁移 governance 0043：权威锁函数、6 个触发器（停用工作区、用户、主体时撤销其会话，连带 0042 撤 Handle），并补救存量。可逆，回退代码即可。没有主机手工步骤。

- **升级前只读预检**（**主机动作**，结果记 `docs/private/`）：按工作区统计停用的工作区、用户、主体名下仍然有效的 Handle 数。迁移会把它们撤掉，并按主体各写一条审计（`principal.disabled_authority_handles_revoked`）。按 release.md 惯例用 `psql -U nexttime` 跑：

  ```sql
  select h.workspace_id, count(*) as live_handles_under_disabled_authority
  from capability_handles h
  join principals p on p.workspace_id = h.workspace_id and p.id = h.on_behalf_of
  join workspaces w on w.id = h.workspace_id
  left join users u on u.id = p.user_id
  where (p.disabled_at is not null or u.status = 'disabled' or w.status = 'disabled')
    and h.revoked_at is null
    and h.expires_at > now()
  group by h.workspace_id
  order by 1;
  ```

- **行为变化**：
  - 停用工作区、用户或主体时，其名下会话与 Handle 一并撤销（包括内核之外直接改库的写方，由触发器兜住）。
  - `issue-service-handle` 对已停用的同名服务主体报错。
  - 改权限和签发并发时，后到的一方会短暂等待；签发只在 READ COMMITTED 下进行。
- **回滚**：回退代码即可；迁移已撤销的会话与 Handle 不会恢复。

### 3.169 包的 LinkType 端点只能指向它依赖的族；本体族有权威名字（#1154，遗留 705、706，0.69.0 起）

迁移 core 0056：新表 `ontology_families`（族名的唯一来源）并一次性补名（元本体、ChangePlan 装过的族、`ops-assets`），纯增量。线上契约：新拒绝码 409 `ontology_link_endpoint_outside_requires`。

- **升级前只读预检**（**主机动作**，结果记 `docs/private/`）：每个工作区里，最新发布版本声明了 `WorkerDefinition` 的族应恰好一个；不是一个的工作区，迁移不会给元本体命名，并发 NOTICE。按 release.md 惯例用 `psql -U nexttime` 跑，结果应为空：

  ```sql
  select w.id, count(h.id)
  from workspaces w
  left join (
    select t.workspace_id, t.id
    from ontology_versions t
    where t.status = 'published'
      and t.version = (
        select max(t2.version) from ontology_versions t2
        where t2.workspace_id = t.workspace_id and t2.id = t.id and t2.status = 'published'
      )
      and exists (
        select 1 from jsonb_array_elements(t.definition -> 'objectTypes') o
        where o ->> 'name' = 'WorkerDefinition'
      )
  ) h on h.workspace_id = w.id
  group by w.id
  having count(h.id) <> 1;
  ```

- **行为变化**：
  - 包和模块安装时，LinkType 两端只能指向元本体、自身各族、直接依赖包的族里声明的类型，违反返回 409 `ontology_link_endpoint_outside_requires`。只在安装时检查，不传递。
  - **额外能力包**：有跨族引用但没写 `requires.packs` 的额外包，升级后会被跳过（在被依赖包的 minVersion 就违反）或带警告读入（只在更高版本违反）。看 `extra_packs_status` 的 `skipped` 和 `warnings`，给它补上 requires。镜像自带包违反时注册表加载直接报错。
  - 元本体在 §3.163 的拒绝原因和回滚预览里，`family` 从 null 变成 `platform-meta`。
  - **命令行**：`seed-domain-pack --pack-name` 要求名字合形状、不超过 64 个字符、不能是 `platform-meta`。以前用不合形状的名字种下的族，不能再用同一个名字重新种入。
- **回滚**：回退代码即可，`ontology_families` 留着不影响旧代码。回滚期间新建的工作区，回到本版后要重跑 `0056` 第 2 步（补名，幂等）。
- 除上面的预检外，无主机动作。

### 3.170 自接门经平台审批换地址；请求绑定创建时的门地址（#1156，遗留 701 内核部分，0.69.0 起）

迁移 core 0057：新表 `gate_address_changes`（含 RLS、触发器、索引），纯增量。governance 0044：`action_requests` 新列 `gate_endpoint_key`（写一次，触发器守），并给自接门上的在途请求回填当前地址键。两个迁移都可回退，语句写在各自文件头部。

- **升级后马上只读核对**（**主机动作**，结果记 `docs/private/`；按 release.md 惯例用 `psql -U nexttime` 跑）：

  ```sql
  select count(*) from action_requests where gate_endpoint_key is not null;
  select count(*) from gate_address_changes;
  ```

  第一条应等于升级时自接门上的在途请求数（一般是 0 或个位数）。要在升级后马上查：之后新建的请求都会绑定地址，这个数会涨。第二条应为 0。
- **巡检**：多了 I-A1（换过地址的门，Object 地址和自接行地址键一致），升级后应为 0；没换过地址的门不计。
- **行为变化**：
  - 新能力：工作区 owner 的 `preview_gate_address_change`、`propose_gate_address_change`、`withdraw_gate_address_change`；平台的 `list_gate_address_changes`、`approve_gate_address_change`、`reject_gate_address_change`。提议 24 小时后惰性过期。只有自接门能换（平台目录门 409 `gatekeeper_not_self_connected`）。
  - 请求在创建时绑定门地址；门换了地址后，旧请求在发送前拒绝（`gate_address_changed`）。门上有升级时就在途、没回填到地址键的老请求时，批准换地址返回 409 `gate_address_change_blocked`。
  - `create_connection` 用别的门已持有的密钥，或用服务过换地址提议的密钥，409 由 `conflict` 改为 `connection_secret_in_use`。`rotate_connection_secret` 对平台门的拒绝仍是 `conflict`。
  - `get_gatekeeper` 给 owner 多了 `endpoint`（脱敏）和 `pendingAddressChange`，member 看不到。`approve_gate_address_change` 的拒绝不带 `details`，地址只给 origin。
  - 换地址全程不发送、不转发账号凭证；applied 的审计行提示所有者自行清除旧主机上的账号凭证。
- **回滚**：回退代码即可。上一版不读写 `gate_address_changes`，插入时 `gate_endpoint_key` 留空，执行器不比较地址。回滚前已换过地址的门，上一版按新地址调用。
- 除上面的核对外，无主机动作。控制台入口在 PR-b。

### 3.171 控制台可提出、审批自接门换地址（#1158，遗留 701 控制台部分，0.69.0 起）

只改控制台，没有迁移和线上契约变化。内核部分见 §3.170。

- **行为变化**：
  - 工作区 owner 在系统与授权 → 门的 ⋯ →「更换地址」签出新连接密钥、预览、提交，待审批时可撤回。
  - 平台管理员在集成 →「自己接入的门」看到待审批的申请，可批准或驳回（驳回可写原因）。没有申请就不显示这一块。
- **升级后核对**（可选）：平台管理员打开集成 →「自己接入的门」，没有申请时不出现换地址列表。
- 无主机动作。

### 3.172 所有者读得到自接门换地址申请的结局（#1166，遗留 715 内核部分，0.69.0 起）

没有迁移，没有写路径变化。线上契约只多了一个可选读字段。

- **行为变化**：自接门的所有者读 `get_gatekeeper` 时，多一个 `lastAddressChangeOutcome`，是这扇门最近一次已结束的换地址申请：
  - 结局和结束时间：applied、rejected、withdrawn、expired。过期的结束时间取 `expires_at`。
  - 驳回原因：经脱敏，没写就是 null。
  - 批准时多 `accountCredentialsLeftOnOldHost: true`，提示所有者自己去旧主机清账号凭证。
  - 不带决定人。成员读不到，平台目录门没有这个字段。有新申请开着时，它和 `pendingAddressChange` 同时出现。
- `reject_gate_address_change` 的说明写明：驳回原因会给工作区所有者看到。平台管理员写原因时，写给所有者看，只谈这一次申请。
- **回滚**：回退代码即可。
- 无主机动作。控制台显示随遗留 715 的下一个 PR。

### 3.173 控制台显示自接门换地址申请的结局（#1168，遗留 715 控制台部分，0.69.0 起）

只改控制台，没有迁移和线上契约变化。内核部分见 §3.172。

- **行为变化**：
  - 自接门的所有者在门的「健康与操作」和「更换地址」里，能看到上一次换地址申请的结局：
    - 已批准：提示到旧主机清除账号凭证；
    - 被驳回：显示原因；
    - 已过期。
  - 有开着的申请时不显示结局，撤回的申请也不显示。
  - 平台管理员驳回时，界面提示原因会给工作区所有者看到。
- 无主机动作。

### 3.174 Handle 治理的三处收尾：权限中途变化回 409、不合并进停用用户、Worker 树撤销覆盖晚到的子 Worker（#1172，遗留 708、713、714，0.69.0 起）

没有迁移。

- **行为变化**：
  - 签发 Handle 时，如果调用方的角色或所属用户在这次调用中途变了（拒签码 `authority_changed`），`/api/cap` 回 409 `conflict`，WS 回 `ILLEGAL_TRANSITION`。以前是 401，控制台会因此回到登录页。消息不带 Principal id 和角色名。其余拒签码不变，仍是 401。
  - `merge_user` 的目标用户已停用时，返回 409 `user_disabled`，什么都不改。
  - 撤销 Worker 树时，等待期间新派生的子 Worker 也会被撤销。极少数情况下，同一棵树的两个撤销者之一会整笔回滚并报错，重试即可，不会留下漏撤的 Handle。
- **回滚**：回退代码即可。
- 无主机动作。

### 3.175 连接密钥一次性、24 小时有效（#1176，遗留 711，core 0058，0.69.0 起）

**迁移 core 0058**：新表 `connection_secret_issuances`（每个签出的 salt 一行，不存密钥本身），带检查约束、触发器和强制 RLS。

- **行为变化**：
  - `mint_connection_secret` 签出的密钥 24 小时内有效，只能用一次：接一个门（`create_connection`），或提交一次换地址申请。`rotate_connection_secret` 签出的直接装到门上，视为已用。
  - 已用过的回 409 `connection_secret_in_use`；过期或没有签发记录的回新码 409 `connection_secret_expired`（WS 都是 `ILLEGAL_TRANSITION`）。
- **升级影响**：
  - 升级前签出、还没用的连接密钥没有签发记录，升级后会报 `connection_secret_expired`，要在控制台重新签出。若主机上有正在进行的接门或换地址操作，升级后重新生成密钥。
  - 已接入的门不受影响：门的鉴权仍然重新派生，不查这张表。
- **升级后只读核对**（`psql -U nexttime`）：
  - 表存在且 RLS 已启用并强制：`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'connection_secret_issuances';` 两列都是 `t`；
  - core 迁移版本为 58。
- **回滚**：0058 是纯新增，旧代码从不读写这张表，回退代码即可，表可以留着。要连迁移一起撤，按迁移注释的三步：`drop table connection_secret_issuances`，`drop function connection_secret_issuances_guard()`，再 `delete from schema_migrations where module = 'core' and version = 58`（#501 在事务里实测跑通）。
- **staging 注意**：0058 在合并前就地改过（插入时拒绝 `issued_at > now()`）。跑过 PR 分支旧版 0058 的 staging 库，迁移 checksum 对不上会被拒，需要重建。主机没跑过 0058，不受影响。
- 下一次主机升级的提示要带上本节。

### 3.176 不变量巡检 I6 不再把同一事务里的状态变化读乱（#1182，遗留 720，0.69.0 起）

没有迁移，只改内核巡检代码和测试。

- **行为变化**：同一事务里写下的多条 action_request 审计行时间戳相同。以前 I6 在同一时刻内按随机 id 排序，会把合法路径（例如批准、开始执行、失败）读成 approved→failed、failed→executing 这类非法边，报出误报。现在同一时刻内按状态在生命周期里的深度排序：合法路径不再报，跳过的边或不可能的边仍然报违规。
- **主机影响**：主机巡检的 I6 结果里如果有这类同事务误报，升级后不再出现。升级前的 I6 报告里可能混有这类误报，升级后重跑巡检，以新结果为准。
- **回滚**：回退代码即可。
- 无主机动作。

### 3.177 人类通道签发 Handle 时复查调用方凭证（#1180，遗留 712，governance 0045，0.69.0 起）

**迁移 governance 0045**：纯新增一个 `security definer` 函数 `console_session_is_live(user_id, console_session_id)`，只回答「这个用户的这个控制台会话还在不在」，不带出行里的任何列；`search_path` 固定，revoke public，只授给 `nexttime_app`。

- **行为变化**：
  - 一个人自己发起的签发（`issue_handle`、`issue_service_handle`、人类通道的 `invoke_worker`），在权威锁下复查这次调用带来的凭证。控制台会话已登出或过期，或 API key 已清掉或已轮换（不再是这次出示的那把），就拒绝签发，HTTP 401 / WS `UNAUTHORIZED`，拒绝码 `credential_revoked`，消息不含 id。
  - 控制台不用改：401 本来就回登录页。服务主体在 `/ws` 上轮换自己的 key 后，同一连接再申请 Handle 会被拒，用新 key 重连即可（口径差异见遗留 722）。
- **升级后只读核对**（`psql -U nexttime`）：
  - governance 迁移版本为 45；
  - `select p.prosecdef, has_function_privilege('nexttime_app', p.oid, 'execute'), has_function_privilege('public', p.oid, 'execute') from pg_proc p where p.proname = 'console_session_is_live';` 返回一行 `t | t | f`。
- **回滚**：回退代码即可，函数可以留着，旧代码不调用它。要连迁移一起撤：`drop function console_session_is_live(uuid, uuid)`，再 `delete from schema_migrations where module = 'governance' and version = 45`。
- 主机无其他手工步骤。下一次主机升级的提示要带上本节。

### 3.178 合并已停用的用户时逐条审计恢复可用的成员资格（#1185，遗留 719，0.69.0 起）

没有迁移。

- **行为变化**：`merge_user` 的来源用户已停用时，每条没有移出的成员资格写一条平台审计 `platform.membership_restored`（控制台显示「成员身份恢复可用」，平台审计可按任一用户或工作区查到）。`merge_user` 审计行多带 `sourceLogin`、`targetLogin`。凭证不会因此回来。
- **回滚**：回退代码即可。
- 无主机动作。

### 3.179 已停用的成员没有 API key，由数据库保证（#1210，遗留 738，core 0059，0.69.1 起）

**迁移 core 0059**：清掉已停用成员行上残留的 `api_key_hash`，每个成员写一条审计；加约束 `principals_disabled_no_api_key`（`disabled_at is null or api_key_hash is null`）；加 BEFORE UPDATE 触发器 `principals_disabled_clears_api_key`。

- **行为变化**：
  - 停用成员的那次写入同时清 key，不论走哪条代码路径。其他会让已停用成员带 key 的写入，数据库一律拒绝（`23514`），包括同一句里既停用又设新 key。
  - 控制台已停用的成员显示「无 API key」，不再有「已失效」。
- **升级影响**：迁移期间 `principals` 被锁住（ACCESS EXCLUSIVE，到迁移提交为止），迁移只写几行。主机上每个「已停用、行上还有 key」的成员，key 被清掉，各写一条 `principal.disabled_api_key_cleared` 审计。这些 key 停用后本来就认证不了（key 查找跳过已停用成员），没有原来能用的东西停止工作。没有其他数据变化。
- **升级前只读预检**（可选，结果记 `docs/private/`）：按工作区数会被清掉的成员。
  ```sql
  select workspace_id, count(*) from principals
   where disabled_at is not null and api_key_hash is not null
   group by workspace_id;
  ```
- **升级后只读核对**：
  - 上面那句返回 0 行；
  - `select count(*) from audit_records where action = 'principal.disabled_api_key_cleared';` 等于预检的总数；
  - `select convalidated from pg_constraint where conname = 'principals_disabled_no_api_key';` 为 `t`；
  - core 迁移版本为 59。
- **回滚**：上一版本的代码可以直接跑在这个 schema 上（见 §6 那一行），回退代码即可。要连迁移一起撤，按迁移注释的四步：`drop trigger principals_disabled_clears_api_key on principals`，`drop function principals_disabled_clears_api_key()`，`alter table principals drop constraint principals_disabled_no_api_key`，再 `delete from schema_migrations where module = 'core' and version = 59`。被清掉的 key 不会恢复：库里只存了 hash，而且它们都认证不了。
- 下一次主机升级的提示要带上本节。

### 3.180 WorkerDefinition 低于已发布 head 的草稿不能发布，入口当前版本按族 head 读（#1221，遗留 742，0.69.2 起）

没有迁移。

- **行为变化**：
  - `publish_worker_definition` 发布低于族里已发布 head 的版本时回 409 `draft_superseded`（`details.familyId` / `draftVersion` / `publishedVersion`），内容可用 `replacesDraft` 提成下一版；弃用的版本不算 head。控制台草稿详情在落后时说明原因并去掉「发布」。
  - 入口的当前版本（`getPublishedEntryDefinition`）改为取最近发布过的入口族的 head（族内按版本号），和族 head 同一读法，不再按 `published_at` 取最后发布的一行。
- **升级影响一：入口当前版本的读法变了**。升级前可以只读查一下主机上有没有顺序反过来的入口版本（结果记 `docs/private/`）：
  ```sql
  select a.workspace_id, a.id, a.version as stamped_later, b.version as higher
    from worker_definitions a
    join worker_definitions b
      on b.workspace_id = a.workspace_id and b.id = a.id
     and a.kind = 'entry' and a.status = 'published' and b.status = 'published'
     and a.version < b.version and a.published_at > b.published_at;
  ```
  没有行就没有影响。有行的工作区，升级后入口 agent 会改用那个族里版本更高的一版（`higher`），而不是后发布的低版本（`stamped_later`）。想继续用低版本的内容，由所有者把它的内容提议成下一版再发布，或弃用更高的那一版。
- **升级影响二：低于已发布 head 的待审草稿不能再发布**（409 `draft_superseded`，控制台详情里说明原因和怎么办）。升级前可以只读查有多少：
  ```sql
  select d.workspace_id, d.id, d.version as draft, max(p.version) as published_head
    from worker_definitions d
    join worker_definitions p
      on p.workspace_id = d.workspace_id and p.id = d.id and p.status = 'published'
   where d.status = 'draft'
   group by d.workspace_id, d.id, d.version
  having max(p.version) > d.version;
  ```
  有行不需要处理：提议人在控制台点「修改这份草稿」保存成下一版，或丢弃。
- **回滚**：回退代码即可，回滚即恢复原来的读法。
- 下一次主机升级的提示要带上本节。

### 3.181 `deprecate_operation` 锁住正在生效的一版，可带调用方看到的版本（#1223，遗留 423，0.69.2 起）

没有迁移，没有主机数据影响。

- **行为变化**：`deprecate_operation` 先锁住正在生效的一版再复查，和并发发布交错时不再把弃用落在刚退役的旧版本上。新增可选参数 `version`：传了且不是正在生效的一版时回 409 `version_changed`，什么也不弃用；不传 `version` 的调用方行为不变。结果和审计行新增 `version`。控制台总是传版本。
- **升级影响**：主机上自己写的脚本直接调 `deprecate_operation` 的，不用改；想避免弃用到别人刚发布的新版本，可以带上 `version`。
- **回滚**：回退代码即可。
- 无主机动作。

### 3.182 agent 的一轮准备时读失败就不启动（#1229，遗留 434，0.69.2 起）

没有迁移，没有主机数据影响。

- **行为变化**：入口 / 管理员 agent 的一轮在准备时某项读失败（个人设置、入口定义、Skill、平台说明、运行镜像），现在这一轮结束为失败，不再以默认提示、不带禁止列表或不按个人设置启动。从未发布过入口定义的工作区照旧按没有处理。
- **怎么认**：内核日志 error，入口为 `could not read … — the entry turn was not started`，管理员 agent 为 `the admin agent turn could not be prepared — not started`。升级后如果看到这两句，查对应的读为什么失败。
- **回滚**：回退代码即可。
- 无主机动作。

### 3.183 服务账号提议的 Operation 草稿记为非人工写的（#1234，遗留 616，0.69.2 起）

没有迁移，没有主机数据影响。

- **行为变化**：服务账号的 API key 提议的 Operation 草稿，起草方现在记为 `agent`，审阅页显示「智能体或服务账号写的」，列表行带「智能体」标记，与 Skill、流程、Worker、本体的规则一致。以前这类草稿记为 `human`。
- **已有记录**：升级不改写旧记录。想知道有多少条旧记录还记着 `human`，可跑只读计数：

  ```sql
  select count(*) as service_written_as_human
    from objects o
    join principals p
      on p.workspace_id = o.workspace_id and p.id::text = o.properties ->> 'proposedBy'
   where o.object_type = 'Operation'
     and o.properties ->> 'origin' = 'human'
     and p.kind <> 'human';
  ```

- **回滚**：回退代码即可。
- 无主机动作；下一次主机升级的提示可带上上面的计数 SQL。

### 3.184 agent 的一轮在所有读取之后才签 Handle（#1237，遗留 751，0.69.2 起）

没有迁移，没有主机数据影响。

- **行为变化**：入口 / 管理员 agent 的一轮先做完准备时的全部读取，最后才签 Handle。读失败而没有启动的一轮（§3.182）不再签发、也不缓存 Handle，`capability_handles` 里不再出现这类记录；下一轮读取成功时自己签。签发规则（会话、缓存复用、闸门收窄）和有效期不变。
- **管理员 agent 的权限检查**：开关关闭或被降级的拒绝随签发一起挪到读取之后。被拒的一轮仍不启动、不签 Handle，日志级别和原因不变；如果同一轮既被拒又读失败，日志记的是读失败。
- **回滚**：回退代码即可。
- 无主机动作。

### 3.185 `invalid_step_reference` 带结构化 `details`（#1240，遗留 502，0.69.2 起）

没有迁移，没有主机数据影响。

- **行为变化**：`propose_procedure` / `publish_procedure` 回的 400 `invalid_step_reference` 多带 `details`：`stepIndex`（从 0 数，流程没有步骤时为 `null`）、`reason`（`no_steps`、`operation_not_published`、`worker_not_published`、`not_worker_kind`、`no_graph_projection` 之一）和这一步引用的对象（operation 步骤为 `gatekeeperId` + `operationName`，worker 步骤为 `definitionId` + `version`，种类不对时还有 `definitionKind`）。消息文字不变，`details` 是加法；控制台显示不变。
- **错误码变化**：worker 步骤查定义时的查询失败（包括语句超时）以前被包成 400「没有发布」，现在按原错误报 500。升级后如果发布流程时看到 500，查内核日志里那次查询为什么失败。
- **回滚**：回退代码即可；控制台回到解析消息的路径，显示不变。
- 无主机动作。

### 3.186 门实例的审计行写明凭据模式（#1243，遗留 606，0.69.2 起）

没有迁移，没有主机数据影响。

- **行为变化**：`create_gate_instance` 的审计行在参数副本之外多记三项解析后的定义：`connector`、`transportKind`、`credentialMode`（`shared` / `connected_account`）。用连接器预设建的实例也能看出预设给的是哪种模式。控制台平台审计页对顶层的 `credentialMode` 不再遮挡，前提是值恰好是这两种之一；参数副本里的 `credentialMode` 照旧遮挡。
- **已有记录**：升级前写下的审计行没有这三项，不回填。
- **回滚**：回退代码即可。新写的行多出的三项会留在库里，它们是枚举值和连接器名，不含凭据；回退后控制台照旧把 `credentialMode` 显示成 `[redacted]`。
- 无主机动作。

### 3.187 只有 agent 自己的会话发来的提议目标、启动 Worker 才算来自它的那一轮（#1245，遗留 443，0.69.2 起）

没有迁移，没有主机数据影响。

- **行为变化**：`propose_goal` 和 `invoke_worker` 记来源轮次时看调用是从哪个会话来的。入口 agent 的会话照旧记这个人正在跑的入口轮次，管理员 agent 的会话照旧记它自己的轮次。人自己的调用、成员客户端的 Handle、服务 Handle 发来的不再记来源轮次：目标的 `originated_in_turn_id` 为空，Task 的 `created_by_activity_id` 不再指向入口 agent 当前那一轮，进度和审批也不再落到那一轮的对话里。Worker 嵌套调用照旧按根 Task 的轮次记。
- **已有记录**：已经写下的来源字段不改。
- **不变**：`record_decision` / `record_procedure_followed` 照旧按调用者找正在跑的轮次（遗留 758）。
- **回滚**：回退代码即可。
- 无主机动作。

### 3.188 Decision 列表与先例查询走索引（#1247，遗留 429，core 0060，0.69.2 起）

**迁移 core 0060**：`decisions` 加索引 `decisions_workspace_created_ms_idx`，键为 `(workspace_id, date_trunc('milliseconds', created_at at time zone 'UTC') desc, id desc)`。只加索引，不改数据、约束和授权；建之前会先删掉同名的失效索引（0044 的写法）。

- **行为变化**：`query_decisions`（控制台推理链的选择器和「最近的决定」）与 `find_precedents` 按这个键排序，直接读索引，不再每页扫整个工作区再排序（本地 20 万条：首页 29 ms → 0.04 ms）。`query_decisions` 的顺序和每一页与原来相同；`find_precedents` 对同一毫秒内写下的几条 Decision 改按 `id` 排，原来按微秒排。
- **升级影响**：迁移在一个事务里用普通 `create index`，建索引期间 `decisions` 被 SHARE 锁住：读照常，写入（审批、核对、目标结果、冲突裁决、`record_decision`）排队等它建完。本地 20.6 万行用 0.15 s，索引 12 MB。
- **升级前只读预检**（结果记 `docs/private/`）：先看表有多大，据此估计锁要拿多久。
  ```sql
  select count(*) from decisions;
  ```
  升到 0.69.2 之后的下一版（含 core 0061，见 §3.190）的主机不用做下面这步：0060 与 0061 连续执行，0060 建的索引随即被 0061 删掉。只有停在 0.69.2、或回退代码后要重建 0060 索引时才有用。嫌排队时间太长，可以在上一版还在跑的时候，事务外提前建好（不阻塞写入），迁移发现已有有效索引就什么都不建：
  ```sql
  create index concurrently if not exists decisions_workspace_created_ms_idx
    on decisions (workspace_id, (date_trunc('milliseconds', created_at at time zone 'UTC')) desc, id desc);
  ```
- **升级后只读核对**：
  - `select indisvalid from pg_index where indexrelid = 'decisions_workspace_created_ms_idx'::regclass;` 为 `t`；
  - core 迁移版本为 60。
- **回滚**：上一版本的代码不认这个索引，直接跑在新 schema 上（见 §6 那一行），回退代码即可。要删索引：`drop index decisions_workspace_created_ms_idx;`，再 `delete from schema_migrations where module = 'core' and version = 60`。
- 下一次主机升级的提示要带上本节。

### 3.189 `report_task_result` 的回答带逐条拒绝的条目（#1249，遗留 650，0.69.2 起）

没有迁移，没有主机数据影响。

- **行为变化**：
  - `report_task_result` 的回答多三个数组：`factsRejected`、`proposedOperationsRejected`、`evidenceDropped`，内容与 `tasks.result` 记下的是同一份；没有拒绝时为空数组。契约是加法（`docs/contracts/capabilities.json` 只这一项变）。
  - 新运行时的 Worker 从回答里取被拒的条目交给模型，上报之后不再调 `get_task`。所以内核日志里每次 Worker 运行末尾那条 `get_task` 401（Handle 已吊销）不再出现，工具结果里也第一次能看到逐条拒绝。
  - 没声明 `search` 的 Worker 每次运行仍有一条 `search` 403 和一条 `not_in_scope` 拒绝审计（遗留 761），这不是越权，也不是吊销后重试。
- **升级顺序**：内核与运行时镜像谁先谁后都可以。新运行时配旧内核时不显示拒绝，也不再多一次 401；旧运行时配新内核时忽略新字段，照旧回读、照旧 401。
- **回滚**：回退代码即可。
- 无主机动作。

### 3.190 Decision 列表带 since 或游标时也走索引（#1252，遗留 760，core 0061，0.69.2 之后的下一版）

**迁移 core 0061**：`decisions` 加存储生成列 `created_ms_utc timestamp generated always as (date_trunc('milliseconds', created_at at time zone 'UTC')) stored`，建索引 `decisions_workspace_created_ms_utc_idx (workspace_id, created_ms_utc desc, id desc)`，删掉 0060 的 `decisions_workspace_created_ms_idx`。

- **行为变化**：
  - `query_decisions` 带 `since` 或游标时，扫描从游标处开始、到 `since` 停下，应用角色在 RLS 下也一样（0060 下应用角色只有首页受益）。顺序、分页、游标格式不变。
  - `since` 不是合法时间时返回 400 `invalid_params`（WS 为 `INVALID_PARAMS`，消息以 `since:` 开头），原来是 500。
- **升级影响**：加存储生成列会重写 `decisions`，期间 ACCESS EXCLUSIVE 锁住表，读和写都等它完成（本地 20.6 万行、64 MB：0.7 s）。没有不锁表的做法。
- **升级前只读预检**（结果记 `docs/private/`）：据行数估计锁的时长。
  ```sql
  select count(*) from decisions;
  ```
  从 0.69.2 之前的版本升级时 0060 与 0061 连续执行；§3.188 的事务外预建对升到本版的主机不用做。
- **升级后只读核对**：
  - `select attgenerated from pg_attribute where attrelid = 'decisions'::regclass and attname = 'created_ms_utc';` 为 `s`；
  - `select indisvalid from pg_index where indexrelid = 'decisions_workspace_created_ms_utc_idx'::regclass;` 为 `t`；
  - `select to_regclass('decisions_workspace_created_ms_idx');` 为空；
  - core 迁移版本为 61。
- **回滚**：0.69.2 的代码直接跑在新 schema 上，结果正确，Decision 列表回到每页排序（见 §6 那一行），回退代码即可。要撤 schema：`drop index decisions_workspace_created_ms_utc_idx;`，`alter table decisions drop column created_ms_utc;`，需要时按 §3.188 用 `concurrently` 重建 0060 的索引，再 `delete from schema_migrations where module = 'core' and version = 61`。
- 下一次主机升级的提示要带上本节和 §3.188。

### 3.191 Worker 的 Handle 没有 `search` 时不再调它（#1255，遗留 761，0.69.2 之后的下一版）

没有迁移，没有主机数据影响。

- **行为变化**：WorkerDefinition 声明的能力里没有 `search` 的 Worker，不再在每次运行开始时调 `search`。内核日志里那条 `search` 403、审计里那条 `not_in_scope` 拒绝不再出现。注入的上下文不变（以前也因为被拒而没有相关事实）。
- **契约加法**：`get_task` 回答给这个 Task 自己的 WorkerRun Handle 时多一个可选字段 `callerCapabilities`（取 Handle 已验证的 scope）。其他调用方与 `list_tasks` 不带这个字段。`docs/contracts/capabilities.json` 只这一项变。
- **升级影响**：无 compose 或 env 变化，运行时契约不变，内核与运行时镜像谁先谁后都可以。旧内核配新运行时、新内核配旧运行时，都照旧调用 `search`。
- **升级后只读核对（可选）**：跑一个不含 `search` 的 Worker，内核日志里没有它的 `search` 403，审计里也没有这次运行的 `not_in_scope`。
- **回滚**：回退代码即可。
- 无主机动作。

### 3.192 门启动时拒绝未知的 `GATE_CREDENTIAL_MODE`（#1261，遗留 764，0.69.2 之后的下一版）

没有迁移，不改契约。

- **行为变化**：gatekeeper-base 的门在 `GATE_CREDENTIAL_MODE` 不是 `shared` / `connected_account`、也不是未设或空时，启动失败并报出这个变量。原来这类值（包括拼错的 `connected-account`）会静默按 `shared` 运行；这次是把配置错误暴露出来。带空白的值（如 `" shared"`）也会失败，不做 trim。
- **升级影响**：主机上哪个门的这个变量写了别的值，升级后那个门起不来。镜像升级顺序不限。
- **升级前只读检查**（两处都只看 `GATE_CREDENTIAL_MODE` 这一个变量，只限本项目，结果记 `docs/private/`）：
  - **下次起服务会用的配置**：在项目目录，用主机实际起服务时的同一组 `-f`、env 文件和 profile 渲染，只 grep 这个变量：
    ```sh
    docker compose <同一组 -f / --env-file / --profile> config | grep -n GATE_CREDENTIAL_MODE
    ```
    不要保存完整输出：`config` 会把插值后的 secret 一起打出来。只用默认参数渲染时，未启用 profile 的服务和用别的 `-f` 起的门都看不到。
  - **当前在跑的容器**：用 `docker compose <同一组参数> ps -q` 列出本项目的容器，逐个：
    ```sh
    docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' <容器> | grep '^GATE_CREDENTIAL_MODE='
    ```
    不扫主机上其他项目的容器。
  - 两处都只能出现 `shared`、`connected_account`，或者没有这一行。出现别的值时，先确认这个门本该用哪种模式再改；改成 `connected_account` 还需要 `GATE_STORE_KEY_FILE`。
- **回滚**：回退代码即可。
- 下一次主机升级的提示要带上本节。

### 3.193 内核镜像的 `/app` 与应用代码归 root 所有（#1265、#1281，遗留 414、765，0.69.2 之后的下一版）

没有迁移，不改契约。

- **行为变化**：内核镜像里 `/app` 目录本身、应用代码，以及 `ontology/`、`packs/`、`connectors/`、`pi.version` 都归 root 所有，所有人可读、只有 root 可写；运行时用户 `nexttime` 改不了、也没法改名或替换。权限在构建阶段设好，不随检出时的 umask 变。内核运行时本来就不往 `/app` 下写（compose 以 `read_only` 运行，只有 `/tmp` 可写）。
- **升级影响**：换镜像即生效，镜像升级顺序不限。
- **升级后只读检查**（只看本项目的内核镜像，结果记 `docs/private/`）：
  ```sh
  docker run --rm --entrypoint sh nexttime-ai-kernel -c 'stat -c "%U %a %n" /app /app/dist /app/package.json; touch /app/x 2>&1 | head -1'
  ```
  三行都应是 `root`，且组和其他用户没有写位（如 `755`、`644`）；`touch` 应报 `Permission denied`。镜像名以主机实际用的为准。
- **回滚**：回退镜像即可。
- 下一次主机升级的提示要带上本节。

### 3.194 按身份取 Fact 的两个函数加 tiebreaker（#1283，遗留 143，core 0062，0.69.2 之后的下一版）

**迁移 core 0062**：用 `create or replace` 只替换 `find_active_fact_for_identity` 与 `latest_fact_invalidated_for_identity` 两个函数体；签名、`security definer`、`search_path` 与工作区检查不变。不动数据，不锁表，执行很快。

- **行为变化**：同一身份有多条最新并列的行时，活跃 Fact 按 `id desc` 取第一条；作废检查只有并列的最新几行全部作废才回答「是」，否则内核重读（最多 `MAX_ACTIVE_FACT_REREAD_ATTEMPTS` 次，之后照旧插一条新 Fact）。没有并列的身份结果和原来一样。
- **升级前检查**：无。
- **升级顺序**：不限。上一版内核在新函数上照常运行，不依赖并列时的顺序。
- **回滚**：只回退代码即可，不需要回换函数。要撤 schema，按 0042 的定义重建这两个函数，再删 `schema_migrations` 里 core 62 那一行。
- 下一次主机升级的提示要带上本节。

### 3.195 确认不存在只认 Operation 版本记着的那次确认（#1289，遗留 496，goal 0020 + governance 0046，0.69.2 之后的下一版）

**迁移 goal 0020 与 governance 0046**：只建函数与触发器（`goal_absence_version_confirmed`，两张验收检查表各一个触发器，reconcile 一个），不动数据，执行很快。

- **行为变化**：确认不存在的验收检查要通过、平台要在「不存在」回答上记 `effect_seen`，Observation 上的 `absentAnswersReview` 必须是这个 Operation（同一个门、同名）某个已发布或已弃用版本记着的那一次确认。产品路径本来就复制被问版本的确认，正常部署不受影响。
- **升级前检查（可选，只读）**：三行都应为 0。**必须用表属主跑（`psql -U nexttime`）**：用 `nexttime_app` 跑，RLS 会让三行都读成 0。不为 0 时升级照常，触发器不改已有行，但升级后审计检查器会报出这些行；结果记 `docs/private/`。

```sql
-- 已通过的确认不存在检查，以及无人决定、建立在「不存在」回答上的 reconcile，
-- 其 Observation 上的确认没有任何已发布或已弃用的该 Operation 版本记着。
with confirmed as (
  select op.workspace_id, op.identity_key ->> 'gatekeeperId' as gk, op.identity_key ->> 'name' as name,
         op.properties ->> 'absentAnswersReviewedBy' as by, op.properties ->> 'absentAnswersReviewedAt' as at
    from objects op
   where op.object_type = 'Operation' and op.properties ->> 'status' in ('published', 'deprecated')
)
select 'goal' as kind, count(*) from goal_acceptance_checks c
  join observations o on o.workspace_id = c.workspace_id and o.id = c.observation_id
 where c.kind = 'observe_absent' and c.status = 'passed'
   and not exists (select 1 from confirmed v where v.workspace_id = c.workspace_id
     and v.gk = c.observation_check ->> 'gatekeeperId' and v.name = c.observation_check ->> 'operation'
     and v.by = o.content #>> '{absentAnswersReview,reviewedBy}' and v.at = o.content #>> '{absentAnswersReview,reviewedAt}')
union all
select 'step', count(*) from step_acceptance_checks c
  join observations o on o.workspace_id = c.workspace_id and o.id = c.observation_id
 where c.kind = 'observe_absent' and c.status = 'passed'
   and not exists (select 1 from confirmed v where v.workspace_id = c.workspace_id
     and v.gk = c.observation_check ->> 'gatekeeperId' and v.name = c.observation_check ->> 'operation'
     and v.by = o.content #>> '{absentAnswersReview,reviewedBy}' and v.at = o.content #>> '{absentAnswersReview,reviewedAt}')
union all
select 'reconcile', count(*) from action_requests r
  join decisions d on d.workspace_id = r.workspace_id and d.id = r.reconciliation_decision_id
  join observations o on o.workspace_id = r.workspace_id and o.id::text = d.rationale ->> 'observationId'
  join action_request_reconcile_checks c on c.workspace_id = r.workspace_id and c.action_request_id = r.id
 where d.decided_by is null and o.content ? 'absent'
   and not exists (select 1 from confirmed v where v.workspace_id = r.workspace_id
     and v.gk = c.observation_check ->> 'gatekeeperId' and v.name = c.observation_check ->> 'operation'
     and v.by = o.content #>> '{absentAnswersReview,reviewedBy}' and v.at = o.content #>> '{absentAnswersReview,reviewedAt}');
```

- **升级顺序**：不限。上一版内核写 Observation 的方式不变，照常通过新触发器。
- **回滚**：只回退代码即可，不需要删触发器。要撤 schema：删两个验收检查触发器、reconcile 触发器与对应函数，再删 `schema_migrations` 里 goal 20 与 governance 46 两行。
- 下一次主机升级的提示要带上本节。

### 3.196 IPv4 前导零段与以数字结尾的主机条目（#1305，遗留 777，0.69.2 之后的下一版）

无迁移。改的是配置与已存 Worker 定义的解析，其中一处改变了旧版本已接受的值的含义，所以加一节可选的升级前只读检查。

- **含义变化**：内核 `NEXTTIME_CONNECTION_ALLOW_HOSTS` / `NEXTTIME_CONNECTION_FIXTURE_HOSTS` 里带前导零的 IP 条目，以前按十进制读，现在与 URL 解析一致按八进制读，放行的会是另一个地址。同一批里还有一处放宽（#1316，遗留 781）：这两个变量里带单独 `0x` 段的条目（如 `192.0.2.0x`）以前不算 IP、记 error 后被忽略，现在与 URL 一致把该段读成 0，放行对应地址（这里是 `192.0.2.0`）。下面检查 (a) 会把这类条目列在「ends in a number」一行，按本意改写成十进制地址或删掉，脚本不用改。
- **解析变严**：已存 WorkerDefinition（任何 status）的 `egressDeny` 里以数字结尾、却不是 IP 的条目不再通过校验，组合候选与管理员提议读到这个版本时当作解析不了；`EGRESS_TRUSTED_RESOLVED_CIDRS` 里带前导零的条目记 error 并忽略（收窄）。
- **无需担心**：`NEXTTIME_SUBNET_CONTROL` / `NEXTTIME_SUBNET_WORKERS` 带前导零时 Docker 与内核本来就拒绝，正在运行的主机不会是这种值，下面的脚本顺带检查。`DENY_HOSTS`、`EGRESS_DENY_HOST_SUFFIXES` 与映射文件里以数字结尾的条目只多一条 error 日志，以前也拦不住任何东西。
- **升级前检查（可选，只读，结果记 `docs/private/`）**：
  - (a) 在项目目录下检查 `.env`，正常输出为空。有输出时升级前处理：前导零的 IP / CIDR 改写成本意的十进制（尤其是 ALLOW_HOSTS），以数字结尾的非 IP 条目删掉（它们以前就匹配不到任何主机）。

    ```sh
    grep -E '^(NEXTTIME_SUBNET_CONTROL|NEXTTIME_SUBNET_WORKERS|EGRESS_TRUSTED_RESOLVED_CIDRS|NEXTTIME_CONNECTION_ALLOW_HOSTS|NEXTTIME_CONNECTION_FIXTURE_HOSTS|DENY_HOSTS|EGRESS_DENY_HOST_SUFFIXES)=' .env |
    awk 'function strict(h,  p, k, n) { n = split(h, p, "."); if (n != 4) return 0
           for (k = 1; k <= 4; k++) if (p[k] !~ /^(0|[1-9][0-9]*)$/ || length(p[k]) > 3 || p[k] + 0 > 255) return 0
           return 1 }
    {
      name = $0; sub(/=.*/, "", name); v = substr($0, length(name) + 2); gsub(/["\047[:space:]]/, "", v)
      n = split(v, e, ",")
      for (i = 1; i <= n; i++) {
        h = tolower(e[i]); sub(/\/.*/, "", h); sub(/\.+$/, "", h)
        if (h == "" || h ~ /:/) continue
        if (h ~ /^[0-9.]+$/ && h ~ /(^|\.)0[0-9]/) print name ": leading-zero part: " e[i]
        else if (h ~ /(^|\.)(0x[0-9a-f]*|[0-9]+)$/ && !strict(h)) print name ": ends in a number but is not an IPv4 address: " e[i]
      }
    }'
    ```

  - (b) 已存定义里的 `egressDeny`。**必须用表属主跑（`psql -U nexttime`）**：`worker_definitions` 开了 RLS。正常结果为空；有行时升级照常，升级后对这些定义发一个去掉该条目的新版本（条目本来就拦不住请求，去掉不会放宽出口）。

    ```sql
    select workspace_id, id, version, kind, status, e as entry
      from worker_definitions,
           jsonb_array_elements_text(case when jsonb_typeof(definition -> 'egressDeny') = 'array'
                                          then definition -> 'egressDeny' else '[]'::jsonb end) e
     where rtrim(lower(e), '.') ~ '(^|\.)(0x[0-9a-f]*|[0-9]+)$'
     order by workspace_id, id, version;
    ```

- **升级顺序**：不限。
- **回滚**：只回退代码即可。
- 下一次主机升级的提示要带上本节。

### 3.197 主机列表里的 IP 条目按地址精确匹配（#1320，遗留 785，0.69.2 之后的下一版）

无迁移。出口代理的 allow / deny 条目与内核 `NEXTTIME_CONNECTION_ALLOW_HOSTS` / `NEXTTIME_CONNECTION_FIXTURE_HOSTS` 里的 IP 条目，以前按文本后缀比较，现在按它表示的地址精确匹配，任何写法都认（前导零、整数、十六进制、末尾点、方括号）。

- **含义变化**：
  - 拒绝列表里写法不规范的 IP 条目开始生效（多拒，收窄）；出口代理拒绝列表里写法不规范或带方括号的 IPv6 条目同样开始生效。
  - 内核允许列表里带末尾点的 IP 条目（如 `203.0.113.8.`）开始生效（放宽，以前永远匹配不到）。
  - 短写法（如 `2.7`）不再按后缀匹配以它结尾的其他地址：拒绝侧不再多拒（放宽，属非预期用法），映射文件允许侧不再多放。
  - 带方括号的 IPv6 条目（如 `[2001:db8::1]`）在内核允许列表里也开始生效（放宽，#1324，遗留 786）；方括号里不是 IPv6 的条目（如 `[192.0.2.8]`）不匹配任何地址，记 error。出口代理纯 HTTP 请求的 IPv6 字面量目标与 CONNECT 一样按字面量处理：已列入允许列表的公网 IPv6 地址以前被拒（`dns-error`），现在放行。下面的扫描只看 IPv4 形状的条目，不受影响。
  - 出口代理的 allow 放行后仍要过地址分类，不会因此放出私网地址。默认的 `DENY_HOSTS` 与默认拒绝后缀里没有 IP 条目，映射文件的 allow / deny 由 worker-supervisor 写、正常不会有 IP 条目，正常部署不受影响。
- **升级前检查（可选，只读，结果记 `docs/private/`）**：在项目目录下运行，列出 `.env` 里以数字结尾、却不是四段十进制的条目，正常输出为空。有输出时，把条目改写成本意的四段十进制地址。列出的条目有两种：写法不规范的 IP（如 `192.0.2.010`、`0xcb007108`、`2.7`、`203.0.113.8.`），升级后按它表示的地址匹配；根本不是 IP 的（如 `256.1.1.1`、`08.8.8.8`、五段写法），什么也匹配不到。能处理行首空格、`export` 前缀、引号与行尾 ` # 注释`；只用 POSIX awk 特性（mawk 1.3.4 实测，gawk 结果相同为推断）。

    ```sh
    grep -E '^[[:space:]]*(export[[:space:]]+)?(NEXTTIME_CONNECTION_ALLOW_HOSTS|NEXTTIME_CONNECTION_FIXTURE_HOSTS|DENY_HOSTS|EGRESS_DENY_HOST_SUFFIXES)=' .env |
    awk 'function strict(h,  p, k, n) { n = split(h, p, "."); if (n != 4) return 0
           for (k = 1; k <= 4; k++) if (p[k] !~ /^(0|[1-9][0-9]*)$/ || length(p[k]) > 3 || p[k] + 0 > 255) return 0
           return 1 }
    {
      line = $0; sub(/^[[:space:]]*/, "", line); sub(/^export[[:space:]]+/, "", line)
      name = line; sub(/=.*/, "", name); v = substr(line, length(name) + 2)
      sub(/[[:space:]]+#.*$/, "", v); gsub(/["\047[:space:]]/, "", v)
      n = split(v, e, ",")
      for (i = 1; i <= n; i++) {
        h = tolower(e[i]); if (!sub(/^[*][.]/, "", h)) sub(/^[.]/, "", h)
        if (h ~ /^((0x[0-9a-f]*|[0-9]+)[.])*(0x[0-9a-f]*|[0-9]+)[.]?$/ && !strict(h))
          print name ": entry ends in a number but is not four plain decimal parts; rewrite it as the address you mean: " e[i]
      }
    }'
    ```

- **升级顺序**：不限。
- **回滚**：只回退代码即可。
- 下一次主机升级的提示要带上本节。

### 3.198 门宿主拉 OpenAPI 文档时不跟随重定向（#1342，遗留 199，0.69.2 之后的下一版）

无迁移。门宿主给 http 实例拉 OpenAPI `manifestSource` 时，以前跟随重定向，现在与内核（R-27）和门的 transport 一致，不跟随。

- **含义变化（收窄）**：OpenAPI 文档地址会重定向的 http 实例，升级后不再构建、不再接管、不再公告。原因写在门宿主的 warn 日志和 `/healthz` 里，原文含 `does not follow redirects`。门宿主每轮 tick 照常重试。
- **影响范围**：内核在创建连接时本来就拒绝会重定向的 `manifestSource`，所以只影响创建之后地址才开始重定向的实例。mcp 实例、预置连接器实例、没有 `manifestSource` 的 http 实例不受影响。
- **升级后核对（可选，只读，结果记 `docs/private/`）**：在门宿主日志里查 `does not follow redirects`。正常没有命中。有命中时，把该实例的 OpenAPI 文档地址改成日志里给出的最终地址。
- **升级顺序**：不限。
- **回滚**：只回退代码即可。
- 下一次主机升级的提示要带上本节。

### 3.199 ssh 门的 `command_pattern` 必须匹配整条命令（#1346，遗留 195，0.69.2 之后的下一版）

无迁移。ssh 门以前只要 `command_pattern` 出现在命令里就放行，`^show\b` 会放行 `show x; reboot`。现在模式必须匹配整条命令。Operation 摘要不变，不需要重新接管。

- **含义变化（收窄，fail-closed）**：按前缀写的模式（如 `^show\b`）升级后只放行恰好是 `show` 的命令，带参数的命令会被拒（403 `operation_refused`）。空的 `command_template`、既没有模板也没有模式的 binding 改为普通失败。
- **不受影响**：`command_pattern` 是 `.*` 的 Operation（单行命令仍然都放行）；只用 `command_template` 的 ssh Operation（空模板除外）；http、mcp、cli、docker 门；策略表规则（仍在整行里查找，见遗留 148）。
- **升级前核对（可选，只读，结果记 `docs/private/`）**：看主机上 ssh 门的清单文件里有没有 `command_pattern` 不是整行写法的 Operation。只有 `.*` 的不用管。有的话，升级后相应调用会被拒，处置是把模式写成整行，参数只放普通字符，如 `show( [A-Za-z0-9_./:@%+=,-]+)*`。不要写成 `show\b.*`，那样第二条命令仍能搭车。
- **升级顺序**：不限。
- **回滚**：只回退代码即可。
- 下一次主机升级的提示要带上本节。

### 3.201 OpenAPI 导入读 path 级参数并展开文档内 `$ref`（#1354，遗留 197，0.69.2 之后的下一版）

无迁移。门宿主与内核同版本升级。OpenAPI 导入开始读 path 级参数，并展开文档内的 `$ref`（参数、请求体、schema）；读不到的引用不再让 Operation 接受任意参数。

- **含义变化**：
  - 用到 path 级参数或 `$ref` 的 http 门，升级后相关 Operation 的定义摘要会变，调用返回 409 `operation_definition_mismatch`，直到在控制台审阅采用、对齐并发布修订。往安全方向失败，不执行任何东西。
  - **会变严的一类**：请求体顶层是 `allOf` / `anyOf` / `oneOf` / `not` 的 Operation（包括 `$ref` 旁边写了与目标冲突的兄弟关键字），以前是接受一切的 `{}`，升级后只收参数、发不出请求体。
  - 引用很多、很深的文档，超出导入上限的 Operation 的 `params_schema` 是 `{"$ref":"#/x-nexttime-inline-limit"}`，调用 400 `invalid_operation_schema`。
  - **`$ref` 旁边的兄弟关键字（#1365，遗留 799，同一版）**：兄弟会改变目标关键字含义时（例如目标有 `properties` 和 `additionalProperties: false`，`$ref` 旁边又写了 `properties`），不再合并进目标，而是写成 `allOf` 与目标同时生效，这类 Operation 的定义也会变，处置同上。目标有 `properties`、`$ref` 旁边写 `additionalProperties: false` 的，这一处升级后只收空对象 `{}`；写在请求体顶层的，请求体不再读入。处置是把 `additionalProperties` 写进被引用的 schema，或手写 `params_schema`。`$ref` 旁边的 `nullable` 在目标没有 `type` 时忽略，不再让整个 Operation 编译失败。
  - **请求体的媒体类型与形状（#1368，遗留 798，同一版）**：请求体是其他媒体类型（multipart、`+json` 等）、数组或字符串的 Operation，以前接受任意参数，升级后只收自己声明的参数；要带这类请求体，就手写门清单的 `params_schema`。请求体写成 `application/json; charset=…` 或媒体类型大小写不同的 JSON，以前读不出（得到 `{}`），升级后**开始**按 JSON 读出请求体属性。这两类 Operation 的定义都会变，处置同上。
- **升级前核对（可选，只读，结果记 `docs/private/`）**：对每个以 OpenAPI 文档为清单源的 http 门实例，取文档看是否用到 path 级参数或 `$ref`，两个数都是 0 的门不受影响：

    ```sh
    jq '([.paths[] | select(has("parameters"))] | length), ([.. | objects | select(has("$ref"))] | length)'
    ```

  顺带数一下顶层组合的请求体（经 `$ref` 指过去的不在这个数里）：

    ```sh
    jq '[.paths[][]? | objects | .requestBody?.content?["application/json"]?.schema? // empty | select(has("allOf") or has("anyOf") or has("oneOf") or has("not"))] | length'
    ```

- **升级后**：在控制台看各 http 门的可达性，显示定义不一致的，按 §3.24 窗口后的步骤审阅采用、对齐、逐条发布修订。对齐前先看一眼新定义：请求体顶层是组合的 Operation 只剩参数，超过导入上限的 Operation 调用 400。这两类发布了也用不了，处置是手写门清单里的 `params_schema`，或者换一份文档（请求体写成带 `properties` 的对象、引用少一些）。
- **回滚**：只回退代码即可。
- 下一次主机升级的提示要带上本节。

### 3.202 门按参数 schema 自己的 JSON Schema 版本校验参数（#1387，遗留 803，0.69.2 之后的下一版）

无迁移，不需要主机操作。门宿主按 `params_schema` 的 `$schema`（没写时按所用关键字）选 draft-07、2019-09 或 2020-12 校验参数。Operation 定义与摘要不变，不需要审阅采用。

- **含义变化**：
  - **会变严**：`$schema` 写 2019-09 / 2020-12，或者用了 `unevaluatedProperties`、`prefixItems`、`dependentRequired` 等新版关键字的，这些约束开始生效，以前能过的调用可能返回 400 `invalid_params`。
  - **会变宽**：`$schema` 写 2019-09 / 2020-12（或用 `https` 写 draft-07）的 Operation，以前每次调用都是 400 `invalid_operation_schema`，现在能正常调用。
  - **会失败**：没写 `$schema`、把 `prefixItems` 等 2020-12 独有关键字和数组形式的 `items` 混用的 Operation，改为每次调用 400 `invalid_operation_schema`（schema 本身前后矛盾）。处置是改正门清单或文档里的 `params_schema`。
- **升级后**：调用开始出现 `invalid_params` 或 `invalid_operation_schema` 的，看对应 Operation 的 `params_schema` 是否属于上面几类。
- **回滚**：只回退代码即可。
- 下一次主机升级的提示要带上本节。

### 3.203 活跃 Fact 按类型、按时间读走索引（#1471，遗留 146，core 0063，0.69.2 之后的下一版）

**迁移 core 0063**：`links` 加两个只含活跃 Fact（`superseded_at is null and invalidated_at is null`）的部分索引，只加索引，不改数据、约束和授权；建之前先删掉同名的失效索引（0044 的写法）：

- `links_workspace_type_active_idx`，键为 `(workspace_id, link_type, date_trunc('milliseconds', recorded_at at time zone 'UTC') desc, id desc)`；
- `links_workspace_recorded_active_idx`，键为 `(workspace_id, recorded_at desc, id desc)`。

- **行为变化**：
  - `list_facts` 和 `get_entry_context` 的最近 Fact 直接读索引，不再每次扫整个工作区再排序。本地 120 万活跃 Fact 时，`list_facts` 首页 1.7 s → 0.9 ms，最近 Fact 15.8 s → 0.5 ms。
  - `list_facts` 的行、顺序、分页与原来相同，升级前拿到的游标照样能翻页。
  - `countFactsByLinkType`（图谱概况、入口上下文的类型计数）不变，见遗留 854。
- **升级影响**：迁移在一个事务里用普通 `create index`，建索引期间 `links` 被 SHARE 锁住：读照常，所有 Fact 写入（采集提交、Worker 上报、核对、作废）排队等两个索引建完。本地 160 万行（活跃 120 万，表 284 MB）共用 2.4 s，两个索引 78 MB 和 67 MB，约每百万活跃 Fact 2.5 s；主机磁盘慢的话可能要几倍。
- **升级前只读预检**（结果记 `docs/private/`）：先看活跃 Fact 有多少，据此估计锁要拿多久。

  ```sql
  select count(*) from links where superseded_at is null and invalidated_at is null;
  ```

  嫌排队时间太长，可以在上一版还在跑的时候，事务外提前建好（不阻塞写入）。迁移发现已有有效索引就什么都不建：

  ```sql
  create index concurrently if not exists links_workspace_type_active_idx
    on links (workspace_id, link_type, (date_trunc('milliseconds', recorded_at at time zone 'UTC')) desc, id desc)
    where superseded_at is null and invalidated_at is null;
  create index concurrently if not exists links_workspace_recorded_active_idx
    on links (workspace_id, recorded_at desc, id desc)
    where superseded_at is null and invalidated_at is null;
  ```

  `concurrently` 中途失败或被取消，会留下同名的失效索引，迁移会先删掉再建。
- **升级后只读核对**：
  - 下面两行的 `indisvalid` 都为 `t`：

    ```sql
    select c.relname, i.indisvalid from pg_index i join pg_class c on c.oid = i.indexrelid
     where c.relname in ('links_workspace_type_active_idx', 'links_workspace_recorded_active_idx');
    ```

  - core 迁移版本为 63。
- **回滚**：上一版本的代码不认这两个索引，直接跑在新 schema 上（见 §6 那一行），回退代码即可。要删索引：`drop index links_workspace_type_active_idx; drop index links_workspace_recorded_active_idx;`，再 `delete from schema_migrations where module = 'core' and version = 63`。
- 下一次主机升级的提示要带上本节。

### 3.204 门把「表示不存在的回答」按集合算摘要（#1493，遗留 860，0.69.2 之后的下一版）

- **行为变化**：门声明的「表示不存在的回答」（`absent_statuses` / `absent_exit_codes`）只换顺序时不再算定义变化：清单不进待采用，调用不被拒，清单审核里也不列。门和内核的 Operation 摘要都按从小到大的顺序计算这两项；已经按从小到大写的声明，摘要和以前逐字节相同。没有迁移，不改线上契约，不改写存着的 Operation 定义、门清单和摘要。
- **升级影响**：平台的门随本版一起升级，不用处理。工作区自己接入、基于旧版 gatekeeper-base 的门，如果清单里这项声明不是从小到大写的，升级后门算的摘要和内核的对不上，这个 Operation 的调用会被门拒绝（409 `operation_definition_mismatch`）。这时在控制台「采用」或「与门公告对齐」都恢复不了，因为门那边算的摘要还是旧的。
- **升级前只读预检**（以表的属主运行，和前面几节的预检一样；结果记 `docs/private/`）：查有没有声明乱序的 Operation，已发布的和草稿都查（草稿发布后同样会对不上）。

  ```sql
  select o.workspace_id,
         o.identity_key ->> 'gatekeeperId' as gatekeeper_id,
         o.identity_key ->> 'name' as operation,
         o.properties ->> 'status' as status,
         o.properties -> 'binding' as binding
    from objects o
    cross join lateral (
      select coalesce(o.properties -> 'binding' -> 'absent_statuses',
                      o.properties -> 'binding' -> 'absent_exit_codes') as declared
    ) d
   where o.object_type = 'Operation'
     and o.properties ->> 'status' in ('published', 'draft')
     and jsonb_typeof(d.declared) = 'array'
     and d.declared <> (select jsonb_agg(v order by v) from jsonb_array_elements(d.declared) v);
  ```

  没有结果就什么都不用做。有结果时：
  - 对应的是平台的门：不用处理。
  - 对应的是工作区自己接入、基于旧版 gatekeeper-base 的门：维护者把清单里这项声明改成从小到大写，或者用新版 gatekeeper-base 重建。
- **升级后排查**：出现 409 `operation_definition_mismatch`、但这个门的清单没有待采用的改动时，先看这项声明是不是从小到大写的。
- **回滚**：回退代码即可，没有迁移，存着的数据没有改写。回滚后，按新版重建、且声明乱序的自接门会和回滚后的内核对不上，情形同上；按从小到大写的声明在任何版本组合下都对得上。
- 下一次主机升级的提示要带上本节。

### 3.205 成员申请所有者启用平台门实例（#1521，遗留 254，governance 0047 + 0048，0.69.2 之后的下一版）

**迁移 governance 0047 与 0048**：都只改 `connection_requests`，随 `--pull` 自动执行，不改写已有的行。

- **0047**：
  - 加三列 `gate_instance_id`、`cancel_reason`、`cancelled_at`，都可空，不回填；`target` 去掉 `not null`。
  - 加四个约束：`connection_requests_one_subject`（`target` 和 `gate_instance_id` 恰好一个有值）、`connection_requests_gate_enable_not_admin_agent`、`connection_requests_cancel_reason`、`connection_requests_cancel_fields`（只有 `cancelled` 的行带取消原因和时间）。
  - 加部分唯一索引 `connection_requests_one_open_gate_enable`（同一个人对同一个门实例只有一条未完成的申请）和索引 `connection_requests_gate_instance_idx`。
  - 加平台平面的两条策略：`connection_requests_platform_read`、`connection_requests_platform_cancel`。平台只能把未完成的门实例申请取消为 `gate_unavailable`。
- **0048**：加一个 `BEFORE UPDATE` 触发器 `connection_requests_fixed_columns_guard`，不管哪个平面、哪个角色更新都生效，违反时报 23514：
  - 申请本身的列写下后不能改：工作区、id、类型、地址、门实例、申请人、申请时间。
  - `completed_by` 只在申请完成的那次更新里写。
  - 已经完成或取消的申请不能再改：不能改回 `requested`，也不能改完成人、完成时间、取消原因。

- **行为变化**：
  - 不能启用平台门实例的成员可以申请启用（`request_gate_instance_enable`）。申请进所有者在「系统与授权」的连接申请队列；所有者启用后申请完成；申请人可以撤回，所有者可以拒绝。
  - 以下情况会在同一个平台事务里，把这些门实例的未完成申请取消为 `gate_unavailable`：
    - 平台停用或删除门实例；
    - 把连接器移出平台预置模式；
    - 平台变更回滚停用门实例。
  - 平台审计行列出被取消的申请。工作区审计不加行，原因记在申请行上，工作区读得到。
  - 以前取消的申请没有取消原因（不回填）；谁取消的，写在它的 `connection.request_cancelled` 审计行里。
- **升级影响**：存量行都满足新约束：`target` 都有值，`gate_instance_id` 为空，以前取消的行两个取消字段都为空。加约束时 PostgreSQL 会校验存量行，`connection_requests` 是小表，很快。加约束、索引和策略期间这张表被短暂锁住，连接申请的读写排队，其他功能不受影响。没有需要手工执行的步骤。
- **升级前只读预检**（以表的属主运行，和前面几节一样；结果记 `docs/private/`）：

  ```sql
  select status, count(*) from connection_requests group by status order by status;
  select tgname from pg_trigger
   where tgrelid = 'connection_requests'::regclass and not tgisinternal order by tgname;
  ```

  - 第一条：记下各状态的条数，升级后对照。
  - 第二条：只应有 `connection_requests_admin_agent_session_guard`（governance 0037）。
- **升级后只读核对**：
  - `select version from schema_migrations where module = 'governance' and version in (47, 48) order by version;` 返回两行。
  - 上面查触发器的语句多出 `connection_requests_fixed_columns_guard`。
  - 各状态的条数和升级前一样，迁移不改写行。
  - 在还没有人申请或撤回之前，`select count(*) from connection_requests where gate_instance_id is not null or cancel_reason is not null or cancelled_at is not null;` 为 0。
- **回滚**（见 §6 两行）：
  1. 回退代码之前，先只读看有没有门实例申请：

     ```sql
     select status, count(*) from connection_requests where gate_instance_id is not null group by status;
     ```

  2. 有的话，在维护窗口里以表的属主把它们删掉。上一版把 `target` 当字符串读，留着这类申请，它的所有者队列会出错。这是写操作：只删门实例申请，没有别的表引用它们；它们的工作区审计行和平台审计行都留着。

     ```sql
     begin;
     delete from connection_requests where gate_instance_id is not null;
     commit;
     ```

  3. 回退代码。0047 和 0048 的 schema 可以留着：上一版只更新未完成申请的状态和完成列，0048 不拦它；它取消申请时不写取消原因，0047 的约束允许。
  4. 要连 schema 一起撤，先撤 0048，再撤 0047：
     - 0048：`drop trigger connection_requests_fixed_columns_guard on connection_requests; drop function connection_requests_fixed_columns_guard();`，再删 `schema_migrations` 里 governance 48 那一行。
     - 0047：删两条平台策略、两个索引、四个约束和三列，把 `target` 设回 `not null`（第 2 步之后所有行都有 `target`），再删 governance 47 那一行。
- 下一次主机升级的提示要带上本节。

### 3.206 Worker 运行中的工具调用落库（#1531，遗留 155 内核一半，task 0016，0.69.2 之后的下一版）

**迁移 task 0016**：新表 `worker_run_tool_calls`，随 `--pull` 自动执行，不回填，不动已有的表。

- **表**：每行是一个 WorkerRun 的一次工具调用记录。主键（工作区、WorkerRun、调用 id），同一个调用 id 只存第一次；`sequence` 1–200，同一个运行内唯一，一个运行最多 200 条；`content` 必须是 `kind = 'tool_call'` 且调用 id 与行一致的记录；外键指向 `worker_runs`。
- **权限**：工作区行级隔离（和 `tasks`、`worker_runs` 一样）；应用角色只有 `select`、`insert`，记录写下后不能改、不能删。删除工作区时和别的工作区表一起删（先于 `worker_runs`），清除预览里写「Worker 运行的工具调用」。
- **行为变化**：
  - Worker 在运行中把每次工具调用报给新能力 `report_tool_calls`（只能写自己这次运行的；调用结束就报，交结果之前全部报完，交结果之后不再报；回合结束时还没结束的调用记为「没有结束」）。内核按对话里工具调用的同一套规则遮蔽、截成预览再存；每次报告一条审计行，只记运行、条数和遮蔽数，不记调用内容。Worker 发送前会截短过大的参数和结果，但参数里秘密字段的值总会一起发出（内核要用它们遮住结果里的回显）；极少数放不进一次报告的调用不带结果发送。
  - 能读这个 Task 的人（所有者、请求人）用新能力 `get_task_tool_calls` 按 Task 读，按运行开始先后、每个运行内按报告顺序分页；别人读得到的是和不存在的 Task 一样的 404。控制台的显示由控制台一半接着做。
  - 只有 Handle 带 `report_tool_calls` 的 Worker 才报（`get_task` 的 `callerCapabilities` 里有它）：升级前签发的 Handle、评测运行的封闭 Handle 都不报，照旧只有会话文件里有。
  - 记录是 Worker 运行时自己的说法；它在门上做了什么，仍以审计里的 `observe_operation` / `request_action` 行为准。
- **升级影响**：只建一张空表和它的策略、授权，很快，不锁已有的表。升级前已经开始的运行没有记录。没有需要手工执行的步骤。
- **升级后只读核对**（以表的属主运行，结果记 `docs/private/`）：
  - `select version from schema_migrations where module = 'task' and version = 16;` 返回一行。
  - `select privilege_type from information_schema.role_table_grants where table_name = 'worker_run_tool_calls' and grantee = 'nexttime_app' order by 1;` 只有 `INSERT`、`SELECT`。
  - 升级后第一个跑完、用过工具的 Worker 之后，`select count(*) from worker_run_tool_calls;` 大于 0。
- **回滚**（见 §6 一行）：只需回退代码，上一版从不读写这张表。还在用新运行时镜像的 Worker 遇到上一版内核时，Handle 里没有 `report_tool_calls`，不会去报。要连 schema 一起撤：`drop table worker_run_tool_calls`，再删 `schema_migrations` 里 task 16 那一行（记录随之丢失，它们只在这张表里）。
- 下一次主机升级的提示要带上本节。

### 3.207 签发 Handle 时可写备注，列表带会话短编号（#1549，遗留 168 补充，governance 0049，0.69.2 之后的下一版）

**迁移 governance 0049**：`sessions` 加一列 `note`（可空）和约束 `sessions_note_bounded`，随 `--pull` 自动执行，不回填。

- **约束**：`note` 为空，或是 1–200 个字符、首尾没有空格的文本。内核写入前已经去掉首尾空白、空白当作没有备注，长度上限和线上契约一致（`HANDLE_NOTE_MAX_LENGTH`，200），所以内核接受的备注总能写进去。
- **行为变化**：
  - `issue_handle`、`issue_service_handle` 多一个可选参数 `note`：说明这个客户端拿来做什么（如「备份采集器」）。去掉首尾空白；空白等于没有；超过 200 个字符返回 400。审计参数副本会删减的内容（Handle、平台 API key、厂商密钥、`Bearer` 值、`password: …`、URL 里的密码等，`findSuspectedSecrets`）出现在备注里时返回 400 `invalid_params`，什么也不写，报错只说是 `note`，不回显内容；所以存下和列出的备注总和审计行一致。
  - 密钥识别多一种形态：单独出现的平台 API key（恰好 43 个 base64url 字符，大小写混合且含数字、`-` 或 `_`，即 `generateApiKey` 生成的格式）。它在所有脱敏处（对话实时流与工具调用记录、落库的回复、能力调用的审计参数副本、Worker 报告等）换成 `[redacted]`。以前这种 key 没有前缀可认，会以原文留下。
    - 只遮不拒：任何 32 字节值的 base64url 编码都是这个形状（base64url 的 SHA-256 摘要、JWK 里 Ed25519 公钥的 `x`、随机 id），所以它不在高置信规则里。观察类调用的参数和管理员提案里出现这种值照常放行，只在审计副本里遮住并计数，不会因此返回 400。签发备注用的是完整规则，贴进 key 仍然拒收。
    - 门地址例外：门的 `target`、`manifestSource` 按地址规则判断（遗留 186：地址里不能带凭据）。这种形状单独出现在查询串、片段或 `@` 之后等位置时，处理如下；路径段里的不算，因为前面紧挨着 `/`：
      - **写入**：建连接申请、注册门、建门实例都返回 400 `credentials_in_connection_params`，其余写门地址的入口同理（门公告只在地址变了时拒；`enable_gate_instance` 对已存的这种实例也拒，见 §3.25）。base64url 的 32 字节摘要和 key 同形，也会被拒。
      - **升级清洗**：这类地址计入 `connectionTargets`、`gatekeeperAddresses`、`gateInstanceAddresses`，只计数。门实际调用的地址不改。
      - **展示副本**：4 类（`selfConnectionAddresses`、`gatekeeperNames`、`connectedSystems`、`connectionActivities`）按读侧的显示规则单向剪掉 userinfo、查询串和片段，剩下的形状换成 `[redacted]`。只能从 `BACKUP_NOW` 恢复。
    - 「单独」指前后都不紧接任何一种 base64 的字符：base64url 的字母表、标准 base64 的 `+` 和 `/`，后面也不能是 `=`。所以标准 base64 编码的 32 字节值（WireGuard 公钥、`Digest: SHA-256=…`、S3 校验和，都是 43 个字符加 `=`），以及证书正文、data URI 这类大块 base64 里的任何片段，都不算 key，不会被遮住。
    - 接受的过度脱敏：单独出现、恰好 43 个字符、同时含大写、小写和数字（或 `-`、`_`）的 base64url 串都会被遮住。除了平台 key，主要是 base64url 编码的 32 字节值（SHA-256 摘要、JWK 公钥），偶尔是很长的驼峰标识符。Worker 报告、图谱写入这类存脱敏副本的地方，存下的也是遮住后的值。
    - 接受的漏检只有一种：紧跟在 `/` 或 `+` 后面的 key，比如写进 URL 路径里的。平台 key 只通过 `Authorization: Bearer` 传，不会出现在路径里。
  - 两个签发结果和 `list_handles` 的每一行多两个字段：`sessionShortId`（会话 id 的前 8 位十六进制，小写；由 id 算出，不是 token 的片段，不唯一）和 `sessionNote`（没有备注时为 `null`）。入口、Worker、管理员智能体等平台持有的会话没有备注，但有短编号。
  - `revoke_handle` 的审计行多一个 `sessionShortId`，和列表里看到的一致。撤销仍按完整的 Handle id 走，短编号只给人看。
  - 主机命令 `issue-service-handle` 还不能写备注；`list_external_runtimes` 还不显示备注和短编号。控制台的显示由控制台一半接着做。
- **升级影响**：加列只改元数据；加约束要扫一遍 `sessions`（所有行的 `note` 都为空，校验只是读一遍），期间这张表被短暂锁住，签发 Handle、开新对话、启动 Worker 排队，其他功能不受影响。没有需要手工执行的步骤。
- **这次升级的存量清洗：平台 key 形状只计数，不改写**。`--pull` 在 `BACKUP_NOW` 之后照常自动跑 `scrub-raw-secrets --yes`（`STEP raw-secret-scrub`，见 §3 开头的「存量清洗」一段）。
  - **改写的 3 类不认这种形状**：历史 agent Turn 的摘要和决定（`turnReports`）、agent 记录的 Decision 摘要（`decisions`）、工具调用记录的结果预览（`toolCallRecords`）照旧按其他规则改写（单向，只能从这次的 `BACKUP_NOW` 恢复），但不改写单独出现的 43 个 base64url 字符。任何 32 字节值的 base64url 编码（摘要、公钥）都是这个形状，改了就再也恢复不了。新写入的内容照上面的规则遮住。
  - **新增 3 个只计数类别**：`turnReportKeyShapes`、`decisionKeyShapes`、`toolCallRecordKeyShapes`，列出这 3 张表里仍留着这种形状的行。日志按 `counted <类别> <工作区>/<id>` 逐行列出，不含值；不改写，所以每次运行都会再计。
  - **原有的只计数类别**（Fact 和 Object 的属性、任务输入、`auditResults`、`gateCallObservations`）用完整规则判断，含这种形状的行也会被计入，同样只计数。
  - 其他审计行（能力调用的参数副本等）里存着的平台 key 不在这次清洗范围内，由审计存量那一项另行处理（§3.208：`auditPayloads`）。
  - 预检 SQL（`scrub-raw-secrets.preflight.sql`）按关键字匹配，认不出没有前缀的 key，所以它给的上界不含这种形态。精确计数看这一步的日志和 `cli.raw_secrets_scrubbed` 审计行；把各类计数记 `docs/private/`。
  - **处置**（victor 在主机上决定和执行）：按 §3.208。清洗在改写之前把全库每一行里的形状与仍有效的 key 比对（`liveApiKeys`），只输出表名和行的主键、API key 的 id 和账号 id；按清单逐个轮换，再复跑确认「仍有效」归零。不要手工改这些行。
- **升级前只读预检**（以表的属主运行，和前面几节一样；结果记 `docs/private/`）：`select count(*) from sessions;` 记下行数，估计加约束时锁表多久（本地 100 万行、数据在缓存里时约 0.2 s；主机磁盘慢、数据不在缓存里时会更久）。
- **升级后只读核对**：
  - `select version from schema_migrations where module = 'governance' and version = 49;` 返回一行。
  - `select column_name from information_schema.columns where table_name = 'sessions' and column_name = 'note';` 返回一行。
  - 在还没有人带备注签发之前，`select count(*) from sessions where note is not null;` 为 0。
- **回滚**（见 §6 一行）：只需回退代码。上一版按列名插入 `sessions`，从不读写 `note`，新约束对空值总成立；新版本写下的备注留在表里，上一版看不到。要连 schema 一起撤：`alter table sessions drop column note`（约束随列删除，备注随之丢失），再删 `schema_migrations` 里 governance 49 那一行。
- 下一次主机升级的提示要带上本节。

### 3.208 存量里的平台 API key：审计行计数，全库比对仍有效的 key，按清单轮换（#1553，遗留 168 补充的审计存量，0.69.2 之后的下一版）

没有迁移。改的是 `scrub-raw-secrets`，也就是 `--pull` 在 `BACKUP_NOW` 之后自动跑的 `STEP raw-secret-scrub`（§3.25）。新写入的内容自 §3.207
起在写入时就遮住平台 key（能力调用的参数副本、批准与拒绝的原因、门结果的审计副本、Worker 报告等），这一节只处理之前存下的。

- **行为变化**：
  - **只计数的类别多 1 类，共 12 类**：`auditPayloads`，即 payload 里有值规则会删减内容的审计行，不分 action。日志照旧逐行打印
    `counted auditPayloads <工作区>/<id>`（平台级行只有 `<id>`），不含值。
    - 只按值判断，不看字段名：审计 payload 自己的字段（`credentialReview`、`suspectedSecretValues`）名字就像秘密，按字段名判会全部计入。
    - 会计入的有三种：遗留 180 之前写下的参数副本原文；§3.207 之前写下的平台 key；只是长得像 key 的值（base64url 编码的 32 字节摘要、公钥）。
    - 审计只增不减（I11），这个计数不会归零，也不需要处置。`action_request.complete` / `.fail` 的行可能同时计入 `auditResults`。
  - **全库比对仍有效的 key（`liveApiKeys`）**：清洗在改写任何东西之前，先把全库读一遍，再与现有的 key 比对。对上的就是仍然签发着的 key。
    - **读哪些**：`public` schema 的每张表、每一行，每个文本、JSON 和文本数组列。表和列从系统目录读，以后迁移新加的表也自动在内。只跳过
      两列凭据自己的哈希：`principals.api_key_hash` 和 `users.password_hash`。所以人发的对话消息、agent 的回复、能力调用的
      `action_requests.params`、Worker 的报告、备注、提案等，凡是 key 可能被贴进或回显的地方都在内，不只是上面各类别读的那些列。
    - **怎么比**：每个平台 key 形状（单独出现的 43 个 base64url 字符，§3.207）按 `principals.api_key_hash` 的算法算 sha256，到 `principals`
      里查。在 JSON 的值、对象键和数组里都找。
    - **日志**：每对上一处打印一行 `live-api-key <表> <行> principal <工作区>/<Principal id> <human|service>[ user <用户 id>]`。
      - `<行>` 是这一行的主键，多列时用 `/` 连接：大多数表是 `<工作区>/<id>`，`audit_records` 只有 `<id>`，没有主键的表给 `ctid`。
        主键里某一列的值会被值规则删减，或含 43 个以上连续的 base64url 字符（有人把 key 或 Handle 用作或嵌进了连接器名之类的文本主键），
        这一列整个换成 `[redacted]`，日志和审计行都不出现它。uuid 只有 36 个字符，不受影响；44 个字符以上的 `gate_id`、`check_key` 这类名字也会显示成
        `[redacted]`，处置不需要它们，按 Principal 轮换即可。
      - 同一行里有两把 key 就打两行。
      - Principal id 就是这把 key 的 id，一个 Principal 只有一把；`user` 是人的账号 id，服务凭证没有。
      - 不输出 key 的任何片段，不输出哈希，也不输出是哪一列。
    - **报告和审计行**：报告多一行 `liveApiKeys (still issued, rotate each): tables=<表数> rows=<行数> keys=<数> found=<处> principals=…`，
      `tables` 和 `rows` 是这次比对读了多少。最后的汇总行多一项 `liveApiKeys=<数>`，数的是要轮换的 key（按 Principal 去重）。
      `cli.raw_secrets_scrubbed` 审计行多一个 `liveApiKeys`，含计数和前 20 处，同样只有 id。
    - **`liveApiKeys=0` 说明什么**：库里存着的每一行都没有单独出现的、仍有效的 key。它不覆盖库以外的副本（`BACKUP_NOW` 的备份文件、
      日志），也认不出不是单独出现的 key（比如被编码进更长的 base64 串里）。
    - 所在工作区或用户被停用的 key 也算仍有效：重新启用后它又能用。Principal 被停用后 key 已清除（core 0059），不会再对上。
- **处置**（victor 在主机上决定和执行，结果记 `docs/private/`；只读，或只动清单上的账号）：
  1. **取清单**：在这次升级的清洗日志 `drills/apply-<tag>-<ts>-raw-secret-scrub.log` 里找 `live-api-key` 开头的行，就是清单；汇总行的
     `liveApiKeys=` 是要轮换的 key 数，为 0 就到此为止。**以这一次的清单为准**：改写类别里的 key 如果写成了 `Bearer <key>`，或在名字像秘密的
     JSON 字段里，这次改写会把它遮住，之后的运行再也看不到它，但 key 本身仍然有效。清单与各类计数一起记
     `docs/private/`。
  2. **按清单逐个轮换**，每个 Principal 一次，与它出现了几处无关：
     - `service`：工作区 owner 在控制台「治理 → 成员与授权」打开这个服务凭证，点 Rotate API key，把新 key 换到在用它的自动化里
       （`key-rotation.md` §5）。确定不再用的，可以停用（`disable_principal`）。
     - `human`：运维 CLI 早年签发给人的遗留 key（`key-rotation.md` §5.1）。由该用户在控制台改一次密码，或平台管理员重置其密码；这会清掉此人
       所有成员身份的 key，不再补发（D-25）。还在用这把 key 的脚本或验收，改用服务凭证。
     - 清单里的行不用改，审计行也改不了（审计只增）。key 失效之后，那串字符就没有用了，备份文件和日志里的副本也一样。
  3. **复跑确认归零**（dry run，什么都不写，也不写审计行；经 SSH 时用 `ssh -n`）：

     ```sh
     docker compose run --rm --no-deps -T kernel node dist/cli/scrub-raw-secrets.js </dev/null \
       | grep -E '^(live-api-key |scrub-raw-secrets: dry-run )'
     ```

     期望只打印一行汇总，其中 `liveApiKeys=0`；多出来的 `live-api-key` 行就是还没轮换的。复跑只能看到库里还存着的副本，所以第 1 步清单上的
     每个 Principal 都轮换过，才算完成。
- **升级影响**：`STEP raw-secret-scrub` 会更久。比对要把全库再读一遍，每张表按主键分批，读的量和 `BACKUP_NOW` 的备份相当；`auditPayloads`
  还要按 id 分批读一遍 `audit_records`。可参考这次 `BACKUP_NOW` 的耗时，或用 `select pg_size_pretty(pg_database_size(current_database()));`
  估计。比对时，每批最多按哈希查一次 `principals`（走 `api_key_hash` 的唯一索引）。
  - **内存**：比对每批 200 行，一批的行同时在清洗进程的内存里，峰值随行的大小涨。本地实测 dry run 的峰值 RSS：空库约 140 MB；
    加一张 1,000 行、每行一条落库上限大小（256 Ki 个中文字符）回复的表后约 400 MB，耗时约 7 秒。
  - 改写与写入的行为都没变。
- **预检 SQL**：认不出没有前缀的 key（§3.207），这次不加列。精确计数看清洗日志。
- **回滚**（见 §6，没有迁移）：只回退代码。上一版的清洗没有 `auditPayloads` 和比对，其他照旧。
- 下一次主机升级的提示要带上本节。

### 3.209 owner 查找可添加的平台用户（遗留 150，core 0064，0.69.2 之后的下一版）

**迁移 core 0064**：只加一个 `security definer` 函数 `lookup_users_for_owner(text, integer)`，随 `--pull` 自动执行，不动数据，不锁表。

- **函数**：只回答本事务所在工作区里有效（没停用）的 human 或 service owner，其他调用者报 42501。按登录名或显示名子串匹配（去掉首尾空白、不区分大小写，至少 2 个字符，`%`、`_` 不是通配符）。只列 `add_member` 能加的用户：没停用、不是本工作区的有效成员、不是验收残留（与 `list_users` 的 `hideResidual` 同一条件）。只返回登录名和显示名，最多 21 行。`search_path` 是 `public, pg_temp`，PUBLIC 没有执行权限，只授给 `nexttime_app`。
- **行为变化**：新增能力 `lookup_users`（只在人的通道，minRole owner）：工作区 owner 按登录名或显示名查找可以添加的平台用户，最多 20 条，多了带 `truncated`。以前不是平台管理员的 owner 只能手打登录名。控制台的搜索选择由控制台一半接着做。
- **升级影响**：没有需要手工执行的步骤。
- **升级后只读核对**（以表的属主运行，结果记 `docs/private/`）：
  - `select version from schema_migrations where module = 'core' and version = 64;` 返回一行。
  - `select proconfig from pg_proc where proname = 'lookup_users_for_owner';` 含 `search_path=public, pg_temp`。
- **回滚**（见 §6 一行）：只需回退代码，上一版从不调这个函数。要连 schema 一起撤：`drop function lookup_users_for_owner(text, integer);`，再删 `schema_migrations` 里 core 64 那一行。
- 下一次主机升级的提示要带上本节。

### 3.210 新签发的平台 API key 带 `ntk_` 前缀（遗留 906 第一步，0.69.2 之后的下一版）

没有迁移，不需要主机步骤。

- **行为变化**：
  - **新 key 的格式**：内核新签发的平台 API key 是 `ntk_` 加 43 个 base64url 字符，共 47 个字符。签发的地方有：
    `create_principal`、`rotate_api_key`，以及运维 CLI 的 `create-workspace`（给 owner 的 key）和 `add-principal`。
    - 之前签发的 key 照常能用。库里只存 key 的 sha256，按哈希查找，不看格式。
    - 用 key 的自动化不用改，换 key 时照常换整串。
  - **识别带前缀的 key**：`ntk_` 加 43 个 base64url 字符。前面紧接字母或数字时不算（那是别的词的结尾）；紧跟在 `_`、`-`、`/` 后面也算
    （`call_ntk_…`、URL 路径）。JSON 转义（`\n`、`\t`、`\r`、`\b`、`\f`、`\uXXXX`）和 URL 编码（`%20`、`%2F` 这类 `%XX`）之后也算，
    虽然它们以字母或数字结尾：工具结果是 JSON 文本，单独占一行的 key 在里面是 `…\nntk_…`；Python 的 `json.dumps` 把中文写成 `\uXXXX`。
    后面还连着字符时，只遮前缀和 43 个字符。和 §3.207 的旧格式不同，摘要和公钥不会是这个形状，所以它进了所有规则：
    - 所有脱敏处都换成 `[redacted]`，与 §3.207 的范围相同。
    - 拒收凭据用的高置信规则也认它：观察类调用的参数（400 `credentials_in_observe_params`）、目标核验的参数、管理员提案的内容和原因里出现
      带前缀的 key，会被拒收；旧格式的照旧只遮不拒。签发 Handle 的备注照旧拒收两种格式。
    - 升级清洗改写历史 Turn 报告、Decision 和工具调用记录时，会把带前缀的 key 遮住（§3.208 不改写的只是旧格式的形状）。本版之前不可能有带前缀
      的 key，所以升级时实际不会改到它。
    - 升级清洗的 `liveApiKeys` 比对（§3.208）也认带前缀的 key：库里任何地方存着一把仍有效的带前缀 key，都会列出来。
  - **旧格式的识别规则（§3.207）暂时保留**：主机上仍有效的旧 key 还是这个格式，去掉它，这些 key 贴出来就不会被遮了。所以本版之后，
    base64url 编码的 32 字节摘要和公钥仍会被遮住（§3.207 接受的过度脱敏）。
    - 它也补上了 JSON 转义之后的盲区：工具结果里单独占一行的旧 key（`…\n` 之后）以前原样留下，现在会被遮住，`liveApiKeys` 比对也认得出。
      仍然只遮不拒。
    - URL 编码之后仍不算：`%2F`、`%2B` 代表的 `/`、`+` 后面，这个形状本来就不算（§3.207）。
  - **Handle 与厂商 key 也补上同一处**：compact JWT（Handle 的形状）和厂商 key（`sk-`、`ghp_`、`AKIA` 等）跟在 JSON 转义或 URL 编码之后，
    以前原样进工具调用记录和 `chat.stream`，现在会被遮住；两者都在高置信规则里，出现在观察类调用参数等处时会被拒收，和不带转义时一样。
  - **这次升级的存量清洗会多改写一类历史行**：`--pull` 在 `BACKUP_NOW` 之后自动跑的 `STEP raw-secret-scrub`（§3.25）用的改写规则也跟着变了。
    - 历史 Turn 报告、Decision 和工具调用记录里，跟在 JSON 转义或 URL 编码之后的 Handle 形状 JWT 和厂商 key，这次会被改写成 `[redacted]`。
      工具调用记录的结果预览是 JSON 文本，主要是它。
    - 旧格式形状照旧只计数、不改写（§3.208），但 JSON 转义之后的也会计入，`liveApiKeys` 比对也认得出。
    - 计数看这一步的日志和 `cli.raw_secrets_scrubbed` 审计行，记 `docs/private/`。
  - **平台 key 规则排在厂商规则前面**：key 的随机部分偶尔会拼出 `-sk-` 加 16 个字符，以前厂商规则先遮住这一段，key 的开头留在输出里
    （约百万分之二）。现在整把 key 一起遮住。
- **第二步（遗留 906，另开 PR）**：去掉旧格式的识别规则，摘要和公钥从此不再被遮。开启条件是主机上不再有仍有效的旧格式 key。
  - 只有维护者能确认这一点：库里只存哈希，内核分不出一把 key 是新格式还是旧格式。
  - 和 §3.208 的处置同一时机做，结果记 `docs/private/`：
    1. **在 apply 之前**只读列出持有 key 的 Principal，作为基线（以表的属主运行）。这时它们的 key 全是旧格式：

       ```sql
       select workspace_id, id, kind from principals where api_key_hash is not null;
       ```

       - 不能等到升级之后再列：`apply-release.sh` 自己跑的 S1–S4 验收会先签发带前缀的新 key，之后的清单里新旧混在一起，库里又分不出格式。
       - 升级后把同一条查询再跑一次，和基线对照：两边都有的 Principal 仍持旧格式 key，要轮换。只在升级后出现的，是本次验收夹具新签的 key
         （ephemeral 工作区，到期自动清理），不在轮换范围。
       - 升级前没取基线的，把升级后清单里 ephemeral 验收工作区的 Principal 去掉，剩下的都当旧格式处理。

    2. 逐个轮换，做法同 §3.208 第 2 步，不限于清单上的：
       - `service`：Rotate API key，或者停用。
       - `human`：由本人改一次密码，或由平台管理员重置。
    3. 记下清单与每个的处理结果，告诉协调线程开第二步。
- **升级影响**：没有需要手工执行的步骤。第一次轮换或新建服务凭证时，控制台显示的新 key 以 `ntk_` 开头。
- **回滚**（见 §5，没有迁移）：只回退代码。
  - 存量清洗的遮蔽是单向的：回退代码不会恢复原文，旧代码照常读遮蔽后的文本。只有这次 `BACKUP_NOW` 的备份能带回原文，只用于灾备（同 §3.25）。
  - 本版签发的带前缀 key 回滚后仍能认证，但上一版认不出它：它贴进对话、备注或调用参数时不会被遮住。
  - 所以回滚后，把本版签发过的 key 再轮换一次，上一版签发的是旧格式。
- 下一次主机升级的提示要带上本节。

### 3.211 工具结果里单独占一行的 env 行、`--password` 等也会被遮住（遗留 916，0.69.2 之后的下一版）

没有迁移，不需要主机步骤。

- **行为变化**：
  - **以前漏在哪**：工具结果是 JSON 文本，值规则以前按原文读它，有两处漏：
    - 输出的每一行在 JSON 里都跟在 `\n` 后面。按名字认的值规则把 `\n` 的 `n` 当成前一个词的结尾，名字就认不出来了。
      涉及的写法：env 行（`PGPASSWORD=…`）、行首的 `Bearer` / `Basic`、`--password`、YAML 和 ini 的 `password:`、查询串的 `api_key=`。
    - 带双引号的值（`API_TOKEN="…"`、`password: "…"`）在 JSON 里写成 `\"…\"`。上面这些规则把开头的 `\` 当成整个值，
      遮完停在引号，真正的值留下，落库成 `API_TOKEN=[redacted]"…\"`。不跟在 `\n` 后面也会这样。
    - 这些值以前原样进工具调用记录和 `chat.stream`。`Authorization` 头、URL 里的密码、PEM 私钥不受影响。
    - 纯文本（不是 JSON 文本的结果，比如脚本、compose 文件、源码）里本来就写成 `\"…\"` 的值不在本修复内，见 §3.212。
  - **现在怎么读**：内核读这类 JSON 文本时，含转义的字符串值先解码，再跑一遍值规则和调用参数里遮住的值。
    - 参数里的密码含引号或反斜杠时，JSON 里写成 `\"`、`\\`，以前按原文认不出来，现在也会被遮住。
    - 解码读过的字符串，按原文的那一遍不再读，免得把写回的 `\"[redacted]\"` 又改坏。
    - 工具结果超过读取上限、被截断在某个字符串中间时，这个字符串也解码；截断拆开的转义（单独的 `\`、不足四位的 `\u`）不参与解码，原样留在末尾。
  - **写回的格式**：改动过的字符串按 `JSON.stringify` 重新写回，其中别的转义变成最短写法（`\u4e2d` 写成「中」，`\/` 写成 `/`）。
    没改动的字符串逐字节不变。键名不扫。字符串里又嵌一层 JSON 文本的（双重编码）只解一层。
  - **用到的地方**：
    - 实时 `chat.stream` 里的工具结果。
    - 工具调用记录的结果预览，包括 Worker 运行中落库的（§3.206）。
    - 升级清洗改写历史工具调用记录（见下）。
    - 升级清洗给 Worker 门调用 Observation 计数（`gateCallObservations`，§3.25）：被截断、存成文本的那种也这样判断，可能多计入几行，仍只计数。
      新写入的 Observation 本来就按解析后的值遮蔽，不受影响。
- **这次升级的存量清洗会多改写一类历史行**：`--pull` 在 `BACKUP_NOW` 之后自动跑的 `STEP raw-secret-scrub`（§3.25）改写历史工具调用记录时也走这一遍。
  - 历史工具调用记录的结果预览里，跟在 JSON 转义之后的上述值，这次会被改写成 `[redacted]`，所在的字符串按上面的格式重新写回。
    截在 16,000 字符的长预览，最后那个字符串也解码。
  - 以前被拆坏、值留在原处的 `[redacted]"…\"`，这次改写成现在会写出的 `\"[redacted]\"`，记录重新是合法 JSON。
    - `[redacted]` 前面必须是名字规则的分隔符（`=`、`:`、空格或 tab），中间不能有未转义的引号或换行这类控制字符。纯文本也改，见 §3.212。
    - 合法 JSON 里，闭合引号后面在下一个未转义的引号之前不可能出现 `\"`，完整写出的 `"[redacted]"` 前面是引号，所以只有被拆坏的地方会被改写。
      纯文本里正常写出的 `TOKEN="[redacted]"` 不受影响，以 `[` 或 `{` 开头的日志行（`[INFO] password="[redacted]" msg=\"x\"`）也不受影响。
    - 截在 16,000 字符的长预览，如果截断点正好落在被拆坏的值中间，后面没有 `\"`，这个值在截断点之前的部分会留下。
  - 旧格式平台 API key 的形状解码后也照旧只计数、不改写（§3.208）。
  - Worker 运行中的工具调用记录（§3.206）和本修复同版上线，没有需要清洗的存量。
  - 计数看这一步的日志和 `cli.raw_secrets_scrubbed` 审计行，记 `docs/private/`。
- **升级影响**：没有需要手工执行的步骤。
- **回滚**（见 §5，没有迁移）：只回退代码。
  - 存量清洗的遮蔽是单向的：回退代码不会恢复原文，旧代码照常读遮蔽后的文本。只有这次 `BACKUP_NOW` 的备份能带回原文，只用于灾备（同 §3.25）。
  - 回滚后，新写入的工具结果里跟在 `\n` 之后的值、带双引号的值又会原样留下。
- 下一次主机升级的提示要带上本节。

### 3.212 纯文本里写成 `\"…\"` 的值也会被遮住（遗留 918，0.69.2 之后的下一版）

没有迁移，不需要主机步骤。

- **以前漏在哪**：
  - 脚本、compose 文件、源码、日志里，带引号的值常写成 `\"…\"`。例如 `sh -c "export API_TOKEN=\"…\""`、`command: "PGPASSWORD=\"…\" psql"`、`const s = "password: \"…\"";`、`--password \"…\"`。
  - 按名字认的规则（env 行、`password:`、`--password` 等）把开头的 `\` 当成整个值，遮完停在引号，真正的值留下，写成 `API_TOKEN=[redacted]"…\"`。
  - 凡是经值规则的地方都这样：实时 `chat.stream` 的回复与工具结果、工具调用记录、Turn 报告、决策、审计参数副本。§3.211 修的是 JSON 文本里的这种写法，这里是纯文本。
- **现在怎么读**：
  - `\"…\"` 当作一个带引号的值，到同一行的下一个 `\"` 为止，整体换成 `\"[redacted]\"`。
  - 已经是 `\"[redacted]\"` 的不再计数。同一行没有收尾 `\"` 的照旧（§3.213 起也遮住）。
  - 实时 `chat.stream` 分段扣留时也认 `\"` 开头的值，收尾之前不放出。
- **这次升级的存量清洗会多改写几类历史行**：`STEP raw-secret-scrub`（§3.25）改写时，先把以前拆坏的 `[redacted]"…\"` 改回 `\"[redacted]\"`，每处计 1。
  - 历史工具调用记录：§3.211 的这一步不再只看以 `{`、`[` 开头的 JSON 文本，纯文本也改。
  - Turn 报告（`turnReports`）的 summary 和 decisions、agent 决策（`decisions`）的 summary：也先做这一步，再按存量规则改写。
  - 条件同 §3.211：`[redacted]` 前面是名字规则的分隔符，到下一个 `\"` 之间没有未转义的引号、换行或其他控制字符。完整写出的 `"[redacted]"` 前面是引号，不受影响。
  - 分不出来的两种写法：到同一行下一个 `\"` 为止的文本会被当成值改写，中间的非密钥文本丢掉，每处多计 1，不会露值。
    - 裸值后面紧跟一个收尾引号，同一行后面又出现 `\"`：例如 `-e "PW_TOKEN=[redacted]" img \"x\"`，中间的 ` img ` 丢掉。
    - 名字和裸值写在 `\"…\"` 里面：例如 `-e \"API_TOKEN=…\" -e \"DEBUG=1\"`，裸值连收尾 `\"` 的 `\` 一起取走，写成 `\"API_TOKEN=[redacted]" -e \"DEBUG=1\"`；改写后是 `\"API_TOKEN=\"[redacted]\"DEBUG=1\"`，` -e ` 丢掉。`curl -H \"X-Api-Key: …\" -d \"{}\"`、`echo \"password=…\" && echo \"done\"` 同样。
    - 不只是历史行：本版写入时仍会写出第一种形状（第二种 §3.213 起不再写出），而存量清洗每次升级都扫全库，所以本版之后新写的这种行，也会在之后的升级里被改写一次（改写后不再变），直到存量修复下线。
  - 计数看这一步的日志和 `cli.raw_secrets_scrubbed` 审计行，记 `docs/private/`。
- **升级影响**：没有需要手工执行的步骤。
- **回滚**（见 §5，没有迁移）：只回退代码。
  - 存量清洗的改写是单向的：回退代码不会恢复原文。只有这次 `BACKUP_NOW` 的备份能带回原文，只用于灾备（同 §3.25）。
  - 回滚后，新写入的 `\"…\"` 值又会原样留下。
- 下一次主机升级的提示要带上本节。

### 3.213 多转义一层的值、写进字符串里的 JSON 键值、同一行没收尾的 `\"` 值与 JSON 值也会被遮住（遗留 919、921，0.69.2 之后的下一版）

没有迁移，不需要主机步骤。

- **以前漏在哪**（#501、#493 复看 #1575 时实测，main 上就有）：
  - 日志里打印的 JSON 字符串，里面的 `\"…\"` 又转义一层，写成 `\\\"…\\\"`，例如 `"cmd": "export API_TOKEN=\\\"…\\\""`。按名字认的规则把开头的 `\\\` 当成整个值，值留下。
  - JSON 文本又写进一个字符串里，引号都变成 `\"`，例如 `payload={\"password\":\"…\"}`。名字规则要求名字后面紧跟分隔符，JSON 键值规则的键里不能有 `\`，两条都读不到它，值整段留下。
  - 同一行没有收尾引号的值（工具输出被截断、字符串跨行、在 `\r` 前收尾）：`\"…` 只有开头的 `\` 被当成值，JSON 键值里没收尾的字符串根本不算值。值都留下（遗留 921）。
  - 凡是经值规则的地方都这样：实时 `chat.stream` 的回复与工具结果、工具调用记录、Turn 报告、决策、审计参数副本。
- **现在怎么读**：
  - 值以奇数个反斜杠加引号开头的（`\"`、`\\\"`、`\\\\\\\"`，最多 7 个反斜杠，即三层），读到同一行的下一个引号为止，要由同样长的一串收尾，整体换成同样层数的 `\\\"[redacted]\\\"`。更长的一串按下面没收尾的值读，值照样遮住。
  - `\"键\": \"值\"`：键按 JSON 键值规则认；值里内层的转义都是两个反斜杠（`\\\"`、`\\\\`、`\\n`），所以第一个不属于它们的 `\"` 收尾，整体换成 `\"[redacted]\"`。
  - 以反斜杠加引号开头、同一行没有同样一串收尾的值，读到行尾或同一行第一个 `"` 为止（写在字符串里的值随那个字符串结束，`{"cmd":"PASSWORD=\"…","x":1}` 的 JSON 结构不动）。反斜杠两个一组算，收尾 `\"` 的 `\` 不算进去，上一层字符串的收尾留着：`{\"env\":\"password: \\\"…\"}` 写成 `…\\\"[redacted]\"}`。JSON 键值里没收尾的字符串同样读到行尾，或读到一个不收尾的引号。换成开头的引号加 `[redacted]`，不补收尾引号：`API_TOKEN=\"[redacted]`、`"session cookie": "[redacted]`。只有一个引号、同一行后面什么也没有的，不算值。
  - 纯引号（`"…`、`'…`）同一行没收尾的，仍不算值，照旧留下（#501 复看 #1577）。这样的引号常常是收尾引号：名字和分隔符本身写在提示语或标签里，比如 `input("Password:")`、`read -sp "Password:" PW`、`{"label":"Password:"}`。按值读会把引号后面的字遮掉，存量清洗还会把历史行一起改掉。这一类另作遗留，单独设计。JSON 键值只看以密钥命名的键，误遮少得多；代码里拼 JSON、同一行又没收尾的（`'{"password": "' + pw`）会被遮住。
  - 不带引号的值不再把收尾 `\"` 的 `\` 算进去：`-e \"API_TOKEN=…\" -e \"DEBUG=1\"` 写成 `-e \"API_TOKEN=[redacted]\" -e \"DEBUG=1\"`。以前写成 `API_TOKEN=[redacted]" -e …`，下一次升级时 §3.212 的修复把它当成拆坏的值，吃掉后面到 `\"` 为止的字。反斜杠两个一组算，值自己的 `\\` 照旧算进值。
  - 已经遮过的不再计数。
  - 所有规则仍是线性时间：开头那串反斜杠设了上限，`password: ` 后面跟一长串反斜杠、一个引号、再一长串反斜杠的 1 MB 文本约 60 ms（没有上限时要 42 s，#501 复看 #1577 实测）。
  - 实时 `chat.stream` 分段扣留时也认这几种的开头，收尾或换行之前不放出；切点不落在一串反斜杠中间。
- **这次升级的存量清洗**：`STEP raw-secret-scrub`（§3.25）用的存量规则多了这几种，历史的工具调用记录、Turn 报告和 agent 决策里的这类值会被单向遮住，每处计 1。
  - 以前整段留下的、JSON 键值里没收尾的字符串这次会被遮住；纯引号没收尾的照旧不改。
  - 以前写成 `password=[redacted]"…`（只遮了 `\`）、同一行后面再没有 `\"` 的没收尾值不改写，值留在历史行里：这样的字和"不带引号的值被引号截断、后面跟着字"写出来一样（`{"cmd":"PASSWORD=…","x":1}` 存下来就是 `PASSWORD=[redacted]","x":1`），按它改写会改坏 JSON 文本。
  - §3.212 的修复遇到收尾是 `\\\"` 的拆坏值，按收尾那串的长度写回 `\\\"[redacted]\\\"`，和现在写入的样子一致。
  - 计数看这一步的日志和 `cli.raw_secrets_scrubbed` 审计行，记 `docs/private/`。
- **升级影响**：没有需要手工执行的步骤。
- **回滚**（见 §5，没有迁移）：只回退代码。存量清洗的改写是单向的，只有这次 `BACKUP_NOW` 的备份能带回原文（同 §3.25）。回滚后，新写入的这几种值又会原样留下。
- 下一次主机升级的提示要带上本节。

### 3.214 双引号里带转义引号的值整体遮住（#501 复看 #1577，0.69.2 之后的下一版）

没有迁移，不需要主机步骤。

- **以前漏在哪**（#501 复看 #1577 时实测，main 上就有）：
  - 按名字认的规则排在 JSON 键值规则前面，带双引号的值读到下一个 `"` 为止，不认 `\"` 转义。
  - 所以值里有转义引号时只遮到那个引号，后面的字留下：`{"password": "a \"b <密钥>"}` 写成 `{"password": "[redacted]"b <密钥>"}`。`{"api_key":"x\"<密钥>"}`、`password: "a \"b <密钥>"`、`PASSWORD="a\"<密钥>"` 也一样。
  - 名字规则不认的键（`"session cookie"`）走 JSON 键值规则，本来就整体遮住。
  - 工具结果本身是 JSON 对象时，解码后照样按这条规则读；JSON 写在字符串里时（`{"stdout":"{\"password\": \"a \\\"b …\"}"}`），工具调用记录里也露。
- **现在怎么读**：
  - 双引号里的值认 `\` 转义，读到第一个没被反斜杠转义、后面跟着空白、`,;)}]&.'|<>` 之一或文本结尾的 `"`，整体换成 `"[redacted]"`。JSON、shell、YAML 的双引号字符串都这样转义，收尾引号后面也都是这些字。不含 `:`：跟着 `:` 的是 JSON 键的收尾引号，读到那里就把下一对的名字读进来了（#501 复看 #1579）。也不含 `\`：后一个值以 `\` 开头时（`"\n…"`、`"\\host…"`）同样会读进下一对。
  - 没有这样的引号时，照旧读到第一个 `"`：`password="C:\dir\" x` 写成 `password="[redacted]" x`，`password="a\"b"c` 写成 `password="[redacted]"b"c`。
  - 收尾引号后面要跟这些字，是因为值以 `\` 结尾再加收尾引号（Windows 路径、cmd.exe）时，`\"` 不是转义：不加这一条，`--password "C:\dir\" --token "<密钥>"` 会一直读到 `--token` 那个值开头的 `"`，后一个值露出来（#493、#501 复看 #1579）。
  - 截断在值中间、值里又有转义引号的 JSON（`{"password": "a \"b <密钥>`，同一行没收尾）仍只遮到那个引号：名字规则先读到它，§3.213 的没收尾读法只给 JSON 键值规则。
  - 收尾的 `"` 也不能是下一对值的开引号：它前面紧挨着一个名字和它的分隔符（`token=`、`password: `、`'token' = `、`--token `、`--token=`、`API_TOKEN=`），而且这个名字按名字、`--flag`、环境变量三条规则各自的边界算得上名字、又是那条规则会遮住值的名字时（名字前面不是字母、数字、`_`、`.`、`-`；`--flag` 前面不是字母、数字、`-`；环境变量名前面不是字母、数字、`_`；所以 `" token=`、`.'token' = `、`.--token `、`"API_TOKEN=` 都算），不收尾；后面隔着 0 到 8 个空白再跟 `:` 或 `=` 时也不收尾，那是键的收尾引号（JSON 的 `"api_key" : `，TOML、HCL 的 `"api_key" = `；#501 复看 05f9be71）。下一对是 JSON 键（`, "password": `）时，键的开引号没被转义，值读不过去，照旧读到第一个 `"`。所以前一个值以 `\` 结尾、后一个值的名字又算得上名字时（`password="C:\dir\" token=" <密钥>"`），两个值都遮住，和 #1579 之前（与 v0.69.2 相同）一样（遗留 924，#493、#501 复看 #1579 与 #1581）。规则自己不当名字读的（`_k: `、`x--k `）和不遮值的名字（`note: `）不拦，照常收尾（§3.216）。
  - 代价：值里有转义引号，而收尾的 `"` 正好符合上一条（前面紧挨着一个会被遮住的名字和分隔符，或后面隔着空白跟 `:` 或 `=`）时，照 #1579 之前（与 v0.69.2 相同）读到第一个 `"`，后半段留下：`password="a \"b token: " x`、`{"password": "a\"<密钥> k="}`、`password="a\"<密钥>&next="`、`password: "a\"<密钥>" : x`、`password="a\"<密钥>" = x`（#501 复看 #1581 与 05f9be71）。这几种在 v0.69.2 上本来就露。
  - 实时 `chat.stream`：放出的那段若在 `"` 后面切开，按"后面还有字"读，和整段读法一致；不在 `"` 后面最多 8 个空白中间切，连引号一起扣住，等后面的字来了再看是不是 `:` 或 `=`；切点后面已经来了别的字时不扣，所以 `" " " …` 连串只扣最后一个（#493 复看 #1581 与 e301108f）；其余分段扣留不变。
  - 一行里混用三四层引号、前一条规则遮住的值改变了后一条规则怎么读时，实时流放出的文本可能和整段脱敏不逐字相同（遗留 920 同一类，main 上也有；#493 复看 #1579 的三条例子固定在 `secret-stream.test.ts` 里）。落库的消息按整段脱敏。
- **这次升级的存量清洗**：`STEP raw-secret-scrub`（§3.25）的存量规则同样改了，但历史行里已经写成 `"[redacted]"b <密钥>"` 的不改写，后半段留在历史行里。
  - 这串字和"带引号的值收尾之后紧跟着字"写出来一样（`password="x"y "z"` 存下来是 `password="[redacted]"y "z"`），按它改写会吃掉后面的字。
  - 需要时按下面的只读 SQL 数一次（#501 复看 #1579），执行方式同 §3.15 A：在主机检出目录下执行，经 SSH 时把 heredoc 通过管道交给 ssh。位置列表与 §3.15 A 相同，只按位置输出行数，不打印值。
  - 它找的是 `"[redacted]"` 后面紧跟着不能结束值的字（字母、中文等；句末的 `.` 和 `|<>` 不算，#493 复看 #1579），引号前可以有任意层反斜杠：jsonb 列 `::text` 之后引号写成 `\"`，stdout 里又是 JSON 文本的再多一层，所以按"引号后面紧跟字母或数字"直接写的正则在这些行上查不到。
  - 命中的里面也有 `password="x"y` 这样本来不是密钥的。由人按位置查看行、判断留下的是不是密钥的后半段、要不要轮换，结果记 `docs/private/`。

```sh
docker compose exec -T postgres psql -U nexttime -d nexttime -v ON_ERROR_STOP=1 <<'SQL'
begin transaction read only;
with src(location, t) as (
            select 'chat_messages', content::text from chat_messages
  union all select 'audit_records', payload::text from audit_records
  union all select 'tasks', input::text || ' ' || coalesce(result::text, '') from tasks
  union all select 'activities', metadata::text from activities
  union all select 'objects', properties::text from objects
  union all select 'links', properties::text from links
  union all select 'evidence', content::text from evidence
  union all select 'decisions', coalesce(summary, '') || ' ' || coalesce(rationale::text, '') from decisions
  union all select 'observations', content::text from observations
  union all select 'skills', description || ' ' || markdown from skills
  union all select 'procedures', description || ' ' || steps::text from procedures
  union all select 'action_requests', params::text from action_requests
  union all select 'pending_context_items', payload::text from pending_context_items
)
select src.location, count(*) as rows
from src
where src.t ~ '\\*"\[redacted\]\\*"[^[:space:],;:)}\]"''\\&.|<>]'
group by src.location
order by src.location;
rollback;
SQL
```

- **升级影响**：没有需要手工执行的步骤。
- **回滚**（见 §5，没有迁移）：只回退代码。回滚后，新写入的这种值又只遮到转义引号为止。
- 下一次主机升级的提示要带上本节。

### 3.215 实时 `chat.stream` 里紧跟在引号、`.`、`_`、`-` 后面的 `--flag` 与 env 名，值收尾之前不放出（遗留 925，与 §3.214 同一个 PR，0.69.2 之后的下一版）

没有迁移，不需要主机步骤。

- **以前漏在哪**（#493 复看 #1579 时发现，main 上就有）：
  - 整段脱敏时，`--password` 类参数只要前面不是字母、数字或 `-` 就算，env 行的名字只要前面不是字母、数字或 `_` 就算；所以 `say "hi".--password "<密钥> x"`、`"hi"_--password …`、`"hi".API_TOKEN="a <密钥>"`、`"hi"-API_TOKEN=…` 都遮住。
  - 实时流判断「这里是不是一个密钥名、值还没收尾」时，用的是 `password: ` 那条规则的边界：前面是 `.`、`_`、`-` 时不算名字。于是在值中间切开时，前半段当普通文字放出，值整段露出来；超过 64 个字符的 env 名也是这样。
  - 落库的消息按整段脱敏，遮得住。
- **现在**：实时流对 `--flag` 和 env 名各用整段脱敏那条规则自己的边界（env 名最长 128 个字符），值收尾之前从名字起扣住。
- §3.214 收尾引号前认的名字，整段和实时流因此是同一组：`PASSWORD="C:\dir\".API_TOKEN=" <密钥>"`、65 到 128 个字符的 env 名、`.--token `、`_--token `、`.--token=` 这几种，以前流里先放出名字、再把值当普通引号串放出，现在从名字起扣住（#501 复看 05f9be71）。
- `"hi".password: "…"` 这种写法整段脱敏本来就不遮（`password: ` 那条规则前面是 `.` 时不算名字），实时流也照旧不扣，两边一致。
- **升级影响**：没有需要手工执行的步骤。
- **回滚**（见 §5，没有迁移）：只回退代码。回滚后，这几种写法在实时流里又可能露出值。
- 下一次主机升级的提示要带上本节。

### 3.216 带转义读的值不把下一对读进来；写进字符串里的 JSON 键用 `=` 也遮住（遗留 926，#501 复看 #1581，0.69.2 之后的下一版）

没有迁移，不需要主机步骤。

- **以前漏在哪**：
  - 带转义读的三种值会读过同一行下一对的名字和开引号：双引号里认 `\"` 的值（§3.214）、`\"…\"`（§3.212）、同一行没收尾的 `\"…`（§3.213）。下一对的规则找不到名字，它的值就露出来。
  - 例子：`token: "a\" --token 'x", <密钥>'`、`password="C:\dir\" token='x" <密钥>'`、`export PGPASSWORD="C:\pg\" API_TOKEN='x"; <密钥>'`。这三种 v0.69.2 和 #1579 之前遮得住，main 上露。
  - 同类的还有 `API_TOKEN=\"a --token 'b\" <密钥>'` 和 `password=\"abc --token 'x" <密钥>'`。
  - 写进字符串里的 JSON 键用 `=` 时，没有一条规则认：`\"password\" = \"<密钥>\"`、`pwsh -c "… @{\"Password\" = \"<密钥>\"}"`。v0.69.2 起就露。
- **现在怎么读**：
  - 三种值都在下一对前面停下，下一对的值由它自己的规则遮住。下一对指：
    - 名字、`--flag`、env 名三条规则会遮住值的名字，按各自的边界算；
    - 后面跟着分隔符和开引号。开引号是 `"`，或者是 `'` 且这个 `'…'` 里、收尾的 `'` 之前有 `"`，读过去就会在它里面收尾。
  - `'…'` 里没有 `"`、是空的、或者没收尾时，照 main 读过去，一起遮住：`password="a\" token='b' <密钥>"`。
  - 不遮值的名字（`note: `、`_k: `）不拦，当作值里的字读进来。§3.214 代价里的 `password="a \"b note: " x` 因此现在整体遮住。
  - 同一行没收尾的 `\"…` 不把行尾的空白、也不把下一对前面的空白读进去。实时流在下一对的名字前切开时，读法和整段一样。
  - 写进字符串里的 JSON 键，分隔符认 `:` 也认 `=`；实时流同样从键起扣住。`==`（比较）不算分隔符。
- **代价**：
  - 前一个值读过了不带引号的下一对（`token = `），又停在一个紧贴着值的名字前（`<密钥>.api_key="`）时，那段字被当成后一对的名字，留下。main 和 v0.69.2 都遮得住，实测 20 万行里有 1 行。
  - 实时流里有几行和整段脱敏不逐字相同：整段里，前一条规则先遮住了 `'…'`，后一条规则在改写后的文本上读法变了。这是遗留 920 同一类，落库的消息按整段脱敏。整段里靠前一条规则碰巧遮住的值，实时流可能露出，落库不受影响。
- **已知限制（另行登记，§3.217 已修）**：后一条规则的 `'…'` 值里有一对，前一条规则先用带转义读的值读过了这个 `'…'` 的收尾 `'`。后一条规则于是读不到收尾，值露出来，例如 `--token='\<密钥>":api_key=\"'\"`。
  - 规则按先后在改写后的文本上跑，才会这样。大多 #1579 之前就有，v0.69.2 没有带转义读的值，所以遮得住。
  - 修法要改成三条名值规则按位置一起扫，见 §3.217（遗留 928）。
- **升级影响**：没有需要手工执行的步骤。
- **回滚**（见 §5，没有迁移）：只回退代码。回滚后，上面这几种写法又会露出值。
- 下一次主机升级的提示要带上本节。

### 3.217 名字、`--flag`、env 三条规则在原文上一起读；转义开引号后面是密钥键名时不当值读；起在值里、伸到外面的一对照样读到（遗留 928、929、934，0.70.0 之后的下一版）

没有迁移，不需要主机步骤。

- **以前漏在哪**：
  - 三条名值规则按先后跑，后一条读的是前一条改写过的文本。前一条用带转义读的值读过了后一个 `'…'` 值的收尾 `'`、把它换进了掩码，后一条就读不到收尾，值露出来：`--token='\<密钥>":api_key=\"'\"`、`note: API_TOKEN: '<密钥>} .API_TOKEN=\"x'`。大多 #1579 起就有，v0.69.2 遮得住（遗留 928，§3.216 的已知限制）。前一条的值读过了后一对的名字时也一样，后一条在改写过的文本上找不到它：`api_key = a}.--token '<密钥> x'`、`--token "a API_TOKEN="b API_TOKEN="<密钥> c"`，v0.69.2 起就露。
  - 没收尾的 `\"…` 开头就是一个密钥键名和它的收尾引号、再跟 `:` 或 `=` 时（`token: \"password": <密钥>`、`token: \"password" = <密钥>`），把键读成了前一对的值，键后面的值露出来。#1577 起（遗留 929）。
  - 不带引号的值读过紧贴着它的下一对的名字和开引号，后一个值露出来：`token=x,api_key="<密钥> y"`、`--token x,--password "<密钥> y"`。v0.69.2 起就露。
  - 一对的值里面起了另一对、伸到这个值外面时，这条规则从这个值的结尾往下读，读不到起在值里的那一对，后面的值露出来：`TOKEN=x,token="apikey:"<密钥>"`。引号里的值本身是名字、分隔符加另一种引号时，前面没有 `,;&|` 也一样，值读到里面那个引号就收尾了：`password:"TOKEN='"'<密钥>"`、`token='TOKEN="'"<密钥>'`、`--apikey='password:"'"<密钥>'`。都是 #1586 起，v0.70.0 遮得住：那时一条规则改写过前一对，后一条在改写过的文本上读（遗留 934，#501 复看 #1589）。
  - 外层的值是带转义读的写法时，同样的写法也露：`password:\"TOKEN='"'<密钥>`、`--token \"TOKEN='"'<密钥>\"`、`password:"\"a TOKEN='"'<密钥>"`。main、v0.69.2 也露，v0.70.0 遮得住（#501 复看 #1591）。这样的值再套在 flag 的引号值里（`--password 'Password:\"TOKEN='"'<密钥>`），或者 `"…"` 在转义引号处收尾、紧跟着值用 `'…'` 包着 `"` 的下一对（`--password "\"secret:'"='<密钥>"`）时也露，838696e9 修过上面那几行以后仍露（#501 复看 838696e9）。
  - 引号里的值以会遮值的键名结尾、后面跟 `=` 或 `:` 时（`token="abc<密钥>Secret" = 1`），按键名认，不当值读，整个值露出来。v0.70.0、main 也露（#493 复看 #1591）。
  - 引号里的值本身是一个会遮值的键名加收尾引号、再跟 `:` 或 `=` 时，前一对把这个键当值读，键后面的值露出来：`token: "password": <密钥>`、`token: \"password\": \"<密钥>\"`、`"token": "password": "<密钥>"`。v0.69.2 起就露（遗留 930 的一部分）。
  - 这样的键名后面跟没收尾的 `"…` 值时（`token=password: "api_key": "<密钥>`、`token: "password": "<密钥>`），这个值只有 JSON 规则读。JSON 规则跑在三条规则改写之后，前一对已经把键当值遮掉，它认不出键，值露出来。有前一对的那几行是本节上一版（838696e9）照常读普通 `"…"` 带出来的，v0.70.0、main 遮得住；没有前一对的，v0.70.0、main 也露（#493 复看 #1591）。
  - 带转义读的 `\"…\"` 以会遮值的键名加转义的收尾引号结尾、再跟 `:` 或 `=` 时（`password=\"<密钥>myToken\": 1`、`token=\"abc<密钥>Secret\" = 1`、`\"password\": \"<密钥>myToken\": 1`），本节上一版（fb4eee26）按键名认、不当值读，整个值露出来。main、v0.70.0 遮得住（#493 复看 fb4eee26）。
- **现在怎么读**：
  - 三条规则各自在原文上找，按出现位置从左到右取；同一处起的，先 env、再名字、再 `--flag`。
  - 整个落在已取的一段里的，那一段已经遮住，不再算。起在里面、伸到外面的（两对交叉），这一段延到它的结尾，它剩下的部分（两段之间的字、开引号照原文，值换成掩码）接在后面；这条规则再从原来那段的结尾往下读，所以交叉值里面的下一对照样读到。落在里面、但越过了这一段最近一次被交叉前的结尾的那一条，也从那个结尾往下读，同一处起的几条先取哪条不影响结果（#493 复看 #1586）。
  - 交叉的两对合成一处替换，实时流不会从中间切开。遮住的字和 main、v0.69.2 一样：`"api_key": "'.API_TOKEN="<密钥>'"` 写成 `"api_key": "[redacted]"[redacted]"`。
  - JSON 那几条规则仍在这三条之后、在改写后的文本上读；写在字符串里的那条在键是名字时也和三条一起读（见下）。§3.218 起，键里写不下一对的 JSON 那一对也一起读。
  - 不带引号的值在 `,`、`;`、`&`、`|` 后面紧跟的下一对（会遮值的名字、分隔符、开引号）前停下，下一对由它自己的规则遮住。只在这几个字符后面停：名字会把贴着它写的字都算进去，下一对的名字可能从值的开头就起（`--password=<密钥>--api-key="…"`），在那里停，前一个值就整段露了（#493 复看 #1586）。值的第一个字符照读，第一个字符是这几个之一时第二个也照读（`token=;…`）。下一对的开引号后面紧跟着会遮值的键名、它的收尾引号、再隔 0 到 8 个空白跟 `:` 或 `=` 时（`token=x,password: "api_key": <密钥>`），不停，照 v0.70.0 读过去；键自己的那一对和它交叉，键连同前后两个值一起遮住：`token=x,password: "api_key": <密钥>` 写成 `token=[redacted] "[redacted]": [redacted]`（#501 复看 #1586，#493 复看 #1591）。
  - 没收尾的 `\"…`，开头是会遮值的键名、普通的收尾引号，再隔 0 到 8 个空白跟 `:` 或 `=` 时，不当值读，那一对由名字规则读。
  - 下一对的开引号前不再认一个可有可无的 `'`：`'` 后面跟着 `"` 而 `'` 没收尾时（`token='"…`），那一对的规则在那里不遮值，停在它前面反而把前一个值读到的部分留下（#493 复看 #1583）。
  - 没收尾的 `\"…` 看行尾空白时先吃满、不回退，输出不变（#501 复看 #1583）。
  - 实时流读扣下的文本时，把已经放出的最后 8 个字符当作前文，给规则往回看（名字前面的 `.` 之类），规则不从里面起读。切点两边因此和整段读法一致。
  - 实时流不在这样的开引号和它后面的键之间切开。开引号后面的字还可能凑成这样的键时，从 `,;&|` 那个字符起扣住，等键到齐再定前一个值停不停。
  - 一条规则取下一对以后，从这一对的值的开头往下读，不从结尾读：起在值里、伸到外面的一对和它交叉，照交叉读（`TOKEN=x,token="apikey:"<密钥>"` 先取 `token="apikey:"`，再取 `apikey:"<密钥>"`，合成一处）。同一处起、被它盖住的那一条也从值的开头往下读。被盖住的一条，值的第一个字就起了一对时（转义开引号后面紧跟一对，或值本身就是会遮值的键名加收尾引号），从那一对起往下读：`--token='token: \"api_key="'<密钥>"` 写成 `--token='[redacted]'[redacted]"`，`--token='x,api_key="api_key":'<密钥>'` 写成 `--token='[redacted]'[redacted]'`（#493 复看 #1591）。重读的只是这个值、到那一对为止的字或那个键（至多 64 个字符），整段仍是线性的。
  - 交叉以后，前一个值的收尾引号落在交叉那一对的值里面（在那个值的开引号之后），这个引号就不是前一个值自己的：前一个值接着读到同一行里它那种引号下一次能收尾的地方（引号后面跟着空白、`,;)}]&.'|<>` 之一或文本结尾，而且不是键的收尾引号），读过的部分遮住：`password:"TOKEN='"'<密钥>"` 写成 `password:"[redacted]"'[redacted]"`。中途遇到下一对、JSON 规则会读的密钥键名连同它的开引号（`"password": "`、`\"api_key\" = \"`）或行尾就停，读到的部分照样遮住，停下的地方由那一对的规则接着读。前一个值没收尾、停下的地方落在交叉那一对的值里面时也一样：`password:\"TOKEN='"'<密钥>` 写成 `password:\"[redacted]'[redacted]`（#501 复看 #1591）。
  - 被已取的值盖住的值没收尾、停在交叉那一对的值里，或者停在那一对前面、中间只有空白时，也照上一条接着读到自己的引号：`--password 'Password:\"TOKEN='"'<密钥>` 写成 `--password '[redacted]'[redacted]'[redacted]`（#501 复看 #1591）。
  - 带开引号、没收尾、停在下一对前面的值（`\"…`），和下一对之间只有空白时，下一对算在这个值里面，这个值照上一条接着读到自己的引号，和 v0.70.0 把它读到行尾一样：`--token \"xa TOKEN='\"'<密钥> y'`、`apikey=\"a TOKEN='"'<密钥>` 整段遮住。中间隔着别的字时不算（`api_key: \"a"b TOKEN='\"' c` 照旧）。普通的 `"…"` 在反斜杠转义的引号处收尾（`"\"`，带转义读的值不在那里收尾）、紧跟着的下一对的值用 `'…'` 包着一个 `"` 时，也这样算：那个 `"` 可能才是它的收尾，`--password "\"secret:'"='<密钥>"` 写成 `--password "[redacted]"secret:'[redacted]'[redacted]"`（#501 复看 #1591）。
  - 带转义读的值（`\"…\"`、没收尾的 `\"…`）不读进下一对，但下一对从值的第一个字符就起时照读，和不带引号的值一样：`--token \"TOKEN='\"'<密钥>\"`。不读的话这个值什么也没有，下一对把它后面的引号当值，后面的值露出来。
  - 带转义读的 `"…"` 读过下一对，只要那一对的值用 `'…'` 包着它会收尾的那个 `"`：那一对和它交叉，两个值连同那一对的名字一起遮住：`password:"\"a TOKEN='"'<密钥>"` 写成 `password:"[redacted]"'[redacted]"`。以前停在那一对前面，在它前面的 `\"` 收尾，后面露出来（#501 复看 #1591）。下一对的值用 `"` 开头时照旧停：读进去的话，这个值会在那一对的开引号处收尾，把那一对吞掉。
  - 写在字符串里的 JSON 那一对（`\"api_key\": \"`、`\"Password\" = \"`），键只由字母、数字和 `_.-` 写成时（至多 64 个字符，不必字母开头），也和三条规则一起在原文上读。带转义读的值（`\"…\"`、没收尾的 `\"…`）和 JSON 规则的值，开头是这样的键时照常当值读：键自己的那一对起在这个值里、伸到外面，和它交叉，键连同两个值一起遮住：`token: \"password\": \"<密钥>\"` 写成 `token: \"[redacted]\": \"[redacted]\"`，`{\"token\":\"password\":\"<密钥>\"}` 写成 `{\"token\":\"[redacted]\":\"[redacted]\"}`，不以字母开头的键也一样（`token: \"_password\": \"<密钥>\"`，main、v0.70.0 露键后面的值）。以这样的键名结尾的值也照常遮住：`password=\"<密钥>myToken\": 1` 写成 `password=\"[redacted]\": 1`（#493 复看 fb4eee26）。上一版不当值读，键由 JSON 规则在改写后的文本上读：键前面那一对的值读到键为止时，以键名结尾的值整个露。
  - 一起读时，这一对的值停在会遮值的名字和分隔符前面（`token: `、`--token=`、`API_TOKEN=`），那一对由它自己的规则读，再从它的值的开头往下读：`\"password\": \"token: apiKey' = \"<密钥>\"` 写成 `\"password\": \"[redacted]\"[redacted]\"`。不停的话，那一对整个落在这个值里、算被盖住，从它的结尾往下读，它值里起的下一对读不到，后面的值露出来（main、v0.70.0 也露）。这个值剩下的部分由 JSON 规则在改写后的文本上照旧遮住。键只许这几种字：一个匹配只遮值、不遮键，键里许有别的字时，键里能写下一对，那一对的值就露了（`{\"api_key=<密钥>&token\": \"x\"}`，#493 复看 fb4eee26 时的变异）。只许这几种字的键里写不下一对。
  - 没收尾的 `\"…` 开头是会遮值的键名加普通的收尾引号时（`token: \"password": <密钥>`），仍不当值读（见上，遗留 929）：那种键的那一对只有 JSON 规则在改写后的文本上读（遗留 930），当值读的话键被前一对遮掉，后面的值露出来；四个生成器上多露几十到上百行。
  - 普通的 `"…"` 不这样认，照常当值读：键自己的那一对起在这个值里、伸到外面，和它交叉，键连同两个值一起遮住：`token: "password": <密钥>` 写成 `token: "[redacted]": [redacted]`。以键名结尾的值也照常遮住：`token="abc<密钥>Secret" = 1` 写成 `token="[redacted]" = [redacted]`（#493 复看 #1591）。
  - 写在引号里、后面跟 `:` 的键（JSON 的写法，`"api_key": "`）后面没收尾的 `"…`，名字规则也照 JSON 规则那样读到行尾。键自己的那一对于是和前面把键当值读的那个值交叉，键连同两个值一起遮住：`token=password: "api_key": "<密钥>` 写成 `token=[redacted] "[redacted]": "[redacted]`，`token: "password": "<密钥>` 写成 `token: "[redacted]": "[redacted]`（#493 复看 #1591）。只在同一行后面再没有 `"` 时这样读，有的话照普通的 `"…"` 读到那个 `"`，所以读不进下一对。别的名字后面没收尾的 `"` 照旧不当值读（`password: "<密钥> x` 各版本都露；`input("Password:")` 这类提示不动，#501 复看 #1577）。
  - 实时流在值还开着（带开引号、没收尾）、后面只有空白时把它扣住，等后面的字到齐再定下一对是不是在它里面。
- **对比**（生成器偏重引号，每 10 万行，两个种子）：
  - 整段：比 main（#1583）少露 933–939 行，多露 39–44 行；比 v0.69.2 多露 19–20 行（main 是 41–49 行）。比两者都多露的 19–20 行逐条看过，都是 main 里前一条规则的掩码碰巧吞掉了后一个值的收尾引号，那个值读得更长；原文上读，值在它自己的收尾处停，后面没收尾的普通 `"…` 不当值读。
  - 实时流比自身整段多露的，从 46–54 行降到 1 行（main 的实时流 35–45 行）。
  - 遗留 934 这一步（四个生成器：偏重引号、偏重键名、引号嵌套、值里接名字（一对的值里接着另一个名字、引号和键，#501 复看 838696e9 那几行的写法），每 10 万行，两个种子；和 main 即 #1589、v0.70.0、838696e9 比）：
    - 偏重引号：比 main 多露 0 行；比 v0.70.0 多露 14–15 行（main 39–44 行），这些 main 也露，见代价。
    - 偏重键名：比 v0.70.0 多露 8–15 行（main 406–412 行）；其中比 main 多露的 2–5 行（比 main 和 v0.70.0 都多露的 1–4 行），就是代价里那条临时的，其余 main 也露。
    - 引号嵌套（值里套另一种引号的一对）：比 main 多露 0 行；比 v0.70.0 多露 2–4 行（main 1074–1193 行），这些 main 也露，见代价。
    - 值里接名字：比 main 多露 0 行；比 v0.70.0 多露 15–16 行（main 998–1023 行，838696e9 109–115 行），这些 main 也露，见代价。
    - 四个生成器上都没有比 838696e9 多露的行；前三个生成器上，838696e9 的每一类又都是 #493、#501 头一轮复看前（c1ca8ded）同一类的子集。
    - 键名值后面跟没收尾的 `"…` 那一类（前缀 10 种 × 名字 9 种 × 分隔 6 种 × 键 7 种 × 键的引号 4 种 × 分隔 6 种 × 值 12 种，共 108.9 万行，全部跑完）：比 v0.70.0、main、838696e9、c1ca8ded 多露的都是 0 行；838696e9 比 v0.70.0 多露 4.3 万行。约八分之一的行各随机切流三次，流式比整段多露 0 行。
    - 实时流比自身整段多露的：偏重引号 4–5 行、偏重键名 42–53 行、引号嵌套 0 行、值里接名字 11–12 行（main 的实时流分别是 1 行、30–40 行、0 行、21–24 行）。比 838696e9 多出来的，是整段现在读过一个已经收尾的 `'…'` 或 `"…"` 接着往后遮，实时流在那个收尾处已经放出，不再往后接；实时流比 main 的实时流多露的只有偏重键名上的 2 / 6 行，和 838696e9 一样。落库的消息按整段脱敏。
  - #493 复看 fb4eee26 这一步（同样四个生成器、两个种子，和 main、v0.70.0、fb4eee26 比）：
    - 比 fb4eee26 多露的只有偏重键名种子 8 上 1 行，main、v0.70.0 也露，见代价；比 fb4eee26 少露的，偏重引号 102 / 105 行、偏重键名 246 / 238 行、值里接名字 20 / 22 行。
    - 偏重键名上比 main 多露 1 / 3 行（fb4eee26 是 2 / 5 行），比 main 和 v0.70.0 都多露 0 / 2 行，都是代价里那条临时的；别的生成器上比 main 多露 0 行。
    - 比 v0.70.0 多露的：偏重引号 14 / 13 行、偏重键名 7 / 12 行、引号嵌套 2 / 4 行、值里接名字 16 / 15 行，都是 fb4eee26 也露的。
    - 实时流比自身整段多露 3 / 4、54 / 43、0 / 0、11 / 12 行；比 main 的实时流多露的只有偏重键名上 1 / 4 行（fb4eee26 是 2 / 6 行）。
    - 照 #493 表里的写法另做两个穷举，全部跑完：带转义引号的值（前缀 4 种 × 名字 6 种 × 分隔 4 种 × 转义 2 种 × 值 8 种 × 结尾的键 7 种 × 后面的字 7 种，75,264 行）、转义的键和前一个值交叉（322,560 行）；加上一步的 108.9 万行。比 v0.70.0、main、fb4eee26、838696e9、c1ca8ded、v0.69.2 多露的都是 0 行；fb4eee26 在第一个上比 main、v0.70.0 多露 27,900 行，在第二个上比 main 多露 5,565 行、比 v0.70.0 多露 2,365 行。约八分之一的行各随机切流三次，流式比整段多露 0 行。
- **代价**：
  - 一个值里面的一对（`token="a PASSWORD=<密钥> b"`）只计一次，main 计两次；遮住的字不变。
  - 读成值的键名和它两边的值一起遮住（`token=x,password: "api_key": <密钥>` 写成 `token=[redacted] "[redacted]": [redacted]`），main 留着键名。
  - 带转义读的 `"…"` 读过下一对以后，遮到那一对的收尾：`password="C:\dir\" token='x" <密钥>'` 写成 `password="[redacted]"[redacted]'`，main 留着 ` token='`。以反斜杠结尾的路径后面紧跟一对、那一对的 `'…'` 值里有 `"` 时，路径的值算没收尾，往后遮到下一个能收尾的 `"`、下一对或行尾：`password="C:\dir\" token='x"y' z` 写成 `password="[redacted]" token='[redacted]'[redacted]`，main 留着 ` z`（#501 复看 #1591）。只多遮。
  - 外层的值读到自己的收尾引号或行尾，中间普通的对一起遮住：`api_key: \"a TOKEN="<密钥>" user=alice, mode=fast` 写成 `api_key: \"[redacted] TOKEN="[redacted]"[redacted]`，main 和 v0.70.0 保留 ` user=alice, mode=fast`。#501 的生成器加上普通名字以后，每 10 万行有 560 / 565 行这样多遮，其中种子 7 的 560 行里 v0.70.0 保留普通值的有 552 行（#501 复看 #1591）。只多遮，不露值。
  - `token: \"password\": <密钥>`、`token: \"note": <密钥>` 照旧露（main、v0.70.0、v0.69.2 也露）：写在字符串里的 JSON 键后面跟不带引号的值，JSON 规则只读带转义引号的值。
  - 往后读到自己引号的值，遮住的比 main 多（前一对值里的字、下一对的名字和分隔符，停在下一对前的值读进下一对以后到再下一对或行尾的字），和 v0.70.0 相近；值里的一对照样计数。
  - 实时流仍有极少数行和整段不逐字相同（遗留 920 那一类），钉住的一行 main 也这样切（原来钉住的另一行现在和整段一致）；落库的消息按整段脱敏。
  - 一串首尾相交的对合成一处替换。整串长过实时流的扣留上限（4096 个字符）时，实时流照过长的值处理、停流，main 不停（#493、#501 复看 #1586）；不露值。
  - `api_key=;password="<密钥>\"` 这种空值后紧跟下一对的，后一个值照旧露（main、v0.69.2 也露）：第二个字符照读，下一对的名字被读进了前一个值。不带引号的值里 `:`、`}` 这些字符后面紧跟的下一对也照旧（`token: x}api_key="<密钥>"`，main、v0.69.2 也露）：只在 `,;&|` 后面停。
  - `,`、`;`、`&`、`|` 后面贴着下一对名字写的字算那个名字的一部分（`token=x;abc<密钥>API_TOKEN="…"` 里的 `abc<密钥>`），不再当前一个值遮；main、v0.69.2 读过了下一对，把它当前一个值遮住，下一对的值却露出来（#493 复看 #1586）。
  - **临时，指向 930，已由 §3.218 关闭**：偏重键名的生成器上仍有 1–3 行比 main 多露、0–2 行比 main 和 v0.70.0 都多露（见对比；fb4eee26 是 2–5、1–4 行）；#501 的生成器上，c1ca8ded 比 main 多露 39 / 46 行，也是这一类。都是 JSON 键名被名字规则当成值的一部分遮掉，JSON 规则在改写后的文本上读不到键：`APIKEY=password:"passwordx":"<密钥>"`、`apikey=passwd:"apikeye":"<密钥>`、`\"Password\"=\"<密钥>` 读进了前一个值的那种。main、v0.70.0 遮得住。最小化的写法作为已知失败用例写在 `secret-values.test.ts` 里；其中转义 JSON 键的 3 行（`apikey:passwd="\"apiKey\":\"<密钥>` 一类）在 #493 复看 fb4eee26 这一步遮住，剩 4 行。#493 复看 563b112b 的生成器（开引号转义、收尾引号三种写法，8 万行）上，本节比 main 多露 64 行，也都比 v0.70.0 多露：键的开引号转义、收尾引号不转义，键是名字规则不认、JSON 规则认的（`passwordx`、`_password`），前一个值把它读进去遮掉。其中 29 行 fb4eee26 遮得住，是转义 JSON 那一对和名值规则一起读带出来的（`{\"token\": \"passwordx": "<密钥>"`），35 行 fb4eee26 也露（`token=x,api_key: \"passwordx"  :  "<密钥>"`）。协调线程 11-22 02:40Z 定为同一类。#501 复看 563b112b 的转义 JSON 生成器上另有 3 / 1 行，键是名字规则认的：转义 JSON 的值读过里面那一对、接着读到收尾时，把 `\\\"` 里的 `\"` 或普通的 `"` 当成收尾，值收早了，后面的字露出来（`\"token\":\"'apikey=x&\\\"'<密钥>`）；fb4eee26、main、v0.70.0 遮得住，协调线程 02:44Z 也归 930。这两类的最小化写法补了 6 行已知失败，共 10 行。遗留 930（JSON 规则在原文上读）关闭它们；下次发版的门槛是 930 合入，两个生成器上比 v0.70.0 多露的都是 0 行。
  - 三个生成器上比 v0.70.0 多露、main 也露的行（偏重引号 14–15 行、偏重键名其余的行、引号嵌套 2–5 行）不是本节带来的。外层是带转义读的写法的那一类（#501 复看 #1591 的 8 / 6 行）本节已修，见上。多是带转义读的值在下一对前停下（遗留 926）以后，后面那一对的值在它自己的引号处收尾，再后面的字露出来：`--apikey='api_key: \"<密钥>'APIKEY='apikey:""'<密钥> y"'&`、`api_key: "note:\"<密钥>\".APIKEY='xtoken=""'<密钥>'";`；v0.70.0 读到行尾遮住。偏重键名上抽看的几行多半带 JSON 键，遗留 930 预计能关掉一部分。转义开引号、普通收尾引号的值以键名结尾的（`password=\"<密钥>myToken": 1`、`token=\"abc<密钥>Secret" = 1`）也归这一类：#1586 起，没收尾的 `\"…` 开头是键名加收尾引号时不当值读（遗留 929），以键名结尾的值也被当成键，整个露；main、v0.69.2 也露，v0.70.0 遮得住（#493 的那个生成器上 8 万行里 3,345 行）。像转义收尾那样拿掉这条守卫，四个生成器上多露几十到上百行（见现在怎么读），所以没动。普通的 `"…"` 在转义引号处收尾、和紧跟着的下一对之间隔着字的（`--password "\";secret:'"='<密钥>"`；隔着的只有空白时已修，见现在怎么读）也归这一类，main 也露，v0.70.0 遮得住（#501 复看 fb4eee26）。定为发版阻断，门槛仍是比 v0.70.0 多露 0 行：930 合入后重新对拍，剩下的单独登记一条「开放（阶段内处理）」，排在 927 之前，下次发版前必须关闭。930 之后重新对拍的结果见 §3.218。
  - 写在字符串里的 JSON 值停在紧挨着的下一对前面时，照「带开引号、没收尾、停在下一对前面的值」那条接着读到自己的收尾。这一读可能整个盖住和那一对交叉的再下一对，再下一对算被盖住、不再往下读，它值里起的一对读不到：`\"api_key\" = \"note;.--token='x|\"secret" = "x'\t\"<密钥>\"}"k"\t=\t'x"&token: 'note"=<密钥> : ` 最后一个值露出来。fb4eee26 遮住；main、v0.70.0 也露（main 还多露一个）。四个生成器 80 万行里只有这 1 行比 fb4eee26 多露，没钉：钉住现在的读法就是钉住露。
  - 被前一个值交叉遮掉的转义键，值一开头就是一对时（`token: \"password\": \"token: a <密钥>\"`、`password:\"token\"=\"--password t <密钥>`），键的值读成空，里面那一对的值在空白处停下，后面的字露出来。main、v0.70.0 也露，fb4eee26 遮住（#501 复看 563b112b，三个生成器上各 0–1 行）。值开头不是一对时（`token: \"password\": \"a token: b <密钥>\"`）本节遮住，所有旧版都露。
  - 值还开着时实时流扣得更久：带开引号、没收尾的值后面只有空白时，扣到后面来了别的字或行尾为止。整串长过扣留上限时照过长的值处理、停流，不露值。
  - 整段把一个值遮到行尾时，实时流也只能扣到行尾：同一行再超过扣留上限（4096 个字符）就照过长的值处理、停流。例如 `token='TOKEN="'"x" ` 后面同一行再接 6000 个字符，在 4112 处停，main 不停（#493、#501 复看 #1591）。不露值，只是这条消息的实时显示停在那里；压缩过的 JSON、长日志行会碰到。
- **升级影响**：没有需要手工执行的步骤。
- **回滚**（见 §5，没有迁移）：只回退代码。回滚后，上面这几种写法又会露出值。
- 下一次主机升级的提示要带上本节。

### 3.218 键里写不下一对的 JSON 键也和名字、`--flag`、env 三条规则在原文上一起读；JSON 值认得它自己的转义引号（遗留 930，0.70.0 之后的下一版）

没有迁移，不需要主机步骤。

- **以前漏在哪**：
  - JSON 规则跑在名字、`--flag`、env 三条规则之后，在它们改写过的文本上读。JSON 键是名字规则不认、JSON 规则认的（键尾不是名字规则认的名字：`passwordx`、`_password`、`apikeye`；或者键里有 `,`、`'`、空白：`x,passwordx`、`x passwordx`），前一个值又把它读进去时，键已经遮掉，JSON 规则找不到它，键后面的值露出来：`APIKEY=password:"passwordx":"<密钥>"`、`apikey=passwd:"apikeye":"<密钥>`、`{\"token\": \"passwordx": "<密钥>"`、`token: "token: "x passwordx": "<密钥>"`、`token=x,api_key: \"passwordx"  :  "<密钥>"`。写在字符串里的那一对，§3.217 起和三条规则一起读，但键只许字母、数字和 `_.-`，键带 `,`、`'` 时也一样露（`--token --token \",passwd\"=\"<密钥>`）。#1586、#1591 起，v0.70.0 遮得住（§3.217 代价里临时的那条）。键长 65–128 个字符的也一样（`APIKEY=password:"<56 个 a>passwordx": "<密钥>"`，#493 复看 1edc778d）。
  - 写在字符串里的 JSON 值（`\"…`）读过里面那一对、接着读到自己的收尾时，把 `\\\"`（那段 JSON 自己的引号）里的 `\"`、或者普通的 `"` 当成收尾，值收早了，后面的字露出来：`\"token\":\"'apikey=x&\\\"'<密钥>`、`password=\"\"password\"=\"\\\"<密钥>Token:`、`\"password\":\" token:x"\"'apikey\":\"<密钥>`。#1591 起，v0.70.0 遮得住（#501 复看 563b112b，也是临时的那条）。普通的 JSON 值里带 `\"` 的，有一种所有版本都露：`token: "passwordx": "a token: x\" <密钥>"`。
- **现在怎么读**：
  - 普通的 JSON 那一对（`"passwordx": "`）也和三条规则一起在原文上读；写在字符串里的那一对（`\"passwordx\": \"`），键也放宽到同样的写法。键里写不下一对就行（至多 128 个字符，和 JSON 规则读的键一样长；起先定的 64 个字符，65–128 个字符的键仍只由 JSON 规则读，#493 复看 1edc778d）：没有 `:`、`=`（除了 `--flag`，每一对的名字和值之间都隔着其中一个），也没有后面跟空白的 `--flag`（`--flag` 和值之间隔着空白或 `=`）。空白、`,`、`'`、`--` 都可以有：`token: "token: "x passwordx": "<密钥>"` 写成 `token: "[redacted]"[redacted]": "[redacted]"`，`token:\"--passwd\":\"<密钥>` 写成 `token:\"[redacted]\":\"[redacted]`。
  - 键里写得下一对时（`{"api_key=<密钥>&tokenx": "x"}`、`{"x --token <密钥>": "x"}`），JSON 这一对不一起读，键里那一对由它自己的规则读：一个匹配只遮值、不遮键，从键的开引号起取了它，就盖住了键里那一对，那一对的值会露。
  - 普通的 JSON 那一对，键尾是名字规则认的名字时不一起读（键尾那段名字字符以字母开头、前面不贴着名字字符、至多 64 个字符，而且是会遮值的名字：`"apikey"`、`"x,apikey"`）：名字规则照它读名字那样读这个值，和前一个值的交叉也照名字算。JSON 那一对从键的开引号起，比名字早一个字符和前一个值交叉，一起读会把名字规则遮住的字留下（`token='token="'"apikey":""<密钥>` 仍写成 `token='[redacted]'"apikey":"[redacted]"[redacted]`）。
  - 一起读时，值停在会遮值的名字和分隔符前面，那一对由它自己的规则读，和 §3.217 写在字符串里的那一对一样。
  - JSON 值照 JSON 字符串读，套了几层字符串，就数几层转义。普通的 JSON 值，`"` 前面的反斜杠是偶数个（0、2…）时才收尾，`\"` 是值里的字：`"passwordx": "a token: x\" <密钥>"` 写成 `"passwordx": "[redacted]"`。写在字符串里的 JSON 值，照那段 JSON 再套一层字符串读：`\"` 前面的反斜杠连同它自己那一个共 1、5、9… 个时才收尾；3、7… 个时（`\\\"`）是那段 JSON 自己的引号，值接着往下读；普通的 `"` 也不收尾。值停在里面那一对前、交叉以后接着读到自己收尾的那一读（§3.217「交叉以后」那条）也这样认：`\"token\":\"'apikey=x&\\\"'<密钥>` 写成 `\"token\":\"[redacted]`，`token=""passwordx":"\"<密钥>Secret:` 写成 `token="[redacted]"passwordx":"[redacted]`。每串反斜杠只读一遍，整段仍是线性的。
  - 一起读的 JSON 值开在这个 JSON 字符串自己的引号上、没收尾，停在里面那一对前、中间只隔着空白，而那一对的值正好从这个字符串的收尾引号起、引号后面接着的还是 JSON 时，字符串在这个引号处收尾：那一对的名字是字符串里的字，和它一起遮住，那一对不读（#501 复看 87e4c881 §2 的 PC，协调线程 11-26 17:01Z 定合并前采纳）。「接着的还是 JSON」是：空白和收掉所在对象、数组的 `}`、`]` 以后，`,`、开下一个对象的 `{`、`[` 和下一个键，直到它的 `:`（键至多 128 个字符）；`}`、`]` 以后只隔着空白就开下一个对象、数组的（`{…} {…}`，#501 复看 68183f3b，协调线程 11-26 19:59Z 定合并前加上），也一样；或者行尾。写在字符串里的值，还可以接着外层字符串的收尾 `"`，再往后是外层 JSON 照这样接着。`{"passwordx": "a token: ", "password:k": " <密钥>"}` 写成 `{"passwordx": "[redacted]", "password:[redacted]": "[redacted]"}`，`{"log": "{\"passwordx\": \"a token: \"}", "password:k": " <密钥>"}` 写成 `{"log": "{\"passwordx\": \"[redacted]\"}", "password:[redacted]": "[redacted]"}`；以前接着读过那一对，把后面的键读进去，JSON 规则找不到它。引号后面接着别的字时照旧接着读：`{"passwordx": "a token: "} and <密钥>"` 里 `token: "} and <密钥>"` 可能就是一对，仍写成 `{"passwordx": "[redacted]"[redacted]"`（#501 的原型在 `}` 后面不看下一个键，这一行露，main 遮住）。`}`、`]` 后面直接是键（`{"passwordx": "a token: "} "note": "<密钥>"}`）、值后面不隔 `}`、`]` 就开下一个对象，或者下一个键里有反斜杠（JSON 规则不读这样的键）时，也照旧接着读。值停在行尾、那一对在下一行时不这样收尾，行尾不随字符串遮掉。值开在里面的 `\"` 上时（普通 JSON 值里套着转义 JSON 那一对，左在里面的值接着读以后）也不这样收尾：`"passwordx":"\"password\":\""_password":" token:", "note": "<密钥>"` 仍全部遮住（原型只看值没收尾，这一行露，main、v0.70.0 也露）。
  - JSON 规则仍在三条之后、在改写后的文本上读，这些值剩下的部分照旧由它遮住。实时流里这些匹配和三条规则的一样合成一处替换。上面那种收尾要看过匹配的结尾、看到下一个键的 `:` 才定得下，所以匹配带上它看到哪里（`settledAt`）；实时流的切点落在匹配起点和那里之间，或者那一读读到了已收到文本的末尾时，退到匹配起点（不退的话，切在匹配和下一个键之间时，前半段单独遮完，计数比整段少一个）。
- **对比**（和 main 即 #1591、v0.70.0、v0.69.2 比）：
  - 新做的 930 穷举（前缀 4 种 × 前一对 7 种 × 它的开引号 4 种 × 值里的字 5 种 × 键 9 种 × 键的开、收引号各 2 种 × 分隔 5 种 × 值 6 种 × 结尾 4 种，241.9 万行，全部跑完）：比 main、v0.70.0 多露的都是 0 行；main 比 v0.70.0 多露 15,504 行，本节比 main 少露 58,080 行。约八分之一的行各随机切流三次，流式比整段、比 main 的流式多露 0 行。
  - #493 表里的两个穷举（带转义引号的值 75,264 行、转义的键和前一个值交叉 322,560 行）：比 main、v0.70.0 多露 0 行，流式 0 行。
  - 四个生成器（偏重引号、偏重键名、引号嵌套、值里接名字，每 10 万行，两个种子）：比 main 多露的都是 0 行。比 v0.70.0 多露的偏重引号 14 / 13、偏重键名 7 / 12、引号嵌套 2 / 4、值里接名字 16 / 15 行，和 main 逐行相同，见代价。实时流比自身整段多露 3 / 4、54 / 43、0 / 0、11 / 12 行，和 main 的实时流一样，比它多露 0 行。
  - 偏重普通 JSON 键的生成器（#501 复看 1edc778d 时提出，这里另写了一个更重的：前一个值后面跟一到两个普通 JSON 键；键是名字规则不认、JSON 规则认的，名字规则认的，带 `,`、`'`、空白、`--`、`:`、`=` 的，和 67 个字符的长键；值里带名字和分隔符、`\"`、`\\"`、`\\\"`，有时两段；以密钥、密钥接名字和分隔符、密钥接 `\"` 等结尾，有时再接一对；每 10 万行，两个种子）：比 v0.70.0 多露 961 / 986 行，main 是 1,493 / 1,497 行；比 main 少露 6,534 / 6,603 行，比 main 多露 34 / 35 行，其中 32 / 29 行比 v0.70.0 也多露，见代价。本节在 #501 复看的那一版（1edc778d）上，比 main 和 v0.70.0 都多露 2,306 行（种子 7），多是普通 JSON 值在 `\"` 处收早了。实时流比 main 的实时流多露 34 / 34 行。
  - 长键穷举（前缀 9 种 × 开引号 2 种 × 键尾 6 种 × 键长 50–140 × 分隔 3 种 × 结尾 4 种，117,936 行）：比 main 多露 0 行，main 比 v0.70.0 多露 24,204 行；比 v0.70.0 多露的 6,456 行都以密钥接名字和分隔符结尾（929 那一类），main 也露。每 7 行切流一次，流式比 main 的流式多露 0 行。
  - 规整 JSON 对象的生成器（#501 复看 87e4c881 §1 提出，这里照它的描述重写：`JSON.stringify` 生成 2–3 个成员的对象，键和值用上面那几种片段；普通的、写在字符串里的、放在数组里的、对象后面接着字的四种，每种每 10 万行，种子 7 / 8；另有两个穷举，`{"键1": "值1", "键2": "值2"}` 22,464 行，和它写在字符串里的 22,464 行）。数的是记号露没露，不分它该不该遮：
    - 比 main 多露：四种是 0 / 0、31 / 39、4 / 5、19 / 19 行，两个穷举 0 行；上面那种收尾之前（87e4c881）是 271 / 255、85 / 87、632 / 656、257 / 270 行和 1,200、36 行。这些行多是普通键的值里、`atoken: <记号>` 这样不该遮的记号，main 把后面的值多遮、碰巧遮住，v0.70.0 也露。比 main 和 v0.70.0 都多露的是 0 / 0、1 / 1、4 / 4、0 / 0 行，逐行看过，都在登记的那两类里（键里写得下一对的键，和 929 那一类），见代价。
    - 比 v0.70.0 多露：6 / 3、11 / 22、32 / 25、3 / 3 行，两个穷举 0 行；87e4c881 是 274 / 256、215 / 225、650 / 655、239 / 249 行和 1,200、180 行。
    - 和 #501 的原型逐行比（普通的、写在字符串里的、穷举，种子 7），多露、少露都是 0 行；原型在 `}` 后面不看下一个键，`{"passwordx": "a token: "} and <密钥>"` 这样的行它露，这几个生成器里没有。
    - 实时流比 main 的实时流多露 0 / 0、31 / 39、4 / 5、19 / 19 行，和整段比 main 多露的是同一批；比自身整段多露 2 / 4、0 / 3、3 / 4、2 / 5 行，main 的实时流比它自身整段多露 13 / 13、9 / 14、39 / 44、8 / 14 行。
  - 上面那种收尾之后，前面几组全部重跑（930 穷举、#493 的两个穷举、四个生成器、偏重普通 JSON 键的生成器、长键穷举）：整段和流式的数都和收尾之前一样，四个生成器和偏重普通 JSON 键的生成器上，和收尾之前逐行比，多露、少露都是 0 行。
  - 一行两个对象只隔着空白的生成器（#501 复看 68183f3b §1 提出，这里照它的描述另写：规整 JSON 对象的生成器生成两个对象，中间隔一两个空格、tab 或什么都不隔，三分之一写成 `[{…}] [{…}]`；普通的和写在字符串里的，每种每 10 万行，种子 7 / 8，数记号）：`}`、`]` 后面只隔着空白开下一个对象、数组算接着 JSON 之前，比 main 多露 77 / 71、113 / 96 行，比 main 和 v0.70.0 都多露 77 / 70、38 / 31 行；之后比 main 多露 0 / 2、102 / 100 行（写在字符串里的多是不该遮的记号，同上），比 main 和 v0.70.0 都多露 0 / 1、11 / 8 行，见代价。#501 只数该遮的密钥，量到之后比 main 多露 8 / 8、5 / 7 行，其中比 v0.70.0 也多露 2 / 1、4 / 4 行。实时流比自身整段多露 7 / 4、5 / 1 行，main 的实时流比它自身整段多露 60 / 66、46 / 55 行。加上这一条以后，前面几组全部重跑，整段和流式的数都不变，整段和加之前逐字相同（长键穷举只比了数）。
- **代价**：
  - 键里写得下一对（有 `:`、`=`，或后面跟空白的 `--flag`）时，JSON 这一对仍只由 JSON 规则在改写后的文本上读，被前一个值读进去时后面的值照旧露（main 也露，v0.70.0 遮得住）：`apikey=secret:"password:k":"<密钥>"`、`apikey=passwd:"a=passwordx":"<密钥>"`（键里那一段不是密钥的名字，一样露）、`token: "token: "--passwd x": "<密钥>"`。键里那一对一起读会被盖住（见上）。#501 复看 1edc778d 的普通 JSON 生成器上，这一类有 11 / 13 行比 v0.70.0 多露，main 也露；长键那 5 / 2 行（67 个字符，`apikey=passwd:"service_<50 个 x>_password":"<密钥>"`）这一类，键的上限提到 128 以后遮住。归入下面那条发版阻断。长过 128 个字符的键，JSON 规则本来就不读，所有版本都露（`APIKEY=password:"<120 个 a>passwordx": "<密钥>"`），比 v0.70.0 不多露。
  - 偏重普通 JSON 键的生成器上（见对比），这一类和 929 那一类（值以名字和分隔符结尾）另有 32 / 29 行比 main 和 v0.70.0 都多露：一起读的普通 JSON 值停在里面那一对前，接着读到自己的收尾时越过后面这样的键，把键读进去，JSON 规则找不到它：`"passwordx": " token: ""password:k": " <密钥>"`、`"_password": "x token=""_password": "<密钥>Secret:"`。main 不一起读普通 JSON 那一对，碰巧遮住。缩小后都是这两类。929 那一类不只出现在键里写得下一对的键后面，普通的键后面也有：`"passwordx": "\\\"apikey=x":"apikeye" : " <密钥>API_TOKEN="`（#493 复看 1a314bec，它另写的偏重普通 JSON 键的生成器上每 6 万行 3 / 3 行比 main 多露）。协调线程 11-26 16:47Z 定：这批比 main 多露的行作为本节的代价合入，发版门槛不变；17:01Z 改定：合并前先采纳 #501 的 PC 或同类改法（上面「现在怎么读」里字符串在收尾引号处收尾的那条），剩下的行仍照 16:47Z 作为代价接受。采纳以后，这个生成器上的这 32 / 29 行不变（和采纳之前逐行相同）；规整 JSON 对象的生成器上比 main 和 v0.70.0 都多露的 0 / 0、1 / 1、4 / 4、0 / 0 行，和一行两个对象只隔着空白的生成器上的 0 / 1、11 / 8 行（见对比；后者 20 行每行都带着键里写得下一对的键，多数前一个对象的最后一个值以名字和分隔符结尾），也是这两类，一样归入下面那条发版阻断。试过两种停法（键的上限还是 64 时，种子 7，本节是 37 行）：接着读时在任何 JSON 键前都停下，JSON 规则会把遮罩后的引号和键的开引号配成一对，变成 68 行；只在普通 JSON 那一对、转义的那一对认的键前停下，35 行，只少 2 行，比 1edc778d 多露的却从 6 行升到 24 行。所以没改，也归入下面那条发版阻断。
  - 字符串在收尾引号处收尾那一读要看到下一个键的 `:` 才定得下：实时流在这样的匹配前多扣着一段，最多到下一个键的 `:`（键至多 128 个字符），这一段到了才放出去。一行里很多这样的成员（`{"passwordx": "a token: ", "passwordx": "a token: ", …}`）时，每个成员都要等下一个键，切点一个成员一个成员往回退，整行一直扣着，到最后一个成员定下才放出去；实时流每次切只把扣着的文本读一遍，不再每退一次读一遍（#493 复看 339705af：10 行共 31 KB、7 个字符一块推送，那时 98 秒，main 68 秒；现在 2 秒左右）。一行长过扣住的上限（4,096 个字符）时照旧暂停，main 和收尾之前也一样。
  - 读成值的键名连同两边的值一起遮住，计数多一个：`token: "token: "x passwordx": "<密钥>"` 写成 `token: "[redacted]"[redacted]": "[redacted]"`，v0.70.0 留着 `x passwordx`。和 §3.217 读成值的键名一样，只多遮。
  - JSON 值交叉以后接着读，越过那段 JSON 自己的引号（普通的值越过 `\"`，写在字符串里的越过 `\\\"` 和普通的 `"`），遮到真正的收尾、下一对或行尾，比 main 多遮。
  - 每个 `"` 起都要试一次更宽的键（至多 128 个字符）；最坏的写法（一行里很多 `"--a--a…"`）比 main 慢一倍左右，仍是线性的。JSON 值里成串的 `\"`、反斜杠，一行里很多交叉的普通 JSON 值，和一行里很多 127、128 个字符的键（普通的、转义的、被前一个值读进去的），在 4 万、8 万、16 万字符上也是线性的，最慢的一种比 main 慢一半左右。字符串在收尾引号处收尾那一读，一行里很多 `}`、`{[`、外层的 `"}`、长键和很多收尾的成员（普通的、写在字符串里的），在 10 万、20 万、40 万次重复上也是线性的，最慢的一种比收尾之前慢四成左右。一行里很多只隔着空白的对象、数组（普通的、写在字符串里的），很多 `}` 后面接对象或键，也是线性的，和加上那一条之前差两成以内。
  - JSON 键里有反斜杠时（`{"password\\k": "<密钥>"}`），JSON 规则不读这一对，值露；所有版本都露，比 v0.70.0 不多露，不是本节带来的（#501 复看 68183f3b §4，另登记一条 P3，挂起）。上面那种收尾和它一致，下一个键里有反斜杠时不算接着 JSON。
  - 四个生成器上比 v0.70.0 多露、main 也露的那些行（见对比）不是本节带来的，本节也没关掉；抽看的和 §3.217 代价里那条描述的一样，多是带转义读的值在下一对前停下（遗留 926）以后，后面那一对的值在它自己的引号处收尾，再后面的字露出来（`--apikey='api_key: \"<密钥>'APIKEY='apikey:""'<密钥> y"'&`）。连同 `--password "\";secret:'"='<密钥>"`、929 守卫那一类（`password=\"<密钥>myToken": 1`，#493 的生成器上 8 万行里 3,345 行）和上面键里写得下一对、长键的那两条，照 §3.217 定的单独登记一条「开放（阶段内处理）」，排在 927 之前，下次发版前必须关闭。协调线程 11-26 15:37Z 定：这一条的发版门槛也带上偏重普通 JSON 键的生成器，比 v0.70.0 多露须为 0 行，929 那一类也算在里面（#501 建议）。
- **升级影响**：没有需要手工执行的步骤。
- **回滚**（见 §5，没有迁移）：只回退代码。回滚后，上面这几种写法又会露出值。
- 下一次主机升级的提示要带上本节。

### 3.219 每段文本也照 v0.70.0 的规则读一遍，任一读法遮住的都遮住（遗留 939，0.70.0 之后的下一版）

没有迁移，不需要主机步骤。

- **以前漏在哪**：§3.217、§3.218 代价里登记的那几类（键里写得下一对的 JSON 键、长键、929 那一类、带转义读的值停下以后后面那一对在自己引号处收尾，等），比 v0.70.0 多露。逐行看，这些行多是 v0.70.0 一条规则接一条规则改写时读错、多遮了一段，碰巧把密钥遮住：读过一个已经收尾的值，把后面的字一直遮到行尾；把键当成值读。一类一类去补，补完一类又冒出下一类（926、934、930、939），追的是 v0.70.0 读错的样子。
- **现在怎么读**：
  - v0.70.0 发布时的 `secret-values.ts` 原样冻结成 `secret-values-v0.70.0.ts`，只读：规则、注释、格式都不改，测试钉住横幅以下的 SHA-256 和 v0.70.0 逐字节相同。它读的名字规则仍是 `@nexttime/shared` 现在的（v0.70.0 以来没变过）。
  - 每段文本由现在的规则和 v0.70.0 的规则各读一遍：任一读法遮住的字都遮住，两种读法都放出的字才放出（遮蔽取并集）。结果里放出的每一段，两种读法都放出，露出的密钥不会多于其中任一种。两种读法写的 `[redacted]` 和遮住的字连成一段时，只写一个 `[redacted]`：`token=x,password: "note": ` 写成 `token=[redacted] "[redacted]": `（现在的规则遮 `x,` 和 `note`，v0.70.0 遮 `x,password:`）。
  - 计数：只有 v0.70.0 遮住的一段算一个值；里面带着现在规则自己的遮罩的，照那个遮罩的值算。
  - 带这层下限的是 `SECRET_VALUE_PATTERNS` 和 `STORED_REWRITE_SECRET_PATTERNS` 这两个 v0.70.0 就有的列表，也就是所有默认的遮法：工具结果、实时流、`redactSecrets`、存量改写。调用方自己传的列表（这两个的副本，`HIGH_CONFIDENCE_SECRET_PATTERNS`）照原样读；`HIGH_CONFIDENCE_SECRET_PATTERNS` 和 v0.70.0 那份读法相同，用不着。
  - 大多数文本 v0.70.0 读出来就是原文，或者和现在的规则读得一样，这时直接用现在规则的读法，不再对齐。
  - 实时流的切点也不落在 v0.70.0 的匹配里（`floorReadSpans`），切开读和整段读一样。
- **对比**（和 main 即 #1593、v0.70.0 比）：
  - 发版门槛的三个生成器（偏重引号、偏重键名、偏重普通 JSON 键，每 10 万行，种子 7 / 8）：比 v0.70.0 多露 0 / 0、0 / 0、0 / 0 行（main 是 14 / 13、7 / 12、961 / 986 行），929 那一类算在里面；比 main 多露 0 行，比 main 少露 16 / 13、14 / 20、1,047 / 1,049 行。
  - 其余几组（引号嵌套、值里接名字两个生成器，930 穷举，#493 的两个穷举，长键穷举，规整 JSON 对象的六组，一行两个对象的两组）：比 v0.70.0、main 多露的都是 0 行。main 比 v0.70.0 多露的引号嵌套 2 / 4、值里接名字 16 / 15 行，长键穷举 6,456 行（929 那一类），规整 JSON 对象的四种 6 / 3、11 / 22、32 / 25、3 / 3 行，一行两个对象的两组 21 / 15、70 / 64 行，现在都不比 v0.70.0 多露；930 穷举、#493 的两个穷举和规整 JSON 对象的两个穷举，main 已经是 0 行。
  - 实时流：切法和 §3.218 相同，上面每一组都比 main 的实时流多露 0 行。#501 另写的规整 JSON 对象几组（每组前 1,000 行、每个切点切两段）上，有 1–2 行比 main 的实时流多露；逐行看，现在的实时流和自身整段一样，整段也不比 main、v0.70.0 多露，是 main 的实时流在那个切点碰巧比它自己的整段多遮了一个值。比自身整段多露的：五个生成器（偏重普通 JSON 键、偏重引号、偏重键名、引号嵌套、值里接名字）42 / 62、5 / 6、52 / 40、0 / 2、10 / 5 行，main 的实时流比它自身整段多露 65 / 90、3 / 4、54 / 43、0 / 0、11 / 12 行；规整 JSON 对象的四种、一行两个对象的两组 0 / 4、0 / 2、1 / 1、2 / 3、1 / 4、2 / 1 行；长键穷举 12 行，main 的实时流也露；三个穷举 0 行。
- **代价**：
  - v0.70.0 读错、多遮的，会一直多遮：读过一个收尾的值，把后面的字遮到行尾（`.--token=\" : .'token' = '\\"x<值>"}password=',<值>"|` 写成 `.--token=\"[redacted]"|`，现在的规则只遮两个值）；把键当成值读（上面的 `token=x,password: "note": `）。现在的规则以后怎么改，这些地方都不会少遮；要等现在的规则自己就盖住 v0.70.0 遮的那些，再评估退役冻结模块（登记一条 P3，挂起）。量级（#501 复看 #1595 量）：仓库自己 67.8 万行文本里，只有 35 行和 main 读得不同，都是 `docs/STATUS.md` 和本文件里引用这些写法的行，日常文本几乎碰不到；生成器上多遮的行，偏重键名约四分之一，规整 JSON 对象 9–12%，偏重普通 JSON 键 3%，其余 0.2–1.9%。
  - 耗时，仍是线性的：日常文本整段慢 1.3–2 倍，随文本不同（4 KB、100 KB 的工具结果 1.3–1.7 倍；仓库自己的代码和文档约 1.95 倍，#501 量：快路只省掉对齐，两种读法仍各读一遍）；实时流 16–64 个字符一块推送慢 1.9–2.3 倍（100 KB、16 个字符一块从 88 毫秒到 165 毫秒），4,096 个字符一块 0.9–1.6 倍。对抗写法（一行里重复同一种交叉、转义、没收尾的写法到 4 KB–100 KB）整段慢 1.4–3.3 倍，实时流多数慢 1.5–2.5 倍，最慢的一种 4.3 倍（2 毫秒到 9 毫秒）。下面那几种更早暂停的写法慢得更多：一行里重复 `"api_key": "x `（前面接不接 `token=password: `）到 30 KB、7 个字符一块推送，是 main 的 8–11 倍（0.08 秒到 0.84 秒，单次推送最多 7 毫秒，#493 复看 #1595 量）。
  - 两种读法对齐时，替换在两个遮罩之间留下的字，放回原文时取「前一段之后第一处」，不一定是它原来的位置。放到另一读遮住的字上时，它跟着被遮，比两种读法都多遮。例：`{"x'passwordx9":"'\"API_TOKEN=","x passwordx":"<值>"}` 两种读法都写成 `"[redacted]"[redacted]"x passwordx"`，对齐以后写成 `"[redacted]"x passwordx"`。整段两种读法读得一样时不对齐，所以这一处遮不遮，要看同一段文本别处有没有两读不同的写法：同一行后面接一个 `token=x,password: "note": `，就会遮掉。只多遮，不多露（#493 复看 #1595，逐个标记查过）。
  - 少数文本再读一遍还会多遮一点，读第三遍就不再变：生成器上每 10 万行 0–90 行，main 0–20 行（#493、#501 复看 #1595）。一种是并集写出了两种读法都没写过的形状：现在规则的遮罩后面跟着收尾引号，v0.70.0 遮了这个引号，并集把它一起遮掉，后面放出的字再读时就落在字符串里。另一种是 v0.70.0 自己再读就会变的那些（偏重键名上它自己每 10 万行 145–162 行），下限把它们带了进来。所以存量改写在下一次升级时，会把这些已经改写过的行再改一次、再计一次数，只多遮。要读到不变为止得多读一遍、耗时翻倍，不做。
  - 实时流在这几种病态写法上更早暂停：一行里很多 `token: \"password\":`、`token: \"password\" = `、`"token": "password": "`、`token=password: "api_key": "`、`"api_key": "`，main 能一路放出，现在扣满 4,096 个字符的上限后暂停，最后整段读完一次替换，不漏。要让这些写法也一路放出，得把 v0.70.0 那一读改成跟着推送增量地读（登记一条 P3，挂起，等真实信号再做）。
  - 实时流有些写法扣得更久：`token=x,password: "note": ` 以前在 `,` 处放出 `token=[redacted]`，现在等 `note` 后面的值来了才一起放出（v0.70.0 把 `token` 的值读到 `password:`）。
  - 测试里两个每个切点都把整段重读一遍的压力用例，耗时从 2.4 秒左右到 4 秒多，负载高时会超过默认的 5 秒；只给这两个放宽到 20 秒。
- **升级影响**：没有需要手工执行的步骤。
- **回滚**（见 §5，没有迁移）：只回退代码。回滚后，§3.217、§3.218 代价里那几类又比 v0.70.0 多露。
- 下一次主机升级的提示要带上本节。

### 3.220 带引号的值读到紧贴着收尾引号写的字（遗留 937，0.70.0 之后的下一版）

没有迁移，不需要主机步骤。

- **以前漏在哪**：`"…"`、`'…'` 值读到收尾的引号就停，紧贴着这个引号写的字不算这个值，照原样留下。`APIKEY=\"TOKEN=""<密钥>""\"` 里，`TOKEN=` 的值读成空的 `""`，后面的 `<密钥>` 露出来；`token="x"<密钥>`、`token='x'<密钥> y` 也一样。v0.69.2、v0.70.0、main 都露。
- **现在怎么读**：
  - 收尾引号后面紧贴着的字，到下一个空白或引号为止，算这个值的一部分，和不带引号的值一样读（`restOfTheWord`）：`TOKEN=""<密钥>""` 写成 `TOKEN="[redacted]"[redacted]""`，`token='x'<密钥> y` 写成 `token='[redacted]'[redacted] y`。
  - 写法：引号里的部分和后面的字各写一个 `[redacted]`，收尾引号留在原处，算一个值。引号要留在原处：JSON 那几条规则在改写后的文本上读，少写一个引号，后面的引号就配反了，`{"token": ""x"password": "<值>"}` 里 `password` 的值会露出来。
  - 下面这些地方不往后读：
    - 引号后面是值后面常见的字（空白、`,;)}]&.'|<>`），或 `:`、`=`、`\`、引号；
    - 引号后面是反引号或全角标点（`，。、；：！？）」』】》`）：这多是代码段、中文句子的收尾，读进去会连着后面的字一直遮到下一个空白，`` `API_TOKEN="…"` `` 这样的代码段也就合不上了（仓库自己的文本里，不这样收住时多遮的 320 行有 196 行是这种）；
    - 收尾引号前有反斜杠（`password="a\"b"c`），这可能是值自己的引号（§3.221 起也往后读）；
    - 到下一个引号为止的字是一个键，引号后面跟着 `:` 或 `=`（`token="x"x,passwordx": "<值>"`）：收尾的引号其实是那个键的开引号，这个键由后面的 JSON 规则读；
    - 读到一个密钥名和它的分隔符就停（`token="x"api_key: <值>`），那一对由它自己的规则读。
  - 实时流：切点落在紧贴引号的字里，或者落在引号后面、还在等 `:` 或 `=` 时，扣住这个值，等这个值怎么读定下来再放出（`wordToComeAt`），切开读和整段读一样。
- **对比**（和 main 即 #1595、v0.70.0 比；每 10 万行，种子 7 / 8，值里接名字、偏重普通 JSON 键只跑种子 7）：
  - 整段：五个生成器上比 main、比 v0.70.0 多露的都是 0 行。比 main 少露的行：引号嵌套 19,226 / 18,952，偏重键名 6,437 / 6,345，偏重引号 1,593 / 1,546，偏重普通 JSON 键 4,217，值里接名字 9,901 行。
  - 实时流：五个生成器上比 main 的实时流多露的都是 0 行，比 main 的实时流少露：引号嵌套 19,226 / 18,952，偏重键名 6,452 / 6,362，偏重引号 1,593 / 1,547，偏重普通 JSON 键 4,217，值里接名字 9,911 行。比自身整段多露的：偏重普通 JSON 键 42，偏重引号 5 / 5，偏重键名 38 / 27，引号嵌套 0 / 2，值里接名字 0 行；main 的实时流比它自身整段多露 42、5 / 6、52 / 40、0 / 2、10 行，同样的切法上不比现在少露。
- **代价**：
  - 多遮：紧贴着收尾引号写的字，一直遮到下一个空白或引号。`token="x"y` 写成 `token="[redacted]"[redacted]`；汉字紧贴着引号（`API_TOKEN="x"写进配置 然后`）时遮到下一个空白，和不带引号的值（`API_TOKEN=x写进配置`）在 main 上的读法一样。量级：仓库自己 2,457 个文件、83.1 万行文本里，124 行和 main 读得不同，都是多遮，没有一行多露；多是测试代码里 `"${FAKE}"${…}` 这样两段紧贴着写的模板字符串。词中间的反引号也算在词里：`` 用 `password="x"y` 写 `` 写成 `` 用 `password="[redacted]"[redacted] 写 ``，代码段少了收尾的反引号，仓库自己的文本里有 36 行这样（登记 P3，挂起）。
  - 耗时，仍是线性的：日常文本整段和 main 持平（100 KB 的本文件 16 毫秒对 16 毫秒，100 KB 的测试代码 5 毫秒对 5 毫秒），实时流 16、64、4,096 个字符一块是 main 的 0.6–1.4 倍，多在测量误差里。对抗写法（一种写法重复到 200 KB）整段至多约 1.9 倍，最慢的是 `token="x"y ` 后接一串 `token='a'b c `，从 47 毫秒到 90 毫秒。实时流至多约 3 倍：`token="x"` 后接长为 L 的词，再接 `"`、8 个空白和 `:`，重复到 200 KB、16 个字符一块，L 为 200、1,000、2,000 时是 main 的 2.0、2.9、3.0 倍（2,000 时从 3.3 秒到 9.7 秒）。引号后面还在等 `:` 时整个词扣住，每来一块重读一遍；随总长仍是线性的，单次 `push` 至多约 6.5 毫秒，和 main 差不多；去掉那几个空白就和 main 一样。
  - 计数：紧贴着的字以前若另被读成一个值（v0.70.0 那一读遮住它，或者另一条规则从它读起），算两个值，现在算在这个值里，算一个。遗留 934 那组用例（#1591 起）里有 29 行因此 `redactedValues` 少 1，钉住的文本一字不变；不往后读时，这些行都回到原来的计数。这样的行很常见，不是回退：生成器上文字和 main 一样、计数不同的行，新写的 JSON 和长键每 10 万行 5,839–8,935 行（6–9%），规整 JSON 1,199–1,970 行。用到计数的地方只看它是否大于 0（如请求动作门 `governance/approval/request-action.ts` 的 `paramsCarrySuspectedSecrets`），或者只报告它。
  - 再读一遍还会变的行（读出的结果再读一遍又多遮一点）和 main 几乎一样：五个生成器上每 3 万行 2、2、3、24、25 行（引号嵌套、偏重键名、偏重引号、偏重普通 JSON 键、值里接名字），main 是 2、2、3、23、25 行。规整 JSON 对象上多一些，每 10 万行比 main 多 7–17 行：键里带空白（`"x passwordx"`）时，键前瞻到空白就停，认不出这个键，把它当成值的后半段吃掉（`{"note": "API_TOKEN=","x passwordx": "<值>"}` 写成 `{"note": "API_TOKEN="[redacted]"[redacted] passwordx": "[redacted]"}`，键少了开引号和 `x`），有的行再读一遍时，后面的规则从这个坏了的键读起，又改一次。只多遮（登记 P3，挂起）。
  - 实时流扣得稍久：紧贴着引号的字还没读到空白、或引号后面还在等 `:` 或 `=` 时，整个值扣住。
- **仍然露的**（v0.69.2、v0.70.0、main 也露，登记 P3，两条）：
  - 转义引号（§3.221 修好，值里有下一对的、紧贴着的字以反斜杠开头的除外）：转义引号的值、或被一个转义的引号收住的值，不往后读；收尾引号后面紧贴着反斜杠的也不读。同一种写法写在 JSON 字符串里、引号都转义了（`{"cmd":"APIKEY=\"TOKEN=\"\"<密钥>\"\"\""}`），不在 JSON 里的 `token=\"x\"<密钥>`，值里有 `\"` 的 `password="a\"b"<密钥>`，以及 `token="x"\"<密钥>`、`token="x"\\<密钥>`。
  - 紧贴着的字里又有引号：读到那个引号就停，同一种、另一种都是（`token='a'b'<密钥>`、`token="a"b"<密钥>`、`token="x"y"<密钥>"`、`token="a"b'<密钥>`、`token='a'b"<密钥>`）；紧贴着的字以引号开头时不读（`TOKEN=""'<密钥>'`、`TOKEN="x"''<密钥>`、`TOKEN=''""<密钥>`、`token="a""<密钥>`）；到那个引号为止的字后面跟着 `:` 或 `=`、像一个键时也不读，真键和像键的值尾分不清（`token="x"<密钥>": 1`、`token='x'<密钥>': 1`、`TOKEN=""<密钥>"        : 1`，8 个空白；9 个就遮住）。
- **存量**：
  - 以前的版本给这种值写下的是 `TOKEN="[redacted]"<密钥>`（`TOKEN="x"<密钥>`、`TOKEN=""<密钥>` 都这样写）：引号里的遮了，后面的密钥照原样存着。存量改写的规则（`STORED_REWRITE_SECRET_PATTERNS`）里，env、名字和 `--flag` 三条规则多读这一种：`"[redacted]"`、`'[redacted]'` 后面紧贴着字的，照新读法再读一遍，写成 `"[redacted]"[redacted]`，并计数（`STORED_NAMED_VALUES`）。往后读到哪里，用的就是新读法那段规则（`moreOfTheWord`）；后面已是 `[redacted]` 的不读。实时读法不变。
  - 对比（旧行用 v0.70.0 写出，五个生成器每 3 万行，种子 7 / 8）：存量改写后，比不加这一读、比 main 的存量改写、比旧行本身多露的都是 0 行；少露：引号嵌套 6,109 / 6,193，偏重键名 3,579 / 3,475，偏重引号 911 / 857，偏重普通 JSON 键 2,134 / 2,157，值里接名字 3,197 / 3,218 行。改了的行计数都大于 0，没改的都是 0。
  - 新版本写下的行，下一次升级时会被改一次的，有两类，都只多遮、只改一次：
    - 值被一个转义的引号收住、后面紧贴着字（`password="a\"b"c` 写成 `password="[redacted]"b"c`，`password: '\'a` 写成 `password: '[redacted]'a`）。反斜杠随值遮掉了，留下的和以前版本给 `password="x"b"c` 写下的一字不差，那一行的 `b` 要遮，存量里分不出这两种，就都遮。其中一半多遮住的是新读法露着的字（上面「仍然露的」第一条）；那条在 §3.221 修好，这类行不再产生。
    - 文字里本来就有掩码、后面紧贴着字（`run password="[redacted]"<密钥>y`，模型、工具或文档引用了以前的掩码，又紧接着写了字）。实时读法见到值以掩码开头就当已遮过（`NOT_ALREADY_REDACTED`），照原样留下；存量改写把它当成旧版本写下的掩码，遮掉后面的字。这一类遮住的就是实时读法露着的密钥（登记 P3）。
    - 量级：生成器上 0–7.5% 的行（输入里带现成掩码的五组，50 万行里 11,783 行是第二类），仓库自己的文本 90.5 万行里 61 行（58 行第一类、3 行第二类，多在两个脱敏的测试文件里）。main 的存量改写本来就会改一些新写下的行（每 3 万行 264–1,988 行，如 `repairSplitQuotedMasks` 写明的「改一次」），这两类加在上面；改过一次后再跑不再变。
    - 另有极少的行是键守卫只在遮之前成立：紧贴着的字到下一个引号为止像一个键（`"a|token:"  :` 这样，引号后面是空白和 `:`），实时读法不往后读；遮过之后那个引号后面是掩码，不再像键，存量再读时就遮了（39.5 万行里 1 行）。也只多遮。
- **升级影响**：没有需要手工执行的步骤。`scripts/apply-release.sh` 每次升级在 `BACKUP_NOW` 之后跑存量改写，照上面「存量」再读一遍改写的三类（`turnReports`、`decisions`、`toolCallRecords`）：其中以前存下的、紧贴着收尾引号的密钥这次遮住，计数进清洗报告。只计数、不改写的几类（`taskInputs`、`factProperties`、`objectProperties`、`auditResults`、`auditPayloads`）用的是实时读法，看不到这种旧尾巴：这几类里以前写下的 `TOKEN="[redacted]"<密钥>` 不改，清洗报告也不计（登记 P3）。
- **回滚**（见 §5，没有迁移）：只回退代码。回滚后，紧贴着收尾引号写的字又照原样留下；存量改写已遮住的不会回来，要找回只能用那次升级的 `BACKUP_NOW` 备份。
- 下一次主机升级的提示要带上本节。
