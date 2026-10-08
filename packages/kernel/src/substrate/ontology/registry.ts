import type { PrincipalKind } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { lockOntologyFamily, mapOntologyVersionRow, nextOntologyVersion } from './loader.js';
import type { OntologyVersionDbRow, OntologyVersionRow } from './loader.js';
import { assertOntologyNamespace } from './namespace.js';
import type { ActionTypeDefinition, ObjectTypeDefinition, OntologyDefinition } from './schema.js';
import { OntologyDefinitionSchema } from './schema.js';

/**
 * substrate/ontology/registry: the runtime, agent-facing half of the ontology registry (docs/
 * development-tasks.md S3.1 deliverable `ontology/{schema,registry}.ts`) — `propose_ontology_change`
 * / `publish_ontology_version` / `get_type` / `list_types` / `validate`'s actual logic, called by
 * `application/gateway/ontology-handlers.ts`.
 *
 * Distinct from `loader.ts`'s domain-pack mechanism (git-reviewed `ontology/*.yaml` files,
 * published directly with no draft phase, design doc §7.10): this module is the *runtime* path —
 * an agent proposing a change from inside a Handle session, a human publishing it, and every
 * caller asking "what does this type mean" / "is this link legal". The two mechanisms share only
 * `ontology_versions` as their storage and `nextOntologyVersion` as their version arithmetic; they
 * never call into each other.
 *
 * **I16 draft isolation** — "reuse the guard from PR #71" (this task's own dispatch): PR #71
 * (`fix/operation-draft-isolation`, `meta-objects.ts`'s `registerOperationDraftObject`) fixed a
 * race where an unconditional read-then-write let a Handle-channel proposal overwrite *someone
 * else's* pending draft in place, because that function upserts by a fixed identity (no version
 * component) — a second proposal against the same identity necessarily either replaces or
 * conflicts with the first. `ontology_versions`' own identity is `(workspace_id, id, version)`,
 * with `version` an ever-incrementing part of the *key itself* — `proposeOntologyChange` below
 * always **inserts a new row** at the next version number, never updates an existing row in place,
 * so there is no "whose draft am I overwriting" question to guard against: two concurrent
 * proposals against the same `id` simply produce two sibling draft rows (e.g. v3 proposed by
 * Alice, v4 proposed by Bob), each visible only to its own proposer (`loadVisibleOntology` below).
 * The actual mechanism being reused from PR #71 is not the ON CONFLICT overwrite guard itself (this
 * module has no overwrite path for it to protect) but the *shape* of I16 it enforces — "a Handle
 * caller may see/act on its own draft, never anyone else's" — implemented here as a read-time
 * filter (`proposed_by = caller`) rather than a write-time conditional, which is the correct
 * mechanism for an append-only identity and does not fork a second isolation design.
 *
 * A concurrent **first** proposal against a brand-new `id` (two different proposers each omitting
 * `id`) cannot collide at all — each gets its own fresh `gen_random_uuid()`. A concurrent
 * **revision** proposal against the *same existing* `id` computing the same `nextOntologyVersion`
 * can, in principle, race on the primary key (`(workspace_id, id, version)`) the same way
 * `publishOntologyVersion`/`loader.ts` already could before this task — the second INSERT fails
 * with a unique-violation and the caller retries; this is an accepted, pre-existing race profile
 * (not a correctness regression this task introduces), not silently corrupted state.
 */

// -------------------------------------------------------------------------------------------
// proposeOntologyChange
// -------------------------------------------------------------------------------------------

export type { OntologyVersionRow };

export class OntologyChangeValidationError extends Error {
  readonly issues: unknown;
  constructor(issues: unknown) {
    super('propose_ontology_change: change does not match OntologyDefinitionSchema');
    this.name = 'OntologyChangeValidationError';
    this.issues = issues;
  }
}

export interface ProposeOntologyChangeInput {
  /** Omit to start a brand-new ontology family (fresh id, version 1); given, proposes the next
   *  version under that existing family — see this module's own doc comment on why this never
   *  collides with another proposer's own pending draft. */
  readonly id?: string;
  readonly change: unknown;
  readonly proposedBy: string;
}

/** R-60: the family's published head — its highest `published` version, the one every reader of
 *  "the published ontology" (`loadPublishedLinkTypes`, `loadVisibleOntology` for anyone without a
 *  newer draft) takes for that family — or null when nothing of it is published. */
async function loadPublishedHeadVersion(
  client: PoolClient,
  workspaceId: string,
  id: string,
): Promise<number | null> {
  const result = await client.query<{ head: number | null }>(
    `select max(version) as head from ontology_versions
     where workspace_id = $1 and id = $2 and status = 'published'`,
    [workspaceId, id],
  );
  return result.rows[0]?.head ?? null;
}

/** Validates `input.change` against `OntologyDefinitionSchema` and inserts it as a new `draft`
 *  `ontology_versions` row. Dispatch.ts's own `paramsSchema` check already validates `change`
 *  end-to-end for a real capability call (`propose_ontology_change`'s registry entry,
 *  `packages/shared/src/capabilities.ts`) — this second check stays so `registry.ts` is correct
 *  when called directly (tests, a future non-capability caller), not only behind dispatch.
 *
 *  R-60: the draft records its base — the family's published head right now (null for a new
 *  family, or one with nothing published) — so `publishOntologyDraft` can refuse it once that
 *  head has moved. Read without the family lock on purpose: a publish that commits concurrently
 *  can only leave the recorded base *older* than the head, which the publish check then refuses
 *  (the proposer proposes again) — never a base newer than what the draft was written against. */
export async function proposeOntologyChange(
  client: PoolClient,
  workspaceId: string,
  input: ProposeOntologyChangeInput,
): Promise<OntologyVersionRow> {
  const parsed = OntologyDefinitionSchema.safeParse(input.change);
  if (!parsed.success) throw new OntologyChangeValidationError(parsed.error.issues);

  const baseVersion = input.id
    ? await loadPublishedHeadVersion(client, workspaceId, input.id)
    : null;
  const version = await nextOntologyVersion(client, workspaceId, input.id);
  const result = await client.query<OntologyVersionDbRow>(
    `insert into ontology_versions
       (workspace_id, id, version, status, definition, proposed_by, base_version)
     values ($1, coalesce($2::uuid, gen_random_uuid()), $3, 'draft', $4::jsonb, $5, $6)
     returning workspace_id, id, version, status, definition, proposed_by, published_by,
       created_at, published_at`,
    [
      workspaceId,
      input.id ?? null,
      version,
      JSON.stringify(parsed.data),
      input.proposedBy,
      baseVersion,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('proposeOntologyChange: INSERT ... RETURNING produced no row');
  return mapOntologyVersionRow(row);
}

// -------------------------------------------------------------------------------------------
// publishOntologyDraft
// -------------------------------------------------------------------------------------------

export class OntologyDraftNotFoundError extends Error {
  readonly ontologyId: string;
  readonly version: number;
  constructor(ontologyId: string, version: number) {
    super(
      `no draft ontology_versions row (id=${ontologyId}, version=${version}) of yours — already published/deprecated, never proposed, or proposed by someone else`,
    );
    this.name = 'OntologyDraftNotFoundError';
    this.ontologyId = ontologyId;
    this.version = version;
  }
}

/** R-60: the draft was proposed against a published version that is no longer the family's head —
 *  someone published another version of it since (another proposer's draft, a domain pack, a
 *  module upgrade). Every version is a full replacement definition, so publishing this one would
 *  either do nothing (a lower number than the head) or silently drop whatever the newer version
 *  added; the proposer proposes again from the current head instead. */
export class OntologyBaseMovedError extends Error {
  readonly code = 'ontology_base_moved' as const;
  readonly ontologyId: string;
  readonly version: number;
  /** The published version the draft was proposed against (null: nothing was published then). */
  readonly baseVersion: number | null;
  /** The family's published head now. */
  readonly publishedVersion: number | null;
  constructor(
    ontologyId: string,
    version: number,
    baseVersion: number | null,
    publishedVersion: number | null,
  ) {
    super(
      `draft ontology version (id=${ontologyId}, version=${version}) was proposed against ${
        baseVersion === null ? 'no published version' : `published version ${baseVersion}`
      }, but the family's published version is now ${
        publishedVersion === null ? 'none' : publishedVersion
      } — propose the change again from the current version`,
    );
    this.name = 'OntologyBaseMovedError';
    this.ontologyId = ontologyId;
    this.version = version;
    this.baseVersion = baseVersion;
    this.publishedVersion = publishedVersion;
  }
}

export interface PublishOntologyDraftInput {
  readonly id: string;
  readonly version: number;
  readonly publishedBy: string;
}

/** Atomically transitions one exact `draft` row (`(workspaceId, id, version)` — the table's own
 *  primary key) to `published` (I16: human channel only, enforced by the capability registry
 *  before this ever runs — this function does not itself check `channel`). The `WHERE status =
 *  'draft'` guard makes this safe under a race (two concurrent publishes of the same row: the
 *  first to commit wins, the second affects zero rows and throws `OntologyDraftNotFoundError` —
 *  never a double-publish). `proposed_by = publishedBy` (STATUS leftover 100): only the draft's
 *  own proposer may publish it — a draft is visible to its proposer alone (`loadVisibleOntology`,
 *  `listOntologyVersions`), so anyone else would be publishing a definition they never saw; an
 *  entry agent's proposal is still the person's own (`proposed_by` is the Handle's `obo`).
 *  Another principal's draft affects zero rows and throws the same `OntologyDraftNotFoundError` as
 *  a missing one — the read side's "absent, not a 403" convention, so existence never leaks.
 *  I12 (`definition` immutable once published) is enforced by the
 *  existing DB trigger (`ontology_versions_block_published_definition_update`,
 *  `migrations/core/0011_ontology_versions_status_lock.sql`) — this UPDATE never touches
 *  `definition`, so the trigger's own `old.status = 'published'` branch never applies to it.
 *
 *  R-60: under the family lock (`lockOntologyFamily`, shared with the loader's
 *  `publishOntologyVersion`), the draft's recorded `base_version` must still be the family's
 *  published head, else `OntologyBaseMovedError` and nothing changes. The lock makes "check the
 *  head, then publish" one step for every publisher of the family: two drafts made from the same
 *  base can no longer both pass. The not-found check runs first, so a draft that is not the
 *  caller's never reveals anything about its family.
 *
 *  I-P1 (`namespace.ts`): still under that lock (it takes the workspace's namespace lock first),
 *  the draft's ObjectType / ActionType names must not belong to another family's published head,
 *  else `OntologyNamespaceConflictError` and nothing changes. */
export async function publishOntologyDraft(
  client: PoolClient,
  workspaceId: string,
  input: PublishOntologyDraftInput,
): Promise<OntologyVersionRow> {
  await lockOntologyFamily(client, workspaceId, input.id);
  const draft = await client.query<{
    base_version: number | null;
    definition: OntologyDefinition;
  }>(
    `select base_version, definition from ontology_versions
     where workspace_id = $1 and id = $2 and version = $3 and status = 'draft'
       and proposed_by = $4`,
    [workspaceId, input.id, input.version, input.publishedBy],
  );
  const draftRow = draft.rows[0];
  if (!draftRow) throw new OntologyDraftNotFoundError(input.id, input.version);
  const head = await loadPublishedHeadVersion(client, workspaceId, input.id);
  if (head !== draftRow.base_version) {
    throw new OntologyBaseMovedError(input.id, input.version, draftRow.base_version, head);
  }
  await assertOntologyNamespace(client, workspaceId, input.id, draftRow.definition);

  const result = await client.query<OntologyVersionDbRow>(
    `update ontology_versions
       set status = 'published', published_by = $4, published_at = now()
     where workspace_id = $1 and id = $2 and version = $3 and status = 'draft'
       and proposed_by = $4
     returning workspace_id, id, version, status, definition, proposed_by, published_by,
       created_at, published_at`,
    [workspaceId, input.id, input.version, input.publishedBy],
  );
  const row = result.rows[0];
  if (!row) throw new OntologyDraftNotFoundError(input.id, input.version);
  return mapOntologyVersionRow(row);
}

// -------------------------------------------------------------------------------------------
// loadVisibleOntology / getType / listTypes / validateLink — the read side every one of
// get_type/list_types/validate shares: "every ontology family's latest version visible to this
// caller" (every `published` row, plus the caller's *own* `draft` rows — I16's read half), merged
// into one flat type namespace and looked up by name.
// -------------------------------------------------------------------------------------------

export interface VisibleOntologyFamily {
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly definition: OntologyDefinition;
}

/**
 * Per `id` family, the highest version visible to `callerPrincipalId` — a `published` row is
 * visible to everyone; a `draft` row only to the principal who proposed it (I16). The correlated
 * subquery picks, for each `id`, the max version among rows this caller may see, then returns only
 * that one row per family (never a lower version shadowed by a newer visible one, and never a row
 * this caller cannot see at all). A caller with their own newer draft over an already-published
 * family therefore sees *their* draft's content for that family, not the published one — exactly
 * "propose a private draft; visible only to the proposer until published".
 */
export async function loadVisibleOntology(
  client: PoolClient,
  workspaceId: string,
  callerPrincipalId: string,
): Promise<readonly VisibleOntologyFamily[]> {
  const result = await client.query<{
    id: string;
    version: number;
    status: string;
    definition: OntologyDefinition;
  }>(
    `select t.id, t.version, t.status, t.definition
     from ontology_versions t
     where t.workspace_id = $1
       and (t.status = 'published' or (t.status = 'draft' and t.proposed_by = $2))
       and t.version = (
         select max(t2.version)
         from ontology_versions t2
         where t2.workspace_id = t.workspace_id
           and t2.id = t.id
           and (t2.status = 'published' or (t2.status = 'draft' and t2.proposed_by = $2))
       )
     order by t.id`,
    [workspaceId, callerPrincipalId],
  );
  return result.rows;
}

/** One ObjectType/LinkType/ActionType definition, tagged with which kind it is (mirrors
 *  `wire/ontology.ts`'s `OntologyTypeWireSchema` discriminated union — this is the pre-wire shape
 *  the handler projects from). A LinkType groups every signature (domain/range pair) sharing its
 *  name across every visible family into one `signatures[]` — see `ontology-definition.ts`'s own
 *  doc comment on why one name may carry more than one signature. */
export type OntologyTypeEntry =
  | ({ readonly kind: 'object' } & ObjectTypeDefinition)
  | {
      readonly kind: 'link';
      readonly name: string;
      readonly signatures: readonly LinkTypeSignature[];
    }
  | ({ readonly kind: 'action' } & ActionTypeDefinition);

export interface LinkTypeSignature {
  readonly domain: string;
  readonly range: string;
  readonly description: string;
}

/** Merges every visible family's `objectTypes`/`linkTypes`/`actionTypes` into one flat namespace
 *  per kind. Published families cannot collide on an ObjectType/ActionType name (I-P1, refused at
 *  publish by `namespace.ts`); only a caller's own draft can still shadow another family's type in
 *  that caller's own view, and then the family later in `families` wins — `families` is ordered by
 *  `id` (`loadVisibleOntology`'s own `order by t.id`), an arbitrary but deterministic tie-break,
 *  not a meaningful precedence (publishing that draft is refused); a
 *  LinkType name instead accumulates signatures from every family that declares it, since two
 *  packs legitimately reusing the same relationship name for their own domain is not a conflict
 *  the way two same-named ObjectTypes would be. */
function mergeVisibleOntology(families: readonly VisibleOntologyFamily[]): {
  objectTypes: Map<string, ObjectTypeDefinition>;
  linkTypes: Map<string, LinkTypeSignature[]>;
  actionTypes: Map<string, ActionTypeDefinition>;
} {
  const objectTypes = new Map<string, ObjectTypeDefinition>();
  const linkTypes = new Map<string, LinkTypeSignature[]>();
  const actionTypes = new Map<string, ActionTypeDefinition>();

  for (const family of families) {
    for (const objectType of family.definition.objectTypes) {
      objectTypes.set(objectType.name, objectType);
    }
    for (const linkType of family.definition.linkTypes) {
      const existing = linkTypes.get(linkType.name) ?? [];
      existing.push({
        domain: linkType.domain,
        range: linkType.range,
        description: linkType.description,
      });
      linkTypes.set(linkType.name, existing);
    }
    for (const actionType of family.definition.actionTypes ?? []) {
      actionTypes.set(actionType.name, actionType);
    }
  }

  return { objectTypes, linkTypes, actionTypes };
}

/** `get_type`'s logic: looks up `typeName` across every ontology family visible to
 *  `callerPrincipalId`, checking ObjectType, then LinkType, then ActionType (names are not
 *  required to be unique *across* the three kinds — the first kind to match wins; ops-assets-v1
 *  and platform-meta never collide this way in practice). `null` if no kind has a type by this
 *  name. */
export async function getType(
  client: PoolClient,
  workspaceId: string,
  callerPrincipalId: string,
  typeName: string,
): Promise<OntologyTypeEntry | null> {
  const families = await loadVisibleOntology(client, workspaceId, callerPrincipalId);
  const { objectTypes, linkTypes, actionTypes } = mergeVisibleOntology(families);

  const objectType = objectTypes.get(typeName);
  if (objectType) return { kind: 'object', ...objectType };

  const signatures = linkTypes.get(typeName);
  if (signatures) return { kind: 'link', name: typeName, signatures };

  const actionType = actionTypes.get(typeName);
  if (actionType) return { kind: 'action', ...actionType };

  return null;
}

/** `list_types`'s logic — every currently-visible type, optionally filtered to one `kind`. */
export async function listTypes(
  client: PoolClient,
  workspaceId: string,
  callerPrincipalId: string,
  kind?: 'object' | 'link' | 'action',
): Promise<readonly OntologyTypeEntry[]> {
  const families = await loadVisibleOntology(client, workspaceId, callerPrincipalId);
  const { objectTypes, linkTypes, actionTypes } = mergeVisibleOntology(families);

  const items: OntologyTypeEntry[] = [];
  if (kind === undefined || kind === 'object') {
    for (const objectType of objectTypes.values()) items.push({ kind: 'object', ...objectType });
  }
  if (kind === undefined || kind === 'link') {
    for (const [name, signatures] of linkTypes) items.push({ kind: 'link', name, signatures });
  }
  if (kind === undefined || kind === 'action') {
    for (const actionType of actionTypes.values()) items.push({ kind: 'action', ...actionType });
  }
  return items;
}

/**
 * S5.1 (docs/development-tasks.md §5b S5.1; design §5.4 I2): the LinkType namespace a Link
 * *write* is checked against — every family's latest **published** version only. Deliberately
 * narrower than `loadVisibleOntology` above (which also admits the caller's own pending drafts,
 * I16's read half, so `validate` / `get_type` can answer about a draft): a draft is a proposal,
 * and letting its proposer write Facts against types nobody has published would make the
 * invariant depend on who is asking. Same "latest version per family" rule otherwise.
 */
export async function loadPublishedLinkTypes(
  client: PoolClient,
  workspaceId: string,
): Promise<ReadonlyMap<string, readonly LinkTypeSignature[]>> {
  const result = await client.query<{
    id: string;
    version: number;
    status: string;
    definition: OntologyDefinition;
  }>(
    `select t.id, t.version, t.status, t.definition
     from ontology_versions t
     where t.workspace_id = $1
       and t.status = 'published'
       and t.version = (
         select max(t2.version)
         from ontology_versions t2
         where t2.workspace_id = t.workspace_id
           and t2.id = t.id
           and t2.status = 'published'
       )
     order by t.id`,
    [workspaceId],
  );
  return mergeVisibleOntology(result.rows).linkTypes;
}

export interface ValidateLinkInput {
  readonly linkType: string;
  readonly sourceType: string;
  readonly targetType: string;
}

/** The outcome `evaluateLink` (and, through it, the S5.1 write guard) reports — three-valued on
 *  purpose so the guard's error body can tell an agent *which* of the two things to fix. */
export type LinkEvaluation =
  | { readonly kind: 'declared_and_valid' }
  | { readonly kind: 'undeclared_link_type' }
  | {
      readonly kind: 'domain_range_violation';
      /** Every `domain -> range` signature the LinkType does declare. */
      readonly expected: readonly string[];
    };

const matchesTypeName = (value: string, expected: string): boolean =>
  expected === '*' || expected === value;

/** Pure half of `validateLink`, shared with the S5.1 write guard: does some signature of
 *  `input.linkType` in `linkTypes` accept `input.sourceType -> input.targetType` (`"*"` matches
 *  any type on either side)? */
export function evaluateLink(
  linkTypes: ReadonlyMap<string, readonly LinkTypeSignature[]>,
  input: ValidateLinkInput,
): LinkEvaluation {
  const signatures = linkTypes.get(input.linkType);
  if (!signatures || signatures.length === 0) return { kind: 'undeclared_link_type' };
  const accepted = signatures.some(
    (signature) =>
      matchesTypeName(input.sourceType, signature.domain) &&
      matchesTypeName(input.targetType, signature.range),
  );
  if (accepted) return { kind: 'declared_and_valid' };
  return {
    kind: 'domain_range_violation',
    expected: signatures.map((s) => `${s.domain} -> ${s.range}`),
  };
}

export interface ValidateLinkResult {
  readonly valid: boolean;
  readonly errors?: readonly string[];
}

/** `validate`'s logic (I2 "Link 符合 LinkType 的 domain/range") — `input` is valid when some
 *  LinkType signature named `input.linkType`, among every family visible to `callerPrincipalId`,
 *  accepts `input.sourceType` as `domain` (exact match or the `"*"` wildcard) and
 *  `input.targetType` as `range` (same rule). */
export async function validateLink(
  client: PoolClient,
  workspaceId: string,
  callerPrincipalId: string,
  input: ValidateLinkInput,
): Promise<ValidateLinkResult> {
  const families = await loadVisibleOntology(client, workspaceId, callerPrincipalId);
  const { linkTypes } = mergeVisibleOntology(families);

  const evaluation = evaluateLink(linkTypes, input);
  if (evaluation.kind === 'declared_and_valid') return { valid: true };
  if (evaluation.kind === 'undeclared_link_type') {
    return { valid: false, errors: [`unknown LinkType "${input.linkType}"`] };
  }
  return {
    valid: false,
    errors: [
      `LinkType "${input.linkType}" does not permit ${input.sourceType} -> ${input.targetType} (allowed: ${evaluation.expected.join(', ')})`,
    ],
  };
}

// -------------------------------------------------------------------------------------------
// listOntologyVersions — closing wave C5b (coverage gap G1 part 2): the read side
// `list_ontology_versions` needs, distinct from `loadVisibleOntology` above. That function merges
// every visible family into "the current type namespace" (one row per family, by design — `get_type`
// /`list_types`/`validate` all just want to know what a type currently means). This one instead
// returns *raw* `ontology_versions` rows — one per (id, version) — so a person can find a specific
// draft's own id/version to hand to `publish_ontology_version`; the shape and visibility rule are
// deliberately borrowed byte-for-byte from `application/worker/definitions.ts`'s
// `listWorkerDefinitionsPage` (published rows, workspace-wide, plus the caller's own `draft` rows,
// I16's read half — same predicate `application/worker/skills.ts`'s `listSkills` also uses), not
// invented fresh for this one capability.
// -------------------------------------------------------------------------------------------

export interface OntologyVersionListItem {
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly definition: OntologyDefinition;
  readonly proposedBy: {
    readonly id: string;
    readonly kind: PrincipalKind;
    readonly displayName: string | null;
  };
  readonly createdAt: Date;
  /** R-61: for a draft, the published version of its own family it was proposed against (R-60's
   *  `base_version`) with that version's definition — what the draft changes is exactly the diff
   *  between the two, within this one family. Null for a draft of a new family (or one with
   *  nothing published when it was proposed), and always null for a published row: a base only
   *  means something while there is still a decision to make. */
  readonly base: {
    readonly version: number;
    readonly definition: OntologyDefinition;
  } | null;
}

interface OntologyVersionListDbRow {
  id: string;
  version: number;
  status: string;
  definition: OntologyDefinition;
  created_at: Date;
  proposer_id: string;
  proposer_kind: PrincipalKind;
  proposer_display_name: string | null;
  base_version: number | null;
  base_definition: OntologyDefinition | null;
}

function mapListRow(row: OntologyVersionListDbRow): OntologyVersionListItem {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    definition: row.definition,
    proposedBy: {
      id: row.proposer_id,
      kind: row.proposer_kind,
      displayName: row.proposer_display_name,
    },
    createdAt: row.created_at,
    base:
      row.base_version !== null && row.base_definition !== null
        ? { version: row.base_version, definition: row.base_definition }
        : null,
  };
}

export const DEFAULT_LIST_ONTOLOGY_VERSIONS_LIMIT = 100;
export const MAX_LIST_ONTOLOGY_VERSIONS_LIMIT = 500;

const ONTOLOGY_VERSION_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `base64url(createdAt|id|version)`: the `base64url(createdAt|id)` cursor shape
 *  `listWorkerDefinitionsPage`/`listSkills` use, plus `version` — unlike those tables, one
 *  ontology family (`id`) carries many rows, and two versions of one family created in the same
 *  millisecond (a module install that publishes twice in one transaction, a seed) tie on
 *  `(createdAt, id)`; a page ending on the first of them used to skip the second. A two-part cursor
 *  issued before this change still decodes and means what it meant then (`LEGACY_CURSOR_VERSION`). */
function encodeListOntologyVersionsCursor(createdAt: Date, id: string, version: number): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}|${version}`, 'utf8').toString('base64url');
}

/** Below every real `version` (a positive int): a legacy two-part cursor compares below all of
 *  them, so the next page skips every version of that `(createdAt, id)`, as it did before. */
const LEGACY_CURSOR_VERSION = 0;

function decodeListOntologyVersionsCursor(
  cursor: string | undefined,
): { readonly createdAt: string; readonly id: string; readonly version: number } | null {
  if (!cursor) return null;
  try {
    const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (parts.length !== 2 && parts.length !== 3) return null;
    const [createdAt = '', id = '', versionText] = parts;
    const version = versionText === undefined ? LEGACY_CURSOR_VERSION : Number(versionText);
    if (
      !createdAt ||
      Number.isNaN(Date.parse(createdAt)) ||
      !ONTOLOGY_VERSION_UUID_PATTERN.test(id) ||
      !Number.isSafeInteger(version) ||
      (versionText !== undefined && version < 1)
    ) {
      return null;
    }
    return { createdAt, id, version };
  } catch {
    return null;
  }
}

export interface ListOntologyVersionsFilter {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface OntologyVersionsPage {
  readonly items: readonly OntologyVersionListItem[];
  readonly nextCursor?: string;
  readonly truncated?: true;
}

/**
 * `list_ontology_versions`'s logic: every `published` `ontology_versions` row (workspace-wide, any
 * version — a family may carry more than one row still marked `published`, same as
 * `worker_definitions`, since nothing here deprecates an older published ontology version) plus
 * `callerPrincipalId`'s own `draft` rows (I16 — never another principal's), newest `created_at`
 * first, keyset-paginated on `(createdAt, id, version)`. `proposed_by` is joined against
 * `principals` for the wire shape's resolved `{id, kind, displayName}` — the FK
 * (`ontology_versions.proposed_by references principals`) guarantees the join always finds a row,
 * so this is a plain `join`, not a `left join`.
 *
 * R-61: a draft row also carries its `base` — a `left join` to the same family's row at the
 * draft's `base_version` (R-60). That row is published by construction (a base is only ever taken
 * from `published` rows, and a published row never goes back to draft), and the join still
 * excludes drafts outright, so it can never surface another principal's draft (I16).
 */
export async function listOntologyVersions(
  client: PoolClient,
  workspaceId: string,
  callerPrincipalId: string,
  filter: ListOntologyVersionsFilter = {},
): Promise<OntologyVersionsPage> {
  const requestedLimit = filter.limit ?? DEFAULT_LIST_ONTOLOGY_VERSIONS_LIMIT;
  const limit = Math.min(Math.max(requestedLimit, 1), MAX_LIST_ONTOLOGY_VERSIONS_LIMIT);
  const cursor = decodeListOntologyVersionsCursor(filter.cursor);

  const result = await client.query<OntologyVersionListDbRow>(
    `select t.id, t.version, t.status, t.definition, t.created_at,
            p.id as proposer_id, p.kind as proposer_kind, p.display_name as proposer_display_name,
            b.version as base_version, b.definition as base_definition
     from ontology_versions t
     join principals p on p.workspace_id = t.workspace_id and p.id = t.proposed_by
     left join ontology_versions b
       on t.status = 'draft'
      and b.workspace_id = t.workspace_id
      and b.id = t.id
      and b.version = t.base_version
      and b.status <> 'draft'
     where t.workspace_id = $1
       and (
         t.status = 'published'
         or (t.status = 'draft' and t.proposed_by = $2)
       )
       and (
         $3::timestamptz is null
         or (date_trunc('milliseconds', t.created_at), t.id, t.version)
            < ($3::timestamptz, $4::uuid, $5::int)
       )
     order by date_trunc('milliseconds', t.created_at) desc, t.id desc, t.version desc
     limit $6`,
    [
      workspaceId,
      callerPrincipalId,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      cursor?.version ?? null,
      limit + 1,
    ],
  );

  const rows = result.rows.slice(0, limit).map(mapListRow);
  const last = rows[rows.length - 1];
  const nextCursor =
    result.rows.length > limit && last
      ? encodeListOntologyVersionsCursor(last.createdAt, last.id, last.version)
      : undefined;
  const truncated = requestedLimit > MAX_LIST_ONTOLOGY_VERSIONS_LIMIT ? (true as const) : undefined;
  return {
    items: rows,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    ...(truncated !== undefined ? { truncated } : {}),
  };
}
