import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { runInvariantChecks } from '../../substrate/audit/index.js';
import { OntologyViolationError, SqlGraphStore } from '../../substrate/graph/index.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/ontology-guard.integration.test: DB-gated (real Postgres; auto-skip without
 * DATABASE_URL) coverage of S5.1 — I2 enforced at the write point (substrate/graph/
 * ontology-guard.ts; docs/development-tasks.md §5b S5.1; STATUS leftover 37) — driven through the
 * capabilities a real writer uses, on a workspace created the way the platform creates one
 * (`createWorkspaceWithOwner`: platform-meta + the ops-assets-v1 domain pack published at birth).
 *
 *   - `runs_on` Container -> Host is declared: written.
 *   - `runs_on` Host -> Container is not a declared signature: `domain_range_violation`, with the
 *     declared signatures in `expected` so an agent can correct itself from the body.
 *   - `frobnicates`: `undeclared_link_type`.
 *   - `supersede_fact` runs the same check on the replacement.
 *   - `warn` (the rollout mode, `workspaces.ontology_enforcement`): the write goes through and an
 *     `ontology_violation` audit row records it.
 *   - A hand-inserted workspace with no published ontology is not enforced (the module doc
 *     comment's "adopted no ontology" rule — this package's other DB-gated fixtures rely on it).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const REPO_ROOT = path.resolve(KERNEL_ROOT, '..', '..');
const ONTOLOGY_DIR = path.join(REPO_ROOT, 'ontology');

const graphStore = new SqlGraphStore();

function handleCaller(workspaceId: string, obo: string): ResolvedCaller {
  const now = Math.floor(Date.now() / 1000);
  return {
    channel: 'handle',
    claims: {
      ws: workspaceId,
      sid: randomUUID(),
      obo,
      scope: { capabilities: ['assert_fact', 'supersede_fact'], resources: {} },
      jti: randomUUID(),
      iat: now,
      exp: now + 600,
    },
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'S5.1 ontology guard (integration, real Postgres, dispatchCapability)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let containerId: string;
    let hostId: string;

    async function makeObject(objectType: string, identity: Record<string, unknown>) {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const object = await graphStore.upsertObject(client, workspaceId, {
          objectType,
          identity,
          properties: {},
        });
        return object.id;
      });
    }

    async function setEnforcement(mode: 'reject' | 'warn'): Promise<void> {
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        await client.query('update workspaces set ontology_enforcement = $2 where id = $1', [
          workspaceId,
          mode,
        ]);
      });
    }

    async function thrownBy(call: () => Promise<unknown>): Promise<unknown> {
      return call().then(
        () => {
          throw new Error('expected the call to be refused, but it resolved');
        },
        (err: unknown) => err,
      );
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      const created = await createWorkspaceWithOwner(pool, {
        name: `ontology-guard-${randomUUID().slice(0, 8)}`,
        owner: { displayName: 'Guard Owner' },
        ontologyDir: ONTOLOGY_DIR,
      });
      workspaceId = created.workspaceId;
      ownerId = created.ownerPrincipalId;
      containerId = await makeObject('Container', { containerId: randomUUID() });
      hostId = await makeObject('Host', { hostname: `guard-${randomUUID().slice(0, 8)}` });
    }, 120_000);

    afterAll(async () => {
      await pool.end();
    });

    it('a new workspace is born in reject mode; a declared signature is written', async () => {
      const row = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        client.query<{ ontology_enforcement: string }>(
          'select ontology_enforcement from workspaces where id = $1',
          [workspaceId],
        ),
      );
      expect(row.rows[0]?.ontology_enforcement).toBe('reject');

      const fact = (await dispatchCapability(
        { pool },
        handleCaller(workspaceId, ownerId),
        'assert_fact',
        { sourceObjectId: containerId, targetObjectId: hostId, linkType: 'runs_on' },
      )) as { id: string; linkType: string };
      expect(fact.linkType).toBe('runs_on');
    });

    it('a declared LinkType with the endpoints the wrong way round is a domain_range_violation, with the allowed signatures', async () => {
      const err = await thrownBy(() =>
        dispatchCapability({ pool }, handleCaller(workspaceId, ownerId), 'assert_fact', {
          sourceObjectId: hostId,
          targetObjectId: containerId,
          linkType: 'runs_on',
        }),
      );
      expect(err).toBeInstanceOf(OntologyViolationError);
      const violation = err as OntologyViolationError;
      expect(violation.code).toBe('ontology_violation');
      expect(violation.details).toMatchObject({
        reason: 'domain_range_violation',
        linkType: 'runs_on',
        sourceType: 'Host',
        targetType: 'Container',
      });
      expect(violation.details.expected).toContain('Container -> Host');
    });

    it('a LinkType no published version declares is an undeclared_link_type', async () => {
      const err = await thrownBy(() =>
        dispatchCapability({ pool }, handleCaller(workspaceId, ownerId), 'assert_fact', {
          sourceObjectId: containerId,
          targetObjectId: hostId,
          linkType: 'frobnicates',
        }),
      );
      expect(err).toBeInstanceOf(OntologyViolationError);
      expect((err as OntologyViolationError).details).toMatchObject({
        reason: 'undeclared_link_type',
        linkType: 'frobnicates',
        expected: [],
      });
    });

    it('supersede_fact checks the replacement the same way — a Fact written under warn cannot be superseded under reject', async () => {
      // Written while the workspace was in `warn` (a rollout-period row, the shape of every
      // pre-S5.1 row on a host) …
      await setEnforcement('warn');
      let written: { id: string };
      try {
        written = (await dispatchCapability(
          { pool },
          handleCaller(workspaceId, ownerId),
          'assert_fact',
          {
            sourceObjectId: hostId,
            targetObjectId: containerId,
            linkType: 'uses_image',
            properties: { v: 1 },
          },
        )) as { id: string };
      } finally {
        await setEnforcement('reject');
      }
      // … its supersede keeps the identity (I5) and is therefore the same violation, refused
      // before the identity or lifecycle checks run.
      const err = await thrownBy(() =>
        dispatchCapability({ pool }, handleCaller(workspaceId, ownerId), 'supersede_fact', {
          factId: written.id,
          sourceObjectId: hostId,
          targetObjectId: containerId,
          linkType: 'uses_image',
          properties: { v: 2 },
        }),
      );
      expect(err).toBeInstanceOf(OntologyViolationError);
      expect((err as OntologyViolationError).details).toMatchObject({
        reason: 'domain_range_violation',
        linkType: 'uses_image',
        sourceType: 'Host',
        targetType: 'Container',
      });
    });

    it('warn: the write goes through and an ontology_violation audit row records it', async () => {
      await setEnforcement('warn');
      try {
        const fact = (await dispatchCapability(
          { pool },
          handleCaller(workspaceId, ownerId),
          'assert_fact',
          { sourceObjectId: hostId, targetObjectId: containerId, linkType: 'runs_on' },
        )) as { id: string; linkType: string };
        expect(fact.linkType).toBe('runs_on');

        const audit = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          client.query<{ resource_id: string; payload: Record<string, unknown> }>(
            `select resource_id, payload from audit_records
              where workspace_id = $1 and action = 'ontology_violation'
              order by created_at desc limit 1`,
            [workspaceId],
          ),
        );
        expect(audit.rows[0]?.resource_id).toBe('runs_on');
        expect(audit.rows[0]?.payload).toMatchObject({
          reason: 'domain_range_violation',
          enforcement: 'warn',
          sourceObjectId: hostId,
          targetObjectId: containerId,
        });
      } finally {
        await setEnforcement('reject');
      }
    });

    it('I-S5-1 counts the rows warn let through, naming the LinkType and the endpoint types', async () => {
      // The two `warn` writes above (runs_on Host -> Container, uses_image Host -> Container) are
      // the only violating rows this workspace holds; the check runs across the whole database,
      // so assert on this workspace's own sample rather than on the total.
      const results = await runInvariantChecks(pool);
      const check = results.find((result) => result.invariant === 'I-S5-1');
      expect(check).toBeDefined();
      expect(check?.violations).toBeGreaterThanOrEqual(2);
      const ours = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        client.query<{ n: string }>(
          `select count(*)::text as n from links
            where workspace_id = $1 and link_type in ('runs_on', 'uses_image')
              and source_object_id = $2 and target_object_id = $3`,
          [workspaceId, hostId, containerId],
        ),
      );
      expect(ours.rows[0]?.n).toBe('2');
    });

    it('a hand-inserted workspace with no published ontology is not enforced', async () => {
      const bareWorkspaceId = randomUUID();
      const bareOwnerId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: bareWorkspaceId, principalId: bareOwnerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            bareWorkspaceId,
            'ontology-guard-bare',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'bare owner')`,
            [bareWorkspaceId, bareOwnerId],
          );
        },
        { skipRoleSwitch: true },
      );
      const { a, b } = await withWorkspace(
        pool,
        { workspaceId: bareWorkspaceId, principalId: bareOwnerId },
        async (client) => ({
          a: (
            await graphStore.upsertObject(client, bareWorkspaceId, {
              objectType: 'test.thing',
              properties: {},
            })
          ).id,
          b: (
            await graphStore.upsertObject(client, bareWorkspaceId, {
              objectType: 'test.thing',
              properties: {},
            })
          ).id,
        }),
      );
      const fact = (await dispatchCapability(
        { pool },
        handleCaller(bareWorkspaceId, bareOwnerId),
        'assert_fact',
        { sourceObjectId: a, targetObjectId: b, linkType: 'anything_goes' },
      )) as { linkType: string };
      expect(fact.linkType).toBe('anything_goes');
    });
  },
);
