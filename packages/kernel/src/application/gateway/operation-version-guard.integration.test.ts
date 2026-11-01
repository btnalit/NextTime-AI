import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Operation } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  deprecateOperation,
  getOperation,
  importManifest,
  publishOperation,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { writeAudit } from '../../substrate/audit/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';

/**
 * Legacy 482 (migrations/core/0047_operation_version_guard.sql): a published Operation version is
 * what every approval of it reads, and the database keeps it that way. Its definition never
 * changes; its status moves only along the Operation lifecycle; its governance fields change only
 * together with the `operation.governance_refreshed` AuditRecord that states the new values, in the
 * same transaction. The governed paths themselves (publish, deprecate, discard, a draft's rewrite,
 * `update_operation_description`, `refresh_operation_governance`) keep their own coverage —
 * `operation-governance.integration.test.ts`, `governance/gatekeepers/manifest.test.ts`,
 * `platform-gates.integration.test.ts` — and run on this schema. This file writes the row the way
 * no governed path does and expects the database to refuse it, both as the kernel's workspace role
 * and as the login role.
 */

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const DATABASE_URL = process.env.DATABASE_URL;

function testOperation(overrides: Partial<Operation> = {}): Operation {
  return {
    name: `guard.op.${randomUUID()}`,
    description: 'An operation the guard keeps.',
    binding: { kind: 'http', method: 'POST', path: '/records/purge' },
    params_schema: {},
    mode: 'execute',
    blast_radius: 'high',
    reversibility: false,
    auto_approvable: false,
    await_decision: true,
    reads: [],
    writes: ['records'],
    destructive_hint: true,
    ...overrides,
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'legacy 482: a published Operation version changes only through its governed transitions (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    const graphStore = new SqlGraphStore();

    function inTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);
    }

    /** The login role: owns `objects`, bypasses RLS — the operator CLI's and a migration's role. */
    function asLoginRole<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, {
        skipRoleSwitch: true,
      });
    }

    async function seedOperation(
      operation: Operation,
      options: { readonly publish: boolean },
    ): Promise<{ gatekeeperId: string; id: string }> {
      const activityId = await inTx(async (client) => {
        const result = await client.query<{ id: string }>(
          `insert into activities (workspace_id, kind, status, started_by)
           values ($1, 'test.operation-version-guard', 'running', $2) returning id`,
          [workspaceId, ownerId],
        );
        return result.rows[0]?.id ?? '';
      });
      const { gatekeeperId } = await inTx((client) =>
        registerGatekeeper(client, workspaceId, {
          name: `guard-gate-${randomUUID().slice(0, 8)}`,
          transportKind: 'http',
          target: 'example-system',
          endpoint: `https://guard-${randomUUID()}.example.invalid`,
          activityId,
          registeredBy: { id: ownerId, kind: 'human' },
        }),
      );
      await inTx((client) =>
        importManifest(client, workspaceId, {
          gatekeeperId,
          operations: [operation],
          proposedBy: { id: ownerId, kind: 'human' },
          activityId,
        }),
      );
      if (options.publish) {
        await inTx((client) =>
          publishOperation(client, workspaceId, { gatekeeperId, name: operation.name }),
        );
      }
      const record = await inTx((client) =>
        getOperation(client, workspaceId, gatekeeperId, operation.name),
      );
      if (!record) throw new Error('seeded Operation not found');
      return { gatekeeperId, id: record.id };
    }

    async function propertiesOf(id: string): Promise<Record<string, unknown>> {
      const result = await asLoginRole((client) =>
        client.query<{ properties: Record<string, unknown> }>(
          'select properties from objects where workspace_id = $1 and id = $2',
          [workspaceId, id],
        ),
      );
      const row = result.rows[0];
      if (!row) throw new Error(`Operation ${id} not found`);
      return row.properties;
    }

    function mergeProperties(client: PoolClient, id: string, patch: Record<string, unknown>) {
      return client.query(
        `update objects set properties = properties || $3::jsonb, updated_at = now()
         where workspace_id = $1 and id = $2`,
        [workspaceId, id, JSON.stringify(patch)],
      );
    }

    function governanceAudit(
      client: PoolClient,
      id: string,
      after: Record<string, unknown>,
      action = 'operation.governance_refreshed',
    ) {
      return writeAudit(client, {
        workspaceId,
        actorPrincipalId: ownerId,
        action,
        resourceType: 'operation',
        resourceId: id,
        payload: { before: {}, after, direction: 'loosened' },
      });
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      ownerId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'operation-version-guard-test-workspace',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'owner')`,
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    describe('governance fields of a published version', () => {
      it('a raw write of auto_approvable with no AuditRecord is refused at commit, as either role', async () => {
        const { id } = await seedOperation(testOperation(), { publish: true });

        for (const run of [inTx, asLoginRole]) {
          await expect(
            run((client) => mergeProperties(client, id, { auto_approvable: true })),
          ).rejects.toThrow(/governance \(auto_approvable\) changes only with/);
        }
        expect((await propertiesOf(id)).auto_approvable).toBe(false);
      });

      it('the graph store’s own merge (a kernel-authored upsert) is held to the same rule', async () => {
        const operation = testOperation();
        const { gatekeeperId, id } = await seedOperation(operation, { publish: true });

        await expect(
          inTx((client) =>
            graphStore.upsertObject(client, workspaceId, {
              objectType: 'Operation',
              kernelAuthored: true,
              identity: { gatekeeperId, name: operation.name, version: 1 },
              properties: { await_decision: false, mode: 'observe' },
            }),
          ),
        ).rejects.toThrow(/governance \(mode, await_decision\) changes only with/);
        const properties = await propertiesOf(id);
        expect(properties.await_decision).toBe(true);
        expect(properties.mode).toBe('execute');
      });

      it('removing a declared hint is a governance change too', async () => {
        const { id } = await seedOperation(testOperation(), { publish: true });

        await expect(
          inTx((client) =>
            client.query(
              `update objects set properties = properties - 'destructive_hint'
               where workspace_id = $1 and id = $2`,
              [workspaceId, id],
            ),
          ),
        ).rejects.toThrow(/governance \(destructive_hint\) changes only with/);
        expect((await propertiesOf(id)).destructive_hint).toBe(true);
      });

      it('an AuditRecord that states other values, or another action, does not count', async () => {
        const { id } = await seedOperation(testOperation(), { publish: true });

        await expect(
          inTx(async (client) => {
            await mergeProperties(client, id, { auto_approvable: true, blast_radius: 'low' });
            await governanceAudit(client, id, { autoApprovable: true, blastRadius: 'high' });
          }),
        ).rejects.toThrow(/changes only with/);
        await expect(
          inTx(async (client) => {
            await mergeProperties(client, id, { auto_approvable: true });
            await governanceAudit(client, id, { autoApprovable: true }, 'operation.published');
          }),
        ).rejects.toThrow(/changes only with/);
        // One about another Operation.
        const other = await seedOperation(testOperation(), { publish: true });
        await expect(
          inTx(async (client) => {
            await mergeProperties(client, id, { auto_approvable: true });
            await governanceAudit(client, other.id, { autoApprovable: true });
          }),
        ).rejects.toThrow(/changes only with/);
        expect((await propertiesOf(id)).auto_approvable).toBe(false);
      });

      it('an AuditRecord whose `after` is not an object, or is missing, states nothing', async () => {
        const { id } = await seedOperation(testOperation(), { publish: true });
        // Removing a hint compares a missing value; a payload that names the field in an array, or
        // has no `after` at all, must not read as stating that removal.
        for (const payload of [
          { before: {}, after: ['destructiveHint'], direction: 'tightened' },
          { before: {}, direction: 'tightened' },
          { before: {}, after: null, direction: 'tightened' },
        ]) {
          await expect(
            inTx(async (client) => {
              await client.query(
                `update objects set properties = properties - 'destructive_hint'
                 where workspace_id = $1 and id = $2`,
                [workspaceId, id],
              );
              await writeAudit(client, {
                workspaceId,
                actorPrincipalId: ownerId,
                action: 'operation.governance_refreshed',
                resourceType: 'operation',
                resourceId: id,
                payload,
              });
            }),
          ).rejects.toThrow(/governance \(destructive_hint\) changes only with/);
        }
        expect((await propertiesOf(id)).destructive_hint).toBe(true);
      });

      it('an AuditRecord from an earlier transaction does not count', async () => {
        const { id } = await seedOperation(testOperation(), { publish: true });
        await inTx((client) => governanceAudit(client, id, { autoApprovable: true }));

        await expect(
          inTx((client) => mergeProperties(client, id, { auto_approvable: true })),
        ).rejects.toThrow(/changes only with/);
        expect((await propertiesOf(id)).auto_approvable).toBe(false);
      });

      it('the change goes through with the AuditRecord stating it, written after it in the same transaction — what refresh_operation_governance does', async () => {
        const { id } = await seedOperation(testOperation(), { publish: true });

        await inTx(async (client) => {
          await client.query(
            `update objects
             set properties = (properties || $3::jsonb) - 'destructive_hint'::text, updated_at = now()
             where workspace_id = $1 and id = $2`,
            [workspaceId, id, JSON.stringify({ mode: 'observe', auto_approvable: true })],
          );
          await governanceAudit(client, id, {
            mode: 'observe',
            blastRadius: 'high',
            autoApprovable: true,
            destructiveHint: null,
          });
        });
        const properties = await propertiesOf(id);
        expect(properties).toMatchObject({ mode: 'observe', auto_approvable: true });
        expect(properties).not.toHaveProperty('destructive_hint');
      });

      it('S11 GO12 (core 0048): `target` is a governance field — changed only with the record stating it as the wire does', async () => {
        const { id } = await seedOperation(testOperation(), { publish: true });
        const declared = { object_type: 'Thing', params: ['id'] };

        // No record, or one stating the stored shape instead of the wire's: refused.
        await expect(
          inTx((client) => mergeProperties(client, id, { target: declared })),
        ).rejects.toThrow(/governance \(target\) changes only with/);
        await expect(
          inTx(async (client) => {
            await mergeProperties(client, id, { target: declared });
            await governanceAudit(client, id, { target: declared });
          }),
        ).rejects.toThrow(/governance \(target\) changes only with/);
        expect(await propertiesOf(id)).not.toHaveProperty('target');

        // Stated as the wire states it: it goes through, and so does removing it again.
        await inTx(async (client) => {
          await mergeProperties(client, id, { target: declared });
          await governanceAudit(client, id, { target: { objectType: 'Thing', params: ['id'] } });
        });
        expect((await propertiesOf(id)).target).toEqual(declared);
        await expect(
          inTx((client) =>
            client.query(
              `update objects set properties = properties - 'target' where workspace_id = $1 and id = $2`,
              [workspaceId, id],
            ),
          ),
        ).rejects.toThrow(/governance \(target\) changes only with/);
        await inTx(async (client) => {
          await client.query(
            `update objects set properties = properties - 'target' where workspace_id = $1 and id = $2`,
            [workspaceId, id],
          );
          await governanceAudit(client, id, { target: null });
        });
        expect(await propertiesOf(id)).not.toHaveProperty('target');
      });

      it('a deprecated version is held the same way', async () => {
        const operation = testOperation();
        const { gatekeeperId, id } = await seedOperation(operation, { publish: true });
        await inTx((client) =>
          deprecateOperation(client, workspaceId, { gatekeeperId, name: operation.name }),
        );

        await expect(
          inTx((client) => mergeProperties(client, id, { auto_approvable: true })),
        ).rejects.toThrow(/is deprecated and its governance \(auto_approvable\)/);
      });

      it('a draft is still the proposer’s to rewrite', async () => {
        const { id } = await seedOperation(testOperation(), { publish: false });

        await inTx((client) => mergeProperties(client, id, { auto_approvable: true }));
        expect((await propertiesOf(id)).auto_approvable).toBe(true);
      });
    });

    describe('definition and identity of a version that left draft', () => {
      it('a published version’s definition never changes, with or without an AuditRecord', async () => {
        const { id } = await seedOperation(testOperation(), { publish: true });
        const binding = { kind: 'http', method: 'POST', path: '/records/purge-all' };

        for (const run of [inTx, asLoginRole]) {
          await expect(
            run(async (client) => {
              await mergeProperties(client, id, { binding });
              await governanceAudit(client, id, {});
            }),
          ).rejects.toThrow(/is published and its definition never changes/);
        }
        await expect(
          inTx((client) => mergeProperties(client, id, { params_schema: { type: 'object' } })),
        ).rejects.toThrow(/definition never changes/);
        // Bookkeeping is part of the version too: who proposed it, and what it revised.
        await expect(
          inTx((client) => mergeProperties(client, id, { proposedBy: randomUUID() })),
        ).rejects.toThrow(/definition never changes/);
        expect((await propertiesOf(id)).binding).toEqual({
          kind: 'http',
          method: 'POST',
          path: '/records/purge',
        });
      });

      it('a discarded draft is kept as it was', async () => {
        const { id } = await seedOperation(testOperation(), { publish: false });
        await inTx((client) => mergeProperties(client, id, { status: 'discarded' }));

        await expect(
          inTx((client) => mergeProperties(client, id, { reversibility: true })),
        ).rejects.toThrow(/is discarded and its definition never changes/);
      });

      it('a description is documentation and changes in place', async () => {
        const { id } = await seedOperation(testOperation(), { publish: true });

        await inTx((client) => mergeProperties(client, id, { description: 'Purges records.' }));
        expect((await propertiesOf(id)).description).toBe('Purges records.');
      });

      it('a published version keeps its identity', async () => {
        const operation = testOperation();
        const { gatekeeperId, id } = await seedOperation(operation, { publish: true });

        await expect(
          inTx((client) =>
            client.query(
              'update objects set identity_key = $3::jsonb where workspace_id = $1 and id = $2',
              [workspaceId, id, JSON.stringify({ gatekeeperId, name: operation.name, version: 7 })],
            ),
          ),
        ).rejects.toThrow(/is published and keeps its identity/);
        // A key it no longer has is a change too, not an unknown one.
        await expect(
          inTx((client) =>
            client.query(
              'update objects set identity_key = null where workspace_id = $1 and id = $2',
              [workspaceId, id],
            ),
          ),
        ).rejects.toThrow(/is published and keeps its identity/);
        // Nor does it become another row, or another workspace's (the login role is not held by
        // the workspace policy, so only the guard stands here).
        await expect(
          asLoginRole((client) =>
            client.query(
              'update objects set id = gen_random_uuid() where workspace_id = $1 and id = $2',
              [workspaceId, id],
            ),
          ),
        ).rejects.toThrow(/is published and keeps its identity/);
        await expect(
          asLoginRole((client) =>
            client.query(
              'update objects set workspace_id = $3 where workspace_id = $1 and id = $2',
              [workspaceId, id, randomUUID()],
            ),
          ),
        ).rejects.toThrow(/is published and keeps its identity/);
        const kept = await asLoginRole((client) =>
          client.query('select 1 from objects where workspace_id = $1 and id = $2', [
            workspaceId,
            id,
          ]),
        );
        expect(kept.rowCount).toBe(1);
      });

      it('an Operation row stays one, and no other row becomes one', async () => {
        const { id } = await seedOperation(testOperation(), { publish: false });
        await expect(
          inTx((client) =>
            client.query(
              `update objects set object_type = 'Fixture' where workspace_id = $1 and id = $2`,
              [workspaceId, id],
            ),
          ),
        ).rejects.toThrow(/stays one, and no other row becomes one/);

        const fixture = await inTx((client) =>
          client.query<{ id: string }>(
            `insert into objects (workspace_id, object_type, properties)
             values ($1, 'Fixture', $2::jsonb) returning id`,
            [workspaceId, JSON.stringify({ ...testOperation(), status: 'published' })],
          ),
        );
        await expect(
          inTx((client) =>
            client.query(
              `update objects set object_type = 'Operation' where workspace_id = $1 and id = $2`,
              [workspaceId, fixture.rows[0]?.id],
            ),
          ),
        ).rejects.toThrow(/stays one, and no other row becomes one/);
      });
    });

    describe('status moves only along the Operation lifecycle', () => {
      it('nothing goes back to draft, nothing leaves deprecated or discarded, and a draft is never deprecated', async () => {
        const published = await seedOperation(testOperation(), { publish: true });
        await expect(
          inTx((client) => mergeProperties(client, published.id, { status: 'draft' })),
        ).rejects.toThrow(/cannot move from published to draft/);

        await inTx((client) => mergeProperties(client, published.id, { status: 'deprecated' }));
        await expect(
          inTx((client) => mergeProperties(client, published.id, { status: 'published' })),
        ).rejects.toThrow(/cannot move from deprecated to published/);

        const draft = await seedOperation(testOperation(), { publish: false });
        await expect(
          inTx((client) => mergeProperties(client, draft.id, { status: 'deprecated' })),
        ).rejects.toThrow(/cannot move from draft to deprecated/);
        await inTx((client) => mergeProperties(client, draft.id, { status: 'discarded' }));
        await expect(
          inTx((client) => mergeProperties(client, draft.id, { status: 'draft' })),
        ).rejects.toThrow(/cannot move from discarded to draft/);
      });

      it('a row with no status is a draft: removing the status of a version that left draft moves it back, and is refused', async () => {
        const operation = testOperation();
        const { id } = await seedOperation(operation, { publish: true });
        const removeStatus = (client: PoolClient) =>
          client.query(
            `update objects set properties = properties - 'status' where workspace_id = $1 and id = $2`,
            [workspaceId, id],
          );

        for (const run of [inTx, asLoginRole]) {
          await expect(run(removeStatus)).rejects.toThrow(/cannot move from published to draft/);
          await expect(
            run((client) => mergeProperties(client, id, { status: null })),
          ).rejects.toThrow(/cannot move from published to draft/);
        }
        // The two-step rewrite this closes: drop the status, then rewrite the definition and
        // governance and put `published` back. The first step already fails.
        await expect(
          asLoginRole(async (client) => {
            await removeStatus(client);
            await mergeProperties(client, id, {
              mode: 'execute',
              auto_approvable: true,
              binding: { kind: 'http', method: 'DELETE', path: '/records' },
              status: 'published',
            });
          }),
        ).rejects.toThrow(/cannot move from published to draft/);
        expect(await propertiesOf(id)).toMatchObject({
          status: 'published',
          auto_approvable: false,
          binding: { kind: 'http', method: 'POST', path: '/records/purge' },
        });

        await inTx((client) => mergeProperties(client, id, { status: 'deprecated' }));
        await expect(inTx(removeStatus)).rejects.toThrow(/cannot move from deprecated to draft/);
      });

      it('a draft with no status is a draft: it is rewritten freely and published along the lifecycle', async () => {
        const { id } = await seedOperation(testOperation(), { publish: false });

        await inTx((client) =>
          client.query(
            `update objects set properties = properties - 'status' where workspace_id = $1 and id = $2`,
            [workspaceId, id],
          ),
        );
        await inTx((client) => mergeProperties(client, id, { auto_approvable: true }));
        await inTx((client) => mergeProperties(client, id, { status: 'published' }));
        expect(await propertiesOf(id)).toMatchObject({
          status: 'published',
          auto_approvable: true,
        });
      });

      it('a publish may stamp bookkeeping in the statement that flips the draft', async () => {
        const { id } = await seedOperation(testOperation(), { publish: false });

        await inTx((client) =>
          mergeProperties(client, id, {
            status: 'published',
            publishedNote: 'stamped with the publish',
          }),
        );
        expect(await propertiesOf(id)).toMatchObject({
          status: 'published',
          publishedNote: 'stamped with the publish',
        });
      });
    });
  },
);
