# Runbook：automation（GitHub 自动化一览）

对应交付物：本仓库的 GitHub 自动化补全包——`renovate.json`、
`.github/workflows/{codeql,scorecard,image-scan,release-please,auto-merge,pr-title}.yml`、
`.github/{PULL_REQUEST_TEMPLATE.md,CODEOWNERS}`。已有的 `ci.yml`/`e2e.yml`/`pi-drift.yml` 不在本
文档改动范围内，一并列进下表方便查阅。

本页只做导航——每个 bot/workflow 具体怎么配的、为什么这么配，见对应文件自己的注释；`pi` 相关的
细节见 `docs/runbooks/pi-upgrade.md`，release 相关的细节见 `docs/runbooks/release.md`。

## 唯一的人工步骤：安装 Renovate GitHub App

`renovate.json` 只是配置文件——Renovate 要真的跑起来，仓库 owner 需要去
**<https://github.com/apps/renovate>** 点 "Install"，选择这个仓库（或选 "All repositories"）。
这是本自动化包里**唯一**一处工具本身做不到、必须人工点一次的地方；其它所有行为都由已经合并到
`main` 的配置/workflow 自动生效。装好之后 Renovate 会在下一次它自己的调度周期里开始按
`renovate.json` 的规则跑,不需要额外触发。

## 一览表

| Bot / Workflow | 用途 | 在哪跑 / 触发时机 | 开出东西之后做什么 |
|---|---|---|---|
| **Renovate**（GitHub App，非本仓库 workflow） | npm / Docker（Dockerfile + `docker-compose.yml`）/ GitHub Actions 依赖更新，`renovate.json` 配置 | Renovate 云端按自己的调度跑，产出走 `schedule:nonOfficeHours`（Asia/Shanghai 非工作时间）；`pi` 组、非 major npm 分组各自有自己的 weekly schedule（见 `renovate.json` 注释） | 见下面 "auto-merge.yml" 一行——大多数 PR 不用手动碰 |
| **dependabot[bot]**（仓库原生安全更新，非本仓库 workflow） | 依赖安全漏洞修复 PR；`.github/dependabot.yml` 已删除，所以现在开出来的每一个 dependabot PR 都是这一种，不再有版本更新 PR | 仓库 Settings → Code security 的 "Dependabot security updates" 开关触发（已开），不经过任何配置文件 | 同上，走 auto-merge.yml 分流 |
| **auto-merge.yml** | 给 Renovate/Dependabot 开出的 PR 分流：patch/minor 且非 `pi` → 打开 GitHub 原生 auto-merge；major 或 `pi` 组 → 打 `needs-review` 标签，不自动合 | 上述两种 PR 的 opened/reopened/synchronize | `needs-review` 标签的 PR：人工审查后手动合并。没打这个标签的：不用管——`guards`/`quality`/`test` 三个必过检查跑绿后 GitHub 自动合并（分支保护 + 仓库已开的 `allow_auto_merge`） |
| **ci.yml**（已有，未改动） | `guards`/`quality`/`test` 三个必过检查 | 每个 PR + push main | 红了就修；这是唯一真正门禁合并的地方 |
| **e2e.yml**（已有，未改动） | web 控制台 Playwright e2e | 每个 PR + push main | 红了排查，但**目前不是必过检查**（见文件末尾注释）——稳定几轮之后手动加进分支保护 |
| **pi-drift.yml**（已有，未改动） | 探测 pi@latest 是否会破坏 `@nexttime/platform-extension` | 每晚 + 手动 | 开/更新 `pi-drift` 标签的 issue，见 `docs/runbooks/pi-upgrade.md` §6 |
| **codeql.yml** | CodeQL 代码扫描（javascript-typescript，默认规则集 + security-and-quality） | push main / 每个 PR / 每周一 | Security → Code scanning alerts 里看；非必过检查 |
| **scorecard.yml** | OpenSSF Scorecard 供应链健康度评分，结果发布到 api.scorecard.dev 并上传到 code scanning | push main / 每周六 | Security → Code scanning alerts；README 的 Scorecard 徽章会显示当前分数 |
| **image-scan.yml** | Trivy 扫描本仓库构建的全部 10 个平台镜像（OS + npm 漏洞，HIGH/CRITICAL） | 每周一 + 手动（`gh workflow run image-scan.yml --ref <分支>`） | Security → Code scanning alerts，按 `image-scan-<镜像名>` 分类查看每个镜像各自的结果；非必过检查，一个镜像扫描失败不影响其它九个（`continue-on-error` + `fail-fast: false`） |
| **release-please.yml** | 维护一个滚动的 "chore: release X.Y.Z" PR，合并后打 tag、发 GitHub Release | push main | 见 `docs/runbooks/release.md`——合并那个 release PR 前有一步必须手动做的事（补一次 CI 触发） |
| **pr-title.yml** | PR 标题按 conventional commits 校验 | 每个 PR 的 open/edit/reopen | 非必过检查；标题不合规范改标题重新触发就行 |

## 常见问题

**Renovate 半天没开出任何 PR。** 先确认 GitHub App 真的装了（仓库 Settings → GitHub Apps 里应该
能看到 Renovate）；装了但还没到它的调度周期也正常，`schedule:nonOfficeHours` 意味着白天（
Asia/Shanghai 工作时间）不会开新 PR。

**auto-merge.yml 没有给某个 PR 开自动合并。** 先看这个 PR 有没有 `needs-review` 标签——有就是
故意的（major 或 `pi` 组）。没有标签但也没触发：检查 workflow 运行记录里 `renovate`/`dependabot`
两个 job 有没有跑（`if: github.actor == ...` 条件没匹配上,通常是因为这个 PR 不是这两个 bot
开的）。

**`needs-review` 标签的 PR 想强制走自动合并流程。** 把标签摘掉，然后随便 push 一次这个 PR 分支
触发 `synchronize`（或者直接手动 `gh pr merge --auto --merge`，效果一样，只是不经过这个
workflow 的记录）。

**要不要把 `e2e`/`pr-title` 也设成必过检查。** 不是本自动化包决定的——是仓库 Settings → Branches
→ `main` 的分支保护规则里手动加,`e2e.yml` 自己的文件末尾注释里也写了同样的话（等它稳定跑几轮
PR 不 flaky 之后再加）。`pr-title.yml` 设不设为必过看团队要不要真的强制 PR 标题规范；本 PR 默认
不加。
