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

## 主机验收记录（如适用）

<!-- 跑了哪个 runbook、在哪台主机、关键输出/截图。不适用就删掉这一节。 -->
