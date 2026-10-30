// @vitest-environment jsdom
import {
  type EvalBudgetWire,
  type EvalCaseSummaryWire,
  type EvalCaseWire,
  type EvalFixtureGateWire,
  type EvalRunSummaryWire,
  type EvalRunWire,
  type EvalSuiteWire,
  type EvalTrialWire,
  evalCallCountPath,
} from '@nexttime/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { EvaluationPage } from './EvaluationPage.js';

afterEach(cleanup);

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
const GATE = '22222222-2222-4222-8222-222222222222';
const AT = '2026-10-30T00:00:00.000Z';

const GATES: EvalFixtureGateWire[] = [
  {
    gatekeeperId: GATE,
    gateName: 'inventory',
    operations: [
      {
        name: 'hosts.get',
        version: 1,
        mode: 'observe',
        description: null,
        paramsSchema: { type: 'object', properties: { host: { type: 'string' } } },
        answersAbsent: true,
      },
      {
        name: 'hosts.list',
        version: 1,
        mode: 'observe',
        description: null,
        paramsSchema: {},
        answersAbsent: false,
      },
      {
        name: 'hosts.restart',
        version: 1,
        mode: 'execute',
        description: null,
        paramsSchema: { type: 'object', properties: { host: { type: 'string' } } },
        answersAbsent: false,
      },
    ],
    snapshotDigest: `sha256:${'0'.repeat(64)}`,
    addedInVersion: 2,
    addedBy: 'p-me',
    addedAt: AT,
    liveState: 'same',
  },
];

const BUDGET: EvalBudgetWire = {
  monthlyBudgetUsd: 10,
  spentUsd: 2.5,
  periodStart: '2026-10-01T00:00:00.000Z',
  periodEnd: '2026-11-01T00:00:00.000Z',
  trialCostUsd: 0.4,
  unpricedTrials: 0,
};

function wholeCase(extra: Partial<EvalCaseWire> = {}): EvalCaseWire {
  const evalCase: EvalCaseWire = {
    id: 'c-1',
    suiteId: 's-1',
    title: 'check dependants first',
    partition: 'regression',
    split: 'dev',
    mechanism: null,
    origin: 'human',
    addedInVersion: 3,
    addedBy: 'p-me',
    addedAt: AT,
    supersedes: null,
    fixtureRuleCount: 1,
    assertionCount: 2,
    fixtureProblems: [],
    fixtureOperations: [],
    input: 'restart web',
    fixtures: [
      {
        gatekeeperId: GATE,
        operation: 'hosts.get',
        when: { path: 'host', op: 'eq', value: 'web' },
        answer: { kind: 'data', data: { dependants: ['api'] } },
      },
    ],
    assertions: [
      { expect: { path: 'result.summary', op: 'contains', value: 'api' } },
      { expect: { path: evalCallCountPath(GATE, 'hosts.restart'), op: 'eq', value: 0 } },
    ],
    contentDigest: `sha256:${'1'.repeat(64)}`,
    retiredInVersion: null,
    retireReason: null,
    supersededBy: null,
    ...extra,
  };
  // The kernel's brief: the distinct gate and operation pairs the rules answer, in rule order.
  const pairs = new Map(
    evalCase.fixtures.map((rule) => [
      `${rule.gatekeeperId}\u0000${rule.operation}`,
      { gatekeeperId: rule.gatekeeperId, operation: rule.operation },
    ]),
  );
  return { ...evalCase, fixtureOperations: extra.fixtureOperations ?? [...pairs.values()] };
}

function summaryOfCase(evalCase: EvalCaseWire): EvalCaseSummaryWire {
  const {
    suiteId: _s,
    input: _i,
    fixtures: _f,
    assertions: _a,
    contentDigest: _d,
    retiredInVersion: _r,
    retireReason: _rr,
    supersededBy: _sb,
    ...summary
  } = evalCase;
  return summary;
}

function suite(cases: EvalCaseWire[], extra: Partial<EvalSuiteWire> = {}): EvalSuiteWire {
  return {
    id: 's-1',
    name: 'restart drills',
    description: '',
    workerDefinition: { id: WD, version: 1, status: 'published' },
    version: 3,
    fixtureGateCount: 1,
    fixtureGatesNeedingAttention: 0,
    caseCount: cases.length,
    casesNeedingAttention: cases.filter((item) => item.fixtureProblems.length > 0).length,
    createdBy: 'p-me',
    createdAt: AT,
    updatedAt: AT,
    canary: `NTEVAL-${'ab'.repeat(16)}`,
    fixtureGates: GATES,
    cases: cases.map(summaryOfCase),
    history: [
      {
        version: 1,
        kind: 'created',
        actorId: 'p-me',
        reason: null,
        createdAt: AT,
        workerDefinitionVersion: 1,
      },
    ],
    ...extra,
  };
}

function handlers(role: string, current: () => EvalSuiteWire, cases: () => EvalCaseWire[]) {
  return {
    get_workspace: () => ({
      id: 'ws-1',
      name: 'Acme',
      caller: { id: 'p-me', role, displayName: 'Me', kind: 'human' },
    }),
    list_eval_suites: () => ({ items: [] }),
    get_eval_suite: () => current(),
    get_eval_budget: () => BUDGET,
    list_eval_runs: () => ({ items: [] }),
    get_eval_case: (params: unknown) => {
      const { caseId } = params as { caseId: string };
      const found = cases().find((item) => item.id === caseId);
      if (!found) throw new HttpError('capability_error', 'no such case', 'not_found');
      return found;
    },
    list_worker_definitions: () => ({
      items: [
        { id: WD, version: 1, kind: 'worker', status: 'published', definition: { name: 'r' } },
      ],
    }),
    list_principals: () => ({ items: [{ id: 'p-me', displayName: 'alice', kind: 'human', role }] }),
    resolve_refs: () => ({ items: [] }),
  };
}

function renderDetail(http: CapabilityCaller) {
  render(
    <PermissionsProvider>
      <EvaluationPage http={http} suiteId="s-1" onSelectSuite={vi.fn()} />
    </PermissionsProvider>,
  );
}

const select = (element: HTMLElement, value: string) =>
  fireEvent.change(element, { target: { value } });
const type = (element: HTMLElement, value: string) =>
  fireEvent.change(element, { target: { value } });

describe('SuiteCases (S10 E3-1b)', () => {
  it('lists the cases with their partition and split, flags a rule a sync left behind, and opens one whole', async () => {
    const broken = wholeCase({
      id: 'c-2',
      title: 'list before restart',
      split: 'holdout',
      partition: 'mechanism',
      mechanism: 'skips the inventory',
      fixtureProblems: [{ index: 0, problem: 'operation_not_on_gate' }],
    });
    const cases = [wholeCase(), broken];
    const http = scriptedHttp(
      handlers(
        'builder',
        () => suite(cases),
        () => cases,
      ),
    );
    renderDetail(http);
    const section = await screen.findByTestId('eval-suite-cases');
    expect(within(section).getByTestId('eval-suite-cases-count').textContent).toBe(
      '2 条（dev 1，holdout 1）',
    );
    expect(within(section).getByTestId('eval-suite-cases-attention').textContent).toMatch(
      /1 条用例的夹具规则/,
    );
    const rows = within(section).getAllByTestId('eval-case');
    expect(rows[0]?.textContent).toContain('回归');
    expect(rows[1]?.textContent).toMatch(/机制：skips the inventory/);
    expect(within(rows[1] as HTMLElement).getByTestId('eval-case-attention').textContent).toBe(
      '1 条夹具规则需要处理',
    );

    fireEvent.click(within(rows[1] as HTMLElement).getByTestId('eval-case-open'));
    const view = await screen.findByTestId('eval-case-view');
    expect(http.calls.find((c) => c.name === 'get_eval_case')?.params).toEqual({
      suiteId: 's-1',
      caseId: 'c-2',
    });
    expect(within(view).getByTestId('eval-case-view-input').textContent).toBe('restart web');
    const rule = within(view).getByTestId('eval-case-view-rule');
    expect(rule.textContent).toContain('inventory · hosts.get');
    expect(rule.textContent).toContain('参数满足：host 等于 "web" → 返回数据');
    expect(within(rule).getByTestId('eval-case-view-rule-problem').textContent).toMatch(
      /已没有这个操作/,
    );
    const assertions = within(view).getAllByTestId('eval-case-view-assertion');
    expect(assertions).toHaveLength(2);
    expect(assertions[0]?.textContent).toBe('结果摘要包含 "api"');
    expect(assertions[1]?.textContent).toMatch(/^没有调用 inventory · hosts\.restart$/);
  });

  it('adds a case from picks: partition and split, a rule on a frozen Operation, a template assertion', async () => {
    let current = suite([]);
    const http = scriptedHttp({
      ...handlers(
        'builder',
        () => current,
        () => [],
      ),
      add_eval_case: () => {
        current = suite([wholeCase({ id: 'c-9', title: 'new one' })], { version: 4 });
        return current;
      },
    });
    renderDetail(http);
    await screen.findByTestId('eval-suite-cases-empty');
    fireEvent.click(screen.getByTestId('eval-case-add-trigger'));
    const sheet = await screen.findByTestId('eval-case-sheet');
    const save = within(sheet).getByTestId('eval-case-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(within(sheet).getByTestId('eval-case-missing').textContent).toBe(
      '还差：填写标题、选择分区、选择 dev 或 holdout、填写输入、补全断言',
    );

    type(within(sheet).getByTestId('eval-case-title'), ' new one ');
    select(within(sheet).getByTestId('eval-case-partition'), 'regression');
    expect(within(sheet).queryByTestId('eval-case-holdout-notice')).toBeNull();
    select(within(sheet).getByTestId('eval-case-split'), 'dev');
    expect(within(sheet).queryByTestId('eval-case-holdout-notice')).toBeNull();
    select(within(sheet).getByTestId('eval-case-split'), 'holdout');
    expect(sheet.textContent).toContain('holdout：只用于最终确认');
    // Legacy 516: holdout text is withheld from agents wherever it turns up — say so while it is
    // written, so a stock phrase or a copied log line does not also stop real work.
    const notice = within(sheet).getByTestId('eval-case-holdout-notice').textContent ?? '';
    expect(notice).toContain('连续 40 个字符');
    expect(notice).toContain('不要用常见套话');
    expect(notice).toContain('夹具应答的数据不算在内');
    type(within(sheet).getByTestId('eval-case-input'), 'restart web');

    fireEvent.click(within(sheet).getByTestId('eval-case-rule-add'));
    const rule = within(sheet).getByTestId('eval-case-rule');
    select(within(rule).getByTestId('eval-case-rule-gate'), GATE);
    select(within(rule).getByTestId('eval-case-rule-op'), 'hosts.list');
    const answer = within(rule).getByTestId('eval-case-rule-answer') as HTMLSelectElement;
    // hosts.list declares no "not there" answer, so none is offered.
    expect([...answer.options].map((option) => option.value)).toEqual(['data', 'error']);
    select(within(rule).getByTestId('eval-case-rule-op'), 'hosts.get');
    expect([...answer.options].map((option) => option.value)).toEqual(['data', 'absent', 'error']);
    select(within(rule).getByTestId('eval-case-rule-when'), 'param');
    select(within(rule).getByTestId('eval-case-rule-param'), 'host');
    type(within(rule).getByTestId('eval-case-rule-value'), 'web');
    select(answer, 'absent');

    const assertion = within(sheet).getByTestId('eval-case-assertion');
    select(within(assertion).getByTestId('eval-case-assertion-template'), 'not_called');
    select(within(assertion).getByTestId('eval-case-assertion-gate'), GATE);
    select(within(assertion).getByTestId('eval-case-assertion-op'), 'hosts.restart');
    type(within(assertion).getByTestId('eval-case-assertion-note'), 'never restarts');

    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByTestId('eval-case-sheet')).toBeNull());
    expect(http.calls.find((c) => c.name === 'add_eval_case')?.params).toEqual({
      suiteId: 's-1',
      suiteVersion: 3,
      partition: 'regression',
      split: 'holdout',
      title: 'new one',
      input: 'restart web',
      fixtures: [
        {
          gatekeeperId: GATE,
          operation: 'hosts.get',
          when: { path: 'host', op: 'eq', value: 'web' },
          answer: { kind: 'absent' },
        },
      ],
      assertions: [
        {
          expect: { path: evalCallCountPath(GATE, 'hosts.restart'), op: 'eq', value: 0 },
          note: 'never restarts',
        },
      ],
    });
    expect(await screen.findByTestId('eval-case')).toBeTruthy();
  });

  it('an edit keeps the kind, needs a change and a reason, and then shows the case that replaced it', async () => {
    let cases = [wholeCase()];
    let current = suite(cases);
    const http = scriptedHttp({
      ...handlers(
        'builder',
        () => current,
        () => cases,
      ),
      edit_eval_case: () => {
        const replacement = wholeCase({
          id: 'c-1b',
          title: 'check dependants before any restart',
          supersedes: 'c-1',
          addedInVersion: 4,
        });
        cases = [
          wholeCase({ retiredInVersion: 4, retireReason: 'clearer', supersededBy: 'c-1b' }),
          replacement,
        ];
        current = suite([replacement], { version: 4 });
        return current;
      },
    });
    renderDetail(http);
    fireEvent.click(await screen.findByTestId('eval-case-open'));
    await screen.findByTestId('eval-case-view');
    fireEvent.click(screen.getByTestId('eval-case-edit'));
    const sheet = screen.getByTestId('eval-case-sheet');
    expect(within(sheet).getByTestId('eval-case-kind-fixed').textContent).toContain('回归');
    // A dev case's text is not withheld from agents: no holdout notice.
    expect(within(sheet).queryByTestId('eval-case-holdout-notice')).toBeNull();
    expect(within(sheet).queryByTestId('eval-case-partition')).toBeNull();
    const save = within(sheet).getByTestId('eval-case-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(within(sheet).getByTestId('eval-case-missing').textContent).toBe(
      '还差：填写修改原因；内容和现在一样，没有可保存的改动',
    );
    type(within(sheet).getByTestId('eval-case-reason'), 'clearer');
    expect(save.disabled).toBe(true);
    type(within(sheet).getByTestId('eval-case-title'), 'check dependants before any restart');
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);

    const view = await screen.findByTestId('eval-case-view');
    await waitFor(() => expect(view.getAttribute('data-case-id')).toBe('c-1b'));
    // Closed, focus goes to the row of the case that replaced the one opened (#810 UX P3-3).
    fireEvent.click(screen.getByTestId('eval-case-close'));
    await waitFor(() => expect(screen.queryByTestId('eval-case-sheet')).toBeNull());
    await waitFor(() =>
      expect(
        document.activeElement?.closest('[data-testid="eval-case"]')?.getAttribute('data-case-id'),
      ).toBe('c-1b'),
    );
    const params = http.calls.find((c) => c.name === 'edit_eval_case')?.params as Record<
      string,
      unknown
    >;
    expect(params).toMatchObject({
      suiteId: 's-1',
      suiteVersion: 3,
      caseId: 'c-1',
      reason: 'clearer',
      title: 'check dependants before any restart',
      input: 'restart web',
    });
    expect(params).not.toHaveProperty('partition');
    expect(params.fixtures).toEqual(wholeCase().fixtures);
    expect(params.assertions).toEqual(wholeCase().assertions);
  });

  it('a version changed in between keeps the form and what was typed, and says so', async () => {
    const cases = [wholeCase()];
    let current = suite(cases);
    const http = scriptedHttp({
      ...handlers(
        'builder',
        () => current,
        () => cases,
      ),
      edit_eval_case: () => {
        current = suite(cases, { version: 5 });
        throw new HttpError('capability_error', 'suite moved on', 'version_changed');
      },
    });
    renderDetail(http);
    fireEvent.click(await screen.findByTestId('eval-case-open'));
    await screen.findByTestId('eval-case-view');
    fireEvent.click(screen.getByTestId('eval-case-edit'));
    const sheet = screen.getByTestId('eval-case-sheet');
    type(within(sheet).getByTestId('eval-case-title'), 'renamed');
    type(within(sheet).getByTestId('eval-case-reason'), 'why');
    fireEvent.click(within(sheet).getByTestId('eval-case-save'));
    const error = await within(sheet).findByTestId('eval-case-save-error');
    expect(error.textContent).toContain('用例集在你打开之后被改过');
    // The refusal has focus, not <body> (#810 UX P3-2).
    await waitFor(() =>
      expect(document.activeElement).toBe(within(sheet).getByTestId('eval-case-save-error-anchor')),
    );
    expect((within(sheet).getByTestId('eval-case-title') as HTMLInputElement).value).toBe(
      'renamed',
    );
    await waitFor(() =>
      expect(http.calls.filter((c) => c.name === 'get_eval_suite').length).toBeGreaterThan(1),
    );
  });

  it('retiring asks for a reason and closes the case', async () => {
    let current = suite([wholeCase()]);
    const http = scriptedHttp({
      ...handlers(
        'builder',
        () => current,
        () => [wholeCase()],
      ),
      retire_eval_case: () => {
        current = suite([], { version: 4 });
        return current;
      },
    });
    renderDetail(http);
    fireEvent.click(await screen.findByTestId('eval-case-open'));
    await screen.findByTestId('eval-case-view');
    fireEvent.click(screen.getByTestId('eval-case-retire-trigger'));
    const confirm = await screen.findByTestId('eval-case-retire');
    const button = within(confirm).getByRole('button', { name: '退役' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    type(within(confirm).getByTestId('eval-case-retire-reason'), ' duplicate of another ');
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByTestId('eval-case-sheet')).toBeNull());
    expect(http.calls.find((c) => c.name === 'retire_eval_case')?.params).toEqual({
      suiteId: 's-1',
      suiteVersion: 3,
      caseId: 'c-1',
      reason: 'duplicate of another',
    });
    expect(await screen.findByTestId('eval-suite-cases-empty')).toBeTruthy();
  });

  it('editing a holdout case says its text is withheld from agents (legacy 516)', async () => {
    const cases = [wholeCase({ split: 'holdout' })];
    const http = scriptedHttp(
      handlers(
        'builder',
        () => suite(cases),
        () => cases,
      ),
    );
    renderDetail(http);
    fireEvent.click(await screen.findByTestId('eval-case-open'));
    await screen.findByTestId('eval-case-view');
    fireEvent.click(screen.getByTestId('eval-case-edit'));
    const sheet = screen.getByTestId('eval-case-sheet');
    expect(within(sheet).getByTestId('eval-case-holdout-notice').textContent).toContain(
      '不要整段照抄真实数据或日志',
    );
  });

  it('a member reads cases whole and is offered no change', async () => {
    const cases = [wholeCase()];
    const http = scriptedHttp(
      handlers(
        'member',
        () => suite(cases),
        () => cases,
      ),
    );
    renderDetail(http);
    fireEvent.click(await screen.findByTestId('eval-case-open'));
    await screen.findByTestId('eval-case-view');
    await waitFor(() => expect(screen.queryByTestId('eval-case-add-trigger')).toBeNull());
    expect(screen.queryByTestId('eval-case-edit')).toBeNull();
    expect(screen.queryByTestId('eval-case-retire-trigger')).toBeNull();
    // A reader with nothing to change still has a way out (#810 UX P2-2).
    fireEvent.click(screen.getByTestId('eval-case-close'));
    await waitFor(() => expect(screen.queryByTestId('eval-case-sheet')).toBeNull());
  });

  it('a reader who may not edit is asked to open flagged cases to see them, not to edit them', async () => {
    const cases = [
      wholeCase({ fixtureProblems: [{ index: 0, problem: 'operation_not_on_gate' }] }),
    ];
    const http = scriptedHttp(
      handlers(
        'member',
        () => suite(cases),
        () => cases,
      ),
    );
    renderDetail(http);
    const notice = await screen.findByTestId('eval-suite-cases-attention');
    await waitFor(() => expect(notice.textContent).toContain('打开它们查看'));
    expect(notice.textContent).toContain('在夹具门同步后对不上了');
    expect(notice.textContent).not.toContain('编辑');
  });

  it('a fixture gate a case uses names the case, opens it, and says what removing it waits for', async () => {
    const cases = [wholeCase()];
    const http = scriptedHttp(
      handlers(
        'builder',
        () => suite(cases),
        () => cases,
      ),
    );
    renderDetail(http);
    const card = await screen.findByTestId('eval-fixture-gate');
    const remove = (await within(card).findByTestId(
      'eval-fixture-gate-remove-trigger',
    )) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(within(card).getByTestId('eval-fixture-gate-remove-in-use').textContent).toBe(
      '还差：先编辑或退役用到它的 1 条用例',
    );
    const usedBy = within(card).getByTestId('eval-fixture-gate-used-by');
    expect(usedBy.textContent).toContain('1 条用例用到它');
    fireEvent.click(within(usedBy).getByTestId('eval-fixture-gate-used-by-case'));
    const view = await screen.findByTestId('eval-case-view');
    expect(view.getAttribute('data-case-id')).toBe('c-1');
  });

  it('a gate no case uses can be removed', async () => {
    const http = scriptedHttp(
      handlers(
        'builder',
        () => suite([]),
        () => [],
      ),
    );
    renderDetail(http);
    const card = await screen.findByTestId('eval-fixture-gate');
    const remove = (await within(card).findByTestId(
      'eval-fixture-gate-remove-trigger',
    )) as HTMLButtonElement;
    expect(remove.disabled).toBe(false);
    expect(within(card).queryByTestId('eval-fixture-gate-remove-in-use')).toBeNull();
    expect(within(card).queryByTestId('eval-fixture-gate-used-by')).toBeNull();
  });

  it('a sync that drops an operation a case answers says how many cases stop matching', async () => {
    const cases = [wholeCase()];
    const changed = suite(cases, {
      fixtureGates: GATES.map((gate) => ({ ...gate, liveState: 'changed' as const })),
    });
    const http = scriptedHttp({
      ...handlers(
        'builder',
        () => changed,
        () => cases,
      ),
      // hosts.get is gone from the gate now; hosts.list and hosts.restart stay.
      list_operations: () => ({
        items: [
          { name: 'hosts.list', version: 1, status: 'published' },
          { name: 'hosts.restart', version: 1, status: 'published' },
        ],
      }),
    });
    renderDetail(http);
    fireEvent.click(await screen.findByTestId('eval-fixture-gate-sync-trigger'));
    const confirm = await screen.findByTestId('eval-fixture-gate-sync');
    await waitFor(() =>
      expect(within(confirm).getByTestId('confirm-impact').textContent).toContain(
        '1 条用例的规则用到要移除的操作，同步后会对不上',
      ),
    );
  });

  it('an operation whose name hides characters is listed but cannot be picked', async () => {
    const hidden = 'restart\u{202E}gnp.exe\u{200B}';
    const gates = GATES.map((gate) => ({
      ...gate,
      operations: [
        ...gate.operations,
        {
          name: hidden,
          version: 1,
          mode: 'execute' as const,
          description: null,
          paramsSchema: {},
          answersAbsent: false,
        },
      ],
    }));
    const http = scriptedHttp(
      handlers(
        'builder',
        () => suite([], { fixtureGates: gates }),
        () => [],
      ),
    );
    renderDetail(http);
    fireEvent.click(await screen.findByTestId('eval-case-add-trigger'));
    const sheet = await screen.findByTestId('eval-case-sheet');
    fireEvent.click(within(sheet).getByTestId('eval-case-rule-add'));
    const rule = within(sheet).getByTestId('eval-case-rule');
    select(within(rule).getByTestId('eval-case-rule-gate'), GATE);
    const op = within(rule).getByTestId('eval-case-rule-op') as HTMLSelectElement;
    const option = [...op.options].find((candidate) => candidate.value === hidden);
    expect(option?.disabled).toBe(true);
    expect(option?.textContent).toContain('名字里有看不见的字符');
    expect([...op.options].find((candidate) => candidate.value === 'hosts.get')?.disabled).toBe(
      false,
    );
  });

  it('a custom condition says what its paths read: the call’s params in a rule, the run in an assertion', async () => {
    const http = scriptedHttp(
      handlers(
        'builder',
        () => suite([]),
        () => [],
      ),
    );
    renderDetail(http);
    fireEvent.click(await screen.findByTestId('eval-case-add-trigger'));
    const sheet = await screen.findByTestId('eval-case-sheet');
    fireEvent.click(within(sheet).getByTestId('eval-case-rule-add'));
    const rule = within(sheet).getByTestId('eval-case-rule');
    select(within(rule).getByTestId('eval-case-rule-gate'), GATE);
    select(within(rule).getByTestId('eval-case-rule-op'), 'hosts.get');
    select(within(rule).getByTestId('eval-case-rule-when'), 'predicate');
    const rulePath = within(rule).getByTestId('eval-case-rule-predicate-path') as HTMLInputElement;
    // 「参数，如 host」: the gate's own first param as the example.
    expect(rulePath.placeholder.startsWith('参数')).toBe(true);
    expect(rulePath.placeholder.endsWith('host')).toBe(true);
    expect(rulePath.getAttribute('aria-label')).toBe('第 1 个条件：调用参数里的哪个值');
    expect(rule.textContent).toContain('调用参数里的');
    expect(rule.textContent).not.toContain('结果里的');

    const assertion = within(sheet).getByTestId('eval-case-assertion');
    select(within(assertion).getByTestId('eval-case-assertion-template'), 'predicate');
    const runPath = within(assertion).getByTestId(
      'eval-case-assertion-predicate-path',
    ) as HTMLInputElement;
    expect(runPath.placeholder.startsWith('路径')).toBe(true);
    expect(runPath.placeholder.endsWith('result.summary')).toBe(true);
    expect(assertion.textContent).toContain('运行里的');
    expect(assertion.textContent).not.toContain('结果里的');
  });
});

function trialOf(extra: Partial<EvalTrialWire> = {}): EvalTrialWire {
  return {
    id: 't-1',
    arm: 'baseline',
    caseId: 'c-1',
    caseTitle: 'check dependants first',
    rep: 1,
    status: 'scored',
    verdict: 'failed',
    error: null,
    taskId: 'task-1',
    assertions: [
      { index: 0, outcome: 'satisfied', note: null },
      { index: 1, outcome: 'unsatisfied', note: null },
    ],
    result: { summary: 'Checked api, then restarted web.' },
    calls: [
      {
        seq: 1,
        gatekeeperId: GATE,
        gate: 'inventory',
        operation: 'hosts.get',
        mode: 'observe',
        params: { host: 'web' },
        ruleIndex: 0,
        answer: 'data',
        at: AT,
      },
      {
        seq: 2,
        gatekeeperId: GATE,
        gate: 'inventory',
        operation: 'hosts.restart',
        mode: 'execute',
        params: { host: 'web' },
        ruleIndex: null,
        answer: 'unanswered',
        at: AT,
      },
    ],
    costUsd: 0.37,
    tokens: 12345,
    startedAt: AT,
    finishedAt: '2026-10-30T00:01:30.000Z',
    ...extra,
  };
}

function runOf(trial: Partial<EvalTrialWire> = {}, extra: Partial<EvalRunWire> = {}): EvalRunWire {
  const whole = trialOf(trial);
  return {
    id: 'r-1',
    suiteId: 's-1',
    suiteVersion: 3,
    kind: 'case_trial',
    workerDefinition: { id: WD, version: 1 },
    k: 1,
    status: whole.status === 'running' ? 'running' : 'finished',
    createdBy: 'p-me',
    createdAt: AT,
    finishedAt: whole.finishedAt,
    trials: [whole],
    ...extra,
  };
}

function summaryOfRun(run: EvalRunWire): EvalRunSummaryWire {
  const { trials, ...rest } = run;
  const count = (status: string) =>
    trials.filter((trial) =>
      status === 'passed' || status === 'failed'
        ? trial.status === 'scored' && trial.verdict === status
        : trial.status === status,
    ).length;
  return {
    ...rest,
    caseIds: [...new Set(trials.map((trial) => trial.caseId))],
    passed: count('passed'),
    failed: count('failed'),
    errored: count('errored'),
    running: count('running'),
    costUsd: trials[0]?.costUsd ?? null,
  };
}

async function openCaseTrials(http: CapabilityCaller): Promise<HTMLElement> {
  renderDetail(http);
  const section = await screen.findByTestId('eval-suite-cases');
  fireEvent.click(within(section).getAllByTestId('eval-case-open')[0] as HTMLElement);
  await screen.findByTestId('eval-case-view');
  return screen.findByTestId('eval-case-trials');
}

describe('CaseTrials (S10 E3-2a 试跑)', () => {
  it('a builder tries a case: the confirm says what runs and what it costs, then the trial shows whole', async () => {
    const cases = [wholeCase()];
    let runs: EvalRunWire[] = [];
    const http = scriptedHttp({
      ...handlers(
        'builder',
        () => suite(cases),
        () => cases,
      ),
      list_eval_runs: () => ({ items: runs.map(summaryOfRun) }),
      start_eval_case_trial: () => {
        runs = [runOf()];
        return runs[0];
      },
      get_eval_run: () => runs[0],
    });
    const trials = await openCaseTrials(http);
    await within(trials).findByTestId('eval-case-trials-empty');
    await waitFor(() =>
      expect(within(trials).getByTestId('eval-case-trial-budget').textContent).toMatch(
        /本月已用 \$2\.50 \/ \$10\.00，剩余 \$7\.50。按最近试跑的平均，一次试跑约 \$0\.40/,
      ),
    );
    const start = within(trials).getByTestId('eval-case-trial-start') as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);

    const confirm = await screen.findByTestId('eval-case-trial-confirm');
    const impact = within(confirm).getByTestId('confirm-impact').textContent ?? '';
    expect(impact).toContain('按 Worker v1、用例集 v3 运行');
    expect(impact).toContain('费用约 $0.40，计入本月评测预算');
    expect(impact).toContain('剩余 $7.50');
    expect(within(confirm).queryByTestId('eval-case-trial-short')).toBeNull();
    fireEvent.click(within(confirm).getByTestId('confirm-button'));

    const shown = await within(trials).findByTestId('eval-case-trial');
    expect(http.calls.find((c) => c.name === 'start_eval_case_trial')?.params).toEqual({
      suiteId: 's-1',
      suiteVersion: 3,
      caseId: 'c-1',
    });
    expect(shown.getAttribute('data-status')).toBe('failed');
    expect(within(shown).getByTestId('eval-case-trial-cost').textContent).toBe(
      '$0.37 · 12,345 token',
    );
    const assertions = within(shown).getAllByTestId('eval-case-trial-assertion');
    expect(assertions.map((item) => item.textContent)).toEqual([
      expect.stringContaining('结果摘要包含 "api"'),
      expect.stringMatching(/没有调用 inventory · hosts\.restart/),
    ]);
    const calls = within(shown).getAllByTestId('eval-case-trial-call');
    expect(calls.map((item) => item.getAttribute('data-answer'))).toEqual(['data', 'unanswered']);
    expect(calls[0]?.textContent).toContain('inventory · hosts.get');
    expect(calls[0]?.textContent).toContain('规则 1 作答：返回数据');
    expect(calls[1]?.textContent).toMatch(/没有规则匹配/);
    expect(within(shown).getByTestId('eval-case-trial-report').textContent).toContain(
      'Checked api, then restarted web.',
    );
    // The evaluation Task is the owner's to open, not a builder's.
    expect(within(shown).queryByTestId('eval-case-trial-task')).toBeNull();
  });

  it('a running trial is read again until it ends, and then the list and the budget move with it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const cases = [wholeCase()];
      const running = runOf({
        status: 'running',
        verdict: null,
        assertions: [],
        result: null,
        calls: [],
        costUsd: null,
        tokens: 0,
        finishedAt: null,
      });
      let reads = 0;
      const http = scriptedHttp({
        ...handlers(
          'owner',
          () => suite(cases),
          () => cases,
        ),
        list_eval_runs: () => ({ items: [summaryOfRun(running)] }),
        get_eval_run: () => {
          reads += 1;
          return reads === 1 ? running : runOf({ verdict: 'passed' });
        },
      });
      const trials = await openCaseTrials(http);
      const shown = await within(trials).findByTestId('eval-case-trial');
      expect(shown.getAttribute('data-status')).toBe('running');
      expect(shown.textContent).toMatch(/还没有调用夹具门/);
      const listed = http.calls.filter((c) => c.name === 'list_eval_runs').length;
      const budgets = http.calls.filter((c) => c.name === 'get_eval_budget').length;

      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      await waitFor(() =>
        expect(within(trials).getByTestId('eval-case-trial').getAttribute('data-status')).toBe(
          'passed',
        ),
      );
      await waitFor(() =>
        expect(http.calls.filter((c) => c.name === 'list_eval_runs').length).toBeGreaterThan(
          listed,
        ),
      );
      expect(http.calls.filter((c) => c.name === 'get_eval_budget').length).toBeGreaterThan(
        budgets,
      );
      // The owner opens the evaluation Task.
      expect(within(trials).getByTestId('eval-case-trial-task').getAttribute('href')).toBe(
        '#/work/tasks/task-1',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('a trial that ended without a verdict says why', async () => {
    const cases = [wholeCase()];
    const withheld = runOf({
      status: 'errored',
      verdict: null,
      error: 'withheld',
      assertions: [],
      result: null,
      calls: [],
      costUsd: 0,
      tokens: 0,
    });
    const http = scriptedHttp({
      ...handlers(
        'member',
        () => suite(cases),
        () => cases,
      ),
      list_eval_runs: () => ({ items: [summaryOfRun(withheld)] }),
      get_eval_run: () => withheld,
    });
    const trials = await openCaseTrials(http);
    const notice = await within(trials).findByTestId('eval-case-trial-errored');
    expect(notice.textContent).toMatch(/holdout 原文或用例集的 canary/);
    expect(within(trials).queryByTestId('eval-case-trial-assertions')).toBeNull();
    expect(within(trials).getByTestId('eval-case-trial-calls').textContent).toMatch(
      /没有调用夹具门/,
    );
    // A member reads trials and starts none.
    expect(within(trials).queryByTestId('eval-case-trial-start')).toBeNull();
  });

  it('a spent budget turns 试跑 off before anything starts, and says where it is raised', async () => {
    const cases = [wholeCase()];
    const http = scriptedHttp({
      ...handlers(
        'builder',
        () => suite(cases),
        () => cases,
      ),
      get_eval_budget: () => ({ ...BUDGET, spentUsd: 10 }),
    });
    const trials = await openCaseTrials(http);
    const exhausted = await within(trials).findByTestId('eval-case-trial-exhausted');
    expect(exhausted.textContent).toMatch(/请工作区所有者在「模型与配额」调高「评测月度预算」/);
    expect(
      (within(trials).getByTestId('eval-case-trial-start') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('too little left for the estimate is said in the confirm, not refused', async () => {
    const cases = [wholeCase()];
    const http = scriptedHttp({
      ...handlers(
        'builder',
        () => suite(cases),
        () => cases,
      ),
      get_eval_budget: () => ({ ...BUDGET, spentUsd: 9.8 }),
    });
    const trials = await openCaseTrials(http);
    const start = within(trials).getByTestId('eval-case-trial-start') as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    const confirm = await screen.findByTestId('eval-case-trial-confirm');
    expect(within(confirm).getByTestId('eval-case-trial-short').textContent).toMatch(
      /可能不够这次试跑/,
    );
  });

  it('a suite changed since it was opened refuses the start and says nothing ran', async () => {
    const cases = [wholeCase()];
    const http = scriptedHttp({
      ...handlers(
        'builder',
        () => suite(cases),
        () => cases,
      ),
      start_eval_case_trial: () => {
        throw new HttpError('capability_error', 'suite changed', 'version_changed');
      },
    });
    const trials = await openCaseTrials(http);
    const start = within(trials).getByTestId('eval-case-trial-start') as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    const confirm = await screen.findByTestId('eval-case-trial-confirm');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    const error = await within(confirm).findByTestId('confirm-error');
    expect(error.textContent).toMatch(/什么也没有启动/);
  });

  it('a retired case keeps its earlier trials and offers no new one', async () => {
    const retired = wholeCase({ retiredInVersion: 4, retireReason: 'covered elsewhere' });
    const done = runOf({ verdict: 'passed' });
    const http = scriptedHttp({
      ...handlers(
        'builder',
        () => suite([retired]),
        () => [retired],
      ),
      list_eval_runs: () => ({ items: [summaryOfRun(done), summaryOfRun({ ...done, id: 'r-0' })] }),
      get_eval_run: () => done,
    });
    // Opened as an earlier row is (the history's link to a retired or replaced case).
    const view = await openCaseTrials(http);
    expect(view.textContent).toMatch(/不能再试跑/);
    expect(within(view).queryByTestId('eval-case-trial-start')).toBeNull();
    await within(view).findByTestId('eval-case-trial');
    expect(within(view).getAllByTestId('eval-case-trial-row')).toHaveLength(2);
  });
});
