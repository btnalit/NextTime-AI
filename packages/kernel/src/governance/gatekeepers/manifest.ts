import type { Operation, PrincipalKind, PublishableStatus } from '@nexttime/shared';
import { IllegalTransition, PUBLISHABLE_TRANSITIONS, transition } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type { OperationOrigin } from '../../substrate/ontology/index.js';
import {
  registerOperationDraftObject,
  setOperationStatusObject,
} from '../../substrate/ontology/index.js';

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
 *     transition) **and**, in the same transaction, deprecates the row named by its `draftOf` —
 *     but only if that row is still `published` at the moment of this call (someone may have
 *     deprecated it directly in the meantime; publishing the revision must not then throw trying
 *     to deprecate an already-`deprecated` row — `PUBLISHABLE_TRANSITIONS` has no edge for that,
 *     by design). The now-superseded row's Object id comes back as the published record's own
 *     `supersedes` (only ever set on `publishOperation`'s return value, never persisted) —
 *     `application/gateway/operation-manifest-handlers.ts` records it on the publish Activity's
 *     `metadata` for audit/explain.
 *   - Every read that used to assume "one row per identity" (`getOperation`, `getPublishedOperation`,
 *     the `list*`/`find_*` helpers below) is unaffected in its external contract: at most one row
 *     per identity is ever `draft` and at most one is ever `published` at a time, so "the current
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
    super(`Operation not found: gatekeeper ${gatekeeperId}, name "${name}"`);
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
  readonly existingStatus: PublishableStatus;
  constructor(gatekeeperId: string, name: string, existingStatus: PublishableStatus) {
    super(
      `Operation "${name}" on gatekeeper ${gatekeeperId} already exists (status: ${existingStatus}) — a proposal may only create a new draft or revise the proposer’s own draft`,
    );
    this.name = 'OperationIdentityConflictError';
    this.existingStatus = existingStatus;
  }
}

// -------------------------------------------------------------------------------------------
// importManifest / proposeOperation — always produce drafts (I16), never touch a published row.
// -------------------------------------------------------------------------------------------

export interface ImportManifestInput {
  readonly gatekeeperId: string;
  readonly operations: readonly Operation[];
  readonly proposedBy: { readonly id: string; readonly kind: PrincipalKind };
  readonly activityId: string;
}

export interface SkippedOperation {
  readonly name: string;
  /** `published` or `deprecated` — the row `importManifest` refused to write over. */
  readonly status: PublishableStatus;
}

export interface ImportManifestResult {
  /** The `'import'`-origin drafts written (new, or replacing an existing draft of any origin). */
  readonly imported: readonly OperationRecord[];
  /** Names whose row is `published`/`deprecated` and was therefore left exactly as it was. */
  readonly skipped: readonly SkippedOperation[];
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
 *  version dimension existed). */
export async function importManifest(
  client: PoolClient,
  workspaceId: string,
  input: ImportManifestInput,
): Promise<ImportManifestResult> {
  const imported: OperationRecord[] = [];
  const skipped: SkippedOperation[] = [];
  for (const operation of input.operations) {
    const existing = await getOperation(client, workspaceId, input.gatekeeperId, operation.name);
    const version = existing?.version ?? 1;
    const written = await registerOperationDraftObject(client, workspaceId, {
      gatekeeperId: input.gatekeeperId,
      name: operation.name,
      version,
      operation,
      proposedBy: input.proposedBy,
      activityId: input.activityId,
      origin: 'import',
    });
    if (!written) {
      // The conditional write refused: the row exists and is not a draft. Read it back only to
      // report which terminal status blocked the import.
      const blocked = await getOperation(client, workspaceId, input.gatekeeperId, operation.name);
      skipped.push({ name: operation.name, status: blocked?.status ?? 'published' });
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

  let version: number;
  let draftOf: string | undefined;
  if (existing === null) {
    version = 1;
  } else if (existing.status === 'published') {
    version = existing.version + 1;
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
    // A conflicting draft, or a fully `deprecated` identity — unchanged pre-S3.12 rule.
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
    // the pre-read and the conditional write); report whatever is there now.
    const current = await getOperation(client, workspaceId, gatekeeperId, name);
    throw new OperationIdentityConflictError(gatekeeperId, name, current?.status ?? 'draft');
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

interface OperationObjectRow {
  id: string;
  identity_key: { gatekeeperId?: string; name?: string; version?: number } | null;
  properties: Record<string, unknown>;
}

/**
 * Reads the *current* row for an identity, regardless of status, or `null` if none exists at all.
 * S3.12: since a `published` row and a revision `draft` may now coexist for the same
 * `(gatekeeperId, name)`, "current" is whichever of those exists — `draft` first (a pending
 * revision is what `proposeOperation`/`importManifest` must react to), else `published`, else the
 * most recent `deprecated` row (so a fully-retired identity still names *a* status). At most one
 * `draft` and at most one `published` row ever exist per identity at a time, so this is still a
 * well-defined single answer, not an arbitrary pick among several live rows.
 */
export async function getOperation(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
  name: string,
): Promise<OperationRecord | null> {
  const result = await client.query<OperationObjectRow>(
    `select id, identity_key, properties
     from objects
     where workspace_id = $1
       and object_type = 'Operation'
       and identity_key ->> 'gatekeeperId' = $2
       and identity_key ->> 'name' = $3
     order by
       case properties ->> 'status'
         when 'draft' then 0
         when 'published' then 1
         else 2
       end,
       coalesce((properties ->> 'version')::int, 1) desc
     limit 1`,
    [workspaceId, gatekeeperId, name],
  );
  const row = result.rows[0];
  if (!row) return null;
  return toOperationRecord(gatekeeperId, name, row.id, row.properties);
}

/** Reads one Operation Object by its own id (S3.12 — `publishOperation`'s supersede step follows
 *  a revision draft's `draftOf` reference, which names a row by id, not by identity/version). */
async function getOperationById(
  client: PoolClient,
  workspaceId: string,
  objectId: string,
): Promise<OperationRecord | null> {
  const result = await client.query<OperationObjectRow>(
    `select id, identity_key, properties
     from objects
     where workspace_id = $1 and object_type = 'Operation' and id = $2`,
    [workspaceId, objectId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const gatekeeperId = row.identity_key?.gatekeeperId;
  const name = row.identity_key?.name;
  if (!gatekeeperId || !name) return null; // defensive — every Operation Object carries both
  return toOperationRecord(gatekeeperId, name, row.id, row.properties);
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
 */
export async function getPublishedOperation(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
  name: string,
): Promise<OperationRecord | null> {
  const result = await client.query<OperationObjectRow>(
    `select id, identity_key, properties
     from objects
     where workspace_id = $1
       and object_type = 'Operation'
       and identity_key ->> 'gatekeeperId' = $2
       and identity_key ->> 'name' = $3
       and properties ->> 'status' = 'published'
     limit 1`,
    [workspaceId, gatekeeperId, name],
  );
  const row = result.rows[0];
  if (!row) return null;
  return toOperationRecord(gatekeeperId, name, row.id, row.properties);
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
     order by updated_at asc`,
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
     order by updated_at asc`,
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
         order by updated_at asc`,
        [workspaceId, filter.gatekeeperId],
      )
    : await client.query<OperationObjectRow>(
        `select id, identity_key, properties
         from objects
         where workspace_id = $1
           and object_type = 'Operation'
         order by updated_at asc`,
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

/** `list_gatekeepers`'s own per-gate `operationCount` (S3.11) — one grouped query over every
 *  Gatekeeper's Operations, rather than `listOperations(...).length` once per gate in a loop
 *  (N+1), and rather than fetching every Operation's full `properties` just to count them.
 *  Counts **distinct Operation identities** (`gatekeeperId` + `name`), not rows — S3.12: a single
 *  identity can now project as several rows (a `deprecated` version alongside its `published`
 *  successor, or a pending revision `draft`), and this count is meant to answer "how many
 *  Operations does this gate expose", not "how many row versions exist". */
export async function countOperationsByGatekeeper(
  client: PoolClient,
  workspaceId: string,
): Promise<ReadonlyMap<string, number>> {
  const result = await client.query<{ gatekeeper_id: string | null; count: string }>(
    `select identity_key ->> 'gatekeeperId' as gatekeeper_id,
            count(distinct identity_key ->> 'name')::bigint as count
     from objects
     where workspace_id = $1 and object_type = 'Operation'
     group by identity_key ->> 'gatekeeperId'`,
    [workspaceId],
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
): Promise<OperationRecord> {
  const record = await getOperation(client, workspaceId, gatekeeperId, name);
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
}

/**
 * Publishes a draft Operation. Throws `OperationNotFoundError` if unknown, `IllegalTransition`
 * (`@nexttime/shared`) if not currently `draft`. The returned record carries the draft's full
 * definition (`operation`, `origin`, `proposedBy`) — `publish_operation`'s handler returns it
 * verbatim so the owner sees exactly what was just published (an agent's proposal is published
 * only this way, one at a time; see `publishManifest`).
 *
 * S3.12: when the draft being published is a revision (`draftOf` set — module doc comment), this
 * also deprecates the superseded row, in the same transaction (same `client`, no separate commit) —
 * but only if that row is *still* `published` right now (someone may have deprecated it directly
 * via `deprecateOperation` in the meantime; `PUBLISHABLE_TRANSITIONS` has no `deprecated →
 * deprecate` edge, so blindly retrying that transition would throw `IllegalTransition` and abort
 * this publish over a state that already reached exactly where this call wanted it). The returned
 * record's `supersedes` is that row's Object id — set only when this call actually deprecated it —
 * for `operation-manifest-handlers.ts` to record on the publish Activity's `metadata` (audit/
 * explain).
 */
export async function publishOperation(
  client: PoolClient,
  workspaceId: string,
  input: PublishOperationInput,
): Promise<OperationRecord> {
  const existing = await requireOperation(client, workspaceId, input.gatekeeperId, input.name);
  transition(PUBLISHABLE_TRANSITIONS, existing.status, 'publish');
  await setOperationStatusObject(
    client,
    workspaceId,
    { gatekeeperId: input.gatekeeperId, name: input.name, version: existing.version },
    'published',
  );

  let supersedes: string | undefined;
  if (existing.draftOf !== undefined) {
    const superseded = await getOperationById(client, workspaceId, existing.draftOf);
    if (superseded && superseded.status === 'published') {
      await setOperationStatusObject(
        client,
        workspaceId,
        { gatekeeperId: input.gatekeeperId, name: input.name, version: superseded.version },
        'deprecated',
      );
      supersedes = existing.draftOf;
    }
  }

  return { ...existing, status: 'published', ...(supersedes !== undefined ? { supersedes } : {}) };
}

export interface PublishManifestInput {
  readonly gatekeeperId: string;
}

export interface PublishManifestResult {
  readonly gatekeeperId: string;
  /** The `'import'`-origin drafts this call published, in `updated_at` order. */
  readonly publishedOperationNames: readonly string[];
  /** Drafts left as drafts because they are not the gate's own declaration — agent/human
   *  proposals (and legacy drafts with no recorded origin). Each needs an owner's explicit
   *  `publish_operation`, which shows its full definition first. */
  readonly skippedDraftOperationNames: readonly string[];
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
 * trivially a no-op.
 */
export async function publishManifest(
  client: PoolClient,
  workspaceId: string,
  input: PublishManifestInput,
): Promise<PublishManifestResult> {
  const drafts = await listDraftOperationsForGatekeeper(client, workspaceId, input.gatekeeperId);
  const publishedOperationNames: string[] = [];
  const skippedDraftOperationNames: string[] = [];
  for (const draft of drafts) {
    if (draft.origin !== 'import') {
      skippedDraftOperationNames.push(draft.name);
      continue;
    }
    await publishOperation(client, workspaceId, {
      gatekeeperId: input.gatekeeperId,
      name: draft.name,
    });
    publishedOperationNames.push(draft.name);
  }
  return { gatekeeperId: input.gatekeeperId, publishedOperationNames, skippedDraftOperationNames };
}

export interface DeprecateOperationInput {
  readonly gatekeeperId: string;
  readonly name: string;
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
  transition(PUBLISHABLE_TRANSITIONS, existing.status, 'deprecate');
  await setOperationStatusObject(
    client,
    workspaceId,
    { gatekeeperId: input.gatekeeperId, name: input.name, version: existing.version },
    'deprecated',
  );
  return { ...existing, status: 'deprecated' };
}

export { IllegalTransition };
