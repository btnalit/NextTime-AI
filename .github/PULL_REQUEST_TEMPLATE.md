## 这个 PR 做了什么

<!-- 一两句话：改了什么、为什么。链接相关 issue/design doc 章节。 -->

## 检查清单

- [ ] **契约快照**：如果改动涉及 capability/event 的 params/result schema（`packages/kernel/src`
      下的 registry），已跑过 `pnpm contract:snapshot` 重新生成
      `docs/contracts/{capabilities,events}.json` 并提交（`docs/wire-contract-conventions.md`
      §5；CI `quality` job 的 `pnpm contract:check` 会在漂移时直接报错）。没有改到 registry 的
      PR 不适用，勾掉即可。
- [ ] **主机验收**：如果改动涉及运行时行为（Dockerfile、`docker-compose.yml`、启动脚本、任何
      `docs/runbooks/host-*.md` 覆盖的服务），已经按对应 runbook 在真实主机上跑过一遍验证，或者
      在下面写清楚为什么不需要（比如纯单测覆盖、没有主机可跑）。
- [ ] **文档**：改了行为但相关 runbook/设计文档还没同步的，本 PR 一并更新；纯代码改动没有文档
      需要同步的，勾掉即可。

- [ ] **控制台**：本 PR 新增或改变了用户可见的能力（capability、配置项、状态、错误）时，控制台里
      有对应的入口和呈现；没有的话，在下面写清理由和跟进 issue。纯后端内部改动勾掉即可。
      先过 `docs/console-usability-dod.md` 的六条底线：不手打能派生或能选的字段 · 没有死路
      （做不了的写明找谁或给出申请）· 没有 403 · 不显示原始 API 名或英文服务端文案 ·
      每个按钮当前角色都用得了 · e2e 用 data-testid 定位。
      再对照完整的 11 条逐条自查改到的页面 / 旅程：
      能选不打 · 选项带状态 · zh 无半截英文 / 原始枚举 / 裸 id · 校验就地 + 「还差：…」 ·
      错误有中文标题和下一步 · 加载 / 空 / 错 / 部分四态 · 变更后同页刷新 · 破坏性分级确认 ·
      未设置不偷偷写值 · 当前角色没有死路。
- [ ] **e2e 定位器**：本 PR 改了按钮 / 链接 / 标题 / 字段标签等可见文字时，同一提交里已更新
      `e2e/` 下用到它们的定位器；web-e2e 在 PR 头上为绿。
- [ ] **控制台截图**：改到的页面附 1440 与 390 两张截图（含一个出错或空态），贴在下面。

## 主机验收记录（如适用）

<!-- 跑了哪个 runbook、在哪台主机、关键输出/截图。不适用就删掉这一节。 -->
