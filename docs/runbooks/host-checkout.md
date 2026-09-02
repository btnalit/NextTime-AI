# Runbook：host-checkout（代码检出、`.env`、密钥占位、启动 Postgres）

对应任务：development-tasks.md § E3、E4。占位符取值见 `docs/private/`（不入库）。

## E3.1 代码检出
```
ssh <TARGET_HOST> 'CODE_DIR=<CODE_DIR> BRANCH=main sh -s' < scripts/host-checkout.sh
```
`CODE_DIR` 必须显式给出；`REPO_URL` 默认本仓库地址，`BRANCH` 默认 `main`。已有检出会
`fetch` + 重置到 `origin/$BRANCH`（丢弃本地改动），否则 `clone`。脚本打印最终 commit。

## E3.2 生成 `.env`
在 `<CODE_DIR>` 下从 `.env.example` 生成 `.env`（不入库），填入真实值：`NEXTTIME_DATA /
KERNEL_BIND_ADDR / KERNEL_PUBLIC_URL / NEXTTIME_SUBNET_* / WORKER_RUNTIME`（取值见
`docs/private/`）。确认已被忽略：`git check-ignore .env` 应有输出。

## E3.3 密钥与配置占位
```
ssh <TARGET_HOST> 'NEXTTIME_DATA=<NEXTTIME_DATA> sh -s' < scripts/host-env-init.sh
```
幂等，依赖 E2（`secrets/pg_password` 存在）。创建 `secrets/kernel.env`（`DATABASE_URL` 取自
`pg_password`，特殊字符 URL-encode）、`secrets/{llm-proxy,gatekeeper-ragflow}.env`（无值模
板）、`config/{llm-providers.yaml,models.json,handle.pub}`（占位）；把 `sessions workspaces
artifacts caddy` 属主改成容器非 root 用户（uid:gid 见脚本注释），`config/` 设为可读；
`pgdata/`、`secrets/` 目录本身、`backups/` 不动。用 `stat` / `ls -ln` 验证，**不要 `cat` 密钥**。

紧接着跑 `ssh <TARGET_HOST> 'NEXTTIME_DATA=<NEXTTIME_DATA> sh -s' < scripts/gen-handle-keys.sh` 生成 Handle 签名密钥对（S1.9，幂等）。

## E3.4 校验 compose
`cd <CODE_DIR> && docker compose config >/dev/null && echo ok`；失败则回仓库改脚本或 compose
期望，推回后重新 E3.1 再重试。

## E4 启动 Postgres
```
cd <CODE_DIR>
docker compose up -d postgres
docker compose ps --format json          # 等 health = healthy，≤ 90s
docker compose exec -T postgres psql -U nexttime -d nexttime -c \
  "create extension if not exists vector; select extversion from pg_extension where extname='vector';"
ss -tlnp | grep ':5432'                  # 期望无输出：不对主机发布端口
docker network inspect <compose项目>_control   # 确认在 control 网络、子网符合 .env
```
不启动除 `postgres` 外的任何服务。

## 回滚
`docker compose down`（不加 `-v`，保留 `pgdata`）；`.env`/`secrets/*` 有问题手工修正后重跑
E3.3；代码检出问题重跑 E3.1（幂等）。
