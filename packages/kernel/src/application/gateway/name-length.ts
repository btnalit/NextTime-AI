import type { PoolClient } from 'pg';

/**
 * Legacy 309: a name a capability writes inside an opaque payload (`propose_skill`'s `skill`,
 * `propose_procedure`'s `procedure`, `propose_worker_definition`'s `definition`) or whose cap
 * depends on what the workspace already holds (a name its record already has; an ontology type
 * the workspace has published) — checked by its handler, since the capability's `paramsSchema`
 * cannot see it. The caps are
 * `@nexttime/shared`'s (`name-limits.ts`), counted as Zod's `.max()` counts. Mapped to 400
 * `invalid_params` with `details` (`path`, `maxLength`), before anything is written.
 */
export class NameTooLongError extends Error {
  readonly code = 'invalid_params' as const;
  readonly details: { readonly path: string; readonly maxLength: number };
  constructor(path: string, maxLength: number, note?: string) {
    super(
      `${path} is longer than ${maxLength} characters — nothing was written. Use a name of at most ${maxLength} characters${note === undefined ? '' : ` (${note})`}.`,
    );
    this.name = 'NameTooLongError';
    this.details = { path, maxLength };
  }
}

/** Throws {@link NameTooLongError} when `name` is longer than `maxLength`. */
export function assertNameWithin(
  name: string | undefined,
  path: string,
  maxLength: number,
  note?: string,
): void {
  if (name !== undefined && name.length > maxLength) {
    throw new NameTooLongError(path, maxLength, note);
  }
}

/** Where a record's versions keep the name it may change from version to version. */
const VERSIONED_NAME_COLUMNS = {
  procedures: 'name',
  worker_definitions: "definition->>'name'",
} as const;

/**
 * {@link assertNameWithin} for a version of a record whose versions may rename it (a Procedure, a
 * WorkerDefinition): `recordId` given, a name one of the record's versions already has is not new
 * to it, so it is not checked again — a record named longer before the cap keeps its name.
 */
export async function assertVersionNameWithin(
  client: PoolClient,
  input: {
    readonly table: keyof typeof VERSIONED_NAME_COLUMNS;
    readonly workspaceId: string;
    readonly recordId: string | undefined;
    readonly name: string;
    readonly path: string;
    readonly maxLength: number;
  },
): Promise<void> {
  if (input.name.length <= input.maxLength) return;
  if (input.recordId !== undefined) {
    const kept = await client.query(
      `select 1 from ${input.table}
        where workspace_id = $1 and id = $2 and ${VERSIONED_NAME_COLUMNS[input.table]} = $3
        limit 1`,
      [input.workspaceId, input.recordId, input.name],
    );
    if ((kept.rowCount ?? 0) > 0) return;
  }
  throw new NameTooLongError(input.path, input.maxLength);
}
