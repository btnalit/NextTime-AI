# Runbook：add-domain-pack（新增一个领域包）

对应任务：development-tasks.md § S3.10（"`docs/runbooks/`：新增一个领域包"；S3 实施波次表 W1-E
行）。设计依据：`docs/graph-ai-middle-platform-design.md` §7.10（"内容以两种包交付...**领域包**
`ontology/<domain>/`：`types.yaml`（ObjectType / LinkType / ActionType）、`skills/`、
`procedures/`、`workers/`"）、§5.1.2（本体/ObjectType/LinkType 概念）。

**先读这一段，再往下走**：development-tasks.md § S3.1（"本体注册表与本体 v1"）——
`identity_key`、`ActionType` 元数据、`validate_link` domain/range 强制校验、
`propose_ontology_change`/`publish_ontology_version` 的完整 propose→publish 生命周期——**写本文档
时尚未落地**（S3 实施波次表把它排在 W1-A，本次 S3.10 文档改动不依赖它完成，但"新增一个领域包"这件
事本身的**产品化程度**直接受它影响）。本文档如实记录：哪些今天就能做、哪些做了也没有地方接、哪些
字面上等 S3.1 落地才有意义——不假装一条尚未存在的能力已经可用。

## 1. 目的

给平台加一批新的领域概念（ObjectType/LinkType）与配套的可执行内容（Skill/Procedure/
WorkerDefinition），让 agent 能在这批新概念上工作——design §7.10 的"领域包"就是这两类东西的合集，
不是一等的运行时组件，是版本化的 YAML + 文件，走 git/PR，经 human 通道发布进图。

## 2. 现状核实（写本文档时的真实情况，不是设计意图）

### 2.1 本体 YAML——今天能写，但发布路径只有一条、且是硬编码的

`packages/kernel/src/substrate/ontology/loader.ts` 的 `OntologyDefinitionSchema` 是**唯一**已实现
的本体文件 schema：
```
objectTypes: [{ name, description }]
linkTypes: [{ name, domain, range, description }]
```
**没有** `identity_key`、**没有** `ActionType`（development-tasks.md S3.1 交付物列出的两项，均未
实现）——`domain`/`range` 只是字符串（`"*"` 表示不限定于当前定义内的类型），写入时**不**做
"domain/range 必须引用一个真实存在的 ObjectType"这类校验（这正是 S3.1 要交付的 `validate_link`）。

**发布路径**：`publishOntologyVersion()`（同一文件导出）把一份 `OntologyDefinition` 直接写成
`ontology_versions` 表的一行 `published` 状态（无草稿态——该函数自己的文档注释："a bootstrap seed
has no other reviewer than the same owner who is creating the workspace"）。但**调用它的地方只有
一处**：`packages/kernel/src/cli/bootstrap.ts` 的 `create-workspace` 子命令，硬编码只读
`ontology/platform-meta.yaml` 一个文件（`seedPlatformMetaOntology()`）。**没有任何 CLI 子命令、
capability，或其它调用点**能把第二个、你自己新写的 `ontology/<domain>.yaml` 发布进一个工作区
（既有的也好，新建的也好）。development-tasks.md S3.1 的交付物里 `propose_ontology_change`（走
Handle 通道生成私有 draft）与 `publish_ontology_version` 就是要补上这条通用路径——两者在
`packages/shared/src/capabilities.ts` 的 `ontology` 组里**已注册但无 handler**
（development-tasks.md S3.7 实现说明里"已注册但无 handler 的 capability"清单第一组）。

**结论**：本文档能教你怎么**写**一份符合 schema、能通过本地校验的 `ontology/<domain>.yaml`；**不能**
教你怎么把它发布进一个运行中的工作区——那需要 S3.1 落地后的 `propose_ontology_change`/
`publish_ontology_version`，或者（在那之前）有人扩展 `bootstrap.ts` 让 `create-workspace`
接受"额外发布哪些本体文件"这样的参数，这是一项代码改动，超出本文档（docs-only）范围。

### 2.2 `identity_key`——存储机制已存在，声明机制（S3.1）还没有

数据库层面：`objects` 表早就有 `identity_key jsonb` 列 + 唯一索引
`(workspace_id, object_type, identity_key) where identity_key is not null`
（`migrations/core/0002_substrate.sql`、`0006_object_identity.sql`）——去重机制本身能用。缺的是
**声明**：本体 YAML 里没有字段能写"ObjectType X 的 identity_key 由哪些属性组成"，写入方（不管是
未来的采集器、Gatekeeper 的 `result_mapping`，还是一次性脚本）必须**自己**在代码里决定并传入
`identityKey` 的实际值——`substrate/ontology/meta-objects.ts` 里 `registerGatekeeperObject`/
`projectWorkerDefinitionObject` 就是这么做的（各自硬编码自己的 identity 组成）。development-
tasks.md S3.1 要交付的是把这个约定提升成本体 YAML 里可声明、可被 `validate_link` 校验的一等字段
（"identity_key 每 ObjectType"）。

### 2.3 实际把领域**数据**（Fact/Object）写进图——比 §2.1 更早的一个缺口，与 S3.1 无关

`assert_fact` capability（`{objectId, linkType, value, sourceId?}`）**已注册、有 handler 挂载，
但 handler 本体除了跑一次 I16 门禁检查外，直接 `throw AssertFactWriteNotImplementedError`**——
`packages/kernel/src/application/gateway/handlers.ts` 该函数自己的注释："the graph write is not
implemented (pre-existing gap, not S2.6 scope)"。同时，注册表里**没有**任何 `create_object` 之类
的通用写入 capability（`get_object`/`traverse`/`search`/`state_at` 全部是只读）。

**结论**：即使一个领域包的 ObjectType/LinkType 已经在图里（哪怕是手写脚本硬塞进去的），也**没有
一个通用 capability 能让 agent 直接"断言一个事实"**。今天图里真正会出现领域数据，只有三条路径：
① 一个 Gatekeeper Operation 声明了 `result_mapping`（`reads`/`writes` 指向你的新 ObjectType），
调用后由 `GatekeeperBase.toObservedFacts` 自动写入（见 `docs/runbooks/add-gatekeeper.md`）；
② 一个 Worker 的 `report_result.facts_to_assert`（`application/task/result.ts`，见
`docs/runbooks/host-worker-runtime.md` §13）；③ 采集器（development-tasks.md S3.3
`collectors/host-inventory`）——写本文档时这个包**不存在**（`ls collectors/` 为空），是 S3
实施波次表 W3-A 项，尚未开工。**一个新领域包若想真的看到数据，必须搭配①或②**——单独发布一份
ObjectType/LinkType 定义不会自己产生任何图内容。

### 2.4 今天真正可用、且已经过验收的部分：Skill / Procedure / WorkerDefinition

与 §2.1–2.3 不同，`propose_skill`/`publish_skill`、`propose_procedure`/`publish_procedure`、
`propose_worker_definition`/`publish_worker_definition` **都已实现、都有真实 handler、都在
`docs/runbooks/host-worker-runtime.md` §12–14 走通过主机验收**——draft → published 两步式发布、
写入 `worker_definitions`/`skills`/`procedures` 各自的表，并投影成图 Object
（`substrate/ontology/meta-objects.ts` 的 `projectSkillObject`/`projectProcedureObject`/
`projectWorkerDefinitionObject`，这部分不受 §2.1 的"没有通用发布路径"限制——**它们发布的不是
`ontology_versions` 行，而是各自模块自己的表**，走的是各自独立的、已实现的 propose/publish
capability，S3.1 与它们无关）。

## 3. 前置条件

- 有一个 workspace 与至少一个 owner Principal。
- `pnpm install`（本地校验 §4 需要能跑 `pnpm --filter @nexttime/kernel` 下的 TS 代码，或至少能读
  `packages/kernel/src/substrate/ontology/loader.ts` 的 schema 定义自行核对）。

## 4. 步骤：写 `ontology/<domain>.yaml`

按 §2.1 的 schema、参照 `ontology/platform-meta.yaml`（本仓库唯一真实的 `OntologyDefinitionSchema`
样例）：

```yaml
objectTypes:
  - name: Widget
    description: >-
      一个可库存的物品——领域包示例，替换成真实概念。

linkTypes:
  - name: stored_in
    domain: Widget
    range: "*"
    description: >-
      该 Widget 当前存放的位置。range 用 "*" 是因为"位置"可能是另一个领域包定义的类型，不局限于
      本文件内声明的 ObjectType。
```

命名约定（沿用 `platform-meta.yaml`/`entry-agent.yaml`/`ops-runner.yaml` 已经确立的惯例）：**扁平
文件** `ontology/<domain>.yaml`，不是设计文档 §10.1 原始草图画的 `ontology/<domain>/` 目录
（`platform-meta.yaml` 自己的"命名注释"已经记录过这条同样的偏离——本仓库的领域包用文件名前缀区分
（如 `ops-assets`），而不是子目录）。`skills/`/`procedures/`/`workers/` 三类配套内容不走这个 YAML
文件——它们各自用 §5 的 capability 发布，不塞进本体文件里。

## 5. 步骤：发布配套内容（今天真的能做的部分）

用 `propose_skill`/`publish_skill`（Skill）、`propose_procedure`/`publish_procedure`（Procedure）、
`propose_worker_definition`/`publish_worker_definition`（WorkerDefinition）——完整命令示例见
`docs/runbooks/host-worker-runtime.md` §12.1（WorkerDefinition）、§14.1（Skill）；Procedure 的
参数形状与 Skill 同一模式（`propose_procedure{procedure: {...}}` → `publish_procedure
{procedureId}`），本文档不重复贴一遍相同结构的命令。

```bash
# 例：为这个领域包发布一个引用 §4 概念的 Skill（骨架，字段按你的领域内容填）：
curl -s https://<host>:8443/api/cap/propose_skill \
  -H "Authorization: Bearer ${OWNER_KEY}" -H 'content-type: application/json' \
  -d '{"skill":{"name":"widget-triage","description":"...","markdown":"..."}}'
# 记下 result.id，再:
curl -s https://<host>:8443/api/cap/publish_skill \
  -H "Authorization: Bearer ${OWNER_KEY}" -H 'content-type: application/json' \
  -d '{"skillId":"<id>"}'
```

## 6. 步骤：本地校验 `ontology/<domain>.yaml`（在没有发布路径的情况下，至少确认它是合法的）

没有 CLI 子命令、没有独立脚本封装这一步（S3.1 落地前，`parseOntologyDefinition`/
`loadOntologyDefinitionFile` 只在 kernel 单元测试与 `seedPlatformMetaOntology` 内部被调用）——
最接近"验证"的手段是跑一次内核单元测试形状的一次性脚本：

```bash
cd <CODE_DIR>
pnpm --filter @nexttime/kernel build
# packages/kernel 是 ESM（package.json "type":"module"）——用 --input-type=module，不是 require()：
node --input-type=module -e "
import { parseOntologyDefinition } from './packages/kernel/dist/substrate/ontology/loader.js';
import { readFileSync } from 'node:fs';
const text = readFileSync('ontology/<domain>.yaml', 'utf8');
const def = parseOntologyDefinition(text, 'ontology/<domain>.yaml');
console.log(JSON.stringify(def, null, 2));
console.log('OK — schema 有效');
"
```
解析失败会抛 `OntologyDefinitionParseError`，错误信息里带具体是哪个字段不满足 Zod schema
（多数是漏了 `description`，或 `linkTypes` 缺 `domain`/`range` 其中一个——`.strict()` 也会拒绝
任何 schema 之外的多余字段，比如手滑写成设计文档草图里的 `identity_key`/`actionTypes`，这些字段
今天会直接校验失败，不是被静默忽略）。

## 7. 验证

- §6 的本地解析脚本能跑通、不报错——这是本文档能给出的**最高**验证级别（S3.1 落地前）。
- 若配套发布了 Skill/Procedure/WorkerDefinition（§5），`publish_*` 调用返回
  `{"ok":true,"result":{"status":"published",...}}` 即为该部分真正成功；进一步端到端验证（挂进
  Worker 容器、真的被 agent 用上）走 `docs/runbooks/host-worker-runtime.md` §13/§14 同款命令。
- development-tasks.md § S3.10 原文对"新增一个领域包"没有给出独立的验收句（只有"新增一个接入包"
  有——"接入一个 fake 系统成功"），这与 §2 记录的现状一致：领域包这条线在 S3.1 落地前本来就没有
  完整的端到端验收对象。

## 8. 回滚

- `ontology/<domain>.yaml` 文件本身：`git revert`，不涉及任何已发布状态（因为 §2.1 决定了它今天
  发布不出去）。
- 已发布的 Skill/Procedure/WorkerDefinition：`deprecate_skill{skillId}` /
  `deprecate_procedure{procedureId}` / `deprecate_worker_definition{definitionId}`——都是
  `draft → published → deprecated` 单向状态机（I12），没有"撤销发布"，弃用后新的 Worker 定义/入口
  不会再引用它，但已经引用过的历史 Task/Activity 不受影响（design §12 审计不可变）。

## 9. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 想把新写的 `ontology/<domain>.yaml` 发布进一个工作区，找不到任何命令 | §2.1——目前只有 `create-workspace` 会发布本体，且硬编码只发布 `platform-meta.yaml` | 这是一个真实的产品化缺口（development-tasks.md S3.1），不是本文档遗漏；在 S3.1 落地前，需要有人扩展 `bootstrap.ts`（代码改动）才能让这条路径接受任意本体文件——记录为已知缺口，不要在生产工作区手写脚本直接操作 `ontology_versions` 表绕过治理 |
| 发布了 Skill 引用了 `ontology/<domain>.yaml` 里的 ObjectType 名字，但图里从来没出现过这个类型的 Object | §2.3——发布本体定义/Skill 都不会自动产生图数据；需要一个 Gatekeeper 的 `result_mapping` 或 Worker 的 `report_result.facts_to_assert` 才会真的写 Fact | 按 `docs/runbooks/add-gatekeeper.md` 接一个门并声明 `reads`/`writes` 指向这个新 ObjectType，或让引用它的 WorkerDefinition 的 Worker 在 `report_result` 里 `facts_to_assert` |
| 直接调用 `assert_fact` 想手动断言一个事实，返回 500/内部错误 | §2.3——`assert_fact` 的 handler 是一个未实现的桩，字面上会抛错，不是权限或参数问题 | 这不是配置问题；改用 §2.3 列出的两条真实路径之一 |
| 本地校验脚本报 `OntologyDefinitionParseError`，提示某个字段"unrecognized key" | 写了设计文档 §7.10 草图里提到、但当前 schema 还不支持的字段（如 `identity_key`、`actionTypes`）——`.strict()` 会拒绝 | 对照 §2.1 的当前真实 schema（只有 `objectTypes: [{name,description}]`、`linkTypes: [{name,domain,range,description}]`）删掉多余字段；这些字段等 S3.1 落地后才会被支持 |
