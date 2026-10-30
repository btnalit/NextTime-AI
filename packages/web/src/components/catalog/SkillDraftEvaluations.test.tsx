// @vitest-environment jsdom
import type {
  DraftEvaluationSummaryWire,
  EvalBudgetWire,
  EvalCaseSummaryWire,
  EvalSuiteSummaryWire,
  EvalSuiteWire,
} from '@nexttime/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { SkillDraftEvaluations } from './SkillDraftEvaluations.js';

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

const budget = (extra: Partial<EvalBudgetWire> = {}): EvalBudgetWire => ({
  monthlyBudgetUsd: 10,
  spentUsd: 2.5,
  periodStart: '2026-10-01T00:00:00.000Z',
  periodEnd: '2026-11-01T00:00:00.000Z',
  trialCostUsd: 0.01,
  unpricedTrials: 0,
  committedUsd: 0,
  ...extra,
});

function caseRow(
  id: string,
  partition: EvalCaseSummaryWire['partition'],
  mechanism: string | null = null,
): EvalCaseSummaryWire {
  return {
    id,
    title: `case ${id}`,
    partition,
    split: 'dev',
    mechanism,
    origin: 'human',
    addedInVersion: 1,
    addedBy: 'p-me',
    addedAt: AT,
    supersedes: null,
    fixtureRuleCount: 0,
    assertionCount: 1,
    fixtureOperations: [],
    fixtureProblems: [],
  };
}

const SUMMARY: EvalSuiteSummaryWire = {
  id: 's-1',
  name: 'restart drills',
  description: '',
  workerDefinition: { id: WD, version: 1, status: 'published' },
  version: 3,
  fixtureGateCount: 1,
  fixtureGatesNeedingAttention: 0,
  caseCount: 4,
  casesNeedingAttention: 0,
  createdBy: 'p-me',
  createdAt: AT,
  updatedAt: AT,
};

const SUITE: EvalSuiteWire = {
  ...SUMMARY,
  canary: `NTEVAL-${'ab'.repeat(16)}`,
  fixtureGates: [],
  cases: [
    caseRow('c-1', 'regression'),
    caseRow('c-2', 'mechanism', 'asks first'),
    caseRow('c-3', 'mechanism', 'asks first'),
    caseRow('c-4', 'full'),
  ],
  history: [],
};

function summary(extra: Partial<DraftEvaluationSummaryWire> = {}): DraftEvaluationSummaryWire {
  return {
    id: 'e-1',
    status: 'finished',
    stage: null,
    verdict: 'regressed',
    reason: 'regression_case_lost',
    decidedBy: 'regression',
    costUsd: 0.08,
    createdBy: 'p-me',
    createdAt: AT,
    finishedAt: AT,
    cancelledBy: null,
    suite: { id: 's-1', name: 'restart drills', version: 3 },
    workerDefinition: { id: WD, version: 1 },
    candidate: { skillId: SKILL, version: 2, name: 'restart-helper', draftDigest: 'sha256:d' },
    baseline: { skillId: SKILL, version: 1, name: 'restart-helper' },
    mechanism: null,
    ...extra,
  };
}

function handlers(role: string, extra: Record<string, (params: unknown) => unknown> = {}) {
  return {
    get_workspace: () => ({
      id: 'ws-1',
      name: 'Acme',
      caller: { id: 'p-me', role, displayName: 'Me', kind: 'human' },
    }),
    list_draft_evaluations: () => ({ items: [summary()] }),
    list_eval_suites: () => ({ items: [SUMMARY] }),
    get_eval_suite: () => SUITE,
    get_eval_budget: () => budget(),
    ...extra,
  };
}

const DRAFT = {
  id: SKILL,
  version: 2,
  name: 'restart-helper',
  status: 'draft',
  draftDigest: 'sha256:d',
};

function renderSection(
  http: CapabilityCaller,
  skill = DRAFT,
  inUseVersion: number | undefined = 1,
  onEvaluatingChange?: (evaluating: boolean) => void,
) {
  render(
    <PermissionsProvider>
      <SkillDraftEvaluations
        http={http}
        skill={skill}
        inUseVersion={inUseVersion}
        onEvaluatingChange={onEvaluatingChange}
      />
    </PermissionsProvider>,
  );
}

const select = (element: HTMLElement, value: string) =>
  fireEvent.change(element, { target: { value } });

async function openSheet(): Promise<HTMLElement> {
  const button = await screen.findByTestId('skill-draft-evaluate');
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  const sheet = await screen.findByTestId('draft-eval-start');
  const suite = within(sheet).getByTestId('draft-eval-start-suite');
  await waitFor(() => expect((suite as HTMLSelectElement).disabled).toBe(false));
  select(suite, 's-1');
  await within(sheet).findByTestId('draft-eval-start-plan');
  return sheet;
}

describe('SkillDraftEvaluations (S10 E3-2b)', () => {
  it('lists this version’s evaluations with their verdict and why, linked to 草稿评测', async () => {
    const http = scriptedHttp(handlers('builder'));
    renderSection(http);
    const row = await screen.findByTestId('skill-draft-evaluation');
    expect(row.textContent).toContain('有回归');
    expect(row.textContent).toContain('有回归用例，草稿通过的次数比基线少。');
    expect(within(row).getByRole('link').getAttribute('href')).toBe(
      '#/govern/evaluation/drafts/e-1',
    );
    expect(http.calls.find((c) => c.name === 'list_draft_evaluations')?.params).toEqual({
      skillId: SKILL,
    });
  });

  it('plans each stage before a start, then starts with the suite version and mechanism chosen', async () => {
    const started = vi.fn(() => ({ id: 'e-2' }));
    const http = scriptedHttp(handlers('builder', { start_draft_evaluation: started }));
    renderSection(http);
    const sheet = await openSheet();
    const stages = within(sheet).getAllByTestId('draft-eval-start-stage');
    expect(stages.map((node) => node.textContent)).toEqual([
      '回归检查1 条用例 × 每组 2 次 × 两组 = 4 次试跑，约 $0.04',
      '机制检验没有选机制，跳过机制检验。',
      '确认对比1 条用例 × 每组 3 次 × 两组 = 6 次试跑，约 $0.06',
    ]);
    select(within(sheet).getByTestId('draft-eval-start-mechanism'), 'asks first');
    await waitFor(() =>
      expect(within(sheet).getAllByTestId('draft-eval-start-stage')[1]?.textContent).toContain(
        '2 条用例 × 每组 5 次 × 两组 = 20 次试跑',
      ),
    );
    fireEvent.click(within(sheet).getByTestId('draft-eval-start-submit'));
    await waitFor(() =>
      expect(started).toHaveBeenCalledWith({
        skillId: SKILL,
        version: 2,
        draftDigest: 'sha256:d',
        suiteId: 's-1',
        suiteVersion: 3,
        mechanism: 'asks first',
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('draft-eval-start')).toBeNull());
  });

  it('lists each failed check of the draft in place, by what it counted', async () => {
    const http = scriptedHttp(
      handlers('builder', {
        start_draft_evaluation: () => {
          throw new HttpError('capability_error', 'refused', 'draft_check_failed', {
            problems: [
              { check: 'credential_like', count: 1, limit: null },
              { check: 'edit_budget', count: 250, limit: 200 },
            ],
          });
        },
      }),
    );
    renderSection(http);
    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByTestId('draft-eval-start-submit'));
    const check = await within(sheet).findByTestId('draft-eval-start-check');
    const problems = within(check).getAllByTestId('draft-eval-start-problem');
    expect(problems.map((node) => node.getAttribute('data-check'))).toEqual([
      'credential_like',
      'edit_budget',
    ]);
    expect(problems[1]?.textContent).toContain('改了 250 行，超过了 200 行的上限');
  });

  it('will not start when what is left cannot cover the first stage, and says why', async () => {
    const http = scriptedHttp(
      handlers('builder', { get_eval_budget: () => budget({ spentUsd: 9.98 }) }),
    );
    renderSection(http);
    const sheet = await openSheet();
    expect(within(sheet).getByTestId('draft-eval-start-short').textContent).toContain(
      '不够跑第一个阶段',
    );
    // The first stage is checked at the start: it does not fit. A later one may not, by then.
    expect(
      within(sheet)
        .getAllByTestId('draft-eval-start-stage-short')
        .map((node) => node.textContent),
    ).toEqual(['预算不够', '预算可能不够']);
    expect(
      (within(sheet).getByTestId('draft-eval-start-submit') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('while one runs: no second start, and the draft says it cannot be discarded or rejected', async () => {
    const http = scriptedHttp(
      handlers('builder', {
        list_draft_evaluations: () => ({
          items: [
            summary({
              status: 'running',
              stage: 'regression',
              verdict: null,
              reason: null,
              decidedBy: null,
              finishedAt: null,
            }),
          ],
        }),
      }),
    );
    renderSection(http);
    const note = await screen.findByTestId('skill-draft-evaluating');
    expect(note.textContent).toContain('不能丢弃或拒绝');
    await waitFor(() =>
      expect((screen.getByTestId('skill-draft-evaluate') as HTMLButtonElement).disabled).toBe(true),
    );
  });

  it('reads the list again while one runs, until it ends — then it may start again and the draft may go', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const running = summary({
        status: 'running',
        stage: 'confirm',
        verdict: null,
        reason: null,
        decidedBy: null,
        finishedAt: null,
      });
      let reads = 0;
      const http = scriptedHttp(
        handlers('builder', {
          list_draft_evaluations: () => {
            reads += 1;
            return { items: [reads === 1 ? running : summary()] };
          },
        }),
      );
      const evaluating = vi.fn();
      renderSection(http, DRAFT, 1, evaluating);
      await screen.findByTestId('skill-draft-evaluating');
      await waitFor(() => expect(evaluating).toHaveBeenLastCalledWith(true));

      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      await waitFor(() => expect(screen.queryByTestId('skill-draft-evaluating')).toBeNull());
      expect(screen.getByTestId('skill-draft-evaluation').textContent).toContain('有回归');
      await waitFor(() =>
        expect((screen.getByTestId('skill-draft-evaluate') as HTMLButtonElement).disabled).toBe(
          false,
        ),
      );
      expect(evaluating).toHaveBeenLastCalledWith(false);

      // Ended: no more reads.
      await act(async () => {
        vi.advanceTimersByTime(9000);
      });
      expect(reads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a member reads the evaluations but is told who starts one; a published version without any shows nothing', async () => {
    const member = scriptedHttp(handlers('member'));
    renderSection(member);
    await screen.findByTestId('skill-draft-evaluation');
    await waitFor(() =>
      expect(screen.getByTestId('skill-draft-evaluations').textContent).toContain(
        '评测由构建者或工作区所有者发起。',
      ),
    );
    expect(screen.queryByTestId('skill-draft-evaluate')).toBeNull();
    cleanup();

    const published = scriptedHttp(
      handlers('builder', { list_draft_evaluations: () => ({ items: [] }) }),
    );
    renderSection(published, { ...DRAFT, status: 'published', version: 1 }, undefined);
    await waitFor(() =>
      expect(published.calls.some((c) => c.name === 'list_draft_evaluations')).toBe(true),
    );
    expect(screen.queryByTestId('skill-draft-evaluations')).toBeNull();
  });
});
