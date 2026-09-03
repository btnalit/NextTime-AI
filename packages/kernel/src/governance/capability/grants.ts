import type { GrantStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';

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
  /** Matched against `action_requests.resource_scope` by `hasActiveGrant`/`listGrantHolderPrincipalIds`
   *  below — `undefined`/absent means "every resource_scope" (a wildcard grant for this
   *  capability/action_kind), per migrations/governance/0002_policy.sql's own worked SQL example. */
  readonly resourceScope?: string;
  readonly [key: string]: unknown;
}

export interface CapabilityGrantRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly principalId: string;
  /** Doubles as an `action_kind` when this grant exists to satisfy I14 (design doc §5.1.4). */
  readonly capability: string;
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
  capability: string;
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
    capability: row.capability,
    scope: row.scope,
    status: row.status,
    grantedBy: row.granted_by,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
  };
}

const GRANT_COLUMNS =
  'workspace_id, id, principal_id, capability, scope, status, granted_by, created_at, revoked_at, expires_at';

// -------------------------------------------------------------------------------------------
// grantCapability / revokeCapabilityGrant — the `grant_capability` / `revoke_capability`
// capabilities' service half (packages/shared/src/capabilities.ts governance group).
// -------------------------------------------------------------------------------------------

export interface GrantCapabilityInput {
  readonly principalId: string;
  readonly capability: string;
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
    `insert into capability_grants (workspace_id, principal_id, capability, scope, granted_by, expires_at)
     values ($1, $2, $3, $4::jsonb, $5, $6)
     returning ${GRANT_COLUMNS}`,
    [
      workspaceId,
      input.principalId,
      input.capability,
      JSON.stringify(input.scope ?? {}),
      input.grantedBy,
      input.expiresAt ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('grantCapability: INSERT ... RETURNING produced no row');
  return mapGrantRow(row);
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
  return mapGrantRow(row);
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
// I14 — "the approver must hold an active capability_grants row for the action_kind ×
// resource_scope". `capability_grants.scope ->> 'resourceScope' is null` is this module's
// documented wildcard convention (see `CapabilityGrantScope`'s doc comment) — a grant with no
// resourceScope covers every resource_scope for that capability/action_kind, matching
// migrations/governance/0002_policy.sql's own worked SQL example verbatim.
// -------------------------------------------------------------------------------------------

export interface ScopeMatch {
  readonly principalId: string;
  readonly actionKind: string;
  readonly resourceScope?: string | null | undefined;
}

const MATCHING_GRANT_WHERE = `
  workspace_id = $1
  and principal_id = $2
  and capability = $3
  and status = 'active'
  and (expires_at is null or expires_at > now())
  and (scope ->> 'resourceScope' is null or scope ->> 'resourceScope' = $4)
`;

/** Whether `match.principalId` holds an active, unexpired grant covering `actionKind` ×
 *  `resourceScope` — the owner-override half of I14 ("the workspace owner counts as holding every
 *  scope") is layered on separately by callers (e.g. `governance/approval/service.ts`'s I14
 *  precheck), not by this function, so it stays a pure "does a grant row exist" question. */
export async function hasActiveGrant(
  client: PoolClient,
  workspaceId: string,
  match: ScopeMatch,
): Promise<boolean> {
  const result = await client.query(
    `select 1 from capability_grants where ${MATCHING_GRANT_WHERE} limit 1`,
    [workspaceId, match.principalId, match.actionKind, match.resourceScope ?? null],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface ScopeQuery {
  readonly actionKind: string;
  readonly resourceScope?: string | null | undefined;
}

/** Every principal id with an active, unexpired grant covering `actionKind` × `resourceScope` —
 *  the grant half of `governance/approval/routing.ts`'s I14 holder computation (the workspace
 *  owner(s) are the other half, `listWorkspaceOwnerPrincipalIds` below). */
export async function listGrantHolderPrincipalIds(
  client: PoolClient,
  workspaceId: string,
  query: ScopeQuery,
): Promise<readonly string[]> {
  const result = await client.query<{ principal_id: string }>(
    `select distinct principal_id from capability_grants
     where workspace_id = $1
       and capability = $2
       and status = 'active'
       and (expires_at is null or expires_at > now())
       and (scope ->> 'resourceScope' is null or scope ->> 'resourceScope' = $3)`,
    [workspaceId, query.actionKind, query.resourceScope ?? null],
  );
  return result.rows.map((row) => row.principal_id);
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
