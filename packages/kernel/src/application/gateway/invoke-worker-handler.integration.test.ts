import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HandleClaims, Role } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import type {
  TaskSpawnInput,
  TaskSpawnOutcome,
  TaskSupervisorClientPort,
  TaskSupervisorStatus,
} from '../../adapters/supervisor-client/index.js';
import {
  type IssuedHandle,
  entryScope,
  generateEphemeralHandleKeyPair,
  issueHandle,
} from '../../governance/capability/index.js';
import { InvokeWorkerDefinitionNotEnabledError } from '../task/index.js';
import { configureTaskRuntime, resetTaskRuntimeForTests } from '../task/runtime.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/invoke-worker-handler.integration.test: DB-gated (real Postgres; auto-skip
 * without DATABASE_URL) proof that `invokeWorkerHandler`'s `wait:true` path is genuinely two-phase
 * (P1-4 fix, review job 652a4abc: "dispatch keeps the withWorkspace txn/pool connection open
 * through the wait (≤90s) → pool exhaustion blocks report_task_result").
 *
 * The proof mirrors `request-action.integration.test.ts`'s own `RecordingTransport` technique
 * (checking a governed effect's visibility from a *second* connection): a fake supervisor client's
 * `status()` — called only from inside `waitForOutcome`'s poll loop, i.e. only once phase 2
 * (`afterCommit`) has actually started — checks, via a wholly separate pool connection, whether
 * `dispatchCapability`'s own phase-1 audit row for this `invoke_worker` call is already visible.
 * Under the pre-fix single-phase handler, the whole `wait:true` poll (including this very first
 * tick) ran *inside* dispatch.ts's still-open transaction, so that audit row could never be
 * visible to a second connection at this point — the fixed two-phase handler commits phase 1
 * before entering the wait, so it always is.
 *
 * The caller must be a *real* issued Handle (`issueHandle`, not a hand-fabricated `claims` object)
 * — `invoke_worker` mints a child WorkerRun Handle whose `parent_jti` foreign-keys back to the
 * caller's own `capability_handles` row (`governance/capability/handles.ts`); a fabricated `jti`
 * with no such row fails that FK at spawn time (`invoke.integration.test.ts`'s own
 * `issueTestHandle` helper exists for exactly this reason).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

/** Never reports a terminal status — `waitForOutcome` therefore polls at least once and then times
 *  out at `input.timeout`, which is exactly the window this test needs to observe. */
class NeverFinishingSupervisorClient implements TaskSupervisorClientPort {
  auditVisibleOnFirstPoll: boolean | undefined;
  private readonly pool: Pool;
  private readonly workspaceId: string;
  private polled = false;

  constructor(pool: Pool, workspaceId: string) {
    this.pool = pool;
    this.workspaceId = workspaceId;
  }

  async spawn(input: TaskSpawnInput): Promise<TaskSpawnOutcome> {
    return { containerId: `container-${input.workerRunId}`, ip: '198.51.100.20' };
  }

  async terminate(): Promise<boolean> {
    return true;
  }

  async status(workerRunId: string): Promise<TaskSupervisorStatus | undefined> {
    if (!this.polled) {
      this.polled = true;
      const client = await this.pool.connect();
      try {
        const result = await client.query<{ n: number }>(
          `select count(*)::int as n from audit_records
           where workspace_id = $1 and action = 'invoke_worker'`,
          [this.workspaceId],
        );
        this.auditVisibleOnFirstPoll = (result.rows[0]?.n ?? 0) >= 1;
      } finally {
        client.release();
      }
    }
    return {
      workerRunId,
      status: 'running',
      exitCode: undefined,
      containerId: `container-${workerRunId}`,
      ip: '198.51.100.20',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      reason: undefined,
    };
  }
}

describe.runIf(DATABASE_URL !== undefined)(
  'invoke_worker handler — two-phase wait (integration, real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: Awaited<ReturnType<typeof generateEphemeralHandleKeyPair>>['privateKey'];
    let workspaceId: string;
    let ownerId: string;
    let workerDefinitionId: string;

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

    async function adminInsertPrincipal(role: string, displayName: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', $3, $4)",
            [workspaceId, id, role, displayName],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function inTx<T>(
      principalId: string,
      fn: (client: PoolClient) => Promise<T>,
    ): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId }, fn);
    }

    async function insertSession(
      kind: string,
      principalId: string,
      onBehalfOf: string,
    ): Promise<string> {
      return inTx(principalId, async (client) => {
        const result = await client.query<{ id: string }>(
          `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
           values ($1, $2, $3, $4, 'active') returning id`,
          [workspaceId, principalId, kind, onBehalfOf],
        );
        const id = result.rows[0]?.id;
        if (!id) throw new Error('failed to insert session');
        return id;
      });
    }

    async function issueTestHandle(sessionId: string): Promise<IssuedHandle> {
      return inTx(ownerId, (client) =>
        issueHandle(client, { sessionId, scope: entryScope(), ttlSeconds: 3600, privateKey }),
      );
    }

    function claimsFromIssued(issued: IssuedHandle): HandleClaims {
      return {
        ws: issued.workspaceId,
        sid: issued.sessionId,
        obo: issued.onBehalfOf,
        scope: issued.scope,
        jti: issued.jti,
        iat: Math.floor(issued.issuedAt.getTime() / 1000),
        exp: Math.floor(issued.expiresAt.getTime() / 1000),
      };
    }

    /** `set_agent_profile` is `channel: 'human'`-only (capabilities.ts) — the one call in the S3.13
     *  runtime-consumer tests below that cannot go through a Handle. */
    function humanCaller(principalId: string, role: Role): ResolvedCaller {
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

    /** find_workers/invoke_worker for `principalId`, over a fresh entry session/Handle (S3.13
     *  runtime-consumer tests below) — same shape the existing "two-phase wait" test above already
     *  establishes, generalized to any principal rather than the module's own `ownerId`. */
    async function entryHandleCallerFor(principalId: string): Promise<ResolvedCaller> {
      const sessionId = await insertSession('entry', principalId, principalId);
      const issued = await issueTestHandle(sessionId);
      return { channel: 'handle', claims: claimsFromIssued(issued) };
    }

    /** Proposes and publishes one `kind: 'worker'` WorkerDefinition with a unique `name` — the
     *  S3.13 runtime-consumer tests below need two independently-invocable definitions per test to
     *  prove narrowing (one enabled, one not), never reusing the module-level `workerDefinitionId`
     *  the "two-phase wait" test above already exercises. */
    async function publishTestWorkerDefinition(name: string): Promise<string> {
      const proposed = await inTx(ownerId, (client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          kind: 'worker',
          definition: { systemPrompt: `You are worker ${name}.`, name },
        }),
      );
      await inTx(ownerId, (client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: proposed.id,
          version: proposed.version,
        }),
      );
      return proposed.id;
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      const keyPair = await generateEphemeralHandleKeyPair();
      privateKey = keyPair.privateKey;

      workspaceId = await adminInsertWorkspace('invoke-worker-handler-integration-test');
      ownerId = await adminInsertPrincipal('owner', 'owner');

      const proposed = await inTx(ownerId, (client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          kind: 'worker',
          definition: { systemPrompt: 'You are a plain worker.' },
        }),
      );
      await inTx(ownerId, (client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: proposed.id,
          version: proposed.version,
        }),
      );
      workerDefinitionId = proposed.id;
    });

    afterAll(async () => {
      resetTaskRuntimeForTests();
      await pool.end();
    });

    it('commits the phase-1 audit row before the wait:true poll ever starts', async () => {
      const supervisorClient = new NeverFinishingSupervisorClient(pool, workspaceId);
      configureTaskRuntime({ pool, privateKey, supervisorClient });

      const sessionId = await insertSession('entry', ownerId, ownerId);
      const issued = await issueTestHandle(sessionId);
      const caller: ResolvedCaller = { channel: 'handle', claims: claimsFromIssued(issued) };

      const result = (await dispatchCapability({ pool }, caller, 'invoke_worker', {
        definitionId: workerDefinitionId,
        version: 1,
        input: {},
        wait: true,
        timeout: 1,
      })) as { status: string; id: string; workerRunId: string };

      expect(result.status).toBe('running'); // timed out still-running, never hangs (§8.2)
      expect(supervisorClient.auditVisibleOnFirstPoll).toBe(true);
    });

    describe('S3.13 runtime consumer — AgentProfile.enabledWorkerDefinitions', () => {
      it('a profile with enabledWorkerDefinitions=[A] narrows find_workers to A and refuses invoke_worker(B) with 403', async () => {
        configureTaskRuntime({
          pool,
          privateKey,
          supervisorClient: new NeverFinishingSupervisorClient(pool, workspaceId),
        });

        const principalId = await adminInsertPrincipal('owner', 'profile-narrow-owner');
        const definitionA = await publishTestWorkerDefinition(
          'agent-profile-narrow-worker-a-unique',
        );
        const definitionB = await publishTestWorkerDefinition(
          'agent-profile-narrow-worker-b-unique',
        );

        // Owners are not exempt (a Profile is a preference the principal set for themselves) —
        // deliberately an `owner`-role principal here, not a `member`.
        await dispatchCapability({ pool }, humanCaller(principalId, 'owner'), 'set_agent_profile', {
          enabledWorkerDefinitions: [definitionA],
        });

        const caller = await entryHandleCallerFor(principalId);

        const found = (await dispatchCapability({ pool }, caller, 'find_workers', {
          need: 'agent-profile-narrow-worker',
        })) as { items: readonly { definitionId: string }[] };
        const foundIds = found.items.map((item) => item.definitionId);
        expect(foundIds).toContain(definitionA);
        expect(foundIds).not.toContain(definitionB);

        await expect(
          dispatchCapability({ pool }, caller, 'invoke_worker', {
            definitionId: definitionB,
            version: 1,
            input: {},
          }),
        ).rejects.toBeInstanceOf(InvokeWorkerDefinitionNotEnabledError);

        // A itself stays invocable — the profile narrows, it does not additionally break the
        // enabled definition.
        const invokedA = (await dispatchCapability({ pool }, caller, 'invoke_worker', {
          definitionId: definitionA,
          version: 1,
          input: {},
        })) as { status: string };
        expect(invokedA.status).toBe('running');
      });

      it('a principal with no AgentProfile row (null = inherit) sees and can invoke every published WorkerDefinition', async () => {
        configureTaskRuntime({
          pool,
          privateKey,
          supervisorClient: new NeverFinishingSupervisorClient(pool, workspaceId),
        });

        const principalId = await adminInsertPrincipal('member', 'profile-unset-member');
        const definitionA = await publishTestWorkerDefinition(
          'agent-profile-unset-worker-a-unique',
        );
        const definitionB = await publishTestWorkerDefinition(
          'agent-profile-unset-worker-b-unique',
        );

        const caller = await entryHandleCallerFor(principalId);

        const found = (await dispatchCapability({ pool }, caller, 'find_workers', {
          need: 'agent-profile-unset-worker',
        })) as { items: readonly { definitionId: string }[] };
        const foundIds = found.items.map((item) => item.definitionId);
        expect(foundIds).toContain(definitionA);
        expect(foundIds).toContain(definitionB);

        for (const definitionId of [definitionA, definitionB]) {
          const invoked = (await dispatchCapability({ pool }, caller, 'invoke_worker', {
            definitionId,
            version: 1,
            input: {},
          })) as { status: string };
          expect(invoked.status).toBe('running');
        }
      });
    });
  },
);
