# Runbook：backup-restore（每日备份与恢复演练）

对应任务：development-tasks.md § S1.12。设计 §10.2 / §10.4 / §13。服务重启顺序/健康检查见
`docs/runbooks/operations.md`，本文档只覆盖数据层面的备份与恢复。`backup` 容器的权限模型
（2026-09-08 定稿）：**root + `cap_drop: [ALL]` + 仅 `cap_add: [DAC_READ_SEARCH]`**，只读根文件系统，
`no-new-privileges`，挂载只有只读的备份来源与可写的 `backups/`。本节先说这个模型为什么是这样、
主机要准备什么、怎么验证；下面"备份什么"等章节不变。

## 权限模型与主机前置条件

**为什么不是非 root。** fix/socket-proxy-and-backup-user 曾把它切到 `user: "10001:10001"`，
主机实测（在该容器内 `grep Cap /proc/self/status`）证明行不通：Docker 的 `cap_add` 只进容器的
*bounding set*，非 root 用户起来时 permitted/effective 为空——`CapEff: 0000000000000000`，
`DAC_READ_SEARCH` 从未生效；Docker 挂载的 `/run/secrets/pg_password` 是 root 0600，10001 读不到，
`pg_dump` 直接 "no password supplied"；`caddy/` 下 certmagic 写死的 root 0600 私钥同样读不到。
以 root 且只保留一个 cap 运行时 `CapEff: 0000000000000004`，两者都可读。另一条路——把 secret 与
caddy 目录改成组可读——是为了让容器"看起来"非 root 而削弱主机文件系统，不取。

**这个 root 被什么约束住。** 除读/目录搜索权限绕过外无任何 capability（没有 `DAC_OVERRIDE`、
`CHOWN`、`SETUID`…），根文件系统只读，`no-new-privileges`，挂载只有 `workspaces/ config/
gatekeepers/ caddy/ llm-proxy/ models/`（只读）与 `backups/`（读写）——它写不到任何原本写不到的
地方，也碰不到 Docker socket 或其他服务。`llm-proxy/` 归 uid 10001、0750（`host-llm-proxy-init.sh`
/ `host-env-init.sh`）——同一个 `DAC_READ_SEARCH` 也是它能读进这个目录的原因，和读
`gatekeepers/`、`caddy/` 走的是同一条路。

**为什么需要 `DAC_READ_SEARCH`（而不是 chmod/chown）。** `caddy` 以 root 跑，`caddyserver/certmagic`
的 `FileStorage` 把每次证书/密钥写入都硬编码成 `0600`/`0700`、root 属主、原子 rename 替换 inode
（读过 `filestorage.go` / `internal/atomicfile/file.go` 确认）。`on_demand` TLS 每来一个新 SNI 就
可能重新写文件，任何事先做的 `chmod -R o+rX` / `chown -R :10001 + setgid` 都不会延续到新文件上
（certmagic 自己的 `chmod(0600)` 还会清掉组位）。能让 `tar` 在任何时刻可靠遍历 `caddy/` 的是这个
capability，所以 `caddy/` 不需要给其他用户任何权限。`caddy/` 里有内部 CA 的根私钥，
`scripts/host-env-init.sh` 对它先 `chown -R 0:0`、顶层 `chmod 700`，再 `chmod -R o-rwx`（收紧）。
早先版本在这里执行的是 `chmod -R o+rX`，会让根私钥对主机上所有本地账户可读（2026-10-02 复审
R-32），重跑当前版本即可修正。

**为什么必须先 chown**：caddy 虽然是 root，但带 `cap_drop: [ALL]`，没有 `DAC_OVERRIDE`，和普通 uid
一样受属主 / 组 / 其他位约束。更早的某个版本把 `caddy/` 顶层目录 chown 成了 10001（750），那样的主机
全靠旧的 `o+rX` 才进得去；只去掉其他人权限就会把 caddy 自己锁在 CA 外面——v0.36.0 应用到主机时正是
这样：caddy 报 `open /data/caddy/pki/authorities/local/root.crt: permission denied` 反复重启，控制台
中断约 10 分钟，`chown 0:0` + `chmod 700` 后恢复。

**主机前置条件**：`${NEXTTIME_DATA}/backups` 必须是 **root 属主（0:0，750）**——没有 `DAC_OVERRIDE`
的 root 只能写自己拥有的目录；fix/socket-proxy-and-backup-user 那版 `host-env-init.sh` 把它 chown 成了
10001，导致每次备份以一条空的 `pg_dump failed:` 失败（主机实测），当前版本的 `sh scripts/host-env-init.sh`
（幂等）会把它强制改回 0:0 并打印确认，同时把 `caddy/` 收紧为 `o-rwx`（输出里"files readable by others"应为 0）。

**上线顺序**：`docker compose up -d docker-socket-proxy`（若同批上线；`backup` 本身不用它）→
`docker compose up -d backup`（或整批 `docker compose up -d`）。

**验证（先于真实备份）**——注意必须用 `--entrypoint` 换掉固定的 `["/bin/sh","/backup.sh"]`，
否则追加的参数只会被 `backup.sh` 忽略并照常跑一次备份：
```
docker compose run --rm --no-deps --entrypoint sh backup -c 'id -u; grep -E "^Cap(Eff|Bnd)" /proc/self/status'
# 期望：0
#       CapBnd: 0000000000000004
#       CapEff: 0000000000000004
```
若 `CapEff` 不是 `…04`（只有 DAC_READ_SEARCH），说明 compose 版本不对或被本地覆盖，先停下来排查。

## 备份什么

`backup` 容器（`postgres:17-alpine`）每日 `BACKUP_TIME`（容器 `TZ`，默认 UTC 03:30）跑一次：
- `pg_dump -Fc` 整个 `nexttime` 库 → `${NEXTTIME_DATA}/backups/db/nexttime-<UTC时间戳>.dump`
- `tar -czf` 打包 `workspaces/ config/ gatekeepers/ caddy/ llm-proxy/ models/`（**不含**
  `secrets/`，`caddy/` 下的内部 CA 私钥本身就是要备份的内容；`gatekeepers/*/store.key`——某个
  `connected_account` 模式门的加密凭证存储密钥——按文件名排除，其余 `gatekeepers/` 内容照常打包）→
  `${NEXTTIME_DATA}/backups/files/files-<ts>.tgz`。容器挂载已收窄为按目录只读（`workspaces/
  config/ gatekeepers/ caddy/ llm-proxy/ models/`）+ `backups/` 读写，不再是整个 `${NEXTTIME_DATA}`
  读写。

**归档现在含真实密钥（S8 leftover 58）。** `llm-proxy/` 里的 `keys.json`（S7-A 控制台写入的供应商
API key）与 `providers.json` 一并进了 `files-<ts>.tgz`；`tar` 默认保留每个源文件的权限位，
`keys.json` 的 `0600` 原样进档、原样出档（不需要额外参数）。**这意味着每一份 `files-<ts>.tgz`
现在和 `secrets/` 一样敏感**：只给能读 `secrets/` 的运维人员访问 `backups/` 目录与其中的
`files-*.tgz`；异地转存 / 拷贝这些归档时按密钥材料对待（加密传输、加密静态存储，绝不进公开或共享
存储）；轮换某个供应商的 key 后，旧的 `files-*.tgz` 里仍留着已轮换前的旧 key，按
`BACKUP_RETENTION` 自然过期，不做特殊清除。`models/` 只含 `models.json`（可用 `make gen-models`
重建，非敏感，一并备份只是图省事）。

每类各保留最新 `BACKUP_RETENTION`（默认 7）份，旧的自动删除；成功后写
`${NEXTTIME_DATA}/backups/last-success`（时间戳 + 两个产物大小）。失败不中断循环，下次
`BACKUP_TIME` 再试；日志走 stdout（`docker compose logs backup`）。

`backups/db/` 与 `backups/files/` 归 backup 服务所有：发版 / 演练前的手工 `pg_dump` 放到别的目录
（`backups/pre-upgrade/`，不参与 backup 服务的轮换；发版应用通过后只保留最新 3 份，维护者 2026-10-01，
见 `release.md` §3"备份三件事"）。2026-09-25 前轮换按文件名匹配
`nexttime-*.dump`，手工放进去的 `nexttime-pre-<tag>.dump` 按名字排在所有时间戳之后、被当成"最新"，
每天新生成的 dump 反而立刻被删；现在轮换与 `drill-*.sh` 找"最新 dump"都只认 `nexttime-<时间戳>.dump`。

库内的保留只有一处会删行：`observations` 的压缩（遗留 103，`compact-observations`）。它在每次发版应用的
`BACKUP_NOW` 成功之后跑（`release.md` §3"观察记录压缩"），删的是早于 30 天、不被任何 Fact 引用、
不是 Source 最新、不是所在 (activity, source) 最后一行、也不带 payload 的采集标记行；要找回某一行，就从压缩前
那份 `BACKUP_NOW` dump（`backups/db/` 里 `apply-<tag>` 当天的那份）恢复到临时库里查。每天的 dump 因此不再随
采集无限增长。

## 手动跑一次
```
docker compose run --rm -e BACKUP_NOW=1 backup
ls ${NEXTTIME_DATA}/backups/db ${NEXTTIME_DATA}/backups/files
cat ${NEXTTIME_DATA}/backups/last-success
```

## 备份还在跑吗（`scripts/check-backup-freshness.sh`）

每晚失败只记在 `docker compose logs backup` 里，没人看就一直没人知道（收尾波次 C10）。在检出目录跑：
```
sh scripts/check-backup-freshness.sh                    # 默认上限 26 小时
sh scripts/check-backup-freshness.sh --max-age-hours 50 # 例如刚改过 BACKUP_TIME
```
三行 `PASS backup-service / last-success / dump-present` 加 `BACKUP-FRESHNESS OK`；任一 `FAIL` 非零退出。
只读。发版应用时它是第一步（`release.md` §3"备份三件事"）。

## 备份状态（控制台，2026-10-02 复审 D-28）

平台 运行状态 页的「备份」卡片（`platform_status.backup`）读的就是上面那个 `last-success`：
`docker-compose.yml` 把**这一个文件**只读挂进内核（`/data/backups/last-success`），`backups/` 目录本身、
dump 与含密钥的 `files-*.tgz` 都不进内核（`scripts/validate-compose.mjs` 守着这一条）。`正常` / `已过期`
用的是和 `check-backup-freshness.sh` 同一个 26 小时上限；读不到标记时是 `未知`，原因在「技术细节」里。
卡片只看新鲜度——"backup 服务在跑"和"dump 还在盘上"仍然只有主机上的脚本能查。

**主机上这个文件要求的属主与权限（逐条，别的都不用动）：**

| 路径 | 类型 | 属主 | 权限 | 谁保证 |
|---|---|---|---|---|
| `${NEXTTIME_DATA}/backups/` | 目录 | `0:0`（root） | `750`（**不变**） | `host-env-init.sh`（原有） |
| `${NEXTTIME_DATA}/backups/last-success` | **普通文件**（不能是目录、不能是符号链接） | `0:0`（root） | `644` | `host-env-init.sh` 与 `apply-release.sh` 在不存在时建一个空的；`backup.sh` 每次成功后原地重写并 `chmod 644` |

为什么是这样：内核以 uid 10001 运行；绑定挂载单个文件时，容器里只检查**这个文件本身**的权限位，
宿主机上 `backups/`（root 750）不会被穿越，所以只需要文件对其他人可读（`644`），`backups/` 不用放宽。
文件绑定挂载跟着 inode 走：`backup.sh` 用截断原地重写（不是写临时文件再改名），内核总能看到最新内容；
**不要手工 `mv` / 替换这个文件**——替换后内核在重建前一直看到旧 inode。

检查（主机上，只读）：
```
stat -c '%F %u:%g %a' ${NEXTTIME_DATA}/backups/last-success   # 期望：regular file 0:0 644（空文件显示 regular empty file）
docker compose exec -T kernel cat /data/backups/last-success   # 内核里看到的应与主机上 cat 一致
```

修复：
- 卡片显示 `not readable`：`chmod 644 ${NEXTTIME_DATA}/backups/last-success`（下次备份成功时 `backup.sh` 也会再设一次）。
- 卡片显示 `is a directory`（文件不存在时内核先起来了，Docker 在那个路径建了一个空目录；之后 `backup.sh`
  再也写不了标记，`check-backup-freshness.sh` 会 FAIL）：
  ```
  docker compose stop kernel
  rmdir ${NEXTTIME_DATA}/backups/last-success
  sudo env NEXTTIME_DATA=${NEXTTIME_DATA} sh scripts/host-env-init.sh   # 或手工：: > 该文件; chmod 644 该文件
  docker compose up -d kernel
  docker compose run --rm -e BACKUP_NOW=1 backup                         # 立刻写一次真实标记
  ```
- 卡片显示 `no backup marker` 但主机上文件在：内核容器是 D-28 之前建的、还没有这个挂载——`docker compose up -d kernel`。

## 恢复演练（`scripts/restore.sh`，在宿主机上跑，不在容器内）
先 `--dry-run`：只校验 dump 与 tgz，不建库、不解压。
```
cd <代码检出目录>
sh scripts/restore.sh --dry-run --db ${NEXTTIME_DATA}/backups/db/nexttime-<ts>.dump \
  --files ${NEXTTIME_DATA}/backups/files/files-<ts>.tgz
```
真实恢复（默认新建 `nexttime_restore_<ts>` 库，绝不碰活库）：
```
sh scripts/restore.sh --db ${NEXTTIME_DATA}/backups/db/nexttime-<ts>.dump
docker compose exec -T postgres psql -U nexttime -d nexttime_restore_<ts> -c '\dt'
docker compose exec -T postgres psql -U nexttime -d postgres -c 'DROP DATABASE "nexttime_restore_<ts>";'
```
要恢复到活库 `nexttime`（危险，仅故障恢复时用）：加 `--target-db nexttime --i-know`。这条路径的步骤：

1. `restore.sh` 先 `docker compose stop kernel agent-host worker-supervisor backup`（它们持有到
   `nexttime` 的连接，或写入即将被替换的数据），等 `nexttime` 上的连接清零。
2. 把现库**改名**为 `nexttime_pre_restore_<ts>` 留作回退，不删任何东西。
3. 新建空的 `nexttime`，用 `pg_restore --exit-on-error --single-transaction` 整体恢复：要么全部成功，要么全部回滚。
4. 核对 public 下的表数是否等于 dump 自己 TOC 里列出的表数。

任何一步失败都会自动把半成品删掉、把 `nexttime_pre_restore_<ts>` 改回 `nexttime`。如果连改名回退也失败了，脚本会打印手工收尾的两条命令。

脚本退出时（无论成功、失败还是被 Ctrl-C / ssh 断开打断）都会通过 trap 自动 `docker compose start` 把四个服务拉回来；`postgres` 本身不停，恢复过程中始终可达。成功后旧库仍以 `nexttime_pre_restore_<ts>` 保留，核对恢复后的栈正常再按 summary 里的命令删掉，它会占用一份库的磁盘空间。

2026-10-02 复审 R-11 之前，这条路径用的是 `pg_restore --clean --if-exists` 直接盖在活库上。这样做有两个问题：

- 新版本建的对象会留下来挡住 DROP，跨版本回滚会得到新旧混杂的库；
- `pg_restore` 的失败只会让它退出 1，而脚本把退出 1 当成警告，照样报告成功。

只有临时库路径（`drill-restore.sh`）能在主机上实测；活库路径除改名一步外与它完全相同。`--files` 恢复到暂存目录 `${NEXTTIME_DATA}/restore/<ts>/`，从不覆盖 `workspaces/
config/ gatekeepers/ caddy/ llm-proxy/ models/` 任何一个活目录——把 `llm-proxy/keys.json` 之类
的供应商 key 挪回 `${NEXTTIME_DATA}/llm-proxy/` 前先核对是不是真要覆盖当前值，覆盖前建议先把
当前 `keys.json` 另存一份；暂存目录本身继承了归档里 `keys.json` 的 `0600`，但目录本身按当前
umask 创建，操作完成后记得清理 `${NEXTTIME_DATA}/restore/<ts>/`（同一份密钥材料，不要留在暂存区）。

## 验证（自动化演练：`scripts/drill-restore.sh`）

S3.10 交付物——把上面"恢复演练"一节的手动步骤（找到最新 dump → `scripts/restore.sh --db ...` →
`\dt` 数数 → `DROP DATABASE`）自动化成一个 PASS/FAIL 分明、可重复跑的脚本，对应
`docs/development-tasks.md` § S3.10 的验收句"按「从备份恢复」手册在临时环境走一遍成功"：

```bash
cd <CODE_DIR>
sh scripts/drill-restore.sh
```

没有指定 `--db` 时，自动找 `${NEXTTIME_DATA}/backups/db/` 下最新的 dump；一份都没有（全新主机、
还没跑过备份）会自动先跑一次 `docker compose run --rm -e BACKUP_NOW=1 backup` 补一份出来，不需要
操作员先手动执行"手动跑一次"那一节。跑的仍是**真实**的 `scripts/restore.sh`（未改动、原样调用），
恢复目标固定是它自己默认的一次性 `nexttime_restore_<ts>` 库（脚本从不传 `--target-db`，因此永远
不会碰到活库 `nexttime`），断言恢复出的库里 `select count(*) from information_schema.tables where
table_schema='public'` 大于 0（证明 dump 不是空的/损坏的，而不只是命令退出码为 0），随后
`DROP DATABASE` 清理并复查确认已删除。

期望输出（末尾）：
```
PASS preflight-services postgres running
PASS resolve-dump using newest existing dump: ...
PASS restore restored into nexttime_restore_<ts> from ...
PASS restore-table-count nexttime_restore_<ts> has <N> table(s) in schema public
PASS drop-temp-db nexttime_restore_<ts> dropped
DRILL-RESTORE OK
```
任何一步失败都打印 `FAIL <step> <detail>` 到 stderr 并以非零退出——不会把半失败状态误报成成功；
失败时顺手删掉本次建的 `nexttime_restore_<ts>`（只认这个名字形状，不会碰活库）。

**2026-10-01 演练发现（收尾波次 C10）**：`restore.sh` 自 #188（2026-09-17，postgres 改 `read_only`）
起一直失败——它用 `docker compose cp` 把 dump 拷进容器，而 Docker 拒绝向只读根文件系统的容器 `cp`
（`container rootfs is marked read-only`），哪怕目标 `/tmp` 是可写 tmpfs。上一次演练是 09-02，所以没人
发现；`drill-upgrade.sh` 的回滚也走这条路。已改为经 `exec -T` 流式写进容器 `/tmp`（tmpfs，占一份 dump
大小的内存直到恢复结束）。备份文件本身一直是好的。改完在主机上用当日 dump 实测：恢复出的库 public
39 张表与活库一致，关键表行数差异恰好等于 dump 之后清掉的 11 个验收工作区。

指定某一份具体 dump（例如复现某次故障时的状态）：`sh scripts/drill-restore.sh --db
${NEXTTIME_DATA}/backups/db/nexttime-<ts>.dump`；想跑完之后手动检查恢复出的库再自己清理，加
`--keep`（脚本会打印手动 `\dt`/`DROP DATABASE` 的命令）。

## LVM 提醒

`${NEXTTIME_DATA}/backups/` 落在根 LV（未挂独立卷），空间与 `pgdata/` 共享；`BACKUP_RETENTION`
保持较小（默认 7），必要时先清理旧备份再扩容，避免把根分区写满。
