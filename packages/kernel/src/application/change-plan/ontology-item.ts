import type { PoolClient } from 'pg';
import {
  type OntologyDefinition,
  OntologyDefinitionSchema,
  assertOntologyNamespace,
  deriveOntologyPackId,
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
 */

export interface OntologyVersionIntent {
  readonly kind: 'ontology_version';
  /** The ontology family's stable name, e.g. a module's (`deriveOntologyPackId`). */
  readonly family: string;
  readonly definition: OntologyDefinition;
}

export interface PlannedOntologyItem {
  readonly target: { readonly family: string; readonly ontologyId: string };
  readonly before: { readonly version: number; readonly definitionDigest: string } | null;
  readonly after: { readonly definitionDigest: string };
  readonly widening: readonly WideningReason[];
  /** The head already is this definition: applying would publish nothing new. */
  readonly unchanged: boolean;
  /** Validated content to publish (not part of the item record or the segment digest — its digest
   *  is). */
  readonly definition: OntologyDefinition;
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
