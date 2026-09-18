import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { registerSource } from '../../substrate/epistemic/index.js';
import { publishOntologyDomainPack } from '../../substrate/ontology/index.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/freshness.integration.test: DB-gated (real Postgres; auto-skip without
 * DATABASE_URL) coverage of S5.2 — freshness and the observation window (docs/development-tasks.md
 * §5b S5.2; migration core 0026; STATUS leftovers 28 / 38) — through `submit_observations` the
 * way a collector drives it, on a workspace with the ops-assets-v1 pack published:
 *
 *   1. a fresh Fact's `lastObservation*` is its origin; re-observing it unchanged advances
 *      `lastObservedAt` (`factsUnchanged`, no new row);
 *   2. `window: {complete: true, objectTypes: ['Container']}` retires the Container whose links the
 *      run did not re-submit — `invalidatedAt` set, `invalidationReason = 'not_reobserved'`,
 *      `factsInvalidated` counted, an audit row per window — while the Object stays and `explain`
 *      shows both the end and the last confirmation;
 *   3. a Fact of *another* Source at a Container is not touched by this Source's window;
 *   4. a Container that reappears gets a new Fact; the retired one stays retired;
 *   5. an empty submission with a window is the way to close a run whose last phase had no items.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const REPO_ROOT = path.resolve(KERNEL_ROOT, '..', '..');
const ONTOLOGY_DIR = path.join(REPO_ROOT, 'ontology');

interface FactLike {
  readonly id: string;
  readonly linkType: string;
  readonly invalidatedAt: string | null;
  readonly invalidationReason: string | null;
  readonly observationId: string | null;
  readonly lastObservationId: string | null;
  readonly lastObservedAt: string | null;
}

interface SubmitResult {
  readonly activityId: string;
  readonly factsAsserted: number;
  readonly factsUnchanged: number;
  readonly factsInvalidated: number;
  readonly objects: readonly {
    objectType: string;
    identity: Record<string, unknown>;
    id: string;
  }[];
}

function handleCaller(workspaceId: string, obo: string): ResolvedCaller {
  const now = Math.floor(Date.now() / 1000);
  return {
    channel: 'handle',
    claims: {
      ws: workspaceId,
      sid: randomUUID(),
      obo,
      scope: {
        capabilities: ['submit_observations', 'assert_fact', 'explain', 'get_object', 'traverse'],
        resources: {},
      },
      jti: randomUUID(),
      iat: now,
      exp: now + 600,
    },
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'S5.2 freshness and the not_reobserved observation window (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let sourceId: string;
    const hostname = `fresh-${randomUUID().slice(0, 8)}`;

    function call<T>(name: string, params: Record<string, unknown>): Promise<T> {
      return dispatchCapability(
        { pool },
        handleCaller(workspaceId, ownerId),
        name,
        params,
      ) as Promise<T>;
    }

    function containerItem(containerId: string) {
      return {
        objectType: 'Container',
        identity: { containerId },
        properties: { name: containerId },
        links: [{ linkType: 'runs_on', target: { objectType: 'Host', identity: { hostname } } }],
      };
    }

    async function activeRunsOnFacts(): Promise<Map<string, FactLike>> {
      const rows = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        client.query<{ id: string; container_id: string; invalidated_at: Date | null }>(
          `select l.id, s.identity_key ->> 'containerId' as container_id, l.invalidated_at
             from links l join objects s on s.workspace_id = l.workspace_id and s.id = l.source_object_id
            where l.workspace_id = $1 and l.link_type = 'runs_on' and s.object_type = 'Container'
              and s.identity_key ->> 'containerId' like 'fresh-%'
            order by l.recorded_at`,
          [workspaceId],
        ),
      );
      const byContainer = new Map<string, FactLike>();
      for (const row of rows.rows) {
        const fact = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          client.query<{
            id: string;
            link_type: string;
            invalidated_at: Date | null;
            invalidation_reason: string | null;
            observation_id: string | null;
            last_observation_id: string | null;
            last_observed_at: Date | null;
          }>(
            `select id, link_type, invalidated_at, invalidation_reason, observation_id,
                    last_observation_id, last_observed_at
               from links where workspace_id = $1 and id = $2`,
            [workspaceId, row.id],
          ),
        );
        const f = fact.rows[0];
        if (!f) continue;
        byContainer.set(`${row.container_id}:${f.id}`, {
          id: f.id,
          linkType: f.link_type,
          invalidatedAt: f.invalidated_at?.toISOString() ?? null,
          invalidationReason: f.invalidation_reason,
          observationId: f.observation_id,
          lastObservationId: f.last_observation_id,
          lastObservedAt: f.last_observed_at?.toISOString() ?? null,
        });
      }
      return byContainer;
    }

    function factsOf(map: Map<string, FactLike>, containerId: string): FactLike[] {
      return [...map.entries()]
        .filter(([key]) => key.startsWith(`${containerId}:`))
        .map(([, fact]) => fact);
    }

    async function openConflictCount(): Promise<number> {
      const rows = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        client.query<{ n: string }>(
          "select count(*)::text as n from conflicts where workspace_id = $1 and status = 'open'",
          [workspaceId],
        ),
      );
      return Number(rows.rows[0]?.n ?? '0');
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      const created = await createWorkspaceWithOwner(pool, {
        name: `freshness-${randomUUID().slice(0, 8)}`,
        owner: { displayName: 'Freshness Owner' },
        ontologyDir: ONTOLOGY_DIR,
      });
      workspaceId = created.workspaceId;
      ownerId = created.ownerPrincipalId;
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        publishOntologyDomainPack(client, workspaceId, {
          packName: 'ops-assets',
          fileName: 'ops-assets-v1.yaml',
          dir: ONTOLOGY_DIR,
          principalId: ownerId,
        }),
      );
      const source = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        registerSource(client, workspaceId, {
          kind: 'collector',
          ownerPrincipalId: ownerId,
          visibility: 'workspace',
          metadata: { name: 'freshness-test-collector' },
        }),
      );
      sourceId = source.id;
    }, 120_000);

    afterAll(async () => {
      await pool.end();
    });

    let firstRunLastObservedAt: string | null = null;

    it('run 1: two Containers on the Host; a fresh Fact is its own last confirmation', async () => {
      const result = await call<SubmitResult>('submit_observations', {
        sourceId,
        observations: [
          { objectType: 'Host', identity: { hostname } },
          containerItem('fresh-a'),
          containerItem('fresh-b'),
        ],
        window: { complete: true, objectTypes: ['Container'] },
      });
      expect(result.factsAsserted).toBe(2);
      expect(result.factsInvalidated).toBe(0);

      const facts = await activeRunsOnFacts();
      const a = factsOf(facts, 'fresh-a');
      expect(a).toHaveLength(1);
      expect(a[0]?.observationId).not.toBeNull();
      expect(a[0]?.lastObservationId).toBe(a[0]?.observationId);
      expect(a[0]?.lastObservedAt).not.toBeNull();
      firstRunLastObservedAt = a[0]?.lastObservedAt ?? null;

      const host = result.objects.find((o) => o.objectType === 'Host');
      const object = await call<{ lastObservedAt: string | null }>('get_object', {
        objectId: host?.id,
      });
      expect(object.lastObservedAt).not.toBeNull();
    });

    it('run 2: only fresh-a re-observed — its clock advances, fresh-b is retired not_reobserved, the Object stays', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const result = await call<SubmitResult>('submit_observations', {
        sourceId,
        observations: [containerItem('fresh-a')],
        window: { complete: true, objectTypes: ['Container'] },
      });
      expect(result.factsAsserted).toBe(0);
      expect(result.factsUnchanged).toBe(1);
      expect(result.factsInvalidated).toBe(1);

      const facts = await activeRunsOnFacts();
      const a = factsOf(facts, 'fresh-a')[0];
      const b = factsOf(facts, 'fresh-b')[0];
      expect(a?.invalidatedAt).toBeNull();
      expect(a?.lastObservedAt).not.toBe(firstRunLastObservedAt);
      expect(a?.lastObservationId).not.toBe(a?.observationId);
      expect(b?.invalidatedAt).not.toBeNull();
      expect(b?.invalidationReason).toBe('not_reobserved');

      // The Object is never invalidated by absence — its clock just stopped.
      const objectB = result.objects.find((o) => o.identity.containerId === 'fresh-b');
      expect(objectB).toBeUndefined(); // not touched by this run
      const containerA = result.objects.find((o) => o.identity.containerId === 'fresh-a')?.id;
      const traversed = await call<{ edges: readonly { linkId: string }[] }>('traverse', {
        fromId: containerA,
        linkType: 'runs_on',
        depth: 1,
      });
      expect(traversed.edges.map((e) => e.linkId)).toEqual([a?.id]);

      const explained = await call<{
        fact?: {
          invalidatedAt: string | null;
          invalidationReason: string | null;
          lastObservation: { id: string; source: { id: string } | null } | null;
        };
      }>('explain', { nodeId: b?.id });
      expect(explained.fact?.invalidationReason).toBe('not_reobserved');
      expect(explained.fact?.invalidatedAt).not.toBeNull();
      expect(explained.fact?.lastObservation?.source?.id).toBe(sourceId);

      const audit = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        client.query<{ payload: { count: number; objectTypes: string[] } }>(
          `select payload from audit_records
            where workspace_id = $1 and action = 'facts_not_reobserved' and resource_id = $2`,
          [workspaceId, result.activityId],
        ),
      );
      expect(audit.rows[0]?.payload).toMatchObject({ count: 1, objectTypes: ['Container'] });
    });

    it("another Source's Fact at a Container is outside this Source's window", async () => {
      const hostId = (
        await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          client.query<{ id: string }>(
            `select id from objects where workspace_id = $1 and object_type = 'Host'
               and identity_key ->> 'hostname' = $2`,
            [workspaceId, hostname],
          ),
        )
      ).rows[0]?.id;
      const containerA = (
        await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          client.query<{ id: string }>(
            `select id from objects where workspace_id = $1 and object_type = 'Container'
               and identity_key ->> 'containerId' = 'fresh-a'`,
            [workspaceId],
          ),
        )
      ).rows[0]?.id;
      // A human's own assertion (no Observation, a different origin) on the same identity would
      // be a Conflict; use a different LinkType so it is simply another Fact at this Container.
      const foreign = await call<{ id: string }>('assert_fact', {
        sourceObjectId: containerA,
        targetObjectId: hostId,
        linkType: 'part_of',
        properties: { note: 'asserted by the owner, not observed' },
      });

      const result = await call<SubmitResult>('submit_observations', {
        sourceId,
        observations: [containerItem('fresh-a')],
        window: { complete: true, objectTypes: ['Container'] },
      });
      expect(result.factsInvalidated).toBe(0);
      const still = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        client.query<{ invalidated_at: Date | null }>(
          'select invalidated_at from links where workspace_id = $1 and id = $2',
          [workspaceId, foreign.id],
        ),
      );
      expect(still.rows[0]?.invalidated_at).toBeNull();
    });

    it('run 3: fresh-b reappears — a new Fact; the retired one stays retired', async () => {
      const result = await call<SubmitResult>('submit_observations', {
        sourceId,
        observations: [containerItem('fresh-a'), containerItem('fresh-b')],
        window: { complete: true, objectTypes: ['Container'] },
      });
      expect(result.factsAsserted).toBe(1);
      expect(result.factsInvalidated).toBe(0);
      const b = factsOf(await activeRunsOnFacts(), 'fresh-b');
      expect(b).toHaveLength(2);
      expect(b.filter((f) => f.invalidatedAt === null)).toHaveLength(1);
      expect(b.filter((f) => f.invalidationReason === 'not_reobserved')).toHaveLength(1);
    });

    let collectorFactA: string | undefined;
    let foreignFactA: string | undefined;

    it('a second Source contradicts fresh-a (Conflict) — the collector still builds on its own Fact: unchanged, nothing retired, no second Conflict', async () => {
      const own = factsOf(await activeRunsOnFacts(), 'fresh-a').find(
        (f) => f.invalidatedAt === null,
      );
      collectorFactA = own?.id;
      expect(collectorFactA).toBeDefined();

      const second = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        registerSource(client, workspaceId, {
          kind: 'collector',
          ownerPrincipalId: ownerId,
          visibility: 'workspace',
          metadata: { name: 'freshness-second-source' },
        }),
      );
      const contradiction = await call<SubmitResult>('submit_observations', {
        sourceId: second.id,
        observations: [
          {
            ...containerItem('fresh-a'),
            links: [
              {
                linkType: 'runs_on',
                target: { objectType: 'Host', identity: { hostname } },
                properties: { marker: 'contradiction' },
              },
            ],
          },
        ],
      });
      expect(contradiction.factsAsserted).toBe(1);
      expect(await openConflictCount()).toBe(1);
      const active = factsOf(await activeRunsOnFacts(), 'fresh-a').filter(
        (f) => f.invalidatedAt === null,
      );
      expect(active).toHaveLength(2);
      foreignFactA = active.find((f) => f.id !== collectorFactA)?.id;
      expect(foreignFactA).toBeDefined();

      // Before 0027 the lookup returned only the newest active row — the second Source's — so
      // this run opened a second Conflict, inserted a third Fact, and its window then retired
      // the collector's own row as not_reobserved.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const result = await call<SubmitResult>('submit_observations', {
        sourceId,
        observations: [containerItem('fresh-a'), containerItem('fresh-b')],
        window: { complete: true, objectTypes: ['Container'] },
      });
      expect(result.factsAsserted).toBe(0);
      expect(result.factsUnchanged).toBe(2);
      expect(result.factsInvalidated).toBe(0);
      expect(await openConflictCount()).toBe(1);
      const after = factsOf(await activeRunsOnFacts(), 'fresh-a');
      const ownAfter = after.find((f) => f.id === collectorFactA);
      expect(ownAfter?.invalidatedAt).toBeNull();
      expect(ownAfter?.lastObservedAt).not.toBe(own?.lastObservedAt);
      expect(after.find((f) => f.id === foreignFactA)?.invalidatedAt).toBeNull();
    });

    it('run 4: an empty submission with a window closes the run — everything of the type is retired, another Source’s Fact is not', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const result = await call<SubmitResult>('submit_observations', {
        sourceId,
        observations: [],
        window: { complete: true, objectTypes: ['Container'] },
      });
      expect(result.factsInvalidated).toBe(2);
      const facts = [...(await activeRunsOnFacts()).values()];
      const stillActive = facts.filter((f) => f.invalidatedAt === null);
      expect(stillActive.map((f) => f.id)).toEqual([foreignFactA]);
    });
  },
);
