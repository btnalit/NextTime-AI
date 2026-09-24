import { test } from '@playwright/test';
import { ADMIN_LOGIN } from '../lib/auth.js';

/**
 * Journey ⑤: 清理验收残留 (development-tasks.md §5e F4, W3 波次)
 *
 * 步骤:
 *   1. 一次验收/试用之后，工作区里留下了不再需要的对象：过期的临时工作区、已停用超过保留期的工作区、
 *      入口容器、残留的 Gatekeeper/Worker 定义草稿。
 *   2. 在相应页面找到"清理/残留"入口（今天已知的一个例子：平台 · 工作区的"仅看残留"预设 + 清除流程，
 *      workspaces.spec.ts 的 S6-A A1 场景已覆盖到工作区这一层）。
 *   3. 预览将被清除的内容（dry run：数量、原因），不是直接删除。
 *   4. 确认（重新输入名称 + 勾选确认，§5.9 原则 4 的不可逆操作模式），执行。
 *   5. 残留列表里这一项消失，有可审计的记录。
 * 状态覆盖:
 *   - 空: 没有残留——空态要说清楚"当前没有可清理的"，不是一片空白。
 *   - 错: 清除失败（例如仍有依赖它的活跃资源）——应给出具体原因，不是静默失败。
 *   - 无权限: 非平台管理员看不到"残留"这个筛选/入口。
 *   - 窄屏: 确认对话框在 768px 下仍可完整操作（尤其是"重新输入名称"这个输入框）。
 * 成功判据:
 *   - 一次验收后，一个人能找到、看懂、清理掉验收产生的残留，不用 SQL/CLI，且清理前有预览、清理后有
 *     记录。
 *
 * 今天能做到哪一步：工作区这一层的"残留 → 预览 → 确认 → 清除"已经是 S6-A A1 起的稳定能力
 * （workspaces.spec.ts 最后一个测试直接覆盖），但"验收残留"在审计条目里指的范围更广——入口容器、
 * Gatekeeper/Worker 草稿等其他种类的残留还没有统一的"残留"视图（development-tasks.md §5e 的表格
 * 把这条排在 W3，不是 W1/W2）。这里不把 workspaces.spec.ts 已经验证过的工作区清除流程重复包装成
 * "旅程"（会与那个测试维护两份几乎相同的脚本）——留给 W3 把"残留"扩到工作区之外时，再在这里写出
 * 真正跨种类的旅程。
 */

test.describe('Journey ⑤: 清理验收残留', () => {
  test.skip(!ADMIN_LOGIN, 'set WEB_E2E_ADMIN_LOGIN/WEB_E2E_ADMIN_INITIAL_PASSWORD (see README.md)');

  test.fixme(
    'end to end: preview and clear acceptance leftovers beyond workspace purge (entry containers, draft definitions, …)',
    async () => {
      // W3 — "残留" today only has a UI for the workspace layer (workspaces.spec.ts's own S6-A A1
      // test already covers that one end to end). See this file's own doc comment.
    },
  );
});
