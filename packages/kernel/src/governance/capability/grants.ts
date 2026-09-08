import type { GrantStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { revokeEntrySessionHandles } from './handles.js';

/**
 * governance/capability/grants: CapabilityGrant CRUD and the I14 "does this Principal hold this
 * scope" lookup (design doc §5.1.4 CapabilityGrant, §5.4 I14, §5.5 `active → revoked | expired`;
 * migrations/governance/0002_policy.sql `capability_grants`).
 *
 * Placement note (assumption — see PR body "假设"): this file's sibling `handles.ts`'s own module
 * doc comment already flags the gap this fills ("CapabilityGrant ... is not yet implemented ...
 * lands with S2.1/S2.3, not here") — `capability_grants` is this module's own table by the design
 * doc's module list (§7.1 "governance | capability、policy、approval、..." — Capability/
 * CapabilityGrant/CapabilityHandle are one module's three concepts), even though the table itself
 * was created by S2.1's `governance/0002_policy.sql` migration file (which also holds `policies`,
 * `policy`'s own table, in the same file — a migration-file grouping choice, not a module-ownership
 * one). S2.3 (this task) is the first to need read/write access to it (I14's `approve`/`reject`
 * precheck, and the routing.ts holder-list query) — added here, in `governance/capability`, rather
 * than duplicated or placed in `governance/policy`/`governance/approval`, so there is exactly one
 * place that knows this table's row shape and query patterns, per §7.10's module contract ("每个
 * 模块拥有自己的表...不查询其他模块的表").
 *
 * Every function here takes an already-open `PoolClient`, same convention as `handles.ts` — the
 * caller is expected to already be running inside `withWorkspace(...)`.
 */

export interface CapabilityGrantScope {
  readonly [key: string]: unknown;
}

export interface CapabilityGrantRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly principalId: string;
  /** The resource kind this grant covers (docs/wire-contract-conventions.md §1, 2026-09-08
   *  decision: `capability_grants.capability` renamed `resource_type` — "capability" is reserved
   *  for a registry name, never borrowed by a Grant). Today `'gatekeeper'`
   *  (`GATEKEEPER_GRANT_CAPABILITY`), or a bare I14 action_kind string for an approval-queue grant
   *  with no single resource instance (`resourceId` is `null` for those rows). */
  readonly resourceType: string;
  /** The specific resource this grant covers within `resourceType` (e.g. a gatekeeperId) —
   *  `null`/absent means "every resource of this type" (a wildcard grant), or, for an
   *  action_kind-scoped row, "no single resource applies". Was folded into `scope.resourceScope`
   *  before migrations/governance/0009_capability_grants_resource_type.sql promoted it to its own
   *  column. */
  readonly resourceId: string | null;
  readonly scope: CapabilityGrantScope;
  readonly status: GrantStatus;
  readonly grantedBy: string;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
  readonly expiresAt: Date | null;
}

interface CapabilityGrantDbRow {
  workspace_id: string;
  id: string;
  principal_id: string;
  resource_type: string;
  resource_id: string | null;
  scope: CapabilityGrantScope;
  status: GrantStatus;
  granted_by: string;
  created_at: Date;
  revoked_at: Date | null;
  expires_at: Date | null;
}

function mapGrantRow(row: CapabilityGrantDbRow): CapabilityGrantRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    principalId: row.principal_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    scope: row.scope,
    status: row.status,
    grantedBy: row.granted_by,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
  };
}

const GRANT_COLUMNS =
  'workspace_id, id, principal_id, resource_type, resource_id, scope, status, granted_by, created_at, revoked_at, expires_at';

/** The `capability_grants.resource_type` value that represents "may act on this Gatekeeper" (S2.13
 *  `connect_gatekeeper`'s own convention — `agent-host-runtime.ts`'s `ensureEntryHandle` already
 *  reads it via `listActiveGrantResourceScopes(..., {resourceType: GATEKEEPER_RESOURCE_SCOPE_KEY})`,
 *  same literal string as `governance/policy/engine.ts`'s `GATEKEEPER_RESOURCE_SCOPE_KEY` — not
 *  imported from there to avoid a needless cross-submodule dependency for one string constant;
 *  both names are documented as the same convention, see lane2's own "semantic drift" note on this
 *  column mixing two vocabularies before docs/wire-contract-conventions.md's rename). Used here for
 *  two authority-tightening fixes (review job 652a4abc, item 2 and item 4):
 *   - `MATCHING_GRANT_WHERE`/`listGrantHolderPrincipalIds` also accept a `'gatekeeper'` grant
 *     scoped to the same resource id as satisfying I14 for *any* `action_kind` at that gate
 *     (item 2's "decide and document" — decision: yes, a principal trusted to act on a Gatekeeper
 *     at all is trusted to approve any of its Operations; §5.8 already frames `operator` role as
 *     only "进队列", capability scope as what actually decides "能批哪条").
 *   - `grantCapability`/`revokeCapabilityGrant` revoke the principal's entry-session Handle(s)
 *     whenever the changed grant's `resourceType` is this value (item 4).
 */
export const GATEKEEPER_GRANT_CAPABILITY = 'gatekeeper';

// -------------------------------------------------------------------------------------------
// grantCapability / revokeCapabilityGrant — the `grant_capability` / `revoke_capability`
// capabilities' service half (packages/shared/src/capabilities.ts governance group).
// -------------------------------------------------------------------------------------------

export interface GrantCapabilityInput {
  readonly principalId: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly scope?: CapabilityGrantScope;
  readonly grantedBy: string;
  readonly expiresAt?: Date;
}

export async function grantCapability(
  client: PoolClient,
  workspaceId: string,
  input: GrantCapabilityInput,
): Promise<CapabilityGrantRow> {
  const result = await client.query<CapabilityGrantDbRow>(
    `insert into capability_grants (workspace_id, principal_id, resource_type, resource_id, scope, granted_by, expires_at)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7)
     returning ${GRANT_COLUMNS}`,
    [
      workspaceId,
      input.principalId,
      input.resourceType,
      input.resourceId ?? null,
      JSON.stringify(input.scope ?? {}),
      input.grantedBy,
      input.expiresAt ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('grantCapability: INSERT ... RETURNING produced no row');
  const mapped = mapGrantRow(row);

  // Item 4 fix: a new `'gatekeeper'` Grant widens what this principal may reach through their
  // entry agent — force their cached entry Handle(s) to reissue on the next Turn rather than
  // waiting for `ensureEntryHandle`'s own ttl-driven reissue window (see
  // `revokeEntrySessionHandles`'s own doc comment).
  if (mapped.resourceType === GATEKEEPER_GRANT_CAPABILITY) {
    await revokeEntrySessionHandles(client, workspaceId, mapped.principalId);
  }
  return mapped;
}

export class GrantNotFoundError extends Error {
  constructor(workspaceId: string, grantId: string) {
    super(`CapabilityGrant not found: workspace ${workspaceId}, id ${grantId}`);
    this.name = 'GrantNotFoundError';
  }
}

/** Revokes an active grant (§5.5 `active → revoked`). Idempotent in the "already revoked" sense is
 *  deliberately *not* offered — revoking an already-revoked/expired grant throws
 *  `GrantNotFoundError`, since the `where status = 'active'` predicate below matches no row for
 *  either case and this module cannot tell them apart from "never existed" without a second query;
 *  callers that need to distinguish should read the row first via `getGrant`. */
export async function revokeCapabilityGrant(
  client: PoolClient,
  workspaceId: string,
  grantId: string,
): Promise<CapabilityGrantRow> {
  const result = await client.query<CapabilityGrantDbRow>(
    `update capability_grants set status = 'revoked', revoked_at = now()
     where workspace_id = $1 and id = $2 and status = 'active'
     returning ${GRANT_COLUMNS}`,
    [workspaceId, grantId],
  );
  const row = result.rows[0];
  if (!row) throw new GrantNotFoundError(workspaceId, grantId);
  const mapped = mapGrantRow(row);

  // Item 4 fix (review job 652a4abc lane2 P1: "revoking a connect_gatekeeper Grant leaves the
  // gate in the entry Handle up to ~21.6h") — force the principal's cached entry Handle(s) to
  // reissue on their next Turn rather than continuing to carry a gate this Grant just revoked.
  if (mapped.resourceType === GATEKEEPER_GRANT_CAPABILITY) {
    await revokeEntrySessionHandles(client, workspaceId, mapped.principalId);
  }
  return mapped;
}

export async function getGrant(
  client: PoolClient,
  workspaceId: string,
  grantId: string,
): Promise<CapabilityGrantRow | null> {
  const result = await client.query<CapabilityGrantDbRow>(
    `select ${GRANT_COLUMNS} from capability_grants where workspace_id = $1 and id = $2`,
    [workspaceId, grantId],
  );
  const row = result.rows[0];
  return row ? mapGrantRow(row) : null;
}

// -------------------------------------------------------------------------------------------
// I14 — "the approver must hold an active capability_grants row for the action_kind (as
// resourceType) × resource_scope (as resourceId)". `capability_grants.resource_id is null` is this
// module's documented wildcard convention (see `CapabilityGrantRow.resourceId`'s own doc comment)
// — a grant with no resourceId covers every resource for that resourceType, matching
// migrations/governance/0002_policy.sql's own worked SQL example (now against the renamed
// columns, migrations/governance/0009_capability_grants_resource_type.sql).
// -------------------------------------------------------------------------------------------

export interface ScopeMatch {
  readonly principalId: string;
  readonly resourceType: string;
  readonly resourceId?: string | null | undefined;
}

/**
 * Item 2 decision (review job 652a4abc, "decide and document whether capability='gatekeeper'
 * grants satisfy I14 for that gate — recommended yes"): **yes** — a `'gatekeeper'` grant scoped to
 * the same resource id (the ActionRequest's `gatekeeper_id`, see `GATEKEEPER_GRANT_CAPABILITY`'s
 * own doc comment) satisfies I14 for *any* `action_kind` at that Gatekeeper, in addition to an
 * exact `resource_type = action_kind` grant. Rationale: I14's `action_kind`-exact grant already
 * lets a workspace scope an approver narrowly ("this operator may only approve
 * `container.restart`"); a `'gatekeeper'` grant is the *coarser* delegation ("this operator may
 * act on this Gatekeeper at all", the same grant `connect_gatekeeper`/`grant_capability
 * {resourceType:'gatekeeper'}` writes for entry-Handle gate access, S2.13) — a principal already
 * trusted with that broader authority is necessarily trusted with the narrower "approve one
 * Operation on it" (§5.8 "角色 operator 只是进队列；能批哪条由 capability 范围决定" already frames
 * capability scope, not role, as the actual decision surface; this widens what counts as a
 * matching scope, not who reaches the check). `$4 is not null` guards the added OR-branch so it
 * never fires for an ActionRequest with no `resource_scope` on file (pre-item-2 rows, or a future
 * non-Gatekeeper `action_kind`) — an unscoped `'gatekeeper'` grant has nothing meaningful to match
 * there.
 */
const MATCHING_GRANT_WHERE = `
  workspace_id = $1
  and principal_id = $2
  and status = 'active'
  and (expires_at is null or expires_at > now())
  and (
    (resource_type = $3 and (resource_id is null or resource_id = $4))
    or (
      $4 is not null
      and resource_type = '${GATEKEEPER_GRANT_CAPABILITY}'
      and (resource_id is null or resource_id = $4)
    )
  )
`;

/** Whether `match.principalId` holds an active, unexpired grant covering `resourceType` ×
 *  `resourceId` — the owner-override half of I14 ("the workspace owner counts as holding every
 *  scope") is layered on separately by callers (e.g. `governance/approval/service.ts`'s I14
 *  precheck), not by this function, so it stays a pure "does a grant row exist" question. See
 *  `MATCHING_GRANT_WHERE`'s own doc comment for the item-2 "gatekeeper grant satisfies I14"
 *  widening this also applies. */
export async function hasActiveGrant(
  client: PoolClient,
  workspaceId: string,
  match: ScopeMatch,
): Promise<boolean> {
  const result = await client.query(
    `select 1 from capability_grants where ${MATCHING_GRANT_WHERE} limit 1`,
    [workspaceId, match.principalId, match.resourceType, match.resourceId ?? null],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface ScopeQuery {
  readonly resourceType: string;
  readonly resourceId?: string | null | undefined;
}

/** Every principal id with an active, unexpired grant covering `resourceType` × `resourceId` —
 *  the grant half of `governance/approval/routing.ts`'s I14 holder computation (the workspace
 *  owner(s) are the other half, `listWorkspaceOwnerPrincipalIds` below). Same item-2 "gatekeeper
 *  grant satisfies I14" widening as `hasActiveGrant`/`MATCHING_GRANT_WHERE` above, kept as its own
 *  literal SQL (a `distinct principal_id` projection, not the `exists`-shaped
 *  `MATCHING_GRANT_WHERE`) rather than factored into one shared string, since the two queries
 *  select different columns. */
export async function listGrantHolderPrincipalIds(
  client: PoolClient,
  workspaceId: string,
  query: ScopeQuery,
): Promise<readonly string[]> {
  const result = await client.query<{ principal_id: string }>(
    `select distinct principal_id from capability_grants
     where workspace_id = $1
       and status = 'active'
       and (expires_at is null or expires_at > now())
       and (
         (resource_type = $2 and (resource_id is null or resource_id = $3))
         or (
           $3 is not null
           and resource_type = '${GATEKEEPER_GRANT_CAPABILITY}'
           and (resource_id is null or resource_id = $3)
         )
       )`,
    [workspaceId, query.resourceType, query.resourceId ?? null],
  );
  return result.rows.map((row) => row.principal_id);
}

/**
 * Whether `query.principalId` holds ANY active, unexpired `capability_grants` row for
 * `query.resourceType` — regardless of `resourceId` (wildcard or a specific one alike). Distinct
 * from `hasActiveGrant`, which matches a *specific* target `resourceId` (or the wildcard-null
 * convention for it); this answers "does the principal hold this resource type at all, on any
 * resource" — item 5's `set_auto_approved_action_kind` check needs exactly this shape: the
 * workspace-wide auto-approval rule it writes is not itself resource-scoped (it is not "for gate
 * G", it is "for every gate"), so the write-time authorization check cannot narrow to one
 * `resourceId` either — any grant naming this `action_kind`, at any gate (or wildcard), is
 * sufficient (§5.8 "能批哪条由 capability 范围决定" extended to "能设自动批准规则的范围由 capability 范围
 * 决定").
 */
export interface AnyActiveGrantQuery {
  readonly principalId: string;
  readonly resourceType: string;
}

export async function hasAnyActiveGrant(
  client: PoolClient,
  workspaceId: string,
  query: AnyActiveGrantQuery,
): Promise<boolean> {
  const result = await client.query(
    `select 1 from capability_grants
     where workspace_id = $1
       and principal_id = $2
       and resource_type = $3
       and status = 'active'
       and (expires_at is null or expires_at > now())
     limit 1`,
    [workspaceId, query.principalId, query.resourceType],
  );
  return (result.rowCount ?? 0) > 0;
}

// -------------------------------------------------------------------------------------------
// listActiveGrantResourceScopes (S2.13): the mechanism that flows a `connect_gatekeeper` Grant
// into an entry Handle's own `resources.gatekeeper` scope at issuance time
// (`application/host-bridge/agent-host-runtime.ts`'s `ensureEntryHandle` — that seam was
// documented as missing by `governance/capability/handles.ts`'s own "Known seam for S2.4/S2.13"
// note, which this closes). Distinct from `hasActiveGrant`/`listGrantHolderPrincipalIds` above,
// which answer I14's "does this principal cover this one resource" question for a *known*
// resource; this answers the dual question, "every resource this principal is covered for under
// this resourceType" — there is no fixed resource in hand yet, a Handle's scope is being built
// from scratch.
// -------------------------------------------------------------------------------------------

export interface ActiveGrantResourceScopeQuery {
  readonly principalId: string;
  readonly resourceType: string;
}

/** Every distinct, non-null `resourceId` from `match.principalId`'s active, unexpired grants for
 *  `match.resourceType` — a grant with no `resourceId` (the wildcard-coverage convention,
 *  `CapabilityGrantRow.resourceId`'s own doc comment) is skipped: it covers every resource for
 *  I14 purposes, but there is no single id to add to a Handle's finite `resources[key]` list. */
export async function listActiveGrantResourceScopes(
  client: PoolClient,
  workspaceId: string,
  query: ActiveGrantResourceScopeQuery,
): Promise<readonly string[]> {
  const result = await client.query<{ resource_id: string }>(
    `select distinct resource_id from capability_grants
     where workspace_id = $1
       and principal_id = $2
       and resource_type = $3
       and status = 'active'
       and (expires_at is null or expires_at > now())
       and resource_id is not null`,
    [workspaceId, query.principalId, query.resourceType],
  );
  return result.rows.map((row) => row.resource_id);
}

// -------------------------------------------------------------------------------------------
// Workspace owner — "the workspace owner counts as holding every scope" (this task's own I14
// wording; §5.8 does not otherwise special-case `owner` for approval, but §5.1.1 already frames
// `owner` as the tenant-root role — see application/gateway/authorize.ts's `roleSatisfiesMinRole`
// doc comment for the same "owner is a super-role" reading applied to `minRole`).
// -------------------------------------------------------------------------------------------

export async function isWorkspaceOwner(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<boolean> {
  const result = await client.query(
    `select 1 from principals where workspace_id = $1 and id = $2 and role = 'owner' limit 1`,
    [workspaceId, principalId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listWorkspaceOwnerPrincipalIds(
  client: PoolClient,
  workspaceId: string,
): Promise<readonly string[]> {
  const result = await client.query<{ id: string }>(
    `select id from principals where workspace_id = $1 and role = 'owner'`,
    [workspaceId],
  );
  return result.rows.map((row) => row.id);
}
