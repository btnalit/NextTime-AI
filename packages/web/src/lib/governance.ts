import type { GrantStatus, PrincipalKind, Role } from '@nexttime/shared';

/**
 * lib/governance: wire shapes for the S3.11 governance capabilities this PR's web half codes
 * against (the "Contract you code against" section of the task — the kernel half is landing in a
 * parallel PR against the same names/shapes; see docs/development-tasks.md §S3.11). None of these
 * capabilities exist in `@nexttime/shared`'s `CAPABILITY_REGISTRY` yet on `main` as of this PR —
 * every page reading them treats a `not_found` response as "not deployed yet" (`lib/errors.ts`
 * `isNotFoundError`) rather than assuming the shape below is wrong. Field names follow
 * docs/wire-contract-conventions.md (`id` for the resource's own key, `<resource>Id` for a
 * reference, `*At` for ISO timestamps, list results as `{items, nextCursor?}`).
 */

// -------------------------------------------------------------------------------------------
// Members (list_principals / create_principal / set_principal_role / rotate_api_key /
// disable_principal)
// -------------------------------------------------------------------------------------------

export interface PrincipalRow {
  readonly id: string;
  readonly kind: PrincipalKind;
  readonly role: Role;
  readonly displayName: string;
  readonly createdAt: string;
  readonly disabledAt?: string | null;
  /** Set only for `kind: 'agent'` principals (a Worker's own identity) — links back to the
   *  WorkerDefinition that spawns it. */
  readonly workerDefinitionId?: string | null;
  /** Whether this principal currently holds an API key — never the key itself (S3.11: "API key
   *  只显示一次" — shown once, at `create_principal`/`rotate_api_key` time, never again). */
  readonly hasApiKey: boolean;
}

export interface CreatePrincipalResult {
  readonly principal: PrincipalRow;
  /** Shown once by the caller, then discarded — never stored, never re-fetchable. */
  readonly apiKey: string;
}

export interface RotateApiKeyResult {
  readonly principalId: string;
  readonly apiKey: string;
}

export function principalDisplayRole(principal: Pick<PrincipalRow, 'role' | 'kind'>): string {
  return principal.kind === 'human' ? principal.role : `${principal.role} · ${principal.kind}`;
}

// -------------------------------------------------------------------------------------------
// Access (list_grants / grant_capability / revoke_capability — grant_capability and
// revoke_capability already exist, docs/wire-contract-conventions.md §1 resourceType/resourceId
// rename)
// -------------------------------------------------------------------------------------------

export interface GrantRow {
  readonly id: string;
  readonly principalId: string;
  readonly resourceType: string;
  readonly resourceId?: string | null;
  readonly scope?: Readonly<Record<string, unknown>> | null;
  readonly status: GrantStatus;
  readonly grantedBy: string;
  readonly createdAt: string;
  readonly expiresAt?: string | null;
}

// -------------------------------------------------------------------------------------------
// Systems (list_gatekeepers / get_gatekeeper — additive to the existing S2.13 `search`-based
// GatekeeperCard flow in lib/connections.ts, which this PR leaves untouched)
// -------------------------------------------------------------------------------------------

export interface GatekeeperListRow {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly status: string;
  readonly manifestVersion?: number | null;
  readonly operationCount: number;
  readonly createdAt: string;
}

export interface GatekeeperDetailOperation {
  readonly name: string;
  readonly status: string;
  readonly mode?: string;
  readonly blastRadius?: string;
}

/** `get_gatekeeper`'s `health` is not a wire enum anywhere in `@nexttime/shared` today — read
 *  defensively (`healthToneOf` below) instead of assuming a fixed shape from a capability that, as
 *  of this PR, is still being implemented in the parallel kernel PR. */
export type GatekeeperHealth = unknown;

export interface GatekeeperDetail extends GatekeeperListRow {
  readonly operations: readonly GatekeeperDetailOperation[];
  readonly health: GatekeeperHealth;
}

export interface HealthView {
  readonly tone: 'ok' | 'danger' | 'neutral';
  readonly label: string;
}

/** Reads `get_gatekeeper`'s `health` leniently: `{ok: boolean}`, `{status: 'healthy'|...}`, a bare
 *  boolean, or anything else it might turn out to be — never throws, never crashes the drawer on a
 *  shape this PR guessed wrong while the kernel half was still being written in parallel. */
export function healthView(health: GatekeeperHealth): HealthView {
  if (typeof health === 'boolean') {
    return health ? { tone: 'ok', label: 'Healthy' } : { tone: 'danger', label: 'Unhealthy' };
  }
  if (health && typeof health === 'object') {
    const record = health as Record<string, unknown>;
    if (typeof record.ok === 'boolean') {
      return record.ok ? { tone: 'ok', label: 'Healthy' } : { tone: 'danger', label: 'Unhealthy' };
    }
    if (typeof record.status === 'string') {
      const status = record.status.toLowerCase();
      if (status.includes('unhealthy') || status.includes('down') || status.includes('fail')) {
        return { tone: 'danger', label: record.status };
      }
      if (status.includes('healthy') || status.includes('ok') || status.includes('up')) {
        return { tone: 'ok', label: record.status };
      }
      return { tone: 'neutral', label: record.status };
    }
  }
  return { tone: 'neutral', label: 'Unknown' };
}

// -------------------------------------------------------------------------------------------
// Catalog (list_operations / get_gatekeeper's embedded operations[] — both on main as of PR
// #100, `gatekeeper-read-handlers.ts`'s shared `toWireOperationSummary`; list_skills /
// list_procedures / list_worker_definitions — existing, `lib/tasks.ts` already types
// `WorkerDefinitionSummary`)
// -------------------------------------------------------------------------------------------

/** `toWireOperationSummary` (`gatekeeper-read-handlers.ts`) — verified against the real kernel
 *  projection, not a guess this PR made ahead of it landing. An Operation has **no dedicated id
 *  column** (identity is the pair `{gatekeeperId, name}`, `capabilities.ts`'s own comment on
 *  `propose_operation`/`publish_operation`) and this projection carries no `gatekeeperName` or
 *  `createdAt` — an earlier draft of this type guessed at both; corrected here rather than kept as
 *  dead/always-undefined fields. Use `operationKey()` below wherever a stable per-row key is
 *  needed (React lists, a busy-row lookup, ...). */
export interface OperationCatalogRow {
  readonly gatekeeperId: string;
  readonly name: string;
  readonly status: string;
  readonly mode?: string;
  readonly blastRadius?: string;
  readonly autoApprovable?: boolean;
  /** Always `1` today — no per-Operation revision counter exists yet (`toWireOperationSummary`'s
   *  own doc comment). Kept on the wire type so a future real version renders without a UI change. */
  readonly version?: number;
}

/** The stable identity of an Operation row — no dedicated id column exists (see
 *  `OperationCatalogRow`'s own doc comment), so every list/lookup in the UI keys off this pair
 *  instead of a fabricated `id`. */
export function operationKey(row: Pick<OperationCatalogRow, 'gatekeeperId' | 'name'>): string {
  return `${row.gatekeeperId}::${row.name}`;
}

/** `list_skills` (`application/gateway/skill-procedure-handlers.ts` `listSkillsHandler`, already
 *  wired) — verified against the kernel's own projection, not a guess. */
export interface SkillRow {
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly name: string;
  readonly description: string;
  readonly applicable?: Readonly<Record<string, unknown>>;
}

/** `list_procedures` (same handler file, `listProceduresHandler`) — verified. */
export interface ProcedureRow {
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly name: string;
  readonly description: string;
  readonly steps?: readonly unknown[];
}

// -------------------------------------------------------------------------------------------
// Models / quotas / policies (list_models; list_quotas / list_policies — new, shape inferred
// from the existing `set_quota{key,value}` / `set_policy{policy}` write-side params, since no
// read side exists anywhere in the codebase to verify against yet)
// -------------------------------------------------------------------------------------------

export interface ModelRow {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
}

export interface QuotaRow {
  readonly key: string;
  readonly value: unknown;
}

/** A Policy is an opaque `jsonRecord` on the write side (`set_policy{policy: jsonRecord}` —
 *  `packages/shared/src/capabilities.ts` has no fixed Policy schema at all), so `list_policies`
 *  rows are rendered as a raw (redacted) JSON dump rather than assumed columns — see
 *  `components/ModelsPage.tsx`. */
export type PolicyRow = Readonly<Record<string, unknown>>;

// -------------------------------------------------------------------------------------------
// Workspace (get_workspace)
// -------------------------------------------------------------------------------------------

/** `get_workspace`'s `caller` (S3.11 coordination addendum, 2026-09-08): the already-resolved
 *  human Principal (`application/gateway/dispatch.ts`'s `ResolvedCaller.principal`, projected by
 *  `members-handlers.ts`'s `getWorkspaceHandler`) — the console's first authoritative "who am I"
 *  read, replacing the 403-probing inference in `lib/role.ts` as the primary source (that module
 *  is now a fallback only, for a kernel that predates this field or when the call itself fails). */
export interface WorkspaceCaller {
  readonly id: string;
  readonly role: Role;
  readonly displayName: string;
  readonly kind: PrincipalKind;
}

export interface WorkspaceInfo {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly principalCount: number;
  readonly gatekeeperCount: number;
  readonly caller: WorkspaceCaller;
}
