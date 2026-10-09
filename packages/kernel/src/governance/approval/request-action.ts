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
import { evaluate, readEffectivePolicy, toPolicyEvaluationInput } from '../policy/index.js';
import { countSuspectedSecrets } from '../redaction/index.js';
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
 * Idempotency window (2026-10-02 review R-53, maintainer decision D-12): a key the caller did not
 * supply — `application/gateway/action-executor.ts`'s `deriveDefaultIdempotencyKey`, prefixed
 * `auto:` — dedupes only against a row that is still in flight (`IN_FLIGHT_ACTION_REQUEST_STATUSES`).
 * Once that row is terminal, a repeat is a new intent and gets a new row: a retry after `failed`,
 * `rejected` or `expired` is evaluated again, and a legitimate repeat (restart, check, restart)
 * applies again instead of replaying the first `executed` result. Any other key is explicit (the
 * caller's own `idempotencyKey`, scoped by `scopeExplicitIdempotencyKey`) and keeps its original
 * meaning: one row per key, whatever its status. migrations/governance/
 * 0014_action_request_idempotency_window.sql holds the two matching partial unique indexes.
 *
 * Idempotency race (I6/I11 concurrency hardening): the check-first read above is not itself the
 * enforcement mechanism — two concurrent `requestAction` calls sharing one `idempotencyKey` can
 * both see "no existing row" and both attempt to INSERT. The partial unique indexes
 * (`action_requests_idempotency_key_uidx` for explicit keys,
 * `action_requests_derived_idempotency_key_inflight_uidx` for derived ones) are what actually
 * prevent two rows: Postgres detects the conflict at INSERT time — the second inserter
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
  /** P-B1: see `PolicyEvaluationInput.mcpTrustBlocked`. */
  readonly mcpTrustBlocked?: boolean;
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
  /** S3.13 / D-16: the requester's resolved `effective.autoApproveLow`, threaded straight through
   *  to `evaluate()`'s own field of the same name — see that module's doc comment. Omitted (the
   *  default, `true` inside `evaluate()`) never narrows. */
  readonly principalAutoApproveLowEnabled?: boolean;
}

const RESOLUTION_EVENT_BY_DECISION: Record<PolicyDecision, ActionRequestEvent> = {
  allow: 'auto_approve',
  require_approval: 'require_approval',
  deny: 'deny',
};

/** D-12: the prefix `application/gateway/action-executor.ts`'s `deriveDefaultIdempotencyKey` puts
 *  on a key the caller did not supply. Must match the `like 'auto:%'` predicates in
 *  migrations/governance/0014_action_request_idempotency_window.sql. */
export const DERIVED_IDEMPOTENCY_KEY_PREFIX = 'auto:';

/** D-12: the statuses a derived key still dedupes against — the non-terminal states of
 *  `ACTION_REQUEST_TRANSITIONS` (`executed` counts as terminal: the operation has run, even though
 *  `verify` can follow). Must match governance 0014's in-flight index predicate. */
export const IN_FLIGHT_ACTION_REQUEST_STATUSES: readonly ActionRequestStatus[] = [
  'proposed',
  'policy_evaluated',
  'auto_approved',
  'pending_approval',
  'approved',
  'executing',
];

const IDEMPOTENCY_KEY_CONSTRAINTS: ReadonlySet<string> = new Set([
  'action_requests_idempotency_key_uidx',
  'action_requests_derived_idempotency_key_inflight_uidx',
]);

/** Same detection pattern `application/chat/service.ts` already uses for its own partial-unique-
 *  index race (`activities_one_running_turn_per_chat_uidx`) — matches on both SQLSTATE 23505 and
 *  the specific constraint name, so an unrelated unique violation is never misread as this race. */
function isIdempotencyKeyConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { code?: unknown; constraint?: unknown };
  return (
    candidate.code === '23505' &&
    typeof candidate.constraint === 'string' &&
    IDEMPOTENCY_KEY_CONSTRAINTS.has(candidate.constraint)
  );
}

/**
 * The row a call with `idempotencyKey` replays, if any. An explicit key matches its one row in any
 * status (unchanged). A derived key matches only an in-flight row (D-12) — except after losing the
 * INSERT race (`afterConflict`): the unique violation proves a concurrent in-flight row with this
 * key existed a moment ago, so the newest row with the key is the one this call collapses onto,
 * even if the winner has gone terminal since.
 */
async function findReplayableActionRequest(
  client: PoolClient,
  workspaceId: string,
  idempotencyKey: string,
  options: { readonly afterConflict: boolean },
): Promise<ActionRequestRow | null> {
  if (!idempotencyKey.startsWith(DERIVED_IDEMPOTENCY_KEY_PREFIX)) {
    return findActionRequestByIdempotencyKey(client, workspaceId, idempotencyKey);
  }
  const result = options.afterConflict
    ? await client.query<ActionRequestDbRow>(
        `select ${ACTION_REQUEST_ROW_COLUMNS} from action_requests
         where workspace_id = $1 and idempotency_key = $2
         order by requested_at desc, id desc
         limit 1`,
        [workspaceId, idempotencyKey],
      )
    : await client.query<ActionRequestDbRow>(
        `select ${ACTION_REQUEST_ROW_COLUMNS} from action_requests
         where workspace_id = $1 and idempotency_key = $2 and status = any($3::text[])
         limit 1`,
        [workspaceId, idempotencyKey, IN_FLIGHT_ACTION_REQUEST_STATUSES],
      );
  const row = result.rows[0];
  return row ? mapActionRequestRow(row) : null;
}

async function insertActionRequestRow(
  client: PoolClient,
  workspaceId: string,
  input: RequestActionInput,
  finalStatus: ActionRequestStatus,
  policyDecision: PolicyDecision,
  requesterCanApprove: boolean,
): Promise<ActionRequestRow> {
  const result = await client.query<ActionRequestDbRow>(
    `insert into action_requests (
       workspace_id, status, gatekeeper_id, action_kind, resource_scope, blast_radius,
       policy_decision, await_decision, on_behalf_of, parent_worker_run_id, actor_runtime,
       idempotency_key, params, requester_can_approve
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)
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
      requesterCanApprove,
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
 * violation (concurrent callers — see this module's own doc comment). For a derived key that holds
 * only while the existing row is in flight (D-12, this module's own doc comment). I18 quota checks
 * (§8.1 "policy + 配额(I18)") are S2.7 scope, not performed here.
 */
export async function requestAction(
  client: PoolClient,
  workspaceId: string,
  input: RequestActionInput,
): Promise<ActionRequestRow> {
  if (input.idempotencyKey) {
    const existing = await findReplayableActionRequest(client, workspaceId, input.idempotencyKey, {
      afterConflict: false,
    });
    if (existing) return existing;
  }

  // R-20 / D-15: the rule for this gate's action kind, else the workspace-wide one.
  const policyRow = await readEffectivePolicy(
    client,
    workspaceId,
    input.gatekeeperId,
    input.actionKind,
  );
  const evaluation = evaluate({
    gatekeeperId: input.gatekeeperId,
    blastRadius: input.blastRadius,
    operationAutoApprovable: input.operationAutoApprovable,
    mcpTrustBlocked: input.mcpTrustBlocked,
    paramsCarrySuspectedSecrets:
      countSuspectedSecrets(input.params ?? {}, { secretFields: true }) > 0,
    workspacePolicy: policyRow ? toPolicyEvaluationInput(policyRow) : undefined,
    requesterScope: input.requesterScope,
    principalAutoApproveLowEnabled: input.principalAutoApproveLowEnabled,
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
        evaluation.requesterCanApprove,
      );
      await client.query('RELEASE SAVEPOINT request_action_insert');
    } catch (err) {
      if (!isIdempotencyKeyConflict(err)) throw err;
      await client.query('ROLLBACK TO SAVEPOINT request_action_insert');
      const existing = await findReplayableActionRequest(
        client,
        workspaceId,
        input.idempotencyKey,
        { afterConflict: true },
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
      evaluation.requesterCanApprove,
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
