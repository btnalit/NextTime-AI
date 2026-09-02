# Runbook：backup-restore（每日备份与恢复演练）

对应任务：development-tasks.md § S1.12。设计 §10.2 / §10.4 / §13。

## 备份什么

`backup` 容器（`postgres:17-alpine`）每日 `BACKUP_TIME`（容器 `TZ`，默认 UTC 03:30）跑一次：
- `pg_dump -Fc` 整个 `nexttime` 库 → `${NEXTTIME_DATA}/backups/db/nexttime-<UTC时间戳>.dump`
- `tar -czf` 打包 `sessions/ workspaces/ config/`（**不含** `secrets/`）→
  `${NEXTTIME_DATA}/backups/files/files-<ts>.tgz`

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
要恢复到活库 `nexttime`（危险，仅故障恢复时用）：加 `--target-db nexttime --i-know`。`--files`
恢复到暂存目录 `${NEXTTIME_DATA}/restore/<ts>/`，从不覆盖 `sessions/ workspaces/`。

## LVM 提醒

`${NEXTTIME_DATA}/backups/` 落在根 LV（未挂独立卷），空间与 `pgdata/` 共享；`BACKUP_RETENTION`
保持较小（默认 7），必要时先清理旧备份再扩容，避免把根分区写满。
