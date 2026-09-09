import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  attachEvidence,
  recordSourceObservation,
  registerPrivateSource,
  startActivity,
} from '../../substrate/epistemic/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { dispatchCapability, isResultValidationEnabled } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/epistemic-handlers.integration.test: DB-gated (real Postgres; auto-skip
 * without DATABASE_URL) proof that the seven S3.2 `epistemic`-group capabilities are wired
 * end-to-end through `dispatchCapability` — `authorizeCapabilityCall`, `paramsSchema` validation,
 * and `resultSchema` validation (`KERNEL_VALIDATE_RESULTS=1`) all only run on this path, same
 * convention `ontology-handlers.integration.test.ts` already established for its own five.
 * `conflicts.test.ts` (substrate/epistemic) already covers the T0.4 three-step scenario and
 * private-Source visibility directly against `SqlGraphStore.assertFact` — this file seeds its own
 * Conflict/Fact/Decision fixtures the same way and focuses on the seven handlers' own wiring.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

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

/** Mirrors `ontology-handlers.integration.test.ts`'s own `handleCaller` — a fabricated Handle
 *  caller carrying exactly the capability names it needs. */
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

const READ_CAPABILITIES = [
  'list_conflicts',
  'query_decisions',
  'find_precedents',
  'causal_chain',
  'decision_impact',
];

describe.runIf(DATABASE_URL !== undefined)(
  'epistemic-handlers (integration, real Postgres, dispatchCapability)',
  () => {
    let pool: Pool;
    const store = new SqlGraphStore();
    let workspaceId: string;
    let ownerId: string;
    let memberId: string;

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
      workspaceId = await adminInsertWorkspace('epistemic-handlers-test-workspace');
      ownerId = await adminInsertPrincipal('owner', 'owner');
      memberId = await adminInsertPrincipal('member', 'member');
    });

    afterAll(async () => {
      await pool.end();
    });

    it('KERNEL_VALIDATE_RESULTS=1 is on for this test run (sanity check for the resultSchema assertions below)', () => {
      expect(isResultValidationEnabled()).toBe(true);
    });

    it('list_conflicts finds an open Conflict opened by assertFact, and resolve_conflict (keep_a) resolves it', async () => {
      const { factAId, factBId } = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const objectA = await store.upsertObject(client, workspaceId, {
            objectType: 'test.host',
            identity: { hostname: `resolve-${randomUUID()}` },
          });
          const objectB = await store.upsertObject(client, workspaceId, {
            objectType: 'test.service',
            identity: { name: `resolve-svc-${randomUUID()}` },
          });

          const sourceS1 = await registerPrivateSource(client, workspaceId, {
            kind: 'test.collector',
            ownerPrincipalId: ownerId,
          });
          const sourceS2 = await registerPrivateSource(client, workspaceId, {
            kind: 'test.collector',
            ownerPrincipalId: ownerId,
          });

          const activityA = await startActivity(client, workspaceId, { kind: 'test.ingest' });
          await recordSourceObservation(client, workspaceId, {
            sourceId: sourceS1.id,
            activityId: activityA.id,
          });
          const factA = await store.assertFact(
            client,
            workspaceId,
            { id: ownerId, kind: 'human' },
            {
              linkType: 'test.runs_on',
              sourceObjectId: objectB.id,
              targetObjectId: objectA.id,
              activityId: activityA.id,
            },
          );

          const activityB = await startActivity(client, workspaceId, { kind: 'test.ingest' });
          await recordSourceObservation(client, workspaceId, {
            sourceId: sourceS2.id,
            activityId: activityB.id,
          });
          const factB = await store.assertFact(
            client,
            workspaceId,
            { id: ownerId, kind: 'human' },
            {
              linkType: 'test.runs_on',
              sourceObjectId: objectB.id,
              targetObjectId: objectA.id,
              activityId: activityB.id,
            },
          );

          return { factAId: factA.id, factBId: factB.id };
        },
      );

      const listCaller = handleCaller(workspaceId, ownerId, READ_CAPABILITIES);
      const page = (await dispatchCapability({ pool }, listCaller, 'list_conflicts', {
        status: 'open',
      })) as {
        items: Array<{ id: string; factAId: string; factBId: string; status: string }>;
      };
      const conflict = page.items.find(
        (item) =>
          (item.factAId === factAId && item.factBId === factBId) ||
          (item.factAId === factBId && item.factBId === factAId),
      );
      expect(conflict).toBeDefined();
      if (!conflict) throw new Error('unreachable');

      // resolve_conflict is channel:'human' — a Handle caller is rejected.
      await expect(
        dispatchCapability({ pool }, listCaller, 'resolve_conflict', {
          conflictId: conflict.id,
          resolution: 'keep_a',
          reason: 'test',
        }),
      ).rejects.toThrow(/human-channel-only/);

      const ownerCaller = humanCaller(workspaceId, ownerId, 'owner');
      const resolved = (await dispatchCapability({ pool }, ownerCaller, 'resolve_conflict', {
        conflictId: conflict.id,
        resolution: conflict.factAId === factAId ? 'keep_a' : 'keep_b',
        reason: 'factA is correct',
      })) as { id: string; status: string; resolvedBy: string | null };
      expect(resolved.status).toBe('resolved');
      expect(resolved.resolvedBy).toBe(ownerId);

      // The losing Fact (factB) is now invalidated; the winning Fact (factA) is untouched.
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const rows = await client.query<{ id: string; invalidated_at: Date | null }>(
          'select id, invalidated_at from links where workspace_id = $1 and id = any($2::uuid[])',
          [workspaceId, [factAId, factBId]],
        );
        const a = rows.rows.find((row) => row.id === factAId);
        const b = rows.rows.find((row) => row.id === factBId);
        expect(a?.invalidated_at).toBeNull();
        expect(b?.invalidated_at).not.toBeNull();
      });

      // Resolving an already-resolved Conflict is an illegal transition.
      await expect(
        dispatchCapability({ pool }, ownerCaller, 'resolve_conflict', {
          conflictId: conflict.id,
          resolution: 'keep_a',
          reason: 'again',
        }),
      ).rejects.toThrow();

      // query_decisions({objectId: objectA}) finds the Decision resolve_conflict recorded — its
      // rationale carries `factAId`/`factBId`, both of which touch objectA.
      const decisionsPage = (await dispatchCapability(
        { pool },
        handleCaller(workspaceId, ownerId, READ_CAPABILITIES),
        'query_decisions',
        {},
      )) as { items: Array<{ id: string; rationale: Record<string, unknown> | null }> };
      const decision = decisionsPage.items.find(
        (item) => item.rationale?.conflictId === conflict.id,
      );
      expect(decision).toBeDefined();

      // decision_impact(decisionId) surfaces the same two Facts.
      if (decision) {
        const impact = (await dispatchCapability(
          { pool },
          handleCaller(workspaceId, ownerId, READ_CAPABILITIES),
          'decision_impact',
          { decisionId: decision.id },
        )) as { facts: Array<{ id: string }> };
        const factIds = impact.facts.map((f) => f.id);
        expect(factIds).toEqual(expect.arrayContaining([factAId, factBId]));

        // causal_chain(decisionId) reaches the Decision itself.
        const chain = (await dispatchCapability(
          { pool },
          handleCaller(workspaceId, ownerId, READ_CAPABILITIES),
          'causal_chain',
          { decisionId: decision.id },
        )) as { rootType: string; chain: unknown[] };
        expect(chain.rootType).toBe('decision');
        expect(chain.chain.length).toBeGreaterThan(0);
      }
    });

    it('verify_fact requires Evidence on file (I3.6), then promotes epistemic_status', async () => {
      const factId = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const objectA = await store.upsertObject(client, workspaceId, {
            objectType: 'test.host',
            identity: { hostname: `verify-${randomUUID()}` },
          });
          const objectB = await store.upsertObject(client, workspaceId, {
            objectType: 'test.service',
            identity: { name: `verify-svc-${randomUUID()}` },
          });
          const activity = await startActivity(client, workspaceId, { kind: 'test.ingest' });
          const fact = await store.assertFact(
            client,
            workspaceId,
            { id: ownerId, kind: 'human' },
            {
              linkType: 'test.runs_on',
              sourceObjectId: objectB.id,
              targetObjectId: objectA.id,
              activityId: activity.id,
            },
          );
          return fact.id;
        },
      );

      const ownerCaller = humanCaller(workspaceId, ownerId, 'owner');

      await expect(
        dispatchCapability({ pool }, ownerCaller, 'verify_fact', { factId }),
      ).rejects.toThrow(/no Evidence on file/);

      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        attachEvidence(client, workspaceId, {
          linkId: factId,
          kind: 'test.evidence',
          content: { note: 'looks right' },
          createdBy: ownerId,
        }),
      );

      const verified = (await dispatchCapability({ pool }, ownerCaller, 'verify_fact', {
        factId,
      })) as { epistemicStatus: string; verifiedBy: string | null };
      expect(verified.epistemicStatus).toBe('verified');
      expect(verified.verifiedBy).toBe(ownerId);
    });

    it('find_precedents(objectId) and find_precedents() with neither param', async () => {
      const caller = handleCaller(workspaceId, memberId, READ_CAPABILITIES);
      const empty = (await dispatchCapability({ pool }, caller, 'find_precedents', {})) as {
        items: unknown[];
      };
      expect(empty.items).toEqual([]);

      const byObject = (await dispatchCapability({ pool }, caller, 'find_precedents', {
        objectId: randomUUID(),
      })) as { items: unknown[] };
      expect(Array.isArray(byObject.items)).toBe(true);
    });
  },
);
