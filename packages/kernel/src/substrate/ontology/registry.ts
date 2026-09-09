import type { PoolClient } from 'pg';
import { mapOntologyVersionRow, nextOntologyVersion } from './loader.js';
import type { OntologyVersionDbRow, OntologyVersionRow } from './loader.js';
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

/** Validates `input.change` against `OntologyDefinitionSchema` and inserts it as a new `draft`
 *  `ontology_versions` row. Dispatch.ts's own `paramsSchema` check already validates `change`
 *  end-to-end for a real capability call (`propose_ontology_change`'s registry entry,
 *  `packages/shared/src/capabilities.ts`) — this second check stays so `registry.ts` is correct
 *  when called directly (tests, a future non-capability caller), not only behind dispatch. */
export async function proposeOntologyChange(
  client: PoolClient,
  workspaceId: string,
  input: ProposeOntologyChangeInput,
): Promise<OntologyVersionRow> {
  const parsed = OntologyDefinitionSchema.safeParse(input.change);
  if (!parsed.success) throw new OntologyChangeValidationError(parsed.error.issues);

  const version = await nextOntologyVersion(client, workspaceId, input.id);
  const result = await client.query<OntologyVersionDbRow>(
    `insert into ontology_versions (workspace_id, id, version, status, definition, proposed_by)
     values ($1, coalesce($2::uuid, gen_random_uuid()), $3, 'draft', $4::jsonb, $5)
     returning workspace_id, id, version, status, definition, proposed_by, published_by,
       created_at, published_at`,
    [workspaceId, input.id ?? null, version, JSON.stringify(parsed.data), input.proposedBy],
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
      `publish_ontology_version: no draft ontology_versions row (id=${ontologyId}, version=${version}) — already published/deprecated, or never proposed`,
    );
    this.name = 'OntologyDraftNotFoundError';
    this.ontologyId = ontologyId;
    this.version = version;
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
 *  never a double-publish). I12 (`definition` immutable once published) is enforced by the
 *  existing DB trigger (`ontology_versions_block_published_definition_update`,
 *  `migrations/core/0011_ontology_versions_status_lock.sql`) — this UPDATE never touches
 *  `definition`, so the trigger's own `old.status = 'published'` branch never applies to it. */
export async function publishOntologyDraft(
  client: PoolClient,
  workspaceId: string,
  input: PublishOntologyDraftInput,
): Promise<OntologyVersionRow> {
  const result = await client.query<OntologyVersionDbRow>(
    `update ontology_versions
       set status = 'published', published_by = $4, published_at = now()
     where workspace_id = $1 and id = $2 and version = $3 and status = 'draft'
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
 *  per kind. On a name collision across *different* families (not exercised by `ops-assets-v1`,
 *  which shares no ObjectType/ActionType name with `platform-meta`), the family later in `families`
 *  wins for ObjectType/ActionType — `families` is ordered by `id` (`loadVisibleOntology`'s own
 *  `order by t.id`), an arbitrary but deterministic tie-break, not a meaningful precedence; a
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

export interface ValidateLinkInput {
  readonly linkType: string;
  readonly sourceType: string;
  readonly targetType: string;
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

  const signatures = linkTypes.get(input.linkType);
  if (!signatures || signatures.length === 0) {
    return { valid: false, errors: [`unknown LinkType "${input.linkType}"`] };
  }

  const matches = (value: string, expected: string) => expected === '*' || expected === value;
  const accepted = signatures.some(
    (signature) =>
      matches(input.sourceType, signature.domain) && matches(input.targetType, signature.range),
  );
  if (accepted) return { valid: true };

  const allowed = signatures.map((s) => `${s.domain} -> ${s.range}`).join(', ');
  return {
    valid: false,
    errors: [
      `LinkType "${input.linkType}" does not permit ${input.sourceType} -> ${input.targetType} (allowed: ${allowed})`,
    ],
  };
}
