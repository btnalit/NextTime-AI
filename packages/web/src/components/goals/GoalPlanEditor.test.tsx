// @vitest-environment jsdom
import type { GoalDetailWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import { type CapabilityCaller, SILENT_PUSH_SOURCE } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { GoalDetailPage } from './GoalDetailPage.js';
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
    expect((await screen.findByTestId('goal-op-done')).textContent).toMatch(/计划已改为第 2 版/);
    expect(screen.queryByTestId('goal-plan-editor')).toBeNull();
  });

  it('marks a masked input on its field and will not send it until it is written again', async () => {
    const http = scriptedHttp(handlers(masked(), workspace('p-alice', 'member')));
    renderPage(http);
    await openEditor();
    const input = within(step('fetch')).getByTestId('goal-plan-step-input') as HTMLTextAreaElement;
    expect(input.value).toContain('[redacted]');
    expect(alerts(step('fetch'))).toMatch(/此处原文已遮蔽，请重新填写/);
    expect((screen.getByTestId('goal-plan-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('goal-plan-wait').textContent).toMatch(/还有 1 处要改/);

    fireEvent.change(input, { target: { value: '{"hosts": 3, "auth": "用 deploy 账号的令牌"}' } });
    expect(alerts(step('fetch'))).toBe('');
    expect((screen.getByTestId('goal-plan-submit') as HTMLButtonElement).disabled).toBe(false);
    expect(http.calls.some((call) => call.name === 'revise_goal')).toBe(false);
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
