import {
  ACTION_REQUEST_TRANSITIONS,
  type ActionRequestEvent,
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

/**
 * Idempotent: a repeat call with the same `idempotencyKey` returns the existing row unchanged — no
 * new insert, no new audit/outbox writes (a true no-op replay, not merely "the same resulting
 * state"). I18 quota checks (§8.1 "policy + 配额(I18)") are S2.7 scope, not performed here.
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

  const result = await client.query<ActionRequestDbRow>(
    `insert into action_requests (
       workspace_id, status, gatekeeper_id, action_kind, resource_scope, blast_radius,
       policy_decision, await_decision, on_behalf_of, parent_worker_run_id, actor_runtime,
       idempotency_key
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     returning ${ACTION_REQUEST_ROW_COLUMNS}`,
    [
      workspaceId,
      finalStatus,
      input.gatekeeperId,
      input.actionKind,
      input.resourceScope ?? null,
      input.blastRadius,
      evaluation.decision,
      input.awaitDecision,
      input.onBehalfOf,
      input.parentWorkerRunId ?? null,
      input.actorRuntime,
      input.idempotencyKey ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('requestAction: INSERT ... RETURNING produced no row');
  const mapped = mapActionRequestRow(row);

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
