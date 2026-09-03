import {
  ACTION_REQUEST_TRANSITIONS,
  type ActionRequestEvent,
  type ActionRequestStatus,
  type BlastRadius,
  type CapabilityScope,
  type PolicyDecision,
  transition,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { evaluate, readWorkspacePolicy } from '../policy/index.js';
import { findActionRequestByIdempotencyKey } from './reads.js';
import { recordTransition } from './transition-log.js';
import {
  ACTION_REQUEST_ROW_COLUMNS,
  type ActionRequestDbRow,
  type ActionRequestRow,
  mapActionRequestRow,
} from './types.js';

/**
 * governance/approval/request-action: `request_action` (design doc §5.1.4, §8.1; docs/
 * development-tasks.md S2.3) — creates an ActionRequest and immediately resolves it through the
 * Policy engine (`governance/policy`).
 *
 * Transition persistence (I6, "ActionRequest 只沿转移表走"): validates the full
 * `proposed → policy_evaluated → {auto_approved|pending_approval|denied}` hop sequence against
 * `ACTION_REQUEST_TRANSITIONS` before writing anything, but persists the row with a single INSERT
 * already at its resolved status — `proposed`/`policy_evaluated` are real, representable states
 * (the DB schema allows a row to stop at either, migrations/governance/0003_action_requests.sql's
 * own header comment) but are never externally observable mid-resolution within one atomic
 * `request_action` call (no other transaction can see the row before this one commits), so
 * persisting them as separate durable rows would add write volume without adding information.
 *
 * Idempotency race (I6/I11 concurrency hardening): the check-first read above is not itself the
 * enforcement mechanism — two concurrent `requestAction` calls sharing one `idempotencyKey` can
 * both see "no existing row" and both attempt to INSERT. The partial unique index
 * `action_requests_idempotency_key_uidx` (migrations/governance/0003_action_requests.sql) is what
 * actually prevents two rows: Postgres detects the conflict at INSERT time — the second inserter
 * blocks until the first commits or rolls back, then either proceeds (rollback) or raises
 * SQLSTATE 23505 (commit) — and 23505 aborts the rest of the *whole* transaction unless the failed
 * statement was wrapped in its own `SAVEPOINT`. So the INSERT below always runs inside one: on a
 * unique-violation on that specific index, roll back to the savepoint (restoring the caller's
 * transaction to a usable state — this function never opens its own `withWorkspace`, so leaving
 * the transaction poisoned would break every write the *caller* still has queued after this call)
 * and return the winner's row, honoring the same "a repeat call returns the existing row, no new
 * audit/outbox writes" contract as the fast-path check above.
 */

export interface RequestActionInput {
  readonly gatekeeperId: string;
  readonly actionKind: string;
  readonly resourceScope?: string;
  readonly blastRadius: BlastRadius;
  /** The invoked Operation's own declared `auto_approvable` (I8 signal 1) — resolved by the
   *  caller (S2.4's Gatekeeper client, once it exists); `false` also represents "unclassified" per
   *  I17 (see `governance/policy/engine.ts`'s own doc comment). */
  readonly operationAutoApprovable: boolean;
  readonly awaitDecision: boolean;
  readonly onBehalfOf: string;
  readonly actorRuntime: string;
  readonly idempotencyKey?: string;
  readonly parentWorkerRunId?: string;
  /** The Operation call's own arguments — persisted so `ActionExecutor.execute()` can `apply` them
   *  later, possibly in a different transaction/process (S2.4, migrations/governance/
   *  0004_action_request_params.sql). Defaults to `{}`. */
  readonly params?: Record<string, unknown>;
  /** The requesting Handle's scope — `policy/engine.ts`'s coverage/`deny` check reads
   *  `resources['gatekeeper']` from this (see that module's `GATEKEEPER_RESOURCE_SCOPE_KEY` doc
   *  comment for the exact convention). */
  readonly requesterScope: CapabilityScope;
}

const RESOLUTION_EVENT_BY_DECISION: Record<PolicyDecision, ActionRequestEvent> = {
  allow: 'auto_approve',
  require_approval: 'require_approval',
  deny: 'deny',
};

const IDEMPOTENCY_KEY_CONSTRAINT = 'action_requests_idempotency_key_uidx';

/** Same detection pattern `application/chat/service.ts` already uses for its own partial-unique-
 *  index race (`activities_one_running_turn_per_chat_uidx`) — matches on both SQLSTATE 23505 and
 *  the specific constraint name, so an unrelated unique violation is never misread as this race. */
function isIdempotencyKeyConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { code?: unknown; constraint?: unknown };
  return candidate.code === '23505' && candidate.constraint === IDEMPOTENCY_KEY_CONSTRAINT;
}

async function insertActionRequestRow(
  client: PoolClient,
  workspaceId: string,
  input: RequestActionInput,
  finalStatus: ActionRequestStatus,
  policyDecision: PolicyDecision,
): Promise<ActionRequestRow> {
  const result = await client.query<ActionRequestDbRow>(
    `insert into action_requests (
       workspace_id, status, gatekeeper_id, action_kind, resource_scope, blast_radius,
       policy_decision, await_decision, on_behalf_of, parent_worker_run_id, actor_runtime,
       idempotency_key, params
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
     returning ${ACTION_REQUEST_ROW_COLUMNS}`,
    [
      workspaceId,
      finalStatus,
      input.gatekeeperId,
      input.actionKind,
      input.resourceScope ?? null,
      input.blastRadius,
      policyDecision,
      input.awaitDecision,
      input.onBehalfOf,
      input.parentWorkerRunId ?? null,
      input.actorRuntime,
      input.idempotencyKey ?? null,
      JSON.stringify(input.params ?? {}),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('requestAction: INSERT ... RETURNING produced no row');
  return mapActionRequestRow(row);
}

/**
 * Idempotent: a repeat call with the same `idempotencyKey` returns the existing row unchanged — no
 * new insert, no new audit/outbox writes (a true no-op replay, not merely "the same resulting
 * state"), whether the duplicate is detected by the fast-path read or by the INSERT's own unique
 * violation (concurrent callers — see this module's own doc comment). I18 quota checks (§8.1
 * "policy + 配额(I18)") are S2.7 scope, not performed here.
 */
export async function requestAction(
  client: PoolClient,
  workspaceId: string,
  input: RequestActionInput,
): Promise<ActionRequestRow> {
  if (input.idempotencyKey) {
    const existing = await findActionRequestByIdempotencyKey(
      client,
      workspaceId,
      input.idempotencyKey,
    );
    if (existing) return existing;
  }

  const workspacePolicyRow = await readWorkspacePolicy(client, workspaceId, input.actionKind);
  const evaluation = evaluate({
    gatekeeperId: input.gatekeeperId,
    blastRadius: input.blastRadius,
    operationAutoApprovable: input.operationAutoApprovable,
    workspacePolicy: workspacePolicyRow
      ? {
          autoApprove: workspacePolicyRow.autoApprove,
          requesterCanApprove: workspacePolicyRow.requesterCanApprove,
        }
      : undefined,
    requesterScope: input.requesterScope,
  });

  // I6: validate the full hop sequence against the shared transition table before writing
  // anything. `transition()` throws IllegalTransition if either edge is missing — it never is,
  // for any PolicyDecision, but this keeps the state machine authoritative rather than this
  // function's own lookup table.
  transition(ACTION_REQUEST_TRANSITIONS, 'proposed', 'evaluate_policy');
  const finalStatus = transition(
    ACTION_REQUEST_TRANSITIONS,
    'policy_evaluated',
    RESOLUTION_EVENT_BY_DECISION[evaluation.decision],
  );

  let mapped: ActionRequestRow;
  if (input.idempotencyKey) {
    await client.query('SAVEPOINT request_action_insert');
    try {
      mapped = await insertActionRequestRow(
        client,
        workspaceId,
        input,
        finalStatus,
        evaluation.decision,
      );
      await client.query('RELEASE SAVEPOINT request_action_insert');
    } catch (err) {
      if (!isIdempotencyKeyConflict(err)) throw err;
      await client.query('ROLLBACK TO SAVEPOINT request_action_insert');
      const existing = await findActionRequestByIdempotencyKey(
        client,
        workspaceId,
        input.idempotencyKey,
      );
      // The unique violation means a row with this key exists (or existed a moment ago, within
      // the same still-committed transaction) — not finding it now would mean the winner rolled
      // back after all, which contradicts a *committed* conflicting row ever having existed. Fail
      // loudly rather than silently swallowing that impossible case.
      if (!existing) throw err;
      return existing;
    }
  } else {
    mapped = await insertActionRequestRow(
      client,
      workspaceId,
      input,
      finalStatus,
      evaluation.decision,
    );
  }

  await recordTransition(client, workspaceId, {
    actorPrincipalId: input.onBehalfOf,
    action: 'action_request.request',
    actionRequestId: mapped.id,
    resultingStatus: finalStatus,
    pendingApprovalFanout: {
      gatekeeperId: input.gatekeeperId,
      actionKind: input.actionKind,
      resourceScope: input.resourceScope ?? null,
    },
  });

  return mapped;
}
