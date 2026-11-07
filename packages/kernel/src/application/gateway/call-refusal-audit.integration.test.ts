import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityScope, PrincipalKind, Role } from '@nexttime/shared';
import { AuditRecordWireSchema, PlatformAuditRecordWireSchema } from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { HANDLE_SIGNING_ALG } from '../../governance/capability/index.js';
import { runWithCorrelationId } from '../../substrate/correlation/index.js';
import { issueAdminAgentHandle } from '../admin-agent/index.js';
import { type UserRow, createUser } from '../identity/index.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import { withAdminClient } from './auth.js';
import { CapabilityCallRefusedError, ForbiddenError } from './authorize.js';
import { REFUSAL_AUDIT_LIMIT, callRefusalCount } from './call-refusals.js';
import { dispatchCapability } from './dispatch.js';
import { authenticateHandle } from './handle-auth.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * Batch D3 (docs/test-coverage-gaps-2026-11-06.md G10/G11; migration core 0054; real Postgres,
 * auto-skip without DATABASE_URL), through `dispatchCapability`:
 *
 *   - every audit row records what the act came through (`acting_through`) and, for a Handle, the
 *     session it was issued under (`acting_session_id`) — derived from the caller, the same on the
 *     workspace and the platform plane, so an admin agent's rows no longer read as its
 *     administrator's own clicks; `actor_principal_id` still names the Principal answerable;
 *   - a Handle's call refused by authorization leaves one row in its own transaction, `outcome:
 *     'refused'`, its param names and never their values, at most `REFUSAL_AUDIT_LIMIT` an hour per
 *     session, capability and reason; the rest, and every person's refusal, are only counted.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const ONTOLOGY_DIR = path.join(KERNEL_ROOT, '..', '..', 'ontology');

interface AuditRow {
  id: string;
  workspace_id: string | null;
  actor_principal_id: string | null;
  actor_user_id: string | null;
  action: string;
  payload: Record<string, unknown>;
  acting_through: string | null;
  acting_session_id: string | null;
}

describe.runIf(DATABASE_URL !== undefined)(
  'batch D3 — what an audited act came through, and refused Handle calls (integration, real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: CryptoKey;
    let publicKey: CryptoKey;
    let workspaceId: string;
    let admin: UserRow;
    let adminPrincipalId: string;
    let previousSwitch: string | undefined;

    async function insertPrincipal(kind: PrincipalKind, role: Role): Promise<string> {
      const id = randomUUID();
      await withAdminClient(pool, (client) =>
        client.query(
          `insert into principals (workspace_id, id, kind, role, display_name)
           values ($1, $2, $3, $4, $5)`,
          [workspaceId, id, kind, role, `d3-${kind}-${role}`],
        ),
      );
      return id;
    }

    async function insertSession(kind: string, principalId: string): Promise<string> {
      const result = await withAdminClient(pool, (client) =>
        client.query<{ id: string }>(
          `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
           values ($1, $2, $3, $2, 'active') returning id`,
          [workspaceId, principalId, kind],
        ),
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error('no session');
      return id;
    }

    /** A Handle's verified claims under a real session of `kind` — what dispatch is handed after
     *  authentication; dispatch reads the session's kind itself. */
    async function handleCaller(
      kind: string,
      principalId: string,
      capabilities: readonly string[],
    ): Promise<ResolvedCaller & { channel: 'handle' }> {
      const sid = await insertSession(kind, principalId);
      const now = Math.floor(Date.now() / 1000);
      const scope: CapabilityScope = { capabilities: [...capabilities], resources: {} };
      return {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid,
          obo: principalId,
          scope,
          jti: randomUUID(),
          iat: now,
          exp: now + 600,
        },
      };
    }

    function personCaller(principalId: string, role: Role): ResolvedCaller {
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

    /** One call with its own correlation id; resolves with what it returned or threw. */
    async function call(
      caller: ResolvedCaller,
      name: string,
      params: Record<string, unknown> = {},
    ): Promise<{ correlationId: string; outcome: unknown }> {
      const correlationId = `d3-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const outcome = await runWithCorrelationId(correlationId, () =>
        dispatchCapability({ pool }, caller, name, params),
      ).then(
        (result) => result,
        (err: unknown) => err,
      );
      return { correlationId, outcome };
    }

    /** Every audit row the call with `correlationId` wrote, workspace rows first. */
    async function rowsOf(correlationId: string): Promise<AuditRow[]> {
      const result = await withAdminClient(pool, (client) =>
        client.query<AuditRow>(
          `select id, workspace_id, actor_principal_id, actor_user_id, action, payload,
                  acting_through, acting_session_id
             from audit_records where payload->>'correlationId' = $1
            order by (workspace_id is null), created_at, id`,
          [correlationId],
        ),
      );
      return result.rows;
    }

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
        login: `d3-admin-${tag}`,
        displayName: 'D3 Admin',
        platformRole: 'admin',
      });
      // A trial workspace, so the administrator's admin agent may act in it (S11 AA3a, I-A6).
      const created = await createWorkspaceWithOwner(pool, {
        name: `d3-${tag}`,
        owner: { userId: admin.id, displayName: 'D3 Admin' },
        ontologyDir: ONTOLOGY_DIR,
        purpose: 'admin_trial',
      });
      workspaceId = created.workspaceId;
      adminPrincipalId = created.ownerPrincipalId;
    });

    afterAll(async () => {
      if (previousSwitch === undefined) Reflect.deleteProperty(process.env, 'ADMIN_AGENT_ENABLED');
      else process.env.ADMIN_AGENT_ENABLED = previousSwitch;
      await pool?.end();
    });

    describe('acting_through', () => {
      it("a person's own call: person, no session", async () => {
        const { correlationId, outcome } = await call(
          personCaller(adminPrincipalId, 'owner'),
          'list_skills',
        );
        expect(outcome).not.toBeInstanceOf(Error);
        expect(await rowsOf(correlationId)).toMatchObject([
          {
            action: 'list_skills',
            actor_principal_id: adminPrincipalId,
            acting_through: 'person',
            acting_session_id: null,
          },
        ]);
      });

      it('each kind of Handle says what it came through and its session; the actor stays the Principal it acts for', async () => {
        const member = await insertPrincipal('human', 'member');
        const service = await insertPrincipal('service', 'member');
        for (const [kind, principalId, actingThrough] of [
          ['entry', member, 'entry_agent'],
          ['worker_run', member, 'worker_handle'],
          ['mcp_session', member, 'member_handle'],
          ['service', service, 'service_handle'],
        ] as const) {
          const caller = await handleCaller(kind, principalId, ['list_skills']);
          const { correlationId, outcome } = await call(caller, 'list_skills');
          expect(outcome, kind).not.toBeInstanceOf(Error);
          expect(await rowsOf(correlationId), kind).toMatchObject([
            {
              actor_principal_id: principalId,
              acting_through: actingThrough,
              acting_session_id: caller.claims.sid,
              payload: { channel: 'handle', onBehalfOf: principalId },
            },
          ]);
        }
      });

      it("an admin agent's rows say so on both planes — the trial workspace's and the platform's — though the actor is its administrator (G11)", async () => {
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
        const { correlationId, outcome } = await call(
          { channel: 'handle', claims },
          'platform_state_gates',
        );
        expect(outcome).not.toBeInstanceOf(Error);
        const rows = await rowsOf(correlationId);
        expect(rows).toMatchObject([
          {
            workspace_id: workspaceId,
            actor_principal_id: adminPrincipalId,
            acting_through: 'admin_agent_session',
            acting_session_id: issued.sessionId,
          },
          {
            workspace_id: null,
            actor_principal_id: null,
            actor_user_id: admin.id,
            acting_through: 'admin_agent_session',
            acting_session_id: issued.sessionId,
          },
        ]);

        // The administrator's own platform call, for contrast: a person, no session.
        const own = await call(platformCaller(admin), 'list_users');
        expect(own.outcome).not.toBeInstanceOf(Error);
        expect(await rowsOf(own.correlationId)).toMatchObject([
          { workspace_id: null, actor_user_id: admin.id, acting_through: 'person' },
        ]);

        // Both reads say it on the wire too.
        const platformRead = (await dispatchCapability(
          { pool },
          platformCaller(admin),
          'platform_audit_query',
          { action: 'platform_state_gates', limit: 5 },
        )) as { items: unknown[] };
        const platformRow = PlatformAuditRecordWireSchema.parse(
          platformRead.items.find((item) => (item as { id: string }).id === rows[1]?.id),
        );
        expect(platformRow).toMatchObject({
          actingThrough: 'admin_agent_session',
          actingSessionId: issued.sessionId,
        });
        const workspaceRead = (await dispatchCapability(
          { pool },
          personCaller(adminPrincipalId, 'owner'),
          'audit_query',
          { filter: { action: 'platform_state_gates' }, limit: 5 },
        )) as { items: unknown[] };
        const workspaceRow = AuditRecordWireSchema.parse(
          workspaceRead.items.find((item) => (item as { id: string }).id === rows[0]?.id),
        );
        expect(workspaceRow).toMatchObject({
          actingThrough: 'admin_agent_session',
          actingSessionId: issued.sessionId,
        });
      });

      it('the database refuses a value outside the list, and a session with a channel that has none', async () => {
        for (const [actingThrough, actingSessionId] of [
          ['robot', null],
          ['person', randomUUID()],
          ['system', randomUUID()],
          [null, randomUUID()],
        ] as const) {
          await expect(
            withAdminClient(pool, (client) =>
              client.query(
                `insert into audit_records (workspace_id, actor_principal_id, action, payload, acting_through, acting_session_id)
                 values ($1, $2, 'd3.constraint_probe', '{}'::jsonb, $3, $4)`,
                [workspaceId, adminPrincipalId, actingThrough, actingSessionId],
              ),
            ),
            `${actingThrough} / ${actingSessionId}`,
          ).rejects.toMatchObject({ code: '23514' });
        }
      });
    });

    describe('refused calls', () => {
      it("a Handle's call outside its scope: one refused row, in its own transaction, with param names and never their values", async () => {
        const member = await insertPrincipal('human', 'member');
        const caller = await handleCaller('mcp_session', member, ['list_skills']);
        const value = `d3-value-${randomUUID()}`;
        const { correlationId, outcome } = await call(caller, 'get_object', {
          objectId: value,
          'not a name!': value,
        });
        expect(outcome).toBeInstanceOf(CapabilityCallRefusedError);
        expect((outcome as CapabilityCallRefusedError).reason).toBe('not_in_scope');
        const rows = await rowsOf(correlationId);
        expect(rows).toMatchObject([
          {
            workspace_id: workspaceId,
            action: 'get_object',
            actor_principal_id: member,
            acting_through: 'member_handle',
            acting_session_id: caller.claims.sid,
            payload: {
              channel: 'handle',
              onBehalfOf: member,
              paramKeys: ['objectId'],
              paramKeysOmitted: 1,
              outcome: 'refused',
              refusal: { code: 'forbidden', status: 403, reason: 'not_in_scope' },
            },
          },
        ]);
        expect(JSON.stringify(rows)).not.toContain(value);
      });

      it("an admin agent's call for a person's decision, and a platform capability through a Handle, are refused and audited in the Handle's workspace", async () => {
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
        for (const [name, reason] of [
          ['approve', 'human_channel_only'],
          ['list_users', 'platform_scope'],
        ] as const) {
          const { correlationId, outcome } = await call({ channel: 'handle', claims }, name);
          expect(outcome, name).toBeInstanceOf(ForbiddenError);
          expect(await rowsOf(correlationId), name).toMatchObject([
            {
              workspace_id: workspaceId,
              action: name,
              actor_principal_id: adminPrincipalId,
              acting_through: 'admin_agent_session',
              acting_session_id: issued.sessionId,
              payload: {
                sessionKind: 'admin_agent',
                sessionId: issued.sessionId,
                outcome: 'refused',
                refusal: { code: 'forbidden', status: 403, reason },
              },
            },
          ]);
        }
      });

      it("a service Principal's Handle on a capability made for a person: refused in the call's transaction, audited the same", async () => {
        const service = await insertPrincipal('service', 'member');
        const caller = await handleCaller('service', service, ['propose_goal']);
        const { correlationId, outcome } = await call(caller, 'propose_goal', {
          statement: 'nobody confirms this',
          plan: {
            steps: [{ key: 'a', worker: { definitionId: randomUUID(), version: 1 }, input: {} }],
          },
          budget: { maxTokens: 100_000, maxSteps: 10, maxRevisions: 2, maxWallClockSeconds: 3600 },
        });
        expect(outcome).toBeInstanceOf(ForbiddenError);
        expect((outcome as CapabilityCallRefusedError).reason).toBe('not_for_person');
        const rows = await rowsOf(correlationId);
        expect(rows).toMatchObject([
          {
            action: 'propose_goal',
            actor_principal_id: service,
            acting_through: 'service_handle',
            acting_session_id: caller.claims.sid,
            payload: {
              outcome: 'refused',
              refusal: { code: 'forbidden', status: 403, reason: 'not_for_person' },
              paramKeys: ['budget', 'plan', 'statement'],
            },
          },
        ]);
        expect(JSON.stringify(rows)).not.toContain('nobody confirms this');
      });

      it(`at most ${REFUSAL_AUDIT_LIMIT} rows an hour per session, capability and reason; the rest are counted`, async () => {
        const member = await insertPrincipal('human', 'member');
        const caller = await handleCaller('entry', member, ['list_skills']);
        const labels = {
          channel: 'handle',
          capability: 'get_object',
          reason: 'not_in_scope',
        } as const;
        const writtenBefore = callRefusalCount({ ...labels, audit: 'written' });
        const heldBackBefore = callRefusalCount({ ...labels, audit: 'held_back' });
        for (let i = 0; i < REFUSAL_AUDIT_LIMIT + 2; i += 1) {
          const { outcome } = await call(caller, 'get_object', { objectId: randomUUID() });
          expect(outcome).toBeInstanceOf(ForbiddenError);
        }
        const count = async (action: string) =>
          (
            await withAdminClient(pool, (client) =>
              client.query<{ n: number }>(
                `select count(*)::int as n from audit_records
                  where acting_session_id = $1 and action = $2 and payload->>'outcome' = 'refused'`,
                [caller.claims.sid, action],
              ),
            )
          ).rows[0]?.n;
        expect(await count('get_object')).toBe(REFUSAL_AUDIT_LIMIT);
        expect(callRefusalCount({ ...labels, audit: 'written' }) - writtenBefore).toBe(
          REFUSAL_AUDIT_LIMIT,
        );
        expect(callRefusalCount({ ...labels, audit: 'held_back' }) - heldBackBefore).toBe(2);

        // Another capability from the same session has a window of its own.
        const other = await call(caller, 'approve');
        expect(other.outcome).toBeInstanceOf(ForbiddenError);
        expect(await count('approve')).toBe(1);
      });

      it("a person's refusal writes nothing and is counted", async () => {
        const auditor = await insertPrincipal('human', 'auditor');
        const labels = {
          channel: 'human',
          capability: 'assert_fact',
          reason: 'auditor_read_only',
          audit: 'none',
        } as const;
        const member = await insertPrincipal('human', 'member');
        const roleLabels = {
          channel: 'human',
          capability: 'install_pack',
          reason: 'role',
          audit: 'none',
        } as const;
        const before = [callRefusalCount(labels), callRefusalCount(roleLabels)];
        const byAuditor = await call(personCaller(auditor, 'auditor'), 'assert_fact');
        const byMember = await call(personCaller(member, 'member'), 'install_pack');
        for (const refused of [byAuditor, byMember]) {
          expect(refused.outcome).toBeInstanceOf(CapabilityCallRefusedError);
          expect(await rowsOf(refused.correlationId)).toEqual([]);
        }
        expect([callRefusalCount(labels), callRefusalCount(roleLabels)]).toEqual([
          (before[0] ?? 0) + 1,
          (before[1] ?? 0) + 1,
        ]);
      });
    });
  },
);
