/**
 * application/eval: evaluation (S10 E3; docs/s10-evolution-plan-2026-10-04.md §3.1 EvalSuite /
 * EvalRun, §3.3 I-E1–I-E4, §5.5, §5.6). E3-1a delivers an evaluation suite's shell
 * (`suites.ts`): the published WorkerDefinition version it pins, its canary, its fixture gates —
 * real gates' names and published Operations frozen into it (`snapshot.ts`) — and its versioned
 * history. Cases (E3-1b), runs (E3-2) and verdicts (E3-3) come later.
 *
 * It owns `eval_suites`, `eval_suite_changes` and `eval_fixture_gates` (migrations/worker/0007 —
 * in the `worker` migration module only because they reference `worker_definitions` and modules
 * run in directory order) and exposes only this interface.
 *
 * Closed to agents (I-E4 "评测对人透明、对 agent 封闭"): nothing here is written to the graph, so
 * `search` / `explain` never reach it, and its capabilities are human-channel, made for a person
 * (`actsForPerson`) and in HUMAN_ONLY_CAPABILITY_NAMES. `.dependency-cruiser.cjs` lets only the
 * gateway's `eval-handlers.ts` import this module, so no Handle-channel handler can read a suite by
 * accident (§5.5 "纵深防御").
 */
export {
  EvalSuiteInputError,
  EvalSuiteNameTakenError,
  EvalSuiteNotFoundError,
  EvalSuiteStateError,
} from './errors.js';
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
