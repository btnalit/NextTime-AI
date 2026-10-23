import {
  OPERATION_ITEM_FIELD_VALUES,
  type Operation,
  type OperationItemField,
  OperationSchema,
  type PrincipalKind,
  storableText,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  GatekeeperNotFoundError,
  OPERATION_DESCRIPTION_MAX_LENGTH,
  OperationIdentityConflictError,
  OperationNotFoundError,
  type OperationRecord,
  getGatekeeper,
  getOperation,
  getOperationVersion,
  getPublishedOperation,
  lockOperationRevision,
  operationDefinitionDiffers,
  publishOperationRevision,
} from '../../governance/gatekeepers/index.js';
import { findSuspectedSecrets } from '../../governance/redaction/index.js';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import { type WideningReason, classifyOperationChange } from './classify.js';
import { contentDigest } from './digest.js';
import type { ContentVersionRef } from './family-item.js';

/**
 * application/change-plan/operation-item: the `operation_version` item kind (S11 P1-E) — "publish a
 * revision of this published Operation with these governance fields", the intent of
 * `publish_operation` applied to a revision, through `governance/gatekeepers`' own
 * `publishOperationRevision` (a draft at the next version, published at once, retiring the live
 * one).
 *
 * What it may change is what the workspace decides about calls of the Operation, never what the
 * gate runs: `description`, `blast_radius`, `auto_approvable`, `await_decision`, `reads` and
 * `writes` (`OPERATION_ITEM_FIELDS`). The gate holds every call to the digest of the definition it
 * runs (`@nexttime/gatekeeper-base`'s `operation-digest.ts`: name, binding, params schema, result
 * mapping, mode, reversibility and, for an ssh binding, `blast_radius`), so a revision that moved
 * any of those would make the gate refuse every call; the plan refuses it instead. The MCP hints
 * are the system's own claim about its tool and stay as imported. In short: the gate decides what
 * it runs, the workspace decides how it is reviewed.
 *
 * Only a published Operation is revised, and never past a revision someone has under review: a
 * pending draft refuses the item (`OperationIdentityConflictError`) rather than being overwritten
 * or published over.
 *
 * What the item records (`change_items.target` / `before` / `after`):
 *   * target — `{ gatekeeperId, gatekeeperName, name }`: the Operation, and its Gatekeeper's name
 *     when applied (for the reader; the Gatekeeper is named by id);
 *   * before — `{ version, contentDigest }` of the published version it replaced (never null);
 *   * after — `{ contentDigest }` planned, plus the `version` the apply published.
 * The content digest is `contentDigest` of the whole `Operation`.
 *
 * Rollback: an Operation has one published version at a time and a retired version is never
 * published again (I12), so the inverse publishes a further revision carrying `before`'s content —
 * compared before it is written: the live version must still carry what the item published, the
 * version it replaced must still hold `before`'s content, and no revision may be pending.
 *
 * So the item is in effect while the live version carries the content it published, whatever that
 * version's number: rolling back a later segment publishes this item's content again as a further
 * version, and this item can then be rolled back in turn.
 *
 * Locks: `lockOperationRevision` (one advisory lock for the workspace's revisions), then the live
 * row (`for update`), so what a plan read is what its apply changes.
 */

/** The fields an `operation_version` item may set (`@nexttime/shared`, where each is described). */
export const OPERATION_ITEM_FIELDS = OPERATION_ITEM_FIELD_VALUES;

/** Values for some of `OPERATION_ITEM_FIELDS`; every field left out stays the published version's. */
export type OperationGovernanceValues = { readonly [K in OperationItemField]?: Operation[K] };

export interface OperationVersionIntent {
  readonly kind: 'operation_version';
  readonly gatekeeperId: string;
  /** The Operation's name on that Gatekeeper. */
  readonly name: string;
  readonly set: OperationGovernanceValues;
}

/** A type, not an interface, so it is a `Record` where the engine records an item generically. */
export type OperationItemTarget = {
  readonly gatekeeperId: string;
  readonly gatekeeperName: string;
  readonly name: string;
};

/** One governance field the item changes, before and after. */
export interface OperationFieldChange {
  readonly field: OperationItemField;
  readonly before: unknown;
  readonly after: unknown;
}

export interface PlannedOperationItem {
  readonly kind: 'operation_version';
  readonly target: OperationItemTarget;
  readonly before: ContentVersionRef;
  readonly after: { readonly contentDigest: string };
  readonly widening: readonly WideningReason[];
  /** The live version already has these values: applying would publish nothing new. */
  readonly unchanged: boolean;
  /** For the person reviewing; not recorded, not in the digest. */
  readonly fields: readonly OperationFieldChange[];
  /** The revision's whole content (its digest is `after`'s). */
  readonly content: Operation;
}

/** What the item changes, as one key (`engine.ts` refuses two items with the same key in one
 *  segment). */
export function operationItemTargetKey(intent: OperationVersionIntent): string {
  return `operation_version:${intent.gatekeeperId}:${intent.name}`;
}

/** Holds the workspace's Operation revisions (`lockOperationRevision`) until the transaction
 *  ends. */
export async function lockOperationItem(client: PoolClient, workspaceId: string): Promise<void> {
  await lockOperationRevision(client, workspaceId);
}

function subjectOf(target: { readonly gatekeeperId: string; readonly name: string }): string {
  return `change-plan: Operation ${JSON.stringify(target.name)} on gatekeeper ${target.gatekeeperId}`;
}

/** The item's fields that differ between two versions' content, in `OPERATION_ITEM_FIELDS` order. */
function fieldChanges(operation: Operation, revised: Operation): OperationFieldChange[] {
  return OPERATION_ITEM_FIELDS.filter(
    (field) => contentDigest(operation[field] ?? null) !== contentDigest(revised[field] ?? null),
  ).map((field) => ({ field, before: operation[field] ?? null, after: revised[field] ?? null }));
}

/** The live version with `values` set, checked: only `OPERATION_ITEM_FIELDS`, a valid Operation, a
 *  description that is visible text of the allowed length with no suspected credential (nobody is
 *  asked to confirm one here: an item's content is reviewed as a whole), and the same definition
 *  the gate runs. A caller bug otherwise — an intent is built by code — so a plain `Error`. */
function revisedContent(
  intent: OperationVersionIntent,
  live: OperationRecord,
): Readonly<Operation> {
  const subject = subjectOf(intent);
  const unknown = Object.keys(intent.set).filter(
    (field) => !(OPERATION_ITEM_FIELDS as readonly string[]).includes(field),
  );
  if (unknown.length > 0) {
    throw new Error(
      `${subject}: an item sets only ${OPERATION_ITEM_FIELDS.join(', ')}, not ${unknown.join(', ')}`,
    );
  }
  const set: Record<string, unknown> = { ...intent.set };
  if (typeof set.description === 'string') {
    const description = storableText(set.description.trim());
    if (description.length === 0 || description.length > OPERATION_DESCRIPTION_MAX_LENGTH) {
      throw new Error(
        `${subject}: a description is 1 to ${OPERATION_DESCRIPTION_MAX_LENGTH} characters`,
      );
    }
    if (findSuspectedSecrets(description).count > 0) {
      throw new Error(`${subject}: the description carries a suspected credential`);
    }
    set.description = description;
  }
  const parsed = OperationSchema.safeParse({ ...live.operation, ...set });
  if (!parsed.success) {
    throw new Error(`${subject}: the revision is not a valid Operation (${parsed.error.message})`);
  }
  // `safeParse` drops keys `OperationSchema` does not know; the revision keeps what the live
  // version has, with only the fields set replaced.
  const revised = { ...live.operation, ...set } as Operation;
  if (operationDefinitionDiffers(live, revised)) {
    throw new Error(
      `${subject}: a revision keeps what the gate runs (for an ssh binding that includes blast_radius); only how calls are governed changes`,
    );
  }
  return revised;
}

/** The item's dry run: reads the live version, builds and checks the revision, classifies it.
 *  `OperationNotFoundError` when the Operation has no published version, `GatekeeperNotFoundError`
 *  when its Gatekeeper is gone, `OperationIdentityConflictError` when a revision draft is pending.
 *  Writes nothing; call it under `lockOperationItem` (it locks the live row itself). */
export async function planOperationItem(
  client: PoolClient,
  workspaceId: string,
  intent: OperationVersionIntent,
): Promise<PlannedOperationItem> {
  const { gatekeeperId, name } = intent;
  const gatekeeper = await getGatekeeper(client, workspaceId, gatekeeperId);
  if (!gatekeeper) throw new GatekeeperNotFoundError(gatekeeperId);
  const live = await getPublishedOperation(client, workspaceId, gatekeeperId, name, {
    forUpdate: true,
  });
  if (!live) throw new OperationNotFoundError(gatekeeperId, name);
  const current = await getOperation(client, workspaceId, gatekeeperId, name);
  if (current?.status === 'draft') {
    throw new OperationIdentityConflictError(gatekeeperId, name, 'draft');
  }
  const content = revisedContent(intent, live);
  const before = { version: live.version, contentDigest: contentDigest(live.operation) };
  const digest = contentDigest(content);
  const unchanged = before.contentDigest === digest;
  return {
    kind: 'operation_version',
    target: { gatekeeperId, gatekeeperName: gatekeeper.name, name },
    before,
    after: { contentDigest: digest },
    widening: unchanged ? [] : classifyOperationChange(live.operation, content),
    unchanged,
    fields: unchanged ? [] : fieldChanges(live.operation, content),
    content,
  };
}

async function publishRevision(
  client: PoolClient,
  workspaceId: string,
  target: OperationItemTarget,
  replaces: number,
  operation: Operation,
  publishedBy: string,
): Promise<OperationRecord> {
  const principal = await client.query<{ kind: PrincipalKind }>(
    'select kind from principals where workspace_id = $1 and id = $2',
    [workspaceId, publishedBy],
  );
  const kind = principal.rows[0]?.kind;
  if (!kind) throw new Error(`${subjectOf(target)}: no principal ${publishedBy} in this workspace`);
  const activity = await startActivity(client, workspaceId, {
    kind: 'operation_publish',
    principalId: publishedBy,
    metadata: { gatekeeperId: target.gatekeeperId, name: target.name, via: 'change_plan' },
  });
  const published = await publishOperationRevision(client, workspaceId, {
    gatekeeperId: target.gatekeeperId,
    name: target.name,
    replaces,
    operation,
    publishedBy: { id: publishedBy, kind },
    activityId: activity.id,
  });
  await endActivity(client, workspaceId, activity.id, 'completed');
  return published;
}

/** Publishes the planned revision, `appliedBy` as its proposer and publisher. Returns the item's
 *  `after`. */
export async function applyOperationItem(
  client: PoolClient,
  workspaceId: string,
  planned: PlannedOperationItem,
  appliedBy: string,
): Promise<{ readonly contentDigest: string; readonly version: number }> {
  const published = await publishRevision(
    client,
    workspaceId,
    planned.target,
    planned.before.version,
    planned.content,
    appliedBy,
  );
  if (contentDigest(published.operation) !== planned.after.contentDigest) {
    throw new Error(
      `${subjectOf(planned.target)}: v${published.version} was published with content other than planned`,
    );
  }
  return { contentDigest: planned.after.contentDigest, version: published.version };
}

// -------------------------------------------------------------------------------------------
// After applying: the stored item, its target now, and its rollback
// -------------------------------------------------------------------------------------------

const ContentVersionRefSchema = z
  .object({ version: z.number().int().positive(), contentDigest: z.string() })
  .strict();

const StoredOperationItemSchema = z
  .object({
    target: z
      .object({ gatekeeperId: z.string(), gatekeeperName: z.string(), name: z.string() })
      .strict(),
    before: ContentVersionRefSchema,
    after: ContentVersionRefSchema,
  })
  .strict();

/** An applied `operation_version` item as `change_items` stores it. */
export type StoredOperationItem = z.infer<typeof StoredOperationItemSchema>;

/** Reads a stored item's `target` / `before` / `after`; throws on a shape the kind never writes. */
export function parseStoredOperationItem(row: {
  readonly target: unknown;
  readonly before: unknown;
  readonly after: unknown;
}): StoredOperationItem {
  return StoredOperationItemSchema.parse({
    target: row.target,
    before: row.before,
    after: row.after,
  });
}

function isVersion(record: OperationRecord, ref: ContentVersionRef): boolean {
  return record.version === ref.version && contentDigest(record.operation) === ref.contentDigest;
}

/** The live version carries the content the item published (see this module's comment). */
function carries(live: OperationRecord, after: ContentVersionRef): boolean {
  return contentDigest(live.operation) === after.contentDigest;
}

export type OperationItemState =
  | { readonly state: 'in_effect' }
  | { readonly state: 'replaced'; readonly headVersion: number }
  | { readonly state: 'not_installed' };

/** Whether the live version still carries what the item published. */
export async function readOperationItemState(
  client: PoolClient,
  workspaceId: string,
  item: StoredOperationItem,
): Promise<OperationItemState> {
  const live = await getPublishedOperation(
    client,
    workspaceId,
    item.target.gatekeeperId,
    item.target.name,
  );
  if (!live) return { state: 'not_installed' };
  if (carries(live, item.after)) return { state: 'in_effect' };
  return { state: 'replaced', headVersion: live.version };
}

/** The governance fields the item changed, read from the version it replaced and the one it
 *  published as they are now — empty when either is gone or no longer holds the content the item
 *  recorded. For the reader of a segment (`get_change_segment`). */
export async function readOperationItemFields(
  client: PoolClient,
  workspaceId: string,
  item: StoredOperationItem,
): Promise<readonly OperationFieldChange[]> {
  const { gatekeeperId, name } = item.target;
  const before = await getOperationVersion(
    client,
    workspaceId,
    gatekeeperId,
    name,
    item.before.version,
  );
  const after = await getOperationVersion(
    client,
    workspaceId,
    gatekeeperId,
    name,
    item.after.version,
  );
  if (!before || !after || !isVersion(before, item.before) || !isVersion(after, item.after)) {
    return [];
  }
  return fieldChanges(before.operation, after.operation);
}

export type OperationRollbackBlocker =
  | {
      readonly reason: 'not_installed' | 'restored_version_missing' | 'revision_pending';
    }
  | { readonly reason: 'replaced'; readonly headVersion: number };

export interface PlannedOperationRollback {
  readonly kind: 'operation_version';
  readonly target: OperationItemTarget;
  /** The live version, carrying what the item published, when the rollback can go ahead (the
   *  version the item published itself, unless a later rollback published its content again);
   *  the version the item published when blocked. */
  readonly from: ContentVersionRef;
  /** The version whose content comes back (as a further version, see this module's comment). */
  readonly to: ContentVersionRef;
  /** The rollback's own classification (I-A4): from the live content to `to`'s. Empty when
   *  blocked. */
  readonly widening: readonly WideningReason[];
  readonly blocker: OperationRollbackBlocker | null;
  /** `to`'s content, when not blocked. */
  readonly content: Operation | null;
}

/** The item's rollback dry run (§3.4 "先比较再写"; see this module's comment). Writes nothing; a
 *  rollback calls it under `lockOperationItem`. */
export async function planOperationRollback(
  client: PoolClient,
  workspaceId: string,
  item: StoredOperationItem,
): Promise<PlannedOperationRollback> {
  const { gatekeeperId, name } = item.target;
  const blocked = (blocker: OperationRollbackBlocker): PlannedOperationRollback => ({
    kind: 'operation_version',
    target: item.target,
    from: item.after,
    to: item.before,
    widening: [],
    blocker,
    content: null,
  });
  const live = await getPublishedOperation(client, workspaceId, gatekeeperId, name);
  if (!live) return blocked({ reason: 'not_installed' });
  if (!carries(live, item.after)) {
    return blocked({ reason: 'replaced', headVersion: live.version });
  }
  const current = await getOperation(client, workspaceId, gatekeeperId, name);
  if (current?.status === 'draft') return blocked({ reason: 'revision_pending' });
  const restored = await getOperationVersion(
    client,
    workspaceId,
    gatekeeperId,
    name,
    item.before.version,
  );
  if (!restored || !isVersion(restored, item.before)) {
    return blocked({ reason: 'restored_version_missing' });
  }
  return {
    kind: 'operation_version',
    target: item.target,
    from: { version: live.version, contentDigest: item.after.contentDigest },
    to: item.before,
    widening: classifyOperationChange(live.operation, restored.operation),
    blocker: null,
    content: restored.operation,
  };
}

/** Rolls the item back as planned (an unblocked `planOperationRollback` in this transaction,
 *  under `lockOperationItem`): publishes `to`'s content as the next version. Returns that version. */
export async function applyOperationRollback(
  client: PoolClient,
  workspaceId: string,
  planned: PlannedOperationRollback,
  rolledBackBy: string,
): Promise<number> {
  if (planned.content === null) {
    throw new Error(`${subjectOf(planned.target)}: a blocked rollback is never applied`);
  }
  const published = await publishRevision(
    client,
    workspaceId,
    planned.target,
    planned.from.version,
    planned.content,
    rolledBackBy,
  );
  if (contentDigest(published.operation) !== planned.to.contentDigest) {
    throw new Error(
      `${subjectOf(planned.target)}: rolling back v${planned.from.version} published content other than v${planned.to.version}'s`,
    );
  }
  return published.version;
}
