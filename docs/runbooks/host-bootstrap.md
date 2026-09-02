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
| `sessions/` | `kernel`（只读）、`worker-supervisor`（读写） |
| `workspaces/` | `worker-supervisor`（读写；子目录挂载规则见下） |
| `secrets/` | `postgres`（Docker secret `pg_password`）、`backup` |
| `config/` | `kernel`、`worker-supervisor`（均只读）、`llm-proxy`（只读） |
| `caddy/` | `caddy`（TLS 状态数据） |
| `backups/` | `backup` 容器（整个 `${NEXTTIME_DATA}` 挂为 `/data`） |
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
期望：`secrets` 为 `700`；九个路径（八个一级子目录 + `workspaces/tasks`）齐全；
`secrets/pg_password` 为 `600` 且非空；其余目录为 `750`。
