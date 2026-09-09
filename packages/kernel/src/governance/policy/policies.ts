import { type BlastRadius, BlastRadiusSchema } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { assertPolicyWriteAllowed } from './engine.js';

/**
 * governance/policy/policies: reads and writes the workspace's `policies` table
 * (migrations/governance/0002_policy.sql) — the DB-touching half of the `policy` module, kept
 * separate from `engine.ts`'s pure `evaluate()` (design doc §7.10 layering note: `engine.ts`
 * itself does no IO). `governance/approval/service.ts` (sibling governance module) calls
 * `readWorkspacePolicy` through this module's public interface (`index.ts`) to resolve
 * `request_action`'s policy-engine input; the `set_policy`/`set_auto_approved_action_kind`
 * capabilities' handlers (application/gateway/handlers.ts) call `setPolicy`/
 * `setAutoApprovedActionKind`.
 */

export interface PolicyRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly actionKind: string;
  readonly blastRadius: BlastRadius | null;
  readonly autoApprove: boolean;
  readonly requesterCanApprove: boolean | null;
  readonly setBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface PolicyDbRow {
  workspace_id: string;
  id: string;
  action_kind: string;
  blast_radius: BlastRadius | null;
  auto_approve: boolean;
  requester_can_approve: boolean | null;
  set_by: string;
  created_at: Date;
  updated_at: Date;
}

function mapPolicyRow(row: PolicyDbRow): PolicyRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    actionKind: row.action_kind,
    blastRadius: row.blast_radius,
    autoApprove: row.auto_approve,
    requesterCanApprove: row.requester_can_approve,
    setBy: row.set_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const POLICY_COLUMNS =
  'workspace_id, id, action_kind, blast_radius, auto_approve, requester_can_approve, set_by, created_at, updated_at';

/** Reads the workspace's `policies` row for `actionKind`, or `null` if none exists ("use the
 *  compiled-in default" — engine.ts's own `effectiveWorkspaceAutoApprove`/`resolveRequesterCanApprove`). */
export async function readWorkspacePolicy(
  client: PoolClient,
  workspaceId: string,
  actionKind: string,
): Promise<PolicyRow | null> {
  const result = await client.query<PolicyDbRow>(
    `select ${POLICY_COLUMNS} from policies where workspace_id = $1 and action_kind = $2`,
    [workspaceId, actionKind],
  );
  const row = result.rows[0];
  return row ? mapPolicyRow(row) : null;
}

/** `list_policies` (S3.11, docs/development-tasks.md "中台控制面"): every explicit `policies` row
 *  the workspace has ever `set_policy`'d, most recently updated first — an action_kind with no row
 *  here is simply absent (it is running on the compiled-in default, `engine.ts`'s own concern, not
 *  this read's). */
export async function listPolicies(
  client: PoolClient,
  workspaceId: string,
): Promise<readonly PolicyRow[]> {
  const result = await client.query<PolicyDbRow>(
    `select ${POLICY_COLUMNS} from policies where workspace_id = $1 order by updated_at desc`,
    [workspaceId],
  );
  return result.rows.map(mapPolicyRow);
}

// -------------------------------------------------------------------------------------------
// set_policy — packages/shared/src/capabilities.ts governance group, `paramsSchema: {policy:
// jsonRecord}`. The wire payload's shape (validated here, not in the shared registry, since it is
// this module's own business-level structure, not a generic JSON blob at every layer).
// -------------------------------------------------------------------------------------------

// S3.7 wire fix (docs/wire-contract-conventions.md §1, 2026-09-08 decision — "不得把裸字符串叫
// actionKind"; found by this task's own vocabulary guard, scripts/guards/vocabulary.mjs, on its
// first run): the wire-facing field is `actionKindTag` (a bare action-kind tag string), not
// `actionKind` — that word is reserved for the ActionDescription `{tag,label}` display object.
// `SetPolicyInput` below (this module's own internal parameter shape, matches the
// `policies.action_kind` DB column and every other governance/policy|approval internal type) is
// deliberately *not* derived from this schema anymore, so this rename does not ripple through
// this module's own SQL/engine calls.
export const SetPolicyPayloadSchema = z
  .object({
    actionKindTag: z.string().min(1),
    blastRadius: BlastRadiusSchema.optional(),
    autoApprove: z.boolean(),
    requesterCanApprove: z.boolean().optional(),
  })
  .strict();
export type SetPolicyPayload = z.infer<typeof SetPolicyPayloadSchema>;

/** Thrown by `parseSetPolicyPayload` when `set_policy`'s opaque `policy: jsonRecord` payload does
 *  not match `SetPolicyPayloadSchema`. Declared here (not reused from `application/gateway/
 *  dispatch.ts`'s `InvalidCapabilityParamsError`) to avoid a circular import — `application/
 *  gateway/handlers.ts` calls this module, and `dispatch.ts` calls `handlers.ts`; governance may
 *  not depend on application either way (§7.10). `interfaces/http/capability-route.ts` maps this
 *  to the same HTTP 400 `invalid_params` shape as `InvalidCapabilityParamsError`. */
export class SetPolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetPolicyValidationError';
  }
}

/** Validates `set_policy`'s raw `policy` payload against `SetPolicyPayloadSchema`, throwing
 *  `SetPolicyValidationError` (not a raw `ZodError`) on failure. */
export function parseSetPolicyPayload(raw: unknown): SetPolicyPayload {
  const parsed = SetPolicyPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SetPolicyValidationError(`invalid set_policy payload: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** This module's own internal parameter shape for `setPolicy` — deliberately independent of
 *  `SetPolicyPayload` above (see that type's own doc comment): `actionKind` here matches the
 *  `policies.action_kind` DB column, the name every other governance/policy|approval internal
 *  type already uses for this same value. */
export interface SetPolicyInput {
  readonly actionKind: string;
  readonly blastRadius?: BlastRadius;
  readonly autoApprove: boolean;
  readonly requesterCanApprove?: boolean;
  readonly setBy: string;
}

/**
 * Upserts a `policies` row (§9.3 `set_policy`, owner-only human channel). Rejects (before touching
 * the DB — `assertPolicyWriteAllowed`, engine.ts) an attempt to set `autoApprove: true` at
 * `blastRadius: 'high'` (I8 "工作区不能关闭"); the DB CHECK on `policies.auto_approve` is the
 * second, independent enforcement of the same rule (migrations/governance/0002_policy.sql).
 *
 * A repeat call for the same `(workspaceId, actionKind)` replaces the row's tunable columns
 * (`blastRadius`/`autoApprove`/`requesterCanApprove`) — `set_policy` is configuration, not an
 * append-only governed record (see that migration's own "delete is granted" comment, same
 * reasoning extends to update-in-place).
 */
export async function setPolicy(
  client: PoolClient,
  workspaceId: string,
  input: SetPolicyInput,
): Promise<PolicyRow> {
  assertPolicyWriteAllowed({
    actionKind: input.actionKind,
    blastRadius: input.blastRadius,
    autoApprove: input.autoApprove,
  });

  const result = await client.query<PolicyDbRow>(
    `insert into policies (workspace_id, action_kind, blast_radius, auto_approve, requester_can_approve, set_by)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (workspace_id, action_kind) do update
       set blast_radius = excluded.blast_radius,
           auto_approve = excluded.auto_approve,
           requester_can_approve = excluded.requester_can_approve,
           set_by = excluded.set_by,
           updated_at = now()
     returning ${POLICY_COLUMNS}`,
    [
      workspaceId,
      input.actionKind,
      input.blastRadius ?? null,
      input.autoApprove,
      input.requesterCanApprove ?? null,
      input.setBy,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('setPolicy: INSERT ... RETURNING produced no row');
  return mapPolicyRow(row);
}

// -------------------------------------------------------------------------------------------
// set_auto_approved_action_kind — "总是批准此类" (§9.3, design doc S2.10 card action). paramsSchema
// is `{actionKind: z.string()}` only, no blastRadius — see this module's own doc comment / this
// task's PR body "已知偏离" for why the high-blast-radius guard can only fire here when a prior
// `set_policy` call already recorded this action_kind's `blast_radius` (S2.6's graph-stored
// Operation metadata, the only other source of truth for an action_kind's blast_radius, does not
// exist yet — this handler cannot look it up).
// -------------------------------------------------------------------------------------------

export interface SetAutoApprovedActionKindInput {
  readonly actionKind: string;
  readonly setBy: string;
}

export async function setAutoApprovedActionKind(
  client: PoolClient,
  workspaceId: string,
  input: SetAutoApprovedActionKindInput,
): Promise<PolicyRow> {
  const existing = await readWorkspacePolicy(client, workspaceId, input.actionKind);
  return setPolicy(client, workspaceId, {
    actionKind: input.actionKind,
    blastRadius: existing?.blastRadius ?? undefined,
    autoApprove: true,
    requesterCanApprove: existing?.requesterCanApprove ?? undefined,
    setBy: input.setBy,
  });
}
