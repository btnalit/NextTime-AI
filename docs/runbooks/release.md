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

**应用一个 release 的唯一入口（S9 D2）**：在检出根目录

```
sh scripts/apply-release.sh vX.Y.Z           # 源码构建镜像
sh scripts/apply-release.sh --pull vX.Y.Z    # 拉取发布镜像（失败自动退回源码构建）
```

经 SSH 时作为后台任务运行并跟日志（脚本先打印日志路径，`${NEXTTIME_DATA}/drills/apply-<tag>-<ts>.log`）：每步一行
`STEP …`，致命步骤打印 `FAIL <step>` 并以非 0 退出，最后一行 `RESULT ok` 或 `RESULT acceptance-failures=<n>`。
它按顺序做完本节下面分散描述的全部手续：备份新鲜度 → 发版前 dump（`backups/pre-upgrade/`）→ 切 tag →
拉取或构建镜像 → 迁移 dry-run 与应用 → `up -d` → S3 → S1 → S2 → S4 → `BACKUP_NOW` → 只留 3 份发版前 dump →
清理过期的 ephemeral 工作区。dump / 切 tag / 镜像 / 迁移任一步失败都在 `up` 之前停下，在跑的栈不受影响；
验收失败只计数不中止（栈已在新版本上，读各套日志后按 §5 决定是否回滚）。主机差异只来自 `.env`。
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
sh scripts/pull-images.sh vX.Y.Z       # 拉取 → 验签（身份钉到本仓库 main 上的 publish-images.yml）→ 重打成 compose 的本地名
docker compose up -d --no-build
```

验签用钉 digest 的 cosign 容器跑，主机不需要装任何东西。包是公开的（从公开仓库的工作流发布、继承仓库可见性，
2026-10-02 核实匿名可拉），主机不需要任何 registry 凭证；若以后改成私有，先 `docker login ghcr.io`（read:packages
令牌，放主机 `secrets/`，不进仓库），验签会在匿名失败后带上 docker 配置重试。重打 tag 之后 compose、worker-supervisor 白名单、`activeRuntimeImage`、
「pi 运行时」卡片看到的名字与标签和源码构建完全一样。`.env` 里 `EXPLORER_BUILD=1` 的主机：发布的 caddy
不含 Explorer bundle，caddy 仍用 `sh scripts/build-images.sh caddy` 构建。验收夹具（accept-s2 / fake-llm）
不发布，照旧在主机构建。拉取或验签失败就退回 `build-images.sh`，并记进主机私有记录。

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
5. **`deploy/worker-runtime/Dockerfile` 的 pi 全局安装层**（`npm install -g … @earendil-works/pi-
   coding-agent@${PI_VERSION}`）本来就已经只 keyed 在 `pi.version`（`COPY pi.version` 是这一层唯一
   的输入,在稳定的 apt/useradd 层之上）,这次只加一个 `RUN --mount=type=cache,id=npm-cache,
   target=/npm-cache` + `npm install -g --cache=/npm-cache …`：pi 升版本时,新版本依赖树里没变的那部分
   包仍能复用缓存,不必整树重新下载。

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

**风险**：BuildKit 缓存挂载需要 BuildKit 后端,而不是旧的 legacy builder——`docker-preflight.md`
要求的"Docker Engine / Compose v2"这一前提下,`docker compose build` 默认经 buildx/BuildKit 实现,
本身已经在用 `# syntax=docker/dockerfile:1.7`（每个 Dockerfile 早已声明,这次没有改动这一行,说明
BuildKit frontend 早就在被使用,主机第一次用到 `--mount=type=cache` 之前不需要单独"预拉"这个
frontend 镜像）。如果主机的 Docker 版本异常老旧、`docker compose build` 落回 legacy builder,
`--mount=type=cache` 会直接报语法错误而不是静默忽略——下次主机应用前先跑一次
`docker compose build kernel`确认不报错,再跑全量 `sh scripts/build-images.sh`。

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
| v0.36.0 之后的下一版 | governance `0014_action_request_idempotency_window`（R-53 / 决定 D-12）：把 0003 的 `action_requests_idempotency_key_uidx`（所有非空键、任何状态唯一）拆成两个部分唯一索引——同名索引只管非派生键（`idempotency_key not like 'auto:%'`，任何状态，语义不变）；新增 `action_requests_derived_idempotency_key_inflight_uidx` 只管 `request_action` 自己派生的 `auto:` 键，且只在行仍在途时（`proposed` / `policy_evaluated` / `auto_approved` / `pending_approval` / `approved` / `executing`）唯一。不改数据、不加列 | 可逆 | 建索引不会失败：旧索引下每个键本就唯一，两个子集必然唯一；DROP 与两条 CREATE 在同一事务里，没有无唯一约束的时刻。读了 v0.36.0 的 `requestAction`：先按键查任何状态的行、命中即重放，查不到才插入——旧代码在新 schema 上照旧"命中即重放"，等于修复前的行为；新代码期间留下的同键多条终态行，旧代码取 `rows[0]`（任一条）重放，仍是修复前"重放旧行"的已知行为。唯一的差异在并发：同一派生键两次同时插入时，冲突现在报新索引名，旧代码只认旧名，会把这次并发重复当错误抛出（调用失败，不会写出重复行）；旧套件的并发用例用的是非派生键，不受影响 | 只需回退代码；若要连 schema 一起撤：先确认没有同一 `(workspace_id, idempotency_key)` 的多条行（新代码期间可能已有，那时下面的 CREATE 会失败，留着即可），再 `drop index action_requests_derived_idempotency_key_inflight_uidx; drop index action_requests_idempotency_key_uidx; create unique index action_requests_idempotency_key_uidx on action_requests (workspace_id, idempotency_key) where idempotency_key is not null`（不撤也无害） |
| v0.36.0 之后的下一版 | task `0005_task_idempotency_key`（R-54 / 决定 D-12）：`tasks` 新增可空 `idempotency_key`（不回填）+ 两个部分唯一索引：`tasks_idempotency_key_uidx`（非派生键，任何状态）、`tasks_derived_idempotency_key_inflight_uidx`（`invoke_worker` 派生的 `auto:` 键，仅 `created` / `queued` / `running` / `waiting_approval`） | 可逆 | 读了 v0.36.0 的 `insertQueuedTaskWithQuotaCheck`：`insert into tasks (…)` 是显式列清单，不写新列，旧代码插入的行恒为 NULL，两个索引的 `where` 都不覆盖 NULL，不会拒绝任何旧写入；`TASK_ROW_COLUMNS` 同样是显式列清单，不读新列。回退后 `invoke_worker` 退回没有幂等键的旧行为（客户端超时后的重试会再起一个 Worker，即 R-54 本身） | 只需回退代码；若要连 schema 一起撤：`drop index tasks_derived_idempotency_key_inflight_uidx; drop index tasks_idempotency_key_uidx; alter table tasks drop column idempotency_key`（不撤也无害） |

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

结论：以上迁移"可逆"由推理升级为实测（空库上的 schema 兼容性；依赖生产数据的部分不在其内）。此前这里写的
`drill-upgrade.sh --to v0.15.0 --ack-live-restore` 主机 PROBE 不再需要——它的回滚会覆盖活库，维护者 2026-10-02 选择
不用（S9 D4 方案 (b)）。以后每个改动迁移的 PR 自动跑同一个探针（BASE = 最新发布 tag）。

**规则**：任何一次发布如果表里出现"不可逆"，必须在合并那次 release PR **之前**把这条不可逆标注
手工加进它自己的 `CHANGELOG.md` 那一节（本文件 §5"回滚一次还没合并的 release PR"已经说明这个
PR 允许人工改动）——写清楚是哪个迁移、为什么不可逆、回退必须用哪次备份。`scripts/drill-upgrade.sh`
的 PROBE 输出（`PROBE old-code-on-new-schema ok|failed`）是这个判断的证据来源：一次真实升级前
（或候选 tag 定下来后）跑一遍 `drill-upgrade.sh --to <候选 tag> --ack-live-restore`，PROBE 结果
连同上面表格式的推理一起，决定要不要在这次发布的 CHANGELOG 里加标注。
