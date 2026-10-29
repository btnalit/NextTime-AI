import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Operation, Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { NotProposerError } from '../../governance/capability/index.js';
import { registerGatekeeper } from '../../governance/gatekeepers/index.js';
import { queryAudit } from '../../substrate/audit/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/publish-authority.integration.test: DB-gated (auto-skip without
 * DATABASE_URL) dispatch-level coverage of review 2026-10-02 decision D-24 — every meta-ontology
 * `publish_*` / `deprecate_*` is `minRole: 'builder'`, and only the row's proposer or the workspace
 * owner may act on it. One publish path (`publish_skill` on a draft, which builders and the owner
 * can see — another builder's attempt is 403 `not_proposer`) and one deprecate path
 * (`deprecate_operation`, a published row everyone sees: 403 `not_proposer`), each at member /
 * another builder / the proposer / the owner.
 *
 * Plus the version half: propose stays permissive (a new version may be added to anyone's family),
 * but publishing a version that would supersede a live version someone else proposed needs that
 * proposer or the owner — a Skill family (the version is added through the service, since
 * `propose_skill`'s params carry no family id) and a WorkerDefinition family (end to end:
 * `propose_worker_definition{definitionId}` does accept one).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function testOperation(name: string): Operation {
  return {
    name,
    description: 'A test operation.',
    binding: { kind: 'http', method: 'GET', path: '/stock' },
    params_schema: {},
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: [],
    writes: [],
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'D-24 publish / deprecate authority (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let builderId: string;
    let otherBuilderId: string;
    let memberId: string;
    let gatekeeperId: string;

    function humanCaller(principalId: string, role: Role): ResolvedCaller {
      return {
        channel: 'human',
        principal: { workspaceId, id: principalId, kind: 'human', role, displayName: null },
        session: {
          workspaceId,
          id: randomUUID(),
          principalId,
          kind: 'web',
          onBehalfOf: principalId,
          status: 'active',
          createdAt: new Date(),
          expiresAt: null,
        },
      };
    }

    function call<T>(
      principalId: string,
      role: Role,
      name: string,
      params: Record<string, unknown>,
    ): Promise<T> {
      return dispatchCapability(
        { pool },
        humanCaller(principalId, role),
        name,
        params,
      ) as Promise<T>;
    }

    async function insertPrincipal(role: Role, name: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        (client) =>
          client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', $3, $4)`,
            [workspaceId, id, role, name],
          ),
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function proposeSkill(): Promise<{ skillId: string; draftDigest: string }> {
      const proposed = await call<{ id: string; draftDigest: string }>(
        builderId,
        'builder',
        'propose_skill',
        {
          skill: {
            name: `d24-skill-${randomUUID().slice(0, 8)}`,
            description: 'A skill used by the D-24 authority test.',
            markdown: '# Steps\n\nDo the thing.',
          },
        },
      );
      return { skillId: proposed.id, draftDigest: proposed.draftDigest };
    }

    /** An Operation `builderId` proposed and published (its own draft — allowed). */
    async function publishedOperationOfBuilder(): Promise<string> {
      const name = `d24.op.${randomUUID().slice(0, 8)}`;
      const { draftDigest } = await call<{ draftDigest: string }>(
        builderId,
        'builder',
        'propose_operation',
        { gatekeeperId, operation: testOperation(name) },
      );
      await call(builderId, 'builder', 'publish_operation', { gatekeeperId, name, draftDigest });
      return name;
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: randomUUID() },
        (client) =>
          client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'd24-publish-authority',
          ]),
        { skipRoleSwitch: true },
      );
      ownerId = await insertPrincipal('owner', 'owner');
      builderId = await insertPrincipal('builder', 'builder');
      otherBuilderId = await insertPrincipal('builder', 'other-builder');
      memberId = await insertPrincipal('member', 'member');
      gatekeeperId = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const activity = await startActivity(client, workspaceId, {
            kind: 'test.register_gatekeeper',
            principalId: ownerId,
          });
          const registered = await registerGatekeeper(client, workspaceId, {
            name: `d24-gate-${randomUUID().slice(0, 8)}`,
            transportKind: 'http',
            target: 'd24-test-system',
            endpoint: `https://gate-${randomUUID()}.d24-test.invalid`,
            activityId: activity.id,
            registeredBy: { id: ownerId, kind: 'human' },
          });
          return registered.gatekeeperId;
        },
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    describe('publish_skill', () => {
      it('member: refused by the builder floor (403 forbidden)', async () => {
        const { skillId, draftDigest } = await proposeSkill();
        await expect(
          call(memberId, 'member', 'publish_skill', { skillId, version: 1, draftDigest }),
        ).rejects.toBeInstanceOf(ForbiddenError);
      });

      it('another builder: sees the draft (D-26 reviewer rule) but it is not theirs — 403 not_proposer', async () => {
        const { skillId, draftDigest } = await proposeSkill();
        await expect(
          call(otherBuilderId, 'builder', 'publish_skill', { skillId, version: 1, draftDigest }),
        ).rejects.toBeInstanceOf(NotProposerError);
        // Nothing was published by the refused call.
        const asProposer = await call<{ status: string } | null>(
          builderId,
          'builder',
          'get_skill',
          {
            skillId,
          },
        );
        expect(asProposer?.status).toBe('draft');
      });

      it('the proposer publishes their own draft', async () => {
        const { skillId, draftDigest } = await proposeSkill();
        const published = await call<{ status: string }>(builderId, 'builder', 'publish_skill', {
          skillId,
          version: 1,
          draftDigest,
        });
        expect(published.status).toBe('published');
      });

      it('the owner publishes a builder’s draft', async () => {
        const { skillId, draftDigest } = await proposeSkill();
        const published = await call<{ status: string }>(ownerId, 'owner', 'publish_skill', {
          skillId,
          version: 1,
          draftDigest,
        });
        expect(published.status).toBe('published');
      });
    });

    describe('deprecate_operation', () => {
      it('member: refused by the builder floor (403 forbidden)', async () => {
        const name = await publishedOperationOfBuilder();
        await expect(
          call(memberId, 'member', 'deprecate_operation', { gatekeeperId, name }),
        ).rejects.toBeInstanceOf(ForbiddenError);
      });

      it('another builder: 403 not_proposer, and the Operation stays published', async () => {
        const name = await publishedOperationOfBuilder();
        await expect(
          call(otherBuilderId, 'builder', 'deprecate_operation', { gatekeeperId, name }),
        ).rejects.toBeInstanceOf(NotProposerError);
        const listed = await call<{ items: readonly { name: string; status: string }[] }>(
          ownerId,
          'owner',
          'list_operations',
          { gatekeeperId },
        );
        expect(listed.items.find((op) => op.name === name)?.status).toBe('published');
      });

      it('the proposer deprecates their own Operation', async () => {
        const name = await publishedOperationOfBuilder();
        const deprecated = await call<{ status: string }>(
          builderId,
          'builder',
          'deprecate_operation',
          { gatekeeperId, name },
        );
        expect(deprecated.status).toBe('deprecated');
      });

      it('the owner deprecates a builder’s Operation', async () => {
        const name = await publishedOperationOfBuilder();
        const deprecated = await call<{ status: string }>(ownerId, 'owner', 'deprecate_operation', {
          gatekeeperId,
          name,
        });
        expect(deprecated.status).toBe('deprecated');
      });

      it('another builder cannot publish a builder’s Operation draft either (403 not_proposer)', async () => {
        const name = `d24.op.${randomUUID().slice(0, 8)}`;
        const { draftDigest } = await call<{ draftDigest: string }>(
          builderId,
          'builder',
          'propose_operation',
          { gatekeeperId, operation: testOperation(name) },
        );
        await expect(
          call(otherBuilderId, 'builder', 'publish_operation', { gatekeeperId, name, draftDigest }),
        ).rejects.toBeInstanceOf(NotProposerError);
      });

      it('a builder’s own revision of an Operation the owner published needs the owner to publish it', async () => {
        const name = `d24.op.${randomUUID().slice(0, 8)}`;
        const first = await call<{ draftDigest: string }>(ownerId, 'owner', 'propose_operation', {
          gatekeeperId,
          operation: testOperation(name),
        });
        await call(ownerId, 'owner', 'publish_operation', {
          gatekeeperId,
          name,
          draftDigest: first.draftDigest,
        });
        // The builder's revision loosens nothing here, but publishing it would deprecate the
        // owner's row — deprecate authority over that row is required too.
        const { draftDigest } = await call<{ draftDigest: string }>(
          builderId,
          'builder',
          'propose_operation',
          {
            gatekeeperId,
            operation: { ...testOperation(name), description: 'A revised description.' },
          },
        );
        await expect(
          call(builderId, 'builder', 'publish_operation', { gatekeeperId, name, draftDigest }),
        ).rejects.toBeInstanceOf(NotProposerError);
        const published = await call<{ status: string; version: number }>(
          ownerId,
          'owner',
          'publish_operation',
          { gatekeeperId, name, draftDigest },
        );
        expect(published.status).toBe('published');
        expect(published.version).toBe(2);
      });
    });

    describe('discard_operation_draft (legacy 278)', () => {
      /** The draft's `draftDigest`, as the catalog lists it (review #493 on #583). */
      async function listedDigest(name: string): Promise<string> {
        const listed = await call<{
          items: readonly { name: string; status: string; draftDigest?: string }[];
        }>(ownerId, 'owner', 'list_operations', { gatekeeperId });
        const digest = listed.items.find(
          (op) => op.name === name && op.status === 'draft',
        )?.draftDigest;
        if (digest === undefined) throw new Error(`expected ${name} listed with a draftDigest`);
        return digest;
      }
      async function draftOfBuilder(): Promise<{
        name: string;
        version: number;
        draftDigest: string;
      }> {
        const name = `d24.discard.${randomUUID().slice(0, 8)}`;
        const proposed = await call<{ version: number }>(
          builderId,
          'builder',
          'propose_operation',
          {
            gatekeeperId,
            operation: testOperation(name),
          },
        );
        return { name, version: proposed.version, draftDigest: await listedDigest(name) };
      }
      const listedNames = async () =>
        (
          await call<{ items: readonly { name: string }[] }>(ownerId, 'owner', 'list_operations', {
            gatekeeperId,
          })
        ).items.map((op) => op.name);

      it('member: refused by the builder floor (403 forbidden)', async () => {
        const draft = await draftOfBuilder();
        await expect(
          call(memberId, 'member', 'discard_operation_draft', { gatekeeperId, ...draft }),
        ).rejects.toBeInstanceOf(ForbiddenError);
      });

      it('another builder: sees the draft but it is not theirs — 403 not_proposer, and it stays listed', async () => {
        const draft = await draftOfBuilder();
        await expect(
          call(otherBuilderId, 'builder', 'discard_operation_draft', { gatekeeperId, ...draft }),
        ).rejects.toBeInstanceOf(NotProposerError);
        expect(await listedNames()).toContain(draft.name);
      });

      it('the proposer discards their own draft: it leaves the catalog, and the audit record says what was discarded and why', async () => {
        const draft = await draftOfBuilder();
        const discarded = await call<{ status: string; version: number }>(
          builderId,
          'builder',
          'discard_operation_draft',
          { gatekeeperId, ...draft, reason: 'The gate no longer offers it.' },
        );
        expect(discarded).toMatchObject({ status: 'discarded', version: draft.version });
        expect(await listedNames()).not.toContain(draft.name);
        const audited = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          queryAudit(client, workspaceId, { action: 'discard_operation_draft' }),
        );
        const row = audited.find(
          (entry) => (entry.payload as { params?: { name?: string } }).params?.name === draft.name,
        );
        expect(row?.actorPrincipalId).toBe(builderId);
        expect(row?.payload).toMatchObject({
          params: { gatekeeperId, name: draft.name, reason: 'The gate no longer offers it.' },
          // propose_operation over the human channel records a person's proposal.
          origin: 'human',
          proposedBy: { id: builderId },
          definitionDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        });
        // Never the definition itself.
        expect(JSON.stringify(row?.payload)).not.toContain('binding');
      });

      it('the owner discards a builder’s draft', async () => {
        const draft = await draftOfBuilder();
        const discarded = await call<{ status: string }>(
          ownerId,
          'owner',
          'discard_operation_draft',
          { gatekeeperId, ...draft },
        );
        expect(discarded.status).toBe('discarded');
      });

      it('a published Operation is refused (409 illegal transition): it is deprecated, not discarded', async () => {
        const name = await publishedOperationOfBuilder();
        await expect(
          call(builderId, 'builder', 'discard_operation_draft', {
            gatekeeperId,
            name,
            version: 1,
            draftDigest: 'sha256:any',
          }),
        ).rejects.toMatchObject({ name: 'IllegalTransition' });
      });

      it('review #493 on #583: a draft its proposer revised in place since it was listed is refused draft_changed and stays listed', async () => {
        const draft = await draftOfBuilder();
        await call(builderId, 'builder', 'propose_operation', {
          gatekeeperId,
          operation: { ...testOperation(draft.name), description: 'Revised after it was listed.' },
        });
        await expect(
          call(ownerId, 'owner', 'discard_operation_draft', { gatekeeperId, ...draft }),
        ).rejects.toMatchObject({ code: 'draft_changed' });
        expect(await listedNames()).toContain(draft.name);
        const fresh = await listedDigest(draft.name);
        expect(fresh).not.toBe(draft.draftDigest);
        await expect(
          call(ownerId, 'owner', 'publish_operation', {
            gatekeeperId,
            name: draft.name,
            draftDigest: draft.draftDigest,
          }),
        ).rejects.toMatchObject({ code: 'draft_changed' });
        const discarded = await call<{ status: string }>(
          ownerId,
          'owner',
          'discard_operation_draft',
          { gatekeeperId, ...draft, draftDigest: fresh },
        );
        expect(discarded.status).toBe('discarded');
      });
    });

    describe('a new version in someone else’s family', () => {
      // S11 W1a E2-0: the next version goes through `propose_skill{skillId}` /
      // `propose_procedure{procedureId}`, which keeps a Skill's name and waits for a pending draft.
      async function publishedSkillOfBuilder(): Promise<{ skillId: string; name: string }> {
        const name = `d24-skill-${randomUUID().slice(0, 8)}`;
        const v1 = await call<{ id: string; draftDigest: string }>(
          builderId,
          'builder',
          'propose_skill',
          { skill: { name, description: 'v1 by the family’s proposer.', markdown: '# v1' } },
        );
        await call(builderId, 'builder', 'publish_skill', {
          skillId: v1.id,
          version: 1,
          draftDigest: v1.draftDigest,
        });
        return { skillId: v1.id, name };
      }

      it('Skill: another builder may propose a version, may not publish it; the owner may', async () => {
        const { skillId, name } = await publishedSkillOfBuilder();

        const v2 = await call<{ version: number; draftDigest: string }>(
          otherBuilderId,
          'builder',
          'propose_skill',
          {
            skill: {
              name,
              description: 'Another builder’s version.',
              markdown: '# Do it differently',
            },
            skillId,
          },
        );
        expect(v2.version).toBe(2);
        const { draftDigest } = v2;
        await expect(
          call(otherBuilderId, 'builder', 'publish_skill', { skillId, version: 2, draftDigest }),
        ).rejects.toBeInstanceOf(NotProposerError);

        const published = await call<{ status: string; version: number }>(
          ownerId,
          'owner',
          'publish_skill',
          { skillId, version: 2, draftDigest },
        );
        expect(published).toMatchObject({ status: 'published', version: 2 });
      });

      it('legacy 300: Skill — the owner reviewed v2; published and followed by a v3 draft since, v3 is not published in its place (409 version_changed)', async () => {
        const { skillId, name } = await publishedSkillOfBuilder();
        const proposeVersion = (markdown: string) =>
          call<{ version: number; draftDigest: string }>(builderId, 'builder', 'propose_skill', {
            skill: { name, description: 'The family’s next version.', markdown },
            skillId,
          });
        const v2 = await proposeVersion('# v2\n\nWhat the owner reviewed.');
        expect(v2.version).toBe(2);
        // While v2 is a draft no other version can be proposed on top of it.
        await expect(proposeVersion('# v3\n\nToo early.')).rejects.toMatchObject({
          code: 'draft_pending',
          draftVersion: 2,
        });
        // Its proposer publishes v2 and proposes v3 while the owner still looks at v2.
        await call(builderId, 'builder', 'publish_skill', {
          skillId,
          version: 2,
          draftDigest: v2.draftDigest,
        });
        const v3 = await proposeVersion('# v3\n\nNobody reviewed this.');
        expect(v3.version).toBe(3);

        await expect(
          call(ownerId, 'owner', 'publish_skill', {
            skillId,
            version: 2,
            draftDigest: v2.draftDigest,
          }),
        ).rejects.toMatchObject({ code: 'version_changed', reviewedVersion: 2, currentVersion: 3 });
        // Nothing was published: the family's latest is still the v3 draft.
        const latest = await call<{ status: string; version: number } | null>(
          ownerId,
          'owner',
          'get_skill',
          { skillId },
        );
        expect(latest).toMatchObject({ status: 'draft', version: 3 });

        const published = await call<{ status: string; version: number }>(
          ownerId,
          'owner',
          'publish_skill',
          { skillId, version: 3, draftDigest: v3.draftDigest },
        );
        expect(published).toMatchObject({ status: 'published', version: 3 });
      });

      it('review #493 on #764 (F1): Skill — the owner reviewed v2; discarded and proposed again as v2 since, the new content is not published in its place (409 draft_changed)', async () => {
        const { skillId, name } = await publishedSkillOfBuilder();
        const proposeVersion = (markdown: string) =>
          call<{ version: number; draftDigest: string }>(builderId, 'builder', 'propose_skill', {
            skill: { name, description: 'The family’s next version.', markdown },
            skillId,
          });
        const reviewed = await proposeVersion('# REVIEWED');
        const shown = await call<{ markdown: string; draftDigest: string }>(
          ownerId,
          'owner',
          'get_skill',
          { skillId },
        );
        expect(shown).toMatchObject({ markdown: '# REVIEWED', draftDigest: reviewed.draftDigest });

        // The proposer discards v2 and proposes another v2 while the owner still looks at the first.
        await call(builderId, 'builder', 'discard_draft', {
          kind: 'skill',
          id: skillId,
          version: 2,
        });
        const swapped = await proposeVersion('# SWAPPED');
        expect(swapped.version).toBe(2);
        expect(swapped.draftDigest).not.toBe(reviewed.draftDigest);

        await expect(
          call(ownerId, 'owner', 'publish_skill', {
            skillId,
            version: 2,
            draftDigest: reviewed.draftDigest,
          }),
        ).rejects.toMatchObject({ code: 'draft_changed' });
        // Nothing was published: v2 is still the swapped draft.
        const latest = await call<{ status: string; version: number; markdown: string } | null>(
          ownerId,
          'owner',
          'get_skill',
          { skillId },
        );
        expect(latest).toMatchObject({ status: 'draft', version: 2, markdown: '# SWAPPED' });

        // Reviewed as it is now, it publishes.
        const published = await call<{ status: string; version: number }>(
          ownerId,
          'owner',
          'publish_skill',
          { skillId, version: 2, draftDigest: swapped.draftDigest },
        );
        expect(published).toMatchObject({ status: 'published', version: 2 });
      });

      it('legacy 300: Procedure — the same binding on publish_procedure', async () => {
        const procedure = (description: string) => ({
          name: 'd24-proc',
          description,
          steps: [{ kind: 'approval', description: 'A human approves.' }],
        });
        const v1 = await call<{ id: string; version: number; draftDigest: string }>(
          builderId,
          'builder',
          'propose_procedure',
          { procedure: procedure('v1') },
        );
        await call(builderId, 'builder', 'publish_procedure', {
          procedureId: v1.id,
          version: 1,
          draftDigest: v1.draftDigest,
        });
        const proposeVersion = (description: string) =>
          call<{ version: number; draftDigest: string }>(
            builderId,
            'builder',
            'propose_procedure',
            {
              procedure: procedure(description),
              procedureId: v1.id,
            },
          );
        const v2 = await proposeVersion('v2 — what the owner reviewed');
        expect(v2.version).toBe(2);
        await call(builderId, 'builder', 'publish_procedure', {
          procedureId: v1.id,
          version: 2,
          draftDigest: v2.draftDigest,
        });
        expect((await proposeVersion('v3 — proposed after the owner looked at v2')).version).toBe(
          3,
        );
        await expect(
          call(ownerId, 'owner', 'publish_procedure', {
            procedureId: v1.id,
            version: 2,
            draftDigest: v2.draftDigest,
          }),
        ).rejects.toMatchObject({ code: 'version_changed', reviewedVersion: 2, currentVersion: 3 });
      });

      it('review #493 on #764 (F1): Procedure — a draft discarded and proposed again under the same version is not published for the one reviewed (409 draft_changed)', async () => {
        const procedure = (description: string) => ({
          name: 'd24-proc',
          description,
          steps: [{ kind: 'approval', description: 'A human approves.' }],
        });
        const v1 = await call<{ id: string; draftDigest: string }>(
          builderId,
          'builder',
          'propose_procedure',
          { procedure: procedure('v1') },
        );
        await call(builderId, 'builder', 'publish_procedure', {
          procedureId: v1.id,
          version: 1,
          draftDigest: v1.draftDigest,
        });
        const proposeVersion = (description: string) =>
          call<{ version: number; draftDigest: string }>(
            builderId,
            'builder',
            'propose_procedure',
            {
              procedure: procedure(description),
              procedureId: v1.id,
            },
          );
        const reviewed = await proposeVersion('REVIEWED');
        const listed = await call<{
          items: readonly { id: string; version: number; draftDigest?: string }[];
        }>(ownerId, 'owner', 'list_procedures', {});
        expect(listed.items.find((item) => item.id === v1.id)).toMatchObject({
          version: 2,
          draftDigest: reviewed.draftDigest,
        });
        await call(builderId, 'builder', 'discard_draft', {
          kind: 'procedure',
          id: v1.id,
          version: 2,
        });
        const swapped = await proposeVersion('SWAPPED');
        expect(swapped.version).toBe(2);

        await expect(
          call(ownerId, 'owner', 'publish_procedure', {
            procedureId: v1.id,
            version: 2,
            draftDigest: reviewed.draftDigest,
          }),
        ).rejects.toMatchObject({ code: 'draft_changed' });
        const [row] = (
          await call<{ items: readonly { id: string; status: string; description: string }[] }>(
            ownerId,
            'owner',
            'list_procedures',
            {},
          )
        ).items.filter((item) => item.id === v1.id);
        expect(row).toMatchObject({ status: 'draft', description: 'SWAPPED' });
      });

      it('WorkerDefinition: propose_worker_definition{definitionId} is allowed, publishing it is not; the owner may', async () => {
        const v1 = await call<{ id: string; version: number }>(
          builderId,
          'builder',
          'propose_worker_definition',
          { kind: 'worker', definition: { systemPrompt: 'v1 by the family’s proposer' } },
        );
        await call(builderId, 'builder', 'publish_worker_definition', {
          definitionId: v1.id,
          version: v1.version,
        });

        const v2 = await call<{ id: string; version: number }>(
          otherBuilderId,
          'builder',
          'propose_worker_definition',
          {
            definitionId: v1.id,
            kind: 'worker',
            definition: { systemPrompt: 'v2 by another builder' },
          },
        );
        expect(v2.version).toBe(2);
        await expect(
          call(otherBuilderId, 'builder', 'publish_worker_definition', {
            definitionId: v2.id,
            version: v2.version,
          }),
        ).rejects.toBeInstanceOf(NotProposerError);

        const published = await call<{ status: string }>(
          ownerId,
          'owner',
          'publish_worker_definition',
          { definitionId: v2.id, version: v2.version },
        );
        expect(published.status).toBe('published');
      });
    });
  },
);
