import { SystemMessageContentSchema, getCapability } from '@nexttime/shared';
import { type Page, expect, test } from '@playwright/test';
import { OWNER_API_KEY, loginAsOwner, signedInOwner } from './lib/auth.js';

/**
 * e2e/chat-goal.spec.ts (S11 GO5e-2): a goal in the chat it was proposed from — the proposal as a
 * card that sends the requester to the goal's page to confirm it, and each later milestone (and
 * its step's Task) as a status line — in a real browser at the widths UX checks (1440, 390).
 * Nothing on the CI stack proposes a goal (its agent runtime only echoes), so the goal's messages
 * are stand-ins appended to the real chat's history as the socket carries it
 * (`page.routeWebSocket`, forwarding everything else both ways), and `get_goal` is answered in the
 * browser (`page.route`, as goal-detail.spec.ts does). The chat itself, the signed-in owner and
 * the goal pages' shell are the real stack. Full-page captures land in `test-results/` for the UX
 * acceptance to read; they are not a screenshot gate.
 */

const GOAL = '66000000-0000-4000-8000-000000000301';
const WORKER = '66000000-0000-4000-8000-0000000003e1';
const GATE = '66000000-0000-4000-8000-0000000003d1';
const TASK = '66000000-0000-4000-8000-000000000311';

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
    statement: '每周一早上汇总三台主机的证书到期时间，快到期的列出来',
    currentRevision: 1,
    budget: { maxTokens: 200000, maxSteps: 8, maxRevisions: 2, maxWallClockSeconds: 3600 },
    usage: { tokens: 0, steps: 0, revisions: 0 },
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
      reason: null,
      decidedBy: null,
      decidedAt: null,
      createdAt: T0,
      removals: {},
      hints: [],
      fromProcedure: null,
    },
    revisions: [],
    steps: [],
    acceptance: { rounds: [], steps: [], overriddenChecks: [] },
    leftovers: null,
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

const goalUpdate = (sequence: number, at: string, fields: Record<string, unknown>) =>
  systemMessage(sequence, at, {
    kind: 'system.goal_update',
    text: `Goal ${GOAL}`,
    goalRunId: GOAL,
    ...fields,
  });

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
      await expect(card.getByTestId('goal-proposal-statement')).toHaveText(
        '每周一早上汇总三台主机的证书到期时间，快到期的列出来',
      );
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
      // A milestone is never cut, at either width: it wraps instead.
      for (const index of [0, 2, 3]) {
        const text = lines.nth(index).locator('.system-status-text');
        expect(await text.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
      await page.screenshot({
        path: testInfo.outputPath(`chat-goal-milestones-${width}.png`),
        fullPage: true,
      });

      await lines.nth(2).click();
      await expect(page).toHaveURL(new RegExp(`#/work/goals/${GOAL}$`));
    });
  }
});
