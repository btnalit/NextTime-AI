import { type BlastRadius, BlastRadiusSchema } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { type WorkspacePolicyInput, assertPolicyWriteAllowed } from './engine.js';

/**
 * governance/policy/policies: reads and writes the workspace's policy rules — the DB-touching half
 * of the `policy` module, kept separate from `engine.ts`'s pure `evaluate()` (design doc §7.10
 * layering note: `engine.ts` itself does no IO). Two tables hold the same row shape:
 *
 *   - `gatekeeper_policies` (migrations/governance/0016_auto_approval_scope.sql) — a rule for one
 *     `(gatekeeper, action_kind)`. "Always allow" (`set_auto_approved_action_kind`) writes only
 *     here (R-20 / D-15: the approver saw one gate, and Operation names collide across gates);
 *     `set_policy` writes here when it names a gate.
 *   - `policies` (migrations/governance/0002_policy.sql) — a workspace-wide rule for an
 *     `action_kind` on every gate. Since D-15 it can only narrow: `setPolicy` refuses to turn
 *     auto-approval on without a gate, and `engine.ts` ignores a workspace-wide
 *     `autoApprove: true` (`WorkspacePolicyInput.scope`).
 *
 * `governance/approval/request-action.ts` (sibling governance module) calls `readEffectivePolicy`
 * through this module's public interface (`index.ts`) to resolve `request_action`'s policy-engine
 * input; the `set_policy` / `set_auto_approved_action_kind` / `list_policies` handlers
 * (application/gateway/handlers.ts) call `setPolicy` / `setAutoApprovedActionKind` / `listPolicies`.
 */

export interface PolicyRow {
  readonly workspaceId: string;
  readonly id: string;
  /** The Gatekeeper a gate-scoped rule (`gatekeeper_policies`) applies to; `null` for a
   *  workspace-wide `policies` row (every gate). */
  readonly gatekeeperId: string | null;
  readonly actionKind: string;
  readonly blastRadius: BlastRadius | null;
  readonly autoApprove: boolean;
  readonly requesterCanApprove: boolean | null;
  readonly setBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Legacy 218 (migrations/governance/0020): for a gate-scoped rule that turns auto-approval on,
   *  the definition it allows — the digest a gate checks on every call, as an ActionRequest
   *  records it (`operationDigest`) — and the published version that was. `null` on a
   *  workspace-wide row, on a rule that does not auto-approve, and on one written before the
   *  definition was recorded (suspended until allowed again). */
  readonly operationDigest: string | null;
  readonly operationVersion: number | null;
}

interface PolicyDbRow {
  workspace_id: string;
  id: string;
  gatekeeper_id: string | null;
  action_kind: string;
  blast_radius: BlastRadius | null;
  auto_approve: boolean;
  requester_can_approve: boolean | null;
  set_by: string;
  created_at: Date;
  updated_at: Date;
  operation_digest: string | null;
  operation_version: number | null;
}

function mapPolicyRow(row: PolicyDbRow): PolicyRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    gatekeeperId: row.gatekeeper_id,
    actionKind: row.action_kind,
    blastRadius: row.blast_radius,
    autoApprove: row.auto_approve,
    requesterCanApprove: row.requester_can_approve,
    setBy: row.set_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    operationDigest: row.operation_digest,
    operationVersion: row.operation_version,
  };
}

const RULE_COLUMNS =
  'id, action_kind, blast_radius, auto_approve, requester_can_approve, set_by, created_at, updated_at';
/** `policies` has no `gatekeeper_id` column, nor the allowed definition (a workspace-wide rule
 *  never turns auto-approval on) — projected as `null` so both tables map through `mapPolicyRow`. */
const WORKSPACE_POLICY_COLUMNS = `workspace_id, null::uuid as gatekeeper_id, ${RULE_COLUMNS}, null::text as operation_digest, null::integer as operation_version`;
const GATEKEEPER_POLICY_COLUMNS = `workspace_id, gatekeeper_id, ${RULE_COLUMNS}, operation_digest, operation_version`;

/** The workspace-wide `policies` row for `actionKind`, or `null` if none exists. */
async function readWorkspacePolicy(
  client: PoolClient,
  workspaceId: string,
  actionKind: string,
): Promise<PolicyRow | null> {
  const result = await client.query<PolicyDbRow>(
    `select ${WORKSPACE_POLICY_COLUMNS} from policies where workspace_id = $1 and action_kind = $2`,
    [workspaceId, actionKind],
  );
  const row = result.rows[0];
  return row ? mapPolicyRow(row) : null;
}

/** The gate-scoped `gatekeeper_policies` row for `(gatekeeperId, actionKind)`, or `null`. */
export async function readGatekeeperPolicy(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
  actionKind: string,
): Promise<PolicyRow | null> {
  const result = await client.query<PolicyDbRow>(
    `select ${GATEKEEPER_POLICY_COLUMNS} from gatekeeper_policies
     where workspace_id = $1 and gatekeeper_id = $2 and action_kind = $3`,
    [workspaceId, gatekeeperId, actionKind],
  );
  const row = result.rows[0];
  return row ? mapPolicyRow(row) : null;
}

/**
 * The rule that applies to an ActionRequest for `actionKind` on `gatekeeperId`: the gate-scoped
 * row if one exists (the most specific consent wins, whole row), else the workspace-wide row, else
 * `null` ("use the compiled-in default" — `engine.ts`).
 */
export async function readEffectivePolicy(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
  actionKind: string,
): Promise<PolicyRow | null> {
  return (
    (await readGatekeeperPolicy(client, workspaceId, gatekeeperId, actionKind)) ??
    (await readWorkspacePolicy(client, workspaceId, actionKind))
  );
}

const BLAST_RADIUS_RANK: Record<BlastRadius, number> = { low: 0, medium: 1, high: 2 };

/** What a request is made against — the published definition's digest (`operationRecordDigest`)
 *  and its declared blast radius — or, for a rule's list entry, the definition published now. */
export interface DefinitionInForce {
  readonly operationDigest: string | undefined;
  readonly blastRadius: BlastRadius;
}

/**
 * Legacy 218: whether a gate-scoped auto-approval rule still allows what is in force. It allows
 * the definition recorded when it was written (`operationDigest`), at no more than the blast
 * radius it recorded then: a revision with another definition, or a governance edit raising the
 * blast radius in place (`refresh_operation_governance` keeps the digest), was never seen by the
 * person who allowed it. A rule naming no definition (written before 0020 without evidence, or by
 * the previous release after a rollback) allows nothing. Only a gate-scoped `autoApprove: true`
 * row has a consent to outlive — every other row is `'current'`.
 */
export type AutoApproveConsent = 'current' | 'definition_changed' | 'not_recorded';

export function autoApproveConsent(
  row: PolicyRow,
  current: DefinitionInForce | null,
): AutoApproveConsent {
  if (row.gatekeeperId === null || !row.autoApprove) return 'current';
  if (row.operationDigest === null) return 'not_recorded';
  if (current === null || current.operationDigest !== row.operationDigest) {
    return 'definition_changed';
  }
  if (
    row.blastRadius !== null &&
    BLAST_RADIUS_RANK[current.blastRadius] > BLAST_RADIUS_RANK[row.blastRadius]
  ) {
    return 'definition_changed';
  }
  return 'current';
}

/** A rule row as `evaluate()`'s `workspacePolicy` input, for a request made against `request`. */
export function toPolicyEvaluationInput(
  row: PolicyRow,
  request: DefinitionInForce,
): WorkspacePolicyInput {
  return {
    scope: row.gatekeeperId === null ? 'workspace' : 'gatekeeper',
    autoApprove: row.autoApprove,
    requesterCanApprove: row.requesterCanApprove,
    allowsThisDefinition: autoApproveConsent(row, request) === 'current',
  };
}

/** `list_policies` (S3.11, docs/development-tasks.md "中台控制面"): every explicit rule the
 *  workspace has — workspace-wide and gate-scoped alike, told apart by `gatekeeperId` — most
 *  recently updated first. An action_kind with no row is simply absent (it is running on the
 *  compiled-in default, `engine.ts`'s own concern, not this read's). */
export async function listPolicies(
  client: PoolClient,
  workspaceId: string,
): Promise<readonly PolicyRow[]> {
  const result = await client.query<PolicyDbRow>(
    `select ${WORKSPACE_POLICY_COLUMNS} from policies where workspace_id = $1
     union all
     select ${GATEKEEPER_POLICY_COLUMNS} from gatekeeper_policies where workspace_id = $1
     order by updated_at desc, id`,
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
// R-20 / D-15: `gatekeeperId` scopes the rule to one gate (`gatekeeper_policies`); omitted, the
// rule is workspace-wide and may only require approval (`setPolicy`).
export const SetPolicyPayloadSchema = z
  .object({
    gatekeeperId: z.string().uuid().optional(),
    actionKindTag: z.string().min(1),
    blastRadius: BlastRadiusSchema.optional(),
    autoApprove: z.boolean(),
    // Omitted: the rule keeps what it has (#493 review of #592 — omission never resets it to the
    // default, which is looser for a non-high action). `null`: clear it, inheriting the default.
    requesterCanApprove: z.boolean().nullable().optional(),
    // Legacy 218: with `gatekeeperId` and `autoApprove: true`, the published version of the
    // Operation the caller looked at — the rule allows that definition only.
    operationVersion: z.number().int().positive().optional(),
  })
  .strict();
export type SetPolicyPayload = z.infer<typeof SetPolicyPayloadSchema>;

/** Thrown by `parseSetPolicyPayload` when `set_policy`'s opaque `policy: jsonRecord` payload does
 *  not match `SetPolicyPayloadSchema`, and by `setPolicy` for a workspace-wide auto-approval.
 *  Declared here (not reused from `application/gateway/dispatch.ts`'s
 *  `InvalidCapabilityParamsError`) to avoid a circular import — `application/gateway/handlers.ts`
 *  calls this module, and `dispatch.ts` calls `handlers.ts`; governance may not depend on
 *  application either way (§7.10). `interfaces/http/capability-route.ts` maps this to the same
 *  HTTP 400 `invalid_params` shape as `InvalidCapabilityParamsError`. */
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

/** Legacy 218: the published definition a gate-scoped auto-approval rule allows. */
export interface AllowedDefinition {
  readonly operationDigest: string;
  readonly operationVersion: number;
}

/** This module's own internal parameter shape for `setPolicy` — deliberately independent of
 *  `SetPolicyPayload` above (see that type's own doc comment): `actionKind` here matches the
 *  `action_kind` DB column, the name every other governance/policy|approval internal type
 *  already uses for this same value. */
export interface SetPolicyInput {
  /** Set: a gate-scoped rule (`gatekeeper_policies`). Omitted: a workspace-wide rule. */
  readonly gatekeeperId?: string;
  readonly actionKind: string;
  readonly blastRadius?: BlastRadius;
  readonly autoApprove: boolean;
  /** Omitted: an existing row keeps its value (a new row gets `null`); `null`: clear it, so the
   *  compiled-in default applies (`engine.ts` `resolveRequesterCanApprove`). */
  readonly requesterCanApprove?: boolean | null;
  readonly setBy: string;
  /** Legacy 218: required for a gate-scoped rule with `autoApprove: true` — the definition the
   *  person allowed. Ignored otherwise (such a row records none: it has no consent to outlive). */
  readonly allows?: AllowedDefinition;
}

/**
 * Upserts a rule (§9.3 `set_policy`, owner-only human channel; and "Always allow" below). Rejects,
 * before touching the DB:
 *
 *   - `autoApprove: true` at `blastRadius: 'high'` (`assertPolicyWriteAllowed`, engine.ts — I8
 *     "工作区不能关闭"); the DB CHECK on both tables is the second, independent enforcement;
 *   - `autoApprove: true` without a `gatekeeperId` (R-20 / D-15): auto-approval is consented to
 *     per gate, so a workspace-wide rule may only require approval.
 *
 * A repeat call for the same key replaces the row's tunable columns
 * (`blastRadius`/`autoApprove`; `requesterCanApprove` only when given — omitted, it is kept) — a rule is configuration, not an
 * append-only governed record (0002's own "delete is granted" comment, same reasoning extends to
 * update-in-place); every write is audited by the capability dispatch.
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
  if (input.gatekeeperId === undefined && input.autoApprove) {
    throw new SetPolicyValidationError(
      `policy for action_kind "${input.actionKind}": auto-approval is granted per gate (R-20 / D-15) — a workspace-wide rule can only require approval; pass gatekeeperId`,
    );
  }
  if (input.gatekeeperId !== undefined && input.autoApprove && input.allows === undefined) {
    // The handlers always resolve it; a rule naming no definition would allow nothing.
    throw new Error(
      `setPolicy: an auto-approval rule for "${input.actionKind}" must name the definition it allows (legacy 218)`,
    );
  }
  const allows = input.gatekeeperId !== undefined && input.autoApprove ? input.allows : undefined;

  const values = [
    workspaceId,
    input.actionKind,
    input.blastRadius ?? null,
    input.autoApprove,
    input.requesterCanApprove ?? null,
    input.setBy,
    input.requesterCanApprove !== undefined,
  ];
  const result =
    input.gatekeeperId === undefined
      ? await client.query<PolicyDbRow>(
          `insert into policies (workspace_id, action_kind, blast_radius, auto_approve, requester_can_approve, set_by)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (workspace_id, action_kind) do update
             set blast_radius = excluded.blast_radius,
                 auto_approve = excluded.auto_approve,
                 requester_can_approve = case when $7::boolean then excluded.requester_can_approve
                                              else policies.requester_can_approve end,
                 set_by = excluded.set_by,
                 updated_at = now()
           returning ${WORKSPACE_POLICY_COLUMNS}`,
          values,
        )
      : await client.query<PolicyDbRow>(
          `insert into gatekeeper_policies (
             workspace_id, action_kind, blast_radius, auto_approve, requester_can_approve, set_by,
             gatekeeper_id, operation_digest, operation_version
           )
           values ($1, $2, $3, $4, $5, $6, $8, $9, $10)
           on conflict (workspace_id, gatekeeper_id, action_kind) do update
             set blast_radius = excluded.blast_radius,
                 auto_approve = excluded.auto_approve,
                 requester_can_approve = case when $7::boolean then excluded.requester_can_approve
                                              else gatekeeper_policies.requester_can_approve end,
                 set_by = excluded.set_by,
                 operation_digest = excluded.operation_digest,
                 operation_version = excluded.operation_version,
                 updated_at = now()
           returning ${GATEKEEPER_POLICY_COLUMNS}`,
          [
            ...values,
            input.gatekeeperId,
            allows?.operationDigest ?? null,
            allows?.operationVersion ?? null,
          ],
        );
  const row = result.rows[0];
  if (!row) throw new Error('setPolicy: INSERT ... RETURNING produced no row');
  return mapPolicyRow(row);
}

// -------------------------------------------------------------------------------------------
// set_auto_approved_action_kind — "总是允许" (§9.3, design doc S2.10 card action). R-20 / D-15:
// the rule is for one gate's action kind, for every requester — keyed `(gatekeeperId,
// actionKind)`. The caller (the handler) resolves the published Operation and passes its own
// `blastRadius`, so a `high` Operation is refused here (`HighBlastRadiusAutoApproveError`) and the
// row's CHECK guards the same snapshot.
// -------------------------------------------------------------------------------------------

export interface SetAutoApprovedActionKindInput {
  readonly gatekeeperId: string;
  readonly actionKind: string;
  /** The published Operation's own `blast_radius` on that gate. */
  readonly blastRadius: BlastRadius;
  readonly setBy: string;
  /** Legacy 218: the published definition the person allowed. */
  readonly allows: AllowedDefinition;
}

/** Writes the gate-scoped auto-approval rule. A `requesterCanApprove` already in force for this
 *  gate and kind (the gate row's, else the workspace-wide row's) is carried over, so turning
 *  auto-approval on never silently drops that narrowing. */
export async function setAutoApprovedActionKind(
  client: PoolClient,
  workspaceId: string,
  input: SetAutoApprovedActionKindInput,
): Promise<PolicyRow> {
  const existing = await readEffectivePolicy(
    client,
    workspaceId,
    input.gatekeeperId,
    input.actionKind,
  );
  return setPolicy(client, workspaceId, {
    gatekeeperId: input.gatekeeperId,
    actionKind: input.actionKind,
    blastRadius: input.blastRadius,
    autoApprove: true,
    requesterCanApprove: existing?.requesterCanApprove ?? undefined,
    setBy: input.setBy,
    allows: input.allows,
  });
}
