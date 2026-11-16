import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HandleClaims, Operation, PrincipalKind, Role } from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import type { GatekeeperClient } from '../../adapters/gatekeeper-client/index.js';
import { createGateConnectionSecrets } from '../../adapters/gatekeeper-client/index.js';
import { createOutboundTargetGuard } from '../../adapters/outbound-target/index.js';
import type {
  TaskSpawnInput,
  TaskSpawnOutcome,
  TaskSupervisorClientPort,
  TaskSupervisorStatus,
} from '../../adapters/supervisor-client/index.js';
import { ApprovalDrainer } from '../../governance/approval/index.js';
import {
  ADMIN_AGENT_SESSION_KIND,
  HANDLE_SIGNING_ALG,
  HandleRevoked,
  entryScope,
  issueHandle,
} from '../../governance/capability/index.js';
import {
  importManifest,
  publishOperation,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { recordMintedConnectionSecret } from '../gates/index.js';
import {
  createAdminWithTransaction,
  createGatekeeperActionExecutor,
} from '../gateway/action-executor.js';
import { withAdminClient } from '../gateway/auth.js';
import { ForbiddenError } from '../gateway/authorize.js';
import type { CapabilityHandlerContext } from '../gateway/capability-handler.js';
import {
  ConnectorNotSelfServeError,
  requestConnectionHandler,
  setConnectionHandlerDeps,
} from '../gateway/connection-handlers.js';
import { AdminAgentCallRefusedError, dispatchCapability } from '../gateway/dispatch.js';
import { authenticateHandle } from '../gateway/handle-auth.js';
import { CAPABILITY_HANDLERS } from '../gateway/handlers.js';
import { setRequestActionDeps } from '../gateway/request-action-handler.js';
import type { ResolvedCaller } from '../gateway/resolve-caller.js';
import { type UserRow, createUser } from '../identity/index.js';
import { PURGE_RETENTION_DAYS, purgeWorkspace } from '../platform/purge-workspace.js';
import { configureTaskRuntime, resetTaskRuntimeForTests } from '../task/runtime.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import {
  AdminAgentRefused,
  TRIAL_SELF_CONNECT_AUDIT_ACTION,
  isPlatformAdminInTrialWorkspace,
  issueAdminAgentHandle,
} from './index.js';

/**
 * application/admin-agent trial runs (S11 AA5a-1; docs/goal-orchestration-and-admin-agent-plan-
 * 2026-10-16.md §5.8 steps 2 and 4, the AA5 plan's F1 and F2; real Postgres, auto-skip without
 * DATABASE_URL). The admin agent may now ask to connect a system (`request_connection`) and start a
 * published Worker (`invoke_worker`) — in its trial workspace only, enforced by the kernel and the
 * database, never by its prompt:
 *
 *   - both record the admin agent session they came through (I-A7), on the row, the wire and the
 *     audit row; the database refuses that record outside a trial workspace, for another Principal,
 *     for a session that is not an admin agent's, and any later change to it;
 *   - outside a trial workspace both are refused — at dispatch, and by the handler itself whatever
 *     the caller says it is; a production workspace's Worker or gate cannot be reached from the
 *     trial workspace, and a trial request cannot be completed from production;
 *   - demoting the administrator refuses both at once (I-A3);
 *   - in a trial workspace a platform administrator may self-connect an http or mcp system whatever
 *     the platform's connector mode, each use audited on its own row; nobody else, no other kind,
 *     no other workspace — and none once the trial workspace is purged;
 *   - a Worker the admin agent starts asks for an execute Operation as any Worker does: an ordinary
 *     ActionRequest that waits for the person's `approve`, and only then reaches the gate.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const ONTOLOGY_DIR = path.join(KERNEL_ROOT, '..', '..', 'ontology');

const GATE_TOKEN = 'aa5a1-trial-integration-test-gate-token-0123456789';
const CONNECTION_SECRETS = createGateConnectionSecrets(GATE_TOKEN);

const DESCRIBED_OPERATIONS: Operation[] = [
  {
    name: 'ticket.list',
    binding: { kind: 'http', method: 'GET', path: '/tickets' },
    params_schema: {},
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: [],
    writes: [],
  },
];

/** An execute Operation of a trial gate (legacy 641): never auto-approved, and the Worker does not
 *  wait on the decision — the request is pending until a person decides it. */
const TICKET_CREATE: Operation = {
  name: 'ticket.create',
  binding: { kind: 'http', method: 'POST', path: '/tickets' },
  params_schema: {},
  mode: 'execute',
  blast_radius: 'medium',
  reversibility: false,
  auto_approvable: false,
  await_decision: false,
  reads: [],
  writes: [],
};

/** Never dials anything: describes one observe operation, stores nothing. */
const FAKE_GATEKEEPER_CLIENT: GatekeeperClient = {
  describeOperations: async () => ({ operations: DESCRIBED_OPERATIONS }),
  observe: async () => {
    throw new Error('not implemented');
  },
  simulate: async () => {
    throw new Error('not implemented');
  },
  apply: async () => {
    throw new Error('not implemented');
  },
  lookupApply: async () => {
    throw new Error('not implemented');
  },
  revert: async () => {
    throw new Error('not implemented');
  },
  health: async () => ({ status: 'ok' }),
  storeConnectedAccount: async () => {},
  deleteConnectedAccount: async () => {},
};

/** Spawns nothing real; every WorkerRun stays running. */
class RunningSupervisorClient implements TaskSupervisorClientPort {
  async spawn(input: TaskSpawnInput): Promise<TaskSpawnOutcome> {
    return { containerId: `container-${input.workerRunId}`, ip: '198.51.100.30' };
  }
  async terminate(): Promise<boolean> {
    return true;
  }
  async status(workerRunId: string): Promise<TaskSupervisorStatus | undefined> {
    return {
      workerRunId,
      status: 'running',
      exitCode: undefined,
      containerId: `container-${workerRunId}`,
      ip: '198.51.100.30',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      reason: undefined,
    };
  }
}

describe.runIf(DATABASE_URL !== undefined)(
  'S11 AA5a-1 admin agent trial runs: request_connection and invoke_worker (integration, real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: CryptoKey;
    let publicKey: CryptoKey;
    let previousSwitch: string | undefined;
    /** The administrator the agent acts for: a platform admin, owner of both workspaces. */
    let admin: UserRow;
    let trialWs: string;
    let adminPrincipalId: string;
    /** An owner of the trial workspace who is not a platform administrator. */
    let memberPrincipalId: string;
    let productionWs: string;
    let productionOwnerId: string;
    let trialDefinitionId: string;
    let productionDefinitionId: string;
    let productionGatekeeperId: string;
    /** An admin_agent session in the production workspace, as an earlier release could have
     *  opened one (AA1 checked no purpose) — what the handler and the database must refuse. */
    let productionAdminSessionId: string;

    function inWs<T>(
      workspaceId: string,
      principalId: string,
      fn: (client: PoolClient) => Promise<T>,
    ): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId }, fn);
    }

    /** A connection secret as `mint_connection_secret` issues one: its salt recorded (legacy 711). */
    async function issuedSecret(workspaceId: string, principalId: string): Promise<string> {
      const minted = CONNECTION_SECRETS.mint(workspaceId);
      await inWs(workspaceId, principalId, (client) =>
        recordMintedConnectionSecret(client, workspaceId, minted.salt, principalId),
      );
      return minted.secret;
    }

    /** `resources`: what the runtime bakes in (`ensureAdminAgentHandle` — the person's gate
     *  Grants in the trial workspace); none by default. */
    async function issue(resources?: Readonly<Record<string, readonly string[]>>) {
      return inWs(trialWs, adminPrincipalId, (client) =>
        issueAdminAgentHandle(client, {
          workspaceId: trialWs,
          principalId: adminPrincipalId,
          ...(resources === undefined ? {} : { resources }),
          ttlSeconds: 600,
          privateKey,
        }),
      );
    }

    async function agent(
      resources?: Readonly<Record<string, readonly string[]>>,
    ): Promise<{ caller: ResolvedCaller; claims: HandleClaims; sessionId: string }> {
      const issued = await issue(resources);
      const claims = await authenticateHandle(pool, issued.token, { publicKey }, 'source');
      return { caller: { channel: 'handle', claims }, claims, sessionId: issued.sessionId };
    }

    /** The administrator's own entry agent in the trial workspace: same Principal, an entry
     *  session and Handle. Legacy 443: `mcp_session` — a client they issued a Handle to instead. */
    async function entryAgent(kind: 'entry' | 'mcp_session' = 'entry'): Promise<ResolvedCaller> {
      const entrySession = await insertSession(trialWs, kind, adminPrincipalId);
      const entryHandle = await inWs(trialWs, adminPrincipalId, (client) =>
        issueHandle(client, {
          sessionId: entrySession,
          scope: entryScope(),
          ttlSeconds: 600,
          privateKey,
          basis: { kind: 'role', role: 'owner', credential: null },
        }),
      );
      return {
        channel: 'handle',
        claims: {
          ws: entryHandle.workspaceId,
          sid: entryHandle.sessionId,
          obo: entryHandle.onBehalfOf,
          scope: entryHandle.scope,
          jti: entryHandle.jti,
          iat: Math.floor(entryHandle.issuedAt.getTime() / 1000),
          exp: Math.floor(entryHandle.expiresAt.getTime() / 1000),
        } satisfies HandleClaims,
      };
    }

    /** The Worker of `taskId` as its Handle presents it: the Task's WorkerRun session and scope. */
    async function workerOf(
      taskId: string,
    ): Promise<{ caller: ResolvedCaller; scope: HandleClaims['scope']; workerRunId: string }> {
      const row = await withAdminClient(pool, async (client) => {
        const result = await client.query<{
          worker_run_id: string;
          session_id: string;
          jti: string;
          on_behalf_of: string;
          scope: HandleClaims['scope'];
          expires_at: Date;
        }>(
          `select r.id as worker_run_id, h.session_id, h.jti, h.on_behalf_of, h.scope, h.expires_at
             from capability_handles h
             join worker_runs r on r.session_id = h.session_id
            where r.task_id = $1`,
          [taskId],
        );
        return result.rows[0];
      });
      if (!row) throw new Error(`no Worker Handle for Task ${taskId}`);
      return {
        caller: {
          channel: 'handle',
          claims: {
            ws: trialWs,
            sid: row.session_id,
            obo: row.on_behalf_of,
            scope: row.scope,
            jti: row.jti,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(new Date(row.expires_at).getTime() / 1000),
          },
        },
        scope: row.scope,
        workerRunId: row.worker_run_id,
      };
    }

    /** A running Turn of the administrator's in a new Chat of `agentKind` — an admin agent's under
     *  `adminSessionId`, as `sendChatMessage` starts it (core 0052's `sessionKind` / `sessionId`). */
    async function startRunningTurn(
      agentKind: 'entry' | 'admin_agent',
      adminSessionId?: string,
    ): Promise<string> {
      return inWs(trialWs, adminPrincipalId, async (client) => {
        const chat = await client.query<{ id: string }>(
          `insert into chats (workspace_id, owner_principal_id, agent_kind, visibility)
           values ($1, $2, $3, 'private') returning id`,
          [trialWs, adminPrincipalId, agentKind],
        );
        const turn = await startActivity(client, trialWs, {
          kind: 'agent_turn',
          chatId: chat.rows[0]?.id,
          principalId: adminPrincipalId,
          ...(adminSessionId === undefined
            ? {}
            : { metadata: { sessionKind: 'admin_agent', sessionId: adminSessionId } }),
        });
        return turn.id;
      });
    }

    async function endTurn(turnId: string): Promise<void> {
      await withAdminClient(pool, (client) =>
        client.query(
          `update activities set status = 'completed', ended_at = now()
            where workspace_id = $1 and id = $2`,
          [trialWs, turnId],
        ),
      );
    }

    async function taskTurn(taskId: string): Promise<string | null> {
      const result = await withAdminClient(pool, (client) =>
        client.query<{ created_by_activity_id: string | null }>(
          'select created_by_activity_id from tasks where workspace_id = $1 and id = $2',
          [trialWs, taskId],
        ),
      );
      return result.rows[0]?.created_by_activity_id ?? null;
    }

    function person(
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

    async function insertPrincipal(
      workspaceId: string,
      kind: PrincipalKind,
      role: Role,
      userId: string | null,
    ): Promise<string> {
      const id = randomUUID();
      await withAdminClient(pool, (client) =>
        client.query(
          `insert into principals (workspace_id, id, kind, role, display_name, user_id)
           values ($1, $2, $3, $4, $5, $6)`,
          [workspaceId, id, kind, role, `${kind}-${role}`, userId],
        ),
      );
      return id;
    }

    async function insertSession(
      workspaceId: string,
      kind: string,
      principalId: string,
    ): Promise<string> {
      const result = await withAdminClient(pool, (client) =>
        client.query<{ id: string }>(
          `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
           values ($1, $2, $3, $2, 'active') returning id`,
          [workspaceId, principalId, kind],
        ),
      );
      return result.rows[0]?.id ?? '';
    }

    async function publishDefinition(
      workspaceId: string,
      ownerId: string,
      extra: { readonly capabilities?: readonly string[]; readonly gates?: readonly string[] } = {},
    ): Promise<string> {
      const proposed = await inWs(workspaceId, ownerId, (client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          origin: 'human',
          kind: 'worker',
          definition: {
            systemPrompt: 'You check a ticket system.',
            name: 'ticket-checker',
            ...extra,
          },
        }),
      );
      await inWs(workspaceId, ownerId, (client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: proposed.id,
          version: proposed.version,
        }),
      );
      return proposed.id;
    }

    async function lastAudit(
      workspaceId: string,
      action: string,
    ): Promise<Record<string, unknown> | undefined> {
      const result = await withAdminClient(pool, (client) =>
        client.query<{
          payload: Record<string, unknown>;
          actor_principal_id: string;
          resource_type: string | null;
          resource_id: string | null;
        }>(
          `select payload, actor_principal_id, resource_type, resource_id from audit_records
            where workspace_id = $1 and action = $2 order by created_at desc, id desc limit 1`,
          [workspaceId, action],
        ),
      );
      const row = result.rows[0];
      return row
        ? {
            ...row.payload,
            actor: row.actor_principal_id,
            resourceType: row.resource_type,
            resourceId: row.resource_id,
          }
        : undefined;
    }

    async function auditCount(workspaceId: string, action: string): Promise<number> {
      const result = await withAdminClient(pool, (client) =>
        client.query<{ n: number }>(
          'select count(*)::int as n from audit_records where workspace_id = $1 and action = $2',
          [workspaceId, action],
        ),
      );
      return result.rows[0]?.n ?? 0;
    }

    async function setPlatformRole(user: UserRow, role: 'admin' | 'user'): Promise<void> {
      await withAdminClient(pool, (client) =>
        client.query('update users set platform_role = $2 where id = $1', [user.id, role]),
      );
    }

    /** Sets the platform's generic connectors for `kinds` to `mode` while `fn` runs, then puts
     *  back what was there. Test files run one at a time against a real database. */
    async function withConnectorModes<T>(
      kinds: readonly string[],
      mode: string,
      fn: () => Promise<T>,
    ): Promise<T> {
      const before = await withAdminClient(pool, (client) =>
        client.query<{ name: string; mode: string }>(
          'select name, mode from connectors where name = any($1::text[])',
          [kinds],
        ),
      );
      await withAdminClient(pool, (client) =>
        client.query('update connectors set mode = $2 where name = any($1::text[])', [kinds, mode]),
      );
      try {
        return await fn();
      } finally {
        for (const row of before.rows) {
          await withAdminClient(pool, (client) =>
            client.query('update connectors set mode = $2 where name = $1', [row.name, row.mode]),
          );
        }
      }
    }

    async function refusalOf(promise: Promise<unknown>): Promise<unknown> {
      return promise.then(
        () => null,
        (err: unknown) => err,
      );
    }

    async function checkViolation(sql: string, params: unknown[]): Promise<void> {
      const thrown = await refusalOf(withAdminClient(pool, (client) => client.query(sql, params)));
      expect(thrown, sql).toMatchObject({ code: '23514' });
    }

    const unusedEndpoint = () => `http://127.0.0.1:1/aa5a1-${randomUUID()}`;

    beforeAll(async () => {
      previousSwitch = process.env.ADMIN_AGENT_ENABLED;
      process.env.ADMIN_AGENT_ENABLED = '1';
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      const pair = await generateKeyPair(HANDLE_SIGNING_ALG, { crv: 'Ed25519' });
      privateKey = pair.privateKey;
      publicKey = pair.publicKey;

      const tag = randomUUID().slice(0, 8);
      admin = await createUser(pool, {
        login: `aa5a1-admin-${tag}`,
        displayName: 'AA5a-1 Admin',
        platformRole: 'admin',
      });
      const member = await createUser(pool, {
        login: `aa5a1-member-${tag}`,
        displayName: 'AA5a-1 Member',
        platformRole: 'user',
      });
      const trial = await createWorkspaceWithOwner(pool, {
        name: `aa5a1-trial-${tag}`,
        owner: { userId: admin.id, displayName: 'AA5a-1 Admin' },
        ontologyDir: ONTOLOGY_DIR,
        purpose: 'admin_trial',
      });
      trialWs = trial.workspaceId;
      adminPrincipalId = trial.ownerPrincipalId;
      memberPrincipalId = await insertPrincipal(trialWs, 'human', 'owner', member.id);
      const production = await createWorkspaceWithOwner(pool, {
        name: `aa5a1-production-${tag}`,
        owner: { userId: admin.id, displayName: 'AA5a-1 Admin' },
        ontologyDir: ONTOLOGY_DIR,
      });
      productionWs = production.workspaceId;
      productionOwnerId = production.ownerPrincipalId;

      trialDefinitionId = await publishDefinition(trialWs, adminPrincipalId);
      productionDefinitionId = await publishDefinition(productionWs, productionOwnerId);
      productionGatekeeperId = await inWs(productionWs, productionOwnerId, async (client) => {
        const activity = await startActivity(client, productionWs, {
          kind: 'test.connection',
          principalId: productionOwnerId,
        });
        const registered = await registerGatekeeper(client, productionWs, {
          name: `aa5a1-production-gate-${tag}`,
          transportKind: 'http',
          target: 'production-ticket-system',
          endpoint: unusedEndpoint(),
          connectionSecretSalt: 'f'.repeat(32),
          activityId: activity.id,
          registeredBy: { id: productionOwnerId, kind: 'human' },
        });
        return registered.gatekeeperId;
      });
      productionAdminSessionId = await insertSession(
        productionWs,
        ADMIN_AGENT_SESSION_KIND,
        productionOwnerId,
      );

      configureTaskRuntime({ pool, privateKey, supervisorClient: new RunningSupervisorClient() });
      setConnectionHandlerDeps({
        gatekeeperClient: FAKE_GATEKEEPER_CLIENT,
        connectionSecrets: CONNECTION_SECRETS,
        outboundTargetGuard: createOutboundTargetGuard({
          policy: { platformSubnets: [], allowHosts: ['127.0.0.1'] },
        }),
      });
    });

    afterAll(async () => {
      resetTaskRuntimeForTests();
      if (previousSwitch === undefined) Reflect.deleteProperty(process.env, 'ADMIN_AGENT_ENABLED');
      else process.env.ADMIN_AGENT_ENABLED = previousSwitch;
      await pool?.end();
    });

    it('request_connection through the Handle records the admin agent session on the request, its wire and its audit row; the person’s own records none', async () => {
      const { caller, sessionId } = await agent();
      const requested = (await dispatchCapability({ pool }, caller, 'request_connection', {
        kind: 'http',
        target: 'trial-ticket-system',
      })) as { id: string; status: string; adminAgentSessionId?: string };
      expect(requested.status).toBe('requested');
      expect(requested.adminAgentSessionId).toBe(sessionId);
      const row = await withAdminClient(pool, (client) =>
        client.query<{ admin_agent_session_id: string | null; requested_by: string }>(
          'select admin_agent_session_id, requested_by from connection_requests where id = $1',
          [requested.id],
        ),
      );
      expect(row.rows[0]).toEqual({
        admin_agent_session_id: sessionId,
        requested_by: adminPrincipalId,
      });
      expect(await lastAudit(trialWs, 'request_connection')).toMatchObject({
        actor: adminPrincipalId,
        sessionKind: 'admin_agent',
        sessionId,
      });
      // The default connector mode is self_serve: no exception used, no row for it.
      expect(await auditCount(trialWs, TRIAL_SELF_CONNECT_AUDIT_ACTION)).toBe(0);

      const own = (await dispatchCapability(
        { pool },
        person(trialWs, adminPrincipalId),
        'request_connection',
        { kind: 'http', target: 'trial-ticket-system-by-hand' },
      )) as { id: string; adminAgentSessionId?: string };
      expect(own).not.toHaveProperty('adminAgentSessionId');
      const listed = (await dispatchCapability(
        { pool },
        person(trialWs, adminPrincipalId),
        'list_connection_requests',
        { status: 'requested' },
      )) as { items: readonly { id: string; adminAgentSessionId?: string }[] };
      expect(listed.items.find((item) => item.id === requested.id)?.adminAgentSessionId).toBe(
        sessionId,
      );
      expect(listed.items.find((item) => item.id === own.id)).not.toHaveProperty(
        'adminAgentSessionId',
      );
    });

    it('invoke_worker through the Handle starts a published Worker whose Task records the admin agent session; an entry agent’s Task records none', async () => {
      const { caller, sessionId } = await agent();
      const started = (await dispatchCapability({ pool }, caller, 'invoke_worker', {
        definitionId: trialDefinitionId,
        version: 1,
        input: { ticket: 'T-1' },
      })) as { id: string; status: string };
      expect(started.status).toBe('running');
      const task = (await dispatchCapability({ pool }, caller, 'get_task', {
        taskId: started.id,
      })) as { onBehalfOf: string; adminAgentSessionId?: string };
      expect(task.onBehalfOf).toBe(adminPrincipalId);
      expect(task.adminAgentSessionId).toBe(sessionId);
      expect(await lastAudit(trialWs, 'invoke_worker')).toMatchObject({
        actor: adminPrincipalId,
        sessionKind: 'admin_agent',
        sessionId,
        resourceType: 'task',
        resourceId: started.id,
      });
      // The Worker's own Handle is a Worker's: nothing only an admin agent calls, no connection
      // request (the drafts a Worker may propose anyway are a Worker's own, as everywhere).
      const child = await withAdminClient(pool, (client) =>
        client.query<{ scope: { capabilities: string[] } }>(
          `select h.scope from capability_handles h
             join worker_runs r on r.session_id = h.session_id
            where r.task_id = $1`,
          [started.id],
        ),
      );
      const childCapabilities = child.rows[0]?.scope.capabilities ?? [];
      expect(childCapabilities.length).toBeGreaterThan(0);
      for (const name of [
        'platform_state_gates',
        'propose_admin_proposal',
        'agent_withdraw_admin_proposal',
        'request_connection',
      ]) {
        expect(childCapabilities, name).not.toContain(name);
      }

      // The person's own entry agent: same Principal, no admin agent session on its Task.
      const entryCaller = await entryAgent();
      const byEntry = (await dispatchCapability({ pool }, entryCaller, 'invoke_worker', {
        definitionId: trialDefinitionId,
        version: 1,
        input: { ticket: 'T-2' },
      })) as { id: string };
      const entryTask = (await dispatchCapability({ pool }, entryCaller, 'get_task', {
        taskId: byEntry.id,
      })) as Record<string, unknown>;
      expect(entryTask).not.toHaveProperty('adminAgentSessionId');
    });

    it('invoke_worker hands a Worker request_action on a trial gate only through the person’s gate Grant the Handle carries; the admin agent’s own Handle never holds it (the AA5 plan’s D1)', async () => {
      const tag = randomUUID().slice(0, 8);
      const trialGate = await inWs(trialWs, adminPrincipalId, async (client) => {
        const activity = await startActivity(client, trialWs, {
          kind: 'test.connection',
          principalId: adminPrincipalId,
        });
        const registered = await registerGatekeeper(client, trialWs, {
          name: `aa5a1-trial-gate-${tag}`,
          transportKind: 'http',
          target: 'trial-ticket-system',
          endpoint: unusedEndpoint(),
          connectionSecretSalt: 'f'.repeat(32),
          activityId: activity.id,
          registeredBy: { id: adminPrincipalId, kind: 'human' },
        });
        return registered.gatekeeperId;
      });
      const gatedDefinitionId = await publishDefinition(trialWs, adminPrincipalId, {
        capabilities: ['request_action'],
        gates: [trialGate],
      });
      const invokeGated = (caller: ResolvedCaller, ticket: string) =>
        dispatchCapability({ pool }, caller, 'invoke_worker', {
          definitionId: gatedDefinitionId,
          version: 1,
          input: { ticket },
        }) as Promise<{ id: string }>;

      // No gate carried: a Worker that must ask for actions cannot be started at all.
      const bare = await agent();
      expect(bare.claims.scope.capabilities).not.toContain('request_action');
      expect(await refusalOf(invokeGated(bare.caller, 'T-d1-1'))).toMatchObject({
        name: 'InvokeWorkerAttenuationError',
      });

      // The gate Grant carried, as the runtime issues it: the Worker may ask for actions on that
      // gate (each still decided by policy or a person); the admin agent itself still may not.
      const granted = await agent({ gatekeeper: [trialGate] });
      expect(granted.claims.scope.capabilities).not.toContain('request_action');
      expect(granted.claims.scope.resources.gatekeeper).toEqual([trialGate]);
      const started = await invokeGated(granted.caller, 'T-d1-2');
      try {
        const child = await withAdminClient(pool, (client) =>
          client.query<{ scope: { capabilities: string[]; resources: Record<string, string[]> } }>(
            `select h.scope from capability_handles h
               join worker_runs r on r.session_id = h.session_id
              where r.task_id = $1`,
            [started.id],
          ),
        );
        expect(child.rows).toHaveLength(1);
        expect(child.rows[0]?.scope.capabilities).toContain('request_action');
        expect(child.rows[0]?.scope.resources.gatekeeper).toEqual([trialGate]);
      } finally {
        // The supervisor fake keeps every WorkerRun running: end this one so it does not count
        // against the person's concurrency quota in the tests after it.
        await dispatchCapability({ pool }, person(trialWs, adminPrincipalId), 'cancel_task', {
          taskId: started.id,
        });
      }

      // A gate carried for one system does not open another: a production gate is not declared
      // by the trial definition, and the trial gate alone is all the Worker gets.
      expect(
        await refusalOf(
          dispatchCapability({ pool }, granted.caller, 'invoke_worker', {
            definitionId: gatedDefinitionId,
            version: 1,
            input: { ticket: 'T-d1-3' },
            gates: [productionGatekeeperId],
          }),
        ),
      ).toMatchObject({ name: 'InvokeWorkerValidationError' });
    });

    it('a Worker the admin agent starts hands its result back and its Task completes; the admin agent’s own Handle cannot report one', async () => {
      const { caller } = await agent();
      const started = (await dispatchCapability({ pool }, caller, 'invoke_worker', {
        definitionId: trialDefinitionId,
        version: 1,
        input: { ticket: 'T-report-1' },
      })) as { id: string };
      const worker = await workerOf(started.id);
      expect(worker.scope.capabilities).toContain('report_task_result');

      // Its own session is no WorkerRun's: refused, and the Worker's Task is untouched by it.
      expect(
        await refusalOf(
          dispatchCapability({ pool }, caller, 'report_task_result', { summary: 'not mine' }),
        ),
      ).toMatchObject({ message: expect.stringMatching(/not bound|not a WorkerRun/i) });

      const reported = (await dispatchCapability({ pool }, worker.caller, 'report_task_result', {
        summary: 'T-report-1 checked',
      })) as { id: string; status: string };
      expect(reported).toMatchObject({ id: started.id, status: 'completed' });
      const task = (await dispatchCapability({ pool }, caller, 'get_task', {
        taskId: started.id,
      })) as { status: string; result?: { summary?: string } };
      expect(task.status).toBe('completed');
      expect(task.result?.summary).toBe('T-report-1 checked');
    });

    it('a Worker the admin agent starts asks for an execute Operation on a trial gate as any Worker does: an ordinary ActionRequest, pending and the gate untouched until the person approves it; neither Handle can decide it (legacy 641)', async () => {
      const applied: string[] = [];
      const recordingGate: GatekeeperClient = {
        ...FAKE_GATEKEEPER_CLIENT,
        simulate: async () => ({ description: 'would open a ticket (test fake)' }),
        apply: async (_target, input) => {
          applied.push(input.operation);
          return { data: { ticket: 'T-641' }, replayed: false };
        },
      };
      const withTransaction = createAdminWithTransaction(pool);
      const drainer = new ApprovalDrainer({
        executor: createGatekeeperActionExecutor({
          gatekeeperClient: recordingGate,
          withTransaction,
        }),
        withTransaction,
      });
      setRequestActionDeps({ gatekeeperClient: recordingGate, drainer });

      const tag = randomUUID().slice(0, 8);
      const trialGate = await inWs(trialWs, adminPrincipalId, async (client) => {
        const activity = await startActivity(client, trialWs, {
          kind: 'test.connection',
          principalId: adminPrincipalId,
        });
        const registered = await registerGatekeeper(client, trialWs, {
          name: `aa5a1-ticket-gate-${tag}`,
          transportKind: 'http',
          target: 'trial-ticket-system',
          endpoint: unusedEndpoint(),
          connectionSecretSalt: 'f'.repeat(32),
          activityId: activity.id,
          registeredBy: { id: adminPrincipalId, kind: 'human' },
        });
        await importManifest(client, trialWs, {
          gatekeeperId: registered.gatekeeperId,
          operations: [TICKET_CREATE],
          proposedBy: { id: adminPrincipalId, kind: 'human' },
          activityId: activity.id,
        });
        await publishOperation(client, trialWs, {
          gatekeeperId: registered.gatekeeperId,
          name: TICKET_CREATE.name,
        });
        return registered.gatekeeperId;
      });
      const definitionId = await publishDefinition(trialWs, adminPrincipalId, {
        capabilities: ['request_action'],
        gates: [trialGate],
      });
      const { caller: adminAgent } = await agent({ gatekeeper: [trialGate] });
      const started = (await dispatchCapability({ pool }, adminAgent, 'invoke_worker', {
        definitionId,
        version: 1,
        input: { ticket: 'T-641' },
      })) as { id: string };
      const administrator = person(trialWs, adminPrincipalId);
      const statusOf = async (actionRequestId: string) =>
        (
          (await dispatchCapability({ pool }, administrator, 'get_action', {
            actionRequestId,
          })) as { status: string }
        ).status;
      try {
        const worker = await workerOf(started.id);
        const requested = (await dispatchCapability({ pool }, worker.caller, 'request_action', {
          gatekeeperId: trialGate,
          operation: TICKET_CREATE.name,
          params: { title: 'T-641' },
        })) as { id: string };
        // The request any Worker's call makes: decided by the policy, which sends it to a person.
        expect(requested).toMatchObject({
          status: 'pending_approval',
          policyDecision: 'require_approval',
          onBehalfOf: adminPrincipalId,
          parentWorkerRunId: worker.workerRunId,
        });
        // Undecided, it never reaches the gate — not from the call, not from a drain.
        await drainer.drainGatekeeper(trialWs, adminPrincipalId, trialGate);
        expect(applied).toEqual([]);

        // Neither the admin agent nor its Worker decides it: `approve` is the person's own, on the
        // human channel only.
        for (const handle of [adminAgent, worker.caller]) {
          const refused = await refusalOf(
            dispatchCapability({ pool }, handle, 'approve', { actionRequestId: requested.id }),
          );
          expect(refused).toBeInstanceOf(ForbiddenError);
          expect(refused).toMatchObject({ reason: 'human_channel_only' });
        }
        expect(await statusOf(requested.id)).toBe('pending_approval');

        // The person approves it, and it runs once, the way every approved request runs.
        const approved = (await dispatchCapability({ pool }, administrator, 'approve', {
          actionRequestId: requested.id,
        })) as { status: string; decidedBy: string | null };
        expect(approved).toMatchObject({ status: 'approved', decidedBy: adminPrincipalId });
        await drainer.drainGatekeeper(trialWs, adminPrincipalId, trialGate);
        expect(applied).toEqual([TICKET_CREATE.name]);
        expect(await statusOf(requested.id)).toBe('executed');
      } finally {
        await dispatchCapability({ pool }, administrator, 'cancel_task', { taskId: started.id });
      }
    });

    it('invoke_worker attributes the Task to the Turn that started it: an admin agent’s Task to its own running Turn, never to an entry Turn running beside it', async () => {
      const { caller, sessionId } = await agent();
      const entryCaller = await entryAgent();
      const invoke = async (who: ResolvedCaller, ticket: string) =>
        (
          (await dispatchCapability({ pool }, who, 'invoke_worker', {
            definitionId: trialDefinitionId,
            version: 1,
            input: { ticket },
          })) as { id: string }
        ).id;

      // The admin Turn starts first, so the entry Turn is the person's most recent running one.
      const adminTurn = await startRunningTurn('admin_agent', sessionId);
      const entryTurn = await startRunningTurn('entry');
      try {
        expect(await taskTurn(await invoke(caller, 'T-attr-1'))).toBe(adminTurn);
        expect(await taskTurn(await invoke(entryCaller, 'T-attr-2'))).toBe(entryTurn);
        // Legacy 443: a client the person issued a Handle to (`mcp_session`) starts its Task from
        // no Turn, whichever of the person's agents is running one.
        const ownClient = await entryAgent('mcp_session');
        // The supervisor fake keeps every WorkerRun running: end each of these once checked, so
        // the person stays under the concurrency quota for the calls below.
        const cancel = (taskId: string) =>
          dispatchCapability({ pool }, person(trialWs, adminPrincipalId), 'cancel_task', {
            taskId,
          });
        const ownTask = await invoke(ownClient, 'T-attr-2b');
        expect(await taskTurn(ownTask)).toBeNull();
        await cancel(ownTask);
        // Nor does a Handle whose session this workspace has no row of (dispatch reads none, legacy
        // 759: its kind is `null`, never taken for an entry session).
        if (entryCaller.channel !== 'handle') throw new Error('expected a Handle caller');
        const noSession: ResolvedCaller = {
          ...entryCaller,
          claims: { ...entryCaller.claims, sid: randomUUID() },
        };
        const noSessionTask = await invoke(noSession, 'T-attr-2c');
        expect(await taskTurn(noSessionTask)).toBeNull();
        await cancel(noSessionTask);

        // No running Turn of its own: the admin agent's Task belongs to no Turn, even with the
        // person's entry Turn still running.
        await endTurn(adminTurn);
        expect(await taskTurn(await invoke(caller, 'T-attr-3'))).toBeNull();
      } finally {
        await endTurn(adminTurn);
        await endTurn(entryTurn);
      }
    });

    it('a production workspace’s Worker or gate cannot be reached from the trial workspace, and a trial request cannot be completed from production', async () => {
      const { caller } = await agent();
      // Another workspace's definition does not exist here.
      expect(
        await refusalOf(
          dispatchCapability({ pool }, caller, 'invoke_worker', {
            definitionId: productionDefinitionId,
            version: 1,
            input: {},
          }),
        ),
      ).toBeInstanceOf(Error);
      // Another workspace's gate is not one the trial definition declares.
      expect(
        await refusalOf(
          dispatchCapability({ pool }, caller, 'invoke_worker', {
            definitionId: trialDefinitionId,
            version: 1,
            input: { ticket: 'T-3' },
            gates: [productionGatekeeperId],
          }),
        ),
      ).toMatchObject({ name: 'InvokeWorkerValidationError' });
      const strays = await withAdminClient(pool, (client) =>
        client.query(
          `select 1 from tasks
            where (workspace_id = $1 and worker_definition_id = $2)
               or (workspace_id = $3 and admin_agent_session_id is not null)`,
          [trialWs, productionDefinitionId, productionWs],
        ),
      );
      expect(strays.rowCount).toBe(0);

      // A trial request is invisible from production and cannot be completed there.
      const requested = (await dispatchCapability({ pool }, caller, 'request_connection', {
        kind: 'http',
        target: 'trial-only-system',
      })) as { id: string };
      const productionQueue = (await dispatchCapability(
        { pool },
        person(productionWs, productionOwnerId),
        'list_connection_requests',
        {},
      )) as { items: readonly { id: string }[] };
      expect(productionQueue.items.map((item) => item.id)).not.toContain(requested.id);
      expect(
        await refusalOf(
          dispatchCapability(
            { pool },
            person(productionWs, productionOwnerId),
            'create_connection',
            {
              connectionRequestId: requested.id,
              kind: 'http',
              target: 'trial-only-system',
              endpoint: unusedEndpoint(),
              connectionSecret: CONNECTION_SECRETS.mint(productionWs).secret,
              credentialKind: 'shared',
            },
          ),
        ),
      ).toBeInstanceOf(Error);
      const stillRequested = await withAdminClient(pool, (client) =>
        client.query<{ status: string }>('select status from connection_requests where id = $1', [
          requested.id,
        ]),
      );
      expect(stillRequested.rows[0]?.status).toBe('requested');
    });

    it('outside a trial workspace the handlers refuse an admin agent themselves, whatever the caller says it is (not_trial_workspace)', async () => {
      const invokeWorker = CAPABILITY_HANDLERS.get('invoke_worker');
      expect(invokeWorker).toBeDefined();
      const ctxs: CapabilityHandlerContext[] = [
        // As the dispatcher builds it after its own check.
        {
          channel: 'handle',
          principalId: productionOwnerId,
          adminAgent: { sessionId: productionAdminSessionId, userId: admin.id },
        } as CapabilityHandlerContext,
        // A caller built without the dispatcher's field: the session row says what it is.
        {
          channel: 'handle',
          principalId: productionOwnerId,
          claims: { sid: productionAdminSessionId },
        } as unknown as CapabilityHandlerContext,
      ];
      for (const ctx of ctxs) {
        const requested = await refusalOf(
          inWs(productionWs, productionOwnerId, (client) =>
            requestConnectionHandler(
              client,
              productionWs,
              { kind: 'http', target: 'production-system' },
              ctx,
            ),
          ),
        );
        expect(requested).toBeInstanceOf(AdminAgentRefused);
        expect((requested as AdminAgentRefused).reason).toBe('not_trial_workspace');
        const invoked = await refusalOf(
          inWs(productionWs, productionOwnerId, (client) =>
            (invokeWorker as NonNullable<typeof invokeWorker>)(
              client,
              productionWs,
              { definitionId: productionDefinitionId, version: 1, input: {} },
              ctx,
            ),
          ),
        );
        expect(invoked).toBeInstanceOf(AdminAgentRefused);
        expect((invoked as AdminAgentRefused).reason).toBe('not_trial_workspace');
      }
      // The person's own call there is untouched by it.
      await expect(
        inWs(productionWs, productionOwnerId, (client) =>
          requestConnectionHandler(
            client,
            productionWs,
            { kind: 'http', target: 'production-system-by-hand' },
            { channel: 'human', principalId: productionOwnerId } as CapabilityHandlerContext,
          ),
        ),
      ).resolves.toBeDefined();
      const recorded = await withAdminClient(pool, (client) =>
        client.query(
          `select 1 from connection_requests where workspace_id = $1 and admin_agent_session_id is not null
           union all
           select 1 from tasks where workspace_id = $1 and admin_agent_session_id is not null`,
          [productionWs],
        ),
      );
      expect(recorded.rowCount).toBe(0);
    });

    it('the database records an admin agent session only for its own Principal in a trial workspace, and never changes it', async () => {
      const { sessionId } = await agent();
      const entrySession = await insertSession(trialWs, 'entry', adminPrincipalId);

      // connection_requests (governance 0037)
      const insertRequest = `insert into connection_requests
          (workspace_id, kind, target, requested_by, admin_agent_session_id) values ($1, 'http', 'probe', $2, $3)`;
      await checkViolation(insertRequest, [
        productionWs,
        productionOwnerId,
        productionAdminSessionId,
      ]);
      await checkViolation(insertRequest, [trialWs, adminPrincipalId, entrySession]);
      await checkViolation(insertRequest, [trialWs, memberPrincipalId, sessionId]);
      const accepted = await withAdminClient(pool, (client) =>
        client.query<{ id: string }>(`${insertRequest} returning id`, [
          trialWs,
          adminPrincipalId,
          sessionId,
        ]),
      );
      const requestId = accepted.rows[0]?.id;
      await checkViolation(
        'update connection_requests set admin_agent_session_id = null where id = $1',
        [requestId],
      );
      // Completing or cancelling it leaves it as it is.
      await withAdminClient(pool, (client) =>
        client.query("update connection_requests set status = 'cancelled' where id = $1", [
          requestId,
        ]),
      );

      // tasks (task 0013)
      const insertTask = `insert into tasks
          (workspace_id, on_behalf_of, worker_definition_id, worker_definition_version, admin_agent_session_id)
          values ($1, $2, $3, 1, $4)`;
      await checkViolation(insertTask, [
        productionWs,
        productionOwnerId,
        productionDefinitionId,
        productionAdminSessionId,
      ]);
      await checkViolation(insertTask, [
        trialWs,
        adminPrincipalId,
        trialDefinitionId,
        entrySession,
      ]);
      await checkViolation(insertTask, [trialWs, memberPrincipalId, trialDefinitionId, sessionId]);
      const task = await withAdminClient(pool, (client) =>
        client.query<{ id: string }>(`${insertTask} returning id`, [
          trialWs,
          adminPrincipalId,
          trialDefinitionId,
          sessionId,
        ]),
      );
      const taskId = task.rows[0]?.id;
      await checkViolation('update tasks set admin_agent_session_id = null where id = $1', [
        taskId,
      ]);
      const plain = await withAdminClient(pool, (client) =>
        client.query<{ id: string }>(
          `insert into tasks (workspace_id, on_behalf_of, worker_definition_id, worker_definition_version)
           values ($1, $2, $3, 1) returning id`,
          [trialWs, adminPrincipalId, trialDefinitionId],
        ),
      );
      await checkViolation('update tasks set admin_agent_session_id = $2 where id = $1', [
        plain.rows[0]?.id,
        sessionId,
      ]);
    });

    it('demoting the administrator refuses both at once (I-A3)', async () => {
      const { caller } = await agent();
      await setPlatformRole(admin, 'user');
      try {
        for (const [name, params] of [
          ['request_connection', { kind: 'http', target: 'after-demotion' }],
          ['invoke_worker', { definitionId: trialDefinitionId, version: 1, input: { n: 9 } }],
        ] as const) {
          const thrown = await refusalOf(dispatchCapability({ pool }, caller, name, params));
          expect(thrown, name).toBeInstanceOf(AdminAgentCallRefusedError);
          expect((thrown as AdminAgentCallRefusedError).refusal, name).toBe('not_platform_admin');
          expect(await lastAudit(trialWs, name), name).toMatchObject({
            sessionKind: 'admin_agent',
            outcome: 'refused',
            refusal: { reason: 'not_platform_admin' },
          });
        }
      } finally {
        await setPlatformRole(admin, 'admin');
      }
    });

    it('in a trial workspace a platform administrator self-connects http or mcp while the connector is platform-preset, each use audited; nobody else, no other kind, no other workspace', async () => {
      await withConnectorModes(['http', 'mcp', 'cli'], 'platform_preset', async () => {
        const { caller, sessionId } = await agent();
        const before = await auditCount(trialWs, TRIAL_SELF_CONNECT_AUDIT_ACTION);

        // The admin agent asks.
        const requested = (await dispatchCapability({ pool }, caller, 'request_connection', {
          kind: 'mcp',
          target: 'trial-mcp-system',
        })) as { id: string; adminAgentSessionId?: string };
        expect(requested.adminAgentSessionId).toBe(sessionId);
        expect(await lastAudit(trialWs, TRIAL_SELF_CONNECT_AUDIT_ACTION)).toMatchObject({
          actor: adminPrincipalId,
          capability: 'request_connection',
          kind: 'mcp',
          connectorMode: 'platform_preset',
          sessionKind: 'admin_agent',
          sessionId,
          resourceType: 'connection_request',
          resourceId: requested.id,
        });

        // Not another kind.
        expect(
          await refusalOf(
            dispatchCapability({ pool }, caller, 'request_connection', {
              kind: 'cli',
              target: 'trial-cli-system',
            }),
          ),
        ).toBeInstanceOf(ConnectorNotSelfServeError);
        // Not someone who is not a platform administrator, though an owner here.
        expect(
          await refusalOf(
            dispatchCapability({ pool }, person(trialWs, memberPrincipalId), 'request_connection', {
              kind: 'http',
              target: 'member-system',
            }),
          ),
        ).toBeInstanceOf(ConnectorNotSelfServeError);
        // Not another workspace, though the same platform administrator.
        expect(
          await refusalOf(
            dispatchCapability(
              { pool },
              person(productionWs, productionOwnerId),
              'request_connection',
              { kind: 'http', target: 'production-system' },
            ),
          ),
        ).toBeInstanceOf(ConnectorNotSelfServeError);

        // Completing it: a member who is not a platform administrator cannot.
        const completeParams = (secret: string) => ({
          connectionRequestId: requested.id,
          kind: 'mcp',
          target: 'trial-mcp-system',
          endpoint: unusedEndpoint(),
          connectionSecret: secret,
          credentialKind: 'shared',
        });
        expect(
          await refusalOf(
            dispatchCapability(
              { pool },
              person(trialWs, memberPrincipalId),
              'create_connection',
              completeParams(CONNECTION_SECRETS.mint(trialWs).secret),
            ),
          ),
        ).toBeInstanceOf(ConnectorNotSelfServeError);
        // The platform administrator, in the console, can — and that use is audited too.
        const created = (await dispatchCapability(
          { pool },
          person(trialWs, adminPrincipalId),
          'create_connection',
          completeParams(await issuedSecret(trialWs, adminPrincipalId)),
        )) as { gatekeeperId: string; connectionRequestId: string | null };
        expect(created.connectionRequestId).toBe(requested.id);
        const completion = await lastAudit(trialWs, TRIAL_SELF_CONNECT_AUDIT_ACTION);
        expect(completion).toMatchObject({
          actor: adminPrincipalId,
          capability: 'create_connection',
          kind: 'mcp',
          connectorMode: 'platform_preset',
          resourceType: 'gatekeeper',
          resourceId: created.gatekeeperId,
        });
        expect(completion).not.toHaveProperty('sessionKind');
        expect(await auditCount(trialWs, TRIAL_SELF_CONNECT_AUDIT_ACTION)).toBe(before + 2);
        // A self connection like any other: the platform sees it and can suspend it.
        const self = await withAdminClient(pool, (client) =>
          client.query('select 1 from workspace_self_connections where gatekeeper_object_id = $1', [
            created.gatekeeperId,
          ]),
        );
        expect(self.rowCount).toBe(1);
        // The completed request keeps the admin agent session it came through.
        const row = await withAdminClient(pool, (client) =>
          client.query<{ status: string; admin_agent_session_id: string | null }>(
            'select status, admin_agent_session_id from connection_requests where id = $1',
            [requested.id],
          ),
        );
        expect(row.rows[0]).toEqual({ status: 'completed', admin_agent_session_id: sessionId });

        // Demoted, the same administrator no longer gets the exception.
        await setPlatformRole(admin, 'user');
        try {
          expect(
            await refusalOf(
              dispatchCapability(
                { pool },
                person(trialWs, adminPrincipalId),
                'request_connection',
                { kind: 'http', target: 'after-demotion-by-hand' },
              ),
            ),
          ).toBeInstanceOf(ConnectorNotSelfServeError);
        } finally {
          await setPlatformRole(admin, 'admin');
        }

        // A trial workspace taken out of use (disabled — a workspace is purged only once it is)
        // no longer grants the exception either.
        const disabled = await withAdminClient(pool, async (client) => {
          await client.query("update workspaces set status = 'disabled' where id = $1", [trialWs]);
          try {
            return await isPlatformAdminInTrialWorkspace(client, trialWs, adminPrincipalId);
          } finally {
            await client.query("update workspaces set status = 'active' where id = $1", [trialWs]);
          }
        });
        expect(disabled).toBe(false);
        expect(
          await withAdminClient(pool, (client) =>
            isPlatformAdminInTrialWorkspace(client, trialWs, adminPrincipalId),
          ),
        ).toBe(true);
      });
    });

    it('a connector the platform disabled stays closed in a trial workspace too: no request, no completion, no exception audited (coordinator 2026-11-05)', async () => {
      const { caller } = await agent();
      // Asked for while the platform ran http itself, then switched off before anyone completed it.
      const requested = await withConnectorModes(
        ['http'],
        'platform_preset',
        async () =>
          dispatchCapability({ pool }, caller, 'request_connection', {
            kind: 'http',
            target: 'switched-off-later',
          }) as Promise<{ id: string }>,
      );
      await withConnectorModes(['http', 'mcp'], 'disabled', async () => {
        const before = await auditCount(trialWs, TRIAL_SELF_CONNECT_AUDIT_ACTION);
        for (const kind of ['http', 'mcp'] as const) {
          // The admin agent cannot ask…
          const byAgent = await refusalOf(
            dispatchCapability({ pool }, caller, 'request_connection', {
              kind,
              target: `disabled-${kind}`,
            }),
          );
          expect(byAgent, kind).toBeInstanceOf(ConnectorNotSelfServeError);
          expect(byAgent, kind).toMatchObject({ code: 'connector_not_self_serve' });
          // …nor its platform administrator, by hand.
          expect(
            await refusalOf(
              dispatchCapability(
                { pool },
                person(trialWs, adminPrincipalId),
                'request_connection',
                { kind, target: `disabled-${kind}-by-hand` },
              ),
            ),
            kind,
          ).toBeInstanceOf(ConnectorNotSelfServeError);
        }
        // Nor complete what was asked for before the switch.
        expect(
          await refusalOf(
            dispatchCapability({ pool }, person(trialWs, adminPrincipalId), 'create_connection', {
              connectionRequestId: requested.id,
              kind: 'http',
              target: 'switched-off-later',
              endpoint: unusedEndpoint(),
              connectionSecret: CONNECTION_SECRETS.mint(trialWs).secret,
              credentialKind: 'shared',
            }),
          ),
        ).toBeInstanceOf(ConnectorNotSelfServeError);
        expect(await auditCount(trialWs, TRIAL_SELF_CONNECT_AUDIT_ACTION)).toBe(before);
        const row = await withAdminClient(pool, (client) =>
          client.query<{ status: string }>('select status from connection_requests where id = $1', [
            requested.id,
          ]),
        );
        expect(row.rows[0]?.status).toBe('requested');
      });
    });

    it('a purged trial workspace takes the exception with it: its administrator gets none there, no call reaches it, its admin agent’s Handle is dead, and no request or self connection of it is left (legacy 640)', async () => {
      const tag = randomUUID().slice(0, 8);
      const purged = await createWorkspaceWithOwner(pool, {
        name: `aa5a1-purged-trial-${tag}`,
        owner: { userId: admin.id, displayName: 'AA5a-1 Admin' },
        ontologyDir: ONTOLOGY_DIR,
        purpose: 'admin_trial',
      });
      const ws = purged.workspaceId;
      const adminHere = purged.ownerPrincipalId;
      const exceptionHolds = (workspaceId: string, principalId: string) =>
        withAdminClient(pool, (client) =>
          isPlatformAdminInTrialWorkspace(client, workspaceId, principalId),
        );
      const rowsOf = async (table: 'connection_requests' | 'workspace_self_connections') => {
        const result = await withAdminClient(pool, (client) =>
          client.query<{ n: number }>(
            `select count(*)::int as n from ${table} where workspace_id = $1`,
            [ws],
          ),
        );
        return result.rows[0]?.n ?? 0;
      };

      await withConnectorModes(['http'], 'platform_preset', async () => {
        // Before: the exception holds here, as in the trial workspace every other test uses. The
        // admin agent asks twice; the administrator completes one, the other is left open.
        expect(await exceptionHolds(ws, adminHere)).toBe(true);
        const issued = await inWs(ws, adminHere, (client) =>
          issueAdminAgentHandle(client, {
            workspaceId: ws,
            principalId: adminHere,
            ttlSeconds: 600,
            privateKey,
          }),
        );
        const claims = await authenticateHandle(pool, issued.token, { publicKey }, 'source');
        const asAgent = (target: string) =>
          dispatchCapability({ pool }, { channel: 'handle', claims }, 'request_connection', {
            kind: 'http',
            target,
          }) as Promise<{ id: string }>;
        const completedRequest = await asAgent('purged-trial-completed');
        const openRequest = await asAgent('purged-trial-left-open');
        await dispatchCapability({ pool }, person(ws, adminHere), 'create_connection', {
          connectionRequestId: completedRequest.id,
          kind: 'http',
          target: 'purged-trial-completed',
          endpoint: unusedEndpoint(),
          connectionSecret: await issuedSecret(ws, adminHere),
          credentialKind: 'shared',
        });
        expect(await rowsOf('connection_requests')).toBe(2);
        expect(await rowsOf('workspace_self_connections')).toBe(1);

        // Taken out of use, and purged once its retention has passed — the same function and the
        // same eligibility check the console's purge_workspace runs (no operator `force`).
        await withAdminClient(pool, (client) =>
          client.query(
            `update workspaces set status = 'disabled',
                    disabled_at = now() - make_interval(days => $2::int + 1)
              where id = $1`,
            [ws, PURGE_RETENTION_DAYS],
          ),
        );
        await purgeWorkspace(pool, { workspaceId: ws, confirm: true, actorUserId: admin.id });

        // After: the exception's own check says no for the same platform administrator…
        expect(await exceptionHolds(ws, adminHere)).toBe(false);
        // …and nothing reaches it: asking again, or completing the request left open, is refused
        // before any handler runs, as every call into a workspace that is not active is…
        const afterPurge = [
          dispatchCapability({ pool }, person(ws, adminHere), 'request_connection', {
            kind: 'http',
            target: 'after-purge-by-hand',
          }),
          dispatchCapability({ pool }, person(ws, adminHere), 'create_connection', {
            connectionRequestId: openRequest.id,
            kind: 'http',
            target: 'purged-trial-left-open',
            endpoint: unusedEndpoint(),
            connectionSecret: CONNECTION_SECRETS.mint(ws).secret,
            credentialKind: 'shared',
          }),
        ];
        for (const call of afterPurge) {
          const refused = await refusalOf(call);
          expect(refused).toBeInstanceOf(ForbiddenError);
          expect(refused).toMatchObject({ message: expect.stringMatching(/^workspace_disabled/) });
        }
        // …and the admin agent's Handle no longer authenticates.
        expect(
          await refusalOf(authenticateHandle(pool, issued.token, { publicKey }, 'source')),
        ).toBeInstanceOf(HandleRevoked);
        // Nothing of it is left for the platform to count as a self connection, or to complete.
        expect(await rowsOf('connection_requests')).toBe(0);
        expect(await rowsOf('workspace_self_connections')).toBe(0);
      });
      // The trial workspace still in use keeps its exception.
      expect(await exceptionHolds(trialWs, adminPrincipalId)).toBe(true);
    });
  },
);
