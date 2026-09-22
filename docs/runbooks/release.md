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

### 3.1 版本号随镜像走：构建 kernel 前先导出 `KERNEL_VERSION`

控制台概览显示的内核版本（`platform-handlers.ts` 读 `KERNEL_VERSION`）自 B1（`console-completion-plan.md`
§5.8）起是**构建参数 → 镜像 ENV**（`packages/kernel/Dockerfile` 的 `ARG KERNEL_VERSION` →
`ENV KERNEL_VERSION`，`docker-compose.yml` 的 `build.args` 传 `${KERNEL_VERSION:-dev}`），
**不再是 `.env` 里手工维护的值**——`.env` 里若还留着 `KERNEL_VERSION=...`，compose 已不读它，删掉即可。
镜像构建上下文不含 `.git/`（`.dockerignore`），所以值必须由跑 `docker compose build` 的 shell 给出：

```
cd <CODE_DIR>            # 已 checkout 到目标 tag / commit
export KERNEL_VERSION="$(git describe --tags --abbrev=0) ($(git rev-parse --short HEAD))"
docker compose build kernel && docker compose up -d kernel
```

渲染规则（选定"tag + 短 sha"，不用 `git describe --long` 的 `v0.13.2-0-g0fa5a1e` 形态）：

| 检出位置 | `KERNEL_VERSION` | 概览显示 |
|---|---|---|
| 正好在 tag `v0.13.2`（`0fa5a1e`） | `v0.13.2 (0fa5a1e)` | `v0.13.2 (0fa5a1e)` |
| tag 之后 3 个 commit（hotfix 应急，§4 第 5 步） | `v0.13.2 (abc1234)` | `v0.13.2 (abc1234)`——sha 与 tag 的 sha 不同即可辨认"不在 tag 上" |
| 未导出（本地 / CI 构建） | 空 → compose 缺省 `dev` | `dev` |

`git describe --tags --abbrev=0` 只取最近的 tag（不带 `-N-gSHA` 后缀），短 sha 单独用 `git rev-parse --short
HEAD` 取——两段拼起来就是概览要的 `v0.13.2 (0fa5a1e)` 形态，内核与前端不做任何格式化。
`scripts/drill-upgrade.sh` / `scripts/drill-install.sh` 里每一步 `docker compose ... build` 之前（各自
checkout 目标 ref **之后**）都应先做同样的 `export`，否则演练 / 安装出来的镜像概览会显示 `dev`；
用 `docker image inspect nexttime-ai-kernel --format '{{.Config.Env}}'` 可以在 `up` 之前核对镜像里烙的值。

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

## 6. 迁移可逆性

对应 `docs/development-tasks.md` §"S5.8 交付与演示闭环"交付物 2。`docs/runbooks/operations.md`
§9 已经说过"迁移只增不减，回滚代码不会自动回滚 schema"——本节把这句话落成一张可核查的表，逐个
迁移文件回答同一个问题。

**定义**：一个迁移**可逆** = 回退这次发布时，只需要把**代码**切回 v(n-1)（`docs/runbooks/
release.md` §3 的 `git checkout` 方式），v(n-1) 的代码能在 v(n) 已经应用过这个迁移的 schema 上
继续正确运行，不需要连数据库也一起回滚。**不可逆** = 回退代码不够，必须额外用升级前的备份
`scripts/restore.sh --target-db nexttime --i-know`（`docs/runbooks/backup-restore.md`）把数据库
本身也还原回去。

判定方法：**读 SQL 本身，也读 v(n-1) 那个版本里实际调用它的代码**，而不是"这条 SQL 只做了 ADD
COLUMN/CREATE FUNCTION，所以肯定可逆"这种表面判断——同一句"只是新增"，如果新增的是一个
`CREATE OR REPLACE FUNCTION` 改变了返回行数、或一个新的写入点校验会拒绝旧代码本来会发出的写入，
结论可能完全相反。`scripts/drill-upgrade.sh` 的 PROBE 步骤（"checkout v(n-1) 代码、在 v(n) 的
schema 上跑它自己的 `accept_s1.sh`"）就是把这条判断从"读代码得出的推理"变成"跑出来的证据"的机制；
下表的"依据"列是这次读代码得到的推理，PROBE 的实测结果作为独立证据附在旁边。

| 版本 | 迁移 | 可逆？ | 依据 | 回退方式 |
|---|---|---|---|---|
| v0.10.1 | （无——本版本只有 kernel 的连接池错误处理修复，无 schema 变更） | 可逆（N/A） | 无迁移可回退 | 按 §3 切回上一个 tag 即可，无需 `restore.sh` |
| v0.11.0 | core `0025_ontology_enforcement`：`workspaces` 新增 `ontology_enforcement`（既有行回填 `'warn'`，新行默认 `'reject'`），供写入点（`ontology-guard.ts`）按 I2 校验 Link | 可逆 | 校验逻辑本身在 v(n) 的 kernel 代码里（`enforceOntologyOnLinkWrite`），回退到 v(n-1) 代码后这段代码根本不存在，不会再读这一列；新列有默认值，v(n-1) 代码原有的显式列插入语句不受影响。唯一的操作性关联：STATUS "W9 主机应用注意"要求把既有工作区从 `warn` 手动切到 `reject` 是**前进方向**的滚动升级安全阀，不是回滚问题——回滚后这一列的值即使是 `reject`，v(n-1) 代码也不读它，纯元数据，不影响功能 | 只需回退代码 |
| v0.11.0 | core `0026_fact_freshness`：`links` 新增 `last_observation_id`/`last_observed_at`，`objects` 新增 `last_observed_at`，加一个索引 | 可逆 | 三列全部可空、无默认值以外的约束；`links_source_object_active_idx` 只是索引，不改变任何写入路径的语义。v(n-1) 代码的 `FACT_COLUMNS`/`OBJECT_COLUMNS` 是编译进二进制的显式列清单（`substrate/graph/queries.ts`），不会去读这三个新列，新增列对它完全透明 | 只需回退代码 |
| v0.11.0 | core `0027_find_active_facts_for_identity`：`CREATE OR REPLACE` 把 `find_active_fact_for_identity` 从"最多返回 1 行（`limit 1`）"改成"返回该身份全部仍活跃的 Fact（可能 > 1 行），且 `for update` 现在锁的是全部这些行" | 可逆 | 读了 v(n-1) 的调用方（`sql-store.ts` `assertFact`，`git show <v0.11.0 前一个 commit>`）：调用方只做 `priorResult.rows[0]`（取第一行）和 `rows.length === 0`（判断"完全没有"），两者在返回集从"至多 1 行"变成"至多 N 行（`order by recorded_at desc` 不变）"后行为不变——`rows[0]` 仍然是最新的那一行，`length === 0` 仍然只在真的没有活跃 Fact 时成立。v(n-1) 代码因此退化成它升级前本来的行为（对同一身份的多个活跃 Fact 只处理最新一条），这正是 S3.2 就已知、文档化过的既有局限，不是这次迁移新引入的破坏。唯一的真实差异：并发场景下现在会锁住更多行（更强的串行化），可能略增锁等待，不是正确性问题 | 只需回退代码（并发锁范围变化是性能/可用性层面的细微差异，不影响正确性） |
| v0.12.0 | core `0028_source_name_workspace_purpose`：`sources` 新增可空 `name`（仅在同一 `(workspace_id, kind, name)` 唯一时回填）+ 局部唯一索引 `where name is not null`；`workspaces` 新增 `purpose`（默认 `'standard'`）/`expires_at`（可空） | 可逆 | v(n-1) 的 `register_source`/`create-workspace` 不知道 `name`/`purpose`/`expires_at` 这几列，插入语句是显式列清单，不会给 `name` 赋值——插入行 `name` 恒为 `NULL`，局部唯一索引的 `where name is not null` 条件天然不适用，不会因为"名字冲突"而报错；v(n-1) 版本的采集器本来就是用本地状态文件缓存 Source id 做幂等（S5.3 之前的既有机制），回退后这个机制原样继续工作，只是重新失去"按 name 天然幂等"这个 S5.3 才有的好处，不是错误 | 只需回退代码 |
| v0.12.0 | core `0029_latest_fact_dead_end_for_identity`：新增函数 `latest_fact_invalidated_for_identity`（v(n-1) 完全没有任何代码调用过这个此前不存在的函数名） | 可逆 | 纯新增，且是全新函数名——v(n-1) 代码库里没有、也不可能有对它的调用（S5.5 才第一次引入这个调用点），回退没有任何"曾经调用、现在行为变了"的路径需要检查 | 只需回退代码 |

**规则**：任何一次发布如果表里出现"不可逆"，必须在合并那次 release PR **之前**把这条不可逆标注
手工加进它自己的 `CHANGELOG.md` 那一节（本文件 §5"回滚一次还没合并的 release PR"已经说明这个
PR 允许人工改动）——写清楚是哪个迁移、为什么不可逆、回退必须用哪次备份。`scripts/drill-upgrade.sh`
的 PROBE 输出（`PROBE old-code-on-new-schema ok|failed`）是这个判断的证据来源：一次真实升级前
（或候选 tag 定下来后）跑一遍 `drill-upgrade.sh --to <候选 tag> --ack-live-restore`，PROBE 结果
连同上面表格式的推理一起，决定要不要在这次发布的 CHANGELOG 里加标注。
