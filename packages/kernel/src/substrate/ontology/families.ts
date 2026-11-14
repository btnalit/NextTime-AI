import {
  ONTOLOGY_FAMILY_NAME_MAX_LENGTH,
  ONTOLOGY_FAMILY_NAME_PATTERN,
  PLATFORM_META_ONTOLOGY_FAMILY,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';

/**
 * substrate/ontology/families: an ontology family's name (legacy 706, migrations/core/0056
 * `ontology_families`). A family is `ontology_versions.id` in its workspace; a named one also has a
 * row here, written in the transaction that publishes its version (`loader.ts`'s
 * `publishOntologyVersion`, `family`). Who names one:
 *   - the platform-meta ontology, `platform-meta` (`seedPlatformMetaOntology`, a fresh id per
 *     workspace);
 *   - a pack's or a module's install and an admin proposal, the item's `family`
 *     (`application/change-plan/ontology-item.ts`);
 *   - the command line's `seed-domain-pack`, its `--pack-name`.
 * The last two derive the id from the name (`deriveOntologyPackId`, F2). A family published from a
 * console draft (`propose_ontology_change`, a fresh id) has no name.
 *
 * F1: a name is unique in its workspace and never changes — the table's unique constraint, its
 * grants (`select, insert`) and its trigger. F3: `platform-meta` is the platform-meta ontology's;
 * where a pack, an admin proposal or the command line names a family, it is refused
 * (`assertOntologyFamilyName`), and the unique name refuses it in the table should one get through.
 */

/** A family name a pack, admin proposal or command-line seed may not use: not a pack name's shape,
 *  longer than {@link ONTOLOGY_FAMILY_NAME_MAX_LENGTH}, or the platform-meta ontology's (F3). */
export class OntologyFamilyNameError extends Error {
  readonly code = 'ontology_family_name_invalid' as const;
  constructor(reason: string) {
    super(reason);
    this.name = 'OntologyFamilyNameError';
  }
}

/** Refuses a name a pack, admin proposal or the command line may not give a family (see
 *  `OntologyFamilyNameError`). The platform-meta seed names its family without it. */
export function assertOntologyFamilyName(name: string): void {
  if (name === PLATFORM_META_ONTOLOGY_FAMILY) {
    throw new OntologyFamilyNameError(
      `"${PLATFORM_META_ONTOLOGY_FAMILY}" is the platform's own ontology in every workspace; name the family otherwise`,
    );
  }
  if (name.length > ONTOLOGY_FAMILY_NAME_MAX_LENGTH || !ONTOLOGY_FAMILY_NAME_PATTERN.test(name)) {
    throw new OntologyFamilyNameError(
      `"${name}" is not an ontology family name: lower-case words joined by single hyphens, at most ${ONTOLOGY_FAMILY_NAME_MAX_LENGTH} characters`,
    );
  }
}

/** Records `name` as family `id`'s in `workspaceId` (F1): written once, with its family's first
 *  named publish; a later publish under the same name changes nothing. Throws when the family is
 *  named otherwise already, or the name is another family's (`OntologyFamilyNameError`) — neither
 *  happens while F2 and F3 hold. */
export async function nameOntologyFamily(
  client: PoolClient,
  workspaceId: string,
  id: string,
  name: string,
): Promise<void> {
  let inserted: { rowCount: number | null };
  try {
    inserted = await client.query(
      `insert into ontology_families (workspace_id, id, name) values ($1, $2, $3)
       on conflict (workspace_id, id) do nothing`,
      [workspaceId, id, name],
    );
  } catch (err) {
    if ((err as { constraint?: string }).constraint === 'ontology_families_name_unique') {
      throw new OntologyFamilyNameError(
        `"${name}" already names another ontology family in this workspace`,
      );
    }
    throw err;
  }
  if (inserted.rowCount === 1) return;
  const current = await client.query<{ name: string }>(
    'select name from ontology_families where workspace_id = $1 and id = $2',
    [workspaceId, id],
  );
  const named = current.rows[0]?.name;
  if (named !== name) {
    throw new OntologyFamilyNameError(
      `ontology family ${id} is named "${named}", not "${name}"; a family's name never changes`,
    );
  }
}

/** The name of each family in `ids` that has one, in `workspaceId`; a family with none is
 *  absent. */
export async function loadOntologyFamilyNames(
  client: PoolClient,
  workspaceId: string,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (ids.length === 0) return new Map();
  const result = await client.query<{ id: string; name: string }>(
    'select id, name from ontology_families where workspace_id = $1 and id = any($2::uuid[])',
    [workspaceId, [...ids]],
  );
  return new Map(result.rows.map((row) => [row.id, row.name] as const));
}

/** The id of the family named `name` in `workspaceId`, or `null` when no family has that name. */
export async function loadOntologyFamilyId(
  client: PoolClient,
  workspaceId: string,
  name: string,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    'select id from ontology_families where workspace_id = $1 and name = $2',
    [workspaceId, name],
  );
  return result.rows[0]?.id ?? null;
}
