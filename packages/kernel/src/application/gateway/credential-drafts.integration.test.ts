import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Operation, Role } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  importManifest,
  publishImportedDrafts,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { dispatchCapability } from './dispatch.js';
import { setGatekeeperReadHandlerDeps } from './gatekeeper-read-handlers.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/credential-drafts.integration.test (legacy 198, #532 review O): a draft
 * whose definition carries suspected credential values is published only by a person who confirms
 * them (`publish_operation`'s `credentialsReviewed`, decision 2026-10-09 「二次确认」). The bulk
 * paths publish with nobody confirming — `publish_manifest` and the landing of
 * `enable_gate_instance` (`publishImportedDrafts`) — so they leave such a draft unpublished and
 * list it in `credentialDrafts`, and publish the rest. Legacy 801: the catalog's draft rows say how
 * many suspected values each carries, so the console knows which drafts a bulk publish leaves.
 *
 * DB-gated (real Postgres; auto-skip without DATABASE_URL).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

// Built at run time: a vendor-key-shaped value an OpenAPI document's `example` might carry.
const vendorShaped = `sk-${'a1B2'.repeat(12)}`;

interface OperationRow {
  name: string;
  status: string;
  draftDigest?: string;
  suspectedSecretValues?: number;
}

function lookup(name: string, example?: string): Operation {
  return {
    name,
    description: 'Looks up one record by its id.',
    binding: { kind: 'http', method: 'GET', path: '/records/{id}' },
    params_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', 'x-in': 'path', ...(example !== undefined ? { example } : {}) },
      },
      required: ['id'],
    },
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: ['Record'],
    writes: [],
  };
}

const HELD = {
  suspectedSecretValues: 1,
  suspectedSecretPaths: ['params_schema.properties.id.example'],
};

describe.runIf(DATABASE_URL !== undefined)(
  'credential drafts — a bulk publish leaves a definition carrying suspected credentials for a person (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let gatekeeperId: string;

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

    function call<T>(name: string, params: Record<string, unknown>): Promise<T> {
      return dispatchCapability({ pool }, owner(), name, params) as Promise<T>;
    }

    async function admin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, {
        skipRoleSwitch: true,
      });
    }

    async function row(name: string): Promise<OperationRow | undefined> {
      const listed = await call<{ items: OperationRow[] }>('list_operations', { gatekeeperId });
      const rows = listed.items.filter((item) => item.name === name);
      return (
        rows.find((item) => item.status === 'draft') ??
        rows.find((item) => item.status === 'published')
      );
    }

    async function importDrafts(operations: readonly Operation[]) {
      return admin(async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.import_manifest',
          principalId: ownerId,
        });
        return importManifest(client, workspaceId, {
          gatekeeperId,
          operations,
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: activity.id,
        });
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
            'credential-drafts-test-workspace',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'owner')`,
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      gatekeeperId = await admin(async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.register_gatekeeper',
          principalId: ownerId,
        });
        const registered = await registerGatekeeper(client, workspaceId, {
          name: 'credential-drafts-gate',
          transportKind: 'http',
          target: 'credential-drafts-system',
          endpoint: 'https://gate.credential-drafts-test.invalid/',
          activityId: activity.id,
          registeredBy: { id: ownerId, kind: 'human' },
        });
        return registered.gatekeeperId;
      });
      // Never make a real network call for get_gatekeeper's health probe.
      setGatekeeperReadHandlerDeps({
        gatekeeperClient: {
          describeOperations: async () => ({ operations: [] }),
          observe: async () => ({ data: null }),
          simulate: async () => ({ description: 'no-op (test fake)' }),
          apply: async () => ({ data: null, replayed: false }),
          lookupApply: async () => ({ data: null, replayed: true }),
          revert: async () => ({ data: null }),
          health: async () => ({ status: 'ok' }),
          storeConnectedAccount: async () => {},
          deleteConnectedAccount: async () => {},
        },
      });
    });

    afterAll(async () => {
      setGatekeeperReadHandlerDeps({});
      await pool.end();
    });

    it('publish_manifest leaves a draft carrying suspected credentials for a person, who publishes it confirming them', async () => {
      const carrying = `cd.bulk.get.${randomUUID().slice(0, 8)}`;
      const plain = `cd.bulk.list.${randomUUID().slice(0, 8)}`;
      await importDrafts([lookup(carrying, vendorShaped), lookup(plain, 'R-1')]);
      const listed = await call<{ items: OperationRow[] }>('list_operations', { gatekeeperId });
      const drafts = listed.items
        .filter((item) => item.status === 'draft' && [carrying, plain].includes(item.name))
        .map((item) => ({ name: item.name, draftDigest: item.draftDigest }));
      expect(drafts).toHaveLength(2);

      const published = await call<{
        publishedOperationNames: string[];
        credentialDrafts: unknown[];
      }>('publish_manifest', { gatekeeperId, drafts });
      expect(published.publishedOperationNames).toEqual([plain]);
      expect(published.credentialDrafts).toEqual([{ name: carrying, ...HELD }]);
      expect(JSON.stringify(published)).not.toContain(vendorShaped);
      expect((await row(carrying))?.status).toBe('draft');
      expect((await row(plain))?.status).toBe('published');

      const held = await row(carrying);
      await expect(
        call('publish_operation', { gatekeeperId, name: carrying, draftDigest: held?.draftDigest }),
      ).rejects.toMatchObject({ code: 'credentials_review_required' });
      expect((await row(carrying))?.status).toBe('draft');
      const confirmed = await call<{ status: string }>('publish_operation', {
        gatekeeperId,
        name: carrying,
        draftDigest: held?.draftDigest,
        credentialsReviewed: true,
      });
      expect(confirmed.status).toBe('published');
    });

    it('list_operations and get_gatekeeper count the suspected credential values of a draft, never of a published version', async () => {
      const carrying = `cd.count.get.${randomUUID().slice(0, 8)}`;
      const plain = `cd.count.list.${randomUUID().slice(0, 8)}`;
      await importDrafts([lookup(carrying, vendorShaped), lookup(plain, 'R-1')]);

      const listed = await call<{ items: OperationRow[] }>('list_operations', { gatekeeperId });
      const held = listed.items.find((item) => item.name === carrying);
      expect(held).toMatchObject({ status: 'draft', suspectedSecretValues: 1 });
      const clean = listed.items.find((item) => item.name === plain);
      expect(clean?.status).toBe('draft');
      expect(clean).not.toHaveProperty('suspectedSecretValues');
      // A count, never where or what.
      expect(JSON.stringify(listed)).not.toContain(vendorShaped);

      const detail = await call<{ operations: OperationRow[] }>('get_gatekeeper', { gatekeeperId });
      expect(detail.operations.find((item) => item.name === carrying)).toMatchObject({
        status: 'draft',
        suspectedSecretValues: 1,
      });
      expect(detail.operations.find((item) => item.name === plain)).not.toHaveProperty(
        'suspectedSecretValues',
      );

      await call('publish_operation', {
        gatekeeperId,
        name: carrying,
        draftDigest: held?.draftDigest,
        credentialsReviewed: true,
      });
      const published = await row(carrying);
      expect(published?.status).toBe('published');
      expect(published).not.toHaveProperty('suspectedSecretValues');
    });

    it('enable-time publishing (publishImportedDrafts) holds the same draft and publishes the rest', async () => {
      const carrying = `cd.land.get.${randomUUID().slice(0, 8)}`;
      const plain = `cd.land.list.${randomUUID().slice(0, 8)}`;
      const imported = await importDrafts([lookup(carrying, vendorShaped), lookup(plain)]);
      const landed = await admin((client) =>
        publishImportedDrafts(client, workspaceId, gatekeeperId, imported.imported),
      );
      expect(landed.publishedOperationNames).toEqual([plain]);
      expect(landed.credentialDrafts).toEqual([{ name: carrying, ...HELD }]);
      expect((await row(carrying))?.status).toBe('draft');
    });
  },
);
