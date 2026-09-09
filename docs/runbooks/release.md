# Runbook：release（版本发布：release-please 契约、主机跟随 tag、hotfix）

对应交付物：`.github/workflows/release-please.yml` + `release-please-config.json` +
`.release-please-manifest.json`（GitHub 自动化补全包的一部分，见
`docs/runbooks/automation.md`）。前置阅读：`docs/runbooks/host-checkout.md`（E3.1 代码检出脚本
`scripts/host-checkout.sh`）、`docs/runbooks/operations.md`（整体回滚顺序）。

## 1. 现状：单一根版本，release-please 全自动开 PR

本仓库是单体 pnpm workspace（`packages/*`/`gatekeepers/*`/`collectors/*` 共享一条版本线，不是
每个包独立发版）——`release-please-config.json` 只声明了一个包 `"."`（根目录，
`release-type: node`，即读写根 `package.json` 的 `version` 字段），`.release-please-manifest.json`
记录当前已发布版本（起始 `0.1.0`）。**不要**给某个 `packages/*` 单独发版或加自己的 `version`
字段——那是多包独立发版模式，本仓库没有采用。

流程：

1. 每次 push 到 `main`，`release-please.yml` 跑一次 `googleapis/release-please-action`。
2. 它扫描自上一个 tag 以来的所有 commit，按 conventional commits 前缀分类（`feat:` → Features，
   `fix:` → Bug Fixes，`feat!:`/`BREAKING CHANGE:` → 触发 major——本仓库 commit 已经在用
   `feat/fix/docs/chore(scope): ...` 前缀，见 `git log`），据此算出下一个版本号，然后**开一个
   标题形如 `chore: release X.Y.Z` 的 PR**（没有就开，有就更新到最新累积状态——同一个 PR 会随着
   `main` 上新 commit 不断 force-push 更新，不会开出第二个）。这个 PR 本身改两处：根
   `package.json` 的 `version` 字段、`CHANGELOG.md`（新增一节）。
3. **合并这个 release PR 才是真正"切一个版本"的动作**：合并后 release-please 在合并产生的
   commit 上打 tag `vX.Y.Z`（`release-please-config.json` 里 `include-component-in-tag: false`
   ——单包 manifest，tag 不带包名前缀），并创建一个同名 GitHub Release，Release 说明取自
   `CHANGELOG.md` 对应那一节。
4. 平时不用管这个 PR——它会自己维护到最新状态。什么时候合并，是一个人的决定（"现在要不要切一个
   版本发出去"），不是自动的。

## 2. 已知限制：release PR 不会自动触发 CI，合并前先手动踢一下

`release-please.yml` 用默认 `GITHUB_TOKEN`（没有引入新的 PAT/secret）。GitHub Actions 有一条
文档化的限制：**用 `GITHUB_TOKEN` 开出/更新的 PR，不会触发监听 `pull_request` 的其它
workflow**（防止递归触发）。后果：release-please 开的这个 release PR，`ci.yml`
（`guards`/`quality`/`test`，分支保护要求的三个必过检查）、`codeql.yml`、`pr-title.yml`
**都不会自动跑**——分支保护会一直显示"必过检查未运行"，PR 合不了。

**合并 release PR 前，必须先手动让 `pull_request` 事件真的触发一次**，两种做法任选：

```
# 方式一：给 release PR 分支推一个空 commit（人的操作，不是 GITHUB_TOKEN，会正常触发 pull_request）
git fetch origin release-please--branches--main
git checkout release-please--branches--main
git commit --allow-empty -m "chore: trigger CI"
git push

# 方式二：直接在 GitHub UI 上把这个 PR 关闭再重新打开（Close pull request → Reopen）
```

两种方式效果一样：都会补发一次 `pull_request` 事件，`guards`/`quality`/`test` 正常跑起来，跑绿
之后就能正常合并（分支保护 + `allow_auto_merge` 已经开着，合并方式不变）。

## 3. 主机怎么跟随一个 release tag

`scripts/host-checkout.sh`（`docs/runbooks/host-checkout.md` E3.1）默认把检出目录重置到
`origin/main`（`BRANCH` 环境变量默认 `main`）——这是"跟主线走"的日常部署模式,不是"锁定在某个
release"的模式。要让主机部署锁定在某个已发布的 tag（而不是 main 分支最新 commit），在
E3.1 之后手动切一次：

```
ssh <TARGET_HOST>
cd <CODE_DIR>
git fetch origin --tags
git checkout vX.Y.Z          # detached HEAD，明确落在这个 release
git rev-parse HEAD            # 确认 commit 对得上 GitHub Release 页面
```

接下来照常走 `docs/runbooks/operations.md` 的重启顺序（`docker compose build <改动的服务> &&
docker compose up -d <该服务>`）。下次要跟回 `main` 的最新提交，重新跑一次
`scripts/host-checkout.sh`（它会把 detached HEAD 状态覆盖掉，重新 fetch + reset 到
`origin/main`）即可，无需额外清理。

## 4. Hotfix 流程

线上 tag 之后发现一个必须马上修的问题，不等下一次常规 release：

1. 从出问题的 tag 切分支：`git checkout -b hotfix/<描述> vX.Y.Z`。
2. 按正常流程改代码、写 `fix: ...`（或 `fix(scope): ...`）前缀的 commit，走 PR 流程合到
   `main`（`pr-title.yml` 会检查标题前缀；正常 PR 走 `ci.yml` 三个必过检查）。
3. 合并到 `main` 后，`release-please.yml` 会照常识别出这条 `fix:` commit，累进到下一个待发布
   PR 里（比如 `main` 上如果已经有其它未发布的改动，两者会算进同一个下一版本号，不会单独为
   hotfix 开一条独立的版本线——这符合"单一根版本"的前提：本仓库没有对旧版本分支做 backport 式
   维护）。
4. 需要**立刻**把这个修复发出去、不等其它未发布改动一起走：直接按 §1 步骤 3 合并当前的 release
   PR（release-please 已经把这条 `fix:` commit 算进去了），拿到新 tag 后按 §3 让主机跟上。
5. 如果 hotfix 紧急到等不了 release-please 走一轮 PR-合并的完整流程：先按 §3 直接把主机切到
   hotfix 分支的 commit 应急（`git checkout <hotfix分支的commit sha>`，跳过 tag），事后照常走
   §1-§3 补一个正式 release tag，再把主机切回那个 tag——不要长期让生产停留在一个没有 tag 的
   commit 上，`docs/runbooks/operations.md` 的回滚流程依赖"当前部署对应哪个已知 tag/commit"这个
   前提。

## 5. 回滚

- **回滚一次已经打了 tag 的发布**：不删 tag（tag 是历史记录，删了会打乱其它人已经 fetch 过的
  引用）。按 §3 把主机切到上一个已知良好的 tag。要不要在 `main` 上补一个 revert commit（会被
  release-please 算进下一个版本），看这次发布的问题是否需要在代码层面修正。
- **回滚一次还没合并的 release PR**（比如 CHANGELOG 分类算错了）：直接改这个 PR 里的
  `CHANGELOG.md`/`package.json` 内容手动修正后合并——release-please 不会覆盖人工改过的这个PR
  分支，下次跑会基于新的 manifest 状态继续。或者直接关闭该 PR，release-please 下次 push 到
  `main` 时会重新开一个。
- **配置本身出问题**（`release-please-config.json`/`.release-please-manifest.json` 写错，
  release-please 算出的版本号不对）：`.release-please-manifest.json` 是当前"已发布版本"的唯一
  事实来源，手工改这个文件对齐实际情况（比如已经手工打过某个 tag，但 manifest 没同步），下次
  push 后 release-please 会以此为准重新计算。
