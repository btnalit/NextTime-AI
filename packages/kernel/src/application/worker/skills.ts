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
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { projectSkillObject } from '../../substrate/ontology/index.js';

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
 * half — a draft is private to its proposer, not just unwritable by anyone else — via `listSkills`'s
 * own predicate (see that function's doc comment; the migration's header comment explains why this
 * is *not* an RLS policy).
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
  /** Omit to start a new Skill family (a fresh `id`, version 1); given, proposes the next version
   *  under that existing `id` — mirrors `definitions.ts`'s `ProposeWorkerDefinitionInput`. No
   *  currently-registered capability passes this (`propose_skill`'s own `paramsSchema` has no id
   *  field, packages/shared/src/capabilities.ts) — kept for the same reason `definitions.ts` keeps
   *  it: the relational shape (a versioned family) already supports it, and a future capability
   *  extending `propose_skill` should not need a schema migration to use it. */
  readonly skillId?: string;
  readonly name: string;
  readonly description: string;
  readonly markdown: string;
  readonly applicable?: SkillApplicable;
}

async function nextVersion(
  client: PoolClient,
  workspaceId: string,
  skillId: string | undefined,
): Promise<number> {
  if (!skillId) return 1;
  const result = await client.query<{ max: number | null }>(
    'select max(version) as max from skills where workspace_id = $1 and id = $2',
    [workspaceId, skillId],
  );
  return (result.rows[0]?.max ?? 0) + 1;
}

/** Creates a new `draft` Skill version, owned by `proposerPrincipalId` (I16: ownership is the
 *  calling principal by construction). No content validation happens here — see `publishSkill`. */
export async function proposeSkill(
  client: PoolClient,
  workspaceId: string,
  proposerPrincipalId: string,
  input: ProposeSkillInput,
): Promise<SkillRow> {
  const version = await nextVersion(client, workspaceId, input.skillId);
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
// publish / deprecate — resolve to the *latest* version under `skillId` (the registered
// `publish_skill`/`deprecate_skill` capabilities take `{skillId}` alone, no `version` —
// packages/shared/src/capabilities.ts).
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

/** Publishes the latest draft version of `skillId` (human channel only — enforced at the gateway):
 *  validates the transition (`IllegalTransition` on anything but `draft -> published`), validates
 *  content (`validateSkillContent`), sets `published_by`/`published_at`, and projects the Skill
 *  into the graph (`substrate/ontology`'s `projectSkillObject`) so `find_procedures`/`list_skills`
 *  and a future WorkerDefinition's `uses` resolution (`application/task/spawn.ts`) have something
 *  to find. */
export async function publishSkill(
  client: PoolClient,
  workspaceId: string,
  publisherPrincipalId: string,
  skillId: string,
): Promise<SkillRow> {
  const row = await getLatestForUpdate(client, workspaceId, skillId);
  transition(PUBLISHABLE_TRANSITIONS, row.status, 'publish');
  validateSkillContent(row);

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
 * published, right now" naturally covers).
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
 *  is currently `published`. */
export async function deprecateSkill(
  client: PoolClient,
  workspaceId: string,
  skillId: string,
): Promise<SkillRow> {
  const row = await getLatestForUpdate(client, workspaceId, skillId);
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
// reads
// -------------------------------------------------------------------------------------------

/** `list_skills`: published Skills (their latest version only — a superseded draft-before-publish
 *  version never surfaces once a later one exists) plus `callerPrincipalId`'s own draft Skills
 *  (I16 read-privacy — this is the enforcement point this module's own doc comment describes: a
 *  draft proposed by principal A is simply absent from principal B's `list_skills` result, the same
 *  "not found" behavior a single-row lookup would give, without needing a separate single-row
 *  capability to test it against). */
export async function listSkills(
  client: PoolClient,
  workspaceId: string,
  callerPrincipalId: string,
): Promise<readonly SkillRow[]> {
  const result = await client.query<SkillDbRow>(
    `select distinct on (id) ${SELECT_COLUMNS} from skills
     where workspace_id = $1
       and (status = 'published' or (status = 'draft' and proposed_by = $2))
     order by id, version desc`,
    [workspaceId, callerPrincipalId],
  );
  return result.rows.map(mapRow);
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
