import type { DraftCheckProblemWire } from '@nexttime/shared';

/**
 * application/eval's refusals, sorted the way the `goal` module sorts its own: not there (404), a
 * request no state of the suite would take (400 invalid_params), one the suite's state does not
 * allow now (409 conflict), a name another suite has (409 eval_suite_name_taken). A change made
 * against a suite version other than the current one is `ReviewedVersionChangedError` (409
 * version_changed), as every other "you looked at another version" refusal is.
 */

/** 404 not_found: no suite with this id in the workspace. */
export class EvalSuiteNotFoundError extends Error {
  constructor(suiteId: string) {
    super(`evaluation suite ${suiteId} not found`);
    this.name = 'EvalSuiteNotFoundError';
  }
}

/** 404 not_found: the suite has no case row with this id (E3-1b). An `EvalSuiteNotFoundError`,
 *  so every place that maps that one maps this one the same way. */
export class EvalCaseNotFoundError extends EvalSuiteNotFoundError {
  constructor(caseId: string) {
    super(caseId);
    this.message = `evaluation case ${caseId} not found in this suite`;
    this.name = 'EvalCaseNotFoundError';
  }
}

/** 400 invalid_params: the pin is not a published worker-kind version, the gate is not there or
 *  publishes nothing — whatever the suite's state. */
export class EvalSuiteInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalSuiteInputError';
  }
}

/** 409 conflict: the suite already is as asked (the version pinned now, a gate it already has, a
 *  gate that still matches, a case that already reads so) or does not have the gate or the live
 *  case named. */
export class EvalSuiteStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalSuiteStateError';
  }
}

/** 409 eval_suite_name_taken: another suite of the workspace has this name (case and surrounding
 *  blanks ignored — `eval_suites_name_unique`). */
export class EvalSuiteNameTakenError extends Error {
  readonly code = 'eval_suite_name_taken' as const;
  constructor(name: string) {
    super(
      `another evaluation suite is already named "${name}" — choose another name; nothing was created`,
    );
    this.name = 'EvalSuiteNameTakenError';
  }
}

/** How many of the cases using a fixture gate a refusal names (the count is always whole). */
const IN_USE_CASES_SHOWN = 50;

/** 409 fixture_gate_in_use (E3-1b): cases the suite holds answer calls through the fixture gate
 *  to remove — removing it would leave those rules answering nothing. `details` names them (the
 *  first {@link IN_USE_CASES_SHOWN}, oldest first, and how many in all), so the person can edit or
 *  retire them first. Only a person reaches it (`remove_eval_fixture_gate` is human-only). */
export class EvalFixtureGateInUseError extends Error {
  readonly code = 'fixture_gate_in_use' as const;
  readonly details: {
    readonly caseCount: number;
    readonly cases: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  };
  constructor(gateName: string, cases: ReadonlyArray<{ id: string; title: string }>) {
    const titles = cases.slice(0, 5).map((item) => `"${item.title}"`);
    super(
      `fixture gate "${gateName}" answers calls in ${cases.length} case(s) the suite holds (${titles.join(', ')}${cases.length > 5 ? ', …' : ''}) — edit or retire them first; nothing was changed`,
    );
    this.name = 'EvalFixtureGateInUseError';
    this.details = { caseCount: cases.length, cases: cases.slice(0, IN_USE_CASES_SHOWN) };
  }
}

/** 404 not_found: no evaluation run with this id in the workspace (E3-2a). */
export class EvalRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`evaluation run ${runId} not found`);
    this.name = 'EvalRunNotFoundError';
  }
}

/** 429 evaluation_budget_exhausted (E3-2a): this UTC month's evaluation budget
 *  (`evaluation.monthly_cost_budget_usd`) is spent, so no run is started. `details` carries the
 *  budget and what was spent, in USD. The status and family are the daily cost budget's
 *  (`daily_cost_exceeded`): a spending limit, lifted when the period turns or an owner raises it. */
export class EvaluationBudgetExhaustedError extends Error {
  readonly code = 'evaluation_budget_exhausted' as const;
  readonly details: { readonly budgetUsd: number; readonly spentUsd: number };
  constructor(budgetUsd: number, spentUsd: number) {
    super(
      `this month's evaluation budget ($${budgetUsd.toFixed(2)}) is spent ($${spentUsd.toFixed(2)} so far) — nothing was started; an owner can raise evaluation.monthly_cost_budget_usd, or wait for the next UTC month`,
    );
    this.name = 'EvaluationBudgetExhaustedError';
    this.details = { budgetUsd, spentUsd };
  }
}

/** 404 not_found: no draft evaluation with this id in the workspace, or one the caller may not see
 *  (its draft is someone else's and was never published; E3-2b). An `EvalRunNotFoundError`, so
 *  every place that maps that one maps this one the same way. */
export class DraftEvaluationNotFoundError extends EvalRunNotFoundError {
  constructor(evaluationId: string) {
    super(evaluationId);
    this.message = `draft evaluation ${evaluationId} not found`;
    this.name = 'DraftEvaluationNotFoundError';
  }
}

/** 400 draft_check_failed (E3-2b): the draft failed the check it passes before an evaluation
 *  starts (`draft-check.ts`). `details.problems` names each failed check with what it counted —
 *  never the text it found. */
export class DraftCheckFailedError extends Error {
  readonly code = 'draft_check_failed' as const;
  readonly details: { readonly problems: readonly DraftCheckProblemWire[] };
  constructor(problems: readonly DraftCheckProblemWire[]) {
    super(
      `the draft did not pass the check an evaluation starts with (${problems.map((p) => p.check).join(', ')}) — change the draft and try again; nothing was started`,
    );
    this.name = 'DraftCheckFailedError';
    this.details = { problems };
  }
}

/** 429 evaluation_budget_insufficient (E3-2b): what is left of this month's evaluation budget —
 *  after what is spent and what the trials not ended yet are expected to cost — does not cover the
 *  first stage the evaluation would run (its trials × the recent cost of a trial). `details`
 *  carries the budget, what was spent, what is committed and the estimate, in USD. */
export class EvaluationBudgetInsufficientError extends Error {
  readonly code = 'evaluation_budget_insufficient' as const;
  readonly details: {
    readonly budgetUsd: number;
    readonly spentUsd: number;
    readonly committedUsd: number;
    readonly estimateUsd: number;
  };
  constructor(budgetUsd: number, spentUsd: number, committedUsd: number, estimateUsd: number) {
    super(
      `this month's evaluation budget ($${budgetUsd.toFixed(2)}, $${spentUsd.toFixed(2)} spent, about $${committedUsd.toFixed(2)} committed to trials not ended yet) does not cover the first stage (about $${estimateUsd.toFixed(2)}) — nothing was started; wait for running evaluations to end, an owner can raise evaluation.monthly_cost_budget_usd, or wait for the next UTC month`,
    );
    this.name = 'EvaluationBudgetInsufficientError';
    this.details = { budgetUsd, spentUsd, committedUsd, estimateUsd };
  }
}

/** 409 not_a_draft (E3-2b): the Skill version named is published or deprecated — only a draft is
 *  evaluated. */
export class EvalSkillNotADraftError extends Error {
  readonly code = 'not_a_draft' as const;
  constructor(skillId: string, version: number, status: string) {
    super(
      `Skill ${skillId}@${version} is not a draft (status: ${status}) — only a draft is evaluated; nothing was started`,
    );
    this.name = 'EvalSkillNotADraftError';
  }
}

/** 409 conflict on a draft evaluation that has already ended (cancel). An `EvalSuiteStateError`. */
export class DraftEvaluationEndedError extends EvalSuiteStateError {
  constructor(evaluationId: string, status: string) {
    super(`draft evaluation ${evaluationId} has already ended (${status}); nothing was changed`);
    this.name = 'DraftEvaluationEndedError';
  }
}
