/**
 * application/eval-session: what an evaluation Task's Worker reaches (S10 E3-2a;
 * docs/s10-evolution-plan-2026-10-04.md §3.3 I-E1, §5.5 封闭). An evaluation Task (`tasks.purpose
 * = 'evaluation'`, migrations/task/0011) runs one case of a suite for `application/eval`'s trial
 * runner; its Worker is closed in:
 *
 *   - **its Handle** is minted with `get_task`, `list_allowed_operations`, `observe_operation`,
 *     `request_action` and `report_task_result` only, and the gateway refuses anything else for its
 *     session again (`EVALUATION_SESSION_CAPABILITIES`), whatever the Handle says;
 *   - **its own Task only** — the evaluation service Principal every evaluation Task acts for would
 *     otherwise let one trial's Worker read another's Task;
 *   - **every gate call is answered from the case's fixtures** (`answerFixtureCall`), recorded on
 *     the trial, never sent to a gate — and audited under an action of its own
 *     (`FIXTURE_CALL_AUDIT_ACTION`), so no gate's call counts include it; its tool list is the
 *     suite's fixture gates as frozen (`listFixtureOperations`);
 *   - **its report** completes the Task and writes nothing else (`reportEvaluationResult`);
 *   - its container's egress is denied (worker-supervisor `egressDenyAll`, set at spawn).
 *
 * This module reads the evaluation tables `application/eval` owns (`eval_runs`, `eval_trials`,
 * `eval_cases`, `eval_fixture_gates`) and writes one (`eval_trial_calls`), for the Handle side only,
 * and returns nothing of a case but what its Worker is given: the input (through `get_task`), the
 * tool list and the answers. `.dependency-cruiser.cjs` lets only the gateway's
 * `evaluation-session.ts` import it.
 */
export {
  type FixtureCall,
  type FixtureCallOutcome,
  type FixtureCallRefusal,
  FIXTURE_FAILURE_CODE,
  FIXTURE_UNANSWERED_MESSAGE,
  answerFixtureCall,
  listFixtureOperations,
} from './fixtures.js';
export { type EvaluationReportOutcome, reportEvaluationResult } from './report.js';
export {
  EVALUATION_SESSION_CAPABILITIES,
  type EvaluationSession,
  FIXTURE_CALL_AUDIT_ACTION,
  FIXTURE_CALL_CAPABILITIES,
  evaluationSealAllowance,
  readEvaluationSession,
} from './session.js';
