/**
 * application/eval: evaluation (S10 E3; docs/s10-evolution-plan-2026-10-04.md §3.1 EvalSuite /
 * EvalRun, §3.3 I-E1–I-E4, §5.5, §5.6). E3-1a delivers an evaluation suite's shell
 * (`suites.ts`): the published WorkerDefinition version it pins, its canary, its fixture gates —
 * real gates' names and published Operations frozen into it (`snapshot.ts`) — and its versioned
 * history — and its cases (E3-1b, `cases.ts`, `case-reads.ts`): what an evaluated Worker is given,
 * how its calls are answered and what makes it pass. E3-2a adds runs (`runs.ts`): a case tried
 * once as an evaluation Task acting for the workspace's evaluation Principal (`principal.ts`),
 * under a monthly evaluation budget (`budget.ts`), scored once its Task ends (`runner.ts`); the
 * trial's Worker itself is served by `application/eval-session`. Draft runs (E3-2b) and verdicts
 * (E3-3) come later.
 *
 * It owns `eval_suites`, `eval_suite_changes`, `eval_fixture_gates` (migrations/worker/0007 —
 * in the `worker` migration module only because they reference `worker_definitions` and modules
 * run in directory order), `eval_cases` (worker/0008) and `eval_runs` / `eval_trials`
 * (worker/0009; `eval_trial_calls` is eval-session's), and exposes only this interface.
 *
 * Closed to agents (I-E4 "评测对人透明、对 agent 封闭"): nothing here is written to the graph, so
 * `search` / `explain` never reach it, and its capabilities are human-channel, made for a person
 * (`actsForPerson`) and in HUMAN_ONLY_CAPABILITY_NAMES. `.dependency-cruiser.cjs` lets only the
 * gateway's `eval-handlers.ts` (and the composition root, for the runner's tick) import this
 * module, so no Handle-channel handler can read a suite by accident (§5.5 "纵深防御").
 */
export type { EvalBudget } from './budget.js';
export { evalBudgetWire, readEvalBudget } from './budget.js';
export type { EvalCaseTarget } from './cases.js';
export { addEvalCase, editEvalCase, getEvalCase, retireEvalCase } from './cases.js';
export {
  EvalCaseNotFoundError,
  EvalFixtureGateInUseError,
  EvalRunNotFoundError,
  EvalSuiteInputError,
  EvalSuiteNameTakenError,
  EvalSuiteNotFoundError,
  EvalSuiteStateError,
  EvaluationBudgetExhaustedError,
} from './errors.js';
export { EVALUATION_PRINCIPAL_DISPLAY_NAME } from './principal.js';
export type { EvalTrialTickOptions } from './runner.js';
export { EVALUATION_TRIAL_END_ACTION, runEvalTrialTick } from './runner.js';
export type { CaseTrialTarget, StartedCaseTrial } from './runs.js';
export { getEvalRun, listEvalRuns, startCaseTrial, startCaseTrialTask } from './runs.js';
export type {
  CreateEvalSuiteInput,
  EvalSuiteActor,
  EvalSuiteChangeTarget,
  FixtureGateTarget,
} from './suites.js';
export {
  addEvalFixtureGate,
  createEvalSuite,
  getEvalSuite,
  listEvalSuites,
  removeEvalFixtureGate,
  repinEvalSuite,
  syncEvalFixtureGate,
} from './suites.js';
