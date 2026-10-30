// @vitest-environment jsdom
import type {
  EvalBudgetWire,
  EvalFixtureGateWire,
  EvalSuiteSummaryWire,
  EvalSuiteWire,
} from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { EvaluationPage } from './EvaluationPage.js';

afterEach(cleanup);

function kernelError(code: string, message: string): HttpError {
  return new HttpError('capability_error', message, code);
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

const WD = '11111111-1111-4111-8111-111111111111';
const GATE_A = '22222222-2222-4222-8222-222222222222';
const GATE_B = '33333333-3333-4333-8333-333333333333';
const CANARY = `NTEVAL-${'ab'.repeat(16)}`;

const workspaceAs = (role: string) => () => ({
  id: 'ws-1',
  name: 'Acme',
  caller: { id: 'p-me', role, displayName: 'Me', kind: 'human' },
});

const DEFINITIONS = {
  items: [
    { id: WD, version: 2, kind: 'worker', status: 'published', definition: { name: 'restarter' } },
    { id: WD, version: 1, kind: 'worker', status: 'published', definition: { name: 'restarter' } },
  ],
};

function gate(extra: Partial<EvalFixtureGateWire> = {}): EvalFixtureGateWire {
  return {
    gatekeeperId: GATE_A,
    gateName: 'inventory',
    operations: [
      {
        name: 'hosts.list',
        version: 1,
        mode: 'observe',
        description: 'list hosts',
        paramsSchema: {},
        answersAbsent: false,
      },
    ],
    snapshotDigest: `sha256:${'0'.repeat(64)}`,
    addedInVersion: 2,
    addedBy: 'p-me',
    addedAt: '2026-10-30T00:00:00.000Z',
    liveState: 'same',
    ...extra,
  };
}

function suite(extra: Partial<EvalSuiteWire> = {}): EvalSuiteWire {
  return {
    id: 's-1',
    name: 'restart drills',
    description: 'what a restart must not break',
    workerDefinition: { id: WD, version: 1, status: 'published' },
    version: 2,
    fixtureGateCount: 1,
    fixtureGatesNeedingAttention: 0,
    caseCount: 0,
    casesNeedingAttention: 0,
    createdBy: 'p-me',
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
    canary: CANARY,
    fixtureGates: [gate()],
    cases: [],
    history: [
      {
        version: 1,
        kind: 'created',
        actorId: 'p-me',
        reason: null,
        createdAt: '2026-10-30T00:00:00.000Z',
        workerDefinitionVersion: 1,
      },
      {
        version: 2,
        kind: 'fixture_gate_added',
        actorId: 'p-me',
        reason: null,
        createdAt: '2026-10-30T00:00:00.000Z',
        gatekeeperId: GATE_A,
        gateName: 'inventory',
      },
    ],
    ...extra,
  };
}

const BUDGET: EvalBudgetWire = {
  monthlyBudgetUsd: 10,
  spentUsd: 2.5,
  periodStart: '2026-10-01T00:00:00.000Z',
  periodEnd: '2026-11-01T00:00:00.000Z',
  trialCostUsd: 0.4,
  unpricedTrials: 0,
  committedUsd: 0,
};

function summaryOf(full: EvalSuiteWire): EvalSuiteSummaryWire {
  const { canary: _c, fixtureGates: _g, history: _h, ...rest } = full;
  return rest;
}

function baseHandlers(role = 'builder', current: () => EvalSuiteWire = () => suite()) {
  return {
    get_workspace: workspaceAs(role),
    list_eval_suites: () => ({ items: [summaryOf(current())] }),
    get_eval_suite: () => current(),
    get_eval_budget: () => BUDGET,
    list_eval_runs: () => ({ items: [] }),
    list_worker_definitions: () => DEFINITIONS,
    list_principals: () => ({
      items: [{ id: 'p-me', displayName: 'alice', kind: 'human', role }],
    }),
    resolve_refs: () => ({ items: [] }),
    list_draft_evaluations: () => ({ items: [] }),
  };
}

function renderPage(http: CapabilityCaller, suiteId?: string, onSelectSuite = vi.fn()) {
  render(
    <PermissionsProvider>
      <EvaluationPage
        http={http}
        tab="suites"
        itemId={suiteId}
        onNavigate={(_tab, id) => onSelectSuite(id)}
      />
    </PermissionsProvider>,
  );
  return onSelectSuite;
}

describe('EvaluationPage (S10 E3-1a)', () => {
  it('lists suites with their pinned Worker, version and fixture gates; picking one opens it', async () => {
    const http = scriptedHttp(baseHandlers());
    const onSelect = renderPage(http);
    const row = await screen.findByTestId('eval-suite-row');
    expect(row.textContent).toContain('restart drills');
    await waitFor(() => expect(row.textContent).toContain('restarter'));
    expect(row.textContent).toContain('v1');
    expect(row.textContent).toContain('1 个夹具门');
    expect(within(row).queryByTestId('eval-suite-row-attention')).toBeNull();
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith('s-1');
    expect(http.calls.find((c) => c.name === 'list_worker_definitions')?.params).toEqual({
      kind: 'worker',
    });
  });

  it('the detail shows the canary, the frozen operations and the history, newest first', async () => {
    const http = scriptedHttp(baseHandlers());
    renderPage(http, 's-1');
    const detail = await screen.findByTestId('eval-suite-detail');
    expect(within(detail).getByTestId('eval-suite-canary').textContent).toBe(CANARY);
    expect(detail.textContent).toContain('用例集只给人看');
    const gateCard = within(detail).getByTestId('eval-fixture-gate');
    expect(gateCard.textContent).toContain('inventory');
    expect(gateCard.textContent).toContain('hosts.list');
    expect(within(gateCard).queryByTestId('eval-fixture-gate-notice')).toBeNull();
    // Nothing to sync while the gate still matches.
    expect(within(gateCard).queryByTestId('eval-fixture-gate-sync-trigger')).toBeNull();
    const entries = within(detail).getAllByTestId('eval-suite-history-entry');
    expect(entries.map((entry) => entry.getAttribute('data-version'))).toEqual(['2', '1']);
    expect(entries[0]?.textContent).toMatch(/添加夹具门 inventory/);
  });

  it('an auditor reads everything, people by name, and is offered no change', async () => {
    const http = scriptedHttp({
      ...baseHandlers('auditor'),
      // An auditor may not list principals; names come through resolve_refs, as 创建 does.
      list_principals: () => {
        throw kernelError('forbidden', 'list_principals needs operator');
      },
      resolve_refs: () => ({ items: [{ id: 'p-me', kind: 'principal', name: 'alice' }] }),
    });
    renderPage(http, 's-1');
    const detail = await screen.findByTestId('eval-suite-detail');
    await waitFor(() => expect(screen.queryByTestId('eval-suite-create-open')).toBeNull());
    expect(screen.queryByTestId('eval-suite-repin-trigger')).toBeNull();
    expect(screen.queryByTestId('eval-suite-add-gate-trigger')).toBeNull();
    expect(screen.queryByTestId('eval-fixture-gate-remove-trigger')).toBeNull();
    await waitFor(() =>
      expect(within(detail).getByTestId('eval-fixture-gate-added-by').textContent).toContain(
        'alice',
      ),
    );
    for (const actor of within(detail).getAllByTestId('eval-suite-history-actor')) {
      expect(actor.textContent).toContain('alice');
    }
  });

  it('creating a suite picks the Worker and its version, never a typed id', async () => {
    const created = suite({ id: 's-2', name: 'backup drills', version: 1, fixtureGates: [] });
    const http = scriptedHttp({
      ...baseHandlers(),
      list_eval_suites: () => ({ items: [] }),
      create_eval_suite: () => created,
    });
    const onSelect = renderPage(http);
    await screen.findByTestId('eval-suites-empty');
    fireEvent.click(screen.getByTestId('eval-suite-create-open'));
    const sheet = await screen.findByTestId('eval-suite-create');
    const submit = within(sheet).getByTestId('eval-suite-create-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(within(sheet).getByTestId('eval-suite-create-missing').textContent).toContain(
      '填写名字',
    );

    fireEvent.change(within(sheet).getByTestId('eval-suite-create-name'), {
      target: { value: '  backup drills ' },
    });
    const worker = within(sheet).getByTestId('eval-suite-create-worker') as HTMLSelectElement;
    await waitFor(() => expect(worker.disabled).toBe(false));
    expect([...worker.options].map((option) => option.textContent)).toEqual([
      worker.options[0]?.textContent,
      'restarter',
    ]);
    expect(worker.options[0]?.textContent).toMatch(/^选择 Worker$/);
    fireEvent.change(worker, { target: { value: WD } });
    const version = within(sheet).getByTestId('eval-suite-create-version') as HTMLSelectElement;
    expect(version.value).toBe('2');
    expect([...version.options].map((option) => option.textContent)).toEqual(['v2（最新）', 'v1']);
    fireEvent.change(version, { target: { value: '1' } });

    fireEvent.click(submit);
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('s-2'));
    expect(http.calls.find((c) => c.name === 'create_eval_suite')?.params).toEqual({
      name: 'backup drills',
      workerDefinitionId: WD,
      workerDefinitionVersion: 1,
    });
  });

  it('a taken name is refused on the name field', async () => {
    const http = scriptedHttp({
      ...baseHandlers(),
      create_eval_suite: () => {
        throw kernelError('eval_suite_name_taken', 'an evaluation suite named it exists');
      },
    });
    renderPage(http);
    await screen.findByTestId('eval-suite-row');
    fireEvent.click(screen.getByTestId('eval-suite-create-open'));
    const sheet = await screen.findByTestId('eval-suite-create');
    fireEvent.change(within(sheet).getByTestId('eval-suite-create-name'), {
      target: { value: 'Restart Drills' },
    });
    const worker = within(sheet).getByTestId('eval-suite-create-worker') as HTMLSelectElement;
    await waitFor(() => expect(worker.disabled).toBe(false));
    fireEvent.change(worker, { target: { value: WD } });
    fireEvent.click(within(sheet).getByTestId('eval-suite-create-submit'));
    await waitFor(() =>
      expect(sheet.textContent).toContain('工作区里已经有同名的用例集，换一个名字。'),
    );
    expect(within(sheet).getByTestId('eval-suite-create-name').getAttribute('aria-invalid')).toBe(
      'true',
    );
  });

  it('with no published Worker the form says where to publish one', async () => {
    const http = scriptedHttp({
      ...baseHandlers(),
      list_worker_definitions: () => ({ items: [] }),
    });
    renderPage(http);
    await screen.findByTestId('eval-suite-row');
    fireEvent.click(screen.getByTestId('eval-suite-create-open'));
    expect(await screen.findByTestId('eval-suite-create-no-workers')).toBeTruthy();
  });

  it('removing a fixture gate needs a reason and sends the suite version shown', async () => {
    let current = suite();
    const http = scriptedHttp({
      ...baseHandlers('builder', () => current),
      remove_eval_fixture_gate: () => {
        current = suite({ version: 3, fixtureGates: [], fixtureGateCount: 0 });
        return current;
      },
    });
    renderPage(http, 's-1');
    const card = await screen.findByTestId('eval-fixture-gate');
    fireEvent.click(within(card).getByTestId('eval-fixture-gate-remove-trigger'));
    const confirm = await screen.findByTestId('eval-fixture-gate-remove');
    const ok = within(confirm).getByTestId('confirm-button') as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    fireEvent.change(within(confirm).getByTestId('eval-fixture-gate-remove-reason'), {
      target: { value: ' gate retired ' },
    });
    expect(ok.disabled).toBe(false);
    fireEvent.click(ok);
    await waitFor(() => expect(screen.getByTestId('eval-suite-fixture-gates-empty')).toBeTruthy());
    // The card and its 移除 are gone; focus stays in the suite, not on the page.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('eval-suite-fixture-gates')),
    );
    expect(http.calls.find((c) => c.name === 'remove_eval_fixture_gate')?.params).toEqual({
      suiteId: 's-1',
      suiteVersion: 2,
      gatekeeperId: GATE_A,
      reason: 'gate retired',
    });
  });

  it('a change somebody made in between is refused and the suite is read again', async () => {
    let current = suite();
    const http = scriptedHttp({
      ...baseHandlers('builder', () => current),
      remove_eval_fixture_gate: () => {
        current = suite({ version: 3, name: 'restart drills' });
        throw kernelError('version_changed', 'the suite changed');
      },
    });
    renderPage(http, 's-1');
    const card = await screen.findByTestId('eval-fixture-gate');
    fireEvent.click(within(card).getByTestId('eval-fixture-gate-remove-trigger'));
    const confirm = await screen.findByTestId('eval-fixture-gate-remove');
    fireEvent.change(within(confirm).getByTestId('eval-fixture-gate-remove-reason'), {
      target: { value: 'gone' },
    });
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() => expect(confirm.textContent).toContain('用例集在你打开之后被改过'));
    await waitFor(() =>
      expect(screen.getByTestId('eval-suite-detail').textContent).toMatch(/用例集 v3/),
    );
  });

  it('adding a fixture gate offers only gates not in the suite and shows what will be frozen', async () => {
    const http = scriptedHttp({
      ...baseHandlers(),
      list_gatekeepers: () => ({
        items: [
          {
            id: GATE_A,
            name: 'inventory',
            kind: 'http',
            status: 'active',
            operationCount: 1,
            createdAt: 'x',
          },
          {
            id: GATE_B,
            name: 'tickets',
            kind: 'http',
            status: 'active',
            operationCount: 2,
            createdAt: 'x',
          },
        ],
      }),
      list_operations: () => ({
        items: [
          {
            gatekeeperId: GATE_B,
            name: 'tickets.open',
            mode: 'execute',
            blastRadius: 'low',
            autoApprovable: false,
            version: 1,
            status: 'published',
          },
          {
            gatekeeperId: GATE_B,
            name: 'tickets.draft',
            mode: 'observe',
            blastRadius: 'low',
            autoApprovable: true,
            version: 1,
            status: 'draft',
          },
        ],
      }),
      add_eval_fixture_gate: () => suite({ version: 3 }),
    });
    renderPage(http, 's-1');
    fireEvent.click(await screen.findByTestId('eval-suite-add-gate-trigger'));
    const confirm = await screen.findByTestId('eval-suite-add-gate');
    const select = (await within(confirm).findByTestId(
      'eval-suite-add-gate-select',
    )) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect([...select.options].map((option) => option.textContent)).toEqual([
      '选择一个门',
      'tickets',
    ]);
    fireEvent.change(select, { target: { value: GATE_B } });
    const preview = await within(confirm).findByTestId('eval-suite-add-gate-preview');
    expect(preview.textContent).toContain('tickets.open');
    expect(preview.textContent).not.toContain('tickets.draft');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(http.calls.find((c) => c.name === 'add_eval_fixture_gate')?.params).toEqual({
        suiteId: 's-1',
        suiteVersion: 2,
        gatekeeperId: GATE_B,
      }),
    );
  });

  it('a gate with no published operation cannot be added', async () => {
    const http = scriptedHttp({
      ...baseHandlers(),
      list_gatekeepers: () => ({
        items: [
          {
            id: GATE_B,
            name: 'tickets',
            kind: 'http',
            status: 'active',
            operationCount: 1,
            createdAt: 'x',
          },
        ],
      }),
      list_operations: () => ({ items: [] }),
    });
    renderPage(http, 's-1');
    fireEvent.click(await screen.findByTestId('eval-suite-add-gate-trigger'));
    const confirm = await screen.findByTestId('eval-suite-add-gate');
    const select = (await within(confirm).findByTestId(
      'eval-suite-add-gate-select',
    )) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: GATE_B } });
    expect(await within(confirm).findByTestId('eval-suite-add-gate-unpublished')).toBeTruthy();
    expect((within(confirm).getByTestId('confirm-button') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('a gate that changed says so and offers a sync that previews what moves', async () => {
    const changed = suite({
      fixtureGates: [gate({ liveState: 'changed' })],
      fixtureGatesNeedingAttention: 1,
    });
    const http = scriptedHttp({
      ...baseHandlers('builder', () => changed),
      list_operations: () => ({
        items: [
          {
            gatekeeperId: GATE_A,
            name: 'hosts.list',
            mode: 'observe',
            blastRadius: 'low',
            autoApprovable: true,
            version: 2,
            status: 'published',
          },
          {
            gatekeeperId: GATE_A,
            name: 'hosts.reboot',
            mode: 'execute',
            blastRadius: 'medium',
            autoApprovable: false,
            version: 1,
            status: 'published',
          },
        ],
      }),
      sync_eval_fixture_gate: () => suite({ version: 3 }),
    });
    renderPage(http);
    const row = await screen.findByTestId('eval-suite-row');
    expect(within(row).getByTestId('eval-suite-row-attention').textContent).toContain(
      '1 个和门不一致',
    );
    cleanup();

    renderPage(http, 's-1');
    const card = await screen.findByTestId('eval-fixture-gate');
    expect(within(card).getByTestId('eval-fixture-gate-notice').textContent).toContain('同步');
    fireEvent.click(within(card).getByTestId('eval-fixture-gate-sync-trigger'));
    const confirm = await screen.findByTestId('eval-fixture-gate-sync');
    await waitFor(() =>
      expect(within(confirm).getByTestId('confirm-impact').textContent).toMatch(
        /新增 hosts\.reboot/,
      ),
    );
    expect(within(confirm).getByTestId('confirm-impact').textContent).toMatch(/变更 hosts\.list/);
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(http.calls.find((c) => c.name === 'sync_eval_fixture_gate')?.params).toEqual({
        suiteId: 's-1',
        suiteVersion: 2,
        gatekeeperId: GATE_A,
      }),
    );
    // The gate matches again, so 同步 is gone; focus moves to its card, not to the page.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('eval-fixture-gate')),
    );
    expect(screen.queryByTestId('eval-fixture-gate-sync-trigger')).toBeNull();
  });

  it('a name carrying a bidi override or an invisible character is shown with it made visible', async () => {
    const spoofed = 'restart\u202Egnp.exe';
    const gateName = 'inv\u200Bentory';
    const shown = /restart\\u\{202E\}gnp\.exe/;
    const changed = suite({
      fixtureGates: [
        gate({
          gateName,
          liveState: 'changed',
          operations: [
            {
              name: spoofed,
              version: 1,
              mode: 'execute',
              description: null,
              paramsSchema: {},
              answersAbsent: false,
            },
          ],
        }),
      ],
      history: [
        ...suite().history,
        {
          version: 3,
          kind: 'fixture_gate_synced',
          actorId: 'p-me',
          reason: null,
          createdAt: '2026-10-30T00:00:00.000Z',
          gatekeeperId: GATE_A,
          gateName,
          addedOperations: [spoofed],
          removedOperations: [],
          changedOperations: [],
        },
      ],
      version: 3,
    });
    const http = scriptedHttp({
      ...baseHandlers('builder', () => changed),
      list_gatekeepers: () => ({
        items: [
          {
            id: GATE_B,
            name: 'tick\u202Eets',
            kind: 'http',
            status: 'active',
            operationCount: 1,
            createdAt: 'x',
          },
        ],
      }),
      list_operations: (params) => ({
        items: [
          {
            gatekeeperId: (params as { gatekeeperId: string }).gatekeeperId,
            name: `${spoofed}.v2`,
            mode: 'execute',
            blastRadius: 'low',
            autoApprovable: false,
            version: 1,
            status: 'published',
          },
        ],
      }),
    });
    renderPage(http, 's-1');
    const card = await screen.findByTestId('eval-fixture-gate');
    const opName = within(card).getByTestId('eval-fixture-operation-name').textContent ?? '';
    expect(opName).toMatch(shown);
    expect(opName).not.toContain('\u202E');
    expect(card.textContent).toMatch(/inv\\u\{200B\}entory/);
    const synced = screen.getAllByTestId('eval-suite-history-entry')[0]?.textContent ?? '';
    expect(synced).toMatch(shown);
    expect(synced).toMatch(/inv\\u\{200B\}entory/);
    expect(synced).not.toMatch(/[\u202E\u200B]/);

    // The sync preview names what moves the same way.
    fireEvent.click(within(card).getByTestId('eval-fixture-gate-sync-trigger'));
    const sync = await screen.findByTestId('eval-fixture-gate-sync');
    await waitFor(() =>
      expect(within(sync).getByTestId('confirm-impact').textContent).toMatch(
        /新增 restart\\u\{202E\}gnp\.exe\.v2/,
      ),
    );
    expect(sync.textContent).not.toMatch(/[\u202E\u200B]/);
    fireEvent.click(within(sync).getByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('eval-fixture-gate-sync')).toBeNull());

    // And so do the gates and the operations offered for a new fixture gate.
    fireEvent.click(screen.getByTestId('eval-suite-add-gate-trigger'));
    const add = await screen.findByTestId('eval-suite-add-gate');
    const select = (await within(add).findByTestId(
      'eval-suite-add-gate-select',
    )) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.options[1]?.textContent).toMatch(/tick\\u\{202E\}ets/);
    fireEvent.change(select, { target: { value: GATE_B } });
    const preview = await within(add).findByTestId('eval-suite-add-gate-preview');
    expect(preview.textContent).toMatch(shown);
    expect(add.textContent).not.toMatch(/[\u202E\u200B]/);
  });

  it('repinning offers the Worker’s other published versions and an optional reason', async () => {
    const http = scriptedHttp({
      ...baseHandlers(),
      repin_eval_suite: () =>
        suite({ version: 3, workerDefinition: { id: WD, version: 2, status: 'published' } }),
    });
    renderPage(http, 's-1');
    const trigger = (await screen.findByTestId('eval-suite-repin-trigger')) as HTMLButtonElement;
    await waitFor(() => expect(trigger.disabled).toBe(false));
    fireEvent.click(trigger);
    const confirm = await screen.findByTestId('eval-suite-repin');
    const version = within(confirm).getByTestId('eval-suite-repin-version') as HTMLSelectElement;
    expect([...version.options].map((option) => option.textContent)).toEqual(['v2']);
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(http.calls.find((c) => c.name === 'repin_eval_suite')?.params).toEqual({
        suiteId: 's-1',
        suiteVersion: 2,
        workerDefinitionVersion: 2,
      }),
    );
  });

  it('a deprecated pin is flagged, and with no other published version 换版本 says why it is off', async () => {
    const pinned = suite({ workerDefinition: { id: WD, version: 1, status: 'deprecated' } });
    const http = scriptedHttp({
      ...baseHandlers('builder', () => pinned),
      list_worker_definitions: () => ({
        items: [
          {
            id: WD,
            version: 1,
            kind: 'worker',
            status: 'published',
            definition: { name: 'restarter' },
          },
        ],
      }),
    });
    renderPage(http, 's-1');
    expect(await screen.findByTestId('eval-suite-worker-deprecated')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('eval-suite-repin-none').textContent).toContain(
        '没有别的已发布版本',
      ),
    );
    expect((screen.getByTestId('eval-suite-repin-trigger') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe('EvaluationPage — the month’s evaluation budget (S10 E3-2a)', () => {
  it('shows what is spent and left, what a trial costs and when the month resets', async () => {
    const http = scriptedHttp({
      ...baseHandlers(),
      get_eval_budget: () => ({ ...BUDGET, unpricedTrials: 2 }),
    });
    renderPage(http);
    const card = await screen.findByTestId('eval-budget');
    await waitFor(() =>
      expect(within(card).getByTestId('eval-budget-line').textContent).toBe(
        '本月已用 $2.50 / $10.00，剩余 $7.50',
      ),
    );
    expect(within(card).getByTestId('eval-budget-estimate').textContent).toMatch(
      /一次试跑约 \$0\.40/,
    );
    expect(within(card).getByTestId('eval-budget-estimate').textContent).toMatch(/UTC 自然月/);
    expect(within(card).getByTestId('eval-budget-unpriced').textContent).toMatch(/2 次试跑/);
    expect(within(card).queryByTestId('eval-budget-exhausted')).toBeNull();
    // Only the owner sets it.
    expect(within(card).queryByTestId('eval-budget-raise')).toBeNull();
  });

  it('says how much of what is left the trials not ended yet hold (#833 review)', async () => {
    const http = scriptedHttp({
      ...baseHandlers(),
      get_eval_budget: () => ({ ...BUDGET, committedUsd: 1.2 }),
    });
    renderPage(http);
    const card = await screen.findByTestId('eval-budget');
    await waitFor(() =>
      expect(within(card).getByTestId('eval-budget-line').textContent).toBe(
        '本月已用 $2.50 / $10.00，剩余 $7.50，其中约 $1.20 留给还没跑完的试跑',
      ),
    );
  });

  it('once it is spent, says nothing can start, and points the owner to where it is raised', async () => {
    const http = scriptedHttp({
      ...baseHandlers('owner'),
      get_eval_budget: () => ({ ...BUDGET, spentUsd: 10.2, trialCostUsd: null }),
    });
    renderPage(http);
    const card = await screen.findByTestId('eval-budget');
    const exhausted = await within(card).findByTestId('eval-budget-exhausted');
    expect(exhausted.textContent).toMatch(/已经用完/);
    expect(within(card).getByTestId('eval-budget-line').textContent).toMatch(/剩余 \$0\.00/);
    expect(within(card).getByTestId('eval-budget-estimate').textContent).toMatch(/估不出/);
    await waitFor(() => expect(within(exhausted).getByTestId('eval-budget-raise')).toBeTruthy());
  });

  it('a budget of $0 reads as evaluation turned off, not a month used up (#822 UX P3-3)', async () => {
    const http = scriptedHttp({
      ...baseHandlers('owner'),
      get_eval_budget: () => ({ ...BUDGET, monthlyBudgetUsd: 0, spentUsd: 0 }),
    });
    renderPage(http);
    const card = await screen.findByTestId('eval-budget');
    const exhausted = await within(card).findByTestId('eval-budget-exhausted');
    expect(exhausted.textContent).toMatch(/本月评测预算是 \$0，不能试跑/);
    expect(exhausted.textContent).not.toContain('用完');
  });

  it('a budget it cannot read is an error with a retry, the page still usable', async () => {
    let fail = true;
    const http = scriptedHttp({
      ...baseHandlers(),
      get_eval_budget: () => {
        if (fail) throw kernelError('internal', 'boom');
        return BUDGET;
      },
    });
    renderPage(http);
    await screen.findByTestId('eval-budget-error');
    expect(await screen.findByTestId('eval-suite-row')).toBeTruthy();
    fail = false;
    fireEvent.click(within(screen.getByTestId('eval-budget-error')).getByRole('button'));
    await screen.findByTestId('eval-budget-line');
  });
});
