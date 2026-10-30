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
