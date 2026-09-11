# Runbook：host-explorer（Explorer 挂载与三工作区验证）

对应任务：`docs/development-tasks.md` §S3.5。设计文档 §9.5（九个端点契约）、§7.6（Explorer 挂载与
human 通道：调用者自己的 API key 或控制台登录后的会话 cookie，W7 / S4.1）。前置：`host-caddy.md`（caddy
已上线，`/api` 已反代到 kernel）；至少已有一些
Fact / Decision 可看（例如 S3.3 采集器跑过一轮，或手工 `assert_fact`/`record_decision` 过）。

## 目的

Explorer 是第三方开源的 Knowledge Explorer 静态前端（`semantica-agi/semantica` 项目的
`explorer/` 子目录）。内核实现了它的 Graph / Decision / Lineage 三个工作区所需的九个端点
（`packages/kernel/src/interfaces/explorer-contract/`），未改动的 Explorer 静态包指向本平台即可
加载我们自己的图数据与决策链。Ontology / Vocabulary / Reasoning / Enrich / SPARQL / Manage 等
其余工作区（含该项目自带的导航 tab）不在本次范围内——内核不实现它们的端点，点开会报错，属预期
（见下方"常见问题"）。

## 前置条件

1. `host-caddy.md` 已完成，`caddy` 容器已起，`/api/*` 反代工作正常。
2. 内核已有至少一个 owner 角色的 Principal（`host-bootstrap.md`/`host-checkout.md` 的首次
   引导已创建）。
3. 构建 Explorer 静态包（步骤 1）：正常路径只需要主机有 Docker——`node`/`npm`/`git` 都在
   `deploy/caddy/Dockerfile` 的构建阶段内部装、用完即弃，不进 caddy 运行时镜像，主机本身不需要
   装它们。只有选择步骤 1 末尾"没有 Docker、只想本地验证构建产物"那条不常见的替代路径
   （直接在主机上跑 `sh explorer/build.sh`）时，主机才需要自带 `node`/`npm`/`git`。

## 鉴权（W7 起，S4.1 改为控制台会话）

Explorer 的九个端点不再靠 caddy 注入一把共享 key。S4.1 起浏览器凭证就是**控制台会话 cookie**
`nexttime_console_session`（用户名 + 密码登录 `POST /api/auth/login` 时由内核签发；内核 Handle 密钥对
签的 EdDSA JWT，独立 `typ`，8 小时 TTL，claims 为 uid/sid；实现见
`packages/kernel/src/application/identity/console-session.ts`）——W7 那枚 Explorer 专用 cookie
`nexttime_explorer_session` 与 `POST`/`DELETE /api/explorer/session` 路由已退役（返回 404）。九个端点
每次请求先认 `X-API-Key`（脚本/curl 用这条，`scripts/accept_s3.sh` 的 driver 也走这条），没有才认这个
cookie；走 cookie 时内核每次请求都重新读一遍用户会话（未吊销、未过期、用户未停用），再按工作区找到
这个用户在该工作区的成员 Principal（未被禁用、工作区未停用）。工作区来自 `X-Workspace-Id` 头、控制台
切换工作区时写下的选择器 cookie `nexttime_workspace`（非 HttpOnly，只是选择器，不是凭证——成员资格
仍每次校验），或该用户唯一的成员资格。未改动的 Explorer 静态包发不出自定义头，所以靠后两者。角色是
平的、无序，任何角色的成员都能读——没有角色门槛。撤权：停用用户 / `disable_principal` 立即生效；
`rotate_api_key` 不影响已签发的 cookie（受 8 小时 TTL 约束，STATUS 遗留 31）。caddy 不再持有任何
Explorer 凭证。若内核没配 Handle 签名密钥，`POST /api/auth/login` 返回 503，此时只有 `X-API-Key`
路径可用。**用 API key 登录控制台的会话没有这枚 cookie**（API key 是给自动化与过渡期的），要在浏览器里
看 Explorer 就用用户名 + 密码登录。

浏览器打开方式：先在同一浏览器用用户名 + 密码登录控制台并选中工作区，再打开 `/explorer/`（或点控制台
侧栏的"图 Explorer"链接，新标签页打开）——未改动的 Explorer 静态包做的是普通同源 `fetch()`，浏览器会
自动带上这两枚 cookie。

## 步骤

### 1. 构建 Explorer 静态包并重建 caddy

W4 收尾后，构建 Explorer 静态包这一步已经并入 `docker compose build caddy` 本身
（`deploy/caddy/Dockerfile` 新增的 `explorer-build` 构建阶段——见该文件"Explorer bundle
selection"注释），**只需要主机上有 Docker，不再需要 node/npm/git**：

```bash
cd <CODE_DIR>
echo "EXPLORER_BUILD=1" >> .env    # 默认 0（不构建，用占位页）——见 .env.example 自己的说明
docker compose build caddy
docker compose up -d caddy
```

默认克隆 `semantica-agi/semantica` 的 `v0.6.7` 标签并构建；换一个标签在 `.env` 里加
`SEMANTICA_REF=<tag>`。构建阶段替换的是镜像内部的 `/srv/explorer`，不是仓库里的
`deploy/caddy/explorer-placeholder/` 目录本身——那个目录仍然只是提交进库的占位页，
`EXPLORER_BUILD=1` 不会、也不需要改动它。

`EXPLORER_BUILD` 不设（或设为 `0`）时行为与之前完全一致：`docker compose build caddy`
不联网、不克隆，直接用 `deploy/caddy/explorer-placeholder/` 里已提交的占位页（或主机上
曾经手工跑过 `sh explorer/build.sh`、就地替换过该目录内容后的产物——两条路径产出的目录
形状相同，`Dockerfile` 对它们一视同仁）。

**在主机上没有 Docker、只想本地验证构建产物本身的场景**（不常见——正常操作流程走上面的
`docker compose build caddy`）：仍可以直接跑 `sh explorer/build.sh`（需要主机自带
node/npm/git；也可以 `SEMANTICA_SRC=/path/to/checkout sh explorer/build.sh` 跳过克隆），
产物同样落在 `deploy/caddy/explorer-placeholder/`，之后 `docker compose build caddy`
（不设 `EXPLORER_BUILD`）会把这份本地构建的产物原样打进镜像。**Windows 主机**用这条路径时
要在 WSL 里跑，不要用原生 Git-Bash/MSYS——MSYS 的路径转换会破坏传给 `vite build` 的
`--base=/explorer/`/`--outDir` 参数（`explorer/build.sh` 自己的注释有细节；`Dockerfile`
内部的构建阶段跑在 Linux 容器里，不受此影响）。

## 验证

```bash
cd <CODE_DIR>
BIND_ADDR=$(grep '^KERNEL_BIND_ADDR=' .env | cut -d= -f2)
OWNER_KEY=<你自己的 owner API key>

# 九个端点各探一次（期望 200；/decisions/:id/chain 与 /provenance 需要真实 id，用图里已有的随便一个）
curl -sk -o /dev/null -w 'nodes: %{http_code}\n' \
  -H "X-API-Key: ${OWNER_KEY}" "https://${BIND_ADDR}:8443/api/graph/nodes"
curl -sk -o /dev/null -w 'edges: %{http_code}\n' \
  -H "X-API-Key: ${OWNER_KEY}" "https://${BIND_ADDR}:8443/api/graph/edges"
curl -sk -o /dev/null -w 'bounds: %{http_code}\n' \
  -H "X-API-Key: ${OWNER_KEY}" "https://${BIND_ADDR}:8443/api/temporal/bounds"
curl -sk -o /dev/null -w 'decisions: %{http_code}\n' \
  -H "X-API-Key: ${OWNER_KEY}" "https://${BIND_ADDR}:8443/api/decisions"

# 静态页面本身
curl -sk "https://${BIND_ADDR}:8443/explorer/" | head -1   # 应是 <!doctype html>

# W7 会话 cookie：用 owner key 换 cookie，再用 cookie 免 X-API-Key 读图
curl -sk -c /tmp/nt-cookie.txt -o /dev/null -w 'session: %{http_code}\n' -X POST \
  -H "Authorization: Bearer ${OWNER_KEY}" "https://${BIND_ADDR}:8443/api/explorer/session"
curl -sk -b /tmp/nt-cookie.txt -o /dev/null -w 'nodes via cookie: %{http_code}\n' "https://${BIND_ADDR}:8443/api/graph/nodes"
curl -sk -o /dev/null -w 'nodes without credentials: %{http_code}\n' "https://${BIND_ADDR}:8443/api/graph/nodes"   # 期望 401
rm -f /tmp/nt-cookie.txt
```

浏览器：先在 `https://<BIND_ADDR>:8443/` 登录控制台（先按 `host-caddy.md` §E8.2 信任内网 CA，
否则证书告警），再打开 `/explorer/`（或点控制台侧栏的"图 Explorer"链接）：

- **Knowledge Explorer / Graph** 工作区：图应能加载出采集器写入的 Object/Fact（节点/边）。
- **Decisions** 工作区：左侧列表能看到已有 Decision，点开显示 causal chain。
- **Manage → Lineage**（Explorer 自己的导航把 Lineage 放在 Manage 子标签下，不是顶层 tab）：
  输入一个 Fact/Decision/Activity 的 id，能画出 PROV-O 血缘图，右上角能导出 JSON/Markdown。

三个工作区都能加载 = 本 runbook 的验收标准（对应 `docs/development-tasks.md` §S3.5 的验收句）。

## 回滚

```bash
cd <CODE_DIR>
sed -i '/^EXPLORER_BUILD=/d' .env   # 或手工删掉/注释掉该行——不删 EXPLORER_BUILD=1 重建只会再构建一次
git checkout -- deploy/caddy/explorer-placeholder   # 只在曾经用"步骤 1 末尾"的直接主机构建路径
                                                     # 就地替换过该目录内容时才需要这一步
docker compose build caddy
docker compose up -d caddy
```

只想不动静态页、单纯把 Explorer 的 API 访问下线：`disable_principal` 相关账号，或直接停掉
kernel——W7 起没有单独的 Explorer 凭证可撤，撤的就是账号本身。

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `/explorer/` 显示"Explorer bundle not built" | `.env` 里没设 `EXPLORER_BUILD=1`（默认用占位页），或设了但还没 `docker compose build caddy` | 按"步骤 1"补跑 |
| Explorer 页面能打开，但 Graph/Decisions 的请求是 401 | 没有先在同一浏览器用用户名 + 密码登录控制台（用 API key 登录的会话没有 cookie）、cookie 已过期（8 h）或已登出、用户已停用、该 Principal 已被 `disable_principal` | 回控制台用密码重新登录后再打开 `/explorer/` |
| Explorer 请求是 403 | 控制台里没有选中工作区且该用户有多个成员资格（`workspace_required`），或在选中的工作区里没有成员资格 | 回控制台切到目标工作区（会写 `nexttime_workspace` 选择器 cookie）再刷新 Explorer |
| `POST /api/auth/login` 返回 503 | 内核没有 Handle 签名密钥（`HANDLE_PRIVATE_KEY_FILE`） | 按 host-bootstrap.md 生成密钥；`X-API-Key` 路径不受影响 |
| 页面加载出来但静态资源（JS/CSS）404，或 Network 里看到请求打到 `/assets/...` 而不是 `/explorer/assets/...` | 构建时没有 `--base=/explorer/`（例如手工跑了 `vite build` 而不是 `explorer/build.sh`） | 用 `explorer/build.sh`，不要绕过它手工构建 |
| Ontology Hub / Enrich / Manage 里的 KG Overview、SPARQL 等标签页报错或空白 | 预期——本任务只实现 Graph/Decision/Lineage 三个工作区的后端（design doc §9.5"只做这些"），其余标签页仍在导航里但没有对应后端 | 无需处理；不要把这当成故障 |
| `create_principal` 返回 403 | 调用者不是 owner 角色 | 换一个 owner 的 API key |
| 图里能看到 `WorkerDefinition`/`Gatekeeper`/`Skill`/`Procedure`/`Operation` 类型的节点 | 不应该发生——`explorer-read-service.ts` 会过滤掉这些平台元本体对象；如果看到了说明契约实现有回归 | 按 bug 处理，不是配置问题 |
