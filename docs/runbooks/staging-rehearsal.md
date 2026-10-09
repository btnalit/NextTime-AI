# Runbook：staging-rehearsal（云端发版预演）

对应脚本：`scripts/staging-rehearsal.sh`；调用方：`.github/workflows/staging.yml`。
前置阅读：`docs/runbooks/release.md` §3（主机上的 `apply-release.sh`）、
`docs/runbooks/host-accept-real-model.md`（`--real` 模式）。

## 1. 目的

在一台**一次性**的 Docker 主机（GitHub-hosted runner）上，把"生产主机今天在跑的发布版 → 本次要上
的版本"完整走一遍，结论是：**这个提交能在生产现状之上 apply，并且在那里通过 S3/S1/S2/S4**。

它是主机 apply 之前的预发环境，不是主机 apply 本身：主机上的 apply、主机验收记录、回滚决定仍然
在生产主机上做（见 §5"仍然只能在生产主机上做的事"）。

## 2. 它做了什么（与生产主机的对应关系）

| 步骤 | 预演里怎么做 | 生产主机上对应的是 |
|---|---|---|
| gVisor | 与生产主机同样注册 `runsc`（`runtimeArgs: ["--network=host"]`） | 主机 `/etc/docker/daemon.json` |
| preflight | 目标版本的 `host-preflight.sh`，另查内核 IPv6（docker-socket-proxy 绑 `[::]:2375`） | `host-preflight.md` |
| 检出 | 本仓库的本地克隆，停在 `--from` tag | `host-checkout.md` |
| 主机初始化 | `--from` 版本自己的 `host-bootstrap` / `host-env-init` / `host-llm-proxy-init` / `gen-handle-keys` / `derive-internal-tokens` | `README.md` ① |
| `.env` | `KERNEL_BIND_ADDR=127.0.0.1`、文档网段 `203.0.113.0/24` / `203.0.114.0/24`、`WORKER_RUNTIME`、`COMPOSE_FILE` 加 staging overlay | 主机自己的 `.env` |
| 镜像 | `--from` 的 `pull-images.sh`（cosign 验签） | `apply-release.sh --pull` |
| 迁移 | `migrate.js` | 同 |
| 运营者一次性状态 | 建 `staging` 工作区；`ops-assets-v1/v2` 放进 `config/ontology/` 并 `seed-domain-pack`；`issue-service-handle` 写采集器 token；`config/egress-sources.json` 交给 uid 10001；docker 门实例 `discovered → enabled` | `add-domain-pack.md`、`host-collector.md` §1–2、`host-worker-runtime.md` §4、集成页启用门实例 |
| 基线 | `--from` 自己的 S3 → S1 → S2 → S4（让待测迁移面对非空表，也证明这台主机本身等价） | 主机上次发版时的验收 |
| apply | 与 `release.md` §3 同一入口：`git show <to>:scripts/apply-release.sh` 取出**目标版本自己的**副本，在检出根目录跑 `sh <副本> [--pull] <to>`：dump → 检出 → 镜像（tag 拉取 / 否则源码构建）→ 迁移 → up → 目标版本 S3 → S1 → S2 → S4 → backup / 保留策略 | `release.md` §3 |
| 控制台 file probe | 一次性平台管理员经 caddy 登录 → `issue_llm_admin_token`；假供应商写进 `config/llm-providers.yaml`、假 key 文件放进 `secrets/llm-provider-keys/`，llm-proxy 须列出它（`source: file`、读到 key）且 `gen-models` 输出它，随后恢复原样（零 token） | `README.md` ①、`host-env-init.sh` |
| 真实模型（可选） | 走控制台路径加供应商（管理员登录 → `issue_llm_admin_token` → `/api/llm-admin` 建供应商、设 key → llm-proxy 重写 models.json → 控制台"测试"）→ `accept_s2/s3.sh --real` | `host-accept-real-model.md` |

staging overlay（写在数据目录 `staging/docker-compose.staging.yml`，不在检出里，所以对 from / to
两个版本都生效）只做一件事：把 `gatekeeper-ragflow` 移到一个不启用的 profile——预演环境没有
RagFlow 上游，它会因 `RAGFLOW_BASE_URL` 未设一直重启。验收脚本自己用显式 `-f` 起服务，不读
overlay，这不影响它们（它们从不启动 RagFlow 门）。

非 tag 的目标（PR、main）会得到一个本地、从不推送的 tag `vA.(B+1).0-staging.<sha>`，因为
`apply-release.sh` 只接受 tag；脚本退出时删除。`KERNEL_VERSION` 因此显示这个 tag，仅展示用。

## 3. 怎么跑

### 3.1 自动触发

PR 或 main push 改到发布路径（`packages/kernel/migrations/**`、`docker-compose.yml`、
`scripts/{apply-release,pull-images,build-images,host-*,accept_s*,staging-rehearsal}.sh`、
`scripts/lib/**`、`deploy/accept/**`、本 workflow）时自动跑：from = 目标之下最新的 `vX.Y.Z`，
to = PR 合并提交 / main 头，带基线。不是 required check，但审查线程按"全部检查绿"规则等它。
同一 PR 的新推送会取消它上一轮；main push 排队、不互相取消；每次手动触发自成一组，不会被任何推送取消。

### 3.2 手动（workflow_dispatch）

Actions → `staging` → Run workflow：

| 输入 | 含义 |
|---|---|
| `to` | 空 = 选中的分支头；`vX.Y.Z` = 已发布 tag，用已签名镜像（`--pull`）预演发版本身 |
| `from` | 空 = `to` 之下最新 tag（即生产当前版本，前提是生产没落后） |
| `worker_runtime` | `auto`（preflight 结论）/ `runc` / `runsc`——**与生产主机 `.env` 保持一致** |
| `seed` | 默认开；关掉省一轮基线时间，但迁移只面对空表 |
| `real_model` / `runs` | 见 §4 |

### 3.3 本地（任何一次性 Linux + Docker 主机）

```bash
# 以 root，在本仓库完整克隆（含 tag）的根目录
sh scripts/staging-rehearsal.sh --disposable-host --from v0.42.0 --to HEAD --work /srv/staging
```

脚本拒绝已有 `nexttime-ai` 容器的主机和非空的 `--work`。**不要在生产主机上跑。**

## 4. 真实模型回归

只在手动触发且 `real_model: true` 时跑，job 进入 `staging-real-model` environment。一次性设置
（仓库 Settings → Environments）：

1. 新建 environment `staging-real-model`，Deployment branches 限制为 `main`，**不设 required reviewer**。
   这是有意的取舍（2026-10-09 维护者决定）：真实模型回归要能长期自动跑，不依赖人工点批准。花钱的边界由系统
   控制兜住，而不是靠审批：①只能从 main 触发（environment 的 deployment branch，`plan` 再核对 `GITHUB_REF`）；
   ②被测版本只能是存在的 `vX.Y.Z` tag 或 main 上的提交（见下）；③`runs` ≤ 10；④触发者填写的每个验收工作区
   每日 token 配额 `token_budget`（见"成本上限"），只接受 1–10000000 的整数——内核把 `0` 当作不限额，`plan`
   直接拒绝 `0`、负数、小数和超出上限的值（`staging-rehearsal.sh` 自己也拒绝）；⑤同一时间只跑一个真实模型
   run：`plan` 发现本 workflow 还有未结束的 `+ real model` dispatch 就失败。
   这几道都只管单次运行：每次 run 都是全新的 runner 和数据库，"每日"配额每次都从零算。多次先后运行的累计
   花费没有平台侧上限，靠供应商账户侧的额度或消费限制兜底。
2. 在该 environment 下加三个 secret：
   - `STAGING_LLM_PROVIDERS_YAML`：一份完整的 `llm-providers.yaml`（格式见
     `config/llm-providers.example.yaml`；`upstream_base_url` 必须是公网可达的——runner 到不了内网）；
   - `STAGING_LLM_PROXY_ENV`：每个 `api_key_env` 一行 `NAME=value`（允许 `export ` 前缀、引号和行尾 ` # 注释`）；yaml 只有一个
     `api_key_env` 时也可以只放 key 本身。开跑前先校验——缺哪个名字就以计数报错退出，不打印名字和值；
   - `STAGING_REAL_MODEL`：`<provider/model>`，必须是上面 yaml 生成的 `models.json` 里的 id。
3. 从 **main** Run workflow，勾 `real_model`，`runs` 填 3（冒烟）或 10（每次发版的例行回归，上限 10）。
   再勾 `extended` 会加跑 `accept_s2.sh --extended` 的六个场景（`host-accept-real-model.md` §4），
   花费约三倍，job 超时相应从 180 放宽到 330 分钟。

被测版本受限：`to` 只能是存在的 `vX.Y.Z` tag（只核对格式与 tag 存在，不核对是否为 GitHub Release、是否在 main 上）或已经在 main 上的提交（留空 = main 头），否则 `plan`
job 直接失败，不进入 environment。`plan` 不在 environment 里，先于真实模型 job 跑完：run 名称与它的 job 摘要里写着
from / to / 提交 sha / runs / 配额——要跑的就是这一行；之后 `rehearsal` 开头再核对 sha，不一致就失败。

成本上限：真实模型阶段开始前，脚本把内核自己的每工作区每日 token 配额 `LLM_DAILY_TOKEN_BUDGET` 设为
`token_budget`（默认 3000000）并重建 kernel——超额的工作区由 llm-proxy 直接拒绝（平台既有的预算机制，
见 `operations.md` 遗留 19 一节），而不是靠场景自己收敛。`token_budget` 必须是 1 到 10000000 的整数——内核把 0 当成不限额，`plan` 直接拒绝；同一时间只允许一个真实模型
run（`plan` 查本 workflow 未结束的 `+ real model` dispatch，有就失败），避免并发叠加花费。每个验收脚本用自己的一次性工作区，所以单次
回归的上界约为"验收脚本数 × 配额"。

真实模型的供应商走的是控制台那条路，与管理员在"添加 LLM 供应商"页面上做的完全一样，不写 `config/llm-providers.yaml`，
不放 key 文件，也不跑 `gen-models`：脚本用 bootstrap CLI 建一个一次性平台管理员 `staging-llm-admin`（随机密码，经 stdin），
经 caddy 登录（`/api/auth/login`），调 `issue_llm_admin_token` 拿 5 分钟 token，再对 `/api/llm-admin/providers` 逐个建供应商
（`STAGING_LLM_PROVIDERS_YAML` 只是输入格式，先过 llm-proxy 自己的 schema），用 `PUT …/secret` 设控制台 key，确认 llm-proxy
自己重写了 models.json（`modelsJsonError` 为空），最后对被测模型跑一次控制台的"测试"（一次真实补全加一次工具调用往返，
`STEP real-setup console providers=… test HTTP … completion=… tool_call=…`），两项都 `ok` 才继续。密码、token、key
只经 stdin 或 0700 目录里的 0600 文件，不上命令行。阶段结束时脚本让这个管理员登出（撤销它的 session），密码只存在于脚本
的 shell 里，之后这个账号无人能登录。

每次预演（不论是否带真实模型）在升级之后都经控制台跑一次零 token 的 file probe，覆盖生产主机上的另一条路（`config/llm-providers.yaml` 加
`secrets/llm-provider-keys/<api_key_env>` 的 key 文件，R-24）：写一个假供应商（上游 `.invalid`，不发任何请求）和一个按
`host-env-init.sh` 约定权限的假 key 文件，重建 llm-proxy，要求控制台列表里它是 `source: file` 且读到了 key、`gen-models` 也输出它
（`STEP file-probe providers HTTP … listed-with-key=… gen-models=…`），之后把 yaml 和 key 目录恢复原样；不带真实模型时
临时管理员随即登出。

真实模型阶段开始前，`--real` 的值必须是不含空白和控制字符的 `<provider>/<model id>`（入参检查，秒级失败）；
llm-proxy 写出 models.json 后，脚本确认这个 provider 和模型都在其中（`STEP real-setup models.json providers=… provider_present=… model_present=…`，
不打印名字），否则直接失败——内核的 bootstrap CLI 不校验 `--entry-model`，而 pi 遇到它不认识的 provider 会在启动时退出（与 pi 内置 provider 同名但 models.json 里没有的，则绕过 llm-proxy、因无 key 失败）。
`accept_s2.sh --real` 的冒烟 Turn（`real-smoke`）失败时，它的 `DIAG` 行（入口容器状态与输出末尾，已脱敏）会转印到 job 日志，
`accept_s3.sh --real` 不再运行。

真实模型阶段跑完打印一行 `STEP real-usage calls=… input_tokens=… output_tokens=… cache_read_tokens=… cache_write_tokens=… cost_usd=…`：取自内核自己的 `llm_usage` 账本，只算真实 provider（不含脚本随后在 fake provider 上跑的部分），不含 provider / 模型名；`cost_usd` 只在 providers yaml 给模型配了 `cost` 时非 0。控制台"测试"直连上游、不经 proxy，不计入这一行，也不受 `token_budget` 约束（两次很小的调用）。runner 跑完即销毁，这一行是唯一留下的用量记录。

secret 缺任何一个时，真实模型部分在 job 摘要里标 **SKIPPED** 并打 warning，不会显示为通过；预演本身
照常运行、照常判定。

日志与 artifact 是公开的：workflow 对模型 id、它的两段、yaml 里的 provider 名与上游 URL、
`STAGING_LLM_PROXY_ENV` 里每个 ≥ 8 字符的值（即 API key 本身）做 `::add-mask::`，上传前对日志文件
逐一替换成 `<redacted>`——GitHub 的 secret 打码只作用于 job 日志，不覆盖 artifact。读数规则同 `host-accept-real-model.md`
§5（`REAL scenario=… ok=k/n`），计数记录规则同其 §6——供应商与模型名仍只进 `docs/private/`。

## 5. 仍然只能在生产主机上做的事

| 项 | 为什么预演覆盖不了 |
|---|---|
| 生产数据上的迁移 | 预演的表由基线验收填充，形状接近但不是生产数据；`release.md` 里针对既有数据的 preflight SQL（如 §3.7/§3.8 类检查）仍在主机跑 |
| RagFlow 门与 S4 的 ragflow 部分 | 没有 RagFlow 上游；预演的 S4 只覆盖 docker 门 |
| 局域网 / 路由侧、主机上其他服务 | runner 是孤立的公网 VM |
| 长期运行性质 | 重启恢复、夜间备份计划、日志与磁盘增长——runner 跑完即销毁 |
| 生产上的回滚 | 预演只证明前滚；回滚演练见 `drill-upgrade.sh`（在主机或另一台一次性主机上） |
| 发版授权 | 预演绿不等于可以上生产；生产 apply 仍需维护者明确同意 |

## 6. 怎么读输出

与 `apply-release.sh` 同格式：每步一行 `STEP …`，停止时 `FAIL <step>`，最后一行
`RESULT ok` / `RESULT failed-at=<step>` / `RESULT acceptance-failures=<n>` /
`RESULT real-model-failures=<n>`，只有 `RESULT ok` 退出 0。`STEP apply | …` 是
`apply-release.sh` 自己日志里的行。完整日志在 artifact `staging-logs`（保留 7 天）：
`baseline-<from>-s{1..4}.log`、`apply-<tag>-<ts>[-sN].log`、`compose-logs.txt` 等。

## 7. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `FAIL preflight … IPv6 disabled` | 主机内核关了 IPv6，docker-socket-proxy 起不来 | 换主机；GitHub runner 没有这个问题 |
| `STEP baseline-… RETRY once` | `--from` 版本自己的一项验收第一次没过、重跑一次（只对基线；apply 阶段的验收从不重跑）。已知原因：真实 agent-host 运行时下 kernel 并发处理同一 Turn 的 `message` 与 `turnEnded` 帧，`chat.metadata`（Turn 结束）可能先于助手消息入库推给客户端，`accept_s1` 的 `chat-bob` 读到 1 条历史 | 第一次的日志保留为 `baseline-…-try1.log`；同一项连续两次失败才算基线失败 |
| `FAIL baseline …` | `--from` 版本在这台主机上就过不了验收——环境与生产不等价，预演结论不可信 | 读 `baseline-*.log`；确认是环境差异后可 `--allow-baseline-failures`，并在结论里写明 |
| S1 `chat-alice` 失败、入口容器日志 `fetch failed` | `WORKER_RUNTIME=runsc` 而 runsc 用 gVisor 默认网络栈注册：它访问不到 Docker 内嵌 DNS（`127.0.0.11`，gVisor FAQ 列出的限制），入口容器解析不了 `kernel` / `llm-proxy` | 按生产主机的方式注册：`runsc install -- --network=host`（`daemon.json` 里 `runtimes.runsc.runtimeArgs=["--network=host"]`），workflow 已这样装 |
| S3 `seed-domain-pack` 失败 | `config/ontology/` 里没有 `ops-assets-*.yaml` | 预演脚本已复制；主机上按 `add-domain-pack.md` 放入 |
| S1/S2 egress 探针失败、egress-proxy 日志 `unknown-source` | `config/egress-sources.json` 是 `host-env-init.sh` 建的 root 文件，worker-supervisor（uid 10001）写不进入口容器的来源登记 | 基线前预演脚本按 `host-worker-runtime.md` §4 `chown 10001:10001`（`--from` 版本需要）；若目标版本的 `apply-release.sh` 自己管这一步（`STEP egress-sources`，#491 起），apply 前把文件还原成 root 0644，由产品步骤负责、apply 后的验收来证明 |
