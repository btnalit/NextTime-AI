import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  EvalSuiteSummaryWire,
  EvalSuiteWire,
  Operation,
  PrincipalKind,
  Role,
} from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { ReviewedVersionChangedError } from '../../governance/capability/index.js';
import {
  deprecateOperation,
  importManifest,
  publishOperation,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { TextCarriesCredentialsError } from '../../governance/redaction/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import {
  EvalSuiteInputError,
  EvalSuiteNameTakenError,
  EvalSuiteNotFoundError,
  EvalSuiteStateError,
} from '../eval/index.js';
import { purgeWorkspace } from '../platform/index.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/eval-suites.integration.test: DB-gated (real Postgres; auto-skip without
 * DATABASE_URL) — S10 E3-1a, an evaluation suite's shell through the capabilities: creating one,
 * every change that makes a version (repin, a fixture gate added, synced, removed), who may read
 * and change it, that no agent or service reaches it (I-E4), and what the database refuses
 * whoever writes (migrations/worker/0007).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function operation(name: string, extra: Partial<Operation> = {}): Operation {
  return {
    name,
    description: `reads ${name}`,
    binding: { kind: 'http', method: 'GET', path: `/${name}` },
    params_schema: { type: 'object', properties: { host: { type: 'string' } } },
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: [],
    writes: [],
    ...extra,
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'evaluation suites (S10 E3-1a, integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    const people: Record<'owner' | 'builder' | 'member' | 'auditor', string> = {
      owner: randomUUID(),
      builder: randomUUID(),
      member: randomUUID(),
      auditor: randomUUID(),
    };
    const serviceId = randomUUID();
    const workerDefinitionId = randomUUID();
    const entryDefinitionId = randomUUID();
    let gateA: string;
    let gateEmpty: string;

    function caller(
      principalId: string,
      role: Role,
      kind: PrincipalKind = 'human',
    ): ResolvedCaller {
      return {
        channel: 'human',
        principal: { workspaceId, id: principalId, kind, role, displayName: null },
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
    const person = (role: keyof typeof people) => caller(people[role], role);

    /** The owner's agent, its Handle scoped to the reads — the channel still refuses it. */
    function ownerAgent(capabilities: string[]): ResolvedCaller {
      const now = Math.floor(Date.now() / 1000);
      return {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid: randomUUID(),
          obo: people.owner,
          scope: { capabilities, resources: {} },
          jti: randomUUID(),
          iat: now,
          exp: now + 600,
        },
      };
    }

    async function asOwnerRole<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: people.owner }, fn, {
        skipRoleSwitch: true,
      });
    }
    async function asApp<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: people.owner }, fn);
    }

    async function insertDefinition(
      id: string,
      version: number,
      kind: 'worker' | 'entry',
      status: 'draft' | 'published',
    ): Promise<void> {
      await asOwnerRole((client) =>
        client.query(
          `insert into worker_definitions
             (workspace_id, id, version, kind, status, definition, proposed_by, published_by, published_at)
           values ($1, $2, $3, $4, $5, '{}'::jsonb, $6, $7, $8)`,
          [
            workspaceId,
            id,
            version,
            kind,
            status,
            people.builder,
            status === 'published' ? people.builder : null,
            status === 'published' ? new Date() : null,
          ],
        ),
      );
    }

    async function registerGate(name: string, operations: Operation[]): Promise<string> {
      return asApp(async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.connection',
          principalId: people.owner,
        });
        const registered = await registerGatekeeper(client, workspaceId, {
          name,
          transportKind: 'http',
          target: `${name}-system`,
          endpoint: `http://${name}.invalid`,
          activityId: activity.id,
          registeredBy: { id: people.owner, kind: 'human' },
        });
        if (operations.length > 0) {
          await importManifest(client, workspaceId, {
            gatekeeperId: registered.gatekeeperId,
            operations,
            proposedBy: { id: people.owner, kind: 'human' },
            activityId: activity.id,
          });
        }
        return registered.gatekeeperId;
      });
    }

    async function publishOn(gatekeeperId: string, operations: Operation[]): Promise<void> {
      await asApp(async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.connection',
          principalId: people.owner,
        });
        await importManifest(client, workspaceId, {
          gatekeeperId,
          operations,
          proposedBy: { id: people.owner, kind: 'human' },
          activityId: activity.id,
        });
        for (const op of operations) {
          await publishOperation(client, workspaceId, { gatekeeperId, name: op.name });
        }
      });
    }

    async function call<T>(who: ResolvedCaller, capability: string, params: unknown): Promise<T> {
      return (await dispatchCapability({ pool }, who, capability, params)) as T;
    }

    async function createSuite(name: string): Promise<EvalSuiteWire> {
      return call<EvalSuiteWire>(person('builder'), 'create_eval_suite', {
        name,
        description: 'restart drills',
        workerDefinitionId,
        workerDefinitionVersion: 1,
      });
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: people.owner },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'e3-1a-eval-suites',
          ]);
          for (const [role, id] of Object.entries(people)) {
            await client.query(
              "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', $3, $3)",
              [workspaceId, id, role],
            );
          }
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'service', 'builder', 'collector')",
            [workspaceId, serviceId],
          );
        },
        { skipRoleSwitch: true },
      );
      await insertDefinition(workerDefinitionId, 1, 'worker', 'published');
      await insertDefinition(workerDefinitionId, 2, 'worker', 'published');
      await insertDefinition(workerDefinitionId, 3, 'worker', 'draft');
      await insertDefinition(entryDefinitionId, 1, 'entry', 'published');
      gateA = await registerGate('inventory', []);
      await publishOn(gateA, [operation('hosts.list')]);
      gateEmpty = await registerGate('nothing-published', [operation('drafts.only')]);
    });

    afterAll(async () => {
      await pool.end();
    });

    it('a builder creates a suite at version 1 pinning a published worker version, with a canary', async () => {
      const suite = await createSuite('Restart drills');
      expect(suite).toMatchObject({
        name: 'Restart drills',
        description: 'restart drills',
        workerDefinition: { id: workerDefinitionId, version: 1, status: 'published' },
        version: 1,
        fixtureGateCount: 0,
        fixtureGatesNeedingAttention: 0,
        createdBy: people.builder,
        fixtureGates: [],
        history: [
          {
            version: 1,
            kind: 'created',
            actorId: people.builder,
            reason: null,
            workerDefinitionVersion: 1,
          },
        ],
      });
      expect(suite.canary).toMatch(/^NTEVAL-[0-9a-f]{32}$/);
    });

    it('refuses a pin that is not a published worker version, a taken name and credential text', async () => {
      const base = { name: 'pins', workerDefinitionId, workerDefinitionVersion: 1 };
      for (const pin of [
        { workerDefinitionId, workerDefinitionVersion: 3 }, // a draft
        { workerDefinitionId, workerDefinitionVersion: 9 }, // no such version
        { workerDefinitionId: entryDefinitionId, workerDefinitionVersion: 1 }, // entry kind
      ]) {
        await expect(
          call(person('builder'), 'create_eval_suite', { ...base, ...pin }),
        ).rejects.toBeInstanceOf(EvalSuiteInputError);
      }
      await createSuite('Taken name');
      await expect(createSuite('  taken NAME ')).rejects.toBeInstanceOf(EvalSuiteNameTakenError);
      await expect(
        call(person('builder'), 'create_eval_suite', {
          ...base,
          description: 'use password=hunter2-hunter2 to log in',
        }),
      ).rejects.toBeInstanceOf(TextCarriesCredentialsError);
      const names = (
        await call<{ items: EvalSuiteSummaryWire[] }>(person('builder'), 'list_eval_suites', {})
      ).items.map((s) => s.name);
      expect(names).not.toContain('pins');
    });

    it('every person reads suites; only a builder or above changes them', async () => {
      const suite = await createSuite('Roles');
      for (const role of ['owner', 'builder', 'member', 'auditor'] as const) {
        const list = await call<{ items: EvalSuiteSummaryWire[] }>(
          person(role),
          'list_eval_suites',
          {},
        );
        expect(list.items.map((s) => s.id)).toContain(suite.id);
        const read = await call<EvalSuiteWire>(person(role), 'get_eval_suite', {
          suiteId: suite.id,
        });
        expect(read.canary).toBe(suite.canary);
      }
      for (const role of ['member', 'auditor'] as const) {
        await expect(
          call(person(role), 'create_eval_suite', {
            name: `by ${role}`,
            workerDefinitionId,
            workerDefinitionVersion: 1,
          }),
        ).rejects.toBeInstanceOf(ForbiddenError);
        await expect(
          call(person(role), 'add_eval_fixture_gate', {
            suiteId: suite.id,
            suiteVersion: 1,
            gatekeeperId: gateA,
          }),
        ).rejects.toBeInstanceOf(ForbiddenError);
      }
      await expect(
        call(person('builder'), 'get_eval_suite', { suiteId: randomUUID() }),
      ).rejects.toBeInstanceOf(EvalSuiteNotFoundError);
    });

    it('no agent and no service Principal reaches a suite (I-E4)', async () => {
      const suite = await createSuite('Closed');
      const agent = ownerAgent(['list_eval_suites', 'get_eval_suite']);
      await expect(call(agent, 'list_eval_suites', {})).rejects.toBeInstanceOf(ForbiddenError);
      await expect(call(agent, 'get_eval_suite', { suiteId: suite.id })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      const service = caller(serviceId, 'builder', 'service');
      await expect(call(service, 'list_eval_suites', {})).rejects.toBeInstanceOf(ForbiddenError);
      await expect(call(service, 'get_eval_suite', { suiteId: suite.id })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(
        call(service, 'create_eval_suite', {
          name: 'by a service',
          workerDefinitionId,
          workerDefinitionVersion: 1,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      // Nothing of a suite is anywhere an agent's reads could reach: the canary is in no workspace
      // table but the eval_* ones (the audit trail included), and the agent's `search` finds nothing.
      const holding = await asOwnerRole(async (client) => {
        const tables = await client.query<{ table_name: string }>(
          `select distinct table_name from information_schema.columns
            where table_schema = 'public' and column_name = 'workspace_id'
              and table_name not like 'eval\\_%'`,
        );
        const found: string[] = [];
        for (const { table_name: table } of tables.rows) {
          const rows = await client.query<{ n: string }>(
            `select count(*)::text as n from "${table}" t where t.workspace_id = $1 and t::text like $2`,
            [workspaceId, `%${suite.canary}%`],
          );
          if (rows.rows[0]?.n !== '0') found.push(table);
        }
        return { tables: tables.rows.length, found };
      });
      expect(holding.tables).toBeGreaterThan(30);
      expect(holding.found).toEqual([]);
      // (Searched last: the search's own params are audited, and carry the canary.)
      const searched = await call<{ items: unknown[] }>(ownerAgent(['search']), 'search', {
        query: suite.canary,
      });
      expect(searched.items).toEqual([]);
    });

    it('a fixture gate freezes the gate’s name and published Operations; sync takes the new ones', async () => {
      const gate = await registerGate('inventory-live', []);
      await publishOn(gate, [operation('hosts.list')]);
      const suite = await createSuite('Fixtures');
      const added = await call<EvalSuiteWire>(person('builder'), 'add_eval_fixture_gate', {
        suiteId: suite.id,
        suiteVersion: 1,
        gatekeeperId: gate,
      });
      expect(added.version).toBe(2);
      expect(added.fixtureGates).toEqual([
        {
          gatekeeperId: gate,
          gateName: 'inventory-live',
          operations: [
            {
              name: 'hosts.list',
              version: 1,
              mode: 'observe',
              description: 'reads hosts.list',
              paramsSchema: { type: 'object', properties: { host: { type: 'string' } } },
              answersAbsent: false,
            },
          ],
          snapshotDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          addedInVersion: 2,
          addedBy: people.builder,
          addedAt: expect.any(String),
          liveState: 'same',
        },
      ]);
      expect(added.history[0]).toMatchObject({
        version: 2,
        kind: 'fixture_gate_added',
        gatekeeperId: gate,
        gateName: 'inventory-live',
      });

      await expect(
        call(person('builder'), 'add_eval_fixture_gate', {
          suiteId: suite.id,
          suiteVersion: 2,
          gatekeeperId: gate,
        }),
      ).rejects.toBeInstanceOf(EvalSuiteStateError);
      for (const gatekeeperId of [gateEmpty, randomUUID()]) {
        await expect(
          call(person('builder'), 'add_eval_fixture_gate', {
            suiteId: suite.id,
            suiteVersion: 2,
            gatekeeperId,
          }),
        ).rejects.toBeInstanceOf(EvalSuiteInputError);
      }
      await expect(
        call(person('builder'), 'sync_eval_fixture_gate', {
          suiteId: suite.id,
          suiteVersion: 2,
          gatekeeperId: gate,
        }),
      ).rejects.toBeInstanceOf(EvalSuiteStateError);

      // The gate publishes another Operation: the frozen one no longer matches.
      await publishOn(gate, [
        operation('hosts.restart', {
          mode: 'execute',
          blast_radius: 'medium',
          auto_approvable: false,
        }),
      ]);
      const changed = await call<EvalSuiteWire>(person('member'), 'get_eval_suite', {
        suiteId: suite.id,
      });
      expect(changed.fixtureGates[0]?.liveState).toBe('changed');
      expect(changed.fixtureGatesNeedingAttention).toBe(1);
      const listed = (
        await call<{ items: EvalSuiteSummaryWire[] }>(person('member'), 'list_eval_suites', {})
      ).items.find((s) => s.id === suite.id);
      expect(listed?.fixtureGatesNeedingAttention).toBe(1);

      const synced = await call<EvalSuiteWire>(person('builder'), 'sync_eval_fixture_gate', {
        suiteId: suite.id,
        suiteVersion: 2,
        gatekeeperId: gate,
      });
      expect(synced.version).toBe(3);
      expect(synced.fixtureGates).toHaveLength(1);
      expect(synced.fixtureGates[0]).toMatchObject({ addedInVersion: 3, liveState: 'same' });
      expect(synced.fixtureGates[0]?.operations.map((op) => [op.name, op.mode])).toEqual([
        ['hosts.list', 'observe'],
        ['hosts.restart', 'execute'],
      ]);
      expect(synced.history[0]).toEqual({
        version: 3,
        kind: 'fixture_gate_synced',
        actorId: people.builder,
        reason: null,
        createdAt: expect.any(String),
        gatekeeperId: gate,
        gateName: 'inventory-live',
        addedOperations: ['hosts.restart'],
        removedOperations: [],
        changedOperations: [],
      });

      // Version 2 still holds the row it had: retired at 3, superseded by the new one.
      const rows = await asApp((client) =>
        client.query<{ added_in_version: number; retired_in_version: number | null }>(
          `select added_in_version, retired_in_version from eval_fixture_gates
            where workspace_id = $1 and suite_id = $2 order by added_in_version`,
          [workspaceId, suite.id],
        ),
      );
      expect(rows.rows).toEqual([
        { added_in_version: 2, retired_in_version: 3 },
        { added_in_version: 3, retired_in_version: null },
      ]);

      // The gate stops publishing anything: there is nothing to sync to.
      for (const name of ['hosts.list', 'hosts.restart']) {
        await asApp((client) =>
          deprecateOperation(client, workspaceId, { gatekeeperId: gate, name }),
        );
      }
      const unavailable = await call<EvalSuiteWire>(person('builder'), 'get_eval_suite', {
        suiteId: suite.id,
      });
      expect(unavailable.fixtureGates[0]?.liveState).toBe('unavailable');
      await expect(
        call(person('builder'), 'sync_eval_fixture_gate', {
          suiteId: suite.id,
          suiteVersion: 3,
          gatekeeperId: gate,
        }),
      ).rejects.toBeInstanceOf(EvalSuiteInputError);

      const removed = await call<EvalSuiteWire>(person('builder'), 'remove_eval_fixture_gate', {
        suiteId: suite.id,
        suiteVersion: 3,
        gatekeeperId: gate,
        reason: 'the inventory system was retired',
      });
      expect(removed.version).toBe(4);
      expect(removed.fixtureGates).toEqual([]);
      expect(removed.history[0]).toMatchObject({
        version: 4,
        kind: 'fixture_gate_removed',
        reason: 'the inventory system was retired',
        gatekeeperId: gate,
      });
      await expect(
        call(person('builder'), 'remove_eval_fixture_gate', {
          suiteId: suite.id,
          suiteVersion: 4,
          gatekeeperId: gate,
          reason: 'again',
        }),
      ).rejects.toBeInstanceOf(EvalSuiteStateError);
    });

    it('a change against another suite version writes nothing (409 version_changed)', async () => {
      const suite = await createSuite('Stale');
      await expect(
        call(person('builder'), 'repin_eval_suite', {
          suiteId: suite.id,
          suiteVersion: 2,
          workerDefinitionVersion: 2,
        }),
      ).rejects.toBeInstanceOf(ReviewedVersionChangedError);
      const read = await call<EvalSuiteWire>(person('builder'), 'get_eval_suite', {
        suiteId: suite.id,
      });
      expect(read.version).toBe(1);
      expect(read.workerDefinition.version).toBe(1);
      expect(read.history).toHaveLength(1);
    });

    it('repin moves to another published version of the same WorkerDefinition', async () => {
      const suite = await createSuite('Repin');
      await expect(
        call(person('builder'), 'repin_eval_suite', {
          suiteId: suite.id,
          suiteVersion: 1,
          workerDefinitionVersion: 1,
        }),
      ).rejects.toBeInstanceOf(EvalSuiteStateError);
      await expect(
        call(person('builder'), 'repin_eval_suite', {
          suiteId: suite.id,
          suiteVersion: 1,
          workerDefinitionVersion: 3,
        }),
      ).rejects.toBeInstanceOf(EvalSuiteInputError);
      const repinned = await call<EvalSuiteWire>(person('owner'), 'repin_eval_suite', {
        suiteId: suite.id,
        suiteVersion: 1,
        workerDefinitionVersion: 2,
        reason: 'v2 adds the restart tool',
      });
      expect(repinned).toMatchObject({
        version: 2,
        workerDefinition: { id: workerDefinitionId, version: 2, status: 'published' },
      });
      expect(repinned.history[0]).toMatchObject({
        version: 2,
        kind: 'repinned',
        actorId: people.owner,
        reason: 'v2 adds the restart tool',
        fromVersion: 1,
        toVersion: 2,
      });
      // A pinned version deprecated since is shown as such; the suite still reads and changes.
      await asOwnerRole((client) =>
        client.query(
          "update worker_definitions set status = 'deprecated' where workspace_id = $1 and id = $2 and version = 2",
          [workspaceId, workerDefinitionId],
        ),
      );
      const read = await call<EvalSuiteWire>(person('builder'), 'get_eval_suite', {
        suiteId: suite.id,
      });
      expect(read.workerDefinition).toEqual({
        id: workerDefinitionId,
        version: 2,
        status: 'deprecated',
      });
      const back = await call<EvalSuiteWire>(person('builder'), 'repin_eval_suite', {
        suiteId: suite.id,
        suiteVersion: 2,
        workerDefinitionVersion: 1,
      });
      expect(back.workerDefinition).toMatchObject({ version: 1, status: 'published' });
    });

    describe('what the database refuses (worker/0007)', () => {
      let suiteId: string;

      beforeAll(async () => {
        const suite = await createSuite('Guards');
        suiteId = suite.id;
        await call(person('builder'), 'add_eval_fixture_gate', {
          suiteId,
          suiteVersion: 1,
          gatekeeperId: gateA,
        });
      });

      async function refused(sql: string, params: unknown[], message: RegExp): Promise<void> {
        await expect(asApp((client) => client.query(sql, params))).rejects.toThrow(message);
      }

      it('a suite’s name, canary and WorkerDefinition never change; its version moves by one', async () => {
        await refused(
          "update eval_suites set name = 'renamed', version = version + 1 where workspace_id = $1 and id = $2",
          [workspaceId, suiteId],
          /only the pinned version and the suite version change/,
        );
        await refused(
          'update eval_suites set worker_definition_id = $3, version = version + 1 where workspace_id = $1 and id = $2',
          [workspaceId, suiteId, entryDefinitionId],
          /only the pinned version and the suite version change/,
        );
        await refused(
          'update eval_suites set version = version + 2 where workspace_id = $1 and id = $2',
          [workspaceId, suiteId],
          /exactly one/,
        );
        await refused(
          'update eval_suites set worker_definition_version = 3, version = version + 1 where workspace_id = $1 and id = $2',
          [workspaceId, suiteId],
          /pins a published worker-kind/,
        );
        await refused(
          'delete from eval_suites where workspace_id = $1 and id = $2',
          [workspaceId, suiteId],
          /permission denied/,
        );
      });

      it('every suite version has its change, recorded at that version, and history is append-only', async () => {
        await refused(
          'update eval_suites set version = version + 1 where workspace_id = $1 and id = $2',
          [workspaceId, suiteId],
          /without a change recorded/,
        );
        await refused(
          `insert into eval_suite_changes (workspace_id, suite_id, version, kind, actor_id)
           values ($1, $2, 7, 'repinned', $3)`,
          [workspaceId, suiteId, people.builder],
          /current version/,
        );
        await refused(
          "update eval_suite_changes set reason = 'rewritten' where workspace_id = $1 and suite_id = $2",
          [workspaceId, suiteId],
          /permission denied/,
        );
        await refused(
          `insert into eval_suite_changes (workspace_id, suite_id, version, kind, actor_id)
           select $1, $2, 2, 'fixture_gate_removed', $3`,
          [workspaceId, suiteId, people.builder],
          /eval_suite_changes_removal_reason|duplicate key/,
        );
      });

      it('a fixture gate row never changes, is retired at its suite’s version and never deleted', async () => {
        await refused(
          'update eval_fixture_gates set snapshot = \'{"gateName":"x","operations":[]}\' where workspace_id = $1 and suite_id = $2',
          [workspaceId, suiteId],
          /never changes/,
        );
        await refused(
          'update eval_fixture_gates set retired_in_version = 5 where workspace_id = $1 and suite_id = $2',
          [workspaceId, suiteId],
          /retired at its suite's current version/,
        );
        await refused(
          'delete from eval_fixture_gates where workspace_id = $1 and suite_id = $2',
          [workspaceId, suiteId],
          /permission denied/,
        );
        await refused(
          `insert into eval_fixture_gates
             (workspace_id, suite_id, gatekeeper_id, snapshot, snapshot_digest, added_in_version, created_by)
           values ($1, $2, $3, '{"gateName":"x","operations":[]}', 'sha256:${'0'.repeat(64)}', 2, $4)`,
          [workspaceId, suiteId, people.builder, people.builder],
          /not a Gatekeeper|violates foreign key/,
        );
      });

      it('a fixture gate joins or leaves only in a suite version not recorded yet', async () => {
        // The suite is at v2, recorded as gate A's addition: another gate added, or gate A retired,
        // at v2 would change what v2 held after the fact.
        await refused(
          `insert into eval_fixture_gates
             (workspace_id, suite_id, gatekeeper_id, snapshot, snapshot_digest, added_in_version, created_by)
           values ($1, $2, $3, '{"gateName":"x","operations":[]}', 'sha256:${'0'.repeat(64)}', 2, $4)`,
          [workspaceId, suiteId, gateEmpty, people.builder],
          /suite version 2 is already recorded/,
        );
        await refused(
          'update eval_fixture_gates set retired_in_version = 2 where workspace_id = $1 and suite_id = $2',
          [workspaceId, suiteId],
          /suite version 2 is already recorded/,
        );
        const suite = await call<EvalSuiteWire>(person('builder'), 'get_eval_suite', { suiteId });
        expect(suite.version).toBe(2);
        expect(suite.fixtureGates.map((gate) => gate.gatekeeperId)).toEqual([gateA]);
        expect(suite.history.map((change) => change.version)).toEqual([2, 1]);
      });
    });

    // Last: it removes this test's workspace. The cascade runs with triggers off, so the append-only
    // and never-deleted guards above do not stand in its way, and it finds the three tables by their
    // `workspace_id` like any other.
    it('the workspace purge removes suites, their history and fixture gates', async () => {
      const result = await purgeWorkspace(pool, { workspaceId, confirm: true, force: true });
      expect(result.executed).toBe(true);
      expect(result.counts.evalSuites).toBeGreaterThan(0);
      expect(result.counts.evalSuiteChanges).toBeGreaterThan(0);
      expect(result.counts.evalFixtureGates).toBeGreaterThan(0);
      for (const table of ['eval_suites', 'eval_suite_changes', 'eval_fixture_gates']) {
        const left = await pool.query<{ count: string }>(
          `select count(*)::text as count from ${table} where workspace_id = $1`,
          [workspaceId],
        );
        expect(left.rows[0]?.count).toBe('0');
      }
    });
  },
);
