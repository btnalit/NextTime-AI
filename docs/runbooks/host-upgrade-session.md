# Runbook：host-upgrade-session（主机升级会话：常设规则、阶段、结果块）

对应交付物：`scripts/host-upgrade-brief.mjs`（出简报）、`docs/runbooks/release.md` §3（每个版本的主机步骤）、
`docs/runbooks/staging-rehearsal.md`（演练）。上位流程见 `dev-loop.md` §8。

主机升级只在维护者本地的会话里做。这份手册是那个会话每次都适用的部分：规则、阶段顺序、最后交回什么。
每次不同的部分（从哪版到哪版、几个迁移、读哪些小节、哪几步要维护者本人）在升级简报里，简报由脚本算出。

## 1. 怎么开始

维护者在主机检出目录的本地会话里，给出本次的升级简报，并说明按本手册执行。检出目录此时还在旧版本上，
先把目标版本的文件取到项目里 gitignored 的 `docs/private/`（本手册在目标 tag 上没有时，取 `origin/main` 的）：

```
git fetch -q origin --tags
mkdir -p docs/private/upgrade-vX.Y.Z
git show vX.Y.Z:docs/runbooks/release.md > docs/private/upgrade-vX.Y.Z/release.md
git show vX.Y.Z:scripts/apply-release.sh > docs/private/upgrade-vX.Y.Z/apply-release.sh
```

之后的 `--prefetch` 与 `--pull` 都从检出目录的根用这份 `apply-release.sh` 跑。

## 2. 规则（整个会话都适用）

1. **流程以目标 tag 的 `release.md` 为准。** 简报只说读哪些节、什么时候做；SQL 和命令照节里的原文执行。
   简报与手册不一致时以 `release.md` 为准，并告诉维护者。
2. **只读，除非步骤写明要改。** SQL 的执行方式、用哪个数据库角色，见 `release.md` §3 开头「本节命令的执行方式」。
3. **不碰项目目录之外的任何东西**，不碰主机上其他既有服务。会话自己不在项目目录外写文件；
   `apply-release.sh` 运行时在系统临时目录放一份自身的副本并在结束时删掉，是它的设计，不算例外之外的改动。
4. **结果记进 `docs/private/`**（新文件，带日期）：每条查询的计数、每一步的 `RESULT` 行、日志文件名、审计 id。
   不记密钥、token、Handle、key 的值或片段；对话里同样只说计数和 id。
5. **被本地权限检查拦下就停**，等维护者在这个会话里批准，或由他自己加允许规则；不换写法重试，不自己加规则。
6. **成败只看日志最后一行 `RESULT …`**，退出码不算数：`RESULT ok` 没有剩下的事；`failed-at=<step>` 停下报告；
   `acceptance-failures=<n>` 读各套验收日志后按 `release.md` §5 判断是否回滚，交维护者决定；
   `degraded=…` 按 `release.md` §3.26 的表逐项补做。
7. **维护者本人的步骤不代做。** 要登录控制台的步骤、密钥轮换、撤销授权这类终态操作由他本人做，
   不索取管理员凭据；要他决定的事，先把事实摆出来，等他回答。
8. **破坏性验收只在维护者当场明确同意后跑**，不同意就记「staging 代替，主机未跑」。
9. **三条底线**：agent 和内核进程不持凭证；有凭证的动作都要审批；隔离与审计只增不减。
   任何一步要绕过其中一条，停下问维护者。

## 3. 阶段

每个阶段结束时停下，告诉维护者结果和下一步要他做什么。

| 阶段 | 做什么 | 停下的条件 |
|---|---|---|
| 1 起点确认（只读） | `git describe --tags --exact-match` 等于简报的起点；数 `schema_migrations`；`scripts/check-backup-freshness.sh`；记下在跑的服务与镜像 tag | 起点不符、备份不新鲜 |
| 2 核对演练 | 打开简报里的 staging run，确认是这条路径、是绿的；简报标「staging 未覆盖」的项记下来，留到主机上看 | 没有这条路径的绿演练 |
| 3 窗口前 | `--prefetch` 预拉并验签；简报里「窗口前」的小节逐节照原文做只读预检 | 有会挡住升级的结果：交维护者处理完再进窗口 |
| 4 窗口内 | 先告诉维护者被拦下会停、哪些表会被锁；后台跑 `--pull` 并跟日志；不另跑构建，不单独重启服务 | `RESULT` 不是 `ok`：按规则 6 |
| 5 应用后 | 简报里「应用后」的小节逐节核对，结果记 `docs/private/` | 核对不符 |
| 6 维护者本人步骤 | 把要他做和要他决定的事列成清单交给他，等他做完后复核只读的部分 | — |
| 7 结果块 | 打印 §4 的结果块 | — |

## 4. 结果块（交回云端的唯一内容）

会话最后打印下面这一块，维护者把它贴回项目。只含可以公开的内容：没有主机别名、地址、路径、密钥或外部系统的 id。

```
host-result
from: vA.B.C
to: vX.Y.Z
appliedOn: YYYY-MM-DD
result: RESULT ok
migrations: <升级前行数> -> <升级后行数>
acceptance: S3 <过>/<败>, S1 <过>/<败>, S2 <过>/<败>, S4 <过>/<败>
rehearsal: <staging run id>
maintainer-steps: <做完 | 还差：…>
followups: <无 | 一行一条，只写现象与对应的 release.md 节号>
```

合并线程据此在一个记录 PR 里更新 `docs/state/loop.json` 的 `host`（版本与日期）和 `docs/STATUS.md`。
`result` 不是 `RESULT ok` 时不更新主机版本，先处理 `followups`。

## 5. 回滚

按目标 tag 上 `release.md` §5；迁移是否可逆见 §6。回滚由维护者决定，会话只提供事实：
停在哪一步、数据库迁移到哪、哪些验收失败。
