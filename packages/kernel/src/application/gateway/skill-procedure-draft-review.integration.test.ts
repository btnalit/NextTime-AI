import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { proposeSkill } from '../../application/worker/index.js';
import { NotProposerError } from '../../governance/capability/index.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
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
}

interface ProcedureItem {
  readonly id: string;
  readonly status: string;
  readonly proposedBy: string;
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
        await expect(call(memberId, 'member', 'publish_skill', { skillId })).rejects.toBeInstanceOf(
          ForbiddenError,
        );
      });

      it('a builder sees it but cannot publish it (403 not_proposer), and it stays a draft', async () => {
        const skillId = await workerProposedSkillOfMember();

        expect(await listedSkill(builderId, 'builder', skillId)).toMatchObject({
          status: 'draft',
          proposedBy: memberId,
        });
        const refusal = call(builderId, 'builder', 'publish_skill', { skillId });
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
        await expect(
          call(otherBuilderId, 'builder', 'publish_procedure', { procedureId }),
        ).rejects.toBeInstanceOf(NotProposerError);
        expect(await listedProcedure(builderId, 'builder', procedureId)).toMatchObject({
          status: 'draft',
        });
      });
    });
  },
);
