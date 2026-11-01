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

  it('S11 GO8a / GO15b: a step’s WorkerSpec left alone rides along as it is, whatever else changes', async () => {
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
    // S11 GO15b: no longer among what stays as it is — it is edited under 「对 Worker 的调整」, open
    // since the step sets some of it.
    expect(fetch.textContent).not.toContain('这一步对 Worker 的调整保持不变');
    const section = within(fetch).getByTestId('goal-plan-step-spec');
    expect((section as HTMLDetailsElement).open).toBe(true);
    expect(within(section).getByTestId('goal-plan-step-spec-summary').textContent).toMatch(
      /^调整了：职责说明、Skill$/,
    );
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

describe('S11 GO15b: a step’s adjustments to its Worker, edited in the plan editor', () => {
  const directories: Record<string, (params: unknown) => unknown> = {
    get_worker_definition: (params) => ({
      id: WORKER_ID,
      version: (params as { version: number }).version,
      kind: 'worker',
      status: 'published',
      definition: {
        name: 'cert-worker',
        systemPrompt: 'You renew certificates.',
        skills: ['cert-rotation'],
        model: 'model-a',
        capabilities: ['get_task'],
      },
    }),
    list_skills: () => ({
      items: [
        {
          id: '55555555-5555-4555-8555-555555555555',
          version: 2,
          status: 'published',
          name: 'cert-rotation',
          description: '',
        },
        {
          id: '66666666-6666-4666-8666-666666666666',
          version: 1,
          status: 'published',
          name: 'audit',
          description: '',
        },
        {
          id: '77777777-7777-4777-8777-777777777777',
          version: 1,
          status: 'draft',
          name: 'renew-draft',
          description: '',
        },
        {
          id: '88888888-8888-4888-8888-888888888888',
          version: 3,
          status: 'deprecated',
          name: 'legacy-scan',
          description: '',
        },
      ],
    }),
    list_capability_names: () => ({
      items: [
        { name: 'get_task', mode: 'observe' },
        { name: 'propose_action', mode: 'propose' },
      ],
    }),
    list_models: () => ({
      items: [
        { id: 'model-a', provider: 'p', model: 'a' },
        { id: 'model-b', provider: 'p', model: 'b' },
        { id: 'model-c', provider: 'p', model: 'c' },
      ],
    }),
    get_agent_policy: () => ({
      workspaceId: 'ws-1',
      allowedModels: ['model-a', 'model-b'],
      defaultModel: null,
      memberCanEditProfile: true,
      maxPromptAddendumChars: 1000,
      allowedSkills: [],
      allowedGatekeepers: [],
      allowMemberAutoApproveLow: false,
      updatedAt: null,
      updatedBy: null,
    }),
  };
  const revised = {
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
  };
  const withSpec = (spec: Record<string, unknown>) =>
    paused({
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
  const sentSteps = (http: { calls: { name: string; params: unknown }[] }) =>
    (
      http.calls.find((call) => call.name === 'revise_goal')?.params as {
        plan: GoalDetailWire['planRevision']['plan'];
      }
    ).plan.steps;
  const openSpec = async (element: HTMLElement) => {
    const section = within(element).getByTestId('goal-plan-step-spec') as HTMLDetailsElement;
    if (!section.open) {
      section.open = true;
      fireEvent(section, new Event('toggle'));
    }
    return within(element).findByTestId('goal-plan-spec-fields');
  };
  const inherit = (element: HTMLElement, field: string) =>
    within(element)
      .getAllByTestId('goal-plan-spec-inherit')
      .find((box) => box.getAttribute('data-field') === field) as HTMLInputElement;
  const option = (element: HTMLElement, testId: string, label: string) =>
    within(within(element).getByTestId(testId))
      .getAllByRole('checkbox')
      .find((box) => box.closest('label')?.textContent === label) as HTMLInputElement;

  it('starts closed on a step that sets nothing, and reads the directories only once opened', async () => {
    const http = scriptedHttp(
      handlers(paused(), workspace('p-alice', 'member'), { ...directories }),
    );
    renderPage(http);
    await openEditor();
    const fetch = step('fetch');
    const section = within(fetch).getByTestId('goal-plan-step-spec') as HTMLDetailsElement;
    expect(section.open).toBe(false);
    expect(within(fetch).getByTestId('goal-plan-step-spec-summary').textContent).toBe(
      '沿用 Worker 定义',
    );
    expect(http.calls.some((call) => call.name === 'list_skills')).toBe(false);
    await openSpec(fetch);
    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'get_worker_definition')).toBe(true),
    );
  });

  it('picks each field from what it may be, starting from the definition, and sends the WorkerSpec', async () => {
    const http = scriptedHttp(
      handlers(paused(), workspace('p-alice', 'member'), { ...directories, ...revised }),
    );
    renderPage(http);
    await openEditor();
    const fetch = step('fetch');
    await openSpec(fetch);
    // Each field says what the definition version the step names has.
    await waitFor(() =>
      expect(
        within(fetch)
          .getAllByTestId('goal-plan-spec-base')
          .map((line) => line.textContent),
      ).toEqual([
        expect.stringMatching(/^定义：cert-rotation$/),
        '定义：不作用于任何门',
        expect.stringMatching(/^定义：\S+$/),
        expect.stringMatching(/^定义：model-a$/),
      ]),
    );
    // Unticking 沿用定义 starts from the definition's list; Skills on offer are the published ones
    // and a draft, said to be one, never one only deprecated.
    fireEvent.click(inherit(fetch, 'skills'));
    await waitFor(() =>
      expect(option(fetch, 'goal-plan-spec-skills', 'cert-rotation').checked).toBe(true),
    );
    const offered = within(within(fetch).getByTestId('goal-plan-spec-skills'))
      .getAllByRole('checkbox')
      .map((box) => box.closest('label')?.textContent);
    expect(offered).toEqual([
      'cert-rotation',
      'audit',
      'renew-draft（草稿：要有人批准试用，这一步才会开始）',
    ]);
    fireEvent.click(option(fetch, 'goal-plan-spec-skills', 'audit'));
    // Models: the catalog's that the workspace allows, the definition's said in the first option.
    const model = within(fetch).getByTestId('goal-plan-spec-model') as HTMLSelectElement;
    await waitFor(() =>
      expect([...model.options].map((item) => item.value)).toEqual(['', 'model-a', 'model-b']),
    );
    expect(model.options[0]?.textContent).toBe('沿用定义（model-a）');
    fireEvent.change(model, { target: { value: 'model-b' } });
    fireEvent.change(within(fetch).getByTestId('goal-plan-spec-token-budget'), {
      target: { value: '20000' },
    });
    expect(within(fetch).getByTestId('goal-plan-step-spec-summary').textContent).toBe(
      '调整了：Skill、模型、每次尝试的 Token 上限',
    );
    fireEvent.change(screen.getByTestId('goal-plan-reason'), { target: { value: '多做一次审计' } });
    const submit = screen.getByTestId('goal-plan-submit') as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    const confirm = await screen.findByTestId('goal-plan-confirm');
    expect(confirm.textContent).toMatch(/改动 fetch：.*模型设为 model-b（原来沿用 Worker 定义）/);
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(sentSteps(http)[0]).toEqual({
        key: 'fetch',
        worker: { definitionId: WORKER_ID, version: 2 },
        input: { hosts: 3 },
        spec: { skills: ['cert-rotation', 'audit'], model: 'model-b', tokenBudget: 20000 },
      }),
    );
  });

  it('clears every adjustment, and the step runs its Worker as it is', async () => {
    const http = scriptedHttp(
      handlers(
        withSpec({ instructions: 'Only the hosts.', observeScope: [GATE_ID] }),
        workspace('p-alice', 'member'),
        { ...directories, ...revised },
      ),
    );
    renderPage(http);
    await openEditor();
    const fetch = step('fetch');
    await within(fetch).findByTestId('goal-plan-spec-fields');
    expect(inherit(fetch, 'observeScope').checked).toBe(false);
    await waitFor(() =>
      expect(option(fetch, 'goal-plan-spec-observe-scope', 'cert-gate').checked).toBe(true),
    );
    fireEvent.click(within(fetch).getByTestId('goal-plan-spec-clear'));
    expect(within(fetch).getByTestId('goal-plan-step-spec-summary').textContent).toBe(
      '沿用 Worker 定义',
    );
    await send();
    // Left out of what is sent (`undefined` does not reach the wire).
    await waitFor(() => expect(sentSteps(http)[0]?.spec).toBeUndefined());
    expect(JSON.parse(JSON.stringify(sentSteps(http)[0]))).toEqual({
      key: 'fetch',
      worker: { definitionId: WORKER_ID, version: 2 },
      input: { hosts: 3 },
    });
  });

  it('keeps a masked responsibility left alone, and holds it once another adjustment changes', async () => {
    const spec = { instructions: 'Use token [redacted] only.', skills: ['cert-rotation'] };
    const http = scriptedHttp(
      handlers(withSpec(spec), workspace('p-alice', 'member'), { ...directories, ...revised }),
    );
    renderPage(http);
    await openEditor();
    const fetch = step('fetch');
    await within(fetch).findByTestId('goal-plan-spec-fields');
    expect(fetch.textContent).toContain('这里有遮蔽的原文：不改这一步对 Worker 的调整');
    const model = within(fetch).getByTestId('goal-plan-spec-model') as HTMLSelectElement;
    await waitFor(() => expect(model.options.length).toBe(3));
    fireEvent.change(model, { target: { value: 'model-b' } });
    expect(errorOf('goal-plan-spec-instructions')).toMatch(
      /^改了这一步对 Worker 的调整，这一段说明就按新写的算.*请把它重新写成不带凭据的说明。$/,
    );
    expect((screen.getByTestId('goal-plan-submit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(model, { target: { value: '' } });
    expect(errorOf('goal-plan-spec-instructions')).toBe('');
    // Left as it is while the Worker's version changes, it is sent as read — the kernel keeps it.
    fireEvent.change(within(fetch).getByTestId('goal-plan-step-version'), {
      target: { value: '3' },
    });
    await send();
    await waitFor(() => expect(sentSteps(http)[0]?.spec).toBe(spec));
  });

  it('UX P2-1 on #889: unticking 沿用定义 starts from the Skills a run mounts now, and holds one with no usable version', async () => {
    const definition = directories.get_worker_definition as (params: unknown) => {
      definition: Record<string, unknown>;
    };
    const http = scriptedHttp(
      handlers(withSpec({ skills: ['ghost', 'audit'] }), workspace('p-alice', 'member'), {
        ...directories,
        ...revised,
        get_worker_definition: (params) => {
          const read = definition(params);
          return {
            ...read,
            definition: {
              ...read.definition,
              skills: ['cert-rotation', 'legacy-scan', 'renew-draft'],
            },
          };
        },
      }),
    );
    renderPage(http);
    await openEditor();
    // The other steps' sections share the one directory read.
    const fetch = step('fetch');
    await within(fetch).findByTestId('goal-plan-spec-fields');
    // A reference with no published version and no draft is kept, to untick, and says so.
    const ghost = '（已弃用或不在了：留着它这一步就不会开始，取消勾选）';
    await waitFor(() =>
      expect(option(fetch, 'goal-plan-spec-skills', `ghost${ghost}`).checked).toBe(true),
    );
    const skillsField = within(fetch)
      .getAllByTestId('goal-plan-spec-field')
      .find((element) => element.getAttribute('data-field') === 'skills') as HTMLElement;
    // Kept as read, it is the kernel's to hint: nothing holds the plan.
    expect(alerts(skillsField)).toBe('');
    const model = within(fetch).getByTestId('goal-plan-spec-model') as HTMLSelectElement;
    await waitFor(() => expect(model.options.length).toBe(3));
    fireEvent.change(model, { target: { value: 'model-b' } });
    // Sent as written, it would keep the step from starting: held on its field.
    expect(alerts(skillsField)).toMatch(/^ghost 已弃用或不在了：这一步点名它就不会开始。/);
    expect((screen.getByTestId('goal-plan-submit') as HTMLButtonElement).disabled).toBe(true);
    // Back to the definition: its line says which of its Skills a run would not mount.
    fireEvent.click(inherit(fetch, 'skills'));
    expect(alerts(skillsField)).toBe('');
    const skillsLine = within(fetch)
      .getAllByTestId('goal-plan-spec-base')
      .find((line) => line.getAttribute('data-field') === 'skills');
    expect(skillsLine?.textContent).toMatch(
      /^定义：cert-rotation、legacy-scan（已弃用或不在了，沿用时不装载）、renew-draft（只有草稿，沿用时不装载）$/,
    );
    // Unticked again, the list starts from what the definition mounts now — never the deprecated
    // one, nor the draft, which stays on offer to tick.
    fireEvent.click(inherit(fetch, 'skills'));
    const ticked = within(within(fetch).getByTestId('goal-plan-spec-skills'))
      .getAllByRole('checkbox')
      .filter((box) => (box as HTMLInputElement).checked)
      .map((box) => box.closest('label')?.textContent);
    expect(ticked).toEqual(['cert-rotation']);
    expect(
      option(fetch, 'goal-plan-spec-skills', 'renew-draft（草稿：要有人批准试用，这一步才会开始）')
        .checked,
    ).toBe(false);
    expect(alerts(skillsField)).toBe('');
    await send();
    await waitFor(() =>
      expect(sentSteps(http)[0]?.spec).toEqual({ skills: ['cert-rotation'], model: 'model-b' }),
    );
  });

  it('UX P3 on #889: the model says the definition’s, a chosen one’s health, and a list ticked empty what it means', async () => {
    const http = scriptedHttp(
      handlers(paused(), workspace('p-alice', 'member'), {
        ...directories,
        list_models: () => ({
          items: [
            {
              id: 'model-a',
              provider: 'p',
              model: 'a',
              health: { status: 'ok', testedAt: '2026-11-01T00:00:00.000Z' },
            },
            {
              id: 'model-b',
              provider: 'q',
              model: 'b',
              health: { status: 'tools_failed', testedAt: '2026-11-01T00:00:00.000Z' },
            },
          ],
        }),
      }),
    );
    renderPage(http);
    await openEditor();
    const fetch = step('fetch');
    await openSpec(fetch);
    const model = within(fetch).getByTestId('goal-plan-spec-model') as HTMLSelectElement;
    await waitFor(() => expect(model.options.length).toBe(3));
    expect(within(fetch).queryByTestId('goal-plan-spec-model-health')).toBeNull();
    fireEvent.change(model, { target: { value: 'model-b' } });
    expect(within(fetch).getByTestId('goal-plan-spec-model-health').textContent).toMatch(
      /^所选模型的供应商「q」/,
    );
    // Capabilities unticked to none: what that leaves the step with.
    fireEvent.click(inherit(fetch, 'capabilities'));
    await within(fetch).findByTestId('goal-plan-spec-capabilities');
    for (const box of within(within(fetch).getByTestId('goal-plan-spec-capabilities'))
      .getAllByRole('checkbox')
      .filter((item) => (item as HTMLInputElement).checked)) {
      fireEvent.click(box);
    }
    // A list set here with something ticked says nothing more.
    fireEvent.click(inherit(fetch, 'skills'));
    await waitFor(() =>
      expect(option(fetch, 'goal-plan-spec-skills', 'cert-rotation').checked).toBe(true),
    );
    const none = within(fetch)
      .getAllByTestId('goal-plan-spec-none')
      .map((note) => note.getAttribute('data-field'));
    expect(none).toEqual(['capabilities']);
  });

  it('holds a token cap that is not a whole number above 0 on its field', async () => {
    const http = scriptedHttp(
      handlers(paused(), workspace('p-alice', 'member'), { ...directories }),
    );
    renderPage(http);
    await openEditor();
    const fetch = step('fetch');
    await openSpec(fetch);
    fireEvent.change(within(fetch).getByTestId('goal-plan-spec-token-budget'), {
      target: { value: '1.5' },
    });
    expect(errorOf('goal-plan-spec-token-budget')).toBe('填一个大于 0 的整数，或者清空。');
    expect((screen.getByTestId('goal-plan-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows what the kernel found in a WorkerSpec on the field it is about', async () => {
    let refusal: HttpError = new HttpError('capability_error', 'plan: invalid', 'invalid_params', {
      problems: [
        'step "fetch": spec: skills that are not there: "audit"',
        'step "fetch": spec: model — one the llm-proxy catalog does not offer: "model-b"',
      ],
    });
    const http = scriptedHttp(
      // A Skill the directory still lists, gone by the time the kernel checks it.
      handlers(withSpec({ skills: ['audit'] }), workspace('p-alice', 'member'), {
        ...directories,
        revise_goal: () => {
          throw refusal;
        },
      }),
    );
    renderPage(http);
    await openEditor();
    const fetch = step('fetch');
    await within(fetch).findByTestId('goal-plan-spec-fields');
    await waitFor(() => expect(option(fetch, 'goal-plan-spec-skills', 'audit').checked).toBe(true));
    const model = within(fetch).getByTestId('goal-plan-spec-model') as HTMLSelectElement;
    await waitFor(() => expect(model.options.length).toBe(3));
    fireEvent.change(model, { target: { value: 'model-b' } });
    await send();
    const field = (name: string) =>
      within(fetch)
        .getAllByTestId('goal-plan-spec-field')
        .find((element) => element.getAttribute('data-field') === name) as HTMLElement;
    await waitFor(() => expect(alerts(field('skills'))).toMatch(/skills that are not there/));
    expect(errorOf('goal-plan-spec-model')).toMatch(/llm-proxy catalog does not offer/);
    expect(within(fetch).queryByTestId('goal-plan-step-problem')).toBeNull();

    // A credential in its responsibility lands there, with how to write it instead.
    refusal = new HttpError('capability_error', 'plan: refused', 'credentials_in_text', {
      field: 'plan.steps.0.spec.instructions',
      suspectedSecretValues: 1,
    });
    fireEvent.click(option(fetch, 'goal-plan-spec-skills', 'audit'));
    fireEvent.change(within(fetch).getByTestId('goal-plan-spec-instructions'), {
      target: { value: 'password=not-a-real-value' },
    });
    await send();
    await waitFor(() =>
      expect(errorOf('goal-plan-spec-instructions')).toMatch(/用 deploy 账号的令牌/),
    );
  });
});
