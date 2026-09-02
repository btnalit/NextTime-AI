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

期望：`health: 200`；`/` 返回占位页（见 §E8.5）或 web 构建首页；`docker port` 对 kernel 空
输出（内核不发布任何主机端口）；`pki/authorities/local` 下能看到 `root.crt` / `root.key`。

## E8.4 回滚

```bash
docker compose stop caddy
```

不加 `-v`，`${NEXTTIME_DATA}/caddy` 下的 CA 与证书保留，下次 `up` 不会重新签发根 CA（客户端
已导入的信任不失效）。要重新生成 CA（例如怀疑私钥泄露）则先 `docker compose stop caddy`，清空
`${NEXTTIME_DATA}/caddy` 内容后再 `up`——这会让所有已导入的客户端重新提示信任，谨慎操作。

## E8.5 占位静态根 ↔ 真实构建的切换

S1.8（web）与 S3（Explorer）落地前，`docker-compose.yml` 的 `caddy` 服务把 `/srv/web` 与
`/srv/explorer` 分别挂载到仓库内的占位目录：

| 挂载点 | 当前（占位） | 落地后 |
|--------|-------------|--------|
| `/srv/web` | `./deploy/caddy/placeholder`（一行 `index.html`） | `./packages/web/dist`（S1.8 产物） |
| `/srv/explorer` | `./deploy/caddy/explorer-placeholder`（空目录） | `./explorer/dist`（S3 产物） |

切换步骤（以 web 为例，explorer 同理）：

1. 确认 `packages/web/dist` 已由 `corepack pnpm --filter @nexttime/web build` 产出且非空。
2. 编辑 `docker-compose.yml` 的 `caddy.volumes`，把
   `./deploy/caddy/placeholder:/srv/web:ro` 改成 `./packages/web/dist:/srv/web:ro`。
3. `docker compose up -d caddy`（只重建 caddy 容器，不影响 kernel 等其他服务）。
4. `curl -sk https://<bind>:8443/` 应返回真实首页而非占位页。

Caddyfile（`deploy/caddy/Caddyfile`）本身不需要改动——两条路径都是 `/srv/web`
`/srv/explorer`，切换只发生在 compose 的宿主机挂载源。

**S1.8 补充说明（构建产物已存在）**：`packages/web`（design doc §7.6：登录、对话页、`lib/ws-client.ts`）
已随 S1.8 落地。确切构建命令是 `corepack pnpm --filter @nexttime/web build`（注意包名带
`@nexttime/` 前缀，上面步骤 1 的旧写法 `pnpm --filter web build` 按包名精确匹配会找不到该包）；
产物目录固定是 `packages/web/dist`（Vite 默认 `outDir`，`packages/web/vite.config.ts` 未覆盖），
即上表"落地后"一列与步骤 2 里已经写的挂载源——不需要另建目录或改 `outDir`。

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
