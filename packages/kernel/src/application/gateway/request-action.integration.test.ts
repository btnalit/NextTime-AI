import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GatekeeperBase,
  InMemoryIdempotencyStore,
  createGatekeeperServer,
} from '@nexttime/gatekeeper-base';
import type { Transport, TransportInvokeResult } from '@nexttime/gatekeeper-base';
import type { Operation, Role } from '@nexttime/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { HttpGatekeeperClient } from '../../adapters/gatekeeper-client/index.js';
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
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
// review lane 5, P1-1: every /gate/* route now requires Authorization: Bearer <token> — this
// test's own fake gate server and every HttpGatekeeperClient it talks to share this fixed value.
const GATE_TEST_TOKEN = 'gate-integration-test-token-0123456789abcdef';

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
      fakeGateApp = createGatekeeperServer({ gate, token: GATE_TEST_TOKEN });
      await fakeGateApp.listen({ port: 0, host: '127.0.0.1' });
      const address = fakeGateApp.server.address() as AddressInfo;
      const endpoint = `http://127.0.0.1:${address.port}`;

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

      const gatekeeperClient = new HttpGatekeeperClient({ token: GATE_TEST_TOKEN });
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
          gatekeeperClient: new HttpGatekeeperClient({ token: GATE_TEST_TOKEN }),
          withTransaction: adminWithTransaction,
        }),
        withTransaction: adminWithTransaction,
      });
    });

    afterAll(async () => {
      await fakeGateApp.close();
      await pool.end();
    });

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
    // human caller of request_action/observe_operation must hold an active
    // capability='gatekeeper' Grant for the target gate; auditor is excluded outright.
    describe('human-channel gate on request_action/observe_operation (item 1)', () => {
      it('403s a member with no grant at all', async () => {
        const caller = humanCaller(workspaceId, memberNoGrantId, 'member');
        await expect(
          dispatchCapability({ pool }, caller, 'request_action', {
            gatekeeperId,
            operation: 'observe.stock',
            params: {},
          }),
        ).rejects.toThrow(/holds no active|forbidden/i);
        await expect(
          dispatchCapability({ pool }, caller, 'observe_operation', {
            gatekeeperId,
            operation: 'observe.stock',
            params: {},
          }),
        ).rejects.toThrow(/holds no active|forbidden/i);
      });

      it('403s an auditor even though they hold no grant to begin with', async () => {
        const caller = humanCaller(workspaceId, auditorId, 'auditor');
        await expect(
          dispatchCapability({ pool }, caller, 'request_action', {
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
        // The human-caller gate (assertHumanGatekeeperAccess) runs before any Gatekeeper lookup,
        // so an arbitrary id that names no real Gatekeeper is enough to prove the grant is
        // scoped, without registering a second real gate.
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
      })) as { status: string; actionRequestId: string };
      expect(result.status).toBe('pending_approval');

      const resourceScope = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const row = await client.query<{ resource_scope: string | null }>(
            'select resource_scope from action_requests where workspace_id = $1 and id = $2',
            [workspaceId, result.actionRequestId],
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
          actionRequestId: result.actionRequestId,
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
      function entryHandleCaller(): ResolvedCaller {
        const now = Math.floor(Date.now() / 1000);
        return {
          channel: 'handle',
          claims: {
            ws: workspaceId,
            sid: randomUUID(),
            obo: ownerId,
            scope: entryScope({ resources: { gatekeeper: [gatekeeperId] } }),
            jti: randomUUID(),
            iat: now,
            exp: now + 600,
          },
        };
      }

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
      })) as { status: string; actionRequestId: string; data?: unknown };

      expect(result.status).toBe('executed');
      expect(transport.calls[AUTO_OP.name]).toBe(before + 1);
      expect(transport.visibilityChecks[AUTO_OP.name]).toBe(true);
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
      })) as { status: string; actionRequestId: string };
      expect(pendingResult.status).toBe('pending_approval');

      const before = transport.calls[AUTO_OP.name] ?? 0;

      const autoResult = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: AUTO_OP.name,
        params: { qty: 6002 },
      })) as { status: string; actionRequestId: string };

      expect(autoResult.status).toBe('auto_approved'); // not yet executed — blocked behind pendingResult
      expect(transport.calls[AUTO_OP.name]).toBe(before); // the gate was never called for it

      const row = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        getActionRequest(client, workspaceId, autoResult.actionRequestId),
      );
      expect(row?.status).toBe('auto_approved');

      // Unblock the queue, then drain it: rejecting the blocking row alone would leave
      // `autoResult`'s row sitting `auto_approved` (unexecuted) forever — `auto_approved` has no
      // reject/expire edge of its own (packages/shared/src/transitions.ts) — which would then
      // block *every later* test's own auto-execution on this same shared Gatekeeper under the
      // very drainer ordering this test just proved.
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        rejectActionRequest(client, workspaceId, {
          actionRequestId: pendingResult.actionRequestId,
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
    it('a repeat call with identical (gatekeeperId, operation, params) and no explicit idempotencyKey collapses onto the same ActionRequest', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      const params = { qty: 4200 };

      const first = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: AUTO_OP.name,
        params,
      })) as { status: string; actionRequestId: string };
      expect(first.status).toBe('executed');

      const before = transport.calls[AUTO_OP.name] ?? 0;

      const second = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: AUTO_OP.name,
        params,
      })) as { status: string; actionRequestId: string };

      expect(second.actionRequestId).toBe(first.actionRequestId);
      expect(second.status).toBe('executed');
      expect(transport.calls[AUTO_OP.name]).toBe(before); // the gate was not called again
    });

    it('an explicit idempotencyKey collapses a repeat call onto the same ActionRequest even with different params', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      const idempotencyKey = randomUUID();

      const first = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: AUTO_OP.name,
        params: { qty: 4201 },
        idempotencyKey,
      })) as { status: string; actionRequestId: string };
      expect(first.status).toBe('executed');

      const before = transport.calls[AUTO_OP.name] ?? 0;

      const second = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: AUTO_OP.name,
        params: { qty: 4202 }, // different params — the explicit key still wins
        idempotencyKey,
      })) as { status: string; actionRequestId: string };

      expect(second.actionRequestId).toBe(first.actionRequestId);
      expect(transport.calls[AUTO_OP.name]).toBe(before); // the gate was not called again
    });

    it('await_decision:true resolves once a *different connection* approves it mid-wait, and executes exactly once', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      const before = transport.calls[PENDING_OP.name] ?? 0;

      const resultPromise = dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: PENDING_OP.name,
        params: { qty: 2 },
      }) as Promise<{ status: string; actionRequestId: string; data?: unknown }>;

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
      }) as Promise<{ status: string; actionRequestId: string; data?: unknown }>;

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
      })) as { status: string; actionRequestId: string };
      expect(result.status).toBe('pending_approval');

      const row = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        getActionRequest(client, workspaceId, result.actionRequestId),
      );
      expect(row?.parentWorkerRunId).toBe(workerRunId);
    });

    it('an unclassified (unimported) operation → require_approval, never executes', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      const result = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: 'totally.unknown.op',
        params: {},
      })) as { status: string; actionRequestId: string };
      expect(result.status).toBe('pending_approval');

      const row = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        getActionRequest(client, workspaceId, result.actionRequestId),
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
        gatekeeperClient: new HttpGatekeeperClient({ token: GATE_TEST_TOKEN }),
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

    it('a draft (unpublished) operation never executes, even though its own manifest entry declares auto_approvable', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      const before = transport.calls[DRAFT_OP.name] ?? 0;

      const result = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: DRAFT_OP.name,
        params: {},
      })) as { status: string; actionRequestId: string };

      expect(result.status).toBe('pending_approval');
      expect(transport.calls[DRAFT_OP.name] ?? 0).toBe(before); // never invoked
    });
  },
);
