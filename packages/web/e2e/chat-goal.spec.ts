import { SystemMessageContentSchema, getCapability } from '@nexttime/shared';
import { type Locator, type Page, expect, test } from '@playwright/test';
import { OWNER_API_KEY, loginAsOwner, signedInOwner } from './lib/auth.js';

/**
 * e2e/chat-goal.spec.ts (S11 GO5e-2): a goal in the chat it was proposed from — the proposal as a
 * card that sends the requester to the goal's page to confirm it, and each later milestone (and
 * its step's Task) as a status line — in a real browser at the widths UX checks (1440, 390).
 * Nothing on the CI stack proposes a goal (its agent runtime only echoes), so the goal's messages
 * are stand-ins appended to the real chat's history as the socket carries it
 * (`page.routeWebSocket`, forwarding everything else both ways), and `get_goal` is answered in the
 * browser (`page.route`, as goal-detail.spec.ts does). The chat itself, the signed-in owner and
 * the goal pages' shell are the real stack. Full-page captures (the proposal, a proposal that cannot
 * be read, the milestones, two goals in one chat) land in `test-results/` for the UX acceptance to
 * read; they are not a screenshot gate.
 */

const GOAL = '66000000-0000-4000-8000-000000000301';
const WORKER = '66000000-0000-4000-8000-0000000003e1';
const GATE = '66000000-0000-4000-8000-0000000003d1';
const TASK = '66000000-0000-4000-8000-000000000311';
const SECOND = '66000000-0000-4000-8000-000000000302';
const STATEMENT = '每周一早上汇总三台主机的证书到期时间，快到期的列出来';
const SECOND_STATEMENT = '把二号仓本月的盘点差异整理成一份报告，按金额从大到小列出';

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const T0 = minutesAgo(30);
const T1 = minutesAgo(29);
const T2 = minutesAgo(10);

const worker = { definitionId: WORKER, version: 1 };
const PLAN = {
  steps: [
    { key: 'collect', worker, input: { what: '三台主机的证书到期时间' } },
    { key: 'report', worker, dependsOn: ['collect'], input: { language: 'zh' } },
  ],
  acceptance: [
    {
      kind: 'observe_predicate',
      key: 'certs',
      check: {
        gatekeeperId: GATE,
        operation: 'cert.list',
        expect: { path: 'expiring', op: 'eq', value: 0 },
      },
    },
  ],
};

/** `get_goal` for the proposal, as its requester reads it. */
function proposedGoal(requester: string) {
  return {
    id: GOAL,
    status: 'proposed',
    pauseReason: null,
    pausedBy: null,
    pausedByAuthority: null,
    cleanupPending: false,
    outcome: null,
    outcomeBasis: null,
    outcomeDecisionId: null,
    onBehalfOf: requester,
    turnId: null,
    statement: STATEMENT,
    currentRevision: 1,
    budget: { maxTokens: 200000, maxSteps: 8, maxRevisions: 2, maxWallClockSeconds: 3600 },
    usage: { tokens: 0, steps: 0, revisions: 0, plannerTokens: 0, plannerRounds: 0 },
    stepCounts: {
      pending: 0,
      ready: 0,
      running: 0,
      waiting: 0,
      succeeded: 0,
      failed: 0,
      superseded: 0,
      cancelled: 0,
      skipped: 0,
    },
    createdAt: T0,
    updatedAt: T0,
    confirmedAt: null,
    endedAt: null,
    planRevision: {
      id: 'rev-1',
      goalRunId: GOAL,
      revision: 1,
      status: 'proposed',
      basedOnRevision: null,
      plan: PLAN,
      proposedBy: requester,
      proposer: 'person',
      acceptedBy: null,
      reason: null,
      decidedBy: null,
      decidedAt: null,
      createdAt: T0,
      removals: {},
      hints: [],
      checkedStepKeys: [],
      fromProcedure: null,
    },
    revisions: [],
    steps: [],
    acceptance: { rounds: [], steps: [], absenceBaselines: [], overriddenChecks: [] },
    leftovers: null,
    trialApprovals: [],
    planner: null,
    planningRounds: [],
  };
}

/** `get_goal` for a second goal of the same chat, ended as not achieved on its requester's word. */
function endedGoal(requester: string) {
  const goal = proposedGoal(requester);
  return {
    ...goal,
    id: SECOND,
    status: 'completed',
    outcome: 'not_achieved',
    outcomeBasis: 'requester',
    outcomeDecisionId: '66000000-0000-4000-8000-0000000003a1',
    statement: SECOND_STATEMENT,
    confirmedAt: T1,
    endedAt: T2,
    updatedAt: T2,
    planRevision: { ...goal.planRevision, goalRunId: SECOND, status: 'accepted' },
  };
}

/** A stand-in's answer, checked first against the capability's own result contract (as in
 *  goal-detail.spec.ts). */
function answer(name: string, result: unknown) {
  const contract = getCapability(name)?.resultSchema;
  if (!contract) throw new Error(`no result contract for ${name}`);
  return { json: { ok: true, result: contract.parse(result) } };
}

/** A goal milestone (or its step's Task) as the kernel writes it — checked against the shared
 *  `system.*` content schema, so a renamed field fails here. */
function systemMessage(sequence: number, at: string, content: Record<string, unknown>) {
  const parsed = SystemMessageContentSchema.parse(content);
  return {
    id: `stand-in-${sequence}`,
    role: 'system',
    text: parsed.text,
    createdAt: at,
    sequence,
    kind: parsed.kind,
    content: parsed,
    turnId: null,
  };
}

const goalUpdate = (
  sequence: number,
  at: string,
  fields: Record<string, unknown>,
  goalRunId = GOAL,
) =>
  systemMessage(sequence, at, {
    kind: 'system.goal_update',
    text: `Goal ${goalRunId}`,
    goalRunId,
    ...fields,
  });

/** Neither the line nor the page scrolls sideways: a long statement is cut with its whole text as
 *  the title, the milestone itself wraps. */
async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const lines = page.getByTestId('system-status-line');
  for (const line of await lines.all()) {
    expect(await line.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

/** #737 UX P2-3: a goal's line says which goal on a row of its own under what happened, as wide as
 *  the line allows — never a column of a few characters beside the sentence — and what happened
 *  reads in rows, not one character per row. */
async function expectGoalRowUnder(line: Locator): Promise<void> {
  const head = await line.locator('.system-status-head').boundingBox();
  const main = await line.locator('.system-status-main').boundingBox();
  const goalRow = line.getByTestId('system-status-goal');
  const goal = await goalRow.boundingBox();
  if (!head || !main || !goal) throw new Error('the goal line has no head, body or goal row');
  expect(goal.y).toBeGreaterThanOrEqual(head.y + head.height - 1);
  // Cut only once it has the line's whole width.
  if (await goalRow.evaluate((el) => el.scrollWidth > el.clientWidth)) {
    expect(goal.width).toBeGreaterThanOrEqual(main.width - 1);
  }
  for (const part of await line.locator('.system-status-head > *').all()) {
    const box = await part.boundingBox();
    if (box) expect(box.width).toBeGreaterThan(box.height);
  }
}

/** Appends `extra(lastSequence)` to the last page of every chat history the page reads over the
 *  socket; every other frame passes through unchanged, both ways. */
async function appendToChatHistory(
  page: Page,
  extra: (lastSequence: number) => readonly ReturnType<typeof systemMessage>[],
): Promise<void> {
  await page.routeWebSocket(/\/ws(\?.*)?$/, (ws) => {
    const server = ws.connectToServer();
    const historyCalls = new Set<unknown>();
    ws.onMessage((message) => {
      try {
        const frame = JSON.parse(String(message)) as { id?: unknown; method?: string };
        if (frame.method === 'get_chat_history') historyCalls.add(frame.id);
      } catch {
        // Not JSON: forwarded as it is.
      }
      server.send(message);
    });
    server.onMessage((message) => {
      let frame: {
        id?: unknown;
        result?: { items: { sequence: number }[]; nextCursor?: string };
      };
      try {
        frame = JSON.parse(String(message));
      } catch {
        ws.send(message);
        return;
      }
      if (!historyCalls.has(frame.id) || !frame.result) {
        ws.send(message);
        return;
      }
      historyCalls.delete(frame.id);
      if (frame.result.nextCursor === undefined) {
        const last = frame.result.items.at(-1)?.sequence ?? 0;
        frame.result.items = [...frame.result.items, ...extra(last)];
      }
      ws.send(JSON.stringify(frame));
    });
  });
}

async function openNewChat(page: Page): Promise<void> {
  await page.goto('/#/work/chats');
  await page.locator('header').getByRole('button', { name: '新对话' }).click();
  await expect(page.getByRole('button', { name: '返回对话列表' })).toBeVisible();
}

test.describe('S11 GO5e-2: a goal in its chat (stand-in messages)', () => {
  test.skip(!OWNER_API_KEY, 'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY to run this suite');

  for (const width of [1440, 390] as const) {
    test(`a proposal waiting for its requester at ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const owner = (await signedInOwner(page)).id;
      await page.route('**/api/cap/get_goal', async (route) =>
        route.fulfill(answer('get_goal', proposedGoal(await owner))),
      );
      await appendToChatHistory(page, (last) => [
        goalUpdate(last + 1, T0, { change: 'propose', status: 'proposed' }),
      ]);
      await loginAsOwner(page);
      await openNewChat(page);
      // The stand-in rides on the history read a fresh subscription makes.
      await page.reload();

      const card = page.getByTestId('goal-proposal-card');
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card.getByTestId('goal-proposal-statement')).toHaveText(STATEMENT);
      await expect(card.getByTestId('goal-proposal-summary')).toContainText('2 个步骤');
      await expect(card.getByTestId('goal-proposal-awaits')).toBeVisible();
      const open = card.getByTestId('goal-proposal-open');
      await expect(open).toHaveText('查看并确认');
      await page.screenshot({
        path: testInfo.outputPath(`chat-goal-proposal-${width}.png`),
        fullPage: true,
      });

      await open.click();
      await expect(page).toHaveURL(new RegExp(`#/work/goals/${GOAL}$`));
    });

    test(`a proposal its reader cannot read at ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.route('**/api/cap/get_goal', (route) =>
        route.fulfill({
          status: 404,
          json: { ok: false, error: { code: 'not_found', message: 'goal run not found' } },
        }),
      );
      await appendToChatHistory(page, (last) => [
        goalUpdate(last + 1, T0, { change: 'propose', status: 'proposed' }),
      ]);
      await loginAsOwner(page);
      await openNewChat(page);
      await page.reload();

      // Still says a goal was proposed, explains the read, and still opens the goal's page.
      const card = page.getByTestId('goal-proposal-card');
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card.getByTestId('goal-proposal-statement')).toHaveText(
        '这里提出过一个目标，现在读不到它',
      );
      await expect(card.getByTestId('goal-proposal-error')).toContainText('目标页会说明原因');
      await expect(card.getByTestId('goal-proposal-summary')).toHaveCount(0);
      await expect(card.getByTestId('goal-proposal-open')).toHaveText('查看目标');
      await page.screenshot({
        path: testInfo.outputPath(`chat-goal-unreadable-${width}.png`),
        fullPage: true,
      });

      await card.getByTestId('goal-proposal-open').click();
      await expect(page).toHaveURL(new RegExp(`#/work/goals/${GOAL}$`));
    });

    test(`its milestones and its step's Task at ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const owner = (await signedInOwner(page)).id;
      await page.route('**/api/cap/get_goal', async (route) =>
        route.fulfill(answer('get_goal', proposedGoal(await owner))),
      );
      await appendToChatHistory(page, (last) => [
        goalUpdate(last + 1, T0, { change: 'propose', status: 'proposed' }),
        goalUpdate(last + 2, T1, { change: 'confirm', status: 'running' }),
        systemMessage(last + 3, T2, {
          kind: 'system.task_update',
          text: `Goal step "collect": task ${TASK} completed`,
          taskId: TASK,
          status: 'completed',
          summary: '三台主机都已读到',
          failureReason: null,
          goalRunId: GOAL,
          stepKey: 'collect',
        }),
        goalUpdate(last + 4, T2, {
          change: 'pause',
          status: 'paused',
          pauseReason: 'needs_decision',
        }),
        goalUpdate(last + 5, T2, {
          change: 'hold',
          status: 'paused',
          pauseReason: 'needs_decision',
          heldByOwner: true,
        }),
      ]);
      await loginAsOwner(page);
      await openNewChat(page);
      await page.reload();

      const card = page.getByTestId('goal-proposal-card');
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card).toHaveAttribute('data-status', 'paused');
      await expect(card.getByTestId('goal-proposal-open')).toHaveText('查看目标');
      const lines = page.getByTestId('system-status-line');
      await expect(lines).toHaveCount(4);
      await expect(lines.nth(0)).toContainText('目标已确认，开始执行');
      await expect(lines.nth(1).getByTestId('system-status-goal-step')).toHaveText(
        '目标步骤 collect',
      );
      await expect(lines.nth(1)).not.toContainText('Goal step');
      await expect(lines.nth(2)).toContainText('目标已暂停：需要人决定');
      await expect(lines.nth(3)).toContainText('所有者解除之后才能继续');
      // #737 UX P2-2: every line, the step's Task included, says which goal it belongs to.
      for (const index of [0, 1, 2, 3]) {
        const goal = lines.nth(index).getByTestId('system-status-goal');
        await expect(goal).toHaveText(STATEMENT);
        await expect(goal).toHaveAttribute('title', STATEMENT);
        await expectGoalRowUnder(lines.nth(index));
      }
      // A milestone is never cut, at either width: it wraps instead.
      for (const index of [0, 2, 3]) {
        const text = lines.nth(index).locator('.system-status-text');
        expect(await text.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
      await expectNoSidewaysScroll(page);
      await page.screenshot({
        path: testInfo.outputPath(`chat-goal-milestones-${width}.png`),
        fullPage: true,
      });

      await lines.nth(2).click();
      await expect(page).toHaveURL(new RegExp(`#/work/goals/${GOAL}$`));
    });

    test(`two goals in one chat, one ended not achieved, at ${width}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const owner = (await signedInOwner(page)).id;
      await page.route('**/api/cap/get_goal', async (route) => {
        const { goalRunId } = route.request().postDataJSON() as { goalRunId: string };
        const requester = await owner;
        await route.fulfill(
          answer('get_goal', goalRunId === SECOND ? endedGoal(requester) : proposedGoal(requester)),
        );
      });
      await appendToChatHistory(page, (last) => [
        goalUpdate(last + 1, T0, { change: 'propose', status: 'proposed' }),
        goalUpdate(last + 2, T0, { change: 'propose', status: 'proposed' }, SECOND),
        goalUpdate(last + 3, T1, { change: 'confirm', status: 'running' }),
        goalUpdate(last + 4, T1, { change: 'confirm', status: 'running' }, SECOND),
        goalUpdate(
          last + 5,
          T2,
          {
            change: 'complete',
            status: 'completed',
            outcome: 'not_achieved',
            outcomeBasis: 'requester',
          },
          SECOND,
        ),
        systemMessage(last + 6, T2, {
          kind: 'system.task_update',
          text: `Goal step "collect": task ${TASK} failed`,
          taskId: TASK,
          status: 'failed',
          summary: null,
          failureReason: 'other',
          goalRunId: GOAL,
          stepKey: 'collect',
        }),
      ]);
      await loginAsOwner(page);
      await openNewChat(page);
      await page.reload();

      const cards = page.getByTestId('goal-proposal-card');
      await expect(cards).toHaveCount(2, { timeout: 15_000 });
      await expect(cards.nth(0)).toHaveAttribute('data-status', 'running');
      await expect(cards.nth(0).getByTestId('goal-proposal-outcome')).toHaveCount(0);
      await expect(cards.nth(1)).toHaveAttribute('data-status', 'completed');
      await expect(cards.nth(1).getByTestId('goal-proposal-statement')).toHaveText(
        SECOND_STATEMENT,
      );
      // #737 UX P2-1: an end not achieved is a red 「未达成」, never only a green 「已结束」.
      await expect(cards.nth(1).getByTestId('goal-proposal-outcome')).toHaveAttribute(
        'data-status',
        'not_achieved',
      );

      const lines = page.getByTestId('system-status-line');
      await expect(lines).toHaveCount(4);
      await expect(lines.nth(0).getByTestId('system-status-goal')).toHaveText(STATEMENT);
      await expect(lines.nth(1).getByTestId('system-status-goal')).toHaveText(SECOND_STATEMENT);
      await expect(lines.nth(2)).toContainText('目标按未达成结束 · 依据请求人确认');
      await expect(lines.nth(2).getByTestId('system-status-goal-outcome')).toHaveAttribute(
        'data-status',
        'not_achieved',
      );
      await expect(lines.nth(2).getByTestId('system-status-goal')).toHaveText(SECOND_STATEMENT);
      // A failed step: the step, then why, then the goal under them.
      await expect(lines.nth(3).getByTestId('system-status-goal-step')).toHaveText(
        '目标步骤 collect',
      );
      await expect(lines.nth(3).locator('.system-status-reason')).toHaveText('(其他原因)');
      await expect(lines.nth(3).getByTestId('system-status-goal')).toHaveText(STATEMENT);
      for (const index of [0, 1, 2, 3]) await expectGoalRowUnder(lines.nth(index));
      await expectNoSidewaysScroll(page);
      await page.screenshot({
        path: testInfo.outputPath(`chat-goal-two-goals-${width}.png`),
        fullPage: true,
      });

      await lines.nth(2).click();
      await expect(page).toHaveURL(new RegExp(`#/work/goals/${SECOND}$`));
    });
  }
});
