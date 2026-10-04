import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  explain,
  listSourceFreshness,
  registerSource,
  resolveFactOrigin,
  startActivity,
} from '../../substrate/epistemic/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { publishOntologyDomainPack } from '../../substrate/ontology/index.js';
import { dispatchCapability } from '../gateway/dispatch.js';
import type { ResolvedCaller } from '../gateway/resolve-caller.js';
import { createPlatformAdmin } from '../identity/index.js';
import { compactObservations } from './compact-observations.js';
import type { CompactObservationsResult } from './compact-observations.js';

/**
 * application/platform/compact-observations.integration.test: DB-gated (real Postgres; auto-skip
 * without DATABASE_URL) proof of STATUS leftover 103's retention rule, written as "every reader
 * answers the same before and after compaction" on seeded data:
 *
 *   - a collector Source with two real ingest runs, plus redundant pre-PR-#468-style rows on a run
 *     (deleted), a payload row (kept), an unreferenced row that is the Source's newest (kept), and
 *     a legacy Activity whose only link to the Source is three unreferenced rows (one kept) and
 *     whose Fact names no Observation (the observation window's Activity-level fallback);
 *   - a member's run on their own workspace Source, plus three rows of the member's *private*
 *     Source on that Activity (one kept) — the Facts stay hidden from the owner, visible to the
 *     member, and their origin stays the asserting principal (two Sources feed the Activity);
 *   - rows of another Source newer than the age gate (untouched).
 *
 * Every Observation of the workspace is backdated 40 days except the recent ones. Then: a dry run
 * changes nothing and predicts the executing run's counts; the executing run (windows of 3 rows, so
 * groups straddle windows) keeps origin, visibility, freshness and explain identical, writes one
 * unattributed audit row; a second run deletes nothing; a window run afterwards still retires a
 * Fact not re-observed — through its last Observation and through the Activity fallback.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const REPO_ROOT = path.resolve(KERNEL_ROOT, '..', '..');
const ONTOLOGY_DIR = path.join(REPO_ROOT, 'ontology');

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

const CAPABILITIES = ['register_source', 'submit_observations'];

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

interface Snapshot {
  readonly origins: Record<string, string>;
  readonly visibleToOwner: readonly string[];
  readonly visibleToMember: readonly string[];
  readonly freshness: Record<string, string>;
  readonly activitySources: Record<string, readonly string[]>;
}

describe.runIf(DATABASE_URL !== undefined)(
  'compactObservations (integration, real Postgres) — leftover 103',
  () => {
    const graphStore = new SqlGraphStore();
    let pool: Pool;
    const workspaceId = randomUUID();
    const ownerId = randomUUID();
    const memberId = randomUUID();
    const serviceId = randomUUID();
    const hostname = `compact-host-${randomUUID().slice(0, 8)}`;
    const composeProjectId = `compact-project-${hostname}`;
    const memberHost = `compact-member-host-${randomUUID().slice(0, 8)}`;

    let collectorSourceId: string;
    let recentSourceId: string;
    let memberSourceId: string;
    let privateSourceId: string;
    let run1: SubmitResult;
    let run2: SubmitResult;
    let memberRun: SubmitResult;
    let legacyActivityId: string;
    let legacyFactId: string;
    const redundantIds: string[] = [];
    const legacyRowIds: string[] = [];
    const privateRowIds: string[] = [];
    const recentRowIds: string[] = [];
    let payloadRowId: string;
    let sourceNewestRowId: string;
    let before: Snapshot;
    let dryRun: CompactObservationsResult;
    let executed: CompactObservationsResult;
    let rowsBeforeRun: number;

    const asLogin = <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> =>
      withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, { skipRoleSwitch: true });
    const asPrincipal = <T>(principalId: string, fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId }, fn);

    const container = (serviceName: string) => ({
      objectType: 'Container',
      identity: { composeProjectId, serviceName },
      links: [{ linkType: 'runs_on', target: { objectType: 'Host', identity: { hostname } } }],
    });
    const host = { objectType: 'Host', identity: { hostname } };

    async function insertObservation(
      activityId: string,
      sourceId: string,
      options: { readonly content?: Record<string, unknown>; readonly offsetSeconds?: number } = {},
    ): Promise<string> {
      const result = await asLogin((client) =>
        client.query<{ id: string }>(
          `insert into observations (workspace_id, source_id, activity_id, content, created_at)
           values ($1, $2, $3, $4::jsonb, now() + make_interval(secs => $5))
           returning id`,
          [
            workspaceId,
            sourceId,
            activityId,
            JSON.stringify(options.content ?? {}),
            options.offsetSeconds ?? 0,
          ],
        ),
      );
      return result.rows[0]?.id as string;
    }

    async function existing(ids: readonly string[]): Promise<Set<string>> {
      const result = await asLogin((client) =>
        client.query<{ id: string }>(
          'select id from observations where workspace_id = $1 and id = any($2::uuid[])',
          [workspaceId, ids],
        ),
      );
      return new Set(result.rows.map((row) => row.id));
    }

    async function rowCount(): Promise<number> {
      const result = await asLogin((client) =>
        client.query<{ n: number }>(
          'select count(*)::int as n from observations where workspace_id = $1',
          [workspaceId],
        ),
      );
      return result.rows[0]?.n ?? 0;
    }

    async function visibleLinks(principalId: string): Promise<string[]> {
      const result = await asPrincipal(principalId, (client) =>
        client.query<{ id: string }>('select id from links where workspace_id = $1 order by id', [
          workspaceId,
        ]),
      );
      return result.rows.map((row) => row.id);
    }

    async function snapshot(): Promise<Snapshot> {
      // Origin as `assertFact` resolves it, for every active Fact (the login role sees every
      // Observation, the true origin).
      const origins: Record<string, string> = {};
      await asLogin(async (client) => {
        const facts = await client.query<{ id: string; activity_id: string; asserted_by: string }>(
          `select id, activity_id, asserted_by from links
            where workspace_id = $1 and superseded_at is null and invalidated_at is null`,
          [workspaceId],
        );
        for (const fact of facts.rows) {
          const origin = await resolveFactOrigin(client, workspaceId, {
            activityId: fact.activity_id,
            assertedBy: fact.asserted_by,
          });
          origins[fact.id] = `${origin.kind}:${origin.id}`;
        }
      });
      const freshness: Record<string, string> = {};
      for (const row of await asPrincipal(ownerId, (client) =>
        listSourceFreshness(client, workspaceId, 24 * 60 * 60 * 1000),
      )) {
        freshness[row.sourceId] = `${row.lastObservedAt?.toISOString() ?? 'never'}:${row.silent}`;
      }
      // explain(activityId) for every Activity that has Observations, read by the member (who
      // owns the private Source, so sees every Source here): the Sources it lists.
      const activitySources: Record<string, readonly string[]> = {};
      const activities = await asLogin((client) =>
        client.query<{ activity_id: string }>(
          'select distinct activity_id from observations where workspace_id = $1',
          [workspaceId],
        ),
      );
      for (const { activity_id } of activities.rows) {
        const explained = await asPrincipal(memberId, (client) =>
          explain(client, workspaceId, { activityId: activity_id }),
        );
        activitySources[activity_id] = [
          ...new Set((explained.activity?.observations ?? []).map((o) => o.source?.id ?? 'hidden')),
        ].sort();
      }
      return {
        origins,
        visibleToOwner: await visibleLinks(ownerId),
        visibleToMember: await visibleLinks(memberId),
        freshness,
        activitySources,
      };
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      await asLogin(async (client) => {
        await client.query('insert into workspaces (id, name) values ($1, $2)', [
          workspaceId,
          `compact-observations-${workspaceId.slice(0, 8)}`,
        ]);
        for (const [id, kind, role] of [
          [ownerId, 'human', 'owner'],
          [memberId, 'human', 'member'],
          [serviceId, 'service', 'member'],
        ] as const) {
          await client.query(
            'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
            [workspaceId, id, kind, role, `${kind}-${role}`],
          );
        }
      });
      await asPrincipal(ownerId, (client) =>
        publishOntologyDomainPack(client, workspaceId, {
          packName: 'ops-assets',
          fileName: 'ops-assets-v1.yaml',
          dir: ONTOLOGY_DIR,
          principalId: ownerId,
        }),
      );

      const collector = handleCaller(workspaceId, serviceId, CAPABILITIES);
      const call = (caller: ResolvedCaller, name: string, params: Record<string, unknown>) =>
        dispatchCapability({ pool }, caller, name, params);
      collectorSourceId = (
        (await call(collector, 'register_source', {
          kind: 'host-inventory-collector',
          name: 'compact-collector',
          visibility: 'workspace',
        })) as { id: string }
      ).id;
      recentSourceId = (
        (await call(collector, 'register_source', {
          kind: 'host-inventory-collector',
          name: 'compact-recent',
          visibility: 'workspace',
        })) as { id: string }
      ).id;

      // Two real runs: run 2 re-confirms run 1's Facts.
      run1 = (await call(collector, 'submit_observations', {
        sourceId: collectorSourceId,
        observations: [host, container('a'), container('b'), container('c')],
      })) as SubmitResult;
      expect(run1.factsAsserted).toBe(3);
      await new Promise((resolve) => setTimeout(resolve, 20));
      run2 = (await call(collector, 'submit_observations', {
        sourceId: collectorSourceId,
        observations: [host, container('a'), container('b'), container('c')],
      })) as SubmitResult;
      expect(run2.factsUnchanged).toBe(3);

      // Pre-#468 per-item rows on run 1 (redundant: the run keeps its referenced row), a gate-style
      // payload row, and an unreferenced row that is the Source's newest.
      for (let i = 0; i < 5; i++) {
        redundantIds.push(await insertObservation(run1.activityId, collectorSourceId));
      }
      payloadRowId = await insertObservation(run1.activityId, collectorSourceId, {
        content: { operation: 'containers.list', result: { truncated: true } },
      });
      sourceNewestRowId = await insertObservation(run2.activityId, collectorSourceId, {
        offsetSeconds: 3600,
      });

      // A legacy Activity: three unreferenced rows of the collector Source and a Fact that names
      // no Observation (pre-0018 shape) — the window finds its Source only through the Activity.
      const hostObjectId = run1.objects.find((o) => o.objectType === 'Host')?.id as string;
      legacyActivityId = await asLogin(
        async (client) =>
          (
            await startActivity(client, workspaceId, {
              kind: 'ingest.submit_observations',
              principalId: serviceId,
              sourceId: collectorSourceId,
            })
          ).id,
      );
      for (let i = 0; i < 3; i++) {
        legacyRowIds.push(
          await insertObservation(legacyActivityId, collectorSourceId, { offsetSeconds: i - 10 }),
        );
      }
      legacyFactId = await asPrincipal(ownerId, async (client) => {
        const legacyContainer = await graphStore.upsertObject(client, workspaceId, {
          objectType: 'Container',
          identity: { composeProjectId, serviceName: 'legacy' },
          properties: {},
        });
        const fact = await graphStore.assertFact(
          client,
          workspaceId,
          { id: ownerId },
          {
            linkType: 'runs_on',
            sourceObjectId: legacyContainer.id,
            targetObjectId: hostObjectId,
            activityId: legacyActivityId,
            properties: {},
          },
        );
        return fact.id;
      });

      // The member's own run, plus their private Source observed on that Activity.
      const member = handleCaller(workspaceId, memberId, CAPABILITIES);
      memberSourceId = (
        (await call(member, 'register_source', {
          kind: 'test.compact-member',
          name: 'compact-member-source',
          visibility: 'workspace',
        })) as { id: string }
      ).id;
      memberRun = (await call(member, 'submit_observations', {
        sourceId: memberSourceId,
        observations: [
          { objectType: 'Host', identity: { hostname: memberHost } },
          {
            objectType: 'Container',
            identity: { composeProjectId: `compact-project-${memberHost}`, serviceName: 'x' },
            links: [
              {
                linkType: 'runs_on',
                target: { objectType: 'Host', identity: { hostname: memberHost } },
              },
            ],
          },
        ],
      })) as SubmitResult;
      expect(memberRun.factsAsserted).toBe(1);
      privateSourceId = await asLogin(
        async (client) =>
          (
            await registerSource(client, workspaceId, {
              kind: 'test.compact-private',
              ownerPrincipalId: memberId,
              visibility: 'private',
            })
          ).id,
      );
      for (let i = 0; i < 3; i++) {
        privateRowIds.push(
          await insertObservation(memberRun.activityId, privateSourceId, { offsetSeconds: i - 10 }),
        );
      }
      // The private Source's newest row is on another Activity, so (b) does not keep any of the
      // three above — which one survives is (c)'s decision alone.
      const memberSecondActivityId = await asLogin(
        async (client) =>
          (
            await startActivity(client, workspaceId, {
              kind: 'test.compact-member',
              principalId: memberId,
              sourceId: privateSourceId,
            })
          ).id,
      );
      await insertObservation(memberSecondActivityId, privateSourceId);

      // Everything so far is 40 days old …
      await asLogin((client) =>
        client.query(
          `update observations set created_at = created_at - interval '40 days'
            where workspace_id = $1`,
          [workspaceId],
        ),
      );
      // … except three unreferenced rows of another Source, newer than the gate.
      const recentActivityId = await asLogin(
        async (client) =>
          (
            await startActivity(client, workspaceId, {
              kind: 'ingest.submit_observations',
              principalId: serviceId,
              sourceId: recentSourceId,
            })
          ).id,
      );
      for (let i = 0; i < 3; i++) {
        recentRowIds.push(
          await insertObservation(recentActivityId, recentSourceId, { offsetSeconds: i - 10 }),
        );
      }
      before = await snapshot();
      // The fixture exercises what it claims to: the member's Facts are hidden from the owner,
      // and two Sources feed that Activity, so its origin is the asserting principal.
      const memberFacts = await asLogin((client) =>
        client.query<{ id: string }>(
          'select id from links where workspace_id = $1 and activity_id = $2',
          [workspaceId, memberRun.activityId],
        ),
      );
      const memberFactId = memberFacts.rows[0]?.id as string;
      expect(before.visibleToMember).toContain(memberFactId);
      expect(before.visibleToOwner).not.toContain(memberFactId);
      expect(before.origins[memberFactId]).toBe(`principal:${memberId}`);
      expect(before.origins[legacyFactId]).toBe(`source:${collectorSourceId}`);
    }, 120_000);

    afterAll(async () => {
      await pool.end();
    });

    it('a dry run deletes nothing, writes no audit row, and classifies every old row', async () => {
      rowsBeforeRun = await rowCount();
      dryRun = await compactObservations(pool, { confirm: false, workspaceId, batchSize: 3 });
      expect(dryRun.executed).toBe(false);
      expect(dryRun.auditRecordId).toBeNull();
      expect(await rowCount()).toBe(rowsBeforeRun);
      const ws = dryRun.workspaces.find((w) => w.workspaceId === workspaceId);
      expect(ws?.rowsBefore).toBe(rowsBeforeRun);
      expect(ws?.examined).toBe(rowsBeforeRun - recentRowIds.length);
      expect(
        (ws?.keptPayload ?? 0) +
          (ws?.keptReferenced ?? 0) +
          (ws?.keptSourceNewest ?? 0) +
          (ws?.keptLastOfActivitySource ?? 0) +
          (ws?.deleted ?? 0),
      ).toBe(ws?.examined);
      expect(ws?.keptPayload).toBe(1);
      // At least: the collector's unreferenced newest row and the private Source's newest.
      expect(ws?.keptSourceNewest).toBeGreaterThanOrEqual(2);
      // At least: the legacy pair's and the private pair's last rows.
      expect(ws?.keptLastOfActivitySource).toBeGreaterThanOrEqual(2);
      // At least: five redundant rows, two of the legacy pair, two of the private pair.
      expect(ws?.deleted).toBeGreaterThanOrEqual(9);
      const audit = await asLogin((client) =>
        client.query(
          `select id from audit_records
            where workspace_id is null and action = 'cli.observations_compacted'
              and payload ->> 'workspaceFilter' = $1`,
          [workspaceId],
        ),
      );
      expect(audit.rows).toHaveLength(0);
    });

    it('the executing run deletes exactly what the dry run predicted, and only redundant ingest rows', async () => {
      executed = await compactObservations(pool, { confirm: true, workspaceId, batchSize: 3 });
      const ws = executed.workspaces.find((w) => w.workspaceId === workspaceId);
      const dryWs = dryRun.workspaces.find((w) => w.workspaceId === workspaceId);
      expect(ws?.deleted).toBe(dryWs?.deleted);
      expect(ws?.examined).toBe(dryWs?.examined);
      expect(await rowCount()).toBe(rowsBeforeRun - (ws?.deleted ?? 0));
      expect(executed.batches).toBeGreaterThan(1);

      expect((await existing(redundantIds)).size).toBe(0);
      expect(await existing([payloadRowId])).toEqual(new Set([payloadRowId]));
      expect(await existing([sourceNewestRowId])).toEqual(new Set([sourceNewestRowId]));
      expect((await existing(recentRowIds)).size).toBe(recentRowIds.length);
      // Each unreferenced-only pair keeps exactly one row: its newest.
      const legacyLeft = await existing(legacyRowIds);
      expect([...legacyLeft]).toEqual([legacyRowIds[2]]);
      const privateLeft = await existing(privateRowIds);
      expect([...privateLeft]).toEqual([privateRowIds[2]]);
      // Every row a Fact references survived (the FK would have refused otherwise, but the
      // classification must never even try).
      const dangling = await asLogin((client) =>
        client.query(
          `select l.id from links l
            where l.workspace_id = $1
              and ((l.observation_id is not null and not exists (
                     select 1 from observations o where o.workspace_id = l.workspace_id and o.id = l.observation_id))
                or (l.last_observation_id is not null and not exists (
                     select 1 from observations o where o.workspace_id = l.workspace_id and o.id = l.last_observation_id)))`,
          [workspaceId],
        ),
      );
      expect(dangling.rows).toHaveLength(0);
    });

    it('origin, visibility, freshness and explain(activity) answer exactly as before', async () => {
      const after = await snapshot();
      expect(after.origins).toEqual(before.origins);
      expect(after.visibleToOwner).toEqual(before.visibleToOwner);
      expect(after.visibleToMember).toEqual(before.visibleToMember);
      expect(after.freshness).toEqual(before.freshness);
      expect(after.activitySources).toEqual(before.activitySources);
      for (const sources of Object.values(after.activitySources)) {
        expect(sources.length).toBeGreaterThanOrEqual(1);
      }
      // explain(fact) still has its origin Observation and its last confirmation.
      const factC = await asLogin((client) =>
        client.query<{ id: string }>(
          `select l.id from links l join objects s on s.workspace_id = l.workspace_id and s.id = l.source_object_id
            where l.workspace_id = $1 and l.activity_id = $2 and s.identity_key ->> 'serviceName' = 'c'`,
          [workspaceId, run1.activityId],
        ),
      );
      const explained = await asPrincipal(ownerId, (client) =>
        explain(client, workspaceId, { factId: factC.rows[0]?.id as string }),
      );
      expect(explained.activity?.observations.length).toBeGreaterThanOrEqual(1);
      expect(explained.activity?.observations[0]?.source?.id).toBe(collectorSourceId);
      expect(explained.fact?.lastObservation?.source?.id).toBe(collectorSourceId);
    });

    it('writes one unattributed cli.observations_compacted audit row with the parameters and per-workspace counts', async () => {
      const audit = await asLogin((client) =>
        client.query<{
          id: string;
          actor_user_id: string | null;
          payload: Record<string, unknown> & {
            workspaces: { workspaceId: string; deleted: number }[];
          };
        }>(
          `select id, actor_user_id, payload from audit_records
            where workspace_id is null and action = 'cli.observations_compacted'
              and payload ->> 'workspaceFilter' = $1`,
          [workspaceId],
        ),
      );
      expect(audit.rows).toHaveLength(1);
      const row = audit.rows[0];
      expect(row?.id).toBe(executed.auditRecordId);
      expect(row?.actor_user_id).toBeNull();
      expect(row?.payload).toMatchObject({
        attributedActor: false,
        olderThanDays: 30,
        batchSize: 3,
        completed: true,
      });
      expect(row?.payload.workspaces.find((w) => w.workspaceId === workspaceId)?.deleted).toBe(
        executed.workspaces.find((w) => w.workspaceId === workspaceId)?.deleted,
      );
    });

    it('a second run deletes nothing (idempotent) and, given an operator, writes an attributed audit row', async () => {
      const admin = await createPlatformAdmin(pool, {
        login: `compact-${randomUUID().slice(0, 12)}`,
        displayName: 'Compaction Operator',
        password: 'a-strong-enough-password',
      });
      const rowsBefore = await rowCount();
      const second = await compactObservations(pool, {
        confirm: true,
        workspaceId,
        actorUserId: admin.id,
      });
      expect(second.workspaces.find((w) => w.workspaceId === workspaceId)?.deleted).toBe(0);
      expect(await rowCount()).toBe(rowsBefore);
      const audit = await asLogin((client) =>
        client.query<{ actor_user_id: string | null; payload: { attributedActor: boolean } }>(
          'select actor_user_id, payload from audit_records where workspace_id is null and id = $1',
          [second.auditRecordId],
        ),
      );
      expect(audit.rows[0]?.actor_user_id).toBe(admin.id);
      expect(audit.rows[0]?.payload.attributedActor).toBe(true);
    });

    it('after compaction a window run still retires the Facts not re-observed — through the last Observation and through the Activity fallback', async () => {
      const collector = handleCaller(workspaceId, serviceId, CAPABILITIES);
      const result = (await dispatchCapability({ pool }, collector, 'submit_observations', {
        sourceId: collectorSourceId,
        observations: [host, container('a'), container('b')],
        window: { complete: true, objectTypes: ['Container'] },
      })) as SubmitResult;
      expect(result.factsUnchanged).toBe(2);
      expect(result.factsInvalidated).toBe(2);
      const retired = await asLogin((client) =>
        client.query<{ id: string; service_name: string; invalidation_reason: string | null }>(
          `select l.id, s.identity_key ->> 'serviceName' as service_name, l.invalidation_reason
             from links l join objects s on s.workspace_id = l.workspace_id and s.id = l.source_object_id
            where l.workspace_id = $1 and l.link_type = 'runs_on' and l.invalidated_at is not null
              and s.identity_key ->> 'composeProjectId' = $2`,
          [workspaceId, composeProjectId],
        ),
      );
      expect(retired.rows.map((r) => r.service_name).sort()).toEqual(['c', 'legacy']);
      expect(retired.rows.find((r) => r.service_name === 'legacy')?.id).toBe(legacyFactId);
      for (const row of retired.rows) expect(row.invalidation_reason).toBe('not_reobserved');
    });
  },
);
