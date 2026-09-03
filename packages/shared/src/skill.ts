import { z } from 'zod';

/**
 * skill: the Zod shape of a Skill's content (design doc §5.1.4 Skill "一份步骤文档（pi skill 格式），
 * 写明用哪些 Operation/ObjectType 它适用、有什么坑；draft -> published -> deprecated"; §9.2 skills row
 * sketch; docs/development-tasks.md S2.14). `skills.name`/`.description`/`.markdown` are first-class
 * relational columns (`migrations/worker/0002_skills_procedures.sql`), not one opaque jsonb blob
 * (unlike `worker_definitions.definition`) — see that migration's own header comment for why.
 *
 * **`markdown` stores only the skill's instructional body, never a literal `---\n...\n---`
 * frontmatter block.** pi 0.84.4's on-disk `SKILL.md` format is frontmatter (`name`/`description`)
 * plus a body (`docs/skills.md` in the pinned `@earendil-works/pi-coding-agent` package, verified
 * against its `core/skills.ts` `loadSkillFromFile`/`parseFrontmatter`) — but hand-rolling that
 * frontmatter as a stored string invites a whole class of bugs this schema sidesteps entirely:
 * `name`/`description` could drift from whatever a hand-written frontmatter block says, YAML
 * special characters in `description` could corrupt the block, and publish-time validation would
 * need to re-parse YAML out of a string just to check the very fields already sitting in their own
 * columns. Instead: `name`/`description`/`markdown` are validated directly (this file), and
 * `application/worker/skills.ts`'s `renderSkillMarkdownFile` deterministically *serializes* the
 * on-disk file from them at mount time (S2.14 deliverable 4) — the file pi actually reads is a
 * projection of this row, generated once, not a second independent source of truth.
 *
 * Two validation tiers, mirroring `packages/shared/src/worker-definition.ts`'s own "propose is
 * permissive, publish is the gate" split (`application/worker/definitions.ts`'s doc comment has the
 * fuller rationale, reused verbatim for Skill/Procedure by this task):
 *   - {@link ProposeSkillContentSchema} — propose-time: only requires the DB's own `not null`
 *     columns to hold *some* non-empty string. No pi-format validation yet — a draft-in-progress
 *     may not satisfy pi's stricter name/description rules until it is polished for publish.
 *   - {@link PublishedSkillNameSchema} / {@link PublishedSkillDescriptionSchema} — publish-time:
 *     pi's own Agent Skills spec rules (`docs/skills.md` "Name Rules" / "Frontmatter" tables in the
 *     pinned package), replicated here so `application/worker/skills.ts`'s `publishSkill` can
 *     reject a draft whose `name`/`description` would not actually load as a valid pi Skill once
 *     mounted — this task's own acceptance bar ("Skill: pi SKILL.md frontmatter + non-empty body").
 */

/** pi Agent Skills spec: name is 1-64 chars, lowercase letters/digits/hyphens, no leading/trailing
 *  or consecutive hyphens (`docs/skills.md` "Name Rules", `core/skills.ts` `validateName`). */
export const SKILL_NAME_MAX_LENGTH = 64;
/** pi Agent Skills spec: description is required, max 1024 chars (`docs/skills.md`
 *  "Frontmatter", `core/skills.ts` `validateDescription`). */
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Which Gatekeeper transport kinds / ObjectTypes this Skill is relevant to — pure discovery
 *  metadata (`list_skills`/`find_procedures` filtering, design doc §5.1.4 Skill "写明用哪些
 *  Operation/ObjectType 它适用"), never interpreted by the mounting mechanism. Both optional; an
 *  omitted array means "not specifically scoped" rather than "applies to nothing". */
export const SkillApplicableSchema = z
  .object({
    gateKinds: z.array(z.string().min(1)).optional(),
    objectTypes: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type SkillApplicable = z.infer<typeof SkillApplicableSchema>;

/** Propose-time content (permissive — see this module's doc comment). Also the shape
 *  `packages/shared/src/worker-result.ts`'s `proposedSkill` field uses directly: a Worker's
 *  `report_result` tool call and a human's `propose_skill` capability call both produce exactly
 *  this shape (design doc §5.1.4 "Worker 结束时可 propose_skill"). */
export const ProposeSkillContentSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    markdown: z.string().min(1),
    applicable: SkillApplicableSchema.optional(),
  })
  .strict();
export type ProposeSkillContent = z.infer<typeof ProposeSkillContentSchema>;

/** Publish-time `name` — pi's own Agent Skills name rule, replicated (this module's doc comment).
 *  Deliberately stricter than `ProposeSkillContentSchema.name` (which accepts any non-empty
 *  string) — a draft may be renamed before publish; a published Skill's mount directory name and
 *  frontmatter `name` must actually be valid per pi's spec, or pi silently skips loading it. */
export const PublishedSkillNameSchema = z
  .string()
  .min(1)
  .max(SKILL_NAME_MAX_LENGTH)
  .regex(
    SKILL_NAME_PATTERN,
    'must be 1-64 lowercase letters/digits with single hyphens, no leading/trailing/consecutive hyphens (pi Agent Skills name rule)',
  );

/** Publish-time `description` — pi's own Agent Skills description rule (non-empty, ≤1024 chars). */
export const PublishedSkillDescriptionSchema = z.string().min(1).max(SKILL_DESCRIPTION_MAX_LENGTH);
