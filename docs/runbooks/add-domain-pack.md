# Runbook：add-domain-pack（新增或升级一个领域包）

对应任务：`development-tasks.md` § S3.1（本体注册表与本体 v1）、§ S3.3（`seed-domain-pack`）、
§5b S5.3（数据与代码分离：放文件 → seed，不重建 kernel）。设计依据：
`graph-ai-middle-platform-design.md` §5.1.2（本体 / ObjectType / LinkType）、§7.10（领域包）。

> 本文写的是 **S5.3 之后的现状**。S3.1 之前的版本记录过"没有发布路径、`assert_fact` 未实现"等当时
> 的缺口——那些都已落地，这里不再复述历史。

## 1. 目的

给一个工作区加一批领域概念（ObjectType 及其 `identityKey`、LinkType 及其 `domain` / `range`），
让采集器、门的 `result_mapping` 与 Worker 的 `report_result.factsToAssert` 能在这批概念上写入，
而写入点的本体强制（S5.1，I2）也以它为准。配套的 Skill / Procedure / WorkerDefinition 走各自的
`propose_* / publish_*` 能力，不在本体文件里。

## 2. 领域包文件是什么

一份扁平 YAML `<pack>.yaml`（本仓库自带的例子：`ontology/ops-assets-v1.yaml`、`ops-assets-v2.yaml`），
schema 是 `packages/kernel/src/substrate/ontology/loader.ts` 的 `OntologyDefinitionSchema`：

```yaml
objectTypes:
  - name: Widget
    description: >-
      一个可库存的物品——示例，替换成真实概念。
    identityKey: [warehouseId, sku]      # 同类型对象按这些键去重（`objects.identity_key` 唯一索引）

linkTypes:
  - name: stored_in
    domain: Widget
    range: Warehouse                     # "*" 表示不限定
    description: >-
      该 Widget 当前存放的位置。
```

- `identityKey` 声明后，`submit_observations` 会拒绝缺键的观察（`ObservationIdentityError`）。
- 同名 LinkType 可以多条（不同 domain / range），写入时按已发布版本校验（S5.1：`reject` 模式 400
  `ontology_violation`，`warn` 模式写入 + 审计 + I-S5-1 计数）。
- 同一个 pack 的每次 seed 是该 id 族的下一个版本；写入校验只认**最新已发布**版本。

## 3. 放文件

主机数据目录下的 `config/ontology/`（`scripts/host-env-init.sh` 会建；kernel 经只读的
`/data/config` 挂载看到它，compose 里 `DOMAIN_PACK_DIR=/data/config/ontology`）：

```bash
cp <pack>.yaml "${NEXTTIME_DATA}/config/ontology/<pack>.yaml"
```

镜像内的 `/app/ontology/` 只是自带示例——不要在容器里改它，也不需要为一个新领域包重建 kernel。

## 4. seed

```bash
docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js seed-domain-pack \
  --workspace <workspace-id> --principal <owner-principal-id> --pack-name <pack> \
  [--file-name <pack>-v2.yaml]          # 缺省 <pack>.yaml
  [--dir /some/other/dir]               # 缺省 DOMAIN_PACK_DIR，目录不存在则回落到镜像自带的 ontology/
# domain pack published: <pack> (id=..., version=N, from /data/config/ontology)
```

`--principal` 是该工作区里一个 owner / builder 的 Principal id（走普通 RLS 路径，不是超级用户）。
另一条路径是能力：`propose_ontology_change` → `publish_ontology_version`（人通道），适合从控制台或
脚本里做、需要草稿评审的场合；CLI seed 直接发布，等价于 owner 自己提议自己发布。

## 5. 验证

```bash
# 1. 已发布版本里有它（get_type 走注册表的已发布视图）
curl -s https://<host>:8443/api/cap/get_type -H "Authorization: Bearer ${OWNER_KEY}" \
  -H 'content-type: application/json' -d '{"name":"Widget"}'
# 2. 用它写入不再被本体强制拒绝：assert_fact / submit_observations 一条 stored_in 边 → 200
# 3. 换个不合法的 domain / range → 400 ontology_violation，details 里列出允许的签名
```

## 6. 回滚

- 文件：`git revert` / 从 `config/ontology/` 删掉；已发布的版本不受影响（`ontology_versions` 不可变，I12）。
- 已发布版本：发布一个**去掉**该类型的新版本——被删掉的 LinkType 的既有行会开始被 I-S5-1 计数
  （本体动了、数据没跟上），这正是要看到的信号；Object / Fact 行本身不删。

## 7. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `seed-domain-pack` 报文件不存在 | `--dir` 缺省指向 `DOMAIN_PACK_DIR`（主机 `config/ontology/`），文件没放进去或名字不是 `<pack>.yaml` | 放文件，或 `--file-name` 指定 |
| seed 后写入仍 400 `ontology_violation` | 工作区是 `reject`，且这条边的 domain / range 与最新已发布版本不符 | 看 `details.expected`；或按 S5.1 推出流程先把工作区切 `warn` |
| `OntologyDefinitionParseError` | schema 之外的字段（`.strict()`），或漏了 `description` / `domain` / `range` | 对照 §2 |
