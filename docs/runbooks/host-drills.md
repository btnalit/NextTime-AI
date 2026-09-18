# Runbook：host-drills（安装 / 升级回滚两个操作员演练脚本）

对应任务：`docs/development-tasks.md` §"S5.8 交付与演示闭环"交付物 1、2。前置阅读：
`docs/runbooks/README.md` §①（主机初始化真实顺序）、`docs/runbooks/host-checkout.md`、
`docs/runbooks/operations.md`（§4.1 冷启动顺序、§9 回滚）、`docs/runbooks/backup-restore.md`
（`scripts/restore.sh`/`scripts/drill-restore.sh` 已有的恢复演练）、`docs/runbooks/accept-s1.md`、
`docs/runbooks/host-accept-s2.md`、`docs/runbooks/host-accept-s3.md`、`docs/runbooks/release.md`
（新增的"迁移可逆性"一节，`drill-upgrade.sh` 的 PROBE 步骤就是那张表的证据来源）。占位符取值见
`docs/private/`（不入库）。

## 目的

S5.8 把交付闭环拆成几段——安装到一台陌生主机、接入到溯源（S1/S2/S3 验收 + `--real` 已覆盖）、
升级/回滚——其中只有"安装"和"内核+数据库迁移的升级/回滚"两段此前只有 runbook 没有演练脚本。
两个脚本只做**编排与计时**，不重新发明验证——真正的验证仍然是 `scripts/accept_s1.sh` /
`accept_s2.sh` / `accept_s3.sh` 本身；这两个脚本的价值在于把"从一台干净主机走到三份验收通过要
多久、卡在哪一步"和"一次真实升级/回滚要多久、迁移是否可逆"变成可重复跑、可读输出的证据，而不是
只存在于某次手工操作的记忆里。

- `scripts/drill-install.sh`：在一台只有 Docker 的干净主机上，从零走到三份验收通过。
- `scripts/drill-upgrade.sh`：从当前已部署版本 v(n-1) 升级到一个新 tag v(n)，三份验收通过，收集
  "v(n-1) 的代码能否在 v(n) 的 schema 上正确跑"的可逆性证据，再完整回滚（代码 + 数据库）到
  v(n-1) 并复跑 S1 验收。

两者都只打印 `PASS`/`FAIL`/`STEP ... ok (Ns)` 这类结构化行，不需要人工判断输出是否"看起来正常"。

---

## 一、`scripts/drill-install.sh`

### 前置条件

- 一台干净主机：只有 Docker Engine + Compose v2（`docs/runbooks/host-preflight.md` 描述的最低
  条件），**没有**跑过这个仓库的任何部署——脚本自己会检查并拒绝在已有部署的主机上运行（见下方
  GUARD）。
- 运行本脚本的操作员机器（不是目标主机）：能 SSH 到目标主机、且当前目录是本仓库检出根目录
  （脚本要把 `scripts/host-preflight.sh` 等文件的内容通过 `ssh ... < scripts/host-X.sh` 管道过去，
  这正是各 `host-*.md` runbook 一直在用的方式，本脚本只是把这些手动步骤串起来）。
- 提前想好三样这个脚本**不会替你猜**的值（详见下方"常见问题"里的"为什么不自动生成网络参数"）：
  `KERNEL_BIND_ADDR`（caddy 绑定的地址）、`NEXTTIME_SUBNET_CONTROL`、`NEXTTIME_SUBNET_WORKERS`
  （两个不冲突的 Docker 网段）。

### 步骤

```bash
cd <本仓库检出根目录>
TARGET_HOST=<ssh目标> \
CODE_DIR=<目标主机上的检出路径> \
NEXTTIME_DATA=<目标主机上的数据根目录> \
KERNEL_BIND_ADDR=<目标主机地址> \
NEXTTIME_SUBNET_CONTROL=<CIDR> \
NEXTTIME_SUBNET_WORKERS=<CIDR> \
  sh scripts/drill-install.sh
```

可选：`REF`（要检出的 tag/分支，默认 `main`）、`SSH`（ssh 命令覆盖，例如带 `-i`/`-p`）、
`REPO_URL`、`KERNEL_PUBLIC_URL`、`WORKER_RUNTIME`、`TZ`/`BACKUP_TIME`/`BACKUP_RETENTION`——完整
清单与默认值见脚本自己的头注释。

脚本依次打印每一步：

```
STEP ssh-connectivity ... ok (1s)
STEP guard-target ... ok (0s)
STEP preflight ... ok (3s)
STEP checkout ... ok (2s)
STEP bootstrap ... ok (1s)
STEP env-init ... ok (1s)
STEP handle-keys ... ok (1s)
STEP write-env ... ok (0s)
STEP compose-config ... ok (1s)
STEP build ... ok (312s)
STEP postgres-up ... ok (14s)
STEP migrate ... ok (2s)
STEP stack-up ... ok (28s)
STEP caddy-health ... ok (1s)
STEP accept-s1 ... ok (96s)
STEP accept-s2 ... ok (210s)
STEP accept-s3 ... ok (180s)

DRILL-INSTALL OK
total elapsed: 853s (source build: 312s of that total)
...
```

任何一步失败：`FAIL <step> — see <runbook 路径>`，非 0 退出，不会带着已知的失败状态继续往后跑。

### 验证

`DRILL-INSTALL OK` 且退出码 0 = 从一台干净主机走到三份验收通过；`total elapsed` 与单独列出的
`source build` 耗时就是本条验收要求的"记录总耗时（含源码构建）"。

### 回滚

这个脚本本身不做任何破坏性操作以外的事——它*就是*"从零安装"，没有"回滚安装"这个概念。半途失败
后想重新跑：先决定是清理掉这次的半成品（`ssh <TARGET_HOST> 'rm -rf <CODE_DIR>'`，
`${NEXTTIME_DATA}` 下按 `docs/runbooks/host-bootstrap.md` 的目录树手动清理，或者更干净地换一台
主机）还是继续从半成品上重跑——脚本调用的每一个 `host-*.sh` 都是幂等的（各自 runbook 已经写明），
`docker compose build`/`up -d` 也是幂等的，所以大多数半途失败**可以直接重新跑本脚本**（除了
GUARD 那一步——一旦 `.env` 已经生成，GUARD 会拒绝重跑；此时要么手动删掉 `.env` 重来，要么后续步骤
改手动接力）。

### 依赖顺序的交付缺口（务必先读）

`docs/development-tasks.md` 交付物 1 原文写的顺序是 `host-preflight.md → host-bootstrap.md →
host-checkout.md`；`docs/runbooks/README.md` §① 实际给出的顺序是 `host-preflight.md →
host-checkout.md → host-bootstrap.md → host-caddy.md → ...`。两者互相矛盾，而 README 自己也不完全
自洽：`host-checkout.md` 把 §E3.3（`host-env-init.sh` + `gen-handle-keys.sh`）算作"checkout 这个
runbook 的一部分"，但 §E3.3 的正文明确写着依赖 §E2（也就是 `host-bootstrap.md`）的
`secrets/pg_password` 已存在——按 README 表格字面顺序"先整份走完 host-checkout.md 再走
host-bootstrap.md"是走不通的。`drill-install.sh` 采用唯一真正满足依赖关系的交叉顺序：先 clone
代码（§E3.1）→ 跑 `host-bootstrap.sh`（E2）→ 跑 `host-env-init.sh` + `gen-handle-keys.sh`（E3.3
的剩余部分）→ 写 `.env`（E3.2）→ `docker compose config`（E3.4）→ 起 Postgres（E4）。这个交叉本身
就是一个交付缺口：两份文档都需要把"host-checkout.md 的 §E3.3 必须在 host-bootstrap.md 之后"这条
关系写清楚，本任务不改动 `development-tasks.md`/`README.md`，只在这里记录。

---

## 二、`scripts/drill-upgrade.sh`

### 前置条件

- **在目标主机上**、检出根目录下跑（不经 SSH——这个脚本要反复切换这份检出自己的 `git checkout`，
  只能本地跑）。
- 栈已经在跑（至少 `postgres` 与 `kernel`），`./.env` 已存在，工作树**干净**（脚本会
  `git checkout` 切换版本，不允许带着未提交的改动跑）。
- 要升级到的 tag 已经存在于 `origin`（先在本机 `git fetch origin --tags` 确认，或者刚合并的
  release PR 已经打过 tag）。
- **首次使用**（当前检出的版本里还没有这个脚本，例如从 v0.10.0 升到第一个带它的 tag）：直接从目标
  tag 取脚本本身出来跑，其余都不用动——`git fetch origin --tags && git show <vX.Y.Z>:scripts/drill-upgrade.sh
  > /tmp/drill-upgrade.sh && sh /tmp/drill-upgrade.sh --to <vX.Y.Z> --ack-live-restore`。脚本本来就把
  自己复制到检出外再运行（它要 `git checkout` 自己所在的检出），从 `/tmp` 起跑与从检出起跑等价；它调用
  的 `scripts/restore.sh` / `accept_s*.sh` 仍取自检出里"当时那个版本"的文件，这正是设计意图。

### 步骤

```bash
cd <目标主机上的检出根目录>
sh scripts/drill-upgrade.sh --to v0.13.0 --ack-live-restore
```

`--ack-live-restore` 是必填的——这个脚本在回滚阶段会用 `scripts/restore.sh --target-db nexttime
--i-know` 真实覆盖活库，不加这个开关直接拒绝运行，没有绕过它的选项。`--keep-dump`
可以带但不做任何事（升级前的 dump 本来就永远不删，见下）。

脚本依次打印每个阶段的 `PASS`/`FAIL` 行（约定同 `scripts/drill-restore.sh`），关键几行：

```
PASS preflight-stack running: postgres kernel caddy ...
PASS preflight-git-clean working tree clean
PASS preflight-to-tag v0.13.0 exists on origin
PASS preflight-from-version currently at v0.12.0 (af05598...)
PASS pre-upgrade-dump /path/to/backups/db/nexttime-<ts>.dump (kept — this drill never deletes it)
PASS checkout-to v0.13.0 (<commit>)
PASS build-to images built
PASS migrate applied (see --dry-run listing above for what was pending)
PASS up-to stack up
PASS accept-s1-to S1 OK
PASS accept-s2-to S2 OK
PASS accept-s3-to S3 OK
PASS checkout-probe-from v0.12.0 (af05598...)
PROBE old-code-on-new-schema ok
PASS checkout-rollback-from v0.12.0 (af05598...)
PASS rollback-code v(n-1) (af05598...) checked out, built, up — restoring the pre-upgrade dump now
PASS rollback-restore restored .../nexttime-<ts>.dump over the live 'nexttime' database
PASS accept-s1-rollback S1 OK

DRILL-UPGRADE OK
from: v0.12.0 -> to: v0.13.0 -> rolled back to: v0.12.0
pre-upgrade dump (kept): .../nexttime-<ts>.dump
reversibility probe: ok (this is the evidence for docs/runbooks/release.md's 迁移可逆性 table — see that file)

phase timings:
  preflight:            2s
  pre-upgrade dump:     8s
  build v(n):           298s
  migrate:              3s
  up v(n):               22s
  accept S1/S2/S3 v(n): 486s
  probe (non-fatal):    301s
  rollback + accept S1: 214s

to re-apply this upgrade for real (not a drill), from the checkout root:
  git fetch origin --tags && git checkout v0.13.0
  ...
```

**PROBE 那一行是非致命的**——`PROBE old-code-on-new-schema failed` 不会让脚本以非 0 退出；它是
`docs/runbooks/release.md`"迁移可逆性"表的证据来源，不是这个演练本身的验收标准。真正的验收标准是
"三份验收通过 + 回滚后 S1 通过"，这两处任一失败都会让脚本 `FAIL` 并以非 0 退出。

### 验证

`DRILL-UPGRADE OK` 且退出码 0 = 升级到 v(n) 三份验收通过、回滚（代码 + 数据库）后 S1 验收通过。
脚本结束状态：代码检出停在 v(n-1)（开始时在分支上就回到那个分支，开始时钉在 tag 上就回到那个
commit），数据库已还原成升级前的内容——**这就是最终状态，不需要再手动做什么**才算"演练完成"；真的要升级，按脚本末尾打印的"to re-apply this upgrade for real"那几行
命令做。

### 回滚

演练脚本自己在跑完时**已经处于回滚后状态**（代码 v(n-1)、数据库还原自升级前的 dump）——没有"回滚
这个演练"的必要。如果脚本中途 `FAIL` 退出（例如升级到 v(n) 的三份验收没过），当前检出可能停在
v(n) 而数据库仍是 v(n) 的 schema（因为回滚阶段还没跑到）——这时按 `docs/runbooks/operations.md`
§9 手动决定：要么继续排查 v(n) 的问题，要么手动 `git checkout <v(n-1) 的 tag/commit>` +
`sh scripts/restore.sh --db <pre-upgrade-dump 的路径，脚本已经打印过> --target-db nexttime
--i-know` 走一遍脚本本该做的回滚。**`pre-upgrade-dump` 那一行打印的路径就是唯一需要记下来的
东西**——脚本从不删除它。

### 已知遗留（如实记录，不在本任务范围内解决）

- **S3 的临时 workspace 目录会变成孤儿**：`accept_s3.sh`（在升级到 v(n)、PROBE、回滚后复跑这三次
  期间各跑一次）每次都会在 `${NEXTTIME_DATA}/workspaces/` 下留一份临时数据；数据库层面的 `restore`
  只还原 Postgres，不动这个目录——回滚完成后，这些目录仍然留在磁盘上，不属于任何数据库还原后还认得
  的 workspace。真实回滚同样会有这个副作用；本演练脚本不清理，按
  `scripts/delete-workspaces-matching.sh`/手动 `rm -rf` 定期处理。
- **版本专属的手动主机步骤会被回滚吃掉**：某些版本的主机应用除了 `make migrate`
  还需要额外的手动步骤（例如 `docs/STATUS.md` §3 记录的 W9 主机应用注意里"采集器 Source 改名"、
  W10 的"`config/ontology/` 补种子文件"）——这些步骤改的是数据库内容或主机文件，`restore.sh`
  的数据库还原会把它们一起撤销，本脚本无法知道某个具体版本需要重放哪些步骤，也不尝试猜测；一次
  **真实**升级仍然要按该版本自己的发布说明手动补做这些步骤，本演练只验证"迁移本身 + 三份验收 +
  回滚"这一条主干。

---

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `drill-install.sh` 在 `write-env` 一步 `FAIL` | `KERNEL_BIND_ADDR`/`NEXTTIME_SUBNET_CONTROL`/`NEXTTIME_SUBNET_WORKERS` 没给 | 这是刻意设计，不是 bug——脚本不替你猜一个可能已经和主机现有 Docker 网段冲突的子网，也不替你猜一个能被外部访问的地址；看 `preflight` 步骤打印出的 `docker-network-subnets` 那一行，挑不冲突的值，按脚本头注释传入 |
| `drill-install.sh` 在 `guard-target` 一步 `FAIL` | 目标主机上 `$CODE_DIR/.env` 已存在，或 `$NEXTTIME_DATA/pgdata` 非空 | 刻意的、没有绕过开关的安全阀——绝不能把这个脚本指向一台已经有真实部署/真实数据的主机；换一台真正干净的主机，或者确认这台主机上的旧内容确实可以丢弃后手动清理 |
| 浏览器打开 `https://<地址>:8443/` 提示证书不受信任 | `docs/runbooks/host-caddy.md` §E8.2 的内网 CA 信任是客户端/操作员浏览器自己的信任库设置，两个演练脚本都不碰它（也碰不到——那是每个人自己机器上的操作） | 三份验收脚本内部用 `curl -sk` 跳过校验，不受影响；真的要在浏览器里打开控制台/Explorer，按 host-caddy.md §E8.2 手动导入一次 |
| Explorer（`/explorer/`）打开显示"bundle not built" | `drill-install.sh` 不设置 `EXPLORER_BUILD=1`（默认占位页），因为 accept_s3.sh 的三个 `explorer-*` 断言测的是内核自己的 Graph/Decision API 端点，不是 Explorer 静态前端 | 按 `docs/runbooks/host-explorer.md` 步骤 1 手动补建；不影响三份验收的判定 |
| `drill-upgrade.sh` 的 PROBE 那一行是 `failed` | 这正是它存在的意义——记录 v(n-1) 的代码不能在 v(n) 的 schema 上正确运行 | 不是这次演练的失败；把这个结果填进 `docs/runbooks/release.md`"迁移可逆性"表对应版本那一行，并在那次发布的 CHANGELOG 里加不可逆标注（release.md §"迁移可逆性"自己的规则） |
| `drill-upgrade.sh` 在 `preflight-git-clean` 一步 `FAIL` | 检出目录有未提交的改动——脚本要反复 `git checkout` 切换版本，不允许带着改动跑，防止丢失工作 | `git status` 看一下，提交或 `git stash` 之后重跑 |
