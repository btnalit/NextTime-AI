# Runbook：host-caddy（TLS 与静态服务上线）

对应任务：development-tasks.md § E8。占位符取值见 `docs/private/`（不入库）。前置：E2–E4
（数据目录、`.env`、Postgres 已起）、kernel 镜像已 build。

## 目的

`caddy` 是平台唯一的公网面（设计文档 §11）：在 `:8443` 用 Caddy 内置的内网 CA 签发 TLS 证书
（`tls internal`，S1 阶段自签可接受），`/` 与 `/explorer/*` 服务静态构建，`/api` `/ws` `/mcp`
`/llm` 反代到 `kernel:8080`。`kernel` 容器本身不对主机发布任何端口。

## E8.1 上线（在 `<CODE_DIR>` 下执行，已 `ssh <TARGET_HOST>` 登录或经脚本管道）

```bash
cd <CODE_DIR>
docker compose config >/dev/null && echo "config ok"
docker compose build caddy        # 构建 web 静态产物并打进 caddy 镜像（§E8.5）
docker compose up -d kernel caddy
docker compose ps --format json
```

`caddy` 的 compose 定义 `depends_on: [kernel]`，但只保证启动顺序，不等待 kernel 的健康检查
（kernel 服务当前没有 healthcheck）；若 kernel 还没起稳就先探测 `caddy`，`/api/*` 反代可能短暂
502，重试即可。

## E8.2 信任内网 CA（客户端）

Caddy 首次为 `:8443` 签证书时会在 `${NEXTTIME_DATA}/caddy` 下生成自己的内网 CA（`tls
internal` 的行为，非 Let's Encrypt）。取出根证书并导入客户端：

```bash
cd <CODE_DIR>
docker compose exec caddy cat /data/caddy/pki/authorities/local/root.crt
```

把输出保存为 `nexttime-internal-ca.crt`，按客户端系统导入受信任的根证书颁发机构：

- **macOS**：钥匙串访问 → 系统 → 拖入证书 → 双击设为"始终信任"。
- **Windows**：`certutil -addstore -f ROOT nexttime-internal-ca.crt`（管理员）或
  证书管理单元 → 受信任的根证书颁发机构 → 导入。
- **Linux（Debian/Ubuntu）**：拷到 `/usr/local/share/ca-certificates/nexttime-internal-ca.crt`，
  `sudo update-ca-certificates`。
- **Firefox**（有独立证书库，不用系统库）：设置 → 隐私与安全 → 证书 → 查看证书 → 颁发机构 →
  导入，勾选"信任此 CA 来标识网站"。

导入前用 `curl -sk` 跳过校验也能测通；导入后去掉 `-k` 应该也能成功。

## E8.3 验收

```bash
cd <CODE_DIR>
BIND_ADDR=$(grep '^KERNEL_BIND_ADDR=' .env | cut -d= -f2)
echo "health: $(curl -sk -o /dev/null -w '%{http_code}' "https://${BIND_ADDR}:8443/api/health")"
curl -sk "https://${BIND_ADDR}:8443/" | head -1
echo "kernel published ports: $(docker port "$(docker compose ps -q kernel)")"
docker compose exec caddy ls /data/caddy/pki/authorities/local
```

期望：`health: 200`；`/` 返回 web 首页（镜像内的 S1.8 构建产物，见 §E8.5）；`docker port` 对 kernel 空
输出（内核不发布任何主机端口）；`pki/authorities/local` 下能看到 `root.crt` / `root.key`。

## E8.4 回滚

```bash
docker compose stop caddy
```

不加 `-v`，`${NEXTTIME_DATA}/caddy` 下的 CA 与证书保留，下次 `up` 不会重新签发根 CA（客户端
已导入的信任不失效）。要重新生成 CA（例如怀疑私钥泄露）则先 `docker compose stop caddy`，清空
`${NEXTTIME_DATA}/caddy` 内容后再 `up`——这会让所有已导入的客户端重新提示信任，谨慎操作。

## E8.5 静态根随镜像走（web 已随 S1.8 落地）

`caddy` 服务不再 bind mount 静态目录，而是自带镜像（`deploy/caddy/Dockerfile`，多阶段）：
第一阶段在 `node:24` 里 `corepack pnpm install --frozen-lockfile && corepack pnpm --filter
@nexttime/web... build`，第二阶段基于 `caddy:2.10` 把 `packages/web/dist` 拷到 `/srv/web`、把
`deploy/caddy/explorer-placeholder`（空目录，S3 前占位）拷到 `/srv/explorer`。主机不需要 Node
工具链，仓库工作树里也不会出现 root 属主的 `dist/`。

| 路径 | 来源 |
|------|------|
| `/srv/web` | 镜像内，来自 `packages/web/dist`（S1.8） |
| `/srv/explorer` | 镜像内，占位目录；S3 落地后同样在 Dockerfile 里拷入 Explorer 构建产物 |
| `/etc/caddy/Caddyfile` | 仍是 bind mount，改路由不必重建镜像 |

部署一次 web 改动：

```bash
cd <CODE_DIR>
docker compose build caddy
docker compose up -d caddy      # 只重建 caddy 容器，不影响 kernel 等其他服务
curl -sk https://<bind>:8443/ | head -1   # 应是 web 首页的 <!doctype html>
```

回滚：`docker compose down caddy` 后用上一版镜像（`docker image ls nexttime-ai-caddy` 看历史，
或重新 `git checkout <上一版> && docker compose build caddy`）。

## 已知偏离 / 待确认（PR 中一并说明）

- **`/llm` 的反代目标**：`docs/development-tasks.md` §E8 原文把 `/api` `/ws` `/mcp` `/llm`
  统一反代到 `kernel`；设计文档 §7.7 描述的是独立的 `llm-proxy` 服务处理 provider 流量。
  本实现按 §E8 原文反代到 `kernel:8080`，未擅自改成 `llm-proxy`——这条不一致需要人工确认。
- **caddy 以 root 运行**：官方 `caddy:2.10` 镜像声明了第二个 `VOLUME /config`
  （autosave 状态），镜像内该目录 root-owned；不 bind-mount 时 Docker 用匿名卷承接，非 root
  用户写入会权限不足。要做到非 root 需要一个自定义 Dockerfile（`chown` `/config` 或改写
  `XDG_CONFIG_HOME`），超出 E8 范围，未做。`scripts/host-env-init.sh` 仍把
  `${NEXTTIME_DATA}/caddy` chown 给 uid 10001——对 root 运行的容器无影响（root 可写任何属主的
  文件），后续若切到非 root 镜像可以直接复用这个属主设置。
