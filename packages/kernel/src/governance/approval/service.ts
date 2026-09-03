/**
 * governance/approval/service: the ActionRequest state machine's public service surface (design
 * doc §5.1.4 ActionRequest, §5.4 I6/I7/I11/I13/I14, §5.5, §8.1/§8.2, §8.5; docs/development-
 * tasks.md S2.3). A thin barrel over this module's split-out files (design doc §7.10 file-size
 * guidance, "单文件 ≤ 600 行...超过即拆，不等重构") — every actual implementation lives in:
 *
 *   - `types.ts`      — `ActionRequestRow`, the DB-row mapper, `ActionRequestNotFoundError`/
 *                        `ApprovalScopeError`/`ActionRequestConcurrentTransitionError` (I6/I11
 *                        concurrency hardening — a subclass of `@nexttime/shared`'s
 *                        `IllegalTransition`).
 *   - `reads.ts`       — `getActionRequest`/`getActionRequestOrThrow` (lock-free),
 *                        `getActionRequestForUpdate`/`getActionRequestForUpdateOrThrow`
 *                        (`SELECT ... FOR UPDATE` — every governed mutator uses these, never the
 *                        lock-free pair), `listPendingForApprover` (I14), `listExecutableQueue`
 *                        (drainer.ts's lock-free queue read), `approverHasScope` (I14 precheck).
 *   - `status-transition.ts` — `updateActionRequestStatusConditional`: the one conditional
 *                        `UPDATE ... WHERE status = $expected` every governed mutator uses to
 *                        actually change `status` — the correctness guarantee behind the locking
 *                        above (see that file's own doc comment).
 *   - `transition-log.ts` — `recordTransition`: the shared "write AuditRecord + outbox event for
 *                        one transition" helper (I11) every mutator below calls.
 *   - `request-action.ts` — `requestAction`: create + immediately resolve through the Policy
 *                        engine (`governance/policy`).
 *   - `decide.ts`      — `approveActionRequest`/`rejectActionRequest`: I14 precheck, the governed
 *                        transition, and the Approval Decision write (I7 amendment, PR #33).
 *   - `execution.ts`   — `expireActionRequest`/`expireOverduePendingApprovals` (reaper),
 *                        `startActionRequestExecution`/`markActionRequestExecuted`/
 *                        `markActionRequestFailed`/`compensateActionRequest` (called by
 *                        `drainer.ts` and, eventually, S2.4's real Gatekeeper execution path).
 *   - `await-decision.ts` — `awaitActionRequestResolution`: the `await_decision=true`
 *                        wait-until-timeout primitive (§8.2), decoupled from the DB/pool so it is
 *                        unit-testable with no Postgres and no real timers.
 *
 * Every function takes an already-open `PoolClient` (same convention as
 * `governance/capability/handles.ts`/`governance/llm-usage/service.ts`) except
 * `expireOverduePendingApprovals`, which opens its own short-lived per-row transactions (a
 * cross-workspace reaper scan, like `application/outbox/dispatcher.ts` and
 * `application/chat/recovery.ts`'s `interruptStaleRunningTurns`).
 */

export {
  ActionRequestConcurrentTransitionError,
  ActionRequestNotFoundError,
  ApprovalScopeError,
  type ActionRequestRow,
} from './types.js';

export {
  approverHasScope,
  getActionRequest,
  getActionRequestForUpdate,
  getActionRequestForUpdateOrThrow,
  getActionRequestOrThrow,
  listExecutableQueue,
  listPendingForApprover,
} from './reads.js';

export {
  type UpdateActionRequestStatusInput,
  updateActionRequestStatusConditional,
} from './status-transition.js';

export { type RecordTransitionParams, recordTransition } from './transition-log.js';

export { type RequestActionInput, requestAction } from './request-action.js';

export {
  type DecideActionRequestInput,
  approveActionRequest,
  rejectActionRequest,
} from './decide.js';

export {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  type ActionRequestActorOptions,
  type ExpireOverdueOptions,
  type MarkExecutedOptions,
  type MarkFailedOptions,
  type MinimalPool,
  compensateActionRequest,
  expireActionRequest,
  expireOverduePendingApprovals,
  markActionRequestExecuted,
  markActionRequestFailed,
  startActionRequestExecution,
} from './execution.js';

export {
  type AwaitActionRequestResolutionOptions,
  awaitActionRequestResolution,
} from './await-decision.js';
