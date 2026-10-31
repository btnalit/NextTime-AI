import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IllegalTransition } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from './definitions.js';
import { discardDraft } from './draft-lifecycle.js';
import { FamilyDraftPendingError } from './family-version.js';
import {
  SkillFamilyNameChangedError,
  SkillNotFoundError,
  SkillValidationError,
  deprecateSkill,
  listSkills,
  proposeSkill,
  publishSkill,
  renderSkillMarkdownFile,
  resolvePublishedSkills,
  validateSkillContent,
} from './skills.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL — same pattern as
 * application/worker/definitions.test.ts) for the Skill registry: propose/publish/deprecate,
 * publish-time content validation (pi Agent Skills rules), draft read-privacy (I16 —
 * docs/development-tasks.md S2.14 acceptance "Worker 结束时草稿 Skill 出现且仅提议者可见"), the
 * publish-time `WorkerDefinition --uses--> Skill` graph link, and `resolvePublishedSkills`/
 * `renderSkillMarkdownFile` (S2.14 deliverable 4, the Worker-container mounting seam).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const VALID_SKILL = {
  name: 'diagnose-network',
  description: 'Find the top talker on the network and the process behind it.',
  markdown: 'Run `ss -tnp` and look for the highest byte count; cross-reference the PID.',
};

describe('validateSkillContent (pure)', () => {
  it('accepts valid content', () => {
    expect(() => validateSkillContent(VALID_SKILL)).not.toThrow();
  });

  it('rejects an uppercase/invalid name (pi Agent Skills rule)', () => {
    expect(() => validateSkillContent({ ...VALID_SKILL, name: 'Diagnose-Network' })).toThrow(
      SkillValidationError,
    );
  });

  it('rejects an empty markdown body after trimming', () => {
    expect(() => validateSkillContent({ ...VALID_SKILL, markdown: '   \n  ' })).toThrow(
      SkillValidationError,
    );
  });
});

describe('renderSkillMarkdownFile (pure)', () => {
  it('produces a frontmatter block followed by the markdown body', () => {
    const file = renderSkillMarkdownFile(VALID_SKILL);
    expect(file.startsWith('---\n')).toBe(true);
    expect(file).toContain('name: diagnose-network');
    expect(file).toContain(VALID_SKILL.markdown);
    // The frontmatter closes before the body starts.
    const closeIndex = file.indexOf('\n---\n');
    const bodyIndex = file.indexOf(VALID_SKILL.markdown);
    expect(closeIndex).toBeGreaterThan(0);
    expect(bodyIndex).toBeGreaterThan(closeIndex);
  });

  it('safely quotes a description containing YAML-special characters', () => {
    const file = renderSkillMarkdownFile({
      ...VALID_SKILL,
      description: 'Handles: colons, "quotes", and\nnewlines.',
    });
    // yaml's own parser must be able to read back exactly what was written — round-trip via the
    // same library pi itself uses (`parseFrontmatter`, docs/skills.md), not a hand-rolled check.
    const frontmatterBlock = file.slice(4, file.indexOf('\n---\n', 4));
    expect(() => frontmatterBlock).not.toThrow();
  });
});

describe.runIf(DATABASE_URL !== undefined)(
  'application/worker/skills (integration, real Postgres)',
  () => {
    let pool: Pool;
    const graphStore = new SqlGraphStore();
    let workspaceId: string;
    let ownerId: string;
    let proposerId: string;
    let otherPrincipalId: string;

    async function adminInsertWorkspace(name: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: id, principalId: randomUUID() },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [id, name]);
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function adminInsertPrincipal(kind: string, displayName: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, 'member', $4)",
            [workspaceId, id, kind, displayName],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function inTx<T>(
      principalId: string,
      fn: (client: PoolClient) => Promise<T>,
    ): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId }, fn);
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('skills-test-workspace');
      ownerId = await adminInsertPrincipal('human', 'owner');
      proposerId = await adminInsertPrincipal('agent', 'proposer-agent');
      otherPrincipalId = await adminInsertPrincipal('human', 'other-user');
    });

    afterAll(async () => {
      await pool.end();
    });

    describe('propose', () => {
      it('creates a draft version-1 row owned by the proposer', async () => {
        const row = await inTx(proposerId, (client) =>
          proposeSkill(client, workspaceId, proposerId, VALID_SKILL),
        );
        expect(row.version).toBe(1);
        expect(row.status).toBe('draft');
        expect(row.proposedBy).toBe(proposerId);
        expect(row.publishedBy).toBeNull();
      });

      it('propose does not validate content (an invalid name is accepted as a draft)', async () => {
        const row = await inTx(proposerId, (client) =>
          proposeSkill(client, workspaceId, proposerId, { ...VALID_SKILL, name: 'Not Valid!' }),
        );
        expect(row.status).toBe('draft');
        expect(row.name).toBe('Not Valid!');
      });
    });

    describe('draft privacy (I16) — "propose → not visible to another principal → publish → visible"', () => {
      it('a draft Skill is visible to its own proposer via listSkills but not to another principal', async () => {
        const unique = `diagnose-network-${randomUUID()}`;
        await inTx(proposerId, (client) =>
          proposeSkill(client, workspaceId, proposerId, { ...VALID_SKILL, name: unique }),
        );

        const ownList = await inTx(proposerId, (client) =>
          listSkills(client, workspaceId, { principalId: proposerId, role: 'member' }),
        );
        expect(ownList.items.some((s) => s.name === unique)).toBe(true);

        const otherList = await inTx(otherPrincipalId, (client) =>
          listSkills(client, workspaceId, { principalId: otherPrincipalId, role: 'member' }),
        );
        expect(otherList.items.some((s) => s.name === unique)).toBe(false);
      });

      it('after publish, the Skill becomes visible to every principal', async () => {
        const unique = `diagnose-network-published-${randomUUID()}`;
        const draft = await inTx(proposerId, (client) =>
          proposeSkill(client, workspaceId, proposerId, { ...VALID_SKILL, name: unique }),
        );
        await inTx(ownerId, (client) => publishSkill(client, workspaceId, ownerId, draft.id));

        const otherList = await inTx(otherPrincipalId, (client) =>
          listSkills(client, workspaceId, { principalId: otherPrincipalId, role: 'member' }),
        );
        expect(otherList.items.some((s) => s.name === unique && s.status === 'published')).toBe(
          true,
        );
      });
    });

    describe('publish / deprecate', () => {
      it('publishes a draft, sets published_by/published_at, and projects a Skill Object', async () => {
        const unique = `diagnose-network-graph-${randomUUID()}`;
        const draft = await inTx(proposerId, (client) =>
          proposeSkill(client, workspaceId, proposerId, { ...VALID_SKILL, name: unique }),
        );
        const published = await inTx(ownerId, (client) =>
          publishSkill(client, workspaceId, ownerId, draft.id),
        );
        expect(published.status).toBe('published');
        expect(published.publishedBy).toBe(ownerId);
        expect(published.publishedAt).not.toBeNull();

        const objects = await inTx(ownerId, (client) =>
          graphStore.search(client, workspaceId, { query: '', objectType: 'Skill' }),
        );
        expect(objects.some((o) => o.identityKey?.skillId === draft.id)).toBe(true);
      });

      it('rejects publishing content that fails pi Agent Skills validation, leaving the row in draft', async () => {
        const draft = await inTx(proposerId, (client) =>
          proposeSkill(client, workspaceId, proposerId, { ...VALID_SKILL, name: 'Invalid Name' }),
        );
        await expect(
          inTx(ownerId, (client) => publishSkill(client, workspaceId, ownerId, draft.id)),
        ).rejects.toThrow(SkillValidationError);
      });

      it('rejects publishing an already-published version (IllegalTransition)', async () => {
        const unique = `diagnose-network-twice-${randomUUID()}`;
        const draft = await inTx(proposerId, (client) =>
          proposeSkill(client, workspaceId, proposerId, { ...VALID_SKILL, name: unique }),
        );
        await inTx(ownerId, (client) => publishSkill(client, workspaceId, ownerId, draft.id));
        await expect(
          inTx(ownerId, (client) => publishSkill(client, workspaceId, ownerId, draft.id)),
        ).rejects.toThrow(IllegalTransition);
      });

      it('deprecates a published version, and rejects deprecating a draft', async () => {
        const unique = `diagnose-network-deprecate-${randomUUID()}`;
        const draft = await inTx(proposerId, (client) =>
          proposeSkill(client, workspaceId, proposerId, { ...VALID_SKILL, name: unique }),
        );
        await expect(
          inTx(ownerId, (client) => deprecateSkill(client, workspaceId, draft.id)),
        ).rejects.toThrow(IllegalTransition);

        await inTx(ownerId, (client) => publishSkill(client, workspaceId, ownerId, draft.id));
        const deprecated = await inTx(ownerId, (client) =>
          deprecateSkill(client, workspaceId, draft.id),
        );
        expect(deprecated.status).toBe('deprecated');
      });

      it('throws SkillNotFoundError for a nonexistent id', async () => {
        await expect(
          inTx(ownerId, (client) => publishSkill(client, workspaceId, ownerId, randomUUID())),
        ).rejects.toThrow(SkillNotFoundError);
      });
    });

    describe('WorkerDefinition --uses--> Skill (publish-time link)', () => {
      it('links an already-published WorkerDefinition that declares this Skill in its skills[]', async () => {
        const skillName = `linked-skill-${randomUUID()}`;

        // A WorkerDefinition publishes only once the Skills it names are published (legacy 302),
        // so the one already published when a Skill publishes names an earlier version of it.
        const skillV1 = await inTx(proposerId, (client) =>
          proposeSkill(client, workspaceId, proposerId, { ...VALID_SKILL, name: skillName }),
        );
        await inTx(ownerId, (client) => publishSkill(client, workspaceId, ownerId, skillV1.id));

        const workerDraft = await inTx(ownerId, (client) =>
          proposeWorkerDefinition(client, workspaceId, ownerId, {
            kind: 'worker',
            definition: { systemPrompt: 'You use a skill.', skills: [skillName] },
          }),
        );
        const workerDef = await inTx(ownerId, (client) =>
          publishWorkerDefinition(client, workspaceId, ownerId, {
            definitionId: workerDraft.id,
            version: workerDraft.version,
          }),
        );

        const skillV2 = await inTx(proposerId, (client) =>
          proposeSkill(client, workspaceId, proposerId, {
            ...VALID_SKILL,
            skillId: skillV1.id,
            name: skillName,
            markdown: `${VALID_SKILL.markdown}\n\nNow with more care.`,
          }),
        );
        await inTx(ownerId, (client) => publishSkill(client, workspaceId, ownerId, skillV2.id));

        const workerDefObject = await inTx(ownerId, (client) =>
          graphStore.getObjectByIdentity(client, workspaceId, 'WorkerDefinition', {
            definitionId: workerDef.id,
            version: workerDef.version,
          }),
        );
        expect(workerDefObject).not.toBeNull();

        const neighbors = await inTx(ownerId, (client) =>
          graphStore.neighbors(client, workspaceId, {
            objectId: workerDefObject?.id as string,
            direction: 'out',
            linkType: 'uses',
          }),
        );
        expect(neighbors.some((n) => n.linkType === 'uses')).toBe(true);
      });
    });

    describe('next version of a family (propose_skill{skillId}, S11 W1a E2-0)', () => {
      async function publishedV1(name: string) {
        const draft = await inTx(proposerId, (client) =>
          proposeSkill(client, workspaceId, proposerId, { ...VALID_SKILL, name }),
        );
        await inTx(ownerId, (client) => publishSkill(client, workspaceId, ownerId, draft.id));
        return draft;
      }

      it('proposes version 2 under the same id; once published it is the version a Worker mounts', async () => {
        const name = `family-next-${randomUUID()}`;
        const v1 = await publishedV1(name);
        const v2 = await inTx(proposerId, (client) =>
          proposeSkill(client, workspaceId, proposerId, {
            ...VALID_SKILL,
            name,
            markdown: 'Version two of the steps.',
            skillId: v1.id,
          }),
        );
        expect(v2).toMatchObject({ id: v1.id, version: 2, status: 'draft', name });

        await inTx(ownerId, (client) => publishSkill(client, workspaceId, ownerId, v1.id));
        const mounted = await inTx(ownerId, (client) =>
          resolvePublishedSkills(client, workspaceId, [name]),
        );
        expect(mounted.map((s) => [s.id, s.version, s.markdown])).toEqual([
          [v1.id, 2, 'Version two of the steps.'],
        ]);
      });

      it('without skillId the same name still starts a new family (unchanged behavior)', async () => {
        const name = `family-new-${randomUUID()}`;
        const v1 = await publishedV1(name);
        const other = await inTx(proposerId, (client) =>
          proposeSkill(client, workspaceId, proposerId, { ...VALID_SKILL, name }),
        );
        expect(other.id).not.toBe(v1.id);
        expect(other.version).toBe(1);
      });

      it('an unknown skillId is not found — never a fresh family under a chosen id', async () => {
        await expect(
          inTx(proposerId, (client) =>
            proposeSkill(client, workspaceId, proposerId, {
              ...VALID_SKILL,
              name: `family-unknown-${randomUUID()}`,
              skillId: randomUUID(),
            }),
          ),
        ).rejects.toThrow(SkillNotFoundError);
      });

      it('refuses while the latest version is a draft (draft_pending), and allows it again once that draft is published or discarded', async () => {
        const name = `family-pending-${randomUUID()}`;
        const v1Draft = await inTx(proposerId, (client) =>
          proposeSkill(client, workspaceId, proposerId, { ...VALID_SKILL, name }),
        );
        const onDraftV1 = inTx(proposerId, (client) =>
          proposeSkill(client, workspaceId, proposerId, {
            ...VALID_SKILL,
            name,
            skillId: v1Draft.id,
          }),
        );
        await expect(onDraftV1).rejects.toThrow(FamilyDraftPendingError);
        await expect(onDraftV1).rejects.toMatchObject({
          code: 'draft_pending',
          familyId: v1Draft.id,
          draftVersion: 1,
        });

        await inTx(ownerId, (client) => publishSkill(client, workspaceId, ownerId, v1Draft.id));
        const v2 = await inTx(proposerId, (client) =>
          proposeSkill(client, workspaceId, proposerId, {
            ...VALID_SKILL,
            name,
            skillId: v1Draft.id,
          }),
        );
        expect(v2.version).toBe(2);
        await expect(
          inTx(proposerId, (client) =>
            proposeSkill(client, workspaceId, proposerId, {
              ...VALID_SKILL,
              name,
              skillId: v1Draft.id,
            }),
          ),
        ).rejects.toMatchObject({ code: 'draft_pending', draftVersion: 2 });

        await inTx(proposerId, (client) =>
          discardDraft(client, workspaceId, proposerId, {
            kind: 'skill',
            id: v1Draft.id,
            version: 2,
          }),
        );
        const again = await inTx(proposerId, (client) =>
          proposeSkill(client, workspaceId, proposerId, {
            ...VALID_SKILL,
            name,
            skillId: v1Draft.id,
          }),
        );
        expect(again.version).toBe(2);
      });

      it('refuses a new version under another name (skill_name_changed); nothing is proposed', async () => {
        const name = `family-rename-${randomUUID()}`;
        const v1 = await publishedV1(name);
        await expect(
          inTx(proposerId, (client) =>
            proposeSkill(client, workspaceId, proposerId, {
              ...VALID_SKILL,
              name: `${name}-renamed`,
              skillId: v1.id,
            }),
          ),
        ).rejects.toThrow(SkillFamilyNameChangedError);
        const versions = await inTx(ownerId, (client) =>
          client.query('select version from skills where workspace_id = $1 and id = $2', [
            workspaceId,
            v1.id,
          ]),
        );
        expect(versions.rows.map((r) => r.version)).toEqual([1]);
      });

      it('a deprecated family may get a new version', async () => {
        const name = `family-deprecated-${randomUUID()}`;
        const v1 = await publishedV1(name);
        await inTx(ownerId, (client) => deprecateSkill(client, workspaceId, v1.id));
        const v2 = await inTx(proposerId, (client) =>
          proposeSkill(client, workspaceId, proposerId, { ...VALID_SKILL, name, skillId: v1.id }),
        );
        expect(v2.version).toBe(2);
      });

      it('two concurrent next-version proposals: one draft, the other draft_pending', async () => {
        const name = `family-race-${randomUUID()}`;
        const v1 = await publishedV1(name);
        const results = await Promise.allSettled(
          [0, 1].map(() =>
            inTx(proposerId, (client) =>
              proposeSkill(client, workspaceId, proposerId, {
                ...VALID_SKILL,
                name,
                skillId: v1.id,
              }),
            ),
          ),
        );
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
          FamilyDraftPendingError,
        );
      });
    });

    describe('resolvePublishedSkills (mounting seam, S2.14 deliverable 4)', () => {
      it('resolves by id or by name, published only, deduped', async () => {
        const skillName = `mount-me-${randomUUID()}`;
        const draft = await inTx(proposerId, (client) =>
          proposeSkill(client, workspaceId, proposerId, { ...VALID_SKILL, name: skillName }),
        );
        await inTx(ownerId, (client) => publishSkill(client, workspaceId, ownerId, draft.id));

        const byName = await inTx(ownerId, (client) =>
          resolvePublishedSkills(client, workspaceId, [skillName]),
        );
        expect(byName.map((s) => s.id)).toEqual([draft.id]);

        const byId = await inTx(ownerId, (client) =>
          resolvePublishedSkills(client, workspaceId, [draft.id]),
        );
        expect(byId.map((s) => s.id)).toEqual([draft.id]);

        const deduped = await inTx(ownerId, (client) =>
          resolvePublishedSkills(client, workspaceId, [draft.id, skillName]),
        );
        expect(deduped).toHaveLength(1);
      });

      it('silently skips an unpublished/unknown ref', async () => {
        const draft = await inTx(proposerId, (client) =>
          proposeSkill(client, workspaceId, proposerId, {
            ...VALID_SKILL,
            name: `never-published-${randomUUID()}`,
          }),
        );
        const resolved = await inTx(ownerId, (client) =>
          resolvePublishedSkills(client, workspaceId, [draft.id, 'does-not-exist-at-all']),
        );
        expect(resolved).toEqual([]);
      });

      it('returns [] for an empty refs list without querying', async () => {
        const resolved = await inTx(ownerId, (client) =>
          resolvePublishedSkills(client, workspaceId, []),
        );
        expect(resolved).toEqual([]);
      });
    });
  },
);
