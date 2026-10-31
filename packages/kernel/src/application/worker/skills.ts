import {
  IllegalTransition,
  PUBLISHABLE_TRANSITIONS,
  type PublishableStatus,
  PublishedSkillDescriptionSchema,
  PublishedSkillNameSchema,
  type SkillApplicable,
  transition,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { stringify as stringifyYaml } from 'yaml';
import {
  type PublishActor,
  assertPublishAuthority,
  assertReviewedDraft,
  assertReviewedVersion,
} from '../../governance/capability/index.js';
import { assertDraftCredentialsReviewed } from '../../governance/redaction/index.js';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { projectSkillObject } from '../../substrate/ontology/index.js';
import { assertDraftNotEvaluating } from './draft-evaluating.js';
import { type DraftViewer, draftVisibilityBinds, draftVisibleTo } from './draft-visibility.js';
import { assertNoPendingDraft, familyVersionDigest, readFamilyHead } from './family-version.js';
import { assertFamilyPublishAuthority } from './publish-family.js';
import { lockWorkerRegistry } from './registry-lock.js';

const graphStore = new SqlGraphStore();

/**
 * application/worker/skills: the Skill registry (design doc §5.1.4 Skill, §5.4 I12/I16, §5.5
 * `draft -> published -> deprecated`; docs/development-tasks.md S2.14). Owns the `skills` table
 * (`migrations/worker/0002_skills_procedures.sql`) — mirrors `definitions.ts`'s own structure and
 * doc-comment conventions closely (same module, same lifecycle shape) rather than reinventing one.
 *
 * **propose is intentionally permissive, publish is the gate** (`definitions.ts`'s own doc comment,
 * reused verbatim here): `proposeSkill` inserts whatever non-empty `name`/`description`/`markdown`
 * it is given, no pi-format validation. `publishSkill` is where `validateSkillContent` runs pi's
 * own Agent Skills name/description rules (`@nexttime/shared`'s `skill.ts`) and requires a
 * non-empty markdown body — this task's own acceptance bar ("Skill: pi SKILL.md frontmatter +
 * non-empty body").
 *
 * I16 ("Handle 通道写入非 draft 状态或修改他人草稿一律拒绝"): `propose_skill`/`publish_skill`/
 * `deprecate_skill`'s channel split is enforced by the capability registry itself
 * (`packages/shared/src/capabilities.ts`: propose is `channel:'handle'`, publish/deprecate are
 * `channel:'human'`) — this module does not re-check channel. `propose` always inserts a row it
 * owns (`proposedBy` is always the calling principal), so "modify another principal's draft"
 * cannot happen through this capability's shape. What this module *does* own is I16's **read**
 * half — a draft is visible only to its proposer and the workspace's draft reviewers (owner,
 * builder — D-26's rule, `draftVisibleTo` in ./draft-visibility.ts), not just unwritable by anyone
 * else — via `listSkills`'s own predicate (see that function's doc comment; the migration's header
 * comment explains why this is *not* an RLS policy).
 */

// -------------------------------------------------------------------------------------------
// Row shape
// -------------------------------------------------------------------------------------------

interface SkillDbRow {
  workspace_id: string;
  id: string;
  version: number;
  status: PublishableStatus;
  name: string;
  description: string;
  markdown: string;
  applicable: SkillApplicable;
  proposed_by: string;
  published_by: string | null;
  created_at: Date;
  published_at: Date | null;
}

export interface SkillRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly version: number;
  readonly status: PublishableStatus;
  readonly name: string;
  readonly description: string;
  readonly markdown: string;
  readonly applicable: SkillApplicable;
  readonly proposedBy: string;
  readonly publishedBy: string | null;
  readonly createdAt: Date;
  readonly publishedAt: Date | null;
}

function mapRow(row: SkillDbRow): SkillRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    version: row.version,
    status: row.status,
    name: row.name,
    description: row.description,
    markdown: row.markdown,
    applicable: row.applicable ?? {},
    proposedBy: row.proposed_by,
    publishedBy: row.published_by,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}

/** Review #493 on #764 (F1): the digest a reviewer hands back to `publish_skill`
 *  (`familyVersionDigest`) — everything the version says, and who proposed it. */
export function skillDraftDigest(
  row: Pick<
    SkillRow,
    'id' | 'version' | 'name' | 'description' | 'markdown' | 'applicable' | 'proposedBy'
  >,
): string {
  return familyVersionDigest('skill', {
    id: row.id,
    version: row.version,
    name: row.name,
    description: row.description,
    markdown: row.markdown,
    applicable: row.applicable,
    proposedBy: row.proposedBy,
  });
}

const SELECT_COLUMNS = `workspace_id, id, version, status, name, description, markdown, applicable,
  proposed_by, published_by, created_at, published_at`;

// -------------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------------

export class SkillNotFoundError extends Error {
  constructor(workspaceId: string, skillId: string) {
    super(`Skill not found: workspace ${workspaceId}, id ${skillId}`);
    this.name = 'SkillNotFoundError';
  }
}

/** Thrown by `publishSkill` when `name`/`description` fail pi's own Agent Skills rules, or
 *  `markdown` is empty after trimming (this task's acceptance bar: "Skill: pi SKILL.md frontmatter
 *  + non-empty body"). */
export class SkillValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillValidationError';
  }
}

/**
 * S11 P1-D: a Skill name belongs to one Skill family among published versions. A Worker mounts its
 * Skills by name or id (`resolvePublishedSkills`), and pi loads two Skills of one name as one,
 * dropping the other — so a second family publishing a name another one has published would make
 * which text a Worker reads depend on row order. Raised by `publishSkill` and by a ChangePlan
 * segment installing a pack's Skill (at review and at apply), before anything is written; mapped to
 * 409 `skill_name_conflict`. The fix is the owner's: deprecate the other family, or rename.
 */
export class SkillNameConflictError extends Error {
  readonly code = 'skill_name_conflict' as const;
  readonly skillName: string;
  /** The family that already has the name published. */
  readonly ownerSkillId: string;
  constructor(skillName: string, ownerSkillId: string, subject: string) {
    super(
      `${subject}: Skill name "${skillName}" is already published by another Skill (${ownerSkillId}) — a Worker mounts Skills by name, so a name has one Skill; deprecate that one or rename this one. Nothing was published`,
    );
    this.name = 'SkillNameConflictError';
    this.skillName = skillName;
    this.ownerSkillId = ownerSkillId;
  }
}

/**
 * S11 W1a E2-0: a new version of a Skill keeps the family's name. A Worker mounts Skills by id or by
 * name (`resolvePublishedSkills`, newest published version per family among the rows that match),
 * and publishing a version does not deprecate the one before it — so a renamed version would leave
 * every Worker that names the Skill on the old version. A different name is a different Skill:
 * propose it without `skillId`. Mapped to 409 `skill_name_changed`; nothing was proposed.
 */
export class SkillFamilyNameChangedError extends Error {
  readonly code = 'skill_name_changed' as const;
  readonly skillId: string;
  /** The name the family's latest version carries. */
  readonly skillName: string;
  readonly proposedName: string;
  constructor(skillId: string, skillName: string, proposedName: string) {
    super(
      `Skill ${skillId} is named "${skillName}"; a new version keeps its name (a Worker mounts Skills by name, and the earlier version stays published), so "${proposedName}" would be a different Skill — propose it as a new Skill instead. Nothing was proposed`,
    );
    this.name = 'SkillFamilyNameChangedError';
    this.skillId = skillId;
    this.skillName = skillName;
    this.proposedName = proposedName;
  }
}

/** Refuses with `SkillNameConflictError` when a Skill family other than `skillId` has a published
 *  version named `name`. Called under `lockWorkerRegistry`, so the answer holds until the caller's
 *  transaction ends. */
export async function assertSkillNameAvailable(
  client: PoolClient,
  workspaceId: string,
  skillId: string,
  name: string,
  subject: string,
): Promise<void> {
  const result = await client.query<{ id: string }>(
    `select id from skills
     where workspace_id = $1 and name = $2 and status = 'published' and id <> $3
     order by id
     limit 1`,
    [workspaceId, name, skillId],
  );
  const owner = result.rows[0];
  if (owner) throw new SkillNameConflictError(name, owner.id, subject);
}

// -------------------------------------------------------------------------------------------
// Content validation (publish-time only — see this module's doc comment).
// -------------------------------------------------------------------------------------------

/** Validates a Skill's content against pi's own Agent Skills rules (`@nexttime/shared`'s
 *  `skill.ts`) plus "non-empty body". Throws `SkillValidationError`; returns nothing on success. */
export function validateSkillContent(skill: {
  readonly name: string;
  readonly description: string;
  readonly markdown: string;
}): void {
  const nameResult = PublishedSkillNameSchema.safeParse(skill.name);
  if (!nameResult.success) {
    throw new SkillValidationError(
      `Skill name failed pi Agent Skills validation: ${nameResult.error.message}`,
    );
  }
  const descriptionResult = PublishedSkillDescriptionSchema.safeParse(skill.description);
  if (!descriptionResult.success) {
    throw new SkillValidationError(
      `Skill description failed pi Agent Skills validation: ${descriptionResult.error.message}`,
    );
  }
  if (skill.markdown.trim().length === 0) {
    throw new SkillValidationError('Skill markdown body must not be empty');
  }
}

// -------------------------------------------------------------------------------------------
// propose
// -------------------------------------------------------------------------------------------

export interface ProposeSkillInput {
  /** Omit to start a new Skill family (a fresh `id`, version 1); given (`propose_skill{skillId}`,
   *  S11 W1a E2-0), proposes the next version of that existing family — under the rules of
   *  `family-version.ts`, and keeping the family's name ({@link SkillFamilyNameChangedError}). */
  readonly skillId?: string;
  /** With `skillId` naming an id that has no version yet: `'not_found'` (the default — a person's
   *  `propose_skill{skillId}` never starts a family under an id of their choosing), or `'start'`:
   *  version 1 under that id. Only a pack's install passes `'start'`
   *  (`application/change-plan/family-item.ts` — the pack derives the family id from its own name
   *  and the Skill's); the capability handler builds its input without it. */
  readonly onMissingFamily?: 'not_found' | 'start';
  readonly name: string;
  readonly description: string;
  readonly markdown: string;
  readonly applicable?: SkillApplicable;
}

/** The version a proposal gets: 1 for a new family; for an existing one, the next after its latest,
 *  which must exist (unless `onMissingFamily: 'start'`), not be a draft (`family-version.ts`) and
 *  carry the same name. Under `lockWorkerRegistry`, so two proposals to one family cannot both read
 *  the same latest. */
async function nextVersion(
  client: PoolClient,
  workspaceId: string,
  input: ProposeSkillInput,
): Promise<number> {
  const { skillId } = input;
  if (!skillId) return 1;
  await lockWorkerRegistry(client, workspaceId);
  const head = await readFamilyHead(client, 'skills', workspaceId, skillId);
  if (!head) {
    if (input.onMissingFamily === 'start') return 1;
    throw new SkillNotFoundError(workspaceId, skillId);
  }
  assertNoPendingDraft('skill', skillId, head);
  if (head.name !== input.name)
    throw new SkillFamilyNameChangedError(skillId, head.name, input.name);
  return head.version + 1;
}

/** Refuses (`FamilyDraftPendingError`) while the Skill family's latest version is a draft — what
 *  proposing its next version requires, checked ahead of time: a pack's install review
 *  (`application/change-plan/family-item.ts`'s `planFamilyItem`) says so before anyone confirms,
 *  rather than the install failing at apply. The caller holds `lockWorkerRegistry`. A family with
 *  no version passes. */
export async function assertNoPendingSkillDraft(
  client: PoolClient,
  workspaceId: string,
  skillId: string,
): Promise<void> {
  const head = await readFamilyHead(client, 'skills', workspaceId, skillId);
  if (head) assertNoPendingDraft('skill', skillId, head);
}

/** Creates a new `draft` Skill version, owned by `proposerPrincipalId` (I16: ownership is the
 *  calling principal by construction). No content validation happens here — see `publishSkill`. */
export async function proposeSkill(
  client: PoolClient,
  workspaceId: string,
  proposerPrincipalId: string,
  input: ProposeSkillInput,
): Promise<SkillRow> {
  const version = await nextVersion(client, workspaceId, input);
  const result = await client.query<SkillDbRow>(
    `insert into skills
       (workspace_id, id, version, status, name, description, markdown, applicable, proposed_by)
     values
       ($1, coalesce($2::uuid, gen_random_uuid()), $3, 'draft', $4, $5, $6, $7::jsonb, $8)
     returning ${SELECT_COLUMNS}`,
    [
      workspaceId,
      input.skillId ?? null,
      version,
      input.name,
      input.description,
      input.markdown,
      JSON.stringify(input.applicable ?? {}),
      proposerPrincipalId,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('proposeSkill: INSERT ... RETURNING produced no row');
  return mapRow(row);
}

// -------------------------------------------------------------------------------------------
// publish / deprecate — resolve to the *latest* version under `skillId`. `publish_skill` also
// names the version its caller reviewed (legacy 300, `PublishActor.reviewedVersion`) and refuses
// when the latest is another one; `deprecate_skill` takes `{skillId}` alone —
// packages/shared/src/capabilities.ts.
// -------------------------------------------------------------------------------------------

async function getLatestForUpdate(
  client: PoolClient,
  workspaceId: string,
  skillId: string,
): Promise<SkillRow> {
  const result = await client.query<SkillDbRow>(
    `select ${SELECT_COLUMNS} from skills
     where workspace_id = $1 and id = $2
     order by version desc
     limit 1
     for update`,
    [workspaceId, skillId],
  );
  const row = result.rows[0];
  if (!row) throw new SkillNotFoundError(workspaceId, skillId);
  return mapRow(row);
}

/** D-24 (`governance/capability/publish-authority.ts`): the locked row's proposer or the owner.
 *  A draft the caller cannot see (`draftVisibleTo`) is not found — the same answer `get_skill`
 *  gives; a row the caller can see (a builder reviewing someone else's draft, or any published /
 *  deprecated version) is a 403 `not_proposer`. */
function requireSkillAuthority(
  action: 'publish_skill' | 'deprecate_skill',
  actor: PublishActor | undefined,
  row: SkillRow,
): void {
  assertPublishAuthority(
    action,
    actor,
    row,
    `Skill ${row.id}@${row.version}`,
    actor && !draftVisibleTo(actor, row)
      ? () => new SkillNotFoundError(row.workspaceId, row.id)
      : undefined,
  );
}

/** What a Skill makes take effect when published — the content `publish_skill`'s suspected-
 *  credential count reads (governance/redaction/credential-review.ts). */
export function skillReviewContent(row: SkillRow): unknown {
  return {
    name: row.name,
    description: row.description,
    markdown: row.markdown,
    applicable: row.applicable,
  };
}

/** Publishes the latest draft version of `skillId` (human channel only — enforced at the gateway):
 *  validates the transition (`IllegalTransition` on anything but `draft -> published`), validates
 *  content (`validateSkillContent`) and that no other family has the name published
 *  (`SkillNameConflictError`), sets `published_by`/`published_at`, and projects the Skill into the
 *  graph (`substrate/ontology`'s `projectSkillObject`) so `find_procedures`/`list_skills` and a
 *  future WorkerDefinition's `uses` resolution (`application/task/spawn.ts`) have something to
 *  find. Refuses (`DraftEvaluatingError`) while an evaluation of the draft runs. Under
 *  `lockWorkerRegistry`, taken first.
 *
 *  `actor` (D-24): the `publish_skill` caller — `actor.principalId` is `publisherPrincipalId` —
 *  checked against the locked row (`requireSkillAuthority`) and against the family's live
 *  version it would supersede (`assertFamilyPublishAuthority`); omitted by internal callers. */
export async function publishSkill(
  client: PoolClient,
  workspaceId: string,
  publisherPrincipalId: string,
  skillId: string,
  actor?: PublishActor,
): Promise<SkillRow> {
  await lockWorkerRegistry(client, workspaceId);
  const row = await getLatestForUpdate(client, workspaceId, skillId);
  requireSkillAuthority('publish_skill', actor, row);
  // Legacy 300: publish what the person reviewed — a newer version under this id since refuses.
  assertReviewedVersion('publish_skill', `Skill ${row.id}`, actor?.reviewedVersion, row.version);
  // Review #493 on #764 (F1): and the content of that version — a discarded draft's version is
  // taken again by the next proposal.
  assertReviewedDraft(
    'publish_skill',
    `Skill ${row.id}@${row.version}`,
    actor?.reviewedDraftDigest,
    skillDraftDigest(row),
  );
  transition(PUBLISHABLE_TRANSITIONS, row.status, 'publish');
  // S10 E3-3: an evaluation of this draft still running has not given its evidence yet — publish
  // once it ends, or cancel it (as discard and reject wait).
  await assertDraftNotEvaluating(client, workspaceId, row);
  await assertFamilyPublishAuthority(client, workspaceId, {
    table: 'skills',
    action: 'publish_skill',
    familyId: row.id,
    subject: `Skill ${row.id}@${row.version}`,
    actor,
  });
  validateSkillContent(row);
  await assertSkillNameAvailable(
    client,
    workspaceId,
    row.id,
    row.name,
    `publish_skill: Skill ${row.id}@${row.version}`,
  );
  assertDraftCredentialsReviewed(
    'skill',
    `${row.id}@${row.version}`,
    skillReviewContent(row),
    actor,
  );

  const result = await client.query<SkillDbRow>(
    `update skills
     set status = 'published', published_by = $4, published_at = now()
     where workspace_id = $1 and id = $2 and version = $3
     returning ${SELECT_COLUMNS}`,
    [workspaceId, row.id, row.version, publisherPrincipalId],
  );
  const updated = result.rows[0];
  if (!updated) throw new Error('publishSkill: UPDATE ... RETURNING produced no row');

  const skillObject = await projectSkillObject(client, workspaceId, {
    skillId: row.id,
    version: row.version,
    name: row.name,
    description: row.description,
  });

  await linkPublishedWorkerDefinitionsUsingSkill(client, workspaceId, publisherPrincipalId, {
    skillId: row.id,
    skillName: row.name,
    skillObjectId: skillObject.id,
  });

  return mapRow(updated);
}

interface ReferencingWorkerDefinitionRow {
  id: string;
  version: number;
}

/**
 * `WorkerDefinition --uses--> Skill` (design doc §5.1.2; docs/development-tasks.md S2.14
 * deliverable 1: "publish 也把对象投影进图（Skill/Procedure 元本体对象 + WorkerDefinition --uses-->
 * Skill ... 链接）"). Asserted here, at *Skill* publish time, scanning already-published
 * WorkerDefinitions whose own `definition.skills[]` names this Skill by `id` or `name`
 * (`packages/shared/src/worker-definition.ts`'s `skills` field, "referenced by name/id only") —
 * not the other way around (at *WorkerDefinition* publish time) — because `worker_definitions` is
 * this same module's own sibling table (`application/worker/definitions.ts`, same `worker` module
 * — direct SQL access across sibling files within one module is the established convention, e.g.
 * `governance/approval` reading `governance/policy`'s public functions rather than its tables, but
 * within *one* module the tables themselves are shared) and this keeps the whole feature
 * self-contained in this file rather than reopening `definitions.ts`'s own publish flow (which has
 * no Activity of its own to hang a Fact on today) to add a cross-cutting concern this task owns.
 * Best-effort in the sense that a WorkerDefinition published *before* this Skill existed is linked
 * retroactively (as soon as this Skill publishes); one published *after* is covered by
 * S2.6/S2.7's own `find_workers`-style discovery instead — not a gap this function needs to close
 * (design doc has no "retroactive" requirement either way; this is simply what "scan what's already
 * published, right now" naturally covers). Since legacy 302 a WorkerDefinition publishes only once
 * the Skills it names are published (`definition-references.ts`), so the definitions this scan
 * finds name a Skill whose earlier version they were published against; the link drawn is to this
 * version. Nothing reads `uses` today.
 */
async function linkPublishedWorkerDefinitionsUsingSkill(
  client: PoolClient,
  workspaceId: string,
  publisherPrincipalId: string,
  skill: { readonly skillId: string; readonly skillName: string; readonly skillObjectId: string },
): Promise<void> {
  const referencing = await client.query<ReferencingWorkerDefinitionRow>(
    `select id, version from worker_definitions
     where workspace_id = $1 and status = 'published'
       and definition -> 'skills' ?| array[$2, $3]`,
    [workspaceId, skill.skillId, skill.skillName],
  );

  for (const def of referencing.rows) {
    const workerDefObject = await graphStore.getObjectByIdentity(
      client,
      workspaceId,
      'WorkerDefinition',
      { definitionId: def.id, version: def.version },
    );
    // Defensive — every published WorkerDefinition has a graph projection
    // (`projectWorkerDefinitionObject`, called unconditionally by `publishWorkerDefinition`); this
    // should never actually be null, but a missing projection must never break Skill publish.
    if (!workerDefObject) continue;

    const activity = await startActivity(client, workspaceId, {
      kind: 'skill_publish',
      principalId: publisherPrincipalId,
      metadata: {
        skillId: skill.skillId,
        workerDefinitionId: def.id,
        workerDefinitionVersion: def.version,
      },
    });
    await graphStore.assertFact(
      client,
      workspaceId,
      { id: publisherPrincipalId, kind: 'human' },
      {
        linkType: 'uses',
        sourceObjectId: workerDefObject.id,
        targetObjectId: skill.skillObjectId,
        activityId: activity.id,
      },
    );
    await endActivity(client, workspaceId, activity.id, 'completed');
  }
}

/** Deprecates the latest version of `skillId` (human channel only). `IllegalTransition` unless it
 *  is currently `published`. `actor` (D-24): as for `publishSkill`. Under `lockWorkerRegistry`. */
export async function deprecateSkill(
  client: PoolClient,
  workspaceId: string,
  skillId: string,
  actor?: PublishActor,
): Promise<SkillRow> {
  await lockWorkerRegistry(client, workspaceId);
  const row = await getLatestForUpdate(client, workspaceId, skillId);
  requireSkillAuthority('deprecate_skill', actor, row);
  transition(PUBLISHABLE_TRANSITIONS, row.status, 'deprecate');

  const result = await client.query<SkillDbRow>(
    `update skills
     set status = 'deprecated'
     where workspace_id = $1 and id = $2 and version = $3
     returning ${SELECT_COLUMNS}`,
    [workspaceId, row.id, row.version],
  );
  const updated = result.rows[0];
  if (!updated) throw new Error('deprecateSkill: UPDATE ... RETURNING produced no row');
  return mapRow(updated);
}

// -------------------------------------------------------------------------------------------
// S11 P1-D: a family's head, one version, and retiring one version — what a ChangePlan item
// (`application/change-plan/family-item.ts`) reads and writes, under `lockWorkerRegistry`.
// -------------------------------------------------------------------------------------------

/** The family's head: its latest published version (the one `resolvePublishedSkills` mounts), or
 *  `null` when none is published. */
export async function loadPublishedSkillHead(
  client: PoolClient,
  workspaceId: string,
  skillId: string,
): Promise<SkillRow | null> {
  const result = await client.query<SkillDbRow>(
    `select ${SELECT_COLUMNS} from skills
     where workspace_id = $1 and id = $2 and status = 'published'
     order by version desc
     limit 1`,
    [workspaceId, skillId],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** One version of the family, whatever its status; `null` when there is no such row. */
export async function loadSkillVersion(
  client: PoolClient,
  workspaceId: string,
  skillId: string,
  version: number,
): Promise<SkillRow | null> {
  const result = await client.query<SkillDbRow>(
    `select ${SELECT_COLUMNS} from skills where workspace_id = $1 and id = $2 and version = $3`,
    [workspaceId, skillId, version],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Retires `version` of the family (`published -> deprecated`, the lifecycle's one edge out of
 *  `published`), whatever versions came after it — unlike `deprecateSkill`, which acts on the
 *  latest. Returns whether a published row was retired. Its rollback's caller (a ChangePlan item)
 *  holds `lockWorkerRegistry` and audits the change. */
export async function deprecatePublishedSkillVersion(
  client: PoolClient,
  workspaceId: string,
  skillId: string,
  version: number,
): Promise<boolean> {
  const result = await client.query(
    `update skills set status = 'deprecated'
     where workspace_id = $1 and id = $2 and version = $3 and status = 'published'`,
    [workspaceId, skillId, version],
  );
  return (result.rowCount ?? 0) === 1;
}

// -------------------------------------------------------------------------------------------
// reads
// -------------------------------------------------------------------------------------------

/** `list_skills`: published Skills (their latest version only — a superseded draft-before-publish
 *  version never surfaces once a later one exists) plus the draft Skills `viewer` may see — their
 *  own, or every draft for the owner and builders (I16 read-privacy with D-26's reviewer rule,
 *  `draftVisibleTo` — this is the enforcement point this module's own doc comment describes: a
 *  draft proposed by principal A is simply absent from a non-reviewer principal B's `list_skills`
 *  result, the same "not found" behavior a single-row lookup would give). A deprecated version is
 *  not listed (unchanged). */
// -------------------------------------------------------------------------------------------
// S8 W1-C (leftover 48 pagination list): `list_skills` keyset page — the pre-existing `distinct
// on (id) ... order by id, version desc` picked "latest version per id" but sorted the *page*
// itself by `id` (an arbitrary uuid order, not a business ordering) — no existing caller relies
// on that specific order (only `.some(...)`/set-membership checks; `packages/web/src/lib/*.ts`
// callers pass no `limit` and build an id→row map, order-independent), so wrapping the dedup in a
// CTE and sorting the outer page `created_at desc` (newest first, this task's own default
// direction) is additive, not a behavior change any caller depends on.
// -------------------------------------------------------------------------------------------
export const DEFAULT_LIST_SKILLS_LIMIT = 100;
export const MAX_LIST_SKILLS_LIMIT = 500;

const SKILL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeListSkillsCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeListSkillsCursor(
  cursor: string | undefined,
): { readonly createdAt: string; readonly id: string } | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const sepIndex = decoded.lastIndexOf('|');
    if (sepIndex < 0) return null;
    const createdAt = decoded.slice(0, sepIndex);
    const id = decoded.slice(sepIndex + 1);
    if (!createdAt || Number.isNaN(Date.parse(createdAt)) || !SKILL_UUID_PATTERN.test(id)) {
      return null;
    }
    return { createdAt, id };
  } catch {
    return null;
  }
}

export interface ListSkillsFilter {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface SkillsPage {
  readonly items: readonly SkillRow[];
  readonly nextCursor?: string;
  readonly truncated?: true;
}

export async function listSkills(
  client: PoolClient,
  workspaceId: string,
  viewer: DraftViewer,
  filter: ListSkillsFilter = {},
): Promise<SkillsPage> {
  const requestedLimit = filter.limit ?? DEFAULT_LIST_SKILLS_LIMIT;
  const limit = Math.min(Math.max(requestedLimit, 1), MAX_LIST_SKILLS_LIMIT);
  const cursor = decodeListSkillsCursor(filter.cursor);
  const visibility = draftVisibilityBinds(viewer);

  const result = await client.query<SkillDbRow>(
    `with latest as (
       select distinct on (id) ${SELECT_COLUMNS} from skills
       where workspace_id = $1
         and (
           status = 'published'
           or (status = 'draft' and ($6::boolean or proposed_by = $2))
         )
       order by id, version desc
     )
     select * from latest
     where (
       $3::timestamptz is null
       or (date_trunc('milliseconds', created_at), id) < ($3::timestamptz, $4::uuid)
     )
     order by date_trunc('milliseconds', created_at) desc, id desc
     limit $5`,
    [
      workspaceId,
      visibility.principalId,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      limit + 1,
      visibility.seesEveryDraft,
    ],
  );

  const rows = result.rows.slice(0, limit).map(mapRow);
  const last = rows[rows.length - 1];
  const nextCursor =
    result.rows.length > limit && last
      ? encodeListSkillsCursor(last.createdAt, last.id)
      : undefined;
  const truncated = requestedLimit > MAX_LIST_SKILLS_LIMIT ? (true as const) : undefined;
  return {
    items: rows,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    ...(truncated !== undefined ? { truncated } : {}),
  };
}

/** `get_skill` (S8 W1-C, leftover 48 "无 get_skill"): one Skill's latest version, full markdown
 *  body included — same read predicate as `listSkills` (published, or a draft `viewer` may see:
 *  their own, or any for the owner and builders — `draftVisibleTo`); `null` for an unknown id or
 *  a draft the viewer may not see (never distinguished — same "not found" convention
 *  `listSkills`'s own doc comment already established for this predicate). `version` (UX
 *  acceptance of #764, P2-1) reads that version instead — the published one a draft row's
 *  `inUse` names — under the same predicate. */
export async function getSkill(
  client: PoolClient,
  workspaceId: string,
  viewer: DraftViewer,
  skillId: string,
  version?: number,
): Promise<SkillRow | null> {
  const visibility = draftVisibilityBinds(viewer);
  const result = await client.query<SkillDbRow>(
    `select ${SELECT_COLUMNS} from skills
     where workspace_id = $1
       and id = $2
       and ($5::int is null or version = $5)
       and (
         status = 'published'
         or (status = 'draft' and ($4::boolean or proposed_by = $3))
       )
     order by version desc
     limit 1`,
    [workspaceId, skillId, visibility.principalId, visibility.seesEveryDraft, version ?? null],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** UX acceptance of #764 (P2-1): each of `skillIds`' latest published version — what Workers mount
 *  (`resolvePublishedSkills`) — keyed by id; an id with none is absent. `list_skills` attaches it to
 *  a draft row as `inUse`, so a family with a pending draft still shows the version in use.
 *  Published rows are every reader's, so no draft predicate applies. */
export async function latestPublishedSkills(
  client: PoolClient,
  workspaceId: string,
  skillIds: readonly string[],
): Promise<ReadonlyMap<string, SkillRow>> {
  if (skillIds.length === 0) return new Map();
  const result = await client.query<SkillDbRow>(
    `select distinct on (id) ${SELECT_COLUMNS} from skills
     where workspace_id = $1 and id = any($2::uuid[]) and status = 'published'
     order by id, version desc`,
    [workspaceId, skillIds],
  );
  return new Map(result.rows.map((row) => [row.id, mapRow(row)]));
}

/** Every currently-published Skill's own `id` (workspace-wide, no draft mixing — unlike
 *  `listSkills` above, which also surfaces the drafts its viewer may see). S3.13's
 *  `governance/agent-profile` uses this as the "every published Skill" ceiling
 *  `AgentProfile.enabledSkills === null` (inherit) resolves to. */
export async function listPublishedSkillIds(
  client: PoolClient,
  workspaceId: string,
): Promise<readonly string[]> {
  const result = await client.query<{ id: string }>(
    `select id from skills where workspace_id = $1 and status = 'published'`,
    [workspaceId],
  );
  return result.rows.map((row) => row.id);
}

/** Resolves each of `refs` (a WorkerDefinition's declared `skills[]` — id or name, S2.14
 *  deliverable 4) against **published** Skills only, by `id` first, then by `name` — returns only
 *  the ones that actually resolve (silently skipping the rest, same "best effort, never blocks
 *  the caller" convention `application/task/invoke.ts`'s own gate-resolution code uses elsewhere).
 *  Deduplicates by Skill `id` (two `refs` entries resolving to the same Skill mount only once). */
export async function resolvePublishedSkills(
  client: PoolClient,
  workspaceId: string,
  refs: readonly string[],
): Promise<readonly SkillRow[]> {
  if (refs.length === 0) return [];
  const result = await client.query<SkillDbRow>(
    `select distinct on (id) ${SELECT_COLUMNS} from skills
     where workspace_id = $1
       and status = 'published'
       and (id::text = any($2::text[]) or name = any($2::text[]))
     order by id, version desc`,
    [workspaceId, refs],
  );
  return result.rows.map(mapRow);
}

/** The exact Skill versions `refs` names, whatever their status (S11 GO2: a goal step's later
 *  attempt mounts the versions its first attempt loaded, and refuses to start when one is no longer
 *  published) — a ref with no such row is simply absent from the result. */
export async function readSkillVersions(
  client: PoolClient,
  workspaceId: string,
  refs: readonly { readonly skillId: string; readonly version: number }[],
): Promise<readonly SkillRow[]> {
  if (refs.length === 0) return [];
  const result = await client.query<SkillDbRow>(
    `select ${SELECT_COLUMNS} from skills s
     join unnest($2::uuid[], $3::int[]) as r(skill_id, skill_version)
       on s.id = r.skill_id and s.version = r.skill_version
     where s.workspace_id = $1`,
    [workspaceId, refs.map((ref) => ref.skillId), refs.map((ref) => ref.version)],
  );
  return result.rows.map(mapRow);
}

// -------------------------------------------------------------------------------------------
// mounting (S2.14 deliverable 4) — the on-disk file content pi's `loadSkills` reads.
// -------------------------------------------------------------------------------------------

/**
 * Deterministically renders one **published** Skill into pi's on-disk `SKILL.md` format
 * (frontmatter + body) — see this module's sibling `@nexttime/shared`'s `skill.ts` doc comment for
 * why `markdown` never stores the frontmatter itself. `yaml`'s own `stringify` (already a kernel
 * dependency — `substrate/ontology/loader.ts` uses the same package) handles quoting/escaping for
 * `name`/`description`, so a description containing `:`, quotes, or other YAML-special characters
 * still round-trips correctly through pi's own `yaml`-based `parseFrontmatter`.
 */
export function renderSkillMarkdownFile(skill: {
  readonly name: string;
  readonly description: string;
  readonly markdown: string;
}): string {
  const frontmatter = stringifyYaml({ name: skill.name, description: skill.description }).trimEnd();
  return `---\n${frontmatter}\n---\n\n${skill.markdown.trim()}\n`;
}

export { IllegalTransition };
