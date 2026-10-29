import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  DraftNotRejectableError,
  FamilyDraftPendingError,
  proposeSkill,
} from '../../application/worker/index.js';
import { NotProposerError, ReviewedDraftChangedError } from '../../governance/capability/index.js';
import { ForbiddenError } from './authorize.js';
import { InvalidCapabilityParamsError, dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/skill-procedure-draft-review.integration.test: DB-gated (auto-skip without
 * DATABASE_URL) regression for the wave-5 usability gap. A member's Worker proposes a Skill through
 * `report_task_result` — `postWorkerResult` calls `proposeSkill` with the member as proposer
 * (application/task/result.ts), which is how the draft is added here. Since D-24 the member cannot
 * publish it (builder floor), and before this fix the owner, who may, could not see it in
 * `list_skills`: Worker-proposed Skills had no review surface.
 *
 * The rule now (application/worker/draft-visibility.ts, D-26's reviewer rule): a Skill / Procedure
 * draft is visible to its proposer, to builders and to the owner, and to nobody else; D-24's
 * publish authority is unchanged — seeing is not publishing. Procedures are proposed by builders
 * (`propose_procedure` is builder-only), so that path is covered end to end through the
 * capability. The handle channel narrows for the Handle's `obo` with that principal's role.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

interface SkillItem {
  readonly id: string;
  readonly status: string;
  readonly proposedBy: string;
  /** A draft's, which a publish names (review #493 on #764, F1). */
  readonly draftDigest?: string;
}

interface ProcedureItem {
  readonly id: string;
  readonly status: string;
  readonly proposedBy: string;
  readonly draftDigest?: string;
}

describe.runIf(DATABASE_URL !== undefined)(
  'Skill / Procedure draft review by the owner and builders (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let builderId: string;
    let otherBuilderId: string;
    let memberId: string;
    let otherMemberId: string;

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

    /** An agent Handle acting for `obo` (I13) — the Handle carries no role of its own. */
    function handleCaller(obo: string): ResolvedCaller {
      const now = Math.floor(Date.now() / 1000);
      return {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid: randomUUID(),
          obo,
          scope: { capabilities: ['list_skills', 'get_skill', 'list_procedures'], resources: {} },
          jti: randomUUID(),
          iat: now,
          exp: now + 600,
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

    async function listedSkill(
      principalId: string,
      role: Role,
      skillId: string,
    ): Promise<SkillItem | undefined> {
      const page = await call<{ items: readonly SkillItem[] }>(principalId, role, 'list_skills', {
        limit: 500,
      });
      return page.items.find((item) => item.id === skillId);
    }

    async function listedProcedure(
      principalId: string,
      role: Role,
      procedureId: string,
    ): Promise<ProcedureItem | undefined> {
      const page = await call<{ items: readonly ProcedureItem[] }>(
        principalId,
        role,
        'list_procedures',
        { limit: 500 },
      );
      return page.items.find((item) => item.id === procedureId);
    }

    /** The draft digest a reviewer sees on the listed draft — what a publish then names. */
    async function reviewedSkillDigest(
      principalId: string,
      role: Role,
      skillId: string,
    ): Promise<string> {
      const digest = (await listedSkill(principalId, role, skillId))?.draftDigest;
      if (digest === undefined) throw new Error(`fixture: ${skillId} is not a draft ${role} sees`);
      return digest;
    }

    async function reviewedProcedureDigest(
      principalId: string,
      role: Role,
      procedureId: string,
    ): Promise<string> {
      const digest = (await listedProcedure(principalId, role, procedureId))?.draftDigest;
      if (digest === undefined) {
        throw new Error(`fixture: ${procedureId} is not a draft ${role} sees`);
      }
      return digest;
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

    /** A draft Skill owned by the member, added the way `report_task_result` adds a Worker's
     *  `proposedSkill` (`proposeSkill` with the Task's on-behalf-of principal). */
    async function workerProposedSkillOfMember(): Promise<string> {
      const draft = await withWorkspace(pool, { workspaceId, principalId: memberId }, (client) =>
        proposeSkill(client, workspaceId, memberId, {
          name: `worker-skill-${randomUUID().slice(0, 8)}`,
          description: 'A reusable trick a member’s Worker found.',
          markdown: '# Steps\n\nDo the thing.',
        }),
      );
      expect(draft).toMatchObject({ status: 'draft', proposedBy: memberId });
      return draft.id;
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
            'skill-procedure-draft-review',
          ]),
        { skipRoleSwitch: true },
      );
      ownerId = await insertPrincipal('owner', 'owner');
      builderId = await insertPrincipal('builder', 'builder');
      otherBuilderId = await insertPrincipal('builder', 'other-builder');
      memberId = await insertPrincipal('member', 'member');
      otherMemberId = await insertPrincipal('member', 'other-member');
    });

    afterAll(async () => {
      await pool.end();
    });

    describe('a member’s Worker-proposed Skill draft', () => {
      it('the owner finds it in list_skills, with its proposer, and can read it with get_skill', async () => {
        const skillId = await workerProposedSkillOfMember();

        expect(await listedSkill(ownerId, 'owner', skillId)).toMatchObject({
          status: 'draft',
          proposedBy: memberId,
        });
        const detail = await call<{ status: string; proposedBy: string } | null>(
          ownerId,
          'owner',
          'get_skill',
          { skillId },
        );
        expect(detail).toMatchObject({ status: 'draft', proposedBy: memberId });
      });

      it('the owner publishes it, and every member sees it published', async () => {
        const skillId = await workerProposedSkillOfMember();

        const published = await call<{ status: string }>(ownerId, 'owner', 'publish_skill', {
          skillId,
          version: 1,
          draftDigest: await reviewedSkillDigest(ownerId, 'owner', skillId),
        });
        expect(published.status).toBe('published');
        expect(await listedSkill(otherMemberId, 'member', skillId)).toMatchObject({
          status: 'published',
          proposedBy: memberId,
        });
      });

      it('another member does not see it — not listed, get_skill is null', async () => {
        const skillId = await workerProposedSkillOfMember();

        expect(await listedSkill(otherMemberId, 'member', skillId)).toBeUndefined();
        expect(await call<unknown>(otherMemberId, 'member', 'get_skill', { skillId })).toBeNull();
      });

      it('its proposer sees it but cannot publish it (builder floor, D-24 unchanged)', async () => {
        const skillId = await workerProposedSkillOfMember();

        expect(await listedSkill(memberId, 'member', skillId)).toMatchObject({ status: 'draft' });
        const draftDigest = await reviewedSkillDigest(memberId, 'member', skillId);
        await expect(
          call(memberId, 'member', 'publish_skill', { skillId, version: 1, draftDigest }),
        ).rejects.toBeInstanceOf(ForbiddenError);
      });

      it('a builder sees it but cannot publish it (403 not_proposer), and it stays a draft', async () => {
        const skillId = await workerProposedSkillOfMember();

        expect(await listedSkill(builderId, 'builder', skillId)).toMatchObject({
          status: 'draft',
          proposedBy: memberId,
        });
        const refusal = call(builderId, 'builder', 'publish_skill', {
          skillId,
          version: 1,
          draftDigest: await reviewedSkillDigest(builderId, 'builder', skillId),
        });
        await expect(refusal).rejects.toBeInstanceOf(NotProposerError);
        await expect(refusal).rejects.toMatchObject({ code: 'not_proposer' });
        expect(await listedSkill(ownerId, 'owner', skillId)).toMatchObject({ status: 'draft' });
      });

      it('handle channel: the owner’s agent sees it, another member’s agent does not', async () => {
        const skillId = await workerProposedSkillOfMember();

        const asOwnerAgent = (await dispatchCapability(
          { pool },
          handleCaller(ownerId),
          'list_skills',
          { limit: 500 },
        )) as { items: readonly SkillItem[] };
        expect(asOwnerAgent.items.find((item) => item.id === skillId)?.status).toBe('draft');

        const asOtherMemberAgent = (await dispatchCapability(
          { pool },
          handleCaller(otherMemberId),
          'list_skills',
          { limit: 500 },
        )) as { items: readonly SkillItem[] };
        expect(asOtherMemberAgent.items.some((item) => item.id === skillId)).toBe(false);
        expect(
          await dispatchCapability({ pool }, handleCaller(otherMemberId), 'get_skill', {
            skillId,
          }),
        ).toBeNull();
      });
    });

    describe('the next version of a family (propose_skill{skillId} / propose_procedure{procedureId}, S11 W1a E2-0)', () => {
      it('a builder proposes version 2 of a published Skill; while it is a draft another builder gets 409 draft_pending', async () => {
        const skill = {
          name: `family-skill-${randomUUID().slice(0, 8)}`,
          description: 'A Skill that gets a second version.',
          markdown: '# Steps\n\nVersion one.',
        };
        const v1 = await call<{ id: string; version: number; draftDigest: string }>(
          builderId,
          'builder',
          'propose_skill',
          {
            skill,
          },
        );
        await call(builderId, 'builder', 'publish_skill', {
          skillId: v1.id,
          version: 1,
          draftDigest: v1.draftDigest,
        });

        const v2 = await call<{ id: string; version: number; status: string }>(
          builderId,
          'builder',
          'propose_skill',
          { skill: { ...skill, markdown: '# Steps\n\nVersion two.' }, skillId: v1.id },
        );
        expect(v2).toMatchObject({ id: v1.id, version: 2, status: 'draft' });

        const refusal = call(otherBuilderId, 'builder', 'propose_skill', {
          skill,
          skillId: v1.id,
        });
        await expect(refusal).rejects.toBeInstanceOf(FamilyDraftPendingError);
        await expect(refusal).rejects.toMatchObject({
          code: 'draft_pending',
          familyId: v1.id,
          draftVersion: 2,
        });
      });

      it('UX acceptance of #764 (P2-1): the draft row names the version in use (inUse); get_skill{version} reads it; a member sees the published row', async () => {
        const skill = {
          name: `in-use-skill-${randomUUID().slice(0, 8)}`,
          description: 'Version one, in use.',
          markdown: '# One',
        };
        const v1 = await call<{ id: string; draftDigest: string }>(
          builderId,
          'builder',
          'propose_skill',
          { skill },
        );
        await call(builderId, 'builder', 'publish_skill', {
          skillId: v1.id,
          version: 1,
          draftDigest: v1.draftDigest,
        });
        // A published row names no other version.
        expect(await listedSkill(ownerId, 'owner', v1.id)).not.toHaveProperty('inUse');
        await call(builderId, 'builder', 'propose_skill', {
          skill: { ...skill, description: 'Version two, pending.', markdown: '# Two' },
          skillId: v1.id,
        });

        for (const [principalId, role] of [
          [ownerId, 'owner'],
          [otherBuilderId, 'builder'],
        ] as const) {
          expect(await listedSkill(principalId, role, v1.id)).toMatchObject({
            version: 2,
            status: 'draft',
            inUse: {
              id: v1.id,
              version: 1,
              status: 'published',
              description: 'Version one, in use.',
            },
          });
        }
        const inUse = await call<{ version: number; status: string; markdown: string } | null>(
          ownerId,
          'owner',
          'get_skill',
          { skillId: v1.id, version: 1 },
        );
        expect(inUse).toMatchObject({ version: 1, status: 'published', markdown: '# One' });
        expect(
          await call(ownerId, 'owner', 'get_skill', { skillId: v1.id, version: 3 }),
        ).toBeNull();

        const asMember = await listedSkill(memberId, 'member', v1.id);
        expect(asMember).toMatchObject({ version: 1, status: 'published' });
        expect(asMember).not.toHaveProperty('inUse');
        // A member may not read the draft by its version either.
        expect(
          await call(memberId, 'member', 'get_skill', { skillId: v1.id, version: 2 }),
        ).toBeNull();
      });

      it('UX acceptance of #764 (P2-1): a Procedure draft row names the version in use', async () => {
        const procedure = {
          name: `in-use-procedure-${randomUUID().slice(0, 8)}`,
          description: 'v1',
          steps: [{ kind: 'approval', description: 'A human approves the change.' }],
        };
        const v1 = await call<{ id: string; draftDigest: string }>(
          builderId,
          'builder',
          'propose_procedure',
          { procedure },
        );
        await call(builderId, 'builder', 'publish_procedure', {
          procedureId: v1.id,
          version: 1,
          draftDigest: v1.draftDigest,
        });
        await call(builderId, 'builder', 'propose_procedure', {
          procedure: { ...procedure, description: 'v2' },
          procedureId: v1.id,
        });
        expect(await listedProcedure(ownerId, 'owner', v1.id)).toMatchObject({
          version: 2,
          status: 'draft',
          inUse: { version: 1, status: 'published', description: 'v1', steps: procedure.steps },
        });
        expect(await listedProcedure(memberId, 'member', v1.id)).not.toHaveProperty('inUse');
      });

      it('a member’s Worker-proposed draft blocks a builder’s next version too — the builder sees that draft', async () => {
        const skillId = await workerProposedSkillOfMember();
        const detail = await call<{ name: string }>(builderId, 'builder', 'get_skill', { skillId });
        await expect(
          call(builderId, 'builder', 'propose_skill', {
            skill: { name: detail.name, description: 'Next.', markdown: 'Next.' },
            skillId,
          }),
        ).rejects.toMatchObject({ code: 'draft_pending', draftVersion: 1 });
      });

      it('a builder proposes version 2 of a published Procedure under procedureId', async () => {
        const procedure = {
          name: `family-procedure-${randomUUID().slice(0, 8)}`,
          description: 'Approve, then verify.',
          steps: [
            { kind: 'approval', description: 'A human approves the change.' },
            { kind: 'verify', description: 'Check the result.' },
          ],
        };
        const v1 = await call<{ id: string; draftDigest: string }>(
          builderId,
          'builder',
          'propose_procedure',
          { procedure },
        );
        await call(builderId, 'builder', 'publish_procedure', {
          procedureId: v1.id,
          version: 1,
          draftDigest: v1.draftDigest,
        });
        const v2 = await call<{ id: string; version: number }>(
          builderId,
          'builder',
          'propose_procedure',
          { procedure, procedureId: v1.id },
        );
        expect(v2).toMatchObject({ id: v1.id, version: 2 });
      });
    });

    describe('a builder’s Procedure draft (propose_procedure)', () => {
      async function builderProposedProcedure(): Promise<string> {
        const proposed = await call<{ id: string; status: string }>(
          builderId,
          'builder',
          'propose_procedure',
          {
            procedure: {
              name: `review-procedure-${randomUUID().slice(0, 8)}`,
              description: 'Approve, then verify.',
              steps: [
                { kind: 'approval', description: 'A human approves the change.' },
                { kind: 'verify', description: 'Check the result.' },
              ],
            },
          },
        );
        expect(proposed.status).toBe('draft');
        return proposed.id;
      }

      it('the owner sees it with its proposer and publishes it', async () => {
        const procedureId = await builderProposedProcedure();

        expect(await listedProcedure(ownerId, 'owner', procedureId)).toMatchObject({
          status: 'draft',
          proposedBy: builderId,
        });
        const published = await call<{ status: string }>(ownerId, 'owner', 'publish_procedure', {
          procedureId,
          version: 1,
          draftDigest: await reviewedProcedureDigest(ownerId, 'owner', procedureId),
        });
        expect(published.status).toBe('published');
        expect(await listedProcedure(memberId, 'member', procedureId)).toMatchObject({
          status: 'published',
        });
      });

      it('a member does not see it', async () => {
        const procedureId = await builderProposedProcedure();

        expect(await listedProcedure(memberId, 'member', procedureId)).toBeUndefined();
        const asMemberAgent = (await dispatchCapability(
          { pool },
          handleCaller(memberId),
          'list_procedures',
          { limit: 500 },
        )) as { items: readonly ProcedureItem[] };
        expect(asMemberAgent.items.some((item) => item.id === procedureId)).toBe(false);
      });

      it('another builder sees it but cannot publish it (403 not_proposer)', async () => {
        const procedureId = await builderProposedProcedure();

        expect(await listedProcedure(otherBuilderId, 'builder', procedureId)).toMatchObject({
          status: 'draft',
          proposedBy: builderId,
        });
        const draftDigest = await reviewedProcedureDigest(otherBuilderId, 'builder', procedureId);
        await expect(
          call(otherBuilderId, 'builder', 'publish_procedure', {
            procedureId,
            version: 1,
            draftDigest,
          }),
        ).rejects.toBeInstanceOf(NotProposerError);
        expect(await listedProcedure(builderId, 'builder', procedureId)).toMatchObject({
          status: 'draft',
        });
      });
    });

    // E2-0b (review #493 on #764, F2): the reviewer's transition beside discard_draft.
    describe('reject_draft: the owner or the proposer of the version in use takes a pending draft off its family', () => {
      /** v1 published by `builderId`, then v2 proposed by `otherBuilderId` — the pending draft. */
      async function skillWithPendingDraft(): Promise<{
        skillId: string;
        name: string;
        draftDigest: string;
      }> {
        const skill = {
          name: `reject-skill-${randomUUID().slice(0, 8)}`,
          description: 'Version one.',
          markdown: '# One',
        };
        const v1 = await call<{ id: string; draftDigest: string }>(
          builderId,
          'builder',
          'propose_skill',
          { skill },
        );
        await call(builderId, 'builder', 'publish_skill', {
          skillId: v1.id,
          version: 1,
          draftDigest: v1.draftDigest,
        });
        const v2 = await call<{ version: number; draftDigest: string }>(
          otherBuilderId,
          'builder',
          'propose_skill',
          { skill: { ...skill, markdown: '# Two' }, skillId: v1.id },
        );
        expect(v2.version).toBe(2);
        return { skillId: v1.id, name: skill.name, draftDigest: v2.draftDigest };
      }

      async function rejectAudits(id: string) {
        return withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
          const audit = await client.query<{
            actor_principal_id: string;
            resource_type: string;
            payload: {
              channel: string;
              params: { kind: string; version: number; draftDigest: string; reason: string };
              rejectedDraft: { proposedBy: string; inUseVersion: number | null };
            };
          }>(
            `select actor_principal_id, resource_type, payload from audit_records
             where workspace_id = $1 and action = 'reject_draft' and resource_id = $2`,
            [workspaceId, id],
          );
          return audit.rows;
        });
      }

      it('the proposer of the version in use rejects it with a reason: the draft is gone, v1 stays in use, the audit keeps who and why, and the next version can be proposed again', async () => {
        const { skillId, name, draftDigest } = await skillWithPendingDraft();

        const rejected = await call(builderId, 'builder', 'reject_draft', {
          kind: 'skill',
          id: skillId,
          version: 2,
          draftDigest,
          reason: 'Step two repeats step one.',
        });
        expect(rejected).toEqual({ kind: 'skill', id: skillId, version: 2 });
        const listed = await listedSkill(ownerId, 'owner', skillId);
        expect(listed).toMatchObject({ version: 1, status: 'published' });
        expect(listed).not.toHaveProperty('inUse');

        const audits = await rejectAudits(skillId);
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({
          actor_principal_id: builderId,
          resource_type: 'skill',
          payload: {
            channel: 'human',
            params: {
              kind: 'skill',
              version: 2,
              draftDigest,
              reason: 'Step two repeats step one.',
            },
            rejectedDraft: { proposedBy: otherBuilderId, inUseVersion: 1 },
          },
        });

        // draft_pending no longer holds.
        const again = await call<{ version: number }>(otherBuilderId, 'builder', 'propose_skill', {
          skill: {
            name,
            description: 'Version two again.',
            markdown: '# Two, fixed',
          },
          skillId,
        });
        expect(again.version).toBe(2);
      });

      it('the owner rejects it too', async () => {
        const { skillId, draftDigest } = await skillWithPendingDraft();
        await call(ownerId, 'owner', 'reject_draft', {
          kind: 'skill',
          id: skillId,
          version: 2,
          draftDigest,
          reason: 'Not wanted.',
        });
        expect(await listedSkill(ownerId, 'owner', skillId)).toMatchObject({ version: 1 });
      });

      it('the draft’s own proposer, a builder of no version in use, a member and an agent cannot reject it; nothing changes', async () => {
        const { skillId, draftDigest } = await skillWithPendingDraft();
        const params = { kind: 'skill', id: skillId, version: 2, draftDigest, reason: 'No.' };

        // The draft's proposer discards it instead (discard_draft).
        await expect(call(otherBuilderId, 'builder', 'reject_draft', params)).rejects.toThrow(
          /only the workspace owner or the proposer of the family's version in use \(v1\)/,
        );
        await expect(
          call(otherBuilderId, 'builder', 'reject_draft', params),
        ).rejects.toBeInstanceOf(NotProposerError);
        await expect(call(memberId, 'member', 'reject_draft', params)).rejects.toBeInstanceOf(
          ForbiddenError,
        );
        await expect(
          dispatchCapability({ pool }, handleCaller(ownerId), 'reject_draft', params),
        ).rejects.toBeInstanceOf(ForbiddenError);

        expect(await listedSkill(ownerId, 'owner', skillId)).toMatchObject({
          version: 2,
          status: 'draft',
          draftDigest,
        });
        expect(await rejectAudits(skillId)).toHaveLength(0);
      });

      it('a reason is required; the draft reviewed is named by its digest; only a draft is rejected', async () => {
        const { skillId, draftDigest } = await skillWithPendingDraft();
        const params = { kind: 'skill', id: skillId, version: 2, draftDigest };

        await expect(call(builderId, 'builder', 'reject_draft', params)).rejects.toBeInstanceOf(
          InvalidCapabilityParamsError,
        );
        await expect(
          call(builderId, 'builder', 'reject_draft', { ...params, reason: '   ' }),
        ).rejects.toBeInstanceOf(InvalidCapabilityParamsError);
        await expect(
          call(builderId, 'builder', 'reject_draft', {
            ...params,
            draftDigest: 'sha256:another',
            reason: 'No.',
          }),
        ).rejects.toBeInstanceOf(ReviewedDraftChangedError);
        expect(await listedSkill(ownerId, 'owner', skillId)).toMatchObject({ version: 2 });

        await expect(
          call(builderId, 'builder', 'reject_draft', { ...params, version: 1, reason: 'No.' }),
        ).rejects.toBeInstanceOf(DraftNotRejectableError);
        await expect(
          call(builderId, 'builder', 'reject_draft', { ...params, version: 3, reason: 'No.' }),
        ).rejects.toThrow(/not found/i);
      });

      it('a family with no published version: the owner rejects its draft, a builder may not', async () => {
        const skillId = await workerProposedSkillOfMember();
        const draftDigest = await reviewedSkillDigest(ownerId, 'owner', skillId);
        const params = { kind: 'skill', id: skillId, version: 1, draftDigest, reason: 'No.' };

        await expect(call(builderId, 'builder', 'reject_draft', params)).rejects.toThrow(
          /no published version, so only the workspace owner may reject it/,
        );
        await call(ownerId, 'owner', 'reject_draft', params);
        expect(await listedSkill(ownerId, 'owner', skillId)).toBeUndefined();
        expect((await rejectAudits(skillId))[0]?.payload.rejectedDraft).toMatchObject({
          proposedBy: memberId,
          inUseVersion: null,
        });
      });

      it('a Procedure: the proposer of the version in use rejects another builder’s next version, which can then be proposed again', async () => {
        const procedure = {
          name: `reject-procedure-${randomUUID().slice(0, 8)}`,
          description: 'v1',
          steps: [{ kind: 'approval', description: 'A human approves the change.' }],
        };
        const v1 = await call<{ id: string; draftDigest: string }>(
          builderId,
          'builder',
          'propose_procedure',
          { procedure },
        );
        await call(builderId, 'builder', 'publish_procedure', {
          procedureId: v1.id,
          version: 1,
          draftDigest: v1.draftDigest,
        });
        const v2 = await call<{ draftDigest: string }>(
          otherBuilderId,
          'builder',
          'propose_procedure',
          { procedure: { ...procedure, description: 'v2' }, procedureId: v1.id },
        );
        await expect(
          call(otherBuilderId, 'builder', 'propose_procedure', {
            procedure: { ...procedure, description: 'v2 again' },
            procedureId: v1.id,
          }),
        ).rejects.toBeInstanceOf(FamilyDraftPendingError);

        await call(builderId, 'builder', 'reject_draft', {
          kind: 'procedure',
          id: v1.id,
          version: 2,
          draftDigest: v2.draftDigest,
          reason: 'v1 already covers it.',
        });
        expect(await listedProcedure(ownerId, 'owner', v1.id)).toMatchObject({
          status: 'published',
        });
        const again = await call<{ version: number }>(
          otherBuilderId,
          'builder',
          'propose_procedure',
          { procedure: { ...procedure, description: 'v2 again' }, procedureId: v1.id },
        );
        expect(again.version).toBe(2);
      });
    });
  },
);
