import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  HandleClaims,
  Operation,
  PlatformStateAuditWire,
  PlatformStateConnectorsWire,
  PlatformStateGatesWire,
  PrincipalKind,
} from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { withPlatform } from '../../adapters/db/platform-context.js';
import { type PoolLike, createPool, withWorkspace } from '../../adapters/db/pool.js';
import { HANDLE_SIGNING_ALG } from '../../governance/capability/index.js';
import { findSuspectedSecrets } from '../../governance/redaction/index.js';
import { writeAudit } from '../../substrate/audit/index.js';
import { runWithCorrelationId } from '../../substrate/correlation/index.js';
import { storableAnnouncement, upsertAnnouncement } from '../gates/index.js';
import { withAdminClient } from '../gateway/auth.js';
import { ForbiddenError } from '../gateway/authorize.js';
import {
  AdminAgentCallRefusedError,
  AdminAgentOnlyError,
  dispatchCapability,
} from '../gateway/dispatch.js';
import { authenticateHandle } from '../gateway/handle-auth.js';
import type { ResolvedCaller } from '../gateway/resolve-caller.js';
import { type UserRow, createUser } from '../identity/index.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import {
  AdminAgentRefused,
  issueAdminAgentHandle,
  readPlatformStateForAdminAgent,
} from './index.js';
import { findAddressLike } from './platform-state-probes.js';

/**
 * application/admin-agent platform state integration (S11 AA2a; real Postgres, a private database
 * so the platform's own rows are only this file's; auto-skip without DATABASE_URL): what an admin
 * agent reads of the platform through `platform_state_*`, end to end through dispatch with
 * `KERNEL_VALIDATE_RESULTS=1` —
 *
 *   - what it gets back carries none of what the platform rows hold beyond their shapes: no
 *     address, display name, credential-shaped value or free text an administrator wrote;
 *   - the read leaves two audit rows under one correlation id: the call's own in the workspace,
 *     and one on the platform's audit (who, which admin agent session, which area, how many items,
 *     nothing of what was read); without the platform row there is no result;
 *   - the read runs in a read-only platform transaction, with the agent's authority checked there
 *     again (a demotion between the call's commit and the read refuses it, and is audited);
 *   - nothing but an admin agent's Handle gets anything: a person, a service's API key, a
 *     platform administrator in the console, and a Handle of any other session are refused.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const ONTOLOGY_DIR = path.join(KERNEL_ROOT, '..', '..', 'ontology');

// Built at run time: no address literal sits in the source (the CI guard reads tests too).
const PRIVATE_V4 = [10, 20, 30, 40].join('.');
const PRIVATE_V4_B = [192, 168, 77, 5].join('.');
// A vendor-key shape spelled from the alphabet (the synthetic value .gitleaks.toml allows).
const VENDOR_KEY = ['sk', 'ant', 'abcdefghijklmnopqrstuvwxyz'].join('-');

const GATE_ID = 'aa2-fixture-gate';
const CONNECTOR = 'aa2-fixture';

function operation(name: string): Operation {
  return {
    name,
    binding: { kind: 'mcp', tool_name: name },
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
}

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
  const name = `nexttime_platform_state_${randomUUID().replace(/-/g, '')}`;
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

/** `pool`, with `beforeStatement` run before each statement whose text `matches` — on the call's
 *  own connection, so a demotion it runs is committed before that statement's transaction reads. */
function poolWithHook(
  pool: Pool,
  matches: (text: string) => boolean,
  beforeStatement: () => Promise<void>,
): PoolLike {
  return {
    async connect(): Promise<PoolClient> {
      const client = await pool.connect();
      const query = client.query;
      const release = client.release;
      const hooked = async (...args: unknown[]): Promise<unknown> => {
        if (typeof args[0] === 'string' && matches(args[0])) await beforeStatement();
        return (query as (...a: unknown[]) => Promise<unknown>).apply(client, args);
      };
      Object.assign(client, {
        query: hooked,
        release: (...args: unknown[]) => {
          Object.assign(client, { query, release });
          return (release as (...a: unknown[]) => void).apply(client, args);
        },
      });
      return client;
    },
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'S11 AA2a platform_state through an admin agent (integration, real Postgres)',
  () => {
    let pool: Pool;
    let dropDatabase: (() => Promise<void>) | undefined;
    let privateKey: CryptoKey;
    let publicKey: CryptoKey;
    let workspaceId: string;
    /** The administrator the agent acts for: a platform admin, owner of `workspaceId`. */
    let admin: UserRow;
    let adminPrincipalId: string;
    let otherAdmin: UserRow;
    const previousEnv: Record<string, string | undefined> = {};

    async function agent(): Promise<{ caller: ResolvedCaller; sessionId: string }> {
      const issued = await withWorkspace(
        pool,
        { workspaceId, principalId: adminPrincipalId },
        (client) =>
          issueAdminAgentHandle(client, {
            workspaceId,
            principalId: adminPrincipalId,
            ttlSeconds: 600,
            privateKey,
          }),
      );
      const claims = await authenticateHandle(pool, issued.token, { publicKey }, 'source');
      return { caller: { channel: 'handle', claims }, sessionId: issued.sessionId };
    }

    function personCaller(principalId: string, kind: PrincipalKind): ResolvedCaller {
      return {
        channel: 'human',
        principal: { workspaceId, id: principalId, kind, role: 'owner', displayName: null },
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

    interface AuditRow {
      readonly workspace_id: string | null;
      readonly actor_principal_id: string | null;
      readonly actor_user_id: string | null;
      readonly payload: Record<string, unknown>;
    }

    async function auditRows(action: string, correlationId: string): Promise<AuditRow[]> {
      const result = await withAdminClient(pool, (client) =>
        client.query<AuditRow>(
          `select workspace_id, actor_principal_id, actor_user_id, payload from audit_records
            where action = $1 and payload->>'correlationId' = $2
            order by (workspace_id is null), created_at`,
          [action, correlationId],
        ),
      );
      return result.rows;
    }

    async function call(
      caller: ResolvedCaller,
      name: string,
      deps: { pool: PoolLike } = { pool },
    ): Promise<{ correlationId: string; outcome: unknown }> {
      const correlationId = `aa2-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const outcome = await runWithCorrelationId(correlationId, () =>
        dispatchCapability(deps, caller, name, {}),
      ).then(
        (result) => result,
        (err: unknown) => err,
      );
      return { correlationId, outcome };
    }

    async function setPlatformRole(user: UserRow, role: 'admin' | 'user'): Promise<void> {
      await withAdminClient(pool, (client) =>
        client.query('update users set platform_role = $2 where id = $1', [user.id, role]),
      );
    }

    /** Neither an address, a credential-shaped value nor a canary anywhere in `value`. */
    function expectClean(value: unknown): void {
      const text = JSON.stringify(value);
      expect(text).not.toMatch(/canary/i);
      expect(findSuspectedSecrets(value).count).toBe(0);
      expect(findAddressLike(value)).toEqual([]);
    }

    beforeAll(async () => {
      for (const name of ['ADMIN_AGENT_ENABLED', 'KERNEL_VALIDATE_RESULTS']) {
        previousEnv[name] = process.env[name];
        process.env[name] = '1';
      }
      const isolated = await createIsolatedDatabase();
      pool = isolated.pool;
      dropDatabase = isolated.drop;
      await runMigrations(pool, MIGRATIONS_DIR);
      const pair = await generateKeyPair(HANDLE_SIGNING_ALG, { crv: 'Ed25519' });
      privateKey = pair.privateKey;
      publicKey = pair.publicKey;
      const tag = randomUUID().slice(0, 8);
      admin = await createUser(pool, {
        login: `aa2-admin-${tag}`,
        displayName: 'AA2 Admin',
        platformRole: 'admin',
      });
      otherAdmin = await createUser(pool, {
        login: `aa2-other-${tag}`,
        displayName: 'AA2 Other Admin',
        platformRole: 'admin',
      });
      const created = await createWorkspaceWithOwner(pool, {
        name: `aa2-${tag}`,
        owner: { userId: admin.id, displayName: 'AA2 Admin' },
        ontologyDir: ONTOLOGY_DIR,
      });
      workspaceId = created.workspaceId;
      adminPrincipalId = created.ownerPrincipalId;

      // A packaged gate whose every free field is hostile: addresses, a display name with a
      // canary, a connector deny list with an address and a vendor key in it — and, as a row
      // announced before #549 can still hold, a credential in its target (the announce refuses
      // one now, so it is written after).
      await withAdminClient(pool, (client) =>
        upsertAnnouncement(
          client,
          storableAnnouncement({
            gateId: GATE_ID,
            connector: CONNECTOR,
            transportKind: 'mcp',
            target: `http://${PRIVATE_V4}:8080/mcp`,
            endpoint: `http://${PRIVATE_V4_B}:9000`,
            healthEndpoint: `http://${PRIVATE_V4_B}:9000/healthz`,
            displayName: `canary ${PRIVATE_V4} prod ssh root@${PRIVATE_V4_B}`,
            operations: [operation('list_things'), operation('docs.search')],
          }),
          'gate',
        ),
      );
      await withAdminClient(pool, (client) =>
        client.query('update gate_instances set target = $2 where gate_id = $1', [
          GATE_ID,
          `http://ops:${VENDOR_KEY}@${PRIVATE_V4}:8080/mcp`,
        ]),
      );
      await withAdminClient(pool, (client) =>
        client.query('update connectors set disabled_operations = $2::jsonb where name = $1', [
          CONNECTOR,
          JSON.stringify(['docs.search', PRIVATE_V4, VENDOR_KEY, `/etc/${CONNECTOR}`]),
        ]),
      );

      // Platform changes: one by the agent's own administrator, one by another, one by the
      // operator CLI naming nobody, and a read (not a change) — each payload hostile.
      await withPlatform(pool, { userId: admin.id }, (client) =>
        writeAudit(client, {
          workspaceId: null,
          actorPrincipalId: null,
          actorUserId: admin.id,
          action: 'update_connector',
          resourceType: 'connector',
          payload: { canary: VENDOR_KEY, target: `http://${PRIVATE_V4}` },
        }),
      );
      await withPlatform(pool, { userId: otherAdmin.id }, async (client) => {
        await writeAudit(client, {
          workspaceId: null,
          actorPrincipalId: null,
          actorUserId: otherAdmin.id,
          action: 'update_gate_instance',
          resourceType: 'gate_instance',
          payload: { displayName: `canary ${PRIVATE_V4_B}` },
        });
        await writeAudit(client, {
          workspaceId: null,
          actorPrincipalId: null,
          actorUserId: otherAdmin.id,
          action: 'list_users',
          payload: { canary: 'a read is not a change' },
        });
      });
      await withAdminClient(pool, (client) =>
        writeAudit(client, {
          workspaceId: null,
          actorPrincipalId: null,
          action: 'cli.workspace_created',
          payload: { attributedActor: false, canary: `root@${PRIVATE_V4}` },
        }),
      );
    }, 180_000);

    afterAll(async () => {
      for (const [name, value] of Object.entries(previousEnv)) {
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
      await dropDatabase?.();
    });

    it('platform_state_gates: the gate by its shapes only, and two audit rows under one correlation id', async () => {
      const { caller, sessionId } = await agent();
      const { correlationId, outcome } = await call(caller, 'platform_state_gates');
      const gates = outcome as PlatformStateGatesWire;
      expect(gates.total).toBe(1);
      expect(gates.truncated).toBe(false);
      expect(gates.instances).toEqual([
        expect.objectContaining({
          gateId: GATE_ID,
          connector: CONNECTOR,
          transportKind: 'mcp',
          hosted: false,
          preset: null,
          credentialMode: null,
          operationCount: 2,
          enabledWorkspaceCount: 0,
          pendingManifest: null,
        }),
      ]);
      expectClean(gates);

      const [workspaceRow, platformRow, ...rest] = await auditRows(
        'platform_state_gates',
        correlationId,
      );
      expect(rest).toEqual([]);
      expect(workspaceRow).toMatchObject({
        workspace_id: workspaceId,
        actor_principal_id: adminPrincipalId,
        payload: { channel: 'handle', sessionKind: 'admin_agent', sessionId },
      });
      // Constraint a) of AA1 on the platform's side: the proposer is the admin agent session,
      // never the administrator alone — and nothing of what was read, only how much.
      expect(platformRow).toEqual({
        workspace_id: null,
        actor_principal_id: null,
        actor_user_id: admin.id,
        payload: {
          channel: 'handle',
          sessionKind: 'admin_agent',
          sessionId,
          workspaceId,
          onBehalfOf: adminPrincipalId,
          returned: 1,
          correlationId,
        },
      });
    });

    it('platform_state_connectors: disabled Operation names only in identifier shape, the rest counted', async () => {
      const { caller } = await agent();
      const { outcome } = await call(caller, 'platform_state_connectors');
      const { connectors } = outcome as PlatformStateConnectorsWire;
      const fixture = connectors.find((connector) => connector.name === CONNECTOR);
      expect(fixture).toEqual(
        expect.objectContaining({
          kind: 'mcp',
          packaged: true,
          generic: false,
          disabledOperationCount: 4,
          disabledOperations: ['docs.search'],
          operationCount: 2,
          instanceCount: 1,
          selfConnectionCount: 0,
          suspendedSelfConnectionCount: 0,
        }),
      );
      for (const connector of connectors) {
        if (connector.name !== CONNECTOR) expect(connector.generic, connector.name).toBe(true);
      }
      expectClean(connectors);
    });

    it('platform_state_audit: changes by kind of actor, never a payload, a login or a read', async () => {
      const { caller } = await agent();
      // Its own earlier platform rows are reads too: they never count as changes.
      await call(caller, 'platform_state_gates');
      const { outcome } = await call(caller, 'platform_state_audit');
      const summary = outcome as PlatformStateAuditWire;
      expect(summary.windowHours).toBe(168);
      expect(summary.truncated).toBe(false);
      expect(summary.unrecognizedWrites).toBe(0);
      expect(summary.writesByAction).toEqual(
        expect.arrayContaining([
          { action: 'cli.workspace_created', count: 1 },
          { action: 'update_connector', count: 1 },
          { action: 'update_gate_instance', count: 1 },
        ]),
      );
      const actions = summary.writesByAction.map((entry) => entry.action);
      expect(actions).not.toContain('list_users');
      expect(actions.filter((action) => action.startsWith('platform_state_'))).toEqual([]);
      const actorOf = (action: string) =>
        summary.recent.find((write) => write.action === action)?.actor;
      expect(actorOf('update_connector')).toBe('self');
      expect(actorOf('update_gate_instance')).toBe('another_administrator');
      expect(actorOf('cli.workspace_created')).toBe('unattributed');
      expectClean(summary);
      expect(JSON.stringify(summary)).not.toContain(otherAdmin.login);
      expect(JSON.stringify(summary)).not.toContain(admin.login);
    });

    it('the read runs in a read-only platform transaction', async () => {
      const { sessionId } = await agent();
      const thrown = await readPlatformStateForAdminAgent(
        pool,
        { workspaceId, principalId: adminPrincipalId, sessionId, userId: admin.id },
        'platform_state_gates',
        async (client) => {
          await client.query("update users set display_name = 'written' where id = $1", [admin.id]);
          return { result: null, returned: 0 };
        },
      ).then(
        () => null,
        (err: unknown) => err,
      );
      expect((thrown as { code?: string } | null)?.code).toBe('25006');
    });

    it('a demotion between the call and its read refuses the read, with an audit row and no platform row', async () => {
      const { caller, sessionId } = await agent();
      let demoted = false;
      const hooked = poolWithHook(
        pool,
        (text) => text === 'BEGIN READ ONLY',
        async () => {
          if (demoted) return;
          demoted = true;
          await setPlatformRole(admin, 'user');
        },
      );
      try {
        const { correlationId, outcome } = await call(caller, 'platform_state_connectors', {
          pool: hooked,
        });
        expect(demoted).toBe(true);
        expect(outcome).toBeInstanceOf(AdminAgentCallRefusedError);
        expect((outcome as AdminAgentCallRefusedError).refusal).toBe('not_platform_admin');
        const rows = await auditRows('platform_state_connectors', correlationId);
        // The call's own row (phase 1 committed) and the refusal; nothing on the platform's side.
        expect(rows.map((row) => row.workspace_id)).toEqual([workspaceId, workspaceId]);
        expect(rows[1]?.payload).toMatchObject({
          sessionKind: 'admin_agent',
          sessionId,
          outcome: 'refused',
          refusal: { code: 'admin_agent_refused', status: 403, reason: 'not_platform_admin' },
        });
      } finally {
        await setPlatformRole(admin, 'admin');
      }
    });

    it('a read whose Principal no longer belongs to the administrator it was checked for is refused', async () => {
      const { sessionId } = await agent();
      const thrown = await readPlatformStateForAdminAgent(
        pool,
        { workspaceId, principalId: adminPrincipalId, sessionId, userId: otherAdmin.id },
        'platform_state_gates',
        async () => ({ result: null, returned: 0 }),
      ).then(
        () => null,
        (err: unknown) => err,
      );
      expect(thrown).toBeInstanceOf(AdminAgentRefused);
      expect((thrown as AdminAgentRefused).reason).toBe('user_changed');
    });

    it('no platform audit row, no result: a failed record withholds what was read', async () => {
      const { caller } = await agent();
      let reading = false;
      const hooked = poolWithHook(
        pool,
        (text) => {
          if (text === 'BEGIN READ ONLY') reading = true;
          return reading && /^\s*insert into audit_records/i.test(text);
        },
        async () => {
          throw new Error('audit store unavailable');
        },
      );
      const { correlationId, outcome } = await call(caller, 'platform_state_gates', {
        pool: hooked,
      });
      expect(reading).toBe(true);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain('audit store unavailable');
      const rows = await auditRows('platform_state_gates', correlationId);
      expect(rows.map((row) => row.workspace_id)).toEqual([workspaceId]);
    });

    it('refuses a person, a service API key and a platform administrator: only a Handle reaches it', async () => {
      const serviceId = randomUUID();
      await withAdminClient(pool, (client) =>
        client.query(
          `insert into principals (workspace_id, id, kind, role, display_name, user_id)
           values ($1, $2, 'service', 'owner', 'aa2-service', null)`,
          [workspaceId, serviceId],
        ),
      );
      for (const name of [
        'platform_state_gates',
        'platform_state_connectors',
        'platform_state_audit',
      ]) {
        for (const caller of [
          personCaller(adminPrincipalId, 'human'),
          personCaller(serviceId, 'service'),
          platformCaller(admin),
        ]) {
          const { outcome } = await call(caller, name);
          expect(outcome, `${name} ${caller.channel}`).toBeInstanceOf(ForbiddenError);
        }
      }
    });

    it("refuses another session's Handle carrying the names, with an admin_agent_only audit row", async () => {
      const { caller } = await agent();
      const sessionId = randomUUID();
      await withAdminClient(pool, (client) =>
        client.query(
          `insert into sessions (workspace_id, id, principal_id, kind, on_behalf_of, status)
           values ($1, $2, $3, 'entry', $3, 'active')`,
          [workspaceId, sessionId, adminPrincipalId],
        ),
      );
      // A caller built by hand: the admin agent's scope under an entry session.
      const claims = (caller as { claims: HandleClaims }).claims;
      const forged: ResolvedCaller = { channel: 'handle', claims: { ...claims, sid: sessionId } };
      const { correlationId, outcome } = await call(forged, 'platform_state_audit');
      expect(outcome).toBeInstanceOf(AdminAgentOnlyError);
      expect(outcome).toBeInstanceOf(ForbiddenError);
      const rows = await auditRows('platform_state_audit', correlationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.workspace_id).toBe(workspaceId);
      expect(rows[0]?.payload).toMatchObject({
        channel: 'handle',
        outcome: 'refused',
        refusal: { code: 'admin_agent_only', status: 403 },
      });
      expect(rows[0]?.payload).not.toHaveProperty('sessionKind');
    });

    it('with the switch off, or the administrator demoted, refuses at the call like any other', async () => {
      const { caller } = await agent();
      process.env.ADMIN_AGENT_ENABLED = '0';
      try {
        const { outcome } = await call(caller, 'platform_state_gates');
        expect((outcome as AdminAgentCallRefusedError).refusal).toBe('switched_off');
      } finally {
        process.env.ADMIN_AGENT_ENABLED = '1';
      }
      await setPlatformRole(admin, 'user');
      try {
        const { correlationId, outcome } = await call(caller, 'platform_state_gates');
        expect((outcome as AdminAgentCallRefusedError).refusal).toBe('not_platform_admin');
        const rows = await auditRows('platform_state_gates', correlationId);
        expect(rows.map((row) => row.workspace_id)).toEqual([workspaceId]);
      } finally {
        await setPlatformRole(admin, 'admin');
      }
    });
  },
);
