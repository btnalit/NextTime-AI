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
| `collectors/`（含 `host-inventory/` 子目录，S3.3） | `collector-host-inventory`（`register_source` 幂等缓存——`host-inventory-source.json`，见 `collectors/host-inventory/README.md`） |
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
期望：`secrets` 为 `700`；十三个目录路径齐全（九个一级子目录 `pgdata workspaces secrets
config artifacts backups caddy gatekeepers collectors` + 四个二级子目录 `workspaces/tasks
gatekeepers/docker gatekeepers/ragflow collectors/host-inventory`，S3.3 新增 `collectors`/
`collectors/host-inventory` 两条），另有 `config/.keep`（占位文件，非目录）一并列出；
`secrets/pg_password` 为 `600` 且非空；其余目录为 `750`。

## 首次登录：平台初始化令牌（S4.1，design §7.11）

装好的主机上没有默认账户。kernel 启动时若**没有任何活跃的平台管理员**，会生成一枚一次性初始化令牌：
哈希入库（`platform_setup` 表，24 小时过期，5 次错误作废），明文写到
`${NEXTTIME_DATA}/secrets/setup/token`（0600，kernel 容器内唯一可写挂载 `/run/setup`，由
`host-env-init.sh` 建目录并归 uid 10001）；kernel 日志只提示路径，不含令牌值。

```sh
sudo cat "${NEXTTIME_DATA}/secrets/setup/token"
```

浏览器打开控制台（`https://<BIND_ADDR>:8443/`），未初始化时会先显示"初始化平台"页：填入令牌、管理员
登录名、显示名、密码 → 创建第一个 `platform_role='admin'` 用户并直接登录，令牌随即作废（`used_at`），
文件在下次启动时删除。之后这页永不再出现。平台管理员没有业务数据权限（§7.11）：要进某个工作区，
得在那里有成员资格（S4.2 之前由 owner 在成员页添加，或用下面的 CLI）。

CLI 兜底（都在 kernel 容器里跑，密码从 stdin 读，不进 argv 与日志）：

```sh
# 跳过令牌直接建管理员（例如令牌文件丢了又不想重启）
printf '%s\n' '<password>' | docker compose run --rm --no-deps -T kernel \
  node dist/cli/bootstrap.js create-platform-admin --login <login> [--display-name <name>] [--temporary]
# 给已有用户设密码：迁移 0019 为每个既有 human Principal 回填了一个无密码用户，登录名为
# `<显示名 slug>-<principal id 前 8 位>`（create-workspace / add-principal 现在会把它打印出来）
printf '%s\n' '<password>' | docker compose run --rm --no-deps -T kernel \
  node dist/cli/bootstrap.js set-password --login <login> [--temporary]
```

`--temporary` 表示临时密码：该用户首次登录必须先改密，改完之前所有工作区能力返回 403
`password_change_required`。API key（`add-principal`、治理页新建成员）照旧可用，是给自动化与
过渡期的；三份验收脚本都走 API key。

在已有主机上升级到含 S4.1 的版本：**先重跑本脚本**（`host-env-init.sh` 幂等，会补建 `secrets/setup`
并归 uid 10001）再 `docker compose up`——否则 Docker 代建的挂载目录是 root 所有，kernel 写不出令牌，
只会在日志里记一条 error（kernel 本身照常启动）；然后 `make migrate` 落地 0019，重建 kernel 与 caddy。

## 删除 Workspace（Deleting a workspace，操作员专用，破坏性操作）

`packages/kernel/src/cli/bootstrap.ts` 的 `delete-workspace`/`list-workspaces` 子命令是清理
验收/冒烟测试遗留 Workspace（`accept-s2-<epoch>`、`s27-smoke-<epoch>` 这类）的唯一入口——**只存在
于 CLI，从不注册为 Agent 可调用的 capability**（`packages/shared/src/capabilities.ts` 里没有这个
操作），所以没有任何 Worker 或入口 agent 能触达它，无论授予了什么权限。

### 会删除什么
在**一个事务**内，按外键依赖关系在运行时拓扑排序（子表先于父表，而不是本文件里手工维护的表
清单），删除该 Workspace 在每一张带 `workspace_id` 列的表中的所有行，最后删除 `workspaces` 行本
身——`principals`、`sessions`、`capability_handles`、`chats`/`chat_messages`、`tasks`/
`worker_runs`、`audit_records`、`ontology_versions`/`worker_definitions`/`skills`/`procedures`、
`objects`/`links`/`evidence`/`conflicts`/`decisions` 等这个工作区的全部数据都在内。`links`
（I4）与 `audit_records`（I11）本身是只追加表，各自的 `before delete` 触发器会在这一次删除内被
临时禁用、事务提交前重新启用——这是整个代码库里唯一一处刻意绕过这两条不变式的地方，且只对这一
条 `delete from` 语句生效，绝不会残留到这次调用之外。

宿主侧的清理是 `scripts/delete-workspace.sh` 的职责，不在 kernel 源码内——kernel 是机制层，不
认识具体系统名（`scripts/check-kernel-purity.sh` 会拦下任何写进 `packages/kernel/src` 的具体系
统名）：
- 该 Workspace 每个 Principal 对应的常驻入口容器（已停止的也会被 `docker rm -f`，不存在则忽略）。
- 每个 Principal 的数据目录 `${NEXTTIME_DATA}/workspaces/<principalId>`。
- 每个 Task 的数据目录 `${NEXTTIME_DATA}/workspaces/tasks/<taskId>`。

### 不会删除什么
- **备份**（docs/runbooks/backup-restore.md）：已经产生的 `pg_dump`/`tar.gz` 归档不受影响，历
  史备份里仍然完整保留这个 Workspace 曾经存在过的快照——需要找回时只能整体还原一份备份，不能从
  备份里单独抽出一个 Workspace。
- 一条 AuditRecord：`audit_records` 表本身正在被删除，没有地方可以再写一行审计记录。取而代之，
  `delete-workspace` 会向 **stderr** 打印一行结构化 JSON（`{"event":"workspace_deleted", ...}`），
  把它当作这次操作的审计记录来保存/转发到日志系统。

### 两个脚本
```sh
# 列出所有 Workspace（id / name / created_at / principals / tasks），用于挑选删除目标
docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js list-workspaces

# 删除单个 Workspace（--name 可选，用来防止粘贴错 id；宿主侧容器与数据目录一并清理）
sh scripts/delete-workspace.sh <workspaceId> [--name <expected name>]

# 按正则批量删除：不带 --yes 只列出匹配项（安全的 dry run），加上 --yes 才真正逐个删除
sh scripts/delete-workspaces-matching.sh '<regex>' [--yes]
```

### 警告
`delete-workspaces-matching.sh` 的正则是无锚定的子串匹配（除非自己在两端写 `^`/`$`）——批量清
理验收/冒烟 Workspace（例如 `^(accept-s[12]|s2[0-9]-smoke|s1-5b-accept|deepseek-smoke|
s25-gates|s213-ws)`）之前，务必确认这条正则**绝不会**匹配到 web console 自己长期使用的那个
Workspace（例如名字里带 `web-smoke-` 的那个——先用不带 `--yes` 的 dry run 看一遍匹配列表，确认
里面没有它）。误删 web console 自己的 Workspace 会让它已签发的全部 API key 立即失效且不可恢复。
