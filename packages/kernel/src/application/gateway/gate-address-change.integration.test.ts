import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  GateAddressChangePreviewWire,
  GateAddressChangeWire,
  GatekeeperDetailWire,
  Operation,
  PlatformGateAddressChangeWire,
} from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import type { GateTarget, GatekeeperClient } from '../../adapters/gatekeeper-client/index.js';
import {
  GatekeeperClientError,
  createGateConnectionSecrets,
} from '../../adapters/gatekeeper-client/index.js';
import { OutboundTargetRefusedError } from '../../adapters/outbound-target/index.js';
import { getActionRequest, requestAction } from '../../governance/approval/index.js';
import {
  gateAddressOrigin,
  getGatekeeper,
  getPublishedOperation,
  lockSelfConnectionState,
  normalizeGateEndpoint,
  operationRecordDigest,
  publishOperation,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { mapCapabilityError } from '../../interfaces/http/capability-route.js';
import { runInvariantChecks } from '../../substrate/audit/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { REDACTED } from '../../substrate/redaction/index.js';
import { type UserRow, createPlatformAdmin } from '../identity/index.js';
import { createAdminWithTransaction, createGatekeeperActionExecutor } from './action-executor.js';
import { setConnectionHandlerDeps } from './connection-handlers.js';
import { connectedAccountPresence, setCredentialPresenceDeps } from './credential-presence.js';
import { dispatchCapability } from './dispatch.js';
import { resolveGateTarget } from './gate-target.js';
import { setGatekeeperReadHandlerDeps } from './gatekeeper-read-handlers.js';
import type { ResolvedCaller } from './resolve-caller.js';
import { humanCaller, newWorkspace } from './traversal-fixture.js';

/**
 * application/gateway/gate-address-change.integration (legacy 701): moving a gate a workspace
 * connected itself to a new address — `preview_` / `propose_` / `withdraw_gate_address_change`
 * (the workspace's owner) and `list_` / `approve_` / `reject_gate_address_change` (a platform
 * administrator) — through `dispatchCapability`, against real Postgres and a fake gate client
 * keyed by address (nothing leaves the process).
 *
 * What it proves: an approval moves the Gatekeeper Object and its self connection together, to the
 * proposed address with the proposed secret (I-A1, checked by the invariant checker too); nothing
 * is contacted before the cheap refusals; the new host's manifest must match, at proposal and again
 * at approval (I-A4); one open proposal per gate (I-A2) and one proposal per secret; a request made
 * at the old address is refused at the new one and the reaper asks no one about it (I-A3); a
 * request made before requests were bound to an address blocks the approval; the secret is never
 * stored; the presence cache forgets the old host's answers.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const GATE_TOKEN = 'gate-address-change-test-gate-token-0123456789';
/** A secret-looking value an administrator might paste into a reason. Synthetic: `.gitleaks.toml`
 *  allows the `abcdefghijklmnopqrstuvwxyz` run. */
const FAKE_SECRET = 'abcdefghijklmnopqrstuvwxyz0123';

const OP: Operation = {
  name: 'stock.get',
  binding: { kind: 'http', method: 'GET', path: '/stocks' },
  params_schema: {},
  mode: 'observe',
  blast_radius: 'low',
  reversibility: false,
  auto_approvable: true,
  await_decision: false,
  reads: [],
  writes: [],
};

/** A gate keyed by address: what each one describes (OP unless told otherwise), every call it
 *  got, and whether a member's account is on it (the old host says yes, any other no). */
function createFakeGates() {
  const described = new Map<string, Operation[]>();
  /** An address whose `describe_operations` fails with this error. */
  const failing = new Map<string, Error>();
  const describeCalls: GateTarget[] = [];
  const presenceCalls: string[] = [];
  const runCalls: string[] = [];
  const connected = new Set<string>();
  const client: GatekeeperClient = {
    describeOperations: async (target) => {
      describeCalls.push(target);
      const failure = failing.get(target.endpoint);
      if (failure) throw failure;
      return { operations: described.get(target.endpoint) ?? [OP] };
    },
    observe: async () => {
      throw new Error('not in this file');
    },
    simulate: async () => {
      throw new Error('not in this file');
    },
    apply: async (target) => {
      runCalls.push(`apply ${target.endpoint}`);
      throw new Error('apply must not be called');
    },
    lookupApply: async (target) => {
      runCalls.push(`lookup ${target.endpoint}`);
      throw new Error('lookupApply must not be called');
    },
    revert: async () => {
      throw new Error('not in this file');
    },
    health: async () => ({ status: 'ok' }),
    storeConnectedAccount: async () => {},
    deleteConnectedAccount: async () => {},
    credentialPresence: async (target) => {
      presenceCalls.push(target.endpoint);
      return { credentialMode: 'connected_account', present: connected.has(target.endpoint) };
    },
  };
  return { client, described, failing, describeCalls, presenceCalls, runCalls, connected };
}

function platformCaller(user: UserRow): ResolvedCaller {
  return {
    channel: 'platform',
    user: {
      id: user.id,
      login: user.login,
      displayName: user.displayName,
      platformRole: 'admin',
      mustChangePassword: false,
      consoleSessionId: randomUUID(),
    },
  };
}

/** A `MinimalPool` over one client inside the caller's transaction: the invariant checker reads
 *  what the transaction wrote, and its `release` leaves the client to the caller. */
function poolOver(client: PoolClient) {
  const held = new Proxy(client, {
    get: (target, property) =>
      property === 'release' ? () => {} : Reflect.get(target, property, target),
  });
  return { connect: async () => held };
}

describe.runIf(DATABASE_URL !== undefined)(
  'legacy 701 — moving a self-connected gate to a new address (integration, real Postgres)',
  () => {
    let pool: Pool;
    let admin: UserRow;
    let workspaceId: string;
    let ownerId: string;
    let memberId: string;
    let gates: ReturnType<typeof createFakeGates>;
    const secrets = createGateConnectionSecrets(GATE_TOKEN);
    const newSecret = () => secrets.mint(workspaceId).secret;
    const saltOf = (secret: string) => secrets.saltOf(workspaceId, secret);
    const address = (label: string) =>
      `http://gac-${label}-${randomUUID().slice(0, 8)}.invalid:8080/gate`;

    const asOwner = <T>(name: string, params: Record<string, unknown>) =>
      dispatchCapability(
        { pool },
        humanCaller(workspaceId, ownerId, 'owner'),
        name,
        params,
      ) as Promise<T>;
    const asMember = <T>(name: string, params: Record<string, unknown>) =>
      dispatchCapability(
        { pool },
        humanCaller(workspaceId, memberId, 'member'),
        name,
        params,
      ) as Promise<T>;
    const asAdmin = <T>(name: string, params: Record<string, unknown>) =>
      dispatchCapability({ pool }, platformCaller(admin), name, params) as Promise<T>;

    /** The wire code a refused call maps to. */
    async function refusedWith(call: Promise<unknown>): Promise<{ status: number; code: string }> {
      const error = await call.then(
        () => {
          throw new Error('the call was expected to be refused');
        },
        (err: unknown) => err,
      );
      const mapped = mapCapabilityError(error);
      return { status: mapped.status, code: mapped.code };
    }

    /** The whole mapped refusal of a call: status, code, message and details. */
    async function refusal(call: Promise<unknown>) {
      const error = await call.then(
        () => {
          throw new Error('the call was expected to be refused');
        },
        (err: unknown) => err,
      );
      return mapCapabilityError(error);
    }

    /** A gate the workspace connects itself, its one Operation published. */
    async function connectedGate(): Promise<{ gatekeeperId: string; endpoint: string }> {
      const endpoint = address('old');
      const { gatekeeperId } = await asOwner<{ gatekeeperId: string }>('create_connection', {
        kind: 'http',
        target: 'gac-system',
        endpoint,
        connectionSecret: newSecret(),
      });
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        publishOperation(client, workspaceId, { gatekeeperId, name: OP.name }),
      );
      return { gatekeeperId, endpoint };
    }

    async function previewAndPropose(gatekeeperId: string, endpoint = address('new')) {
      const connectionSecret = newSecret();
      const preview = await asOwner<GateAddressChangePreviewWire>('preview_gate_address_change', {
        gatekeeperId,
        endpoint,
        connectionSecret,
      });
      const proposal = await asOwner<GateAddressChangeWire>('propose_gate_address_change', {
        gatekeeperId,
        endpoint,
        connectionSecret,
        previewDigest: preview.previewDigest,
      });
      return { preview, proposal, endpoint, connectionSecret };
    }

    async function listed(id: string): Promise<PlatformGateAddressChangeWire> {
      const { items } = await asAdmin<{ items: PlatformGateAddressChangeWire[] }>(
        'list_gate_address_changes',
        { workspaceId },
      );
      const item = items.find((entry) => entry.id === id);
      if (item === undefined) throw new Error(`proposal ${id} is not listed`);
      return item;
    }

    async function selfConnectionRow(gatekeeperId: string) {
      const result = await pool.query<{ endpoint: string; endpoint_key: string | null }>(
        `select endpoint, endpoint_key from workspace_self_connections
          where workspace_id = $1 and gatekeeper_object_id = $2`,
        [workspaceId, gatekeeperId],
      );
      return result.rows[0];
    }

    async function gatekeeperRecord(gatekeeperId: string) {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        getGatekeeper(client, workspaceId, gatekeeperId),
      );
    }

    /** Moves a proposal's expiry into the past (the table's guard refuses it; the superuser login
     *  role with triggers off does not). */
    async function lapse(id: string): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('set local session_replication_role = replica');
        await client.query(
          `update gate_address_changes
              set created_at = now() - interval '2 days', expires_at = now() - interval '1 day'
            where workspace_id = $1 and id = $2`,
          [workspaceId, id],
        );
        await client.query('commit');
      } finally {
        client.release();
      }
    }

    /** Stores `endpoint` as a proposal's new address as a row written before the address check
     *  would have (`credentials_in_connection_params`) — triggers off, as `lapse` moves expiry. */
    async function storeToEndpoint(id: string, endpoint: string): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('set local session_replication_role = replica');
        await client.query(
          'update gate_address_changes set to_endpoint = $3 where workspace_id = $1 and id = $2',
          [workspaceId, id, endpoint],
        );
        await client.query('commit');
      } finally {
        client.release();
      }
    }

    /** A request of `gatekeeperId` still in flight, made before requests were bound to an address
     *  (governance 0044 left it NULL). */
    async function unboundRequest(gatekeeperId: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) =>
          client.query(
            `insert into action_requests
               (workspace_id, id, status, gatekeeper_id, action_kind, resource_scope, blast_radius,
                policy_decision, await_decision, on_behalf_of, actor_runtime, requested_at)
             values ($1, $2, 'auto_approved', $3::uuid, $4, $3::text, 'low', 'allow', false, $5,
                     'human', now())`,
            [workspaceId, id, gatekeeperId, OP.name, ownerId],
          ),
        { skipRoleSwitch: true },
      );
      return id;
    }

    /** A request of OP on `gatekeeperId` through `requestAction`, in `client`'s transaction. */
    async function requestOn(client: PoolClient, gatekeeperId: string) {
      const published = await getPublishedOperation(client, workspaceId, gatekeeperId, OP.name);
      if (!published) throw new Error('OP is not published');
      return requestAction(client, workspaceId, {
        gatekeeperId,
        actionKind: OP.name,
        resourceScope: gatekeeperId,
        blastRadius: 'medium',
        operationAutoApprovable: true,
        awaitDecision: false,
        onBehalfOf: ownerId,
        actorRuntime: 'pi',
        requesterScope: {
          capabilities: ['request_action'],
          resources: { gatekeeper: [gatekeeperId] },
        },
        idempotencyKey: randomUUID(),
        operationDigest: operationRecordDigest(published),
      });
    }

    /** Runs `sql` (`$1` the workspace, `$2` the Gatekeeper) on the login role with triggers off —
     *  a state only an older kernel or a write around the kernel leaves. */
    async function writeAround(sql: string, gatekeeperId: string, ...more: unknown[]) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('set local session_replication_role = replica');
        await client.query(sql, [workspaceId, gatekeeperId, ...more]);
        await client.query('commit');
      } finally {
        client.release();
      }
    }

    /** Resolves once a transaction waits for the advisory lock on `key`. */
    async function someoneWaitsFor(key: string): Promise<void> {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const waiting = await pool.query<{ n: number }>(
          `select count(*)::int as n from pg_locks
            where locktype = 'advisory' and not granted
              and objid::bigint = (hashtext($1)::bigint & 4294967295)`,
          [key],
        );
        if ((waiting.rows[0]?.n ?? 0) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`nothing waited for ${key}`);
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      admin = await createPlatformAdmin(pool, {
        login: `gac-admin-${randomUUID().slice(0, 8)}`,
        displayName: 'Address Change Admin',
        password: 'gate-address-change-password-1',
      });
      const workspace = await newWorkspace(pool, 'gate-address-change', ['owner', 'member']);
      workspaceId = workspace.workspaceId;
      ownerId = workspace.principals.get('owner') as string;
      memberId = workspace.principals.get('member') as string;
    });

    afterAll(async () => {
      setCredentialPresenceDeps({});
      setGatekeeperReadHandlerDeps({});
      await pool?.end();
    });

    beforeEach(() => {
      gates = createFakeGates();
      setConnectionHandlerDeps({
        gatekeeperClient: gates.client,
        connectionSecrets: secrets,
        outboundTargetGuard: async () => {},
      });
      setGatekeeperReadHandlerDeps({ gatekeeperClient: gates.client });
      setCredentialPresenceDeps({ gatekeeperClient: gates.client });
    });

    it('preview, propose, approve: the Gatekeeper and its self connection move together to the new host, with the new secret', async () => {
      const { gatekeeperId, endpoint: oldEndpoint } = await connectedGate();
      gates.connected.add(oldEndpoint);
      // The owner's account, as the old host answers: remembered for a while.
      const askPresence = () =>
        withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          connectedAccountPresence(client, workspaceId, ownerId, [gatekeeperId]),
        );
      expect((await askPresence()).get(gatekeeperId)).toBe('connected');

      const newEndpoint = address('new');
      const connectionSecret = newSecret();
      const newSalt = saltOf(connectionSecret);
      gates.describeCalls.length = 0;
      const preview = await asOwner<GateAddressChangePreviewWire>('preview_gate_address_change', {
        gatekeeperId,
        endpoint: newEndpoint,
        connectionSecret,
      });
      expect(preview).toMatchObject({
        gatekeeperId,
        fromEndpoint: oldEndpoint,
        toEndpoint: newEndpoint,
        manifest: { matches: true, differing: [], notDescribed: [] },
        impact: {
          publishedOperationCount: 1,
          grantCount: 0,
          autoApprovedOperations: [],
          workerDefinitionCount: 0,
          inFlightActionRequestCount: 0,
        },
      });
      // The new host was asked with the new secret, and nothing else was.
      expect(gates.describeCalls).toEqual([
        { endpoint: newEndpoint, credential: { kind: 'connection', workspaceId, salt: newSalt } },
      ]);

      const proposal = await asOwner<GateAddressChangeWire>('propose_gate_address_change', {
        gatekeeperId,
        endpoint: newEndpoint,
        connectionSecret,
        previewDigest: preview.previewDigest,
      });
      expect(proposal).toMatchObject({
        gatekeeperId,
        fromEndpoint: oldEndpoint,
        toEndpoint: newEndpoint,
        status: 'proposed',
        proposedBy: ownerId,
        decidedAt: null,
      });

      // The owner sees the address and the open proposal; a member sees neither.
      const forOwner = await asOwner<GatekeeperDetailWire>('get_gatekeeper', { gatekeeperId });
      expect(forOwner.endpoint).toBe(oldEndpoint);
      expect(forOwner.pendingAddressChange?.id).toBe(proposal.id);
      const forMember = await asMember<GatekeeperDetailWire>('get_gatekeeper', { gatekeeperId });
      expect(forMember.endpoint).toBeUndefined();
      expect(forMember.pendingAddressChange).toBeUndefined();

      // The platform sees scheme, host and port only.
      const read = await listed(proposal.id);
      expect(read).toMatchObject({
        workspaceId,
        gatekeeperId,
        connector: 'http',
        fromEndpoint: gateAddressOrigin(oldEndpoint),
        toEndpoint: gateAddressOrigin(newEndpoint),
        status: 'proposed',
        suspended: false,
      });
      expect(read.toEndpoint).not.toContain('/gate');

      const applied = await asAdmin<PlatformGateAddressChangeWire>('approve_gate_address_change', {
        workspaceId,
        id: proposal.id,
        previewDigest: read.previewDigest,
      });
      expect(applied).toMatchObject({ status: 'applied', decidedByLogin: admin.login });

      // I-A1: the Object and the self connection are both at the new address; calls go there with
      // the new secret.
      const record = await gatekeeperRecord(gatekeeperId);
      expect(record?.endpoint).toBe(newEndpoint);
      expect(record?.connectionSecretSalt).toBe(newSalt);
      expect(await selfConnectionRow(gatekeeperId)).toEqual({
        endpoint: newEndpoint,
        endpoint_key: normalizeGateEndpoint(newEndpoint),
      });
      if (!record) throw new Error('the Gatekeeper is gone');
      const target = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        resolveGateTarget(client, workspaceId, record),
      );
      expect(target).toEqual({
        endpoint: newEndpoint,
        endpointKey: normalizeGateEndpoint(newEndpoint),
        credential: { kind: 'connection', workspaceId, salt: newSalt },
      });
      const checks = await runInvariantChecks(pool);
      expect(checks.find((check) => check.invariant === 'I-A1')?.sample ?? []).not.toContain(
        `${workspaceId}:${gatekeeperId} (change ${proposal.id})`,
      );

      // The decision's platform audit row, and the event every other kernel process forgets by.
      const audit = await pool.query<{
        workspace_id: string | null;
        actor_user_id: string | null;
        payload: Record<string, unknown>;
      }>(
        `select workspace_id, actor_user_id, payload from audit_records
          where action = 'gatekeeper.address_changed' and resource_id = $1`,
        [gatekeeperId],
      );
      expect(audit.rows).toEqual([
        {
          workspace_id: null,
          actor_user_id: admin.id,
          payload: {
            workspaceId,
            gateAddressChangeId: proposal.id,
            fromHost: gateAddressOrigin(oldEndpoint),
            toHost: gateAddressOrigin(newEndpoint),
            accountCredentialsLeftOnOldHost: true,
          },
        },
      ]);
      const events = await pool.query<{ payload: Record<string, unknown> }>(
        `select payload from outbox
          where event_type = 'GatekeeperAddressChanged' and payload ->> 'gatekeeperId' = $1`,
        [gatekeeperId],
      );
      expect(events.rows.map((row) => row.payload)).toEqual([
        expect.objectContaining({ workspaceId, gatekeeperId, gateAddressChangeId: proposal.id }),
      ]);

      // The old host's answer is forgotten: the next read asks the new one.
      gates.presenceCalls.length = 0;
      expect((await askPresence()).get(gatekeeperId)).toBe('not_connected');
      expect(gates.presenceCalls).toEqual([newEndpoint]);

      // The secret itself is stored nowhere: not on the proposal, in no audit row, in no event.
      const stored = await pool.query<{ n: string }>(
        `select (select count(*) from gate_address_changes c where row_to_json(c)::text like $1)
              + (select count(*) from audit_records a where a.payload::text like $1)
              + (select count(*) from outbox o where o.payload::text like $1) as n`,
        [`%${connectionSecret}%`],
      );
      expect(stored.rows[0]?.n).toBe('0');

      // Decided: the same approval again is refused, nothing moves.
      expect(
        await refusedWith(
          asAdmin('approve_gate_address_change', {
            workspaceId,
            id: proposal.id,
            previewDigest: read.previewDigest,
          }),
        ),
      ).toEqual({ status: 409, code: 'gate_address_change_decided' });
    });

    it('refuses before contacting anything: the same address, a catalog gate, a secret spoken for, another connection’s address, an address carrying credentials', async () => {
      const { gatekeeperId, endpoint } = await connectedGate();
      const other = await connectedGate();
      const catalogGate = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const activity = await startActivity(client, workspaceId, {
            kind: 'test.connection',
            principalId: ownerId,
          });
          const registered = await registerGatekeeper(client, workspaceId, {
            name: 'gac-catalog-gate',
            transportKind: 'http',
            target: 'gac-catalog',
            endpoint: address('catalog'),
            activityId: activity.id,
            registeredBy: { id: ownerId, kind: 'human' },
          });
          return registered.gatekeeperId;
        },
      );
      // The gate's own current secret, and the other gate's.
      const rotate = async (id: string) =>
        (
          await asOwner<{ connectionSecret: string }>('rotate_connection_secret', {
            gatekeeperId: id,
          })
        ).connectionSecret;
      const ownSecret = await rotate(gatekeeperId);
      const othersSecret = await rotate(other.gatekeeperId);
      const otherWorkspace = await newWorkspace(pool, 'gate-address-change-other');
      const foreignSecret = secrets.mint(otherWorkspace.workspaceId).secret;

      gates.describeCalls.length = 0;
      const preview = (params: Record<string, unknown>) =>
        refusedWith(
          asOwner('preview_gate_address_change', {
            gatekeeperId,
            endpoint: address('new'),
            connectionSecret: newSecret(),
            ...params,
          }),
        );
      expect(await preview({ endpoint })).toEqual({ status: 400, code: 'gate_address_unchanged' });
      expect(await preview({ gatekeeperId: catalogGate })).toEqual({
        status: 409,
        code: 'gatekeeper_not_self_connected',
      });
      expect(await preview({ connectionSecret: ownSecret })).toEqual({
        status: 409,
        code: 'connection_secret_in_use',
      });
      expect(await preview({ connectionSecret: othersSecret })).toEqual({
        status: 409,
        code: 'connection_secret_in_use',
      });
      expect((await preview({ connectionSecret: foreignSecret })).status).toBe(400);
      expect(await preview({ endpoint: other.endpoint })).toMatchObject({
        status: 409,
        code: 'endpoint_already_connected',
      });
      expect(
        await preview({ endpoint: 'http://someone:pass@gac-creds.invalid:8080/gate' }),
      ).toMatchObject({ status: 400, code: 'credentials_in_connection_params' });
      expect(gates.describeCalls).toEqual([]);
    });

    it('propose: the new host must describe what is published, the preview must be the one seen, one open proposal per gate, one proposal per secret', async () => {
      const { gatekeeperId } = await connectedGate();

      // The new host runs something else: shown in the preview, refused as a proposal.
      const elsewhere = address('different');
      gates.described.set(elsewhere, [{ ...OP, blast_radius: 'high' }]);
      const differentSecret = newSecret();
      const different = await asOwner<GateAddressChangePreviewWire>('preview_gate_address_change', {
        gatekeeperId,
        endpoint: elsewhere,
        connectionSecret: differentSecret,
      });
      expect(different.manifest).toMatchObject({ matches: false, differing: [OP.name] });
      expect(
        await refusedWith(
          asOwner('propose_gate_address_change', {
            gatekeeperId,
            endpoint: elsewhere,
            connectionSecret: differentSecret,
            previewDigest: different.previewDigest,
          }),
        ),
      ).toEqual({ status: 409, code: 'gate_address_manifest_mismatch' });
      const empty = address('empty');
      gates.described.set(empty, []);
      const emptySecret = newSecret();
      const notDescribed = await asOwner<GateAddressChangePreviewWire>(
        'preview_gate_address_change',
        { gatekeeperId, endpoint: empty, connectionSecret: emptySecret },
      );
      expect(notDescribed.manifest).toMatchObject({ matches: false, notDescribed: [OP.name] });

      // A preview digest that is not this one.
      const endpoint = address('new');
      const connectionSecret = newSecret();
      expect(
        await refusedWith(
          asOwner('propose_gate_address_change', {
            gatekeeperId,
            endpoint,
            connectionSecret,
            previewDigest: 'not-the-preview',
          }),
        ),
      ).toEqual({ status: 409, code: 'gate_address_preview_changed' });

      // One open proposal per gate (I-A2).
      const first = await previewAndPropose(gatekeeperId);
      const second = address('second');
      const secondSecret = newSecret();
      const secondPreview = await asOwner<GateAddressChangePreviewWire>(
        'preview_gate_address_change',
        { gatekeeperId, endpoint: second, connectionSecret: secondSecret },
      );
      expect(
        await refusedWith(
          asOwner('propose_gate_address_change', {
            gatekeeperId,
            endpoint: second,
            connectionSecret: secondSecret,
            previewDigest: secondPreview.previewDigest,
          }),
        ),
      ).toEqual({ status: 409, code: 'gate_address_change_pending' });

      // Withdrawn by the owner; withdrawn again, refused.
      const withdrawn = await asOwner<GateAddressChangeWire>('withdraw_gate_address_change', {
        id: first.proposal.id,
      });
      expect(withdrawn).toMatchObject({ status: 'withdrawn' });
      expect(
        await refusedWith(asOwner('withdraw_gate_address_change', { id: first.proposal.id })),
      ).toEqual({ status: 409, code: 'gate_address_change_decided' });

      // The withdrawn proposal's secret is used up; a fresh one proposes again.
      expect(
        await refusedWith(
          asOwner('preview_gate_address_change', {
            gatekeeperId,
            endpoint: first.endpoint,
            connectionSecret: first.connectionSecret,
          }),
        ),
      ).toEqual({ status: 409, code: 'connection_secret_in_use' });
      const again = await previewAndPropose(gatekeeperId, first.endpoint);
      expect(again.proposal.status).toBe('proposed');
      // Nothing moved meanwhile.
      expect((await gatekeeperRecord(gatekeeperId))?.endpoint).not.toBe(first.endpoint);
    });

    it('approve: refused while a request made before address binding is in flight, and when the new host changed since; reject records the reason', async () => {
      const { gatekeeperId, endpoint } = await connectedGate();
      const { proposal, endpoint: newEndpoint } = await previewAndPropose(gatekeeperId);
      const read = await listed(proposal.id);
      const approve = () =>
        asAdmin('approve_gate_address_change', {
          workspaceId,
          id: proposal.id,
          previewDigest: read.previewDigest,
        });

      expect(
        await refusedWith(
          asAdmin('approve_gate_address_change', {
            workspaceId,
            id: proposal.id,
            previewDigest: 'not-what-was-read',
          }),
        ),
      ).toEqual({ status: 409, code: 'gate_address_preview_changed' });

      gates.described.set(newEndpoint, [{ ...OP, mode: 'execute' }]);
      expect(await refusedWith(approve())).toEqual({
        status: 409,
        code: 'gate_address_manifest_mismatch',
      });
      gates.described.delete(newEndpoint);

      await unboundRequest(gatekeeperId);
      expect(await refusedWith(approve())).toEqual({
        status: 409,
        code: 'gate_address_change_blocked',
      });
      expect((await gatekeeperRecord(gatekeeperId))?.endpoint).toBe(endpoint);
      expect((await listed(proposal.id)).status).toBe('proposed');

      const rejected = await asAdmin<PlatformGateAddressChangeWire>('reject_gate_address_change', {
        workspaceId,
        id: proposal.id,
        reason: 'Not this host.',
      });
      expect(rejected).toMatchObject({
        status: 'rejected',
        rejectionReason: 'Not this host.',
        decidedByLogin: admin.login,
      });
      expect(
        await refusedWith(asAdmin('reject_gate_address_change', { workspaceId, id: proposal.id })),
      ).toEqual({ status: 409, code: 'gate_address_change_decided' });
      expect((await gatekeeperRecord(gatekeeperId))?.endpoint).toBe(endpoint);
    });

    it('a proposal past its expiry is shown expired, recorded so by the next decision, and gives way to a new one', async () => {
      const { gatekeeperId } = await connectedGate();
      const { proposal } = await previewAndPropose(gatekeeperId);
      const previewDigest = (await listed(proposal.id)).previewDigest;
      await lapse(proposal.id);

      expect((await listed(proposal.id)).status).toBe('expired');
      const forOwner = await asOwner<GatekeeperDetailWire>('get_gatekeeper', { gatekeeperId });
      expect(forOwner.pendingAddressChange).toBeUndefined();
      expect(
        await refusedWith(
          asAdmin('approve_gate_address_change', { workspaceId, id: proposal.id, previewDigest }),
        ),
      ).toEqual({ status: 409, code: 'gate_address_change_expired' });
      // Recorded as expired by that refused approval, in its own committed transaction.
      expect(await listed(proposal.id)).toMatchObject({
        status: 'expired',
        decidedAt: expect.any(String),
      });

      // A new proposal; once it lapses too, withdrawing it records it expired.
      const next = await previewAndPropose(gatekeeperId);
      await lapse(next.proposal.id);
      const withdrawn = await asOwner<GateAddressChangeWire>('withdraw_gate_address_change', {
        id: next.proposal.id,
      });
      expect(withdrawn.status).toBe('expired');
    });

    it('legacy 715: the owner reads how the gate’s latest proposal ended — expired, withdrawn, rejected with the reason, applied with credentials left at the old address — and a member none of it', async () => {
      const { gatekeeperId, endpoint: oldEndpoint } = await connectedGate();
      const detail = () => asOwner<GatekeeperDetailWire>('get_gatekeeper', { gatekeeperId });
      expect((await detail()).lastAddressChangeOutcome).toBeUndefined();

      // Past its expiry and recorded by nothing yet: expired, ended at its expiry.
      const first = await previewAndPropose(gatekeeperId);
      await lapse(first.proposal.id);
      const lapsed = await listed(first.proposal.id);
      expect((await detail()).lastAddressChangeOutcome).toEqual({
        id: first.proposal.id,
        gatekeeperId,
        fromEndpoint: oldEndpoint,
        toEndpoint: first.endpoint,
        status: 'expired',
        createdAt: lapsed.createdAt,
        endedAt: lapsed.expiresAt,
        rejectionReason: null,
        accountCredentialsLeftOnOldHost: false,
      });

      // The next proposal records it expired (stamping decided_at now): it still ended at its
      // expiry, and it is the outcome beside the new open proposal.
      const second = await previewAndPropose(gatekeeperId);
      const recorded = await listed(first.proposal.id);
      expect(recorded.status).toBe('expired');
      expect(recorded.decidedAt).not.toBe(lapsed.expiresAt);
      const beside = await detail();
      expect(beside.pendingAddressChange?.id).toBe(second.proposal.id);
      expect(beside.lastAddressChangeOutcome).toMatchObject({
        id: first.proposal.id,
        status: 'expired',
        endedAt: lapsed.expiresAt,
      });

      // Withdrawn by the owner.
      const withdrawn = await asOwner<GateAddressChangeWire>('withdraw_gate_address_change', {
        id: second.proposal.id,
      });
      expect((await detail()).lastAddressChangeOutcome).toEqual({
        id: second.proposal.id,
        gatekeeperId,
        fromEndpoint: oldEndpoint,
        toEndpoint: second.endpoint,
        status: 'withdrawn',
        createdAt: second.proposal.createdAt,
        endedAt: withdrawn.decidedAt,
        rejectionReason: null,
        accountCredentialsLeftOnOldHost: false,
      });

      // Rejected: the reason as the administrator wrote it, a secret-looking value in it masked as
      // all free text is; who rejected it is not shown.
      const third = await previewAndPropose(gatekeeperId);
      const rejected = await asAdmin<PlatformGateAddressChangeWire>('reject_gate_address_change', {
        workspaceId,
        id: third.proposal.id,
        reason: `Use the TLS host. PGPASSWORD=${FAKE_SECRET} was in the note.`,
      });
      const afterRejection = await detail();
      expect(afterRejection.pendingAddressChange).toBeUndefined();
      expect(afterRejection.lastAddressChangeOutcome).toEqual({
        id: third.proposal.id,
        gatekeeperId,
        fromEndpoint: oldEndpoint,
        toEndpoint: third.endpoint,
        status: 'rejected',
        createdAt: third.proposal.createdAt,
        endedAt: rejected.decidedAt,
        rejectionReason: `Use the TLS host. PGPASSWORD=${REDACTED} was in the note.`,
        accountCredentialsLeftOnOldHost: false,
      });
      expect(JSON.stringify(afterRejection)).not.toContain(admin.login);

      // Applied: the gate is at the new address, and account credentials stay at the old one for
      // the owner to clear.
      const fourth = await previewAndPropose(gatekeeperId);
      const applied = await asAdmin<PlatformGateAddressChangeWire>('approve_gate_address_change', {
        workspaceId,
        id: fourth.proposal.id,
        previewDigest: (await listed(fourth.proposal.id)).previewDigest,
      });
      const afterApproval = await detail();
      expect(afterApproval.endpoint).toBe(fourth.endpoint);
      expect(afterApproval.pendingAddressChange).toBeUndefined();
      expect(afterApproval.lastAddressChangeOutcome).toEqual({
        id: fourth.proposal.id,
        gatekeeperId,
        fromEndpoint: oldEndpoint,
        toEndpoint: fourth.endpoint,
        status: 'applied',
        createdAt: fourth.proposal.createdAt,
        endedAt: applied.decidedAt,
        rejectionReason: null,
        accountCredentialsLeftOnOldHost: true,
      });

      // A member reads none of it.
      const forMember = await asMember<GatekeeperDetailWire>('get_gatekeeper', { gatekeeperId });
      expect(forMember.lastAddressChangeOutcome).toBeUndefined();
    });

    it('legacy 718: a gate never shows another gate’s outcome, and a new address stored with a credential is shown without it, open or ended', async () => {
      const a = await connectedGate();
      const b = await connectedGate();
      const detail = (gatekeeperId: string) =>
        asOwner<GatekeeperDetailWire>('get_gatekeeper', { gatekeeperId });

      // A's proposal ends; B, which never had one, shows none.
      const ofA = await previewAndPropose(a.gatekeeperId);
      await asOwner('withdraw_gate_address_change', { id: ofA.proposal.id });
      expect((await detail(a.gatekeeperId)).lastAddressChangeOutcome?.id).toBe(ofA.proposal.id);
      expect((await detail(b.gatekeeperId)).lastAddressChangeOutcome).toBeUndefined();

      // B's ends later: each gate shows its own, the later one never on A.
      const ofB = await previewAndPropose(b.gatekeeperId);
      await asAdmin('reject_gate_address_change', {
        workspaceId,
        id: ofB.proposal.id,
        reason: 'Not this host.',
      });
      expect((await detail(b.gatekeeperId)).lastAddressChangeOutcome).toMatchObject({
        id: ofB.proposal.id,
        gatekeeperId: b.gatekeeperId,
        status: 'rejected',
      });
      expect((await detail(a.gatekeeperId)).lastAddressChangeOutcome).toMatchObject({
        id: ofA.proposal.id,
        gatekeeperId: a.gatekeeperId,
        status: 'withdrawn',
      });

      // A new address stored with a user and password (as a row from before the check would
      // carry): the owner reads it without them, while the proposal is open and once it ended.
      const third = await previewAndPropose(a.gatekeeperId);
      await storeToEndpoint(third.proposal.id, 'http://someone:pass@gac-creds.invalid:8080/gate');
      const shown = 'http://gac-creds.invalid:8080/gate';
      expect((await detail(a.gatekeeperId)).pendingAddressChange?.toEndpoint).toBe(shown);
      await asOwner('withdraw_gate_address_change', { id: third.proposal.id });
      const ended = await detail(a.gatekeeperId);
      expect(ended.lastAddressChangeOutcome).toMatchObject({
        id: third.proposal.id,
        toEndpoint: shown,
      });
      expect(JSON.stringify(ended)).not.toContain('pass@');
    });

    it('I-A3: a request made at the old address is refused at the new one, and the reaper asks no host about it', async () => {
      const { gatekeeperId, endpoint } = await connectedGate();
      const requestId = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const published = await getPublishedOperation(client, workspaceId, gatekeeperId, OP.name);
          if (!published) throw new Error('OP is not published');
          const request = await requestAction(client, workspaceId, {
            gatekeeperId,
            actionKind: OP.name,
            resourceScope: gatekeeperId,
            blastRadius: 'medium',
            operationAutoApprovable: true,
            awaitDecision: false,
            onBehalfOf: ownerId,
            actorRuntime: 'pi',
            requesterScope: {
              capabilities: ['request_action'],
              resources: { gatekeeper: [gatekeeperId] },
            },
            idempotencyKey: randomUUID(),
            operationDigest: operationRecordDigest(published),
          });
          return request.id;
        },
      );
      const row = () =>
        withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          getActionRequest(client, workspaceId, requestId),
        );
      // Bound to the address it was made at; a bound request does not block the change.
      expect((await row())?.gateEndpointKey).toBe(normalizeGateEndpoint(endpoint));

      const { proposal, preview } = await previewAndPropose(gatekeeperId);
      expect(preview.impact.inFlightActionRequestCount).toBe(1);
      await asAdmin('approve_gate_address_change', {
        workspaceId,
        id: proposal.id,
        previewDigest: (await listed(proposal.id)).previewDigest,
      });

      const executor = createGatekeeperActionExecutor({
        gatekeeperClient: gates.client,
        withTransaction: createAdminWithTransaction(pool),
      });
      const request = await row();
      if (!request) throw new Error('the request is gone');
      expect(await executor.execute(request)).toMatchObject({
        ok: false,
        failureKind: 'refused',
        reason: expect.stringMatching(/^gate_address_changed: /),
      });
      expect(await executor.replay(request)).toMatchObject({
        ok: false,
        failureKind: 'outcome_unknown',
      });
      expect(gates.runCalls).toEqual([]);

      // The binding never changes once written.
      await expect(
        pool.query(
          `update action_requests set gate_endpoint_key = 'elsewhere'
            where workspace_id = $1 and id = $2`,
          [workspaceId, requestId],
        ),
      ).rejects.toThrow(/I-A3/);
    });

    it('I-A3 under concurrency: a self connection without an address key binds new requests to the gate’s own address, and a new request and an approval wait for each other (#1156 review P2)', async () => {
      const { gatekeeperId, endpoint } = await connectedGate();
      // As core 0045's backfill left a self connection made before addresses were keyed.
      await writeAround(
        `update workspace_self_connections set endpoint_key = null
          where workspace_id = $1 and gatekeeper_object_id = $2`,
        gatekeeperId,
      );
      expect((await selfConnectionRow(gatekeeperId))?.endpoint_key).toBeNull();
      const lockKey = `self_connection:${workspaceId}:${gatekeeperId}`;
      const asWorkspace = <T>(fn: (client: PoolClient) => Promise<T>) =>
        withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);

      // Bound to the Gatekeeper's own address, so it does not block a change.
      const before = await asWorkspace((client) => requestOn(client, gatekeeperId));
      expect(before.gateEndpointKey).toBe(normalizeGateEndpoint(endpoint));

      // 1. A request in its transaction: the approval waits for it, finds it bound, moves the gate.
      const { proposal, endpoint: newEndpoint } = await previewAndPropose(gatekeeperId);
      const previewDigest = (await listed(proposal.id)).previewDigest;
      let commitRequest = () => {};
      const committed = new Promise<void>((resolve) => {
        commitRequest = resolve;
      });
      let markRequested = () => {};
      const requested = new Promise<void>((resolve) => {
        markRequested = resolve;
      });
      const inFlight = asWorkspace(async (client) => {
        const row = await requestOn(client, gatekeeperId);
        markRequested();
        await committed;
        return row;
      });
      await requested;
      let approved = false;
      const approval = asAdmin('approve_gate_address_change', {
        workspaceId,
        id: proposal.id,
        previewDigest,
      }).then((result) => {
        approved = true;
        return result;
      });
      await someoneWaitsFor(lockKey);
      expect(approved).toBe(false);
      commitRequest();
      const during = await inFlight;
      expect(await approval).toMatchObject({ status: 'applied' });
      expect(during.gateEndpointKey).toBe(normalizeGateEndpoint(endpoint));
      expect((await gatekeeperRecord(gatekeeperId))?.endpoint).toBe(newEndpoint);

      // 2. A change in its transaction (the lock an approval holds from its count to its commit): a
      // new request waits for it and is bound to where it left the gate.
      const heldKey = normalizeGateEndpoint(address('held'));
      const mover = await pool.connect();
      try {
        await mover.query('begin');
        await mover.query('set local session_replication_role = replica');
        await lockSelfConnectionState(mover, workspaceId, gatekeeperId, 'change');
        await mover.query(
          `update workspace_self_connections set endpoint_key = $3
            where workspace_id = $1 and gatekeeper_object_id = $2`,
          [workspaceId, gatekeeperId, heldKey],
        );
        let bound = false;
        const waiting = asWorkspace((client) => requestOn(client, gatekeeperId)).then((row) => {
          bound = true;
          return row;
        });
        await someoneWaitsFor(lockKey);
        expect(bound).toBe(false);
        await mover.query('commit');
        expect((await waiting).gateEndpointKey).toBe(heldKey);
      } finally {
        mover.release();
      }
      await writeAround(
        `update workspace_self_connections set endpoint_key = $3
          where workspace_id = $1 and gatekeeper_object_id = $2`,
        gatekeeperId,
        normalizeGateEndpoint(newEndpoint),
      );
    });

    it('a secret that served a proposal connects no gate afterwards, whatever became of the proposal (#1156 review P2-1)', async () => {
      const { gatekeeperId } = await connectedGate();
      const { proposal, connectionSecret } = await previewAndPropose(gatekeeperId);
      const described = gates.describeCalls.length;
      const connectWith = () =>
        asOwner('create_connection', {
          kind: 'http',
          target: 'gac-system',
          endpoint: address('elsewhere'),
          connectionSecret,
        });
      expect(await refusedWith(connectWith())).toEqual({
        status: 409,
        code: 'connection_secret_in_use',
      });
      await asAdmin('reject_gate_address_change', { workspaceId, id: proposal.id });
      expect(await refusedWith(connectWith())).toEqual({
        status: 409,
        code: 'connection_secret_in_use',
      });
      // Refused before the kernel sent the secret anywhere.
      expect(gates.describeCalls.length).toBe(described);
    });

    it('the outbound-target predicate refuses the new address before anything is contacted, at preview and again at approval (#1156 review P2-2)', async () => {
      const refused = new Set<string>();
      const guarded: string[] = [];
      setConnectionHandlerDeps({
        gatekeeperClient: gates.client,
        connectionSecrets: secrets,
        outboundTargetGuard: async (url, subject) => {
          guarded.push(url);
          if (refused.has(url)) {
            throw new OutboundTargetRefusedError(
              url,
              'platform-subnet',
              new URL(url).host,
              subject,
            );
          }
        },
      });
      const { gatekeeperId, endpoint } = await connectedGate();

      const refusedEndpoint = address('refused');
      refused.add(refusedEndpoint);
      const beforePreview = gates.describeCalls.length;
      expect(
        await refusedWith(
          asOwner('preview_gate_address_change', {
            gatekeeperId,
            endpoint: refusedEndpoint,
            connectionSecret: newSecret(),
          }),
        ),
      ).toEqual({ status: 400, code: 'connection_target_refused' });
      expect(guarded).toContain(refusedEndpoint);
      expect(gates.describeCalls.length).toBe(beforePreview);

      // The platform's networks changed after the proposal: the approval asks the predicate again.
      const { proposal, endpoint: newEndpoint } = await previewAndPropose(gatekeeperId);
      refused.add(newEndpoint);
      const beforeApproval = gates.describeCalls.length;
      expect(
        await refusedWith(
          asAdmin('approve_gate_address_change', {
            workspaceId,
            id: proposal.id,
            previewDigest: (await listed(proposal.id)).previewDigest,
          }),
        ),
      ).toEqual({ status: 400, code: 'connection_target_refused' });
      expect(gates.describeCalls.length).toBe(beforeApproval);
      expect((await gatekeeperRecord(gatekeeperId))?.endpoint).toBe(endpoint);
      expect((await listed(proposal.id)).status).toBe('proposed');
    });

    it('approve checks the new address again under its locks, and refuses in the platform’s words: the address by its origin, nothing of the workspace’s other gates (#1156 review P2-2, P3-1)', async () => {
      const approve = async (id: string) =>
        asAdmin('approve_gate_address_change', {
          workspaceId,
          id,
          previewDigest: (await listed(id)).previewDigest,
        });
      /** What a platform refusal must not carry: the address past its origin, another gate. */
      function platformWorded(
        mapped: Awaited<ReturnType<typeof refusal>>,
        toEndpoint: string,
        options: { readonly other?: string; readonly namesAddress: boolean },
      ) {
        expect(mapped.details).toBeUndefined();
        if (options.namesAddress) {
          expect(mapped.message).toContain(JSON.stringify(gateAddressOrigin(toEndpoint)));
        }
        expect(mapped.message).not.toContain(new URL(toEndpoint).pathname);
        expect(mapped.message).toContain('reject the change');
        if (options.other) expect(mapped.message).not.toContain(options.other);
      }

      // The workspace connected another gate at the new address since the proposal.
      const first = await connectedGate();
      const taken = await previewAndPropose(first.gatekeeperId);
      const { gatekeeperId: squatterId } = await asOwner<{ gatekeeperId: string }>(
        'create_connection',
        {
          kind: 'http',
          target: 'gac-system',
          endpoint: taken.endpoint,
          connectionSecret: newSecret(),
        },
      );
      const addressTaken = await refusal(approve(taken.proposal.id));
      expect(addressTaken).toMatchObject({ status: 409, code: 'endpoint_already_connected' });
      platformWorded(addressTaken, taken.endpoint, { other: squatterId, namesAddress: true });
      expect((await gatekeeperRecord(first.gatekeeperId))?.endpoint).toBe(first.endpoint);

      // Another gate holds the secret the change carries — only a write racing the proposal's own
      // checks could make it so; made here around them.
      const second = await connectedGate();
      const carried = await previewAndPropose(second.gatekeeperId);
      const holder = await connectedGate();
      await writeAround(
        `update objects
            set properties = jsonb_set(properties, '{connectionSecretSalt}', to_jsonb($3::text))
          where workspace_id = $1 and id = $2`,
        holder.gatekeeperId,
        saltOf(carried.connectionSecret),
      );
      const secretHeld = await refusal(approve(carried.proposal.id));
      expect(secretHeld).toMatchObject({ status: 409, code: 'connection_secret_in_use' });
      platformWorded(secretHeld, carried.endpoint, {
        other: holder.gatekeeperId,
        namesAddress: false,
      });
      expect((await gatekeeperRecord(second.gatekeeperId))?.endpoint).toBe(second.endpoint);

      // The new host turns the change's secret away now.
      const third = await connectedGate();
      const turned = await previewAndPropose(third.gatekeeperId);
      gates.failing.set(
        turned.endpoint,
        new GatekeeperClientError('gatekeeper client: gate/describe_operations answered 401', {
          code: 'unauthorized',
          status: 401,
        }),
      );
      const notDescribed = await refusal(approve(turned.proposal.id));
      expect(notDescribed).toMatchObject({ status: 502, code: 'manifest_fetch_failed' });
      platformWorded(notDescribed, turned.endpoint, { namesAddress: true });
      expect(notDescribed.message).not.toContain('GATE_KERNEL_TOKEN_FILE');
      expect((await gatekeeperRecord(third.gatekeeperId))?.endpoint).toBe(third.endpoint);
    });

    it('a lapsed proposal is recorded expired by the next proposal for the gate, which takes its place (#1156 review P3-2)', async () => {
      const { gatekeeperId } = await connectedGate();
      const { proposal } = await previewAndPropose(gatekeeperId);
      await lapse(proposal.id);
      const next = await previewAndPropose(gatekeeperId);
      expect(next.proposal.status).toBe('proposed');
      expect(await listed(proposal.id)).toMatchObject({
        status: 'expired',
        decidedAt: expect.any(String),
      });
    });

    it('approve compares the new host’s whole manifest with the proposal’s, descriptions included (#1156 review P3-3)', async () => {
      const { gatekeeperId, endpoint } = await connectedGate();
      const { proposal, endpoint: newEndpoint } = await previewAndPropose(gatekeeperId);
      // What the workspace publishes would still match — only the proposal's manifest digest differs.
      gates.described.set(newEndpoint, [{ ...OP, description: 'Reads one stock, worded anew.' }]);
      expect(
        await refusedWith(
          asAdmin('approve_gate_address_change', {
            workspaceId,
            id: proposal.id,
            previewDigest: (await listed(proposal.id)).previewDigest,
          }),
        ),
      ).toEqual({ status: 409, code: 'gate_address_manifest_mismatch' });
      expect((await gatekeeperRecord(gatekeeperId))?.endpoint).toBe(endpoint);
    });

    it('I-A1: the checker counts a Gatekeeper whose self connection is not where its last applied change put it', async () => {
      const { gatekeeperId } = await connectedGate();
      const { proposal } = await previewAndPropose(gatekeeperId);
      await asAdmin('approve_gate_address_change', {
        workspaceId,
        id: proposal.id,
        previewDigest: (await listed(proposal.id)).previewDigest,
      });
      const sampleOf = `${workspaceId}:${gatekeeperId} (change ${proposal.id})`;
      /** I-A1's sample with `sql` applied in a transaction rolled back afterwards. */
      async function sampleAfter(sql: string): Promise<readonly string[]> {
        const client = await pool.connect();
        try {
          await client.query('begin');
          await client.query('set local session_replication_role = replica');
          await client.query(sql, [workspaceId, gatekeeperId]);
          const checks = await runInvariantChecks(poolOver(client));
          return checks.find((check) => check.invariant === 'I-A1')?.sample ?? [];
        } finally {
          await client.query('rollback');
          client.release();
        }
      }
      // What only a write around the landing path could do: the self connection's key moved back
      // while the Gatekeeper stayed.
      expect(
        await sampleAfter(
          `update workspace_self_connections set endpoint_key = 'http://gac-moved-back.invalid:8080'
            where workspace_id = $1 and gatekeeper_object_id = $2`,
        ),
      ).toContain(sampleOf);
      // The Gatekeeper moved while its self connection stayed.
      expect(
        await sampleAfter(
          `update objects
              set properties = jsonb_set(properties, '{endpoint}', '"http://gac-object-moved.invalid:8080/gate"')
            where workspace_id = $1 and id = $2`,
        ),
      ).toContain(sampleOf);
      // The address copy the platform shows, cut by the raw-secret scrub, is not the address.
      expect(
        await sampleAfter(
          `update workspace_self_connections set endpoint = 'http://gac-shown.invalid:8080'
            where workspace_id = $1 and gatekeeper_object_id = $2`,
        ),
      ).not.toContain(sampleOf);
      const after = await runInvariantChecks(pool);
      expect(after.find((check) => check.invariant === 'I-A1')?.sample ?? []).not.toContain(
        sampleOf,
      );
    });
  },
);
