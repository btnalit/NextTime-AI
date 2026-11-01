// @vitest-environment jsdom
import type { GoalDetailWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import { type CapabilityCaller, SILENT_PUSH_SOURCE } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { GoalDetailPage } from './GoalDetailPage.js';
import { GoalPlanEditor } from './GoalPlanEditor.js';
import { GATE_ID, WORKER_ID, goalDetail, stepRun } from './goal-fixtures.test-helpers.js';

afterEach(cleanup);

function workspace(id: string, role: 'owner' | 'member') {
  return {
    id: 'ws-1',
    name: 'Acme',
    createdAt: '2026-01-01T00:00:00Z',
    principalCount: 2,
    gatekeeperCount: 1,
    caller: { id, role, displayName: id, kind: 'human' },
  };
}

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown>,
): CapabilityCaller & { readonly calls: { name: string; params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      const handler = handlers[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
}

const WORKERS = {
  items: [
    {
      id: WORKER_ID,
      version: 3,
      kind: 'worker',
      status: 'published',
      definition: { name: 'cert-worker' },
    },
    {
      id: WORKER_ID,
      version: 2,
      kind: 'worker',
      status: 'published',
      definition: { name: 'cert-worker' },
    },
  ],
};

function handlers(
  detail: GoalDetailWire,
  as: ReturnType<typeof workspace>,
  extra: Record<string, (params: unknown) => unknown> = {},
) {
  return {
    get_goal: () => detail,
    list_goal_unresolved_actions: () => ({ items: [] }),
    list_gatekeepers: () => ({ items: [{ id: GATE_ID, name: 'cert-gate' }] }),
    resolve_refs: () => ({ items: [] }),
    get_workspace: () => as,
    list_worker_definitions: () => WORKERS,
    ...extra,
  };
}

function renderPage(http: CapabilityCaller) {
  return render(
    <PermissionsProvider>
      <GoalDetailPage http={http} pushes={SILENT_PUSH_SOURCE} goalRunId="goal-1" />
    </PermissionsProvider>,
  );
}

/** Paused by its requester, nothing running: every step may still change. */
const paused = (overrides: Partial<GoalDetailWire> = {}) =>
  goalDetail({
    status: 'paused',
    pauseReason: 'requested',
    pausedBy: 'p-alice',
    // A few minutes ago, so the wall-clock budget is not spent yet.
    confirmedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    steps: [
      stepRun({ status: 'pending', attemptCount: 0, attempts: [] }),
      stepRun({
        id: 'sr-apply',
        stepKey: 'apply',
        status: 'pending',
        attemptCount: 0,
        attempts: [],
      }),
    ],
    ...overrides,
  });

/** The plan with `fetch`'s input masked on read, as the kernel returns it. */
const masked = () =>
  paused({
    planRevision: {
      ...goalDetail().planRevision,
      plan: {
        ...goalDetail().planRevision.plan,
        steps: [
          {
            key: 'fetch',
            worker: { definitionId: WORKER_ID, version: 2 },
            input: { hosts: 3, auth: '[redacted]' },
          },
          ...goalDetail().planRevision.plan.steps.slice(1),
        ],
      },
    },
  });

const step = (key: string) =>
  screen
    .getAllByTestId('goal-plan-step')
    .find((element) => element.getAttribute('data-step-key') === key) as HTMLElement;

const alerts = (element: HTMLElement) =>
  within(element)
    .queryAllByRole('alert')
    .map((alert) => alert.textContent)
    .join('\n');

/** The error `kit/field` shows under the control with this test id. */
const errorOf = (testId: string) =>
  document.getElementById(`${screen.getByTestId(testId).id}-error`)?.textContent ?? '';

async function openEditor() {
  fireEvent.click(await screen.findByTestId('goal-op-revise'));
  return screen.findByTestId('goal-plan-editor');
}

async function send() {
  const submit = screen.getByTestId('goal-plan-submit') as HTMLButtonElement;
  await waitFor(() => expect(submit.disabled).toBe(false));
  fireEvent.click(submit);
  const confirm = await screen.findByTestId('goal-plan-confirm');
  fireEvent.click(within(confirm).getByTestId('confirm-button'));
}

describe('the plan editor while the goal planner has a say (UX P2-1, P2-4 on #864)', () => {
  const PLANNER_ID = '44444444-4444-4444-8444-444444444444';
  const withProposal = () => {
    const base = paused({ pauseReason: 'needs_decision', pausedBy: null, planner: 'propose' });
    return {
      ...base,
      planningRounds: [
        {
          id: 'round-1',
          kind: 'proposal' as const,
          status: 'proposed' as const,
          basedOnRevision: 1,
          point: 'step_failure' as const,
          stepRunId: 'sr-fetch',
          stepKey: 'fetch',
          stepAttempt: 1,
          failureCategory: 'transient' as const,
          acceptanceRound: null,
          taskId: 'task-plan-1',
          revision: 2,
          revisionClass: 'minor' as const,
          classReasons: [],
          outcomeReason: null,
          detail: null,
          createdAt: '2026-10-20T00:05:00.000Z',
          settledAt: '2026-10-20T00:06:00.000Z',
        },
      ],
      revisions: [
        ...base.revisions,
        {
          ...base.revisions[0],
          id: 'rev-2',
          revision: 2,
          status: 'proposed' as const,
          basedOnRevision: 1,
          proposedBy: 'p-planner',
          proposer: 'planner' as const,
          acceptedBy: null,
          reason: 'another Worker',
          decidedBy: null,
          decidedAt: null,
        },
      ],
    } as GoalDetailWire;
  };

  it('says the planner’s proposal is rejected by this revision, and offers no planner Worker for a step', async () => {
    const http = scriptedHttp(
      handlers(withProposal(), workspace('p-alice', 'member'), {
        list_worker_definitions: () => ({
          items: [
            ...WORKERS.items.map((row) => ({ ...row, goalPlanner: false })),
            {
              id: PLANNER_ID,
              version: 1,
              kind: 'worker',
              status: 'published',
              goalPlanner: true,
              definition: { name: 'goal-planner' },
            },
          ],
        }),
      }),
    );
    renderPage(http);
    await openEditor();
    expect((await screen.findByTestId('goal-plan-planner')).textContent).toContain(
      '规划器提的第 2 版修订会被拒绝',
    );
    const fetch = step('fetch');
    const select = within(fetch).getByTestId('goal-plan-step-worker') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(WORKER_ID));
    const values = [...select.options].map((option) => option.value);
    expect(values).toContain(WORKER_ID);
    expect(values).not.toContain(PLANNER_ID);
  });
});

describe('the plan editor on the goal page (S11 GO6, revise_goal)', () => {
  it('is offered to the requester of a paused goal only', async () => {
    renderPage(scriptedHttp(handlers(paused(), workspace('p-alice', 'member'))));
    expect(await screen.findByTestId('goal-op-revise')).toBeTruthy();
    cleanup();

    renderPage(scriptedHttp(handlers(paused(), workspace('p-bob', 'owner'))));
    await screen.findByTestId('goal-op-hold');
    expect(screen.queryByTestId('goal-op-revise')).toBeNull();
    cleanup();

    renderPage(scriptedHttp(handlers(goalDetail(), workspace('p-alice', 'member'))));
    await screen.findByTestId('goal-op-pause');
    expect(screen.queryByTestId('goal-op-revise')).toBeNull();
  });

  it('starts from the plan in force, chosen fields chosen, and sends only what changed', async () => {
    const http = scriptedHttp(
      handlers(paused(), workspace('p-alice', 'member'), {
        revise_goal: () => ({
          goalRunId: 'goal-1',
          status: 'paused',
          changed: true,
          revision: 2,
          planRevisionId: 'rev-2',
          supersededStepRunIds: ['sr-apply'],
          createdStepRunIds: ['sr-apply-2'],
          withdrawnActionRequestIds: [],
          releasedActionRequestIds: [],
          // The plan's own hint stays with the acceptance card; the requester's authority over a
          // step still to start is only in this result.
          hints: [
            { code: 'requester_confirm_only', message: 'no check' },
            {
              code: 'step_gate_not_held',
              message: 'step "apply": …',
              stepKey: 'apply',
              gatekeeperIds: [GATE_ID],
            },
          ],
        }),
      }),
    );
    renderPage(http);
    await openEditor();
    const fetch = step('fetch');
    await waitFor(() =>
      expect((within(fetch).getByTestId('goal-plan-step-worker') as HTMLSelectElement).value).toBe(
        WORKER_ID,
      ),
    );
    expect((within(fetch).getByTestId('goal-plan-step-version') as HTMLSelectElement).value).toBe(
      '2',
    );
    expect(
      JSON.parse((within(fetch).getByTestId('goal-plan-step-input') as HTMLTextAreaElement).value),
    ).toEqual({ hosts: 3 });
    expect(screen.getByTestId('goal-plan-wait').textContent).toMatch(/还没有改动/);

    fireEvent.change(within(step('apply')).getByTestId('goal-plan-step-version'), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByTestId('goal-plan-reason'), {
      target: { value: '换用新版本' },
    });
    await send();
    await waitFor(() =>
      expect(http.calls.find((call) => call.name === 'revise_goal')?.params).toEqual({
        goalRunId: 'goal-1',
        basedOnRevision: 1,
        reason: '换用新版本',
        plan: {
          steps: [
            { key: 'fetch', worker: { definitionId: WORKER_ID, version: 2 }, input: { hosts: 3 } },
            {
              key: 'apply',
              worker: { definitionId: WORKER_ID, version: 3 },
              dependsOn: ['fetch'],
              maxAttempts: 2,
            },
          ],
          acceptance: goalDetail().planRevision.plan.acceptance,
        },
      }),
    );
    const done = await screen.findByTestId('goal-op-done');
    expect(done.textContent).toMatch(/计划已改为第 2 版/);
    const notes = screen.getAllByTestId('goal-op-note');
    expect(notes.map((note) => note.textContent)).toEqual([
      expect.stringMatching(
        /^步骤「apply」的 Worker 要操作门「cert-gate」.*或者再修订计划，换掉或移除这一步。$/,
      ),
    ]);
    expect(screen.queryByTestId('goal-plan-editor')).toBeNull();
    await waitFor(() => expect(document.activeElement?.contains(done)).toBe(true));
  });

  it('S11 GO8a: keeps a step’s WorkerSpec as it is, and says so', async () => {
    const spec = { instructions: 'Only the hosts in the input.', skills: ['cert-rotation'] };
    const withSpec = paused({
      planRevision: {
        ...goalDetail().planRevision,
        plan: {
          ...goalDetail().planRevision.plan,
          steps: [
            {
              key: 'fetch',
              worker: { definitionId: WORKER_ID, version: 2 },
              input: { hosts: 3 },
              spec,
            },
            ...goalDetail().planRevision.plan.steps.slice(1),
          ],
        },
      },
    });
    const http = scriptedHttp(
      handlers(withSpec, workspace('p-alice', 'member'), {
        revise_goal: () => ({
          goalRunId: 'goal-1',
          status: 'paused',
          changed: true,
          revision: 2,
          planRevisionId: 'rev-2',
          supersededStepRunIds: ['sr-fetch'],
          createdStepRunIds: ['sr-fetch-2'],
          withdrawnActionRequestIds: [],
          releasedActionRequestIds: [],
          hints: [],
        }),
      }),
    );
    renderPage(http);
    await openEditor();
    const fetch = step('fetch');
    expect(fetch.textContent).toContain('这一步对 Worker 的调整保持不变');
    await waitFor(() =>
      expect((within(fetch).getByTestId('goal-plan-step-worker') as HTMLSelectElement).value).toBe(
        WORKER_ID,
      ),
    );
    fireEvent.change(within(fetch).getByTestId('goal-plan-step-version'), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByTestId('goal-plan-reason'), { target: { value: '换用新版本' } });
    await send();
    await waitFor(() =>
      expect(
        (
          http.calls.find((call) => call.name === 'revise_goal')?.params as {
            plan: GoalDetailWire['planRevision']['plan'];
          }
        ).plan.steps[0],
      ).toEqual({
        key: 'fetch',
        worker: { definitionId: WORKER_ID, version: 3 },
        input: { hosts: 3 },
        spec,
      }),
    );
  });

  it('S11 GO13: 沿用 Worker 的输出约定 takes the picked version’s contract onto a step without one, and only there', async () => {
    const REPORT = {
      type: 'object',
      properties: { summary: { type: 'string', description: 'What was done' } },
      required: ['summary'],
    };
    const withContract = {
      items: [
        { ...WORKERS.items[0], definition: { name: 'cert-worker', outputSchema: REPORT } },
        WORKERS.items[1],
      ],
    };
    const [fetchStep, applyStep] = goalDetail().planRevision.plan.steps as [
      GoalDetailWire['planRevision']['plan']['steps'][number],
      GoalDetailWire['planRevision']['plan']['steps'][number],
    ];
    const withOwn = paused({
      planRevision: {
        ...goalDetail().planRevision,
        plan: {
          ...goalDetail().planRevision.plan,
          steps: [
            fetchStep,
            {
              ...applyStep,
              worker: { definitionId: WORKER_ID, version: 3 },
              outputSchema: { type: 'object' },
            },
          ],
        },
      },
    });
    const http = scriptedHttp(
      handlers(withOwn, workspace('p-alice', 'member'), {
        list_worker_definitions: () => withContract,
        revise_goal: () => ({
          goalRunId: 'goal-1',
          status: 'paused',
          changed: true,
          revision: 2,
          planRevisionId: 'rev-2',
          supersededStepRunIds: ['sr-fetch'],
          createdStepRunIds: ['sr-fetch-2'],
          withdrawnActionRequestIds: [],
          releasedActionRequestIds: [],
          hints: [],
        }),
      }),
    );
    renderPage(http);
    await openEditor();
    const fetch = step('fetch');
    await waitFor(() =>
      expect((within(fetch).getByTestId('goal-plan-step-worker') as HTMLSelectElement).value).toBe(
        WORKER_ID,
      ),
    );
    // v2 declares no contract: nothing to adopt.
    expect(within(fetch).queryByTestId('goal-plan-step-adopt-output')).toBeNull();
    // A step with its own contract keeps it, and is offered none.
    const apply = step('apply');
    expect(within(apply).queryByTestId('goal-plan-step-adopt-output')).toBeNull();
    expect(apply.textContent).toContain('这一步的输出约定保持不变');
    fireEvent.change(within(fetch).getByTestId('goal-plan-step-version'), {
      target: { value: '3' },
    });
    fireEvent.click(await within(fetch).findByTestId('goal-plan-step-adopt-output'));
    const adopted = within(fetch).getByTestId('goal-plan-step-adopted-output');
    expect(adopted.textContent).toContain('summary');
    await waitFor(() =>
      expect(document.activeElement).toBe(within(fetch).getByTestId('goal-plan-step-drop-output')),
    );
    // Not adopting again, then picking another version, leaves nothing taken.
    fireEvent.click(within(fetch).getByTestId('goal-plan-step-drop-output'));
    await waitFor(() =>
      expect(document.activeElement).toBe(within(fetch).getByTestId('goal-plan-step-adopt-output')),
    );
    // Let go by hand: nothing to explain.
    expect(within(fetch).queryByTestId('goal-plan-step-adoption-dropped')).toBeNull();
    fireEvent.click(within(fetch).getByTestId('goal-plan-step-adopt-output'));
    fireEvent.change(within(fetch).getByTestId('goal-plan-step-version'), {
      target: { value: '2' },
    });
    expect(within(fetch).queryByTestId('goal-plan-step-adopted-output')).toBeNull();
    // Let go by the version change (UX on #880): the step says so, and that v2 declares none.
    expect(within(fetch).getByTestId('goal-plan-step-adoption-dropped').textContent).toContain(
      '原来沿用的输出约定已去掉（那是原来版本的约定）。现在选的版本没有声明输出约定',
    );
    fireEvent.change(within(fetch).getByTestId('goal-plan-step-version'), {
      target: { value: '3' },
    });
    expect(within(fetch).getByTestId('goal-plan-step-adoption-dropped').textContent).toContain(
      '要用现在这个版本的，再沿用一次',
    );
    fireEvent.click(within(fetch).getByTestId('goal-plan-step-adopt-output'));
    expect(within(fetch).queryByTestId('goal-plan-step-adoption-dropped')).toBeNull();
    fireEvent.change(screen.getByTestId('goal-plan-reason'), { target: { value: '检查输出' } });
    // The confirmation says what the revision adopts (UX on #880); nothing is left unused here.
    const submit = screen.getByTestId('goal-plan-submit') as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    const confirm = await screen.findByTestId('goal-plan-confirm');
    expect(confirm.textContent).toContain('沿用 Worker 的输出约定：fetch（输出按约定检查');
    expect(confirm.textContent).not.toContain('声明了输出约定，步骤里没有设置');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(
        (
          http.calls.find((call) => call.name === 'revise_goal')?.params as {
            plan: GoalDetailWire['planRevision']['plan'];
          }
        ).plan.steps[0],
      ).toEqual({
        key: 'fetch',
        worker: { definitionId: WORKER_ID, version: 3 },
        input: { hosts: 3 },
        outputSchema: REPORT,
      }),
    );
  });

  it('keeps a masked input left alone, and holds one changed with the mark still in it', async () => {
    const http = scriptedHttp(
      handlers(masked(), workspace('p-alice', 'member'), {
        revise_goal: () => ({
          goalRunId: 'goal-1',
          status: 'paused',
          changed: true,
          revision: 2,
          planRevisionId: 'rev-2',
          supersededStepRunIds: [],
          createdStepRunIds: [],
          withdrawnActionRequestIds: [],
          releasedActionRequestIds: [],
          hints: [],
        }),
      }),
    );
    renderPage(http);
    await openEditor();
    const input = within(step('fetch')).getByTestId('goal-plan-step-input') as HTMLTextAreaElement;
    expect(input.value).toContain('[redacted]');
    expect(alerts(step('fetch'))).toBe('');
    expect(step('fetch').textContent).toMatch(/不改这一项，提交时原文原样保留/);

    fireEvent.change(input, { target: { value: '{"hosts": 4, "auth": "[redacted]"}' } });
    expect(alerts(step('fetch'))).toMatch(/此处原文已遮蔽，请重新填写/);
    expect((screen.getByTestId('goal-plan-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('goal-plan-wait').textContent).toMatch(/还有 1 处要改/);

    // Back as read: nothing to fix, nothing changed. A change elsewhere sends the input as read.
    fireEvent.change(input, {
      target: { value: JSON.stringify({ hosts: 3, auth: '[redacted]' }, null, 2) },
    });
    expect(alerts(step('fetch'))).toBe('');
    fireEvent.change(within(step('apply')).getByTestId('goal-plan-step-attempts'), {
      target: { value: '3' },
    });
    await send();
    await waitFor(() =>
      expect(
        (
          http.calls.find((call) => call.name === 'revise_goal')?.params as {
            plan: { steps: { input?: unknown }[] };
          }
        ).plan.steps[0]?.input,
      ).toEqual({ hosts: 3, auth: '[redacted]' }),
    );
  });

  it('a refusal stays on its field while another field changes', async () => {
    const http = scriptedHttp(
      handlers(paused(), workspace('p-alice', 'member'), {
        revise_goal: () => {
          throw new HttpError('capability_error', 'reason: refused', 'credentials_in_text', {
            field: 'reason',
            suspectedSecretValues: 1,
          });
        },
      }),
    );
    renderPage(http);
    await openEditor();
    fireEvent.change(within(step('apply')).getByTestId('goal-plan-step-attempts'), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByTestId('goal-plan-reason'), {
      target: { value: 'token=not-a-real-value' },
    });
    await send();
    await waitFor(() => expect(errorOf('goal-plan-reason')).toMatch(/用 deploy 账号的令牌/));
    fireEvent.change(within(step('apply')).getByTestId('goal-plan-step-attempts'), {
      target: { value: '4' },
    });
    expect(errorOf('goal-plan-reason')).toMatch(/用 deploy 账号的令牌/);
  });

  it('shows credentials_in_text on the field it names, with a way to write it instead', async () => {
    const http = scriptedHttp(
      handlers(paused(), workspace('p-alice', 'member'), {
        revise_goal: () => {
          throw new HttpError('capability_error', 'reason: refused', 'credentials_in_text', {
            field: 'reason',
            suspectedSecretValues: 1,
          });
        },
      }),
    );
    renderPage(http);
    await openEditor();
    fireEvent.change(within(step('apply')).getByTestId('goal-plan-step-attempts'), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByTestId('goal-plan-reason'), {
      target: { value: 'token=not-a-real-value' },
    });
    await send();
    await waitFor(() => expect(errorOf('goal-plan-reason')).toMatch(/用 deploy 账号的令牌/));
    expect(screen.getByTestId('goal-plan-refused')).toBeTruthy();
    expect(screen.queryByTestId('goal-plan-confirm')).toBeNull();
    expect(screen.getByTestId('goal-plan-editor')).toBeTruthy();
    expect(http.calls.filter((call) => call.name === 'get_goal')).toHaveLength(1);

    fireEvent.change(screen.getByTestId('goal-plan-reason'), {
      target: { value: '令牌见运维手册' },
    });
    expect(errorOf('goal-plan-reason')).toBe('');
    expect(screen.queryByTestId('goal-plan-refused')).toBeNull();
  });

  it('shows redacted_text_submitted on the step input it names', async () => {
    const http = scriptedHttp(
      handlers(paused(), workspace('p-alice', 'member'), {
        revise_goal: () => {
          throw new HttpError('capability_error', 'masked text', 'redacted_text_submitted', {
            field: 'plan.steps.0.input',
          });
        },
      }),
    );
    renderPage(http);
    await openEditor();
    fireEvent.change(within(step('fetch')).getByTestId('goal-plan-step-attempts'), {
      target: { value: '3' },
    });
    await send();
    await waitFor(() => expect(alerts(step('fetch'))).toMatch(/此处原文已遮蔽，请重新填写/));
    expect(alerts(step('apply'))).toBe('');
    expect(screen.getByTestId('goal-plan-refused')).toBeTruthy();
  });

  it('puts every place a refusal lists on its own field', async () => {
    const http = scriptedHttp(
      handlers(paused(), workspace('p-alice', 'member'), {
        revise_goal: () => {
          throw new HttpError('capability_error', 'plan: refused', 'credentials_in_text', {
            field: 'plan.steps.0.input.password',
            suspectedSecretPaths: [
              'plan.steps.0.input.password',
              'plan.steps.1.reconcile.0.check.params.token',
            ],
            suspectedSecretValues: 2,
          });
        },
      }),
    );
    renderPage(http);
    await openEditor();
    fireEvent.change(within(step('apply')).getByTestId('goal-plan-step-attempts'), {
      target: { value: '3' },
    });
    await send();
    await waitFor(() => expect(alerts(step('fetch'))).toMatch(/用 deploy 账号的令牌/));
    expect(within(step('apply')).getByTestId('goal-plan-step-problem').textContent).toMatch(
      /这里改不了：把这一步移除/,
    );
  });

  it('stays made against the revision it opened on while the goal is read again', async () => {
    const http = scriptedHttp(
      handlers(paused(), workspace('p-alice', 'member'), {
        revise_goal: () => ({
          goalRunId: 'goal-1',
          status: 'paused',
          changed: true,
          revision: 2,
          planRevisionId: 'rev-2',
          supersededStepRunIds: [],
          createdStepRunIds: [],
          withdrawnActionRequestIds: [],
          releasedActionRequestIds: [],
          hints: [],
        }),
      }),
    );
    const editor = (goal: GoalDetailWire) => (
      <PermissionsProvider>
        <GoalPlanEditor
          goal={goal}
          http={http}
          gateNames={new Map()}
          onCancel={vi.fn()}
          onDone={vi.fn()}
        />
      </PermissionsProvider>
    );
    const { rerender } = render(editor(paused()));
    const attempts = () =>
      within(step('apply')).getByTestId('goal-plan-step-attempts') as HTMLSelectElement;
    await waitFor(() => expect(attempts()).toBeTruthy());
    fireEvent.change(attempts(), { target: { value: '3' } });

    // Read again, same revision, a step moved on: the draft stays, the base stays.
    rerender(
      editor(
        paused({
          updatedAt: '2026-10-20T00:20:00.000Z',
          steps: [
            stepRun({ status: 'failed', attemptCount: 1 }),
            stepRun({ id: 'sr-apply', stepKey: 'apply', status: 'pending', attempts: [] }),
          ],
        }),
      ),
    );
    expect(attempts().value).toBe('3');
    expect(screen.queryByTestId('goal-plan-newer')).toBeNull();

    // Read again after someone else's revision 2: refused here, never sent over it.
    const v2 = {
      ...goalDetail().planRevision,
      id: 'rev-2',
      revision: 2,
      basedOnRevision: 1,
      plan: {
        steps: [{ key: 'other', worker: { definitionId: WORKER_ID, version: 2 } }],
      },
    };
    rerender(editor(paused({ currentRevision: 2, planRevision: v2 })));
    expect(screen.getByTestId('goal-plan-newer').textContent).toMatch(
      /你在改的是第 1 版，这期间计划已经改成第 2 版/,
    );
    expect(screen.getByTestId('goal-plan-editor').textContent).toMatch(/基于第 1 版/);
    expect(attempts().value).toBe('3');
    expect((screen.getByTestId('goal-plan-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(http.calls.some((call) => call.name === 'revise_goal')).toBe(false);
  });

  it('takes the focus to its title, and asks before throwing away a changed draft', async () => {
    const http = scriptedHttp(handlers(paused(), workspace('p-alice', 'member')));
    renderPage(http);
    const editor = await openEditor();
    await waitFor(() =>
      expect(document.activeElement?.textContent).toMatch(/修订计划（基于第 1 版）/),
    );
    expect(editor.contains(document.activeElement)).toBe(true);

    fireEvent.change(within(step('apply')).getByTestId('goal-plan-step-attempts'), {
      target: { value: '3' },
    });
    fireEvent.click(screen.getByTestId('goal-plan-cancel'));
    const discard = await screen.findByTestId('goal-plan-discard');
    expect(discard.textContent).toMatch(/改动不会保存/);
    expect(screen.getByTestId('goal-plan-editor')).toBeTruthy();
    fireEvent.click(within(discard).getByTestId('confirm-button'));
    await waitFor(() => expect(screen.queryByTestId('goal-plan-editor')).toBeNull());
  });

  it('moves focus on when 移除 turns into 恢复, a new item is taken out, or a button goes (UX P3-5 on #738)', async () => {
    const http = scriptedHttp(handlers(paused(), workspace('p-alice', 'member')));
    renderPage(http);
    await openEditor();
    const focusedId = () => (document.activeElement as HTMLElement).dataset.testid;

    fireEvent.click(within(step('apply')).getByTestId('goal-plan-step-remove'));
    expect(focusedId()).toBe('goal-plan-step-restore');
    fireEvent.click(document.activeElement as HTMLElement);
    expect(focusedId()).toBe('goal-plan-step-remove');
    expect(step('apply').contains(document.activeElement)).toBe(true);

    fireEvent.click(screen.getByTestId('goal-plan-add-step'));
    const added = screen.getAllByTestId('goal-plan-step').at(-1) as HTMLElement;
    fireEvent.click(within(added).getByTestId('goal-plan-step-remove'));
    expect(focusedId()).toBe('goal-plan-add-step');

    const [observe] = screen.getAllByTestId('goal-plan-check') as [HTMLElement];
    fireEvent.click(within(observe).getByTestId('goal-plan-check-remove'));
    expect(focusedId()).toBe('goal-plan-check-restore');
    fireEvent.click(document.activeElement as HTMLElement);
    expect(focusedId()).toBe('goal-plan-check-remove');

    // 加一条请求人确认 goes once there is one: what the requester is asked takes the focus.
    fireEvent.click(screen.getByTestId('goal-plan-add-confirm'));
    expect(document.activeElement?.tagName).toBe('TEXTAREA');
    const confirm = screen.getAllByTestId('goal-plan-check').at(-1) as HTMLElement;
    expect(confirm.contains(document.activeElement)).toBe(true);
    fireEvent.click(within(confirm).getByTestId('goal-plan-check-remove'));
    expect(focusedId()).toBe('goal-plan-add-confirm');
  });

  it('S11 GO14 (UX P2-1 on #884): after a handoff pause, a new step makes the files again and the step reads its files instead', async () => {
    const base = goalDetail();
    const plan = base.planRevision.plan;
    const detail = paused({
      pauseReason: 'needs_decision',
      pausedBy: null,
      planRevision: {
        ...base.planRevision,
        plan: {
          ...plan,
          steps: [
            plan.steps[0] as (typeof plan.steps)[number],
            { ...(plan.steps[1] as (typeof plan.steps)[number]), filesFrom: ['fetch'] },
          ],
        },
      },
      steps: [
        stepRun({ status: 'succeeded', attemptCount: 1, attempts: [] }),
        stepRun({
          id: 'sr-apply',
          stepKey: 'apply',
          status: 'ready',
          attemptCount: 0,
          attempts: [],
        }),
      ],
    });
    const http = scriptedHttp(
      handlers(detail, workspace('p-alice', 'member'), {
        revise_goal: () => ({
          goalRunId: 'goal-1',
          status: 'paused',
          changed: true,
          revision: 2,
          planRevisionId: 'rev-2',
          supersededStepRunIds: ['sr-apply'],
          createdStepRunIds: ['sr-fetch-2', 'sr-apply-2'],
          withdrawnActionRequestIds: [],
          releasedActionRequestIds: [],
          hints: [],
        }),
      }),
    );
    renderPage(http);
    await openEditor();
    const files = () => within(step('apply')).getByTestId('goal-plan-step-files-from');
    const option = (key: string) =>
      within(files())
        .queryAllByTestId('goal-plan-step-files-from-option')
        .find((input) => input.getAttribute('data-source-step') === key) as
        | HTMLInputElement
        | undefined;
    expect(option('fetch')?.checked).toBe(true);
    expect(step('apply').textContent).not.toContain('留下的文件保持不变');

    fireEvent.click(screen.getByTestId('goal-plan-add-step'));
    const added = screen.getAllByTestId('goal-plan-step').at(-1) as HTMLElement;
    fireEvent.change(within(added).getByTestId('goal-plan-step-key'), {
      target: { value: 'fetch-2' },
    });
    await waitFor(() =>
      expect(
        within(added)
          .getByTestId('goal-plan-step-worker')
          .querySelector(`option[value="${WORKER_ID}"]`),
      ).not.toBeNull(),
    );
    fireEvent.change(within(added).getByTestId('goal-plan-step-worker'), {
      target: { value: WORKER_ID },
    });
    fireEvent.change(within(added).getByTestId('goal-plan-step-version'), {
      target: { value: '2' },
    });
    // Only a step it comes after can be read: fetch-2 is offered once ticked there.
    expect(option('fetch-2')).toBeUndefined();
    const depends = within(step('apply')).getByTestId('goal-plan-step-depends');
    fireEvent.click(within(depends).getByLabelText('fetch-2'));
    fireEvent.click(option('fetch-2') as HTMLInputElement);
    // Unticking fetch there stops reading its files too.
    fireEvent.click(within(depends).getByLabelText('fetch'));
    expect(option('fetch')).toBeUndefined();
    expect(option('fetch-2')?.checked).toBe(true);

    fireEvent.change(screen.getByTestId('goal-plan-reason'), {
      target: { value: '重新取证书，apply 改读新的' },
    });
    // S11 GO15a: the confirm says what changed in the step it redefines.
    const submit = screen.getByTestId('goal-plan-submit') as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    const confirm = await screen.findByTestId('goal-plan-confirm');
    expect(within(confirm).getByTestId('confirm-impact').textContent).toContain(
      '改动 apply：前置步骤加上 fetch-2，去掉 fetch；改读 fetch-2 留下的文件（原来读 fetch）；按新定义重新开始',
    );
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(
        (
          http.calls.find((call) => call.name === 'revise_goal')?.params as {
            plan: GoalDetailWire['planRevision']['plan'];
          }
        ).plan.steps,
      ).toEqual([
        { key: 'fetch', worker: { definitionId: WORKER_ID, version: 2 }, input: { hosts: 3 } },
        {
          key: 'apply',
          worker: { definitionId: WORKER_ID, version: 2 },
          dependsOn: ['fetch-2'],
          maxAttempts: 2,
          filesFrom: ['fetch-2'],
        },
        { key: 'fetch-2', worker: { definitionId: WORKER_ID, version: 2 } },
      ]),
    );
  });

  it('leaves without sending anything', async () => {
    const http = scriptedHttp(handlers(paused(), workspace('p-alice', 'member')));
    renderPage(http);
    await openEditor();
    fireEvent.click(screen.getByTestId('goal-plan-cancel'));
    expect(screen.queryByTestId('goal-plan-editor')).toBeNull();
    expect(await screen.findByTestId('goal-op-revise')).toBeTruthy();
    expect(http.calls.some((call) => call.name === 'revise_goal')).toBe(false);
  });
});
