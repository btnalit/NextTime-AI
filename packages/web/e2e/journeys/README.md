# e2e/journeys — S8 F4 旅程测试

依据：`docs/development-tasks.md` §5e 决定 F4 — "工作单元是用户旅程，不是页面"。六条旅程（① 让入口
agent 能执行、② 接入一个新系统、③ 审批一个执行类动作、④ 追溯"agent 为什么这么说"、⑤ 清理验收残留、
⑥ 添加成员并让其可用）在 `docs/ui-audit-2026-09-23.md` 的走查基础上，把"页面元素在不在"换成"一个人
从头到尾能不能把事做完"。

## 一条旅程怎么写

每个 `NN-<slug>.spec.ts` 文件顶部是一个规格块（写在文件的 doc comment 里，不是代码之外的文档 ——
规格和测试必须不会互相漂移）：

```ts
/**
 * Journey ①: 让入口 agent 能执行
 *
 * 步骤:
 *   1. ...
 *   2. ...
 * 状态覆盖:
 *   - 空: ...
 *   - 错: ...
 *   - 无权限: ...
 *   - 窄屏: ...
 * 成功判据:
 *   - ...
 */
```

- **步骤**是"一个人会做的事"，用 `journeys/helpers.ts` 的 `goToByLabel`/`navItem` 按可见文字导航
  （侧栏中文标签），不拼 `#/...` 哈希——路由是实现细节，旅程描述的是操作。
- **状态覆盖**列出这条旅程在产品今天的状态机里会经过的四类分支：空状态、出错、无权限、窄屏（768px，
  与 `00-gates/` 的第三档截图呼应，但旅程测试不做像素比对，只做"窄屏下这条路走不走得通"）。
- **成功判据**是这条旅程"验收通过"的可观察结果——不是"页面渲染了"，是"任务真的完成了"
  （§5e 原文："以后由这些测试去'点'，不再靠人工走查发现断点"）。

产品今天做不到的步骤用 `test.fixme('W2/W3: <原因>', async () => { ... })`——`fixme` 而不是
`skip`：body 仍然写出真实的操作序列（哪怕现在会在某一步失败），这样 W2/W3 实现对应功能时，去掉
`fixme` 就是这条旅程的验收标准，不用重新读一遍旅程规格再翻译成代码。

## fake 栈 vs 主机只读冒烟

这六个 spec 在 CI 的 fake 栈上跑（`.github/workflows/e2e.yml` 的 `web-e2e` job，
`AGENT_RUNTIME=fake`）——可以创建/修改数据，用完就留在那次性的 workspace 里，job 结束整个栈
`docker compose down -v`。

"主机只读冒烟"（development-tasks.md §5e F4 原文）指的是**同一份旅程规格**、之后在真实主机部署上
跑的一个更窄的子集：只做旅程里天然只读的步骤（导航、查看、筛选——不建工作区、不发起审批、不改治理
数据），验证"这条路径在真实环境里也存在、没有因为环境差异（真实 Worker、真实 Gatekeeper、真实
凭证）而断掉"。这一子集**还没有实现**——留给主机验收基础设施成熟之后（S8 之后的波次）：届时应该是
给每个旅程 spec 加一个 `test.describe('...', { tag: '@host-readonly' })` 之类的筛选，而不是另开
一套平行的旅程定义。

## 与 `00-gates/` 的关系

`00-gates/` 回答"每个页面单独看，像不像、读不读得通、无障碍过不过"；`journeys/` 回答"一串页面连起来，
一件事办不办得成"。两者共用 `e2e/lib/auth.ts` 的登录辅助，`journeys/helpers.ts` 只加旅程特有的东西
（按标签导航、`createFreshWorkspace`）。

③ 审批一个执行类动作不看对话卡片验证批准结果，看 ApprovalQueuePage 自己的"历史 History" tab
（`list_action_requests`，同一页）。这不是绕开困难的捷径，是踩了两轮坑之后的结论：
- 早期版本假设种子 ActionRequest 的卡片落在"最近一个对话"里——`chat.spec.ts` 自己会新建一个从不
  归档的对话，排在它之后的话，"最近一个对话"就不再是种子卡片所在的那一个。
- 改成给目录加数字前缀、排到 `chat.spec.ts` 前面，又排到了 `approvals.spec.ts` 前面，③ 自己的批准
  动作往同一个对话里写"已批准"状态行，顶到 `approvals.spec.ts` 自己那条不限定文本、只按
  `data-status="approved"` 找状态行的断言。
- 改成"挨个打开对话列表找真正带卡片的那个对话"，找对了对话，但卡片的 `data-status` 停在
  `pending_approval` 不再变化，即使强制刷新也一样。拉 CI 失败时留下的数据库快照对比才看清：同一个
  `actionRequestId` 的批准/失败 `system.action_update` 消息分散落进了不止一个对话——`application/
  linkage/chat-targets.ts` 的 `resolveDefaultChat`（"最近一个对话"）在两次事件处理之间解析到了不同
  的对话。这是内核侧 linkage 的行为，`packages/kernel/**` 不在这条车道允许改的文件范围内。

"历史"tab 直接读 `ActionRequest` 自己的权威状态，不经过"卡片落在哪个对话"这一层，天然绕开了上面
三条。`journeys/helpers.ts` 里不再有专门找对话的辅助函数——找错了问题层次，函数写得再稳也没用。
