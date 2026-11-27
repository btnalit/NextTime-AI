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
node packages/kernel/test/redaction-fuzz/run.mjs --write-corpus-baseline   # 重写真实格式语料的基线（下文）
node packages/kernel/test/redaction-fuzz/run.mjs --write-stream-baseline   # 重写流与整段的基线（下文）
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
| 实时流（stream） | `createSecretStreamScrubber`，按行自己的种子切：两组各 1–6 刀，再加一组每 1–4 个字符一刀（像真实的 `textDelta`）；两边切点相同 |
| 存量（stored） | 上一发布版整段读出的结果，再由各自的存量改写（`repairSplitQuotedMasks`，然后 `STORED_REWRITE_SECRET_PATTERNS`）读；`stored/` 组的行本身就是以前版本存下的形式，直接交给存量改写，只读这一遍 |
| 再读（reread） | 各自整段读出的结果，再由自己整段读一遍 |

门槛是「由遮变露」0 行：某个值的字符这次检出露了、上一发布版遮了。字符算不算露，按输出与输入对齐来定
（`measure.ts` 的 `keptChars`）：输出按 `[redacted]` 切开，各段按顺序放在输入里最早能放的位置，一处遮可以遮住 0 个字符
（空的带引号的值写成 `"[redacted]"`）；对不上的输出，它的值的字符全部算露。`stored/` 组的行不对齐：存量改写会把
`[redacted]"…\"` 写成 `\"[redacted]\"`，不是「输入的一些段换成遮罩」。这些行按片段量（`shownInRuns`）：值里任意连续 8 个字符
（值不到 8 个字符就是整个值）原样出现在输出里，这几个字符就算露。

第二道门是「流与自己的整段不同」的行（表里的 `str≠w`，这次检出:上一发布版）：某组切点下流读出的文字与同一边
整段读出的文字不逐字相同。流比整段多遮也算在这里——「由遮变露」只数露，量不到它（内核席位评审 #1619：去掉引号后空白的扣留，
流只会多遮，原来的验收原样放过）。超过扣留上限的长行两边都与整段不同（流放一个 `[redacted]` 停下）。
这道门按 `stream-baseline.json` 卡，见下一节。

其余的数只报告、不设门槛：两边各有多少行露、这次多遮的行、整段输出不同的行、流比自己的整段多露的行、再读会变的行、
存量改写又改了自己写出的行、计数和文本对不上的行、对不上的输出。

## 生成器

| 组 | 来源 |
|---|---|
| `author/` | 内核作者验收 #1597、#1600 用的五个（release.md §3.220、§3.221） |
| `design/` | 设计 §5 实测用的四种权重的随机拼接与 JSON |
| `credentials/` | 凭据席位评审 #1593–#1600 时写的生成器 |
| `kernel/` | 内核席位评审 #1593–#1600 时的 kvgen4、7、8、9、10（从 Python 移植：同样的表与形状，不是同样的行） |
| `long/` | 内核席位评审 #1619 要的长行：行首前缀长于 8 个字符（带引号与不带），值长到 L（3,584）附近、扣留上限（4,096）附近和更长，带引号与不带；PEM 私钥（换行、CRLF、字符串里的 `\n`）。一行流式读一遍要一两秒，每个种子只读 6 行、8 行 |
| `stored/` | 同一评审要的「以前版本会写下的形式」：遗留 916、918 拆开的 `\"…\"` 值（`API_TOKEN=[redacted]"<值>\"`，`repairSplitQuotedMasks` 修的那种），遗留 950 的遮罩后面紧跟文本（`password="[redacted]"<值>` 及各种引号） |
| `formats/` | 真实格式语料第一批：`.env`、YAML、INI、JSON、JSON 写在字符串里、shell 赋值与 `--flag`、PHP 与 Ruby 的 `=>` |

随机数是 mulberry32，按种子；比较前去重，报告里的行数是去重后的。真实格式里的值是运行时随机生成的，不在文件里。

## 真实格式语料的基线

`corpus-baseline.json` 记每种格式在 CI 小样本上这次检出整段读法露值的行数与字符数，验收要求不多于它。
设计的门槛是 0 个字符（§4.4 第 2 条），阶段 1b 与阶段 2 每降一次就重写这个文件：

```sh
node packages/kernel/test/redaction-fuzz/run.mjs --write-corpus-baseline
```

只许变小；变大说明有回退，评审时看这个文件的 diff。加一种格式：在 `generators/real-formats.ts` 加生成器，重写基线。

## 流与整段的基线

设计 I-R3 (b)（§8）要「流与整段不同的行不多于上一版」。main 上做不到：13 个生成器 main 比 v0.70.1 多 1 到 23 行
（每个生成器 4,000 行）。v0.70.1 之后改过脱敏源码的只有遗留 948（#1600）；看过的例子都是流比整段多遮，
流比整段多露的行（`str>w`）两边一样多。门先按 main 卡：
`stream-baseline.json` 记每个生成器在 CI 小样本上这次检出的行数（`rows`）和上一发布版在同样的行上的行数（`atRelease`），
验收要求 `rows` 不变多。等一个带着 948 的版本发出来、`atRelease` 追上 `rows`，就可以改成直接和上一版比。

```sh
node packages/kernel/test/redaction-fuzz/run.mjs --write-stream-baseline    # 只认 CI 小样本、全部生成器
```

只许变小；加生成器时一起重写。这 13 个生成器多出来的行归遗留 920（实时流与整段不一致，阶段 1b 后重测）。

## 变异

`mutations/*.patch` 每个对 `src` 做一处小改动（相对仓库根，`git apply` 能打上）。`--mutations` 逐个打上、跑验收、再撤回：
每个都必须让验收失败，否则说明某种读法没被量到。补丁打不上（源码变了）报 stale，同样算失败，按新源码重做补丁。

| 补丁 | 改了什么 | 应在哪一列失败 |
|---|---|---|
| `whole-floor-off` | `withFloor` 不再用 v0.70.0 的读法兜底 | 整段 |
| `stream-name-not-held` | 流不再扣住还没等到值的密钥名 | 实时流 |
| `stored-named-values-as-written` | 存量改写不再读「遮罩后面还跟着词的其余部分」（遗留 937 的存量形式） | 存量 |
| `stream-bound-releases-raw` | 流到扣留上限时原样放出扣着的文本，而不是一个 `[redacted]` | 实时流（`long/`） |
| `stream-quote-blanks-not-held` | 流不再扣住引号后面的空白 | `str≠w`（流只多遮、不多露） |
| `stream-json-key-not-held` | 流不再扣住行尾可能还是 JSON 键的引号串 | 实时流 |
| `stream-pem-not-held` | 流不再从没有 `-----END` 的 `-----BEGIN` 起扣住 | 实时流（`long/pem`） |
| `stored-split-masks-not-repaired` | `repairSplitQuotedMasks` 什么都不做 | 存量（`stored/split-masks`） |

一个补丁要算「验收抓到了」，必须：打上后 `test/redaction-fuzz/tsconfig.json` 类型检查通过、每个测试文件都加载了、
`harness.test.ts` 通过、至少一个 `acceptance-*.test.ts` 的断言失败。编译不过、文件没加载或 harness 失败记为 broken，
和 stale 一样让 `--mutations` 以非 0 退出（内核席位评审 #1619 第 2 条）。

## 已知的局限

- 对齐取最早能放的位置。一段保留的文本如果在输入里出现两次，可能被放在前一处；生成器的值是长随机词，影响很小。
- 存量读法的输入是上一发布版写出的行，加上 `stored/` 组手写的旧形式；本 PR 写出的行再用存量读法读，记在「存量改写又改了自己写出的行」里，不设门槛。
- `long/` 每个种子只读几行：门槛对它们照样是 0，但覆盖靠的是行的种类，不是行数。全量跑（`--rows 20000`）也只多读种子数倍的行。
- 名字的覆盖不归这里量：语料里的名字都是名字规则认得的（`harness.test.ts` 核对），名字文法是设计的阶段 2。
