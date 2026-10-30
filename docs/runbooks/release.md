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
5. **生产 apply 之前先预演（#488，v0.43.0 起）**：tag 出来后在 Actions → `staging` 手动 dispatch，`to` = 待应用的
   tag（走 `--pull`，验签发布镜像），在一次性 runner 上从上一个发布版升上去并跑 S3→S1→S2→S4；需要真实模型回归时勾
   `real_model`（`staging-real-model` environment，仅 main 触发，不设人工审批，见 `staging-rehearsal.md` §4）。步骤、成本上限与它复现不了的东西见
   `docs/runbooks/staging-rehearsal.md`。预演绿了再按 §3 上生产主机。

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
