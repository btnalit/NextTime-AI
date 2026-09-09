# Runbook：host-collector（部署 `host-inventory` 采集器）

对应任务：`docs/development-tasks.md` S3.3（采集器 `host-inventory` + 五个写入能力）。设计依据：
`docs/graph-ai-middle-platform-design.md` §5.1.3（Source/Observation/Fact 模型）、§7.8（采集器）、
`ontology/ops-assets-v1.yaml`（S3.1，本采集器观察的领域包）。

已有的相邻工作示例：`docs/runbooks/add-gatekeeper.md`（门的接入流程——本采集器不是门，不产生
ActionRequest，不经审批）；`docs/runbooks/add-domain-pack.md`（领域包发布机制——本文档 §2 用到）。

## 0. 前置条件

- 目标主机已完成 `docs/runbooks/host-bootstrap.md`（数据目录、`secrets/`）与
  `docs/runbooks/key-rotation.md` §（Handle 签名密钥对 `handle.key`/`handle.pub` 已生成——
  `issue-service-handle` 用同一对密钥签发）。
- 已有一个 workspace 与至少一个 owner Principal（`docs/runbooks/host-gatekeepers.md` §4 有取得
  `WORKSPACE_ID`/`OWNER_ID` 的完整步骤，本文档复用同样的取得方式）。
- `docker-compose.yml` 已包含本任务新增的 `docker-socket-proxy-collector`/
  `collector-host-inventory` 两个服务块（见该文件自己的注释）。

## 1. 步骤 A：发布 `ops-assets-v1` 领域包（若尚未发布过）

`submit_observations` 的身份键校验（`application/gateway/ingest-handlers.ts`）要求每个
ObjectType 在这个 workspace 当前可见的本体命名空间里存在——没有发布过 `ops-assets` 域包的
workspace，采集器第一次提交就会对每一个 ObjectType 收到 400
`unknown_object_type`（`ObservationIdentityError`）。

```bash
docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js seed-domain-pack \
  --workspace <WORKSPACE_ID> --principal <OWNER_ID> --pack-name ops-assets --file-name ops-assets-v1.yaml
# domain pack published: ops-assets (id=<uuid>, version=1)
```

幂等：对同一个 `--pack-name` 再跑一次会发布下一个版本（`version=2`），不会报错，也不会影响已发布
的 Object/LinkType（S3.1 自己的验收："同内容再发布得 v2"）。

## 2. 步骤 B：铸造采集器自己的 service Handle

```bash
docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js issue-service-handle \
  --workspace <WORKSPACE_ID> --name host-inventory \
  --scope register_source,submit_observations \
  > /tmp/issue-service-handle.out
cat /tmp/issue-service-handle.out
```

输出的最后一行是 Handle token（**只显示这一次**——`cli/bootstrap.ts`'s own doc comment）。取出这
一行写进采集器的密钥文件：

```bash
tail -n 1 /tmp/issue-service-handle.out > "${NEXTTIME_DATA}/secrets/collector-host-inventory.token"
chmod 640 "${NEXTTIME_DATA}/secrets/collector-host-inventory.token"
rm -f /tmp/issue-service-handle.out
```

默认有效期一年（`--ttl-days` 可覆盖）；到期前用 `docs/runbooks/key-rotation.md` 的思路重新跑一遍
本步骤——`issue-service-handle` 对同一个 `--name` 是幂等的（复用同一个 `service` Principal，只铸造
新的 Session/Handle），旧 Handle 在其 `exp` 之前仍然有效，不会因为铸造新的而失效。

## 3. 步骤 C：起服务

```bash
docker compose up -d docker-socket-proxy-collector collector-host-inventory
docker compose ps docker-socket-proxy-collector collector-host-inventory
```

`docker-socket-proxy-collector` 的 healthcheck 通过后 `collector-host-inventory` 才会启动
（`depends_on: {condition: service_healthy}`，`docker-compose.yml`）。首次运行按
`HOST_INVENTORY_INTERVAL_MS`（默认 15 分钟）循环；要立即触发一次并看到退出码：

```bash
docker compose run --rm --no-deps collector-host-inventory node dist/index.js --once
```

## 4. 验证

### 4.1 容器自身日志（一行 JSON 摘要）

```bash
docker compose logs --tail 20 collector-host-inventory
```
期望看到一行 `"message":"run complete"`，附带 `objectsUpserted`/`factsAsserted`/
`factsSuperseded` 的非零计数（第一次运行）。

### 4.2 图里能看到 `Container runs_on Host`（S3.3 验收原句）

```bash
# 1. 找到某个 Container Object 的 id（search 是 handle 通道能力，用任一持有它的 Handle 或走 explain
#    起点更直接——这里用 owner 的 human key 走 search，观察类能力对任何角色都开放）
curl -s https://<host>:8443/api/cap/search \
  -H "Authorization: Bearer ${OWNER_KEY}" -H 'content-type: application/json' \
  -d '{"objectType":"Container"}'
# {"ok":true,"result":{"items":[{"id":"<container-object-id>","objectType":"Container",...}]}}

# 2. traverse 一跳，确认 runs_on 边指向一个 Host —— 注意 traverse 的 paramsSchema 没有 direction
#    字段（packages/shared/src/capabilities.ts 的 traverse 条目，.strict()）：永远两个方向都找，
#    从返回的 edges[].sourceObjectId/targetObjectId 自己判断谁是起点谁是终点即可。
curl -s https://<host>:8443/api/cap/traverse \
  -H "Authorization: Bearer ${OWNER_KEY}" -H 'content-type: application/json' \
  -d '{"fromId":"<container-object-id>","linkType":"runs_on","depth":1}'
# {"ok":true,"result":{"nodes":["<host-object-id>"],"edges":[{"linkId":"<fact-id>","linkType":"runs_on","sourceObjectId":"<container-object-id>","targetObjectId":"<host-object-id>","depth":1}]}}
```

### 4.3 `explain` 溯源到这个采集器的 Source

```bash
curl -s https://<host>:8443/api/cap/explain \
  -H "Authorization: Bearer ${OWNER_KEY}" -H 'content-type: application/json' \
  -d '{"nodeId":"<fact-id-from-the-traverse-edge-above>"}'
```
期望 `result.activity.observations[]` 至少一条，其 `source.kind` 为
`host-inventory-collector`、`source.visibility` 为 `workspace`——这正是本采集器 `register_source`
时用 `visibility: 'workspace'` 的原因：写成 `private` 会让这条 `explain` 对 owner（一个不同于采集
器自己的 service Principal 的调用者）不可见，见 `application/gateway/ingest-handlers.ts` 自己的
模块注释。

### 4.4 幂等性（S3.3 验收：两遍无重复无 Conflict；改端口第三遍 supersede）

在测试环境已由 `packages/kernel/src/application/gateway/ingest-handlers.integration.test.ts`
（DB-gated，CI 的 Postgres service 上跑）覆盖同一场景；主机上等价验证：连续跑两次 `--once`，比较
`docker compose logs` 里两次 `run complete` 的 `factsAsserted`/`factsSuperseded`——第二次
`factsAsserted` 应为 0（`SqlGraphStore.assertFact` 对同源边总是走 supersede，不会有 `factsAsserted`
重新计数第一次已经断言过的边）。

## 5. 已知限制 / 已知偏离

- **进程树采集默认返回 `skipped: true`**：`collectors/host-inventory/src/process-tree.ts`'s own
  doc comment 有完整推理——本采集器的 compose 服务没有 `pid: host`（这会是一个本任务派发文字从未
  要求的、真实的额外特权，这个代码库里每一个加固过的服务都刻意避免这类越界授权），因此这个容器自己
  的 `/proc` 只能看到它自己的进程树，永远匹配不到 agent 运行时进程——这是当前默认部署形态下的**预期
  行为**，不是一个需要修的 bug。如果确实需要观察宿主机上其他容器的进程树，需要显式给
  `collector-host-inventory` 加 `pid: host`（未采用）——这是一处刻意的权限收紧决定，留给后续任务或
  运维评估。
- **`systemctl` 数据源可选**：省略 `/run/systemd:ro` 挂载（`docker-compose.yml` 里注释掉那一行）
  是受支持的配置——`systemd.ts` 检测不到该路径就跳过，不报错。
- **`Container` 之外的对象没有 `owned_by Owner` 边**：`ontology/ops-assets-v1.yaml` 自己的文件头
  已经写明——`Owner` 身份解析不在本采集器范围内，留给未来任务或人工/CLI 直接断言。
- **`repository.ts` 只观察 `HOST_INVENTORY_REPOSITORY_PATHS` 里配置的路径**：不会自动发现主机上的
  git 仓库，默认这个环境变量为空（无 Repository 观察）。

## 6. 回滚 / 停用

```bash
# 停止采集，不删除已写入图里的 Object/Fact（append-only，design §12）
docker compose stop collector-host-inventory docker-socket-proxy-collector

# 撤销采集器自己的 Handle（不影响它已经写入的历史 Fact，只阻止它继续调用）：
# 先找到 issue-service-handle 打印的 session id，再走 revoke —— 目前没有暴露 revoke_session 的
# capability（`revokeSession` 只在 kernel 内部调用），操作员路径是直接在数据库标记
# capability_handles.revoked_at（同 docs/runbooks/key-rotation.md 处理泄露密钥的既有做法），或
# 更简单地删除/失效 ${NEXTTIME_DATA}/secrets/collector-host-inventory.token 并重启容器（下一次
# 调用会 401，采集器只记录失败、不会异常退出重试风暴——见 index.ts 的循环模式）。
```
