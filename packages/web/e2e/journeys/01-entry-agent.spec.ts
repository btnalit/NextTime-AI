import { test } from '@playwright/test';
import { OWNER_API_KEY } from './helpers.js';

/**
 * Journey ①: 让入口 agent 能执行 (development-tasks.md §5e F4/决定, audit J1–J8/R1–R9)
 *
 * 步骤:
 *   1. 在 系统接入 把一个系统接到门后面，发布它至少一个 Operation。
 *   2. 在 访问 把这个门（及其 Operation）授权给自己的入口 agent（或一个成员）。
 *   3. 在 能力目录 · Worker 发布一个引用该 Operation 的 WorkerDefinition。
 *   4. 在 对话 里让入口 agent 委派一个会用到这个 Worker 的任务。
 *   5. 观察任务/审批：门执行，结果回到对话或任务详情。
 * 状态覆盖:
 *   - 空: 全新工作区，三样（门/授权/已发布 Worker）都还没有——概览的"执行就绪"应该说清楚缺哪一样、
 *     去哪补（F6 `execution_readiness`，W1-C，尚未接入页面）。
 *   - 错: 门授权后但 Worker 未发布——委派应该在提交前被挡住，而不是等 Worker 运行时才失败。
 *   - 无权限: 一个只有 member 角色的人打开 系统接入/访问——应该看到只读或 403 的诚实提示，不是空表当
 *     成"什么都没有"。
 *   - 窄屏: 三页各自的表单/抽屉在 768px 下仍可完成，不需要横向滚动。
 * 成功判据:
 *   - 从一个全新工作区、不碰 SQL/CLI，一个人凭页面上的信息就能把"系统接入 → 授权 → 发布 Worker →
 *     对话委派 → 看到结果"走完（W2 波次的完成判据原文）。
 *
 * 今天为什么整条走不通（审计 J1–J8/R1–R9）：授权、启用、Worker 三件事分散在三个页面、各缺一半——
 * 系统接入页发布 Operation 后没有直接跳去访问页做授权的入口；Worker 编辑器没有"引用已发布
 * Operation"的选择器（要手填 JSON）；概览没有"执行就绪"读模型告诉你三件事还差哪个。W2 波次
 * （统一授权流程 J6/AX1/R5/U2；启动器必经"启用+授权" J2/J5；Worker 编辑器选择器 J7/CW1/CW2/R6；
 * 概览"执行就绪" J1/O1）把这些补齐后，去掉下面的 `test.fixme` 就是这条旅程的验收标准。
 */

test.describe('Journey ①: 让入口 agent 能执行', () => {
  test.skip(!OWNER_API_KEY, 'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY (see README.md)');

  test.fixme(
    'end to end: connect a system, authorize, publish a Worker, delegate from chat, see the result',
    async () => {
      // W2 implements this — see this file's own doc comment for the exact step sequence and why
      // it does not exist yet. Left unwritten (rather than a half-working skeleton) because every
      // step depends on the *previous* step's UI actually existing (the Worker editor has no
      // Operation picker yet — CW1/CW2, R6 — so step 3 cannot be scripted without inventing UI
      // that isn't there).
    },
  );
});
