import {
  type GateOwnedParamWire,
  type GatekeeperDetailWire,
  type GrantStatus,
  type OperationAbsentAnswersReviewWire,
  type OperationAbsentAnswersWire,
  type OperationDefinitionChangeWire,
  type OperationGovernanceChangeWire,
  type PrincipalKind,
  type ProviderHealthWire,
  type Role,
  getCapability,
} from '@nexttime/shared';
import type { ActionRequestRowLike } from './action-card.js';
import type { ActionWaitingFields } from './action-outcome.js';
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
  /** S8 W4 (leftover 88): true for the platform's own internal service Principals
   *  (`__gatekeeper_service__`, `__draft_reaper__`) — kernel-derived (`isInternalPrincipalDisplayName`),
   *  never guessed client-side. Consumers filter these out of ordinary member/service-principal
   *  pickers. Optional (like `disabledAt`/`workerDefinitionId` above) so existing test fixtures
   *  that predate this field keep type-checking; `undefined` reads as "not internal". */
  readonly internal?: boolean;
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

/** R-06 (review 2026-10-02, D-05): what the `kit/confirm` `irreversible` tier says before a
 *  service credential holds the owner role — on create (`CreatePrincipalForm`) and on promotion
 *  (`PrincipalDetail`) alike, so "create as member, then promote" reads the same warning. */
export function ownerCredentialConfirmCopy(t: Translate): {
  readonly description: string;
  readonly impact: readonly string[];
} {
  return {
    description: t(
      '这把 API key 能做所有者在本工作区能做的一切，包括管理成员和审批。',
      'This API key can do everything an owner can do in this workspace, including managing members and approving requests.',
    ),
    impact: [
      t(
        '管理成员与凭证（添加、停用、改角色，签发 API key 与 Handle）',
        'Manage members and credentials: add, disable, change roles, issue API keys and Handles',
      ),
      t('批准或驳回动作请求', 'Approve or reject action requests'),
      t('修改授权、策略、配额与系统接入', 'Change grants, policies, quotas and system connections'),
    ],
  };
}

/** R-39 (review 2026-10-02, maintainer decision D-13: a gate grant holder stays an approver, and
 *  the console says so): whether granting a gate to a principal with `role` also makes them an
 *  approver of every action on that gate. The kernel counts a gatekeeper grant as I14 approval
 *  scope, and `approve`'s registry `minRole` decides whose grant counts — the same
 *  `roleSatisfiesMinRole` rule the kernel applies (`member` is the floor every role clears,
 *  anything else needs that exact role). An `owner` approves everything without a grant, so for
 *  them the grant adds nothing and this answers `false`. */
export function gateGrantMakesApprover(role: Role): boolean {
  if (role === 'owner') return false;
  const minRole = getCapability('approve')?.minRole;
  return minRole === undefined || minRole === 'member' || role === minRole;
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
  /** `OperationSummaryWire.version` — told apart only where one name is listed more than once. */
  readonly version?: number;
  readonly status: string;
  readonly mode?: string;
  readonly blastRadius?: string;
  /** Console G4: params only the gate sets (`OperationSummaryWire.gateOwnedParams`). */
  readonly gateOwnedParams?: readonly GateOwnedParamWire[];
}

/** `get_gatekeeper`'s live health probe (`GatekeeperDetailWireSchema.health`): `'ok' |
 *  'unreachable' | 'unauthorized'`, rendered with the same `gateHealth` chip every other gate
 *  health in the console uses (legacy 271 — an earlier lenient reader of guessed shapes showed
 *  every gate as 未知). */
export type GatekeeperHealth = GatekeeperDetailWire['health'];

export interface GatekeeperDetail extends GatekeeperListRow {
  readonly operations: readonly GatekeeperDetailOperation[];
  readonly health: GatekeeperHealth;
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
  /** The identity's version (S3.12): a revision draft is `published.version + 1`, and the version
   *  it replaces stays listed as `deprecated` — so the version tells those rows apart. */
  readonly version?: number;
  /** S8 W3-K1 (leftover 81) — absent or blank means "未填写描述", never coerced to `''` here so the
   *  page can tell "no description" from "kernel omitted the field" the same way either way. */
  readonly description?: string;
  /** STATUS leftover 123 (`OperationSummaryWire.proposedBy`): whose row it is under D-24 — only
   *  that principal and the owner may edit its description. Absent on an older kernel or a legacy
   *  row with no recorded proposer. */
  readonly proposedBy?: string;
  /** R-19 (D-17): on a draft that revises a published version — what publishing it would change,
   *  with the kernel's direction (`OperationSummaryWire.governanceChange`). */
  readonly governanceChange?: OperationGovernanceChangeWire;
  /** Legacy K (UX acceptance of #538): on the same drafts — what publishing it changes in the
   *  definition the gate runs (`OperationSummaryWire.definitionChange`). */
  readonly definitionChange?: OperationDefinitionChangeWire;
  /** Console G4 (legacy 219): params this version declares that only the gate sets
   *  (`OperationSummaryWire.gateOwnedParams`) — a draft carrying them cannot be published. */
  readonly gateOwnedParams?: readonly GateOwnedParamWire[];
  /** UX acceptance of #573 P3-1 (`OperationSummaryWire.origin`): `import` for the gate's own
   *  manifest, `agent` / `human` for a proposal. Absent on an older kernel or a legacy row. */
  readonly origin?: 'import' | 'agent' | 'human';
  /** Review #493 on #583 (`OperationSummaryWire.draftDigest`): on a draft only — which content
   *  this row shows, handed back to discard / publish so a draft revised since is refused. */
  readonly draftDigest?: string;
  /** S11 「门确认不存在」 A (`OperationSummaryWire.absentAnswers`): on an observe Operation that
   *  declares them, the target's answers that mean "does not exist". */
  readonly absentAnswers?: OperationAbsentAnswersWire;
  /** S11 「门确认不存在」 B-a (`OperationSummaryWire.absentAnswersReview`): on a published version
   *  declaring them, who confirmed at publish that the gate's credentials can see what it looks up,
   *  and when. Absent on a draft and on a version published before the confirmation existed. */
  readonly absentAnswersReview?: OperationAbsentAnswersReviewWire;
}

/** S11 「门确认不存在」 A: what an observe Operation's declaration means, in a sentence — the
 *  catalog's detail line for `OperationCatalogRow.absentAnswers`. */
export function absentAnswersText(answers: OperationAbsentAnswersWire, t: Translate): string {
  const or = t(' 或 ', ' or ');
  if ('statuses' in answers) {
    const statuses = answers.statuses.join(or);
    return t(
      `目标回答 ${statuses} 时，表示要查的东西不存在：这次观察记为“不存在”，不算调用失败。`,
      `When the target answers ${statuses}, the thing looked up does not exist: the observation is recorded as “not there”, not as a failed call.`,
    );
  }
  const codes = answers.exitCodes.join(or);
  return t(
    `命令以退出码 ${codes} 结束时，表示要查的东西不存在：这次观察记为“不存在”，不算调用失败。`,
    `When the command exits with ${codes}, the thing looked up does not exist: the observation is recorded as “not there”, not as a failed call.`,
  );
}

/** S11 「门确认不存在」 B-a: when the target gives one of the declared answers, as a clause —
 *  「目标回答 404 或 410 时」, 「命令以退出码 4 结束时」 — the same wording as `absentAnswersText`. */
export function absentAnswersWhenText(answers: OperationAbsentAnswersWire, t: Translate): string {
  const or = t(' 或 ', ' or ');
  if ('statuses' in answers) {
    const statuses = answers.statuses.join(or);
    return t(`目标回答 ${statuses} 时`, `when the target answers ${statuses}`);
  }
  const codes = answers.exitCodes.join(or);
  return t(`命令以退出码 ${codes} 结束时`, `when the command exits with ${codes}`);
}

/** The publisher's side of it: the target gives those answers only when the thing is not there —
 *  「只有它不存在时，目标才会回答 404」, 「只有它不存在时，命令才会以退出码 4 结束」. */
export function absentAnswersOnlyWhenText(
  answers: OperationAbsentAnswersWire,
  t: Translate,
): string {
  const or = t(' 或 ', ' or ');
  if ('statuses' in answers) {
    const statuses = answers.statuses.join(or);
    return t(
      `只有它不存在时，目标才会回答 ${statuses}`,
      `the target answers ${statuses} only when it is not there`,
    );
  }
  const codes = answers.exitCodes.join(or);
  return t(
    `只有它不存在时，命令才会以退出码 ${codes} 结束`,
    `the command exits with ${codes} only when it is not there`,
  );
}

/** Why such an answer can prove nothing, by what the binding declares (review #501 on #757): an
 *  http target may answer 404 for no permission (hiding the resource), a wrong address or a
 *  misconfigured proxy; a command may exit the same way for no permission (`ls`, `stat`) or for any
 *  other failure (`kubectl` exits 1 on every error). */
export function absentAnswersCaveatText(answers: OperationAbsentAnswersWire, t: Translate): string {
  if ('statuses' in answers) {
    return t(
      '有的目标在没有权限（为隐藏资源回 404）、地址或代理配错时也会这样回答，那时它证明不了任何东西。',
      'Some targets answer the same way for no permission (a 404 that hides the resource), a wrong address or a misconfigured proxy, and then it proves nothing.',
    );
  }
  return t(
    '有的命令没有权限时也以同样的退出码结束（比如 ls、stat），有的出任何错都这样结束（比如 kubectl 出错都退出 1），那时它证明不了任何东西。',
    'Some commands exit the same way without permission (ls, stat, for example), and some on any error (kubectl exits 1 on every error), and then it proves nothing.',
  );
}

/** The publisher's side of the same caveat: what does not give the answer —
 *  「没权限、地址或代理配错时不会这样回答」, 「没权限或命令出别的错时不会用这个退出码」. */
export function absentAnswersNotForText(answers: OperationAbsentAnswersWire, t: Translate): string {
  if ('statuses' in answers) {
    return t(
      '没权限、地址或代理配错时不会这样回答',
      'never for no permission, a wrong address or a misconfigured proxy',
    );
  }
  return t(
    '没权限或命令出别的错时不会用这个退出码',
    'never for no permission or any other failure of the command',
  );
}

/** The stable identity of an Operation row — no dedicated id column exists (see
 *  `OperationCatalogRow`'s own doc comment), so every list/lookup in the UI keys off this pair
 *  instead of a fabricated `id`. */
export function operationKey(row: Pick<OperationCatalogRow, 'gatekeeperId' | 'name'>): string {
  return `${row.gatekeeperId}::${row.name}`;
}

/** The catalog's selection key for the pending revision of a published Operation: the draft shares
 *  `operationKey` with the version in effect, so the catalog tells the two apart (`CatalogPage`'s
 *  `catalogOperationKey`). Legacy K: an alignment's revision drafts link here to be published. */
export function revisionDraftKey(row: Pick<OperationCatalogRow, 'gatekeeperId' | 'name'>): string {
  return `${operationKey(row)}@draft`;
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
  /** The proposer's principal id. The owner and builders see every draft (D-26 rule), so the
   *  catalog shows whose draft it is; optional only so older fixtures still type-check. */
  readonly proposedBy?: string;
  /** A draft's content digest (review #493 on #764, F1): `publish_skill` names it, so a draft
   *  discarded and proposed again under the same version since is refused (409 `draft_changed`),
   *  not published in place of the one reviewed. Absent on a published / deprecated row. */
  readonly draftDigest?: string;
  /** UX acceptance of #764 (P2-1): on a draft row, the family's latest published version — the one
   *  Workers mount until the draft is published. */
  readonly inUse?: Omit<SkillRow, 'inUse'>;
}

/** `list_procedures` (same handler file, `listProceduresHandler`) — verified. */
export interface ProcedureRow {
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly name: string;
  readonly description: string;
  readonly steps?: readonly unknown[];
  /** S11 GO5d-2: the parameters schema a goal made from it is proposed with; `null` / absent: it
   *  takes none. */
  readonly parameters?: Readonly<Record<string, unknown>> | null;
  /** As `SkillRow.proposedBy`. */
  readonly proposedBy?: string;
  /** As `SkillRow.draftDigest`, for `publish_procedure`. */
  readonly draftDigest?: string;
  /** As `SkillRow.inUse`: the version a goal made from it uses until the draft is published. */
  readonly inUse?: Omit<ProcedureRow, 'inUse'>;
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
  /** The provider's health as llm-proxy last wrote it (console audit P0-2); absent = unknown. */
  readonly health?: ProviderHealthWire;
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

/** `ActionRequestRowLike` (lib/action-card.ts, unchanged) plus the decision fields above and why
 *  an unfinished row waits (`lib/action-outcome`, legacy 287) — what `ApprovalQueuePage` /
 *  `TaskDetail`'s linked approvals render. Named `Row` rather than `Wire` because the older
 *  `ActionRequestRowLike` is deliberately looser than the wire schema (every field beyond the S2.10
 *  set optional, so an older row shape still renders). */
export type ActionRequestRow = ActionRequestRowLike &
  ActionRequestDecisionFields &
  ActionWaitingFields;
