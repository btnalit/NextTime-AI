# 脱敏验收（redaction-fuzz）

脱敏换边界设计（`docs/redaction-boundary-design-2026-11-27.md`）§4.4、§7 阶段 1a、§8 的验收工具。
只是测试代码：不进 `src`、不进 dist，也不在内核的 `pnpm test` 里——它要读上一发布版的源码，由 `run.mjs` 取。

## 怎么跑

```sh
node packages/kernel/test/redaction-fuzz/run.mjs                     # CI 的小样本：每个生成器 2,000 行 × 种子 7、8
node packages/kernel/test/redaction-fuzz/run.mjs --seeds 1,2,3,4,5 --rows 20000   # 席位跑全量
node packages/kernel/test/redaction-fuzz/run.mjs --generators formats/yaml,kernel/kv9 --report /tmp/r
node packages/kernel/test/redaction-fuzz/run.mjs --mutations         # 逐个打变异补丁，每个都必须让验收失败
node packages/kernel/test/redaction-fuzz/run.mjs --list              # 生成器与变异的名字
```

参数见 `run.mjs` 开头的注释。基线默认是上一发布版：不比 `.release-please-manifest.json` 的版本新的最新 tag
（release PR 已经写了它要发的版本，那个 tag 还不存在，所以和前一个比）。

`run.mjs` 用 `git archive` 把这个 tag 的 `packages/kernel/src`、`packages/shared/src` 取到 `.baseline/<tag>/`（已忽略），
本地没有这个 tag 就先从 origin 取。目录放在包里而不是系统临时目录：那里的 `zod`、`jose` 要能沿目录向上找到。
`vitest.config.ts` 把基线里的 `@nexttime/shared` 指到同一个 tag 的 shared，不用这次检出的。

## 量什么

每个生成器写出 `Row = { t, req?, spans? }`：`req` 是文本里要藏的值（每处出现都算），`spans` 是值写在哪里（真实格式语料用）。
同一行交给这次检出与上一发布版各读四遍：

| 读法 | 是什么 |
|---|---|
| 整段（whole） | `scrubSecretValues` |
| 实时流（stream） | `createSecretStreamScrubber`，按行自己的种子切 1–6 刀，两边切点相同 |
| 存量（stored） | 上一发布版整段读出的结果，再由各自的存量改写（`repairSplitQuotedMasks`，然后 `STORED_REWRITE_SECRET_PATTERNS`）读 |
| 再读（reread） | 各自整段读出的结果，再由自己整段读一遍 |

门槛是「由遮变露」0 行：某个值的字符这次检出露了、上一发布版遮了。字符算不算露，按输出与输入对齐来定
（`measure.ts` 的 `keptChars`）：输出按 `[redacted]` 切开，各段按顺序放在输入里最早能放的位置，一处遮可以遮住 0 个字符
（空的带引号的值写成 `"[redacted]"`）；对不上的输出，它的值的字符全部算露。

其余的数只报告、不设门槛：两边各有多少行露、这次多遮的行、整段输出不同的行、流比自己的整段多露的行、再读会变的行、
存量改写又改了自己写出的行、计数和文本对不上的行、对不上的输出。

## 生成器

| 组 | 来源 |
|---|---|
| `author/` | 内核作者验收 #1597、#1600 用的五个（release.md §3.220、§3.221） |
| `design/` | 设计 §5 实测用的四种权重的随机拼接与 JSON |
| `credentials/` | 凭据席位评审 #1593–#1600 时写的生成器 |
| `kernel/` | 内核席位评审 #1593–#1600 时的 kvgen4、7、8、9、10（从 Python 移植：同样的表与形状，不是同样的行） |
| `formats/` | 真实格式语料第一批：`.env`、YAML、INI、JSON、JSON 写在字符串里、shell 赋值与 `--flag`、PHP 与 Ruby 的 `=>` |

随机数是 mulberry32，按种子；比较前去重，报告里的行数是去重后的。真实格式里的值是运行时随机生成的，不在文件里。

## 真实格式语料的基线

`corpus-baseline.json` 记每种格式在 CI 小样本上这次检出整段读法露值的行数与字符数，验收要求不多于它。
设计的门槛是 0 个字符（§4.4 第 2 条），阶段 1b 与阶段 2 每降一次就重写这个文件：

```sh
node packages/kernel/test/redaction-fuzz/run.mjs --write-corpus-baseline
```

只许变小；变大说明有回退，评审时看这个文件的 diff。加一种格式：在 `generators/real-formats.ts` 加生成器，重写基线。

## 变异

`mutations/*.patch` 每个对 `src` 做一处小改动（相对仓库根，`git apply` 能打上）。`--mutations` 逐个打上、跑验收、再撤回：
每个都必须让验收失败，否则说明某种读法没被量到。补丁打不上（源码变了）报 stale，同样算失败，按新源码重做补丁。

| 补丁 | 改了什么 | 应在哪一列失败 |
|---|---|---|
| `whole-floor-off` | `withFloor` 不再用 v0.70.0 的读法兜底 | 整段 |
| `stream-name-not-held` | 流不再扣住还没等到值的密钥名 | 实时流 |
| `stored-named-values-as-written` | 存量改写不再读「遮罩后面还跟着词的其余部分」（遗留 937 的存量形式） | 存量 |

## 已知的局限

- 对齐取最早能放的位置。一段保留的文本如果在输入里出现两次，可能被放在前一处；生成器的值是长随机词，影响很小。
- 存量读法的输入只取上一发布版写出的行；本 PR 写出的行再用存量读法读，记在「存量改写又改了自己写出的行」里，不设门槛。
- 名字的覆盖不归这里量：语料里的名字都是名字规则认得的（`harness.test.ts` 核对），名字文法是设计的阶段 2。
