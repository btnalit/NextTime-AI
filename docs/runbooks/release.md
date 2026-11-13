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
4. 平时不用管这个 PR——它会自己维护到最新状态。什么时候合并不是自动的，要有人决定"现在要不要切一个
   版本发出去"。**维护者 2026-11-07 定**：一个阶段做完整之后的大版本由协调者把控发版，不用等维护者批准。合并线程合入前照常做这几件事：手写发版说明（升级须知、已知问题、回滚），核对 release PR 落后 main 为 0、CI 全绿，并查开放的 Dependabot 告警。告警接口对线程是 403 时，用 `pnpm audit` 代查。STATUS 遗留表里标着「发版前必须关闭」的遗留没关之前，不合 release PR（例如遗留 681，见 §3.150）。主机升级仍由维护者决定（第 6 条）。
5. **生产 apply 之前先预演（#488，v0.43.0 起）**：tag 出来后在 Actions → `staging` 手动 dispatch，`to` = 待应用的
   tag（走 `--pull`，验签发布镜像），在一次性 runner 上从上一个发布版升上去并跑 S3→S1→S2→S4；需要真实模型回归时勾
   `real_model`（`staging-real-model` environment，仅 main 触发，不设人工审批，见 `staging-rehearsal.md` §4）。步骤、成本上限与它复现不了的东西见
   `docs/runbooks/staging-rehearsal.md`。预演绿了再按 §3 上生产主机。
6. **主机升级按大版本攒着做（维护者 2026-11-06 定）**：发版不等于升主机，主机按大版本攒几版一次升（如 v0.50.0 → v0.63.0 一个窗口）。
   只有主机升级前那一次预演要求 `from` = 主机当前版本、`to` = 要升到的 tag，按主机实际要走的路径跑一遍；日常预演
   （功能 PR、发版后的例行预演）的 `from` 不限，取上一个发布版即可。这条是流程约定，CI 不强制检查。

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

**镜像签名碰上 Rekor 409 时（v0.65.0 遇到过）**：发布 run 的 `build-sign` 在 `cosign sign` 这一步报 `createLogEntryConflict`（409，透明日志里已有同样的条目），这是 Sigstore 那边的问题，与代码无关，镜像已经推上去了，只是没签上。先「Re-run failed jobs」一次；还失败的话，不要再重跑整个 release run，在 Actions 手动 dispatch `publish-images`（`tag` = 这个版本），它会重新构建、签名并扫描全部 11 个镜像；成功后再手动 dispatch 一次 `release-channel`，写出 `channel.json`。tag 和 GitHub Release 不受影响，不用重做。

## 3. 主机怎么跟随一个 release tag

**应用一个 release 的唯一入口（S9 D2）**：在检出根目录，跑**目标 tag 自己的** `apply-release.sh`

```
git fetch -q origin --tags
git show vX.Y.Z:scripts/apply-release.sh > /tmp/apply-release-vX.Y.Z.sh
sh /tmp/apply-release-vX.Y.Z.sh --prefetch vX.Y.Z  # 维护窗口之前：预拉并验签；终端只打印日志路径，日志 drills/prefetch-vX.Y.Z-<ts>.log 最后一行必须是 RESULT ok（见下）
sh /tmp/apply-release-vX.Y.Z.sh --pull vX.Y.Z      # 窗口内：用已预拉、已验签的发布镜像应用（没预拉完就拒绝；失败即停，不回退构建）；经 SSH 时后台运行（nohup / tmux）并 tail -f 日志，见下
sh /tmp/apply-release-vX.Y.Z.sh vX.Y.Z             # 仅显式需要时：源码构建（主机出网不可靠，不作为常规路径）
```

**维护窗口之前先预拉，是 `--pull` 的前置条件（遗留 137，#513 起）**：v0.43.0 的维护窗口里光拉 11 个镜像
就用了约 53 分钟，而主机出网是长期约束（维护者 2026-10-09：不再调优）。提前（比如前一天）把目标版本的镜像
拉好并验签：

    git fetch -q origin --tags
    git show vX.Y.Z:scripts/apply-release.sh > /tmp/apply-release-vX.Y.Z.sh
    sh /tmp/apply-release-vX.Y.Z.sh --prefetch vX.Y.Z    # 日志 drills/prefetch-vX.Y.Z-<ts>.log，最后一行必须是 RESULT ok

`--prefetch` 只跑目标 tag 自己的 `pull-images.sh --prefetch`：拉取 + 验签 11 个平台镜像（每个的
`org.opencontainers.image.revision` 必须等于 tag 的 commit），再补拉目标 compose 文件里钉 digest 的
第三方镜像、`docker/dockerfile:1.7` 和验收 fixture 的基础镜像（只补缺失的）。**不重打 tag、不切检出、
不碰在跑的栈和数据库**，随时可跑、可重跑（已在的跳过）。每次拉取限时（`PULL_ATTEMPT_TIMEOUT`，默认
7200 s）、失败重试两次，超时那次已下完的层留在本机、重试接着拉；`RESULT failed-at=prefetch` 时看同目录的
`-pull.log`：平台镜像拉取或验签失败会在那一个镜像上直接停下，第三方镜像、frontend 和 fixture 基础镜像拉不下来的则继续、列在最后；两种都重跑即可。

窗口内的 `--pull` 第一步（在备份、dump、切 tag 之前）离线核对镜像都已预拉：没有就
`FAIL not-prefetched`，主机上什么都没改，先补 `--prefetch` 再来。确实要在窗口内现拉（每个镜像最坏
3 × 2 h）时用 `--pull --allow-long-pull vX.Y.Z`，日志留 `STEP prefetch-check WARNING`。之后日志里每个镜像
一行 `present, not pulled again`，验签照做（每个镜像一次小请求，访问 GHCR 签名与 Sigstore，限时 600 s、重试两次——窗口内仍要联网的一步，遗留 141）；拉取或验签失败就在 `up` 之前停下（`FAIL images`，检出切回、
栈不动），**不再退回源码构建**——那条路要现场走 npm / apt，且验收的会是未签名的主机构建。`--pull` 应用后的
验收只认带发布标签的镜像（`ACCEPT_REQUIRE_RELEASE_IMAGES=1`）。
预拉的镜像在下一次 `prune-images.sh` 前一直占盘（每个版本约 2.8 GB）；若预拉了 vX.Y.Z 却先应用了更低版本
的 hotfix，`prune-images.sh --keep 2` 会把预拉的版本算作最新两个之一，上一版的回滚镜像可能因此被清掉，
这种情况先删掉预拉的镜像或用 `--keep 3`。

为什么不直接 `sh scripts/apply-release.sh`：检出目录此时还停在**正在运行的旧版本**上，
`scripts/apply-release.sh` 是旧 tag 的副本——它切到新 tag 后仍按旧流程往下走，新版本加进流程的步骤
它一概不会做。R-03 起的第一次应用就是这样：旧副本没有"派生 internal-plane 凭证"这一步
（`scripts/derive-internal-tokens.sh`），迁移的 `docker compose run` 因新 compose 文件引用的
`secrets/internal-*-to-*.token` 不存在而失败，停在 `FAIL migrate`（`up` 之前，在跑的栈不受影响）。
用 `git show` 取出目标 tag 的副本，流程永远属于被应用的那个版本。

上生产主机之前，先按 §1 第 5 步在 Actions → `staging` 对同一个 tag 跑一次预演，绿了再动主机。

跨越的每个版本在下面 §3.1 起各有一小节；标明"维护窗口前"的核对（如 §3.13）和 `--prefetch` 同时做，结论记 `docs/private/`，有需要主人确认的先确认再进窗口。一次跨多个版本的窗口按 §3.23 的总清单走；v0.46.0 → v0.49.0 按 §3.27（v0.47.0、v0.48.0 不单独上主机）。

**本节命令的执行方式**：所有命令都在主机检出目录下执行。SQL 一律经
`docker compose exec -T postgres psql -U nexttime -d nexttime -v ON_ERROR_STOP=1` 交给 psql，并包在
`begin transaction read only; … rollback;` 里。经 SSH 执行时：
- 带 SQL 或脚本的命令，把 heredoc 通过管道交给 ssh，stdin 就是 SQL，不要加 `</dev/null`：
  `ssh <主机别名> 'cd <检出目录> && docker compose exec -T postgres psql -U nexttime -d nexttime -v ON_ERROR_STOP=1' <<'SQL'`，然后是 SQL 正文，最后一行 `SQL`；
- 不需要输入的命令（`docker ps`、`docker compose logs`、`docker inspect`、`stat`）用 `ssh -n`，或在命令末尾加 `</dev/null`，
  否则 ssh 会吃掉后面命令的 stdin。

标「**victor 手动**」的步骤要登录控制台，由维护者本人做，远程 CLI 会话不做、也不要索取管理员凭据；控制台路径写成
「分组 → 页面 → 按钮」，分组是侧栏的「使用 / 治理 / 平台」。

**执行会话被拦下时（遗留 231）**：远程 CLI 会话的某条主机命令被本地权限检查拦下时，停在这一步，等维护者在**该会话里**批准，
或由他自己加允许规则；不换个写法重新发起，也不自己加允许规则。下发窗口操作之前先把这一点告诉维护者，让他在场批准或提前加好规则。

经 SSH 时作为后台任务运行并跟日志（脚本先打印日志路径，`${NEXTTIME_DATA}/drills/apply-<tag>-<ts>.log`）：每步一行
`STEP …`，致命步骤打印 `FAIL <step>` 并以非 0 退出。最后一行是 `RESULT ok`、`RESULT failed-at=<step>`、`RESULT acceptance-failures=<n>`
或 `RESULT degraded=<step>[,<step>…]`，两者都有时是 `RESULT acceptance-failures=<n> degraded=…`（v0.48.0 起有 degraded，§3.26）。
**退出码 0 不等于成功，看最后一行 RESULT**：只有 `failed-at` 退出 1，`acceptance-failures` 与 `degraded` 都退出 0；只有 `RESULT ok`
表示没有剩下要做的事。远程 CLI 会话同样按 RESULT 行判断，不按退出码。`degraded` 表示新版本已在运行，但某个不致命的步骤没做完：
按 apply 日志里对应 `STEP <step> …` 行打印的命令补做（§3.26 的表），补做结果记 `docs/private/`。
它按顺序做完本节下面分散描述的全部手续：备份新鲜度 → 发版前 dump（`backups/pre-upgrade/`）→ 切 tag →
派生 internal-plane 凭证（新 tag 自己的 `scripts/derive-internal-tokens.sh`，只写
`secrets/internal-*-to-*.token`，R-03）→ 拉取或构建镜像 → 迁移 dry-run 与应用 → `up -d` → S3 → S1 → S2 →
S4 → `BACKUP_NOW` → 只留 3 份发版前 dump → 镜像保留（`scripts/prune-images.sh --keep 2 --yes`：本项目镜像只留
最近两个发布版本，任何容器在用的、带 `latest` 的、`activeRuntimeImage` 及其回滚目标一律保留；别的项目的镜像、
没有本项目标签的悬空镜像和构建缓存不碰；`STEP images-retention` 行给出删了多少；单独跑默认只演练）→
清理过期的 ephemeral 工作区 → 观察记录压缩（遗留 103，见本节"观察记录压缩"段）。dump / 切 tag / 派生 / 镜像 /
迁移任一步失败都在 `up` 之前停下，在跑的栈不受影响；切 tag 之前记下原来的 ref（`STEP checkout-from`），
切 tag 之后、`up` 之前的失败会把检出切回去（`STEP checkout restored to …`，切不回时打印要手动执行的
`git checkout`），让检出始终与在跑的栈一致；迁移失败时先列出已提交的迁移（每个文件一个事务，
`STEP migrate committed <module>/<version>`）和本次的发版前 dump（`STEP migrate rollback point`），
再按 §5 / §6 决定是修好重跑还是恢复 dump（R-71）。`up` 本身失败时检出留在新 tag 上（部分容器可能已是新版本），
按 §5 手动回滚，日志里的 `checkout-from` 就是上一版的位置；
验收失败只计数不中止（栈已在新版本上，读各套日志后按 §5 决定是否回滚）。主机差异只来自 `.env`。
第 3 步 `git fetch` 限时 300 s，失败而 tag 已在本地（预拉时 fetch 过）时继续，日志 `STEP checkout WARNING git fetch failed — … using it`。
下面各小节保留为每一步的背景与手动做法。

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

接下来构建镜像：**`sh scripts/build-images.sh`**（2026-09-26 起的唯一构建入口）——它构建全部默认服务
**外加** `worker-runtime`（`build-only` profile，裸 `docker compose build` 从不重建它，所有入口 agent /
Worker 跑的 pi + platform-extension 会悄悄停在旧构建上），并从检出本身导出 `KERNEL_VERSION` /
`PI_VERSION` / `PLATFORM_EXTENSION_VERSION` / `BUILT_FROM`，镜像标签因此是真实版本而不是 `dev`；
运行时镜像另打 `nexttime-ai-worker-runtime:pi-<版本>` 供回滚。之后照常走 `docs/runbooks/operations.md`
的重启顺序（`docker compose up -d`）；运行层页的「pi 运行时」卡片随后显示还有几个常驻智能体在旧镜像上，
一键升级即可。

**拉取发布镜像（S9 D1，代替上面的构建）**：发版时 `release-please.yml` 的 `publish-images` job 把十一个
平台镜像推到 GHCR（`ghcr.io/<owner>/nexttime-ai-<service>:vX.Y.Z`，带 SBOM / provenance 与 cosign keyless
签名；历史版本可在 Actions 手动跑 `publish-images` 补发）。检出切到同一个 tag 后：

```
sh scripts/pull-images.sh vX.Y.Z       # 拉取 → 验签（精确匹配：本仓库 main 上的 publish-images.yml，且由本仓库 main 上的运行签出）→ 重打成 compose 的本地名
docker compose up -d --no-build
```

验签用钉 digest 的 cosign 容器跑，主机不需要装任何东西。包是公开的（从公开仓库的工作流发布、继承仓库可见性，
2026-10-02 核实匿名可拉），主机不需要任何 registry 凭证；若以后改成私有，先 `docker login ghcr.io`（read:packages
令牌，放主机 `secrets/`，不进仓库），验签会在匿名失败后带上 docker 配置重试。重打 tag 之后 compose、worker-supervisor 白名单、`activeRuntimeImage`、
「pi 运行时」卡片看到的名字与标签和源码构建完全一样。`.env` 里 `EXPLORER_BUILD=1` 的主机：发布的 caddy
不含 Explorer bundle，caddy 仍用 `sh scripts/build-images.sh caddy` 构建。验收不在主机上源码构建任何平台镜像（遗留 137）：S3 的采集器、S2 的两个门（与 `gate-host` 同一个
gatekeeper-base 镜像）都直接用本次装上的镜像，发布镜像的 revision 必须等于检出 commit。三个裸 fixture
（accept-s2 sshd / openapi / mcp）和 fake-llm 仍在主机构建：基础镜像 + COPY，sshd 另有一层
`apk add openssh-server`。基础镜像和构建缓存都在时不出网；新主机或清过构建缓存后，sshd 那层要访问
Alpine 源——这是验收仍剩的出网点（遗留 139）。拉取或验签失败时 `apply-release.sh --pull` 在 `up` 之前停下，
不退回构建；查明原因（多半是出网）后重跑 `--prefetch` 再应用。

下次要跟回 `main` 的最新提交，重新跑一次
`scripts/host-checkout.sh`（它会把 detached HEAD 状态覆盖掉，重新 fetch + reset 到
`origin/main`）即可，无需额外清理。

**备份三件事（收尾波次 C10，2026-10-01 起每次应用都做）**：
1. 切 tag **之前**先跑 `sh scripts/check-backup-freshness.sh`——验证上次应用以来每晚备份一直在跑
   （`backup` 服务在、`last-success` 不超过 26 小时、它指向的 dump 还在）。必须先于本次的发版前 dump /
   `BACKUP_NOW`，否则 `last-success` 总是新的，什么也证明不了。FAIL 先看 `docker compose logs backup`。
2. 发版前 dump 只放 `${NEXTTIME_DATA}/backups/pre-upgrade/`（绝不进 `backups/db/`，见
   `backup-restore.md`），应用通过后只保留最新 3 份（维护者 2026-10-01）。文件名按它**实际**
   捕获的版本命名，即 `nexttime-pre-<目标 tag>-from-<当前运行版本>-<ts>.dump`。如果检出已经停在
   目标 tag 上（上一次应用在切 tag 之后失败、这次是重跑），这份 dump 已经不是回退点，改名为
   `nexttime-rerun-<tag>-<ts>.dump`，单独只留 1 份，不会把真正的发版前 dump 挤出 3 份窗口
   （2026-10-02 复审 L9-7）。回退时要选 `from-` 写着回退目标版本的那一份。
3. 验收通过后 `docker compose run --rm -e BACKUP_NOW=1 backup`，确认新 dump 留在 `backups/db/` 里没被轮换删掉。

**观察记录压缩（遗留 103，维护者 2026-10-04 决定：年龄闸 30 天，带 payload 的观察永不压缩）**：
`BACKUP_NOW` 成功之后（那份 dump 就是恢复点；`BACKUP_NOW` 失败时这一步跳过，打印
`STEP observations-compaction skipped …`），并且放在清理过期工作区之后，`apply-release.sh` 跑
`docker compose run --rm --no-deps -T kernel node dist/cli/compact-observations.js --yes`，完整输出写进
`${NEXTTIME_DATA}/drills/apply-<tag>-<ts>-compaction.log`，日志里一行
`STEP observations-compaction exit=<rc> compact-observations: ok deleted=<n> of older=<m> rows=<r> workspaces=<w> batches=<b> log=…`。
失败只记录、不中止发版。一行观察只有同时满足下面全部条件才会被删：没有任何 Fact 的 `observation_id` /
`last_observation_id` 指向它（不论 Fact 状态）；不是它所属 Source 最新的一行；不是它所在
`(workspace, activity, source)` 剩下的最后一行；`content = '{}'`（采集标记——门观察、任务结果带 payload，
永不删）；早于 30 天。所以 Fact 的起源、私有 Source 带来的 Fact 可见性、Source 新鲜度 / 静默检测、观察窗口、
`explain` 与 PROV 导出读到的结果都不变。按每 Source、每 1 万行一个短事务分批删，用 core 0039 的索引；
每次 `--yes` 写一条平台审计 `cli.observations_compacted`（参数 + 各工作区计数；无操作者时按 core 0040
记为未署名的主机运维动作）。手动跑：不带 `--yes` 就是演练（dry run），按类别打印各工作区的计数，什么都不删；
可加 `--older-than-days <n>`、`--workspace <id>`、`--batch-size <n>`、`--actor <login>`。

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

### 3.2 一次性目录迁移：`models.json` 挪出 `config/`（S7-A）

S7-A（docs/STATUS.md 维护者决定 2026-09-22 ⑤：不给 `${NEXTTIME_DATA}/config/` 换属主）把 llm-proxy
原子重写的 `models.json` 从 `${NEXTTIME_DATA}/config/models.json` 挪到它自己的
`${NEXTTIME_DATA}/models/models.json`——kernel、worker-supervisor、`make gen-models`、
`scripts/host-env-init.sh`/`scripts/host-llm-proxy-init.sh` 都随这个版本的镜像/脚本一起换成新路径。
**已经部署过旧版本**（`config/models.json` 存在）的主机，在这次 `docker compose up` **之前**手动做一次
目录搬迁，不然新代码在新目录下找不到 `models.json`，`list_models`/`list_platform_models` 会 503、新
拉起的 agent 容器也拿不到白名单：

```bash
ssh <TARGET_HOST>
cd <CODE_DIR>
set -a; . ./.env; set +a
mkdir -p "${NEXTTIME_DATA}/models"
mv "${NEXTTIME_DATA}/config/models.json" "${NEXTTIME_DATA}/models/models.json"
chown 10001:10001 "${NEXTTIME_DATA}/models" "${NEXTTIME_DATA}/models/models.json"
```

之后照常按 §3 切到目标 tag、`docker compose build kernel llm-proxy worker-supervisor caddy` +
`docker compose up -d`（`scripts/host-env-init.sh` 幂等重跑一次也可以——它现在会自己补建
`models/`，但**不会**帮你把旧文件从 `config/` 搬过去，搬家必须是这条手动步骤）。回滚（§5）等价对称：
如果要切回一个 S7-A 之前的 tag，把 `models.json` 搬回 `config/` 下（`mv` 反方向），否则旧代码在
`config/` 下找不到它。

一次性步骤，不属于 §6 的 schema 迁移可逆性表（这是文件系统布局变化，不是数据库迁移）——`models.json`
本身是纯派生数据（`llm-providers.yaml` + 控制台 `providers.json` 的合并投影），丢了也能用
`make gen-models` 重新生成，只是省不了这一步手动 `mv` 加 `chown`。

`scripts/drill-upgrade.sh` 现在会在自己每一次 `git checkout`（切到 `--to` 目标 tag、PROBE 阶段切回
v(n-1)、最终回滚切回 v(n-1)）之后自动做这次搬家（`layout_step`）——不看 tag 号，只看检出树自己的
`docker-compose.yml` 是否挂载 `${NEXTTIME_DATA:?}/models`，来判断 `models.json` 该在 `config/`
还是 `models/`，以及是否需要建 `${NEXTTIME_DATA}/llm-proxy/`（S6-B），两个方向都是幂等的。真实升级
（不是演练）仍然要按上面的手动步骤做一次——这个自动化目前只存在于演练脚本里。

### 3.3 新增只读镜像代理：`docker-socket-proxy-images`（fix/supervisor-images-proxy，v0.16.2）

`docker-compose.yml` 新增第四个 `docker-socket-proxy` 实例（`IMAGES=1` 独此一项，`POST=0`）+ 专属
`dockerapi-images` 网络，worker-supervisor 新增 `DOCKER_IMAGES_HOST` env、加入这个网络——背景与为什么
不直接在既有 `docker-socket-proxy` 上开 `IMAGES=1`，见 `docker-compose.yml` 该服务块自己的注释，以及
`docs/runbooks/operations.md` §13"`docker-socket-proxy-images`"一节。

**已经部署过 v0.16.1 及更早版本的主机**，在这次 `docker compose up` 时（按 §3 切到目标 tag 之后）：

```bash
ssh <TARGET_HOST>
cd <CODE_DIR>
docker compose up -d docker-socket-proxy-images worker-supervisor
docker compose ps docker-socket-proxy-images worker-supervisor   # 都应为 healthy
```

`docker compose up -d`（不带服务名，§3 正常流程的一部分）本身就会创建新网络、拉起新服务、并因为
worker-supervisor 的服务定义变了（新 env + 新网络）而重建它——上面这条命令只是把这一步单独点名出来，
避免漏看（`GET /images` 在旧容器上会继续 403，`list_runtime_images`/`runtime_inventory`/
`set_active_runtime_image`/`rollback_runtime_image` 全部失败关闭，直到 worker-supervisor 真正重建）。
无数据库迁移，无文件系统搬迁——纯 compose 拓扑变化，回滚（§5）等价对称：切回 v0.16.1 之前的 tag 后，
`docker-socket-proxy-images`/`dockerapi-images` 不再被任何 compose 文件引用，`docker compose up -d`
会自然不再拉起它（旧容器需要的话手动 `docker compose down docker-socket-proxy-images` 清理，非必须）。

### 3.4 依赖安装层缓存：manifest-first 顺序 + BuildKit 缓存挂载（STATUS 遗留 93）

**问题**：每个 `@nexttime/*` 镜像的 build 阶段此前是 `COPY . .` 再 `pnpm install --frozen-lockfile`
——依赖安装层的 Docker 缓存 key 是整棵源码树的内容，任何一处源码改动（哪怕跟依赖无关）都让这一层
失效，于是每次发版全部服务都要把全量 npm 依赖重新下载一遍。这台主机的出网经上游网关，并发下载量大时
连接被掐断（`UND_ERR_SOCKET`）——v0.23.0 应用前两次都卡在 `pnpm install`、第三次才过。

**改法**（十一个 Dockerfile 的 `build` 阶段：`packages/{kernel,agent-host,egress-proxy,
gatekeeper-base,llm-proxy,worker-supervisor}/Dockerfile`、`gatekeepers/{docker,ragflow}/Dockerfile`、
`collectors/host-inventory/Dockerfile`、`deploy/caddy/Dockerfile` 的 `web-build` 阶段、
`deploy/worker-runtime/Dockerfile` 的 `build` 阶段——不含 `deploy/accept-s2/*`、`deploy/fake-llm`
这几个没有 `pnpm install` 的裸 fixture 镜像，也不含 caddy 的 `explorer-build` 阶段，它是
`EXPLORER_BUILD=1` 才跑的另一个仓库的 npm 构建，与本仓库工作区无关）：

1. **依赖层只依赖 manifest**：先 `COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./`，再逐个
   `COPY <pkg>/package.json <pkg>/package.json` 补全全部 12 个工作区成员（`pnpm install` 解析的是
   整个工作区依赖图——`workspace:*` 互相引用——不是某个包自己的依赖，所以任何一个 Dockerfile 都要
   全部 12 份 manifest，不能只拷自己 `--filter` 的那个包）。
2. **`pnpm fetch --frozen-lockfile --network-concurrency=4 --store-dir=/pnpm/store`**：`pnpm fetch`
   只读 `pnpm-lock.yaml`（`pnpm fetch --help`："package manifest is ignored"），把内容寻址存储填满，
   完全不需要上一步拷的 package.json 内容本身——拷 package.json 只是为了让这一层的缓存 key 与依赖
   实际状态一致（哪个包的哪个依赖变了，只影响这一层，源码改动不影响）。`network-concurrency=4`
   （pnpm 默认 16）：把并发下载连接数压低,用换取网关不掐断连接的稳定性，与 `scripts/build-images.sh`
   自己的 `COMPOSE_PARALLEL_LIMIT=1`（不同镜像的构建之间不并发）是同一个问题在两个层面的对应处理。
3. **`RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store`**：BuildKit 缓存挂载,内容持久化在
   宿主机的 buildx 构建缓存里，跨越单次 `docker compose build` 的多个镜像、也跨越不同的发版。所有
   十一个 Dockerfile 用的是**同一个** `id=pnpm-store`——`build-images.sh` 序列构建每个镜像时,第一个
   镜像（如 kernel）下载的公共依赖（`typescript`/`zod`/`@biomejs/biome` 等）会被后面每一个镜像的
   `pnpm fetch` 直接命中,不必逐个镜像各自下载一遍。`pnpm-lock.yaml` 变了（依赖升级）也只是让新增的
   那部分包重新下载,旧包的 tarball 仍在缓存里可复用。
4. **`COPY . .` 挪到 fetch 之后**，再 `pnpm install --offline --frozen-lockfile --store-dir=/pnpm/store`
   ——`--offline` 强制不联网,只从上一步已经填好的 store 里链接 `node_modules`（pnpm 自己文档："pair
   with --offline --frozen-lockfile"）。挂载缓存的内容对 BuildKit 是临时挂载,不会进最终镜像层——
   pnpm 在跨设备场景会自动从 hardlink 回退为 copy,把内容真正复制进这层普通文件系统,镜像内容因此不变。
5. **`deploy/worker-runtime/Dockerfile` 的 pi 全局安装层**（当时是 `npm install -g … @earendil-works/pi-
   coding-agent@${PI_VERSION}`）当时就已经只 keyed 在 `pi.version`（`COPY pi.version` 是这一层唯一
   的输入,在稳定的 apt/useradd 层之上）,遗留 93 那次只加了一个 `RUN --mount=type=cache,id=npm-cache,
   target=/npm-cache` + `npm install -g --cache=/npm-cache …`：pi 升版本时,新版本依赖树里没变的那部分
   包仍能复用缓存,不必整树重新下载。
   pi 1.1.0 起（#481），这一层改为 `deploy/worker-runtime/pi/` 锁文件 + `npm ci --cache=/npm-cache`：
   这一层的输入多了这两个文件，缓存挂载照旧，见 `pi-upgrade.md` §3。

**主机怎么核对生效**：

- 同一份代码第二次构建同一个镜像（比如改一行 `README.md` 后重跑 `sh scripts/build-images.sh
  kernel`），build 日志里 `pnpm fetch` 那一行应显示 `CACHED`（BuildKit 对完全相同输入的层直接跳过,
  不重新执行）；改一行源码但不改依赖同理。
- 故意改一下某个包的 `dependencies`（比如加一个版本号不同的依赖）重新构建,能看到新增的那一个包在
  下载,其余包不重新下载（构建输出里 `pnpm fetch` 自己的 `Progress: resolved N, reused M, downloaded
  K` 行,`reused` 应接近 `N`）。
- `docker buildx du`：查看 `pnpm-store` / `npm-cache` 这两个 cache mount 各占多少磁盘,确认确实在
  持久化增长而不是每次从空构建。
- CI 的证明面（本机没有 Docker,以上两条本机都做不了）：`.github/workflows/image-scan.yml`
  （每周 + 手动触发）用 `docker/build-push-action` 对全部十个真实服务镜像跑一遍完整 build（`cache-
  from`/`cache-to: type=gha`）,是这次改动在没有本机 Docker 的情况下唯一能跑通"这些 Dockerfile 语法
  正确、多阶段引用正确"的地方；`.github/workflows/e2e.yml` 的"Build kernel/caddy/llm-proxy images"
  步骤额外覆盖 kernel/caddy/llm-proxy/gate-host（`packages/gatekeeper-base/Dockerfile`）四个。这两个
  workflow 的 runner 都是全新 VM,不会体现"跨发版复用宿主机缓存"这个效果本身（GHA 的 `type=gha`
  缓存是另一套独立的远端缓存,不代表主机 BuildKit 本地缓存的行为）,但足以证明每个 Dockerfile 改完之后
  仍然能从头构建成功、镜像内容不变。真正验证"缓存挂载在主机上确实跨发版复用"要在主机上做上面两条。

**风险**：BuildKit 缓存挂载需要 BuildKit 后端,而不是旧的 legacy builder——`host-preflight.md`
要求的"Docker Engine / Compose v2"这一前提下,`docker compose build` 默认经 buildx/BuildKit 实现,
本身已经在用 `# syntax=docker/dockerfile:1.7`（每个 Dockerfile 早已声明,这次没有改动这一行,说明
BuildKit frontend 早就在被使用,主机第一次用到 `--mount=type=cache` 之前不需要单独"预拉"这个
frontend 镜像）。如果主机的 Docker 版本异常老旧、`docker compose build` 落回 legacy builder,
`--mount=type=cache` 会直接报语法错误而不是静默忽略——下次主机应用前先跑一次
`docker compose build kernel`确认不报错,再跑全量 `sh scripts/build-images.sh`。

### 3.5 自连门改用自己的连接密钥（R-01 / R-27，维护者决定 D-01）

**变化**：内核只把平台 `gate_token` 发给平台目录里的实例（`gate_instances`：打包门、门宿主实例，按
endpoint 的 host 判定）。经 `create_connection` 接入的**自连门**改用它自己的连接密钥——由
`mint_connection_secret` 签发、写进门的 `GATE_KERNEL_TOKEN_FILE`；内核只在 Gatekeeper 上存一个非秘密
salt，每次调用时用 `gate_token` 重新派生。owner 提供的 URL（`create_connection` 的 `endpoint` /
`manifestSource`、自连门的每次调用）还要过出站目标判定：裸服务名、`localhost`、回环、链路本地、平台
两个子网一律拒绝。没有新迁移（salt 存在 Gatekeeper 对象的 `properties` 里）。

**升级后既有自连门会停用，直到 owner 重签一次密钥**——这是有意的：它们此前持有的就是平台 `gate_token`，
继续发给 owner 填的地址正是 R-01 要关掉的口子。内核不会再碰它们（调用直接报
`connection_secret_missing`，不联系门），健康探测显示 `unauthorized`。操作员在升级时：

1. **升级前**列出受影响的自连门（Gatekeeper 的 endpoint host 不在平台目录里的）——在主机上：

   ```bash
   docker compose exec -T postgres psql -U nexttime -d nexttime -c "
   select o.workspace_id, o.id as gatekeeper_id, o.properties->>'name' as name,
          o.properties->>'endpoint' as endpoint
     from objects o
    where o.object_type = 'Gatekeeper'
      and o.properties ? 'endpoint'
      and not exists (
        select 1 from gate_instances g
         where g.endpoint <> ''
           and lower(substring(g.endpoint from '^[a-zA-Z]+://([^/]+)'))
             = lower(substring(o.properties->>'endpoint' from '^[a-zA-Z]+://([^/]+)')))"
   ```

   结果记 `docs/private/`；空表 = 没有要处理的。
2. 照常应用发布（§3）。`.env` 不用改：kernel 现在也读 `NEXTTIME_SUBNET_CONTROL`（早就是必填项）。
3. 通知每个工作区 owner：在控制台 **系统与授权 → 该门所在行的 ⋯ → 重新签发连接密钥**（或
   `rotate_connection_secret {gatekeeperId}`），把显示一次的密钥写进门的 `GATE_KERNEL_TOKEN_FILE` 指向的
   文件、重启门。门上原先放的平台 `gate.token` 副本此后应删掉（自连门不该再持有它）。
4. 自连门的 endpoint 若是**平台网络上的裸服务名 / 平台子网地址**（例如操作员自己加进 compose 的门），升级后
   连调用都会被出站目标判定拒绝（`target_refused`）。二选一：把它做成打包门（`add-gatekeeper.md`，走平台
   目录，用 `gate_token`）；或把主机名加进 `.env` 的 `NEXTTIME_CONNECTION_ALLOW_HOSTS`（逗号分隔）后
   `docker compose up -d --no-deps --force-recreate kernel`，再按第 3 步重签密钥。

验收夹具（`accept-s2-*`）不需要任何操作：`docker-compose.yml` 固定把它们写进 kernel 的
`NEXTTIME_CONNECTION_FIXTURE_HOSTS`（与操作员的 `NEXTTIME_CONNECTION_ALLOW_HOSTS` 取并集），主机验收
`accept_s2.sh` / `drill-add-gatekeeper.sh` 不重启 kernel。

**回滚**：切回上一版代码即可（无 schema 变化）。旧代码不认识 salt，会重新把 `gate_token` 发给自连门——
已经换成连接密钥的门会 401，直到把门的 `GATE_KERNEL_TOKEN_FILE` 指回平台 `gate.token`。

### 3.6 provider key 与 RAGFlow key 改为文件（R-24）

**变化**：容器 env 能被只读的采集器 socket 代理 `inspect` 看到，所以两类密钥改从文件读：

| 密钥 | 主机文件（目录 0750 root:10001，文件 0640 root:10001） | 容器内路径（只读目录挂载） | 谁读（uid） |
|---|---|---|---|
| LLM provider key | `${NEXTTIME_DATA}/secrets/llm-provider-keys/<NAME>`，`<NAME>` = provider 的 `api_key_env` | `/run/secrets/llm-provider-keys/<NAME>`（`LLM_PROVIDER_KEYS_DIR`） | `llm-proxy`，uid 10001 / gid 10001，**启动时**读 |
| RAGFlow API key | `${NEXTTIME_DATA}/secrets/gatekeeper-ragflow/api_key` | `/run/secrets/gatekeeper-ragflow/api_key`（`GATE_CREDENTIAL_RAGFLOW_API_KEY_FILE`） | `gatekeeper-ragflow`，uid 10001 / gid 10001，**每次调用**读 |

**升级不会断**：目录不存在时 Docker 建一个空目录，服务照常起；没有文件的 key 退回读 `secrets/llm-proxy.env` /
`secrets/gatekeeper-ragflow.env` 里的原变量，并打一行弃用告警（`provider key read from the environment` /
`credential GATE_CREDENTIAL_RAGFLOW_API_KEY read from the environment`，只有变量名，从不打印值）。迁移步骤（在主机上，
不要把 key 打到终端）：

1. 照常应用发布（§3）。
2. 建目录并定权限：`sudo NEXTTIME_DATA="$NEXTTIME_DATA" sh scripts/host-env-init.sh`（幂等；它也把两个目录下已有
   文件改成 0640、组 10001——服务以 uid/gid 10001 运行，读不了的文件会被跳过并在日志里报 `could not be read`）。
3. 每个 provider key 搬一个文件（`NAME` 逐个取 `config/llm-providers.yaml` 与控制台里各 provider 的
   `api_key_env`；env 文件里的值若带引号，文件里不要引号）：

   ```bash
   NAME=EXAMPLE_API_KEY
   sudo sh -c "umask 027; sed -n 's/^$NAME=//p' '$NEXTTIME_DATA/secrets/llm-proxy.env' | tr -d '\n' > '$NEXTTIME_DATA/secrets/llm-provider-keys/$NAME'"
   ```

   RAGFlow 同理：`GATE_CREDENTIAL_RAGFLOW_API_KEY` 的值 → `secrets/gatekeeper-ragflow/api_key`。
4. 再跑一次第 2 步修正新文件的权限，然后从两个 env 文件里删掉已搬走的变量，
   `docker compose up -d --force-recreate llm-proxy gatekeeper-ragflow`。
5. 验证：`docker compose logs llm-proxy gatekeeper-ragflow | grep -E 'read from the environment|could not be read'`
   为空；`docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' <容器> | cut -d= -f1` 只列变量名，
   其中不再有 key；走一轮对话 / 一次 RAGFlow 调用。记结果到 `docs/private/`。

`scripts/validate-compose.mjs` 现在拒绝在 `docker-compose.yml` 的任何服务 `environment` 里出现
`GATE_CREDENTIAL_*` / `*_API_KEY`（`*_FILE` 除外），并要求上面两项文件接线；操作员自己的 env 文件不在它的检查范围内，
靠第 5 步的日志确认。

**回滚**：上一版只读 env——在确认新版本工作前先别删 env 文件里的变量；若已删、又要回滚，按 key 文件的内容把变量
写回 env 文件再 `--force-recreate`。无 schema 变化。

**不在本次范围**：worker / 入口容器的 `CAPABILITY_HANDLE` 仍以容器 env 传入（短时、按 scope 收窄的 Handle，
不是 provider key），见 R-24 的后续项。——已由 #524 完成（v0.44.0 之后的下一版）：Handle 不再进入容器，见 §3.17。

### 3.7 本体类型名在工作区内唯一（I-P1，S10 P0，core 0041）

**变化**：一个工作区里，ObjectType 名与 ActionType 名各自只能属于一个已发布的本体族（LinkType 仍可同名、签名累加）。
`publish_ontology_version`、`install_module` / `upgrade_module` 与种子 / 领域包发布在发布前检查，撞名时拒绝
（409 `ontology_namespace_conflict`，什么都不写），不再让按族 id 排序靠后的族静默覆盖另一个族的同名类型。
core 0041 同时删掉 0035 给工作区事务留的 `ontology_enforcement` 兼容放行（产品路径从没用过）。

**升级前只读预检**：已有的撞名不会被这次升级改动，但撞名的两个族此后都发不出新版本，所以先确认没有——在主机上：

```bash
docker compose exec -T postgres psql -U nexttime -d nexttime -c "
begin transaction read only;
with heads as (
  select t.workspace_id, t.id, t.definition
    from ontology_versions t
   where t.status = 'published'
     and t.version = (select max(t2.version) from ontology_versions t2
                       where t2.workspace_id = t.workspace_id and t2.id = t.id
                         and t2.status = 'published')),
names as (
  select workspace_id, id, 'object' as kind, e->>'name' as name
    from heads, jsonb_array_elements(definition->'objectTypes') e
  union all
  select workspace_id, id, 'action', e->>'name'
    from heads, jsonb_array_elements(coalesce(definition->'actionTypes', '[]'::jsonb)) e)
select workspace_id, kind, name, array_agg(id order by id) as families
  from names group by workspace_id, kind, name having count(*) > 1
 order by workspace_id, kind, name;
rollback;" </dev/null
```

（`</dev/null`：经 ssh 在脚本里跑时，不让 `docker compose exec` 吞掉后续命令的标准输入；本机直接跑无影响。）

结果记 `docs/private/`；空表 = 没有要处理的。不为空时先别应用，把结果带回来单独评审迁移方案（把其中一个族的
类型改名为新版本，旧版本保留可读——S10 方案 §8）。

### 3.8 一个 Gatekeeper 只关联一个平台门实例（L4-13，S10 K4，core 0042）

**变化**：`workspace_gate_links` 的 `(workspace_id, gatekeeper_object_id)` 改为唯一索引。同一个端点换了
GATE_ID 重新部署后，`preview_gate_instance_enable` / `enable_gate_instance` 会拒绝把已关联的 Gatekeeper
再关联一次（409 `gatekeeper_already_linked`，什么都不写），不再留下两条关联让信任级别与停用 Operation 列表
取决于哪一行先读到。同一迁移把四个 `security definer` 函数绑定到事务自己的工作区（L4-11 余项），并收回
`nexttime_app` 对 `workspace_gate_links` 的 DELETE（内核没有删关联的路径）。

**升级前只读预检**：已有的重复关联会让 0042 建唯一索引失败、整个迁移回滚，所以先确认没有——在主机上：

```bash
docker compose exec -T postgres psql -U nexttime -d nexttime -c "
begin transaction read only;
select workspace_id, gatekeeper_object_id, array_agg(gate_id order by enabled_at) as gate_ids
  from workspace_gate_links
 group by workspace_id, gatekeeper_object_id
having count(*) > 1
 order by workspace_id, gatekeeper_object_id;
rollback;" </dev/null
```

（`</dev/null` 同 §3.7。）

结果记 `docs/private/`；空表 = 可以直接应用。不为空时先别应用：每组留下当前在用的那个门实例的关联，其余的按
`docs/runbooks/add-gatekeeper.md` §11.1 层 1（登录角色上删 `workspace_gate_links` 一行）删掉，并把删了哪几行记进 `docs/private/`，再重跑预检到空。

### 3.9 新增 `update-feed` 服务（S10 U1，v0.43.0 起）

目录 `config/update-feed/`（10002:10002 0755）：按本节入口跑目标 tag 自己的 `apply-release.sh` 时，v0.43.0 起的脚本在切 tag 之前补建（`STEP update-feed-dir`），不需要额外步骤；直接跑检出里 v0.42.0 及更早的脚本则不会建它，要先手工补建（命令见 `operations.md` §16）；漏做只影响「版本信息」缺失，补建后 `docker compose restart update-feed`。第一次应用前确认 CI 已把 `channel.json` 发到滚动的 `channel` 预发布；应用后看 `docker compose logs --tail 20 update-feed` 有一次成功写入。四种状态的核对见 `docs/runbooks/operations.md` §16。

### 3.10 `config/egress-sources.json` 属主每次应用都校正（#491，v0.43.0 起）

v0.43.0 起的 `apply-release.sh` 在切 tag 之前把这个文件设成 `10001:10001 0644`（缺失则建成 `{}`，Docker 先建出的空目录会删掉，非空目录则 `FAIL egress-sources` 停下），应用日志多一行 `STEP egress-sources config/egress-sources.json is 10001:10001 0644`。改属主失败时只打 `STEP egress-sources WARNING could not set …`、不停下：看到这行要手工 `chown 10001:10001` + `chmod 644` 修好，否则 worker 写不进来源登记，出网会被 egress-proxy 当 unknown-source 拒绝。无 schema 变化。按 §3 的入口用目标 tag 的脚本副本时，第一次应用就生效；直接跑旧检出里的脚本不会做这一步（手工做法见 `docs/runbooks/host-worker-runtime.md` §4）。

### 3.11 控制台「测试」对当前 Claude 模型不再误报 tool_call 失败（#502，v0.43.0 起）

已知问题（v0.42.0 及之前）："添加 LLM 供应商"页的「测试」在 Anthropic Messages 供应商上强制 `tool_choice: {type:'tool'}`，当前 Claude 模型拒绝强制工具选择（HTTP 400），所以测试结果总是 `completion: ok`、`tool_call: error`。只影响测试按钮的显示：路由与 agent 调用不经过这个测试，照常工作。v0.43.0 起改为 `tool_choice: {type:'auto'}` 加提示词里的明确指令，无 schema 变化、无主机步骤。应用后可在控制台对已配置的 Anthropic 供应商点一次「测试」核对，两项都应是 ok（一次很短的真实调用）。STATUS 遗留 133。

### 3.12 供应商 Base URL 规则与 `tool_call` 探测重试（#510，v0.44.0 起）

上游 Base URL 只允许 http/https，不得带 userinfo、查询串或片段（`?` / `#` 能改写代理拼出的请求路径，userinfo 会在 URL 里夹带凭据）。控制台新建、修改供应商和拉取模型列表时，违规的地址返回 400。v0.43.0 及之前已经存进库里的违规行照常加载，但不路由、不测试（`/test` 返回 409 `upstream_base_url_invalid`）、不写进 models.json。llm-proxy 启动时为每一行打一条 warn：`provider "<id>" is not routed — its upstream base URL …; edit it in the console`。应用后看一次日志：`docker compose logs llm-proxy | grep 'is not routed'`。有输出就在控制台把对应供应商的 Base URL 改成源站（例如 `https://api.example.com`）。改之前，这个供应商的模型对 agent 不可用。`tool_call` 探测在 OpenAI 两种 API 上，遇到上游 400 / 422 会去掉 `tool_choice` 再试一次。这样 DeepSeek 思考模式下的「测试」不再误报（主机验收 4.7b），发版后在控制台对该供应商点一次「测试」核对。无 schema 变化。

### 3.13 出网禁止名单的 `.x` / `*.x` 条目开始生效（#515，v0.44.0 起）

行为变化：WorkerDefinition `egressDeny`、`DENY_HOSTS`、`EGRESS_DENY_HOST_SUFFIXES` 以及出网源映射的 `deny` 里，写成 `.x` 或 `*.x` 的条目以前什么都不拒绝（fail-open），现在等同于 `x`，拒绝 `x` 本身及其全部子域（`*.x` 也连 `x` 一起拒绝）。已发布的定义不需要重新发布就生效，某个 Worker 若曾依赖访问这类域名，应用后会收到 `403 source-deny`。allow 侧（`NEXTTIME_CONNECTION_ALLOW_HOSTS`、源映射 `allow`）保持严格：永远匹配不上的条目在启动或加载时打一条 error 日志并被忽略，不会导致启动失败，行为与修复前一样（从未放行过）。发布含 IP、URL、端口、CIDR 或通配符条目的新定义版本会被拒绝。

**维护窗口前**（与 `--prefetch` 同时，在当前版本上跑）做下面三项只读核对。目的是在新行为生效之前看清哪些条目会开始拒绝，需要时先和主人确认，而不是应用后才发现。三项都不依赖新版本代码：A 只读库，B 只读 `.env` 原文，C 在当前运行的 egress-proxy 容器里跑一段自带逻辑的脚本，只读环境变量和挂载的映射文件。都在主机检出目录下执行，经 SSH 时把 heredoc 通过管道交给 ssh。结果记 `docs/private/`。

**A. 数据库：已保存的 WorkerDefinition 里受影响的 `egressDeny` 条目**

```sh
docker compose exec -T postgres psql -U nexttime -d nexttime -v ON_ERROR_STOP=1 <<'SQL'
begin transaction read only;
select d.workspace_id, d.id as definition_id, d.version, d.kind, d.status, e.entry,
       case
         when lower(btrim(e.entry)) ~ '^(\*\.|\.)[a-z0-9_-]+(\.[a-z0-9_-]+)*\.?$'
           then 'leading-dot-or-wildcard: denied nothing until now; denies the bare name + subdomains after this release'
         when lower(btrim(e.entry)) ~ '^[0-9]+(\.[0-9]+){0,3}$'
           then 'ipv4-literal: matches only that exact literal; a new version with it is now refused'
         when lower(btrim(e.entry)) ~ '^[0-9a-f:.]+$' and e.entry like '%:%'
           then 'ipv6-literal: matches only that exact spelling; a new version with it is now refused'
         else 'unmatchable: still denies nothing; a new version with it is now refused - fix by hand'
       end as finding
from worker_definitions d
cross join lateral jsonb_array_elements_text(
  case when jsonb_typeof(d.definition -> 'egressDeny') = 'array'
       then d.definition -> 'egressDeny' else '[]'::jsonb end
) as e(entry)
where lower(btrim(e.entry)) !~ '^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.?$'
   or lower(btrim(e.entry)) ~ '^[0-9]+(\.[0-9]+){0,3}$'
order by d.status, d.workspace_id, d.id, d.version;
rollback;
SQL
```

0 行即干净。`status = 'published'` 且归为 `leading-dot-or-wildcard` 的行，应用后开始拒绝，要和定义的主人确认这是预期的；不是预期的，先在控制台发布去掉该条目的新版本再进窗口。

**B. 内核 allow-hosts（信息性）**

```sh
sed -n 's/^NEXTTIME_CONNECTION_ALLOW_HOSTS=//p' .env | tr ',' '\n' \
  | sed 's/^[[:space:]"]*//;s/[[:space:]"]*$//' \
  | grep -vE '^$|^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*\.?$|^[0-9a-fA-F:.]+$' \
  || echo "NEXTTIME_CONNECTION_ALLOW_HOSTS: ok"
```

读 `.env` 原文，不读运行中容器创建时的环境变量。列出的条目修复前就不生效，应用后内核在日志里点名并忽略，行为不变。改成裸名才会生效，那是放行，需要主人确认，不在本次升级里顺手改。

**C. egress-proxy：环境变量里的 deny 列表和 `SOURCE_MAP_FILE`**

```sh
docker compose exec -T egress-proxy node - <<'JS'
const ok = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;
const ip = (s) => /^[0-9.]+$/.test(s) || (s.includes(':') && /^[0-9a-f:.]+$/.test(s));
const norm = (s) => s.trim().toLowerCase().replace(/\.$/, '');
const lead = (s) => /^(\*\.|\.)/.test(norm(s));
const bare = (s) => norm(s).replace(/^(\*\.|\.)/, ''); // one prefix, like normalizeDenyHostPattern
const split = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const out = [];
const deny = (where, e) => {
  if (lead(e) && ok.test(bare(e))) out.push(`${where} deny "${e}": leading . / *. - denied nothing until now; after this release it denies "${bare(e)}" and its subdomains`);
  else if (!ok.test(bare(e)) && !ip(bare(e))) out.push(`${where} deny "${e}": can never match - fix by hand`);
};
for (const k of ['DENY_HOSTS', 'EGRESS_DENY_HOST_SUFFIXES']) for (const e of split(process.env[k])) deny(k, e);
const file = process.env.SOURCE_MAP_FILE;
const map = file ? JSON.parse(require('fs').readFileSync(file, 'utf8')) : {};
for (const s of Object.values(map)) {
  for (const e of s.allow || []) if (!ok.test(norm(e)) && !ip(norm(e))) out.push(`source ${s.sourceId} allow "${e}": never matches (stays fail-closed) - fix by hand`);
  for (const e of s.deny || []) deny(`source ${s.sourceId}`, e);
}
console.log(out.length ? out.join('\n') : 'egress-proxy: no affected entries');
JS
```

输出只有 sourceId（`entry:` / `worker:` 加工作区、主体或 run id），不打印客户端 IP。`leading . / *.` 行就是应用后开始拒绝的条目，处理方式同 A。

C 读到的环境变量是容器创建时的值；应用会按 `.env` 重建容器，所以再看一眼 `.env` 原文（compose 只把 `EGRESS_DENY_HOST_SUFFIXES` 传给 egress-proxy），判断方式同 C 的 deny 规则：

```sh
sed -n 's/^EGRESS_DENY_HOST_SUFFIXES=//p' .env
```

源映射是 C 运行那一刻的快照，随 Worker 起停变化；已发布定义里哪些条目会开始拒绝，以 A 为准。

**应用后**（窗口内，S1–S4 之后）只看日志确认与窗口前的结论一致，不需要再跑 A–C：

```sh
docker compose logs kernel | grep 'outbound-target: NEXTTIME_CONNECTION_'
docker compose logs egress-proxy | grep 'can never match a host'
```

两条都没有输出最常见；有输出时，条目应与 B、C 列出的一致。

### 3.14 新能力 `list_facts`；已签发的 Handle 不会自动获得（#514，v0.44.0 起）

graph 组新增只读能力 `list_facts`（按链接类型列出工作区的活跃 Fact），`get_entry_context` 多返回 `factCountsByLinkType`。入口 agent 的注入上下文改为先给图概览、再给最近 Fact 样本。入口 Handle 在应用后重启时按新的能力上限重新签发，不需要操作。用户在控制台自助签发的 MCP / Claude Code / pi interactive Handle 的 scope 是签发那一刻的能力清单，调 `list_facts` 会返回 `forbidden`，需要重新签发（`howto-connect-pi.md` 排障表）。已有工作区的入口 systemPrompt 不会随模板更新，关键指引放在了注入上下文与工具描述里。无迁移。主机验收 S5.7 dependency_chat 按至少 8/10 判定。

### 3.15 agent-host 与 kernel 须同版本；agent 输出脱敏与发版后 Handle 核对（#520，v0.44.0 起）

无迁移、无新的应用步骤。按 §3 入口整版应用即可，**agent-host 与 kernel 必须是同一版本**：新 agent-host 配旧内核时，旧内核会丢弃带 `name` 的工具结束帧，实时界面上那次调用一直显示"运行中"直到 Turn 结束；旧 agent-host 配新内核无害。gatekeeper-base 的路径模板正则有改动，门镜像随版本重建即可。

行为变化：
- 入口 Turn 的每个工具调用结束时，聊天历史里多一条 `role='tool'`、`kind: 'tool_call'` 的消息，刷新后仍可见，可见性与所在 Chat 相同；控制台的工具行渲染与本版同发。
- 实时文本、工具调用、落库回复、Handle 通道调用的审计参数、Worker 报告里形似密钥的值显示为 `[redacted]`。实时文本会扣住末尾一个词，未完成的名值对和未闭合的引号值扣到值结束；4096 字符以上不断开的一段（压缩 JS、长 base64）实时只显示一个 `[redacted]`，Turn 结束后落库的回复照常显示。这是纵深防御：编码后的外带挡不住（STATUS 遗留 156）。
- 新的只读能力 `graph_overview`。与 §3.14 一样，控制台自助签发的 Handle 要重新签发才能调用；入口 Handle 重启后自动按新上限签发。

**应用后**（窗口内，S1–S4 之后）三项核对，结果记 `docs/private/`。

**A. Handle 历史命中**：v0.43.0 及之前，agent 写出的内容都没有脱敏，可能含 Handle；#520 之后，Worker 提议与其他 `propose_*` / `request_action` 写入的内容仍原样保留（遗留 157）。所以除了聊天、审计、Task、Fact / evidence / decisions，还要扫 agent 能写入、以后还会被使用的位置：Skill 正文（发布后注入以后的 agent 上下文）、Procedure 步骤、ActionRequest 参数（批准后发往目标系统）、observations、待注入的上下文条目。这条正则匹配**所有** Handle，不只是入口 Handle：控制台自助签发的最长 30 天，服务 Handle 最长 365 天。所以不能看行的时间，要按每个 Handle 自己的 `jti` 查它是否仍有效、未吊销。在主机检出目录下执行；经 SSH 时与 §3.13 一样，把 heredoc 通过管道交给 ssh（不要加 `</dev/null`，stdin 就是 SQL）。输出只有计数和最晚过期时间，不打印 Handle 或 `jti`：

```sh
docker compose exec -T postgres psql -U nexttime -d nexttime -v ON_ERROR_STOP=1 <<'SQL'
begin transaction read only;
with p as (select 'eyJhbGciOiJFZERTQSJ9\.([A-Za-z0-9_-]{6,})\.[A-Za-z0-9_-]{6,}'::text as re),
src(location, t) as (
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
), seg as (
  select src.location, (regexp_matches(src.t, p.re, 'g'))[1] as s from src, p
), jtis as (
  select distinct location,
         substring(encode(decode(rpad(translate(s, '-_', '+/'), (length(s) + 3) / 4 * 4, '='), 'base64'), 'escape')
                   from '"jti":"([0-9a-f-]{36})"') as jti
  from seg where length(s) % 4 <> 1
)
select j.location,
       count(*) as distinct_handles,
       count(*) filter (where h.jti is not null and h.revoked_at is null and h.expires_at > now()) as live_unrevoked,
       count(*) filter (where h.jti is null) as not_found,
       max(h.expires_at) filter (where h.revoked_at is null) as latest_expiry
from jtis j left join capability_handles h on h.jti::text = j.jti
where j.jti is not null
group by j.location
order by j.location;
rollback;
SQL
```

`eyJhbGciOiJFZERTQSJ9` 是 Handle 的头部 `{"alg":"EdDSA"}`，只匹配 Handle。0 行，或每行 `live_unrevoked = 0`，即无事。中间段解不出 `jti` 的（截断、损坏）直接跳过，不会让事务中止。有 `live_unrevoked > 0` 时，找维护者决定是否吊销：按 `jti` 吊销（`capability_handles.revoked_at`，每次调用都检查）是改主机数据的操作，须维护者明确同意，本手册不自动做。历史行是否清洗另行决定（审计只追加）。

**B. 工具调用留在历史里**（**victor 手动**）：使用 → 对话，新建一个对话，问一个需要查图的问题（例如「图谱里有哪些系统？」），等回复结束后刷新页面，回复上方能看到「调用了 N 个工具」组（#523），展开后每行有工具名、结果（完成 / 失败 / 未完成）、起止时间与参数和结果预览。

**C. 输出里的 Handle 被替换**（**victor 手动**，使用 → 对话）：不要让 agent 运行 `env`：工具结果会原样回到模型上下文，经 llm-proxy 发给上游模型供应商，等于把真实的入口 Handle 送出主机。改用合成值验证同一条脱敏路径：让 agent 运行 `echo "CAPABILITY_HANDLE=eyJhbGciOiJub25lIn0.c3ludGhldGlj.bm90LWEtcmVhbC1zaWc"`。它同时命中 `NAME=value` 与 JWT 两类模式，头部是 `{"alg":"none"}`，不会被 A 计入。实时流、刷新后的历史、审计页（治理 → 审计，打开「显示读操作」）里都应显示为 `[redacted]`。

### 3.16 llm-proxy 管理接口限流与密钥检查（#521，v0.44.0 起）

无迁移、无新步骤。行为变化：
- 控制台的拉模型列表、逐模型探测、「测试」按管理员限流（同时 2 个、排队 4 个、每分钟 60 次上游调用），超出时控制台提示暂停几秒，属预期。
- 含 HTTP header 不能承载的字符（全角空格、中间空格、换行）的供应商密钥，以前让该供应商的每次模型调用 500，现在返回 502 `upstream_key_invalid`，控制台卡片提示「密钥含非法字符，请重新填写」。密钥首尾空白会被去掉，CRLF 结尾的 env 或密钥文件照常可用。

应用后看一次日志：`docker compose logs llm-proxy | grep 'cannot carry'`。有输出就在控制台重新填写对应供应商的密钥（或修好密钥文件 / 环境变量），改之前这个供应商的模型对 agent 不可用。日志只有供应商 id 与来源，不含密钥值。

### 3.17 Handle 移出 agent 容器：窗口前排空 Worker（#524，governance 0018，v0.44.0 之后的下一版起）

入口 agent 与 WorkerRun 的 Handle 不再以 `CAPABILITY_HANDLE` 放进容器 env（容器里只剩标记 `source-bound`）。worker-supervisor
把「容器在 `workers` 网络的地址 → Handle」写进新的 tmpfs 卷 `handle-bindings`，kernel 与 llm-proxy 对 `workers` 来源只认绑在
对端地址上的 Handle，请求自带凭证即 401，`workers` 平面以外的路由 403（设计文档 I19，`host-worker-runtime.md`）。

**窗口前（必须）**：
1. **排空 Worker**：判据只有一条，`docker ps --filter label=nexttime.role=worker` 为空（经 SSH 用 `ssh -n`）。
   控制台任务列表只作参考：§3.22 Q4 命中的 Task 永远显示"进行中"、名下却没有容器，先按 §3.22 处置，不要等它们消失；
   Q3 命中且容器还活着的，也要先按 §3.22 处置，否则 `docker ps` 清不空。进行中的 WorkerRun 会失败：governance 0018 吊销它的 Handle，新的
   supervisor 也不会为旧容器建绑定。入口容器不用管，下一个 Turn 会自动重签并重建。`apply-release.sh` 目前不替你检查这一步（遗留 170）。
   排空之后到窗口结束之前不要新发起 Worker；`queued` 的 Task 在应用后由新代码起容器，不受影响。
2. 照常 `--prefetch` 目标 tag 并确认 `RESULT ok`（§3）。

**应用时会发生什么**：
- governance `0018_container_held_handles_revoked`：吊销所有未过期、未吊销的 `entry` / `worker_run` Handle（即上一版放进容器
  env 的那些），每个 (工作区, 主体) 写一条审计 `principal.container_handles_revoked`，payload 带 `revokedHandleCount`。
  llm-proxy 经吊销同步跟上。只改数据，可逆（§6）。
- compose 新建卷 `handle-bindings`（目录 `0700 10001:10001`）；kernel、llm-proxy、worker-supervisor 随版本重建（`up` 本来就会）。
  滚动重建的几秒里旧 llm-proxy 遇到带 `hld` 的新 token 会 401，属窗口内。
- worker-runtime 镜像的自检多一行 `check=handle_binding`，入口容器与 WorkerRun 容器都跑（`NEXTTIME_MODE` 为 `entry` 或
  `worker`）：在启动 pi 之前反复问内核 `GET /api/source-binding`，绑定指向本容器才继续，20 秒内等不到就退出
  （`address_not_bound` / `address_bound_to_another_container` / `hostname_not_a_container_id`）。**这是 fail closed**：
  绑定没建好时 agent 起不来，而不是带着别的凭证跑。

**应用后核对**：
- S1 多三步：`env-no-handle`（容器里读不到任何 JWT，扫全部进程环境）、`env-workers-plane`、`env-source-binding`（逐容器核对
  地址不同、绑定指向该容器、从容器里问内核得到该容器 id、入口自检 `check=handle_binding result=ok`）；`env-capability-handle`
  的文字变了。`apply-release.sh` 在一次运行里按 S3 → S1 → S2 → S4 跑完全部验收，失败只计数、不会停下，所以要在 apply 日志里
  确认这三步都是 PASS：任何一步 FAIL 都视为来源绑定没有生效，按 §5 判断是否回滚，不能只看 `RESULT` 的失败计数。
- 0018 只在执行那一刻存在未过期、未吊销的容器 Handle 时才写审计行 `principal.container_handles_revoked`（例如 24 h 内没有
  Turn、也没有 Worker，就是 0 行，不代表失败）。所以用下面的只读 SQL 核对：新 kernel 启动之前签发、至今仍有效的容器 Handle
  应为 0。截点是**新 kernel 容器的启动时间**，不是 apply 日志的开始时间：`apply-release.sh` 在 `STEP migrate ok` 之后、
  `up` 之前，旧栈还在跑，旧内核这段时间仍可能签出放进容器 env 的旧式 Handle，0018 吊销不到它们，按日志开始时间截会漏掉。
  先取截点：

  ```sh
  docker inspect -f '{{.State.StartedAt}}' $(docker compose ps -q kernel) </dev/null
  ```

  把输出（UTC，形如 `2026-10-10T01:23:45.678901234Z`）填进下面的 `<kernel 启动时间>`：

  ```sh
  docker compose exec -T postgres psql -U nexttime -d nexttime -v ON_ERROR_STOP=1 <<'SQL'
  begin transaction read only;
  select count(*) from capability_handles h
    join sessions s on s.workspace_id = h.workspace_id and s.id = h.session_id
   where s.kind in ('entry','worker_run') and h.revoked_at is null
     and h.expires_at > now() and h.created_at < '<kernel 启动时间>'::timestamptz;
  rollback;
  SQL
  ```

  结果大于 0 时按遗留 167 处理：经维护者同意，手工再跑一次 0018 的 `update`（主机写操作）。
- 用 §3.15 A 的只读 SQL 再数一次历史 Handle 命中：容器 Handle 副本此时应已全部吊销，剩下的 `live_unrevoked` 是用户粘贴进去的
  bearer Handle（遗留 157），结果记 `docs/private/`。

**回滚**：回滚前同样按第 1 步排空 Worker：新版本起的 WorkerRun 容器里只有 `source-bound` 标记，旧 kernel / llm-proxy 不认，
这些 run 会失败。旧代码不读绑定文件；旧 kernel / llm-proxy 的严格 claims schema 拒绝带 `hld` 的 token，入口 agent 会从旧内核拿到新
Handle。fail closed，不丢数据；0018 的吊销不随回滚恢复，也不需要。卷可以留着。回滚后再升级的窗口见遗留 167。

### 3.18 含疑似凭据的内容生效前须二次确认（#526，v0.44.0 之后的下一版起）

无迁移、无部署变化。行为变化：`approve`（含「总是允许」）与 `publish_skill` / `publish_procedure` / `publish_operation` /
`publish_worker_definition` 在要生效的内容含 N > 0 处疑似凭据时，须勾「已核对凭据」（调用带 `credentialsReviewed: true`），
否则内核返回 400 `credentials_review_required`；含疑似凭据的参数不再被自动批准或「总是允许」放行。控制台的对话审批卡遇到
这种请求只给「去审批页核对」与拒绝。用脚本或 CLI 批准 / 发布含凭据内容的调用方要显式带这个字段。

**应用后核对**（**victor 手动**；只用合成值，不要用真实凭据或真实 Handle）：
- 造一个审批请求：需要一个要审批的 Operation（`mode` 为 act、不自动批准的任意一个；治理 → 能力目录里能看到）。使用 → 对话，
  让 agent 对它发起 `request_action`，参数里放 `{"password": "abcdefghijklmnopqrstuvwxyz0123"}`（合成值放在 `password` 字段里，
  按字段名计数；若把 `password=abc…` 整串放进别的字段，比如 `cmd`，路径显示的是 `cmd`）。
- (a) 对话里的审批卡只有「去审批页核对」和拒绝，不能直接批准。使用 → 待我审批，打开这一条：显示「含 1 处疑似凭据」和字段
  `password`，「批准」不可用并提示「先勾选「已核对凭据」」；勾选后「批准」可用。
- (b) 批准后，治理 → 审计里这次批准的审计行带 `credentialReview`（`suspectedSecretValues: 1`、`confirmed: true`）。批准会让
  Operation 真的执行，所以挑一个对目标系统无害的 Operation；不想执行就在 (a) 看完后点拒绝，(b) 留到下一次真实审批时核对。

结果记 `docs/private/`。

### 3.19 第三方镜像改从 GHCR 副本拉取（#531，v0.44.0 之后的下一版起）

无迁移。`docker-compose.yml` 的第三方服务（pgvector、postgres、docker-socket-proxy、alpine、curl）和各 Dockerfile 的
基础镜像与 `# syntax=` 前端，改为按 digest 引用 `ghcr.io/btnalit/nexttime-mirror-*`（清单 `deploy/image-mirrors.json`）。
digest 与上一版完全相同，镜像内容不变，只换来源。

- **预取**：§3.13 的 `--prefetch` 改从 GHCR 拉这些副本；digest 与本机已有的相同时层直接复用，只取 manifest；主机本来就从 GHCR 拉应用镜像，不需要新出口。
  fixture 的前端引用从该 tag 自己的 Dockerfile 第 1 行读出，不再写死。
- **应用**：镜像引用字符串变了，`up -d` 会按新配置重建 postgres 与四个 socket-proxy 容器（同一镜像，数据卷不动，
  postgres 停几秒，`apply-release.sh` 在 `up` 之前已做 dump）。属预期，不是故障。
- **回滚到 v0.44.0 及更早**：旧 tag 的 compose 仍引用 Docker Hub。本机已有的镜像按 digest 直接复用，缺的才从 Docker Hub
  拉（主机自己的匿名配额，429 只发生在共享出口的 CI runner 上）。
  - 引用字符串又变回去，`up -d` 会**再次**重建 postgres 与四个 socket-proxy 容器（同一镜像，数据卷不动），同上属预期。
  - 旧版 `restore.sh` 的 dry-run 用的是不带 digest 的 `postgres:17-alpine`，本机没有这个 tag 时会去 Docker Hub 拉浮动 tag。
    回滚后要跑旧版恢复演练的，先用 GHCR 副本把这个 tag 补上（`docker run` 遇到本地已有的 tag 不会再拉）：
    `docker pull ghcr.io/btnalit/nexttime-mirror-postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73`，
    再 `docker tag ghcr.io/btnalit/nexttime-mirror-postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73 postgres:17-alpine`。
- **不要删 `nexttime-mirror-*` 包的旧版本**（包括升级钉值后变成无 tag 的版本）：已发布版本的 Dockerfile / compose 按 digest
  引用它们，删了就无法重建或回滚到那一版。仓库里没有任何删除包版本的工作流，`prune-images.sh` 只清主机本地的
  `nexttime-ai-*`；GHCR 不会自动清理容器包版本。在 GitHub 包设置里手动清理时跳过这些包。

### 3.20 observe 参数凭据审查与门侧结构守卫（#532，v0.44.0 之后的下一版起）

无迁移、无部署变化。行为变化：
- `observe_operation` 与 `request_action` 的 observe 分支对参数做凭据审查。只有高置信的字面凭据会被拒（400
  `credentials_in_observe_params`）：PEM、JWT、厂商前缀密钥、字面 `Bearer` / `Authorization: token`、能解码成 `user:password`
  的 `Basic`、URL 里的字面密码；`$VAR` / `${VAR}` 占位符放行。其余可疑值放行，审计行带
  `credentialReview {suspectedSecretValues, suspectedSecretPaths}`。
- 审计里的参数副本在 Handle、人、平台三个通道都按 #526 的同一规则脱敏（字段名规则 + 值模式）。
- `http` 门拒绝任何落到门自己拥有的 header、凭据 query 参数、cookie 或 binding 固定 query（不分大小写）上的参数（403
  `operation_refused`），分页游标按参数名豁免；`importOpenApi` 不再声明这类参数；MCP transport 不再跟随重定向。

**维护窗口前**（与 `--prefetch` 同时，在当前版本上跑，只读，主机执行；经 SSH 按 §3 开头的方式把 heredoc 交给 ssh）：
列出线上 Operation 声明的、可能落到门侧守卫上的参数。门侧守卫对没写 `x-in` 的参数也检查：GET / HEAD 的这类参数默认进 query
（`toQuery` → `isGateOwnedQueryParam`），手写 manifest 通常不写 `x-in`；与 binding 路径里固定 query 同名的参数也会被拒。
所以下面的查询把这两类都列出来，并输出 `binding_path` 供对照固定 query。结果记 `docs/private/`。

```sh
docker compose exec -T postgres psql -U nexttime -d nexttime -v ON_ERROR_STOP=1 <<'SQL'
begin transaction read only;
-- 门公告的 manifest（gate_instances 有 read_all 策略）
select gi.gate_id, op->>'name' as op, upper(op->'binding'->>'method') as method,
       op->'binding'->>'path' as binding_path,
       p.key as param, coalesce(p.value->>'x-in', '(GET/HEAD 默认 query)') as loc
from gate_instances gi,
     jsonb_array_elements(gi.operations) op,
     jsonb_each(coalesce(op->'params_schema'->'properties','{}'::jsonb)) p
where p.value->>'x-in' in ('header','query','cookie')
   or (p.value->>'x-in' is null and upper(op->'binding'->>'method') in ('GET','HEAD'))
order by 1, 2, 5;
-- 工作区里 draft / published 的 Operation（含 create_connection 注册的外部门与手写 manifest）
select o.workspace_id, o.identity_key->>'gatekeeperId' as gatekeeper, o.identity_key->>'name' as op,
       o.properties->>'status' as status, upper(o.properties->'binding'->>'method') as method,
       o.properties->'binding'->>'path' as binding_path,
       p.key as param, coalesce(p.value->>'x-in', '(GET/HEAD 默认 query)') as loc
from objects o,
     jsonb_each(coalesce(o.properties->'params_schema'->'properties','{}'::jsonb)) p
where o.object_type = 'Operation'
  and o.properties->>'status' in ('draft','published')
  and (p.value->>'x-in' in ('header','query','cookie')
       or (p.value->>'x-in' is null and upper(o.properties->'binding'->>'method') in ('GET','HEAD')))
order by 1, 2, 3, 7;
rollback;
SQL
```

判读（结果是候选，不是命中）：
- 逐行按 `isGateOwnedHeader` / `isGateOwnedQueryParam`（`packages/gatekeeper-base`）核对参数名：`Authorization`、`Cookie`、
  `X-Api-Key` 这类头，`access_token` / `api_key` / `token` 这类凭据 query 名会被拒；`x-in` 为 `cookie` 的一律会被拒；
  名字与 `binding_path` 里 `?` 之后某个固定 query 同名（不分大小写）的也会被拒。分页游标（如 `pageToken`）按参数名豁免。
  其余普通业务参数（`q`、`limit`、`id` 等）不受影响。
- 门凭据里配置的注入 header 名在库里看不到（只在门的凭据文件里），所以"与门凭据注入的 header 同名"这一类本查询查不出；
  对有命中的门，在 平台 → 集成 → 该门 的凭据里看一眼 `headers` 的名字。
- 核对后没有会被拒的参数，就不需要任何动作。有的话，应用后这些调用会返回 403 `operation_refused`，处置见下。

有会被拒的参数时（**victor 手动**，应用后）：
- 门重新公告的 manifest 不再声明这类参数，平台 → 集成 → 该门 会出现「这个门 announce 了与生效清单不同的 Operation」，点「审阅并采用」
  → 「采用」；然后各工作区在 治理 → 系统与授权 → 该系统卡片 点「与门公告对齐」→「对齐」。
- 原来由调用方传的租户、组织头，要从参数挪到门凭据的 `headers` 里（平台 → 集成 → 该门 → 凭据）。
- 手写 manifest 声明的这类参数，在 治理 → 系统与授权 发布去掉该参数的新版本。

**应用后核对**（**victor 手动**；只用合成值，不要用真实 Handle 或 key）。四项都在 使用 → 对话 里让 agent 调一个 observe 工具
（任一已启用门的观察类 Operation），再到 治理 → 审计 打开「显示读操作」，在「动作」里填 `observe_operation` 看审计行：
- (a) 让 agent 把参数值写成 `Bearer abcdefghij0123456789` 调用：工具结果是 400 `credentials_in_observe_params`，在对话的工具行里
  能看到。审计流里这一时刻的 `observe_operation` 若有记录，结果是被拒而不是成功；拒绝发生在内核把请求交给门之前，所以不会有
  这次调用的观察结果。
- (b) 让 agent 用 `{app="x"} |= "Authorization: failed"` 这类查询文本调用：放行，审计行带 `credentialReview`，参数副本里是
  `Authorization: [redacted]`。
- (c) 带一个 `pageToken` 参数调用（值用合成串）：审计行带 `credentialReview`，`params.params.pageToken` 为 `[redacted]`。
- (d) 在 治理 → 系统与授权 重新导入一个 OpenAPI 门：它的工具列表里没有 `Authorization` 这类头参数。若窗口前的查询找到过手写
  manifest 声明这类参数，让 agent 用合成值调一次那个 Operation，返回 403 `operation_refused`。

### 3.21 模型供应商健康状态文件 `provider-health.json`（#530，v0.44.0 之后的下一版起）

无迁移、无 compose / env / 权限变化。llm-proxy 在它已拥有的 `models/` 目录里、`models.json` 旁边新写一个
`provider-health.json`（每个供应商只有状态与测试时间，不含密钥或上游错误原文），内核经已有的只读挂载读取，控制台所有模型选择处
据此显示「可用 / 未测试 / 测试失败 / 状态未知」。备份本来就包含 `models/`。

行为变化：概览的「可用模型」只计供应商测试通过的模型，第一次应用后在每个供应商测试通过之前会显示 0（或「状态未知」），属预期：
在控制台「模型与供应商」逐个点「测试」即可。

**应用后核对**：
- (a)（主机，只读）`provider-health.json` 存在于 `models.json` 同目录，属主 uid 10001、权限 0644，每个供应商只有 `status` /
  `testedAt`；llm-proxy 日志里没有 `provider-health.json not writable`：

  ```sh
  docker compose exec -T llm-proxy stat -c '%u %a %n' /data/models/provider-health.json </dev/null
  docker compose logs llm-proxy </dev/null | grep 'provider-health.json not writable'
  ```

  第一条应输出 `10001 644 /data/models/provider-health.json`，第二条没有输出。llm-proxy 启动时就写这个文件，逐个测试之后各供应商的 `status` 随之更新。
- 逐个测试（**victor 手动**）：平台 → 模型与供应商，对每个供应商点「测试调用」，结果都应是可用。
- (b)（**victor 手动**）上次测试被拒的供应商在供应商表里显示「密钥被拒」，它的模型在 使用 → 我的智能体 的模型选择和对话头部
  不可选，平台 → 概览 的「需要人处理」列出它。没有被拒的供应商就跳过。
- (c)（**victor 手动**）把 (b) 的供应商修好密钥后再点「测试调用」，通过后同样的模型无需重启内核即可在 我的智能体 里选择。

结果记 `docs/private/`。

### 3.22 崩溃重试与取消的状态修复：升级前统计受影响的 Task（#534，v0.44.0 之后的下一版起）

无迁移。行为变化：结束一个 WorkerRun 的那次调用才决定它的 Task；`cancel_task` 先把 Task 改成 `cancelled` 再回收它名下的 run
（审计里 `task.cancel` 现在排在 `worker_run.terminate` 之前）；spawn 读 Task 状态时加 `for share`。修复前，崩溃重试与 reaper
超时、或与取消并发时，可能出现：重试还在跑的 Task 被标成 failed、用户的取消变成 `failed: terminated`、已取消或已失败的 Task 下
留着一个持有效 Handle 的 run、认领重试后 Task 永久停在 `running`。

**维护窗口前**（在当前版本上跑，只读，主机执行；经 SSH 按 §3 开头的方式把 heredoc 交给 ssh，不要加 `</dev/null`）：统计历史上
受影响的 Task。结果是候选清单，逐条对照审计再判断。结果记 `docs/private/`。Q3、Q4 的处置要在 §3.17 排空之前做完。

```sh
docker compose exec -T postgres psql -U nexttime -d nexttime -v ON_ERROR_STOP=1 <<'SQL'
begin transaction read only;
-- Q1 Task 失败时它的崩溃重试还活着，或晚于 failed_at 才终止（reaper 超时的变体 failure_reason = 'timeout'）。
-- 正常的重试失败在同一事务里终止 run 并失败 Task（now() 相同），不会命中。
select t.workspace_id, t.id as task_id, t.failure_reason, t.failed_at,
       wr.id as worker_run_id, wr.status as run_status, wr.started_at, wr.terminated_at
from tasks t
join worker_runs wr on wr.workspace_id = t.workspace_id and wr.task_id = t.id
where t.status = 'failed'
  and t.retry_count = 1
  and t.failure_reason in ('worker_failed', 'timeout')
  and (wr.status <> 'terminated' or wr.terminated_at > t.failed_at)
order by t.failed_at desc;

-- Q2 认领了重试却没起来：迟到的反应先失败了 Task，重试的 spawn 因此被拒。
-- 相似情况：重试 spawn 在写入 run 行之前就失败了。逐条对照审计。
select t.workspace_id, t.id as task_id, t.failed_at
from tasks t
where t.status = 'failed' and t.retry_count = 1 and t.failure_reason = 'worker_failed'
  and (select count(*) from worker_runs wr
       where wr.workspace_id = t.workspace_id and wr.task_id = t.id) = 1
order by t.failed_at desc;

-- Q3 failed / cancelled 的 Task 下仍有未终止的 WorkerRun。
select t.workspace_id, t.id as task_id, t.status as task_status, t.failure_reason,
       coalesce(t.failed_at, t.cancelled_at) as ended_at,
       wr.id as worker_run_id, wr.status as run_status, wr.started_at
from worker_runs wr
join tasks t on t.workspace_id = wr.workspace_id and t.id = wr.task_id
where wr.status in ('provisioning', 'running', 'suspended')
  and t.status in ('failed', 'cancelled')
order by wr.started_at;

-- Q4 running 的 Task 名下没有活的 WorkerRun；忽略最近几分钟内更新过的行。
select t.workspace_id, t.id as task_id, t.retry_count, t.updated_at
from tasks t
where t.status = 'running'
  and not exists (select 1 from worker_runs wr
                  where wr.workspace_id = t.workspace_id and wr.task_id = t.id
                    and wr.status in ('provisioning', 'running', 'suspended'))
  and t.updated_at < now() - interval '10 minutes'
order by t.updated_at;
rollback;
SQL
```

处置：
- **Q3（终态 Task 下的活 run）**：先看容器是否还活着：对每个 `worker_run_id` 跑
  `docker ps --filter label=nexttime.worker-run-id=<worker_run_id> --format '{{.ID}} {{.Status}}' </dev/null`。
  - 没有输出：只是库里的行没收尾，governance 0018 会吊销它的 Handle，窗口过后不持有可用 Handle，不需要单独处理。
  - 有输出：它会让 §3.17 的排空判据清不空。等它跑到 WorkerDefinition 的时长上限被 reaper 收掉，或由 victor 决定后停掉容器
    （主机写操作，须 victor 明确同意）。升级前它就是终态 Task 下的有效 Handle，要尽快处理。
- **Q1 / Q2（历史结果）**：调用方当时看到的是 `failed`，重试提交的结果已被拒。不要自动修复（重跑会重复副作用），列给 Task 的
  owner 决定是否重新发起。
- **Q4（`running` 却没有活 run）**（**victor 手动**，排空之前做）：走受治理的取消路径，不要直接 UPDATE。逐条在 使用 → 任务 打开
  该 Task（按 `task_id`），点「取消任务」→「确认取消」，状态变成 `cancelled`。这些 Task 在控制台里永远显示"进行中"，不取消的话
  任务列表永远不会清空（§3.17 的排空只看 `docker ps`）。

### 3.23 升级窗口总清单：v0.44.0 → v0.46.0（v0.45.0 不单独上主机）

主机 2026-10-10 已在 v0.44.0，应用后核对全部做完（STATUS 时间线），所以不再连带 v0.44.0 的各小节。v0.45.0 不单独上主机，
下一次窗口直接升到 v0.46.0，一次跨过 §3.17–§3.22（v0.45.0）和 §3.24（v0.46.0）。迁移有两条，都只改数据或加可空列：
governance 0018（吊销容器 Handle）与 0019（`action_requests.operation_digest`）。如果最终升的是 v0.45.0，表里 §3.24 的步骤跳过。
先确认起点：主机检出与在跑的栈一致（§3 入口保证），`git describe --tags --exact-match </dev/null` 应输出 `v0.44.0`。

「谁」一列：主机 = 远程 CLI 会话在主机 shell 里执行；**victor 手动** = 要登录控制台（§3 开头）；victor 决定 = 主机写操作，
须维护者明确同意后才做。

| # | 时机 | 步骤 | 谁 |
|---|---|---|---|
| 1 | 窗口前 | `--prefetch v0.46.0`，日志最后一行 `RESULT ok`（§3） | 主机 |
| 2 | 窗口前 | 只读核对，结果记 `docs/private/`：§3.20 SQL（判读时加上 §3.24 补的门拥有头名单）、§3.22 Q1–Q4、§3.24 的 1、2 两条 SQL | 主机 |
| 3 | 窗口前 | §3.22 Q4 有命中：逐条在 使用 → 任务 取消 | **victor 手动** |
| 4 | 窗口前 | §3.22 Q3 有命中**且容器还活着**：等它到时长上限被收掉，或停掉容器 | victor 决定 |
| 5 | 窗口前 | 排空（§3.17）：`docker ps --filter label=nexttime.role=worker` 为空；此后到窗口结束不再发起 Worker | 主机；victor 不发起 |
| 6 | 窗口内 | `--pull v0.46.0`，`RESULT ok` 或 `RESULT acceptance-failures=<n>`；`up` 会重建 postgres 与四个 socket-proxy 容器，属预期（§3.19）；内核与全部打包门由同一次 `up` 升到同版本（§3.24） | 主机 |
| 7 | 应用后 | apply 日志里 S1 的 `env-no-handle`、`env-workers-plane`、`env-source-binding` 都是 PASS（§3.17），任何一步 FAIL 按 §5 判断回滚 | 主机 |
| 8 | 应用后 | §3.17 SQL（截点取新 kernel 的启动时间）、§3.15 A SQL、§3.21 (a) | 主机 |
| 9 | 应用后 | §3.21 逐个测试与 (b)(c)、§3.18、§3.20 (a)–(d) | **victor 手动** |
| 10 | 应用后 | §3.24 窗口后：每个 OpenAPI / MCP 平台门「审阅并采用」→ 各工作区「与门公告对齐」→ 逐条发布修订 → 抽查。做完之前，定义变了的 Operation 调用返回 409 `operation_definition_mismatch` | **victor 手动** |

第 3、4 步必须在第 5 步之前：Q4 的 Task 永远显示"进行中"，Q3 的活容器让 `docker ps` 清不空。第 2 步的 §3.20 结果有会被拒的
参数时，按 §3.20 的处置在应用后由 victor 手动处理，不阻塞窗口。第 10 步尽量在窗口内做完：没做完的平台门在这期间对受影响的
Operation 一律 409，不执行任何东西（fail closed）。

**回滚**（§5）：回滚目标是 v0.44.0。回滚前同样按第 5 步排空 Worker（§3.17 回滚段），其余按 §3.17、§3.19、§3.24 的回滚说明。

### 3.24 门只运行被批准的那份定义；发布时拒绝门拥有的参数（#538，governance 0019，v0.45.0 之后的下一版起）

行为与兼容：
- 内核每次 observe / simulate / apply 都带上批准的那份 Operation 定义的摘要 `operationDigest`，门比对自己正在运行的定义，对不上
  或没带就拒绝（409 `operation_definition_mismatch`），此时传输和凭据都没碰。**内核与全部打包门必须同版本升级**：按 §3 入口整版
  应用，compose 一次完成；新门拒绝不带摘要的调用。
- migration governance 0019：`action_requests` 加一列可空的 `operation_digest`（带形状约束：`sha256:<64 hex>`、`none` 或空），
  不回填，可回滚（旧代码不读这一列）。execute 的摘要在建 ActionRequest 时记下；升级前遗留的空值行在执行时用当时已发布的版本，
  门的定义已经变了就 409 失败。
- `publish_operation` 拒绝声明了门拥有参数的 http Operation（400 `gate_owned_params`，列出参数名与位置）；`publish_manifest`、
  `enable_gate_instance` 与 CLI `register-gatekeeper --publish`（该 CLI 已于 P0b 移除，#620）跳过这类 Operation、其余照常发布，并在结果里报告。已发布的行不追溯，
  运行时由门拒绝（§3.20 的 SQL 能列出它们）。
- 门的拒绝在三个通道上保留门自己的状态码与错误码（以前一律 502 `gatekeeper_error`）；门拒绝导致的执行失败原因前面多了门的错误码。
  I17 请求（建请求时既未发布也没有草稿）批准后不再执行，失败原因以 `operation_definition_unavailable:` 开头。
- MCP 门遇到重定向时，报错写明状态码、目标地址，以及"把 URL 设成最终地址"。

**维护窗口前**（只读，主机执行；经 SSH 按 §3 开头的方式把 heredoc 交给 ssh；结果记 `docs/private/`）：

1. 未完成的 ActionRequest 计数。这些行升级后摘要为空，按执行时已发布的版本执行；门的定义已经变了的会 409 失败。§3.17 的排空
   已覆盖大部分，计数是为了让升级后的失败可以解释：

   ```sh
   docker compose exec -T postgres psql -U nexttime -d nexttime -v ON_ERROR_STOP=1 <<'SQL'
   begin transaction read only;
   select status, count(*) from action_requests
   where status in ('proposed','policy_evaluated','auto_approved','pending_approval','approved','executing')
   group by status order by 1;
   rollback;
   SQL
   ```

2. 非平台门（自连门，没有平台实例链接）清单：

   ```sh
   docker compose exec -T postgres psql -U nexttime -d nexttime -v ON_ERROR_STOP=1 <<'SQL'
   begin transaction read only;
   select o.workspace_id, o.id as gatekeeper, o.properties->>'name' as name,
          o.properties->>'transportKind' as transport
   from objects o
   where o.object_type = 'Gatekeeper'
     and not exists (select 1 from workspace_gate_links l
                     where l.workspace_id = o.workspace_id and l.gatekeeper_object_id = o.id)
   order by 1, 3;
   rollback;
   SQL
   ```

   判读：基于旧 gatekeeper-base 的自连门不校验摘要，升级后照常工作。只有 owner 用新 base 重建、且门的清单与导入副本不一致的
   自连门会被拒，处理见 `add-gatekeeper.md` §12。v0.49.0 及以前产品内没有同步路径；#612 起（v0.50.0）系统抽屉有
   「重新读取门的清单」，按门自己的描述预览差异并开修订 / 导入草稿，由 owner 发布后生效，见 §12 那一行。

3. §3.20 的候选参数查询照跑，判读时门拥有的头名单补上：`es-security-runas-user`、`X-Run-As`、`X-Hasura-*`、`x-functions-key`、
   `*-jwt-assertion`、`X-Forwarded-Email`、`X-Forwarded-Groups`。**这份查询只是预估**：SQL 算不了摘要，哪些 Operation 的定义变了，
   以升级后对齐确认框里列出的为准（下面第 2 步）。

**窗口后**（**victor 手动**，对每个 OpenAPI / MCP 平台门）：
1. 平台 → 概览「需要人处理」或 平台 → 集成 列表里标着「新清单待采用」的门 → 「审阅并采用」。确认框列出采用后需要对齐的工作区；
   点「采用」。
2. 各工作区：治理 → 系统与授权 → 该系统卡片 → 「与门公告对齐」。确认框里标着「门运行的定义变了，打开修订草稿」的 Operation
   就是要开修订的；点「对齐」。
3. 对齐结果里每条修订草稿点「去能力目录发布」，核对「和已发布版本相比」的差异后发布。发布之前，这些 Operation 的调用返回 409
   `operation_definition_mismatch`。
4. 抽查：使用 → 对话 里让 agent 调一个刚发布修订的 observe Operation（参数用合成值），应成功。

结果记 `docs/private/`。

**回滚**：旧代码不读 `operation_digest`，列留着即可（schema 撤法见 §6 表）。回滚前按 §3.17 排空 Worker。打包门随 compose 一起回到旧版本，
不校验摘要、按自己的清单执行，回到升级前的行为；窗口后发布的修订保持发布状态，不用撤回。
**自连门例外**：升级期间 owner 用新版本 gatekeeper-base 重建过的自连门不随 compose 回退，它拒绝不带摘要的调用，回滚到旧内核后
对它的每次调用都返回 409 `operation_definition_mismatch`。处理：owner 用旧版本 gatekeeper-base 重建这个门。§3.24 窗口前第 2 条
SQL 列出的自连门清单就是要逐个确认的范围。

### 3.25 敏感值不再原样落库与回显；升级时清洗存量（#549，core 0043，v0.46.0 之后的下一版起）

行为变化：
- 智能体写的 Turn 报告与 Decision、`get_task` / `list_tasks` 返回的 `tasks.input`、工具调用记录的结果、门输出与失败原因的审计副本及其读回、
  Fact 与观察对象的属性、Worker `search` 查询、llm-proxy 转给智能体的非 2xx 上游错误体，都在系统边界按同一套规则遮蔽，存和返回的都是
  遮蔽副本，控制台显示 `[redacted]`。
- 带凭据的地址（URL 里的密码；名字像秘密的查询参数，以及 `sig`、`signature`、`key`、`X-Amz-Signature` 等）在所有写入入口直接 400，
  什么都不存、不发请求：申请连接、建连接（含清单来源）、建平台门实例、启用平台门实例、Gatekeeper 登记、门公告。门公告里**与库中旧值
  相同**的地址放行，升级后正在运行的门心跳不断；新值或变了的值带凭据时门日志记 `credentials_in_connection_params`。
- 签发凭据的 Operation：结果里的凭据智能体和控制台都只看到 `[redacted]`，这类场景应由目标系统直接交给人。发起方入口智能体
  `get_task` 拿到遮蔽副本，只有执行该 Task 的 Worker 拿到原文。
- llm-proxy 的错误体是重新序列化的 JSON（空白可能变化，真 key 与类 token 串变成 `***`），2xx 不受影响。

**存量清洗 `STEP raw-secret-scrub`**：`--pull` 在 `BACKUP_NOW` 之后自动跑 `node dist/cli/scrub-raw-secrets.js --yes`（备份失败就跳过；
失败不致命；可重复执行；日志 `drills/apply-<tag>-<ts>-raw-secret-scrub.log`，apply 日志里一行 `STEP raw-secret-scrub exit=…` 带摘要）。
- 改写 3 类（人会读的智能体副本）：`turnReports`、`decisions`、`toolCallRecords`。v0.50.0 起改写 6 类：#620（core 0045）加
  `selfConnectionAddresses`（自连门在平台面的地址副本，`workspace_self_connections.target / endpoint`，见 §3.34），#637 加 `gatekeeperNames`
  （Gatekeeper 的 `name`）与 `connectedSystems`（门旁 ConnectedSystem 的 identity key `name`、`target`、`name`）。名字按读侧的显示规则改写；
  剪掉凭据后同名的，按键序第一个拿到名字，其余释放 identity key，名字留在 `properties.name`，并以 `properties.duplicateOf` 指向持有者。
- 只计数、不改写 7 类，日志只列行 id、从不列值：`taskInputs`、`connectionTargets`、`gatekeeperAddresses`、`gateInstanceAddresses`、
  `factProperties`、`objectProperties`、`auditResults`。其中 Task 输入、审计里的门结果和 Fact / 对象属性在读出时已经遮蔽，原文留在库里和
  备份里。
- 只列、不改 1 类（v0.50.0 起，#637）：`connectedSystemDuplicates`，不是凭据，列出被写成重复件的 ConnectedSystem（本次与以往
  运行）；报告里这一类的标签是 `listed, nothing to fix`，与只计数的类别分开看。dry run 只列以往运行留下的：剪后是否撞名，要等前面的名字改写之后才知道。
- 写一条平台审计 `cli.raw_secrets_scrubbed`（只有计数和行 id）；core 0043 只为允许这条未署名的主机操作放宽 `audit_records_actor_shape`。
- 要逐行读 `audit_records` 等表，表大时会拉长窗口。
- 只计数的类别在报告行与审计里每类最多列 20 个行 id（超出时以 `,…` 结尾），dry run 也一样。v0.48.0 起（#556）清洗日志在扫描时把每一条
  只计数的行打印成一行 `counted <category> <workspace>/<id>`（平台级行只有 `<id>`），不截断，就是逐行核对清单；v0.47.0 的 CLI 没有这些行，
  超过 20 条时按预检 SQL 把对应的 `count(*)` 改成 `select id`（只读，同样包在只读事务里）列出全部。

**清洗没跑成时补跑**：apply 日志里是 `STEP raw-secret-scrub skipped`（`backup-now` 失败）或 `exit` 不为 0（清洗中途失败，失败之前的批次
已提交）时，v0.48.0 起最后一行是 `RESULT degraded=…`，其中有 `backup-now` 或 `raw-secret-scrub`，日志里紧跟着打印补跑命令（v0.47.0 的
apply-release 在这两种情况下仍打印 `RESULT ok`，遗留 252）。补跑前先要一次新的、成功的备份，再带 `--yes` 跑清洗；经 SSH 时两条都用
`ssh -n`，补跑结果同样记 `docs/private/`：

```sh
docker compose run --rm -e BACKUP_NOW=1 backup </dev/null        # 确认 backups/last-success 已更新
docker compose run --rm --no-deps -T kernel node dist/cli/scrub-raw-secrets.js --yes </dev/null
```

**维护窗口前**（在当前版本上跑，只读，主机执行）：用目标 tag 里的预检 SQL 估上限，再记下相关表的行数用来估耗时，结果记 `docs/private/`。
预检文件随 tag 发布，`--prefetch` 之后本地就有这个 tag；`<目标 tag>` 与 §3.27 的窗口目标是同一个（开窗口时刷新为当时最新的发版）。
v0.50.0 起预检多两列上界 `gatekeeper_names`、`connected_systems`（#637）：

```sh
ssh -n <主机别名> 'cd <检出目录> && (echo "begin transaction read only;"; git show <目标 tag>:packages/kernel/src/cli/scrub-raw-secrets.preflight.sql; echo "rollback;") | docker compose exec -T postgres psql -U nexttime -d nexttime -v ON_ERROR_STOP=1'
```

```sh
docker compose exec -T postgres psql -U nexttime -d nexttime -v ON_ERROR_STOP=1 <<'SQL'
begin transaction read only;
select relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid)) as size
  from pg_stat_user_tables
 where relname in ('audit_records', 'activities', 'decisions', 'chat_messages', 'tasks', 'links', 'objects',
                   'connection_requests', 'gate_instances')
 order by relname;
rollback;
SQL
```

预检是文本匹配的上界；精确计数要新 kernel 镜像（`scrub-raw-secrets.js` 不带 `--yes` 就是 dry run），v0.46.0 的镜像里没有，所以窗口前
不跑 dry run，以 `--pull` 里那次 `--yes` 的报告为准。升级后有人手动跑 dry run 对数时注意：地址带凭据的 ConnectedSystem 在 dry run 里同时计入
`connectedSystems` 与 `objectProperties`，`--yes` 时先改写、`objectProperties` 再扫就不算它们，所以 `objectProperties` 以 `--yes` 后的计数为准（遗留 390）。

**应用后**（主机读日志，结果记 `docs/private/`；处置项由 victor 决定）：
- `connectionTargets` > 0：这些旧申请在取消之前仍显示原 target（遗留 247 ①）。由申请人或工作区所有者取消，需要的话用不带凭据的地址重新申请。
- `gateInstanceAddresses` 或 `gatekeeperAddresses` > 0：这些门实例与 Gatekeeper 的地址带凭据，它们的门公告照旧放行，但这些实例不能再
  启用到新的工作区。由平台管理员用不带凭据的地址重建实例（凭据经门宿主的凭据录入），旧实例的停用或删除是写操作，victor 决定。
- `connectedSystemDuplicates` > 0 不需要处置，记数到 `docs/private/` 即可。
- apply 日志最后一行是 `RESULT degraded=…raw-secret-scrub…`，且 `-raw-secret-scrub.log` 末行含 `objects_identity_key_uidx`：清洗期间有门以同样的
  显示名落地，按上面「补跑」先备份、再跑 `--yes`，那一行会被写成重复件。
- 其余只计数的类别不需要处置；要真正删掉库里与备份里的原文，属破坏性操作，另行决定。

**回滚**（§5）：代码切回 v0.46.0 即可，core 0043 只放宽约束（§6）。回滚后：
- 已遮蔽的行**保持遮蔽**：清洗是单向的，旧代码读到的是 `[redacted]` 文本，无害。
- 名字的改写同样是单向的（#637）：旧代码读到剪过的名字，无害；重复件的 identity key 为空，旧代码按名字 upsert 时会落到持有者上，也无害。
- 恢复 `BACKUP_NOW` 或 `pre-upgrade/` 的 dump 会把原文带回来：**只用于灾备**，不作为回滚手段。在 v0.47.0 及以后的版本上恢复备份之后，按上面「补跑」
  的命令再跑一次清洗。
- 升级前后的这两份 dump 里都有原文，保留期内按凭据材料对待，不拷离主机。
- v0.46.0 的入口重新接受带凭据的地址（即遗留 186 本身），回滚期间不要新建带凭据的连接或门实例。

### 3.26 caddy 日志不记凭据；apply 不再把没做完的事报成 ok（#556，遗留 236、252，v0.47.0 之后的下一版起）

行为变化（没有迁移）：
- caddy 的两处日志（站点访问日志与全局 `log default`，后者含错误条目和 DEBUG 下 reverse_proxy 的条目）删掉全部请求头，查询串里
  `=` 之后的值改成 `REDACTED`。以前用 `X-API-Key` 经 caddy 调接口时 key 会以原文进日志。代价：User-Agent、X-Forwarded-For 等诊断字段
  也不再记录，`remote_ip` 保留。没有键名、只有值的查询串（`?<token>`）遮不到，目前没有调用方这样用（遗留 258）。
- llm-proxy 改写非 2xx 错误体时去掉上游的 `content-encoding`；2xx 透传不变（遗留 257）。
- 清洗日志逐行列出只计数的行（§3.25）。
- `apply-release.sh`：
  - **第 6 步之后的单文件挂载刷新**：`up -d` 只在定义或镜像变了时重建容器，从检出目录单文件挂进去的配置换了内容，旧容器仍读旧文件
    （caddy 就因此一直读旧 Caddyfile）。现在对 caddy、backup、update-feed 逐个比较容器里的文件与检出目录，不同就重建，日志一行
    `STEP mount-refresh <service> recreated — …`。`--pull` 换了 caddy 镜像时 `up -d` 已经重建 caddy、新容器直接读新 Caddyfile，比较一致，
    **不会再打印 caddy recreated，这不算异常**；只有 caddy 镜像没变（例如源码构建）时才由这一步重建。caddy 是否读到新配置以
    `STEP caddy-log-redaction` 各项 PASS 为准。**也可能看到 backup 与 update-feed 被重建**：两者镜像按 digest 固定，是否重建只取决于容器
    有多老（容器很久没重建就一直读着启动时的旧脚本），属正常。
  - **第 7 步之后两项检查**：`STEP acceptance-fixtures`（验收用的测试容器不许残留，正常是 `none left running`）；`STEP caddy-log-redaction`
    （经真实入口发合成探针，再数本次 apply 以来 caddy 日志里的凭据，各项应为 PASS；需要 `.env` 里的 `KERNEL_BIND_ADDR`，日志
    `drills/apply-<tag>-<ts>-caddy-log.log`）。这两项和下表其余步骤一样，没做完都体现在最后的 RESULT 行。
  - caddy 重建时 docker 删掉旧容器的 json 日志，里面以前的 key 原文随之消失；被复制到别处的副本不受影响。

**`RESULT degraded=…` 的各项**（每项在日志里对应的 `STEP <step> …` 行带现成命令；补做后再看一遍对应检查，结果记 `docs/private/`）：

| 项 | 意思 | 怎么补 |
|---|---|---|
| `backup-now` | 新版本上的备份没成功，压缩与清洗都被跳过（压缩下次 apply 再跑） | 按打印的命令重新备份，再按 §3.25「补跑」清洗 |
| `raw-secret-scrub` | 清洗跳过或中途失败（失败前的批次已提交） | §3.25「补跑」：先备份，再 `--yes` |
| `observations-compaction` | Observation 压缩失败 | 按打印的命令重跑 |
| `backup-marker` | `backups/last-success` 不是普通文件或建不出来 | 按打印的 `mv` / `: >` 命令修 |
| `update-feed-dir` | `config/update-feed` 属主或权限设不上 | 按打印的 `chown` / `chmod` 命令修 |
| `egress-sources` | `config/egress-sources.json` 属主或权限设不上 | 按打印的 `chown` / `chmod` 命令修 |
| `mount-refresh` | 某个服务没能重建，可能仍读旧文件 | `docker compose up -d --no-deps --no-build --force-recreate <service>`；是 caddy 时再跑一次 caddy 日志检查 |
| `acceptance-fixtures` | 有测试容器残留（无鉴权的测试端点留在 control 网络上） | 按打印的 `docker compose … rm -sf …` 移除 |
| `caddy-log-redaction` | caddy 日志检查没过或没跑成 | 按打印的命令重建 caddy 并再检查一次；仍不过就停下报告 |

**应用后，由 victor 决定**（主机与凭据操作）：
- 曾经用 `X-API-Key` 经 caddy 调 Explorer 或 curl 的 owner API key，在此前的 caddy 日志里是原文，而 docker 门能读这些日志：是否轮换。
- 旧 caddy 日志被复制到别处的副本（例如私有记录里贴过的 `docker compose logs` 输出）：是否清理。

**回滚**（§5）：没有迁移，v0.48.0 的 Caddyfile 相对 v0.46.0 只改了日志块，compose 不变。换回 v0.46.0 镜像时 caddy 随 `up -d` 重建、读回旧
Caddyfile，日志重新记录请求头与查询串原文；不要为了「生效」去主动重建 caddy（没被重建的 caddy 继续遮蔽，更安全）。回滚期间不要用
API key 经 caddy 调接口。

### 3.27 升级窗口总清单：v0.46.0 → v0.50.0

**2026-10-30 刷新**：维护者 2026-10-16 暂缓窗口，2026-10-30 开窗口时目标改为当时最新的发版 v0.50.0。v0.47.0、v0.48.0、v0.49.0 都不单独上主机，一次窗口从 v0.46.0 直接到 v0.50.0。v0.50.0 在 v0.49.0 之上带了 §3.28–§3.74 各节（索引见本节末尾），**每一节的「窗口前」「应用后」「回滚」都要按节执行**；下表第 2、8、9、10 行把它们按时机汇总，细节以各节为准。

以下是 v0.49.0 部分的原清单（仍然适用）：v0.47.0、v0.48.0 不单独上主机（#554 不在 v0.47.0 里，遗留 259 的修复 #561 不在 v0.48.0 里）。v0.49.0 收齐：#541（只改控制台渲染
与两个只读查询）、#549（§3.25）、#554、#559 与 #561（只改控制台与 CI 守卫，无主机步骤）、#556（§3.26）；v0.49.0 只比 v0.48.0 多 #561 与 STATUS。迁移只有 core 0043（放宽一条审计约束）。没有 Handle 吊销，不需要排空 Worker。
先确认起点：`git describe --tags --exact-match </dev/null` 应输出 `v0.46.0`；上主机前按 §1 第 5 步对同一个 tag 跑一次 `staging` 预演。

窗口开始前告诉维护者：执行会话被本地权限检查拦下时会停下等他批准（§3 开头，遗留 231），请他在场或提前加好允许规则。

主机直连 GitHub 不稳定：`git fetch` 拿不到 tag 时，从维护者电脑用 git bundle 导入 tag（bundle 的具体路径记在 `docs/private/`，不入库），
导入后核对 `git rev-parse 'v0.50.0^{commit}'` 等于发版 commit，再做第 1 步。

| # | 时机 | 步骤 | 谁 |
|---|---|---|---|
| 1 | 窗口前 | `--prefetch v0.50.0`，日志最后一行 `RESULT ok`（§3）；tag 拿不到时先按上面用 bundle 导入并核对 commit | 主机 |
| 2 | 窗口前 | §3.25 的预检 SQL 与表行数；目标含 #644 时再跑 §3.38 的打包门只读检查（不为空先改 `.env` 的 `GATE_CONNECTOR`）；目标含 #650 时可选跑 §3.40 的本体族只读检查；结果记 `docs/private/`。v0.50.0 另加：§3.30 与 §3.32 估算 `audit_records` 回填 / 建索引的锁与等待（等不起时按 §3.32 预建并确认索引有效），§3.31 与 §3.37 看相关表行数，§3.45 查同名已发布 Skill，§3.47 四条只读查询，§3.48 清点工作区 pi 资源文件（不删），§3.50 `goal_runs` 行数，§3.52 看 `connectors` 里 `ragflow` 一行，§3.55 `plan_revisions` / `procedures` 行数，§3.56 列出部署了 `document.parse` 的工作区，§3.57 `models/` 目录属主与权限，**§3.63 只读 SQL A–E（D 有行先处理）**，§3.67 可选计数，**§3.73 `docker version` 的 Engine ≥ 26.0.0** | 主机 |
| 3 | 窗口内 | `--pull v0.50.0`，**按最后一行 RESULT 判断，不按退出码**（§3）。日志里应看到：`STEP caddy-log-redaction` 各项 PASS（caddy 由 `up -d` 或 `mount-refresh` 重建，看不到 `mount-refresh caddy recreated` 不算异常；backup、update-feed 可能 recreated，也属正常，§3.26）；`STEP acceptance-fixtures none left running`；`STEP backup-now exit=0` 在前、`STEP raw-secret-scrub exit=0` 在后。`acceptance-failures` 按 §5 判断回滚；`degraded=…` 按 §3.26 的表逐项补做，补做结果记 `docs/private/` | 主机 |
| 4 | 应用后 | 读 `-raw-secret-scrub.log`：改写 6 类、只计数 7 类、只列 1 类（`connectedSystemDuplicates`）的数字、`cli.raw_secrets_scrubbed` 的审计 id、全部 `counted …` 行，记 `docs/private/` | 主机 |
| 5 | 应用后 | §3.25「应用后」的处置：只计数的地址类别 > 0 时按 `counted …` 行逐条决定 | victor 决定 |
| 6 | 应用后 | §3.26「应用后」：owner API key 是否轮换、旧 caddy 日志副本是否清理 | victor 决定 |
| 7 | 应用后 | 控制台核对，结果告诉远程会话记 `docs/private/`：(a) 用一个非所有者账号打开 治理 → 系统与授权 →「接入一个系统」，选一个还没在本工作区启用的实例，到「在本工作区启用」这一步应说明由谁启用、给出一句可复制发给所有者的申请、能退回，没有死路（#541 验收盲区，#554）；(b) 第 4 步 `gateInstanceAddresses` > 0 时，在 平台 → 集成 试着启用其中一个实例，应被拒并在字段上给出说明，不建链接（遗留 251）；(c) 治理 → 审计 的行标题是中文名；(d) 打开任一新建 / 添加表单先不填，提交按钮灰掉时旁边写着「还差：…」（#554）；(e) 在授权表单里选成员时，两个同名成员各带短 id、能分开（遗留 259，#561） | **victor 手动** |
| 8 | 应用后 | v0.50.0 各节的应用后只读核对：§3.28 `vector` 扩展版本仍是 `0.8.6`（**不执行 `ALTER EXTENSION vector UPDATE`**）；§3.29 两类审计计数与内核日志 N / M 对上，旧「始终允许」规则可能显示「已暂停 · 待确认版本」由 owner 重新确认；§3.30 历史失败行多显示「结果不明」是预期；§3.31 三个触发器为 `O`、`I-G*` 不变式指标为 0；§3.32 索引 `indisvalid` 为 `t`；§3.47 迁移 NOTICE 每类 `without` 为 0；§3.48 在应用之后新建的容器上核对；§3.53 三条约束在；§3.56 `document.parse` 需平台采用 + 各工作区对齐；结果记 `docs/private/` | 主机 |
| 9 | 应用后 | GO7b：`accept_s2` 的 fake 路径照常跑 S1、S4–S11，S12、S2 不跑（S2 摘要里有一行 `NOTE goal-disruptive …`）。S12、S2 会 `SIGKILL` 内核两次、重启 worker-supervisor 一次（整套约 35–45 分钟，每次中断约 20 秒），**只在维护者当场明确同意后**单独再跑 `ACCEPT_DISRUPTIVE=1 sh scripts/accept_s2.sh`；跑之前确认 `.env` 没有调大 `TASK_REAPER_INTERVAL_MS`、`GOAL_ACCEPTANCE_CHECK_*`、`GOAL_RECONCILE_CHECK_*`，llm-proxy 的 `UPSTREAM_IDLE_TIMEOUT_MS` 不低于 120 秒；不同意就不跑，两项以同一 tag 的 staging 结果代替，STATUS 写「staging 代替，主机未跑」 | 主机；破坏性部分 **victor 当场同意** |
| 10 | 应用后 | GO7b：维护者挑一个遗留 230 的真实目标在主机上真实跑一遍并在控制台可查；§7.2 付费真实模型回归按协调线程的安排并入最后一轮 | **victor** |

**回滚**（§5）：回滚目标是 v0.46.0，按 §3.25 与 §3.26 的回滚说明；不需要排空 Worker。 v0.50.0 另外：worker-runtime 与 worker-supervisor 只能整版回滚（§3.48）；有接入预设实例时先停 `gate-host`（§3.52）；回滚 worker-supervisor 前先终止带 `nexttime.egress-deny-all=true` 标签的 Task（§3.73）；回退代码前先处理挂在系统接入包上的实例（§3.38）；其余按各节「回滚」。

v0.50.0 带的各版小节（2026-10-30 已按 v0.50.0 刷新本清单；下一次发版若改窗口目标，照同样方式刷新）：§3.28（#589 升钉：`postgres` 与 `backup` 重建、不执行 `ALTER EXTENSION`、应用后只读核对 `vector` 扩展版本）与 §3.29（#592：governance 0020，旧「始终允许」规则可能显示「已暂停 · 待确认版本」需 owner 重新确认，契约不向后兼容、旧控制台页要刷新）与 §3.30（#601：governance 0021，窗口前估算 `audit_records` 全表扫描的锁表时间并核对回收超时，窗口后历史失败行多显示「结果不明」）与 §3.31（#607：goal 0001 / task 0007 / governance 0022，窗口前估算建索引时间）与 §3.32（#615：core 0044，窗口前估算建索引期间审计写入的等待，必要时并发预建并确认索引有效）与 §3.33（#619：goal 0002，新增每秒认领与每分钟对账的后台负载）与 §3.34（#620：core 0045，窗口前三数预检、迁移期间不接新门、清洗改写类变成 4 个、回滚后自接门暂停失效；#637 再加两个改写类与一个只列类，见 §3.25）、§3.35（#626：goal 0003，只重建一个守卫函数，无主机步骤）、§3.36（#633：goal 0004，加列与重建一个守卫函数，无主机步骤）、§3.37（#642：governance 0023，`action_requests` 加列、约束与守卫触发器，窗口前看一眼该表行数，无主机步骤）、§3.38（#644：无迁移，窗口前打包门只读检查，内核与门宿主同版，回退代码前先处理挂在系统接入包上的实例）、§3.39（#649：governance 0024，新表与重建核对守卫，两个可选环境变量不设即默认，代码回退期间观察压缩报 degraded 可忽略）、§3.40（#650：governance 0025，只加新表，可选的窗口前本体族只读检查，模块升级可能新返回 400 `change_confirmation_required`）、§3.41（#664：goal 0005，新表与重建目标守卫，两个可选环境变量不设即默认，升级后 I-G5 指标应为 0，代码回退期间观察压缩报 degraded 可忽略）、§3.42（#670：goal 0006，步骤验收新表与新触发器，无新环境变量，代码回退期间观察压缩报 degraded 可忽略）、§3.43（#668：无迁移，能力包清单在镜像 `/app/packs`，`kernel.env` 不要设 `PACKS_DIR`）与 §3.44（#674：core 0046 + goal 0007，可逆，无新环境变量，升级后 I-G5 指标仍应为 0）与 §3.45（#679：governance 0026，可逆，窗口前只读查同名已发布 Skill，镜像新增 ops-base）与 §3.46（#690：governance 0027，可逆，镜像新增 ops-base v2，装或升级能力包后对门做一次健康探测）与 §3.47（#700：governance 0028，可逆，窗口前四条只读查询，迁移结束的 NOTICE 每类 `without` 应为 0，窗口后核对找不到主体的 Decision）与 §3.48（#698：无迁移，worker-runtime 与 worker-supervisor 同版、只能整版回滚，窗口前只读清点工作区里的 pi 资源文件，应用后在新建的容器上核对）与 §3.49（#705：无迁移，镜像新增 ops-base v3，包里的 Worker 安装时可绑门）与 §3.50（#704：goal 0008，可逆，可选环境变量 `GOAL_MAX_PROPOSED_PER_REQUESTER` 写错内核起不来）与 §3.51（#710：无迁移，门对齐时治理字段从三个扩到九个）与 §3.52（#715：无迁移，内核镜像带接入预设；有预设实例时回滚要先停 `gate-host`）与 §3.53（#716：task 0008，可逆，worker-runtime 与内核同版本）与 §3.54（#721：无迁移，镜像新增 knowledge v1 能力包）与 §3.55（#722：goal 0009 + worker 0005，可逆）与 §3.56（#726：无迁移，RAGFlow `document.parse` 收紧，需平台采用 + 各工作区对齐）与 §3.57（#730：task 0009 可逆，supervisor 加 `models/` 只读挂载，kernel 与 supervisor 同版本）与 §3.58（#728：无迁移，入口 agent 新增目标工具，验收脚本自建 fake-llm）与 §3.59（#737：linkage 0003 放宽 CHECK，可逆）与 §3.60（#745：goal 0010 加一列，不回填，可逆）与 §3.61（#747：无迁移，已有工作区可对齐入口模板，由所有者决定）与 §3.62（#753：无迁移，门可声明「不存在」的回答）与 §3.63（#759：无迁移，安全修复，窗口前只读核查 A–E）与 §3.64（#765：core 0047 加触发器守护已发布 Operation，可逆，无主机步骤）与 §3.65（#764：无迁移，`publish_skill` / `publish_procedure` 必填 `draftDigest`，契约不向后兼容）与 §3.66（#757：无迁移，发布带「不存在」声明的 Operation 要人确认）与 §3.67（#772：无迁移，新能力 `reject_draft`）；#774（遗留 486）无迁移、无主机步骤，发版说明写「指向入口定义的流程步骤在提议和发布时被拒，`find_procedures` 不再推荐这类流程」；#781（W1a E2-1）无迁移、无主机步骤，发版说明写「新能力 `get_skill_stats`（builder 起，人的通道），控制台 Skill 详情新增「使用情况」」；§3.68（#780：迁移 goal/0011，按门确认不存在验收）；#784（W1a E2-2）无迁移、无主机步骤，发版说明写「新能力 `get_procedure_stats`（builder 起，人的通道）；`find_procedures` 的结果多了 `outcomes{achieved, total}`（新增字段，旧调用方不受影响）；控制台流程详情新增「使用情况」」；§3.69（#792：迁移 worker/0006，Worker 定义族与 `invoke_worker` 的契约变化）与 §3.70（#786：迁移 goal/0012，「存在过」基线）；§3.71（#796：迁移 task/0010，任务级观察范围）；§3.72（#799：迁移 governance/0029，reconcile 用门确认不存在）；§3.73（#818：评测容器出网全拒，无迁移，窗口前核对 Docker Engine ≥ 26.0.0）；§3.74（#821：门新路由 `gate/credential-presence`，无迁移）。

### 3.28 第三方镜像升钉：pgvector、node、postgres（#589，v0.50.0 起）

无迁移。按 issue #587（`image-pins` 每周比对，遗留 181）把三个钉值移到上游 tag 当前 digest：pgvector（主库 `postgres` 服务）
PostgreSQL 仍是 17.11，扩展 0.8.6 → 0.8.7；postgres（`backup` 服务与 `restore.sh` 的 dry-run 工具镜像）仍是 17.11，只是 Alpine 包重建；
node 24.21.0 → 24.22.0，只影响平台镜像的构建，随发版重建，没有主机步骤。没有大版本或数据格式变化，不需要 `pg_upgrade` 或 dump/restore。

- **应用**：镜像引用变了，`up -d` 会重建 `postgres` 与 `backup` 容器（数据卷不动，`postgres` 停几秒，`apply-release.sh` 在 `up` 之前已做 dump），属预期。
- **pgvector 不需要 `ALTER EXTENSION`**：换镜像后新的 0.8.7 共享库直接加载库里登记为 0.8.6 的扩展，照常可用；上游 `vector--0.8.6--0.8.7.sql` 只有 `COMMENT ON`。
  **不要执行 `ALTER EXTENSION vector UPDATE`**；如果执行过（登记版本变成 0.8.7），就**不能再回滚到旧镜像**：旧镜像没有 0.8.7 的控制文件，扩展相关的 SQL 会报版本不存在。
- **应用后只读核对**：`select extversion from pg_extension where extname = 'vector';`（不执行 `ALTER EXTENSION` 时应仍是 `0.8.6`），结果记 `docs/private/`。
- **回滚**：旧 tag 按旧 digest 引用 GHCR 副本，旧版本仍在包里（§3.19：不删 `nexttime-mirror-*` 的旧包版本），`up -d` 再重建一次即可；前提是没有执行过 `ALTER EXTENSION`（见上）。
  §3.19 回滚命令里的 postgres digest（`18cfe3ef…`）是升钉前的旧值，**保留不改**：回滚到 v0.44.0 及更早时给旧版 `restore.sh` 补本地 tag 要用它。

### 3.29 「始终允许」绑定所审的定义；发布与安装绑定所审的版本（#592，governance 0020，遗留 218 / 300 / 301，v0.50.0 起）

带一个 governance 迁移（`0020_auto_approval_definition`），随 `apply-release.sh` 的迁移步骤自动应用，无单独主机步骤；线上契约**不向后兼容**（见下）。

- **迁移做什么**：`gatekeeper_policies` 加两列可空列 `operation_digest`、`operation_version`，记下按门「始终允许」所允许的那份定义。既有的按门自动批准规则按证据绑定、不会更宽：取同一门、同一动作种类上、由该规则的写入者在规则最后写入之前批准（不是驳回）的最新一条请求的摘要；找到就绑定并继续自动批准，找不到（或那条请求早于 0019、没有摘要）就**不绑定**，规则在本版显示「已暂停 · 待确认版本」，这类请求改为走审批。每条规则写一条审计：`policy.auto_approve_definition_bound` 或 `policy.auto_approve_definition_unproven`；内核日志有一行 `governance 0020: bound N auto-approval rule(s) …, suspended M`。重复执行结果不变。
- **窗口后提醒维护者**：没有批准证据的旧「始终允许」规则会显示「已暂停 · 待确认版本」，对应 Operation 的请求会重新出现在审批队列里。这是预期（只会更窄）；需要继续自动批准的，由 owner 在控制台策略表里按当前发布的版本「重新确认」。
- **应用后只读核对**：`select action, count(*) from audit_records where action in ('policy.auto_approve_definition_bound', 'policy.auto_approve_definition_unproven') group by action;`，与内核日志那一行的 N / M 对上，结果记 `docs/private/`。
- **契约不向后兼容**：升级时浏览器里还开着的旧控制台页，在发布、安装、「始终允许」、发布清单时会得到 400 `invalid_params`（什么都不写），刷新页面即可。直接调 API 的脚本要带上新参数：`publish_skill` / `publish_procedure` / `install_module` / `upgrade_module` 必填 `version`；`publish_operation` 的 `draftDigest` 必填；`set_auto_approved_action_kind` 必填 `actionRequestId`；`set_policy` 按门开自动批准要 `operationVersion`，不再接受门上不存在的动作；`publish_manifest` 必填 `drafts`；`set_policy` 省略 `requesterCanApprove` 时保留原值（以前写成默认），回到默认要显式传 `null`。仓库内的 `scripts/accept_s2.sh`、`accept_s4.sh`、`drill-add-gatekeeper.sh` 已随 #592 更新，窗口里跑 S2 / S4 时一并验证。
- **回滚**：只回退代码即可（§6）。回退后上一版写的规则不带摘要，回到本版时显示暂停、走审批；用上一版编辑一条已绑定的规则会保留旧摘要，回到本版时显示「已暂停 · 定义已变」。两种都只会更窄，回到本版后由 owner 重新确认。

### 3.30 ActionRequest 撤回状态与失败类别（#601，governance 0021，S11 GO1 前半，遗留 310，v0.50.0 起）

带一个 governance 迁移（`0021_action_request_withdraw_failure_kind`），随 `apply-release.sh` 的迁移步骤自动应用，无单独主机步骤。

- **迁移做什么**：重建 `action_requests_status_check` 加入 `withdrawn`；加列 `failure_kind`（CHECK 只许 `not_delivered` / `refused` / `outcome_unknown`，恰在 `failed` / `compensated` 行上有值）；加触发器 `action_requests_status_guard`（拒绝以 `withdrawn` 新建、离开 `withdrawn`、从执行后的状态进入 `withdrawn`；写失败行不带类别时补 `outcome_unknown`）；按白名单回填存量失败行。
- **窗口前只读核对**：回填对 `audit_records` 按 action 全表扫描一次（没有可用索引），并且和 `ALTER TABLE` 在同一个事务里、持有 `action_requests` 的排他锁，期间审批与门执行会等。先查 `select count(*) from audit_records;` 与 `select count(*) from action_requests where status in ('failed', 'compensated');` 估算锁表时间，结果记 `docs/private/`。同时核对主机 `.env` 的 `ACTION_REQUEST_STALE_EXECUTING_TIMEOUT_MS` 未设或不低于 `120000`：回填把「开始执行两分钟内失败」当作第一次调用的结果，回收阈值低于两分钟时这个前提不成立（审查 #493 在 #601 记为 P3）。
- **窗口后提醒维护者**：历史失败行里拿不准的会显示红色「结果不明，需要核对」，数量可能不少。这是有意的保守读法（方向是让人核对，而不是诱导重试），不是新故障；历史行没有关联 StepRun，推进器不读它们。应用后只读核对：`select failure_kind, count(*) from action_requests where status in ('failed', 'compensated') group by failure_kind;`，结果记 `docs/private/`。
- **契约**：`ActionRequestStatus` 新增 `withdrawn`，`ActionRequestWire` 新增必填可空字段 `failureKind`。仓库内消费方已同步；升级时还开着的旧控制台页遇到这两个值时显示可能不全，刷新即可。发版说明人工补一句：`markActionRequestFailed` 现在要求 `failureKind`，`ActionExecutorResult` 改为联合类型（只影响仓库内调用方）。
- **回滚**：只回退代码即可（§6）。上一版写失败行不带类别，触发器补 `outcome_unknown`；残留的 `withdrawn` 行对上一版是终态（它的 drain 与过期只按名字挑 `auto_approved` / `approved` / `pending_approval` / `executing`）。

### 3.31 目标级执行的数据模型（#607，goal 0001、task 0007、governance 0022，S11 GO1 后半，v0.50.0 起）

带三个迁移，随 `apply-release.sh` 的迁移步骤自动应用，无单独主机步骤；线上契约无变化。

- **迁移做什么**：`goal/0001` 是新模块 `goal`（迁移锁键 7241000701）的三张新表 `goal_runs` / `plan_revisions` / `step_runs` 与它们的守卫触发器、延迟约束触发器 `plan_revisions_adopted`；`task/0007` 给 `tasks` 加可空列 `goal_run_id` / `step_run_id` / `plan_revision` / `step_attempt` / `run_config_snapshot`、CHECK、外键、I-G1 唯一索引、触发器 `tasks_goal_step_immutable` 与索引 `worker_runs_task_idx`；`governance/0022` 给 `action_requests` 加可空列 `step_run_id`、外键、触发器 `action_requests_step_run_immutable` 与索引 `action_requests_parent_worker_run_idx`。都不回填。
- **窗口前只读核对**：`task/0007` 与 `governance/0022` 在 `tasks`、`action_requests` 上加 CHECK 与外键时在锁内校验全表（新列全是 NULL，很快）；两条新索引用普通 `create index`（迁移在事务里跑，不能 `CONCURRENTLY`），建索引期间阻塞对 `worker_runs`、`action_requests` 的写入。先查 `select count(*) from worker_runs;` 与 `select count(*) from action_requests;` 估算时间，和 §3.30 的 `audit_records` 估算一起记 `docs/private/`（审查 #493 在 #607 记为 P3）。
- **应用后只读核对**：`select tgname, tgenabled from pg_trigger where tgname in ('tasks_goal_step_immutable', 'action_requests_step_run_immutable', 'action_requests_status_guard');` 都是 `O`；内核日志里 `nexttime_invariant_violations{invariant=~"I-G.*"}` 为 0。
- **回滚**：只回退代码即可（§6）。上一版不读写三张新表，看不到新列；新列都可空、上一版写的行全为 NULL，满足 CHECK 与外键；不可改触发器只在改这些列时触发。

### 3.32 审计按对象的索引（#615，core 0044，遗留 338，v0.50.0 起）

带一个 core 迁移（`0044_audit_records_resource_idx`），随 `apply-release.sh` 的迁移步骤自动应用；线上契约形状不变。

- **迁移做什么**：建部分索引 `audit_records_resource_idx`，列 `(workspace_id, resource_id, created_at)`，条件 `where resource_id is not null`。只加索引，上一版不引用它。同名索引若是无效残留（`indisvalid = false`），迁移先删掉再建。
- **锁**：迁移在事务里跑，只能用普通 `create index`，对 `audit_records` 持 SHARE 锁直到迁移提交：读不受影响，所有审计 INSERT 等待。`apply-release.sh` 迁移时上一版内核还在服务，它的受治理写入与能力调用会排队（不会失败），时长约为 `audit_records` 一次顺序扫描加带 resource 的行的排序。
- **窗口前只读核对**：在 §3.30 的 `select count(*) from audit_records;` 之外再查 `select count(*) from audit_records where resource_id is not null;` 与 `select pg_size_pretty(pg_relation_size('audit_records'));`，估算建索引期间审计写入要等多久，结果记 `docs/private/`。
- **等不起时窗口前预建**：上一版还在跑时，在事务外执行

  ```sql
  create index concurrently if not exists audit_records_resource_idx
    on audit_records (workspace_id, resource_id, created_at) where resource_id is not null;
  ```

  **必须等这条命令返回、并确认 `select indisvalid from pg_index where indexrelid = 'audit_records_resource_idx'::regclass;` 为 `t` 之后才能进窗口**：还在构建中的索引在目录里也是 `indisvalid = false`，迁移会去 drop 它，并与 `CREATE INDEX CONCURRENTLY` 互相等待（审查 #493 在 #615 记为 P3）。预建失败或被取消留下的无效索引不用手工删，迁移会处理。
- **应用后只读核对**：同一条 `indisvalid` 查询为 `t`。
- **行为变化（发版说明补一句）**：agent 从 `request_action` 拿到的失败原因与 wire 上的 `outcomeInDoubt.reason`，现在和 `failureReason` 一样截断到 1000 个 code point，不可见字符显示为 `\u{XXXX}`。
- **回滚**：只回退代码即可（§6）。要连 schema 一起撤：`drop index if exists audit_records_resource_idx;` 并 `delete from schema_migrations where module = 'core' and version = 44;`（不撤也无害）。

### 3.33 目标推进器（#619，goal 0002，S11 GO2，遗留 325，v0.50.0 起）

带一个 goal 迁移（`0002_goal_advancer`），随 `apply-release.sh` 的迁移步骤自动应用；没有新环境变量、不改 compose、无单独主机步骤。

- **迁移做什么**：`goal_runs` 加可空列 `next_tick_at`、CHECK `goal_runs_next_tick`（终态行为空）、只收有 `next_tick_at` 的部分索引，并重建守卫 `goal_runs_status_guard`（只多放行这一列）。GoalRun 在 v0.49.0 之后才有，主机升级时 goal 0001 与 0002 一起应用、表是空的，耗时可以忽略。
- **新的后台负载**：每秒一次到期认领（走部分索引），每分钟一次对账扫描（只看 `running` / `paused` 的 GoalRun）。GO5 开放 `propose_goal` 之前库里没有 GoalRun。
- **goal 之外的行为变化**：`run_lost` 不再收割从没有过 WorkerRun 的 `running` / `waiting_approval` Task（遗留 325），现有入口不会产生这样的 Task。
- **回滚**：只回退代码即可（§6）。上一版没有 goal 模块，回退后这些表不再被读写；GO1 的代码也不读写 `next_tick_at`。

### 3.34 自连门的来源与平台切断；接入路径统一（#620，core 0045，S11 P0b，遗留 118 残余 ①，v0.50.0 起）

带一个 core 迁移（`0045_workspace_self_connections`），随 `apply-release.sh` 的迁移步骤自动应用；没有新环境变量、不改 compose。

行为变化：
- 工作区自己接入的门（`create_connection`，或旧版 CLI 登记的）有了来源记录，平台管理员能在「集成 → 自己接入的门」里逐个暂停 / 恢复；
  暂停期间这个门的所有 Operation 在每条调用路径上都按「平台已停用」拒绝。平台面只看到协议、主机和端口，完整地址只在工作区自己的视图。
- 一个工作区里一个地址只能有一个门：同址的第二次接入 409 `endpoint_already_connected`（大小写、默认端口含 ssh 22、尾斜杠、userinfo、
  查询串等不同写法算同址）。工作区里**原本就有**两个写法不同、实际同址的门时，两者都保留、各有来源；启用同址的平台实例时以 ambiguous 拒绝。
- 启用与自接门同址的平台实例会认领它：这个门从自己接入转为目录来源；已被平台暂停的自接门不能被认领（`self_connection_suspended`）。
- `bootstrap.js register-gatekeeper` 已移除，改用目录启用或 `create_connection`。

**迁移做什么**：建表 `workspace_self_connections`（强制 RLS，只有平台事务能改暂停状态），并为每个**没有目录关联**的 Gatekeeper 回填一行，
署名为空、时间取 Gatekeeper 自己的 `created_at`。复制地址时按清洗预检的模式剪掉凭据：endpoint 去掉 userinfo、查询串与片段，target 去掉
userinfo 里的密码与查询串，剩下的仍像秘密时整段记 `[redacted]`；Gatekeeper Object 本身不改（门在那里被调用，清洗把它计入
`gatekeeperAddresses`）。回填行的 `endpoint_key` 为空，所以同址的旧门不会让迁移失败，也不会被合并。NOTICE 一行报回填数、剪掉凭据的行数、
跳过数（传输种类没有接入包，预期为 0，遗留 373）。量级：一张表加一次 `objects ⋈ connectors` 的插入，在 core 的 advisory lock 下秒级。

**维护窗口前**（在当前版本上跑，只读，主机执行；`objects` 有 RLS，必须用 superuser 跑；结果记 `docs/private/`）：

```sh
docker compose exec -T postgres psql -U nexttime -d nexttime -v ON_ERROR_STOP=1 <<'SQL'
begin transaction read only;
select count(*) filter (where c.name is not null) as will_backfill,
       count(*) filter (where c.name is null)     as will_skip,
       count(*) filter (where coalesce(o.properties->>'endpoint','') ~ '@|[?#]'
                           or coalesce(o.properties->>'target','')   ~ '://[^/]*@') as addresses_to_check
  from objects o
  left join connectors c on c.name = o.properties->>'transportKind'
 where o.object_type = 'Gatekeeper'
   and not exists (select 1 from workspace_gate_links l
                    where l.workspace_id = o.workspace_id and l.gatekeeper_object_id = o.id);
rollback;
SQL
```

预期 `will_skip = 0`；不为 0 时这些门迁移后没有来源、平台看不到，先告诉 victor。`addresses_to_check > 0` 时，迁移会剪掉副本里的凭据，
窗口后再按 §3.25 的清洗报告核对 `selfConnectionAddresses` 与 `gatekeeperAddresses`。

**窗口内**：迁移期间旧 kernel 还在跑，这段时间里新接的门不会有来源行，所以**迁移期间不接新门**。

**清洗没跑成时**：`apply-release.sh` 在迁移之后才跑 `BACKUP_NOW → raw-secret-scrub`；`BACKUP_NOW` 失败时清洗被跳过，新表里只有迁移里的
正则在把关。按 §3.25「清洗没跑成时补跑」处理，这次补跑也会按精确规则改写新表的 `selfConnectionAddresses`。

**窗口后**（结果记 `docs/private/`）：告诉 victor「集成 → 自己接入的门」里会出现回填的旧门；与目录实例同址的那几行，由 owner 启用实例来认领。
自接门的 Gatekeeper / ConnectedSystem 名字就是目标：读侧已脱敏，但遗留 186 之前写入的带凭据旧名字仍在库里与备份里，由清洗改写（遗留 384，#637 加的 `gatekeeperNames` 与 `connectedSystems`，§3.25）；开窗口前确认目标发版包含 #637，否则先告诉 victor。

**回滚**（§5、§6）：只回退代码即可，表可以保留、重新升级幂等。**回滚到 0045 之前的 kernel 后，自接门的暂停不再生效**（旧 kernel 不读这张表），
回滚后在平台侧确认哪些门需要切断，改用停用工作区或在门宿主侧断开。

### 3.35 目标的暂停、继续与取消（#626，goal 0003，S11 GO3a，遗留 330、357，v0.50.0 起）

带一个 goal 迁移（`0003_goal_cancelling`），随 `apply-release.sh` 的迁移步骤自动应用；没有新环境变量、不改 compose、无单独主机步骤。

- **迁移做什么**：照 goal 0001 重建触发器函数 `step_runs_status_guard`，只多拒绝一种情况（GoalRun 在 `cancelling` 时步骤不能从 `waiting` 回到 `running`）。goal 表在主机上是空的，耗时可以忽略。
- **新的后台负载**：对账周期（默认 60 s）多一条查询，扫描 `cancelled` 且 `cleanup_pending` 的 GoalRun。GO5 开放能力之前库里没有 GoalRun。
- **goal 之外的行为变化**：排水器遇到队首在读与开始之间被撤回或被别处开始时重读队列继续，不再结束本轮（遗留 330）；目标步骤下的 Worker 在步骤关闭后发起 `request_action` 或嵌套 `invoke_worker` 得到 409 并留一条拒绝审计；目标步骤下的嵌套子 Task 先用目标空闲余量，不够时从调用方 Task 的预算里分（审计 `task.budget_handed_down`）。目标之外的调用都不受影响。
- **回滚**：只回退代码即可（§6）。上一版没有取消路径，永远不会碰到这个拒绝。

### 3.36 目标的修订与 hold（#633，goal 0004，S11 GO3b，遗留 356、364，v0.50.0 起）

带一个 goal 迁移（`0004_goal_revision_hold`），随 `apply-release.sh` 的迁移步骤自动应用；没有新环境变量、不改 compose、无单独主机步骤。

- **迁移做什么**：`goal_runs` 加三列（`paused_by`、`paused_by_authority`、`advance_failures`，可空或有默认值），`plan_revisions` 加一列（`removals`，默认 `{}`），四个约束，照 goal 0002 重建 `goal_runs_status_guard`（只多 hold 一段）。goal 表在主机上是空的，耗时可以忽略。
- **新的后台负载**：残留清理扫描改按 `id` keyset 取（走主键）；对账扫描多一个 `exists` 条件（superseded 步骤的活 Task），条件 (a)、(b) 多一个子查询，都走 GoalRun 的索引。GO5 开放能力之前库里没有 GoalRun。
- **goal 之外的行为变化**：无（`withdrawStepActions` 多一个可选参数，取消路径不传，行为不变）。
- **回滚**：只回退代码即可（§6）。上一版不写新列，两列为空时守卫和 CHECK 都接受。

### 3.37 动作的去重与人工核对（#642，governance 0023，S11 GO3c，v0.50.0 起）

带一个 governance 迁移（`0023_action_request_reconciliation`），随 `apply-release.sh` 的迁移步骤自动应用；没有新环境变量、不改 compose、无单独主机步骤。

- **迁移做什么**：`action_requests` 加三列（`reconciliation`、`reconciliation_decision_id`、`reexecute_decision_id`，可空、不回填），四个 CHECK、两个指向 `decisions` 的外键，一个守卫触发器 `action_requests_reconciliation_guard`（`before insert or update of …`）。加 CHECK 与外键时会扫一遍 `action_requests`（新列全为空，扫描期间该表写入等待），窗口前只读看一眼它的行数即可。
- **goal 之外的行为变化**：目标步骤之外的 `request_action` 不变（GO5 开放能力之前库里没有 GoalRun）；I6 不变量检查不再把不带 `resultingStatus` 的审计行当转移，少报一类违规。线上契约只新增可选字段 `reconciliation`。
- **回滚**：只回退代码即可（§6）。上一版用显式列清单读写 `action_requests`，看不到新列；CHECK 对三列为空的旧行恒真；触发器放行三列为空的插入，更新只在写这三列时触发。

### 3.38 门宿主实例的系统接入包（#644，S11 P1 第一个小 PR，无迁移，v0.50.0 起）

没有迁移、没有新环境变量、不改 compose。主机上已有的门宿主实例都在通用接入包上，不受影响。

- **新能力参数与错误码**：`create_gate_instance` 多可选的 `connector`；新增 409 `connector_kind_mismatch`、`connector_packaged`（创建时）与 `connector_not_packaged`、`connector_kind_mismatch`（announce 时，操作者在门日志的 warn 里看到）；新平台审计动作 `connector.created`。
- **打包门的 announce 现在也会被拒**：没冻结的打包门（不是 `enabled` / `disabled`，也不是由这两种状态转成的 `lost`）的 `GATE_CONNECTOR` 用了通用名（`http` / `mcp` / `cli` / `ssh`）或门宿主接入包时返回 `connector_not_packaged`，接入包是别的种类时返回 `connector_kind_mismatch`；被拒之后它停止心跳、变成 `lost`。已启用或禁用的打包门是冻结的，不受影响。

**维护窗口前**（在当前版本上跑，只读，主机执行；结果记 `docs/private/`）：找出会被拒的打包门。

```bash
docker compose exec -T postgres psql -U nexttime -d nexttime -c "
begin transaction read only;
select g.gate_id, g.status, g.status_before_lost, g.connector, g.transport_kind,
       c.kind as connector_kind, c.packaged
  from gate_instances g join connectors c on c.name = g.connector
 where not g.hosted
   and not (g.status in ('enabled','disabled')
            or (g.status = 'lost' and g.status_before_lost in ('enabled','disabled')))
   and (not c.packaged or c.kind <> g.transport_kind)
 order by g.gate_id;
rollback;" </dev/null
```

空表表示不受影响。不为空时，先在主机 `.env` 里把对应打包门的 `GATE_CONNECTOR` 改成系统自己的名字，再升级。这些实例本来就进不了目录（通用名不能设为平台预置），改名不影响任何工作区。

**窗口内：内核与门宿主同版**。两者由同一个 `docker compose up -d` 拉起，`gate-host` 还 `depends_on` 内核 healthy，正常走完 apply 就是同版：

- apply 最后一行不是 `RESULT failed-at=up` 时，再用 `docker compose ps kernel gate-host` 确认两个服务都是本窗口新建的、healthy。
- 最后一行是 `RESULT failed-at=up` 时，修好重跑之前，不要在控制台新建挂系统接入包的实例。
- 万一混版，两个方向都安全：先升内核、门宿主还是旧版时，已有实例照常服务；这段时间新建的挂系统接入包的实例会被旧门宿主以通用名 announce、被拒 409 `identity_mismatch`，停在「等待宿主接管」，门宿主每轮一行 warn，门宿主升级后下一轮拉取（默认 60 s 内）自动接管。先升门宿主、内核还是旧版时，列表里没有接入包字段，门宿主回落到通用名，与旧版行为一致。

**回滚**：这里只说只回退代码（§5 / operations.md 的做法）；用窗口前的备份整库恢复时，这些实例随备份一起消失，没有这个风险。

- 一旦有实例挂在系统接入包上，就不要回退到本 PR 之前的版本。必须回退时，先只读列出受影响的实例：

  ```sql
  select gate_id, status, connector from gate_instances
   where hosted and connector not in ('http','mcp');
  ```

- 再删除这些实例（有工作区启用的，删除会被拒 409 `gate_in_use`，要先解除链接），回退后在通用接入包下重建。
- 不这样做的话，旧版里这些实例会失去对应：还没被接管的，旧门宿主 announce 通用名被拒；已接管还没启用的（`discovered`），旧内核按 announce 把它改挂到通用接入包，通用接入包不是平台预置时它在目录里看不到，回退后在通用接入包下删了重建；已启用或禁用的，announce 身份不符，旧内核保留原记录、健康度置为 unknown。接入包这一行留在库里，旧控制台把它显示为「通用」类型，无害。挂在通用接入包上的实例不受影响。

### 3.39 平台核对观察（#649，governance 0024，S11 GO3d，v0.50.0 起）

带一个 governance 迁移（`0024_action_request_reconcile_checks`），随 `apply-release.sh` 的迁移步骤自动应用；不改 compose、无单独主机步骤；窗口前只读检查：无。

- **迁移做什么**：新表 `action_request_reconcile_checks`（两个部分索引），重建守卫 `action_requests_reconciliation_guard`（`decided_by` 为空的分支收窄为平台的 `effect_seen`，必须引用同一 Source 上判定式满足的 Observation）。GO3c（governance 0023，同属下一版）写的结论都是人的、带 `basis = 'person'`，重建后的守卫照旧接受；0023 下写不出 `decided_by` 为空的结论，收窄不会让已有行失效。
- **新后台定时器**：每 5 秒一轮，只在 GoalRun 运行且有到期检查时调门。
- **新增两个可选环境变量**（kernel 的 env_file，即主机 `.env`）：`GOAL_RECONCILE_CHECK_MAX_ATTEMPTS`（默认 5）、`GOAL_RECONCILE_CHECK_MAX_DURATION_MS`（默认 900000，15 分钟），正整数，不设即用默认值，主机 `.env` 不需要改。两个上限同时生效、先到先停，目标的墙钟预算也照样封顶，所以不另设最大值。
- **回滚**：只回退代码即可（§6）。上一版不读写新表。**代码回退到上一版后，apply-release 的 observations-compaction 步骤会报 degraded**：上一版的压缩看到 0024 指向 `observations` 的新外键就拒绝运行（安全失败，不删任何东西），重新应用带 0024 的版本后恢复；回退期间这一条 degraded 可以忽略。

### 3.40 变更计划核心：模块安装与升级记段（#650，governance 0025，S11 P1-A，v0.50.0 起）

带一个 governance 迁移（`0025_change_segments`），随 `apply-release.sh` 的迁移步骤自动应用；没有新环境变量、不改 compose、无单独主机步骤。

- **迁移做什么**：新表 `change_segments`、`change_items`，带守卫、RLS 和授权（应用角色对两张表无 DELETE）。只加新表，不改已有表和数据。
- **新错误码**：400 `change_confirmation_required`（`install_module` / `upgrade_module` 遇到内容扩大授权的模块，现有模块都不会触发）；409 `change_plan_changed`（P1-B 的包能力才会返回给调用方，本版能力碰不到）。
- **新审计**：动作 `change_item.apply`、资源类型 `change_item`；每次模块安装或升级多一条，建工作区时每个默认模块也多一条（通道 `platform`）。
- **行为变化**：一个工作区里，模块所在本体族的当前版本如果是人工定制的、声明了 ActionType，对这个模块的 `upgrade_module` 会被拒（400 `change_confirmation_required`），原来带 `confirm: true` 会直接覆盖。
- **窗口前只读检查（可选，结果记 `docs/private/`）**：列出当前版本声明了 ActionType 的本体族；空表就是不受影响，不为空只影响对这些族的模块升级。

  ```bash
  docker compose exec -T postgres psql -U nexttime -d nexttime -v ON_ERROR_STOP=1 <<'SQL'
  begin transaction read only;
  select v.workspace_id, v.id, v.version, jsonb_array_length(v.definition -> 'actionTypes') as action_types
    from ontology_versions v
   where v.status = 'published'
     and jsonb_typeof(v.definition -> 'actionTypes') = 'array'
     and jsonb_array_length(v.definition -> 'actionTypes') > 0
     and v.version = (select max(v2.version) from ontology_versions v2
                       where v2.workspace_id = v.workspace_id and v2.id = v.id
                         and v2.status = 'published')
   order by v.workspace_id, v.id;
  rollback;
  SQL
  ```

- **回滚**：只回退代码即可（§6）。新表留在库里，旧代码不读也不写，模块安装照旧工作；之后再升级回来，回退期间装的版本溯源显示 `provenance_unknown`，这是预期。

### 3.41 目标验收（#664，goal 0005，S11 GO4a，v0.50.0 起）

带一个 goal 迁移（`0005_goal_acceptance`），随 `apply-release.sh` 的迁移步骤自动应用；不改 compose、无单独主机步骤；窗口前只读检查：无。

- **迁移做什么**：新表 `goal_acceptance_checks`（守卫、RLS，应用角色无 DELETE），新列 `goal_runs.outcome_decision_id`，重建 `goal_runs_status_guard`（在 goal 0004 基础上加 I-G5：得到 `achieved` 只能经验收检查全过或请求人本人批准的 Decision）。
- **新后台定时器**：每 5 秒一轮，只在目标处于 `verifying` 且有到期检查时调门。
- **新增两个可选环境变量**（kernel 的 env_file，即主机 `.env`）：`GOAL_ACCEPTANCE_CHECK_MAX_ATTEMPTS`（默认 5）、`GOAL_ACCEPTANCE_CHECK_MAX_DURATION_MS`（默认 900000，15 分钟），正整数，不设即用默认值，主机 `.env` 不需要改。
- **新指标**：`nexttime_invariant_violations{invariant="I-G5"}`，升级后应为 0；不为 0 说明守卫缺失或被禁用，或有不经验收得到 `achieved` 的目标，先停下查。
- **回滚**：只回退代码即可（§6）。上一版不读写新表与新列。**代码回退到上一版后，apply-release 的 observations-compaction 步骤会报 degraded**：上一版的压缩看到 0005 指向 `observations` 的新外键就拒绝运行（安全失败，不删任何东西），重新应用带 0005 的版本后恢复；与 §3.39 同类，回退期间这一条 degraded 可以忽略。

### 3.42 步骤验收（#670，goal 0006，S11 GO4b，v0.50.0 起）

带一个 goal 迁移（`0006_step_acceptance`），随 `apply-release.sh` 的迁移步骤自动应用；没有新环境变量（沿用 §3.41 的 `GOAL_ACCEPTANCE_CHECK_*`）、不改 compose、无单独主机步骤；窗口前只读检查：无。

- **迁移做什么**：扩大 `step_runs.waiting_reason` 的 CHECK（加 `acceptance`、`acceptance_unavailable`），新表 `step_acceptance_checks`（守卫、RLS，应用角色无 DELETE），新触发器 `step_runs_acceptance_guard`（声明了验收的步骤只能经验收全过才成功）。
- **I-G5 指标**：§3.41 的 `nexttime_invariant_violations{invariant="I-G5"}` 现在也覆盖步骤验收，升级后仍应为 0。
- **回滚**：只回退代码即可（§6）。上一版不读写新表。**代码回退到上一版后，apply-release 的 observations-compaction 步骤会报 degraded**（与 §3.39、§3.41 同类，重新应用带 0006 的版本后恢复，回退期间可以忽略）。上一版遇到停在 `waiting(acceptance)` 的步骤会推进失败，连续失败后目标暂停等人，不会未经验收就成功。

### 3.43 能力包（#668，S11 P1-C，v0.50.0 起）

没有迁移、没有新环境变量、不改 compose、无单独主机步骤；窗口前只读检查：无。

- **镜像变化**：内核镜像多了 `/app/packs`（`PACKS_DIR=/app/packs` 由镜像设定），能力包清单改由它提供，取代已删除的 `ontology/modules.yaml`。**`kernel.env` 不要设 `PACKS_DIR`**，否则会覆盖镜像里的目录。加模块新版本改为写 `packs/<name>/<version>/pack.yaml`（`operations.md` §14）。
- **新能力与错误码**：`list_packs`、`preview_pack_install`、`install_pack`；404 `pack_not_found`、409 `version_changed`。模块相关能力的线上契约不变。
- **注册表整体校验**：`packs/` 里任何一处不合规，整份能力包注册表都会被拒（不半装），症状与处理见 `operations.md` §14。镜像里的 `packs/` 随版本发布，正常升级不会遇到。
- **回滚**：只回退代码即可。安装状态和摘要都不入库、每次现算，所以摘要格式改成 `contentDigest` 对已有工作区透明。

### 3.44 事实判定式（#674，core 0046 + goal 0007，S11 GO4c，v0.50.0 起）

带两个迁移（`core/0046_activity_trigger_record`、`goal/0007_fact_acceptance`），随 `apply-release.sh` 的迁移步骤自动应用；没有新环境变量、不改 compose、无单独主机步骤；窗口前只读检查：无。

- **core 0046**：Activity 的 `kind` 与 `metadata.triggeredByTaskId` / `metadata.actionRequestId` 写入后不能再改（守卫）；其他元数据键照旧可写。上一版从不改这些。
- **goal 0007**：两张检查表加 `fact_check`、`fact_id`（外键指向 `links`）和新 kind；重建三个守卫，其中目标级检查从此绑定到计划声明，按检查达成要求声明的每一项都在最新一轮；新增四个函数。
- **I-G5 指标**：§3.41 的 `nexttime_invariant_violations{invariant="I-G5"}` 现在也覆盖事实检查与「按计划声明」两个条件，升级后仍应为 0。
- **回滚**：只回退代码即可（§6），两个迁移都可逆，不需要 `reversibility-deltas.json` 条目。上一版不读写新列，也不写事实检查行；它写目标级检查行时本来就按计划声明建行，新的绑定规则不挡它。回滚后留下的 pending 事实检查不会被上一版领取，所在目标或步骤一直等待；上一版读到带事实检查的计划会视为不可读并暂停目标；什么都不会被判达成。

### 3.45 能力包可带 Skill 与 Worker（#679，governance 0026，S11 P1-D，v0.50.0 起）

带一个迁移（`governance/0026_change_item_worker_kinds`），随 `apply-release.sh` 的迁移步骤自动应用；没有新环境变量、不改 compose、无单独主机步骤。

- **窗口前只读检查**：查工作区里有没有同名的已发布 Skill：

  ```sql
  select workspace_id, name, count(distinct id) from skills where status = 'published' group by 1, 2 having count(distinct id) > 1;
  ```

  有结果不阻塞升级，但升级后这些名字再发布新版本会得到 409 `skill_name_conflict`；按 `operations.md` §14 在「Skill」页停用多余的那个。
- **governance 0026**：只改 `change_items` 的 kind 约束（加 `skill_version`、`worker_definition_version`），无数据改写。
- **镜像变化**：`/app/packs` 新增 `ops-base` v1（Skill `docker-triage`、Worker `ops-runner`），随内核镜像重建生效；`ops-assets` v1 / v2 的 notes 改为单行，这两个版本的清单摘要随之改变。摘要只记在安装记录上作出处，不参与状态判断，不需要任何操作；在旧构建上预览、新构建上安装会得到一次 `change_plan_changed`，重新预览即可。
- **新错误码**：409 `skill_name_conflict`（`details.skillName`）；`publish_skill` 现在拒绝与已发布 Skill 同名的发布。
- **回滚**：只回退代码即可（§6）。0026 只放宽约束、可逆，上一版不读 `change_items`（0025 同一版新增）；回滚后已安装的 Skill / Worker 版本留在原处、照常可用，只是没有能力包页面去撤销它们。

### 3.46 安装记录核验与 Operation 改动项（#690，governance 0027，S11 P1-E1，v0.50.0 起）

带一个迁移（`governance/0027_change_item_operation_kind`），随 `apply-release.sh` 的迁移步骤自动应用；没有新环境变量、不改 compose、无单独主机步骤。

- **governance 0027**：只改 `change_items` 的 kind 约束（加 `operation_version`），无数据改写。
- **镜像变化**：`/app/packs` 新增 `ops-base` v2（内容同 v1，写明要用到 docker），随内核镜像重建生效。
- **新行为**：装或升级能力包后，内核以安装人身份自动核验一次，对包要用到的系统的门做一次健康探测（与 `get_gatekeeper` 同一请求，不新开带凭据的调用）；核验出错只记日志，安装照样成功。
- **新错误码**：409 `change_segment_superseded`（`details.supersededBy`）、429 `change_verification_cooldown`（`details.retryAfterSeconds`）；新审计事件 `change_segment.verify`。
- **回滚**：只回退代码即可（§6）。0027 只放宽约束、可逆，上一版不读 `change_items`（0025 同一未发版系列新增）；回滚后经改动项发布的 Operation 版本留在原处、照常生效，只是没有安装记录页面去撤销或核验它们。

### 3.47 Decision 只给看得到它主体的人看（#700，governance 0028，S11 W1 GO5c 前小 PR C，v0.50.0 起）

带一个迁移（`governance/0028_decision_subjects`），随 `apply-release.sh` 的迁移步骤自动应用；没有新环境变量、不改 compose。

- **governance 0028**：`decisions` 加主体五列与触发器 `decisions_subject`，回填已有行（压测 20 万行 5.8 s），RLS `decisions_visibility` 加对话与冲突两条规则。
- **窗口前只读检查**（结果记 `docs/private/`）：

  ```sql
  -- 1. 回填要处理的总行数
  select count(*) from decisions;
  -- 2. 每类受管 Decision 的行数
  select a.kind, count(*)
    from decisions d join activities a on a.workspace_id = d.workspace_id and a.id = d.activity_id
   where a.kind in ('governance.approval_decision', 'governance.reconcile_decision',
                    'goal.outcome_decision', 'epistemic.conflict_resolution')
   group by a.kind;
  -- 3. rationale 里点名了请求 / 目标 / 冲突的行（找不到主体时只给 owner 看）
  select count(*) from decisions
   where jsonb_typeof(rationale) = 'object' and rationale ?| array['actionRequestId', 'goalRunId', 'conflictId'];
  -- 4. 私聊里的 Decision（升级后只有私聊的主人看得到，owner 也看不到）
  select count(*) from decisions d
    join activities a on a.workspace_id = d.workspace_id and a.id = d.activity_id
    join chats c on c.workspace_id = a.workspace_id and c.id = a.chat_id
   where c.visibility = 'private';
  ```

- **NOTICE**：迁移结束打印 `governance 0028: <kind>: N with their subject, M without; …; K Decision(s) in all read by the workspace owner only (…); C Decision(s) of a conversation`。每类 `without` 应为 0（不为 0 说明那些请求、目标或冲突已经找不到，它们只给 owner 看）；`K` 是全部 `subject_unresolved`；`C` 应等于检查 4 加上共享对话里的 Decision 数。
- **窗口后核对**：

  ```sql
  select d.id, a.kind, d.created_at, d.rationale
    from decisions d join activities a on a.workspace_id = d.workspace_id and a.id = d.activity_id
   where d.subject_unresolved
   order by d.created_at desc;
  ```

- **新行为**：成员读不到看不到的请求、目标、私聊与冲突上的 Decision（列表里没有、单条 404）；auditor 的 `export_prov` 按普通成员规则过滤；被裁决作废的 Fact 的作废原因只写哪个冲突、怎么裁的。owner 从此也看不到别人私聊里的 Decision。
- **回滚**：只回退代码即可（§6）。上一版不读新列，触发器在它的插入上照样填主体，回滚再升级不会留下没有主体的 Decision；上一版的读面只因两条 RLS 规则变窄（别人私聊里的 Decision、看不到的 Conflict 的裁决）。

### 3.48 pi 白名单启动（#698，遗留 422，S11 W3，v0.50.0 起）

无迁移；worker-supervisor 与 worker-runtime 镜像随本版一起应用。

- **应用**：`apply-release.sh` 本身会构建或拉取 worker-runtime 并重打 tag，不要另跑 `build-images.sh`。应用后核对，输出应为 `2`：

  ```bash
  docker image inspect nexttime-ai-worker-runtime --format '{{index .Config.Labels "ai.nexttime.runtime-contract"}}'
  ```

- **应用过程中**：拉完镜像、还没重启服务的这段时间，旧 supervisor 新起的入口容器会以 `check=models_json result=fail reason=empty_mount` 退出，维护窗口内可以接受。
- **入口容器收敛**：已在跑的入口容器下一轮对话会自动重建（旧布局容器没有 `nexttime.runtime-contract` label）。想立刻收敛，在运行层页点「现在重建」（`roll_entry_containers`）；返回 `skipped_in_flight` 的，等那一轮结束后再点一次。
- **应用后核对**（`host-worker-runtime.md` §6）：只在应用之后新建的容器上做，旧容器两项都不会通过、不说明是本版的问题。
  - 日志里有 `check=models_json result=ok` 和 `check=pi_resource_discovery result=off`；
  - `Binds` 恰好三条；
  - 写入探针三条都报 `Read-only file system`。
- **固定旧 tag 的情况**：活动镜像如果被手动设成固定的旧 tag，运行层页会标出「不兼容」并提示换哪个镜像；在换之前新起的容器都会被 409 `runtime_image_incompatible` 拒绝。
- **回滚**：只能整版做，代码、镜像、worker-supervisor 一起回滚。只回滚运行时镜像（`pi-0.99.2` 等 422 之前的镜像）会被拒绝；只回滚 supervisor，新容器会以 `empty_mount` 退出。到下一次 pi 升级之前都是这样。
- **排障**：发生 409 时要看的日志见 `operations.md` §13 的排障行。
- **窗口前只读清点**（结果记 `docs/private/`，不删）：

  ```bash
  find "${NEXTTIME_DATA}/workspaces" -maxdepth 5 \( -name AGENTS.md -o -name CLAUDE.md -o -name SYSTEM.md \
    -o -name APPEND_SYSTEM.md -o -name mcp.json -o -name .mcp.json \
    -o \( -type d -path '*/.pi/*' \( -name extensions -o -name skills -o -name prompts \) \) \) -print
  ```

  `.pi/agent/skills/`、`.pi/agent/settings.json`、`.pi/agent/models.json` 是旧版平台自己写的（已发布的 Skill 和设置），不是智能体写的，要单独列出。清点出的这些文件从此不再生效。
- **新错误码与 wire**：409 `runtime_image_incompatible`（supervisor 起容器；内核设为活动、回滚、滚动重建）；`RuntimeImageWire` 新增 `runtimeCompatible`。

### 3.49 包里的 Worker 按系统类型绑定工作区的门（#705，S11 P1-E2a，v0.50.0 起）

无迁移；没有新环境变量、不改 compose、无单独主机步骤。

- **镜像变化**：`/app/packs` 新增 `ops-base` v3（Worker `ops-runner` 写明 `systems: [docker]`），随内核镜像重建生效。
- **新行为**：装或升级能力包时，包里写了 `systems` 且还没有门的 Worker 绑到工作区这几类系统已接入的门（审阅框可逐个取消）；工作区给 Worker 设的门和模型在升级时原样保留。已装 v1 / v2 的工作区升级到 v3 时，`ops-runner` 若已有门不受影响。
- **新错误与参数**：`preview_pack_install` / `install_pack` 新可选参数 `workerGates`，不在候选里的门 400 `invalid_params`，审阅后门有变化 409 `change_plan_changed`；需求状态去掉 `can_connect`。
- **回滚**：只回退代码即可。上一版不认识 Worker 的 `systems`（已发布的 Worker 版本里没有这个字段，它只在包清单里），本版绑上的门留在 Worker 版本里照常生效。

### 3.50 入口 agent 替人提议目标（#704，goal 0008，S11 GO5c，v0.50.0 起）

带一个迁移（`goal/0008_goal_idempotency_key`），随 `apply-release.sh` 的迁移步骤自动应用；不改 compose。

- **goal 0008**：`goal_runs` 加可空列 `idempotency_key` 与两个部分唯一索引，不回填，`idempotency_key is null` 的行两个索引都不收。窗口前只读检查：`select count(*) from goal_runs;`（建索引的行数，预期很小）。
- **新环境变量（可选）**：`GOAL_MAX_PROPOSED_PER_REQUESTER`，每个请求人同时等待确认的目标上限，默认 5，正整数；写错（0、负数、小数、非数字）内核启动失败并说明原因。
- **新行为与错误码**：新能力 `propose_goal`（服务账号、agent 主体发起 403，`issue_service_handle` 不再签它），超出上限 409 `proposed_goal_limit`（`details.limit` / `details.proposed`）；`revise_goal` 拒收带凭据或 `[redacted]` 的计划与理由（400 `credentials_in_text` / `redacted_text_submitted`，带位置），原样提交的调用当作没改；入口 Handle 可以读自己代表的人的目标。
- **回滚**：只回退代码即可（§6）。上一版不知道这一列，插入时它是 NULL，两个索引都不管；`goal_runs_status_guard` 不允许改这一列。

### 3.51 Operation 治理字段收敛到同一套分类器（#710，S11 P1-E2b，v0.50.0 起）

无迁移；没有新环境变量、不改镜像与 compose、无单独主机步骤。

- **新行为**：门宣告里的 `await_decision`、`reads` / `writes` 和三个 MCP 提示变了时，对齐预览会列出、按放宽或收紧确认，对齐会原地写进已发布的 Operation（宣告里去掉的提示被删掉）；之前这些变化被静默丢掉。自连门的放宽照旧走修订草稿。`read_only_hint` 任何改动都按放宽确认。
- **应用后第一次对齐**：平台门上已有的 Operation 若与门当前宣告在这几个字段上不一致，「集成」页与对齐预览会第一次显示这些差异；按确认框逐项看后再对齐，这是预期的，不是回归。
- **回滚**：只回退代码即可。这几个字段本来就是 Operation 定义的一部分，上一版照常读取本版写入的值；上一版只是不再比较和写入它们。

### 3.52 接入预设，首个 RAGFlow（#715，S11 P1-F1，v0.50.0 起）

无迁移；不改 compose 与 `.env`。内核镜像新增 `/app/connectors` 与 `CONNECTOR_PRESETS_DIR=/app/connectors`（镜像内自带，不需要主机配置），内核与门宿主同版本发布。

- **窗口前只读检查**（结果记进 `docs/private/`）：看 `connectors` 里 `ragflow` 这一行，**不要**用「`gatekeeper-ragflow` 在不在跑」判断：

  ```bash
  docker compose exec -T postgres psql -U nexttime -d nexttime -c "
  begin transaction read only;
  select c.name, c.packaged, c.mode,
         (select count(*) from gate_instances g where g.connector = c.name) as instances
    from connectors c where c.name = 'ragflow';
  rollback;" </dev/null
  ```

  判读：空表时预设可用；`packaged = t` 时预设显示「已由打包的门接入」，这是预期，不要为了用预设去动打包门（退役见遗留 448）。
- **新行为**：平台管理员可在「平台 · 集成」按 RAGFlow 预设建门宿主实例（只填地址，无 `document.upload`）；已按预设接入后不要再启用打包门（409 `connector_not_packaged`）。自签证书的 RAGFlow 继续用打包门，**不要**给 `gate-host` 设 `GATE_TLS_CA_FILE` / `GATE_TLS_SERVERNAME`（会替换门宿主所有实例的信任，遗留 450）。步骤见 host-gatekeepers.md §14.4。
- **回滚**：回滚前先只读查：

  ```sql
  select gate_id from gate_instances where hosted and definition ? 'preset';
  ```

  为空照常回滚。非空时先 `docker compose stop gate-host`，再回滚其余服务，最后启动旧版 `gate-host`：新版门宿主一旦从旧内核拉定义，会把预设实例当作已删除并清掉它的凭证目录，升回来就要重新录入 RAGFlow 的 API key。整库恢复不受影响。回滚期间在旧版删除预设实例会留下孤儿凭证目录（遗留 451）。

### 3.53 步骤之间的数据交接与返工一次（#716，task 0008，S11 GO5d-1，v0.50.0 起）

带一个迁移（`task/0008_task_output_contract`），随 `apply-release.sh` 的迁移步骤自动应用；没有新环境变量或服务，不改 compose。Worker 扩展（platform-extension）有改动，worker-runtime 与内核同版本发布。

- **task 0008**：`tasks` 加三列 nullable jsonb `output_schema`、`rejected_output`、`rework_of`，不回填；三条 CHECK（`tasks_output_schema`、`tasks_rejected_output`、`tasks_rework_of`）与触发器 `tasks_output_contract_immutable`（`output_schema` 与 `rework_of` 写入后不再改）。已有行三列都是 NULL，CHECK 对它们成立。窗口前只读检查：`select count(*) from tasks;`（加约束时扫描的行数）。
- **新行为与错误码**：有输出约定的步骤，`report_task_result` 不合格时返回 400 `invalid_params`（`details.problems`，只给位置）；步骤第一次 `no_result` 自动返工一次，不再立刻暂停 `needs_decision`（已有目标的步骤也一样）；WS 通道上报告格式错误现在是 `INVALID_PARAMS`（之前落成 internal error）。没有 `outputSchema` / `bindings` 的步骤其余行为不变。
- **应用后检查**：`select conname from pg_constraint where conname like 'tasks_%output%' or conname = 'tasks_rework_of';` 应列出三条约束。
- **回滚**：只回退代码即可（§6），worker-runtime 与内核一起回退。上一版插入和查询 `tasks` 都写明列名，看不到这三列；它对 Task 的更新（状态、结果、token）不碰触发器保护的列。

### 3.54 knowledge 能力包 v1 与能力包依赖（#721，S11 P1-F2，v0.50.0 起）

无迁移；没有新环境变量，不改 compose，无单独主机步骤。

- **镜像变化**：`/app/packs` 新增 `knowledge` v1（依赖 ops-assets v2 与 RAGFlow），随内核镜像重建生效。
- **新行为与错误码**：能力包可以声明依赖别的能力包；依赖没满足时 `install_pack` 返回 409 `pack_dependency_unmet`，什么也不写；核验新增依赖检查，已有核验记录读出来依赖为空，不受影响。knowledge 要先装 ops-assets v2，并需要工作区已接入 RAGFlow（打包门或 §3.52 的预设实例）。步骤见 operations.md §14.9。
- **回滚**：只回退代码即可。上一版不认识 `requires.packs`，但它的 `packs/` 里也没有 knowledge，已装的 knowledge 留下的 Skill 与 Worker 版本照常存在；核验记录里多出的 `dependencies` 键上一版不读。

### 3.55 Procedure 成为计划模板（#722，goal 0009 + worker 0005，S11 GO5d-2，v0.50.0 起）

带两个迁移（`goal/0009_plan_revision_source`、`worker/0005_procedure_parameters`），随 `apply-release.sh` 的迁移步骤自动应用（goal 模块先于 worker）；没有新环境变量或服务，不改 compose。

- **goal 0009**：`plan_revisions` 加 `source_procedure_id`、`source_procedure_version` 两列，不回填；CHECK 两列同有同无、只能出现在第 1 版上；`plan_revisions_guard` 写入后不可改。
- **worker 0005**：`procedures.parameters jsonb`（必须是对象），不回填；用 `create or replace` 替换流程发布后不可改触发器的函数体，覆盖这一列；外键 `plan_revisions (workspace_id, source_procedure_id, source_procedure_version) → procedures` 与一个部分索引。
- **窗口前只读检查**：`select count(*) from plan_revisions;`、`select count(*) from procedures;`（加约束与外键时扫描的行数，预期很小）。已有计划版本没有来源、已有流程 `parameters` 为 NULL，约束对它们成立。
- **新行为与错误码**：`propose_goal` 可以用 `fromProcedure` 代替 `plan`；`publish_procedure` 对写了模板字段的流程，展开出的计划不通过时返回 400 `invalid_params`（`details.problems`），草稿不变；已有流程照常发布。`get_goal` / `get_goal_revision` 的计划版本加 `fromProcedure`，`list_procedures` 加 `parameters`。
- **回滚**：只回退代码即可（§6）。上一版不读写这些列，它提的流程 `parameters` 为 NULL，触发器多出来的比较对它没有影响；外键只约束非空的来源列。

### 3.56 RAGFlow `document.parse` 每次都要人批（#726，S11 P1-F，v0.50.0 起）

没有迁移、新环境变量或服务，不改 compose；只改 `ragflow` 门的清单（打包门与 RAGFlow 预设）。`document.parse` 从 `low`、可自动批准改为 `medium`、不可自动批准，因为重新解析会删掉文档原有的全部分块（含手工添加或编辑过的）。**已有部署不会自动收紧**，按下面三步做。详细步骤见 `docs/runbooks/host-gatekeepers.md` §13「升级后收紧 `document.parse`」。

- **窗口前（只读）**：用 `host-gatekeepers.md` §13 的查询列出部署了 `document.parse` 的工作区，结果记进 `docs/private/`。`gate_id` 为空的行是经旧注册路径或工作区自己接上的：前一种要先从平台目录接入再对齐。
- **平台采用新清单**：升级后，启用或禁用过的 `ragflow` 门（打包门和按预设建的实例）announce 出的新清单会挂起待采用。平台管理员在「平台 · 集成」打开它，核对变化只有 `document.parse` 的影响级（low → medium）和可否自动批准（是 → 否），确认采用。待采用期间调用不会被拒，照旧按旧分类执行。
- **每个启用了这扇门的工作区对齐一次**：所有者到「系统与授权」→ 这个系统 →「已部署 Operation 的治理字段」对齐。（#733 起，所有者在「系统与授权」的系统行上会直接看到「分类与平台最新清单不一致，需对齐」的提示，旁边就是「对齐」。）没对齐之前，这个工作区里的 `document.parse` 仍会自动批准。对齐不更新描述，已部署副本没有删除分块的提醒（遗留 457）。
- **对齐完成前的临时办法**：平台管理员可以在「平台 · 集成」→ `ragflow` 接入包的「允许调用的操作」里停用 `document.parse`，全部对齐后再恢复。
- **核对（只读）**：对齐后在「已部署 Operation 的治理字段」或 `list_operations` 里看到 `document.parse` 是 `medium`、不可自动批准。**不要用真实参数发 `request_action` 核对**：被批准就会删掉分块。要验证审批路径，`document_ids` 用不存在的 id，看到 `pending_approval` 后立即拒绝。
- **回滚**：无迁移，只回退代码（§6）。

### 3.57 WorkerRun 运行指纹（#730，task 0009，S11 W1a，v0.50.0 起）

带一个迁移（`task/0009_worker_run_fingerprint`），随 `apply-release.sh` 的迁移步骤自动应用；compose 有一处改动：worker-supervisor 新增 `${NEXTTIME_DATA:?}/models:/data/models:ro`（挂目录不挂文件；`models.json` 不含凭据）。没有新环境变量或服务。

- **迁移**：`worker_runs` 加 `run_spec`、`runtime_report`、`environment_digest` 三列与三个 CHECK、一个部分索引，触发器 `worker_runs_fingerprint_write_once`；不回填，已有运行读出「未记录」。
- **kernel 与 worker-supervisor 必须同版本**：旧 supervisor 不回报运行时，那一半记「未上报」，不报错；整版升级 / 回退即可。
- **窗口前只读检查**（#488 审查）：`ls -lnd "${NEXTTIME_DATA}/models" "${NEXTTIME_DATA}/models/models.json"`。期望目录 0755、属主 10001，文件对 10001 可读（通常 0644）。不可读时 spawn 照常，只是没指定模型的运行没有环境指纹。结果记进 `docs/private/`。
- **升级后检查**（#488 审查）：证明 supervisor 真能读到文件，下面两条输出的十六进制摘要应相同：
  ```sh
  docker compose exec -T worker-supervisor node -e "const c=require('crypto'),f=require('fs');console.log('sha256:'+c.createHash('sha256').update(f.readFileSync('/data/models/models.json')).digest('hex'))"
  sha256sum "${NEXTTIME_DATA}/models/models.json"
  ```
  之后跑第一个没指定模型的 Task，`get_task` 的 `workerRuns[].environment.runtime.modelsConfigDigest` 应是同一个摘要，`environmentDigest` 不为 null。云端预发只跑 fake 验收，按设计不报这个摘要，这条路径的第一次端到端证据只能在主机上拿到。
- **可比范围**：`environment_digest` 只在同一台主机内可比（`imageId` 是本机 Docker 解析出的 id），不要拿 staging 与主机的指纹比较。
- **回滚**：回退代码即可（§6）。上一版对 `worker_runs` 的 INSERT / SELECT 都列名、从不写这三列、也从不把运行退回 `provisioning`，CHECK 对它写的全 NULL 行成立；去掉 compose 的 `models/` 挂载随整版回退。

### 3.58 入口 agent 在对话里发起目标（#728，S11 GO5e-1，v0.50.0 起）

没有迁移、新环境变量或服务，不改 compose。

- **生效方式**：入口和 interactive 模式的五个目标工具（`propose_goal` 与四个读取）随这次发版的 worker-runtime 镜像生效；已有工作区立即可用（入口 Handle 的范围按角色算）。确认仍只在控制台「目标」页。
- **已有工作区的提示词**：模板里的「Goals」一节只写进新建的工作区；已有工作区的入口提示词要等遗留 145 的小 PR，在那之前靠 `propose_goal` 描述里的要点。
- **验收**：`scripts/accept_s2.sh` fake 模式多第 9 步，多跑一两分钟。验收脚本 fake 模式每次先按当前检出构建 fake-llm（镜像站 node 基础镜像加一层 COPY），主机上第一次跑会把一直沿用的旧 fake-llm 换成当前版本；`server.mjs` 每变一次留下一个悬空旧镜像，是否清理由操作员决定（遗留 460）。
- **回滚**：无迁移，只回退代码（§6）。

### 3.59 目标在发起它的对话里（#737，linkage 0003，S11 GO5e-2，v0.50.0 起）

带一个迁移（`linkage/0003`），随 `apply-release.sh` 的迁移步骤自动应用；没有新环境变量或服务，不改 compose、Dockerfile 或启动脚本。

- **迁移**：`pending_context_items.kind` 的 CHECK 加上 `goal_update`，只放宽，不动数据。窗口前只读检查：无新增。
- **新行为**：发起目标的对话里出现目标卡片与里程碑状态行，步骤 Task 出现在同一个对话里并标出是哪一步；入口 agent 下一轮在入口上下文里读到目标的变化。
- **验收**：`host-accept-s2.md` 多一条 `step9-goal-milestones` 的 PASS 行，随下一次发版窗口在主机上跑。
- **回滚**：回退代码即可（§6）。上一版读到 `goal_update` 行会把它和其他条目一样放进 `tasks` 那一组，不需要动数据。

### 3.60 目标记下启动参数（#745，goal 0010，遗留 454/455，v0.50.0 起）

带一个迁移（`goal/0010`），随 `apply-release.sh` 的迁移步骤自动应用；没有新环境变量或服务，不改 compose、Dockerfile 或启动脚本。

- **迁移**：`plan_revisions` 加可空列 `source_procedure_parameters jsonb` 和一个 CHECK（只能和 `source_procedure_id` 同时出现、必须是对象），不回填，之前的修订版保持 `null`。窗口前只读检查：无新增。
- **新行为**：用流程发起的目标在 `get_goal` / `get_goal_revision` 的 `fromProcedure` 上带启动参数（读面遮蔽）与请求人确认验收来自流程第几步；计划与流程里绑定取自自己或不存在的步骤时，提示直接说清楚。
- **回滚**：回退代码即可（§6）。上一版代码不读也不写这一列，不需要动数据。

### 3.61 已有工作区的入口定义对齐平台模板（#747，遗留 145，v0.50.0 起）

无迁移；没有新环境变量或服务，不改 compose、Dockerfile 或启动脚本。发版后镜像里新的 `ontology/entry-agent.yaml` 就是比对用的模板。

- **窗口后只读检查**：所有者在控制台目录 → Worker 看入口模板提示。主机工作区创建于之前的版本，预期显示「与这个平台版本自带的入口模板不同」。
- **不代为采用**：按模板生成草稿与发布都由所有者在控制台决定，窗口里不代为生成或发布。
- **回滚**：回退代码即可，不需要动数据；按模板发布的入口版本和手工发布的版本一样，是入口家族里的普通版本。

### 3.62 门确认不存在：声明与接收（#753，S11「门确认不存在」A，v0.50.0 起）

无迁移；不改 compose、Dockerfile 或启动脚本，门镜像随发版重建。

- **已有清单不受影响**：现有门清单没有 `absent_statuses` / `absent_exit_codes`，Operation 摘要不变，发版后行为不变。窗口前只读检查：无新增。
- **生效条件**：有人在门清单里给 observe 类 Operation 加上声明并重新发布，才会生效；声明会改摘要，按既有流程审核发布。
- **混跑**：门与内核必须同版本。老门或老内核遇到带声明的定义会因摘要不一致拒绝调用（409 `operation_definition_mismatch`），不会误判「不存在」；按 §3.27 单窗口一起升级即可。
- **回滚**：回退代码即可。回退前先确认没有发布过带声明的 Operation；若有，老版本不认识这两个字段，先发布不带声明的版本再回退。

### 3.63 观察型写入不能改写平台元本体对象（#759，安全修复，v0.50.0 起）

无迁移；不改 compose、Dockerfile 或启动脚本。主机 v0.46.0 上两条路径（`submit_observations`、门回写的 observedFacts）都在且没有元本体检查，所以**窗口前**先在当前版本上跑下面的只读 SQL（只读事务，结果记 `docs/private/`；正常应全部 0 行，E 除外）：

```sql
-- A. 被观察型写入碰过的元本体对象：这两条路径会设 last_observed_at，平台自己的写入从不设
select workspace_id, object_type, id, identity_key, created_at, updated_at, last_observed_at
from objects
where object_type in ('WorkerDefinition','Gatekeeper','Operation','Capability','Skill','Procedure')
  and last_observed_at is not null
order by last_observed_at;

-- B. 门回写指向元本体对象的 observed Link（覆盖 core/0026 之前、还没有 last_observed_at 的写入）
select l.workspace_id, l.id as link_id, l.created_at, t.object_type, t.id as object_id
from links l
join objects t on t.workspace_id = l.workspace_id and t.id = l.target_object_id
where l.link_type = 'observed'
  and t.object_type in ('WorkerDefinition','Gatekeeper','Operation','Capability','Skill','Procedure');

-- C. 形状不是平台写出来的元本体对象（只有外部写入会造出这种行）
select workspace_id, object_type, id, identity_key, created_at
from objects
where (object_type = 'Operation' and not coalesce(identity_key ?& array['gatekeeperId','name','version'], false))
   or (object_type = 'WorkerDefinition' and not coalesce(identity_key ?& array['definitionId','version'], false))
   or (object_type = 'Skill' and not coalesce(identity_key ?& array['skillId','version'], false))
   or (object_type = 'Procedure' and not coalesce(identity_key ?& array['procedureId','version'], false))
   or object_type = 'Capability';

-- D. result_mapping 指向元本体类型的已存 Operation（升级后过不了新的 OperationSchema，读写都会失败）
select workspace_id, id, identity_key from objects
where object_type = 'Operation'
  and properties->'result_mapping'->>'object_type' in
      ('WorkerDefinition','Gatekeeper','Operation','Capability','Skill','Procedure');

-- E. 已发布、可自动批准的 execute Operation（门摘要不覆盖这几个字段，遗留 482；由维护者逐条过目）
select workspace_id, id, identity_key, properties->>'blast_radius' as blast_radius,
       properties->>'await_decision' as await_decision, updated_at
from objects
where object_type = 'Operation' and properties->>'status' = 'published'
  and properties->>'mode' = 'execute' and properties->>'auto_approvable' = 'true';
```

- **A 或 B 有行**：逐行对照这个对象最近的受治理写入（`audit_records`，`payload->>'resourceRef'` 对得上），看 `updated_at` 之后有没有对应的动作。能就地改动已发布 Operation 的受治理动作有：`publish_operation`、`publish_manifest`、`enable_gate_instance`、`update_operation_description`、`refresh_operation_governance`、`deprecate_operation`、ChangePlan apply，以及发布新版本时把旧版本翻成 deprecated。没有对应动作的就是被改写过，由维护者决定处理（废弃后重新发布）。
- **盲区**：core/0026 之前、不带 link 的 `submit_observations` 写入从数据上追不出来；门会校验定义摘要，盲区里真正有风险的只剩摘要不覆盖的字段，所以 E 作为人工过目清单。
- **C 的误报**：identity 为 null 的 Operation 可能是 core/0016 以前的遗留行，先对照 0016 的回填再下结论；Gatekeeper 不列（早期登记的门可能带 identity）。
- **D 有行**：升级前先把这些 Operation 废弃或改正 `result_mapping` 再发布，否则升级后读写失败。
- **回滚**：回退到旧内核即失去这道收口，问题回到修复前；新内核不会自动恢复已被改写的行，要靠上面的核查。

### 3.64 已发布 Operation 由数据库守护（#765，遗留 482，v0.50.0 起）

带一个迁移（`core/0047_operation_version_guard`），随 `apply-release.sh` 的迁移步骤自动应用；只建两个触发器和两个函数，不改数据、不回填、不扫表。没有新环境变量或服务，不改 compose、Dockerfile 或启动脚本；门不用升级，门的定义摘要与审批结果都不变。

- **窗口前只读检查**：无新增。§3.63 的 A–E 照跑；如果 A / B 发现被改写过的已发布 Operation，要在升级**之前**按 §3.63 处理（废弃后重新发布）：升级后这一行不能再就地改回，只能走生命周期。
- **生效后**：离开草稿的 Operation 版本只能改 `status`（沿生命周期）、`description`，治理字段只能随同事务的 `operation.governance_refreshed` 审计改（`refresh_operation_governance`）。任何产品路径都不会触发拒绝；若在日志里看到这类拒绝（服务端错误），说明有代码路径在绕过受治理的动作，记 `docs/private/` 并报告。
- **混跑 / 回滚**：代码回滚到 v0.49.0 兼容，库不用恢复：v0.49.0 改 Operation 只走受治理的路径，它的 `refresh_operation_governance` 在同一事务里写同样的审计记录。可逆性探针里 v0.49.0 有 3 条绕过 handler 直接调 `refreshOperationGovernance` 的单元测试按设计失败，已在 `migrations/reversibility-deltas.json` 声明。
- **撤销 schema**（只在确需时，由维护者决定）：`drop trigger objects_operation_governance_audited on objects; drop trigger objects_operation_version_guard on objects; drop function objects_operation_governance_audited(); drop function objects_operation_version_guard();`
- 这道守护针对应用路径，不防数据库属主（属主能 `disable trigger`）。以后的迁移如果确实要改已发布行，要在迁移里显式处理并写明原因。

### 3.65 编辑已发布的 Skill / 流程 = 同族下一版本（#764，S11 W1a E2-0，遗留 48 ②，v0.50.0 起）

无迁移；没有新环境变量或服务，不改 compose、Dockerfile 或启动脚本；窗口前只读检查：无新增。

- **契约不向后兼容**：`publish_skill` / `publish_procedure` 新增必填参数 `draftDigest`（草稿行与 `propose_*` 结果都带它）。升级时浏览器里还开着的旧控制台页、以及不带这个参数的脚本，发布 Skill / 流程会得到 400 `invalid_params`（什么都不写），刷新页面即可。
- **新错误码**（发版说明照写）：409 `draft_changed`（版本号对、草稿内容已换）、409 `draft_pending`（族有待发布草稿，先发布或丢弃它）、409 `skill_name_changed`（Skill 新版本必须沿用族名）；WS 侧为 `ILLEGAL_TRANSITION`。
- **已有数据**：不改。`propose_*` 不带族 id 时照旧建新族；带族 id 才提议同族下一版本。
- **回滚**：回退代码即可，库不用恢复。回退后旧控制台的发布请求不带 `draftDigest`，旧内核照常接受。

### 3.66 门确认不存在 B-a：发布时由人确认（#757，S11，v0.50.0 起）

无迁移；不改 compose、Dockerfile 或启动脚本；窗口前只读检查：无新增。A（§3.62）和 B-a 都未发版，现有门清单没有「不存在」声明，所以发版后行为不变；有人在门清单里加了声明，发布时会被要求确认。

- **生效后**：带声明的 Operation 只能由人在目录里逐个确认后发布（`publish_operation` 带 `absentAnswersReviewed: true`）；`publish_manifest`、`enable_gate_instance` 会把这类草稿留下并在结果里列出（`absentAnswerDrafts`）。用服务账号 API key 登录控制台时勾选确认会被 403 拒绝，换人的账号操作。
- **回滚**：回退代码即可，库不用恢复。旧代码读 Operation 时会把 `absentAnswersReviewedBy` / `absentAnswersReviewedAt` 留在定义对象里，但线上 `OperationSchema` 解析丢掉未知键，门的调用摘要只取固定字段，不受影响；旧代码发布只翻状态，core 0047 照样放行。
- **再升级回来**：回滚期间发布的带声明版本没有确认，目录显示「没有人确认过」；B-b 合入后验收要求 Operation 带确认，这些版本要重新发布一次。

### 3.67 拒绝待审的 Skill / 流程草稿（#772，S11 W1a E2-0b，v0.50.0 起）

无迁移；没有新环境变量或服务，不改 compose、Dockerfile 或启动脚本；窗口前只读检查：无新增。

- **新能力**（发版说明照写）：`reject_draft`（人的通道，builder 起）：工作区所有者或该族在用版本的提议人可拒绝别人提议的待审 Skill / 流程草稿，原因必填并进审计；被拒的草稿行删除，族可以再提议下一版本。`draft_pending` 的提示写明可以先发布、丢弃或被拒绝。
- **契约**：只新增能力，向后兼容。
- **回滚**：回退代码即可，库不用恢复；回退后待审草稿又只能由提议者丢弃、所有者发布或 30 天清理。

### 3.68 按门确认不存在验收（#780，goal 0011，S11 B-b，v0.50.0 起）

带一个迁移（`goal/0011_absence_acceptance`），随 `apply-release.sh` 的迁移步骤自动应用：两张检查表的 kind / 形状 CHECK 收进新种类 `observe_absent`，两个 guard 和 `goal_runs_status_guard` 整体重定义，执行器的 due 索引带上新种类。没有回填：现有行都是 `observe_predicate`、`fact_predicate` 或 `requester_confirm`，新 CHECK 对它们都成立。没有新环境变量或服务，不改 compose、Dockerfile 或启动脚本；门不用升级。

- **窗口前只读检查**：无新增。只动 goal 模块自己的表和函数，云上 staging 跑迁移即可覆盖，没有主机专属步骤。
- **生效后**：删除、下线类目标可以让平台按门确认不存在来验收；所用 Operation 必须声明了「不存在」回答且由人确认后发布（§3.66），否则提计划或做检查时被拒（`absence_not_declared` / `absence_not_reviewed`）。
- **回滚**：上一个发布 v0.49.0 没有目标代码，不读写这些表，回退代码即可，库不用恢复。带 GO4 验收但不带本迁移的版本没有上过主机；假如中间有这样一个版本，它的扫描只认自己知道的种类，不会领取 `observe_absent` 行，计划 schema 读不了这种计划，推进时把目标停到 `needs_decision`，不会照着做；恢复要等回到本版本。
- 发版说明可写「删除、下线类目标可以让平台按门确认不存在来验收」。

### 3.69 被拒绝的草稿给到提议人；看不到的 Worker 定义族按不存在（#792，遗留 491 / 492，v0.50.0 起）

带一个迁移（`worker/0006_draft_rejections`），随 `apply-release.sh` 的迁移步骤自动应用：新表 `draft_rejections`（RLS 按工作区，`nexttime_app` 只有 select / insert），并从已有的 `reject_draft` 审计记录回填历史拒绝（名字取同族上一版本，重跑不重复插入）。没有新环境变量或服务，不改 compose、Dockerfile 或启动脚本。

- **窗口前只读检查（可选）**：`select count(*) from audit_records where action = 'reject_draft'`，迁移后与 `select count(*) from draft_rejections` 对照，应一致。
- **契约变化（发版说明照写）**：`propose_worker_definition{definitionId}` 的 `definitionId` 必须是调用方看得到的族，只有别人私有草稿的族与不存在的 id 一律 404 `not_found`，不再在调用方自选的 id 下新建族（省略 `definitionId` 仍新建；能力包安装不受影响）；`invoke_worker` 对别人私有的 Worker 定义草稿从 409 `not_published` 改为 404 `not_found`；`publish_procedure` 步骤引用、目标计划校验、`resolve_refs` 对别人的草稿同样按不存在回答；新能力 `list_draft_rejections`（人的通道，member 起）。
- **回滚**：回退代码即可，库不用恢复。旧代码不读不写新表，在新结构上照常运行，只是它做的拒绝不留记录。

### 3.70 「存在过」基线（#786，goal 0012，S11 B-c，v0.50.0 起）

带一个迁移（`goal/0012_absence_baselines`），随 `apply-release.sh` 的迁移步骤自动应用：新表 `goal_absence_baselines`（RLS，`nexttime_app` 只有 select / insert / update）、它的 guard、函数 `goal_absence_seen_before`，以及两张验收表上的 I-AB1 触发器。没有回填：B-b（goal/0011）没上过主机，不存在 pending 或 passed 的 `observe_absent`。没有新环境变量或服务，不改 compose、Dockerfile 或启动脚本；门不用升级。

- **窗口前只读检查**：无新增。
- **生效后**：删除类目标开工前平台先用同样的调用确认要删的东西在；参数写错、东西本来就不在时目标暂停交给请求人，不会被当成已经删掉。`get_goal` 的 `acceptance` 多一个只读字段 `absenceBaselines`。发版说明可写「删除类目标开工前平台先确认要删的东西在，参数写错不会被当成已经删掉」。
- **回滚**：上一个发布 v0.49.0 没有目标代码，不读写新表；**它的观察压缩遇到指向 `observations` 的新外键会按既有 fail-closed 守卫拒绝运行**（已在 `reversibility-deltas.json` 声明），回滚期间观察不压缩、不影响其他功能，回到本版本即恢复。带 B-b 但不带 B-c 的版本没上过主机；假如中间有这样一个版本，它会忽略基线，没有基线的不存在检查想通过时被新触发器拒绝，检查停在 pending，回到本版本后继续运行。

### 3.71 任务级观察范围（#796，task 0010，S11 GO11 / W1a E3-0，v0.50.0 起）

带一个迁移（`task/0010_task_observe_scope`），随 `apply-release.sh` 的迁移步骤自动应用：`tasks.observe_scope uuid[]`（可空，不回填，CHECK 一维且不含 NULL 元素），触发器 `tasks_observe_scope_immutable`（创建后不可改）与 `worker_runs_observe_scope_inherited`（子运行的 Task 范围必须包含在上级范围内）。没有新环境变量或服务，不改 compose、Dockerfile 或启动脚本；门不用升级。

- **窗口前只读检查**：无新增。生产代码还不创建带范围的 Task。
- **契约变化（发版说明照写）**：`get_task` / `list_tasks` 的 Task 多一个字段 `observeScope: string[] | null`（只增）；`find_operations` 的 `reachability` 注解只给入口 agent，任何 WorkerRun 会话都不再带（以前目标步骤里没有上级的 Worker 会拿到按成员入口 agent 算的可达性，与能力描述不符）；`excluded_by_policy` 多一个来源（Task 的观察范围），错误码不变。
- **回滚**：回退代码即可，库不用恢复。上一版插入与读取 `tasks` 都列出列名，不碰新列，它创建的 Task 都不设范围，`worker_runs` 插入都能通过继承检查。只有本版本能创建带范围的 Task：回退后这类 Task 的 Worker 再启动子 Worker 会被触发器拒绝（失败即关闭），观察也不再按范围收窄。

### 3.72 reconcile 用门确认不存在（#799，governance 0029，S11「门确认不存在」reconcile，v0.50.0 起）

带一个迁移（`governance/0029_reconcile_absence_seen_before`），随 `apply-release.sh` 的迁移步骤自动应用：新增 SQL 函数 `action_request_absence_seen_before` 和 `action_requests` 上的触发器 `action_requests_reconciliation_seen_before`，不动表结构，不回填（之前没有哪个版本让 reconcile 检查做不存在调用）。goal 模块排在 governance 之前，`step_runs` 与 `goal_absence_baselines`（goal/0012）在它之前已存在。没有新环境变量或服务，不改 compose、Dockerfile 或启动脚本；门不用升级。

- **窗口前只读检查**：无新增。
- **契约变化（发版说明照写）**：只放宽输入，`propose_goal` / `revise_goal` 计划里 `steps[].reconcile[].check` 也接受不存在调用（`ObservationAbsenceCheck`），输出不变。行为变化：门对「找不到」回 200 加空结果时，「存在过」基线记 `unavailable`（`presence_not_confirmed`），目标在开工前暂停，不再当成看到了它（遗留 507）。
- **发版说明可写**：删除类动作结果不明时，平台能用门确认「已经不在了」来核对，前提是开工前看到过它在；门对「找不到」回空结果时，目标会在开工前暂停。
- **回滚**：回退代码即可，库不用恢复。上一发布 v0.49.0 没有目标代码，不跑 reconcile，触发器碰不到它的写入。假如中间有带 #786 但不带本 PR 的版本（没上过主机）：它的计划校验拒绝 reconcile 里的不存在调用；库里已有的这类核对检查，旧执行器照常调门，门说不在时去记 `effect_seen`，但不带 `absentAnswersReview`，新触发器会拒绝；试满次数后这条检查记 `unavailable` 交给人核对，不会误判生效。

### 3.73 评测容器出网全拒（#818，S10 E3-2-0，v0.50.0 起）

没有迁移，不改 compose、Dockerfile 或启动脚本；只改 egress-proxy 与 worker-supervisor。egress-proxy 的来源条目可带 `denyAll`，命中时拒绝原因为 `source-deny-all`；supervisor `/task/spawn` 新增可选字段 `egressDenyAll`，带它起的容器打标签 `nexttime.egress-deny-all=true`。现有请求与来源表的行为不变；这类容器从 E3-2a 起才会出现。

- **窗口前只读检查**：主机上跑 `docker version`，确认 Engine ≥ 26.0.0（CVE-2024-29018）。低于它时，internal 的 `workers` 网络上的容器经 Docker 内嵌 DNS 会把查询转给外部解析器，能解析外网名字，形成 DNS 外带通道；后续处理是给评测容器设一个不可达的 `--dns`。结果记 `docs/private/`。
- **发版说明可写**：egress-proxy 新增拒绝原因 `source-deny-all`；worker-supervisor `/task/spawn` 新增可选 `egressDenyAll`。
- **回滚**：回退代码即可，库不用恢复。**回滚 worker-supervisor 到本版之前的版本前，先终止所有带 `nexttime.egress-deny-all=true` 标签的 Task 容器**：旧 supervisor 的 reconcile 会把它们重新登记成不带 `denyAll`、也不带兜底放行名的条目，出网完全放开（遗留 518）。

### 3.74 审批前提示「成员未连接此账户」（#821，遗留 513，v0.50.0 起）

没有迁移，不改 compose。门（gatekeeper-base）新增路由 `gate/credential-presence`，只认 `gate_token`、只回有无，Caddy 不对外发布这条路由（边缘访问回 404）。**门镜像与内核同版才会出现提示**：旧门对新路由回 404，内核把它当「未知」、不显示提示，所以不阻塞升级，也不要求先升级门。

- **窗口前只读检查**：无新增。
- **契约变化（发版说明照写）**：只增量。`StepActionWire.failureCode` 为必填但可空；`ActionRequestWire.onBehalfOfAccount` 可选；新增一个 PlanHint code。
- **发版说明可写**：提目标、确认、审批时，如果申请人在某扇按成员连接账户的门上没有自己的凭证，目标页、确认框、审批详情和对话里的审批卡会提前标出「该成员未连接此账户」，不用等批准后被门拒绝才知道。
- **回滚**：回退代码即可，库不用恢复。旧内核不调新路由；旧门不认新路由也不影响新内核。

### 3.75 评测用例试跑（#822，S10 E3-2a，v0.50.0 之后的下一版起）

迁移 task `0011`（`tasks.purpose` 与约束）和 worker `0009`（`eval_runs`、`eval_trials`、`eval_trial_calls` 与账本守卫），都只新增、不回填。新配额键 `evaluation.monthly_cost_budget_usd`，默认 $10。不改 compose。

- **窗口前只读检查**：无新增。§3.73 的 Docker Engine ≥ 26.0.0 从本版起真正用上：评测容器带 `nexttime.egress-deny-all=true` 标签。
- **发版说明可写**：「治理 → 评测」的单条用例试跑；新能力 `start_eval_case_trial`、`get_eval_run`、`list_eval_runs`、`get_eval_budget`；`TaskWire.purpose`；新配额键 `evaluation.monthly_cost_budget_usd`（默认 $10）；新错误 429 `evaluation_budget_exhausted`、403 `evaluation_run_ended`（Worker 报告后的夹具调用）；审计动作 `evaluation.fixture_call`、`evaluation.trial_end`（负载：suite、trial、Task、status、verdict 或 error、`costUsd`、`tokenCount`、`runFinished`）。
- **回滚**：
  - 把内核回滚到本版之前，先让所有在跑的评测 Task 结束或取消。只读检查 `select count(*) from tasks where purpose = 'evaluation' and status not in ('completed','failed','cancelled')` 必须为 0。
  - 新内核停下后、旧内核启动前再查一次（#488 P2）；不为 0 就把新内核重新启动，取消这些 Task，再回滚。原因：旧内核不再对评测 Task 的 Handle 做第二次拒绝，门调用也不再由夹具应答；旧内核还会重排崩溃的评测 Task，而重起的容器不带出网全拒。
  - 同一遍里核对 `select count(*) from eval_trials where status = 'running'` 为 0（#488 P3）。
  - worker-supervisor 回滚照 §3.73 执行（遗留 518）：从本版起才有带 `nexttime.egress-deny-all=true` 标签的评测容器。

### 3.76 zod 4 与能力入参值上限（#829，v0.50.0 之后的下一版起）

没有迁移，不改 compose，契约快照不变。消除 v0.50.0 带出去的 zod 3 高危 GHSA-mrhx（遗留 522）。

- **窗口前只读检查**：无新增。
- **发版说明照写（行为变化）**：
  - 入参里的值（数组元素与对象成员）超过 131072 个的调用被拒绝，HTTP 400 / WS / MCP 回 `invalid_params`，信息为 `invalid params for capability "<name>": params hold more than 131072 values (array elements and object members)`。1 MiB 以内的密集 body 也可能被拒，例如 400 KB 的数字数组或 980 KB 的小行表。
  - 校验失败的英文文案变了（issue 不出 kernel，但 `propose_goal` 的计划错误文字会带上新文案，模型能看到）。
  - `z.string().datetime()` 不再接受只精确到分钟的时间；现有生产方都带秒，不受影响。
  - `.int()` 字段拒绝超出安全整数范围的整数（如 2^53+2）。
- **回滚**：回退代码即可，库不用恢复。回滚后 GHSA-mrhx 回来，入参值上限消失。

### 3.77 草稿评测（#833，S10 E3-2b，v0.50.0 之后的下一版起）

迁移 worker `0010`（新表 `eval_draft_evaluations`；`eval_runs.kind` 可取 `draft`，`eval_trials.status` 可取 `queued`；账本守卫，以及阻止删除评测中 Skill 草稿的触发器），只新增、不回填。不改 compose，无新配额键（沿用 §3.75 的 `evaluation.monthly_cost_budget_usd`）。E3-2a（§3.75）与本节同一版发。

- **窗口前只读检查**：无新增。
- **发版说明可写**：
  - 能力目录里 Skill 草稿的详情可以「评测」，结果在「评测 → 草稿评测」。
  - 新能力 `start_draft_evaluation`、`get_draft_evaluation`、`list_draft_evaluations`、`cancel_draft_evaluation`；`list_eval_runs{kind?}`。
  - `EvalRun.kind` 新增 `draft`，`EvalTrial.status` 新增 `queued`；草稿评测的每臂计数含 `voided`（取消时还在排队、从未开始的试跑）。
  - 新错误 400 `draft_check_failed`、429 `evaluation_budget_insufficient`（details `budgetUsd`、`spentUsd`、`committedUsd`、`estimateUsd`）、409 `draft_evaluating`（`discard_draft` / `reject_draft` 也会回）。
  - `get_eval_budget`（`EvalBudgetWire`）新增 `committedUsd`：未结束试跑的预估成本，评测开始与每段开始都把它计入本月预算。
  - 审计动作 `evaluation.draft_stage`、`evaluation.draft_verdict`。
- **回滚**：
  - 把内核回滚到本版之前，先取消或等完所有在跑的草稿评测。两条只读检查都必须为 0：`select count(*) from eval_draft_evaluations where status = 'running'`；`select count(*) from eval_trials where status in ('queued','running')`。
  - 计数不为 0 时先用 `cancel_draft_evaluation`（评测 → 草稿评测 → 取消评测）取消，等 trial tick 把被终止的试跑记为 errored，再重查（#488）。
  - 新内核停下后、旧内核启动前再查一次，同 §3.75。
  - 原因：旧内核从不启动排队的试跑，也不推进或结束评测；数据库触发器仍拒绝丢弃、拒绝与过期评测中的草稿，草稿会卡住。
  - 回滚过本版后，旧内核读不了 `draft` 运行：有过草稿评测的用例集 `list_eval_runs` 结果校验失败，控制台里它的运行列表报错，别处不受影响。
  - worker-supervisor 回滚照 §3.73 与 §3.75 执行。

### 3.78 评测防泄漏暂停（#838，S10 E3-2c，v0.51.0 之后的下一版起）

迁移 worker `0011`（新表 `eval_seal_hits`、`eval_seal_holds`，各带守卫触发器），只新增、不回填。不改 compose，没有新配置或环境变量；阈值（24 小时内 5 次）固定在代码里。

- **窗口前只读检查**：无新增。
- **发版说明可写**：
  - 防泄漏拦截现在会暂停反复触发它的智能体：同一个人（或评测自己）24 小时内被拦 5 次，代表他的全部智能体暂停，直到工作区 owner 在「治理 → 评测」写明理由解除；系统从不自动解除。
  - 新能力 `list_eval_seal_holds`、`release_eval_seal_hold`（只走人的通道）。
  - 新错误 403 `evaluation_probe_hold`（WS -32019），`start_eval_case_trial`、`start_draft_evaluation` 也会回。
  - 新试跑错误 `paused`：试跑在评测被暂停期间跑过，没有结果。
  - 审计动作 `evaluation.seal_hold_opened`、`evaluation.seal_hold_refused`。
- **回滚**：旧内核在这个 schema 上照常运行，但既不计数也不检查暂停，回滚过本版等于解除所有生效中的暂停，而行仍是 `active`。按下面顺序做，不要调换（#488 P2：解除评测主体的暂停会立刻派发它排队的试跑）：
  1. 先处理生效中的暂停：`select count(*) from eval_seal_holds where status = 'active'`。不为 0 时与 owner 定这些智能体能否在不暂停的情况下运行；能的话先用 `release_eval_seal_hold` 写明理由解除，让记录说明原因。
  2. 用 `cancel_draft_evaluation` 取消在跑的草稿评测，等 trial tick 把被终止的试跑记完。
  3. 跑 §3.77 与 §3.75 的计数（草稿评测、排队与在跑试跑、未结束的评测 Task），确认为 0。只回滚到 v0.51.0 时，这一步确保第 1 步解除暂停后派发的试跑也已结束。
  4. 停新内核；旧内核起来之前把以上计数全部再查一遍。

### 3.79 发布审阅：发布绑定评测证据（#842，S10 E3-3a，v0.51.0 之后的下一版起）

没有迁移，不改 compose。

- **窗口前只读检查**：无新增。
- **要告诉 owner 的新行为**：评测发现「有回归」或「差于基线」的草稿，要逐条写下失败理由才能发布；草稿评测进行中不能发布，等评测结束或取消。
- **发版说明可写**：
  - 发布 Skill 草稿时显示它的评测证据，并记下依据哪次评测发布；「有回归」「差于基线」评测发现的失败要逐条写理由确认。
  - 审阅区还列出这个 Skill 其他版本被判「机制未证实」「有回归」「差于基线」的评测，以及那个版本后来已发布、已弃用、已拒绝还是已丢弃。
  - 新能力 `get_skill_publish_evidence`；`publish_skill` 新增 `evaluationReview`。
  - 新错误 409 `evaluation_changed`、400 `evaluation_review_required`；`publish_skill` 也会回 409 `draft_evaluating`。
  - 直接调 API 的脚本：发布有不利评测的草稿必须带 `evaluationReview`，否则 400。
- **回滚**：旧内核的参数校验是严格的，会拒绝新控制台带的 `evaluationReview`，所以内核与控制台一起回滚（发版回滚本来就一起）。期间发布的版本保留审计行。

### 3.80 评测摘要进图与 agent 侧 dev 结论（#845，worker 0012，S10 E3-3b，v0.51.0 之后的下一版起）

带一个 worker 迁移（`0012_draft_evaluation_summary`），随 `apply-release.sh` 的迁移步骤自动应用；不改 compose、无单独主机步骤、无新环境变量；窗口前只读检查：无。

- **迁移做什么**：`eval_draft_evaluations` 加两个可空列 `summary_observation_id`（外键指向 `observations`）与 `dev_verdict`，两条约束（两列同有同无、只有 `finished` 的评测能有值），一个部分索引 `eval_draft_evaluations_summary_observation_idx`（供 Observation 压缩条件 (a) 查询）。迁移前结束的评测不回填，`get_skill_draft_verdicts` 不列它们。
- **入口 agent**：入口 Handle 的能力范围是固定上限，已有工作区升级后入口 agent 马上能调 `get_skill_draft_verdicts`；系统提示里「提议下一版前先读」的说明要等 owner 对齐入口模板（§3.61 的做法）后才有。
- **发版说明可写**：草稿评测结束后在图上记一条只对评测服务主体可见的摘要；提议者的智能体可以读到自己草稿只按 dev 用例判的结论（新能力 `get_skill_draft_verdicts`，Handle 通道，member 起）；控制台草稿评测详情显示这条结论。契约：`DraftEvaluation*Wire` 新增 `devVerdict`，`publish_skill` 审计的 `evaluation` 新增 `observationId`，`evaluation.draft_verdict` 审计多带 `devVerdict`、`observationId`。
- **回滚**：只回退代码即可（§6）。上一版不读写新列，新结束的评测不再记摘要与 dev 结论，已写的保留。**代码回退到上一版后，apply-release 的 observations-compaction 步骤会报 degraded**：上一版的压缩看到 0012 指向 `observations` 的新外键就拒绝运行（安全失败，不删任何东西），重新应用带 0012 的版本后恢复；与 §3.39、§3.41 同类，回退期间这一条 degraded 可以忽略（`reversibility-deltas.json` 已声明）。

### 3.81 发布 WorkerDefinition 时校验引用（#848，遗留 302，v0.52.0 之后的下一版起）

无迁移、不改 compose、无单独主机步骤、无新环境变量；窗口前只读检查：无。

- **行为变化（要告诉 owner）**：`publish_worker_definition` 现在拒绝引用不存在的能力（Worker 能力上限之外）、本工作区没有的门、没有已发布版本的 Skill，以及人发布时不在模型目录里的模型：返回 400 `unresolved_references`，`details.unresolved` 按字段列出，版本留在草稿；模型目录读不到时，写了模型的版本返回 503，什么也不发布（与 `set_agent_profile` 相同）。WS 通道映射为 `INVALID_PARAMS`。控制台在「发布」旁逐字段写明原因与改法。
- **能力包安装**：包里的 Worker 引用的 Skill 已弃用、或沿用的门不在工作区时，整次安装被拒且不写入，控制台逐字段说在工作区里怎么修。建工作区不受影响（只发布入口定义）。
- **不回溯**：升级前已发布的版本保持原样，照常运行；组建时的准入检查属于 GO8。
- **发版说明可写**：发布 Worker 定义时会检查它引用的能力、门、Skill 和模型都存在；控制台在「发布」旁逐个字段写明哪里不对，并可以直接改一版。
- **回滚**：只回退代码即可，无数据变化；回退后发布不再校验引用。

### 3.82 步骤用 WorkerSpec 组建 Worker 并准入（#853，S11 GO8a，v0.52.0 之后的下一版起）

无迁移（快照是 jsonb，`observe_scope` 列 task/0010 已有）、不改 compose、无单独主机步骤、无新环境变量（推进器读已有的 `MODELS_JSON_FILE`）；窗口前只读检查：无。

- **发版说明可写**：目标的每一步可以在已发布的 Worker 定义上调整职责、Skill、门、能力、模型、观察范围和 Token 上限，开工前平台会检查，不会超出 Worker 的上限和请求人的权限；引用草稿 Skill 的步骤会停下等人处理；模型每次尝试都要在模型目录里、并且是工作区允许的。契约：`PlanStep.spec`（可选）与四个新提示码（`step_skill_draft`、`step_skill_deprecated`、`step_model_not_offered`、`step_model_not_allowed`），`PlanHint` 多 `skillRefs` / `model`；旧计划不受影响。
- **快照**：运行配置快照升 v2（多 `spec`），v1 照样能读。
- **回滚**：只回退代码即可，无数据变化。**回退到本版之前时，旧代码读不出 v2 快照，有过尝试的步骤会暂停 `needs_decision`（"no readable configuration snapshot"）**：安全失败，不起 Worker；重新应用本版后可「继续」。发版说明里提一句。

### 3.83 草稿 Skill 试用批准（#855，goal 0013，S11 GO8b，v0.52.0 之后的下一版起）

带一个 goal 迁移（`0013_step_trial_approvals`），随 `apply-release.sh` 的迁移步骤自动应用；不改 compose、无单独主机步骤、无新环境变量；窗口前只读检查：无。

- **迁移做什么**：新表 `goal_step_trial_approvals`（一次批准一行，只追加、不删除），外键指向 `goal_runs`、`step_runs`、`principals`，没有表指向它；guard 触发器限定只能在目标 `proposed` / `paused` 时、由本工作区未停用的人写入，之后冻结（提议时的批准只在第一次尝试开始时补一次 StepRun）。不回填：之前的版本一律拒绝草稿 Skill。
- **发版说明可写**：目标的某一步用到还只是草稿的 Skill 时，能发布这些草稿的人（提议人或工作区所有者）可以在目标页「批准试用」：这一步的第一次尝试与重试挂载批准的草稿版本，草稿一改、修订替换这一步或目标结束则批准失效；批准不会让目标继续，仍由请求人按「继续」。新能力 `approve_step_trial`（人工通道，builder 起，agent 与服务账号不能调用），`get_goal` 新增 `trialApprovals`，新审计动作 `step_trial.approve`。
- **回滚**：只回退代码即可（§6）。GO8a 与本项进同一版，回退到 v0.52.0 时 §3.82 的说明照样适用。不带本项的代码不读写新表，也不会让草稿 Skill 进 Worker（有 GO8a 时准入照旧 `needs_approval`），所以已批准、还没开始的步骤不会挂草稿；已经在本版用草稿开始的尝试继续跑完，它的重试在回退后被拒（只从快照挂已发布版本，且不认识快照里的 `trial` 字段），目标暂停为「需要决定」。清除工作区时新表排在三个父表之前。要连 schema 一起撤：`drop table goal_step_trial_approvals`（触发器随表删除）、`drop function goal_step_trial_approvals_guard()`，并 `delete from schema_migrations where module = 'goal' and version = 13`（不撤也无害；撤表会丢掉批准记录，`audit_records` 里的 `step_trial.approve` 仍在）。

### 3.84 验收的 fake 路径让 kernel 读验收模型目录（#855 带入的验收修复，原 #856）

不改生产 compose、无迁移、无新环境变量。

- **窗口里的变化**：S1 / S2 / S3 的 fake 路径现在会在进入和退出时各重启一次 kernel（读验收的模型目录），窗口里跑验收时 kernel 有两次短暂重启。验收的 models.json 在 `${NEXTTIME_DATA}/accept/models/`，只读挂给 kernel 的 `/data/models`；不挂整个 accept 目录（llm-proxy 的 `keys.json` 在那里）。
- **为什么**：#848 起 kernel 发布 WorkerDefinition 时按它挂载的模型目录校验模型，原来验收只把 llm-proxy 与 worker-supervisor 切到 fake 目录，S2 的 `ops-runner-publish` 会 400。
- **注意**：退出时的 restore 也重建 kernel，这一步失败按 P1 处理（遗留 548 会写进 runbook）；带 `spec.model` 的生产目标运行在验收期间可能暂停（遗留 545）。
- **#862 起（同一下一版）**：两次 kernel 重启之后脚本都会等 agent-host 重新连上（日志 `kernel-link: connected`，最多 `ACCEPT_KERNEL_LINK_WAIT_S` 秒，默认 60）；恢复失败或链路没回来打 `accept: P1 — …`、退出码为 1，做法见 `accept-s1.md` §1（遗留 545、548 已关）。

### 3.85 重试的模型回落与「版本不再发布」的提示（#857，遗留 543、544，v0.54.0 起）

无迁移、不改 compose、无单独主机步骤、无新环境变量；窗口前只读检查：无。

- **行为变化（要告诉 owner）**：目标步骤的模型取自请求人的智能体设置时，admin 收窄 `allowedModels` 之后，这一步的重试会按上限回落到允许的模型（审计 `task.queue` 记 `modelFallback {from, to}`），不再沿用被收窄掉的模型；WorkerSpec 或 WorkerDefinition 明确设的模型不回落。
- **发版说明可写**：步骤钉住的 Worker 版本或上一次尝试用过的 Skill 版本不再发布时，目标页会点名这一步并说明下一步。契约：两个新计划提示码 `step_worker_unavailable`、`step_skill_version_unavailable`。
- **回滚**：只回退代码即可，无数据变化；回退后重试照旧沿用第一次尝试的模型，提示回到原来的说法。

### 3.86 目标规划器提议修订（#864，goal 0014，task 0012，S11 GO9a，v0.54.0 起）

带两个迁移（goal `0014_planning_rounds`、task `0012_task_planning`），随 `apply-release.sh` 的迁移步骤自动应用。不改 compose，没有单独的主机步骤，没有新环境变量（规划器模板 `ontology/goal-planner.yaml` 随镜像里已有的 `ontology/` 目录一起发）。task/0012 重建 `tasks` 的 CHECK 约束时会持有 `ACCESS EXCLUSIVE` 锁，迁移期间 `tasks` 的读写会短暂等待。

- **迁移做什么**
  - 新表 `goal_planner_delegations`、`goal_planning_rounds`，各带 guard 触发器。
  - `plan_revisions` 新增触发器 `plan_revisions_planner`。
  - `tasks` 新增列 `planning_round_id`（外键指向规划轮），`tasks_purpose` 增加 `planning`，`tasks_goal_step_ref` 改写。
  - 不回填。
- **发版说明可写**
  - 确认目标时可以让「目标规划器」帮忙（默认打开）。步骤失败、需要你决定时，规划器先提一个计划修订，目标页写明它改了什么、为什么；只有请求人能接受（可选同时继续）或拒绝，平台从不替你接受。
  - 规划器不能观察、不能出网、只能交回报告；它提的修订和你自己写的修订过同样的检查、占同样的修订次数。
  - 新能力 `decide_plan_revision`；`confirm_goal` 新增 `planner`（模式，现在只有 `'propose'`）；`get_goal` 新增 `planner`、`planningRounds`，修订带 `proposer`；Worker 定义的行新增 `goalPlanner`，规划器这一族不能用作步骤的 Worker。
  - 新审计动作：`goal_run.planner_granted`、`goal_planning_round.open`、`goal_planning_round.settle`、`plan_revision.propose`。
- **回滚**
  - 只回退代码即可（§6）。不带本项的代码不读写新表。
  - 回退前先让在跑的规划结束，窗口前只读检查 `select count(*) from goal_planning_rounds where status = 'running'`，应为 0。在跑的规划轮在回退后会一直停在 `running`；回退后的代码把它的任务当成不属于任何步骤的任务，它的报告不推进任何步骤，崩溃后也不会重试（那个版本只重试 `purpose` 为空的任务），所以它不会在 deny-all 出网之外重新启动。
  - 旧的 `TaskWire.purpose` 枚举里没有 `planning`。生产环境不校验结果，读任务不会报错；回退后的控制台只为 `evaluation` 显示用途行，规划任务在任务详情里看起来和普通任务一样。
  - 留在 `proposed` 的规划器修订不会被接受：另一个修订生效后，I-G3 检查会拒绝它。
  - 清除工作区时，新表排在 `goal_runs`、`step_runs`、`plan_revisions`、`principals` 之前，`tasks` 排在 `goal_planning_rounds` 之前。
  - 要连 schema 一起撤：
    - 先撤 task/0012：删掉约束 `tasks_planning_shape`、外键 `tasks_planning_round_fkey`、索引 `tasks_planning_round_uidx`、触发器和函数 `tasks_planning_guard` 与 `worker_runs_planning_root`、列 `planning_round_id`，再把 `tasks_purpose`、`tasks_goal_step_ref`、`tasks_output_schema` 恢复成 task/0011 时的写法；
    - 再 `drop table goal_planning_rounds, goal_planner_delegations`（触发器随表删除），`drop trigger plan_revisions_planner on plan_revisions`，删掉迁移里的函数；
    - 最后从 `schema_migrations` 删掉 goal 14 和 task 12 两行。

### 3.87 目标规划器的小修订由平台采用（#866，goal 0015，S11 GO9b，v0.54.0 起）

带一个迁移（goal `0015_planner_apply_minor`），随 `apply-release.sh` 的迁移步骤自动应用。不改 compose，没有单独的主机步骤，没有新环境变量。必须和 #864（goal 0014、task 0012）同版或在它之后。

- **迁移做什么**：`goal_planner_delegations` 的模式增加 `apply_minor`；`goal_planning_rounds` 新增 `kind`（默认 `proposal`）、`revision_class`、`class_reasons`，状态增加 `applied`，原因增加 `step_keeps_failing`、`run_not_running`；新增函数 `goal_planning_class_reasons_valid`；改写 `goal_planning_rounds_guard` 和 `plan_revisions_planner`。只有列默认值，没有其他回填。
- **窗口前只读检查**：`select count(*) from goal_planning_rounds where status = 'running'`，应为 0。
- **发版说明可写**：
  - 确认目标时可以选「小修订由平台替我采用、目标不停」。
  - 步骤失败时，规划器换一条路；平台按自己的规则判断是不是小修订，是就替你采用、目标继续。
  - 改验收、能执行动作、要人批准才能开始、会停下在跑的工作的修订，都会暂停目标等你决定。
  - 用到原来没有的 gate 的修订，哪怕只读，也暂停等你决定。
  - 同一份工作平台最多替你改两次，换了步骤名也算。
  - 新增 `confirm_goal.planner: 'apply_minor'`、`PlanningRoundWire.kind/revisionClass/classReasons`（原因带可选的 `capabilities`、`gates`）、`PlanRevisionSummaryWire.acceptedBy`。
- **回滚**
  - 回退目标是 v0.53.0（GO9a 和 GO9b 同版发布）。只回退代码即可（§6）：v0.53.0 不读这两张表，`apply_minor` 的目标在步骤失败时照常暂停；在跑的自主轮停在 `running`，重新升级后以 `run_not_running` 作废。
  - 若中途回退到只含 GO9a 的构建：它把所有授权读成 `propose`，新开的轮是 `proposal`；它以 `run_left_pause` 作废在跑的自主轮，守卫接受。它的控制台把 `applied` 显示成未知状态。
  - 回退前用上面的只读检查确认没有在跑的轮。
  - 要连 schema 一起撤，需要满足三个前提：没有 `applied` 的轮，没有带新原因的轮，没有 `apply_minor` 的授权。然后：
    1. 重新执行 0014 里 `goal_planning_rounds_guard` 和 `plan_revisions_planner` 的 `create or replace`；
    2. 删掉本迁移加的约束，重新加回 0014 的四个约束；
    3. 删掉约束 `goal_planning_rounds_class_reasons` 之后，`drop function goal_planning_class_reasons_valid(jsonb)`；
    4. 删掉 `kind`、`revision_class`、`class_reasons` 三列；
    5. `delete from schema_migrations where module = 'goal' and version = 15`。
  - 撤 schema 的顺序：先撤 0015，再撤 0014 和 task/0012。

### 3.88 目标预算全量：无进展熔断与规划器轮数（#870，S11 GO10，v0.55.0 起）

无迁移、不改 compose、无单独主机步骤、无新环境变量；窗口前只读检查：无。

- **行为变化（要告诉 owner）**：GO9a 起 `maxRevisions` 只限制被接受的修订。从这一版起，它同时限制**规划器轮数 / planner rounds**：规划器每跑一轮（拉起过规划任务的轮）都算一轮，不论被拒、没提出修订还是失败，与计划修订各自计数、共用同一个上限；任一个到上限就不再开轮（`failed` / `revision_budget_exhausted`），手动修订不占规划器轮数。已有目标升级后按新规则计数，已经跑过的规划轮也算在内，所以有的目标可能比升级前更早停止规划。
- **行为变化**：`apply_minor` 下，自上次确认、继续或有步骤成功以来平台已自主规划 3 轮，再有一步失败时不开第 4 轮，目标暂停为「连续没有进展」（`paused(no_progress)`），等人重试步骤、修订计划或结束目标；人继续之后重新计数，暂停期间规划器不提议。
- **发版说明可写**：目标用量单列规划器（`GoalUsageWire.plannerTokens`，已包含在 `tokens` 里；`plannerRounds`），控制台预算卡与规划器卡片显示规划器用了多少 token、跑了几轮。
- **回滚**：只回退代码即可，无数据变化。回退后 `maxRevisions` 回到只限制被接受的修订，没有无进展熔断；处于 `paused(no_progress)` 的目标在旧代码里按普通暂停处理，人可继续。

### 3.89 目标验收未通过时的规划轮（#872，goal 0016，S11 GO10b，v0.55.0 起）

带一个迁移（goal `0016_planning_acceptance_anchor`），随 `apply-release.sh` 的迁移步骤自动应用。不改 compose，没有单独的主机步骤，没有新环境变量。

- **发版说明可写**：所有步骤都成功、目标验收没通过时，如果请求人让规划器参与，规划器为这一轮验收提一个修订，由请求人决定；`apply_minor` 也只提议，平台不自己改计划。
- **只回退代码的前提**：`select count(*) from goal_planning_rounds where acceptance_round is not null and status = 'running'` 为 0。不为 0 时，先等那一轮结算，或者让请求人对那个 run 继续或结束目标，再回退。
- **原因**：v0.54.0 及更早的代码（以及含 GO10、不含 GO10b 的构建）经 inner join 读规划轮的步骤，看不到验收轮。
  - 还在 running 的验收轮永不结算，规划器的结果不会落地。它的规划 Task 结束后，到期查询（不 join 步骤）仍看得到这一轮，这个 run 每个 tick 都被空推进，直到有人操作它（继续、结束、取消、修订计划或所有者锁定会把它放弃为 `run_left_pause`）。
  - 已结算的验收轮无害：控制台规划器卡片不显示它，它提出的修订照样作为提议让请求人决定；若回退到只含 GO10 的构建，它的规划器轮数上限检查不再数它（`usage.plannerRounds` 照数），这样的目标之后可能多跑相应轮数（v0.54.0 没有规划器轮数上限，不涉及）。
- **连 schema 一起回退**：不带 `status` 的同一计数必须为 0（第 3 步 `set not null` 会自己拒绝）。停 kernel，单事务执行：
  1. 先恢复 goal/0015 的 `goal_planning_rounds_guard`（0016 的守卫读 `acceptance_round`）；
  2. 删约束 `goal_planning_rounds_anchor`、`goal_planning_rounds_acceptance_kind` 和索引 `goal_planning_rounds_acceptance_uidx`；
  3. 删 `acceptance_round` 列，`step_run_id`、`step_attempt`、`failure_category` 恢复 `not null`；
  4. 删 `schema_migrations` 里 goal 16。
- **回退到哪一版**：回退目标是 v0.54.0（GO10 #870 与 GO10b 同版发布）；不论退到只含 GO10 的构建还是更早的版本，前提相同。GO10 没有迁移，goal/0015 及更早的迁移不受 goal/0016 影响；迁移文件头有同样步骤。

### 3.90 同一个门的执行队列按目标资源排队（#876，governance 0030，S11 GO12，0.56.0 起）

带一个迁移（governance `0030_action_request_target`），随 `apply-release.sh` 的迁移步骤自动应用。不改 compose，没有新环境变量。遗留 565（`requested_at` 提交顺序缺口）由 #881（governance 0031，§3.93）修好，同版发布。

- **发版说明可写**：Operation 可以声明一次调用作用于哪一个实例（`target: { object_type, params }`）。同一个门上，作用于不同实例的请求互不阻塞，等审批的请求只挡同一实例和作用于整个门的调用；没有声明目标的 Operation 行为不变。不合法的声明在导入清单、门公告、`propose_operation` 时一律 400 `invalid_operation_target`（`details` 带 `{reason, operation, path}`）。契约：`ActionRequestWire.target`、`queuedBehind.scope`（`target` / `gate`）、`OperationGovernanceFieldsWire.target`、`OperationSummaryWire.target`。
- **主机注意（无需操作）**：升级后，已发布的 docker `container.restart` 要等属主接受 docker 门的治理刷新（加上 `target` 属于放宽）才开始按容器排队；在那之前仍整门串行，和现在一样。原地接受这次治理刷新依赖 core `0048`（§3.91）。
- **回滚**
  - 只回退代码：随时可以。不含这个迁移的代码从不读写 `target` 列，它插入的行 `target` 为空，守卫放行；它让每个请求等同门所有更早的请求，比现在更严。本版并发开始的同门请求处于 `executing`，旧的排水器遇到 `executing` 就停，不会多跑。
  - 连 schema 一起回退：**先撤 governance 0031（§3.93 的有序步骤）**，再在同一事务里执行（反过来会让整个平台的动作开始不了）：
    1. `drop trigger action_requests_target_guard on action_requests`；
    2. `drop function action_requests_target_guard()`；
    3. `alter table action_requests drop column target`（CHECK 随列一起删掉）；
    4. `delete from schema_migrations where module = 'governance' and version = 30`。

### 3.91 已发布 Operation 版本上的目标声明（#876，core 0048，S11 GO12，0.56.0 起）

带一个迁移（core `0048_operation_target_governance`），随 `apply-release.sh` 的迁移步骤自动应用；和 §3.90 同版。

- **作用**：允许治理刷新在已发布的 Operation 版本上写 `target`（主机上原地接受 docker 门的治理刷新、让 `container.restart` 带上目标靠它）。
- **回滚**
  - 只回退代码：随时可以。不含这个迁移的代码从不在已发布版本上写 `target`。
  - 连 schema 一起回退：重新执行 core/0047 里的两条 `create or replace function`，再 `delete from schema_migrations where module = 'core' and version = 48`。已经带上 `target` 的已发布版本保留它。

### 3.92 Worker 约定与 `find_workers` 的新字段（#880，S11 GO13，0.56.0 起）

没有迁移，不改 compose，没有新环境变量，主机不需要操作。

- **发版说明可写**：Worker 定义可以声明自己要什么输入、交回什么输出（`inputSchema` / `outputSchema`，只是声明，步骤的输出仍只按步骤自己的约定检查）。`find_workers` 每条结果带约定、它声明的每个门对调用方现在是 `act` / `observe` / `none`、近 90 天的提示（token 中位数与主结果达成数，各带样本数，少于 5 个标样本不足），找不到时说明原因（`emptyReason`：`no_match`，或按不可委派 / 被 AgentProfile 排除的计数）。规划器拿到的 Worker 列表带可否启动与原因、约定和提示，提示不参与排序。计划提示新增 `step_output_contract_unused`、`step_input_mismatch`（只是建议，步骤照常开始）。控制台：Worker 定义编辑器有输入、输出约定两段；目标修订与流程编辑器可一键沿用 Worker 的输出约定。契约只加字段：`find_workers` 结果的 `inputSchema?` / `outputSchema?` / `gates[]` / `hints`、信封 `emptyReason?`；`PlanHint` 的两个新码与 `inputProblems?` / `inputProblemCount?`。
- **回滚**：只回退代码（目标 v0.55.0），不需要预发，不动主机。已存的 Worker 定义版本内容里留下 `inputSchema` / `outputSchema`；v0.55.0 只在发布时和扩展包 ChangePlan 的 WorkerDefinition 项按 kind schema 严格校验，所以：
  1. 已发布、带这两个字段的版本回退后照常可用；
  2. 带这两个字段的新提议仍会以草稿入库，到发布时才失败（unrecognized keys）；
  3. **GO13 期间提议、回退时还是草稿的这类版本在 v0.55.0 上发布不了，要重新提议一版不带这两个字段的**（运维最可能撞到的一条）；
  4. 含这类 WorkerDefinition 的扩展包 ChangePlan 在 v0.55.0 上评审和应用都会被拒，v0.55.0 的包注册表也会拒绝按 GO13 写的扩展包里的 Worker；仓库内置包不带这两个字段；
  5. 旧控制台从这类版本「编辑（新版本草稿）」会丢掉这两个字段，不报错。

### 3.93 同一个门上冲突的请求不会同时执行（#881，governance 0031，遗留 565，0.56.0 起）

带一个迁移（governance `0031_action_request_execution_guard`），随 `apply-release.sh` 的迁移步骤自动应用。不改 compose，没有新环境变量。和 §3.90、§3.91 同版发布，回退目标是 v0.55.0。

- **发版说明可写**：同一个门上互相冲突的两个执行请求（任一作用于整个门，或作用于同一实例）不会同时执行，由数据库在请求开始执行时检查。保证的是互斥，不是严格按发起时间执行：发起请求的事务提交得晚，它会排在已经开始执行的、后发起的冲突请求之后。
- **主机注意（无需操作）**：同一个门上的开始逐个进行，平时察觉不到。开始执行的事务必须是 READ COMMITTED（Postgres 默认）；如果在库或角色上把 `default_transaction_isolation` 改成了 REPEATABLE READ 或 SERIALIZABLE，动作会开始不了（SQLSTATE `NTQ02`），默认配置不受影响。
- **回滚**
  - 只回退代码：随时可以，触发器留着，互斥仍成立。旧排水器在少数情况下会把一行排在冲突的执行中请求前面，开始时收到一个意料之外的数据库错误（`NTQ01`），那一行等另一条结束后照常开始，不会两条同时执行。调用方看到的：
    - 后台排水（outbox 消费者、定时 tick）：这次排水停下，日志里多一行错误；
    - `request_action` 调用里的即时排水：**罕见情况下那次调用返回内部错误，但请求已经入队，轮到时照常执行一次**。调用方重试时，带显式 idempotency key 或来自目标步骤的，拿回原来那一行；不带的，只在原请求还没结束时拿回它，结束后再调就是新请求（R-53 / D-12 的既有规则）。
  - 连 schema 一起回退（§3.90、§3.91 与本节合成一段有序步骤）：**必须先撤 0031，再撤 0030。** 守卫函数是 plpgsql，读 `action_requests.target`，Postgres 不记录这种依赖；先删 `target` 列，语句照样成功，之后每一次开始都会在守卫里报列不存在，整个平台的动作都开始不了。停 kernel，单事务执行：
    1. 先撤 governance 0031：
       1. `drop trigger action_requests_execution_guard on action_requests`；
       2. `drop function action_requests_execution_guard()`；
       3. `drop function action_request_execution_lock(uuid, uuid)`；
       4. `drop function action_request_targets_conflict(jsonb, jsonb)`；
       5. `drop function action_request_identity_text(jsonb)`；
       6. `delete from schema_migrations where module = 'governance' and version = 31`。
    2. 再撤 governance 0030（§3.90 的四步）。
    3. core 0048（§3.91）和前两者无关，放在哪一步都行。

    撤掉之后回到 v0.55.0 的行为。这个顺序在跑满迁移的新库上试过（#881）。

### 3.94 同一个目标里后一步读前一步留下的文件（#884，S11 GO14，0.57.0 起）

没有迁移，不改生产 compose 的结构，但**内核与 worker-supervisor 必须同一次升级、同一次回退**：新内核给每个目标步骤的 spawn 带 `goalRunId`，老 supervisor 的请求 schema 是 strict 的，会拒绝，所有目标步骤都起不来。升级路径由预发演练（v0.56 → 新头，accept_s2 S14）覆盖。

- **发版说明可写**：计划条目可以写 `filesFrom: [步骤…]`（1 到 8 个，必须在它的 `dependsOn` 里）。被点名的步骤那次被接受的尝试，其 Worker 放在 `/workspace/out` 的文件，在这一步的容器里只读出现在 `/upstream/<步骤>`。上游还没退出就稍后再看；文件交不出（被跳过、没成功、目录不在或不属于这个目标、`out` 被换成别的东西）时目标暂停等人决定，不花尝试次数。没结束的目标里已成功步骤的目录每小时续租，目标结束后再过一个保留期清掉。改 `filesFrom` 算小修订；流程模板暂不支持。控制台在确认卡片、规划器提议、步骤详情、修订编辑器里都显示读取关系。契约只加字段：`PlanStep.filesFrom?`；supervisor 内部接口加 `goalRunId`、`upstream[]`、409 `upstream_unavailable` / `goal_task_spawned`、`POST /task-dirs/keep`。
- **升级前检查**：主机 `.env` 若设置了 `TASK_WORKDIR_RETENTION_HOURS`，必须 ≥ 2，否则新 supervisor 不启动。两者之间没有启动依赖，升级时内核与 supervisor 重建的短暂窗口里 spawn 可能得到 400（`host-worker-runtime.md` §17.2）。
- **主机注意**：长期暂停的目标会一直占着它已成功步骤的目录；只读查询与处理办法见 `host-worker-runtime.md` §17.1。
- **已知边界**：步骤间的文件是唯一不经凭证复查的通道（绑定的凭证复查是值级的，文件不做）。这是 GO14 方案的明确取舍：上游 Worker 拿到的观察已经脱敏，Worker 进程不持凭证。
- **回滚**：只回退代码，内核与 supervisor 一起回退（目标 v0.56.0）。回退前先跑 `host-worker-runtime.md` §17.2 的只读 SQL，查有没有计划用到 `filesFrom`（老内核的 `PlanStepSchema` 是 strict 的，读不了这些计划，`get_goal` 会报 the stored plan no longer parses）。有行时：
  1. 没结束的目标（包括还没确认的 `proposed`）先由请求人取消；
  2. 待决的、带 `filesFrom` 的修订先拒绝；
  3. 先 `docker compose stop kernel`，换好内核与 supervisor 两边的版本后再一起起。

  已结束的这类目标回退后读不出详情，直到再升级回来。

### 3.95 WorkerSpec 对照定义、准入结论与字段级修订差异（#888，S11 GO15a，0.58.0 起）

只读。没有迁移，不改 compose，没有新环境变量，主机不需要操作。

- **发版说明可写**：步骤的 WorkerSpec 逐字段对照这一步用的 Worker 定义版本显示（保留、去掉、加上了什么，模型从什么改成什么，其余沿用定义），每一步有一行准入结论（可以开始 / 要有人批准试用 Skill 草稿 / 现在不会开始，并给理由）。运行暂停时规划器的提议也做准入检查，接受确认框列出会让目标停下的步骤。提议卡、计划版本时间线与修订确认框逐字段列出改动步骤改了什么。契约只加：新能力 `get_worker_definition`（observe，人类通道，成员与审计员可读；已发布与已弃用的版本人人可读，草稿只有提议人可读，看不到的版本返回 `null`）；`PlanRevisionWire.checkedStepKeys`；shared 的提示码 → 准入结论表 `PLAN_HINT_ADMISSION`。
- **回滚**：只回退代码，随时可以，不需要预发，不动主机。新能力没有写入任何东西。

### 3.96 在「修订计划…」里调整一步对 Worker 的设定（#889，S11 GO15b，0.58.0 起）

只改控制台。没有迁移，内核不改，不改 compose，主机不需要操作。

- **发版说明可写**：在目标的「修订计划…」里，每一步多了「对 Worker 的调整」折叠区，可以用选择器调整这一步的 Skill、门、观察范围、能力、模型和职责说明（只能收窄，提交后由内核重新准入）；没有调整的步骤原样带回。Skill 草稿只有一版时标明要有人批准试用才会开始，已弃用的不列；模型按请求人的智能体设置允许的范围列出。暂停说明遇到 Skill 草稿、弃用、版本不可用或 Worker 版本不可用时，指向控制台里能走通的入口，不再让人去对话里找入口智能体。
- **回滚**：只回退代码，随时可以。已经用新编辑器提交的修订是普通的计划修订，旧版本照常读取。

### 3.97 管理员智能体的身份、上限与逐次调用检查；服务 key 不再能装包或写分段（#897，S11 AA1 + 遗留 407，0.59.0 起）

带一个迁移（core `0049_admin_agent_sessions`），随 `apply-release.sh` 的迁移步骤自动应用。新环境变量 `ADMIN_AGENT_ENABLED`，默认关；这一版没有任何东西会启动管理员智能体（AA4 的运行时才会），所以主机不用设它。

- **迁移**：core/0049 只把 `sessions.kind` 的 CHECK 放宽一个值 `admin_agent`，不回填。旧代码从不写这个值。
- **开关**：`ADMIN_AGENT_ENABLED` 不设、空、`0`、`false`（不分大小写，首尾空白会去掉）都是关，`1` / `true` 是开；**写成其他值，内核启动时报错退出**。升级前确认主机 `secrets/kernel.env` 里没有它，或者值是这几种之一：内核只从这个 env_file 读它，`docker-compose.yml` 不从 `.env` 传这个变量，写在 `.env` 里不起作用（11-02 更正，W1a 核对 compose）。（v0.59.0 的 GitHub 发布说明把这句写成「`1` / `true` 以外的非空值都会退出」，以这里为准。）
- **行为变化（遗留 407）**：`install_pack`、`install_module`、`upgrade_module`、`roll_back_change_segment`、`verify_change_segment` 改为只能代表人调用（`actsForPerson`）；ChangePlan 引擎应用与回滚分段前再查一次，不是 human Principal、或不在 human / platform 通道就返回 403 `forbidden`，什么都不写。**服务 API key 调这五个能力现在得到 403**。主机脚本不用服务 key 调它们，不受影响；排障见 `operations.md` 的排障表与「核验」一节。
- **发版说明可写**：平台有了"管理员智能体"身份：它没有自己的 Principal，会话种类是 `admin_agent`，属于管理员本人在该工作区的 human Principal；Handle 只由容器持有，上限是 28 个只读能力，再按此人在工作区的角色收窄；每次调用都重新检查此人仍是有效平台管理员、工作区启用、开关打开，拒绝也记审计；经它的每条审计都带 `sessionKind: 'admin_agent'` 和 `sessionId`。approve、apply、rollback 与逐项确认只走人的控制台通道，管理员智能体的 Handle 一律拒绝。管理员被降为普通用户时，立即吊销其管理员智能体会话与 Handle。服务 API key 不能再装包、装模块或写 ChangePlan 分段（遗留 407）。
- **回滚**：先查 `select count(*) from sessions where kind = 'admin_agent'`。为 0（这一版总是如此）时可以连 schema 一起撤：按 0001 的五个值重建约束，再 `delete from schema_migrations where module = 'core' and version = 49`。不为 0 时保留 core/0049、只回退代码（这些会话被 `capability_handles`、`llm_usage`、`tasks` 以 restrict 外键引用，删掉会丢用量与 Task 历史）。**AA4 之后**回退到 AA1 之前的代码，要先吊销管理员智能体的 Handle（旧代码把它当 bearer、不做逐次的平台角色检查），语句见 0049 文件头：`update capability_handles set revoked_at = now() where session_id in (select id from sessions where kind = 'admin_agent') and revoked_at is null`。

### 3.98 管理员智能体读平台门、连接器与近期变更（#900，S11 AA2a，0.59.0 起）

只读。没有迁移，不改 compose，没有新环境变量，主机不需要操作。管理员智能体的开关 `ADMIN_AGENT_ENABLED` 仍默认关（§3.97），这一版也没有运行时会启动它。

- **发版说明可写**：新增三个只有管理员智能体会话能调用的只读能力 `platform_state_gates`、`platform_state_connectors`、`platform_state_audit`（能力上的新标记 `adminAgentOnly`，契约快照随之增加）。每次调用分两段：先在调用方工作区里做派发检查并写工作区审计，再在只读平台事务里以管理员身份重查权限后读取；随后写一条平台审计（谁、哪个会话、哪个工作区、读了哪一区、返回多少条，不含内容），这一条写不进去就不返回结果。返回内容按形状白名单投影：不合形状、像 IP 或像密钥的值丢弃或只计数。服务 Handle、CLI 和非管理员智能体会话都调不到这三个能力（403 `forbidden`，审计记 `admin_agent_only`）。
- **回滚**：只回退代码，随时可以。三个能力只读，平台审计里留下的读记录照常可查。

### 3.99 管理员智能体读平台运行时、更新与不变量检查（#903，S11 AA2b，0.60.0 起）

只读。没有迁移，不改 compose，没有新环境变量，主机不需要操作。`ADMIN_AGENT_ENABLED` 仍默认关（§3.97）。

- **发版说明可写**：平台状态再加三个只有管理员智能体会话能调用的只读能力 `platform_state_runtime`（当前镜像与最近镜像、入口容器计数、五个平台服务的状态）、`platform_state_updates`（当前 / 最新 / 回滚版本、待跑迁移、pi 更新状态）、`platform_state_invariants`（最近一次一致性检查的时间与每项违例数，不给样本）；契约快照随之增加，服务 Handle 选择器与签发拒绝名单各加这三项。调用路径与审计同 §3.98；返回内容按形状白名单投影，版本号的预发布后缀夹带不进地址。
- **回滚**：只回退代码，随时可以。

### 3.100 模型调用全被预算拒绝时，Task、试跑、目标与入口 Turn 不再算完成（#910，遗留 589，0.60.0 起）

带两个迁移（llm-usage `0003_usage_refusal`、goal `0017_pause_model_refused`），随 `apply-release.sh` 的迁移步骤自动应用。不改 compose，没有新环境变量。

- **llm-proxy 与内核必须同版**：旧内核的严格用量 schema 不认 `refusalScope`。`apply-release.sh` 按 tag 整体升级与回滚，正常走就是同版。
- **迁移**：0003 加 `llm_usage.refusal_scope` 列、CHECK `llm_usage_refusal`（`refused` ⇔ 有 scope，且 0 token、0 费用）与两个 `where status = 'refused'` 的部分索引 `llm_usage_refused_session_idx (workspace_id, session_id)`、`llm_usage_refused_turn_idx (workspace_id, turn_id)`。建索引时在 SHARE 锁下读一遍 `llm_usage`，期间 llm-proxy 的用量插入排队（它的 reporter 会重试），不报错。0017 给 `goal_runs.pause_reason` 加 `model_refused`。
- **行为变化**：
  - llm-proxy 的预算拒绝挪到读完请求体（受 `maxRequestBodyBytes` 限制）与模型白名单之后；白名单外照旧 403、不计量；`GET /v1/models` 不受预算影响。
  - 每个 402 先写一条 `status = 'refused'` 的用量记录交给内核再回，最多多等 5 秒；超时照样回 402，打 warn `llm-proxy: refusal delivery timed out; answering 402, the record is resent in the background`，计数器 `nexttime_llm_proxy_refusal_delivery_timeouts_total{provider}` 加一，记录后台重送，这时内核可能沿用旧判定。**升级窗口内出现几次这条 warn 属正常**。
  - 402 的 message 以 `out of budget: ` 开头（body 其余字段不变），pi 不再把它当临时错误自动重试。
  - 一个 Task 或入口 Turn 的模型调用如果全部因预算被拒、没有一次被回答：Worker Task 失败 `model_refused`（平台失败），评测试跑 `errored`（不判分），目标暂停 `model_refused`（不自动恢复，预算重置或调高后由请求者继续），入口 Turn 结束为 `failed` 并写一条 `system.model_refused` 系统消息（哪个预算、什么时候重置）。
  - 平台「运行状态」的 30 天调用次数与 `report-usage.sh` 的 `calls` 不再算被拒的调用，后者单列 `refused`。
  - 已知窗口（`operations.md`「被拒之后又被回答」，有意不补）：同一会话被拒后又有一次调用被回答、且 Worker 恰在那条用量入库前上报，会被误判为 `model_refused`。
- **发版说明可写**：工作区当天的 token 或费用配额用完后，模型一个字没答的运行不再被记成完成：Task 失败 `model_refused`，评测试跑记 `errored` 不判分，目标暂停等预算恢复，对话里写明是哪个预算被用完、什么时候重置、谁能调高。被拒的调用记成 0 token、0 费用的用量，不进预算、不进 Task 的 token 数与试跑费用。
- **回滚**（见 §6 的两行）：**不能只回滚内核**——旧内核的严格 schema 会把混有 refused 记录的整批拒掉，llm-proxy 的队列满 1000 条后开始丢真实用量，预算就会少算；llm-proxy 必须和内核一起回（按 tag 整体回滚即可）。schema 与已存的 refused 行默认保留（它们是平台拒绝过的运行的证据，不带 token 与费用，旧代码的预算求和不变；旧代码的调用次数会把它们算进去）。

### 3.101 试验工作区、I-A6 与草稿溯源（#914，S11 AA3a，0.61.0 起）

带三个迁移（core `0050_admin_trial_workspaces`、core `0051_ontology_version_origin`、worker `0013_draft_origin`），随 `apply-release.sh` 自动应用。不改 compose，没有新环境变量；`ADMIN_AGENT_ENABLED` 仍默认关，这一版没有运行时会启动管理员智能体（AA4）。

- **迁移**：0050 放宽 `workspaces_purpose_check`（加 `admin_trial`），加触发器 `workspaces_admin_trial_fixed`（`purpose` 改进或改出 `admin_trial` 对所有角色都拒绝；`standard` ↔ `ephemeral` 不受影响）。0013 给 `skills`、`procedures`、`worker_definitions`，0051 给 `ontology_versions` 加可空的 `origin` 列、取值 CHECK 与「写后不改」触发器；已有行不回填，线上省略字段。
- **行为变化**：
  - 新用途「试验工作区」（`create_workspace {purpose: 'admin_trial'}`，只在创建时决定、之后改不了）。不能设为平台默认工作区（`update_platform_settings` 拒绝，错误码 `trial_workspace`），启动时的默认工作区收养也跳过它；除此之外与常规工作区相同，同样的 RLS 隔离、没有额外权限。CLI `create-workspace --purpose` 仍只收 `standard` / `ephemeral`。
  - I-A6：管理员智能体的 Handle 只在试验工作区签发与使用，常规工作区签发拒绝 `not_trial_workspace`，每次调用也重查（对旧版本签出的 Handle 同样生效）。关闭遗留 585。
  - 管理员智能体的上限里明确列出 5 个起草能力（`propose_skill`、`propose_procedure`、`propose_worker_definition`、`propose_operation`、`propose_ontology_change`），只产生待人发布的草稿；发布、批准、应用仍只走人的通道。
  - 草稿溯源 `origin`（`human` / `agent` / `platform`）由内核按调用通道与调用方 Principal 的种类推出，调用方不能传；服务 Principal 的 API key 经人的通道起草记 `agent`。关闭遗留 293。
  - 用户列表的「残留用户」：试验工作区的成员算真实成员。
- **发版说明可写**：平台可以建「试验工作区」，它是将来管理员智能体唯一能行动的地方，创建后不能改回常规、不能设为默认；Skill、Procedure、WorkerDefinition 与本体草稿记录是人、智能体还是平台自己起草的。
- **升级验收期间先别建试验工作区**：`create_workspace` 建试验工作区不受 `ADMIN_AGENT_ENABLED` 控制，一旦建了，只回滚代码的窗口就关上了（见下条与 §6）。
- **回滚**（见 §6 的三行）：只回滚代码的前提是 `select count(*) from workspaces where purpose = 'admin_trial'` 为 0（旧代码的线上 schema 不认这个值）。已经建过的，要先停用、等满 7 天（`PURGE_RETENTION_DAYS`）再清除——它不是临时工作区，不会过期清除——这 7 天里只能保留这个版本。`origin` 列可以留着，旧代码不读。迁移头注释没写这 7 天等待：0050 已在审查与验收环境跑过，改文件会让迁移校验和对不上，以这里为准（#914 #488 P3-a）。

### 3.102 管理员提案：管理员智能体提议、读回与撤回（#916，S11 AA3b-1，0.61.0 起）

带一个迁移 governance `0032_admin_proposals`，随 `apply-release.sh` 自动应用。不改 compose，没有新环境变量，主机不需要操作；`ADMIN_AGENT_ENABLED` 仍默认关，AA4 之前没有运行时会启动管理员智能体。

- **迁移**：新表 `admin_proposals`、`admin_proposal_segments` 及其函数（含 security definer `admin_proposals_proposed_today()`），旧版本不读不写。
- **新线上**：7 个能力——`admin_proposal` 组（adminAgentOnly）`propose_admin_proposal`、`agent_list_admin_proposals`、`agent_get_admin_proposal`、`agent_withdraw_admin_proposal`；`platform` 组 `list_admin_proposals`、`get_admin_proposal`、`withdraw_admin_proposal`（参数 `proposalId`）。新错误码 `admin_proposal_target_unavailable`（400）、`admin_proposal_credential`（400）、`admin_proposal_quota_exceeded`（429，WS -32012）、`admin_proposal_not_found`（404）、`admin_proposal_not_open`（409）。契约快照只新增这 7 项。
- **发版说明可写**：管理员智能体可以在试验工作区里起草「管理员提案」（要改哪些正式工作区、改什么），读回和撤回自己的提案；平台管理员在平台面列出、查看、撤回全部提案。每位管理员每天（UTC）最多 20 份。提案只是提议，正式工作区的变化仍要人审批应用（AA3b-2 / AA3c 起）。
- **本地或验收环境的库**：跑过改名前 0032（表名 `change_plans`、`change_plan_segments`）的，删掉这两张表与它们的函数、删 `schema_migrations` 的 governance 32，再重跑迁移。没有主机跑过改名前的版本。
- **回滚**（见 §6）：只回退代码即可，表留着没人读。

### 3.103 目标工作区的所有者预览、应用或拒绝管理员提案的段（#920，S11 AA3b-2，0.61.0 起）

带一个迁移 governance `0033_change_segments_from_admin_proposals`，随 `apply-release.sh` 自动应用。不改 compose，没有新环境变量，主机不需要操作；`ADMIN_AGENT_ENABLED` 仍默认关。

- **迁移**：`change_segments.source_kind` 加 `admin_proposal`，`proposed_by` 改为可空；加 4 个溯源列（`admin_proposal_id`、`admin_proposal_segment_id`、`proposed_by_user`、`proposer_display_name`，没有外键，试验工作区清除后仍保留）、约束 `change_segments_proposer` 与唯一索引（每个提案段最多一条记录）；3 个守卫：`change_segments_admin_proposal_guard`（插入）、`admin_proposal_segments_record_guard`（`applied_segment_id` 必须是这一段的记录，只有带着那条记录才能 `rolled_back`，决定人与撤销人是事务的 Principal，同状态更新不改 `updated_at`）、`admin_proposals_proposer_guard`（`proposed_by` 是事务的 Principal）。
- **新线上**：4 个能力（`modules` 组、人的通道、`owner` 起、HUMAN_ONLY）`list_admin_proposal_segments`、`preview_admin_proposal_segment`、`apply_admin_proposal_segment`、`reject_admin_proposal_segment`。`ChangeSegmentWire.proposedBy` 可空，新增 `adminProposal { proposalId, proposalSegmentId, proposedBy { userId, displayName } } | null`，`source.kind` 加 `admin_proposal`。新错误码 `admin_proposal_segment_not_found`（404）、`admin_proposal_segment_not_open` / `admin_proposal_segment_blocked` / `admin_proposal_segment_unchanged`（409，WS `ILLEGAL_TRANSITION`）、`admin_proposal_role_mismatch`（403，WS `FORBIDDEN`）；应用时重新解析的摘要不一致沿用 `change_plan_changed`（409）。契约快照新增 4 项，另有 5 项结果 schema 随 `ChangeSegmentWire` 变化（`get_change_segment`、`list_change_segments`、`preview_roll_back_change_segment`、`roll_back_change_segment`、`verify_change_segment`）。
- **行为变化（遗留 600）**：内核在提议前按库里存的 `platform_role` 判断，与 `NEXTTIME_PLATFORM_ADMINS` 钉住的角色不一致时返回 403 `admin_proposal_role_mismatch`（先同步角色），什么都不写；按更严的那边算。
- **发版说明可写**：目标工作区的所有者可以预览、应用或拒绝发给自己的管理员提案段；应用的内容在「安装历史」里显示为「管理员提案 <来源名>」并写明提议的管理员，和能力包安装一样可以撤销。发布的版本记为智能体起草、由所有者发布。控制台还没有提案页面（AA4）。
- **回滚**（见 §6）：留着 0033 只回退代码不会损坏数据（旧代码从不写 `admin_proposal`，能力包照旧插入）。但旧代码把 `proposed_by` 内连接到 principals，`admin_proposal` 的记录（`proposed_by` 为空）对它不可见：列不出，get / verify / 撤销都返回 404。所以**要撤掉管理员提案应用的内容，先在 0.61.0 上撤销，再回退代码**（#920 #488 P3-a）。数据库只保证一个方向的一致性（提案段为 `rolled_back` 时记录一定已撤销），反方向由 `rollback.ts` 在同一事务里同时改两边。

### 3.104 管理员提案的平台部分：新建门实例（#921，S11 AA3c-1，0.61.0 起）

带一个迁移 governance `0034_admin_proposal_platform_segments`，随 `apply-release.sh` 自动应用。不改 compose，没有新环境变量，主机不需要操作；`ADMIN_AGENT_ENABLED` 仍默认关。AA3c-1 与 AA3c-2（§3.106）之间不发版：AA3c-1 单独还没有提案依赖锁、数据库第二道墙与实例复核。

- **迁移**：`admin_proposal_segments` 的 authority 加 `platform`（没有目标工作区，每个提案最多一个：唯一索引 `admin_proposal_segments_one_platform`），条目类型按 authority 检查（平台部分只收 `gate_instance`、最多 10 个；工作区部分是四类版本），CHECK 按正向计数并用 strict 模式（每个条目是带字符串 `kind` 的对象，嵌套数组不能绕过）；新列 `decided_by_user`、`rolled_back_by_user`、`applied_platform_segment_id`（与 `decided_by` / `rolled_back_by` / `applied_segment_id` 互斥）；`withdrawn_origin` 加 `platform_segment`。新表 `platform_change_segments`、`platform_change_items` 只在平台面（强制 RLS，`app_platform()`），不对提案或 `gate_instances` 建外键（试验工作区清除、实例删除后记录仍保留），只授予 select / insert（段另有 update），不能删。守卫：替换 `admin_proposal_segments_guard` 与 `admin_proposal_segments_record_guard`（平台部分只在平台面、由当前管理员 `app.user_id` 决定与撤销），新增 `platform_change_segments_guard`（由应用事务在来源为 proposed 时写入，之后只能 applied → rolled_back，不可删）与 `platform_change_items_guard`（只由写记录的事务写入、之后不改，放宽权限边界的条目要应用人确认，I-A4）。security definer 函数 `admin_proposal_platform_segment(proposal_id)` 只回答事务自己的工作区、且它是该提案某个工作区部分的目标时。
- **新线上**：7 个能力（平台范围、人的通道）`preview_platform_segment`、`apply_platform_segment`、`reject_platform_segment`、`list_platform_change_segments`、`get_platform_change_segment`、`preview_roll_back_platform_change_segment`、`roll_back_platform_change_segment`。`propose_admin_proposal` 可带 `platform { items: gate_instance[] }`；提案的段可以是 authority `platform`（`targetWorkspaceId` 为 null）；`withdrawnOrigin` 加 `platform_segment`；工作区部分的预览与列表加 `segment.platformSegment`（id、status）；`platform_state_connectors` 加 `presets`（白名单字段：name、transportKind、credentialMode、operations {name, mode, blastRadius} 最多 100、operationCount、packagedConnector、instanceCount）。新错误码 `platform_change_segment_not_found`（404，WS `NOT_FOUND`），`platform_segment_not_applied`、`platform_change_segment_rolled_back`、`platform_change_drifted`、`dependent_segments_applied`（409，WS `ILLEGAL_TRANSITION`）。平台新审计动作 `gate_instance.created`（每个应用的条目一条）、`gate_instance.disabled`（撤销停用的每个实例一条）。契约快照新增 7 项、11 项变化。
- **行为变化**：
  - `create_gate_instance` 的 target 上限从 2000 字符降到 500（与门主机能宣告的一致；`update_gate_instance` 不收 target）；已有的更长实例照常可读、可停用。
  - 审计：处理器自己追加的审计内容在工作区与平台两条路径上都过同一份审计副本（门地址按连接规则截掉、像密钥的值隐藏），平台范围的审计行现在也带处理器的 `auditPayload`（固定字段 channel / actorLogin / params 优先）；params 副本先截掉带凭证的门地址（`sig=`、`X-Amz-Signature=`、userinfo），`redactedValues` 计数；干净的地址照原样记录。
- **发版说明可写**：管理员提案可以带一个「平台部分」，内容是新建门实例；平台管理员预览、应用或拒绝它，并能撤销它创建的东西（实例停用，不删除）。提案的工作区部分要等平台部分应用后才能应用。控制台还没有页面（AA4）。控制台文案写「平台部分 / 工作区部分」（英文 platform part / workspace part），不写「段」。
- **回滚**（见 §6）：没有平台部分时只回退代码不损坏数据（旧代码从不写 authority `platform`）。有了之后，旧代码会列出它、目标为空、决定不了：先在 0.61.0 上应用或拒绝（或撤回提案），再回退代码。

### 3.105 成员资格带工作区用途，控制台标出试验工作区；手机导航抽屉恢复（#924，遗留 596、610，0.61.0 起）

没有迁移，不改 compose，没有新环境变量，主机不需要操作。

- **新线上**：`UserMembershipWire` 加必填 `workspacePurpose`（`standard` / `ephemeral` / `admin_trial`），`/api/auth/me`、登录、会话返回的成员资格也带它。契约快照 9 项 schema 变化：`add_membership`、`create_user`、`list_user_memberships`、`list_users`、`merge_user`、`set_membership_role`、`set_user_budget`、`set_user_status`、`update_user`。控制台与内核同版发布；旧控制台忽略这个字段，新控制台遇到不带它的旧内核就不加标注。
- **发版说明可写**：控制台在工作区切换器、侧栏卡片（琥珀色「试验」）、平台用户列表、成员资格面板、账户页与手机顶栏标出试验工作区（临时工作区带「（临时）」）。手机（≤960）上的导航抽屉恢复了导航文字、工作区块与切换器，手机上又能切换工作区（遗留 610，P1：此前 `shell.css` 里 ≤1100 的窄栏规则没有限定在 `.sidebar` 下）。用 API key 登录的会话没有成员资格，不显示「试验」标记。
- **回滚**：只回退代码即可。

### 3.106 管理员提案的平台依赖：锁、数据库第二道墙与实例复核（#923，S11 AA3c-2，0.61.0 起）

带一个迁移 governance `0035_admin_proposal_platform_dependency`，随 `apply-release.sh` 自动应用；只有函数、触发器和一个索引，不存数据。不改 compose，没有新环境变量，主机不需要操作；`ADMIN_AGENT_ENABLED` 仍默认关。

- **迁移**：
  - 触发器 `admin_proposal_segments_platform_dependency`：工作区部分要变成 applied，提案必须没有平台部分，或者平台部分和它的平台变更记录都已 applied。
  - 触发器 `platform_change_segments_rollback_dependency`：平台变更记录要从 applied 变成 rolled_back，提案的工作区部分必须都没有 applied，而且以本提案为来源的 change segment（`change_segments.admin_proposal_id`，任何工作区）都已撤销；试验工作区清除之后也成立。
  - 两个触发器都拿提案依赖锁（advisory 命名空间 7241033，第二个键是 `hashtext(proposal_id)`）：工作区应用拿共享锁，平台撤销拿排他锁。内核路径先拿这把锁再拿行锁；两个都绕过内核、顺序相反的写入可能死锁，Postgres 会中止其中一个，两边都不落库（0035 文件头写明，遗留 608）。
  - security definer 读函数：`admin_proposal_platform_change(proposal_id)` 只回答该提案某个工作区部分的目标工作区，返回已应用记录的 id、审阅摘要和每个条目的门 id / 连接器 / 定义；`admin_proposal_applied_workspace_changes(proposal_id)` 只在平台面回答，列出已应用的依赖。两条的隔离条件都有测试守住。
  - 索引 `change_segments_admin_proposal`。
- **新线上**：新错误码 `platform_segment_changed`（409，WS `ILLEGAL_TRANSITION`，`details.items [{gateId, gone, drift}]`）。平台变更记录被撤销时也返回 `platform_segment_not_applied`（`platformSegmentStatus` 为 `rolled_back`）。`preview_admin_proposal_segment` 的结果加 `platformChanges`，blocker 加可选的 `gateAvailability`（只在 `gate_not_enabled` 上：`can_enable` / `needs_platform`）。`preview_roll_back_platform_change_segment` 的 `dependentsApplied` 改从 change segment 读（试验工作区清除后也列得出）。契约快照 1 项变化（`preview_admin_proposal_segment`）。
- **发版说明可写**：管理员提案的工作区部分应用前，会对照它的平台部分创建的门实例再查一遍；实例在那之后被改过或删了，就列出改了什么，不能应用（`platform_segment_changed`）。工作区部分的审阅摘要现在也覆盖管理员应用的那个平台部分。
- **已知问题**（0.61.0 带着发，下一版 AA4-0 修，遗留 609）：
  - 中：管理员智能体读回自己的管理员提案时（提议的返回、`agent_get_admin_proposal`、`agent_withdraw_admin_proposal`），能看到平台部分新建门宿主实例的地址和 OpenAPI 地址。这些地址都是它自己提议的，提议时已拒绝任何带凭据的地址。下一版去掉。
  - EN: When the admin agent reads back its own admin proposal (the propose result, `agent_get_admin_proposal`, `agent_withdraw_admin_proposal`), it sees the addresses (target and OpenAPI URL) of the gate-host instances the platform part proposes. These are addresses it proposed itself, and any address carrying a credential was refused when proposed. Fixed in the next release.
- **回滚**（见 §6）：只回退代码不损坏数据（0.60.0 没有平台部分，这两个守卫不会拦它做的事）。

### 3.107 审阅页显示草稿的起草方（#927，遗留 597，0.61.0 起）

只改控制台：没有迁移，没有线上变化，契约快照不变，不改 compose，主机不需要操作。

- **发版说明可写**：Skill、流程、Worker 定义、Operation 和本体提案的审阅页显示草稿是谁写的（「起草方」：人 / 智能体 / 平台模板；Operation 是门的清单 / 人 / 智能体）。智能体写的草稿带一句提醒：发布前逐项核对；最后由智能体写的 Operation 草稿说明它可能已替换提议者原来的内容。Worker 定义和 Operation 的审阅页现在也显示提议者。文案写「智能体」而不是「管理员智能体」、写「可能已被替换」而不是「改写」：内核对所有智能体会话和 Handle 都记 `agent`，也不记录一次写入是否替换了人的草稿（AA4 方案 F10-4，协调线程 11-02 决定，AA5 实际用过后再看）。#914 之前写的版本没有记录起草方，不显示这一行。
- **回滚**：只回退代码即可。

### 3.108 所有者在能力目录里审阅管理员提案（#929，S11 AA4a，0.61.0 起）

只改控制台：没有迁移，没有线上变化，契约快照不变，不改 compose，主机不需要操作；`ADMIN_AGENT_ENABLED` 仍默认关。

- **发版说明可写**：工作区所有者在「能力目录」多了「管理员提案」页签，列出管理员提案发给本工作区的部分（默认只看待确认），逐条审阅后应用或写理由拒绝。审阅页写清楚每个条目改什么；扩大权限的条目要逐项确认，含疑似凭据时要勾核对框；系统还没启用时能就地启用，或写明要等平台管理员。平台部分还没应用、或它建的门实例后来被改过时，不能应用并写明原因。拒绝理由留在这个工作区，平台管理员也看得到，提议它的管理员智能体只知道被拒绝了。「安装历史」里来自管理员提案的记录带上提案的标题、说明和链接。图谱抽屉的「提案」改叫「本体提案」。只有所有者看得到这些。
- **回滚**：只回退代码即可。

### 3.109 管理员智能体的观察记下会话；平台运行状态不再占着事务调 HTTP；平台部分撤销预览列出工作区；智能体读不到门地址（#933，S11 AA4-0，0.62.0 起）

带一个迁移 core `0052_activity_session_record`（只替换一个触发器函数，不存数据），随 `apply-release.sh` 自动应用。不改 compose，没有新环境变量，主机不需要操作；`ADMIN_AGENT_ENABLED` 仍默认关。

- **迁移**：替换 `activities_trigger_record_guard`：在 0046 的守卫上加两个键 `metadata.sessionKind`、`metadata.sessionId`，有没有和取值都不能被 update 改。
- **新线上**：
  - `preview_roll_back_platform_change_segment`、`roll_back_platform_change_segment` 的条目加必填 `enabledIn: [{workspaceId, name, purpose}]`（按名字排，最多 50 个；`linkedWorkspaceCount` 仍是总数）。控制台从 AA4b 起读它。
  - 智能体一侧：`propose_admin_proposal`、`agent_get_admin_proposal`、`agent_withdraw_admin_proposal` 改返回 `AgentAdminProposalWireSchema`：平台部分的 `gate_instance` 条目不带 `target` / `manifestSource`，带 `addressWithheld: true`。平台管理员与所有者读到的不变（协调线程 11-02 决定：人读得到，智能体读不到；F9 在提议时已拒绝带凭据的地址）。
  - 契约快照 5 项变化（上面两个撤销能力 + 三个智能体能力）。
- **行为变化**：
  - 经管理员智能体会话的观察（`observe_operation`、`request_action` 的观察分支）在 Activity 的 metadata 里记 `sessionKind` / `sessionId`，能和本人的观察区分开（遗留 584）。
  - 管理员智能体调 `platform_state_runtime` 时，先在事务外取 worker-supervisor 的列表和健康探测，再开只读事务；取的过程中被降权，调用拒绝 `not_platform_admin`。返回形状不变（遗留 592）。
- **发版说明可写**：0.61.0 的已知问题已修复，管理员智能体读回自己的管理员提案时不再看到平台部分门宿主实例的地址（遗留 609）。平台部分的撤销预览列出启用了每个实例的工作区。
- **回滚**（见 §6）：只回退代码不损坏数据：0.61.0 及更早的代码从不写 Activity 的 `metadata.sessionKind` / `metadata.sessionId`。回退到 0.61.0 后，智能体读回提案又能看到门地址（回到 0.61.0 的已知问题）。

### 3.110 平台管理员在平台面审阅管理员提案与平台变更记录（#936，S11 AA4b，0.62.0 起）

只改控制台：没有迁移，没有线上变化，契约快照不变，不改 compose，主机不需要操作；`ADMIN_AGENT_ENABLED` 仍默认关。

- **发版说明可写**：「平台」组下新增「管理员提案」页，两个标签。平台管理员在「管理员提案」里看全部提案（默认列出全部，可按状态筛选）、审阅并应用或写理由拒绝平台部分（每个要新建的门宿主实例逐项确认，含疑似凭据时要勾核对框，和平台现状对不上时不能应用并写明原因）、撤回整份提案；工作区部分只显示状态和所有者写下的理由，不显示它要在工作区里改什么。在「平台变更记录」里看应用留下的记录和每个实例现在的样子，并从那里撤销：确认框按实例列出已启用它的工作区并链接到停用的地方，有工作区部分已应用时不能撤销。英文界面统一把门宿主实例叫 gate-host instance。
- **回滚**：只回退代码即可。

### 3.111 管理员智能体的对话、目标工作区、状态与停止（内核）（#937，S11 AA4c-1，0.62.0 起）

带两个迁移，随 `apply-release.sh` 自动应用：core `0053_chat_agent_kind`（`chats.agent_kind`、两个约束、守卫触发器）、governance `0036_admin_agent_targets`（新平台表 `admin_agent_targets`、两个 security definer 读函数、两个守卫触发器）。不改 compose，没有新环境变量，主机不需要操作；`ADMIN_AGENT_ENABLED` 仍默认关，主机没开，所以下面的行为变化对主机没有影响。

- **发版说明可写**：对话分两种，入口智能体的和管理员智能体的。平台管理员可以在试验工作区里开管理员对话（开关开着才行），这些对话只有本人看得到；同一个人在同一个试验工作区的管理员对话共用一个会话，模型调用与出网按会话分开记账，不会记到同时开着的入口对话上。平台管理员在平台面为自己的管理员智能体选目标工作区（最多 20 个），智能体只能向选中的工作区提议；提案在提议时固定目标，之后去掉的目标上的工作区部分不能再应用，要重新提议。平台管理员能看到自己的管理员智能体状态（能不能用、目标、在用的会话），并能停掉它（吊销会话与 Handle，停掉正在跑的管理员 Turn，入口 Turn 不动）。这一段只是内核；控制台页面在 AA4c-3，运行时在 AA4c-2，合入前管理员 Turn 一律以 `failed` 结束、不交给入口容器。
- **行为变化**：这一版之前，管理员智能体可以向任何在用的标准工作区提议；之后要平台管理员先选目标（400 `admin_proposal_target_not_chosen`）。
- **线上**：新能力 `get_admin_agent_status`、`set_admin_agent_targets`、`stop_admin_agent`（平台面）与 `agent_list_proposal_targets`（管理员上限，`adminAgentOnly`）；`new_chat` 加 `agentKind`，`ChatWire` 加 `agentKind`，`TurnStarted` 加可选的 `agentKind`、`sessionId`，`preview_admin_proposal_segment` 加 `targetChosen`；新错误码 `admin_agent_refused`（403）、`admin_proposal_target_not_chosen`（400）、`admin_proposal_target_no_longer_chosen`（409）、`admin_role_not_stored`（409）。契约快照已更新。
- **回滚**（见 §6 两行）：
  - core 0053：只回退代码前先确认 `select count(*) from chats where agent_kind = 'admin_agent'` 为 0，不为 0 就先把这些对话归档；否则旧代码会把它们当普通私有对话，交给入口智能体起 Turn。
  - governance 0036：只回退代码前要先删掉守卫 `drop trigger admin_proposal_segments_target_chosen on admin_proposal_segments` 和它的函数，否则旧代码提议、应用工作区部分时会被这个守卫拒绝。

### 3.112 管理员智能体的运行时：自己的容器、提示词与扩展模式（#941，S11 AA4c-2，0.62.0 起）

没有迁移，不改 compose，没有新环境变量，主机不需要操作；`ADMIN_AGENT_ENABLED` 仍默认关，主机没开，对主机没有影响。

- **同版升级**：kernel、agent-host、worker-supervisor 三个服务与 worker-runtime 镜像（`entrypoint.sh`、platform-extension）必须一起升。不带 `agentKind` 的帧和请求仍是入口智能体，行为与以前一样；内核只在管理员 Turn 上写这个字段，所以 agent-host 落后时只会拒掉管理员 Turn。
- **发版说明可写**：管理员 Turn 真正跑起来，始终在自己的容器里（`nexttime-admin-<id>`，标签 `nexttime.role=admin`；工作目录与平台目录和入口容器分开，互相挂不到）。管理员容器的出网在绑定 Handle 之前登记为全部拒绝，登记失败就删容器；容器启动自检要求经代理的出网被拒、并且有平台给的管理员提示词，否则不启动 pi。扩展的 `admin` 模式只注册管理员上限里的能力和本工作区 observe 类门工具；每个 Turn 开始时把目标工作区 id 放进上下文。提示词随包在 `ontology/admin-agent.yaml`，只是系统提示词，不授予任何东西。Handle 在 Turn 记录的管理员会话下签发（最长一小时，按人 × 试验工作区缓存、原地换绑）。`stop_admin_agent` 与降级在提交后停管理员容器，停用一个人或一个工作区停两种容器。滚动升级与平台运行状态只看入口容器，管理员 Turn 不拦入口容器的滚动。
- **线上**：`startTurn` / `stopTurn` 帧加可选 `agentKind: 'admin_agent'`；`/resident/spawn`、`/resident/stop`、`GET /resident/:id`、`POST /resident/:id/touch` 加可选 `agentKind`，`/resident/reclaim` 清全部种类；`listResidents` 每条带 `agentKind`；`EXTENSION_MODE_VALUES` 加 `admin`。`scripts/delete-workspace.sh` 同时删管理员容器和它的两个目录。
- **回滚**：只回退代码即可，但**回退代码之前先删掉管理员容器**：`docker ps -aq --filter label=nexttime.role=admin | xargs -r docker rm -f`（容器名为 `nexttime-admin-*`）。旧的 supervisor 只认 `nexttime.role=entry`，看不到这些容器，它们在出网映射里的条目也只在容器被删除时才清掉。`workspaces/.admin/` 与 `workspaces/.platform/admin-agents/` 两个目录可以留着，旧代码不读。

### 3.113 平台管理员在控制台里使用管理员智能体（#943，S11 AA4c-3，0.62.0 起）

只改控制台：没有迁移，没有线上契约变化，不改 compose，主机不需要操作；`ADMIN_AGENT_ENABLED` 仍默认关。控制台要和 §3.111、§3.112 的内核与运行时同版（它读 `get_admin_agent_status`、调 `set_admin_agent_targets`、`stop_admin_agent` 与 `new_chat {agentKind}`）。

- **发版说明可写**：「平台」组下新增「管理员智能体」页：每个试验工作区一张卡，写明能不能开始（不能时写原因、不给按钮）、目标工作区（停用的标出）、在用的会话；可以打开管理员对话、在对话框里选目标工作区（只能选常规、启用中的工作区，最多 20 个，保存前对比加上与去掉的，并写明这组目标由这个试验工作区里你的所有管理员对话共用）、停止一个或全部会话（确认框写明吊销与停下的范围）。平台开关关着时，页面只说一次需要维护者在主机上打开，已有对话照常能读。试验工作区的对话里多「新管理员对话」，管理员对话在列表和标题栏标「管理员智能体」。审计里经管理员智能体的行标「由管理员智能体代为」（遗留 583）；管理员智能体的几项能力统一叫「管理员智能体……」（遗留 591）。目标被去掉的工作区部分在「能力目录 → 管理员提案」里写明原因并置灰应用。Skill、流程、Worker、Operation、本体提案的列表行给智能体写的草稿加琥珀色「智能体」标记（遗留 602）。窄栏里试验工作区有图标级标记。
- **回滚**：只回退代码即可。

### 3.114 管理员智能体的 CI 旅程与 CI 专用提议标记（#945，S11 AA4d-1，0.62.0 起）

没有迁移，没有线上契约变化，不改 compose，主机不需要操作；`ADMIN_AGENT_ENABLED` 仍默认关。

- **发版说明可写**：控制台 e2e 新增旅程 ⑨（管理员智能体提一份管理员提案，平台和工作区各自决定）。内核多一个只在 CI 里接的钩子 `fake-admin-propose.ts`：只有 `FAKE_INVOKE_WORKER=1`（只在 `deploy/ci/env.ci.template` 里设）且 fake 运行时在管理员 Turn 里看到 CI 标记时才调用，用这一轮会话签发的管理员 Handle 走真实的 `propose_admin_proposal` 分发，不授予任何东西。守卫 `scripts/guards/fake-markers.mjs`（进 `pnpm ci:guards`）保证两个 CI 标记只出现在 fake 运行时与 e2e spec 里，钩子只能被允许的内核文件、不经别名导入。`.env.example` 改正了 `ADMIN_AGENT_ENABLED` 的说明：它只在 `secrets/kernel.env` 里生效（遗留 620）。
- **升级时确认**：主机 `secrets/kernel.env` 与 `.env` 里都不应该有 `FAKE_INVOKE_WORKER`；有就删掉，它只属于 CI。
- **回滚**：只回退代码即可。

### 3.115 管理员提案的交接入口：所有者待办计数、对话里的提案链接、建好试验工作区后回到管理员智能体（#947，S11 AA4e，0.62.0 起）

没有迁移，不改 compose，主机不需要操作；`ADMIN_AGENT_ENABLED` 仍默认关。控制台与内核同版（新能力）。

- **线上**：新增只读能力 `get_admin_proposal_segment_counts`（只给所有者：`minRole: owner`、`human` 通道、`actsForPerson`、`HUMAN_ONLY`），返回本工作区还没决定的管理员提案工作区部分数 `{ proposed }`，范围与 `list_admin_proposal_segments {status:'proposed'}` 一致；契约快照已更新。
- **发版说明可写**：目标工作区的所有者在侧栏「能力目录」角标、「管理员提案」页签数字和「待我审批」顶部提示里看到有几份管理员提案等他处理（只在控制台内，不发外部通知）；管理员智能体提议成功后，对话里的工具调用行与折叠行带「在 平台 · 管理员提案 查看」链接（id 从调用结果读，不看模型怎么写）；从「管理员智能体」新建试验工作区后回到那张卡片；管理员对话里还没选目标时输入区上方提示；标题栏「目标工作区…」直接打开选择对话框；已有试验工作区时页头多「新建试验工作区」。
- **回滚**：只回退代码即可。

### 3.116 平台管理员的管理员提案列表单列平台部分状态（#951，遗留 619，0.62.0 起）

没有迁移，不改 compose，主机不需要操作；`ADMIN_AGENT_ENABLED` 仍默认关。控制台与内核同版。

- **线上（加法）**：`AdminProposalSummaryWire` 加 `platformSegmentStatus`（平台部分的状态，没有平台部分时为 `null`；`segmentCounts` 照旧把平台部分算进去）；`list_admin_proposals` 加可选参数 `platformSegmentStatus`，与 `status` 同时给时两个条件都要满足，都在截取前 100 条之前生效。管理员智能体的 `agent_list_admin_proposals` 与提案读回也带这个字段（只是它自己提案的状态）。契约快照已更新。
- **发版说明可写**：「平台 → 管理员提案」列表每行把平台部分单独写出来（例如「平台部分：待你决定；工作区部分：待确认 2」，待你决定的加粗），筛选多一项「平台部分待你决定」。
- **回滚**：只回退代码即可。

### 3.117 管理员智能体在 staging 预演里用真 pi 跑一遍（#949，S11 AA4d-2，0.62.0 起）

只改验收脚本、驱动、fake-llm、手册和一个测试：没有迁移，没有线上契约变化，生产代码行为不变（platform-extension 只多导出一个常量），不改 compose，主机不需要操作。

- **发版说明可写**：S2 验收新增管理员智能体场景（`scripts/lib/accept-s2-admin-agent.sh`）：本次专用的平台管理员在试验工作区开管理员对话，真 pi 在管理员容器里依次调 `agent_list_proposal_targets`、`platform_state_connectors`、`propose_admin_proposal`，脚本核对容器（`nexttime.role=admin`、没有入口容器）、工具列表（没有只属于入口智能体的六个）、提案（`origin = agent`、地址隐去）与审计（`sessionKind = admin_agent`），收尾撤回提案、停止管理员智能体、回收容器、停用两个工作区、降级管理员。
- **主机 apply**：脚本只读运行中内核的 `ADMIN_AGENT_ENABLED`，从不替主机打开；开关关着（主机默认）时只打一行 `NOTE admin-agent … not run`，S2 仍是 `S2 OK`。维护者以后打开开关时，S2 会建一个本次专用的管理员和两个工作区，收尾时停用和降级；降级被拒（它是最后一个启用的管理员）或控制台登录失败时脚本记一行，要到「平台 · 用户」里手工降级（`host-accept-s2.md` §2、§6）。staging 预演在一次性的 `secrets/kernel.env` 里打开开关并设 `ACCEPT_REQUIRE_ADMIN_AGENT=1`，开关没开就 `FAIL admin-agent-switch`。
- **回滚**：只回退代码即可。

### 3.118 新装主机默认打开管理员智能体（#957，S11，0.62.0 起）

不改内核行为（内核自身仍是没设 `ADMIN_AGENT_ENABLED` 就关），没有迁移，不改 compose，契约不变。只改 `scripts/host-env-init.sh`、e2e 与 staging 预演的检查和手册。

- **发版说明可写**：新装主机的 `secrets/kernel.env` 默认带 `ADMIN_AGENT_ENABLED=1`，管理员智能体默认打开；改成 0 并重建内核（`docker compose up -d --force-recreate kernel`）即可关闭。
- **已有主机升级不受影响**：`host-env-init.sh` 只在 `kernel.env` 缺失或为空时才写，从不改写；`kernel.env` 写什么就是什么，没写就是关。要打开时在 `kernel.env` 里加 `ADMIN_AGENT_ENABLED=1` 并 `docker compose up -d --force-recreate kernel`（`host-checkout.md` §E3.3）。主机现在停在 v0.50.0，升级时不会因此打开。
- **回滚**：只回滚代码；已经生成的 `kernel.env` 不会被改回去，要关就手工改成 0 并重建内核。

### 3.119 管理员智能体在试验工作区里请人接系统、试跑 Worker（#954，S11 AA5a-1，0.62.0 起）

带两个迁移，随 `apply-release.sh` 自动应用：task `0013_task_admin_agent_session`（`tasks.admin_agent_session_id`）、governance `0037_connection_request_admin_agent_session`（`connection_requests.admin_agent_session_id`）。两列都可空、不回填，各带到 `sessions` 的外键和一个守卫触发器。不改 compose，没有新环境变量，主机不需要操作；`ADMIN_AGENT_ENABLED` 仍默认关，主机没开，所以管理员智能体的两项新能力对主机没有影响。

- **发版说明可写**：管理员智能体在试验工作区里多了两个能力：`request_connection`（请人接一个系统，凭证由平台管理员在控制台录入，智能体看不到）和 `invoke_worker`（跑这个工作区已发布的 Worker）。两者只在试验工作区生效，由内核和数据库强制；接入请求和 Task 都记下来自哪个管理员智能体会话，Task 记到管理员智能体自己的 Turn。试验工作区里，通用连接器是「平台预置」时，平台管理员也可以自接 http / mcp 系统，每用一次都单独记一条审计；连接器被「禁用」时没有例外。
- **行为变化**：这一版之前，通用连接器是「平台预置」时任何工作区都不能自接；之后在用的试验工作区里，由有效的平台管理员请求或完成的 http / mcp 自接可以放行（审计动作 `connection.trial_self_connect`）。其他工作区、其他种类和「禁用」照旧 409 `connector_not_self_serve`。
- **线上**：`TaskWire.adminAgentSessionId`、`ConnectionRequestWire.adminAgentSessionId`（可选，只在管理员智能体的记录上出现）；管理员智能体上限加 `request_connection`、`invoke_worker`，另有只给它派出的 Worker 用的 `report_task_result`（`ADMIN_AGENT_CEILING_FOR_ITS_WORKERS`）；新审计动作 `connection.trial_self_connect`。契约快照已更新。
- **Handle**：管理员智能体的 Handle 带上这个人在试验工作区的门（与入口智能体 Handle 同一个门集合）；门授权变动时，它的 Handle 和入口智能体的一起吊销（会话不动）。没有迁移，只需回滚代码。
- **回滚**（见 §6 两行）：task 0013 和 governance 0037 回滚时只回代码即可（新列可空、不回填，旧版本不写这一列）；要连列一起删，按两个迁移头注释写的顺序：先删 trigger，再删 function，再 drop column，最后删 `schema_migrations` 里对应的行。

### 3.120 管理员智能体对同一目标反复被拒后熔断（#956，S11 AA5a-2，遗留 595，0.62.0 起）

带一个迁移，随 `apply-release.sh` 自动应用：governance `0038_admin_proposal_rejection_reads`（只建一个 security definer 函数 `admin_proposal_rejections_since(timestamptz)`）。不改 compose；两个新的可选环境变量，主机不设就用默认值，不需要操作。`ADMIN_AGENT_ENABLED` 在主机上没开，所以下面的行为变化对主机没有影响。

- **发版说明可写**：同一位平台管理员提给同一个目标工作区的工作区部分，在 7 天内被拒满 3 次后，管理员智能体再提议到这个目标会被拒绝（429 `admin_proposal_target_rejected_repeatedly`），什么也不写入；能让计数降到上限以下的那次拒绝移出窗口后自动恢复。每次拦下都在试验工作区写一行审计，控制台审计行上写明原因、恢复时间和去哪里看拒绝理由；智能体看不到目标 id、提案 id 和所有者写的理由。
- **环境变量**（可选，`secrets/kernel.env`）：`ADMIN_PROPOSAL_REJECTION_LIMIT`（默认 3）、`ADMIN_PROPOSAL_REJECTION_WINDOW_DAYS`（默认 7）。必须是不小于 1 的整数，空值按默认；写错的值会让内核在启动时停下，报错里写出变量名和默认值。改了要 `docker compose up -d --force-recreate kernel`。
- **线上**：新错误码 `admin_proposal_target_rejected_repeatedly`（HTTP 429；WebSocket 是 `QUOTA_EXCEEDED` -32012，和每日配额同类）；`propose_admin_proposal` 的说明加上这条。契约快照不变。
- **回滚**（见 §6 一行）：上一版不调这个函数，只回滚代码就行；要删函数：`drop function admin_proposal_rejections_since(timestamptz)`，再删 `schema_migrations` 里 governance 38 那一行。

### 3.121 管理员对话链到 Task 和「完成连接」，试验例外的文案（#961，S11 AA5b，0.62.0 起）

只改控制台：没有迁移，不改 compose，没有新环境变量，线上契约不变，主机不需要操作。

- **发版说明可写**：对话里 `invoke_worker` 那一行链接到它建的 Task，`request_connection` 那一行链接到「系统与授权」并直接打开这张申请的「完成连接」抽屉（深链 `#/govern/systems?complete=<申请 id>`；申请已完成、已取消、不在这个工作区或读者完成不了时，页面说明原因）。入口智能体的这两种调用同样有链接。试验工作区里，管理员智能体提的申请和建的 Task 标「由管理员智能体代为」；不是平台管理员的所有者在 http / mcp 申请卡上看到「平台预置时只有平台管理员能完成」。「平台预置」的说明补上试验工作区例外，审计页认得 `connection.trial_self_connect`。
- **回滚**：只回滚代码。

### 3.122 管理员智能体的工单旅程：试验、提案、应用与验证（#959，S11 AA5c，0.62.0 起）

只改验收脚本、驱动、fake-llm、openapi 夹具与手册：没有迁移，线上契约不变，主机不需要操作。

- **主机 apply**：内核开着 `ADMIN_AGENT_ENABLED` 时（新装主机默认开，§3.118），accept_s2 在管理员智能体场景之后多跑一段工单旅程；开关关着时只多一行 `NOTE admin-agent-tickets … not run`。这段会：
  - 起停一个 `accept-s2-tickets-gate` 容器，数据目录在数据目录下的 `accept-s2/tickets-gate`，和其它 accept-s2 门一样保留；
  - 在平台上建一个 gate-host 实例 `accept-tickets-<nonce>`，收尾时回滚成停用；删不掉，每跑一次多一个（遗留 629）；
  - 新建一个连接器 `accept-s2-tickets`，回滚后保留，每台主机只建一次；
  - 在 gate-host 的加密存储里多一份测试用的生产凭证（本次随机生成）；
  - S2 摘要多两行 NOTE（授权门（试验）、验证）。
- **CI**：`quality` 多一步 openapi 夹具自测。
- **回滚**：只回滚代码。

### 3.123 审计流标出被拦下的调用（#964，遗留 628，0.62.0 起）

只改控制台：没有迁移，不改 compose，没有新环境变量，线上契约不变，主机不需要操作。

- **发版说明可写**：审计里被拒的调用（payload 为 `outcome: refused`）在动作名后面多一个红色「被拦下」标记，后面跟着拒绝码（写入方没记拒绝码的只显示标记）。工作区「审计」页、平台「审计」页、平台总览和平台状态页的「最近改动」都有。默认隐藏读操作时，被拒的读调用照样显示，「已隐藏 N 条读操作」只数没被拒的读。手机宽度下标记和拒绝码整组换行。
- **回滚**：只回滚代码。

### 3.124 管理员提案的验证会探它经过的门（#966，遗留 630，0.62.0 起）

没有迁移，不改 compose，没有新环境变量，线上契约形状不变，主机不需要操作。

- **发版说明可写**：验证一段已应用的管理员提案时，除了核验改动项还在生效，还会探这一段写入的 Operation 所在的门和 Worker 那一版里写的门，按系统分组，每个门都要连得通才算满足。门被平台切断（实例停用、连接挂起）或已经不在时，这个系统记成 `needs_platform`，不去探，验证不通过。这一段什么门都不经过时，照旧只核验改动项。控制台的验证结果文案相应调整。
- **行为变化**：管理员提案的验证可能从「通过」变成「不通过」，门不通或被切断时就会这样，这是本意。
- **回滚**：只回滚代码。

### 3.125 应用管理员提案时给 Worker 绑门，应用后自动验证一次（#968，S11 AA5f-1，0.63.0 起）

没有迁移，不改 compose，没有新环境变量，主机不需要操作。线上契约有新增（都是可选输入或新输出字段）：Worker 意图的 `systems`，preview / apply 的 `workerGates`，Worker 预览项的 `gateBinding`，新阻断 `worker_system_not_connected`（带 `connector`、`gateAvailability`、`offered`、`fromPlatformSegment`），apply 结果的 `verification`。

- **发版说明可写**：管理员智能体提议 Worker 时写明它要用的系统（`systems`，按连接器名，1–8 个，不能是通用连接器）。所有者预览、应用时，这个 Worker 在本工作区还没有门，就按这些系统绑到本工作区已接上的门上（默认全绑，可只留一部分）；已经有门的 Worker 保持不动。列出的系统在本工作区没有已接上的门时，这一项被阻断，控制台说明情况，能就地启用的可以就地启用。绑门不等于授权，授权之前用到这个 Worker 的步骤仍会被拒。应用工作区部分后会以所有者身份自动验证一次，结果随 apply 返回。
- **行为变化**：应用后马上手动验证会碰到 60 秒冷却；带 `systems` 的 Worker 在本工作区还没有门时，应用会给它绑门。
- **回滚**：只回滚代码。已存提案里 Worker 的 `systems` 旧代码不读（结果校验 `KERNEL_VALIDATE_RESULTS` 只在测试和 CI 里开），应用时按旧规则不绑门；已经绑门发布的 Worker 版本就是普通的已发布定义，不受影响。

### 3.126 应用管理员提案前在控制台选要绑的门，显示应用后的核验结果（#969，S11 AA5f-2，0.63.0 起）

只改控制台：没有迁移，不改 compose，没有新环境变量，线上契约不变，主机不需要操作。控制台与内核同版（用到 §3.125 的 `workerGates` 与 `verification`）。

- **发版说明可写**：能力目录 →「管理员提案」的预览里，应用时要绑门的 Worker 多一组复选框，默认全部绑上，可以取消勾选；没授权给自己的门有标注。改了勾选会按新的选择重新预览，之前的权限边界确认要重新勾。一个都不勾时写明后果。留下的门已经不能绑时（被平台切断或断开），选择改回默认并提示重新选。应用之后，详情里说应用后的核验结果（通过、没通过、没能核验）。
- **回滚**：只回滚代码。

### 3.127 镜像外的附加能力包目录 `config/packs/`（#971，S11 AA5d-1，0.63.0 起）

没有迁移。compose 有变化：kernel 多一个环境变量 `EXTRA_PACKS_DIR=/data/config/packs`（写在 compose 里，主机 `.env` 不用改），走已有的只读 `config/` 挂载。`host-env-init.sh`（新装）和 `apply-release.sh`（升级）都会建 `config/packs/`，空目录什么都不改。线上契约新增：`PackWire.source`（`builtin` / `extra`），平台面只读能力 `extra_packs_status`。

- **发版说明可写**：除了镜像自带的包，内核还读主机 `config/packs/` 里的附加能力包，放进去就生效、不用重启；在能力目录里标「附加」，安装、审阅、撤销、核验和自带包一样，附加包永远不当模块。附加包有问题只丢掉它自己（违反规则、是符号链接或在符号链接下面、和自带包或其他附加包撞名撞组成部分、依赖缺失或成环），其余照常；被丢掉的包和原因在平台面 `extra_packs_status` 里看（路径相对 `config/packs/`，疑似凭证打码），内核日志每条记一行 `extra_pack_skipped`。放包的步骤见 `operations.md` §14.10（先解到 `.incoming`、`--no-same-owner --no-same-permissions`、有符号链接就停下、`chmod` 后原子 `mv`）。
- **主机**：升级后 `config/packs/` 由 `apply-release.sh` 自动建好，不放包就没有任何变化。
- **回滚**：只回滚代码。`config/packs/` 留着无害，旧内核不读它；已经从附加包装进工作区的内容是普通的安装记录，撤销照旧（旧内核找不到这个包，安装记录可能显示成已定制，这一点是 #488 的推断，未验证）。

### 3.128 把验证通过的管理员提案导出成能力包（#976，S11 AA5d-2，0.63.0 起）

带一个迁移，随 `apply-release.sh` 自动应用：governance `0039_admin_proposal_segment_verified`（只建一个 security definer 函数 `admin_proposal_segment_verified(uuid)`）。不改 compose，没有新环境变量，主机不需要操作。线上契约新增：平台面能力 `export_admin_proposal_pack`，错误码 409 `admin_proposal_pack_not_exportable`（`details.problems`）。

- **发版说明可写**：平台管理员可以把一段已应用、并且在那个工作区里最近一次验证通过的管理员提案（工作区部分），导出成能力包的版本 1：带本体族、Skill、Worker（Worker 带它列的 `systems`，从不带门和模型），Operation 改动只列进 `omitted`。导出只返回文件、不写任何东西（只记一行审计），放进 `config/packs/` 后在应用过的工作区直接是「已是最新」，别的工作区像其他包一样装。不满足条件时一次列出所有原因（九种）。用法、拒绝原因和已知限制见 `operations.md` §14.11。
- **行为变化**：附加包与自带包的清单、Skill、Worker 文件不合 schema 时，原因从 zod 的整段 issue JSON 变成一行 `字段: 原因; …`（只是文字）。新能力不调就什么都不发生。
- **回滚**（见 §6 一行）：上一版不调这个函数，只回滚代码就行；要删函数：`drop function admin_proposal_segment_verified(uuid)`，再删 `schema_migrations` 里 governance 39 那一行。

### 3.129 控制台标出附加包、平台面看附加包状态、把管理员提案导出成能力包（#977，S11 AA5d-3，0.63.0 起）

只改控制台（加 runbook 一行）：没有迁移，不改 compose，没有新环境变量，线上契约不变，主机不需要操作。控制台与内核同版（用到 §3.127 的 `PackWire.source`、`extra_packs_status` 与 §3.128 的 `export_admin_proposal_pack`）。

- **发版说明可写**：能力目录里附加包标「本部署附加」，详情多一行「来源」。「平台 · 模块」多一张「本部署附加的能力包」卡片：读进来的包、没读进来的目录和原因、没配置 / 读不了 / 是空的各有说明，「重新读取」立刻重读目录。「平台 · 管理员提案」详情里，已应用的工作区部分可以「导出成能力包…」：写简介（默认提案标题）和说明（默认列出不带的 Operation 改动），导出后列出文件、没带的条目和摘要，可以下载成 `<名字>-1.tar`，按 `operations.md` §14.10 放进主机 `config/packs/`；被拒时逐条列出原因和位置；某个文件路径放不进 tar 时不下载，提示是哪条路径。
- **回滚**：只回滚代码。

### 3.130 验收：把工单旅程应用的部分导出成能力包，在第三个工作区安装（#979，S11 AA5d-4，0.63.0 起）

只改验收脚本和 runbook：没有迁移，不改 compose，没有新环境变量，线上契约和运行时都不变。

- **发版说明可写**：`accept_s2` 在管理员智能体工单旅程之后多一步 `admin_agent_pack_step`：平台管理员导出目标工作区已应用的部分（两次导出 digest 相同），维护者按 `operations.md` §14.10 放进 `config/packs/`，目标工作区读到它是附加包，第三个工作区由所有者启用门、审阅、安装并通过验证；人做的每件事逐条打印，作为 D-W5 证据。`operations.md` §14.10 的 `mkdir .incoming` 与 tar 串进同一条 `&&` 链；§14.11 写明导出命令、jq 读 `.result.files[]`、写文件前校验路径。
- **主机升级步骤不变**。在主机上跑 S2 时，`config/packs/` 里会短暂多一个 `accept-tickets-<nonce>` 包目录，收尾删掉（`--keep` 也删）；工单旅程没有应用工作区部分时这一步只打一行 `NOTE admin-agent-pack`。
- **回滚**：只回滚代码。

### 3.131 验收：`accept_s2 --real` 让真实模型走一遍管理员智能体工单旅程（#981，S11 AA5，0.63.0 起）

只改验收脚本和 runbook：没有迁移，不改 compose，没有新环境变量，线上契约和运行时都不变。

- **发版说明可写**：内核开着 `ADMIN_AGENT_ENABLED` 时，`accept_s2.sh --real` 多一项 `admin_tickets`：用这一轮的真实模型让管理员智能体在试验工作区接一个测试工单系统、起草 Worker 和 Skill、试开一张工单、提议到目标工作区；人的那几步由脚本扮演。结果是一行 `RUN scenario=admin_tickets`（`reached=` / `stuck=` / `turns=` / `nudges=` / `refused=` / `tokens=` / `cost_usd=` / `human_steps=` 等，见 `host-accept-real-model.md` §5），**模型没走完不让这一轮失败**；只有模型造不成的事（审批被绕过、正式凭证开了工单、凭证进了内核表、审计记错手、人的步骤失败、试验工作区被预算拒过）才 FAIL。内核开关关着时 NOTE 一行，S2 照样 OK。
- **主机升级步骤不变**。这一项不在主机上跑；合入后在 staging 上用 main 跑一轮 `--real`（runs=1、8M token 上限），结果记 STATUS。
- **回滚**：只回滚脚本。

### 3.132 只给能请求动作的 Handle 列执行类 Operation（#989，内核，0.63.0 起）

内核行为修正：没有迁移，不改 compose，没有新环境变量，线上契约 schema 不变（只改了 `propose_worker_definition` 的 description）。

- **发版说明可写**：`list_allowed_operations` 只在 Handle 持有 `request_action` 时列执行类 Operation。持有门、没有 `request_action` 的 Handle（例如没声明 `capabilities` 的 Worker）以前会拿到每次都 403 的执行类工具，现在不再列出，与 MCP 投影的规则一致；持有 `request_action` 的 Handle 列出的和以前一样。`propose_worker_definition` 的描述写清 worker 定义的字段、不写 `capabilities` 时的默认值、写了的列表会替换默认值、要请求动作必须显式列出 `request_action`。默认值不改：声明 `gates` 不隐式带上 `request_action`。
- **主机升级步骤不变**。
- **回滚**：只回滚代码。

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

### 3.156 评审员只读、受目标预算约束；运行时契约升到 3（#1123，S11 GO18a 两条 P3，0.68.0 之后的下一版）

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

### 3.157 公网门必须 https；JSON 键名里的凭据也拒收和遮蔽（#1129，遗留 413、444，0.68.0 之后的下一版）

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

### 3.158 门的地址不允许调用时回 424 `target_refused`（#1131，遗留 700，0.68.0 之后的下一版）

无迁移，**无主机动作**。线上契约变化：门的地址不是允许的目标时，调用的错误由 502 `gatekeeper_error` 变为 424 `target_refused`，带 `details.reason`。控制台与内核同版发布，不会出现旧控制台遇到新码。

- **行为变化**：接在 `http://` 公网地址上的自接门（§3.157），调用在发出前以 424 `target_refused` 拒绝，控制台标题「门的地址不允许调用」，说明用 https:// 重新接入；审计多一行 refused（不含地址）。
- **升级前后**：§3.157 的升级前只读核对照旧执行；查到的门，升级后由工作区所有者用 https:// 重新接入。自接门不能改地址（遗留 701），重新接入会成为一扇新门，操作要重新导入、发布，引用旧门的目标和流程要改。
- **回滚**：回代码即可，没有迁移。

### 3.159 reaper 结束已决 Task 下的活 WorkerRun（#1133，遗留 206、207，0.68.0 之后的下一版）

无迁移，线上契约不变。

- **行为变化**：升级后第一个 reaper tick（30 秒内）会结束已决（cancelled / failed / completed）Task 下仍是活状态的 WorkerRun，撤销 Handle 并停掉容器，审计 `worker_run.terminate`、`reason: task_ended`；Task 保持原终态。以前这些 run 要等到时长上限。对终态 Task 再调一次 `cancel_task` 也会立刻收掉残留 run。
- **升级前只读核对**（可选，结果记 `docs/private/`）：想事先知道会被结束哪些，跑 §3.22 的 Q3。主机从 v0.46 起已按 §3.22 处置过，预计为空。
- **回滚**：回代码即可，没有迁移。

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
  从 v0.45.0 及之后的版本回滚到 v0.44.0 及更早时，回滚前同样排空 Worker（§3.17 回滚段）。
  回滚 worker-supervisor 到 #818（§3.73）之前的版本前，先终止所有带 `nexttime.egress-deny-all=true`
  标签的 Task 容器，否则旧 supervisor 会把它们的出网重新登记成不受限。
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
本身也还原回去。自 2026-10-02（复审 R-11）起，这条命令先把现库改名留作回退，再恢复到一个新建的
`nexttime`，并且全有或全无，所以跨版本回滚不会再留下新版本的对象；失败时自动回到原库。

判定方法：**读 SQL 本身，也读 v(n-1) 那个版本里实际调用它的代码**，而不是"这条 SQL 只做了 ADD
COLUMN/CREATE FUNCTION，所以肯定可逆"这种表面判断——同一句"只是新增"，如果新增的是一个
`CREATE OR REPLACE FUNCTION` 改变了返回行数、或一个新的写入点校验会拒绝旧代码本来会发出的写入，
结论可能完全相反。`scripts/drill-upgrade.sh` 的 PROBE 步骤（"checkout v(n-1) 代码、在 v(n) 的
schema 上跑它自己的 `accept_s1.sh`"）就是把这条判断从"读代码得出的推理"变成"跑出来的证据"的机制；
下表的"依据"列是这次读代码得到的推理，PROBE 的实测结果作为独立证据附在旁边。

**S9 D4 起的实测方式——CI 可逆性探针（不碰任何线上库）**：`drill-upgrade.sh` 的回滚阶段会用备份覆盖
活库，只适合维护窗口。`.github/workflows/reversibility-probe.yml` 在 CI 里回答同一个问题：把 v(n) 的迁移
应用到一个全新的 Postgres，再在它上面跑 v(n-1) 的 kernel 测试套件（kernel 是唯一直接访问数据库的服务）。
改动 `packages/kernel/migrations/**` 的 PR 自动对"最新发布的 tag"跑一次，合入前就知道回滚是否安全；
历史版本对用 Actions 里 `workflow_dispatch`（base = 旧 tag，head = 新 tag）补跑。它证明的是**空库上的
schema 兼容性**，不覆盖依赖生产数据的问题；v(n) 改了 v(n-1) 已经应用过的迁移文件会以校验和不一致失败，
这本身就是不可逆的信号。失败要分辨"真不兼容"与"旧测试断言了新迁移有意改变的约束"，结论写进下表。

**有意变更的声明（2026-10-08 起，合并 main 须全部检查为绿）**：旧测试断言了新迁移有意改变的约束时，不再靠 PR
评论解释红灯，而是在迁移所在的 PR 里给 `packages/kernel/migrations/reversibility-deltas.json` 加一条声明——
哪个迁移（`<module>/NNNN_name.sql`）、v(n-1) 里哪几个测试（文件 + 完整名）、v(n) 里替代它们断言新行为的测试、
指向下表那一行的理由——随迁移一起评审。`scripts/reversibility-triage.mjs` 用证据核对每条声明：v(n-1) 的套件仍然
整套跑（不跳过任何测试）；每个失败都必须被"本 PR 新增的迁移"的声明覆盖（改动已发布的迁移不激活任何声明——那本身就是不可逆）；被声明的测试必须真的失败（不失败 =
声明过期，要删）；每个替代测试必须是本 PR 新增或改名的（v(n-1) 的结果里不能有同名测试），并在 v(n) 里、同一个库上通过；被声明测试所在的文件必须被本 PR 改动过（证明旧断言确实被重新审视过）；报告必须对得上账——Vitest 自己数的失败数等于逐条列出的失败数，同名测试取最差结果，v(n-1) 的退出码与报告一致，至少通过一个测试、跳过不超过 5%（防止没设 `DATABASE_URL` 时整套集成测试被跳过而误判为绿）；测试文件级错误、未处理异常一律算失败。
v(n-1) 已经发布过的迁移的声明自动失效（下一个 tag 带上新测试之后，该条可以删）。没有被声明覆盖的失败仍然让
探针保持红色，按"真不兼容"处理。

| 版本 | 迁移 | 可逆？ | 依据 | 回退方式 |
|---|---|---|---|---|
| v0.10.1 | （无——本版本只有 kernel 的连接池错误处理修复，无 schema 变更） | 可逆（N/A） | 无迁移可回退 | 按 §3 切回上一个 tag 即可，无需 `restore.sh` |
| v0.11.0 | core `0025_ontology_enforcement`：`workspaces` 新增 `ontology_enforcement`（既有行回填 `'warn'`，新行默认 `'reject'`），供写入点（`ontology-guard.ts`）按 I2 校验 Link | 可逆 | 校验逻辑本身在 v(n) 的 kernel 代码里（`enforceOntologyOnLinkWrite`），回退到 v(n-1) 代码后这段代码根本不存在，不会再读这一列；新列有默认值，v(n-1) 代码原有的显式列插入语句不受影响。唯一的操作性关联：STATUS "W9 主机应用注意"要求把既有工作区从 `warn` 手动切到 `reject` 是**前进方向**的滚动升级安全阀，不是回滚问题——回滚后这一列的值即使是 `reject`，v(n-1) 代码也不读它，纯元数据，不影响功能 | 只需回退代码 |
| v0.11.0 | core `0026_fact_freshness`：`links` 新增 `last_observation_id`/`last_observed_at`，`objects` 新增 `last_observed_at`，加一个索引 | 可逆 | 三列全部可空、无默认值以外的约束；`links_source_object_active_idx` 只是索引，不改变任何写入路径的语义。v(n-1) 代码的 `FACT_COLUMNS`/`OBJECT_COLUMNS` 是编译进二进制的显式列清单（`substrate/graph/queries.ts`），不会去读这三个新列，新增列对它完全透明 | 只需回退代码 |
| v0.11.0 | core `0027_find_active_facts_for_identity`：`CREATE OR REPLACE` 把 `find_active_fact_for_identity` 从"最多返回 1 行（`limit 1`）"改成"返回该身份全部仍活跃的 Fact（可能 > 1 行），且 `for update` 现在锁的是全部这些行" | 可逆 | 读了 v(n-1) 的调用方（`sql-store.ts` `assertFact`，`git show <v0.11.0 前一个 commit>`）：调用方只做 `priorResult.rows[0]`（取第一行）和 `rows.length === 0`（判断"完全没有"），两者在返回集从"至多 1 行"变成"至多 N 行（`order by recorded_at desc` 不变）"后行为不变——`rows[0]` 仍然是最新的那一行，`length === 0` 仍然只在真的没有活跃 Fact 时成立。v(n-1) 代码因此退化成它升级前本来的行为（对同一身份的多个活跃 Fact 只处理最新一条），这正是 S3.2 就已知、文档化过的既有局限，不是这次迁移新引入的破坏。唯一的真实差异：并发场景下现在会锁住更多行（更强的串行化），可能略增锁等待，不是正确性问题 | 只需回退代码（并发锁范围变化是性能/可用性层面的细微差异，不影响正确性） |
| v0.12.0 | core `0028_source_name_workspace_purpose`：`sources` 新增可空 `name`（仅在同一 `(workspace_id, kind, name)` 唯一时回填）+ 局部唯一索引 `where name is not null`；`workspaces` 新增 `purpose`（默认 `'standard'`）/`expires_at`（可空） | 可逆 | v(n-1) 的 `register_source`/`create-workspace` 不知道 `name`/`purpose`/`expires_at` 这几列，插入语句是显式列清单，不会给 `name` 赋值——插入行 `name` 恒为 `NULL`，局部唯一索引的 `where name is not null` 条件天然不适用，不会因为"名字冲突"而报错；v(n-1) 版本的采集器本来就是用本地状态文件缓存 Source id 做幂等（S5.3 之前的既有机制），回退后这个机制原样继续工作，只是重新失去"按 name 天然幂等"这个 S5.3 才有的好处，不是错误 | 只需回退代码 |
| v0.12.0 | core `0029_latest_fact_dead_end_for_identity`：新增函数 `latest_fact_invalidated_for_identity`（v(n-1) 完全没有任何代码调用过这个此前不存在的函数名） | 可逆 | 纯新增，且是全新函数名——v(n-1) 代码库里没有、也不可能有对它的调用（S5.5 才第一次引入这个调用点），回退没有任何"曾经调用、现在行为变了"的路径需要检查 | 只需回退代码 |
| v0.13.0–v0.13.2 | （无——`git diff --name-status v0.12.0 v0.13.2 -- packages/kernel/migrations/` 为空，这三个版本之间没有新迁移文件） | 可逆（N/A） | 无迁移可回退 | 按 §3 切回上一个 tag 即可，无需 `restore.sh` |
| v0.14.0 | core `0030_workspace_disabled_at`：`workspaces` 新增可空 `disabled_at`（S6 A1/A6，工作区生命周期：`set_workspace_status` 在 `disabled` 时打时间戳、`active` 时清空；既有 `disabled` 行不回填——决定 3，视为立即可清）；`nexttime_app` 只拿到这一列的 `update` 授权 | 可逆 | 读了 v0.13.2 的调用方（`application/workspace/create.ts` 的 `insert into workspaces (id, name, entry_model, ontology_enforcement, purpose, expires_at) …`、`application/gateway/platform-handlers.ts` 的 `update workspaces set status = $2 where id = $1` 与 `select id, name, status from workspaces …`，`git show v0.13.2:<path>`）：全部是显式列清单，v0.13.2 代码既不写也不读 `disabled_at`；新列可空、无默认值以外约束，插入/更新不受影响。读这一列的 `purge_workspace` 是 v0.14.0 才引入的新代码，回退后这个读取点本身就不存在了 | 只需回退代码 |
| v0.14.0 | core `0031_chat_archived_at`：`chats` 新增可空 `archived_at`（S6-A 会话生命周期：`active → archived` 只影响 `list_chats` 默认可见性，`explain`/`get_chat_history`/`subscribe_chat` 不受影响；无回填） | 可逆 | 读了 v0.13.2 的 `application/chat/service.ts`：`CHAT_COLUMNS`（`'workspace_id, id, owner_principal_id, title, visibility, created_at'`）是编译进二进制的显式字符串常量，insert/select/`returning` 全部走这个常量，不含 `archived_at`——新列对 v0.13.2 代码完全透明，与 0026 行的既有先例（`FACT_COLUMNS`/`OBJECT_COLUMNS`）同一判断方式 | 只需回退代码 |
| v0.15.0 | core `0032_audit_unattributed_platform_actor`：把 `audit_records_actor_shape`（0019：平台行——`workspace_id is null`——必须有 `actor_user_id`）窄化放宽成"…或者 `action = 'platform.workspace_purged'` 且该行自己的 `payload -> 'attributedActor'` 是 JSON 布尔 `false`"，只对这一个具体场景放宽，其余平台行仍强制要求 `actor_user_id`（遗留 54：CLI `purge-workspace` 在解析不出操作者时不应该完全不留审计行） | 可逆 | 读了 v0.14.0 的调用方（`application/platform/purge-workspace.ts`，`git show v0.14.0:<path>`）：`if (input.actorUserId !== undefined) { … await writeAudit(...) }`——`actorUserId` 解析不出时 v0.14.0 **根本不调用** `writeAudit`，从未尝试写一条 `actor_user_id` 为空的平台审计行。0032 本身只放宽（widening）：凡满足旧约束的行必然满足新约束，新增的合法分支（`attributedActor = false`）是 v0.14.0 代码从不触发的新路径；回退到 v0.14.0 代码后，审计缺口的行为退回成迁移前就已知的局限（只留终端警告、无审计行——0032 自己的迁移注释也这么记），不是这次改动新引入的破坏 | 只需回退代码 |
| v0.20.0 | worker `0003_draft_discard`：给 `nexttime_app` 授 `worker_definitions` / `skills` / `procedures` 的 `DELETE`，并在三张表上加 `BEFORE DELETE` 触发器——应用角色只能删 `draft` 行（工作区清除级联以连接登录角色运行，不受限） | 可逆 | 读了 v0.19.0 的代码：没有任何路径删除这三张表的行（此前 `nexttime_app` 根本没有 `DELETE` 权限，清除级联走登录角色），多出来的授权与触发器对 v0.19.0 代码不可见、不改变其任何读写；本迁移只加不改列、不改约束 | 只需回退代码；如要连迁移一起撤：`revoke delete on worker_definitions, skills, procedures from nexttime_app` 并 `drop trigger … / drop function …` 三组（非必需） |
| v0.23.0 | governance `0012_agent_profile_exclusions`：`agent_profiles` 加 `excluded_skills` / `excluded_gatekeepers` / `excluded_worker_definitions`（`jsonb not null default '[]'`）；对每个原先存过明确清单的配置写一条审计 `agent_profile.lists_reset_to_follow_grants`（payload 带原清单）。旧的 `enabled_*` 列原样保留、新代码不读不写 | 可逆 | 只加列、只插审计行；v0.22.0 的代码只读写 `enabled_*`，新列对它不可见。注意：回退后旧代码按 `enabled_*` 重新生效，即回到"清单冻结"的旧行为，并且在 v0.23.0 期间对排除清单的修改不会带回去 | 只需回退代码；新列与审计行可留（审计表只追加，不可删） |
| v0.35.0 | core `0033_ontology_draft_discard`：给 `nexttime_app` 授 `ontology_versions` 的 `DELETE`，并加 `BEFORE DELETE` 触发器——应用角色只能删 `draft` 行（遗留 99：`discard_draft` 新增 `ontology_version` kind，提案者丢弃自己的本体草稿；`current_user = 'nexttime_app'` 限定，工作区清除仍可删全部行） | 可逆 | 旧代码（v0.34.0 及之前）从不对 `ontology_versions` 执行 `DELETE`（`registry.ts` 只有 insert/update/select），新授权与触发器对它们完全透明；写入点本体校验只读 published 行、迁移里没有任何外键引用该表，草稿行被删不会留下孤儿。回退时新增的 `discard_draft{kind:'ontology_version'}` 路径随新代码一并消失；若要连 schema 也回退：`revoke delete on ontology_versions from nexttime_app` + `drop trigger ontology_versions_only_draft_delete on ontology_versions` + `drop function ontology_versions_block_non_draft_delete()`（不回退也无害） | 只需回退代码 |
| v0.35.1 之后的下一版 | core `0034_operation_single_published`（R-08 / 遗留 113）：先自愈——每个 Operation 身份（`identity_key` 的 `gatekeeperId` + `name`）只保留版本最高的那条 `published`，其余改成 `deprecated`（与内核弃用同一写法：`properties \|\| {status:'deprecated'}`、刷新 `updated_at`；不删行；`raise notice` 报改了几行，migrate CLI 会打印出来）；再加排除约束 `objects_operation_single_published`（三列都用 `=`，语义等同部分唯一索引：每个身份至多一条 `published`），`DEFERRABLE INITIALLY DEFERRED`，提交时检查 | 可逆 | 读了 v0.35.1 的 `publishOperation`：它先把修订草稿置为 `published`，下一条语句才弃用旧版本——约束如果按语句检查，回退后普通的修订发布就会失败，所以定为提交时检查：提交时只剩一条 `published` 即通过（集成测试按这个旧顺序跑过）。v0.35.1 唯一会被拒的写入正是 R-08 本身（在待审修订草稿上导入再发布，留下两条 `published`）：回退后这条路径在提交时报约束冲突、整笔事务回滚，不会再写出重复行。自愈只把重复行的状态从 `published` 改成 `deprecated`，v0.35.1 的读路径照常工作，原本在两条里任取一条，现在稳定是最新版本 | 只需回退代码；若要连 schema 一起撤：`alter table objects drop constraint objects_operation_single_published`（不撤也无害）。自愈改掉的状态不随回退恢复——那些行本来就是重复；合并前用 PR 描述里的 Host pre-check 查询列出将被改动的行 |
| v0.36.0 之后的下一版 | governance `0013_action_request_replay_attempts`（R-48，遗留 104 的后续）：`action_requests` 新增 `replay_attempts integer not null default 0`——stale-executing reaper 每次重放前在行上计数（只在行仍为 `executing` 时），到上限仍得不到门的答复就记 `failed: outcome_unknown`；不进 ActionRequest 线上形状 | 可逆 | 只加一列且有默认值。读了 v0.36.0 的代码：`ACTION_REQUEST_ROW_COLUMNS`（`governance/approval/types.ts`）是显式列清单，`request-action.ts` 的插入也是显式列清单，不读不写这一列；新列对它完全透明。回退后 reaper 回到旧行为（重放走 `execute`、超时再记 `failed`），队列读回到不含 `executing` 的旧语义——都是这次修复之前的已知行为，不是回退引入的破坏。门侧的幂等存储文件同 PR 改了格式（多了 `pending` / `failed` 条目）：旧门代码载入时只认 `done` 条目、其余跳过，新门代码能读旧文件，两个方向都能启动 | 只需回退代码；若要连 schema 一起撤：`alter table action_requests drop column replay_attempts`（不撤也无害） |
| v0.36.0 之后的下一版 | governance `0014_action_request_idempotency_window`（R-53 / 决定 D-12）：把 0003 的 `action_requests_idempotency_key_uidx`（所有非空键、任何状态唯一）拆成两个部分唯一索引——同名索引只管非派生键（`idempotency_key not like 'auto:%'`，任何状态，语义不变）；新增 `action_requests_derived_idempotency_key_inflight_uidx` 只管 `request_action` 自己派生的 `auto:` 键，且只在行仍在途时（`proposed` / `policy_evaluated` / `auto_approved` / `pending_approval` / `approved` / `executing`）唯一。不改数据、不加列 | 可逆 | 建索引不会失败：旧索引下每个键本就唯一，两个子集必然唯一；DROP 与两条 CREATE 在同一事务里，没有无唯一约束的时刻。读了 v0.36.0 的 `requestAction`：先按键查任何状态的行、命中即重放，查不到才插入——旧代码在新 schema 上照旧"命中即重放"，等于修复前的行为；新代码期间留下的同键多条终态行，旧代码取 `rows[0]`（任一条）重放，仍是修复前"重放旧行"的已知行为。唯一的差异在并发：同一派生键两次同时插入时，冲突现在报新索引名，旧代码只认旧名，会把这次并发重复当错误抛出（调用失败，不会写出重复行）；旧套件的并发用例用的是非派生键，不受影响 | 只需回退代码；若要连 schema 一起撤：先确认没有同一 `(workspace_id, idempotency_key)` 的多条行（新代码期间可能已有，那时下面的 CREATE 会失败，留着即可），再 `drop index action_requests_derived_idempotency_key_inflight_uidx; drop index action_requests_idempotency_key_uidx; create unique index action_requests_idempotency_key_uidx on action_requests (workspace_id, idempotency_key) where idempotency_key is not null`（不撤也无害） |
| v0.36.0 之后的下一版 | task `0005_task_idempotency_key`（R-54 / 决定 D-12）：`tasks` 新增可空 `idempotency_key`（不回填）+ 两个部分唯一索引：`tasks_idempotency_key_uidx`（非派生键，任何状态）、`tasks_derived_idempotency_key_inflight_uidx`（`invoke_worker` 派生的 `auto:` 键，仅 `created` / `queued` / `running` / `waiting_approval`） | 可逆 | 读了 v0.36.0 的 `insertQueuedTaskWithQuotaCheck`：`insert into tasks (…)` 是显式列清单，不写新列，旧代码插入的行恒为 NULL，两个索引的 `where` 都不覆盖 NULL，不会拒绝任何旧写入；`TASK_ROW_COLUMNS` 同样是显式列清单，不读新列。回退后 `invoke_worker` 退回没有幂等键的旧行为（客户端超时后的重试会再起一个 Worker，即 R-54 本身） | 只需回退代码；若要连 schema 一起撤：`drop index tasks_derived_idempotency_key_inflight_uidx; drop index tasks_idempotency_key_uidx; alter table tasks drop column idempotency_key`（不撤也无害） |
| v0.36.0 之后的下一版 | linkage `0002_context_item_chat_lease`（R-57 / 决定 D-23）：`pending_context_items` 新增可空 `chat_id`（外键 `chats`）与 `lease_turn_id`（外键 `activities`），不回填。`get_entry_context` 带 `turnId` 时把该 Turn 所在对话的条目租给这个 Turn，同一 Turn 的每次调用返回同一批，`report_turn` 时才置 `delivered_at`（即确认）；不带 `turnId` 是只读 peek（`entry` 会话例外：归到它正在运行的 Turn，给 `turnId` 之前构建的入口镜像用） | 可逆 | 只加两列，可空、无默认值；既有行两列为 NULL，复合外键含 NULL 不检查，加约束不会失败。读了 v0.36.0 的 `application/linkage/store.ts`：`insertPendingContextItem` 的插入是显式列清单，不写新列；`drainPendingContextItems` 只按 `principal_id`、`delivered_at is null` 读、只写 `delivered_at`，不读新列。回退后旧代码回到读即消费、不分对话（即 R-57 本身）：新代码期间已租未确认的条目在旧代码看来就是未投递，下一次读取投递一次，不丢。线上契约只多了可选参数 `turnId`：回退后若新的运行时镜像仍是活动镜像，旧内核以 `invalid_params` 拒绝它，扩展随即改发 `{}`（旧内核唯一接受的形式），注入不中断 | 只需回退代码；若要连 schema 一起撤：`alter table pending_context_items drop column lease_turn_id, drop column chat_id`（外键随列删除；不撤也无害） |
| v0.38.0 之后的下一版 | core `0035_db_write_confinement`（R-29；同类 P3 L4-11、L4-12 第 1–2 条一并收）：①回收 `nexttime_app` 不用的授权——`objects` / `activities` / `sources` / `observations` / `evidence` / `conflicts` / `decisions` / `chats` / `sessions` / `outbox` 的 `DELETE`，`sources` / `observations` / `evidence` / `decisions` / `outbox` 的 `UPDATE`；②`workspaces` / `platform_settings` / `platform_settings_history` 开 RLS（不 FORCE）：所有事务可读，只有平台事务（`app_platform()`）可写；工作区事务只剩改**自己**工作区的 `ontology_enforcement` 一列（策略限行、`BEFORE UPDATE` 触发器限列，兼容放行，见"依据"）；③四个 security definer 辅助函数撤掉 PUBLIC 的 EXECUTE，`lookup_user_by_login` 的 `search_path` 补上 `pg_temp`；④一条 UPDATE 不能让 Fact 同时 superseded 与 invalidated，`deprecated` 的 OntologyVersion 定义与 `published` 一样不可改。不改数据、不加列 | 可逆 | 读了 v0.38.0 的全部写入点：被回收的授权没有任何以 `nexttime_app` 运行的路径使用（唯一的删除者是清除级联，outbox 派发器也一样，都在登录角色上）；`workspaces` / `platform_settings` 的写入点全是平台事务（`update_workspace` / `set_workspace_status` / `update_platform_settings` / `set_default_modules` / 运行时镜像与默认模型）或登录角色（bootstrap、`ensureDefaultWorkspace`、清除），读走 read-all 策略不受影响；登录角色是表 owner、不 FORCE，照旧绕过 RLS。v0.38.0 套件里只有 `ontology-guard` / `worker-result` 两个集成测试在工作区事务里改自己工作区的 `ontology_enforcement`（测试准备，不是产品路径）——兼容放行只为它们保留，本版套件已改在登录角色上做，等不再有回退目标的套件需要时，后续迁移可删 `workspaces_own_ontology_enforcement` 策略与触发器里对应的一支。L4-12 两条规则拒绝的写入 v0.38.0 从不发出 | 只需回退代码；若要连 schema 一起撤：`grant` 回被回收的权限，`drop policy` 新增的 7 条策略并对三张表 `disable row level security`，`drop trigger workspaces_platform_only_update on workspaces` 及其函数，四个函数 `grant execute … to public`，按 0012 / 0011 的定义重建 `links_block_content_update` / `ontology_versions_block_published_definition_update`（不撤也无害） |
| v0.38.0 之后的下一版 | governance `0015_monotonic_revocation`（R-29）：`capability_handles` 与 `capability_grants` 各加一个 `BEFORE UPDATE` 触发器——`revoked_at` 一旦置上就不能清空（再次吊销不报错，保留第一次的时间）；grant 的 `revoked` / `expired` 是终态。对所有角色生效，吊销本身不受影响 | 可逆 | 读了 v0.38.0 的写入点：`revokeHandle` / `revokeSession` / 清除级联只在 `revoked_at is null` 时置值，`revokeCapabilityGrant` 只改 `status = 'active'` 的行，没有任何路径清空 `revoked_at` 或把 grant 改回 `active`；清除级联对这两张表只做 DELETE，更新触发器看不到 | 只需回退代码；若要连 schema 一起撤：`drop trigger capability_handles_monotonic_revocation on capability_handles; drop trigger capability_grants_monotonic_revocation on capability_grants` 及两个函数（不撤也无害） |
| v0.38.0 之后的下一版 | core `0036_audit_unattributed_cli_identity`（R-28 / L1-14）：把 `audit_records_actor_shape` 里 0032 给 `platform.workspace_purged` 的无操作者例外（`actor_user_id` 为空且 `payload -> 'attributedActor'` 是 JSON 布尔 `false`）扩到运维 CLI 的五个身份动作 `cli.workspace_created` / `cli.principal_added` / `cli.service_handle_issued` / `cli.platform_admin_created` / `cli.password_set`，其余无操作者的平台行照旧拒绝 | 可逆 | 只放宽（widening）：凡满足 0032 约束的行必然满足新约束，重新加约束校验既有行不会失败，无需回填。读了 v0.38.0 的 `cli/bootstrap.ts`：这五个子命令不写任何审计行，`cli.*` 是新动作名，旧代码从不触发新加的合法分支；旧测试 `writer.test.ts` 断言"其他动作（`platform.user_purged`）的无操作者行被拒"在新约束下仍成立。回退后这五个子命令退回不留审计行（L1-14 本身），已写入的 `cli.*` 行留在表里、旧代码的读路径（`platform_audit_query`）照常列出 | 只需回退代码；若要连 schema 一起撤：按 0032 的定义重建 `audit_records_actor_shape`（前提是先删掉无操作者的 `cli.*` 行，否则重建失败；不撤也无害） |
| v0.38.0 之后的下一版 | core `0037_gate_manifest_pending`（R-18 / 决定 D-18）：`gate_instances` 新增可空 `pending_operations`（jsonb）与 `pending_announced_at`（timestamptz），不回填、无默认值——既有行读作"没有待确认的清单"，与事实一致。已被决定（启用 / 禁用）的实例再 announce 出改变 Operation 集合或需审阅字段的清单时存这里，`operations` 保持到管理员 `confirm_gate_manifest`（按摘要）；清单不变的再 announce 清空它 | 可逆 | 只加两列，可空。读了 v0.38.0 的 `application/gates/store.ts`：`GATE_INSTANCE_SELECT`、`upsertAnnouncement` 的 select / insert / 三条 update、`listAvailableGateInstances` 与 `createHostedGateInstance` 全是显式列清单，不读不写新列；RLS 策略按行，覆盖新列不变，`nexttime_app` 在 0023 已有 select / insert / update。回退后旧代码回到"匹配身份的每次 announce 直接覆盖 `operations`"（即 R-18 本身），新代码期间挂起的清单留在列里、旧代码看不见；重新升级后下一次 announce 会重新算出待确认项（同则清空、异则覆盖），`confirm_gate_manifest` 只认当时的摘要，不会采用过期的那一份 | 只需回退代码；若要连 schema 一起撤：`alter table gate_instances drop column pending_announced_at, drop column pending_operations`（不撤也无害） |
| v0.39.0 之后的下一版 | governance `0016_auto_approval_scope`（R-20 / 决定 D-15，R-21 / 决定 D-16）：①新表 `gatekeeper_policies`（与 `policies` 同列，加 `gatekeeper_id`，唯一键 `(workspace_id, gatekeeper_id, action_kind)`，RLS + 与 `policies` 相同的授权），"总是允许"只写这里；②既有的工作区级 `policies.auto_approve = true` 行：该动作种类只在一个门上出现过 ActionRequest 的，规则移到那个门；零个或多个门的（无法确定审批人看到的是哪个门），自动批准作废；两种情况下工作区级行都不再自动批准——只说了自动批准的行删除，带 `requester_can_approve` 的保留并置 `auto_approve = false`；每行一条审计 `policy.auto_approve_rescoped`（payload 带原值与候选门）；③`agent_policies.allow_member_auto_approve_low` 列默认值改为 `true`；④仍为 `false`、且该工作区从没有任何 `set_agent_policy` 调用提交过 `allowMemberAutoApproveLow` 的行改为 `true`（这个 `false` 只是旧列默认值，没有 owner 选过），每行一条审计 `agent_policy.auto_approve_low_default_applied`；owner 提交过的保留原值 | 可逆 | 只加表、改一个列默认值、只收窄 `policies` 的数据。读了 v0.39.0 的 `governance/policy/policies.ts`：`readWorkspacePolicy` / `listPolicies` / `setPolicy` 只按显式列清单读写 `policies`，upsert 依赖的 `unique (workspace_id, action_kind)` 原样保留，从不读 `gatekeeper_policies`；回退后新代码写的门规则对旧代码不可见（等于没有规则：low 回到默认自动批准，medium 回到要人批——只会更严），被迁移删掉 / 清零的工作区级行让旧代码比迁移前更严，不会更宽。`agent_policies`：v0.39.0 运行时只读 AgentProfile（`profile ?? true`）、不读策略值，翻转对执行无影响，只让旧控制台把这些工作区显示成"允许"（与旧运行时的实际行为一致）；旧代码的 `setAgentPolicy` 写显式值，列默认值只影响平台面板（`writeWorkspaceModelPolicy`）新建的行。注意：回退期间旧代码的"总是允许"会重新写出工作区级 `auto_approve = true` 行（即 R-20 本身）；再升级时迁移不会重跑，但新引擎把工作区级的 `auto_approve = true` 当作"没有意见"（`engine.ts` `WorkspacePolicyInput.scope`），不会因此放宽，策略表里那一行仍显示"自动批准"，由 owner 在模型与配额页改掉 | 只需回退代码；若要连 schema 一起撤：`drop table gatekeeper_policies; alter table agent_policies alter column allow_member_auto_approve_low set default false`（不撤也无害）。②④改掉的数据不随回退恢复；原值在上述两类审计记录的 payload 里，合并前用 PR 描述里的 Host pre-check 查询列出将被改动的行 |
| v0.39.0 之后的下一版 | core `0038_ontology_draft_base_version`（R-60）：`ontology_versions` 新增可空 `base_version`（int）——草稿提议时该族已发布的最高版本，新族或该族尚无发布版本时为空；只回填既有草稿（该族在草稿创建时已发布、且低于草稿自身版本的最高版本，即新代码当时会存的值），已发布行不回填；加检查约束 `ontology_versions_base_before_version`（为空，或 `1 ≤ base_version < version`）。新代码发布草稿时在族锁（`pg_advisory_xact_lock(hashtext('ontology_family:<工作区>:<族>'))`，加载器 / 模块发布同一把）下比对：族的已发布头不再是 `base_version` 就拒 409 `ontology_base_moved`，什么都不改 | 可逆 | 只加一列（可空、无默认值）和一条只约束这一列的检查。读了 v0.39.0 的 `substrate/ontology`：`proposeOntologyChange` 与 `publishOntologyVersion` 的 insert、`publishOntologyDraft` 的 update 都是显式列清单，不写新列（旧代码插入的行恒为空，约束天然满足），所有 select / `returning` 也是显式列，不读它；回填只改草稿行，`ontology_versions_block_published_definition_update` 只管 published / deprecated 行，不受影响；`discard_draft` 的删除不涉及列。回退后旧代码回到发布时不比对基线（即 R-60 本身）。回退期间旧代码提议的修订草稿（带 `id`）`base_version` 为空，重新升级后若该族已有发布版本，发布它们会按"基线已移动"拒绝——宁拒不错，提议人基于当前版本重新提议即可 | 只需回退代码；若要连 schema 一起撤：`alter table ontology_versions drop constraint ontology_versions_base_before_version, drop column base_version`（不撤也无害） |
| v0.39.0 之后的下一版 | governance `0017_auditor_handles_revoked`（R-35 / 决定 D-07）：吊销所有代表 `auditor` 的未过期、未吊销 Handle（`capability_handles.revoked_at = now()`），每个受影响的 auditor 写一条审计 `principal.auditor_handles_revoked`（payload 带吊销数）。原因：auditor 改为严格只读（显式白名单），但旧版本签发的入口 Handle 仍列着所有 `minRole: 'member'` 能力，最长 24 小时有效；吊销后入口 agent 下一个 Turn 按新上限重签。不改 schema | 可逆 | 无 schema 变更，只置 `revoked_at`（0015 的单调吊销触发器允许）。旧代码的入口 Handle 发放路径（`ensureEntryHandle`）在发现缓存的 Handle 已吊销时照常重签，被吊销的只是会话里的旧凭证，不丢数据 | 只需回退代码；被吊销的 Handle 不随回退恢复（也不需要：下一个 Turn 会重签） |
| v0.40.0 之后的下一版 | core `0039_provenance_lookup_indexes`（R-66 / L4-9）：只加四个索引——`observations (workspace_id, activity_id)`（`link_visible_to_caller` 的 Fact 可见性判定、`resolveFactOrigin`、指向 `activities` 的外键）、`observations (workspace_id, source_id, created_at)`（静默 Source 检查的 `max(created_at)`、观察窗口、指向 `sources` 的外键）、`links (workspace_id, last_observation_id) where last_observation_id is not null`（0026 的外键）、`activities (workspace_id, started_by, kind, created_at)`（`findAttributableTurn`、指向 `principals` 的外键）。不改数据、约束、授权，不加保留或删除策略（遗留 103 另行决定）。运行器每个文件一个事务，不能用 `concurrently`：普通 `create index` 对这三张表加 SHARE 锁直到文件提交，`apply-release.sh` 迁移时旧版本 kernel 仍在服务，采集写入、Fact 写入、Turn 记账在建索引期间排队（不报错）；主机上 `observations` 约 60 万行，预计合计不到一分钟 | 可逆 | 只加索引：任何语句的结果都不变，规划器只是多了更便宜的路径。读了 v0.40.0 对这三张表的读写：没有引用索引名、也没有依赖"没有索引"的路径；v0.40.0 的清除级联（`alter table … disable trigger`，R-65 之前的做法）在新 schema 上照常运行，外键检查反而更快 | 只需回退代码；若要连 schema 一起撤：`drop index observations_activity_idx, observations_source_idx, links_last_observation_id_idx, activities_started_by_idx`（不撤也无害，只多一点写入时的索引维护） |
| v0.40.0 之后的下一版 | llm-usage `0002_usage_request_id`（R-67 / L6-13）：`llm_usage` 新增可空 `request_id`（uuid）——llm-proxy 为每个上游请求铸的用量标识，重放时不变；加部分唯一索引 `llm_usage_request_id_uidx (workspace_id, request_id) where request_id is not null`。0001 的唯一键 `(workspace_id, jti, started_at)` **保留**：同一 Handle 在同一毫秒开始的两个请求，后一个存在该毫秒内往后几微秒（不出这一毫秒，低于 llm-proxy 的测量精度）。没有 `request_id` 的记录（R-67 之前的 llm-proxy，只在滚动升级窗口里）照旧按 0001 的键去重。不回填、不改既有行 | 可逆 | 只加一列（可空、无默认值）和一个只覆盖非空行的部分唯一索引。读了 v0.40.0 的 `governance/llm-usage/service.ts`：插入是显式列清单，不写新列（恒为空，新索引不收录），`on conflict (workspace_id, jti, started_at)` 只能推断出一个**非部分**、恰好这三列的唯一索引——正因如此 0001 的键原样保留（删掉或改成部分索引，回退后旧代码的每次用量写入都会 42P10 失败）；新代码写入的行在这三列上也互不相同（微秒错位），所以旧代码的去重语义不变；读路径（日成本 / token 汇总、平台 30 天用量）都是显式列，不读新列。回退后旧代码回到"同一毫秒的并发请求被合并"（即 R-67 本身），新代码期间写入的行原样保留、照常计入汇总 | 只需回退代码；若要连 schema 一起撤：`drop index llm_usage_request_id_uidx; alter table llm_usage drop column request_id`（不撤也无害） |
| v0.41.0 之后的下一版 | core `0040_audit_unattributed_observation_compaction`（遗留 103）：把 `audit_records_actor_shape` 里 0032 / 0036 的无操作者例外（`actor_user_id` 为空且 `payload -> 'attributedActor'` 是 JSON 布尔 `false`）再扩一个动作 `cli.observations_compacted`——`compact-observations --yes` 的平台审计行，`apply-release.sh` 无人值守地跑它时可能解析不出操作者；其余无操作者的平台行照旧拒绝。不改数据 | 可逆 | 只放宽（widening）：凡满足 0036 约束的行必然满足新约束，重新加约束校验既有行不会失败，无需回填。读了 v0.41.0：没有 `compact-observations`，也没有任何路径写 `cli.observations_compacted`，旧代码从不触发新加的合法分支；旧测试 `writer.test.ts` 断言的拒绝情形（其他动作、缺标记）在新约束下仍被拒。回退后压缩命令不存在（回退目标的 `apply-release.sh` 也不跑它），已写入的 `cli.observations_compacted` 行留在表里、旧代码的 `platform_audit_query` 照常列出；已删掉的观察行不随回退恢复——它们按规则本来就不被任何读者用到，要找回只能用压缩前那份 `BACKUP_NOW` dump | 只需回退代码；若要连 schema 一起撤：按 0036 的定义重建 `audit_records_actor_shape`（前提是先删掉无操作者的 `cli.observations_compacted` 行，否则重建失败；不撤也无害） |
| v0.42.0 之后的下一版 | core `0041_drop_workspace_ontology_enforcement_allowance`（S10 P0，遗留 123 跟进）：删 0035 的 `workspaces_own_ontology_enforcement` 策略，`workspaces_block_workspace_plane_update` 去掉 `ontology_enforcement` 一列的例外——工作区事务改不了任何 `workspaces` 行（RLS 隐藏，0 行）。不改数据、不加列 | 可逆 | v0.42.0 的产品代码只在平台事务（`update_workspace`）或登录角色上写 `workspaces`，没有路径用过这条放行；v0.42.0 套件里依赖它的只有 `write-confinement.integration.test.ts` 的两个用例（"兼容放行"，以及"自己工作区的其他列被触发器报错拒绝"——现在是 RLS 隐藏、0 行而不是报错），它们断言的正是这次有意改变的约束，探针里这两个用例失败属"旧测试断言了新迁移有意改变的约束"；`ontology-guard` / `worker-result` 自 0035 起已改在登录角色上改该列 | 只需回退代码；若要连 schema 一起撤：按 0035 重建该策略与触发器函数 |
| v0.42.0 之后的下一版 | core `0042_definer_functions_bound_to_workspace`（S10 K4，遗留 123 的 L4-11 余项与 L4-13）：`find_active_fact_for_identity` / `latest_fact_invalidated_for_identity` 遇到不是 `app_workspace()` 的工作区参数报 42501，`link_visible_to_caller` / `conflict_visible_to_caller` 对它答 false；`workspace_gate_links_gatekeeper_idx` 换成唯一索引 `workspace_gate_links_gatekeeper_key (workspace_id, gatekeeper_object_id)`；收回 `nexttime_app` 对 `workspace_gate_links` 的 DELETE。不改数据、不加列 | 可逆（先过 §3.8 预检） | v0.42.0 的调用方都在 `withWorkspace` 里、传的都是本事务的工作区（GUC 对登录角色也设置），答案不变；v0.42.0 没有删关联的内核路径，手工解除关联走登录角色；v0.42.0 只在一个 Gatekeeper 还没有关联时插入关联（重复关联正是被拦下的情形）。已有重复关联时迁移本身失败、整体回滚，所以要先跑 §3.8 预检 | 只需回退代码；若要连 schema 一起撤：按 0013 / 0017 / 0027 / 0029 重建四个函数（`create or replace` 保留 0035 的授权），`drop index workspace_gate_links_gatekeeper_key` 后按 0023 重建非唯一索引，`grant delete on workspace_gate_links to nexttime_app` |
| v0.42.0 之后的下一版 | task `0006_objective_outcome` + worker `0004_skill_procedure_attribution`（S10 E1 结果归因）：`tasks` 加五个可空的目标结果列（CHECK `tasks_objective_outcome_check`：全空，或第 1 版无前值，或第 2 版前值是另一值），`worker_runs.skills_recorded boolean not null default false`（PG 11+ 常量默认值不重写表），新表 `turn_outcomes`、`worker_run_skills`、`turn_procedure_claims`（工作区 RLS；后两张只授 `select, insert`）。不改既有数据 | 可逆 | 只加可空列、带常量默认值的列与新表：v0.42.0 的写入不碰新列（`skills_recorded` 取默认 false，读作"未记录"），也不知道新表；迁移可逆性探针用 v0.42.0 的测试在新 schema 上跑过（#480，2116 例通过，首跑唯一失败是遗留 123 已记的 `turn-terminal` 偶发超时，下一次提交上全过；合入头 `11252f3` 上探针也是绿的，那次 HEAD 已同时带 core 0041 / 0042 与 #482 的声明式判定） | 只需回退代码；若要连 schema 一起撤：`drop table turn_procedure_claims, worker_run_skills, turn_outcomes; alter table worker_runs drop column skills_recorded; alter table tasks drop constraint tasks_objective_outcome_check, drop column objective_outcome, drop column outcome_given_by, drop column outcome_given_at, drop column outcome_revision, drop column outcome_previous`（并从 `schema_migrations` 删掉这两条；不撤也无害——已记录的归因随之丢失） |
| v0.44.0 之后的下一版 | governance `0018_container_held_handles_revoked`（#524，遗留 156）：吊销所有未过期、未吊销的 `entry` / `worker_run` Handle，每个 (工作区, 主体) 写一条审计 `principal.container_handles_revoked` | 可逆 | 无 schema 变更，只置 `capability_handles.revoked_at`（0015 的单调吊销触发器允许）。v0.44.0 的代码在入口 Handle 被吊销后于下一个 Turn 重签（`ensureEntryHandle` 检查缓存 jti 的吊销），WorkerRun 本来就在窗口前排空；被吊销的 Handle 不恢复，也不需要恢复 | 只需回退代码 |
| v0.45.0 之后的下一版 | governance `0019_action_request_operation_digest`（#538，遗留 189）：`action_requests` 加一列可空的 `operation_digest`（text，检查约束 `action_requests_operation_digest_shape`：为空、`none` 或 `sha256:<64 hex>`），不回填 | 可逆 | 只加一列可空列和只约束这一列的检查。读了 v0.44.0 的 `governance/approval`：`action_requests` 的读写都用显式列清单（`ACTION_REQUEST_ROW_COLUMNS`），不读不写新列，旧代码插入的行恒为空，约束天然满足。回退后旧代码回到执行时不带摘要（即遗留 189 本身），新代码期间写下的摘要留在列里、旧代码看不见；重新升级后这些行照常按记下的摘要执行，回退期间写入的空值行按执行时已发布的版本执行 | 只需回退代码；若要连 schema 一起撤：`alter table action_requests drop column operation_digest`（约束随列删除），并 `delete from schema_migrations where module = 'governance' and version = 19`（不撤也无害） |
| v0.46.0 之后的下一版 | core `0043_audit_unattributed_raw_secret_scrub`（#549，遗留 183–187）：`audit_records_actor_shape` 在 0040 的未署名主机操作名单里加上 `cli.raw_secrets_scrubbed`，其余不变；不改数据、不加列 | 可逆 | 只放宽：满足 0040 约束的行都满足新约束，重建约束不需要回填；v0.46.0 的代码从不写这个动作，回退后约束只是多允许一种它不会写的行。`scrub-raw-secrets` 改写的 3 类数据是另一回事：遮蔽是单向的，回退代码不会恢复原文，旧代码照常读遮蔽后的文本（§3.25） | 只需回退代码；恢复备份会把原文带回来，只用于灾备 |
| v0.50.0 | governance `0020_auto_approval_definition`（#592，遗留 218）：`gatekeeper_policies` 加两列可空列 `operation_digest`（检查约束 `gatekeeper_policies_operation_digest_shape`：为空或 `sha256:<64 hex>`）与 `operation_version`（`gatekeeper_policies_operation_version_positive`：为空或 > 0），并按批准证据回填既有的按门自动批准规则（无证据的不回填，各记一条审计） | 可逆 | 只加两列可空列与只约束这两列的检查，回填只写新列与审计行。上一版的 `governance/policy` 读写 `gatekeeper_policies` 都用显式列清单，看不到新列（PR 与审查 #493 核对，不需要 reversibility 声明）。回退后上一版写的规则不带摘要，重新升级后在本版显示暂停、走审批；用上一版编辑一条已绑定的规则会保留旧摘要，回到本版显示「已暂停 · 定义已变」——都只会更窄，不会更宽（§3.29） | 只需回退代码；若要连 schema 一起撤：`alter table gatekeeper_policies drop column operation_digest, drop column operation_version`（约束随列删除），并 `delete from schema_migrations where module = 'governance' and version = 20`（不撤也无害；审计行保留） |
| v0.50.0 | governance `0021_action_request_withdraw_failure_kind`（#601，S11 GO1 前半）：重建 `action_requests_status_check` 加 `withdrawn`，加列 `failure_kind` 与 CHECK `action_requests_failure_kind_check`，加触发器 `action_requests_status_guard`，按白名单回填存量失败行 | 可逆 | 上一版按显式列清单读写 `action_requests`，看不到 `failure_kind`，也从不写 `withdrawn`；它写的失败行由触发器补 `outcome_unknown`（从不诱导重试的读法）；残留的 `withdrawn` 行对它是终态。PR 在本地先应用本版全部迁移、再跑 v0.49.0 内核全套测试（199 个文件 3343 个测试）全过，不需要 reversibility 声明。回填和 `ALTER TABLE` 同一事务、全表扫描 `audit_records`，窗口前估算锁表时间（§3.30） | 只需回退代码；若要连 schema 一起撤：`drop trigger action_requests_status_guard on action_requests` 与 `drop function action_requests_status_guard()`、`alter table action_requests drop column failure_kind`，把 `withdrawn` 行先改到终态后按 0003 重建状态 CHECK，并 `delete from schema_migrations where module = 'governance' and version = 21`（不撤也无害） |
| v0.50.0 | goal `0001_goal_runs`（#607，S11 GO1 后半，新模块 `goal`，迁移锁键 7241000701）：新表 `goal_runs` / `plan_revisions` / `step_runs`、守卫触发器、延迟约束触发器 `plan_revisions_adopted` | 可逆 | 新模块的新表，上一版从不读写（PR 在本地按 `reversibility-probe` 方式核对） | 只需回退代码；若要连 schema 一起撤：先撤 `task/0007` 与 `governance/0022` 的外键，再 `drop table step_runs, plan_revisions, goal_runs cascade` 并 `delete from schema_migrations where module = 'goal'`（不撤也无害） |
| v0.50.0 | task `0007_task_goal_step`（#607）：`tasks` 加可空列 `goal_run_id` / `step_run_id` / `plan_revision` / `step_attempt` / `run_config_snapshot`、CHECK、外键、I-G1 唯一索引、触发器 `tasks_goal_step_immutable`，`worker_runs_task_idx` | 可逆 | 只加可空列与只约束这些列的 CHECK / 外键 / 触发器，不回填；上一版按显式列清单读写 `tasks`，写的行新列全为 NULL。建索引期间阻塞 `worker_runs` 写入（§3.31） | 只需回退代码；若要撤：`drop trigger tasks_goal_step_immutable on tasks`、删索引与五列，并 `delete from schema_migrations where module = 'task' and version = 7` |
| v0.50.0 | governance `0022_action_request_step_run`（#607）：`action_requests` 加可空列 `step_run_id`、外键、触发器 `action_requests_step_run_immutable`，`action_requests_parent_worker_run_idx` | 可逆 | 同上：可空列不回填，上一版写的行为 NULL，触发器只在改这一列时触发；建索引期间阻塞 `action_requests` 写入（§3.31） | 只需回退代码；若要撤：`drop trigger action_requests_step_run_immutable on action_requests`、删索引与列，并 `delete from schema_migrations where module = 'governance' and version = 22` |
| v0.50.0 | core `0044_audit_records_resource_idx`（#615，遗留 338）：部分索引 `audit_records_resource_idx (workspace_id, resource_id, created_at) where resource_id is not null`，同名无效残留先删再建 | 可逆 | 只加索引，上一版不引用它，规划器自己选路径；PR 在本地先应用本版全部迁移、再跑 v0.49.0 内核全套测试全过，不需要 reversibility 声明。建索引期间阻塞审计写入（§3.32） | 只需回退代码；若要撤：`drop index if exists audit_records_resource_idx` 并 `delete from schema_migrations where module = 'core' and version = 44` |
| v0.50.0 | goal `0002_goal_advancer`（#619，S11 GO2）：`goal_runs` 加可空列 `next_tick_at`、CHECK `goal_runs_next_tick`、部分索引，重建守卫 `goal_runs_status_guard`（只多放行 `next_tick_at`） | 可逆 | 上一版没有 goal 模块，回退后不读写这些表；GO1 代码不读写 `next_tick_at`，守卫只是多允许改一列，不需要 reversibility 声明（§3.33） | 只需回退代码；若要撤：按 goal 0001 重建守卫函数、删索引与 CHECK、`alter table goal_runs drop column next_tick_at`，并 `delete from schema_migrations where module = 'goal' and version = 2` |
| v0.50.0 | goal `0003_goal_cancelling`（#626，S11 GO3a）：照 goal 0001 重建 `step_runs_status_guard`，把 `cancelling` 加进「步骤只能走向结束」的目标状态 | 可逆 | 守卫只多拒绝一种情况，上一版没有取消路径、不会碰到它，不需要 reversibility 声明（§3.35） | 只需回退代码；若要撤：按 goal 0001 重建 `step_runs_status_guard`，并 `delete from schema_migrations where module = 'goal' and version = 3` |
| v0.50.0 | core `0045_workspace_self_connections`（#620，S11 P0b）：新表 `workspace_self_connections`（强制 RLS、`endpoint_key` 部分唯一索引），按没有目录关联的 Gatekeeper 回填并剪掉地址里的凭据 | 可逆 | 上一版不读写这张表；回退后自接门的暂停**不再生效**（§3.34），其余行为与上一版相同；重新升级时 `create table if not exists` 与 `on conflict do nothing` 幂等 | 只需回退代码，表保留；若要撤：`drop table workspace_self_connections` 并 `delete from schema_migrations where module = 'core' and version = 45`（会丢掉平台的暂停记录，先导出） |
| v0.50.0 | goal `0004_goal_revision_hold`（#633，S11 GO3b）：`goal_runs` 加 `paused_by`、`paused_by_authority`、`advance_failures`，`plan_revisions` 加 `removals`，四个约束，照 goal 0002 重建 `goal_runs_status_guard`（多 hold 一段） | 可逆 | 加列都有上一版从不写的默认值或可空；守卫只多拒绝这几列的变化，上一版的暂停、继续不写 `paused_by`，回滚到上一版不需要额外步骤 |
| v0.50.0 | governance `0023_action_request_reconciliation`（#642，S11 GO3c）：`action_requests` 加 `reconciliation`、`reconciliation_decision_id`、`reexecute_decision_id`，四个 CHECK、两个外键，守卫触发器 `action_requests_reconciliation_guard` | 可逆 | 新列可空、上一版从不写；CHECK 对三列为空的行恒真；触发器只拦写这三列的插入和更新，回滚到上一版不需要额外步骤 |
| v0.50.0 | governance `0024_action_request_reconcile_checks`（#649，S11 GO3d）：新表 `action_request_reconcile_checks`（两个部分索引），重建 `action_requests_reconciliation_guard`（`decided_by` 为空的分支收窄） | 可逆（代码回退期间观察压缩报 degraded） | 上一版不读写新表；守卫收窄不影响 0023 下写出的人的结论；上一版的观察压缩看到新外键会安全拒绝运行（不删东西），apply-release 的 observations-compaction 报 degraded，重新应用带 0024 的版本后恢复 |
| v0.50.0 | governance `0025_change_segments`（#650，S11 P1-A）：新表 `change_segments`、`change_items`（守卫、RLS、授权） | 可逆 | 只加新表，上一版不读不写；回退期间装的模块版本之后溯源为 `provenance_unknown`，属预期 |
| v0.50.0 | goal `0005_goal_acceptance`（#664，S11 GO4a）：新表 `goal_acceptance_checks`，新列 `goal_runs.outcome_decision_id`，重建 `goal_runs_status_guard`（加 I-G5） | 可逆（代码回退期间观察压缩报 degraded） | 上一版不读写新表与新列；守卫只收紧得到 `achieved` 的路径；上一版没有任何路径把目标结束为 `completed` |
| v0.50.0 | goal `0006_step_acceptance`（#670，S11 GO4b）：扩大 `step_runs.waiting_reason` 的 CHECK，新表 `step_acceptance_checks`，新触发器 `step_runs_acceptance_guard` | 可逆（代码回退期间观察压缩报 degraded） | 上一版不读写新表；上一版遇到停在 `waiting(acceptance)` 的步骤会推进失败，连续失败后目标暂停等人，不会未经验收就成功 |
| v0.50.0 | core `0046_activity_trigger_record`（#674，S11 GO4c）：Activity 的 `kind` 与触发记录键写入后不可改的守卫 | 可逆 | 上一版从不改这些键 |
| v0.50.0 | goal `0007_fact_acceptance`（#674，S11 GO4c）：两张检查表加 `fact_check` / `fact_id`（外键指向 `links`）与新 kind，重建三个守卫（目标级检查绑定计划声明），新增四个函数 | 可逆 | 上一版不读写新列、不写事实检查行；回滚后留下的 pending 事实检查一直等待，上一版读到带事实检查的计划会暂停目标，不会判达成 |
| v0.50.0 | governance `0026_change_item_worker_kinds`（#679，S11 P1-D）：`change_items_kind_check` 加 `skill_version`、`worker_definition_version` | 可逆 | 只放宽约束、无数据改写；上一版不读 `change_items` |
| v0.50.0 | governance `0027_change_item_operation_kind`（#690，S11 P1-E1）：`change_items_kind_check` 加 `operation_version` | 可逆 | 只放宽约束、无数据改写；上一版不读 `change_items` |
| v0.50.0 | governance `0028_decision_subjects`（#700，遗留 421）：`decisions` 加主体五列、触发器 `decisions_subject` 与回填，RLS `decisions_visibility` 加对话与冲突规则 | 可逆 | 上一版不读新列，触发器在它的插入上照样填主体；上一版读面只因两条 RLS 规则变窄；可逆性探针（v0.49.0 内核套件跑在本版库结构上）只有 `reversibility-deltas.json` 已登记的 4 例失败 |
| v0.50.0 | goal `0008_goal_idempotency_key`（#704，S11 GO5c）：`goal_runs` 加可空列 `idempotency_key` 与两个部分唯一索引，不回填 | 可逆 | 上一版插入时该列为 NULL，两个索引都不收；守卫不允许改这一列 |
| v0.50.0 | task `0008_task_output_contract`（#716，S11 GO5d-1）：`tasks` 加三列 nullable jsonb、三条 CHECK 与写入后不可改触发器，不回填 | 可逆 | 上一版按列名读写 `tasks`，看不到这三列；已有行全为 NULL，CHECK 成立；它的更新不碰受保护的列 |
| v0.50.0 | goal `0009_plan_revision_source`（#722，S11 GO5d-2）：`plan_revisions` 加两列来源与 CHECK、写入后不可改，不回填 | 可逆 | 上一版不读写这两列，已有行为 NULL，CHECK 成立 |
| v0.50.0 | worker `0005_procedure_parameters`（#722，S11 GO5d-2）：`procedures.parameters` 与对象 CHECK、不可改触发器覆盖该列、`plan_revisions` 来源外键与部分索引，不回填 | 可逆 | 上一版提的流程 `parameters` 为 NULL，触发器多出的比较不影响它；外键只约束非空来源 |
| v0.50.0 | task `0009_worker_run_fingerprint`（#730，S11 W1a）：`worker_runs` 加 `run_spec` / `runtime_report` / `environment_digest` 与 CHECK、部分索引、只写一次触发器，不回填 | 可逆 | 上一版的 INSERT / SELECT 都列名、不写这三列、不把运行退回 `provisioning`，CHECK 对全 NULL 行成立 |
| v0.50.0 | linkage `0003`（#737，S11 GO5e-2）：`pending_context_items.kind` 的 CHECK 加上 `goal_update` | 可逆 | 只放宽 CHECK；上一版把 `goal_update` 行放进 `tasks` 组，不动数据 |
| v0.50.0 | goal `0010`（#745，遗留 454）：`plan_revisions` 加 `source_procedure_parameters` 与 CHECK | 可逆 | 只加可空列，不回填；上一版不读不写这一列，不动数据 |
| v0.50.0 | core `0047_operation_version_guard`（#765，遗留 482）：`objects` 上两个触发器（已发布 Operation 的版本守护、治理字段须有同事务审计），不改数据 | 可逆 | 上一版改 Operation 只走受治理的路径，它的 `refresh_operation_governance` 在同一事务写同样的审计；它绕过 handler 直接调 `refreshOperationGovernance` 的 3 条单元测试已在 `reversibility-deltas.json` 声明；撤销 SQL 见 §3.64 |
| v0.50.0 | goal `0011_absence_acceptance`（#780，S11 B-b）：两张检查表的 kind / 形状 CHECK 加 `observe_absent`，两个 guard 与 `goal_runs_status_guard` 重定义，due 索引带上新种类，不回填 | 可逆 | 上一发布 v0.49.0 没有目标代码，不读写这些表；现有行对新 CHECK 都成立；中间版本的处理见 §3.68 |
| v0.50.0 | worker `0006_draft_rejections`（#792，遗留 491）：新表 `draft_rejections`（只追加，RLS），从 `reject_draft` 审计回填 | 可逆 | 上一版不读不写这张表，在新结构上照常运行，只是它做的拒绝不留记录；工作区清除按 `workspace_id` 自动覆盖 |
| v0.50.0 | goal `0012_absence_baselines`（#786，S11 B-c）：新表 `goal_absence_baselines` 与 guard、`goal_absence_seen_before`、两张验收表上的 I-AB1 触发器，不回填 | 可逆 | 上一发布 v0.49.0 没有目标代码，不读写新表；它的观察压缩遇到新外键 fail-closed 拒绝运行（`reversibility-deltas.json` 已声明），见 §3.70 |
| v0.50.0 | task `0010_task_observe_scope`（#796，S11 GO11）：`tasks.observe_scope` 可空列与 CHECK、不可改触发器、`worker_runs` 继承触发器，不回填 | 可逆 | 上一版按列名读写 `tasks`，创建的 Task 都不设范围，`worker_runs` 插入都能通过继承检查；只有本版本创建的带范围 Task 回退后不能再启动子 Worker（失败即关闭），见 §3.71 |
| v0.50.0 | governance `0029_reconcile_absence_seen_before`（#799，S11「门确认不存在」reconcile）：函数 `action_request_absence_seen_before` 与 `action_requests` 触发器，不改表、不回填 | 可逆 | 上一发布 v0.49.0 没有目标代码，不跑 reconcile；中间版本的旧执行器写 `effect_seen` 不带 `absentAnswersReview` 会被拒，试满后记 `unavailable` 交人核对，见 §3.72 |
| v0.50.0 | worker `0007_eval_suites`（#802，S10 E3-1a）：新表 `eval_suites`、`eval_suite_changes`、`eval_fixture_gates` 与守卫触发器，无 DELETE 授权，不回填 | 可逆 | 只新增表，上一版不读不写，在新结构上照常运行；`purge_workspace` 按 `workspace_id` 清掉这三张表（有集成测试） |
| v0.50.0 | worker `0008_eval_cases`（#810，S10 E3-1b）：新表 `eval_cases` 与守卫触发器，`eval_suite_changes` kind 检查多收 `case_added` / `case_edited` / `case_retired`，无 DELETE 授权，不回填 | 可逆，**必须与 worker `0007` 同一版本发布** | 只新增表；上一发布 v0.49.0 不读不写评测表。假如有只带 0007 的版本，回滚到它后不认识三种新 kind，读写过用例的用例集历史会失败，所以两者不能分版本发布；`purge_workspace` 按 `workspace_id` 清理（有集成测试） |
| v0.51.0 | task `0011_task_purpose`（#822，S10 E3-2a）：`tasks.purpose` 列与约束（不可改、评测 Task 只由评测服务主体发起、带观察范围、不是目标步骤，WorkerRun 为根运行），不回填 | 可逆 | 只新增列与约束，旧代码不写 `purpose`；回滚前评测 Task 必须全部结束（§3.75） |
| v0.51.0 | worker `0009_eval_runs`（#822，S10 E3-2a）：新表 `eval_runs`、`eval_trials`、`eval_trial_calls` 与账本守卫，不回填 | 可逆 | 只新增表，旧代码不读不写；`purge_workspace` 清理新表（有集成测试） |
| v0.51.0 | worker `0010_draft_evaluations`（#833，S10 E3-2b）：新表 `eval_draft_evaluations`，`eval_runs.kind` 加 `draft`、`eval_trials.status` 加 `queued`，账本守卫与保护评测中草稿的触发器，不回填 | 可逆 | 只新增表与取值，旧代码读不了 `draft` 运行；回滚前草稿评测与排队、在跑试跑必须为 0（§3.77）；`purge_workspace` 清理新表 |
| v0.52.0 | worker `0011_eval_seal_holds`（#838，S10 E3-2c）：新表 `eval_seal_hits`、`eval_seal_holds` 与守卫触发器，不回填 | 可逆 | 旧内核照常运行但不再执行生效中的暂停；回滚前按 §3.78 的顺序先处理 `active` 暂停；`purge_workspace` 清理两张新表 |
| v0.52.0 | worker `0012_draft_evaluation_summary`（#845，S10 E3-3b）：`eval_draft_evaluations` 加 `summary_observation_id`（外键指向 `observations`）与 `dev_verdict` 两个可空列、两条约束与一个部分索引，不回填 | 可逆（代码回退期间观察压缩报 degraded） | 上一版不读写新列；代码回退期间 observations-compaction 安全失败、不删任何东西，重新应用后恢复（§3.80）；差异已在 `reversibility-deltas.json` 声明 |
| v0.53.0 | goal `0013_step_trial_approvals`（#855，S11 GO8b）：新表 `goal_step_trial_approvals`（一次批准一行，只追加）与 guard 触发器，外键指向 `goal_runs`、`step_runs`、`principals`，不回填 | 可逆 | 回退后，用草稿开始过尝试的步骤再尝试时暂停 `needs_decision`（安全失败）；撤 schema：`drop table goal_step_trial_approvals`、`drop function goal_step_trial_approvals_guard()`，并 `delete from schema_migrations where module = 'goal' and version = 13`（§3.83） |
| v0.54.0 | goal `0014_planning_rounds`（#864，S11 GO9a）：新表 `goal_planner_delegations`、`goal_planning_rounds` 与 guard 触发器，`plan_revisions` 新增触发器 `plan_revisions_planner`，不回填 | 可逆 | 回退前先让在跑的规划结束（窗口前 `select count(*) from goal_planning_rounds where status = 'running'` 为 0）；回退后的代码不读写新表；撤 schema 须先撤 task `0012`，再 `drop table goal_planning_rounds, goal_planner_delegations`、`drop trigger plan_revisions_planner on plan_revisions` 并删迁移里的函数，最后删 `schema_migrations` 的 goal 14 行（§3.86） |
| v0.54.0 | task `0012_task_planning`（#864，S11 GO9a）：`tasks` 新列 `planning_round_id`（外键指向规划轮），`tasks_purpose` 增加 `planning`，重建 `tasks_purpose` / `tasks_goal_step_ref` / `tasks_output_schema` 三个 CHECK（全表校验时短暂持有 `ACCESS EXCLUSIVE`），新增 `tasks_planning_shape`、部分唯一索引与两个触发器，不回填 | 可逆 | 回退后的代码只对 `purpose` 为空的任务做崩溃重试，规划任务不会在 deny-all 之外重启；旧 `TaskWire.purpose` 枚举没有 `planning`，生产不校验结果，控制台把它当普通任务显示；撤 schema 先于 goal `0014`：删 `tasks_planning_shape`、`tasks_planning_round_fkey`、`tasks_planning_round_uidx`、触发器与函数 `tasks_planning_guard`、`worker_runs_planning_root`、列 `planning_round_id`，把三个 CHECK 恢复成 task/0011 的写法（如有 `planning` 行先处理），最后删 `schema_migrations` 的 task 12 行（§3.86） |
| v0.54.0 | goal `0015_planner_apply_minor`（#866，S11 GO9b）：`goal_planner_delegations.mode` 增加 `apply_minor`；`goal_planning_rounds` 新列 `kind`（默认 `proposal`）、`revision_class`、`class_reasons`，状态增加 `applied`、原因增加 `step_keeps_failing` / `run_not_running`；新函数 `goal_planning_class_reasons_valid`，改写 `goal_planning_rounds_guard` 与 `plan_revisions_planner`；只有列默认值 | 可逆 | 回退目标是 v0.53.0（GO9a、GO9b 同版），只回退代码即可；窗口前 `select count(*) from goal_planning_rounds where status = 'running'` 为 0；撤 schema 前提是没有 `applied` 的轮、没有带新原因的轮、没有 `apply_minor` 授权，先于 goal `0014` 与 task `0012`，最后删 `schema_migrations` 的 goal 15 行（§3.87） |
| v0.55.0 | goal `0016_planning_acceptance_anchor`（#872，S11 GO10b）：`goal_planning_rounds` 的 `step_run_id` / `step_attempt` / `failure_category` 改为可空，新列 `acceptance_round`，约束 `goal_planning_rounds_anchor`（恰好一个锚）、`goal_planning_rounds_acceptance_kind`（验收锚只能是 `proposal`），唯一索引 `goal_planning_rounds_acceptance_uidx`，重写 `goal_planning_rounds_guard`；不回填 | 可逆（有前提） | 只回退代码：窗口前 `select count(*) from goal_planning_rounds where acceptance_round is not null and status = 'running'` 为 0（否则先等结算，或让请求人继续或结束目标）；回退目标 v0.54.0（与 GO10 同版）。撤 schema：不带 `status` 的同一计数为 0，停 kernel、单事务：恢复 goal/0015 的守卫 → 删两个约束和索引 → 删 `acceptance_round`、三列恢复 `not null` → 删 `schema_migrations` 的 goal 16 行（§3.89） |
| v0.56.0 | governance `0030_action_request_target`（#876，S11 GO12）：`action_requests.target jsonb`（可空，不回填，不加索引），CHECK `action_requests_target_shape`，触发器 `action_requests_target_guard`（只写一次；`params` 指名的参数值必须等于 `identity`） | 可逆 | 只回退代码随时可以（旧代码不读写 `target`，排得比现在更严，遇 `executing` 就停）；撤 schema：**先撤 governance 0031（本表 0031 行）**，停 kernel、单事务，删触发器与函数 → 删 `target` 列 → 删 `schema_migrations` 的 governance 30 行（§3.90、§3.93） |
| v0.56.0 | core `0048_operation_target_governance`（#876，S11 GO12）：改写 core/0047 的两个函数，允许治理刷新在已发布 Operation 版本上写 `target` | 可逆 | 只回退代码随时可以；撤 schema：重跑 core/0047 的两条 `create or replace function`，删 `schema_migrations` 的 core 48 行，已带 `target` 的已发布版本保留（§3.91） |
| v0.56.0 | governance `0031_action_request_execution_guard`（#881，遗留 565）：函数 `action_request_identity_text`、`action_request_targets_conflict`、`action_request_execution_lock`，触发器 `action_requests_execution_guard`（进入 `executing` 前取门级锁，同门有冲突的执行中请求就拒绝，SQLSTATE `NTQ01`；开始事务不是 READ COMMITTED 时拒绝，SQLSTATE `NTQ02`） | 可逆 | 只回退代码随时可以（触发器留着；旧排水器偶尔收到 `NTQ01`：后台排水停一次，`request_action` 那次调用返回内部错误但请求照常执行一次）；撤 schema：**先于 0030**，停 kernel、单事务删触发器与四个函数，删 `schema_migrations` 的 governance 31 行，再做 0030 的步骤（§3.93） |
| v0.59.0 | core `0049_admin_agent_sessions`（#897，S11 AA1）：`sessions.kind` 的 CHECK 放宽一个值 `admin_agent`，不回填 | 可逆 | 只放宽：满足旧约束的行都满足新约束，重新加约束校验既有行无需回填；旧代码从不写 `admin_agent`，这一版也没有东西会签发管理员智能体的 Handle（开关默认关，AA4 之前没有运行时） | 先查 `admin_agent` 会话数：为 0 时可按 0001 的五个值重建约束并删掉 `schema_migrations` 的 core 49；不为 0 时保留 0049、只回退代码（restrict 外键）。AA4 之后回退到 AA1 之前的代码，先吊销管理员智能体 Handle（见 §3.97、0049 文件头） |
| v0.60.0 | llm-usage `0003_usage_refusal`（#910，遗留 589）：`llm_usage.refusal_scope` 列、CHECK `llm_usage_refusal`（`refused` ⇔ 有 scope，且 0 token、0 费用）、两个 `status = 'refused'` 的部分索引 `llm_usage_refused_session_idx`、`llm_usage_refused_turn_idx` | 可逆 | 只加可空列、新约束与部分索引：旧内核从不写 `refusal_scope`、从不写 `status = 'refused'`，在新 schema 上照常插入；但**不能只回滚内核**，旧内核的严格用量 schema 会拒掉含 `refusalScope` 的整批，新 llm-proxy 的队列满 1000 条后丢真实用量——llm-proxy 与内核同版回滚 | 默认保留 schema 与 refused 行，只回退代码（llm-proxy 与内核一起）。删 schema 可选，会连带删掉 refused 行，删前先导出：停内核，一个事务里删两个索引与约束 `llm_usage_refusal`、`delete from llm_usage where status = 'refused'`、`alter table llm_usage drop column refusal_scope`，再删 `schema_migrations` 的 llm-usage 3（见 0003 文件头） |
| v0.60.0 | goal `0017_pause_model_refused`（#910，遗留 589）：`goal_runs.pause_reason` 的 CHECK 加 `model_refused` | 可逆 | 只放宽：既有行都满足；旧内核从不写 `model_refused`，已经这样暂停的运行在旧代码里是一个没有文案的暂停，恢复照常 | 只回退代码即可。要撤 schema：先确认 `select count(*) from goal_runs where pause_reason = 'model_refused'` 为 0（请求者先恢复或结束每一条），再停内核、一个事务里按 0001 的列表重建 CHECK，删 `schema_migrations` 的 goal 17（见 0017 文件头） |
| v0.61.0 | core `0050_admin_trial_workspaces`（#914，AA3a）：`workspaces_purpose_check` 加 `admin_trial`，触发器 `workspaces_admin_trial_fixed` | 有条件可逆 | 旧代码的线上 schema 不认 `admin_trial`：只有 `select count(*) from workspaces where purpose = 'admin_trial'` 为 0 时才能只回退代码；不为 0 时先停用这些工作区、等满 7 天（`PURGE_RETENTION_DAYS`）清除后再回退，这 7 天里保留这个版本（试验工作区不是临时工作区，不会过期清除）。头注释没写 7 天等待，以本行为准 | 数为 0 时只回退代码即可；要撤 schema 按 0050 文件头：删触发器与函数，按 0028 的值重建 CHECK（`purpose in ('standard', 'ephemeral')`），删 `schema_migrations` 的 core 50 |
| v0.61.0 | core `0051_ontology_version_origin`（#914，AA3a，遗留 293）：`ontology_versions.origin` 可空列、取值 CHECK、写后不改触发器 | 可逆 | 只加可空列：旧代码不读不写 `origin`，在新 schema 上照常插入 | 只回退代码、保留列即可；要删列按 0051 文件头（删触发器与函数、`drop column origin`，删 `schema_migrations` 的 core 51） |
| v0.61.0 | worker `0013_draft_origin`（#914，AA3a，遗留 293）：`skills`、`procedures`、`worker_definitions` 的 `origin` 可空列、取值 CHECK、写后不改触发器 | 可逆 | 同上，旧代码不读不写 `origin` | 只回退代码、保留列即可；要删列按 0013 文件头，删 `schema_migrations` 的 worker 13 |
| v0.61.0 | governance `0032_admin_proposals`（#916，AA3b-1）：新表 `admin_proposals`、`admin_proposal_segments` 及 4 个函数 | 可逆 | 只加新表：旧版本不读不写 | 只回退代码、表留着即可；要删按 0032 文件头：`drop table admin_proposal_segments, admin_proposals`、删文件里的 4 个函数，再删 `schema_migrations` 的 governance 32 |
| v0.61.0 | governance `0033_change_segments_from_admin_proposals`（#920，AA3b-2）：`change_segments.source_kind` 加 `admin_proposal`、`proposed_by` 可空、4 个溯源列、约束 `change_segments_proposer`、唯一索引、3 个守卫 | 有条件可逆 | 留着 0033 只回退代码不损坏数据，但旧代码看不到 `admin_proposal` 记录（`proposed_by` 内连接 principals：不列出，get / verify / 撤销 404）；要撤掉管理员提案应用的内容，先在新版本里撤销再回退代码 | 只回退代码、保留 0033 即可。撤迁移的前提是没有 `source_kind = 'admin_proposal'` 的行：删 3 个触发器与函数和索引、删约束 `change_segments_proposer`、把 `change_segments_source_kind_check` 恢复为 `('pack')`、`proposed_by` 设回 not null、删 4 列，再删 `schema_migrations` 的 governance 33（见 0033 文件头） |
| v0.61.0 | governance `0034_admin_proposal_platform_segments`（#921，AA3c-1）：`admin_proposal_segments` 加 authority `platform` 与 3 列、新表 `platform_change_segments` / `platform_change_items`、守卫替换与新增、函数 `admin_proposal_platform_segment` | 有条件可逆 | 没有平台部分时只回退代码不损坏数据；有平台部分时旧代码会列出目标为空、决定不了的段，先在新版本里应用、拒绝或撤回提案，再回退代码 | 只回退代码、保留 0034 即可。撤迁移的前提是没有 authority `platform` 的段、也没有 `withdrawn_origin = 'platform_segment'` 的撤回，步骤见 0034 文件头 |
| v0.61.0 | governance `0035_admin_proposal_platform_dependency`（#923，AA3c-2）：两个依赖触发器及其函数、两个 security definer 读函数 `admin_proposal_platform_change` / `admin_proposal_applied_workspace_changes`、索引 `change_segments_admin_proposal`；不存数据 | 可逆 | 只回退代码不损坏数据：0.60.0 没有平台部分，守卫不会拦它的写入 | 只回退代码、保留 0035 即可。要撤迁移：删两个触发器及其函数、两个读函数和索引 `change_segments_admin_proposal`，再删 `schema_migrations` 里 governance 35 那一行（见 0035 文件头） |
| v0.62.0 | core `0052_activity_session_record`（#933，AA4-0，遗留 584）：替换触发器函数 `activities_trigger_record_guard`，加 `metadata.sessionKind` / `metadata.sessionId` 写后不改；不存数据 | 可逆 | 只回退代码不损坏数据：旧代码从不写这两个键 | 只回退代码、保留 0052 即可。要撤迁移：重新执行 0046 里 `create or replace function activities_trigger_record_guard` 的函数体，再删 `schema_migrations` 里 core 52 那一行 |
| v0.62.0 | core `0053_chat_agent_kind`（#937，AA4c-1）：`chats.agent_kind`（`entry` / `admin_agent`，默认 `entry`）、约束 `chats_agent_kind_check` 与 `chats_admin_agent_private`、触发器 `chats_agent_kind_guard` 及其函数 | 可逆 | 旧代码不写这一列、按列名读对话，代码可以单独回退；但管理员对话在旧代码里读作普通私有对话，并交给入口智能体起 Turn | 只回退代码前先把 `agent_kind = 'admin_agent'` 的对话归档（计数为 0 才直接回退）。要撤迁移：删触发器及其函数、删两个约束和这一列，再删 `schema_migrations` 里 core 53 那一行（见 0053 文件头） |
| v0.62.0 | governance `0036_admin_agent_targets`（#937，AA4c-1）：平台表 `admin_agent_targets` 及其守卫 `admin_agent_targets_guard`、读函数 `admin_agent_chosen_targets()` / `admin_proposal_target_chosen(uuid)`、工作区部分守卫 `admin_proposal_segments_target_chosen` | 有条件可逆 | 旧代码不认识这张表，照常提议、应用工作区部分，会被这里的守卫拒绝 | 只回退代码前先 `drop trigger admin_proposal_segments_target_chosen on admin_proposal_segments` 并删它的函数。要撤迁移：删这个守卫、两个读函数和表，再删 `schema_migrations` 里 governance 36 那一行（见 0036 文件头） |
| v0.62.0 | task `0013_task_admin_agent_session`（#954，AA5a-1）：`tasks.admin_agent_session_id`（可空、不回填）、外键 `tasks_admin_agent_session_fk`、守卫 `tasks_admin_agent_session_guard` 及其函数（插入时只许本工作区、代表 `on_behalf_of` 的 `admin_agent` 会话且工作区是试验工作区；写入后不改） | 可逆 | 旧代码插入、读取都写明列名，从不写这一列，插入时为 NULL 能过守卫；管理员智能体派的 Task 仍在表里，旧代码只是不显示来源 | 只需回退代码。要撤迁移：`drop trigger tasks_admin_agent_session_guard on tasks`、删它的函数、`alter table tasks drop column admin_agent_session_id`（外键随之删除），再删 `schema_migrations` 里 task 13 那一行（见 0013 文件头） |
| v0.62.0 | governance `0037_connection_request_admin_agent_session`（#954，AA5a-1）：`connection_requests.admin_agent_session_id`（可空、不回填）、外键 `connection_requests_admin_agent_session_fk`、守卫 `connection_requests_admin_agent_session_guard` 及其函数（插入时只许本工作区、代表 `requested_by` 的 `admin_agent` 会话且工作区是试验工作区；写入后不改） | 可逆 | 旧代码插入、读取都写明列名，从不写这一列；完成、取消请求时不动这一列，能过守卫 | 只需回退代码。要撤迁移：`drop trigger connection_requests_admin_agent_session_guard on connection_requests`、删它的函数、`alter table connection_requests drop column admin_agent_session_id`，再删 `schema_migrations` 里 governance 37 那一行（见 0037 文件头） |
| v0.62.0 | governance `0038_admin_proposal_rejection_reads`（#956，AA5a-2，遗留 595）：security definer 函数 `admin_proposal_rejections_since(timestamptz)`，只回答事务自己的平台用户在给定时间之后被拒的工作区部分（目标、提案、部分、时间，不含理由） | 可逆 | 只加函数，旧代码不调它 | 只需回退代码。要撤迁移：`drop function admin_proposal_rejections_since(timestamptz)`，再删 `schema_migrations` 里 governance 38 那一行（见 0038 文件头） |
| v0.63.0 | governance `0039_admin_proposal_segment_verified`（#976，AA5d-2）：security definer 函数 `admin_proposal_segment_verified(uuid)`，只对平台面回答这一段应用的东西在工作区里现在是否 `verified`（只给是或否，不给 id、条目、结果或时间，按 core 0042 的规矩） | 可逆 | 只加函数，旧代码不调它 | 只需回退代码。要撤迁移：`drop function admin_proposal_segment_verified(uuid)`，再删 `schema_migrations` 里 governance 39 那一行 |
| v0.64.0 | governance `0040_pack_installs_from_admin_proposals`（#1002，AA5g-2）：放宽 `change_segments_proposer`，pack 来源的安装记录可以带提案溯源（`admin_proposal_id`、`admin_proposal_segment_id`、提议人两列，四列要么全有、要么全空）；`change_segments_admin_proposal_guard` 加 pack 分支（只管 insert），核对记录与提案段一致：同一提案、同一提议人、段仍是 `proposed`、段里那一项是同包同版本的 `pack_install`、段的 `content_digest` 等于记录的 `source_digest`；`admin_proposal_segments_item_kinds` 允许工作区段只含一项 `pack_install`（平台段不行）。`admin_proposal` 记录的三条规则原样保留 | 可逆 | 约束放宽、guard 加分支、check 加一种情况。旧版本写的行三条都满足（pack 记录四列全空，没有段含 `pack_install`），旧代码读记录也不依赖 pack 记录这四列为空。CI 可逆性探针在 #1002 上是绿的，`reversibility-deltas.json` 没有新增声明。只回滚代码时，旧代码列出 `pack_install` 段会显示它不认识的条目类型、也应用不了它，只能拒绝或撤回 | 只需回退代码。要撤迁移，前提是没有带提案溯源的 pack 记录、也没有 `pack_install` 段：恢复 0033 的 `change_segments_proposer` 与 guard 函数体、0034 的 `admin_proposal_segments_item_kinds`，再删 `schema_migrations` 里 governance 40 那一行（见 0040 文件头） |
| v0.64.0 | core `0054_audit_acting_through`（#1028，批次 D3）：`audit_records` 加可空列 `acting_through`、`acting_session_id`（uuid，无外键），约束 `audit_records_acting_through_check` 与 `audit_records_acting_session_shape`（都是 `not valid`，只检查新写的行） | 可逆 | 只加列、加约束。旧代码不写这两列（写入为 `null`，两条约束都满足），读审计都用显式列名，不受新列影响。只回滚代码时，新版本写下的值留在表里，旧代码不读也不显示 | 只需回退代码。要撤迁移：删两条约束，再删两列，最后删 `schema_migrations` 里 core 54 那一行（见 0054 文件头） |
| v0.65.0 | governance `0041_one_active_grant_per_scope`（#1036，遗留 647）：`capability_grants` 加部分唯一索引 `capability_grants_one_active_per_scope`（`workspace_id, principal_id, resource_type, resource_id`，`nulls not distinct`，`where status = 'active'`）；建索引前先查存量重复，有就报错停下、什么都不改（§3.143） | 可逆 | 只加索引，不改任何行。只回滚代码时，旧代码对已持有的范围再插一行会被索引拒掉（23505），那次调用返回 500，不会写出重复行 | 只需回退代码。要撤迁移：`drop index capability_grants_one_active_per_scope;`，再删 `schema_migrations` 里 governance 41 那一行 |
| v0.65.0 | core `0055_chat_message_idempotency_key`（#1050，遗留 673）：`chat_messages` 加可空列 `idempotency_key`、约束 `chat_messages_idempotency_key_shape`（`not valid`）、部分唯一索引 `chat_messages_idempotency_key_uidx` | 可逆 | 只加列、约束和索引；旧代码不写这一列（写入为 `null`，约束满足），读消息都用显式列名 | 只需回退代码。要撤迁移：删索引、约束和列，再删 `schema_migrations` 里 core 55 那一行（见 0055 文件头） |
| v0.66.0 | worker `0014_definition_derivations`（#1071，GO16b）：新表 `worker_definition_derivations`（基版本、指纹、证据、沉淀人、时间），只许插入（`nexttime_app` 没有 UPDATE / DELETE 权限），插入前触发器校验基版本 | 可逆 | 只加新表：旧代码不读也不写 | 只需回退代码，表可以留着。要删表，按 0014 文件头的三条语句操作，再删 `schema_migrations` 里的 worker 14；删表会丢掉来历 |
| v0.67.0 | goal `0018_plan_revision_cited_precedents`（#1087，GO17b）：`plan_revisions` 加可空列 `cited_precedents uuid[]`，形状 CHECK 与 BEFORE INSERT 触发器（同一请求人、已结束、不重复、不引用自己）；插入后由 `plan_revisions_guard` 冻结 | 可逆 | 只加可空列：旧代码不读也不写 | 只需回退代码，列可以留着。要删，在内核停着时按 0018 文件头的步骤删除触发器、函数和列，再删 `schema_migrations` 里的 goal 18 |
| v0.68.0 | goal `0019_review_acceptance`（#1102，GO18a）：`goal_acceptance_checks` 加 `review_check` 列与 `review` 种类；新表 `goal_review_assessments`（只许插入，写入时按评审报告重算）；整份重写 `goal_acceptance_checks_guard` 与 `goal_runs_status_guard`（允许依据 `reviewer_assessed`，有评审的一轮不再记 `verified_by_check`） | 可逆 | 只加列、加表、重写守卫。上一版不认带评审的计划，会把这样的目标停下等人；已达成的行不受影响（守卫只看状态转换） | 只需回退代码，表与列可以留着。要撤，先让评审 Task 结束、数清按评审达成的目标（§3.155），再在内核停着时恢复 goal/0011 的两个函数 |
| v0.68.0 | task `0014_task_review`（#1102，GO18a）：`tasks` 加可空列 `review_round`、`review_check_key`，`purpose` 多 `review`；每条检查至多一个评审 Task（唯一索引）；评审 Task 的输入建后不改 | 可逆 | 只加可空列：上一版插入与查询都写明列名，不写这两列 | 只需回退代码。回滚前让评审 Task 跑完：上一版不会重试 `purpose` 非空的 Task，留下的评审 Task 不会在出网隔离之外重启 |
| v0.68.0 | task `0015_task_review_result`（#1108，GO18a 跟进）：触发器 `tasks_review_result_guard`（`before update of result`），评审 Task 的 `result` 只能由完成它的那次更新写，完成后不能再改 | 可逆 | 只加触发器。上一版只在完成 Task 时写 `result`，它的更新都过得了 | 只需回退代码。要撤：`drop trigger tasks_review_result_guard on tasks`、`drop function tasks_review_result_guard()`，再删 `schema_migrations` 里 task 15 那一行 |

**CI 可逆性探针实测（2026-10-02，S9 D4，`reversibility-probe.yml` 以 `workflow_dispatch` 补跑）**——v0.16.0 起
"依据"列只有读代码推理的几行，现在都有了跑出来的证据（v(n-1) 的 kernel 测试套件在 v(n) 迁移后的库上）：

| v(n-1) 代码 → v(n) schema | 覆盖的迁移 | 结果 | 覆盖说明 |
|---|---|---|---|
| v0.13.2 → v0.14.0 | core 0030、0031 | 123 / 123 测试文件通过 | `workspaces` / `chats` 的读写在共享库套件里都有 |
| v0.14.0 → v0.15.0 | core 0032 | 131 / 131 通过 | 普通审计行的写入在共享库套件里；`workspace_id is null` 的平台审计行只在自建私有库的 platform-* 套件里写——那部分对 0032 无信号，但 0032 只放宽约束，旧代码合法的写入在新约束下必然合法 |
| v0.19.0 → v0.20.0 | worker 0003 | 140 / 140 通过 | 三张表的提议 / 发布 / 读在共享库套件里；旧代码从不删除这三张表的行 |
| v0.22.0 → v0.23.0 | governance 0012 | 143 / 143 通过 | `agent_profiles` 的读写（`setAgentProfile` / 请求执行路径）在共享库套件里 |
| v0.34.0 → v0.35.0 | core 0033 | 149 / 149 通过 | 本体提议 / 发布 / 读在共享库套件里；旧代码从不删除 `ontology_versions` 的行 |
| v0.35.1 → #400 | core 0034 | 149 / 149 通过（#400 的 PR 自动探针） | 修订发布（v0.35.1 先发布、后弃用的顺序，正是延迟约束要放行的情形）在共享库套件 `manifest.test.ts` 的 S3.12 组里；自建私有库的 platform-* 套件只跑 v0.35.1 自己的迁移，对 0034 无信号 |
| v0.38.0 → #436 | core 0035、governance 0015 | 161 / 161 通过（#436 的 PR 自动探针） | 吊销、Evidence / Fact 写入、工作区状态读取、平台设置读取都在共享库套件里；`ontology-guard` / `worker-result` 两个 v0.38.0 套件在工作区事务里改自己工作区的 `ontology_enforcement`，正是兼容放行保留的那一种写入（本地实测：去掉 `workspaces_own_ontology_enforcement` 后这两个套件 4 个用例失败）；平台事务对 `workspaces` / `platform_settings` 的写入主要在自建私有库的 platform-* 套件里，那部分跑 v0.38.0 自己的迁移、对两条迁移无信号，由本 PR 的 `write-confinement.integration.test.ts` 在新 schema 上覆盖 |

结论：以上迁移"可逆"由推理升级为实测（空库上的 schema 兼容性；依赖生产数据的部分不在其内）。此前这里写的
`drill-upgrade.sh --to v0.15.0 --ack-live-restore` 主机 PROBE 不再需要——它的回滚会覆盖活库，维护者 2026-10-02 选择
不用（S9 D4 方案 (b)）。以后每个改动迁移的 PR 自动跑同一个探针（BASE = 最新发布 tag）。

**规则**：任何一次发布如果表里出现"不可逆"，必须在合并那次 release PR **之前**把这条不可逆标注
手工加进它自己的 `CHANGELOG.md` 那一节（本文件 §5"回滚一次还没合并的 release PR"已经说明这个
PR 允许人工改动）——写清楚是哪个迁移、为什么不可逆、回退必须用哪次备份。`scripts/drill-upgrade.sh`
的 PROBE 输出（`PROBE old-code-on-new-schema ok|failed`）是这个判断的证据来源：一次真实升级前
（或候选 tag 定下来后）跑一遍 `drill-upgrade.sh --to <候选 tag> --ack-live-restore`，PROBE 结果
连同上面表格式的推理一起，决定要不要在这次发布的 CHANGELOG 里加标注。
