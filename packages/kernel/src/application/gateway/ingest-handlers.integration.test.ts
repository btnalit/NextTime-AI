import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { publishOntologyDomainPack } from '../../substrate/ontology/index.js';
import { dispatchCapability, isResultValidationEnabled } from './dispatch.js';
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

      // W5: submit_observations threads the per-item Observation id into assertFact's
      // observationId, and that Observation is recorded under run1's own Activity.
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
  },
);
