import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  type OntologyDefinition,
  OntologyDefinitionSchema,
  type OntologyNamespaceConflict,
  OntologyNamespaceConflictError,
  type OntologyVersionRow,
  assertOntologyNamespace,
  deprecatePublishedOntologyVersion,
  deriveOntologyPackId,
  loadOntologyVersion,
  loadPublishedOntologyHead,
  lockOntologyFamily,
  publishOntologyVersion,
} from '../../substrate/ontology/index.js';
import { type WideningReason, classifyOntologyDefinitionChange } from './classify.js';
import { contentDigest } from './digest.js';

/**
 * application/change-plan/ontology-item: the `ontology_version` item kind — "publish this
 * definition as the next version of ontology family F" (the intent of `publish_ontology_version`,
 * applied through `substrate/ontology`'s `publishOntologyVersion`; S11 plan §5.4 "ChangeItem 只能是对
 * 现有发布 / 配置能力的调用意图").
 *
 * What the item records (`change_items.target` / `before` / `after`):
 *   * target — `{ family, ontologyId }`: the family's stable name and its `ontology_versions.id`
 *     (`deriveOntologyPackId(family)`);
 *   * before — `{ version, definitionDigest }` of the family's published head when planned, `null`
 *     when the family was not installed;
 *   * after — `{ definitionDigest }` planned, plus the `version` the apply published.
 * Version numbers, not definitions: both versions stay in `ontology_versions` (published rows are
 * immutable, I12), and a rollback compares the head with `after.version` before writing (§5.3).
 *
 * Rollback (P1-B, the item's inverse): retire the version the item published (`published ->
 * deprecated`), so the family's head is `before.version` again — the very row that was the head
 * when the item applied, not a copy — or, with no `before`, the family is no longer installed. The
 * objects and Facts already written stay (S10 I-P4). A retired version is never published again
 * (I12), so a rolled back item can never be what the head is.
 */

export interface OntologyVersionIntent {
  readonly kind: 'ontology_version';
  /** The ontology family's stable name, e.g. a module's (`deriveOntologyPackId`). */
  readonly family: string;
  readonly definition: OntologyDefinition;
}

/** Type names of an ontology definition, per section, sorted. */
export interface OntologyTypeNames {
  readonly objectTypes: readonly string[];
  readonly linkTypes: readonly string[];
  readonly actionTypes: readonly string[];
}

/** What a change does to a family's type names, from one definition to another (`null`: the family
 *  not installed): names only the new one declares, only the old one, and in both but declared
 *  differently. A LinkType name counts as one type whatever its endpoints (it may repeat with
 *  several, `classify.ts`): it is changed when its set of declarations is. For a person reviewing
 *  the change; the classification (`classify.ts`) is what decides confirmation. */
export interface OntologyTypeChanges {
  readonly added: OntologyTypeNames;
  readonly removed: OntologyTypeNames;
  readonly changed: OntologyTypeNames;
}

export interface PlannedOntologyItem {
  readonly target: { readonly family: string; readonly ontologyId: string };
  readonly before: { readonly version: number; readonly definitionDigest: string } | null;
  readonly after: { readonly definitionDigest: string };
  readonly widening: readonly WideningReason[];
  /** The head already is this definition: applying would publish nothing new. */
  readonly unchanged: boolean;
  /** From the head to this definition (all empty when `unchanged`). Not part of the item record or
   *  the segment digest: `before` / `after` digest both sides. */
  readonly types: OntologyTypeChanges;
  /** Validated content to publish (not part of the item record or the segment digest — its digest
   *  is). */
  readonly definition: OntologyDefinition;
}

/** What the item changes, as one key (`engine.ts` refuses two items with the same key in one
 *  segment): the family's `ontology_versions.id`. */
export function ontologyItemTargetKey(intent: OntologyVersionIntent): string {
  return `ontology_version:${deriveOntologyPackId(intent.family)}`;
}

const NO_TYPE_NAMES: OntologyTypeNames = { objectTypes: [], linkTypes: [], actionTypes: [] };
const NO_TYPE_CHANGES: OntologyTypeChanges = {
  added: NO_TYPE_NAMES,
  removed: NO_TYPE_NAMES,
  changed: NO_TYPE_NAMES,
};

/** Each type name a section declares, with the digest of its declarations (sorted, so their order
 *  in the file does not count). */
function declarations(entries: readonly { readonly name: string }[]): Map<string, string> {
  const byName = new Map<string, string[]>();
  for (const entry of entries) {
    byName.set(entry.name, [...(byName.get(entry.name) ?? []), contentDigest(entry)]);
  }
  return new Map([...byName].map(([name, digests]) => [name, contentDigest(digests.sort())]));
}

/** See `OntologyTypeChanges`. */
export function ontologyTypeChanges(
  from: OntologyDefinition | null,
  to: OntologyDefinition | null,
): OntologyTypeChanges {
  const section = (
    before: readonly { readonly name: string }[],
    after: readonly { readonly name: string }[],
  ) => {
    const b = declarations(before);
    const a = declarations(after);
    return {
      added: [...a.keys()].filter((name) => !b.has(name)).sort(),
      removed: [...b.keys()].filter((name) => !a.has(name)).sort(),
      changed: [...a.keys()].filter((name) => b.has(name) && b.get(name) !== a.get(name)).sort(),
    };
  };
  const objectTypes = section(from?.objectTypes ?? [], to?.objectTypes ?? []);
  const linkTypes = section(from?.linkTypes ?? [], to?.linkTypes ?? []);
  const actionTypes = section(from?.actionTypes ?? [], to?.actionTypes ?? []);
  const pick = (key: 'added' | 'removed' | 'changed'): OntologyTypeNames => ({
    objectTypes: objectTypes[key],
    linkTypes: linkTypes[key],
    actionTypes: actionTypes[key],
  });
  return { added: pick('added'), removed: pick('removed'), changed: pick('changed') };
}

/** Holds the family (and, first, the workspace's ontology namespace — I-P1) until the transaction
 *  ends, so the head read by `planOntologyItem` is still the head when `applyOntologyItem` writes.
 *  Every ontology publisher takes the namespace lock first, so locking several families of one
 *  workspace in any order cannot deadlock against another publisher. */
export async function lockOntologyItem(
  client: PoolClient,
  workspaceId: string,
  intent: OntologyVersionIntent,
): Promise<void> {
  await lockOntologyFamily(client, workspaceId, deriveOntologyPackId(intent.family));
}

/** The item's dry run: validates the definition, reads the family's published head, classifies the
 *  change, and checks I-P1 (another family's ObjectType / ActionType name refuses with
 *  `OntologyNamespaceConflictError` here, at review, rather than only at apply). Writes nothing. */
export async function planOntologyItem(
  client: PoolClient,
  workspaceId: string,
  intent: OntologyVersionIntent,
): Promise<PlannedOntologyItem> {
  const definition = OntologyDefinitionSchema.parse(intent.definition);
  const ontologyId = deriveOntologyPackId(intent.family);
  const head = await loadPublishedOntologyHead(client, workspaceId, ontologyId);
  const definitionDigest = contentDigest(definition);
  const before = head
    ? { version: head.version, definitionDigest: contentDigest(head.definition) }
    : null;
  const unchanged = before?.definitionDigest === definitionDigest;
  if (!unchanged) await assertOntologyNamespace(client, workspaceId, ontologyId, definition);
  return {
    target: { family: intent.family, ontologyId },
    before,
    after: { definitionDigest },
    widening: unchanged
      ? []
      : classifyOntologyDefinitionChange(head?.definition ?? null, definition),
    unchanged,
    types: unchanged ? NO_TYPE_CHANGES : ontologyTypeChanges(head?.definition ?? null, definition),
    definition,
  };
}

/** Publishes the planned definition as the family's next version, `appliedBy` as its proposer and
 *  publisher (the bootstrap shape `publishOntologyVersion` documents: the person applying the
 *  segment reviewed it; there is no separate draft). Returns the item's `after`. */
export async function applyOntologyItem(
  client: PoolClient,
  workspaceId: string,
  planned: PlannedOntologyItem,
  appliedBy: string,
): Promise<{ readonly definitionDigest: string; readonly version: number }> {
  const published = await publishOntologyVersion(client, workspaceId, {
    id: planned.target.ontologyId,
    definition: planned.definition,
    principalId: appliedBy,
  });
  return { definitionDigest: planned.after.definitionDigest, version: published.version };
}

// -------------------------------------------------------------------------------------------
// After applying (S11 P1-B): the stored item, its target now, and its rollback
// -------------------------------------------------------------------------------------------

const VersionRefSchema = z
  .object({ version: z.number().int().positive(), definitionDigest: z.string() })
  .strict();

const StoredOntologyItemSchema = z
  .object({
    target: z.object({ family: z.string(), ontologyId: z.string() }).strict(),
    before: VersionRefSchema.nullable(),
    after: VersionRefSchema,
  })
  .strict();

/** An applied `ontology_version` item as `change_items` stores it. */
export type StoredOntologyItem = z.infer<typeof StoredOntologyItemSchema>;

/** Reads a stored item's `target` / `before` / `after`; throws on a shape this kind never writes. */
export function parseStoredOntologyItem(row: {
  readonly target: unknown;
  readonly before: unknown;
  readonly after: unknown;
}): StoredOntologyItem {
  return StoredOntologyItemSchema.parse({
    target: row.target,
    before: row.before,
    after: row.after,
  });
}

function isVersion(
  row: OntologyVersionRow,
  ref: { readonly version: number; readonly definitionDigest: string },
): boolean {
  return row.version === ref.version && contentDigest(row.definition) === ref.definitionDigest;
}

export type OntologyItemState =
  | { readonly state: 'in_effect' }
  | { readonly state: 'replaced'; readonly headVersion: number }
  | { readonly state: 'not_installed' };

/** Whether the version the item published is still its family's head. */
export async function readOntologyItemState(
  client: PoolClient,
  workspaceId: string,
  item: StoredOntologyItem,
): Promise<OntologyItemState> {
  const head = await loadPublishedOntologyHead(client, workspaceId, item.target.ontologyId);
  if (!head) return { state: 'not_installed' };
  if (isVersion(head, item.after)) return { state: 'in_effect' };
  return { state: 'replaced', headVersion: head.version };
}

/** Holds the item's family (namespace lock first, as every ontology publisher) until the
 *  transaction ends — taken by a rollback before it plans, so what it compares is what it changes. */
export async function lockOntologyRollback(
  client: PoolClient,
  workspaceId: string,
  item: StoredOntologyItem,
): Promise<void> {
  await lockOntologyFamily(client, workspaceId, item.target.ontologyId);
}

export type OntologyRollbackBlocker =
  | { readonly reason: 'not_installed' }
  | { readonly reason: 'replaced'; readonly headVersion: number }
  | { readonly reason: 'restored_version_missing' }
  | {
      readonly reason: 'namespace_conflict';
      readonly conflicts: readonly OntologyNamespaceConflict[];
    };

export interface PlannedOntologyRollback {
  readonly target: StoredOntologyItem['target'];
  /** The version the item published — the family's head, when the rollback can go ahead. */
  readonly from: StoredOntologyItem['after'];
  /** The version the head goes back to; `null`: the family is no longer installed. */
  readonly to: StoredOntologyItem['before'];
  /** The rollback's own classification (I-A4, the same whitelist as applying): from what the head
   *  declares now to what it would declare after. Empty when blocked. */
  readonly widening: readonly WideningReason[];
  /** Type names the head declares that the restored version does not (empty when blocked). */
  readonly removes: {
    readonly objectTypes: readonly string[];
    readonly linkTypes: readonly string[];
    readonly actionTypes: readonly string[];
  };
  readonly blocker: OntologyRollbackBlocker | null;
}

const NOTHING_REMOVED = { objectTypes: [], linkTypes: [], actionTypes: [] } as const;

/** The item's rollback dry run (§3.4 "逆操作…先比较再写"): blocked unless the family's head is still
 *  the version the item published and the version before it is still there to return to, and the
 *  restored definition does not give a type name a second owner (I-P1). Writes nothing; a rollback
 *  calls it under `lockOntologyRollback`. */
export async function planOntologyRollback(
  client: PoolClient,
  workspaceId: string,
  item: StoredOntologyItem,
): Promise<PlannedOntologyRollback> {
  const blocked = (blocker: OntologyRollbackBlocker): PlannedOntologyRollback => ({
    target: item.target,
    from: item.after,
    to: item.before,
    widening: [],
    removes: NOTHING_REMOVED,
    blocker,
  });
  const { ontologyId } = item.target;
  const head = await loadPublishedOntologyHead(client, workspaceId, ontologyId);
  if (!head) return blocked({ reason: 'not_installed' });
  if (!isVersion(head, item.after))
    return blocked({ reason: 'replaced', headVersion: head.version });

  let restored: OntologyVersionRow | null = null;
  if (item.before) {
    const row = await loadOntologyVersion(client, workspaceId, ontologyId, item.before.version);
    if (!row || !isVersion(row, item.before) || row.status !== 'published') {
      return blocked({ reason: 'restored_version_missing' });
    }
    restored = row;
    try {
      await assertOntologyNamespace(client, workspaceId, ontologyId, row.definition);
    } catch (err) {
      if (!(err instanceof OntologyNamespaceConflictError)) throw err;
      return blocked({ reason: 'namespace_conflict', conflicts: err.conflicts });
    }
  }
  const to = restored?.definition ?? null;
  return {
    target: item.target,
    from: item.after,
    to: item.before,
    widening: classifyOntologyDefinitionChange(head.definition, to),
    removes: ontologyTypeChanges(head.definition, to).removed,
    blocker: null,
  };
}

/** Rolls the item back as planned (an unblocked `planOntologyRollback` in this transaction, under
 *  `lockOntologyRollback`): retires the version it published and checks the family's head is the
 *  version it planned to return to. Returns that head version (`null`: not installed). */
export async function applyOntologyRollback(
  client: PoolClient,
  workspaceId: string,
  planned: PlannedOntologyRollback,
): Promise<number | null> {
  const { ontologyId } = planned.target;
  const retired = await deprecatePublishedOntologyVersion(
    client,
    workspaceId,
    ontologyId,
    planned.from.version,
  );
  if (!retired) {
    throw new Error(
      `change-plan: ontology ${ontologyId} v${planned.from.version} was not published when rolled back`,
    );
  }
  const head = await loadPublishedOntologyHead(client, workspaceId, ontologyId);
  const expected = planned.to;
  if (expected === null ? head !== null : !head || !isVersion(head, expected)) {
    throw new Error(
      `change-plan: ontology ${ontologyId}'s head after rolling back v${planned.from.version} is ${head ? `v${head.version}` : 'none'}, not ${expected ? `v${expected.version}` : 'none'}`,
    );
  }
  return head?.version ?? null;
}
