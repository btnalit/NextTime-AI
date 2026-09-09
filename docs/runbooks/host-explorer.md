# Runbook：host-explorer（Explorer 挂载与三工作区验证）

对应任务：`docs/development-tasks.md` §S3.5。设计文档 §9.5（九个端点契约）、§7.6（Explorer 挂载与
human 通道 API key）。前置：`host-caddy.md`（caddy 已上线，`/api` 已反代到 kernel）；至少已有一些
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
3. 构建 Explorer 静态包需要 `node`/`npm`（仅在运行 `explorer/build.sh` 的主机或
   `deploy/caddy/Dockerfile` 构建阶段里需要，不进 caddy 运行时镜像本身）。

## 步骤

### 1. 创建 Explorer 专用 Principal 并取得 API key

Explorer 的九个端点只做 human 通道鉴权（`X-API-Key`），**不做角色检查**——任何角色的有效 key
都能访问该 workspace 下的数据，因此按最小权限原则给它建一个 `member` 角色的独立 Principal，
不复用 owner/operator 自己的 key：

```bash
cd <CODE_DIR>
BIND_ADDR=$(grep '^KERNEL_BIND_ADDR=' .env | cut -d= -f2)
OWNER_KEY=<你自己的 owner API key>

curl -sk -X POST "https://${BIND_ADDR}:8443/api/cap/create_principal" \
  -H "Authorization: Bearer ${OWNER_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"role":"member","displayName":"explorer"}'
```

响应的 `result.apiKey` 只显示这一次（`create_principal` 的契约——明文 key 不会再被存储或读出），
立刻记下来。

### 2. 写入 `.env` 的 `EXPLORER_API_KEY`

```bash
echo "EXPLORER_API_KEY=<上一步拿到的 key>" >> .env
```

`.env` 本身不入库（`.gitignore`）；`docker-compose.yml` 的 `caddy` 服务把它按
`${EXPLORER_API_KEY:-}` 展开进容器环境，Caddyfile 用 `{$EXPLORER_API_KEY}` 把它注入到每个
Explorer API 请求的 `X-API-Key` 头——未改动的 Explorer 静态前端自己不发这个头
（`fetch("/api/graph/nodes")` 这类根相对路径调用没有自定义 header），所以由 caddy 代为附加。
**没按 `llm-proxy.env` 那样放进 `${NEXTTIME_DATA}/secrets/`**：那需要 `docker compose` 的
`env_file` 在启动时该文件已存在，CI 的 web-e2e 工作流只为它实际起的三个服务（postgres/kernel/
caddy）预置 secrets，不知道这个新文件，第一次提交就把它跑挂了；`${VAR:-}` 展开没有这个文件依赖，
未设置时是空字符串，Explorer 的调用会拿到空 `X-API-Key`，内核侧照样 401（fail closed，不是
放行）。

### 3. 构建 Explorer 静态包

```bash
cd <CODE_DIR>
sh explorer/build.sh
```

默认克隆 `semantica-agi/semantica` 的 `v0.6.7` 标签并构建；也可以指向一份已有的本地检出
（`SEMANTICA_SRC=/path/to/checkout sh explorer/build.sh`，跳过克隆）。构建产物替换
`deploy/caddy/explorer-placeholder/` 的内容——见 `explorer/README.md` 的完整说明。

**Windows 主机**：在 WSL 里跑这一步，不要用原生 Git-Bash/MSYS——MSYS 的路径转换会破坏传给
`vite build` 的 `--base=/explorer/`/`--outDir` 参数（`explorer/build.sh` 自己的注释有细节）。

### 4. 重建并重启 caddy

```bash
cd <CODE_DIR>
docker compose build caddy
docker compose up -d caddy
```

## 验证

```bash
cd <CODE_DIR>
BIND_ADDR=$(grep '^KERNEL_BIND_ADDR=' .env | cut -d= -f2)
EXPLORER_KEY=$(grep '^EXPLORER_API_KEY=' .env | cut -d= -f2)

# 九个端点各探一次（期望 200；/decisions/:id/chain 与 /provenance 需要真实 id，用图里已有的随便一个）
curl -sk -o /dev/null -w 'nodes: %{http_code}\n' \
  -H "X-API-Key: ${EXPLORER_KEY}" "https://${BIND_ADDR}:8443/api/graph/nodes"
curl -sk -o /dev/null -w 'edges: %{http_code}\n' \
  -H "X-API-Key: ${EXPLORER_KEY}" "https://${BIND_ADDR}:8443/api/graph/edges"
curl -sk -o /dev/null -w 'bounds: %{http_code}\n' \
  -H "X-API-Key: ${EXPLORER_KEY}" "https://${BIND_ADDR}:8443/api/temporal/bounds"
curl -sk -o /dev/null -w 'decisions: %{http_code}\n' \
  -H "X-API-Key: ${EXPLORER_KEY}" "https://${BIND_ADDR}:8443/api/decisions"

# 静态页面本身
curl -sk "https://${BIND_ADDR}:8443/explorer/" | head -1   # 应是 <!doctype html>
```

浏览器打开 `https://<BIND_ADDR>:8443/explorer/`（先按 `host-caddy.md` §E8.2 信任内网 CA，否则
证书告警）：

- **Knowledge Explorer / Graph** 工作区：图应能加载出采集器写入的 Object/Fact（节点/边）。
- **Decisions** 工作区：左侧列表能看到已有 Decision，点开显示 causal chain。
- **Manage → Lineage**（Explorer 自己的导航把 Lineage 放在 Manage 子标签下，不是顶层 tab）：
  输入一个 Fact/Decision/Activity 的 id，能画出 PROV-O 血缘图，右上角能导出 JSON/Markdown。

三个工作区都能加载 = 本 runbook 的验收标准（对应 `docs/development-tasks.md` §S3.5 的验收句）。

## 回滚

```bash
cd <CODE_DIR>
git checkout -- deploy/caddy/explorer-placeholder   # 恢复占位页
docker compose build caddy
docker compose up -d caddy
```

只想临时下线 Explorer 的 API 访问而不动静态页：把 `.env` 里的 `EXPLORER_API_KEY` 清空或删掉该
Principal（`disable_principal`），`docker compose up -d caddy`（重新展开 `.env`）——之后的
Explorer API 请求会带一个空/失效的 `X-API-Key`，内核侧一律 401。

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `/explorer/` 显示"Explorer bundle not built" | 还没跑过 `explorer/build.sh`，或跑完没有 `docker compose build caddy` | 按"步骤 3–4"补跑 |
| Explorer 页面能打开，但 Graph/Decisions 一直转圈或报错，Network 面板里 `/api/graph/nodes` 等是 401 | `EXPLORER_API_KEY` 没配置、配错、或对应 Principal 被 `disable_principal` 了 | 重新走"步骤 1–2"，`docker compose up -d caddy`（`restart` 不会重新展开 `.env`，必须 `up -d` 才会用新值重建容器） |
| 页面加载出来但静态资源（JS/CSS）404，或 Network 里看到请求打到 `/assets/...` 而不是 `/explorer/assets/...` | 构建时没有 `--base=/explorer/`（例如手工跑了 `vite build` 而不是 `explorer/build.sh`） | 用 `explorer/build.sh`，不要绕过它手工构建 |
| Ontology Hub / Enrich / Manage 里的 KG Overview、SPARQL 等标签页报错或空白 | 预期——本任务只实现 Graph/Decision/Lineage 三个工作区的后端（design doc §9.5"只做这些"），其余标签页仍在导航里但没有对应后端 | 无需处理；不要把这当成故障 |
| `create_principal` 返回 403 | 调用者不是 owner 角色 | 换一个 owner 的 API key |
| 图里能看到 `WorkerDefinition`/`Gatekeeper`/`Skill`/`Procedure`/`Operation` 类型的节点 | 不应该发生——`explorer-read-service.ts` 会过滤掉这些平台元本体对象；如果看到了说明契约实现有回归 | 按 bug 处理，不是配置问题 |
