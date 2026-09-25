import type { GrantStatus, PrincipalKind, Role } from '@nexttime/shared';
import type { ActionRequestRowLike } from './action-card.js';
import type { Translate } from './i18n.js';
import { principalKindLabel, roleLabel } from './labels.js';

/**
 * lib/governance: wire shapes for the S3.11 governance capabilities (docs/development-tasks.md
 * §S3.11). Written while the kernel half landed in a parallel PR; every capability named here has
 * since shipped in `@nexttime/shared`'s `CAPABILITY_REGISTRY`, and the interim "treat `not_found`
 * as not deployed yet" convention was retired in S6-A0 (B6). Field names follow
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

/** S8 W1-A10 (audit S14 "原始枚举…owner"): bilingual now — takes `t` (this is a pure helper, not
 *  a component, so it cannot call `useT()` itself; the caller passes its own). */
export function principalDisplayRole(
  principal: Pick<PrincipalRow, 'role' | 'kind'>,
  t: Translate,
): string {
  const role = roleLabel(principal.role, t);
  return principal.kind === 'human' ? role : `${role} · ${principalKindLabel(principal.kind, t)}`;
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
 *  shape this PR guessed wrong while the kernel half was still being written in parallel. W1-A12:
 *  takes `t` (a plain function, not a hook — `useT()`'s return value, callable outside a component)
 *  to localize its own fixed vocabulary (`Healthy`/`Unhealthy`/`Unknown`); a `record.status` string
 *  is the kernel's own free-text value and is shown verbatim in both languages, same as before. */
export function healthView(health: GatekeeperHealth, t: Translate): HealthView {
  const healthy = t('健康', 'Healthy');
  const unhealthy = t('不健康', 'Unhealthy');
  const unknown = t('未知', 'Unknown');
  if (typeof health === 'boolean') {
    return health ? { tone: 'ok', label: healthy } : { tone: 'danger', label: unhealthy };
  }
  if (health && typeof health === 'object') {
    const record = health as Record<string, unknown>;
    if (typeof record.ok === 'boolean') {
      return record.ok ? { tone: 'ok', label: healthy } : { tone: 'danger', label: unhealthy };
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
  return { tone: 'neutral', label: unknown };
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
  /** S8 W3-K1 (leftover 81) — absent or blank means "未填写描述", never coerced to `''` here so the
   *  page can tell "no description" from "kernel omitted the field" the same way either way. */
  readonly description?: string;
}

/** The stable identity of an Operation row — no dedicated id column exists (see
 *  `OperationCatalogRow`'s own doc comment), so every list/lookup in the UI keys off this pair
 *  instead of a fabricated `id`. */
export function operationKey(row: Pick<OperationCatalogRow, 'gatekeeperId' | 'name'>): string {
  return `${row.gatekeeperId}::${row.name}`;
}

/** `get_operation_stats` (S3.12 catalog-usage follow-up, `gatekeeper-read-handlers.ts`'s
 *  `toWireOperationStats`) — verified against the real kernel projection. Execute-class Operations
 *  only, current-status snapshot rather than cumulative decision history, and never includes an
 *  Operation with zero calls in the window — see that capability's own registry description
 *  (`packages/shared/src/capabilities.ts`) for the full accounting. `CatalogPage.tsx` degrades to
 *  "—" for any `OperationCatalogRow` with no matching entry here (`operationStatsKey()` below). */
export interface OperationStatsRow {
  readonly gatekeeperId: string;
  readonly operationName: string;
  readonly calls: number;
  readonly approved: number;
  readonly rejected: number;
  readonly autoApproved: number;
  readonly failed: number;
  readonly lastCalledAt: string;
}

/** Same `{gatekeeperId}::{name}` shape as `operationKey()` — the two are joined by this key, not by
 *  a shared id column (neither wire type has one). */
export function operationStatsKey(
  row: Pick<OperationStatsRow, 'gatekeeperId' | 'operationName'>,
): string {
  return `${row.gatekeeperId}::${row.operationName}`;
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

/** `list_capability_names` (S8 W1-C, F6 item 3 — `packages/shared/src/capabilities.ts`'s own
 *  comment on that capability): every capability name a published `kind=worker`
 *  WorkerDefinition may declare in its own `capabilities` — the Worker editor's capability
 *  picker (J7). `mode` is the same `CapabilityMode` union `capabilities.ts` defines
 *  (`observe`/`write`/`propose`/`execute`); not rendered as visible copy anywhere today, kept
 *  on the type for a future caller that wants to group/sort by it. */
export interface CapabilityNameRow {
  readonly name: string;
  readonly mode: string;
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

// -------------------------------------------------------------------------------------------
// Approvals (S6-A C25 / C28 — docs/console-completion-plan.md §5.8 "确认态", §6; runbook
// web-console.md 已知缺口 5 / 6): the human decision behind a decided ActionRequest, and the
// row shape the approvals / task pages read from `list_pending` / `get_action` /
// `list_action_requests`. Additive to `lib/action-card.ts`'s `ActionRequestRowLike` (the chat
// lane's file — not extended there): a consumer intersects the two.
// -------------------------------------------------------------------------------------------

/** `ActionRequestWireSchema`'s S6-A C25 fields (packages/shared/src/wire/governance.ts): read
 *  from the Approval Decision row by every handler that returns decided rows. *Optional* on the
 *  wire (a `request_action` projection is produced before any decision exists) and `null` when
 *  there was no human decision (pending, auto-approved, denied, expired) — a consumer treats
 *  absence exactly like `null`. */
export interface ActionRequestDecisionFields {
  readonly decisionReason?: string | null;
  /** The deciding principal's id (`decisions.decided_by`). */
  readonly decidedBy?: string | null;
  readonly decidedAt?: string | null;
  /** Opaque reference into `decisions` — the `explain{nodeId}` root the audit page uses for a
   *  decided request (its producing Activity is `kind: 'governance.approval_decision'`). */
  readonly approvalDecisionId?: string | null;
}

/** `ActionRequestRowLike` (lib/action-card.ts, unchanged) plus the decision fields above — what
 *  `ApprovalQueuePage` / `TaskDetail`'s linked approvals render. Named `Row` rather than `Wire`
 *  because the older `ActionRequestRowLike` is deliberately looser than the wire schema (every
 *  field beyond the S2.10 set optional, so an older row shape still renders). */
export type ActionRequestRow = ActionRequestRowLike & ActionRequestDecisionFields;
