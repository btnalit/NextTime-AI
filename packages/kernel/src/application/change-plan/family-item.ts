import type { ChangeRollbackBlocker, ProposeSkillContent, SkillApplicable } from '@nexttime/shared';
import { SkillApplicableSchema } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  type SkillRow,
  type WorkerDefinitionRow,
  assertSkillNameAvailable,
  deprecatePublishedSkillVersion,
  deprecatePublishedWorkerDefinitionVersion,
  getWorkerDefinition,
  loadPublishedSkillHead,
  loadPublishedWorkerDefinitionHead,
  loadSkillVersion,
  lockWorkerRegistry,
  proposeSkill,
  proposeWorkerDefinition,
  publishSkill,
  publishWorkerDefinition,
  skillReviewContent,
  validateSkillContent,
  validateWorkerDefinitionContent,
} from '../worker/index.js';
import {
  type WideningReason,
  classifySkillChange,
  classifyWorkerDefinitionChange,
} from './classify.js';
import { contentDigest } from './digest.js';

/**
 * application/change-plan/family-item: the `skill_version` and `worker_definition_version` item
 * kinds (S11 P1-D) — "publish this content as the next version of Skill family S" (the intent of
 * `publish_skill`) and "… of `worker` WorkerDefinition family W" (`publish_worker_definition`),
 * applied through `application/worker`'s own propose and publish. Both families have the shape an
 * ontology family has (`ontology-item.ts`): versions numbered from 1, published rows immutable
 * (I12), the head = the latest published version, and published versions coexisting — so the two
 * kinds share this module and differ only in which registry they read and write (`FamilySpec`).
 *
 * What the item records (`change_items.target` / `before` / `after`):
 *   * target — `{ skillId, name }` / `{ definitionId, name }`: the family's id (a pack derives it
 *     from the pack and the component's name, `application/packs`) and the name it goes by;
 *   * before — `{ version, contentDigest }` of the family's head when planned, `null` when the
 *     family had no published version;
 *   * after — `{ contentDigest }` planned, plus the `version` the apply published.
 * The content digest is `contentDigest` of what a version fixes: a Skill's name, description, body
 * and `applicable` (`skillReviewContent`); a WorkerDefinition's `definition`.
 *
 * Only `worker` WorkerDefinitions: the workspace's entry agent is the most recently published
 * `entry` definition of any family (`getPublishedEntryDefinition`), so an entry item would not
 * have a head of its own to compare and roll back.
 *
 * Everything here runs under `lockWorkerRegistry` (the engine's `lockItem`, a rollback's
 * `lockFamilyRollback`), which `publishSkill` / `publishWorkerDefinition` and their deprecations
 * take too: what a plan read is what its apply changes.
 *
 * Rollback (the item's inverse, as for an ontology item): retire the version the item published, so
 * the family's head is `before.version` again — that very row, still published — or, with no
 * `before`, the family has no published version: a Worker no longer mounts the Skill, nobody can
 * invoke the WorkerDefinition. Earlier published versions of a WorkerDefinition stay invocable
 * either way, as they do after a person's `publish_worker_definition`.
 */

/** A Skill version's content as an item installs it: what `proposeSkill` stores, with `applicable`
 *  as the table holds it (`{}` when not scoped). */
export interface SkillItemContent {
  readonly name: string;
  readonly description: string;
  readonly markdown: string;
  readonly applicable: SkillApplicable;
}

export interface SkillVersionIntent {
  readonly kind: 'skill_version';
  /** The Skill family's id (`skills.id`). */
  readonly skillId: string;
  readonly content: SkillItemContent;
}

export interface WorkerDefinitionVersionIntent {
  readonly kind: 'worker_definition_version';
  /** The WorkerDefinition family's id (`worker_definitions.id`), kind `worker`. */
  readonly definitionId: string;
  /** `worker`-kind content (`@nexttime/shared` worker-definition.ts), with a `name`. */
  readonly definition: Readonly<Record<string, unknown>>;
  /** Fields the workspace owns (S11 P1-E2: a pack's Worker never sets which gates it acts on or
   *  which model runs it): where the head has one, the item publishes the head's value instead of
   *  `definition`'s — read under the registry lock, so what was reviewed keeps exactly what the
   *  workspace had. Where the head has none, `definition`'s value (or none) stands. */
  readonly keepFromHead?: readonly KeptWorkerField[];
}

/** A `worker` WorkerDefinition field an item may keep from the head (`keepFromHead`). */
export type KeptWorkerField = 'gates' | 'model';

export type FamilyVersionIntent = SkillVersionIntent | WorkerDefinitionVersionIntent;
export type FamilyItemKind = FamilyVersionIntent['kind'];

/** A family version, by number and content digest (an item's `before` / `after`). A type, not an
 *  interface, so it is a `Record` where the engine records an item's state generically. */
export type ContentVersionRef = {
  readonly version: number;
  readonly contentDigest: string;
};

/** An item's target, whichever registry: the family id under its own field name, and its name. */
export type FamilyItemTarget =
  | { readonly skillId: string; readonly name: string }
  | { readonly definitionId: string; readonly name: string };

/** One family version as the two registries have it in common. */
interface FamilyRow {
  readonly version: number;
  readonly status: 'draft' | 'published' | 'deprecated';
  readonly content: Readonly<Record<string, unknown>>;
}

function skillContentOf(row: SkillRow): SkillItemContent {
  return skillReviewContent(row) as SkillItemContent;
}

function skillFamilyRow(row: SkillRow | null): FamilyRow | null {
  return row
    ? { version: row.version, status: row.status, content: { ...skillContentOf(row) } }
    : null;
}

function workerFamilyRow(row: WorkerDefinitionRow | null): FamilyRow | null {
  return row ? { version: row.version, status: row.status, content: row.definition } : null;
}

/** What differs between the two registries (see this module's comment). */
interface FamilySpec {
  readonly idField: 'skillId' | 'definitionId';
  /** For messages: `Skill` / `WorkerDefinition`. */
  readonly label: string;
  loadHead(client: PoolClient, workspaceId: string, id: string): Promise<FamilyRow | null>;
  loadVersion(
    client: PoolClient,
    workspaceId: string,
    id: string,
    version: number,
  ): Promise<FamilyRow | null>;
  classify(
    before: Readonly<Record<string, unknown>> | null,
    after: Readonly<Record<string, unknown>> | null,
  ): WideningReason[];
  deprecate(client: PoolClient, workspaceId: string, id: string, version: number): Promise<boolean>;
}

const SKILL_SPEC: FamilySpec = {
  idField: 'skillId',
  label: 'Skill',
  loadHead: async (client, workspaceId, id) =>
    skillFamilyRow(await loadPublishedSkillHead(client, workspaceId, id)),
  loadVersion: async (client, workspaceId, id, version) =>
    skillFamilyRow(await loadSkillVersion(client, workspaceId, id, version)),
  classify: (before, after) =>
    classifySkillChange(before as ProposeSkillContent | null, after as ProposeSkillContent | null),
  deprecate: (client, workspaceId, id, version) =>
    deprecatePublishedSkillVersion(client, workspaceId, id, version),
};

const WORKER_SPEC: FamilySpec = {
  idField: 'definitionId',
  label: 'WorkerDefinition',
  loadHead: async (client, workspaceId, id) =>
    workerFamilyRow(await loadPublishedWorkerDefinitionHead(client, workspaceId, id)),
  loadVersion: async (client, workspaceId, id, version) =>
    workerFamilyRow(await getWorkerDefinition(client, workspaceId, { definitionId: id, version })),
  classify: classifyWorkerDefinitionChange,
  deprecate: (client, workspaceId, id, version) =>
    deprecatePublishedWorkerDefinitionVersion(client, workspaceId, { definitionId: id, version }),
};

function specOf(kind: FamilyItemKind): FamilySpec {
  return kind === 'skill_version' ? SKILL_SPEC : WORKER_SPEC;
}

function familyIdOf(intent: FamilyVersionIntent): string {
  return intent.kind === 'skill_version' ? intent.skillId : intent.definitionId;
}

/** What the item changes, as one key (`engine.ts` refuses two items with the same key in one
 *  segment): the family's id. */
export function familyItemTargetKey(intent: FamilyVersionIntent): string {
  return `${intent.kind}:${familyIdOf(intent)}`;
}

/** The content digest of a family's head — what a pack's state compares (`application/packs`)
 *  — or `null` when it has no published version. Not locked. */
export async function readFamilyHeadDigest(
  client: PoolClient,
  workspaceId: string,
  kind: FamilyItemKind,
  familyId: string,
): Promise<string | null> {
  const head = await specOf(kind).loadHead(client, workspaceId, familyId);
  return head ? contentDigest(head.content) : null;
}

/** Fields that differ between two versions' content (`before` null: every field `after` has). */
function changedFields(
  before: Readonly<Record<string, unknown>> | null,
  after: Readonly<Record<string, unknown>>,
): string[] {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])].sort();
  return keys.filter((key) => {
    const b = before?.[key];
    const a = after[key];
    if (b === undefined || a === undefined) return b !== a;
    return contentDigest(b) !== contentDigest(a);
  });
}

interface PlannedFamilyItemCommon {
  readonly before: ContentVersionRef | null;
  readonly after: { readonly contentDigest: string };
  readonly widening: readonly WideningReason[];
  /** The head already is this content: applying would publish nothing new. */
  readonly unchanged: boolean;
  /** Fields of the content that differ from the head's (every field, for a family not installed;
   *  none when `unchanged`). For the person reviewing; not recorded, not in the digest. */
  readonly changedFields: readonly string[];
}

/** A planned item, by kind, with the validated content it publishes (its digest is `after`'s). */
export type PlannedFamilyItem = PlannedFamilyItemCommon &
  (
    | {
        readonly kind: 'skill_version';
        readonly target: { readonly skillId: string; readonly name: string };
        readonly content: SkillItemContent;
      }
    | {
        readonly kind: 'worker_definition_version';
        readonly target: { readonly definitionId: string; readonly name: string };
        readonly content: Readonly<Record<string, unknown>>;
      }
  );

/** Holds the Skill and WorkerDefinition registries (`lockWorkerRegistry`) until the transaction
 *  ends, so the head `planFamilyItem` reads is still the head when `applyFamilyItem` writes. */
export async function lockFamilyItem(client: PoolClient, workspaceId: string): Promise<void> {
  await lockWorkerRegistry(client, workspaceId);
}

/** A Skill intent's content, validated by `publishSkill`'s own rules — a pack that could never
 *  publish fails at review, not at apply. */
function validatedSkillContent(intent: SkillVersionIntent): SkillItemContent {
  const content: SkillItemContent = {
    name: intent.content.name,
    description: intent.content.description,
    markdown: intent.content.markdown,
    applicable: SkillApplicableSchema.parse(intent.content.applicable),
  };
  validateSkillContent(content);
  return content;
}

/** A WorkerDefinition intent's content, validated by `publishWorkerDefinition`'s own rules, and
 *  its name (an item's target is named). */
function validatedWorkerDefinitionName(intent: WorkerDefinitionVersionIntent): string {
  validateWorkerDefinitionContent('worker', { ...intent.definition });
  const name = intent.definition.name;
  if (typeof name !== 'string' || name === '') {
    throw new Error(
      `change-plan: WorkerDefinition ${intent.definitionId} has no name; an item's target is named`,
    );
  }
  return name;
}

/** The item's dry run: validates the content, reads the family's head, classifies the change, and
 *  — for a Skill — checks no other family has its name published (`SkillNameConflictError` here,
 *  at review, rather than only at apply). Writes nothing. */
export async function planFamilyItem(
  client: PoolClient,
  workspaceId: string,
  intent: FamilyVersionIntent,
): Promise<PlannedFamilyItem> {
  const spec = specOf(intent.kind);
  const familyId = familyIdOf(intent);
  const head = await spec.loadHead(client, workspaceId, familyId);
  const content: Readonly<Record<string, unknown>> =
    intent.kind === 'skill_version'
      ? { ...validatedSkillContent(intent) }
      : withKeptFields(intent.definition, head?.content ?? null, intent.keepFromHead ?? []);
  const digest = contentDigest(content);
  const before = head
    ? { version: head.version, contentDigest: contentDigest(head.content) }
    : null;
  const unchanged = before?.contentDigest === digest;
  const common: PlannedFamilyItemCommon = {
    before,
    after: { contentDigest: digest },
    widening: unchanged ? [] : spec.classify(head?.content ?? null, content),
    unchanged,
    changedFields: unchanged ? [] : changedFields(head?.content ?? null, content),
  };
  if (intent.kind === 'skill_version') {
    const skill = validatedSkillContent(intent);
    if (!unchanged) {
      await assertSkillNameAvailable(
        client,
        workspaceId,
        familyId,
        skill.name,
        `change-plan: Skill ${familyId}`,
      );
    }
    return {
      ...common,
      kind: intent.kind,
      target: { skillId: familyId, name: skill.name },
      content: skill,
    };
  }
  return {
    ...common,
    kind: intent.kind,
    target: {
      definitionId: familyId,
      name: validatedWorkerDefinitionName({ ...intent, definition: content }),
    },
    content,
  };
}

/** `definition` with each `fields` value taken from `head` where the head has one (see
 *  `WorkerDefinitionVersionIntent.keepFromHead`). */
function withKeptFields(
  definition: Readonly<Record<string, unknown>>,
  head: Readonly<Record<string, unknown>> | null,
  fields: readonly KeptWorkerField[],
): Readonly<Record<string, unknown>> {
  if (head === null || fields.length === 0) return definition;
  const content: Record<string, unknown> = { ...definition };
  for (const field of fields) {
    if (head[field] !== undefined) content[field] = head[field];
  }
  return content;
}

/** Publishes the planned content as the family's next version, `appliedBy` as its proposer and
 *  publisher (the person applying the segment reviewed it; there is no separate draft), through the
 *  registry's own propose and publish — no actor, so none of a person's draft checks (D-24, the
 *  credential review: a pack's content is checked when the registry loads, `application/packs`).
 *  Returns the item's `after`. */
export async function applyFamilyItem(
  client: PoolClient,
  workspaceId: string,
  planned: PlannedFamilyItem,
  appliedBy: string,
): Promise<{ readonly contentDigest: string; readonly version: number }> {
  let version: number;
  if (planned.kind === 'skill_version') {
    const { skillId } = planned.target;
    const draft = await proposeSkill(client, workspaceId, appliedBy, {
      skillId,
      name: planned.content.name,
      description: planned.content.description,
      markdown: planned.content.markdown,
      applicable: planned.content.applicable,
    });
    const published = await publishSkill(client, workspaceId, appliedBy, skillId);
    // `publishSkill` publishes the family's latest version; under the registry lock that is the
    // draft just proposed — checked, not assumed.
    if (published.version !== draft.version) {
      throw new Error(
        `change-plan: Skill ${skillId} published v${published.version}, not the proposed v${draft.version}`,
      );
    }
    version = published.version;
  } else {
    const { definitionId } = planned.target;
    const draft = await proposeWorkerDefinition(client, workspaceId, appliedBy, {
      definitionId,
      kind: 'worker',
      definition: { ...planned.content },
    });
    const published = await publishWorkerDefinition(client, workspaceId, appliedBy, {
      definitionId,
      version: draft.version,
    });
    version = published.version;
  }
  return { contentDigest: planned.after.contentDigest, version };
}

// -------------------------------------------------------------------------------------------
// After applying: the stored item, its target now, and its rollback
// -------------------------------------------------------------------------------------------

const ContentVersionRefSchema = z
  .object({ version: z.number().int().positive(), contentDigest: z.string() })
  .strict();

const StoredSkillItemSchema = z
  .object({
    target: z.object({ skillId: z.string(), name: z.string() }).strict(),
    before: ContentVersionRefSchema.nullable(),
    after: ContentVersionRefSchema,
  })
  .strict();

const StoredWorkerDefinitionItemSchema = z
  .object({
    target: z.object({ definitionId: z.string(), name: z.string() }).strict(),
    before: ContentVersionRefSchema.nullable(),
    after: ContentVersionRefSchema,
  })
  .strict();

/** An applied `skill_version` / `worker_definition_version` item as `change_items` stores it. */
export interface StoredFamilyItem {
  readonly kind: FamilyItemKind;
  readonly familyId: string;
  readonly target: FamilyItemTarget;
  readonly before: ContentVersionRef | null;
  readonly after: ContentVersionRef;
}

/** Reads a stored item's `target` / `before` / `after`; throws on a shape its kind never writes. */
export function parseStoredFamilyItem(
  kind: FamilyItemKind,
  row: { readonly target: unknown; readonly before: unknown; readonly after: unknown },
): StoredFamilyItem {
  const raw = { target: row.target, before: row.before, after: row.after };
  if (kind === 'skill_version') {
    const item = StoredSkillItemSchema.parse(raw);
    return { kind, familyId: item.target.skillId, ...item };
  }
  const item = StoredWorkerDefinitionItemSchema.parse(raw);
  return { kind, familyId: item.target.definitionId, ...item };
}

function isVersion(row: FamilyRow, ref: ContentVersionRef): boolean {
  return row.version === ref.version && contentDigest(row.content) === ref.contentDigest;
}

export type FamilyItemState =
  | { readonly state: 'in_effect' }
  | { readonly state: 'replaced'; readonly headVersion: number }
  | { readonly state: 'not_installed' };

/** Whether the version the item published is still its family's head. */
export async function readFamilyItemState(
  client: PoolClient,
  workspaceId: string,
  item: StoredFamilyItem,
): Promise<FamilyItemState> {
  const head = await specOf(item.kind).loadHead(client, workspaceId, item.familyId);
  if (!head) return { state: 'not_installed' };
  if (isVersion(head, item.after)) return { state: 'in_effect' };
  return { state: 'replaced', headVersion: head.version };
}

/** Holds the registries until the transaction ends — taken by a rollback before it plans, so what
 *  it compares is what it changes. */
export async function lockFamilyRollback(client: PoolClient, workspaceId: string): Promise<void> {
  await lockWorkerRegistry(client, workspaceId);
}

export type FamilyRollbackBlocker =
  | {
      readonly reason: Extract<ChangeRollbackBlocker, 'not_installed' | 'restored_version_missing'>;
    }
  | { readonly reason: 'replaced'; readonly headVersion: number };

export interface PlannedFamilyRollback {
  readonly kind: FamilyItemKind;
  readonly familyId: string;
  readonly target: FamilyItemTarget;
  /** The version the item published — the family's head, when the rollback can go ahead. */
  readonly from: ContentVersionRef;
  /** The version the head goes back to; `null`: the family has no published version after. */
  readonly to: ContentVersionRef | null;
  /** The rollback's own classification (I-A4, the same whitelist as applying): from the head's
   *  content to what the head would be after. Empty when blocked. */
  readonly widening: readonly WideningReason[];
  readonly blocker: FamilyRollbackBlocker | null;
}

/** The item's rollback dry run (§3.4 "逆操作…先比较再写"): blocked unless the family's head is still
 *  the version the item published and the version before it is still published to return to.
 *  Retiring a version never gives a Skill name a second family, so there is no name check. Writes
 *  nothing; a rollback calls it under `lockFamilyRollback`. */
export async function planFamilyRollback(
  client: PoolClient,
  workspaceId: string,
  item: StoredFamilyItem,
): Promise<PlannedFamilyRollback> {
  const spec = specOf(item.kind);
  const blocked = (blocker: FamilyRollbackBlocker): PlannedFamilyRollback => ({
    kind: item.kind,
    familyId: item.familyId,
    target: item.target,
    from: item.after,
    to: item.before,
    widening: [],
    blocker,
  });
  const head = await spec.loadHead(client, workspaceId, item.familyId);
  if (!head) return blocked({ reason: 'not_installed' });
  if (!isVersion(head, item.after)) {
    return blocked({ reason: 'replaced', headVersion: head.version });
  }
  let restored: FamilyRow | null = null;
  if (item.before) {
    const row = await spec.loadVersion(client, workspaceId, item.familyId, item.before.version);
    if (!row || !isVersion(row, item.before) || row.status !== 'published') {
      return blocked({ reason: 'restored_version_missing' });
    }
    restored = row;
  }
  return {
    kind: item.kind,
    familyId: item.familyId,
    target: item.target,
    from: item.after,
    to: item.before,
    widening: spec.classify(head.content, restored?.content ?? null),
    blocker: null,
  };
}

/** Rolls the item back as planned (an unblocked `planFamilyRollback` in this transaction, under
 *  `lockFamilyRollback`): retires the version it published and checks the family's head is the
 *  version it planned to return to. Returns that head version (`null`: none published). */
export async function applyFamilyRollback(
  client: PoolClient,
  workspaceId: string,
  planned: PlannedFamilyRollback,
): Promise<number | null> {
  const spec = specOf(planned.kind);
  const subject = `${spec.label} ${planned.familyId}`;
  const retired = await spec.deprecate(client, workspaceId, planned.familyId, planned.from.version);
  if (!retired) {
    throw new Error(
      `change-plan: ${subject} v${planned.from.version} was not published when rolled back`,
    );
  }
  const head = await spec.loadHead(client, workspaceId, planned.familyId);
  const expected = planned.to;
  if (expected === null ? head !== null : !head || !isVersion(head, expected)) {
    throw new Error(
      `change-plan: ${subject}'s head after rolling back v${planned.from.version} is ${head ? `v${head.version}` : 'none'}, not ${expected ? `v${expected.version}` : 'none'}`,
    );
  }
  return head?.version ?? null;
}

/** The field under which a kind's target names its family (`provenance.ts` looks items up by it). */
export function familyIdField(kind: FamilyItemKind): 'skillId' | 'definitionId' {
  return specOf(kind).idField;
}

/** The version number of a family's head, or `null` when it has no published version. Not locked. */
export async function loadFamilyHeadVersion(
  client: PoolClient,
  workspaceId: string,
  kind: FamilyItemKind,
  familyId: string,
): Promise<number | null> {
  return (await specOf(kind).loadHead(client, workspaceId, familyId))?.version ?? null;
}

/** A `skill_version` item's target, checked (a target of the other kind throws). */
export function skillTargetOf(target: FamilyItemTarget): {
  readonly skillId: string;
  readonly name: string;
} {
  if (!('skillId' in target)) throw new Error('change-plan: not a skill_version target');
  return { skillId: target.skillId, name: target.name };
}

/** A `worker_definition_version` item's target, checked (a target of the other kind throws). */
export function workerDefinitionTargetOf(target: FamilyItemTarget): {
  readonly definitionId: string;
  readonly name: string;
} {
  if (!('definitionId' in target)) {
    throw new Error('change-plan: not a worker_definition_version target');
  }
  return { definitionId: target.definitionId, name: target.name };
}
