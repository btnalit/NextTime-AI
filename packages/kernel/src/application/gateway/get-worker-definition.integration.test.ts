import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Role, WorkerDefinitionWireSchema } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL) for S11 GO15a's
 * `get_worker_definition`: one version of a WorkerDefinition — a published or deprecated version
 * to every person (an auditor too; a deprecated one is more than `list_worker_definitions` lists),
 * a draft only to its proposer (legacy 492); `null` for another's draft, a version nothing has, or
 * another workspace's.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function humanCaller(workspaceId: string, principalId: string, role: Role): ResolvedCaller {
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

describe.runIf(DATABASE_URL !== undefined)(
  'get_worker_definition — S11 GO15a (integration, real Postgres)',
  () => {
    let pool: Pool;
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const ownerId = randomUUID();
    const otherOwnerId = randomUUID();
    const memberId = randomUUID();
    const proposerId = randomUUID();
    const auditorId = randomUUID();

    const owner = () => humanCaller(workspaceId, ownerId, 'owner');
    const member = () => humanCaller(workspaceId, memberId, 'member');
    const proposer = () => humanCaller(workspaceId, proposerId, 'builder');
    const auditor = () => humanCaller(workspaceId, auditorId, 'auditor');
    const call = (caller: ResolvedCaller, name: string, params: Record<string, unknown>) =>
      dispatchCapability({ pool }, caller, name, params);
    const read = async (caller: ResolvedCaller, definitionId: string, version: number) => {
      const result = await call(caller, 'get_worker_definition', { definitionId, version });
      return result === null ? null : WorkerDefinitionWireSchema.parse(result);
    };

    async function seedWorkspace(id: string, ownerOf: string, others: [string, Role][]) {
      await withWorkspace(
        pool,
        { workspaceId: id, principalId: ownerOf },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            id,
            `go15a-${id.slice(0, 8)}`,
          ]);
          for (const [principalId, role] of [[ownerOf, 'owner'] as [string, Role], ...others]) {
            await client.query(
              `insert into principals (workspace_id, id, kind, role, display_name)
               values ($1, $2, 'human', $3, $4)`,
              [id, principalId, role, `${role}-${principalId.slice(0, 8)}`],
            );
          }
        },
        { skipRoleSwitch: true },
      );
    }

    let published: { id: string; version: number };
    let deprecated: { id: string; version: number };
    let draft: { id: string; version: number };

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      await seedWorkspace(workspaceId, ownerId, [
        [memberId, 'member'],
        [proposerId, 'builder'],
        [auditorId, 'auditor'],
      ]);
      await seedWorkspace(otherWorkspaceId, otherOwnerId, []);
      const propose = async (caller: ResolvedCaller, systemPrompt: string, definitionId?: string) =>
        (await call(caller, 'propose_worker_definition', {
          kind: 'worker',
          definition: { systemPrompt },
          ...(definitionId ? { definitionId } : {}),
        })) as { id: string; version: number };
      const publish = (ref: { id: string; version: number }) =>
        call(owner(), 'publish_worker_definition', {
          definitionId: ref.id,
          version: ref.version,
        });
      deprecated = await propose(owner(), 'You renew a certificate, first way.');
      await publish(deprecated);
      published = await propose(owner(), 'You renew a certificate, second way.', deprecated.id);
      await publish(published);
      await call(owner(), 'deprecate_worker_definition', {
        definitionId: deprecated.id,
        version: deprecated.version,
      });
      draft = await propose(proposer(), 'You renew a certificate, a third way.', deprecated.id);
    });

    afterAll(async () => {
      await pool.end();
    });

    it('reads a published and a deprecated version for every person, an auditor too', async () => {
      for (const caller of [member(), proposer(), auditor(), owner()]) {
        expect(await read(caller, published.id, published.version)).toMatchObject({
          id: published.id,
          version: published.version,
          status: 'published',
          definition: { systemPrompt: 'You renew a certificate, second way.' },
          goalPlanner: false,
        });
        expect(await read(caller, deprecated.id, deprecated.version)).toMatchObject({
          status: 'deprecated',
          definition: { systemPrompt: 'You renew a certificate, first way.' },
        });
      }
    });

    it('reads a draft for its proposer only; anyone else gets null, as for a version nothing has', async () => {
      expect(await read(proposer(), draft.id, draft.version)).toMatchObject({
        status: 'draft',
        proposedBy: proposerId,
      });
      for (const caller of [member(), auditor(), owner()]) {
        expect(await read(caller, draft.id, draft.version)).toBeNull();
      }
      expect(await read(member(), published.id, draft.version + 1)).toBeNull();
      expect(await read(member(), randomUUID(), 1)).toBeNull();
    });

    it('never reads another workspace’s version', async () => {
      const elsewhere = humanCaller(otherWorkspaceId, otherOwnerId, 'owner');
      expect(await read(elsewhere, published.id, published.version)).toBeNull();
    });

    it('refuses params it does not take', async () => {
      await expect(
        call(member(), 'get_worker_definition', { definitionId: published.id }),
      ).rejects.toThrow();
      await expect(
        call(member(), 'get_worker_definition', {
          definitionId: published.id,
          version: 1,
          status: 'draft',
        }),
      ).rejects.toThrow();
    });
  },
);
