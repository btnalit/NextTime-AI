# Runbook：backup-restore（每日备份与恢复演练）

对应任务：development-tasks.md § S1.12。设计 §10.2 / §10.4 / §13。fix/socket-proxy-and-backup-user
把 `backup` 容器从 root 切到非 root（`user: "10001:10001"`）并加了 `cap_drop: [ALL]` —— 本节顶部
先说主机前置条件（部署/升级到这个版本前必须做，否则 backup 会在第一次写 `backups/` 时
`Permission denied`），下面"备份什么"等章节内容不变。

## 主机前置条件（fix/socket-proxy-and-backup-user：切到非 root uid 10001）

`backup` 现在以平台统一的非 root uid:gid `10001:10001` 运行（同 `nexttime` 用户，见
`packages/*/Dockerfile`），并 `cap_drop: [ALL]`。按顺序执行：

1. **`${NEXTTIME_DATA}/backups` 属主须是 10001:10001**（这是 backup 唯一要写的目录）：
   ```
   sh scripts/host-env-init.sh   # 幂等；这个版本已把 backups/ 加进它的 chown 循环
   # 或手动：
   chown -R 10001:10001 ${NEXTTIME_DATA}/backups
   ```
2. **只读来源 `workspaces/ config/ gatekeepers/` 已经可读**——`host-env-init.sh` 早就把
   `workspaces/`、`gatekeepers/{docker,ragflow}/` chown 给 10001:10001（它们本来就由跑在 uid
   10001 的服务写入），`config/` 做成 world-readable（755/644）——这三个目录不需要为这次改动
   单独处理，backup 用同一个 uid 读它们，权限一直是对的。
3. **`caddy/` 是特例，需要单独理解**：`caddy` 容器以镜像默认的 root 用户跑（`docker-
   compose.yml` 该服务自己的注释），它的按需签发证书（Caddy 内部 CA，`caddyserver/certmagic`
   的 `FileStorage`）把每次写入都硬编码成 `0600`（文件）/`0700`（目录）、root 属主、原子
   rename 替换整个 inode——读过 certmagic 的 `filestorage.go` / `internal/atomicfile/file.go`
   源码确认，不是推测。这意味着：
   - **`chmod -R o+rX` 或 `chown -R :10001 + g+rX` 都不能"扛住"下一次证书签发**——`on_demand`
     TLS 只要来一个新 SNI 就可能触发一次写入，新文件/目录会带着全新的 `0600`/`0700`
     重新出现，之前对旧文件做的任何 chmod/chown 都不会延续到新文件上；`chown` + setgid 甚至
     更容易踩坑：新文件的组会正确继承成 `10001`（setgid 生效），但 certmagic 自己的
     `chmod(0600)` 会把组权限位清零——组对了，位是 `---`，一样读不到。两个选项本质上都
     "扛不住"，选哪个不影响结果。
   - `scripts/host-env-init.sh`（这个版本）对 `caddy/` 只做 `chmod -R o+rX`（不 chown）——
     作为对*现有*文件的一次性基线，成本低、语义简单（不依赖 setgid 与 certmagic 自己
     chmod 之间的竞争关系），但**不是**长期正确性的来源。
   - **真正让备份长期可靠的是 `backup` 服务自己的 `cap_add: [DAC_READ_SEARCH]`**（`docker-
     compose.yml`）——这个 capability 专门用来绕过读权限 / 目录搜索权限检查（Docker 官方文档
     把它列为备份类工具的典型用法），且不像 `DAC_OVERRIDE` 那样连写权限检查也绕过，是能达到
     目的的最小授权。有了它，`tar` 能可靠遍历/读取 `caddy/` 下任何时刻新写入的 `0600`/`0700`
     文件，不依赖"最近有没有人重新 chmod 过"这种时序假设。
   - 不需要额外操作——`cap_add` 已经在 `docker-compose.yml` 里；这里只是解释"为什么"，避免
     以后有人觉得"caddy/ 权限看起来不对"就去动 chmod/chown 当作根因修复。
4. `docker compose up -d docker-socket-proxy`（如果还没起——见 item A 的操作步骤；`backup` 本身
   不用它，这一步只是若同批上线两项改动时的建议顺序）。
5. `docker compose up -d backup`（或整批 `docker compose up -d`）。

**验证："以 10001 身份跑"检查**（先于/独立于下面"手动跑一次"的真实备份）：
```
docker compose run --rm --entrypoint id backup -u
# 期望输出：10001
```
注意不是 `docker compose run --rm -e BACKUP_NOW=1 backup id -u`——这个服务的 `entrypoint:` 已经
固定成 `["/bin/sh", "/backup.sh"]`（`docker-compose.yml`），`docker compose run` 追加的
`id -u` 会变成 `backup.sh` 自己的位置参数（`sh /backup.sh id -u`），而 `backup.sh` 从不读
`$1`/`$2`，实际效果只是照常跑一次备份、`id -u` 被静默忽略，看不到期望的 `10001` 输出——必须用
`--entrypoint id` 显式换掉 entrypoint，才能真的执行 `id -u`。若输出不是 `10001`，说明 `user:`
没生效或镜像/compose 版本不对，先停下来排查，不要继续跑真实备份。

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
