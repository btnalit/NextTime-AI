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

/** 400 invalid_params: the pin is not a published worker-kind version, the gate is not there or
 *  publishes nothing — whatever the suite's state. */
export class EvalSuiteInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalSuiteInputError';
  }
}

/** 409 conflict: the suite already is as asked (the version pinned now, a gate it already has, a
 *  gate that still matches) or does not have the gate named. */
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
