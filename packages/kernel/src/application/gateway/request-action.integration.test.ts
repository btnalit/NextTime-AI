import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GatekeeperBase,
  InMemoryIdempotencyStore,
  TransportTimeoutError,
  createGatekeeperServer,
} from '@nexttime/gatekeeper-base';
import type { Transport, TransportInvokeResult } from '@nexttime/gatekeeper-base';
import type { Operation, Role } from '@nexttime/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  type GateTarget,
  type GatekeeperClient,
  GatekeeperTimeoutError,
  HttpGatekeeperClient,
  deriveConnectionSecret,
} from '../../adapters/gatekeeper-client/index.js';
import { createOutboundTargetGuard } from '../../adapters/outbound-target/index.js';
import { setAgentPolicy, setAgentProfile } from '../../governance/agent-profile/index.js';
import {
  ApprovalDrainer,
  approveActionRequest,
  getActionRequest,
  rejectActionRequest,
} from '../../governance/approval/index.js';
import { entryScope, grantCapability } from '../../governance/capability/index.js';
import {
  importManifest,
  publishOperation,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { queryAudit } from '../../substrate/audit/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import {
  createAdminWithTransaction,
  createGatekeeperActionExecutor,
  reapStaleExecutingActionRequests,
} from './action-executor.js';
import { dispatchCapability } from './dispatch.js';
import { setRequestActionDeps } from './request-action-handler.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * Integration tests (real Postgres + a real fake Gatekeeper HTTP server; auto-skip without
 * DATABASE_URL) for `request_action` end-to-end, including the S2.4 two-phase fix (coordinator
 * review, PR #42 — see request-action-handler.ts's own module doc comment for the full
 * phase-1/phase-2 decision table). Three scenarios specifically exercise what the single-phase
 * version got wrong:
 *
 *   1. `await_decision:true`, approved from a genuinely separate connection ~150ms after the
 *      call starts → must actually observe the approval and execute (a single-phase handler
 *      polling its own still-open transaction could never see it — this would just time out).
 *   2. `auto_approved` → the gate is only ever called once the ActionRequest row is visible from
 *      a second pool connection (proven from *inside* the fake gate's own transport, not
 *      inferred) — the single-phase version called `apply` while the row (and its audit/outbox
 *      rows) were still uncommitted.
 *   3. The async drain consumer and phase 2's own execution attempt racing on the same row still
 *      apply exactly once.
 *
 * The fake Gatekeeper is a *real* `@nexttime/gatekeeper-base` `GatekeeperBase` + Fastify server on
 * a real local port — this exercises the actual HTTP wire (adapters/gatekeeper-client ⇄
 * gatekeeper-base/server.ts), not an in-process fake of the client port.
 *
 * R-01 / maintainer decision D-01: the fake gate is registered the way a self-connected gate is
 * (`registerGatekeeper` with a connection-secret salt, no catalog instance at its address), so it is
 * configured with — and every kernel call presents — its own derived connection secret, never
 * GATE_TEST_TOKEN itself. Its loopback address is allowed past the owner-supplied-URL predicate
 * (R-27) explicitly; the predicate's own cases are unit tests.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
// review lane 5, P1-1: every /gate/* route now requires Authorization: Bearer <token> — this
// test's own fake gate server and every HttpGatekeeperClient it talks to share this fixed value.
const GATE_TEST_TOKEN = 'gate-integration-test-token-0123456789abcdef';
const GATE_CONNECTION_SALT = 'e'.repeat(32);
const ALLOW_LOOPBACK = createOutboundTargetGuard({
  policy: { platformSubnets: [], allowHosts: ['127.0.0.1'] },
});

function testGatekeeperClient(): HttpGatekeeperClient {
  return new HttpGatekeeperClient({ token: GATE_TEST_TOKEN, outboundTargetGuard: ALLOW_LOOPBACK });
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Records every `invoke()` call, and — for `execute`-mode operations — proves the ActionRequest
 * row is visible (`status = 'executing'`) from a *second*, independently-acquired connection at
 * the moment the gate is actually invoked. This is exactly the property the pre-fix single-phase
 * handler violated (it called `apply` while the row was still sitting inside the still-open
 * phase-1 transaction, invisible to every other connection).
 */
class RecordingTransport implements Transport {
  readonly kind = 'http' as const;
  readonly calls: Record<string, number> = {};
  readonly visibilityChecks: Record<string, boolean> = {};
  private readonly pool: Pool;
  private readonly workspaceId: string;

  constructor(pool: Pool, workspaceId: string) {
    this.pool = pool;
    this.workspaceId = workspaceId;
  }

  async invoke(operation: Operation, params: unknown): Promise<TransportInvokeResult> {
    this.calls[operation.name] = (this.calls[operation.name] ?? 0) + 1;

    if (operation.mode === 'execute') {
      const client = await this.pool.connect();
      try {
        const result = await client.query<{ n: number }>(
          `select count(*)::int as n from action_requests
           where workspace_id = $1 and action_kind = $2 and status = 'executing'`,
          [this.workspaceId, operation.name],
        );
        this.visibilityChecks[operation.name] = (result.rows[0]?.n ?? 0) >= 1;
      } finally {
        client.release();
      }
    }

    if (operation.name === 'observe.stock') {
      return { data: { items: [{ sku: 'X1', qty: 7 }] } };
    }
    // `slowMs` simulates a long-running effect (STATUS leftover 105's inline-wait test).
    const slowMs = (params as { slowMs?: unknown } | undefined)?.slowMs;
    if (typeof slowMs === 'number') await sleep(slowMs);
    // `gateTimeout` simulates the gate's own exec timeout killing the call (R-51): the gate
    // records the key as outcome unknown and answers 409 `apply_outcome_unknown`.
    if ((params as { gateTimeout?: unknown } | undefined)?.gateTimeout === true) {
      throw new TransportTimeoutError('fake transport: command timed out and was killed');
    }
    return { data: { ok: true, operation: operation.name, params } };
  }
}

const OBSERVE_OP: Operation = {
  name: 'observe.stock',
  binding: { kind: 'http', method: 'GET', path: '/stock' },
  params_schema: {},
  mode: 'observe',
  blast_radius: 'low',
  reversibility: false,
  auto_approvable: true,
  await_decision: false,
  reads: [],
  writes: [],
  result_mapping: {
    jmes_path: 'items[]',
    object_type: 'test.Stock',
    identity_keys: ['sku'],
    attributes: { quantity: 'qty' },
  },
};

const AUTO_OP: Operation = {
  name: 'auto.op',
  binding: { kind: 'http', method: 'POST', path: '/auto' },
  params_schema: {},
  mode: 'execute',
  blast_radius: 'low',
  reversibility: false,
  auto_approvable: true,
  await_decision: false,
  reads: [],
  writes: [],
};

const PENDING_OP: Operation = {
  name: 'pending.op',
  binding: { kind: 'http', method: 'POST', path: '/pending' },
  params_schema: {},
  mode: 'execute',
  blast_radius: 'medium',
  reversibility: false,
  auto_approvable: false,
  await_decision: true,
  reads: [],
  writes: [],
};

const DRAFT_OP: Operation = {
  name: 'draft.op',
  binding: { kind: 'http', method: 'POST', path: '/draft' },
  params_schema: {},
  mode: 'execute',
  blast_radius: 'low',
  reversibility: false,
  auto_approvable: true,
  await_decision: false,
  reads: [],
  writes: [],
};

/** `awaitDecisionTimeoutMs` for this whole suite — short enough that the two "let it time out"
 *  tests stay fast, long enough that the ~150ms-delayed external-approve tests comfortably land
 *  within budget (phase 2 polls every 200ms — see request-action-handler.ts's
 *  `PHASE2_POLL_INTERVAL_MS`). */
const AWAIT_DECISION_TIMEOUT_MS = 800;
const APPROVE_DELAY_MS = 150;

async function waitForActionRequestByStatus(
  pool: Pool,
  workspaceId: string,
  actionKind: string,
  status: string,
): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const client = await pool.connect();
    let id: string | undefined;
    try {
      const result = await client.query<{ id: string }>(
        `select id from action_requests
         where workspace_id = $1 and action_kind = $2 and status = $3
         order by requested_at desc limit 1`,
        [workspaceId, actionKind, status],
      );
      id = result.rows[0]?.id;
    } finally {
      client.release();
    }
    if (id) return id;
    await sleep(20);
  }
  throw new Error(
    `timed out waiting for an action_requests row: action_kind=${actionKind} status=${status}`,
  );
}

describe.runIf(DATABASE_URL !== undefined)(
  'request_action (integration, real Postgres + fake gate)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let gatekeeperId: string;
    let fakeGateApp: FastifyInstance;
    let gateTarget: GateTarget;
    let transport: RecordingTransport;
    let drainer: ApprovalDrainer;
    // Item 1 fix fixtures (review job 652a4abc): a member with no grant at all, a member holding
    // an active capability='gatekeeper' grant scoped to `gatekeeperId`, and an auditor (excluded
    // outright regardless of any grant).
    let memberNoGrantId: string;
    let memberWithGrantId: string;
    let auditorId: string;

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

    async function adminInsertPrincipal(
      displayName: string,
      role: Role = 'owner',
    ): Promise<string> {
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
      workspaceId = await adminInsertWorkspace('request-action-test-workspace');
      ownerId = await adminInsertPrincipal('owner');

      transport = new RecordingTransport(pool, workspaceId);
      const gate = new GatekeeperBase({
        manifest: [OBSERVE_OP, AUTO_OP, PENDING_OP, DRAFT_OP],
        transport,
        credentialResolver: { resolve: async () => ({}) },
        idempotencyStore: new InMemoryIdempotencyStore(),
      });
      fakeGateApp = createGatekeeperServer({
        gate,
        token: deriveConnectionSecret(GATE_TEST_TOKEN, workspaceId, GATE_CONNECTION_SALT),
      });
      await fakeGateApp.listen({ port: 0, host: '127.0.0.1' });
      const address = fakeGateApp.server.address() as AddressInfo;
      const endpoint = `http://127.0.0.1:${address.port}`;
      gateTarget = {
        endpoint,
        credential: { kind: 'connection', workspaceId, salt: GATE_CONNECTION_SALT },
      };

      await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.connection',
          principalId: ownerId,
        });
        const registered = await registerGatekeeper(client, workspaceId, {
          name: 'test-gate',
          transportKind: 'http',
          target: 'example-system',
          endpoint,
          connectionSecretSalt: GATE_CONNECTION_SALT,
          activityId: activity.id,
          registeredBy: { id: ownerId, kind: 'human' },
        });
        gatekeeperId = registered.gatekeeperId;

        await importManifest(client, workspaceId, {
          gatekeeperId,
          operations: [OBSERVE_OP, AUTO_OP, PENDING_OP, DRAFT_OP],
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: activity.id,
        });
        await publishOperation(client, workspaceId, { gatekeeperId, name: OBSERVE_OP.name });
        await publishOperation(client, workspaceId, { gatekeeperId, name: AUTO_OP.name });
        await publishOperation(client, workspaceId, { gatekeeperId, name: PENDING_OP.name });
        // DRAFT_OP is deliberately never published.
      });

      memberNoGrantId = await adminInsertPrincipal('member-no-grant', 'member');
      memberWithGrantId = await adminInsertPrincipal('member-with-grant', 'member');
      auditorId = await adminInsertPrincipal('auditor', 'auditor');
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        grantCapability(client, workspaceId, {
          principalId: memberWithGrantId,
          resourceType: 'gatekeeper',
          resourceId: gatekeeperId,
          grantedBy: ownerId,
        }),
      );

      const gatekeeperClient = testGatekeeperClient();
      const adminWithTransaction = createAdminWithTransaction(pool);
      setRequestActionDeps({
        gatekeeperClient,
        // P2-2 fix: phase 2 now routes execution through an ApprovalDrainer rather than calling
        // an ActionExecutor directly — a *separate* instance from `drainer` below (constructed
        // the same way `createServer()`/`createBackgroundServices()` build two independent
        // instances in production), deliberately not shared, so this suite's own race test below
        // (`drainer.drainGatekeeper(...)` racing this handler's own internal drainer) exercises
        // the real cross-instance race the DB-level row lock — not either drainer's in-memory
        // single-flight set — is what actually has to make safe.
        drainer: new ApprovalDrainer({
          executor: createGatekeeperActionExecutor({
            gatekeeperClient,
            withTransaction: adminWithTransaction,
          }),
          withTransaction: adminWithTransaction,
        }),
        awaitDecisionTimeoutMs: AWAIT_DECISION_TIMEOUT_MS,
      });

      drainer = new ApprovalDrainer({
        executor: createGatekeeperActionExecutor({
          gatekeeperClient: testGatekeeperClient(),
          withTransaction: adminWithTransaction,
        }),
        withTransaction: adminWithTransaction,
      });
    });

    afterAll(async () => {
      await fakeGateApp.close();
      await pool.end();
    });

    /** A row left `executing` an hour ago (the reaper tests' staleness window is 30 min). */
    async function seedStaleExecutingRow(params: Record<string, unknown>): Promise<string> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const result = await client.query<{ id: string }>(
          `insert into action_requests (
             workspace_id, status, gatekeeper_id, action_kind, blast_radius, policy_decision,
             await_decision, on_behalf_of, actor_runtime, executing_at, params
           ) values ($1, 'executing', $2, $3, 'low', 'allow', false, $4, 'pi',
             now() - interval '1 hour', $5::jsonb)
           returning id`,
          [workspaceId, gatekeeperId, AUTO_OP.name, ownerId, JSON.stringify(params)],
        );
        return result.rows[0]?.id as string;
      });
    }

    async function readReplayState(
      actionRequestId: string,
    ): Promise<{ status: string; replayAttempts: number } | undefined> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const result = await client.query<{ status: string; replay_attempts: number }>(
          'select status, replay_attempts from action_requests where workspace_id = $1 and id = $2',
          [workspaceId, actionRequestId],
        );
        const found = result.rows[0];
        return found ? { status: found.status, replayAttempts: found.replay_attempts } : undefined;
      });
    }

    it('observe path calls the gate and writes an observed Fact', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      const result = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: 'observe.stock',
        params: {},
      })) as { status: string; data: unknown; observedFactCount: number };

      expect(result.status).toBe('ok');
      expect(result.observedFactCount).toBe(1);

      const graphStore = new SqlGraphStore();
      const facts = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        graphStore.neighbors(client, workspaceId, {
          objectId: gatekeeperId,
          direction: 'out',
          linkType: 'observed',
        }),
      );
      expect(facts.length).toBeGreaterThanOrEqual(1);
      expect(facts[0]?.epistemicStatus).toBe('observed');
    });

    // Authority-tightening fix (review job 652a4abc lane3 P1-5 / lane2 P1, item 1): a non-owner
    // human caller of request_action must hold an active capability='gatekeeper' Grant for the
    // target gate; auditor is excluded outright. Leftover 97 (maintainer 2026-09-27 "也放开吧"):
    // observe_operation on the human channel needs no Grant any more — only the auditor rule stays.
    describe('human-channel gate on request_action/observe_operation (item 1, leftover 97)', () => {
      /** Capability-dispatch audit rows `actor` has for `action` on this Gatekeeper. */
      async function humanGateAuditCount(actor: string, action: string): Promise<number> {
        const rows = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          queryAudit(client, workspaceId, {
            actorPrincipalId: actor,
            action,
            resourceType: 'gatekeeper',
            resourceId: gatekeeperId,
            limit: 1000,
          }),
        );
        return rows.length;
      }

      it('leftover 97: request_action reading an observe-class Operation needs no grant on the human channel either, audited once', async () => {
        const caller = humanCaller(workspaceId, memberNoGrantId, 'member');
        const before = await humanGateAuditCount(memberNoGrantId, 'request_action');
        await expect(
          dispatchCapability({ pool }, caller, 'request_action', {
            gatekeeperId,
            operation: 'observe.stock',
            params: {},
          }),
        ).resolves.toMatchObject({ status: 'ok' });
        expect(await humanGateAuditCount(memberNoGrantId, 'request_action')).toBe(before + 1);
      });

      it('request_action for an unpublished (unclassified, I17) Operation still needs the grant on the human channel', async () => {
        const caller = humanCaller(workspaceId, memberNoGrantId, 'member');
        await expect(
          dispatchCapability({ pool }, caller, 'request_action', {
            gatekeeperId,
            operation: DRAFT_OP.name,
            params: {},
          }),
        ).rejects.toThrow(/holds no active|forbidden/i);
      });

      it('leftover 97: a member with no grant observes through observe_operation on the human channel, audited once per call', async () => {
        const caller = humanCaller(workspaceId, memberNoGrantId, 'member');
        const before = await humanGateAuditCount(memberNoGrantId, 'observe_operation');
        const result = (await dispatchCapability({ pool }, caller, 'observe_operation', {
          gatekeeperId,
          operation: 'observe.stock',
          params: {},
        })) as { status: string; observedFactCount: number };
        expect(result.status).toBe('ok');
        expect(await humanGateAuditCount(memberNoGrantId, 'observe_operation')).toBe(before + 1);
      });

      it('leftover 97: the predicate still applies on the human channel — an execute-class or unpublished Operation is refused by observe_operation', async () => {
        const caller = humanCaller(workspaceId, memberNoGrantId, 'member');
        await expect(
          dispatchCapability({ pool }, caller, 'observe_operation', {
            gatekeeperId,
            operation: PENDING_OP.name,
            params: {},
          }),
        ).rejects.toThrow(/execute-class/);
        await expect(
          dispatchCapability({ pool }, caller, 'observe_operation', {
            gatekeeperId,
            operation: DRAFT_OP.name,
            params: {},
          }),
        ).rejects.toThrow(/not found|Operation/);
      });

      // AgentProfile / AgentPolicy configure the member's *agent* (S3.13), not the person's own
      // console reads — the human channel runs `observeRefusal` with no exclusions.
      it('leftover 97: a member’s own My Agent exclusion and the AgentPolicy gate cap do not restrict their own console reads', async () => {
        const excludingMemberId = await adminInsertPrincipal('member-human-excluding', 'member');
        await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          setAgentProfile(client, workspaceId, excludingMemberId, ownerId, {
            excludedGatekeepers: [gatekeeperId],
          }),
        );
        const caller = humanCaller(workspaceId, excludingMemberId, 'member');
        await expect(
          dispatchCapability({ pool }, caller, 'observe_operation', {
            gatekeeperId,
            operation: 'observe.stock',
            params: {},
          }),
        ).resolves.toMatchObject({ status: 'ok' });

        await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          setAgentPolicy(client, workspaceId, ownerId, { allowedGatekeepers: [randomUUID()] }),
        );
        try {
          await expect(
            dispatchCapability({ pool }, caller, 'observe_operation', {
              gatekeeperId,
              operation: 'observe.stock',
              params: {},
            }),
          ).resolves.toMatchObject({ status: 'ok' });
        } finally {
          await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
            setAgentPolicy(client, workspaceId, ownerId, { allowedGatekeepers: [] }),
          );
        }
      });

      it('an execute-class request_action on the human channel without a Grant is still refused, and creates no ActionRequest', async () => {
        const caller = humanCaller(workspaceId, memberNoGrantId, 'member');
        const countPending = () =>
          withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
            const rows = await client.query<{ n: number }>(
              'select count(*)::int as n from action_requests where workspace_id = $1 and action_kind = $2',
              [workspaceId, PENDING_OP.name],
            );
            return rows.rows[0]?.n ?? 0;
          });
        const before = await countPending();
        await expect(
          dispatchCapability({ pool }, caller, 'request_action', {
            gatekeeperId,
            operation: PENDING_OP.name,
            params: { qty: 1 },
          }),
        ).rejects.toThrow(/holds no active|forbidden/i);
        expect(await countPending()).toBe(before);
      });

      it('403s an auditor even though they hold no grant to begin with — on request_action and on observe_operation', async () => {
        const caller = humanCaller(workspaceId, auditorId, 'auditor');
        await expect(
          dispatchCapability({ pool }, caller, 'request_action', {
            gatekeeperId,
            operation: 'observe.stock',
            params: {},
          }),
        ).rejects.toThrow(/auditor/i);
        await expect(
          dispatchCapability({ pool }, caller, 'observe_operation', {
            gatekeeperId,
            operation: 'observe.stock',
            params: {},
          }),
        ).rejects.toThrow(/auditor/i);
      });

      it('allows a member holding an active gatekeeper grant for this gate', async () => {
        const caller = humanCaller(workspaceId, memberWithGrantId, 'member');
        const result = (await dispatchCapability({ pool }, caller, 'observe_operation', {
          gatekeeperId,
          operation: 'observe.stock',
          params: {},
        })) as { status: string };
        expect(result.status).toBe('ok');
      });

      it('a grant for a different gatekeeper does not authorize this one', async () => {
        // The human-caller gate (assertHumanGatekeeperAccess) still runs before any Gatekeeper
        // lookup for anything but a published observe-class Operation (leftover 97), so an
        // arbitrary id that names no real Gatekeeper is enough to prove the grant is scoped,
        // without registering a second real gate.
        const otherGate = randomUUID();
        const caller = humanCaller(workspaceId, memberWithGrantId, 'member');
        await expect(
          dispatchCapability({ pool }, caller, 'request_action', {
            gatekeeperId: otherGate,
            operation: 'observe.stock',
            params: {},
          }),
        ).rejects.toThrow(/holds no active|forbidden/i);
      });
    });

    // Item 2 fix (review job 652a4abc: "resource_scope never populated (NULL) → scoped grants
    // never match"): every governed request now snapshots its own Gatekeeper as resource_scope.
    it('item 2: a governed request persists resource_scope = gatekeeperId', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      const result = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: PENDING_OP.name,
        params: { qty: 424242 },
      })) as { status: string; id: string };
      expect(result.status).toBe('pending_approval');

      const resourceScope = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const row = await client.query<{ resource_scope: string | null }>(
            'select resource_scope from action_requests where workspace_id = $1 and id = $2',
            [workspaceId, result.id],
          );
          return row.rows[0]?.resource_scope;
        },
      );
      expect(resourceScope).toBe(gatekeeperId);

      // Root-cause fix (CI failure, run 34215183787): every other test in this file shares one
      // Gatekeeper/drainer queue across the whole describe block ("遇 pending 停" — the drainer
      // stops at the first still-`pending_approval` row for a Gatekeeper, ascending
      // `requested_at`) — leaving this row pending forever (nothing else in this test ever
      // approves/rejects it) permanently blocked every later `auto_approved`/`approved` row on
      // this same Gatekeeper from ever reaching `executed`. Reject it so the queue is clear for
      // the tests that run after this one, the same way a real caller would eventually resolve
      // any pending_approval row.
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        rejectActionRequest(client, workspaceId, {
          actionRequestId: result.id,
          approverPrincipalId: ownerId,
          approverRole: 'owner',
        }),
      );
    });

    // S2.12 fix: `observe_operation` — the capability an entry agent's projected `<gate>.<op>`
    // tools call. Exercised through dispatchCapability with a *Handle* caller carrying exactly
    // `entryScope(...)`, so authorize.ts's Handle-scope check runs for real (the class of gap that
    // let `explain` 403 unnoticed in S2.6: extension tests never enforce Handle scope).
    describe('observe_operation via an entry-scoped Handle caller', () => {
      function entryHandleCaller(
        gatekeepers: readonly string[] = [gatekeeperId],
        obo: string = ownerId,
      ): ResolvedCaller {
        const now = Math.floor(Date.now() / 1000);
        return {
          channel: 'handle',
          claims: {
            ws: workspaceId,
            sid: randomUUID(),
            obo,
            scope: entryScope(
              gatekeepers.length > 0 ? { resources: { gatekeeper: [...gatekeepers] } } : {},
            ),
            jti: randomUUID(),
            iat: now,
            exp: now + 600,
          },
        };
      }

      /** A Worker-shaped Handle: holds `request_action` (and the worker-infrastructure
       *  `list_allowed_operations`) with a gate scope that does NOT name this test's Gatekeeper. */
      function workerHandleCaller(obo: string): ResolvedCaller {
        const now = Math.floor(Date.now() / 1000);
        return {
          channel: 'handle',
          claims: {
            ws: workspaceId,
            sid: randomUUID(),
            obo,
            scope: {
              capabilities: ['request_action', 'list_allowed_operations'],
              resources: { gatekeeper: [randomUUID()] },
            },
            jti: randomUUID(),
            iat: now,
            exp: now + 600,
          },
        };
      }

      /** How many capability-dispatch audit rows `actor` has for `action` on this Gatekeeper. */
      async function gateAuditCount(actor: string, action: string): Promise<number> {
        const rows = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          queryAudit(client, workspaceId, {
            actorPrincipalId: actor,
            action,
            resourceType: 'gatekeeper',
            resourceId: gatekeeperId,
            limit: 1000,
          }),
        );
        return rows.length;
      }

      async function listedOperationNames(caller: ResolvedCaller): Promise<string[]> {
        const result = (await dispatchCapability(
          { pool },
          caller,
          'list_allowed_operations',
          {},
        )) as { items: { gatekeeperId: string; name: string }[] };
        return result.items
          .filter((item) => item.gatekeeperId === gatekeeperId)
          .map((item) => item.name)
          .sort();
      }

      // Design doc §11 "门上的观察" — decision D4 revoked 2026-09-27 ("只读调用不需要授权"): a Handle
      // observes a gate its member was never granted, whether its `resources.gatekeeper` names
      // another gate or is absent. Still audited exactly as before — one `observe_operation` row per
      // call, actor = the Handle's member.
      it('observes through a Gatekeeper outside the Handle scope — no Grant needed — and audits it', async () => {
        for (const caller of [
          entryHandleCaller([randomUUID()], memberNoGrantId),
          entryHandleCaller([], memberNoGrantId),
        ]) {
          const before = await gateAuditCount(memberNoGrantId, 'observe_operation');
          const result = (await dispatchCapability({ pool }, caller, 'observe_operation', {
            gatekeeperId,
            operation: 'observe.stock',
            params: {},
          })) as { status: string; observedFactCount: number };
          expect(result.status).toBe('ok');
          expect(await gateAuditCount(memberNoGrantId, 'observe_operation')).toBe(before + 1);
        }
      });

      // Same rule on request_action's observe branch: a Worker-shaped Handle whose gate scope names
      // a different Gatekeeper observes through this one (audited as `request_action`) — the
      // observe path never reaches governance/policy's coverage check and no longer needs it.
      it('request_action on an observe-class Operation runs for a Handle whose scope does not cover the gate, and is audited', async () => {
        const before = await gateAuditCount(memberNoGrantId, 'request_action');
        const result = (await dispatchCapability(
          { pool },
          workerHandleCaller(memberNoGrantId),
          'request_action',
          { gatekeeperId, operation: 'observe.stock', params: {} },
        )) as { status: string };
        expect(result.status).toBe('ok');
        expect(await gateAuditCount(memberNoGrantId, 'request_action')).toBe(before + 1);
      });

      // Tool projection agrees with enforcement: the ungranted member's entry Handle is offered the
      // gate's observe tool (the call above succeeds for it) and none of its execute-class ones; a
      // Handle whose gate scope carries the Grant still gets the execute ones (unchanged).
      it('list_allowed_operations projects the ungranted gate’s observe Operations, never its execute ones', async () => {
        expect(await listedOperationNames(entryHandleCaller([], memberNoGrantId))).toEqual([
          'observe.stock',
        ]);
        expect(await listedOperationNames(workerHandleCaller(memberNoGrantId))).toEqual([
          'observe.stock',
        ]);
        expect(await listedOperationNames(entryHandleCaller([gatekeeperId]))).toEqual(
          [AUTO_OP.name, OBSERVE_OP.name, PENDING_OP.name].sort(),
        );
      });

      // The two conditions that still refuse an observation: the member's own AgentProfile
      // exclusion and the workspace AgentPolicy gate cap — enforced per call, and the projection
      // drops the tool for exactly the same member.
      it('refuses (and does not project) a gate the member excluded on My Agent, on both observe paths', async () => {
        const excludedMemberId = await adminInsertPrincipal('member-excluded-gate', 'member');
        await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          setAgentProfile(client, workspaceId, excludedMemberId, ownerId, {
            excludedGatekeepers: [gatekeeperId],
          }),
        );
        await expect(
          dispatchCapability(
            { pool },
            entryHandleCaller([gatekeeperId], excludedMemberId),
            'observe_operation',
            { gatekeeperId, operation: 'observe.stock', params: {} },
          ),
        ).rejects.toThrow(/excluded_by_profile/);
        await expect(
          dispatchCapability({ pool }, workerHandleCaller(excludedMemberId), 'request_action', {
            gatekeeperId,
            operation: 'observe.stock',
            params: {},
          }),
        ).rejects.toThrow(/excluded_by_profile/);
        expect(await listedOperationNames(entryHandleCaller([], excludedMemberId))).toEqual([]);
      });

      it('refuses (and does not project) a gate the workspace AgentPolicy cap leaves out', async () => {
        await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          setAgentPolicy(client, workspaceId, ownerId, { allowedGatekeepers: [randomUUID()] }),
        );
        try {
          await expect(
            dispatchCapability(
              { pool },
              entryHandleCaller([], memberNoGrantId),
              'observe_operation',
              { gatekeeperId, operation: 'observe.stock', params: {} },
            ),
          ).rejects.toThrow(/excluded_by_policy/);
          expect(await listedOperationNames(entryHandleCaller([], memberNoGrantId))).toEqual([]);
        } finally {
          await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
            setAgentPolicy(client, workspaceId, ownerId, { allowedGatekeepers: [] }),
          );
        }
      });

      it('runs a published observe-class Operation and returns its data', async () => {
        const result = (await dispatchCapability(
          { pool },
          entryHandleCaller(),
          'observe_operation',
          {
            gatekeeperId,
            operation: 'observe.stock',
            params: {},
          },
        )) as { status: string; data: unknown; observedFactCount: number };
        expect(result.status).toBe('ok');
        expect(result.observedFactCount).toBe(1);
      });

      it('refuses an execute-class Operation (403-shaped ForbiddenError), never creating an ActionRequest', async () => {
        await expect(
          dispatchCapability({ pool }, entryHandleCaller(), 'observe_operation', {
            gatekeeperId,
            operation: 'auto.op',
            params: {},
          }),
        ).rejects.toThrow(/execute-class/);
      });

      it('treats an unpublished Operation as not found (I17), not as a governed request', async () => {
        await expect(
          dispatchCapability({ pool }, entryHandleCaller(), 'observe_operation', {
            gatekeeperId,
            operation: 'draft.op',
            params: {},
          }),
        ).rejects.toThrow(/not found|Operation/);
      });

      it('an entry Handle still cannot call request_action at all (ceiling invariant)', async () => {
        await expect(
          dispatchCapability({ pool }, entryHandleCaller(), 'request_action', {
            gatekeeperId,
            operation: 'observe.stock',
            params: {},
          }),
        ).rejects.toThrow(/not in|scope|forbidden/i);
      });
    });

    it('auto-approve executes exactly once, and the gate is only called once the row is visible from another connection', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      const before = transport.calls[AUTO_OP.name] ?? 0;

      const result = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: AUTO_OP.name,
        params: { qty: 1 },
      })) as { status: string; id: string; data?: unknown };

      expect(result.status).toBe('executed');
      expect(transport.calls[AUTO_OP.name]).toBe(before + 1);
      expect(transport.visibilityChecks[AUTO_OP.name]).toBe(true);
    });

    // S3.13 regression guard (found in CI, not reproducible on a machine with no local
    // Postgres): an earlier version of this feature fed the *resolved* `effective.autoApproveLow`
    // into the policy engine's narrowing check — which folds in `AgentPolicy
    // .allowMemberAutoApproveLow`'s own compiled-in-`false` default — so *every* workspace with no
    // `agent_policies` row (i.e. every workspace that predates S3.13, including every other test
    // in this file) got low-blast-radius auto-approval silently disabled platform-wide the moment
    // that code ran. These two tests pin both halves of the fix: a principal with no AgentProfile
    // row at all (every test above this one) keeps the pre-S3.13 behavior; only a principal whose
    // own AgentProfile explicitly narrows `autoApproveLow: false` sees `request_action` require
    // approval on an otherwise-auto-approved, low-blast-radius Operation.
    it('S3.13: a principal whose own AgentProfile explicitly sets autoApproveLow:false has an otherwise-auto-approved low-blast-radius request narrowed to require_approval', async () => {
      const narrowedMemberId = await adminInsertPrincipal('member-narrowed-auto-approve', 'member');
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        grantCapability(client, workspaceId, {
          principalId: narrowedMemberId,
          resourceType: 'gatekeeper',
          resourceId: gatekeeperId,
          grantedBy: ownerId,
        }),
      );
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        setAgentProfile(client, workspaceId, narrowedMemberId, ownerId, { autoApproveLow: false }),
      );

      const caller = humanCaller(workspaceId, narrowedMemberId, 'member');
      const before = transport.calls[AUTO_OP.name] ?? 0;

      const result = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: AUTO_OP.name,
        params: { qty: 2 },
      })) as { status: string; id: string };

      expect(result.status).toBe('pending_approval'); // narrowed — would otherwise auto-approve
      expect(transport.calls[AUTO_OP.name]).toBe(before); // the gate was never called

      // Clean up: same convention as the "does not jump ahead" test above — the ApprovalDrainer
      // will not let a *later* ActionRequest execute while an *earlier* one on the same Gatekeeper
      // is still `pending_approval`; leaving this row unresolved would silently block every later
      // test's own AUTO_OP call on this same `gatekeeperId` from ever reaching `executed`.
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        rejectActionRequest(client, workspaceId, {
          actionRequestId: result.id,
          approverPrincipalId: ownerId,
          approverRole: 'owner',
        }),
      );
      await drainer.drainGatekeeper(workspaceId, ownerId, gatekeeperId);
    });

    it('S3.13: a principal with no AgentProfile row at all still auto-approves (the compiled-in AgentPolicy default never narrows on its own)', async () => {
      const untouchedMemberId = await adminInsertPrincipal('member-no-agent-profile', 'member');
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        grantCapability(client, workspaceId, {
          principalId: untouchedMemberId,
          resourceType: 'gatekeeper',
          resourceId: gatekeeperId,
          grantedBy: ownerId,
        }),
      );
      // No setAgentProfile call — this principal has never touched S3.13 at all.

      const caller = humanCaller(workspaceId, untouchedMemberId, 'member');
      const before = transport.calls[AUTO_OP.name] ?? 0;

      const result = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: AUTO_OP.name,
        params: { qty: 3 },
      })) as { status: string; id: string };

      expect(result.status).toBe('executed');
      expect(transport.calls[AUTO_OP.name]).toBe(before + 1);
    });

    // P2-2 fix (review job 652a4abc): phase 2's inline execution now routes through the
    // ApprovalDrainer's per-Gatekeeper "遇 pending 停" ordering instead of calling the
    // ActionExecutor directly — a later auto_approved request must not execute ahead of an
    // earlier still-pending_approval row on the same Gatekeeper.
    it('an auto_approved request does not jump ahead of an earlier pending_approval row on the same Gatekeeper (drainer ordering)', async () => {
      const caller = humanCaller(workspaceId, ownerId);

      const pendingResult = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: PENDING_OP.name,
        params: { qty: 6001 },
      })) as { status: string; id: string };
      expect(pendingResult.status).toBe('pending_approval');

      const before = transport.calls[AUTO_OP.name] ?? 0;

      const autoResult = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: AUTO_OP.name,
        params: { qty: 6002 },
      })) as { status: string; id: string };

      expect(autoResult.status).toBe('auto_approved'); // not yet executed — blocked behind pendingResult
      expect(transport.calls[AUTO_OP.name]).toBe(before); // the gate was never called for it

      const row = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        getActionRequest(client, workspaceId, autoResult.id),
      );
      expect(row?.status).toBe('auto_approved');

      // Unblock the queue, then drain it: rejecting the blocking row alone would leave
      // `autoResult`'s row sitting `auto_approved` (unexecuted) forever — `auto_approved` has no
      // reject/expire edge of its own (packages/shared/src/transitions.ts) — which would then
      // block *every later* test's own auto-execution on this same shared Gatekeeper under the
      // very drainer ordering this test just proved.
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        rejectActionRequest(client, workspaceId, {
          actionRequestId: pendingResult.id,
          approverPrincipalId: ownerId,
          approverRole: 'owner',
        }),
      );
      await drainer.drainGatekeeper(workspaceId, ownerId, gatekeeperId);
    });

    // P2-1 fix (review job 652a4abc): a policy `deny` decision must leave a durable trace — the
    // row, its `action_request.request` audit entry, and the outbox event all commit even though
    // the capability call itself still throws (403-shaped `ActionRequestDeniedError`).
    it('denied leaves a trace: the row and its audit record commit even though the call still throws', async () => {
      const now = Math.floor(Date.now() / 1000);
      const uncoveredCaller: ResolvedCaller = {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid: randomUUID(),
          obo: ownerId,
          // Holds request_action but not this Gatekeeper's resource scope — governance/policy/
          // engine.ts's own doc comment: "deny... checked first".
          scope: { capabilities: ['request_action'], resources: { gatekeeper: [randomUUID()] } },
          jti: randomUUID(),
          iat: now,
          exp: now + 600,
        },
      };

      await expect(
        dispatchCapability({ pool }, uncoveredCaller, 'request_action', {
          gatekeeperId,
          operation: AUTO_OP.name,
          params: { qty: 9001 },
        }),
      ).rejects.toThrow(/denied/i);

      const row = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        client.query<{ id: string; status: string }>(
          `select id, status from action_requests
           where workspace_id = $1 and gatekeeper_id = $2 and action_kind = $3
           order by requested_at desc limit 1`,
          [workspaceId, gatekeeperId, AUTO_OP.name],
        ),
      );
      const deniedRow = row.rows[0];
      expect(deniedRow?.status).toBe('denied');

      const auditRows = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        queryAudit(client, workspaceId, {
          resourceType: 'action_request',
          resourceId: deniedRow?.id,
          limit: 5,
        }),
      );
      expect(auditRows.some((r) => r.action === 'action_request.request')).toBe(true);
    });

    // P1-1 fix (review job 652a4abc): request_action now always derives (or accepts) an
    // idempotency key, so a retry with the same intent returns the existing ActionRequest instead
    // of creating and executing a second one. Placed here (before "an unclassified operation"
    // below) deliberately — that test leaves a permanent, never-resolved pending_approval row on
    // this shared Gatekeeper, and P2-2's drainer-ordering fix means every later auto_approved
    // request on the same Gatekeeper would otherwise queue forever behind it.
    //
    // R-53 (2026-10-02 review, decision D-12): the derived default key only dedupes against a row
    // still in flight. Once the first row is terminal an identical call is a new intent — a
    // legitimate repeat (restart, check, restart) must apply again, not replay the first result.
    it('a repeat call with identical (gatekeeperId, operation, params) and no explicit idempotencyKey, after the first one executed, is a new ActionRequest that applies again', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      const params = { qty: 4200 };

      const first = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: AUTO_OP.name,
        params,
      })) as { status: string; id: string };
      expect(first.status).toBe('executed');

      const before = transport.calls[AUTO_OP.name] ?? 0;

      const second = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: AUTO_OP.name,
        params,
      })) as { status: string; id: string };

      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe('executed');
      expect(transport.calls[AUTO_OP.name]).toBe(before + 1); // applied again
    });

    it('an identical call made while the first one still awaits approval collapses onto the same ActionRequest', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      const params = { qty: 4300 };
      const before = transport.calls[PENDING_OP.name] ?? 0;

      const first = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: PENDING_OP.name,
        params,
      })) as { status: string; id: string };
      expect(first.status).toBe('pending_approval');

      const second = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: PENDING_OP.name,
        params,
      })) as { status: string; id: string };
      expect(second.id).toBe(first.id);
      expect(second.status).toBe('pending_approval');

      // Approve and drain it, so no pending row is left to hold up later tests' requests on this
      // shared Gatekeeper — and it applies exactly once.
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        approveActionRequest(client, workspaceId, {
          actionRequestId: first.id,
          approverPrincipalId: ownerId,
          approverRole: 'owner',
        }),
      );
      await drainer.drainGatekeeper(workspaceId, ownerId, gatekeeperId);
      expect(transport.calls[PENDING_OP.name]).toBe(before + 1);
    });

    // The explicit key keeps its meaning (D-12): one ActionRequest per key, whatever its status —
    // here a replay of an already-`executed` row.
    it('an explicit idempotencyKey collapses a repeat call onto the same ActionRequest even with different params', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      const idempotencyKey = randomUUID();

      const first = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: AUTO_OP.name,
        params: { qty: 4201 },
        idempotencyKey,
      })) as { status: string; id: string };
      expect(first.status).toBe('executed');

      const before = transport.calls[AUTO_OP.name] ?? 0;

      const second = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: AUTO_OP.name,
        params: { qty: 4202 }, // different params — the explicit key still wins
        idempotencyKey,
      })) as { status: string; id: string };

      expect(second.id).toBe(first.id);
      expect(transport.calls[AUTO_OP.name]).toBe(before); // the gate was not called again
    });

    it('await_decision:true resolves once a *different connection* approves it mid-wait, and executes exactly once', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      const before = transport.calls[PENDING_OP.name] ?? 0;

      const resultPromise = dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: PENDING_OP.name,
        params: { qty: 2 },
      }) as Promise<{ status: string; id: string; data?: unknown }>;

      // Deliberately a separate connection/transaction, not the one phase 1 used — this is exactly
      // what a human's `approve()` call looks like in production.
      await sleep(APPROVE_DELAY_MS);
      const actionRequestId = await waitForActionRequestByStatus(
        pool,
        workspaceId,
        PENDING_OP.name,
        'pending_approval',
      );
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        approveActionRequest(client, workspaceId, {
          actionRequestId,
          approverPrincipalId: ownerId,
          approverRole: 'owner',
        }),
      );

      const result = await resultPromise;
      expect(result.status).toBe('executed');
      expect(result.data).toBeDefined();
      expect(transport.calls[PENDING_OP.name]).toBe(before + 1);
      expect(transport.visibilityChecks[PENDING_OP.name]).toBe(true);

      const finalRow = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        getActionRequest(client, workspaceId, actionRequestId),
      );
      expect(finalRow?.status).toBe('executed');
    });

    it('the async drain consumer racing phase 2 on the same approved row still executes exactly once', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      const before = transport.calls[PENDING_OP.name] ?? 0;

      const resultPromise = dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: PENDING_OP.name,
        params: { qty: 3 },
      }) as Promise<{ status: string; id: string; data?: unknown }>;

      const actionRequestId = await waitForActionRequestByStatus(
        pool,
        workspaceId,
        PENDING_OP.name,
        'pending_approval',
      );
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        approveActionRequest(client, workspaceId, {
          actionRequestId,
          approverPrincipalId: ownerId,
          approverRole: 'owner',
        }),
      );

      // Race the drainer (what the outbox consumer / periodic tick would trigger) directly against
      // phase 2's own poll-and-execute — both may attempt `startActionRequestExecution` on the same
      // row; the row lock + conditional UPDATE must let only one of them actually call `apply`.
      const [result] = await Promise.all([
        resultPromise,
        drainer.drainGatekeeper(workspaceId, ownerId, gatekeeperId),
      ]);

      expect(result.status).toBe('executed');
      expect(transport.calls[PENDING_OP.name]).toBe(before + 1);

      const finalRow = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        getActionRequest(client, workspaceId, actionRequestId),
      );
      expect(finalRow?.status).toBe('executed');
    });

    // P1-2 fix (review job 652a4abc): `requestActionHandler` resolves the calling Handle's own
    // WorkerRun via `claims.sid` and threads it through as `parent_worker_run_id` — previously
    // never set by any production caller, leaving `application/task/reaper.ts`'s
    // ActionRequestPending routing consumer (already correctly implemented, see
    // `reaper.integration.test.ts`) with nothing to route back to.
    it('a Worker-Handle caller sets parent_worker_run_id on the created ActionRequest', async () => {
      const taskResult = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) =>
          client.query<{ id: string }>(
            `insert into tasks (workspace_id, status, on_behalf_of, worker_definition_id, worker_definition_version)
             values ($1, 'running', $2, $3, 1) returning id`,
            [workspaceId, ownerId, randomUUID()],
          ),
      );
      const taskId = taskResult.rows[0]?.id as string;

      const sessionId = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const result = await client.query<{ id: string }>(
            `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
             values ($1, $2, 'worker_run', $3, 'active') returning id`,
            [workspaceId, ownerId, ownerId],
          );
          return result.rows[0]?.id as string;
        },
      );

      const workerRunId = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const result = await client.query<{ id: string }>(
            `insert into worker_runs (workspace_id, status, task_id, session_id, depth, attempt)
             values ($1, 'running', $2, $3, 0, 1) returning id`,
            [workspaceId, taskId, sessionId],
          );
          return result.rows[0]?.id as string;
        },
      );

      const now = Math.floor(Date.now() / 1000);
      const workerCaller: ResolvedCaller = {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid: sessionId,
          obo: ownerId,
          scope: { capabilities: ['request_action'], resources: { gatekeeper: [gatekeeperId] } },
          jti: randomUUID(),
          iat: now,
          exp: now + 600,
        },
      };

      const result = (await dispatchCapability({ pool }, workerCaller, 'request_action', {
        gatekeeperId,
        operation: PENDING_OP.name,
        params: { qty: 777 },
      })) as { status: string; id: string };
      expect(result.status).toBe('pending_approval');

      const row = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        getActionRequest(client, workspaceId, result.id),
      );
      expect(row?.parentWorkerRunId).toBe(workerRunId);
    });

    it('an unclassified (unimported) operation → require_approval, never executes', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      const result = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: 'totally.unknown.op',
        params: {},
      })) as { status: string; id: string };
      expect(result.status).toBe('pending_approval');

      const row = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        getActionRequest(client, workspaceId, result.id),
      );
      expect(row?.blastRadius).toBe('medium');
      expect(row?.status).toBe('pending_approval');
    });

    // P1-3 fix (review job 652a4abc): "crash/DB failure between apply success and
    // markActionRequestExecuted leaves row `executing` forever" — a row hand-seeded at `executing`
    // (simulating exactly that crash) with a stale `executing_at` must be picked up, replayed
    // (idempotently, via the same ActionExecutor.execute every other execution path uses), and
    // marked to a terminal status.
    it('the stale-executing reaper replays apply and marks a crashed-mid-execution row', async () => {
      const actionRequestId = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const result = await client.query<{ id: string }>(
            `insert into action_requests (
               workspace_id, status, gatekeeper_id, action_kind, blast_radius, policy_decision,
               await_decision, on_behalf_of, actor_runtime, executing_at, params
             ) values ($1, 'executing', $2, $3, 'low', 'allow', false, $4, 'pi',
               now() - interval '1 hour', $5::jsonb)
             returning id`,
            [workspaceId, gatekeeperId, AUTO_OP.name, ownerId, JSON.stringify({ qty: 5150 })],
          );
          return result.rows[0]?.id as string;
        },
      );

      const before = transport.calls[AUTO_OP.name] ?? 0;
      const withTransactionAdmin = createAdminWithTransaction(pool);
      const actionExecutor = createGatekeeperActionExecutor({
        gatekeeperClient: testGatekeeperClient(),
        withTransaction: withTransactionAdmin,
      });

      const reapResult = await reapStaleExecutingActionRequests(pool, actionExecutor, {
        staleAfterMs: 1000,
      });

      expect(reapResult.scanned).toBeGreaterThanOrEqual(1);
      expect(reapResult.reaped).toBeGreaterThanOrEqual(1);
      expect(transport.calls[AUTO_OP.name]).toBe(before + 1); // the gate was called (the replay)

      const row = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        getActionRequest(client, workspaceId, actionRequestId),
      );
      expect(row?.status).toBe('executed');
    });

    // Real-model regression 2026-10-02: a `gate/apply` timeout is "outcome unknown" — the executor
    // must report it as indeterminate (the drainer then leaves the row `executing`). R-48: a replay
    // that times out too gets no answer either, so the row stays `executing` for the next tick —
    // bounded by the persisted attempt count, after which it is `failed: outcome_unknown` for a
    // person to reconcile, never parked `executing` forever.
    it('an apply timeout is indeterminate for the executor; replays that time out too stay executing until the attempt cap, then fail as outcome_unknown', async () => {
      const timingOutClient = {
        apply: async () => {
          throw new GatekeeperTimeoutError(
            'gatekeeper client: gate/apply timed out after 60000ms',
            'gate/apply',
          );
        },
      } as unknown as GatekeeperClient;
      const actionExecutor = createGatekeeperActionExecutor({
        gatekeeperClient: timingOutClient,
        withTransaction: createAdminWithTransaction(pool),
      });

      const actionRequestId = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const result = await client.query<{ id: string }>(
            `insert into action_requests (
               workspace_id, status, gatekeeper_id, action_kind, blast_radius, policy_decision,
               await_decision, on_behalf_of, actor_runtime, executing_at, params
             ) values ($1, 'executing', $2, $3, 'low', 'allow', false, $4, 'pi',
               now() - interval '1 hour', $5::jsonb)
             returning id`,
            [workspaceId, gatekeeperId, AUTO_OP.name, ownerId, JSON.stringify({ qty: 6160 })],
          );
          return result.rows[0]?.id as string;
        },
      );
      const row = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        getActionRequest(client, workspaceId, actionRequestId),
      );
      if (!row) throw new Error('seeded action request not found');

      const direct = await actionExecutor.execute(row);
      expect(direct.ok).toBe(false);
      expect(direct.indeterminate).toBe(true);
      expect(direct.reason).toMatch(/^outcome unknown: /);

      // 30 min, not the 1 s the crash test above uses: the reaper scans every workspace and this
      // executor fails everything, so only the hand-seeded 1-hour-old rows may qualify — never a
      // row another test file running against the same database just left `executing`.
      const reapOptions = { staleAfterMs: 30 * 60 * 1000, maxReplayAttempts: 2 };
      await reapStaleExecutingActionRequests(pool, actionExecutor, reapOptions);
      const afterFirst = await readReplayState(actionRequestId);
      expect(afterFirst).toEqual({ status: 'executing', replayAttempts: 1 });

      await reapStaleExecutingActionRequests(pool, actionExecutor, reapOptions);
      const after = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        getActionRequest(client, workspaceId, actionRequestId),
      );
      expect(after?.status).toBe('failed');
      const audit = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        queryAudit(client, workspaceId, {
          resourceType: 'action_request',
          resourceId: actionRequestId,
          action: 'action_request.fail',
        }),
      );
      expect((audit[0]?.payload as { reason?: string } | undefined)?.reason).toMatch(
        /^outcome_unknown: no answer from the gate after 2 replays \(last: gatekeeper client: gate\/apply timed out/,
      );
    });

    // R-48: 409 on a replay means the gate is still applying this key — not a failure. The row
    // stays `executing`; once the gate finishes, the next replay gets the stored result. The effect
    // runs exactly once.
    it('a replay answered 409 (the gate is still applying) leaves the row executing; the next replay records the stored result', async () => {
      const params = { slowMs: 1500, marker: randomUUID() };
      const actionRequestId = await seedStaleExecutingRow(params);
      const before = transport.calls[AUTO_OP.name] ?? 0;
      const gatekeeperClient = testGatekeeperClient();
      const actionExecutor = createGatekeeperActionExecutor({
        gatekeeperClient,
        withTransaction: createAdminWithTransaction(pool),
      });

      // The first `apply` for this key is still running on the gate (its kernel caller gave up).
      const firstApply = gatekeeperClient.apply(gateTarget, {
        operation: AUTO_OP.name,
        params,
        onBehalfOf: ownerId,
        actionRequestId,
      });
      await sleep(200);

      const reapOptions = { staleAfterMs: 30 * 60 * 1000 };
      await reapStaleExecutingActionRequests(pool, actionExecutor, reapOptions);
      expect(await readReplayState(actionRequestId)).toEqual({
        status: 'executing',
        replayAttempts: 1,
      });

      await firstApply;
      await reapStaleExecutingActionRequests(pool, actionExecutor, reapOptions);
      const after = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        getActionRequest(client, workspaceId, actionRequestId),
      );
      expect(after?.status).toBe('executed');
      expect(transport.calls[AUTO_OP.name]).toBe(before + 1);
      const audit = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        queryAudit(client, workspaceId, {
          resourceType: 'action_request',
          resourceId: actionRequestId,
          action: 'action_request.complete',
        }),
      );
      expect(
        (audit[0]?.payload as { resultMetadata?: { replayed?: boolean } } | undefined)
          ?.resultMetadata?.replayed,
      ).toBe(true);
    });

    // R-51 / D-11: when the gate itself cannot know (its exec timeout killed the call, or a gate
    // process died mid-call), it answers 409 `apply_outcome_unknown` on every call for the key.
    // The first execution and the reaper's replay both record `failed: outcome_unknown` — never
    // a re-run, never "still applying".
    it('a gate that answers outcome unknown fails the row as outcome_unknown, on the first call and on a replay, without re-running the effect', async () => {
      const params = { gateTimeout: true, marker: randomUUID() };
      const actionRequestId = await seedStaleExecutingRow(params);
      const before = transport.calls[AUTO_OP.name] ?? 0;
      const actionExecutor = createGatekeeperActionExecutor({
        gatekeeperClient: testGatekeeperClient(),
        withTransaction: createAdminWithTransaction(pool),
      });
      const row = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        getActionRequest(client, workspaceId, actionRequestId),
      );
      if (!row) throw new Error('seeded action request not found');

      const direct = await actionExecutor.execute(row);
      expect(direct.ok).toBe(false);
      expect(direct.indeterminate).toBeUndefined();
      expect(direct.reason).toMatch(/^outcome_unknown: apply for actionRequestId /);

      await reapStaleExecutingActionRequests(pool, actionExecutor, {
        staleAfterMs: 30 * 60 * 1000,
      });
      const after = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        getActionRequest(client, workspaceId, actionRequestId),
      );
      expect(after?.status).toBe('failed');
      const audit = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        queryAudit(client, workspaceId, {
          resourceType: 'action_request',
          resourceId: actionRequestId,
          action: 'action_request.fail',
        }),
      );
      expect((audit[0]?.payload as { reason?: string } | undefined)?.reason).toMatch(
        /^outcome_unknown: apply for actionRequestId .* has an unknown outcome/,
      );
      expect(transport.calls[AUTO_OP.name]).toBe(before + 1); // the gate ran it once, never again
    });

    it('a draft (unpublished) operation never executes, even though its own manifest entry declares auto_approvable', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      const before = transport.calls[DRAFT_OP.name] ?? 0;

      const result = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: DRAFT_OP.name,
        params: {},
      })) as { status: string; id: string };

      expect(result.status).toBe('pending_approval');
      expect(transport.calls[DRAFT_OP.name] ?? 0).toBe(before); // never invoked
    });

    // STATUS leftover 105: an auto-approved effect slower than the caller's budget must not hold
    // `request_action` past it (the platform-extension kernel-client gives up at 30 s) — it
    // returns the row's honest non-terminal status, and the effect still completes. Last in this
    // describe on purpose: the slow apply holds this gatekeeper's single-flight drain, and the
    // test waits for it to finish before returning.
    it('an auto-approved apply slower than the request budget returns executing in time and still completes', async () => {
      // Earlier tests in this file leave `pending_approval` rows on this gatekeeper (the
      // unclassified and draft operations); the drain stops at the first one (§8.1 "遇 pending
      // 停"), so this row would never start. Reject them through the governed path first.
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const pending = await client.query<{ id: string }>(
          `select id from action_requests
           where workspace_id = $1 and gatekeeper_id = $2 and status = 'pending_approval'`,
          [workspaceId, gatekeeperId],
        );
        for (const row of pending.rows) {
          await rejectActionRequest(client, workspaceId, {
            actionRequestId: row.id,
            approverPrincipalId: ownerId,
            approverRole: 'owner',
          });
        }
      });

      const slowMs = AWAIT_DECISION_TIMEOUT_MS + 1200;
      const caller = humanCaller(workspaceId, ownerId);
      const startedAt = Date.now();
      const result = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: AUTO_OP.name,
        params: { slowMs, marker: randomUUID() },
      })) as { status: string; id: string };
      const elapsed = Date.now() - startedAt;

      expect(result.status).toBe('executing');
      expect(elapsed).toBeLessThan(slowMs);

      let finalStatus: string | undefined;
      for (let attempt = 0; attempt < 100 && finalStatus !== 'executed'; attempt += 1) {
        await sleep(50);
        const row = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          getActionRequest(client, workspaceId, result.id),
        );
        finalStatus = row?.status;
      }
      expect(finalStatus).toBe('executed');
    });
  },
);
