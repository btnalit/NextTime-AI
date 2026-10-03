import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Operation, Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { proposeSkill as proposeSkillVersion } from '../../application/worker/index.js';
import { NotProposerError } from '../../governance/capability/index.js';
import { registerGatekeeper } from '../../governance/gatekeepers/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/publish-authority.integration.test: DB-gated (auto-skip without
 * DATABASE_URL) dispatch-level coverage of review 2026-10-02 decision D-24 — every meta-ontology
 * `publish_*` / `deprecate_*` is `minRole: 'builder'`, and only the row's proposer or the workspace
 * owner may act on it. One publish path (`publish_skill`, a draft private to its proposer: someone
 * else's reads as not found) and one deprecate path (`deprecate_operation`, a published row
 * everyone sees: 403 `not_proposer`), each at member / another builder / the proposer / the owner.
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

    async function proposeSkill(): Promise<string> {
      const proposed = await call<{ id: string }>(builderId, 'builder', 'propose_skill', {
        skill: {
          name: `d24-skill-${randomUUID().slice(0, 8)}`,
          description: 'A skill used by the D-24 authority test.',
          markdown: '# Steps\n\nDo the thing.',
        },
      });
      return proposed.id;
    }

    /** An Operation `builderId` proposed and published (its own draft — allowed). */
    async function publishedOperationOfBuilder(): Promise<string> {
      const name = `d24.op.${randomUUID().slice(0, 8)}`;
      await call(builderId, 'builder', 'propose_operation', {
        gatekeeperId,
        operation: testOperation(name),
      });
      await call(builderId, 'builder', 'publish_operation', { gatekeeperId, name });
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
        const skillId = await proposeSkill();
        await expect(call(memberId, 'member', 'publish_skill', { skillId })).rejects.toBeInstanceOf(
          ForbiddenError,
        );
      });

      it('another builder: the draft is not theirs and not visible — not found', async () => {
        const skillId = await proposeSkill();
        await expect(
          call(otherBuilderId, 'builder', 'publish_skill', { skillId }),
        ).rejects.toMatchObject({ name: 'SkillNotFoundError' });
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
        const skillId = await proposeSkill();
        const published = await call<{ status: string }>(builderId, 'builder', 'publish_skill', {
          skillId,
        });
        expect(published.status).toBe('published');
      });

      it('the owner publishes a builder’s draft', async () => {
        const skillId = await proposeSkill();
        const published = await call<{ status: string }>(ownerId, 'owner', 'publish_skill', {
          skillId,
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
        await call(builderId, 'builder', 'propose_operation', {
          gatekeeperId,
          operation: testOperation(name),
        });
        await expect(
          call(otherBuilderId, 'builder', 'publish_operation', { gatekeeperId, name }),
        ).rejects.toBeInstanceOf(NotProposerError);
      });

      it('a builder’s own revision of an Operation the owner published needs the owner to publish it', async () => {
        const name = `d24.op.${randomUUID().slice(0, 8)}`;
        await call(ownerId, 'owner', 'propose_operation', {
          gatekeeperId,
          operation: testOperation(name),
        });
        await call(ownerId, 'owner', 'publish_operation', { gatekeeperId, name });
        // The builder's revision loosens nothing here, but publishing it would deprecate the
        // owner's row — deprecate authority over that row is required too.
        await call(builderId, 'builder', 'propose_operation', {
          gatekeeperId,
          operation: { ...testOperation(name), description: 'A revised description.' },
        });
        await expect(
          call(builderId, 'builder', 'publish_operation', { gatekeeperId, name }),
        ).rejects.toBeInstanceOf(NotProposerError);
        const published = await call<{ status: string; version: number }>(
          ownerId,
          'owner',
          'publish_operation',
          { gatekeeperId, name },
        );
        expect(published.status).toBe('published');
        expect(published.version).toBe(2);
      });
    });

    describe('a new version in someone else’s family', () => {
      it('Skill: another builder may propose a version, may not publish it; the owner may', async () => {
        const skillId = await proposeSkill();
        await call(builderId, 'builder', 'publish_skill', { skillId });

        const v2 = await withWorkspace(
          pool,
          { workspaceId, principalId: otherBuilderId },
          (client) =>
            proposeSkillVersion(client, workspaceId, otherBuilderId, {
              skillId,
              name: `d24-skill-${randomUUID().slice(0, 8)}`,
              description: 'Another builder’s version of the family.',
              markdown: '# Steps\n\nDo it differently.',
            }),
        );
        expect(v2.version).toBe(2);
        await expect(
          call(otherBuilderId, 'builder', 'publish_skill', { skillId }),
        ).rejects.toBeInstanceOf(NotProposerError);

        const published = await call<{ status: string; version: number }>(
          ownerId,
          'owner',
          'publish_skill',
          { skillId },
        );
        expect(published).toMatchObject({ status: 'published', version: 2 });
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
