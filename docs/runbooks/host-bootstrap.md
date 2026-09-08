# Runbook：host-bootstrap（数据目录与密钥目录初始化）

## 用途
在目标主机上创建 `${NEXTTIME_DATA}` 下的数据目录树与 `secrets/` 密钥目录，并生成 Postgres
密码文件。不写 `.env`（任务 E3），不生成 Handle 签名密钥对（任务 S1.9）。

## 远程执行
```
ssh <TARGET_HOST> 'NEXTTIME_DATA=/path/to/data sh -s' < scripts/host-bootstrap.sh
```
`NEXTTIME_DATA` 必须显式给出且不能是 `/`；未设置或取值为 `/` 时脚本拒绝运行。

## 幂等性
可重复执行：已存在的目录与 `secrets/pg_password` 不会被覆盖或重新生成，权限位每次都会
被重新设置为期望值，第二次执行应无实质性变更。

## 目录 → 挂载服务（对应 design §10.2 的 docker-compose 骨架）
| 目录 | 挂载到 |
|------|--------|
| `pgdata/` | `postgres`（数据卷） |
| `workspaces/` | `worker-supervisor`（读写；子目录挂载规则见下）、`backup`（只读，`workspaces/` 只读子挂载） |
| `secrets/` | `postgres`（Docker secret `pg_password`） |
| `config/` | `kernel`、`worker-supervisor`（均只读）、`llm-proxy`（只读）、`egress-proxy`（只读）、`backup`（只读子挂载） |
| `caddy/` | `caddy`（TLS 状态数据）、`backup`（只读子挂载，CA 私钥备份） |
| `gatekeepers/`（含 `docker/`、`ragflow/` 两个子目录） | `gatekeeper-docker`、`gatekeeper-ragflow`（各自的幂等存储；只读子挂载给 `backup`） |
| `backups/` | `backup` 容器（唯一可写挂载——`backup.sh` 的 `pg_dump`/tar.gz 输出落地处） |
| `artifacts/` | 预留：当前 compose 骨架未显式挂载任何服务 |

## I15：workspaces 挂载规则
- `workspaces/<uid>/` 只挂载给该用户的常驻入口容器，不挂给其他用户的容器，也不挂给任何 Worker 容器。
- `workspaces/tasks/<task_id>/` 只挂载给该 Task 对应的 Worker 容器。
- 两类目录在主机上同时创建，但挂载边界由 `worker-supervisor` 强制，运行时互不可见。

## 验证
```
stat -c '%a %n' ${NEXTTIME_DATA}/secrets
find ${NEXTTIME_DATA} -maxdepth 2 -printf '%M %u %p\n'
```
期望：`secrets` 为 `700`；十一个目录路径齐全（八个一级子目录 `pgdata workspaces secrets
config artifacts backups caddy gatekeepers` + 三个二级子目录 `workspaces/tasks
gatekeepers/docker gatekeepers/ragflow`），另有 `config/.keep`（占位文件，非目录）一并列出；
`secrets/pg_password` 为 `600` 且非空；其余目录为 `750`。
