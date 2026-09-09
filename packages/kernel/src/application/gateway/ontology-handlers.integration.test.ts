import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { publishOntologyDomainPack } from '../../substrate/ontology/index.js';
import { dispatchCapability, isResultValidationEnabled } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/ontology-handlers.integration.test: DB-gated (real Postgres; auto-skip
 * without DATABASE_URL) proof that the five `ontology`-group capabilities are wired end-to-end
 * through `dispatchCapability` — registry.ts's own unit/semantic coverage
 * (`substrate/ontology/registry.test.ts`) does not exercise `authorizeCapabilityCall`,
 * `paramsSchema` validation, or `resultSchema` validation (`KERNEL_VALIDATE_RESULTS=1`, set by
 * `vitest.base.ts`/CI — see dispatch.ts's own doc comment), all of which only run on this path.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const REPO_ROOT = path.resolve(KERNEL_ROOT, '..', '..');
const ONTOLOGY_DIR = path.join(REPO_ROOT, 'ontology');

function humanCaller(
  workspaceId: string,
  principalId: string,
  role: Role = 'owner',
): ResolvedCaller {
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

/** A fabricated Handle caller carrying exactly the ontology capability names it needs —
 *  `authorize.ts`'s handle-channel branch checks `scope.capabilities` only (no `minRole` check for
 *  the handle channel — that file's own documented gap), so this is enough to exercise the real
 *  `authorizeCapabilityCall` path without minting a real issued Handle
 *  (`invoke-worker-handler.integration.test.ts`'s own doc comment explains when a *real* issued
 *  Handle is required — spawning a child WorkerRun; none of these five capabilities do). */
function handleCaller(
  workspaceId: string,
  obo: string,
  capabilities: readonly string[],
): ResolvedCaller {
  const now = Math.floor(Date.now() / 1000);
  return {
    channel: 'handle',
    claims: {
      ws: workspaceId,
      sid: randomUUID(),
      obo,
      scope: { capabilities: [...capabilities], resources: {} },
      jti: randomUUID(),
      iat: now,
      exp: now + 600,
    },
  };
}

const ONTOLOGY_HANDLE_CAPABILITIES = [
  'get_type',
  'list_types',
  'validate',
  'propose_ontology_change',
];

describe.runIf(DATABASE_URL !== undefined)(
  'ontology-handlers (integration, real Postgres, dispatchCapability)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let aliceId: string;
    let bobId: string;

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

    async function adminInsertPrincipal(displayName: string, role: Role): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
            [workspaceId, id, 'human', role, displayName],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('ontology-handlers-test-workspace');
      ownerId = await adminInsertPrincipal('owner', 'owner');
      aliceId = await adminInsertPrincipal('alice', 'builder');
      bobId = await adminInsertPrincipal('bob', 'builder');

      // Publish the real ops-assets-v1.yaml domain pack so get_type/list_types have a stable,
      // workspace-visible-to-everyone type catalog to read (deliverable 4: "get_type for every
      // type in ops-assets-v1").
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        publishOntologyDomainPack(client, workspaceId, {
          packName: 'ops-assets',
          fileName: 'ops-assets-v1.yaml',
          dir: ONTOLOGY_DIR,
          principalId: ownerId,
        }),
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    it('KERNEL_VALIDATE_RESULTS=1 is on for this test run (sanity check for the resultSchema assertions below)', () => {
      expect(isResultValidationEnabled()).toBe(true);
    });

    it('get_type (handle channel) resolves every ops-assets-v1 ObjectType and validates against resultSchema', async () => {
      const caller = handleCaller(workspaceId, bobId, ONTOLOGY_HANDLE_CAPABILITIES);
      for (const name of ['Host', 'Container', 'Repository']) {
        const result = (await dispatchCapability({ pool }, caller, 'get_type', {
          typeName: name,
        })) as { kind: string; name: string; identityKey?: string[] };
        expect(result.kind).toBe('object');
        expect(result.name).toBe(name);
      }
    });

    it('get_type returns null for an unknown type name', async () => {
      const caller = handleCaller(workspaceId, bobId, ONTOLOGY_HANDLE_CAPABILITIES);
      const result = await dispatchCapability({ pool }, caller, 'get_type', {
        typeName: 'DoesNotExist',
      });
      expect(result).toBeNull();
    });

    it('list_types{kind:"link"} returns the envelope shape and includes a multi-signature LinkType', async () => {
      const caller = handleCaller(workspaceId, bobId, ONTOLOGY_HANDLE_CAPABILITIES);
      const result = (await dispatchCapability({ pool }, caller, 'list_types', {
        kind: 'link',
      })) as { items: Array<{ kind: string; name: string; signatures?: unknown[] }> };
      expect(Array.isArray(result.items)).toBe(true);
      const runsOn = result.items.find((item) => item.name === 'runs_on');
      expect(runsOn?.kind).toBe('link');
      expect(runsOn?.signatures?.length ?? 0).toBeGreaterThanOrEqual(4);
    });

    it('validate accepts an enumerated pair and rejects an unlisted one, both via dispatchCapability', async () => {
      const caller = handleCaller(workspaceId, bobId, ONTOLOGY_HANDLE_CAPABILITIES);
      const accepted = (await dispatchCapability({ pool }, caller, 'validate', {
        link: { linkType: 'mounts', sourceType: 'Container', targetType: 'Volume' },
      })) as { valid: boolean };
      expect(accepted.valid).toBe(true);

      const rejected = (await dispatchCapability({ pool }, caller, 'validate', {
        link: { linkType: 'mounts', sourceType: 'Volume', targetType: 'Container' },
      })) as { valid: boolean; errors?: string[] };
      expect(rejected.valid).toBe(false);
      expect(rejected.errors?.length).toBeGreaterThan(0);
    });

    it('propose_ontology_change (handle) is rejected on the human-only publish_ontology_version capability', async () => {
      const caller = handleCaller(workspaceId, aliceId, ONTOLOGY_HANDLE_CAPABILITIES);
      await expect(
        dispatchCapability({ pool }, caller, 'publish_ontology_version', {
          id: randomUUID(),
          version: 1,
        }),
      ).rejects.toThrow(/human-channel-only/);
    });

    it("propose_ontology_change creates a draft invisible to another principal's get_type; publish_ontology_version (human) makes it visible", async () => {
      const change = {
        objectTypes: [{ name: 'Gadget', description: 'A gadget.', identityKey: ['gadgetId'] }],
        linkTypes: [{ name: 'gadget_rel', domain: 'Gadget', range: 'Gadget', description: 'd' }],
      };

      const aliceCaller = handleCaller(workspaceId, aliceId, ONTOLOGY_HANDLE_CAPABILITIES);
      const proposeResult = (await dispatchCapability(
        { pool },
        aliceCaller,
        'propose_ontology_change',
        { change },
      )) as { id: string; version: number; status: string };
      expect(proposeResult.status).toBe('draft');

      // Alice sees her own draft.
      const aliceSees = await dispatchCapability({ pool }, aliceCaller, 'get_type', {
        typeName: 'Gadget',
      });
      expect(aliceSees).not.toBeNull();

      // Bob (a different Handle caller, same workspace) does not — I16.
      const bobCaller = handleCaller(workspaceId, bobId, ONTOLOGY_HANDLE_CAPABILITIES);
      const bobSees = await dispatchCapability({ pool }, bobCaller, 'get_type', {
        typeName: 'Gadget',
      });
      expect(bobSees).toBeNull();

      // A human (owner) publishes it — publish_ontology_version is channel:'human' only (I16).
      const ownerCaller = humanCaller(workspaceId, ownerId, 'owner');
      const publishResult = (await dispatchCapability(
        { pool },
        ownerCaller,
        'publish_ontology_version',
        { id: proposeResult.id, version: proposeResult.version },
      )) as { id: string; version: number; status: string; publishedAt: string | null };
      expect(publishResult.status).toBe('published');
      expect(publishResult.publishedAt).not.toBeNull();

      // Now Bob sees it too.
      const bobSeesNow = await dispatchCapability({ pool }, bobCaller, 'get_type', {
        typeName: 'Gadget',
      });
      expect(bobSeesNow).not.toBeNull();
    });
  },
);
