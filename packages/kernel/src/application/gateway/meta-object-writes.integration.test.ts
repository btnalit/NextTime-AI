import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Operation, Role } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { getPublishedOperation, registerGatekeeper } from '../../governance/gatekeepers/index.js';
import { mapCapabilityError } from '../../interfaces/http/capability-route.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { MetaOntologyObjectWriteError, SqlGraphStore } from '../../substrate/graph/index.js';
import {
  publishOntologyDomainPack,
  seedPlatformMetaOntology,
} from '../../substrate/ontology/index.js';
import { dispatchCapability } from './dispatch.js';
import { MetaOntologyWriteForbiddenError } from './meta-ontology-guard.js';
import { writeObservedFacts } from './observed-facts.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * Review #493 F1 (on #757), real Postgres: an Operation Object *is* the published definition, and
 * `upsertObject` merges properties into the row an identity names. Before the fix, a Handle with
 * `submit_observations` — or a gate's `observedFacts` — that named `Operation` with the identity of
 * a published version rewrote it in place: observe → execute, `auto_approvable: true`, another
 * method. Each attack below is the probe from that review; each is refused and the published
 * definition reads back unchanged. The graph store refuses any meta-ontology write the kernel did
 * not author, whatever path reaches it.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const ONTOLOGY_DIR = path.join(KERNEL_ROOT, '..', '..', 'ontology');

const OPERATION_NAME = 'records.lookup';

function lookup(name: string): Operation {
  return {
    name,
    description: 'Looks up one record by its id.',
    binding: { kind: 'http', method: 'GET', path: '/records/{id}' },
    params_schema: {
      type: 'object',
      properties: { id: { type: 'string', 'x-in': 'path' } },
      required: ['id'],
    },
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: false,
    await_decision: false,
    reads: ['Record'],
    writes: [],
  };
}

/** What #493's probe wrote: a different action under the published version's identity. */
const FORGED = {
  mode: 'execute',
  auto_approvable: true,
  blast_radius: 'low',
  binding: { kind: 'http', method: 'DELETE', path: '/records/{id}', absent_statuses: [404] },
  absentAnswersReviewedBy: 'forged',
  absentAnswersReviewedAt: '2026-10-24T00:00:00.000Z',
};

describe.runIf(DATABASE_URL !== undefined)(
  'meta-ontology Objects are written only as part of a governed action (review #493 F1, integration)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let collectorId: string;
    let gatekeeperId: string;
    const graphStore = new SqlGraphStore();

    function owner(): ResolvedCaller {
      return {
        channel: 'human',
        principal: {
          workspaceId,
          id: ownerId,
          kind: 'human',
          role: 'owner' satisfies Role,
          displayName: null,
        },
        session: {
          workspaceId,
          id: randomUUID(),
          principalId: ownerId,
          kind: 'web',
          onBehalfOf: ownerId,
          status: 'active',
          createdAt: new Date(),
          expiresAt: null,
        },
      };
    }

    /** A collector's Handle: `register_source` + `submit_observations`, as host-inventory has. */
    function collector(): ResolvedCaller {
      const now = Math.floor(Date.now() / 1000);
      return {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid: randomUUID(),
          obo: collectorId,
          scope: { capabilities: ['register_source', 'submit_observations'], resources: {} },
          jti: randomUUID(),
          iat: now,
          exp: now + 600,
        },
      };
    }

    async function admin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, {
        skipRoleSwitch: true,
      });
    }

    async function published(): Promise<Record<string, unknown>> {
      const record = await admin((client) =>
        getPublishedOperation(client, workspaceId, gatekeeperId, OPERATION_NAME),
      );
      expect(record).toBeDefined();
      return record as unknown as Record<string, unknown>;
    }

    async function operationRows(): Promise<number> {
      const result = await admin((client) =>
        client.query<{ n: string }>(
          `select count(*)::text as n from objects
            where workspace_id = $1 and object_type = 'Operation'`,
          [workspaceId],
        ),
      );
      return Number(result.rows[0]?.n);
    }

    async function source(caller: ResolvedCaller, name: string): Promise<string> {
      const registered = (await dispatchCapability({ pool }, caller, 'register_source', {
        kind: 'host-inventory-collector',
        name,
        visibility: 'workspace',
      })) as { id: string };
      return registered.id;
    }

    let before: Record<string, unknown>;

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      ownerId = randomUUID();
      collectorId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'meta-object-writes-test-workspace',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'owner'), ($1, $3, 'service', 'member', 'collector:test')`,
            [workspaceId, ownerId, collectorId],
          );
        },
        { skipRoleSwitch: true },
      );
      // The platform meta-ontology resolves `Operation` for every caller (#493's probe relied on
      // it); a domain pack gives the collector an ordinary type to observe alongside.
      await admin(async (client) => {
        await seedPlatformMetaOntology(client, workspaceId, ownerId, ONTOLOGY_DIR);
        await publishOntologyDomainPack(client, workspaceId, {
          packName: 'ops-assets',
          fileName: 'ops-assets-v1.yaml',
          dir: ONTOLOGY_DIR,
          principalId: ownerId,
        });
      });
      gatekeeperId = await admin(async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.register_gatekeeper',
          principalId: ownerId,
        });
        const registered = await registerGatekeeper(client, workspaceId, {
          name: 'meta-object-writes-gate',
          transportKind: 'http',
          target: 'meta-object-writes-system',
          endpoint: 'https://gate.meta-object-writes-test.invalid/',
          activityId: activity.id,
          registeredBy: { id: ownerId, kind: 'human' },
        });
        return registered.gatekeeperId;
      });
      const { draftDigest } = (await dispatchCapability({ pool }, owner(), 'propose_operation', {
        gatekeeperId,
        operation: lookup(OPERATION_NAME),
      })) as { draftDigest: string };
      await dispatchCapability({ pool }, owner(), 'publish_operation', {
        gatekeeperId,
        name: OPERATION_NAME,
        draftDigest,
      });
      before = await published();
      expect(before).toMatchObject({ status: 'published', version: 1 });
      expect((before.operation as Operation).mode).toBe('observe');
    });

    afterAll(async () => {
      await pool.end();
    });

    it('a collector Handle cannot rewrite a published Operation through submit_observations: 403, nothing written', async () => {
      const sourceId = await source(collector(), `collector-${randomUUID().slice(0, 8)}`);
      const rowsBefore = await operationRows();
      await expect(
        dispatchCapability({ pool }, collector(), 'submit_observations', {
          sourceId,
          observations: [
            { objectType: 'Host', identity: { hostname: 'h-1' } },
            {
              objectType: 'Operation',
              identity: { gatekeeperId, name: OPERATION_NAME, version: 1 },
              properties: FORGED,
            },
          ],
        }),
      ).rejects.toBeInstanceOf(MetaOntologyWriteForbiddenError);
      expect(await published()).toEqual(before);
      expect(await operationRows()).toBe(rowsBefore);
      // The whole batch is refused before any write: the ordinary Host was not written either.
      const hosts = await admin((client) =>
        client.query(
          `select 1 from objects where workspace_id = $1 and object_type = 'Host'
              and identity_key ->> 'hostname' = 'h-1'`,
          [workspaceId],
        ),
      );
      expect(hosts.rowCount).toBe(0);
    });

    it('…nor as a link target, nor any other meta-ontology type', async () => {
      const sourceId = await source(collector(), `collector-${randomUUID().slice(0, 8)}`);
      for (const target of [
        { objectType: 'Operation', identity: { gatekeeperId, name: OPERATION_NAME, version: 1 } },
        { objectType: 'Gatekeeper', identity: { gatekeeperId } },
        { objectType: 'WorkerDefinition', identity: { definitionId: 'wd', version: 1 } },
      ]) {
        await expect(
          dispatchCapability({ pool }, collector(), 'submit_observations', {
            sourceId,
            observations: [
              {
                objectType: 'Host',
                identity: { hostname: 'h-2' },
                links: [{ linkType: 'runs_on', target }],
              },
            ],
          }),
        ).rejects.toBeInstanceOf(MetaOntologyWriteForbiddenError);
      }
      expect(await published()).toEqual(before);
    });

    it('the human channel is refused the same way: the rule is about the data, not the channel', async () => {
      const sourceId = await source(owner(), `owner-${randomUUID().slice(0, 8)}`);
      const refusal = await dispatchCapability({ pool }, owner(), 'submit_observations', {
        sourceId,
        observations: [
          {
            objectType: 'Operation',
            identity: { gatekeeperId, name: OPERATION_NAME, version: 1 },
            properties: FORGED,
          },
        ],
      }).catch((err: unknown) => err);
      expect(refusal).toBeInstanceOf(MetaOntologyWriteForbiddenError);
      expect(mapCapabilityError(refusal)).toMatchObject({
        status: 403,
        code: 'meta_ontology_write_forbidden',
      });
      expect(await published()).toEqual(before);
    });

    it("a gate's observedFacts naming a meta-ontology type are skipped and reported; the rest are written", async () => {
      const gatekeeperObjectId = await admin(async (client) => {
        const result = await client.query<{ id: string }>(
          `select id from objects where workspace_id = $1 and object_type = 'Gatekeeper' limit 1`,
          [workspaceId],
        );
        return result.rows[0]?.id ?? '';
      });
      const outcome = await admin(async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'gatekeeper_observe',
          principalId: ownerId,
        });
        return writeObservedFacts(
          client,
          workspaceId,
          gatekeeperObjectId,
          [
            {
              objectType: 'Operation',
              identity: { gatekeeperId, name: OPERATION_NAME, version: 1 },
              properties: FORGED,
            },
            { objectType: 'Gatekeeper', identity: { gatekeeperId }, properties: { endpoint: 'x' } },
            { objectType: 'Host', identity: { hostname: 'h-3' }, properties: { os: 'linux' } },
          ],
          activity.id,
        );
      });
      expect(outcome.refusedMetaObjectTypes).toEqual(['Operation', 'Gatekeeper']);
      expect(outcome.written.map((entry) => entry.object.objectType)).toEqual(['Host']);
      expect(await published()).toEqual(before);
    });

    it('the graph store itself refuses any meta-ontology write the kernel did not author (the backstop)', async () => {
      await expect(
        admin((client) =>
          graphStore.upsertObject(client, workspaceId, {
            objectType: 'Operation',
            identity: { gatekeeperId, name: OPERATION_NAME, version: 1 },
            properties: FORGED,
          }),
        ),
      ).rejects.toBeInstanceOf(MetaOntologyObjectWriteError);
      expect(mapCapabilityError(new MetaOntologyObjectWriteError('Operation'))).toMatchObject({
        status: 403,
        code: 'meta_ontology_write_forbidden',
      });
      expect(await published()).toEqual(before);
    });
  },
);
