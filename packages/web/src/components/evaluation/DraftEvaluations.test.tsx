// @vitest-environment jsdom
import type {
  DraftEvaluationArmTallyWire,
  DraftEvaluationStageWire,
  DraftEvaluationWire,
  EvalBudgetWire,
  EvalCaseWire,
  EvalRunWire,
  EvalSuiteWire,
  EvalTrialWire,
  RunEnvironmentWire,
} from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import type { EvaluationTab } from '../../lib/router.js';
import { draftEvaluationSummaryOf } from './DraftEvaluations.js';
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
const SKILL = '44444444-4444-4444-8444-444444444444';
const AT = '2026-10-30T00:00:00.000Z';

const BUDGET: EvalBudgetWire = {
  monthlyBudgetUsd: 10,
  spentUsd: 2.5,
  periodStart: '2026-10-01T00:00:00.000Z',
  periodEnd: '2026-11-01T00:00:00.000Z',
  trialCostUsd: 0.01,
  unpricedTrials: 0,
  committedUsd: 0,
};

const tally = (passed: number, trials: number, extra: Partial<DraftEvaluationArmTallyWire> = {}) =>
  ({
    trials,
    passed,
    failed: trials - passed,
    errored: 0,
    voided: 0,
    open: 0,
    costUsd: trials * 0.01,
    tokens: trials * 100,
    ...extra,
  }) satisfies DraftEvaluationArmTallyWire;

function environment(imageId = 'sha256:aaa'): RunEnvironmentWire {
  return {
    definition: { id: WD, version: 1 },
    model: 'fake-model',
    image: null,
    systemPromptDigest: 'sha256:prompt',
    kernelVersion: '0.50.0',
    runtime: {
      imageRef: 'worker:latest',
      imageId,
      piVersion: null,
      platformExtensionVersion: null,
      builtFrom: null,
      modelsConfigDigest: 'sha256:models',
    },
    environmentDigest: `v1:${imageId}`,
  };
}

function stage(
  name: DraftEvaluationStageWire['stage'],
  extra: Partial<DraftEvaluationStageWire> = {},
): DraftEvaluationStageWire {
  return {
    stage: name,
    status: 'ended',
    skipReason: null,
    runId: `run-${name}`,
    caseCount: 1,
    k: 2,
    estimateUsd: 0.04,
    baseline: tally(1, 2),
    candidate: tally(2, 2),
    cases: [
      {
        caseId: 'c-1',
        title: 'check dependants first',
        split: 'dev',
        baseline: tally(1, 2),
        candidate: tally(2, 2),
      },
    ],
    measure: null,
    ...extra,
  };
}

function evaluation(extra: Partial<DraftEvaluationWire> = {}): DraftEvaluationWire {
  return {
    id: 'e-1',
    status: 'finished',
    stage: null,
    verdict: 'better',
    reason: 'above_baseline',
    decidedBy: 'confirm',
    costUsd: 0.36,
    createdBy: 'p-me',
    createdAt: AT,
    finishedAt: AT,
    cancelledBy: null,
    suite: { id: 's-1', name: 'restart drills', version: 3 },
    workerDefinition: { id: WD, version: 1 },
    candidate: { skillId: SKILL, version: 2, name: 'restart-helper', draftDigest: 'sha256:d' },
    baseline: { skillId: SKILL, version: 1, name: 'restart-helper' },
    mechanism: 'asks before restart',
    otherSkills: [{ skillId: 'sk-notes', version: 1, name: 'notes' }],
    candidateContent: {
      name: 'restart-helper',
      description: 'Restarts a host after asking.',
      markdown: '# Restart\n\nAsk first.',
    },
    baselineContent: {
      name: 'restart-helper',
      description: 'Restarts a host.',
      markdown: '# Restart',
    },
    stages: [
      stage('regression', {
        measure: { stage: 'regression', lostCaseIds: [], unsettledCaseIds: [] },
      }),
      stage('mechanism', {
        k: 10,
        baseline: tally(4, 10),
        candidate: tally(10, 10),
        cases: [],
        measure: {
          stage: 'mechanism',
          candidatePassed: 10,
          candidateTrials: 10,
          candidateNoOutcome: 0,
          baselinePassed: 4,
          baselineTrials: 10,
          baselineNoOutcome: 0,
          baselineMaxPassed: 4,
        },
      }),
      stage('confirm', {
        k: 3,
        cases: [],
        measure: {
          stage: 'confirm',
          delta: 0.1,
          confidence: 0.95,
          dev: {
            candidatePassed: 28,
            candidateTrials: 30,
            candidateNoOutcome: 0,
            baselinePassed: 10,
            baselineTrials: 30,
            baselineNoOutcome: 0,
            difference: 0.6,
            lowerBound: 0.4,
          },
          holdout: null,
        },
      }),
    ],
    environments: [{ environment: environment(), baselineTrials: 18, candidateTrials: 18 }],
    ...extra,
  };
}

function trial(extra: Partial<EvalTrialWire> = {}): EvalTrialWire {
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
    assertions: [{ index: 0, outcome: 'unsatisfied', note: null }],
    result: { summary: 'Restarted web without checking.' },
    calls: [],
    costUsd: 0.01,
    tokens: 100,
    environmentDigest: 'v1:sha256:aaa',
    startedAt: AT,
    finishedAt: AT,
    ...extra,
  };
}

const RUN: EvalRunWire = {
  id: 'run-regression',
  suiteId: 's-1',
  suiteVersion: 3,
  kind: 'draft',
  workerDefinition: { id: WD, version: 1 },
  k: 2,
  status: 'finished',
  draftEvaluationId: 'e-1',
  stage: 'regression',
  createdBy: 'p-me',
  createdAt: AT,
  finishedAt: AT,
  trials: [
    trial(),
    trial({ id: 't-2', rep: 2, verdict: 'passed' }),
    trial({ id: 't-3', arm: 'candidate', verdict: 'passed' }),
    trial({ id: 't-4', arm: 'candidate', rep: 2, verdict: 'passed' }),
    trial({ id: 't-5', caseId: 'c-other', caseTitle: 'another case' }),
  ],
};

const CASE: EvalCaseWire = {
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
  fixtureRuleCount: 0,
  assertionCount: 1,
  fixtureProblems: [],
  fixtureOperations: [],
  input: 'restart web',
  fixtures: [],
  assertions: [{ expect: { path: 'result.summary', op: 'contains', value: 'api' } }],
  contentDigest: `sha256:${'1'.repeat(64)}`,
  retiredInVersion: null,
  retireReason: null,
  supersededBy: null,
};

const SUITE = {
  id: 's-1',
  name: 'restart drills',
  description: '',
  workerDefinition: { id: WD, version: 1, status: 'published' },
  version: 3,
  fixtureGateCount: 0,
  fixtureGatesNeedingAttention: 0,
  caseCount: 1,
  casesNeedingAttention: 0,
  createdBy: 'p-me',
  createdAt: AT,
  updatedAt: AT,
  canary: `NTEVAL-${'ab'.repeat(16)}`,
  fixtureGates: [],
  cases: [],
  history: [],
} satisfies EvalSuiteWire;

function handlers(role: string, current: () => DraftEvaluationWire) {
  return {
    get_workspace: () => ({
      id: 'ws-1',
      name: 'Acme',
      caller: { id: 'p-me', role, displayName: 'Me', kind: 'human' },
    }),
    list_eval_suites: () => ({ items: [] }),
    get_eval_budget: () => BUDGET,
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
    list_principals: () => ({
      items: [{ id: 'p-me', displayName: 'alice', kind: 'human', role }],
    }),
    resolve_refs: () => ({ items: [] }),
    list_draft_evaluations: () => ({ items: [draftEvaluationSummaryOf(current())] }),
    get_draft_evaluation: () => current(),
    get_eval_run: () => RUN,
    get_eval_case: () => CASE,
    get_eval_suite: () => SUITE,
  };
}

function renderPage(
  http: CapabilityCaller,
  itemId?: string,
  onNavigate = vi.fn<(tab: EvaluationTab, id: string | null) => void>(),
) {
  render(
    <PermissionsProvider>
      <EvaluationPage http={http} tab="drafts" itemId={itemId} onNavigate={onNavigate} />
    </PermissionsProvider>,
  );
  return onNavigate;
}

describe('草稿评测 (S10 E3-2b)', () => {
  it('lists the evaluations with what each compares, its verdict and suite; picking one opens it', async () => {
    const http = scriptedHttp(handlers('member', () => evaluation()));
    const onNavigate = renderPage(http);
    const row = await screen.findByTestId('draft-eval-row');
    expect(row.textContent).toMatch(/restart-helper v2 对比 v1/);
    expect(row.textContent).toContain('restart drills v3');
    expect(row.textContent).toContain('由确认对比给出');
    expect(within(row).getByTestId('draft-eval-row-outcome').textContent).toContain('优于基线');
    fireEvent.click(row);
    expect(onNavigate).toHaveBeenCalledWith('drafts', 'e-1');
    // The tab switch goes back to the suites without an item.
    fireEvent.click(screen.getByTestId('eval-tab-suites'));
    expect(onNavigate).toHaveBeenCalledWith('suites', null);
  });

  it('says where an evaluation starts when there is none — and who starts one, to a member', async () => {
    const builder = scriptedHttp({
      ...handlers('builder', () => evaluation()),
      list_draft_evaluations: () => ({ items: [] }),
    });
    renderPage(builder);
    const empty = await screen.findByTestId('draft-evals-empty');
    await waitFor(() => expect(empty.textContent).toContain('在能力目录打开一个 Skill 草稿'));
    expect(within(empty).getByRole('link').getAttribute('href')).toBe('#/govern/catalog/skills');
    cleanup();

    // A member cannot start one: not sent to the catalog to do it (#833 UX P3-3).
    const member = scriptedHttp({
      ...handlers('member', () => evaluation()),
      list_draft_evaluations: () => ({ items: [] }),
    });
    renderPage(member);
    const told = await screen.findByTestId('draft-evals-empty');
    await waitFor(() =>
      expect(told.textContent).toContain(
        '评测由构建者或工作区所有者从 Skill 草稿发起；你能看到的草稿的评测会列在这里。',
      ),
    );
    expect(within(told).queryByRole('link')).toBeNull();
  });

  it('shows a finished evaluation whole: the verdict and why, each stage, the matrix and a trial', async () => {
    const http = scriptedHttp(handlers('member', () => evaluation()));
    renderPage(http, 'e-1');
    const detail = await screen.findByTestId('draft-eval-detail');
    expect(within(detail).getByTestId('draft-eval-outcome').textContent).toContain('优于基线');
    expect(within(detail).getByTestId('draft-eval-reason').textContent).toContain(
      '（由确认对比给出）',
    );
    expect(detail.textContent).toContain('notes v1');
    expect(detail.textContent).toContain('asks before restart');
    expect(detail.textContent).toContain('restarter v1');

    const stages = within(detail).getAllByTestId('draft-eval-stage');
    expect(stages.map((node) => node.getAttribute('data-stage'))).toEqual([
      'regression',
      'mechanism',
      'confirm',
    ]);
    expect(within(stages[0] as HTMLElement).getByTestId('draft-eval-stage-passed')).toBeTruthy();
    expect(within(stages[2] as HTMLElement).getByTestId('draft-eval-stage-decided')).toBeTruthy();
    expect(within(stages[0] as HTMLElement).getByTestId('draft-eval-stage-plan').textContent).toBe(
      '1 条用例 × 每组 2 次 × 两组 = 4 次试跑，预估 $0.04',
    );
    expect(
      within(stages[1] as HTMLElement).getByTestId('draft-eval-measure').textContent,
    ).toContain('基线组 4/10 (40%)（最多 4 次）');
    const confirm = within(stages[2] as HTMLElement).getByTestId('draft-eval-measure');
    expect(confirm.textContent).toContain('差 +60.0 个百分点，下界 +40.0');
    expect(confirm.textContent).toContain('用例集没有 holdout 用例');

    // A case's trials, both arms, read from the stage's run; one opens whole.
    const matrix = within(stages[0] as HTMLElement).getByTestId('draft-eval-matrix');
    expect(within(matrix).getByTestId('draft-eval-matrix-row').textContent).toContain('1/2');
    fireEvent.click(within(matrix).getByTestId('draft-eval-matrix-open'));
    const trials = await within(matrix).findAllByTestId('draft-eval-trial');
    expect(trials.map((node) => node.getAttribute('data-arm'))).toEqual([
      'baseline',
      'baseline',
      'candidate',
      'candidate',
    ]);
    expect(http.calls.find((c) => c.name === 'get_eval_run')?.params).toEqual({
      runId: 'run-regression',
    });
    fireEvent.click(within(trials[0] as HTMLElement).getByTestId('draft-eval-trial-open'));
    const opened = await within(matrix).findByTestId('eval-case-trial');
    expect(opened.textContent).toContain('Restarted web without checking.');
    // It opens under its own row, not after the whole list (#833 UX P2-3).
    expect((trials[0] as HTMLElement).contains(opened)).toBe(true);
    expect(http.calls.find((c) => c.name === 'get_eval_case')?.params).toEqual({
      suiteId: 's-1',
      caseId: 'c-1',
    });
    // A member does not open the evaluation Task, and cannot cancel.
    expect(within(opened).queryByTestId('eval-case-trial-task')).toBeNull();
    expect(screen.queryByTestId('draft-eval-cancel')).toBeNull();

    // One environment.
    expect(screen.queryByTestId('draft-eval-environments-differ')).toBeNull();
    expect(screen.getAllByTestId('draft-eval-environment')).toHaveLength(1);
  });

  it('trials without an outcome: the case they leave open is named, and rates count them apart (#833 review)', async () => {
    const http = scriptedHttp(
      handlers('member', () =>
        evaluation({
          verdict: 'inconclusive',
          reason: 'errored_trials',
          decidedBy: 'regression',
          stages: [
            stage('regression', {
              baseline: tally(2, 2),
              candidate: tally(1, 2, { errored: 1, failed: 0 }),
              cases: [
                {
                  caseId: 'c-1',
                  title: 'check dependants first',
                  split: 'dev',
                  baseline: tally(2, 2),
                  candidate: tally(1, 2, { errored: 1, failed: 0 }),
                },
              ],
              measure: { stage: 'regression', lostCaseIds: [], unsettledCaseIds: ['c-1'] },
            }),
            stage('mechanism', {
              k: 10,
              baseline: tally(3, 10),
              candidate: tally(9, 10),
              cases: [],
              measure: {
                stage: 'mechanism',
                candidatePassed: 9,
                candidateTrials: 9,
                candidateNoOutcome: 1,
                baselinePassed: 3,
                baselineTrials: 10,
                baselineNoOutcome: 0,
                baselineMaxPassed: 4,
              },
            }),
          ],
        }),
      ),
    );
    renderPage(http, 'e-1');
    const detail = await screen.findByTestId('draft-eval-detail');
    expect(within(detail).getByTestId('draft-eval-reason').textContent).toContain('没有结果');
    const stages = within(detail).getAllByTestId('draft-eval-stage');
    const regression = stages[0] as HTMLElement;
    expect(within(regression).getByTestId('draft-eval-measure-unsettled').textContent).toMatch(
      /^定不下来的回归用例（没有结果的试跑能让它倒向任何一边）：check dependants first$/,
    );
    const row = within(regression).getByTestId('draft-eval-matrix-row');
    expect(row.getAttribute('data-unsettled')).toBe('true');
    expect(row.getAttribute('data-lost')).toBeNull();
    expect(row.textContent).toContain('定不下来');
    expect(
      within(stages[1] as HTMLElement).getByTestId('draft-eval-measure').textContent,
    ).toContain('草稿组 9/9 (100%)，另 1 次没有结果（要求全部通过）');
  });

  it('warns when the trials ran in more than one environment', async () => {
    const http = scriptedHttp(
      handlers('member', () =>
        evaluation({
          verdict: 'unmeasured',
          reason: 'environment_differs',
          decidedBy: 'regression',
          environments: [
            { environment: environment('sha256:aaa'), baselineTrials: 2, candidateTrials: 1 },
            { environment: environment('sha256:bbb'), baselineTrials: 0, candidateTrials: 1 },
          ],
        }),
      ),
    );
    renderPage(http, 'e-1');
    const warning = await screen.findByTestId('draft-eval-environments-differ');
    expect(warning.textContent).toContain('2 个运行环境');
    expect(screen.getAllByTestId('draft-eval-environment')).toHaveLength(2);
    expect(screen.getByTestId('draft-eval-reason').textContent).toContain('不全在同一个运行环境');
  });

  it('says the environment is unknown, not shared, when a trial did not report it (#833 UX P2-2)', async () => {
    const unreported: RunEnvironmentWire = {
      ...environment(),
      runtime: null,
      environmentDigest: null,
    };
    const http = scriptedHttp(
      handlers('member', () =>
        evaluation({
          verdict: 'unmeasured',
          reason: 'environment_unknown',
          decidedBy: 'regression',
          environments: [{ environment: unreported, baselineTrials: 2, candidateTrials: 2 }],
        }),
      ),
    );
    renderPage(http, 'e-1');
    const warning = await screen.findByTestId('draft-eval-environments-unknown');
    expect(warning.textContent).toContain('没法确认两组是在同一个环境里跑的');
    expect(warning.textContent).toContain('所以结论是「无法比较」');
    expect(screen.queryByText('两组的所有试跑都在同一个运行环境里。')).toBeNull();
    expect(screen.queryByTestId('draft-eval-environments-differ')).toBeNull();
  });

  it('trials a cancel voided read voided, not errored, and cost nothing (#833 UX P3-2)', async () => {
    const voided = tally(0, 3, { failed: 1, voided: 2, costUsd: 0.01, tokens: 100 });
    const http = scriptedHttp({
      ...handlers('member', () =>
        evaluation({
          status: 'cancelled',
          verdict: null,
          reason: null,
          decidedBy: null,
          cancelledBy: 'p-me',
          stages: [
            stage('regression', {
              status: 'cancelled',
              k: 3,
              baseline: voided,
              candidate: voided,
              cases: [
                {
                  caseId: 'c-1',
                  title: 'check dependants first',
                  split: 'dev',
                  baseline: voided,
                  candidate: voided,
                },
              ],
            }),
          ],
        }),
      ),
      get_eval_run: () => ({
        ...RUN,
        trials: [
          trial(),
          trial({
            id: 't-2',
            rep: 2,
            status: 'errored',
            verdict: null,
            error: 'cancelled',
            taskId: null,
            assertions: [],
            result: null,
            costUsd: null,
            tokens: 0,
            environmentDigest: null,
            startedAt: null,
          }),
        ],
      }),
    });
    renderPage(http, 'e-1');
    const stageCard = (await screen.findAllByTestId('draft-eval-stage'))[0] as HTMLElement;
    expect(within(stageCard).getByTestId('draft-eval-stage-tally').textContent).toBe(
      '基线组 0/3 通过 · 2 作废；草稿组 0/3 通过 · 2 作废',
    );
    const matrix = within(stageCard).getByTestId('draft-eval-matrix');
    expect(within(matrix).getByTestId('draft-eval-matrix-row').textContent).toContain(
      '0/3 (2 作废)',
    );
    fireEvent.click(within(matrix).getByTestId('draft-eval-matrix-open'));
    const trials = await within(matrix).findAllByTestId('draft-eval-trial');
    const second = trials[1] as HTMLElement;
    expect(second.textContent).toContain('已作废');
    expect(second.textContent).not.toContain('$');
    fireEvent.click(within(second).getByTestId('draft-eval-trial-open'));
    const opened = await within(second).findByTestId('eval-case-trial');
    expect(opened.getAttribute('data-status')).toBe('voided');
    expect(within(opened).getByTestId('eval-case-trial-voided').textContent).toContain(
      '没有开始，也没有花费',
    );
    expect(within(opened).queryByTestId('eval-case-trial-cost')).toBeNull();
    expect(within(opened).queryByTestId('eval-case-trial-errored')).toBeNull();
  });

  it('a builder cancels a running evaluation; it then reads cancelled, with no verdict', async () => {
    let current = evaluation({
      status: 'running',
      stage: 'confirm',
      verdict: null,
      reason: null,
      decidedBy: null,
      finishedAt: null,
      stages: [
        stage('regression'),
        stage('mechanism', {
          status: 'skipped',
          skipReason: 'no_mechanism',
          runId: null,
          k: 0,
          caseCount: 0,
          cases: [],
          baseline: tally(0, 0),
          candidate: tally(0, 0),
        }),
        stage('confirm', {
          status: 'running',
          k: 3,
          baseline: tally(0, 3, { failed: 0, open: 3 }),
          candidate: tally(0, 3, { failed: 0, open: 3 }),
          cases: [],
        }),
      ],
    });
    const cancel = vi.fn(() => {
      current = {
        ...current,
        status: 'cancelled',
        stage: null,
        finishedAt: AT,
        cancelledBy: 'p-me',
        stages: current.stages.map((item) =>
          item.stage === 'confirm' ? { ...item, status: 'cancelled' } : item,
        ),
      };
      return current;
    });
    const http = scriptedHttp({
      ...handlers('builder', () => current),
      cancel_draft_evaluation: cancel,
    });
    renderPage(http, 'e-1');
    const running = await screen.findByTestId('draft-eval-running');
    expect(running.textContent).toContain('正在跑确认对比');
    expect(running.textContent).toContain('不能丢弃或拒绝');
    const skipped = screen
      .getAllByTestId('draft-eval-stage')
      .find((node) => node.getAttribute('data-stage') === 'mechanism') as HTMLElement;
    expect(within(skipped).getByTestId('draft-eval-stage-skip').textContent).toContain(
      '没有选机制',
    );

    fireEvent.click(screen.getByTestId('draft-eval-cancel'));
    const confirm = await screen.findByTestId('draft-eval-cancel-confirm');
    fireEvent.click(within(confirm).getByRole('button', { name: '取消评测' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith({ evaluationId: 'e-1' }));
    await screen.findByTestId('draft-eval-cancelled');
    expect(screen.getByTestId('draft-eval-outcome').textContent).toContain('已取消');
    expect(screen.queryByTestId('draft-eval-cancel')).toBeNull();
  });
});
