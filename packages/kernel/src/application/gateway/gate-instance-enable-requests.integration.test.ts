import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AvailableGateInstanceWire,
  ConnectionRequestWire,
  EnableGateInstanceResultWire,
  ListEnvelope,
  Operation,
  PreviewGateInstanceEnableResultWire,
  Role,
} from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { withPlatform } from '../../adapters/db/platform-context.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { HANDLE_SIGNING_ALG } from '../../governance/capability/index.js';
import {
  ConnectionRequestIsGateEnableError,
  claimConnectionRequest,
} from '../../governance/connections/index.js';
import { upsertAnnouncement } from '../gates/index.js';
import { createPlatformAdmin } from '../identity/index.js';
import type { UserRow } from '../identity/index.js';
import { configureTaskRuntime, resetTaskRuntimeForTests } from '../task/runtime.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import { withAdminClient } from './auth.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import { GateInstanceNotAvailableError } from './gate-instance-handlers.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * Legacy 254 (coordinator decision 2026-11-19, choice A): a member asks the workspace owner to
 * enable a platform gate instance, and the ask is a ConnectionRequest (governance 0047). Covers the
 * coordinator's four requirements end to end, on a private database:
 *
 *   1. the database holds one open request per person per gate (partial unique index), and the
 *      other 0047 invariants, whoever writes;
 *   2. `enable_gate_instance` completes the open requests, and the audit names requester and
 *      enabler;
 *   3. every way a request ends lands in a named terminal state — withdrawn, declined, completed,
 *      or `gate_unavailable` when the platform disables, deletes or un-presets the gate (a lost
 *      gate keeps it open) — including a request racing the platform's change;
 *   4. the wire: `target` absent and `gateInstance` present on such a request, `request_connection`
 *      unchanged.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const REPO_ROOT = path.resolve(KERNEL_ROOT, '..', '..');
const ONTOLOGY_DIR = path.join(REPO_ROOT, 'ontology');
const PASSWORD = 'correct horse battery staple';

const OBSERVE_OP: Operation = {
  name: 'list_things',
  binding: { kind: 'mcp', tool_name: 'list_things' },
  params_schema: { type: 'object', properties: {} },
  mode: 'observe',
  blast_radius: 'low',
  reversibility: false,
  auto_approvable: true,
  await_decision: false,
  reads: [],
  writes: [],
  read_only_hint: true,
};

async function waitForNoConnections(cluster: Pool, name: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const { rows } = await cluster.query<{ n: string }>(
      'select count(*)::text as n from pg_stat_activity where datname = $1',
      [name],
    );
    if (rows[0]?.n === '0') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function createIsolatedDatabase(): Promise<{ pool: Pool; drop: () => Promise<void> }> {
  if (DATABASE_URL === undefined) throw new Error('createIsolatedDatabase needs DATABASE_URL');
  const cluster = createPool();
  const name = `nexttime_gate_enable_requests_${randomUUID().replace(/-/g, '')}`;
  try {
    await cluster.query(`create database "${name}"`);
  } catch (err) {
    await cluster.end();
    throw err;
  }
  const url = new URL(DATABASE_URL);
  url.pathname = `/${name}`;
  const pool = createPool({ connectionString: url.toString() });
  return {
    pool,
    drop: async () => {
      await pool.end();
      await waitForNoConnections(cluster, name);
      await cluster.query(`drop database if exists "${name}" with (force)`);
      await cluster.end();
    },
  };
}

interface Workspace {
  readonly id: string;
  readonly ownerId: string;
  readonly memberId: string;
  readonly otherMemberId: string;
}

describe.runIf(DATABASE_URL !== undefined)(
  'legacy 254: gate instance enable requests (integration, real Postgres)',
  () => {
    let pool: Pool;
    let dropDatabase: (() => Promise<void>) | undefined;
    let admin: UserRow;
    let ws: Workspace;
    let otherWs: Workspace;

    function humanCaller(workspace: Workspace, principalId: string, role: Role): ResolvedCaller {
      return {
        channel: 'human',
        principal: {
          workspaceId: workspace.id,
          id: principalId,
          kind: 'human',
          role,
          displayName: null,
        },
        session: {
          workspaceId: workspace.id,
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
    const owner = (w: Workspace) => humanCaller(w, w.ownerId, 'owner');
    const member = (w: Workspace) => humanCaller(w, w.memberId, 'member');
    const otherMember = (w: Workspace) => humanCaller(w, w.otherMemberId, 'member');

    function call<T>(caller: ResolvedCaller, name: string, params: Record<string, unknown> = {}) {
      return dispatchCapability({ pool }, caller, name, params) as Promise<T>;
    }
    function platform<T>(name: string, params: Record<string, unknown> = {}) {
      return dispatchCapability(
        { pool },
        {
          channel: 'platform',
          user: {
            id: admin.id,
            login: admin.login,
            displayName: admin.displayName,
            platformRole: 'admin',
            mustChangePassword: false,
            consoleSessionId: randomUUID(),
          },
        },
        name,
        params,
      ) as Promise<T>;
    }
    const ask = (caller: ResolvedCaller, gateId: string) =>
      call<ConnectionRequestWire>(caller, 'request_gate_instance_enable', { gateId });

    async function enable(caller: ResolvedCaller, gateId: string) {
      const preview = await call<PreviewGateInstanceEnableResultWire>(
        caller,
        'preview_gate_instance_enable',
        { gateId },
      );
      return call<EnableGateInstanceResultWire>(caller, 'enable_gate_instance', {
        gateId,
        manifestDigest: preview.manifestDigest,
      });
    }

    async function refusal(promise: Promise<unknown>): Promise<string> {
      const err = await promise.then(
        () => {
          throw new Error('expected a refusal, but the call resolved');
        },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(GateInstanceNotAvailableError);
      return (err as GateInstanceNotAvailableError).code;
    }

    /** A packaged gate announced and enabled by the platform, its connector platform-preset. */
    async function platformGate(opts: { hosted?: boolean; status?: string } = {}) {
      const gateId = `enable-req-${randomUUID().slice(0, 8)}`;
      const client = await pool.connect();
      try {
        await client.query('begin');
        const outcome = await upsertAnnouncement(
          client,
          {
            gateId,
            connector: `${gateId}-system`,
            transportKind: 'http',
            endpoint: `https://${gateId}.example.invalid`,
            displayName: `Gate ${gateId}`,
            operations: [OBSERVE_OP],
          },
          'gate',
        );
        if (
          'connectorRefused' in outcome ||
          'rejected' in outcome ||
          'credentialRefused' in outcome
        ) {
          throw new Error(`platformGate: ${JSON.stringify(outcome)}`);
        }
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
      // A gate-host instance (the kind `delete_gate_instance` removes) carries its definition.
      await pool.query(
        `update gate_instances
            set status = $2, hosted = $3,
                definition = case when $3 then jsonb_build_object('transportKind', 'http',
                  'target', endpoint, 'credentialMode', 'shared', 'manifestSource', endpoint)
                end
          where gate_id = $1`,
        [gateId, opts.status ?? 'enabled', opts.hosted ?? false],
      );
      return gateId;
    }

    async function requestRow(workspaceId: string, id: string) {
      return withAdminClient(pool, async (client) => {
        const result = await client.query<{
          status: string;
          cancel_reason: string | null;
          cancelled_at: Date | null;
          gatekeeper_id: string | null;
          completed_by: string | null;
          target: string | null;
          gate_instance_id: string | null;
        }>(
          `select status, cancel_reason, cancelled_at, gatekeeper_id, completed_by, target,
                  gate_instance_id
             from connection_requests where workspace_id = $1 and id = $2`,
          [workspaceId, id],
        );
        return result.rows[0];
      });
    }

    async function auditRows(where: string, params: unknown[]) {
      return withAdminClient(pool, async (client) => {
        const result = await client.query<{
          action: string;
          actor_principal_id: string | null;
          workspace_id: string | null;
          resource_id: string | null;
          payload: Record<string, unknown>;
        }>(
          `select action, actor_principal_id, workspace_id, resource_id, payload
             from audit_records where ${where} order by created_at, id`,
          params,
        );
        return result.rows;
      });
    }

    async function workspaceWithMembers(name: string): Promise<Workspace> {
      const created = await createWorkspaceWithOwner(pool, {
        name,
        owner: { userId: admin.id, displayName: 'Admin' },
        ontologyDir: ONTOLOGY_DIR,
      });
      const memberId = randomUUID();
      const otherMemberId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: created.workspaceId, principalId: memberId },
        async (client) => {
          for (const [id, display] of [
            [memberId, 'asking member'],
            [otherMemberId, 'other member'],
          ]) {
            await client.query(
              `insert into principals (workspace_id, id, kind, role, display_name)
               values ($1, $2, 'human', 'member', $3)`,
              [created.workspaceId, id, display],
            );
          }
        },
        { skipRoleSwitch: true },
      );
      return {
        id: created.workspaceId,
        ownerId: created.ownerPrincipalId,
        memberId,
        otherMemberId,
      };
    }

    beforeAll(async () => {
      const isolated = await createIsolatedDatabase();
      pool = isolated.pool;
      dropDatabase = isolated.drop;
      await runMigrations(pool, MIGRATIONS_DIR);
      const pair = await generateKeyPair(HANDLE_SIGNING_ALG, { crv: 'Ed25519' });
      configureTaskRuntime({
        pool,
        privateKey: pair.privateKey,
        supervisorClient: {
          spawn: async () => {
            throw new Error('not used');
          },
          terminate: async () => false,
          status: async () => undefined,
        },
      });
      admin = await createPlatformAdmin(pool, {
        login: `enable-req-admin-${randomUUID().slice(0, 8)}`,
        displayName: 'Enable Requests Admin',
        password: PASSWORD,
      });
      ws = await workspaceWithMembers('enable-requests-a');
      otherWs = await workspaceWithMembers('enable-requests-b');
    }, 180_000);

    afterAll(async () => {
      resetTaskRuntimeForTests();
      await dropDatabase?.();
    }, 60_000);

    it('a member asks: one open request per person per gate, in the owner queue with the gate named, no target; read back on the list', async () => {
      const gateId = await platformGate();
      const first = await ask(member(ws), gateId);
      expect(first).toMatchObject({
        status: 'requested',
        kind: 'http',
        gateInstance: { gateId, displayName: `Gate ${gateId}` },
        requestedBy: ws.memberId,
      });
      expect(first).not.toHaveProperty('target');

      // Asking again returns the open one, nothing written.
      const again = await ask(member(ws), gateId);
      expect(again.id).toBe(first.id);
      expect(again.requestedAt).toBe(first.requestedAt);
      const calls = await auditRows(
        `workspace_id = $1 and action = 'request_gate_instance_enable' and actor_principal_id = $2
           and payload ->> 'gateId' = $3`,
        [ws.id, ws.memberId, gateId],
      );
      expect(calls.map((row) => row.payload.created)).toEqual([true, false]);

      // Another person asks for the same gate: their own request.
      const other = await ask(otherMember(ws), gateId);
      expect(other.id).not.toBe(first.id);

      const queue = await call<ListEnvelope<ConnectionRequestWire>>(
        owner(ws),
        'list_connection_requests',
        { status: 'requested' },
      );
      const listed = queue.items.filter((item) => item.gateInstance?.gateId === gateId);
      expect(listed.map((item) => item.id).sort()).toEqual([first.id, other.id].sort());
      for (const item of listed) expect(item).not.toHaveProperty('target');

      // 「已申请」 is read back from the server, per person.
      const mine = await call<ListEnvelope<AvailableGateInstanceWire>>(
        member(ws),
        'list_available_gate_instances',
      );
      expect(mine.items.find((g) => g.gateId === gateId)?.myEnableRequest).toEqual({
        id: first.id,
        requestedAt: first.requestedAt,
      });
      const theOwners = await call<ListEnvelope<AvailableGateInstanceWire>>(
        owner(ws),
        'list_available_gate_instances',
      );
      expect(theOwners.items.find((g) => g.gateId === gateId)).not.toHaveProperty(
        'myEnableRequest',
      );
    });

    it('refused like enable_gate_instance when no owner could act on it, and once the workspace enabled it', async () => {
      expect(await refusal(ask(member(ws), 'no-such-gate'))).toBe('gate_not_found');
      const discovered = await platformGate({ status: 'discovered' });
      expect(await refusal(ask(member(ws), discovered))).toBe('gate_not_enabled');
      const selfServe = await platformGate();
      await pool.query(
        "update connectors set mode = 'self_serve' where name = (select connector from gate_instances where gate_id = $1)",
        [selfServe],
      );
      expect(await refusal(ask(member(ws), selfServe))).toBe('connector_not_preset');
      const enabledHere = await platformGate();
      await enable(owner(ws), enabledHere);
      expect(await refusal(ask(member(ws), enabledHere))).toBe('gate_already_enabled');
      // Nothing was written for any of them.
      const rows = await withAdminClient(pool, (client) =>
        client.query('select 1 from connection_requests where gate_instance_id = any($1::text[])', [
          ['no-such-gate', discovered, selfServe, enabledHere],
        ]),
      );
      expect(rows.rowCount).toBe(0);
    });

    it('the enable completes every open request for the gate, naming requester and enabler in the audit; a withdrawn one stays withdrawn', async () => {
      const gateId = await platformGate();
      const mine = await ask(member(ws), gateId);
      const theirs = await ask(otherMember(ws), gateId);
      const elsewhere = await ask(member(otherWs), gateId);
      const withdrawnFirst = await platformGate();
      const gone = await ask(otherMember(ws), withdrawnFirst);
      await call(otherMember(ws), 'cancel_connection_request', { connectionRequestId: gone.id });

      const enabled = await enable(owner(ws), gateId);
      expect([...(enabled.completedConnectionRequestIds ?? [])].sort()).toEqual(
        [mine.id, theirs.id].sort(),
      );
      for (const id of [mine.id, theirs.id]) {
        expect(await requestRow(ws.id, id)).toMatchObject({
          status: 'completed',
          gatekeeper_id: enabled.gatekeeperId,
          completed_by: ws.ownerId,
          cancel_reason: null,
        });
      }
      // Another workspace's request for the same gate is that workspace's owner's to act on.
      expect((await requestRow(otherWs.id, elsewhere.id))?.status).toBe('requested');
      expect((await requestRow(ws.id, gone.id))?.status).toBe('cancelled');

      const completedAudit = await auditRows(
        `workspace_id = $1 and action = 'connection.request_completed' and payload ->> 'gateId' = $2`,
        [ws.id, gateId],
      );
      expect(completedAudit).toHaveLength(2);
      expect(
        completedAudit.map((row) => ({
          request: row.resource_id,
          actor: row.actor_principal_id,
          requestedBy: row.payload.requestedBy,
          completedBy: row.payload.completedBy,
          gatekeeperId: row.payload.gatekeeperId,
        })),
      ).toEqual(
        expect.arrayContaining([
          {
            request: mine.id,
            actor: ws.ownerId,
            requestedBy: ws.memberId,
            completedBy: ws.ownerId,
            gatekeeperId: enabled.gatekeeperId,
          },
          {
            request: theirs.id,
            actor: ws.ownerId,
            requestedBy: ws.otherMemberId,
            completedBy: ws.ownerId,
            gatekeeperId: enabled.gatekeeperId,
          },
        ]),
      );
      const [enableRow] = await auditRows(
        `workspace_id = $1 and action = 'enable_gate_instance' and resource_id = $2`,
        [ws.id, enabled.gatekeeperId],
      );
      expect(enableRow?.payload.completedConnectionRequests).toEqual(
        expect.arrayContaining([
          { id: mine.id, requestedBy: ws.memberId },
          { id: theirs.id, requestedBy: ws.otherMemberId },
        ]),
      );

      // The owner's queue shows them done, and the enable again (already linked) completes nothing.
      const again = await enable(owner(ws), gateId);
      expect(again).not.toHaveProperty('completedConnectionRequestIds');
    });

    it('withdrawn by its requester, declined by the owner, refused to anyone else; a new ask after either is a new request', async () => {
      const gateId = await platformGate();
      const first = await ask(member(ws), gateId);
      await expect(
        call(otherMember(ws), 'cancel_connection_request', { connectionRequestId: first.id }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      const withdrawn = await call<ConnectionRequestWire>(member(ws), 'cancel_connection_request', {
        connectionRequestId: first.id,
      });
      expect(withdrawn).toMatchObject({
        status: 'cancelled',
        cancelReason: 'withdrawn',
        gateInstance: { gateId, displayName: `Gate ${gateId}` },
      });
      expect(withdrawn.cancelledAt).toEqual(expect.any(String));
      expect(withdrawn).not.toHaveProperty('target');

      const second = await ask(member(ws), gateId);
      expect(second.id).not.toBe(first.id);
      const declined = await call<ConnectionRequestWire>(owner(ws), 'cancel_connection_request', {
        connectionRequestId: second.id,
      });
      expect(declined.cancelReason).toBe('declined');

      const audit = await auditRows(
        `workspace_id = $1 and action = 'connection.request_cancelled' and resource_id = any($2::uuid[])`,
        [ws.id, [first.id, second.id]],
      );
      expect(audit.map((row) => ({ actor: row.actor_principal_id, payload: row.payload }))).toEqual(
        [
          {
            actor: ws.memberId,
            payload: {
              resultingStatus: 'cancelled',
              cancelReason: 'withdrawn',
              kind: 'http',
              gateId,
              requestedBy: ws.memberId,
            },
          },
          {
            actor: ws.ownerId,
            payload: {
              resultingStatus: 'cancelled',
              cancelReason: 'declined',
              kind: 'http',
              gateId,
              requestedBy: ws.memberId,
            },
          },
        ],
      );
      // A self connection's cancel keeps its target in the audit, as before.
      const selfReq = await withAdminClient(pool, (client) =>
        client.query<{ id: string }>(
          `insert into connection_requests (workspace_id, kind, target, requested_by)
           values ($1, 'http', 'https://inventory.example.invalid/api', $2) returning id`,
          [ws.id, ws.memberId],
        ),
      );
      const selfId = selfReq.rows[0]?.id as string;
      const selfCancelled = await call<ConnectionRequestWire>(
        member(ws),
        'cancel_connection_request',
        { connectionRequestId: selfId },
      );
      expect(selfCancelled).toMatchObject({
        target: 'https://inventory.example.invalid/api',
        cancelReason: 'withdrawn',
      });
      expect(selfCancelled).not.toHaveProperty('gateInstance');
    });

    it('the platform disabling the instance cancels its open requests in every workspace as gate_unavailable, listed on the platform audit row; others stay open', async () => {
      const gateId = await platformGate();
      const untouchedGate = await platformGate();
      const a = await ask(member(ws), gateId);
      const b = await ask(member(otherWs), gateId);
      const withdrawn = await ask(otherMember(ws), gateId);
      await call(otherMember(ws), 'cancel_connection_request', {
        connectionRequestId: withdrawn.id,
      });
      const untouched = await ask(member(ws), untouchedGate);

      await platform('update_gate_instance', { gateId, status: 'disabled' });

      for (const [workspaceId, id] of [
        [ws.id, a.id],
        [otherWs.id, b.id],
      ] as const) {
        const row = await requestRow(workspaceId, id);
        expect(row).toMatchObject({ status: 'cancelled', cancel_reason: 'gate_unavailable' });
        expect(row?.cancelled_at).toBeInstanceOf(Date);
      }
      expect((await requestRow(ws.id, withdrawn.id))?.cancel_reason).toBe('withdrawn');
      expect((await requestRow(ws.id, untouched.id))?.status).toBe('requested');

      const [platformRow] = await auditRows(
        `workspace_id is null and action = 'update_gate_instance'
           and payload -> 'cancelledConnectionRequests' -> 0 ->> 'gateId' = $1`,
        [gateId],
      );
      expect(platformRow?.payload.cancelledConnectionRequests).toEqual(
        expect.arrayContaining([
          { workspaceId: ws.id, id: a.id, gateId, requestedBy: ws.memberId },
          { workspaceId: otherWs.id, id: b.id, gateId, requestedBy: otherWs.memberId },
        ]),
      );
      expect(platformRow?.payload.cancelledConnectionRequests).toHaveLength(2);

      // The requester reads why on the request.
      const queue = await call<ListEnvelope<ConnectionRequestWire>>(
        owner(ws),
        'list_connection_requests',
        { status: 'cancelled' },
      );
      expect(queue.items.find((item) => item.id === a.id)).toMatchObject({
        cancelReason: 'gate_unavailable',
        gateInstance: { gateId },
      });
    });

    it('deleting a gate-host instance, or taking its connector out of platform-preset mode, cancels too; a lost gate keeps its requests open', async () => {
      const hosted = await platformGate({ hosted: true });
      const onHosted = await ask(member(ws), hosted);
      await platform('delete_gate_instance', { gateId: hosted });
      expect(await requestRow(ws.id, onHosted.id)).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'gate_unavailable',
      });
      // Deleted: the queue still says which gate it was, with no name.
      const queue = await call<ListEnvelope<ConnectionRequestWire>>(
        owner(ws),
        'list_connection_requests',
        { status: 'cancelled' },
      );
      expect(queue.items.find((item) => item.id === onHosted.id)?.gateInstance).toEqual({
        gateId: hosted,
        displayName: null,
      });

      const preset = await platformGate();
      const onPreset = await ask(member(ws), preset);
      await platform('set_connector_mode', { name: `${preset}-system`, mode: 'self_serve' });
      expect(await requestRow(ws.id, onPreset.id)).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'gate_unavailable',
      });
      const [modeRow] = await auditRows(
        `workspace_id is null and action = 'set_connector_mode'
           and payload -> 'cancelledConnectionRequests' -> 0 ->> 'gateId' = $1`,
        [preset],
      );
      expect(modeRow?.payload.cancelledConnectionRequests).toEqual([
        { workspaceId: ws.id, id: onPreset.id, gateId: preset, requestedBy: ws.memberId },
      ]);

      const lost = await platformGate();
      const onLost = await ask(member(ws), lost);
      await pool.query(
        "update gate_instances set status_before_lost = status, status = 'lost' where gate_id = $1",
        [lost],
      );
      expect((await requestRow(ws.id, onLost.id))?.status).toBe('requested');
      // Meanwhile the owner cannot enable it, and no one can ask again.
      expect(await refusal(ask(otherMember(ws), lost))).toBe('gate_not_enabled');
    });

    it('a request racing the platform disable: it waits on the availability lock and then reads the disable, never left open', async () => {
      const gateId = await platformGate();
      // The platform's disable, in flight: its transaction holds the lock and has changed the
      // status, not yet committed.
      const held = await pool.connect();
      try {
        await held.query('begin');
        await held.query('select pg_advisory_xact_lock(hashtext($1::text))', [
          `gate_instance_availability:${gateId}`,
        ]);
        await held.query("update gate_instances set status = 'disabled' where gate_id = $1", [
          gateId,
        ]);
        const asked = ask(member(ws), gateId).then(
          () => 'resolved',
          (err: unknown) => (err instanceof GateInstanceNotAvailableError ? err.code : String(err)),
        );
        // The request is blocked behind the lock, not refused or resolved yet.
        const early = await Promise.race([
          asked,
          new Promise((resolve) => setTimeout(() => resolve('waiting'), 300)),
        ]);
        expect(early).toBe('waiting');
        await held.query('commit');
        expect(await asked).toBe('gate_not_enabled');
      } finally {
        held.release();
      }
      const rows = await withAdminClient(pool, (client) =>
        client.query('select 1 from connection_requests where gate_instance_id = $1', [gateId]),
      );
      expect(rows.rowCount).toBe(0);
    });

    // #493 on #1521 (optional 1): the two directions the race above leaves to a hand-written
    // transaction — the platform's real handler waiting behind a request in flight, and the
    // owner's real enable waiting behind a platform disable in flight.
    it('the platform disable racing a request in flight: update_gate_instance waits on the availability lock, then cancels what the other transaction committed', async () => {
      const gateId = await platformGate();
      const held = await pool.connect();
      let requestId = '';
      try {
        await held.query('begin');
        await held.query('select pg_advisory_xact_lock_shared(hashtext($1::text))', [
          `gate_instance_availability:${gateId}`,
        ]);
        const inserted = await held.query<{ id: string }>(
          `insert into connection_requests (workspace_id, kind, gate_instance_id, requested_by)
           values ($1, 'http', $2, $3) returning id`,
          [ws.id, gateId, ws.memberId],
        );
        requestId = inserted.rows[0]?.id ?? '';
        const disabled = platform('update_gate_instance', { gateId, status: 'disabled' }).then(
          () => 'disabled',
          (err: unknown) => String(err),
        );
        const early = await Promise.race([
          disabled,
          new Promise((resolve) => setTimeout(() => resolve('waiting'), 300)),
        ]);
        expect(early).toBe('waiting');
        await held.query('commit');
        expect(await disabled).toBe('disabled');
      } finally {
        held.release();
      }
      expect(await requestRow(ws.id, requestId)).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'gate_unavailable',
      });
    });

    it('an enable racing the platform disable: enable_gate_instance waits on the availability lock, then reads the disable', async () => {
      const gateId = await platformGate();
      const preview = await call<PreviewGateInstanceEnableResultWire>(
        owner(ws),
        'preview_gate_instance_enable',
        { gateId },
      );
      const held = await pool.connect();
      try {
        await held.query('begin');
        await held.query('select pg_advisory_xact_lock(hashtext($1::text))', [
          `gate_instance_availability:${gateId}`,
        ]);
        await held.query("update gate_instances set status = 'disabled' where gate_id = $1", [
          gateId,
        ]);
        const enabled = call(owner(ws), 'enable_gate_instance', {
          gateId,
          manifestDigest: preview.manifestDigest,
        }).then(
          () => 'enabled',
          (err: unknown) => (err instanceof GateInstanceNotAvailableError ? err.code : String(err)),
        );
        const early = await Promise.race([
          enabled,
          new Promise((resolve) => setTimeout(() => resolve('waiting'), 300)),
        ]);
        expect(early).toBe('waiting');
        await held.query('commit');
        expect(await enabled).toBe('gate_not_enabled');
      } finally {
        held.release();
      }
      const links = await withAdminClient(pool, (client) =>
        client.query(
          'select 1 from workspace_gate_links where workspace_id = $1 and gate_id = $2',
          [ws.id, gateId],
        ),
      );
      expect(links.rowCount).toBe(0);
    });

    it('create_connection cannot complete a gate instance enable request (409 connection_request_is_gate_enable)', async () => {
      const gateId = await platformGate();
      const request = await ask(member(ws), gateId);
      await expect(
        withWorkspace(pool, { workspaceId: ws.id, principalId: ws.ownerId }, (client) =>
          claimConnectionRequest(client, ws.id, request.id),
        ),
      ).rejects.toBeInstanceOf(ConnectionRequestIsGateEnableError);
      expect((await requestRow(ws.id, request.id))?.status).toBe('requested');
    });

    describe('governance 0047 holds whoever writes', () => {
      async function insertAsWorkspace(
        sql: string,
        params: unknown[],
      ): Promise<{ code?: string; constraint?: string }> {
        try {
          await withWorkspace(pool, { workspaceId: ws.id, principalId: ws.ownerId }, (client) =>
            client.query(sql, params),
          );
          return {};
        } catch (err) {
          return err as { code?: string; constraint?: string };
        }
      }

      it('one open request per person per gate; exactly one of target and gate instance; cancel fields only on cancelled', async () => {
        const gateId = await platformGate();
        await ask(member(ws), gateId);
        expect(
          await insertAsWorkspace(
            `insert into connection_requests (workspace_id, kind, gate_instance_id, requested_by)
             values ($1, 'http', $2, $3)`,
            [ws.id, gateId, ws.memberId],
          ),
        ).toMatchObject({ code: '23505', constraint: 'connection_requests_one_open_gate_enable' });
        // A closed one does not count.
        expect(
          await insertAsWorkspace(
            `insert into connection_requests
               (workspace_id, kind, gate_instance_id, requested_by, status, cancel_reason, cancelled_at)
             values ($1, 'http', $2, $3, 'cancelled', 'withdrawn', now())`,
            [ws.id, gateId, ws.memberId],
          ),
        ).toEqual({});
        expect(
          await insertAsWorkspace(
            `insert into connection_requests (workspace_id, kind, target, gate_instance_id, requested_by)
             values ($1, 'http', 'https://x.example.invalid', $2, $3)`,
            [ws.id, `${gateId}-both`, ws.otherMemberId],
          ),
        ).toMatchObject({ code: '23514', constraint: 'connection_requests_one_subject' });
        expect(
          await insertAsWorkspace(
            `insert into connection_requests (workspace_id, kind, requested_by) values ($1, 'http', $2)`,
            [ws.id, ws.otherMemberId],
          ),
        ).toMatchObject({ code: '23514', constraint: 'connection_requests_one_subject' });
        expect(
          await insertAsWorkspace(
            `insert into connection_requests
               (workspace_id, kind, gate_instance_id, requested_by, cancel_reason, cancelled_at)
             values ($1, 'http', $2, $3, 'withdrawn', now())`,
            [ws.id, `${gateId}-x`, ws.otherMemberId],
          ),
        ).toMatchObject({ code: '23514', constraint: 'connection_requests_cancel_fields' });
        expect(
          await insertAsWorkspace(
            `insert into connection_requests
               (workspace_id, kind, gate_instance_id, requested_by, status, cancel_reason)
             values ($1, 'http', $2, $3, 'cancelled', 'withdrawn')`,
            [ws.id, `${gateId}-y`, ws.otherMemberId],
          ),
        ).toMatchObject({ code: '23514', constraint: 'connection_requests_cancel_fields' });
        expect(
          await insertAsWorkspace(
            `insert into connection_requests
               (workspace_id, kind, gate_instance_id, requested_by, status, cancel_reason, cancelled_at)
             values ($1, 'http', $2, $3, 'cancelled', 'bored', now())`,
            [ws.id, `${gateId}-z`, ws.otherMemberId],
          ),
        ).toMatchObject({ code: '23514', constraint: 'connection_requests_cancel_reason' });
      });

      it('the platform plane reads gate instance requests only, and may only cancel an open one as gate_unavailable', async () => {
        const gateId = await platformGate();
        const open = await ask(member(ws), gateId);
        const selfReq = await withAdminClient(pool, (client) =>
          client.query<{ id: string }>(
            `insert into connection_requests (workspace_id, kind, target, requested_by)
             values ($1, 'http', 'https://platform-cannot-see.example.invalid', $2) returning id`,
            [ws.id, ws.memberId],
          ),
        );
        const selfId = selfReq.rows[0]?.id as string;

        const seen = await withPlatform(pool, { userId: admin.id }, (client: PoolClient) =>
          client.query<{ id: string }>(
            'select id from connection_requests where id = any($1::uuid[])',
            [[open.id, selfId]],
          ),
        );
        expect(seen.rows.map((row) => row.id)).toEqual([open.id]);

        // Any other edge or column is refused by the policy's `with check`.
        for (const set of [
          "status = 'completed', gatekeeper_id = gen_random_uuid(), completed_by = requested_by, completed_at = now()",
          "status = 'cancelled', cancel_reason = 'withdrawn', cancelled_at = now()",
          "status = 'cancelled', cancel_reason = 'declined', cancelled_at = now()",
        ]) {
          const outcome = await withPlatform(pool, { userId: admin.id }, (client: PoolClient) =>
            client.query(`update connection_requests set ${set} where id = $1`, [open.id]),
          ).then(
            () => 'written',
            (err: { code?: string }) => err.code,
          );
          expect(outcome).not.toBe('written');
        }
        // A self connection's request is not even visible to update.
        const selfUpdate = await withPlatform(pool, { userId: admin.id }, (client: PoolClient) =>
          client.query(
            `update connection_requests set status = 'cancelled', cancel_reason = 'gate_unavailable',
                    cancelled_at = now() where id = $1`,
            [selfId],
          ),
        );
        expect(selfUpdate.rowCount).toBe(0);
        expect((await requestRow(ws.id, open.id))?.status).toBe('requested');
        expect((await requestRow(ws.id, selfId))?.status).toBe('requested');
      });

      // #501 on #1521 (S1): a policy's `with check` sees only the new row, so governance 0048's
      // guard holds what a request is about against every writer — the platform plane's one edge
      // cannot carry another change with it, nor can the workspace plane or a role without RLS.
      it('governance 0048: what a request is about never changes — not alongside the platform’s cancel, not from a workspace, not without RLS', async () => {
        const gateId = await platformGate();
        const open = await ask(member(ws), gateId);
        const before = await requestRow(ws.id, open.id);
        const cancel =
          "status = 'cancelled', cancel_reason = 'gate_unavailable', cancelled_at = now()";
        const changes: readonly [string, unknown[]][] = [
          ['requested_by = $2', [ws.otherMemberId]],
          ["kind = 'ssh'", []],
          ["requested_at = now() - interval '1 day'", []],
          ['gate_instance_id = $2', [`${gateId}-elsewhere`]],
          ['id = $2', [randomUUID()]],
          // Moving it to another workspace: refused by the guard before the requester's foreign
          // key is even checked.
          ['workspace_id = $2', [otherWs.id]],
          // #493 on #1521 (optional 3): who completed it is written by completing it only.
          ['completed_by = $2', [ws.ownerId]],
        ];
        for (const [change, extra] of changes) {
          const sql = `update connection_requests set ${cancel}, ${change} where id = $1`;
          const platformWrite = await withPlatform(
            pool,
            { userId: admin.id },
            (client: PoolClient) => client.query(sql, [open.id, ...extra]),
          ).then(
            () => 'written',
            (err: { code?: string }) => err.code,
          );
          expect(platformWrite, change).toBe('23514');
        }
        // The workspace plane, its own request: the guard, not only its policy.
        const workspaceWrite = await withWorkspace(
          pool,
          { workspaceId: ws.id, principalId: ws.ownerId },
          (client) =>
            client.query('update connection_requests set requested_by = $2 where id = $1', [
              open.id,
              ws.otherMemberId,
            ]),
        ).then(
          () => 'written',
          (err: { code?: string }) => err.code,
        );
        expect(workspaceWrite).toBe('23514');
        // Without RLS at all, a self connection's target included.
        const selfReq = await withAdminClient(pool, (client) =>
          client.query<{ id: string }>(
            `insert into connection_requests (workspace_id, kind, target, requested_by)
             values ($1, 'http', 'https://fixed.example.invalid', $2) returning id`,
            [ws.id, ws.memberId],
          ),
        );
        const unguarded = await withAdminClient(pool, (client) =>
          client.query(
            `update connection_requests set target = 'https://moved.example.invalid' where id = $1`,
            [selfReq.rows[0]?.id],
          ),
        ).then(
          () => 'written',
          (err: { code?: string }) => err.code,
        );
        expect(unguarded).toBe('23514');
        // Nothing moved; the platform's one edge on its own still goes through.
        expect(await requestRow(ws.id, open.id)).toEqual(before);
        const cancelled = await withPlatform(pool, { userId: admin.id }, (client: PoolClient) =>
          client.query(`update connection_requests set ${cancel} where id = $1`, [open.id]),
        );
        expect(cancelled.rowCount).toBe(1);
        expect((await requestRow(ws.id, open.id))?.cancel_reason).toBe('gate_unavailable');
      });
    });
  },
);
