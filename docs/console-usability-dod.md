# 控制台可用性完成标准（Definition of Done）

一个页面或一条旅程，只有下面 11 条全部满足，才算"产品化可用"。每条都写成可以检查的形式，并写明由什么来守：
- CI 守卫，或 e2e 断言，失败就是红灯；
- 单元测试；
- 评审时对照 PR 模板的「控制台」清单逐条自查。

来源：2026-10-09 的控制台体验审计。

## 六条底线

任何改到控制台的 PR 都不能违反下面六条。它们是下表 11 条里最硬的部分，单独列出来，评审和 UX 验收先看这六条：

| 底线 | 具体指 | 对应下表 | 由什么守 |
|---|---|---|---|
| **不手打能派生或能选的字段** | 系统已知的值（模型、门、Operation、对象、工作区、成员、角色、时间……）只用选择器或自动派生。 | 1 | 评审清单；字段清单（审计维护） |
| **没有死路** | 空态、拒绝、做不了的步骤都给出当前角色做得了的下一步；下一步只能由别人做时，写明是谁（从能力注册表读出，`lib/role-holders.ts` 的 `capabilityHolders`），能申请的给出申请入口或一句可以复制发给对方的请求（例：`components/connect/AskOwnerToEnable`）。 | 6、10 | 旅程 ⑧ 断言没有链接的提示写明找谁 |
| **没有 403** | 控制台不发出当前角色会被内核拒绝的请求：读按角色挂起，写按角色收起，路由按路由表放行。 | 10 | 请求层 `HttpClient.roleGate`；`src/role-gating.guard.test.ts`（语法树逐处检查，CI `test`）；旅程 ⑧ 四个非所有者角色 `/api/cap/*` 零 403 |
| **不显示原始 API 名或英文服务端文案** | zh 下不出现能力名、枚举值、错误码、内核英文原文、裸 UUID；这些只进「技术细节」。 | 3、5 | `scripts/guards/i18n-pairs.mjs`；`e2e/00-gates/content.spec.ts`；`expectNoHalfEnglish` / `expectReadableErrors` |
| **每个按钮当前角色都用得了** | 角色做不了的写操作不显示；按内容暂时不能点的按钮灰掉并写明「还差：…」；指向别的页面的链接只在当前角色打得开时才是链接。 | 4、10 | `useRoleCan` / `kit/route-link` 的 `RouteLink` 与 `useCanOpen`（由角色门禁守卫逐处检查）；`scripts/guards/disabled-reason.mjs`（CI `guards`）；e2e `expectDisabledExplained` |
| **e2e 用 data-testid 定位** | e2e 辅助函数和新写的规格按 `data-testid` 找元素，不按可见文字；改可见文字时同一提交更新 e2e。 | 11 | 评审清单；CI web-e2e |

下面 11 条是完整标准。新功能也按这一页验收：后端新增或改变了用户可见的能力（capability、配置项、状态、错误）时，同一个 PR，或写明的跟进 issue，要给出控制台里的入口和呈现。

| # | 标准 | 怎么检查 | 由什么守 |
|---|---|---|---|
| 1 | **能选的不让人打** | 系统已知的值都用选择器、搜索选择，或从上游自动派生，不让人手打 id、tag 或 ISO 时间。这些值包括模型、门、Operation / 动作种类、对象、对象类型、门类型、工作区、成员、角色、时间。只有系统确实不知道的东西才手填，比如名称、提示词、密钥、自定义 Base URL。 | 评审清单 |
| 2 | **选项带状态** | 选择器里每个选项都标出能不能用，例如模型的「可用 / 测试失败 / 未测试」。不能用的选项要么禁用，要么醒目警告并给出修复入口。 | 评审清单 |
| 3 | **中文优先、一致** | zh 模式下不出现：<br>• 半截英文；<br>• 原始枚举、能力名、内部编号；<br>• 裸 UUID。<br>领域术语（Agent、Worker、MCP）可以保留，但全站同一个词只指同一件事。 | `scripts/guards/i18n-pairs.mjs`（CI）；`e2e/00-gates/content.spec.ts` 的文案扫描（棘轮基线）；`e2e/lib/ux-lint.ts` 的 `expectNoHalfEnglish` |
| 4 | **校验就地、提示常驻** | 出错时，字段的格式提示仍然看得见。提交按钮灰着的时候，旁边写明「还差：…」（`components/kit/still-needed`）。前端能判断的规则（长度、格式、必填）不等服务端拒绝。 | `scripts/guards/disabled-reason.mjs`（CI）：凡是按表单内容灰掉的按钮，旁边要有 `<StillNeeded>`，或者有 `title`。原因已经写在屏幕上时，加注释 `ux-lint-allow-disabled: <原因>`。e2e 里的对应检查是 `expectDisabledExplained`。 |
| 5 | **错误可行动** | 出错时写清楚：发生了什么、为什么、下一步点哪里。内核原文和错误码收进可以展开的「技术细节」，不放在正文里。 | `e2e/lib/ux-lint.ts` 的 `expectReadableErrors`；`lib/errors.ts` 的错误映射单测 |
| 6 | **四态齐全** | 加载、空、出错、部分可用，四种状态都有专门的呈现。空态要给出下一步，而且这个下一步当前角色做得了。 | 评审清单；旅程 ⑧（`e2e/journeys/08-least-privilege.spec.ts`）：页面不能把角色拿不到的东西显示成「无法加载」 |
| 7 | **变更后状态立即一致** | 保存、发布、授权之后，同一页上的其他区块（就绪条、矩阵、计数）立刻刷新。不留需要手动「重试」才消失的旧错误。 | 影响执行就绪的改动都调用 `announceReadinessChange`；各页单测 |
| 8 | **破坏性操作分级确认** | 按三档确认，统一走 `components/kit/confirm`：<br>• `low`：直接执行，Toast 里可以撤销；<br>• `medium`：在按钮旁确认，列出影响范围；<br>• `irreversible`：要键入目标名称并勾选知情。 | 评审清单 |
| 9 | **合理默认、不偷偷改** | 没设置的值明确显示「未设置（实际用 X）」。保存只提交用户改过的字段，不把显示用的兜底值写回去。 | 评审清单；表单单测 |
| 10 | **有引导的首跑路径、没有死路** | 从首次登录到「入口 agent 能执行一个动作」，每一步都有明确的入口指向下一步。任何角色都不会看到这两样东西：<br>• 点了一定 403 的按钮；<br>• 只有别人才能照做的指引。 | 控制台请求层 `HttpClient.roleGate` 与界面 `useRoleCan`，和内核用同一个判定 `roleMayUseCapability`；旅程 ⑧：四个非所有者角色走遍可见页，`/api/cap/*` 零 403，没有链接的提示要写明找谁 |
| 11 | **改了可见标签，同一提交里更新 e2e** | 按钮、链接、标题、字段标签等可见文字改名时，同一个提交里同步更新 `e2e/` 下用到它们的定位器。web-e2e 在 PR 头上为绿，是 UX 验收的前提。 | CI web-e2e；e2e 辅助函数用 `data-testid` 定位 |

## 用法

- **写 PR 时**：按 `.github/PULL_REQUEST_TEMPLATE.md` 的「控制台」清单，对照改到的页面或旅程逐条自查，并附上 1440 和 390 两个宽度的截图，其中至少一张是出错或空态。
- **加新表单时**：提交按钮如果按内容灰掉，就用 `<StillNeeded items={…} hidden={busy} />`，写出还差哪些字段，用字段标签的原话（「填写登录名」「选择工作区」）。
- **加新页面时**：
  - 页面要靠某个读才能工作的，在路由表 `lib/route-access.ts` 的 `ROUTE_REQUIRES` 里写上它要的能力。侧栏、链接和直接打开地址都按这张表判定。
  - 页面里的读用 `{ enabled: useRoleCan(http)(name) === true }` 挂起，写操作入口用 `useRoleCan(http)(name) !== false` 判断是否显示。
  - 指向受限路由的链接用 `<RouteLink href={…}>`；不是链接的跳转（按钮、Toast）只在 `useCanOpen(http)(href) !== false` 时提供。
  - 这三条由 `src/role-gating.guard.test.ts` 逐处检查。确实只能从受限入口进来的文件，写进它的白名单并写明理由；白名单只减不增，失效的条目会让测试失败。
- **写「找谁」时**：用 `capabilityHolders(能力名, t)` 从注册表读出角色名，不手写「所有者」「operator」；要别人代办的，给一句可以复制的请求。
- **加新旅程时**：在 `e2e/journeys/` 写规格块（步骤 / 状态覆盖 / 成功判据），并在合适的步骤调用 `e2e/lib/ux-lint.ts` 的断言。
