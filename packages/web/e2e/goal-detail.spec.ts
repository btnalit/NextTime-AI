import { getCapability } from '@nexttime/shared';
import { type Page, expect, test } from '@playwright/test';
import { OWNER_API_KEY, loginAsOwner } from './lib/auth.js';

/**
 * e2e/goal-detail.spec.ts (S11 GO6): the 目标 list and one goal's page with real content, and the
 * operations on it (confirm card, lifting a hold, ending with a refused note), in a real browser
 * at the widths UX checks (1440, 390). Nothing on the CI stack can propose a goal yet
 * (`propose_goal` is GO5c), so the goal reads are stand-ins answered in the browser (`page.route`,
 * as approval-failure-reason.spec.ts does): `list_goals`, `get_goal`, `get_goal_revision`,
 * `list_goal_unresolved_actions`, and the names they point at (`list_principals`,
 * `list_gatekeepers`, `resolve_refs`); the operations the second suite fires, and the audit read
 * behind 解除锁定, are answered the same way. Everything else on the page is the real stack — the
 * signed-in owner among it (`get_workspace`). Full-page captures land in `test-results/` (uploaded
 * as the `playwright-report` artifact) for the UX acceptance to read; they are not a screenshot
 * gate.
 */

const GOAL = '66000000-0000-4000-8000-000000000001';
const GOAL_DONE = '66000000-0000-4000-8000-000000000002';
const GOAL_OTHER = '66000000-0000-4000-8000-000000000003';
const ALICE = '66000000-0000-4000-8000-0000000000a1';
const BOB = '66000000-0000-4000-8000-0000000000b1';
const AGENT = '66000000-0000-4000-8000-0000000000c1';
const GATE = '66000000-0000-4000-8000-0000000000d1';
const WORKER = '66000000-0000-4000-8000-0000000000e1';
const ACTION = '66000000-0000-4000-8000-0000000000f1';
const TASK_FETCH = '66000000-0000-4000-8000-000000000101';
const TASK_APPLY = '66000000-0000-4000-8000-000000000102';
const TASK_FETCH_REWORK = '66000000-0000-4000-8000-000000000103';
const PROCEDURE = '66000000-0000-4000-8000-000000000201';

// Within the last hour, so the wall-clock budget reads as it would on a goal running today.
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const T0 = minutesAgo(45);
const T1 = minutesAgo(44);
const T2 = minutesAgo(25);
const T3 = minutesAgo(5);

const worker = { definitionId: WORKER, version: 2 };

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: GOAL,
    status: 'paused',
    pauseReason: 'awaiting_reconcile',
    pausedBy: null,
    pausedByAuthority: null,
    cleanupPending: false,
    outcome: null,
    outcomeBasis: null,
    outcomeDecisionId: null,
    onBehalfOf: ALICE,
    turnId: null,
    statement: '把三台主机的证书都换成新签发的，旧证书确认不再使用后删除',
    currentRevision: 2,
    budget: { maxTokens: 200000, maxSteps: 12, maxRevisions: 3, maxWallClockSeconds: 14400 },
    usage: { tokens: 48200, steps: 3, revisions: 1 },
    stepCounts: {
      pending: 1,
      ready: 0,
      running: 0,
      waiting: 1,
      succeeded: 1,
      failed: 0,
      superseded: 1,
      cancelled: 0,
      skipped: 0,
    },
    createdAt: T0,
    updatedAt: T3,
    confirmedAt: T1,
    endedAt: null,
    ...overrides,
  };
}

// S11 GO5d-1: fetch declares what it hands back; apply takes its hosts from that output.
const FETCH_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    hosts: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
      description: '要换证书的主机',
    },
    expiresInDays: { type: 'integer', minimum: 0 },
  },
  required: ['hosts'],
  additionalProperties: false,
};

const PLAN_V1 = {
  steps: [
    { key: 'fetch', worker, input: { hosts: 3 }, outputSchema: FETCH_OUTPUT_SCHEMA },
    {
      key: 'apply',
      worker,
      dependsOn: ['fetch'],
      maxAttempts: 2,
      bindings: [{ to: 'target.hosts', from: 'fetch', path: 'hosts' }],
    },
    { key: 'notify', worker, dependsOn: ['apply'] },
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

const PLAN_V2 = {
  ...PLAN_V1,
  steps: [
    PLAN_V1.steps[0],
    PLAN_V1.steps[1],
    { key: 'remove-old', worker, dependsOn: ['apply'], input: { keep: 'none' } },
  ],
};

function revision(n: 1 | 2) {
  return {
    id: `rev-${n}`,
    goalRunId: GOAL,
    revision: n,
    status: 'accepted',
    basedOnRevision: n === 1 ? null : 1,
    plan: n === 1 ? PLAN_V1 : PLAN_V2,
    proposedBy: n === 1 ? AGENT : ALICE,
    reason: n === 1 ? null : '通知改成人工发；旧证书要在换完后删掉',
    decidedBy: ALICE,
    decidedAt: n === 1 ? T1 : T2,
    createdAt: n === 1 ? T0 : T2,
    removals: n === 1 ? {} : { notify: { mode: 'terminate' } },
    hints: [],
    // GO5d-2: revision 1 was made from a published Procedure; revision 2 is alice's own edit.
    fromProcedure: n === 1 ? { procedureId: PROCEDURE, version: 3, name: '证书续期' } : null,
  };
}

function summary(n: 1 | 2) {
  const { plan: _plan, hints: _hints, ...rest } = revision(n);
  return rest;
}

/** One attempt of a step as `get_goal` reads it (`StepAttemptWire`). */
function attempt(
  n: number,
  taskId: string,
  status: string,
  createdAt: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    attempt: n,
    taskId,
    status,
    createdAt,
    failureReason: null,
    rework: false,
    outputProblems: null,
    outputProblemCount: 0,
    ...overrides,
  };
}

const DETAIL = {
  ...run(),
  planRevision: revision(2),
  revisions: [summary(1), summary(2)],
  steps: [
    {
      id: 'sr-fetch',
      stepKey: 'fetch',
      introducedInRevision: 1,
      supersededInRevision: null,
      status: 'succeeded',
      waitingReason: null,
      failureCategory: null,
      attemptCount: 2,
      createdAt: T1,
      updatedAt: T2,
      endedAt: T2,
      // The first attempt never handed back an output its contract accepted; the platform redid
      // it once (GO5d-1).
      attempts: [
        attempt(1, TASK_FETCH, 'failed', T1, {
          failureReason: 'no_result',
          outputProblems: [
            { path: 'output.hosts', message: 'expected array, got string' },
            { path: 'output.expiresInDays', message: 'expected integer, got number' },
          ],
          outputProblemCount: 2,
        }),
        attempt(2, TASK_FETCH_REWORK, 'completed', T1, { rework: true }),
      ],
      actions: [],
      output: { hosts: ['web-1', 'web-2', 'web-3'], expiresInDays: 6 },
    },
    {
      id: 'sr-apply',
      stepKey: 'apply',
      introducedInRevision: 1,
      supersededInRevision: null,
      status: 'waiting',
      waitingReason: 'reconcile',
      failureCategory: null,
      attemptCount: 1,
      createdAt: T2,
      updatedAt: T3,
      endedAt: null,
      attempts: [attempt(1, TASK_APPLY, 'failed', T2, { failureReason: 'worker_failed' })],
      actions: [
        {
          actionRequestId: ACTION,
          status: 'failed',
          failureKind: 'outcome_unknown',
          reconciliation: null,
        },
      ],
      output: null,
    },
    {
      id: 'sr-notify',
      stepKey: 'notify',
      introducedInRevision: 1,
      supersededInRevision: 2,
      status: 'superseded',
      waitingReason: null,
      failureCategory: null,
      attemptCount: 0,
      createdAt: T1,
      updatedAt: T2,
      endedAt: T2,
      attempts: [],
      actions: [],
      output: null,
    },
    {
      id: 'sr-remove-old',
      stepKey: 'remove-old',
      introducedInRevision: 2,
      supersededInRevision: null,
      status: 'pending',
      waitingReason: null,
      failureCategory: null,
      attemptCount: 0,
      createdAt: T2,
      updatedAt: T2,
      endedAt: null,
      attempts: [],
      actions: [],
      output: null,
    },
  ],
  acceptance: { rounds: [], steps: [], overriddenChecks: [] },
  leftovers: null,
};

const UNRESOLVED = [
  {
    actionRequestId: ACTION,
    stepRunId: 'sr-apply',
    stepKey: 'apply',
    gatekeeperId: GATE,
    actionKindTag: 'cert.replace',
    failedAt: T3,
    needs: 'finding',
    platformCheck: null,
  },
];

const GOALS = [
  run(),
  run({
    id: GOAL_DONE,
    status: 'completed',
    pauseReason: null,
    outcome: 'achieved',
    outcomeBasis: 'verified_by_check',
    statement: '给备份库加一块盘并确认挂载',
    currentRevision: 1,
    usage: { tokens: 9100, steps: 2, revisions: 0 },
    stepCounts: { ...run().stepCounts, pending: 0, waiting: 0, succeeded: 2, superseded: 0 },
    endedAt: T3,
  }),
  run({
    id: GOAL_OTHER,
    status: 'running',
    pauseReason: null,
    onBehalfOf: BOB,
    statement: '升级数据库到下一个小版本',
    currentRevision: 1,
    usage: { tokens: 1200, steps: 1, revisions: 0 },
  }),
];

const NAMES: Record<string, { kind: string; name: string }> = {
  [ALICE]: { kind: 'principal', name: 'alice' },
  [BOB]: { kind: 'principal', name: 'bob' },
  [AGENT]: { kind: 'principal', name: '入口智能体' },
  [GATE]: { kind: 'gatekeeper', name: 'cert-gate' },
  [WORKER]: { kind: 'workerDefinition', name: 'cert-rotator' },
  [ACTION]: { kind: 'actionRequest', name: 'cert.replace' },
  [TASK_FETCH]: { kind: 'task', name: 'cert-rotator' },
  [TASK_APPLY]: { kind: 'task', name: 'cert-rotator' },
  [TASK_FETCH_REWORK]: { kind: 'task', name: 'cert-rotator' },
};

/** A stand-in's answer, checked first against the capability's own result contract (review of
 *  #683): when the contract changes, the stand-in fails here instead of the page going green on a
 *  shape the kernel no longer sends. */
function answer(name: string, result: unknown) {
  const contract = getCapability(name)?.resultSchema;
  if (!contract) throw new Error(`no result contract for ${name}`);
  return { json: { ok: true, result: contract.parse(result) } };
}

const member = (id: string, displayName: string) => ({
  id,
  kind: 'human',
  role: 'member',
  displayName,
  createdAt: T0,
  hasApiKey: true,
  disabledAt: null,
  internal: false,
});

async function answerGoalReads(page: Page): Promise<void> {
  await page.route('**/api/cap/list_goals', (route) =>
    route.fulfill(answer('list_goals', { items: GOALS })),
  );
  await page.route('**/api/cap/get_goal', (route) => route.fulfill(answer('get_goal', DETAIL)));
  await page.route('**/api/cap/get_goal_revision', async (route) => {
    const body = route.request().postDataJSON() as { revision?: number } | null;
    const n = body?.revision === 2 ? 2 : 1;
    await route.fulfill(answer('get_goal_revision', revision(n)));
  });
  await page.route('**/api/cap/list_goal_unresolved_actions', (route) =>
    route.fulfill(answer('list_goal_unresolved_actions', { items: UNRESOLVED })),
  );
  await page.route('**/api/cap/list_principals', (route) =>
    route.fulfill(
      answer('list_principals', { items: [member(ALICE, 'alice'), member(BOB, 'bob')] }),
    ),
  );
  await page.route('**/api/cap/list_gatekeepers', (route) =>
    route.fulfill(
      answer('list_gatekeepers', {
        items: [
          {
            id: GATE,
            name: 'cert-gate',
            kind: 'http',
            status: 'active',
            operationCount: 2,
            createdAt: T0,
          },
        ],
      }),
    ),
  );
  await page.route('**/api/cap/resolve_refs', async (route) => {
    const body = route.request().postDataJSON() as { ids?: string[] } | null;
    const items = (body?.ids ?? []).flatMap((id) => {
      const ref = NAMES[id];
      return ref ? [{ id, ...ref }] : [];
    });
    await route.fulfill(answer('resolve_refs', { items }));
  });
}

test.describe('S11 GO6: a goal’s pages with content (stand-in reads)', () => {
  test.skip(!OWNER_API_KEY, 'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY to run this suite');

  for (const width of [1440, 390] as const) {
    test(`list and detail read at ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await answerGoalReads(page);
      await loginAsOwner(page);

      await page.goto('/#/work/goals');
      const rows = page.getByTestId('goal-row');
      await expect(rows).toHaveCount(3, { timeout: 15_000 });
      await expect(page.getByTestId('goals-requester-filter')).toBeVisible();
      await expect(rows.first()).toContainText('alice');
      await page.screenshot({
        path: testInfo.outputPath(`goals-list-${width}.png`),
        fullPage: true,
      });

      await rows.first().click();
      await expect(page).toHaveURL(new RegExp(`#/work/goals/${GOAL}$`));
      // Three steps in the plan in force; the one revision 2 replaced sits folded below them.
      await expect(
        page.locator('[data-testid="goal-step"]:not([data-step-status="superseded"])'),
      ).toHaveCount(3, { timeout: 15_000 });
      await expect(
        page.locator('[data-testid="goal-step"][data-step-status="superseded"]'),
      ).toBeHidden();
      await expect(page.getByTestId('goal-state-note')).toContainText('有动作结果不明');
      await expect(page.getByTestId('goal-unresolved-check')).toContainText('删除');
      await expect(page.getByTestId('goal-step-waiting')).toBeVisible();
      // GO5d-1: apply's input comes from fetch's output; fetch's first attempt was refused and
      // redone once by the platform.
      await expect(page.getByTestId('goal-step-binding')).toHaveText(
        '输入 target.hosts 来自步骤 fetch 输出的 hosts',
      );
      await expect(page.getByTestId('goal-step-attempt-rework')).toHaveCount(1);
      await expect(page.getByTestId('goal-step-attempt-problems')).toContainText('output.hosts');
      const contract = page.getByTestId('goal-step-output-contract');
      // Its own summary: the schema's disclosure nested inside has one too.
      await contract.locator(':scope > summary').click();
      await expect(contract.getByTestId('output-contract-field')).toHaveCount(2);
      const output = page.getByTestId('goal-step-output');
      await output.locator('summary').click();
      await expect(output).toContainText('web-2');
      await expect(page.getByTestId('goal-revision')).toHaveCount(2);
      // GO5d-2: where the plan came from, on the plan and on revision 1, linked to the Procedure.
      await expect(page.getByTestId('goal-plan-source')).toHaveText('由流程 证书续期 v3 生成');
      await expect(page.getByTestId('goal-plan-source-link')).toHaveAttribute(
        'href',
        `#/govern/catalog/procedures/${PROCEDURE}`,
      );
      await expect(page.getByTestId('goal-revision-from-procedure')).toHaveCount(1);
      // The owner on alice's paused goal: hold it or cancel it, record what was found about the
      // action; resuming it is alice's alone.
      await expect(page.getByTestId('goal-op-hold')).toBeVisible();
      await expect(page.getByTestId('goal-op-cancel')).toBeVisible();
      await expect(page.getByTestId('goal-op-resume')).toHaveCount(0);
      await expect(page.getByTestId('goal-reconcile-record')).toBeVisible();

      const diff = page.getByTestId('goal-revision-diff').first();
      await diff.locator('summary').click();
      await expect(diff.getByTestId('goal-revision-diff-body')).toContainText('remove-old');
      await page.screenshot({
        path: testInfo.outputPath(`goal-detail-${width}.png`),
        fullPage: true,
      });
    });
  }
});

/**
 * The signed-in owner's id, read off the real `get_workspace` as the page makes it. Wrapped in an
 * object: an async function returning the bare promise would adopt it, and awaiting the route
 * set-up would then wait for a request the page has not made yet.
 */
async function signedInOwner(page: Page): Promise<{ id: Promise<string> }> {
  let resolve: (id: string) => void = () => undefined;
  const owner = new Promise<string>((done) => {
    resolve = done;
  });
  await page.route('**/api/cap/get_workspace', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { result?: { caller?: { id?: string } } };
    if (body.result?.caller?.id) resolve(body.result.caller.id);
    await route.fulfill({ response });
  });
  return { id: owner };
}

test.describe('S11 GO6: operations on a goal (stand-in reads and operations)', () => {
  test.skip(!OWNER_API_KEY, 'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY to run this suite');

  for (const width of [1440, 390] as const) {
    test(`confirm card, lifting a hold and a refused note at ${width}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await answerGoalReads(page);
      const owner = (await signedInOwner(page)).id;
      let detail: (ownerId: string) => unknown = () => DETAIL;
      let unresolved: unknown[] = [];
      await page.route('**/api/cap/get_goal', async (route) => {
        const ownerId = await owner;
        NAMES[ownerId] = { kind: 'principal', name: 'owner' };
        await route.fulfill(answer('get_goal', detail(ownerId)));
      });
      await page.route('**/api/cap/list_goal_unresolved_actions', (route) =>
        route.fulfill(answer('list_goal_unresolved_actions', { items: unresolved })),
      );
      const fired: { name: string; params: unknown }[] = [];
      const operations: Record<string, unknown> = {
        confirm_goal: { goalRunId: GOAL, status: 'running', changed: true, createdStepRunIds: [] },
        release_goal_hold: { goalRunId: GOAL, status: 'paused', changed: true },
      };
      for (const [name, result] of Object.entries(operations)) {
        await page.route(`**/api/cap/${name}`, async (route) => {
          fired.push({ name, params: route.request().postDataJSON() });
          await route.fulfill(answer(name, result));
        });
      }
      await page.route('**/api/cap/end_goal', async (route) => {
        fired.push({ name: 'end_goal', params: route.request().postDataJSON() });
        await route.fulfill({
          status: 400,
          json: {
            ok: false,
            error: {
              code: 'credentials_in_text',
              message: 'note: looks like it carries a credential',
              details: { field: 'note', suspectedSecretValues: 1 },
            },
          },
        });
      });
      await page.route('**/api/cap/audit_query', (route) =>
        route.fulfill(
          answer('audit_query', {
            items: [
              {
                id: 'audit-hold',
                actorPrincipalId: BOB,
                action: 'goal_run.pause',
                resourceType: 'goal_run',
                resourceId: GOAL,
                payload: { pausedByAuthority: 'owner' },
                createdAt: T1,
              },
            ],
          }),
        ),
      );
      await loginAsOwner(page);

      // 1. The owner's own proposal: the confirm card says what confirming starts.
      const proposal = { ...revision(1), status: 'proposed', decidedBy: null, decidedAt: null };
      detail = (ownerId) => ({
        ...DETAIL,
        ...run({ status: 'proposed', pauseReason: null, currentRevision: null, confirmedAt: null }),
        onBehalfOf: ownerId,
        planRevision: proposal,
        revisions: [{ ...summary(1), status: 'proposed', decidedBy: null, decidedAt: null }],
        steps: [],
        usage: { tokens: 0, steps: 0, revisions: 0 },
      });
      await page.goto(`/#/work/goals/${GOAL}`);
      await page.getByTestId('goal-op-confirm').click({ timeout: 15_000 });
      const confirm = page.getByTestId('goal-op-confirm-confirm');
      await expect(confirm.getByTestId('confirm-impact')).toContainText('3 个步骤');
      await expect(page.getByTestId('goal-op-reject')).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`goal-confirm-${width}.png`),
        fullPage: true,
      });
      await confirm.getByTestId('confirm-button').click();
      await expect(page.getByTestId('goal-op-done')).toContainText('目标已确认');
      expect(fired.find((call) => call.name === 'confirm_goal')?.params).toEqual({
        goalRunId: GOAL,
        revision: 1,
      });

      // 2. Alice's goal the owner held: lifting the hold says alice revised the plan since.
      detail = () => ({
        ...DETAIL,
        pauseReason: 'requested',
        pausedBy: BOB,
        pausedByAuthority: 'owner',
      });
      await page.reload();
      await page.getByTestId('goal-op-release').click({ timeout: 15_000 });
      const release = page.getByTestId('goal-op-release-confirm');
      await expect(release.getByTestId('goal-hold-plan')).toContainText('第 2 版');
      await page.screenshot({
        path: testInfo.outputPath(`goal-release-${width}.png`),
        fullPage: true,
      });
      await release.getByTestId('confirm-button').click();
      await expect(page.getByTestId('goal-op-done')).toContainText('锁定已解除');

      // 3. The owner's own paused goal: a note refused for a credential says how to rewrite it.
      detail = (ownerId) => ({
        ...DETAIL,
        onBehalfOf: ownerId,
        pauseReason: 'awaiting_reconcile',
        steps: DETAIL.steps.map((step) =>
          step.stepKey === 'apply' ? { ...step, status: 'failed', waitingReason: null } : step,
        ),
      });
      unresolved = UNRESOLVED;
      await page.reload();
      await expect(page.getByTestId('goal-reconcile-record')).toBeVisible({ timeout: 15_000 });
      await page.getByTestId('goal-op-end').click();
      const end = page.getByTestId('goal-op-end-confirm');
      await end.getByTestId('goal-op-note').fill('token=not-a-real-value');
      await end.getByTestId('confirm-button').click();
      await expect(end).toContainText('比如「token 过期了」');
      await expect(end.getByTestId('goal-op-note')).toHaveValue('token=not-a-real-value');
      await page.screenshot({
        path: testInfo.outputPath(`goal-end-refused-${width}.png`),
        fullPage: true,
      });
    });
  }
});

/**
 * The plan editor (`revise_goal`) on the owner's own paused goal. `revise_goal` refuses a text
 * holding a credential (400 `credentials_in_text`) or the `[redacted]` mark a read put in its place
 * (400 `redacted_text_submitted`) only once GO5c lands, so both refusals — and the revision that
 * then goes through — are stand-ins here, each naming its field in `details.field` the way GO5c's
 * contract says (`reason`, `plan.steps.<i>.input…`, every place in `paths`). The Workers to choose from are a stand-in too:
 * the CI stack has none published under the plan's Worker id.
 */
test.describe('S11 GO6: revising the plan (stand-in reads, refusals and revision)', () => {
  test.skip(!OWNER_API_KEY, 'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY to run this suite');

  const refusal = (code: string, field: string, details: Record<string, unknown>) => ({
    status: 400,
    json: {
      ok: false,
      error: { code, message: `${field}: refused`, details: { field, ...details } },
    },
  });
  const workerVersion = (version: number) => ({
    id: WORKER,
    version,
    kind: 'worker',
    status: 'published',
    definition: { name: 'cert-rotator' },
    proposedBy: ALICE,
    publishedBy: ALICE,
    createdAt: T0,
    publishedAt: T0,
  });
  /** The error `kit/field` shows under a control, by the control's id. */
  const fieldError = async (page: Page, control: ReturnType<Page['getByTestId']>) =>
    page.locator(`[id="${await control.getAttribute('id')}-error"]`);

  for (const width of [1440, 390] as const) {
    test(`masked input, both refusals on their fields and the revision at ${width}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await answerGoalReads(page);
      const owner = (await signedInOwner(page)).id;
      await page.route('**/api/cap/get_goal', async (route) => {
        const ownerId = await owner;
        NAMES[ownerId] = { kind: 'principal', name: 'owner' };
        await route.fulfill(
          answer('get_goal', {
            ...DETAIL,
            onBehalfOf: ownerId,
            pauseReason: 'requested',
            pausedBy: ownerId,
            pausedByAuthority: 'requester',
            planRevision: {
              ...revision(2),
              plan: {
                ...PLAN_V2,
                steps: [
                  PLAN_V2.steps[0],
                  PLAN_V2.steps[1],
                  { ...PLAN_V2.steps[2], input: { keep: 'none', auth: '[redacted]' } },
                ],
              },
            },
          }),
        );
      });
      await page.route('**/api/cap/list_worker_definitions', (route) =>
        route.fulfill(
          answer('list_worker_definitions', { items: [workerVersion(3), workerVersion(2)] }),
        ),
      );
      const sent: unknown[] = [];
      const answers = [
        refusal('credentials_in_text', 'reason', { suspectedSecretValues: 1 }),
        refusal('redacted_text_submitted', 'plan.steps.2.input.auth', {
          paths: ['plan.steps.2.input.auth'],
        }),
        answer('revise_goal', {
          goalRunId: GOAL,
          status: 'paused',
          changed: true,
          revision: 3,
          planRevisionId: 'rev-3',
          supersededStepRunIds: ['sr-apply'],
          createdStepRunIds: ['sr-apply-3'],
          withdrawnActionRequestIds: [],
          releasedActionRequestIds: [],
          hints: [
            {
              code: 'step_gate_not_held',
              message: 'step: gate not held',
              stepKey: PLAN_V2.steps[1].key,
              gatekeeperIds: [GATE],
            },
          ],
        }),
      ];
      await page.route('**/api/cap/revise_goal', async (route) => {
        sent.push(route.request().postDataJSON());
        const next = answers.shift();
        if (!next) throw new Error('revise_goal sent more often than scripted');
        await route.fulfill(next);
      });
      await loginAsOwner(page);
      await page.goto(`/#/work/goals/${GOAL}`);
      await page.getByTestId('goal-op-revise').click({ timeout: 15_000 });

      // 1. Prefilled from v2. The masked input left alone would keep its original; changed with
      //    the mark still in it, it is held back before anything is sent.
      const editor = page.getByTestId('goal-plan-editor');
      await expect(editor).toContainText('基于第 2 版');
      const stepOf = (key: string) =>
        editor.locator(`[data-testid="goal-plan-step"][data-step-key="${key}"]`);
      const removeOldInput = stepOf('remove-old').getByTestId('goal-plan-step-input');
      await expect(removeOldInput).toHaveValue(/\[redacted\]/);
      await expect(stepOf('remove-old')).toContainText('不改这一项，提交时原文原样保留');
      await expect(await fieldError(page, removeOldInput)).toHaveCount(0);
      await expect(stepOf('apply').getByTestId('goal-plan-step-worker')).toHaveValue(WORKER);
      await expect(page.getByTestId('goal-plan-wait')).toContainText('还没有改动');
      await removeOldInput.fill('{"keep": "all", "auth": "[redacted]"}');
      await expect(await fieldError(page, removeOldInput)).toContainText(
        '此处原文已遮蔽，请重新填写',
      );
      await expect(page.getByTestId('goal-plan-submit')).toBeDisabled();
      await page.screenshot({
        path: testInfo.outputPath(`goal-plan-masked-${width}.png`),
        fullPage: true,
      });

      // 2. Written again, apply moved to v3, a reason that reads like a credential: refused on it.
      await removeOldInput.fill('{"keep": "none", "auth": "用 deploy 账号的令牌"}');
      await stepOf('apply').getByTestId('goal-plan-step-version').selectOption('3');
      const reason = page.getByTestId('goal-plan-reason');
      await reason.fill('token=not-a-real-value');
      const send = async () => {
        await page.getByTestId('goal-plan-submit').click();
        await page.getByTestId('goal-plan-confirm').getByTestId('confirm-button').click();
      };
      await send();
      await expect(await fieldError(page, reason)).toContainText('用 deploy 账号的令牌');
      await expect(page.getByTestId('goal-plan-refused')).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`goal-plan-credentials-${width}.png`),
        fullPage: true,
      });

      // 3. The reason rewritten; the kernel still finds the mark in remove-old's input.
      await reason.fill('apply 换用 v3 的 Worker');
      await send();
      await expect(await fieldError(page, removeOldInput)).toContainText(
        '此处原文已遮蔽，请重新填写',
      );
      await expect(await fieldError(page, reason)).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath(`goal-plan-redacted-${width}.png`),
        fullPage: true,
      });

      // 4. Written again: the revision goes through on v2, and the page says the goal waits.
      await removeOldInput.fill('{"keep": "none"}');
      await send();
      await expect(page.getByTestId('goal-op-done')).toContainText('计划已改为第 3 版');
      // What the requester's authority would stop in the revised plan: only the result says it.
      await expect(page.getByTestId('goal-op-note')).toHaveCount(1);
      await expect(page.getByTestId('goal-op-note')).toContainText('门「cert-gate」');
      await expect(page.getByTestId('goal-op-note')).toContainText('再修订计划');
      await expect(page.getByTestId('goal-plan-editor')).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath(`goal-plan-done-${width}.png`),
        fullPage: true,
      });
      expect(sent).toHaveLength(3);
      expect(sent[2]).toMatchObject({
        goalRunId: GOAL,
        basedOnRevision: 2,
        reason: 'apply 换用 v3 的 Worker',
        plan: {
          steps: [
            PLAN_V2.steps[0],
            { ...PLAN_V2.steps[1], worker: { definitionId: WORKER, version: 3 } },
            { ...PLAN_V2.steps[2], input: { keep: 'none' } },
          ],
        },
      });
    });
  }
});
