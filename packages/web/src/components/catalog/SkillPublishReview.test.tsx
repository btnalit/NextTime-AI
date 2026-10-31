// @vitest-environment jsdom
import type {
  DraftEvaluationArmTallyWire,
  DraftEvaluationEvidenceWire,
  DraftEvaluationSummaryWire,
  PublishAcknowledgementItemWire,
  PublishEvaluationReview,
  SkillPublishEvidenceWire,
} from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Resource } from '../../hooks/useResource.js';
import {
  PublishAcknowledgeSheet,
  type PublishAcknowledgeSheetProps,
  SkillPublishReview,
} from './SkillPublishReview.js';

afterEach(cleanup);

const WD = '11111111-1111-4111-8111-111111111111';
const SKILL = '44444444-4444-4444-8444-444444444444';
const LATEST = '55555555-5555-4555-8555-555555555555';
const EARLIER = '66666666-6666-4666-8666-666666666666';
const OLD_DRAFT = '77777777-7777-4777-8777-777777777777';
const PASSED = '88888888-8888-4888-8888-888888888888';
const NEWER = '99999999-9999-4999-8999-999999999999';
const CASE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CASE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CASE_R = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const AT = '2026-10-30T00:00:00.000Z';

function tally(extra: Partial<DraftEvaluationArmTallyWire> = {}): DraftEvaluationArmTallyWire {
  return {
    trials: 3,
    passed: 3,
    failed: 0,
    errored: 0,
    voided: 0,
    open: 0,
    costUsd: 0.03,
    tokens: 3000,
    ...extra,
  };
}

function summary(extra: Partial<DraftEvaluationSummaryWire> = {}): DraftEvaluationSummaryWire {
  return {
    id: LATEST,
    status: 'finished',
    stage: null,
    verdict: 'worse',
    reason: 'below_margin',
    decidedBy: 'confirm',
    devVerdict: 'worse',
    costUsd: 0.14,
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

function worseEvidence(): DraftEvaluationEvidenceWire {
  return {
    ...summary(),
    decidingStage: {
      stage: 'confirm',
      status: 'ended',
      skipReason: null,
      runId: 'run-1',
      caseCount: 2,
      k: 3,
      estimateUsd: 0.12,
      baseline: tally({ trials: 6, passed: 6, costUsd: 0.06, tokens: 6000 }),
      candidate: tally({ trials: 6, passed: 3, failed: 3, costUsd: 0.08, tokens: 8000 }),
      cases: [
        {
          caseId: CASE_A,
          title: 'restart the web tier',
          split: 'dev',
          baseline: tally(),
          candidate: tally({ passed: 0, failed: 3 }),
        },
        {
          caseId: CASE_B,
          title: 'drain first',
          split: 'holdout',
          baseline: tally(),
          candidate: tally(),
        },
      ],
      measure: {
        stage: 'confirm',
        delta: 0.1,
        confidence: 0.95,
        dev: {
          candidatePassed: 0,
          candidateTrials: 3,
          candidateNoOutcome: 0,
          baselinePassed: 3,
          baselineTrials: 3,
          baselineNoOutcome: 0,
          difference: -1,
          lowerBound: -1,
        },
        holdout: null,
      },
    },
    baselineTotal: tally({ trials: 8, passed: 8, costUsd: 0.06, tokens: 6000 }),
    candidateTotal: tally({ trials: 8, passed: 5, failed: 3, costUsd: 0.08, tokens: 8500 }),
  };
}

const ITEM_A: PublishAcknowledgementItemWire = {
  evaluationId: LATEST,
  caseId: CASE_A,
  title: 'restart the web tier',
  split: 'dev',
  stage: 'confirm',
  baseline: tally(),
  candidate: tally({ passed: 0, failed: 3 }),
};

const ITEM_R: PublishAcknowledgementItemWire = {
  evaluationId: EARLIER,
  caseId: CASE_R,
  title: 'check the health endpoint',
  split: 'dev',
  stage: 'regression',
  baseline: tally({ trials: 2, passed: 2 }),
  candidate: tally({ trials: 2, passed: 0, failed: 2 }),
};

function evidence(extra: Partial<SkillPublishEvidenceWire> = {}): SkillPublishEvidenceWire {
  const earlier: DraftEvaluationEvidenceWire = {
    ...summary({
      id: EARLIER,
      verdict: 'regressed',
      reason: 'regression_case_lost',
      decidedBy: 'regression',
    }),
    decidingStage: null,
    baselineTotal: tally({ trials: 2, passed: 2 }),
    candidateTotal: tally({ trials: 2, passed: 0, failed: 2 }),
  };
  return {
    evaluations: [worseEvidence(), earlier],
    runningEvaluationId: null,
    acknowledge: [ITEM_A, ITEM_R],
    familyHistory: [
      {
        ...summary({
          id: OLD_DRAFT,
          verdict: 'refuted',
          reason: 'mechanism_not_shown',
          decidedBy: 'mechanism',
          candidate: {
            skillId: SKILL,
            version: 1,
            name: 'restart-helper',
            draftDigest: 'sha256:o',
          },
        }),
        candidateState: 'published',
      },
    ],
    ...extra,
  };
}

function ready(data: SkillPublishEvidenceWire): Resource<SkillPublishEvidenceWire> {
  return {
    state: { status: 'ready', data, refreshing: false, refreshError: null },
    reload: vi.fn(async () => undefined),
    mutate: () => undefined,
  };
}

describe('SkillPublishReview (S10 E3-3a)', () => {
  it('the evidence card: verdict, the same content, why, what the deciding stage measured, each case, both arms’ cost, and the link', () => {
    render(<SkillPublishReview evidence={ready(evidence())} />);
    const card = screen.getByTestId('skill-publish-evidence');
    expect(card.getAttribute('data-evaluation-id')).toBe(LATEST);
    expect(within(card).getByTestId('skill-publish-evidence-verdict').textContent).toContain(
      '差于基线',
    );
    expect(within(card).getByTestId('skill-publish-evidence-same-content').textContent).toContain(
      '评测的正是这份草稿现在的内容',
    );
    expect(within(card).getByTestId('skill-publish-evidence-reason').textContent).toContain(
      '低了 10 个百分点以上',
    );
    expect(within(card).getByTestId('skill-publish-evidence-stage').textContent).toContain(
      '确认对比',
    );
    expect(within(card).getByTestId('draft-eval-measure').textContent).toContain('dev');
    const cases = within(card).getAllByTestId('skill-publish-evidence-case');
    expect(cases.map((row) => row.getAttribute('data-acknowledge'))).toEqual(['true', null]);
    expect(cases[0]?.textContent).toContain('发布前要确认');
    expect(card.textContent).toContain('两组合计（各阶段）');
    const totals = within(card).getByTestId('skill-publish-evidence-totals').textContent ?? '';
    expect(totals).toContain('8/8 通过');
    expect(totals).toContain('5/8 通过');
    expect(within(card).getByTestId('skill-publish-evidence-difference').textContent).toContain(
      '+$0.02',
    );
    expect(within(card).getByTestId('skill-publish-evidence-link').getAttribute('href')).toContain(
      LATEST,
    );
    expect(screen.queryByTestId('skill-publish-evidence-inconclusive')).toBeNull();

    expect(screen.getByTestId('skill-publish-review-acknowledge').textContent).toContain(
      '2 条用例上不如基线',
    );
    const earlier = screen.getAllByTestId('skill-publish-review-earlier-row');
    expect(earlier.map((row) => row.getAttribute('data-evaluation-id'))).toEqual([EARLIER]);
    expect(earlier[0]?.textContent).toContain('要确认：');
    expect(earlier[0]?.textContent).toContain(ITEM_R.title);
    // #842 UX P2-1: another version's unfavourable evaluation says where that version stands now,
    // under a neutral title — a published version is not a change that "did not hold up".
    const section = screen.getByTestId('skill-publish-review-history');
    expect(section.textContent).toContain('这个 Skill 其他版本的不利评测');
    expect(section.textContent).not.toContain('没站住');
    const history = screen.getAllByTestId('skill-publish-review-history-row');
    expect(history[0]?.textContent).toContain('v1');
    expect(history[0]?.textContent).toContain('机制未证实');
    const state = within(history[0] as HTMLElement).getByTestId(
      'skill-publish-review-history-state',
    );
    expect(state.getAttribute('data-status')).toBe('published');
    expect(state.textContent).toBe('已发布');
  });

  it('lists only the earlier evaluations that still have failures to acknowledge (#842 UX P3-4)', () => {
    const passed: DraftEvaluationEvidenceWire = {
      ...summary({ id: PASSED, verdict: 'non_inferior', reason: null }),
      decidingStage: null,
      baselineTotal: tally(),
      candidateTotal: tally(),
    };
    const base = evidence();
    render(
      <SkillPublishReview
        evidence={ready({ ...base, evaluations: [...base.evaluations, passed] })}
      />,
    );
    const earlier = screen.getAllByTestId('skill-publish-review-earlier-row');
    expect(earlier.map((row) => row.getAttribute('data-evaluation-id'))).toEqual([EARLIER]);
  });

  it('every state another version can be in has its label', () => {
    const states = ['draft', 'published', 'deprecated', 'rejected', 'discarded'] as const;
    const base = evidence();
    const history = base.familyHistory[0];
    if (history === undefined) throw new Error('fixture');
    render(
      <SkillPublishReview
        evidence={ready({
          ...base,
          familyHistory: states.map((candidateState, index) => ({
            ...history,
            id: `7777777${index}-7777-4777-8777-777777777777`,
            candidateState,
          })),
        })}
      />,
    );
    expect(
      screen.getAllByTestId('skill-publish-review-history-state').map((chip) => chip.textContent),
    ).toEqual(['草稿', '已发布', '已弃用', '已拒绝', '已丢弃']);
  });

  it('inconclusive says the evidence cannot show the draft is no worse; nothing to acknowledge', () => {
    render(
      <SkillPublishReview
        evidence={ready(
          evidence({
            evaluations: [
              { ...worseEvidence(), verdict: 'inconclusive', reason: 'too_few_trials' },
            ],
            acknowledge: [],
            familyHistory: [],
          }),
        )}
      />,
    );
    expect(screen.getByTestId('skill-publish-evidence-inconclusive').textContent).toContain(
      '证据不足以证明这份草稿不比基线差',
    );
    expect(screen.queryByTestId('skill-publish-review-acknowledge')).toBeNull();
    expect(screen.queryByTestId('skill-publish-review-history')).toBeNull();
  });

  it('a draft never evaluated says so: publishing does not need one', () => {
    render(
      <SkillPublishReview
        evidence={ready(evidence({ evaluations: [], acknowledge: [], familyHistory: [] }))}
      />,
    );
    expect(screen.getByTestId('skill-publish-review-none').textContent).toContain(
      '评测不是发布的前提',
    );
    expect(screen.queryByTestId('skill-publish-evidence')).toBeNull();
  });
});

describe('PublishAcknowledgeSheet (S10 E3-3a)', () => {
  function renderSheet(
    onConfirm: (review: PublishEvaluationReview) => Promise<boolean>,
    extra: Partial<PublishAcknowledgeSheetProps> = {},
  ) {
    const onOpenChange = vi.fn();
    const props: PublishAcknowledgeSheetProps = {
      open: true,
      onOpenChange,
      target: 'restart-helper v2',
      evidence: evidence(),
      busy: false,
      evaluating: false,
      credentialSlot: null,
      credentialBlocked: false,
      onConfirm,
      ...extra,
    };
    const view = render(<PublishAcknowledgeSheet {...props} />);
    return {
      onOpenChange,
      sheet: screen.getByTestId('publish-acknowledge'),
      rerender: (next: Partial<PublishAcknowledgeSheetProps>) =>
        view.rerender(<PublishAcknowledgeSheet {...props} {...next} />),
    };
  }

  function fillEveryReason(sheet: HTMLElement): void {
    for (const reason of within(sheet).getAllByTestId('publish-acknowledge-reason')) {
      fireEvent.change(reason, { target: { value: 'known' } });
    }
  }

  it('each failure, grouped by its evaluation, needs a reason; the publish names the newest evaluation and every acknowledgement', async () => {
    const onConfirm = vi.fn(async () => true);
    const { onOpenChange, sheet } = renderSheet(onConfirm);
    const groups = within(sheet).getAllByTestId('publish-acknowledge-evaluation');
    expect(groups.map((g) => g.getAttribute('data-evaluation-id'))).toEqual([LATEST, EARLIER]);
    const items = within(sheet).getAllByTestId('publish-acknowledge-item');
    expect(items.map((item) => item.getAttribute('data-case-id'))).toEqual([CASE_A, CASE_R]);
    expect(items[0]?.textContent).toContain('基线组 3/3，草稿组 0/3');
    expect(items[1]?.textContent).toContain('回归检查');

    const submit = screen.getByTestId('publish-acknowledge-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByTestId('publish-acknowledge-missing').textContent).toContain(
      '为 2 条失败写下理由',
    );
    const reasons = within(sheet).getAllByTestId('publish-acknowledge-reason');
    fireEvent.change(reasons[0] as HTMLElement, { target: { value: '  flaky fixture  ' } });
    expect(screen.getByTestId('publish-acknowledge-missing').textContent).toContain(
      '为 1 条失败写下理由',
    );
    fireEvent.change(reasons[1] as HTMLElement, { target: { value: 'health check moved' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledWith({
      evaluationId: LATEST,
      acknowledgements: [
        { evaluationId: LATEST, caseId: CASE_A, reason: 'flaky fixture' },
        { evaluationId: EARLIER, caseId: CASE_R, reason: 'health check moved' },
      ],
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('a refused publish leaves the sheet open with the reasons kept', async () => {
    const onConfirm = vi.fn(async () => false);
    const { onOpenChange, sheet } = renderSheet(onConfirm);
    const reasons = within(sheet).getAllByTestId('publish-acknowledge-reason');
    for (const reason of reasons) fireEvent.change(reason, { target: { value: 'known' } });
    fireEvent.click(screen.getByTestId('publish-acknowledge-submit'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(
      within(sheet)
        .getAllByTestId('publish-acknowledge-reason')
        .map((el) => (el as HTMLTextAreaElement).value),
    ).toEqual(['known', 'known']);
    // The evidence read again is the same: nothing moved, so nothing to say.
    expect(screen.queryByTestId('publish-acknowledge-changed')).toBeNull();
  });

  it('says in place what moved when the evidence read again after a refusal differs (#842 UX P3-2)', async () => {
    const onConfirm = vi.fn(async () => false);
    const { sheet, rerender } = renderSheet(onConfirm);
    fillEveryReason(sheet);
    fireEvent.click(screen.getByTestId('publish-acknowledge-submit'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    const base = evidence();
    const unmeasured: DraftEvaluationEvidenceWire = {
      ...summary({ id: NEWER, verdict: 'unmeasured', reason: null }),
      decidingStage: null,
      baselineTotal: tally(),
      candidateTotal: tally(),
    };
    rerender({ evidence: { ...base, evaluations: [unmeasured, ...base.evaluations] } });
    const notice = within(sheet).getByTestId('publish-acknowledge-changed');
    expect(notice.textContent).toContain('这次没有发布');
    expect(notice.textContent).toContain('又有一次评测结束，结论是「无法比较」');
    expect(notice.textContent).toContain('要确认的失败没有变');
    // The reasons typed stay with their failures, so it can be submitted again as it is.
    expect((screen.getByTestId('publish-acknowledge-submit') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('a new failure to acknowledge is counted in the notice and needs its reason', async () => {
    const onConfirm = vi.fn(async () => false);
    const { sheet, rerender } = renderSheet(onConfirm);
    fillEveryReason(sheet);
    fireEvent.click(screen.getByTestId('publish-acknowledge-submit'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    const base = evidence();
    const regressed: DraftEvaluationEvidenceWire = {
      ...summary({
        id: NEWER,
        verdict: 'regressed',
        reason: 'regression_case_lost',
        decidedBy: 'regression',
      }),
      decidingStage: null,
      baselineTotal: tally({ trials: 2, passed: 2 }),
      candidateTotal: tally({ trials: 2, passed: 0, failed: 2 }),
    };
    rerender({
      evidence: {
        ...base,
        evaluations: [regressed, ...base.evaluations],
        acknowledge: [{ ...ITEM_R, evaluationId: NEWER }, ...base.acknowledge],
      },
    });
    expect(within(sheet).getByTestId('publish-acknowledge-changed').textContent).toContain(
      '要确认的失败多了 1 条',
    );
    expect(screen.getByTestId('publish-acknowledge-missing').textContent).toContain(
      '为 1 条失败写下理由',
    );
  });

  it('an evaluation running now holds the publish and is named in the notice', async () => {
    const onConfirm = vi.fn(async () => false);
    const { sheet, rerender } = renderSheet(onConfirm);
    fillEveryReason(sheet);
    fireEvent.click(screen.getByTestId('publish-acknowledge-submit'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    rerender({ evidence: evidence({ runningEvaluationId: NEWER }), evaluating: true });
    expect(within(sheet).getByTestId('publish-acknowledge-changed').textContent).toContain(
      '又有一次评测开始了，结束或取消之前不能发布',
    );
    expect((screen.getByTestId('publish-acknowledge-submit') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByTestId('publish-acknowledge-missing').textContent).toContain(
      '等正在跑的评测结束或取消',
    );
  });

  it('an open credential question holds the publish', () => {
    const { sheet } = renderSheet(async () => true, {
      evidence: evidence({ acknowledge: [ITEM_A] }),
      credentialSlot: <p data-testid="credential-slot">confirm</p>,
      credentialBlocked: true,
    });
    expect(within(sheet).getByTestId('credential-slot')).toBeTruthy();
    fireEvent.change(within(sheet).getByTestId('publish-acknowledge-reason'), {
      target: { value: 'known' },
    });
    expect((screen.getByTestId('publish-acknowledge-submit') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByTestId('publish-acknowledge-missing').textContent).toContain('确认凭证提示');
  });
});
