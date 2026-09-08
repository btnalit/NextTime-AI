import type { Operation, PrincipalKind, PublishableStatus } from '@nexttime/shared';
import { IllegalTransition, PUBLISHABLE_TRANSITIONS, transition } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { SqlGraphStore } from '../../substrate/graph/index.js';
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
 */

const graphStore = new SqlGraphStore();

export interface OperationRecord {
  readonly gatekeeperId: string;
  readonly name: string;
  readonly operation: Operation;
  readonly status: PublishableStatus;
  /** Which channel wrote the current draft (`substrate/ontology`'s `OperationOrigin`). Absent on
   *  rows written before drafts carried an origin — such a row is treated as nobody's draft:
   *  `publishManifest` skips it and `proposeOperation` refuses to replace it. */
  readonly origin?: OperationOrigin;
  /** The Principal that wrote the current draft — the `on_behalf_of` human for a Handle caller
   *  (I13), never a session id of its own. Absent on rows written before this was recorded. */
  readonly proposedBy?: { readonly id: string; readonly kind: PrincipalKind };
}

/** The bookkeeping keys `registerOperationDraftObject` stores alongside the manifest entry in
 *  `properties` — stripped back out of `OperationRecord.operation` here so what agents see through
 *  `list_allowed_operations` (and what `request_action` reads policy inputs from) is exactly the
 *  `Operation` shape, with the proposer identity surfaced only as `OperationRecord.proposedBy`. */
const OPERATION_BOOKKEEPING_KEYS = ['status', 'origin', 'proposedBy', 'proposedByKind'] as const;

function isOperationOrigin(value: unknown): value is OperationOrigin {
  return value === 'import' || value === 'agent' || value === 'human';
}

function toOperationRecord(
  gatekeeperId: string,
  name: string,
  properties: Record<string, unknown>,
): OperationRecord {
  const operationFields: Record<string, unknown> = { ...properties };
  for (const key of OPERATION_BOOKKEEPING_KEYS) delete operationFields[key];
  const status = properties.status as PublishableStatus | undefined;
  const proposedById = properties.proposedBy;
  const proposedByKind = properties.proposedByKind;
  return {
    gatekeeperId,
    name,
    operation: operationFields as unknown as Operation,
    status: status ?? 'draft',
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
 * already exists and is not the caller's own `'agent'`/`'human'` draft — a `published`/`deprecated`
 * row (never demoted or rewritten from the Handle channel), another Principal's draft, or an
 * `'import'` draft (I16). Maps to HTTP 409 `conflict` / WS `ILLEGAL_TRANSITION`
 * (interfaces/http/capability-route.ts, interfaces/ws/rpc.ts): the request is well-formed, the
 * row's *state* forbids it — the same reasoning as `IllegalTransition`. The message names the
 * existing row's status, never its proposer.
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
 *  in `skipped`; a name whose row is currently a draft of *any* origin is replaced by the gate's
 *  own declaration (the owner/CLI caller is the authority over the manifest, and an agent's
 *  proposal for that name is superseded, not published, by it). */
export async function importManifest(
  client: PoolClient,
  workspaceId: string,
  input: ImportManifestInput,
): Promise<ImportManifestResult> {
  const imported: OperationRecord[] = [];
  const skipped: SkippedOperation[] = [];
  for (const operation of input.operations) {
    const written = await registerOperationDraftObject(client, workspaceId, {
      gatekeeperId: input.gatekeeperId,
      name: operation.name,
      operation,
      proposedBy: input.proposedBy,
      activityId: input.activityId,
      origin: 'import',
    });
    if (!written) {
      // The conditional write refused: the row exists and is not a draft. Read it back only to
      // report which terminal status blocked the import.
      const existing = await getOperation(client, workspaceId, input.gatekeeperId, operation.name);
      skipped.push({ name: operation.name, status: existing?.status ?? 'published' });
      continue;
    }
    imported.push({
      gatekeeperId: input.gatekeeperId,
      name: operation.name,
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
 *  Operation as a draft. Creates a new draft, or revises the caller's own `'agent'`/`'human'`
 *  draft; any other existing row with that identity throws `OperationIdentityConflictError` and is
 *  left untouched — see the module doc comment for the full rule. `proposedBy.kind` decides the
 *  draft's `origin` (`'human'` for a human caller of this Handle-channel capability, `'agent'`
 *  otherwise). */
export async function proposeOperation(
  client: PoolClient,
  workspaceId: string,
  input: ProposeOperationInput,
): Promise<OperationRecord> {
  const { gatekeeperId } = input;
  const name = input.operation.name;

  // Pre-read: names the existing row's status in the error. Not the guard — the conditional write
  // below is (two dispatch transactions may interleave between this read and that write).
  const existing = await getOperation(client, workspaceId, gatekeeperId, name);
  if (existing && !isOwnProposalDraft(existing, input.proposedBy.id)) {
    throw new OperationIdentityConflictError(gatekeeperId, name, existing.status);
  }

  const origin: OperationOrigin = input.proposedBy.kind === 'human' ? 'human' : 'agent';
  const written = await registerOperationDraftObject(client, workspaceId, {
    gatekeeperId,
    name,
    operation: input.operation,
    proposedBy: input.proposedBy,
    activityId: input.activityId,
    origin,
    onlyOwnDraftOf: input.proposedBy.id,
  });
  if (!written) {
    // Lost a race with a concurrent write on the same identity (the row changed between the
    // pre-read and the conditional write); report whatever is there now.
    const current = await getOperation(client, workspaceId, gatekeeperId, name);
    throw new OperationIdentityConflictError(gatekeeperId, name, current?.status ?? 'draft');
  }

  return {
    gatekeeperId,
    name,
    operation: input.operation,
    status: 'draft',
    origin,
    proposedBy: input.proposedBy,
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

/** Reads one Operation regardless of status, or `null` if it does not exist. */
export async function getOperation(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
  name: string,
): Promise<OperationRecord | null> {
  const object = await graphStore.getObjectByIdentity(client, workspaceId, 'Operation', {
    gatekeeperId,
    name,
  });
  if (!object) return null;
  return toOperationRecord(gatekeeperId, name, object.properties);
}

/**
 * Resolves a **published** Operation only — `null` for a draft, deprecated, or unknown one. I17:
 * "resolve the published Operation (draft/unknown → I17: treat as unclassified require_approval,
 * never execute)" — the caller (`request_action`'s handler) is expected to treat `null` here
 * uniformly as "unclassified", not distinguish "no such Operation" from "not published yet".
 */
export async function getPublishedOperation(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
  name: string,
): Promise<OperationRecord | null> {
  const record = await getOperation(client, workspaceId, gatekeeperId, name);
  return record && record.status === 'published' ? record : null;
}

interface OperationObjectRow {
  identity_key: { gatekeeperId?: string; name?: string } | null;
  properties: Record<string, unknown>;
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
    `select identity_key, properties
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
    records.push(toOperationRecord(gatekeeperId, name, row.properties));
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
    `select identity_key, properties
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
    records.push(toOperationRecord(gatekeeperId, name, row.properties));
  }
  return records;
}

// -------------------------------------------------------------------------------------------
// publish / deprecate — human channel only (enforced at the capability-registry layer, I16).
// -------------------------------------------------------------------------------------------

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

export interface PublishOperationInput {
  readonly gatekeeperId: string;
  readonly name: string;
}

/** Publishes a draft Operation. Throws `OperationNotFoundError` if unknown, `IllegalTransition`
 *  (`@nexttime/shared`) if not currently `draft`. The returned record carries the draft's full
 *  definition (`operation`, `origin`, `proposedBy`) — `publish_operation`'s handler returns it
 *  verbatim so the owner sees exactly what was just published (an agent's proposal is published
 *  only this way, one at a time; see `publishManifest`). */
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
    { gatekeeperId: input.gatekeeperId, name: input.name },
    'published',
  );
  return { ...existing, status: 'published' };
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
 *  if not currently `published`. */
export async function deprecateOperation(
  client: PoolClient,
  workspaceId: string,
  input: DeprecateOperationInput,
): Promise<OperationRecord> {
  const existing = await requireOperation(client, workspaceId, input.gatekeeperId, input.name);
  transition(PUBLISHABLE_TRANSITIONS, existing.status, 'deprecate');
  await setOperationStatusObject(
    client,
    workspaceId,
    { gatekeeperId: input.gatekeeperId, name: input.name },
    'deprecated',
  );
  return { ...existing, status: 'deprecated' };
}

export { IllegalTransition };
