# 测试策略

对应任务：development-tasks.md § S3.10（"`docs/testing.md`：设计 §7.10 的测试分层与每层的运行命令"）。
设计依据：`docs/graph-ai-middle-platform-design.md` §7.10 "测试分层"（本文档末尾原文引用）与 §7.10
"六层单向依赖"表（domain / substrate / governance / application / adapters / interfaces）。

本文档只回答"每层怎么跑、CI 在哪一步跑、本地没有 Docker 时能跑什么"——不重复设计文档已经写好的分层
理由。

## 1. 目的

设计文档 §7.10 原文：

> **测试分层**：domain 用纯单元测试（转移表穷举）；substrate 与 governance 用内核 + Postgres 集成
> 测试；平台扩展与 gatekeeper 基类用契约测试（pi faux provider、fake 系统）；接口层用生成式一致性
> 校验；端到端用 Playwright 与三个验收脚本。每层的失败都能定位到一层。

下表把这五层映射到本仓库真实存在的命令、它们在 `.github/workflows/ci.yml` 三个 job（`quality` /
`test` / `guards`）里的落点，以及本机没有 Docker 时能跑到哪一层。

| 层 | 覆盖范围（本仓库的包/文件） | 命令 | CI job | 本机无 Docker 时 |
|---|---|---|---|---|
| ① domain 单元测试 | `packages/shared`（枚举、转移表、capability 注册表、Zod schema） | `pnpm --filter @nexttime/shared test` | `test` | 能跑，全部能跑 |
| ② substrate/governance 集成测试 | `packages/kernel`（`substrate/*`、`governance/*`、`application/*` 里 `describe.runIf(DATABASE_URL)` 的套件） | `sh scripts/test-db.sh` 起临时 Postgres → `DATABASE_URL=... pnpm --filter @nexttime/kernel test` | `test`（用 GitHub Actions 自带的 `postgres:` service container） | 纯单元部分能跑；DB-gated 套件被 `runIf` 跳过（不是失败），见 §5 |
| ③ 契约测试 | `packages/platform-extension`（`*.sdk.test.ts` 用真实 pi SDK）、`packages/gatekeeper-base` + `gatekeepers/{docker,ragflow}`（fake 系统/假 dockerode） | `pnpm --filter @nexttime/platform-extension test`、`pnpm --filter @nexttime/gatekeeper-base test`、`pnpm --filter <gatekeepers 包> test` | `test` | 能跑——这些测试用内存假桩/pi 的 SDK 内存态，不连真实 Docker 或真实门实例 |
| ④ 接口层一致性校验 | `packages/shared` 的 capability 注册表 → `docs/contracts/{capabilities,events}.json` 快照；`scripts/guards/vocabulary.mjs` 词表守卫 | `pnpm contract:check`、`node scripts/guards/vocabulary.mjs`（先 `node --test scripts/guards/vocabulary.test.mjs` 跑守卫自身的单测） | `quality` | 能跑（纯 Node 脚本，读编译产物，不需要 Docker） |
| ⑤ 端到端 | 三个主机验收脚本 `scripts/accept_s{1,2,3}.sh`（`accept_s3.sh` 是 S3.9 交付物，本次改动时尚未落地，见 §4）；`packages/web` 的 Playwright（`pnpm --filter @nexttime/web e2e`，opt-in） | 见 §4 | 均**不在** CI（无 `e2e` job；两者都需要真实 Docker/主机） | 不能跑——两者都需要真实容器（入口容器、Worker 容器、门服务） |

`pnpm -r test`（`make test`；`.github/workflows/ci.yml` 的 `test` job 跑
`pnpm --no-bail -r test`）一次性跑①②③层里每个包各自的 `vitest run`——②层的 DB 套件是否真的执行
取决于 `DATABASE_URL` 是否设置（见 §2、§5），不是这条命令本身区分层。

## 2. 前置条件

- Node 22 + pnpm（`packageManager` 字段钉死版本，`corepack pnpm ...` 或 CI 用的 `pnpm/setup`）。
- `pnpm install --frozen-lockfile`。
- ②层要跑真的 DB 套件、⑤层要跑主机验收/Playwright：需要 Docker（本机做本任务时没有 Docker，见
  `docs/development-tasks.md` §0.3；`scripts/test-db.sh` 检测不到 Docker 会打印提示并 exit 0，
  不会让整个 `make ci` 失败）。
- ④层的 `contract:check`/`contract:snapshot` 需要先 `pnpm --filter @nexttime/shared build`
  （两个 npm script 自己已经带了这一步，不需要手动先跑）。

## 3. 步骤：本地跑一遍完整分层

```bash
cd <CODE_DIR>
pnpm install --frozen-lockfile

# ① domain
pnpm --filter @nexttime/shared test

# ② substrate/governance —— 起一个临时 Postgres（幂等；无 Docker 时打印提示后 exit 0，不阻塞）
sh scripts/test-db.sh
# 上一步打印的连接串变量名是 TEST_DATABASE_URL（仅供人读），kernel 的 vitest 配置实际读的环境变量
# 是 DATABASE_URL —— 用同一个值导出这个名字（docs/testing.md §5 记录过这个容易踩的名字不对齐）：
export DATABASE_URL="postgres://nexttime:nexttime@127.0.0.1:55432/nexttime_test"
pnpm --filter @nexttime/kernel test
# 不需要单独跑一次 migrate——每个 DB-gated *.integration.test.ts 文件自己在 beforeAll 里调
# runMigrations（一个空库即可，migrate 是幂等的）。

# ③ 契约测试（pi 真实 SDK / fake 系统，不需要 Docker）
pnpm --filter @nexttime/platform-extension test
pnpm --filter @nexttime/gatekeeper-base test
pnpm --filter <gatekeepers/docker 或 gatekeepers/ragflow 的包名> test

# ④ 接口层一致性
node --test scripts/guards/vocabulary.test.mjs   # 守卫检测器自身的单测
node scripts/guards/vocabulary.mjs               # 词表守卫本身——读 packages/shared 的构建产物，
                                                  # 先跑一次 `pnpm --filter @nexttime/shared build`
pnpm contract:check                              # 快照 diff；注册表变了但没跟着跑 contract:snapshot
                                                  # 会在这一步报错并提示怎么修

# 其余每包共有的门槛（对应 Makefile 的 ci 目标）
pnpm -r lint
pnpm -r typecheck
pnpm -r build
pnpm depcruise
pnpm ci:guards        # kernel purity + pi 版本一致性 + membership-capabilities guard + 词表守卫
                       # + shell 脚本 LF/可执行位（gitleaks 与内网 IP 字面量守卫只在 CI guards job 跑，
                       # 见 .github/workflows/ci.yml，本地没有等价单条命令）
```

一次性跑到 CI 三个 job 会跑的全部内容（不含 ⑤ 端到端，那两个不在 CI 里）：`make ci`
（`lint typecheck test build depcruise` + `pnpm ci:guards`）—— 但 `make ci` 不会自动起临时 Postgres，
先跑 §3 里的 `test-db.sh` + 导出 `DATABASE_URL` 再跑 `make ci`，否则②层的 DB 套件全部被跳过（见
§5，跳过不是失败，`make ci` 仍会显示绿）。

## 4. ⑤ 端到端：三个验收脚本与 Playwright

- `scripts/accept_s1.sh`、`scripts/accept_s2.sh`：见 `docs/runbooks/accept-s1.md`、
  `docs/runbooks/host-accept-s2.md`——本文档不重复，只记录它们在测试分层里的位置：这两个脚本是
  §7.10 五层里唯一验证"真实 Docker 容器 + 真实 pi 进程 + 真实门服务"这条链路端到端可用的一层，
  其余四层都用假桩/内存态/DB 集成测试替代了真实容器。
- `scripts/accept_s3.sh`：development-tasks.md § S3.9 的交付物；写本文档时**尚未落地**
  （`scripts/` 目录下还没有这个文件）——S3.10 本身依赖 S3.9（development-tasks.md 原文："依赖：
  S3.9、S1.12"），本文档先把它在分层表里的位置占住，脚本本身与对应 runbook 由 S3.9 任务交付。
- `packages/web` 的 Playwright（`pnpm --filter @nexttime/web e2e`）：独立 opt-in，需要
  `WEB_E2E_BASE_URL`/`WEB_E2E_API_KEY` 指向一个已跑起来的、`AGENT_RUNTIME=fake` 的内核（见
  `packages/web/README.md`"已知偏离"一节、`docs/runbooks/accept-s1.md` §5）。development-tasks.md
  的 S3 实施波次表 W1-D 项计划把它接进 CI 的独立 `e2e` job（用 compose 精简 profile 起
  `postgres+kernel+caddy+fake-llm`）——写本文档时**尚未落地**，`.github/workflows/ci.yml` 目前
  只有 `quality`/`test`/`guards` 三个 job，没有 `e2e`。

## 5. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `pnpm --filter @nexttime/kernel test` 全绿，但看起来只跑了几十个测试、很快就结束 | 没有设置 `DATABASE_URL`——所有 `describe.runIf(DATABASE_URL !== undefined)` 的 DB 集成套件被跳过（vitest 报 skipped，不是 failed，整体退出码仍是 0） | 这不是 bug，是设计（§7.10"每层的失败都能定位到一层"——②层就是需要真实 Postgres 才能验证的那一层）；要真的跑到它们，先 `sh scripts/test-db.sh` 再 `export DATABASE_URL=...` |
| `scripts/test-db.sh` 打印完连接串信息后，`DATABASE_URL` 还是没生效 | 脚本只是**打印**一行 `TEST_DATABASE_URL=...`（供人读），不会、也不能修改调用它的 shell 的环境——它在自己的子进程里跑 | 手动 `export DATABASE_URL="<脚本打印的那个值>"`（注意变量名不同：脚本打印的是 `TEST_DATABASE_URL`，kernel 的 vitest 配置实际读的是 `DATABASE_URL`） |
| 起了临时测试 DB 之后，`kernel` 的多个测试文件互相干扰（一个文件的 outbox consumer 吃了另一个文件的事件） | `packages/kernel/vitest.config.ts` 自己的注释已经记录：`DATABASE_URL` 设置时把 `fileParallelism` 关掉（串行跑测试文件），因为 DB-gated 套件共享同一个数据库、部分套件会起一整个内核（outbox dispatcher + FakeAgentRuntime）消费所有 workspace 的事件 | 不需要手动处理——这是 vitest 配置已经做好的行为；如果看到跨文件干扰，先确认没有绕过 `pnpm --filter @nexttime/kernel test` 自己去手写并行调用 vitest |
| `pnpm contract:check` 报 "drift" 但看不出改了什么 | `packages/shared/src/capabilities.ts`（或 `events.ts`）的注册表内容变了，但没有跟着重新生成 `docs/contracts/{capabilities,events}.json` 快照 | 跑 `pnpm contract:snapshot`，把新生成的 `docs/contracts/*.json` 一并提交进同一个 PR |
| `node scripts/guards/vocabulary.mjs` 报错说读不到某个模块 | 这个守卫读的是 `packages/shared` 的**编译产物**（`dist/`），不是源码——`quality` job 在它之前有一个独立的 `Build` 步骤 | 本地先跑 `pnpm --filter @nexttime/shared build`（或 `pnpm -r build`）再跑这条守卫 |
| CI 的 `test` job 里，某个包测试失败了，但日志里还看到其它几个包看起来"正常跑完" | `pnpm --no-bail -r test`（`.github/workflows/ci.yml` 自己的注释：pnpm 默认递归模式一个包失败就 kill 掉其它还在跑的包，曾经因此把 kernel 的 DB 集成套件的真实失败盖在了另一个不相关包的失败后面） | 找每个包各自的完整输出，不要只看第一条失败——job 的整体 pass/fail 不受这个 flag 影响，仍然是"任何一个包失败则整体失败" |
| `KERNEL_VALIDATE_RESULTS` 是什么、要不要手动设 | `packages/kernel/vitest.config.ts` 与 CI `test` job 都已经把它设成 `1`——`dispatchCapability` 在这个值为 `1` 时会把每次 dispatch 的真实返回值过一遍该 capability 自己的 `resultSchema.safeParse`，不匹配抛内部契约错误（S3.7）。本地跑 `pnpm --filter @nexttime/kernel test` 已经自动带上；生产环境**不设**这个变量（零运行时开销） | 不需要手动设置；只有在本地不经过 `pnpm --filter` 直接调 `vitest` 时才需要自己加 |
| 想验证"真实 pi SDK 有没有变"，但没有环境跑 `*.sdk.test.ts` | 这两个文件（`entry.sdk.test.ts`/`worker.sdk.test.ts`）就是 `pnpm --filter @nexttime/platform-extension test` 的一部分，不需要额外环境——它们 import 真实 `@earendil-works/pi-coding-agent`/`@earendil-works/pi-ai`，在内存里跑，不需要 Docker | 见 `docs/runbooks/pi-upgrade.md` §5"兼容性测试清单"——同一套命令 `.github/workflows/pi-drift.yml` 每晚对 `@latest` 也跑一遍 |

## 6. 回滚 / 清理

- `scripts/test-db.sh` 起的临时容器名固定为 `nexttime-test-db`（`TEST_DB_CONTAINER_NAME` 可覆盖）：
  `docker rm -f nexttime-test-db` 清理；脚本本身在下次运行时也会先 `docker rm -f` 同名容器再重建，
  不需要手动清理就能重复跑。
- `docs/contracts/*.json` 快照、`.dependency-cruiser.cjs` 结果、`scripts/guards/*` 都是只读校验，
  没有产生需要回滚的持久状态。
