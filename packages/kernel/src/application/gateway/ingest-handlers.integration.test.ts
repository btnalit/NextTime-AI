import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { listSourceFreshness, resolveFactOrigin } from '../../substrate/epistemic/index.js';
import { publishOntologyDomainPack } from '../../substrate/ontology/index.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability, isResultValidationEnabled } from './dispatch.js';
import { SourceIdentityConflictError } from './ingest-handlers.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/ingest-handlers.integration.test: DB-gated (real Postgres; auto-skip
 * without DATABASE_URL) proof that `register_source`/`submit_observations` are wired end-to-end
 * through `dispatchCapability` (docs/development-tasks.md S3.3), and specifically the task's own
 * acceptance criteria: register a Source once, submit identical observations twice → no duplicate
 * Object/Fact rows and no Conflict opened; a third submission with a changed property → the prior
 * Fact is superseded; an observation whose identity is missing a required key field → 400
 * (`ObservationIdentityError`); an unknown `sourceId` → 404 (`SourceNotFoundError`).
 *
 * "No duplicate, no Conflict" (S3.2, merged to `main` while this task was in flight) concretely
 * means: exactly one active (non-superseded, non-invalidated) Fact ever exists per edge, and the
 * `conflicts` table gains no row for it. Since the S3.2 followup ("idempotent re-assertion",
 * docs/development-tasks.md) it also means a *literal* no-op write for an identical resubmission:
 * `SqlGraphStore.assertFact`'s same-origin branch now compares content first
 * (`store.ts`'s `factContentEquals`) and only delegates to `supersedeFact` when it actually
 * differs — an identical second submission returns the *same* Fact row unchanged (`factsAsserted:
 * 0, factsSuperseded: 0, factsUnchanged: 1`), which is exactly what stops a collector re-running
 * unchanged observations on a schedule from growing `links` by one row per run forever. A
 * genuinely *changed* re-assertion (run 3 below) still supersedes exactly as before
 * (`substrate/epistemic/conflicts.test.ts`'s own T0.4 case exercises the cross-source variant of
 * this same branch).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const REPO_ROOT = path.resolve(KERNEL_ROOT, '..', '..');
const ONTOLOGY_DIR = path.join(REPO_ROOT, 'ontology');

/** A fabricated Handle caller carrying exactly the capability names it needs — same convention
 *  `ontology-handlers.integration.test.ts`/`epistemic-handlers.integration.test.ts` already use
 *  (no `minRole` check applies to the handle channel, `authorize.ts`'s own documented shape). */
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

/** A human-channel caller (the console / an API key) — same shape `fact-handlers.integration.
 *  test.ts` uses. */
function humanCaller(
  workspaceId: string,
  principalId: string,
  role: 'owner' | 'member',
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

const INGEST_CAPABILITIES = ['register_source', 'submit_observations'];

interface SubmitObservationsResult {
  readonly activityId: string;
  readonly objectsUpserted: number;
  readonly factsAsserted: number;
  readonly factsSuperseded: number;
  readonly factsUnchanged: number;
  readonly objects: readonly {
    objectType: string;
    identity: Record<string, unknown>;
    id: string;
  }[];
}

describe.runIf(DATABASE_URL !== undefined)(
  'ingest-handlers (integration, real Postgres, dispatchCapability)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let servicePrincipalId: string;
    let memberId: string;

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);

      workspaceId = randomUUID();
      ownerId = randomUUID();
      servicePrincipalId = randomUUID();
      memberId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'ingest-handlers-test-workspace',
          ]);
          await client.query(
            'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
            [workspaceId, ownerId, 'human', 'owner', 'owner'],
          );
          await client.query(
            'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
            [workspaceId, memberId, 'human', 'member', 'member'],
          );
          // Mirrors collectors/host-inventory's own real identity: a `kind='service'` Principal,
          // minted a scoped Handle by `cli/bootstrap.ts`'s `issue-service-handle` in production
          // (this test fabricates the claims directly instead — see `handleCaller` above).
          await client.query(
            'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
            [workspaceId, servicePrincipalId, 'service', 'member', 'collector:test'],
          );
        },
        { skipRoleSwitch: true },
      );

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

    it('register_source (workspace visibility) returns a real Source; name is projected from metadata', async () => {
      const caller = handleCaller(workspaceId, servicePrincipalId, INGEST_CAPABILITIES);
      const result = (await dispatchCapability({ pool }, caller, 'register_source', {
        kind: 'host-inventory-collector',
        name: 'host-inventory (test)',
        visibility: 'workspace',
      })) as {
        id: string;
        kind: string;
        name: string;
        ownerPrincipalId: string;
        visibility: string;
      };

      expect(result.kind).toBe('host-inventory-collector');
      expect(result.name).toBe('host-inventory (test)');
      expect(result.ownerPrincipalId).toBe(servicePrincipalId);
      expect(result.visibility).toBe('workspace');
    });

    describe('S5.3: register_source is idempotent on (kind, name)', () => {
      const params = {
        kind: 'host-inventory-collector',
        name: 'idempotent-collector',
        visibility: 'workspace' as const,
      };

      it('the same caller registering the same (kind, name) twice gets one Source: created true, then false', async () => {
        const caller = handleCaller(workspaceId, servicePrincipalId, INGEST_CAPABILITIES);
        const first = (await dispatchCapability({ pool }, caller, 'register_source', params)) as {
          id: string;
          created: boolean;
        };
        const second = (await dispatchCapability({ pool }, caller, 'register_source', params)) as {
          id: string;
          created: boolean;
        };
        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        expect(second.id).toBe(first.id);
        const rows = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          client.query(
            "select id from sources where workspace_id = $1 and kind = $2 and name = 'idempotent-collector'",
            [workspaceId, params.kind],
          ),
        );
        expect(rows.rows).toHaveLength(1);
      });

      it('the same name with the other visibility is 409 source_identity_conflict', async () => {
        const caller = handleCaller(workspaceId, servicePrincipalId, INGEST_CAPABILITIES);
        await expect(
          dispatchCapability({ pool }, caller, 'register_source', {
            ...params,
            visibility: 'private',
          }),
        ).rejects.toBeInstanceOf(SourceIdentityConflictError);
      });

      it('another principal cannot take over a workspace-visible name it can see — 409, no second row', async () => {
        const other = handleCaller(workspaceId, memberId, INGEST_CAPABILITIES);
        await expect(
          dispatchCapability({ pool }, other, 'register_source', params),
        ).rejects.toBeInstanceOf(SourceIdentityConflictError);
      });

      it("another principal's *private* Source of the same (kind, name) is invisible to the lookup — the unique index still makes it a 409", async () => {
        const secret = {
          kind: 'test.private-kind',
          name: 'secret',
          visibility: 'private' as const,
        };
        await dispatchCapability(
          { pool },
          handleCaller(workspaceId, servicePrincipalId, INGEST_CAPABILITIES),
          'register_source',
          secret,
        );
        await expect(
          dispatchCapability(
            { pool },
            handleCaller(workspaceId, memberId, INGEST_CAPABILITIES),
            'register_source',
            secret,
          ),
        ).rejects.toBeInstanceOf(SourceIdentityConflictError);
      });
    });

    it('register_source never trusts a caller-supplied owner — always the calling principal', async () => {
      const caller = handleCaller(workspaceId, servicePrincipalId, INGEST_CAPABILITIES);
      const result = (await dispatchCapability({ pool }, caller, 'register_source', {
        kind: 'test.private-source',
        name: 'private',
        visibility: 'private',
        // paramsSchema is `.strict()` — an `ownerPrincipalId` field would be a 400, not silently
        // ignored; this test asserts the *param shape itself* carries no such field by never
        // passing one and confirming the result's owner is the Handle's own `obo`.
      })) as { ownerPrincipalId: string };
      expect(result.ownerPrincipalId).toBe(servicePrincipalId);
    });

    it('submit_observations: identity missing a required key field → 400 (ObservationIdentityError)', async () => {
      const caller = handleCaller(workspaceId, servicePrincipalId, INGEST_CAPABILITIES);
      const source = (await dispatchCapability({ pool }, caller, 'register_source', {
        kind: 'host-inventory-collector',
        name: 'identity-test-source',
        visibility: 'workspace',
      })) as { id: string };

      await expect(
        dispatchCapability({ pool }, caller, 'submit_observations', {
          sourceId: source.id,
          observations: [{ objectType: 'Host', identity: {} }], // Host requires `hostname`
        }),
      ).rejects.toMatchObject({ name: 'ObservationIdentityError' });
    });

    it('submit_observations: unknown ObjectType → 400 (ObservationIdentityError)', async () => {
      const caller = handleCaller(workspaceId, servicePrincipalId, INGEST_CAPABILITIES);
      const source = (await dispatchCapability({ pool }, caller, 'register_source', {
        kind: 'host-inventory-collector',
        name: 'unknown-type-test-source',
        visibility: 'workspace',
      })) as { id: string };

      await expect(
        dispatchCapability({ pool }, caller, 'submit_observations', {
          sourceId: source.id,
          observations: [{ objectType: 'NoSuchType', identity: { x: 1 } }],
        }),
      ).rejects.toMatchObject({ name: 'ObservationIdentityError' });
    });

    it('submit_observations: unknown sourceId → 404 (SourceNotFoundError)', async () => {
      const caller = handleCaller(workspaceId, servicePrincipalId, INGEST_CAPABILITIES);
      await expect(
        dispatchCapability({ pool }, caller, 'submit_observations', {
          sourceId: randomUUID(),
          observations: [{ objectType: 'Host', identity: { hostname: 'h1' } }],
        }),
      ).rejects.toMatchObject({ name: 'SourceNotFoundError' });
    });

    it('submit_observations twice with identical observations → no duplicate Object/Fact rows, ' +
      'no Conflict; a third submission with a changed link property supersedes the prior Fact ' +
      '(S3.3 acceptance)', async () => {
      const caller = handleCaller(workspaceId, servicePrincipalId, INGEST_CAPABILITIES);
      const source = (await dispatchCapability({ pool }, caller, 'register_source', {
        kind: 'host-inventory-collector',
        name: 'idempotency-test-source',
        visibility: 'workspace',
      })) as { id: string };

      const hostname = `test-host-${randomUUID()}`;
      const composeProjectId = randomUUID(); // stand-in for a real ComposeProject Object id
      const observationsWithPort = (port: number) => [
        { objectType: 'Host', identity: { hostname } },
        {
          objectType: 'Container',
          identity: { composeProjectId, serviceName: 'web' },
          properties: { image: 'nginx:latest' },
          links: [
            {
              linkType: 'runs_on',
              target: { objectType: 'Host', identity: { hostname } },
              properties: { port },
            },
          ],
        },
      ];

      // --- Run 1: first-ever observation of this edge.
      const run1 = (await dispatchCapability({ pool }, caller, 'submit_observations', {
        sourceId: source.id,
        observations: observationsWithPort(8080),
      })) as SubmitObservationsResult;
      expect(run1.objectsUpserted).toBe(2);
      expect(run1.factsAsserted).toBe(1);
      expect(run1.factsSuperseded).toBe(0);
      expect(run1.factsUnchanged).toBe(0);
      expect(run1.objects).toHaveLength(2);
      const hostObjectId = run1.objects.find((o) => o.objectType === 'Host')?.id;
      const containerObjectId = run1.objects.find((o) => o.objectType === 'Container')?.id;
      expect(hostObjectId).toBeTruthy();
      expect(containerObjectId).toBeTruthy();

      const activeFactId = async (): Promise<string | undefined> =>
        withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
          const rows = await client.query<{ id: string }>(
            `select id from links
               where workspace_id = $1 and source_object_id = $2 and target_object_id = $3
                 and link_type = 'runs_on' and superseded_at is null and invalidated_at is null`,
            [workspaceId, containerObjectId, hostObjectId],
          );
          return rows.rows[0]?.id;
        });
      const run1FactId = await activeFactId();
      expect(run1FactId).toBeTruthy();

      // W5: submit_observations threads the call's Observation id (one per call since leftover
      // 103) into assertFact's observationId, and that Observation is recorded under run1's own
      // Activity.
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const factRows = await client.query<{ observation_id: string | null }>(
          'select observation_id from links where workspace_id = $1 and id = $2',
          [workspaceId, run1FactId],
        );
        const observationId = factRows.rows[0]?.observation_id;
        expect(observationId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/i));

        const observationRows = await client.query<{ activity_id: string }>(
          'select activity_id from observations where workspace_id = $1 and id = $2',
          [workspaceId, observationId],
        );
        expect(observationRows.rows[0]?.activity_id).toBe(run1.activityId);
      });

      // --- Run 2: identical resubmission, same origin (same Source) — the S3.2 followup no-op
      // path: content-identical, so `assertFact` writes nothing and returns the *same* Fact row.
      const run2 = (await dispatchCapability({ pool }, caller, 'submit_observations', {
        sourceId: source.id,
        observations: observationsWithPort(8080),
      })) as SubmitObservationsResult;
      expect(run2.factsAsserted).toBe(0);
      expect(run2.factsSuperseded).toBe(0);
      expect(run2.factsUnchanged).toBe(1);
      expect(run2.objects.find((o) => o.objectType === 'Host')?.id).toBe(hostObjectId);
      expect(run2.objects.find((o) => o.objectType === 'Container')?.id).toBe(containerObjectId);

      await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const objectRows = await client.query(
          'select count(*)::int as count from objects where workspace_id = $1 and id = $2',
          [workspaceId, containerObjectId],
        );
        expect(objectRows.rows[0]?.count).toBe(1); // no duplicate Object row.

        const activeFacts = await client.query(
          `select id, properties from links
             where workspace_id = $1 and source_object_id = $2 and target_object_id = $3
               and link_type = 'runs_on' and superseded_at is null and invalidated_at is null`,
          [workspaceId, containerObjectId, hostObjectId],
        );
        expect(activeFacts.rows).toHaveLength(1); // still exactly one active Fact.
        expect(activeFacts.rows[0]?.id).toBe(run1FactId); // the *same* row — no supersede happened.
        expect(activeFacts.rows[0]?.properties).toEqual({ port: 8080 });

        const conflicts = await client.query(
          `select count(*)::int as count from conflicts
             where workspace_id = $1 and (link_a_id in (select id from links where workspace_id = $1 and target_object_id = $2))`,
          [workspaceId, hostObjectId],
        );
        expect(conflicts.rows[0]?.count).toBe(0); // no Conflict.

        // No FactAsserted outbox row for the no-op — run 1's real insert produced exactly one.
        const outboxRows = await client.query(
          `select count(*)::int as count from outbox
             where workspace_id = $1 and event_type = 'FactAsserted' and payload->>'factId' = $2`,
          [workspaceId, run1FactId],
        );
        expect(outboxRows.rows[0]?.count).toBe(1);
      });

      // --- Run 3: changed port → old (run 1/2's) Fact superseded, new value visible.
      const run3 = (await dispatchCapability({ pool }, caller, 'submit_observations', {
        sourceId: source.id,
        observations: observationsWithPort(9090),
      })) as SubmitObservationsResult;
      expect(run3.factsAsserted).toBe(0);
      expect(run3.factsSuperseded).toBe(1);
      expect(run3.factsUnchanged).toBe(0);

      await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const activeFacts = await client.query(
          `select id, properties from links
             where workspace_id = $1 and source_object_id = $2 and target_object_id = $3
               and link_type = 'runs_on' and superseded_at is null and invalidated_at is null`,
          [workspaceId, containerObjectId, hostObjectId],
        );
        expect(activeFacts.rows).toHaveLength(1); // still exactly one active Fact.
        expect(activeFacts.rows[0]?.id).not.toBe(run1FactId); // a genuine new row this time.
        expect(activeFacts.rows[0]?.properties).toEqual({ port: 9090 }); // the new value.
      });
    });

    it('a Fact from a workspace-visibility Source is visible to a different human principal (runbook verification step)', async () => {
      const caller = handleCaller(workspaceId, servicePrincipalId, INGEST_CAPABILITIES);
      const source = (await dispatchCapability({ pool }, caller, 'register_source', {
        kind: 'host-inventory-collector',
        name: 'visibility-test-source',
        visibility: 'workspace',
      })) as { id: string };

      const hostname = `visibility-host-${randomUUID()}`;
      const composeProjectId = randomUUID();
      const result = (await dispatchCapability({ pool }, caller, 'submit_observations', {
        sourceId: source.id,
        observations: [
          { objectType: 'Host', identity: { hostname } },
          {
            objectType: 'Container',
            identity: { composeProjectId, serviceName: 'web' },
            links: [
              {
                linkType: 'runs_on',
                target: { objectType: 'Host', identity: { hostname } },
              },
            ],
          },
        ],
      })) as SubmitObservationsResult;
      const hostObjectId = result.objects.find((o) => o.objectType === 'Host')?.id;
      expect(hostObjectId).toBeTruthy();

      // A *different* human principal (never the collector's own service Principal) reads the
      // Fact back under its own RLS-scoped session — this is what `explain`/`find_*`
      // (docs/runbooks/host-collector.md's own verification step) rely on.
      await withWorkspace(pool, { workspaceId, principalId: memberId }, async (client) => {
        const visible = await client.query(
          `select id from links
           where workspace_id = $1 and target_object_id = $2 and link_type = 'runs_on'
             and superseded_at is null and invalidated_at is null`,
          [workspaceId, hostObjectId],
        );
        expect(visible.rows.length).toBeGreaterThan(0);
      });
    });

    // STATUS leftover 103: one `submit_observations` call writes ONE Observation per (activity,
    // source) — a call has exactly one of each — and every Fact it asserts or re-confirms points at
    // it, instead of one row per item. Every reader that depends on Observations answers what it
    // did with one row per item: origin (`resolveFactOrigin`), freshness (`listSourceFreshness`),
    // `explain` (Fact and Activity) and the observation window.
    it('leftover 103: one call with N items writes one Observation per (activity, source); origin, freshness, explain and the window read it as before', async () => {
      const caller = handleCaller(workspaceId, servicePrincipalId, [
        ...INGEST_CAPABILITIES,
        'explain',
      ]);
      const source = (await dispatchCapability({ pool }, caller, 'register_source', {
        kind: 'host-inventory-collector',
        name: 'one-observation-per-call-source',
        visibility: 'workspace',
      })) as { id: string };
      const hostname = `opc-host-${randomUUID()}`;
      const composeProjectId = `opc-project-${hostname}`;
      const container = (serviceName: string) => ({
        objectType: 'Container',
        identity: { composeProjectId, serviceName },
        links: [{ linkType: 'runs_on', target: { objectType: 'Host', identity: { hostname } } }],
      });
      const host = { objectType: 'Host', identity: { hostname } };
      const submit = async (params: Record<string, unknown>) =>
        (await dispatchCapability({ pool }, caller, 'submit_observations', {
          sourceId: source.id,
          ...params,
        })) as SubmitObservationsResult & { factsInvalidated: number };

      const observationsOn = async (activityId: string) =>
        (
          await withWorkspace(
            pool,
            { workspaceId, principalId: ownerId },
            (client) =>
              client.query<{ id: string; source_id: string; created_at: Date }>(
                `select id, source_id, created_at from observations
                  where workspace_id = $1 and activity_id = $2 order by created_at, id`,
                [workspaceId, activityId],
              ),
            { skipRoleSwitch: true },
          )
        ).rows;
      const runsOnFacts = async (hostObjectId: string) => {
        const rows = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          client.query<{
            id: string;
            service_name: string;
            observation_id: string | null;
            last_observation_id: string | null;
            invalidation_reason: string | null;
          }>(
            `select l.id, s.identity_key ->> 'serviceName' as service_name, l.observation_id,
                    l.last_observation_id, l.invalidation_reason
               from links l
               join objects s on s.workspace_id = l.workspace_id and s.id = l.source_object_id
              where l.workspace_id = $1 and l.link_type = 'runs_on' and l.target_object_id = $2
                and l.superseded_at is null
              order by s.identity_key ->> 'serviceName'`,
            [workspaceId, hostObjectId],
          ),
        );
        return rows.rows;
      };

      // Run 1: four items, three Links — one Observation, every Fact's origin and last
      // confirmation.
      const run1 = await submit({
        observations: [host, container('a'), container('b'), container('c')],
      });
      expect(run1.factsAsserted).toBe(3);
      const hostObjectId = run1.objects.find((o) => o.objectType === 'Host')?.id as string;
      const obs1 = await observationsOn(run1.activityId);
      expect(obs1).toHaveLength(1);
      expect(obs1[0]?.source_id).toBe(source.id);
      const facts1 = await runsOnFacts(hostObjectId);
      expect(facts1).toHaveLength(3);
      for (const fact of facts1) {
        expect(fact.observation_id).toBe(obs1[0]?.id);
        expect(fact.last_observation_id).toBe(obs1[0]?.id);
      }
      // Origin: the one distinct Source feeding the Activity.
      const origin = await withWorkspace(
        pool,
        { workspaceId, principalId: servicePrincipalId },
        (client) =>
          resolveFactOrigin(client, workspaceId, {
            activityId: run1.activityId,
            assertedBy: servicePrincipalId,
          }),
      );
      expect(origin).toEqual({ kind: 'source', id: source.id });

      // Run 2: the same items unchanged — one new Observation; every Fact keeps its origin and
      // moves its last confirmation to it.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const run2 = await submit({
        observations: [host, container('a'), container('b'), container('c')],
      });
      expect(run2.factsUnchanged).toBe(3);
      expect(run2.factsAsserted).toBe(0);
      const obs2 = await observationsOn(run2.activityId);
      expect(obs2).toHaveLength(1);
      for (const fact of await runsOnFacts(hostObjectId)) {
        expect(fact.observation_id).toBe(obs1[0]?.id);
        expect(fact.last_observation_id).toBe(obs2[0]?.id);
      }

      // Freshness: the Source's newest Observation is run 2's.
      const freshness = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        listSourceFreshness(client, workspaceId, 60 * 60 * 1000),
      );
      const row = freshness.find((r) => r.sourceId === source.id);
      expect(row?.lastObservedAt?.getTime()).toBe(obs2[0]?.created_at.getTime());
      expect(row?.silent).toBe(false);

      // explain(fact): narrowed to its origin Observation; lastObservation is run 2's — both
      // resolve to this Source.
      const factA = facts1.find((f) => f.service_name === 'a')?.id;
      const explainedFact = (await dispatchCapability({ pool }, caller, 'explain', {
        nodeId: factA,
      })) as {
        activity: { observations: { id: string; source: { id: string } | null }[] } | null;
        fact?: { lastObservation: { id: string; source: { id: string } | null } | null };
      };
      expect(explainedFact.activity?.observations.map((o) => o.id)).toEqual([obs1[0]?.id]);
      expect(explainedFact.activity?.observations[0]?.source?.id).toBe(source.id);
      expect(explainedFact.fact?.lastObservation?.id).toBe(obs2[0]?.id);
      expect(explainedFact.fact?.lastObservation?.source?.id).toBe(source.id);

      // A second phase of run 2 (same Activity) is a second call — a second Observation on that
      // Activity, still one distinct Source, so origin is unchanged; explain(activity) lists one
      // Observation per call, each resolving to the Source.
      await submit({ activityId: run2.activityId, observations: [host] });
      const obs2Phases = await observationsOn(run2.activityId);
      expect(obs2Phases).toHaveLength(2);
      expect(new Set(obs2Phases.map((o) => o.source_id))).toEqual(new Set([source.id]));
      const explainedActivity = (await dispatchCapability({ pool }, caller, 'explain', {
        nodeId: run2.activityId,
      })) as { activity: { observations: { source: { id: string } | null }[] } | null };
      expect(explainedActivity.activity?.observations).toHaveLength(2);
      for (const observation of explainedActivity.activity?.observations ?? []) {
        expect(observation.source?.id).toBe(source.id);
      }

      // Run 3: a complete window without container c — c's Fact is retired not_reobserved
      // through its last Observation (run 2's single row), a and b are re-confirmed by run 3's.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const run3 = await submit({
        observations: [host, container('a'), container('b')],
        window: { complete: true, objectTypes: ['Container'] },
      });
      expect(run3.factsUnchanged).toBe(2);
      expect(run3.factsInvalidated).toBe(1);
      const obs3 = await observationsOn(run3.activityId);
      expect(obs3).toHaveLength(1);
      const facts3 = await runsOnFacts(hostObjectId);
      expect(facts3.find((f) => f.service_name === 'c')?.invalidation_reason).toBe(
        'not_reobserved',
      );
      for (const name of ['a', 'b']) {
        const fact = facts3.find((f) => f.service_name === name);
        expect(fact?.invalidation_reason).toBeNull();
        expect(fact?.last_observation_id).toBe(obs3[0]?.id);
      }
    });

    // Review 2026-10-02 R-02 / D-03 (`provenance-anchor-guard.ts`): a caller observes only through
    // a Source it owns, and only on an Activity it started — for a Handle, "it" is the principal
    // the Handle acts for. Kernel-internal pairings of a Source and an Activity of different owners
    // (gatekeeper observe/apply, worker_result) do not go through this handler and are unaffected.
    describe('R-02: provenance anchors require ownership (Source owner, Activity starter)', () => {
      const hostname = `r02-host-${randomUUID()}`;
      const collectorItems = [
        { objectType: 'Host', identity: { hostname } },
        {
          objectType: 'Container',
          identity: { composeProjectId: `r02-project-${hostname}`, serviceName: 'web' },
          links: [{ linkType: 'runs_on', target: { objectType: 'Host', identity: { hostname } } }],
        },
      ];
      let collectorSourceId: string;
      let collectorActivityId: string;

      /** Every `source_id` observed on `activityId`, read past RLS so a private Source shows too. */
      async function sourcesObservedOn(activityId: string): Promise<string[]> {
        const rows = await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          (client) =>
            client.query<{ source_id: string }>(
              'select distinct source_id from observations where workspace_id = $1 and activity_id = $2',
              [workspaceId, activityId],
            ),
          { skipRoleSwitch: true },
        );
        return rows.rows.map((row) => row.source_id);
      }

      async function observationCount(sourceId: string): Promise<number> {
        const rows = await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          (client) =>
            client.query<{ n: number }>(
              'select count(*)::int as n from observations where workspace_id = $1 and source_id = $2',
              [workspaceId, sourceId],
            ),
          { skipRoleSwitch: true },
        );
        return rows.rows[0]?.n ?? 0;
      }

      async function activeFactsOn(activityId: string): Promise<number> {
        const rows = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          client.query(
            `select id from links where workspace_id = $1 and activity_id = $2
               and superseded_at is null and invalidated_at is null`,
            [workspaceId, activityId],
          ),
        );
        return rows.rows.length;
      }

      beforeAll(async () => {
        const collector = handleCaller(workspaceId, servicePrincipalId, INGEST_CAPABILITIES);
        const source = (await dispatchCapability({ pool }, collector, 'register_source', {
          kind: 'host-inventory-collector',
          name: 'r02-collector',
          visibility: 'workspace',
        })) as { id: string };
        collectorSourceId = source.id;
        const run = (await dispatchCapability({ pool }, collector, 'submit_observations', {
          sourceId: collectorSourceId,
          observations: collectorItems,
        })) as SubmitObservationsResult;
        expect(run.factsAsserted).toBe(1);
        collectorActivityId = run.activityId;
      });

      it("a member cannot submit to the collector's Source — 403, nothing recorded, no Fact retired", async () => {
        const member = handleCaller(workspaceId, memberId, INGEST_CAPABILITIES);
        const before = await observationCount(collectorSourceId);

        await expect(
          dispatchCapability({ pool }, member, 'submit_observations', {
            sourceId: collectorSourceId,
            observations: collectorItems,
          }),
        ).rejects.toBeInstanceOf(ForbiddenError);
        // The bulk-invalidation shape (an empty complete window) is refused the same way.
        await expect(
          dispatchCapability({ pool }, member, 'submit_observations', {
            sourceId: collectorSourceId,
            observations: [],
            window: { complete: true, objectTypes: ['Container'] },
          }),
        ).rejects.toBeInstanceOf(ForbiddenError);
        // The person on the human channel is refused exactly like an agent acting for them.
        await expect(
          dispatchCapability(
            { pool },
            humanCaller(workspaceId, memberId, 'member'),
            'submit_observations',
            { sourceId: collectorSourceId, observations: collectorItems },
          ),
        ).rejects.toBeInstanceOf(ForbiddenError);

        expect(await observationCount(collectorSourceId)).toBe(before);
        expect(await activeFactsOn(collectorActivityId)).toBe(1);
      });

      it("a member cannot observe their own private Source on the collector's Activity — 403, the collector's Facts stay visible", async () => {
        const member = handleCaller(workspaceId, memberId, INGEST_CAPABILITIES);
        const own = (await dispatchCapability({ pool }, member, 'register_source', {
          kind: 'test.r02-member',
          name: 'r02-member-private',
          visibility: 'private',
        })) as { id: string };

        await expect(
          dispatchCapability({ pool }, member, 'submit_observations', {
            sourceId: own.id,
            activityId: collectorActivityId,
            observations: [{ objectType: 'Host', identity: { hostname } }],
          }),
        ).rejects.toBeInstanceOf(ForbiddenError);

        expect(await sourcesObservedOn(collectorActivityId)).toEqual([collectorSourceId]);
        // Another person still sees the collector's Fact (link_visible_to_caller, core 0013).
        expect(await activeFactsOn(collectorActivityId)).toBe(1);
      });

      it('an unknown activityId is refused with the same 403 (no existence oracle)', async () => {
        const member = handleCaller(workspaceId, memberId, INGEST_CAPABILITIES);
        const own = (await dispatchCapability({ pool }, member, 'register_source', {
          kind: 'test.r02-member',
          name: 'r02-member-unknown-activity',
          visibility: 'workspace',
        })) as { id: string };
        await expect(
          dispatchCapability({ pool }, member, 'submit_observations', {
            sourceId: own.id,
            activityId: randomUUID(),
            observations: [{ objectType: 'Host', identity: { hostname: `r02-${randomUUID()}` } }],
          }),
        ).rejects.toBeInstanceOf(ForbiddenError);
        expect(await observationCount(own.id)).toBe(0);
      });

      it('own Source plus own Activity succeeds — phases of one run share the Activity the first phase started', async () => {
        const member = handleCaller(workspaceId, memberId, INGEST_CAPABILITIES);
        const own = (await dispatchCapability({ pool }, member, 'register_source', {
          kind: 'test.r02-member',
          name: 'r02-member-workspace',
          visibility: 'workspace',
        })) as { id: string };
        const memberHost = `r02-member-host-${randomUUID()}`;

        const phase1 = (await dispatchCapability({ pool }, member, 'submit_observations', {
          sourceId: own.id,
          observations: [{ objectType: 'Host', identity: { hostname: memberHost } }],
        })) as SubmitObservationsResult;
        const phase2 = (await dispatchCapability({ pool }, member, 'submit_observations', {
          sourceId: own.id,
          activityId: phase1.activityId,
          observations: [
            {
              objectType: 'Container',
              identity: { composeProjectId: `r02-project-${memberHost}`, serviceName: 'web' },
              links: [
                {
                  linkType: 'runs_on',
                  target: { objectType: 'Host', identity: { hostname: memberHost } },
                },
              ],
            },
          ],
        })) as SubmitObservationsResult;

        expect(phase2.activityId).toBe(phase1.activityId);
        expect(phase2.factsAsserted).toBe(1);
        expect(await sourcesObservedOn(phase1.activityId)).toEqual([own.id]);
      });

      it("an agent Handle acting for a person writes to that person's Source and Activity", async () => {
        // The person registers a Source and opens an Activity on the human channel …
        const person = humanCaller(workspaceId, ownerId, 'owner');
        const personSource = (await dispatchCapability({ pool }, person, 'register_source', {
          kind: 'test.r02-person',
          name: 'r02-person-source',
          visibility: 'workspace',
        })) as { id: string };
        const personHost = `r02-person-host-${randomUUID()}`;
        const first = (await dispatchCapability({ pool }, person, 'submit_observations', {
          sourceId: personSource.id,
          observations: [{ objectType: 'Host', identity: { hostname: personHost } }],
        })) as SubmitObservationsResult;

        // … and an agent's Handle on their behalf (obo = the person) uses both.
        const agent = handleCaller(workspaceId, ownerId, INGEST_CAPABILITIES);
        const second = (await dispatchCapability({ pool }, agent, 'submit_observations', {
          sourceId: personSource.id,
          activityId: first.activityId,
          observations: [
            {
              objectType: 'Container',
              identity: { composeProjectId: `r02-project-${personHost}`, serviceName: 'web' },
              links: [
                {
                  linkType: 'runs_on',
                  target: { objectType: 'Host', identity: { hostname: personHost } },
                },
              ],
            },
          ],
        })) as SubmitObservationsResult;
        expect(second.factsAsserted).toBe(1);
        expect(await sourcesObservedOn(first.activityId)).toEqual([personSource.id]);

        // The same agent still cannot reach the collector's Source or Activity.
        await expect(
          dispatchCapability({ pool }, agent, 'submit_observations', {
            sourceId: collectorSourceId,
            observations: collectorItems,
          }),
        ).rejects.toBeInstanceOf(ForbiddenError);
        await expect(
          dispatchCapability({ pool }, agent, 'submit_observations', {
            sourceId: personSource.id,
            activityId: collectorActivityId,
            observations: [{ objectType: 'Host', identity: { hostname: personHost } }],
          }),
        ).rejects.toBeInstanceOf(ForbiddenError);
      });
    });
  },
);
