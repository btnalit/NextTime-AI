# Runbook：key-rotation（密钥与令牌轮换）

对应任务：development-tasks.md § S3.10（"`docs/runbooks/`：轮换 Handle 签名密钥与 provider
key...每步的验证与回滚"；本文档同时覆盖 W1-E 行细化出的 `internal_token`/`gate_token` 与
`rotate_api_key`）。设计依据：`docs/graph-ai-middle-platform-design.md` §11（权限与安全，"凭证不进
任何 agent 进程，也不进内核进程"）。

本仓库有四类需要轮换的密钥/令牌，机制完全不同，**不要用同一套步骤套用到全部四种**：

| 类型 | 文件/存储 | 消费者 | 影响范围 |
|---|---|---|---|
| Handle 签名密钥 | `secrets/handle.key`（私钥）+ `config/handle.pub`（公钥） | `kernel`（签发/自验）、`llm-proxy`（验签） | 轮换后**立即**让当时所有已签发、仍在有效期内的 Capability Handle 失效（硬切换，无重叠期，见 §2） |
| `internal_token` | `secrets/internal.token` | `kernel`、`agent-host`、`llm-proxy`、`egress-proxy` | 内核 internal plane（`/internal/*`、`/internal/agent-host` WS）的共享密钥；四者必须同步换 |
| `gate_token` | `secrets/gate.token` | `kernel`（作为客户端）+ 每一个门服务（`gatekeeper-docker`/`gatekeeper-ragflow`/自建的 `gatekeepers/<system>`） | 内核↔门 `/gate/*` 协议的共享密钥；kernel 与每一个门服务必须同步换 |
| Provider key（LLM 供应商） | `secrets/llm-proxy.env` 里 `config/llm-providers.yaml` 的 `api_key_env` 指向的那个变量 | 仅 `llm-proxy` | 只影响该 provider 的出站调用；不影响 Handle/内部 token |
| 平台用户 API key | 数据库 `principals` 表（哈希存储），通过 `rotate_api_key` capability | 该 Principal 自己/持有该 key 的任何客户端 | 只影响这一个 Principal 的 API key；旧 key 立即失效 |

## 0. 通用前置条件

- 目标主机已完成 `docs/runbooks/host-checkout.md`（E3/E4）与 `scripts/gen-handle-keys.sh`——本文档
  假定 `secrets/handle.key`、`config/handle.pub`、`secrets/internal.token`、`secrets/gate.token`
  均已存在（首次生成，不是本文档的范围）。
- **`scripts/gen-handle-keys.sh` 是幂等的、只在文件缺失时生成——它不会帮你做轮换**：任何一个目标
  文件只要存在（哪怕内容为空以外的任意内容）就不会被脚本覆盖（脚本自己的头注释：
  "Generated only if missing — an existing private key is never regenerated"）。轮换必须手动删除
  旧文件（或用等价命令重新生成同名文件）再重启相应服务，本文档每一节给出具体命令。
- 操作前建议先做一次 `docs/runbooks/backup-restore.md` 的手动备份（`docker compose run --rm -e
  BACKUP_NOW=1 backup`）——轮换失败时可以更快判断"是不是数据问题"。

## 1. Handle 签名密钥（`secrets/handle.key`）

### 1.1 目的

Ed25519 密钥对：kernel 用私钥签发 Capability Handle（入口/Worker 身份令牌），kernel 自己与
`llm-proxy` 用公钥本地验签（`llm-proxy` 从不回调内核逐请求验证，design §7.7）。

### 1.2 机制（决定了轮换是硬切换）

`packages/kernel/src/governance/capability/keys.ts` 的 `loadHandleKeyPair()` 只在进程启动时读一次
PEM 文件（该模块自己的注释："the production kernel signs/verifies with one persisted keypair for
its whole lifetime...so a Handle issued before a restart still verifies afterward"）；
`packages/llm-proxy/src/handle-auth.ts` 的 `loadHandlePublicKey()` 同样只在启动时读一次。**没有
双密钥/密钥 ID 重叠期机制**——kernel 一旦用新私钥重启，所有用旧私钥签发、仍在有效期内（默认
`ENTRY_HANDLE_TTL_SECONDS=86400`）的 Handle 立即验签失败。

这不像看起来那么破坏性：`packages/worker-supervisor/src/resident-service.ts` 的"Handle
rotation"机制（该文件模块注释"Handle rotation (lane-6 review P2-5)"）已经处理了自愈——每次
`/resident/spawn` 都会 best-effort 解出新到来的 Handle 的 `jti` 并与容器当前持有的比较，不一致就
重建容器；kernel 在下一轮对话（`startTurn`）会因为进程重启导致内存态 Handle 缓存清空而铸造一个用
**新**私钥签的全新 Handle（带新 `jti`），worker-supervisor 据此自动重建该用户的入口容器。**实际影响
窗口**：轮换发生的那一刻起，到每个用户"下一次发消息"之间，该用户当前持有的旧 Handle 会 401；一旦
发下一条消息，kernel 铸造新 Handle → 容器自动重建 → 恢复正常。不需要手动挨个重启所有用户的入口
容器（虽然主动 `resident_stop` 可以让切换立即生效而不是等自愈，见 §1.4 "更彻底的切换"）。

### 1.3 步骤

```bash
cd <CODE_DIR>
set -a; . ./.env; set +a

# 1. 备份旧密钥对（可选但强烈建议——万一轮换后要临时回滚）
cp "${NEXTTIME_DATA}/secrets/handle.key" "${NEXTTIME_DATA}/secrets/handle.key.bak-$(date +%s)"
cp "${NEXTTIME_DATA}/config/handle.pub" "${NEXTTIME_DATA}/config/handle.pub.bak-$(date +%s)"

# 2. 删除旧密钥对（gen-handle-keys.sh 只在文件缺失时生成，见 §0）
rm -f "${NEXTTIME_DATA}/secrets/handle.key" "${NEXTTIME_DATA}/config/handle.pub"

# 3. 重新生成——这一次脚本会生成一份新的 Ed25519 密钥对（internal.token/gate.token 已存在，
#    脚本不会碰它们）
sh scripts/gen-handle-keys.sh

# 4. 重启两个消费者（compose secret 是 host 文件的只读绑定挂载，进程重启即重新读取——不需要
#    --force-recreate，见 docs/runbooks/operations.md §4.2 关于 secrets 与 env_file 的区别）
docker compose restart kernel llm-proxy
docker compose ps kernel llm-proxy   # 等 kernel healthy
```

### 1.4 更彻底的切换（可选：不等自愈，立即让所有在跑的入口容器换新 Handle）

先列出哪些用户当前有常驻入口容器（容器名形如 `nexttime-entry-<principalId>`）：

```bash
docker ps --filter "label=nexttime.role=entry" --format '{{.Names}}'
```

对每一个 `principalId` 调用 `POST /resident/stop`（`docs/runbooks/host-worker-runtime.md` §8/§9
的既有端点；停止后该用户下次发消息会走全新 spawn，自然拿到用新私钥签的 Handle）：

```bash
docker compose exec -T worker-supervisor node -e "
const token = require('fs').readFileSync('/run/secrets/internal_token','utf8').trim();
fetch('http://localhost:8081/resident/stop', {
  method: 'POST', headers: {'content-type':'application/json', authorization: 'Bearer ' + token},
  body: JSON.stringify({principalId: '<principalId>'}),
}).then(r => console.log(r.status))
"
```

### 1.5 验证

```bash
# 1. 公私钥确实换了
sha256sum "${NEXTTIME_DATA}/config/handle.pub"   # 与轮换前记录的值不同
diff "${NEXTTIME_DATA}/config/handle.pub" "${NEXTTIME_DATA}/config/handle.pub.bak-<ts>" && echo "UNCHANGED (bad)" || echo "changed (expected)"

# 2. kernel/llm-proxy 都健康
docker compose ps kernel llm-proxy

# 3. 端到端：走一轮真实对话（docs/runbooks/accept-s1.md 的 chat 步骤，或 web 控制台登录后发一句话），
#    确认新 Turn 能完成——这证明新签发的 Handle 能被 llm-proxy 用新公钥验证通过
```

### 1.6 回滚

```bash
cp "${NEXTTIME_DATA}/secrets/handle.key.bak-<ts>" "${NEXTTIME_DATA}/secrets/handle.key"
cp "${NEXTTIME_DATA}/config/handle.pub.bak-<ts>" "${NEXTTIME_DATA}/config/handle.pub"
docker compose restart kernel llm-proxy
```
同样是硬切换——回滚同样会让"轮换之后、回滚之前"这段时间签发的新 Handle 失效，同 §1.2 的自愈机制
会在下一轮对话时纠正。

### 1.7 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 轮换后所有用户的当前对话都卡住/报错，但过一会儿自己恢复了 | 预期行为——见 §1.2，旧 Handle 401 → 下一轮对话自动铸造新 Handle → 容器自动重建 | 无需处理；不能接受这个等待窗口时用 §1.4 主动切换 |
| 跑了 `sh scripts/gen-handle-keys.sh` 但公私钥没变 | 没有先删除旧文件（§0"脚本只在文件缺失时生成"） | 按 §1.3 步骤 2 先 `rm -f` 再重新跑脚本 |
| 只重启了 `kernel`，没重启 `llm-proxy` | 两者都缓存了公钥/私钥，只重启一个会导致 kernel 签的新 Handle 在 `llm-proxy` 那边验签失败（用的是`llm-proxy` 还没换的旧公钥） | `docker compose restart kernel llm-proxy` 两个一起 |

## 2. `internal_token`（kernel internal plane 共享密钥）

### 2.1 目的

`/internal/*` HTTP 路由（`agent-host`/`llm-proxy`/`egress-proxy` 分别调 `/internal/agent-host`
WS、`/internal/llm-usage`、`/internal/egress`、`/internal/handle-revocations`）与 kernel 之间的共享
密钥（`fix/internal-plane-auth`）——kernel 双栖在 `control`/`workers` 两个网络、监听所有接口，这个
密钥是防止 Worker 容器伪造这些内部调用的唯一屏障（连同 §11 的"来自 `NEXTTIME_SUBNET_WORKERS` 的
连接即使 token 正确也拒绝"这条第二道防线）。

### 2.2 机制

单一共享密钥（32 字节随机数，hex 编码），每个消费者（`kernel` 自己 + `agent-host`/`llm-proxy`/
`egress-proxy`）在进程启动时读一次（`loadInternalToken()`/各自 config 模块），**没有双 token/宽限
期**——换了旧值就立即让所有仍用旧值的客户端 401，直到它们也换上新文件并重启。

### 2.3 步骤

```bash
cd <CODE_DIR>
set -a; . ./.env; set +a

cp "${NEXTTIME_DATA}/secrets/internal.token" "${NEXTTIME_DATA}/secrets/internal.token.bak-$(date +%s)"
rm -f "${NEXTTIME_DATA}/secrets/internal.token"
sh scripts/gen-handle-keys.sh   # 只会重新生成 internal.token；handle.key/gate.token 已存在，不动

# 四个消费者一起重启（同一份新密钥内容通过 compose secret 挂载，重启即重新读取）：
docker compose restart kernel agent-host llm-proxy egress-proxy
docker compose ps kernel agent-host llm-proxy egress-proxy
```

### 2.4 验证

```bash
# 1. 内容确实变了
sha256sum "${NEXTTIME_DATA}/secrets/internal.token"

# 2. agent-host 能重新连上内部 WS（docker compose logs 里不应有持续的 401/重连失败）：
docker compose logs --since 2m agent-host | grep -i "unauthorized\|401" && echo "STILL FAILING" || echo "ok"

# 3. 端到端：走一轮对话（依赖 agent-host<->kernel 的内部 WS）；确认 llm_usage 表有新行
#    （依赖 llm-proxy -> kernel 的 /internal/llm-usage）
```

### 2.5 回滚

```bash
cp "${NEXTTIME_DATA}/secrets/internal.token.bak-<ts>" "${NEXTTIME_DATA}/secrets/internal.token"
docker compose restart kernel agent-host llm-proxy egress-proxy
```

### 2.6 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 只重启了 `kernel`，`agent-host` 的 WS 一直断线重连 | 四个消费者没有同步换新值——`agent-host` 还在用旧 token 握手，kernel 已经在用新值验证 | 补上 `docker compose restart agent-host llm-proxy egress-proxy` |
| `docker compose logs kernel` 出现 `no_token_configured` | `secrets/internal.token` 被删除后没有成功重新生成（比如 `openssl` 不可用），kernel 是 fail-closed（拒绝一切 `/internal/*` 请求，而不是回退成"不校验"） | 确认 `sh scripts/gen-handle-keys.sh` 真的成功生成了文件（`stat` 检查 mode/非空），再重启 |

## 3. `gate_token`（内核↔门共享密钥）

### 3.1 目的

内核的 `HttpGatekeeperClient` 与每一个门服务（`gatekeeper-docker`/`gatekeeper-ragflow`，以及
`docs/runbooks/add-gatekeeper.md` 新增的任何 `gatekeeper-base` 实例）之间的共享密钥
（`fix/gate-protocol-hardening`）——没有它，任何能访问 `control` 网络的容器都能直接对门发
`/gate/apply` 之类的执行类调用，绕过内核的审批与审计。

### 3.2 机制

同 §2——单一共享密钥，`kernel`（客户端角色，`NEXTTIME_GATE_TOKEN_FILE`）与每个门服务（服务端角色，
`GATE_KERNEL_TOKEN_FILE`）各自在启动时读一次，无重叠期。**消费者数量取决于当前部署了多少个门**——
生产环境至少是 `kernel` + `gatekeeper-docker` + `gatekeeper-ragflow`；`accept-s2-ssh-gate`/
`accept-s2-http-gate` 只在 `accept-s2` profile 起时才存在，不属于常规轮换范围；任何按
`docs/runbooks/add-gatekeeper.md` 新增的门服务同样要计入。

### 3.3 步骤

```bash
cd <CODE_DIR>
set -a; . ./.env; set +a

cp "${NEXTTIME_DATA}/secrets/gate.token" "${NEXTTIME_DATA}/secrets/gate.token.bak-$(date +%s)"
rm -f "${NEXTTIME_DATA}/secrets/gate.token"
sh scripts/gen-handle-keys.sh   # 只会重新生成 gate.token

# kernel + 每一个当前部署的门服务一起重启（按实际部署的门服务列表调整）：
docker compose restart kernel gatekeeper-docker gatekeeper-ragflow
docker compose ps kernel gatekeeper-docker gatekeeper-ragflow
```

### 3.4 验证

```bash
GATE_TOKEN=$(cat "${NEXTTIME_DATA}/secrets/gate.token")
docker compose exec -T kernel node -e "
fetch('http://gatekeeper-docker:8083/gate/health', {headers:{authorization:'Bearer ${GATE_TOKEN}'}}).then(r=>r.text()).then(t=>console.log('docker:',t))
"
docker compose exec -T kernel node -e "
fetch('http://gatekeeper-ragflow:8083/gate/health', {headers:{authorization:'Bearer ${GATE_TOKEN}'}}).then(r=>r.text()).then(t=>console.log('ragflow:',t))
"
```
期望：两者都 `{"ok":true,"result":{"status":"ok"}}`（同 `docs/runbooks/host-gatekeepers.md` §3 的
验证方式）；用**旧** token 重跑同一条命令应得 401，确认旧密钥真的已经失效。

### 3.5 回滚

```bash
cp "${NEXTTIME_DATA}/secrets/gate.token.bak-<ts>" "${NEXTTIME_DATA}/secrets/gate.token"
docker compose restart kernel gatekeeper-docker gatekeeper-ragflow
```

### 3.6 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 某个门轮换后没有一起重启（比如自建的 `gatekeepers/<system>` 忘了带上） | §3.2"消费者数量取决于当前部署了多少个门" | 轮换前先 `docker compose ps` 列出所有当前在跑的门服务，逐一加进 `restart` 命令 |
| 门服务重启后直接进入重启循环 | `secrets/gate.token` 被删除后重新生成失败（同 §2.6 的 `internal.token` 场景），门服务的 `main()` 同样 fail-closed（"refuses to start without it"） | 确认文件存在且非空再重启 |

## 4. Provider key（LLM 供应商 API key）

### 4.1 目的

`llm-proxy` 代表所有 agent 容器持有真实 provider 凭证（design §11 底线 1："provider key 只在
`llm-proxy`"）——agent 容器自己从不持有任何 `*_API_KEY`。轮换 provider key 只影响 `llm-proxy`。

### 4.2 步骤

```bash
cd <CODE_DIR>
set -a; . ./.env; set +a

# 1. 确认 config/llm-providers.yaml 里该 provider 的 api_key_env 指向哪个变量名
grep -A3 "^  <provider-name>:" "${NEXTTIME_DATA}/config/llm-providers.yaml"

# 2. 编辑 secrets/llm-proxy.env，把该变量名对应的值换成新 key（vi/sed 均可，不要打印到终端）：
#    <VAR_NAME>=<new-key>

# 3. env_file 改动必须 --force-recreate（普通 restart 不会重新读 env_file 内容——
#    docs/runbooks/operations.md §4.2）：
docker compose up -d --force-recreate llm-proxy
docker compose ps llm-proxy
```

### 4.3 验证

```bash
# 走一轮真实对话（用该 provider/model），确认能正常拿到回复；
# 或查 llm_usage 表确认新一条调用记录没有 error：
docker compose exec -T postgres psql -U nexttime -d nexttime -c \
  "select provider, model, created_at from llm_usage order by created_at desc limit 5;"
```
若旧 key 已在供应商侧吊销、新 key 未生效，`llm-proxy` 会把上游的鉴权错误原样透传给调用方（agent
容器里表现为该轮回复失败/报错），`docker compose logs llm-proxy` 能看到具体的上游错误。

### 4.4 回滚

```bash
# 把 secrets/llm-proxy.env 里的值改回旧 key（若旧 key 还未在供应商侧吊销）：
docker compose up -d --force-recreate llm-proxy
```
若旧 key 已经吊销，回滚意味着"这个 provider 暂时不可用"，不是简单的文件回滚——需要联系供应商或换
另一个已配置的 provider（`config/llm-providers.yaml` 可以同时声明多个 provider）。

### 4.5 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 改了 `secrets/llm-proxy.env` 但对话仍然用旧 key 失败 | 用了 `docker compose restart` 而不是 `--force-recreate`（env_file 是创建时固化的） | `docker compose up -d --force-recreate llm-proxy` |
| 想确认新 key 有没有真的生效，但不想等一轮真实对话 | 没有独立的"测试 provider key"端点 | 用 `docs/runbooks/host-agent-host.md` 描述的 fake-llm 链路验证其余部分工作正常，再单独走一轮真实 provider 对话确认这一个变量 |

## 5. 平台用户 API key（`rotate_api_key`）

### 5.1 目的

一个人类 Principal（owner/operator/member/...）登录 web 控制台或直接调 `/api/cap/*` 用的那把 API
key——与前面四种系统级密钥完全不同的轮换路径：**capability 驱动，无需重启任何服务，无需
`docker compose`**。

### 5.2 机制

`rotate_api_key{principalId}`（`packages/shared/src/capabilities.ts`，`group: 'members'`,
`mode: 'write'`, `channel: 'human'`）：注册表层 `minRole: 'member'`（每个人至少能转自己的），
handler 再收紧为"owner，或本人"。旧 key 立即停止工作（数据库里只存哈希，`rotate_api_key` 直接
把旧哈希换成新哈希，同一次写入内完成，没有宽限期）；新明文 key **只在这一次响应里出现一次**，
之后无法再找回，只能再次轮换。

### 5.3 步骤——Web 控制台

1. 登录 web 控制台，进入"治理 → 成员与授权"（`#/govern/members`，owner/operator 可见）。
2. 点开目标 Principal 的详情抽屉。
3. 点击"Rotate API key"。
4. 立即复制显示出来的新 key（关闭抽屉前，抽屉只显示这一次；忘记复制需要再次点击 rotate 生成新的
   一把，旧的这把届时也已经失效——见 `docs/runbooks/web-console.md`"排障"表"成员页创建/轮换后密钥
   找不到了"）。

### 5.4 步骤——API/CLI 路径

没有独立 CLI 子命令（`packages/kernel/src/cli/bootstrap.ts` 只有 `create-workspace` /
`add-principal` / `register-gatekeeper` / `delete-workspace` / `list-workspaces` 五个，没有
`rotate-api-key`）——`rotate_api_key` 只能经 HTTP capability 调用：

```bash
# 用 owner 自己的 key，或该 principal 自己的 key（handler 允许 owner 改任何人、本人改自己）：
curl -s https://<kernel-or-caddy-host>:8443/api/cap/rotate_api_key \
  -H "Authorization: Bearer ${CALLER_KEY}" -H 'content-type: application/json' \
  -d '{"principalId":"<principal-uuid>"}'
```
期望：`{"ok":true,"result":{"apiKey":"<new-plaintext-key>", ...}}`——立即复制 `apiKey`，这是唯一
一次能看到明文的机会。经内网直连 kernel 时把上面的 URL 换成
`http://kernel:8080/api/cap/rotate_api_key`（例如从 `kernel` 容器自己内部用 `node -e fetch(...)`
调，同本仓库其它 runbook 的一贯模式）。

### 5.5 验证

```bash
# 旧 key 应该已经失效：
curl -s https://<host>:8443/api/cap/get_workspace \
  -H "Authorization: Bearer ${OLD_KEY}" -H 'content-type: application/json' -d '{}'
# 期望 401

# 新 key 应该可用：
curl -s https://<host>:8443/api/cap/get_workspace \
  -H "Authorization: Bearer ${NEW_KEY}" -H 'content-type: application/json' -d '{}'
# 期望 200
```

### 5.6 回滚

**没有"回滚"这个动作**——旧 key 一旦被轮换掉，它的哈希已经从数据库里被新哈希覆盖，无法恢复。唯一
的"回滚"是再对同一个 `principalId` 调用一次 `rotate_api_key`，生成第三把新 key，把它分发给需要用
这个身份的人/系统。

### 5.7 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 调用 `rotate_api_key` 返回 403 | 调用方既不是 owner 也不是目标 Principal 本人 | 用 owner 的 key，或让该 Principal 本人调用 |
| 关闭了抽屉/丢失了终端输出，找不到新 key 了 | 明文只显示一次，设计如此（S3.11 决策） | 再次调用 `rotate_api_key`——生成新的一把，之前那把（无论是否已经被使用过）同样失效 |
| 轮换后某个自动化脚本/CI 用旧 key 调用平台开始报 401 | 预期行为——旧 key 立即失效，没有宽限期 | 轮换前先确认哪些自动化在用这把 key，轮换后同步更新它们持有的 key |
