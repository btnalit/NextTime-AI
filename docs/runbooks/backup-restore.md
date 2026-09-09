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
gatekeepers/ caddy/`（只读）与 `backups/`（读写）——它写不到任何原本写不到的地方，也碰不到
Docker socket 或其他服务。

**为什么需要 `DAC_READ_SEARCH`（而不是 chmod/chown）。** `caddy` 以 root 跑，`caddyserver/certmagic`
的 `FileStorage` 把每次证书/密钥写入都硬编码成 `0600`/`0700`、root 属主、原子 rename 替换 inode
（读过 `filestorage.go` / `internal/atomicfile/file.go` 确认）。`on_demand` TLS 每来一个新 SNI 就
可能重新写文件，任何事先做的 `chmod -R o+rX` / `chown -R :10001 + setgid` 都不会延续到新文件上
（certmagic 自己的 `chmod(0600)` 还会清掉组位）。`scripts/host-env-init.sh` 对 `caddy/` 做的
`chmod -R o+rX` 只是对现有文件的一次性基线，不是正确性的来源；能让 `tar` 在任何时刻可靠遍历
`caddy/` 的是这个 capability。

**主机前置条件**：`${NEXTTIME_DATA}/backups` 必须是 **root 属主（0:0，750）**——没有 `DAC_OVERRIDE`
的 root 只能写自己拥有的目录；fix/socket-proxy-and-backup-user 那版 `host-env-init.sh` 把它 chown 成了
10001，导致每次备份以一条空的 `pg_dump failed:` 失败（主机实测），当前版本的 `sh scripts/host-env-init.sh`
（幂等）会把它强制改回 0:0 并打印确认。它对 `caddy/` 的 `chmod -R o+rX` 是无害基线，可保留。

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
- `tar -czf` 打包 `workspaces/ config/ gatekeepers/ caddy/`（**不含** `secrets/`，`caddy/` 下的
  内部 CA 私钥本身就是要备份的内容；`gatekeepers/*/store.key`——某个 `connected_account` 模式
  门的加密凭证存储密钥——按文件名排除，其余 `gatekeepers/` 内容照常打包）→
  `${NEXTTIME_DATA}/backups/files/files-<ts>.tgz`。容器挂载已收窄为按目录只读（`workspaces/
  config/ gatekeepers/ caddy/`）+ `backups/` 读写，不再是整个 `${NEXTTIME_DATA}` 读写。

每类各保留最新 `BACKUP_RETENTION`（默认 7）份，旧的自动删除；成功后写
`${NEXTTIME_DATA}/backups/last-success`（时间戳 + 两个产物大小）。失败不中断循环，下次
`BACKUP_TIME` 再试；日志走 stdout（`docker compose logs backup`）。

## 手动跑一次
```
docker compose run --rm -e BACKUP_NOW=1 backup
ls ${NEXTTIME_DATA}/backups/db ${NEXTTIME_DATA}/backups/files
cat ${NEXTTIME_DATA}/backups/last-success
```

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
要恢复到活库 `nexttime`（危险，仅故障恢复时用）：加 `--target-db nexttime --i-know`。这条路径下
`restore.sh` 会先 `docker compose stop kernel agent-host worker-supervisor backup`（它们持有到
`nexttime` 的连接，或写入即将被 `pg_restore --clean` 清空重建的同一份数据），脚本退出时（无论
成功还是失败）通过 trap 自动 `docker compose start` 把四者拉回来——`postgres` 本身不停，恢复过程
中始终可达。`--files` 恢复到暂存目录 `${NEXTTIME_DATA}/restore/<ts>/`，从不覆盖 `workspaces/
config/`。

## LVM 提醒

`${NEXTTIME_DATA}/backups/` 落在根 LV（未挂独立卷），空间与 `pgdata/` 共享；`BACKUP_RETENTION`
保持较小（默认 7），必要时先清理旧备份再扩容，避免把根分区写满。
