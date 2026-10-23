import type {
  Operation,
  OperationStatus,
  PrincipalKind,
  PublishableStatus,
  Role,
} from '@nexttime/shared';
import {
  IllegalTransition,
  OPERATION_NAME_MAX,
  OPERATION_TRANSITIONS,
  type OperationNameProblem,
  UNSTORABLE_CHAR,
  UnstorableTextError,
  findUnstorableText,
  operationNameProblem,
  storableText,
  transition,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  type GraphReadViewer,
  operationDraftHiddenSql,
  operationDraftVisibleTo,
} from '../../substrate/graph/index.js';
import type { OperationOrigin } from '../../substrate/ontology/index.js';
import {
  deprecatePublishedOperationObjects,
  registerOperationDraftObject,
  setOperationDescriptionObject,
  setOperationGovernanceFieldsObject,
  setOperationStatusObject,
} from '../../substrate/ontology/index.js';
import { type PublishActor, assertPublishAuthority, seesEveryDraft } from '../capability/index.js';
import { assertDraftCredentialsReviewed, quotedName } from '../redaction/index.js';
import {
  operationContentDigest,
  operationDefinitionDiffers,
  operationDraftDigest,
  operationRecordDigestOrNull,
} from './definition.js';
import {
  type GateOwnedParamDraft,
  assertNoGateOwnedParams,
  gateOwnedParamsOfDefinition,
} from './gate-owned-params.js';

/**
 * governance/gatekeepers/manifest: Operation manifest import (draft) + publish/deprecate (design
 * doc §5.1.4 InterfaceManifest/Operation, §5.4 I16/I17, §5.5 `draft -> published -> deprecated`;
 * docs/development-tasks.md S2.4 "propose_operation 产草稿，owner 发布"). Owns the
 * transition-checking policy `substrate/ontology/meta-objects.ts`'s Object-projection helpers
 * deliberately do not (see that file's own doc comment).
 *
 * **Draft isolation (review 2026-09, P0 — docs/development-tasks.md S2.4 "实现说明补充")**: the
 * original "upsert as draft" wording let any `propose_operation` caller write over *any* row with
 * the same `{gatekeeperId, name}` identity — including a `published` one (demoting it to draft and
 * rewriting `mode`/`blast_radius`/`auto_approvable`, which the owner's next `publish_manifest` then
 * republished). The contract is now:
 *
 *   - `proposeOperation` (Handle channel) creates a new draft, or replaces the caller's *own*
 *     `'agent'`/`'human'`-origin draft; anything else with that identity — a `published` or
 *     `deprecated` row, another Principal's draft, an `'import'` draft, a legacy draft with no
 *     recorded proposer — is an `OperationIdentityConflictError` (HTTP 409 / WS
 *     ILLEGAL_TRANSITION), and the existing row is untouched (I16 "修改他人草稿一律拒绝").
 *   - `importManifest` (owner/CLI/`create_connection`) writes `'import'`-origin drafts, replacing
 *     any existing draft for the same name, and never touches a `published`/`deprecated` row —
 *     those names are returned as `skipped` so the caller can see them.
 *   - `publishManifest` bulk-publishes `'import'`-origin drafts only; an agent's proposal is
 *     published one at a time by an owner through `publishOperation`, whose handler returns the
 *     draft's full definition so the owner sees exactly what is being published.
 *
 * Every draft carries `origin` + `proposedBy`/`proposedByKind` in its properties; the atomic
 * conditional write these rules are enforced through is `registerOperationDraftObject`'s
 * `ON CONFLICT DO UPDATE ... WHERE` (its doc comment explains why the generic graph upsert could
 * not express this). The pre-reads below exist to name the *reason* in the error, not as the
 * guard itself.
 *
 * **Revision versioning (S3.12, closing docs/runbooks/web-console.md known-gap #11 / the
 * development-tasks.md S3.12 note: "propose_operation ... 因此对任何刚导入的 Operation 都会撞上
 * OperationIdentityConflictError ... 无论目标当前是 draft 还是 published")**: the draft-isolation
 * rule above was correct but incomplete — a `published`/`deprecated` row was never demoted, but
 * there was also no way *forward* from `published` back to a new draft, so classification could
 * never actually be revised once live, only frozen. The Operation identity gained a `version`
 * (`substrate/ontology/meta-objects.ts`'s `OperationIdentity`, `{gatekeeperId, name, version}` —
 * same convention `WorkerDefinition`/`Skill`/`Procedure` already use), and the contract above
 * gains one more branch:
 *
 *   - `proposeOperation` against an identity whose *current* row is `published` opens a **new**
 *     draft at `version = published.version + 1`, carrying `draftOf = <published row's Object id>`
 *     — the published row is never touched by this (I17: it stays live, visible, and unchanged
 *     until an owner explicitly publishes the revision). A second proposal against the *same*
 *     identity while that revision draft is pending follows the existing draft rules exactly (own
 *     proposer replaces it in place; anyone else gets `OperationIdentityConflictError` naming the
 *     draft, never its content) — the published row is not re-consulted once a draft exists.
 *   - `publishOperation` on a revision draft publishes it (draft → published, unchanged
 *     transition) **and**, in the same transaction, deprecates the row it supersedes. Since R-08
 *     (review 2026-10-02) that is every row of the identity still `published` at the moment of
 *     the call — normally exactly the row its `draftOf` names — rather than only the `draftOf`
 *     row: an `importManifest` over a pending revision draft used to drop `draftOf`, and the
 *     publish that followed left two `published` rows. A superseded row someone already
 *     deprecated directly is simply not matched (publishing the revision must not throw over it —
 *     `OPERATION_TRANSITIONS` has no `deprecated → deprecate` edge, by design). The superseded
 *     row's Object id comes back as the published record's own `supersedes` (only ever set on
 *     `publishOperation`'s return value, never persisted) —
 *     `application/gateway/operation-manifest-handlers.ts` records it on the publish Activity's
 *     `metadata` for audit/explain.
 *   - Every read that used to assume "one row per identity" (`getOperation`, `getPublishedOperation`,
 *     the `list*`/`find_*` helpers below) is unaffected in its external contract: at most one row
 *     per identity is ever `draft` and at most one is ever `published` at a time (the published
 *     half is enforced by the database since R-08: the deferred
 *     `objects_operation_single_published` constraint, migrations/core/0034), so "the current
 *     draft"/"the current published version" stay well-defined single answers — `getOperation`
 *     picks whichever of those exists (draft first, since a pending revision is what a second
 *     `propose_operation`/`import_manifest` call must react to), falling back to the most recent
 *     `deprecated` row so a fully-retired identity still names *a* status in a conflict error.
 *     `deprecateOperation` deliberately does **not** use that draft-first priority — it targets the
 *     live `published` row directly (a human must be able to retire the current version even while
 *     a revision draft is under review).
 */

export interface OperationRecord {
  /** The Operation Object's own id — `substrate/ontology`'s graph row id, not part of the
   *  `{gatekeeperId, name, version}` identity itself but the stable reference a revision draft's
   *  `draftOf` (and a publish's `supersedes`) point at. */
  readonly id: string;
  readonly gatekeeperId: string;
  readonly name: string;
  /** S3.12: starts at 1, increments by one per revision (see the module doc comment above) —
   *  defaults to `1` for a row written before this field existed (there was only ever one version
   *  possible then, so that default is exact, not a guess). */
  readonly version: number;
  readonly operation: Operation;
  readonly status: PublishableStatus;
  /** Which channel wrote the current draft (`substrate/ontology`'s `OperationOrigin`). Absent on
   *  rows written before drafts carried an origin — such a row is treated as nobody's draft:
   *  `publishManifest` skips it and `proposeOperation` refuses to replace it. */
  readonly origin?: OperationOrigin;
  /** The Principal that wrote the current draft — the `on_behalf_of` human for a Handle caller
   *  (I13), never a session id of its own. Absent on rows written before this was recorded. */
  readonly proposedBy?: { readonly id: string; readonly kind: PrincipalKind };
  /** S3.12: set only on a revision draft — the Object id of the `published` row it was proposed
   *  against (see the module doc comment above). */
  readonly draftOf?: string;
  /** S3.12: set **only** on `publishOperation`'s own return value, and only when that specific
   *  call actually deprecated a prior published version — never persisted on any row, never
   *  present on any other read path's records (`getOperation`, `listOperations`, ...). */
  readonly supersedes?: string;
}

/** The bookkeeping keys `registerOperationDraftObject` stores alongside the manifest entry in
 *  `properties` — stripped back out of `OperationRecord.operation` here so what agents see through
 *  `list_allowed_operations` (and what `request_action` reads policy inputs from) is exactly the
 *  `Operation` shape, with the proposer identity/revision bookkeeping surfaced only as
 *  `OperationRecord`'s own dedicated fields. */
const OPERATION_BOOKKEEPING_KEYS = [
  'status',
  'origin',
  'proposedBy',
  'proposedByKind',
  'version',
  'draftOf',
] as const;

function isOperationOrigin(value: unknown): value is OperationOrigin {
  return value === 'import' || value === 'agent' || value === 'human';
}

function toOperationRecord(
  gatekeeperId: string,
  name: string,
  id: string,
  properties: Record<string, unknown>,
): OperationRecord {
  const operationFields: Record<string, unknown> = { ...properties };
  for (const key of OPERATION_BOOKKEEPING_KEYS) delete operationFields[key];
  const status = properties.status as PublishableStatus | undefined;
  const proposedById = properties.proposedBy;
  const proposedByKind = properties.proposedByKind;
  const version = typeof properties.version === 'number' ? properties.version : 1;
  const draftOf = typeof properties.draftOf === 'string' ? properties.draftOf : undefined;
  return {
    id,
    gatekeeperId,
    name,
    version,
    operation: operationFields as unknown as Operation,
    status: status ?? 'draft',
    ...(draftOf !== undefined ? { draftOf } : {}),
    ...(isOperationOrigin(properties.origin) ? { origin: properties.origin } : {}),
    ...(typeof proposedById === 'string' && typeof proposedByKind === 'string'
      ? { proposedBy: { id: proposedById, kind: proposedByKind as PrincipalKind } }
      : {}),
  };
}

export class OperationNotFoundError extends Error {
  constructor(gatekeeperId: string, name: string) {
    super(`Operation not found: gatekeeper ${gatekeeperId}, name ${quotedName(name)}`);
    this.name = 'OperationNotFoundError';
  }
}

/**
 * Thrown by `proposeOperation` when an Operation with the same `{gatekeeperId, name}` identity
 * has a *draft* that is not the caller's own `'agent'`/`'human'` draft — another Principal's
 * draft, an `'import'` draft, a legacy draft with no recorded proposer (I16), or (unchanged edge
 * case, S3.12) a fully `deprecated` identity with no live version at all. Never thrown for a
 * `published` row on its own since S3.12 — that opens a revision draft instead (see the module
 * doc comment). Maps to HTTP 409 `conflict` / WS `ILLEGAL_TRANSITION`
 * (interfaces/http/capability-route.ts, interfaces/ws/rpc.ts): the request is well-formed, the
 * row's *state* forbids it — the same reasoning as `IllegalTransition`. The message names the
 * existing row's status, never its proposer or its content.
 */
export class OperationIdentityConflictError extends Error {
  readonly existingStatus: OperationStatus;
  constructor(gatekeeperId: string, name: string, existingStatus: OperationStatus) {
    super(
      `Operation ${quotedName(name)} on gatekeeper ${gatekeeperId} already exists (status: ${existingStatus}) — a proposal may only create a new draft or revise the proposer’s own draft`,
    );
    this.name = 'OperationIdentityConflictError';
    this.existingStatus = existingStatus;
  }
}

/**
 * Review #493 on #583 (P2): the draft named by `{gatekeeperId, name, version}` is no longer the one
 * the caller looked at — revised in place since (its proposer re-proposing, a gate re-import, an
 * align rewriting the gate's own draft), so its `operationDraftDigest` differs from the
 * `draftDigest` sent. Nothing was written; the caller reloads and decides on what is there now.
 */
export class OperationDraftChangedError extends Error {
  readonly code = 'draft_changed' as const;
  constructor(gatekeeperId: string, name: string, version: number) {
    super(
      `Operation ${quotedName(name)} v${version} on gatekeeper ${gatekeeperId} changed after it was read (draftDigest differs) — nothing was written; reload it and look again`,
    );
    this.name = 'OperationDraftChangedError';
  }
}

/** Refuses with `OperationDraftChangedError` unless `expected` is `record`'s current draft digest. */
function assertDraftUnchanged(record: OperationRecord, expected: string): void {
  if (operationDraftDigest(record) !== expected) {
    throw new OperationDraftChangedError(record.gatekeeperId, record.name, record.version);
  }
}

/**
 * Review #493 on #583 (P3): the status of exactly `{gatekeeperId, name, version}`, discarded
 * included — what a conditional write that lost a race reports as blocking it. `getOperation`
 * leaves a discarded row out and so could not say which row refused the write.
 */
async function operationStatusAt(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
  name: string,
  version: number,
): Promise<OperationStatus | null> {
  const result = await client.query<{ status: OperationStatus | null }>(
    `select properties ->> 'status' as status
     from objects
     where workspace_id = $1
       and object_type = 'Operation'
       and identity_key ->> 'gatekeeperId' = $2
       and identity_key ->> 'name' = $3
       and coalesce((properties ->> 'version')::int, 1) = $4
     limit 1`,
    [workspaceId, gatekeeperId, name, version],
  );
  const row = result.rows[0];
  return row ? (row.status ?? 'draft') : null;
}

// -------------------------------------------------------------------------------------------
// importManifest / proposeOperation — always produce drafts (I16), never touch a published row.
// -------------------------------------------------------------------------------------------

export interface ImportManifestInput {
  readonly gatekeeperId: string;
  readonly operations: readonly Operation[];
  readonly proposedBy: { readonly id: string; readonly kind: PrincipalKind };
  readonly activityId: string;
  /**
   * S8 W2-K1 (leftover 71/72, audit CO1: "12 个 Operation 描述全空 ... find_operations 自然语言检索
   * 落空的原因之一"). When `true`, every entry in `input.operations` must carry a non-blank
   * `description` or the whole call throws {@link OperationDescriptionRequiredError} *before*
   * writing anything (atomic — no partial import).
   *
   * Deliberately **opt-in, not the default**, even though the audit's own wording reads as an
   * unconditional rule: a dynamically-imported OpenAPI/MCP/announced manifest is not always under
   * this platform's control, and rejecting a real user's legitimate system over a missing
   * description string would turn a P2 documentation debt into a P0 "cannot connect anything"
   * regression. The one caller that set it — the operator CLI `register-gatekeeper`, for this
   * repo's hand-curated `gatekeepers/<system>/manifest.json` packages — was removed by P0b (S10 W2):
   * every manifest now comes in through the landing (`application/gates/landing.ts`), from a gate's
   * announcement or a live connection, and none sets it. Kept as the check a catalog-side
   * requirement would reuse (P1's change plan), not as a live rule.
   */
  readonly requireDescription?: boolean;
}

/** Legacy 232 (review #493): a *new* Operation name that breaks `operationNameProblem`'s rule
 *  (`@nexttime/shared`) — empty, longer than `OPERATION_NAME_MAX`, or carrying an invisible or
 *  reordering character (an agent could otherwise dress a draft's name up on the approval card).
 *  Thrown by `proposeOperation` and, before any write, by `importManifest`. A name already on file
 *  is never refused by this (it keeps working and is escaped where shown). 400 `invalid_operation_name`. */
export class OperationNameInvalidError extends Error {
  readonly code = 'invalid_operation_name' as const;
  readonly details: { readonly problem: OperationNameProblem; readonly maxLength: number };
  constructor(operationName: string, problem: OperationNameProblem) {
    const why =
      problem === 'empty'
        ? 'is empty'
        : problem === 'too_long'
          ? `is longer than ${OPERATION_NAME_MAX} characters`
          : 'carries a control, invisible or text-reordering character';
    super(
      `Operation name ${quotedName(operationName)} ${why} — nothing was written. Use a visible name of at most ${OPERATION_NAME_MAX} characters.`,
    );
    this.name = 'OperationNameInvalidError';
    this.details = { problem, maxLength: OPERATION_NAME_MAX };
  }
}

/** Refuses `name` for a new identity (`existing === null`); a name already on file passes. */
function assertNewOperationNameAllowed(name: string, existing: OperationRecord | null): void {
  if (existing !== null) return;
  const problem = operationNameProblem(name);
  if (problem !== undefined) throw new OperationNameInvalidError(name, problem);
}

/** Thrown by `importManifest` when `input.requireDescription` is set and `operationName` has no
 *  (or a blank/whitespace-only) `description` — CO1's "manifest 导入时要求描述" reject, naming the
 *  offending Operation so the caller can fix its manifest entry directly. */
export class OperationDescriptionRequiredError extends Error {
  readonly operationName: string;
  constructor(operationName: string) {
    super(
      `import_manifest: Operation ${quotedName(operationName)} has no description — every imported Operation must declare a non-blank description (CO1)`,
    );
    this.name = 'OperationDescriptionRequiredError';
    this.operationName = operationName;
  }
}

export interface SkippedOperation {
  readonly name: string;
  /** `published`, `deprecated` or `discarded` — the row `importManifest` refused to write over. */
  readonly status: OperationStatus;
}

export interface ImportManifestResult {
  /** The `'import'`-origin drafts written (new, or replacing an existing draft of any origin). */
  readonly imported: readonly OperationRecord[];
  /** Names whose row is `published`/`deprecated` and was therefore left exactly as it was. */
  readonly skipped: readonly SkippedOperation[];
}

/**
 * Legacy 320: one manifest entry made storable, or refused. A manifest comes from outside the
 * kernel (a gate's `describe_operations`, an OpenAPI document, an MCP `tools/list`, a hand-written
 * 接入包), and Postgres cannot store U+0000. Its `description` is prose for a reader, so U+0000
 * there is stored as the visible `\u{0}`; every other field — the name, the binding the gate runs,
 * the params schema's keys, the ObjectTypes it reads and writes — is something the kernel or the
 * gate acts on, so U+0000 there refuses the import before any write: a name by the name rule
 * (`OperationNameInvalidError`, as any other control character — and without the lookup that
 * would itself fail on it), anything else by `UnstorableTextError`.
 */
export function storableManifestOperation(operation: Operation): Operation {
  if (operation.name.includes(UNSTORABLE_CHAR)) {
    throw new OperationNameInvalidError(operation.name, 'invisible_or_control_characters');
  }
  const { description, ...acted } = operation;
  const unstorable = findUnstorableText(acted);
  if (unstorable !== undefined) {
    throw new UnstorableTextError(
      `import_manifest: Operation ${quotedName(operation.name)}`,
      unstorable,
      'the field',
    );
  }
  return description?.includes(UNSTORABLE_CHAR)
    ? { ...operation, description: storableText(description) }
    : operation;
}

/** Imports a whole manifest (e.g. from `importOpenApi`/`importMcpTools`, or a hand-written YAML
 *  接入包) as `'import'`-origin draft Operation Objects — one per entry, all `status: 'draft'`
 *  regardless of the transport's own suggested defaults (I17: nothing is auto-approvable until an
 *  owner reviews and publishes it). A name whose row is already `published`/`deprecated` is never
 *  written (an import must not silently demote or rewrite a reviewed Operation) — it is reported
 *  in `skipped`; a name whose row is currently a draft of *any* origin (including a pending S3.12
 *  revision draft against an already-published version — `importManifest`'s "owner/CLI is the
 *  authority over the manifest" rule predates and is unchanged by revisions) is replaced by the
 *  gate's own declaration, *at that draft's own version* (the target slot, computed from the same
 *  `getOperation` priority `proposeOperation` below uses, is whichever version currently occupies
 *  it — draft if one exists, else the next fresh version — the conditional write's own
 *  draft-only guard is what actually decides whether the write lands, exactly as before this
 *  version dimension existed).
 *
 *  R-08 (review 2026-10-02): replacing a revision draft keeps it a revision. The conditional
 *  write replaces `properties` wholesale, so the draft's `draftOf` is passed again — carried
 *  forward from the draft, or, when the draft has none, taken from the identity's live
 *  `published` row (a draft an earlier import already stripped). Publishing the imported version
 *  then supersedes that row instead of leaving it live beside the new one. */
export async function importManifest(
  client: PoolClient,
  workspaceId: string,
  input: ImportManifestInput,
): Promise<ImportManifestResult> {
  const operations = input.operations.map(storableManifestOperation);
  if (input.requireDescription) {
    // Validated up front, before any write — a manifest with one bad entry imports nothing
    // rather than a confusing partial import (same "reject atomically" shape `manifest.ts`'s own
    // draft-isolation conditional writes already use elsewhere in this file).
    for (const operation of operations) {
      if (!operation.description || operation.description.trim().length === 0) {
        throw new OperationDescriptionRequiredError(operation.name);
      }
    }
  }

  // Legacy 232: a new name breaking the name rule imports nothing (same atomic shape as above).
  for (const operation of operations) {
    if (operationNameProblem(operation.name) === undefined) continue;
    assertNewOperationNameAllowed(
      operation.name,
      await getOperation(client, workspaceId, input.gatekeeperId, operation.name),
    );
  }

  const imported: OperationRecord[] = [];
  const skipped: SkippedOperation[] = [];
  for (const operation of operations) {
    const existing = await getOperation(client, workspaceId, input.gatekeeperId, operation.name);
    // Legacy 278: a fresh draft takes the next version above every row, discarded ones included.
    const version =
      existing?.version ??
      (await nextOperationVersion(client, workspaceId, input.gatekeeperId, operation.name));
    // Only a draft can be replaced (a published/deprecated row is skipped below), and only a
    // draft can be a revision of the live row — see the R-08 note in the doc comment above.
    let draftOf: string | undefined;
    if (existing?.status === 'draft') {
      draftOf =
        existing.draftOf ??
        (await getPublishedOperation(client, workspaceId, input.gatekeeperId, operation.name))?.id;
    }
    const written = await registerOperationDraftObject(client, workspaceId, {
      gatekeeperId: input.gatekeeperId,
      name: operation.name,
      version,
      draftOf,
      operation,
      proposedBy: input.proposedBy,
      activityId: input.activityId,
      origin: 'import',
    });
    if (!written) {
      // The conditional write refused: the row at this version exists and is not a draft (it may
      // have been discarded since the pre-read). Read that exact row back to report its status.
      const blocked = await operationStatusAt(
        client,
        workspaceId,
        input.gatekeeperId,
        operation.name,
        version,
      );
      skipped.push({ name: operation.name, status: blocked ?? 'published' });
      continue;
    }
    imported.push({
      id: written.operationObjectId,
      gatekeeperId: input.gatekeeperId,
      name: operation.name,
      version,
      operation,
      status: 'draft',
      origin: 'import',
      proposedBy: input.proposedBy,
      ...(draftOf !== undefined ? { draftOf } : {}),
    });
  }
  return { imported, skipped };
}

export interface ProposeOperationInput {
  readonly gatekeeperId: string;
  readonly operation: Operation;
  readonly proposedBy: { readonly id: string; readonly kind: PrincipalKind };
  readonly activityId: string;
}

/** `propose_operation` (capabilities.ts `meta` group; also `report_task_result`'s
 *  `proposedOperations[]`): an agent that explored a Gatekeeper proposes one concrete, classified
 *  Operation as a draft. Three outcomes, decided by the identity's *current* row (module doc
 *  comment has the full rule):
 *
 *   1. No current row, or the current row is the caller's own `'agent'`/`'human'` draft — creates
 *      (or in-place revises) that draft, unchanged from before S3.12.
 *   2. The current row is a *conflicting* draft (another Principal's, an `'import'` draft, or a
 *      legacy draft with no recorded proposer) — `OperationIdentityConflictError`, row untouched.
 *   3. The current row is `published` (S3.12) — opens a **new** draft one version above it,
 *      `draftOf` pointing at the published row; the published row itself is never touched.
 *
 *  A fully `deprecated` identity (no live draft or published row) falls back to outcome 2 — the
 *  existing pre-S3.12 behavior for that edge case, unchanged here.
 *
 *  `proposedBy.kind` decides the draft's `origin` (`'human'` for a human caller of this
 *  Handle-channel capability, `'agent'` otherwise). */
export async function proposeOperation(
  client: PoolClient,
  workspaceId: string,
  input: ProposeOperationInput,
): Promise<OperationRecord> {
  const { gatekeeperId } = input;
  const name = input.operation.name;

  // Pre-read: decides which of the three outcomes above this call is, and names the existing
  // row's status in a conflict error. Not the guard — the conditional write below is (two
  // dispatch transactions may interleave between this read and that write).
  const existing = await getOperation(client, workspaceId, gatekeeperId, name);
  const refusal = proposalRefusalFor(name, existing, input.proposedBy.id);
  if (refusal?.reason === 'invalid_operation_name') {
    throw new OperationNameInvalidError(name, refusal.problem);
  }
  if (refusal?.reason === 'operation_identity_conflict') {
    // A conflicting draft, or a fully `deprecated` identity — unchanged pre-S3.12 rule.
    throw new OperationIdentityConflictError(gatekeeperId, name, refusal.existingStatus);
  }

  let version: number;
  let draftOf: string | undefined;
  if (existing === null) {
    // Legacy 278: `1`, unless every earlier draft of this identity was discarded.
    version = await nextOperationVersion(client, workspaceId, gatekeeperId, name);
  } else if (existing.status === 'published') {
    // `existing.version + 1`, unless a revision draft above it was discarded (legacy 278).
    version = await nextOperationVersion(client, workspaceId, gatekeeperId, name);
    draftOf = existing.id;
  } else if (isOwnProposalDraft(existing, input.proposedBy.id)) {
    version = existing.version;
    // Carry the existing draft's own `draftOf` forward (bug caught in CI review before merge):
    // `registerOperationDraftObject`'s conditional write replaces `properties` wholesale, not
    // merges it, so leaving this `undefined` here would silently drop a pending revision draft's
    // `draftOf` the moment its own proposer revises it a second time — `undefined` is only ever
    // correct here for a fresh (non-revision) draft, which never had one to begin with.
    draftOf = existing.draftOf;
  } else {
    // Unreachable: `proposalRefusalFor` refused every other current row above.
    throw new OperationIdentityConflictError(gatekeeperId, name, existing.status);
  }

  const origin: OperationOrigin = input.proposedBy.kind === 'human' ? 'human' : 'agent';
  const written = await registerOperationDraftObject(client, workspaceId, {
    gatekeeperId,
    name,
    version,
    draftOf,
    operation: input.operation,
    proposedBy: input.proposedBy,
    activityId: input.activityId,
    origin,
    onlyOwnDraftOf: input.proposedBy.id,
  });
  if (!written) {
    // Lost a race with a concurrent write on the same identity/version (the row changed between
    // the pre-read and the conditional write); report what that exact row is now — a discard in
    // between reads as `discarded`, which the "Operation now" reads leave out.
    const current = await operationStatusAt(client, workspaceId, gatekeeperId, name, version);
    throw new OperationIdentityConflictError(gatekeeperId, name, current ?? 'draft');
  }

  return {
    id: written.operationObjectId,
    gatekeeperId,
    name,
    version,
    operation: input.operation,
    status: 'draft',
    origin,
    proposedBy: input.proposedBy,
    ...(draftOf !== undefined ? { draftOf } : {}),
  };
}

/** Why `proposeOperation` would refuse a proposal of `name` by `proposerId`, read from the
 *  identity's current row: a new identity whose name breaks the name rule (legacy 232), or a row
 *  the proposer may not write over (outcome 2 above — a conflicting draft or a fully `deprecated`
 *  identity). `undefined` means it would write. */
export type OperationProposalRefusal =
  | { readonly reason: 'invalid_operation_name'; readonly problem: OperationNameProblem }
  | { readonly reason: 'operation_identity_conflict'; readonly existingStatus: OperationStatus };

/** The one decision `proposeOperation` makes before writing, shared with
 *  `operationProposalRefusal` so a pre-check and the write can never disagree. */
function proposalRefusalFor(
  name: string,
  existing: OperationRecord | null,
  proposerId: string,
): OperationProposalRefusal | undefined {
  if (existing === null) {
    const problem = operationNameProblem(name);
    return problem !== undefined ? { reason: 'invalid_operation_name', problem } : undefined;
  }
  if (existing.status === 'published' || isOwnProposalDraft(existing, proposerId)) {
    return undefined;
  }
  return { reason: 'operation_identity_conflict', existingStatus: existing.status };
}

/** Review #493 on #593 (M1): what `proposeOperation` would refuse, asked before anything is
 *  written — `report_task_result` turns each refusal into a recorded per-entry rejection
 *  (`worker-result-handler.ts`'s `validateContract`) instead of losing the whole contract. Reads
 *  the same row `proposeOperation` reads; a concurrent write in between is still the write's own
 *  conditional guard to refuse. */
export async function operationProposalRefusal(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
  name: string,
  proposerId: string,
): Promise<OperationProposalRefusal | undefined> {
  const existing = await getOperation(client, workspaceId, gatekeeperId, name);
  return proposalRefusalFor(name, existing, proposerId);
}

/** The one shape `proposeOperation` may replace: a `draft` the same Principal wrote through
 *  `propose_operation` itself (`origin` `'agent'`/`'human'`). An `'import'` draft is the gate's own
 *  declaration, not a proposer's private draft, so it is excluded even when `proposedBy` matches
 *  (the owner who completed the connection is also the `on_behalf_of` of their own entry agent). */
function isOwnProposalDraft(record: OperationRecord, principalId: string): boolean {
  return (
    record.status === 'draft' &&
    (record.origin === 'agent' || record.origin === 'human') &&
    record.proposedBy?.id === principalId
  );
}

// -------------------------------------------------------------------------------------------
// reads
// -------------------------------------------------------------------------------------------

/**
 * Legacy 278: a `discarded` row (`discardOperationDraft`) is kept — its `exposes` Fact and
 * provenance point at it — but it is no longer part of the Operation: every read below that answers
 * "what is this Operation now" (`getOperation`, the directory, the per-gate count) leaves it out.
 * The status-specific reads (`published`, `draft`) never matched it anyway. Generic graph reads
 * (`get_object`, `explain`) still find it, as private as the draft was
 * (substrate/graph/operation-draft-visibility.ts).
 */
const NOT_DISCARDED = "coalesce(properties ->> 'status', 'draft') <> 'discarded'";

/**
 * Legacy 278: the version a new draft of `(gatekeeperId, name)` takes — one above every row the
 * identity has ever had, discarded ones included, so a discarded version is never reused (and the
 * draft write's `status = 'draft'` guard never meets it). For an identity whose highest row is the
 * live `published` one this is `published.version + 1`, exactly as before.
 */
async function nextOperationVersion(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
  name: string,
): Promise<number> {
  const result = await client.query<{ next: number }>(
    `select coalesce(max(coalesce((properties ->> 'version')::int, 1)), 0) + 1 as next
     from objects
     where workspace_id = $1
       and object_type = 'Operation'
       and identity_key ->> 'gatekeeperId' = $2
       and identity_key ->> 'name' = $3`,
    [workspaceId, gatekeeperId, name],
  );
  return Number(result.rows[0]?.next ?? 1);
}

interface OperationObjectRow {
  id: string;
  identity_key: { gatekeeperId?: string; name?: string; version?: number } | null;
  properties: Record<string, unknown>;
}

/** Legacy 232 (review #493 M1): whether `(gatekeeperId, name)` has a `deprecated` row — what
 *  `getOperation` would answer were there no draft. A deprecated Operation was published once, so
 *  everyone may know it existed; a draft is private to its proposer and the reviewers (D-26). */
export async function hasDeprecatedOperation(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
  name: string,
): Promise<boolean> {
  const result = await client.query(
    `select 1
     from objects
     where workspace_id = $1
       and object_type = 'Operation'
       and identity_key ->> 'gatekeeperId' = $2
       and identity_key ->> 'name' = $3
       and properties ->> 'status' = 'deprecated'
     limit 1`,
    [workspaceId, gatekeeperId, name],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Reads the *current* row for an identity, regardless of status, or `null` if none exists at all.
 * S3.12: since a `published` row and a revision `draft` may now coexist for the same
 * `(gatekeeperId, name)`, "current" is whichever of those exists — `draft` first (a pending
 * revision is what `proposeOperation`/`importManifest` must react to), else `published`, else the
 * most recent `deprecated` row (so a fully-retired identity still names *a* status). At most one
 * `draft` and at most one `published` row ever exist per identity at a time (the latter enforced
 * by the database since R-08, migrations/core/0034), so this is still a well-defined single
 * answer, not an arbitrary pick among several live rows.
 */
export async function getOperation(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
  name: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<OperationRecord | null> {
  const result = await client.query<OperationObjectRow>(
    `select id, identity_key, properties
     from objects
     where workspace_id = $1
       and object_type = 'Operation'
       and identity_key ->> 'gatekeeperId' = $2
       and identity_key ->> 'name' = $3
       and ${NOT_DISCARDED}
     order by
       case properties ->> 'status'
         when 'draft' then 0
         when 'published' then 1
         else 2
       end,
       coalesce((properties ->> 'version')::int, 1) desc
     limit 1${options.forUpdate === true ? ' for update' : ''}`,
    [workspaceId, gatekeeperId, name],
  );
  const row = result.rows[0];
  if (!row) return null;
  return toOperationRecord(gatekeeperId, name, row.id, row.properties);
}

/**
 * `getOperation`'s current row, locked until the transaction ends — for a write in place at that
 * row's version (`updateOperationDescription`, `refreshOperationGovernance`). Review #493 on #690: a
 * publish retires the live version under that same row's lock (`publishOperation` locks the draft
 * it publishes before deprecating the live row, `publishOperationRevision` locks the live row
 * first), so a row read without the lock could be retired before the write lands, and the write
 * would edit a version nobody runs while the call reported success. Once the lock is granted the
 * current row is read again; if a publish moved it while this waited, the new current row is
 * locked instead. `null` when the identity has no row at all.
 */
async function lockCurrentOperation(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
  name: string,
): Promise<OperationRecord | null> {
  // Each pass waits only on a publish that moved the current row; three in a row is a bug.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const locked = await getOperation(client, workspaceId, gatekeeperId, name, {
      forUpdate: true,
    });
    if (!locked) return null;
    const current = await getOperation(client, workspaceId, gatekeeperId, name);
    if (current?.id === locked.id) return current;
  }
  throw new Error(
    `lockCurrentOperation: Operation ${quotedName(name)} on gatekeeper ${gatekeeperId} kept moving while it was locked`,
  );
}

/**
 * Resolves the *live* **published** Operation only — `null` for a draft, deprecated, or unknown
 * one, and (S3.12) never distracted by a pending revision draft against the same identity: a
 * dedicated query on `status = 'published'`, not `getOperation`'s draft-first "current row"
 * priority (that priority is for `proposeOperation`/`importManifest`'s own decision, not this
 * one). I17: "resolve the published Operation (draft/unknown → I17: treat as unclassified
 * require_approval, never execute)" — the caller (`request_action`'s handler) is expected to
 * treat `null` here uniformly as "unclassified", not distinguish "no such Operation" from "not
 * published yet".
 *
 * R-08: ordered newest version first, so even a database that still held two `published` rows
 * for one identity (before migrations/core/0034 healed them and made a second one impossible)
 * resolves to the newest classification, never an arbitrary pick between the two.
 */
export async function getPublishedOperation(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
  name: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<OperationRecord | null> {
  const result = await client.query<OperationObjectRow>(
    `select id, identity_key, properties
     from objects
     where workspace_id = $1
       and object_type = 'Operation'
       and identity_key ->> 'gatekeeperId' = $2
       and identity_key ->> 'name' = $3
       and properties ->> 'status' = 'published'
     order by coalesce((properties ->> 'version')::int, 1) desc
     limit 1${options.forUpdate === true ? ' for update' : ''}`,
    [workspaceId, gatekeeperId, name],
  );
  const row = result.rows[0];
  if (!row) return null;
  return toOperationRecord(gatekeeperId, name, row.id, row.properties);
}

/** Whether some Gatekeeper in the workspace publishes an Operation named `name` — what makes it
 *  an action kind a workspace-wide policy rule can name (`set_policy`, legacy 218). */
export async function isPublishedOperationName(
  client: PoolClient,
  workspaceId: string,
  name: string,
): Promise<boolean> {
  const result = await client.query(
    `select 1
     from objects
     where workspace_id = $1
       and object_type = 'Operation'
       and identity_key ->> 'name' = $2
       and properties ->> 'status' = 'published'
     limit 1`,
    [workspaceId, name],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * `list_allowed_operations` (S2.9, task brief: "the published Operations of the Gatekeepers in
 * the Handle's resources.gatekeeper scope") — every **published** Operation across a set of
 * Gatekeeper instance ids, one direct query rather than N `getOperation` round trips. Same direct-
 * SQL-over-`objects` style `substrate/graph/find-means.ts` already established for meta-ontology
 * reads (an Operation has no dedicated relational table, §9.2). Returns `[]` for an empty
 * `gatekeeperIds` (nothing to list, not "list everything").
 */
export async function listPublishedOperationsForGatekeepers(
  client: PoolClient,
  workspaceId: string,
  gatekeeperIds: readonly string[],
): Promise<readonly OperationRecord[]> {
  if (gatekeeperIds.length === 0) return [];
  const result = await client.query<OperationObjectRow>(
    `select id, identity_key, properties
     from objects
     where workspace_id = $1
       and object_type = 'Operation'
       and identity_key ->> 'gatekeeperId' = any($2::text[])
       and properties ->> 'status' = 'published'
     order by updated_at asc, id asc`,
    [workspaceId, gatekeeperIds],
  );
  const records: OperationRecord[] = [];
  for (const row of result.rows) {
    const gatekeeperId = row.identity_key?.gatekeeperId;
    const name = row.identity_key?.name;
    if (!gatekeeperId || !name) continue; // defensive — every Operation Object is upserted with both
    records.push(toOperationRecord(gatekeeperId, name, row.id, row.properties));
  }
  return records;
}

/**
 * Every currently-`draft` Operation of one Gatekeeper instance (any origin — the caller reads
 * `OperationRecord.origin` to tell an import draft from an agent proposal), single query, same
 * direct-SQL-over-`objects` style as `listPublishedOperationsForGatekeepers` above. Backs
 * `publishManifest` below; drafts stay invisible to agents (I17) because no Handle-channel
 * capability reaches this function.
 */
export async function listDraftOperationsForGatekeeper(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
): Promise<readonly OperationRecord[]> {
  const result = await client.query<OperationObjectRow>(
    `select id, identity_key, properties
     from objects
     where workspace_id = $1
       and object_type = 'Operation'
       and identity_key ->> 'gatekeeperId' = $2
       and properties ->> 'status' = 'draft'
     order by updated_at asc, id asc`,
    [workspaceId, gatekeeperId],
  );
  const records: OperationRecord[] = [];
  for (const row of result.rows) {
    const name = row.identity_key?.name;
    if (!name) continue; // defensive — every Operation Object is upserted with both identity fields
    records.push(toOperationRecord(gatekeeperId, name, row.id, row.properties));
  }
  return records;
}

/**
 * `list_operations` (S3.11, docs/development-tasks.md "中台控制面"): the human-facing Operation
 * directory — every Operation regardless of status (draft/published/deprecated all visible, so a
 * console can render the draft → published → deprecated lifecycle), optionally narrowed to one
 * Gatekeeper. Distinct from `listPublishedOperationsForGatekeepers` above (agent-facing, published
 * only, I17 "draft 对 agent 不可见") and `listDraftOperationsForGatekeeper` (drafts only, one
 * gate) — this is the human read side, where I17's visibility restriction does not apply (a human
 * operator reviewing what a Worker proposed is the point of the console's "能力目录" page).
 *
 * S3.12: one identity (`gatekeeperId` + `name`) may now project as *multiple* rows — a
 * `deprecated` superseded version alongside its `published` successor, or a `published` version
 * alongside a pending revision `draft` — each with its own `version`/`status`/`draftOf`. That is
 * deliberate here (full lifecycle history stays queryable — module doc comment's revision-
 * versioning note), unlike `listPublishedOperationsForGatekeepers`/`getPublishedOperation`, which
 * still resolve to at most one row per identity.
 *
 * Unfiltered: the human read handlers narrow drafts per caller with `operationVisibleTo` below
 * (D-26) — this function also feeds `governanceChangesForDrafts`, which needs both rows of an
 * identity.
 */
export async function listOperations(
  client: PoolClient,
  workspaceId: string,
  filter: { readonly gatekeeperId?: string } = {},
): Promise<readonly OperationRecord[]> {
  const result = filter.gatekeeperId
    ? await client.query<OperationObjectRow>(
        `select id, identity_key, properties
         from objects
         where workspace_id = $1
           and object_type = 'Operation'
           and identity_key ->> 'gatekeeperId' = $2
           and ${NOT_DISCARDED}
         order by updated_at asc, id asc`,
        [workspaceId, filter.gatekeeperId],
      )
    : await client.query<OperationObjectRow>(
        `select id, identity_key, properties
         from objects
         where workspace_id = $1
           and object_type = 'Operation'
           and ${NOT_DISCARDED}
         order by updated_at asc, id asc`,
        [workspaceId],
      );
  const records: OperationRecord[] = [];
  for (const row of result.rows) {
    const gatekeeperId = row.identity_key?.gatekeeperId;
    const name = row.identity_key?.name;
    if (!gatekeeperId || !name) continue; // defensive — every Operation Object is upserted with both
    records.push(toOperationRecord(gatekeeperId, name, row.id, row.properties));
  }
  return records;
}

/** Who is reading the Operation directory: the human caller and their workspace role. */
export interface OperationViewer {
  readonly principalId: string;
  readonly role: Role;
}

/** The graph layer's form of an Operation viewer: owner and builder review Operation drafts — the
 *  one reviewer rule every meta-ontology draft registry shares (`seesEveryDraft`,
 *  governance/capability/publish-authority.ts). */
function graphReadViewerOf(viewer: OperationViewer): GraphReadViewer {
  return { principalId: viewer.principalId, seesEveryDraft: seesEveryDraft(viewer.role) };
}

/**
 * D-26 (review 2026-10-02, L2-15): an Operation **draft** is private to its proposer (I16 —
 * `propose_operation` is "a private draft Operation"), except that the workspace's reviewers —
 * `owner` and `builder` — see every draft, because an agent's Operation proposal (a member's
 * Worker result, `proposedBy` = that member) only ever goes live through an owner's
 * `publish_operation` from the catalog. Skill and Procedure drafts follow the same rule
 * (`draftVisibleTo`, application/worker/draft-visibility.ts). Published and deprecated rows stay
 * workspace-visible. A legacy draft with no recorded proposer is nobody's draft: reviewers only.
 *
 * The rule itself lives in substrate/graph/operation-draft-visibility.ts (STATUS leftover 123), so
 * the generic graph reads (`get_object`, `search`, `traverse`, `state_at`, `explain`) hide exactly
 * the drafts this directory hides.
 */
export function operationVisibleTo(viewer: OperationViewer, record: OperationRecord): boolean {
  // `record.proposedBy` exists only when the row carried both `proposedBy` and `proposedByKind`
  // (`toOperationRecord`) — the same "recorded proposer" the SQL form requires.
  return operationDraftVisibleTo(graphReadViewerOf(viewer), {
    status: record.status,
    proposedBy: record.proposedBy?.id,
    proposedByKind: record.proposedBy?.kind,
  });
}

/** `list_gatekeepers`'s own per-gate `operationCount` (S3.11) — one grouped query over every
 *  Gatekeeper's Operations, rather than `listOperations(...).length` once per gate in a loop
 *  (N+1), and rather than fetching every Operation's full `properties` just to count them.
 *  Counts **distinct Operation identities** (`gatekeeperId` + `name`), not rows — S3.12: a single
 *  identity can now project as several rows (a `deprecated` version alongside its `published`
 *  successor, or a pending revision `draft`), and this count is meant to answer "how many
 *  Operations does this gate expose", not "how many row versions exist".
 *
 *  D-26: with a `viewer`, only rows `operationVisibleTo` would show that viewer are counted (the
 *  same rule in SQL, `operationDraftHiddenSql` — a row with no `status` reads as a draft, like
 *  `toOperationRecord`), so the count never names an identity that exists only as someone else's
 *  draft. */
export async function countOperationsByGatekeeper(
  client: PoolClient,
  workspaceId: string,
  viewer?: OperationViewer,
): Promise<ReadonlyMap<string, number>> {
  const graphViewer = viewer === undefined ? undefined : graphReadViewerOf(viewer);
  const result = await client.query<{ gatekeeper_id: string | null; count: string }>(
    `select identity_key ->> 'gatekeeperId' as gatekeeper_id,
            count(distinct identity_key ->> 'name')::bigint as count
     from objects
     where workspace_id = $1 and object_type = 'Operation'
       and ${NOT_DISCARDED}
       and not ${operationDraftHiddenSql('objects', '$2', '$3')}
     group by identity_key ->> 'gatekeeperId'`,
    [workspaceId, graphViewer?.seesEveryDraft ?? true, graphViewer?.principalId ?? null],
  );
  const counts = new Map<string, number>();
  for (const row of result.rows) {
    if (row.gatekeeper_id) counts.set(row.gatekeeper_id, Number(row.count));
  }
  return counts;
}

// -------------------------------------------------------------------------------------------
// publish / deprecate — human channel only (enforced at the capability-registry layer, I16).
// -------------------------------------------------------------------------------------------

/** Backs `publishOperation` below — draft-first (`getOperation`'s own priority), because
 *  publishing must target a pending revision draft when one exists, not the (still separately
 *  live) published row it was proposed against. */
async function requireOperation(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
  name: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<OperationRecord> {
  const record = await getOperation(client, workspaceId, gatekeeperId, name, options);
  if (!record) throw new OperationNotFoundError(gatekeeperId, name);
  return record;
}

/** Backs `deprecateOperation` below — targets the live `published` row directly, deliberately
 *  *not* `getOperation`'s draft-first priority: a human must be able to retire the current version
 *  even while a revision draft (S3.12) is sitting under review, so `deprecate_operation` must never
 *  be redirected onto that draft. Falls back to `getOperation` only to name *why* there is no
 *  published row to deprecate (unknown identity vs. draft-only vs. already-deprecated) — same
 *  `OperationNotFoundError`/`IllegalTransition` split `requireOperation` above draws. */
async function requirePublishedOperation(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
  name: string,
): Promise<OperationRecord> {
  const published = await getPublishedOperation(client, workspaceId, gatekeeperId, name);
  if (published) return published;
  const current = await getOperation(client, workspaceId, gatekeeperId, name);
  if (!current) throw new OperationNotFoundError(gatekeeperId, name);
  return current;
}

export interface PublishOperationInput {
  readonly gatekeeperId: string;
  readonly name: string;
  /** D-24: the `publish_operation` caller, checked against the draft being published
   *  (`governance/capability/publish-authority.ts`) — its proposer or the owner. Omitted by
   *  internal callers (`publishManifest`, `enable_gate_instance`, the CLI). Operation drafts are
   *  reviewed by builders and owners (D-26), so a refusal is a 403, never a not-found. */
  readonly actor?: PublishActor;
  /** Review #493 on #583: the `operationDraftDigest` of the draft the caller reviewed
   *  (`publish_operation`'s `draftDigest`, required on the wire since legacy 300). A draft revised
   *  in place since refuses `OperationDraftChangedError`. Internal callers publish what is there and
   *  omit it. */
  readonly draftDigest?: string;
}

/**
 * Publishes a draft Operation. Throws `OperationNotFoundError` if unknown, `IllegalTransition`
 * (`@nexttime/shared`) if not currently `draft`. The returned record carries the draft's full
 * definition (`operation`, `origin`, `proposedBy`) — `publish_operation`'s handler returns it
 * verbatim so the owner sees exactly what was just published (an agent's proposal is published
 * only this way, one at a time; see `publishManifest`).
 *
 * S3.12 / R-08: publishing a draft also deprecates every row of the same identity that is still
 * `published` right now, in the same transaction (same `client`, no separate commit), and
 * *before* the draft itself flips — so the identity never holds two live rows, not even between
 * two statements. That is normally exactly the row a revision draft's `draftOf` names; matching
 * by status rather than following `draftOf` also covers a draft whose `draftOf` was lost (the
 * R-08 import path, before its fix) and a superseded row someone already deprecated directly via
 * `deprecateOperation` (simply not matched — `OPERATION_TRANSITIONS` has no `deprecated →
 * deprecate` edge, so retrying that transition would throw `IllegalTransition` and abort this
 * publish over a state that already reached exactly where this call wanted it). The returned
 * record's `supersedes` is the deprecated row's Object id — set only when this call actually
 * deprecated one — for `operation-manifest-handlers.ts` to record on the publish Activity's
 * `metadata` (audit/explain).
 */
export async function publishOperation(
  client: PoolClient,
  workspaceId: string,
  input: PublishOperationInput,
): Promise<OperationRecord> {
  // Locked: what is counted and checked below is exactly what the status flip publishes. Without
  // the lock, a proposer's in-place revision of this same draft (`proposeOperation`, same version)
  // could commit between this read and `setOperationStatusObject`, which flips only `status` — the
  // revised content would go live unchecked. Holding the row makes that revision wait, then fail
  // its `status = 'draft'` condition (`OperationIdentityConflictError`).
  const existing = await requireOperation(client, workspaceId, input.gatekeeperId, input.name, {
    forUpdate: true,
  });
  assertPublishAuthority(
    'publish_operation',
    input.actor,
    { status: existing.status, proposedBy: existing.proposedBy?.id },
    `Operation ${input.gatekeeperId}/${input.name}@${existing.version}`,
  );
  transition(OPERATION_TRANSITIONS, existing.status, 'publish');
  // Review #493 on #583: before the gate-owned and credentials checks — those are about the
  // content the caller reviewed, and this says it is not the content here.
  if (input.draftDigest !== undefined) assertDraftUnchanged(existing, input.draftDigest);
  // Legacy J: a definition offering a param the gate refuses on every call is never published,
  // whoever publishes it (`gate-owned-params.ts`). Before the credentials question: a draft that
  // cannot be published as it stands is not worth confirming.
  assertNoGateOwnedParams(
    `${input.gatekeeperId}/${input.name}@${existing.version}`,
    existing.operation,
  );
  // Decision 2026-10-09 "二次确认": the Operation definition an agent may have proposed. Values
  // only — its params schema's property names (`password`) are declarations, not values.
  assertDraftCredentialsReviewed(
    'operation',
    `${input.gatekeeperId}/${input.name}@${existing.version}`,
    existing.operation,
    input.actor,
  );
  // D-24: publishing a revision also deprecates the live row below, so the caller needs deprecate
  // authority over that row too — a builder may revise their own Operation, but replacing (and
  // reclassifying) a row someone else proposed, such as a gate's imported Operation, is the owner's.
  if (input.actor !== undefined) {
    const live = await getPublishedOperation(client, workspaceId, input.gatekeeperId, input.name);
    if (live) {
      assertPublishAuthority(
        'publish_operation',
        input.actor,
        { status: live.status, proposedBy: live.proposedBy?.id },
        `Operation ${input.gatekeeperId}/${input.name}@${live.version} (the published version this draft would replace)`,
      );
    }
  }
  // `existing` is a draft here (the transition above allows `publish` from `draft` only), so this
  // never touches the row being published.
  const superseded = await deprecatePublishedOperationObjects(client, workspaceId, {
    gatekeeperId: input.gatekeeperId,
    name: input.name,
  });
  await setOperationStatusObject(
    client,
    workspaceId,
    { gatekeeperId: input.gatekeeperId, name: input.name, version: existing.version },
    'published',
  );

  // At most one row was live (migrations/core/0034's constraint), so at most one was superseded.
  const supersedes = superseded[0];
  return { ...existing, status: 'published', ...(supersedes !== undefined ? { supersedes } : {}) };
}

// -------------------------------------------------------------------------------------------
// S11 P1-E: a ChangePlan's revision of a published Operation (`application/change-plan`'s
// `operation_version` item). It changes how calls of the Operation are governed, never what the
// gate runs: the revision has the live version's definition (`operationDefinitionDigest`, the one
// a gate holds every call to), so it never makes the gate refuse a call.
// -------------------------------------------------------------------------------------------

/** Holds the workspace's ChangePlan revisions of Operations until the transaction ends: two
 *  segments revising Operations run one after the other — whichever Operations, so they never wait
 *  on each other in a cycle — and the later one plans against what the earlier one published.
 *  Taken before any read of an Operation it revises. */
export async function lockOperationRevision(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [
    `operation_revisions:${workspaceId}`,
  ]);
}

/** Exactly version `version` of `(gatekeeperId, name)`, whatever its status (a discarded draft
 *  included), or `null`. */
export async function getOperationVersion(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
  name: string,
  version: number,
): Promise<OperationRecord | null> {
  const result = await client.query<OperationObjectRow>(
    `select id, identity_key, properties
     from objects
     where workspace_id = $1
       and object_type = 'Operation'
       and identity_key ->> 'gatekeeperId' = $2
       and identity_key ->> 'name' = $3
       and coalesce((properties ->> 'version')::int, 1) = $4
     limit 1`,
    [workspaceId, gatekeeperId, name, version],
  );
  const row = result.rows[0];
  if (!row) return null;
  return toOperationRecord(gatekeeperId, name, row.id, row.properties);
}

export interface PublishOperationRevisionInput {
  readonly gatekeeperId: string;
  readonly name: string;
  /** The published version the revision replaces, as the caller read it: its number and
   *  `operationContentDigest`. Refused unless it is still the live one with that content — a
   *  published version is edited in place (its description, a governance refresh), so the number
   *  alone does not say the caller planned against what is live (review #493 on #690). */
  readonly replaces: { readonly version: number; readonly contentDigest: string };
  /** The revision's whole content: the live version's definition, other governance. */
  readonly operation: Operation;
  /** Whose change this is (the ChangePlan's applier): the revision's proposer and publisher —
   *  origin `human` for a person, `agent` otherwise (as `proposeOperation` records it). */
  readonly publishedBy: { readonly id: string; readonly kind: PrincipalKind };
  readonly activityId: string;
}

/**
 * Publishes `operation` as the next version of `(gatekeeperId, name)`, retiring `replaces` — the
 * existing propose-and-publish path, in one transaction, leaving no draft behind: a draft at the
 * next version (written only if that version is new, `insertOnly`), then `publishOperation`, which
 * deprecates the live row. Refuses, writing nothing, when `replaces` is not the live version
 * (`OperationNotFoundError` when nothing is live), when the live version's content is no longer
 * what `replaces` says (edited in place since the caller read it: a caller that planned under the
 * row lock never sees this, so a plain `Error`), when a draft of the Operation is pending
 * (`OperationIdentityConflictError`: a revision someone has under review is never overwritten or
 * bypassed), or when `operation`'s definition is not the live one's (a caller bug). Call it under
 * `lockOperationRevision`; it locks the live row itself.
 */
export async function publishOperationRevision(
  client: PoolClient,
  workspaceId: string,
  input: PublishOperationRevisionInput,
): Promise<OperationRecord> {
  const { gatekeeperId, name } = input;
  const live = await getPublishedOperation(client, workspaceId, gatekeeperId, name, {
    forUpdate: true,
  });
  if (!live || live.version !== input.replaces.version) {
    throw new OperationNotFoundError(gatekeeperId, name);
  }
  if (operationContentDigest(live.operation) !== input.replaces.contentDigest) {
    throw new Error(
      `publishOperationRevision: Operation ${quotedName(name)} on gatekeeper ${gatekeeperId} v${live.version} was edited in place since it was read; a revision is planned against the live content, under its row lock`,
    );
  }
  const current = await getOperation(client, workspaceId, gatekeeperId, name);
  if (current?.status === 'draft') {
    throw new OperationIdentityConflictError(gatekeeperId, name, 'draft');
  }
  if (operationDefinitionDiffers(live, input.operation)) {
    throw new Error(
      `publishOperationRevision: Operation ${quotedName(name)} on gatekeeper ${gatekeeperId} — a revision keeps the published definition (what the gate runs); only how calls are governed changes`,
    );
  }
  const version = await nextOperationVersion(client, workspaceId, gatekeeperId, name);
  const written = await registerOperationDraftObject(client, workspaceId, {
    gatekeeperId,
    name,
    version,
    draftOf: live.id,
    operation: input.operation,
    proposedBy: input.publishedBy,
    activityId: input.activityId,
    origin: input.publishedBy.kind === 'human' ? 'human' : 'agent',
    insertOnly: true,
  });
  if (!written) throw new OperationIdentityConflictError(gatekeeperId, name, 'draft');
  const published = await publishOperation(client, workspaceId, { gatekeeperId, name });
  if (published.version !== version) {
    throw new Error(
      `publishOperationRevision: Operation ${quotedName(name)} on gatekeeper ${gatekeeperId} published v${published.version}, not the revision v${version}`,
    );
  }
  return published;
}

/** One draft as the caller read it: its name and the `operationDraftDigest` its listing returned
 *  (`list_operations`' `draftDigest`). */
export interface ReviewedDraft {
  readonly name: string;
  readonly draftDigest: string;
}

export interface PublishManifestInput {
  readonly gatekeeperId: string;
  /** Review #493 on #592 (P2, the bulk form of legacy 300): the drafts the caller read before
   *  publishing. Every draft this call would publish must be listed here with its current digest;
   *  one revised since, or one the caller never read (a gate re-import added it), refuses the
   *  whole call with `OperationDraftChangedError` before anything is written. Entries for drafts
   *  that are gone, or that this call does not publish anyway, are ignored. */
  readonly drafts: readonly ReviewedDraft[];
}

export interface PublishManifestResult {
  readonly gatekeeperId: string;
  /** The `'import'`-origin drafts this call published, in `updated_at` order. */
  readonly publishedOperationNames: readonly string[];
  /** Drafts left as drafts because they are not the gate's own declaration — agent/human
   *  proposals (and legacy drafts with no recorded origin). Each needs an owner's explicit
   *  `publish_operation`, which shows its full definition first. */
  readonly skippedDraftOperationNames: readonly string[];
  /** Legacy J: the gate's own drafts left unpublished because they declare a param the gate sets
   *  itself (`gate-owned-params.ts`), with those params. */
  readonly gateOwnedParamDrafts: readonly GateOwnedParamDraft[];
}

/**
 * `publish_manifest` (S2.13, `governance/connections` group's bulk-publish capability, §7.5
 * "owner 发布清单" — distinct granularity from `publishOperation`, which publishes one already-
 * named Operation): publishes every `'import'`-origin draft of one Gatekeeper instance — the
 * manifest the gate itself declared — and *only* those. An agent's `propose_operation` draft is
 * never swept up by a bulk publish (review 2026-09: that is exactly how a prompt-injected
 * proposal's `mode`/`auto_approvable` used to become live); it is reported in
 * `skippedDraftOperationNames` and waits for an owner's per-Operation `publishOperation`. Zero
 * drafts to publish is a successful, not an error, result — a bulk call over zero rows is
 * trivially a no-op. Every draft it publishes must be one the caller read, unchanged
 * (`input.drafts`, review #493 on #592).
 */
export async function publishManifest(
  client: PoolClient,
  workspaceId: string,
  input: PublishManifestInput,
): Promise<PublishManifestResult> {
  const drafts = await listDraftOperationsForGatekeeper(client, workspaceId, input.gatekeeperId);
  const reviewed = new Map(input.drafts.map((d) => [d.name, d.draftDigest]));
  const toPublish: { readonly name: string; readonly draftDigest: string }[] = [];
  const skippedDraftOperationNames: string[] = [];
  const gateOwnedParamDrafts: GateOwnedParamDraft[] = [];
  for (const draft of drafts) {
    if (draft.origin !== 'import') {
      skippedDraftOperationNames.push(draft.name);
      continue;
    }
    const params = gateOwnedParamsOfDefinition(draft.operation);
    if (params.length > 0) {
      gateOwnedParamDrafts.push({ name: draft.name, params });
      continue;
    }
    // Checked for every draft before any is published: a refusal leaves the whole manifest as it was.
    const seen = reviewed.get(draft.name);
    if (seen === undefined) {
      throw new OperationDraftChangedError(draft.gatekeeperId, draft.name, draft.version);
    }
    assertDraftUnchanged(draft, seen);
    toPublish.push({ name: draft.name, draftDigest: seen });
  }
  const publishedOperationNames: string[] = [];
  for (const draft of toPublish) {
    await publishOperation(client, workspaceId, {
      gatekeeperId: input.gatekeeperId,
      name: draft.name,
      draftDigest: draft.draftDigest,
    });
    publishedOperationNames.push(draft.name);
  }
  return {
    gatekeeperId: input.gatekeeperId,
    publishedOperationNames,
    skippedDraftOperationNames,
    gateOwnedParamDrafts,
  };
}

/**
 * Publishes the `'import'`-origin drafts a gate's manifest was just imported as (`importManifest`'s
 * `imported`) — the landing's catalog origin (`enable_gate_instance`, application/gates/landing.ts). A draft
 * declaring a param the gate sets itself stays a draft and is reported (legacy J), like
 * `publishManifest`.
 */
export async function publishImportedDrafts(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
  imported: readonly OperationRecord[],
): Promise<{
  readonly publishedOperationNames: readonly string[];
  readonly gateOwnedParamDrafts: readonly GateOwnedParamDraft[];
}> {
  const publishedOperationNames: string[] = [];
  const gateOwnedParamDrafts: GateOwnedParamDraft[] = [];
  for (const record of imported) {
    const params = gateOwnedParamsOfDefinition(record.operation);
    if (params.length > 0) {
      gateOwnedParamDrafts.push({ name: record.name, params });
      continue;
    }
    await publishOperation(client, workspaceId, { gatekeeperId, name: record.name });
    publishedOperationNames.push(record.name);
  }
  return { publishedOperationNames, gateOwnedParamDrafts };
}

export interface DeprecateOperationInput {
  readonly gatekeeperId: string;
  readonly name: string;
  /** D-24: the `deprecate_operation` caller — the published row's proposer or the owner (see
   *  `PublishOperationInput.actor`). */
  readonly actor?: PublishActor;
}

/** Deprecates a published Operation. Throws `OperationNotFoundError` if unknown, `IllegalTransition`
 *  if not currently `published`. Targets the live published row directly (`requirePublishedOperation`
 *  above) — unaffected by any pending revision draft against the same identity (S3.12). */
export async function deprecateOperation(
  client: PoolClient,
  workspaceId: string,
  input: DeprecateOperationInput,
): Promise<OperationRecord> {
  const existing = await requirePublishedOperation(
    client,
    workspaceId,
    input.gatekeeperId,
    input.name,
  );
  assertPublishAuthority(
    'deprecate_operation',
    input.actor,
    { status: existing.status, proposedBy: existing.proposedBy?.id },
    `Operation ${input.gatekeeperId}/${input.name}@${existing.version}`,
  );
  transition(OPERATION_TRANSITIONS, existing.status, 'deprecate');
  await setOperationStatusObject(
    client,
    workspaceId,
    { gatekeeperId: input.gatekeeperId, name: input.name, version: existing.version },
    'deprecated',
  );
  return { ...existing, status: 'deprecated' };
}

export interface DiscardOperationDraftInput {
  readonly gatekeeperId: string;
  readonly name: string;
  /** The draft version the caller looked at. A draft is revised in place at its own version (the
   *  proposer re-proposing, a gate re-import), so this alone does not name its content —
   *  `draftDigest` does (review #493 on #583). */
  readonly version: number;
  /** The `operationDraftDigest` of the draft the caller looked at (`OperationSummaryWire.
   *  draftDigest`); a draft revised in place since refuses `OperationDraftChangedError`. */
  readonly draftDigest: string;
  /** D-24: the `discard_operation_draft` caller — the draft's proposer or the owner (see
   *  `PublishOperationInput.actor`). */
  readonly actor?: PublishActor;
}

export interface DiscardedOperationDraft {
  readonly id: string;
  readonly gatekeeperId: string;
  readonly name: string;
  readonly version: number;
  readonly status: 'discarded';
  /** What was discarded, for the audit record: who wrote the draft, through which channel, and
   *  the digest of the definition it carried (`null` when it does not parse) — never the
   *  definition itself. */
  readonly origin?: OperationOrigin;
  readonly proposedBy?: { readonly id: string; readonly kind: PrincipalKind };
  readonly draftOf?: string;
  readonly definitionDigest: string | null;
}

/**
 * Legacy 278 (UX acceptance of #577): `discard_operation_draft` — the workspace decides not to
 * publish one draft version (`OPERATION_TRANSITIONS`, `draft → discarded`). Until now a draft the
 * gate no longer announces, or one that can never be published (a gate-owned param, legacy J),
 * stayed in the catalog for good.
 *
 * A transition, not a delete: an Operation draft is a graph Object, and the `exposes` Fact its
 * registration asserted (with its Activity and proposer) points at it. Deleting the row would cut
 * that provenance; marking it keeps "this was proposed, by whom, and dropped" reconstructable,
 * with the audit record (dispatch.ts, plus the handler's payload) saying who discarded it and why.
 * Every read of "the Operation now" leaves the row out (`NOT_DISCARDED`), and its version is never
 * reused (`nextOperationVersion`): a later import, proposal or align opens a fresh draft above it.
 *
 * Targets exactly `{gatekeeperId, name, version}`, locked: `OperationNotFoundError` when there is
 * no such row, D-24's rule on the locked row — the draft's proposer or the owner
 * (`NotProposerError`, 403) — `IllegalTransition` (409) when it is not a draft (a published row is
 * deprecated, not discarded), and `OperationDraftChangedError` (409) when the draft was revised in
 * place since the caller read it (`draftDigest`, review #493 on #583). Operation drafts are visible to every caller over the builder floor
 * (D-26), so a refusal is never a not-found. A revision draft's published row is untouched.
 */
export async function discardOperationDraft(
  client: PoolClient,
  workspaceId: string,
  input: DiscardOperationDraftInput,
): Promise<DiscardedOperationDraft> {
  const result = await client.query<OperationObjectRow>(
    `select id, identity_key, properties
     from objects
     where workspace_id = $1
       and object_type = 'Operation'
       and identity_key ->> 'gatekeeperId' = $2
       and identity_key ->> 'name' = $3
       and coalesce((properties ->> 'version')::int, 1) = $4
     limit 1
     for update`,
    [workspaceId, input.gatekeeperId, input.name, input.version],
  );
  const row = result.rows[0];
  if (!row) throw new OperationNotFoundError(input.gatekeeperId, input.name);
  // A discarded row reads as itself here (`toOperationRecord` keeps the stored status), so the
  // transition below refuses discarding it twice.
  const status = (row.properties.status as OperationStatus | undefined) ?? 'draft';
  const existing = toOperationRecord(input.gatekeeperId, input.name, row.id, row.properties);
  assertPublishAuthority(
    'discard_operation_draft',
    input.actor,
    { status, proposedBy: existing.proposedBy?.id },
    `Operation ${input.gatekeeperId}/${input.name}@${existing.version}`,
  );
  transition(OPERATION_TRANSITIONS, status, 'discard');
  assertDraftUnchanged(existing, input.draftDigest);
  await setOperationStatusObject(
    client,
    workspaceId,
    { gatekeeperId: input.gatekeeperId, name: input.name, version: existing.version },
    'discarded',
  );
  return {
    id: existing.id,
    gatekeeperId: input.gatekeeperId,
    name: input.name,
    version: existing.version,
    status: 'discarded',
    ...(existing.origin !== undefined ? { origin: existing.origin } : {}),
    ...(existing.proposedBy !== undefined ? { proposedBy: existing.proposedBy } : {}),
    ...(existing.draftOf !== undefined ? { draftOf: existing.draftOf } : {}),
    definitionDigest: operationRecordDigestOrNull(existing),
  };
}

// -------------------------------------------------------------------------------------------
// S8 W3-K1 (leftover 81): update_operation_description — human channel, no minRole (same as
// publish_operation/deprecate_operation right above — §9.3 names no role for it explicitly).
// -------------------------------------------------------------------------------------------

/** Matches `update_operation_description`'s own `paramsSchema` bound (packages/shared/src/
 *  capabilities.ts) — no existing import-path limit to match (checked: OperationSchema.description
 *  and every other manifest-import path carry no `.max()` of their own), so this is a fresh, sane
 *  bound for a documentation string. */
export const OPERATION_DESCRIPTION_MAX_LENGTH = 2000;

/** Thrown by `updateOperationDescription` for a blank (after trim) or over-length description —
 *  named distinctly from `OperationDescriptionRequiredError` above (that one is `importManifest`'s
 *  own "the gate's manifest must declare one" rule; this is a human directly editing one Operation's
 *  documentation and gets its own message rather than borrowing `import_manifest`'s wording). */
export class OperationDescriptionInvalidError extends Error {
  readonly operationName: string;
  readonly reason: 'empty' | 'too_long';
  constructor(operationName: string, reason: 'empty' | 'too_long') {
    super(
      reason === 'empty'
        ? `update_operation_description: Operation ${quotedName(operationName)} description must not be blank`
        : `update_operation_description: Operation ${quotedName(operationName)} description exceeds ${OPERATION_DESCRIPTION_MAX_LENGTH} characters`,
    );
    this.name = 'OperationDescriptionInvalidError';
    this.operationName = operationName;
    this.reason = reason;
  }
}

export interface UpdateOperationDescriptionInput {
  readonly gatekeeperId: string;
  readonly name: string;
  readonly description: string;
  /** STATUS leftover 123: the `update_operation_description` caller, held to D-24's rule on the
   *  row being edited — its proposer or the owner (`governance/capability/publish-authority.ts`).
   *  Omitted by internal callers only. */
  readonly actor?: PublishActor;
}

/**
 * `update_operation_description(gatekeeperId, name, description)` (S8 W3-K1, leftover 81, audit
 * CO1 "页面允许 owner 补写描述"): edits one already-registered Operation's `description` **in
 * place** — description is documentation, not a governance field (§ module doc comment's own
 * "governance decisions ... published row stays live" reasoning does not apply to a field that
 * carries no policy weight), so there is no draft/publish two-step here, the same way
 * `updateGateInstance`'s `displayName` patch needs none. Targets the identity's *current* row
 * (`requireOperation`'s draft-first priority, same target `publishOperation` resolves against) —
 * draft, published, or deprecated all accept a description edit; only the identity itself
 * (unknown name) is an error (`OperationNotFoundError`). The row is locked before it is read
 * (`lockCurrentOperation`, review #493 on #690): an edit racing a publish lands on whichever version
 * is current once the publish commits, never on the version it retired.
 *
 * `description` must be non-blank after trimming and at most `OPERATION_DESCRIPTION_MAX_LENGTH`
 * characters (`OperationDescriptionInvalidError`) — checked before any write, so a rejected call
 * touches nothing.
 *
 * Authority (STATUS leftover 123): documentation, but not harmless — a published Operation's
 * description is what every agent reads in its tool list, so whoever edits it can steer agents.
 * D-24's rule applies to the row being edited: the registry's builder floor, then only that row's
 * proposer or the workspace owner (`NotProposerError`, 403 `not_proposer`) — a builder edits the
 * Operations they proposed; a gate's imported Operation (owner-proposed) is the owner's. A draft the
 * caller may not see (D-26, `operationVisibleTo`) answers not-found, never 403; under the builder
 * floor every caller is a draft reviewer, so that branch only matters if the floor ever changes.
 */
export async function updateOperationDescription(
  client: PoolClient,
  workspaceId: string,
  input: UpdateOperationDescriptionInput,
): Promise<OperationRecord> {
  const trimmed = input.description.trim();
  if (trimmed.length === 0) {
    throw new OperationDescriptionInvalidError(input.name, 'empty');
  }
  if (trimmed.length > OPERATION_DESCRIPTION_MAX_LENGTH) {
    throw new OperationDescriptionInvalidError(input.name, 'too_long');
  }

  const existing = await lockCurrentOperation(client, workspaceId, input.gatekeeperId, input.name);
  if (!existing) throw new OperationNotFoundError(input.gatekeeperId, input.name);
  if (input.actor !== undefined && !operationVisibleTo(input.actor, existing)) {
    throw new OperationNotFoundError(input.gatekeeperId, input.name);
  }
  assertPublishAuthority(
    'update_operation_description',
    input.actor,
    { status: existing.status, proposedBy: existing.proposedBy?.id },
    `Operation ${input.gatekeeperId}/${input.name}@${existing.version}`,
  );
  await setOperationDescriptionObject(
    client,
    workspaceId,
    { gatekeeperId: input.gatekeeperId, name: input.name, version: existing.version },
    trimmed,
  );
  return { ...existing, operation: { ...existing.operation, description: trimmed } };
}

// -------------------------------------------------------------------------------------------
// S8 W3-K1 (leftover 79): refresh_operation_governance — human channel, owner only. The shared
// "does this Operation's governance disagree with the gate's announced manifest" judgment
// `preview_gate_instance_enable` (application/gateway/gate-instance-handlers.ts) already computes
// inline for its own `differs` flag now lives here, as `diffOperationGovernanceFields` — both that
// preview and `refreshOperationGovernance` below call it, so "which fields count as governance"
// and "when do they differ" can never drift between the read and the write.
// -------------------------------------------------------------------------------------------

/** The three fields `preview_gate_instance_enable`'s own `differs` flag already compared before
 *  this task (module doc comment) — deliberately not `await_decision`/`reversibility`/the MCP
 *  trust hints, which that preview never compared either; "governance fields" for this capability
 *  means exactly these three, not the full `Operation` shape. */
export interface OperationGovernanceFields {
  readonly mode: Operation['mode'];
  readonly blastRadius: Operation['blast_radius'];
  readonly autoApprovable: boolean;
}

export function operationGovernanceFieldsOf(operation: Operation): OperationGovernanceFields {
  return {
    mode: operation.mode,
    blastRadius: operation.blast_radius,
    autoApprovable: operation.auto_approvable,
  };
}

export type OperationGovernanceFieldName = 'mode' | 'blastRadius' | 'autoApprovable';

export interface OperationGovernanceDiff {
  readonly differs: boolean;
  readonly changedFields: readonly OperationGovernanceFieldName[];
}

/** The exact comparison `preview_gate_instance_enable` used inline for its own `differs` flag
 *  before this task — extracted here so `refreshOperationGovernance` reuses it verbatim rather
 *  than a second, potentially-drifting comparison (dispatch contract). */
export function diffOperationGovernanceFields(
  existing: OperationGovernanceFields,
  announced: OperationGovernanceFields,
): OperationGovernanceDiff {
  const changedFields: OperationGovernanceFieldName[] = [];
  if (existing.mode !== announced.mode) changedFields.push('mode');
  if (existing.blastRadius !== announced.blastRadius) changedFields.push('blastRadius');
  if (existing.autoApprovable !== announced.autoApprovable) changedFields.push('autoApprovable');
  return { differs: changedFields.length > 0, changedFields };
}

export type OperationGovernanceDirection = 'loosened' | 'tightened' | 'mixed';

/** Strictness rank per field value — lower means *less* governance friction (loosened when the
 *  announced value ranks lower than the existing one). `observe` needs no approval at all
 *  (`request_action`'s handler routes it straight through), `execute` always creates an
 *  ActionRequest — so `execute → observe` is a loosening exactly like the task brief's own
 *  example, and blast radius / auto-approvable follow their natural order. */
const MODE_STRICTNESS: Readonly<Record<Operation['mode'], number>> = { observe: 0, execute: 1 };
const BLAST_RADIUS_STRICTNESS: Readonly<Record<Operation['blast_radius'], number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

function fieldDirection(
  field: OperationGovernanceFieldName,
  existing: OperationGovernanceFields,
  announced: OperationGovernanceFields,
): 'loosened' | 'tightened' {
  if (field === 'mode') {
    return MODE_STRICTNESS[announced.mode] < MODE_STRICTNESS[existing.mode]
      ? 'loosened'
      : 'tightened';
  }
  if (field === 'blastRadius') {
    return BLAST_RADIUS_STRICTNESS[announced.blastRadius] <
      BLAST_RADIUS_STRICTNESS[existing.blastRadius]
      ? 'loosened'
      : 'tightened';
  }
  // autoApprovable
  return announced.autoApprovable && !existing.autoApprovable ? 'loosened' : 'tightened';
}

/** Classifies a non-empty set of changed governance fields (`diffOperationGovernanceFields`'s own
 *  `changedFields`) as `loosened` (every changed field reduces governance friction — lower blast
 *  radius, `autoApprovable` false→true, `execute→observe`), `tightened` (every changed field
 *  increases it), or `mixed` (some of each). Throws on an empty `changedFields` — callers only
 *  classify a diff that actually differs. */
export function classifyOperationGovernanceChange(
  existing: OperationGovernanceFields,
  announced: OperationGovernanceFields,
  changedFields: readonly OperationGovernanceFieldName[],
): OperationGovernanceDirection {
  if (changedFields.length === 0) {
    throw new Error(
      'classifyOperationGovernanceChange: changedFields is empty — nothing to classify',
    );
  }
  const directions = new Set(
    changedFields.map((field) => fieldDirection(field, existing, announced)),
  );
  return directions.size > 1 ? 'mixed' : ([...directions][0] as OperationGovernanceDirection);
}

/** R-19 (decision D-17): the one direction every console confirm shows for a governance change —
 *  the refresh preview, a catalog publish, the wizard's reclassification and a gate's pending
 *  manifest — so no client keeps a ranking of its own. `classifyOperationGovernanceChange` for a
 *  real change, `neutral` when none of the three fields differs. */
export type OperationGovernanceChangeDirection = OperationGovernanceDirection | 'neutral';

export function operationGovernanceChangeDirection(
  before: OperationGovernanceFields,
  after: OperationGovernanceFields,
): OperationGovernanceChangeDirection {
  const diff = diffOperationGovernanceFields(before, after);
  return diff.differs
    ? classifyOperationGovernanceChange(before, after, diff.changedFields)
    : 'neutral';
}

export interface OperationGovernanceChange {
  readonly before: OperationGovernanceFields;
  readonly after: OperationGovernanceFields;
  readonly direction: OperationGovernanceChangeDirection;
}

/** `before` → `after` as the wire's `OperationGovernanceChangeWire`. */
export function operationGovernanceChange(
  before: Operation,
  after: Operation,
): OperationGovernanceChange {
  const beforeFields = operationGovernanceFieldsOf(before);
  const afterFields = operationGovernanceFieldsOf(after);
  return {
    before: beforeFields,
    after: afterFields,
    direction: operationGovernanceChangeDirection(beforeFields, afterFields),
  };
}

export interface RefreshOperationGovernanceInput {
  readonly gatekeeperId: string;
  /** The gate instance's announced manifest right now (`operationsOf(rawOperations(...))` —
   *  `application/gateway/gate-instance-handlers.ts` reads it; this module has no dependency on
   *  `application/gates`, same layering `getOperation`/`importManifest` already keep). */
  readonly announcedOperations: readonly Operation[];
  /** Narrows which announced Operations are considered — `undefined`/omitted means every one. */
  readonly operationNames?: readonly string[];
  /** Legacy K: who the revision drafts below are recorded as proposed by (the owner refreshing),
   *  and the Activity they are written under. */
  readonly proposedBy: { readonly id: string; readonly kind: PrincipalKind };
  readonly activityId: string;
  /** UX acceptance of #583 (P3-2): the announced Operations the gate itself no longer runs, held
   *  until the platform adopts its new manifest (`application/gates`' `droppedUntilAdopted`).
   *  Adopting removes them, so no draft is written for them: an import draft is not rewritten and
   *  no revision is opened — publishing either would bring no call back. Governance fields of a
   *  published row are still aligned in place. */
  readonly droppedByGate?: ReadonlySet<string>;
  /** Where `announcedOperations` comes from (`AnnouncedManifestSource`); `'platform'` when
   *  omitted. Either way, a selected announced Operation this Gatekeeper has no row for at all is
   *  imported as an `'import'`-origin draft (`importManifest`) instead of being reported
   *  `unchanged` — enabling or connecting again would register a second Gatekeeper (P0b: one per
   *  address), so this is the only way a name the gate gained reaches the workspace. A draft, never
   *  published here: a new name is new authority, which takes an owner's publish (legacy 214 for a
   *  self-connected gate; P0b closes the same gap for a linked platform gate, #612 P2). Legacy 214,
   *  `'gate'`: a governance change that loosens anything is carried by a revision draft, never
   *  written in place (`governanceChangeNeedsRevision`). */
  readonly source?: AnnouncedManifestSource;
}

/**
 * Who stands behind an announced manifest. `'platform'`: the manifest in effect of a platform gate
 * instance, which a platform administrator adopted (R-18) before any workspace aligns to it.
 * `'gate'` (legacy 214): a self-connected gate's own `describe_operations` — nobody reviewed it
 * before the workspace owner reads the preview.
 */
export type AnnouncedManifestSource = 'platform' | 'gate';

/**
 * Review #493 on #612 (M1): whether a published Operation's governance change must wait for a
 * revision to be published instead of being written in place. The in-place refresh exists for a
 * platform gate's adopted manifest — reviewed twice, by the administrator who adopted it and the
 * owner who aligns. A self-connected gate's own description has had no review at all, so anything
 * it loosens (`loosened`, or `mixed`: something loosens) reaches the published Operation only
 * through the catalog publish of an `'import'` revision (`publish_operation` /
 * `publish_manifest`), as a changed definition does. A tightening is still applied in place: it
 * only adds approval, and a gate that tightens does not wait on a publish for it. The preview
 * (`compareAnnouncedOperations`'s `governanceByRevision`) and the write use this one judgment.
 */
export function governanceChangeNeedsRevision(
  source: AnnouncedManifestSource,
  direction: OperationGovernanceChangeDirection,
): boolean {
  return source === 'gate' && (direction === 'loosened' || direction === 'mixed');
}

export interface RefreshedOperationGovernance {
  /** The Operation Object's own id (`OperationRecord.id`) — a real uuid, unlike the
   *  `{gatekeeperId, name}` identity pair. The handler (`refreshOperationGovernanceHandler`,
   *  gate-instance-handlers.ts) uses this as its per-Operation AuditRecord's `resource_id`
   *  (`audit_records.resource_id` is `uuid`) and strips it back out of the wire result, which has
   *  no `id` field — this is kernel-internal, not part of the capability's public result shape. */
  readonly id: string;
  readonly name: string;
  readonly before: OperationGovernanceFields;
  readonly after: OperationGovernanceFields;
  readonly direction: OperationGovernanceDirection;
}

/** Legacy K: a draft `refreshOperationGovernance` wrote so the workspace can publish what the gate
 *  runs now — a revision opened for a published Operation whose definition the gate no longer
 *  runs, or the gate's own pending draft rewritten to the announced entry. */
export interface OperationRevisionDraft {
  /** The draft's Object id (kernel-internal, for its AuditRecord — not on the wire). */
  readonly id: string;
  readonly name: string;
  readonly version: number;
  /** The published row it revises — absent for a draft of a name never published. */
  readonly draftOf?: string;
  /** `true` when an existing `'import'`-origin draft was rewritten in place (same version),
   *  `false` when a new revision was opened at `version + 1`. */
  readonly replaced: boolean;
  /** A name the announced manifest carries that this Gatekeeper had no row for — imported as a
   *  first draft, not a revision of anything (legacy 214 for `source: 'gate'`; P0b for
   *  `'platform'`). */
  readonly newName?: true;
  /** Review #493 on #612 (M1): the revision carries a governance change that loosens something
   *  (`governanceChangeNeedsRevision`), held back from the published row until it is published.
   *  `definitionChanged`: the gate also runs another definition (it refuses calls until then). */
  readonly governanceLoosened?: {
    readonly direction: OperationGovernanceDirection;
    readonly definitionChanged: boolean;
  };
}

export interface RefreshOperationGovernanceResult {
  readonly refreshed: readonly RefreshedOperationGovernance[];
  /** Legacy K: one `'import'`-origin draft per selected name carrying the announced entry — a
   *  revision opened for a published Operation whose definition differs from it, the gate's own
   *  pending draft rewritten to it, or (legacy 214, `source: 'gate'`) a name it had no row for, or a
   *  self-connected gate's loosened governance fields (review #493 on #612). */
  readonly revisionDrafts: readonly OperationRevisionDraft[];
  /** Every selected name that was neither refreshed nor given a draft — already matching the
   *  manifest, not present at all under this identity, or a pending draft that is someone's
   *  proposal (an agent's or a person's, never overwritten) or already the announced entry. */
  readonly unchanged: readonly string[];
}

/**
 * Applies the gate's announced governance fields to every selected, already-deployed Operation
 * whose fields disagree with it — the write half of `preview_gate_instance_enable`'s `differs`
 * (audit CO2). For each announced Operation in `input.operationNames` (or all of them, when
 * omitted):
 *
 *   - `getOperation` resolves the identity's *current* row (draft-first priority, `manifest.ts`'s
 *     own module doc comment) — `null` means there is nothing "already present" to refresh
 *     (exactly `preview_gate_instance_enable`'s own branch), so the name goes to `unchanged`
 *     untouched — unless `source: 'gate'` (legacy 214, the self-connected resync) imports it as a
 *     first draft; a `draft` row is not refreshed in place either (see the legacy K note below for
 *     the one kind that is rewritten);
 *   - otherwise `diffOperationGovernanceFields` (the exact function `preview_gate_instance_enable`
 *     uses) decides whether it differs; no difference → `unchanged`; a difference → the announced
 *     fields are written **in place** (no new `version` — this module's own doc comment on why)
 *     and the entry is classified (`classifyOperationGovernanceChange`) and returned in
 *     `refreshed` — except a change that loosens anything under `source: 'gate'` (review #493 on
 *     #612, `governanceChangeNeedsRevision`): the published row is left as it is and the change
 *     goes into an `'import'` revision draft below, which an owner publishes in the catalog.
 *
 * Writes nothing for a name that never appears in the announced manifest (silently absent from
 * both `refreshed` and `unchanged` — there is no governance drift to report for an Operation the
 * gate does not currently declare at all).
 *
 * **Legacy K: a changed definition.** A gate refuses calls made under a definition it does not run
 * (`@nexttime/gatekeeper-base` `operation-digest.ts`), so a published Operation whose announced
 * definition changed (binding, params_schema, result_mapping, mode, reversibility; blast_radius
 * for ssh) cannot be called until the workspace publishes the new one. That is a new version, not
 * an in-place edit: what was approved must stay what it was. So for each such `published`
 * Operation this opens an `'import'`-origin revision draft at `version + 1` (`draftOf` the
 * published row) carrying the announced entry, the same draft `importManifest` writes for a new
 * name. The published row stays live and unchanged (besides the in-place governance refresh
 * above) until an owner publishes the draft through `publish_operation` / `publish_manifest`,
 * where its definition and any suspected credentials in it are reviewed (#526). Returned in
 * `revisionDrafts`, never in `unchanged`.
 *
 * A pending draft of the gate's own (`'import'` origin: a revision an earlier refresh opened, or an
 * import a bulk publish held back for declaring a gate-owned param, legacy J) is rewritten to the
 * announced entry at its own version when its definition or governance differs, as
 * `importManifest` replaces it — otherwise a gate that changed twice, or fixed its manifest, would
 * leave the workspace a draft it can never call under. A proposal of an agent or a person is
 * theirs and is left alone.
 */
/**
 * Whether `refresh_operation_governance` rewrites `draft` to the `announced` entry: it is the
 * gate's own (`import`-origin) draft — an agent's or person's proposal is never overwritten — and
 * the announcement differs from it in definition or governance fields. `preview_gate_instance_
 * enable` reports the same judgment (`pendingDraft.rewritable`), so the console's align lists
 * exactly the drafts this would rewrite (console G4, legacy 219).
 */
export function importDraftDiffersFromAnnounced(
  draft: OperationRecord,
  announced: Operation,
): boolean {
  if (draft.status !== 'draft' || draft.origin !== 'import') return false;
  return (
    operationDefinitionDiffers(draft, announced) ||
    diffOperationGovernanceFields(
      operationGovernanceFieldsOf(draft.operation),
      operationGovernanceFieldsOf(announced),
    ).differs
  );
}

async function rewriteImportDraft(
  client: PoolClient,
  workspaceId: string,
  input: RefreshOperationGovernanceInput,
  draft: OperationRecord,
  announced: Operation,
): Promise<OperationRevisionDraft | null> {
  if (!importDraftDiffersFromAnnounced(draft, announced)) return null;
  // Carried forward as `importManifest` does (R-08): replacing a revision keeps it a revision.
  const draftOf =
    draft.draftOf ??
    (await getPublishedOperation(client, workspaceId, input.gatekeeperId, draft.name))?.id;
  const written = await registerOperationDraftObject(client, workspaceId, {
    gatekeeperId: input.gatekeeperId,
    name: draft.name,
    version: draft.version,
    draftOf,
    operation: announced,
    proposedBy: input.proposedBy,
    activityId: input.activityId,
    origin: 'import',
  });
  if (!written) return null;
  return {
    id: written.operationObjectId,
    name: draft.name,
    version: draft.version,
    ...(draftOf !== undefined ? { draftOf } : {}),
    replaced: true,
  };
}

/** A name new to this Gatekeeper, as `importManifest` writes it — the next version above every
 *  row (legacy 278), the name rule for a new name (legacy 232), origin `import`. */
async function importNewOperation(
  client: PoolClient,
  workspaceId: string,
  input: RefreshOperationGovernanceInput,
  announced: Operation,
): Promise<OperationRevisionDraft | null> {
  const { imported } = await importManifest(client, workspaceId, {
    gatekeeperId: input.gatekeeperId,
    operations: [announced],
    proposedBy: input.proposedBy,
    activityId: input.activityId,
  });
  const [written] = imported;
  if (!written) return null;
  return {
    id: written.id,
    name: written.name,
    version: written.version,
    replaced: false,
    newName: true,
  };
}

export async function refreshOperationGovernance(
  client: PoolClient,
  workspaceId: string,
  input: RefreshOperationGovernanceInput,
): Promise<RefreshOperationGovernanceResult> {
  const selected = input.operationNames
    ? input.announcedOperations.filter((operation) =>
        input.operationNames?.includes(operation.name),
      )
    : input.announcedOperations;

  const refreshed: RefreshedOperationGovernance[] = [];
  const revisionDrafts: OperationRevisionDraft[] = [];
  const unchanged: string[] = [];
  const source = input.source ?? 'platform';

  for (const operation of selected) {
    // Locked (review #493 on #690): an in-place write below lands on the version that is current
    // when it commits, never on one a concurrent publish retired.
    const existingRecord = await lockCurrentOperation(
      client,
      workspaceId,
      input.gatekeeperId,
      operation.name,
    );
    const dropped = input.droppedByGate?.has(operation.name) ?? false;
    if (existingRecord === null) {
      // A name the gate no longer runs (held until the platform adopts its new manifest) is not
      // imported: adopting removes it, so publishing the draft would bring no call.
      const imported = dropped
        ? null
        : await importNewOperation(client, workspaceId, input, operation);
      if (imported) revisionDrafts.push(imported);
      else unchanged.push(operation.name);
      continue;
    }
    if (existingRecord.status === 'draft') {
      const rewritten = dropped
        ? null
        : await rewriteImportDraft(client, workspaceId, input, existingRecord, operation);
      if (rewritten) revisionDrafts.push(rewritten);
      else unchanged.push(operation.name);
      continue;
    }
    const before = operationGovernanceFieldsOf(existingRecord.operation);
    const after = operationGovernanceFieldsOf(operation);
    const diff = diffOperationGovernanceFields(before, after);
    const direction = diff.differs
      ? classifyOperationGovernanceChange(before, after, diff.changedFields)
      : null;
    // Review #493 on #612 (M1): a loosening from an unreviewed source waits for a publish.
    const byRevision = direction !== null && governanceChangeNeedsRevision(source, direction);
    const inPlace = direction !== null && !byRevision;
    if (inPlace) {
      await setOperationGovernanceFieldsObject(
        client,
        workspaceId,
        { gatekeeperId: input.gatekeeperId, name: operation.name, version: existingRecord.version },
        after,
      );
      refreshed.push({
        id: existingRecord.id,
        name: operation.name,
        before,
        after,
        direction,
      });
    }

    // Compared as it stands after the in-place write: a `mode` (or an ssh `blast_radius`) the
    // governance refresh just aligned is no longer a difference in definition.
    const deployed: OperationRecord = inPlace
      ? {
          ...existingRecord,
          operation: {
            ...existingRecord.operation,
            mode: after.mode,
            blast_radius: after.blastRadius,
            auto_approvable: after.autoApprovable,
          },
        }
      : existingRecord;
    // Legacy 278: above a discarded revision too, never on top of it.
    const definitionChanged = operationDefinitionDiffers(deployed, operation);
    const revisionVersion =
      !dropped && existingRecord.status === 'published' && (byRevision || definitionChanged)
        ? await nextOperationVersion(client, workspaceId, input.gatekeeperId, operation.name)
        : null;
    const revision =
      revisionVersion !== null
        ? await registerOperationDraftObject(client, workspaceId, {
            gatekeeperId: input.gatekeeperId,
            name: operation.name,
            version: revisionVersion,
            draftOf: existingRecord.id,
            operation,
            proposedBy: input.proposedBy,
            activityId: input.activityId,
            origin: 'import',
          })
        : null;
    if (revision) {
      revisionDrafts.push({
        id: revision.operationObjectId,
        name: operation.name,
        version: revisionVersion ?? existingRecord.version + 1,
        draftOf: existingRecord.id,
        replaced: false,
        ...(byRevision && direction !== null
          ? { governanceLoosened: { direction, definitionChanged } }
          : {}),
      });
    } else if (!inPlace) {
      // A loosening with no revision to carry it (a deprecated row) is not written either.
      unchanged.push(operation.name);
    }
  }

  return { refreshed, revisionDrafts, unchanged };
}

export { IllegalTransition };
