import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool } from 'pg';
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
  ENTRY_CEILING_CAPABILITIES,
  HANDLE_SIGNING_ALG,
  HandleRevoked,
  grantCapability,
} from '../../governance/capability/index.js';
import { registerGatekeeper } from '../../governance/gatekeepers/index.js';
import { GATEKEEPER_RESOURCE_SCOPE_KEY } from '../../governance/policy/index.js';
import { queryAudit } from '../../substrate/audit/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { configureTaskRuntime } from '../task/index.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import { authenticateHandle } from './handle-auth.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/issue-handle-handler.integration.test: DB-gated (real Postgres; auto-skip
 * without DATABASE_URL, same `describe.runIf` pattern every other `*-flow.integration.test.ts`
 * file in this directory uses) end-to-end coverage for `issue_handle` (docs/development-tasks.md
 * W2-B/S3.6): a real Handle-signing keypair, a real Gatekeeper + Grant, and `authenticateHandle`
 * verifying the minted token round-trips — including scope narrowing and revocation.
 *
 * `configureTaskRuntime` needs a `TaskSupervisorClientPort` (`TaskRuntimeDeps`'s own required
 * field) even though `issue_handle`'s own handler never touches it (only `.privateKey`) — the same
 * "provide *a* fake, since the type demands one" shape `invoke-worker-handler.integration.test.ts`
 * already establishes for this singleton, with an even simpler fake here (every method throws —
 * this suite should never spawn/terminate/poll a real Task).
 */

class UnusedSupervisorClient implements TaskSupervisorClientPort {
  spawn(_input: TaskSpawnInput): Promise<TaskSpawnOutcome> {
    throw new Error('issue_handle tests never spawn a Task');
  }
  terminate(_workerRunId: string): Promise<boolean> {
    throw new Error('issue_handle tests never terminate a Task');
  }
  status(_workerRunId: string): Promise<TaskSupervisorStatus | undefined> {
    throw new Error('issue_handle tests never poll Task status');
  }
}

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function humanCaller(workspaceId: string, principalId: string, role: Role): ResolvedCaller {
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

describe.runIf(DATABASE_URL !== undefined)('issue_handle (integration, real Postgres)', () => {
  let pool: Pool;
  let workspaceId: string;
  let ownerId: string;
  let secondOwnerId: string;
  let memberId: string;
  let gatekeeperId: string;
  let handlePublicKey: CryptoKey;

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
          `insert into principals (workspace_id, id, kind, role, display_name)
           values ($1, $2, 'human', $3, $4)`,
          [workspaceId, id, role, displayName],
        );
      },
      { skipRoleSwitch: true },
    );
    return id;
  }

  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool, MIGRATIONS_DIR);

    const { privateKey, publicKey } = await generateKeyPair(HANDLE_SIGNING_ALG, {
      crv: 'Ed25519',
      extractable: true,
    });
    handlePublicKey = publicKey;
    configureTaskRuntime({ pool, privateKey, supervisorClient: new UnusedSupervisorClient() });

    workspaceId = await adminInsertWorkspace('issue-handle-test-workspace');
    ownerId = await adminInsertPrincipal('owner', 'owner-1');
    secondOwnerId = await adminInsertPrincipal('owner', 'owner-2');
    memberId = await adminInsertPrincipal('member', 'member-1');

    gatekeeperId = await withWorkspace(
      pool,
      { workspaceId, principalId: ownerId },
      async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.register_gatekeeper',
          principalId: ownerId,
        });
        const { gatekeeperId: id } = await registerGatekeeper(client, workspaceId, {
          name: 'issue-handle-test-gate',
          transportKind: 'http',
          target: 'issue-handle-test-system',
          endpoint: 'https://gate.issue-handle-test.invalid',
          activityId: activity.id,
          registeredBy: { id: ownerId, kind: 'human' },
        });
        return id;
      },
    );

    // A `connect_gatekeeper`-equivalent Grant, directly via governance/capability — exactly the
    // Grant shape `listActiveGrantResourceScopes(..., {resourceType: GATEKEEPER_RESOURCE_SCOPE_KEY})`
    // (issue-handle-handler.ts) reads.
    await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
      grantCapability(client, workspaceId, {
        principalId: ownerId,
        resourceType: GATEKEEPER_RESOURCE_SCOPE_KEY,
        resourceId: gatekeeperId,
        grantedBy: ownerId,
      }),
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('a member calling issue_handle → ForbiddenError (minRole: owner)', async () => {
    await expect(
      dispatchCapability({ pool }, humanCaller(workspaceId, memberId, 'member'), 'issue_handle', {
        sessionKind: 'interactive',
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('an owner with no requested scope gets the full entry ceiling ∩ their own Grants, and the minted Handle authenticates for real', async () => {
    const owner = humanCaller(workspaceId, ownerId, 'owner');
    const result = (await dispatchCapability({ pool }, owner, 'issue_handle', {
      sessionKind: 'interactive',
    })) as {
      handle: string;
      sessionId: string;
      onBehalfOf: string;
      expiresAt: string;
      scope: { capabilities: string[]; resources: Record<string, string[]> };
    };

    expect(result.onBehalfOf).toBe(ownerId);
    expect(new Set(result.scope.capabilities)).toEqual(new Set(ENTRY_CEILING_CAPABILITIES));
    expect(result.scope.resources.gatekeeper).toEqual([gatekeeperId]);
    expect(typeof result.handle).toBe('string');
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // The session row is a real, freshly-created kind='mcp_session' row (§9.2 "外部运行时").
    const sessionRow = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
      client.query<{ kind: string; on_behalf_of: string; principal_id: string }>(
        'select kind, on_behalf_of, principal_id from sessions where id = $1',
        [result.sessionId],
      ),
    );
    expect(sessionRow.rows[0]).toMatchObject({
      kind: 'mcp_session',
      on_behalf_of: ownerId,
      principal_id: ownerId,
    });

    // The minted token is a real, verifiable Handle — authenticateHandle round-trips it against
    // the same keypair the composition root configured above.
    const claims = await authenticateHandle(pool, result.handle, { publicKey: handlePublicKey });
    expect(claims.ws).toBe(workspaceId);
    expect(claims.obo).toBe(ownerId);
    expect(claims.sid).toBe(result.sessionId);
    expect(claims.scope.resources.gatekeeper).toEqual([gatekeeperId]);
  });

  it('a requested scope narrower than the ceiling is honoured exactly (intersection, not "ignore and give everything")', async () => {
    const owner = humanCaller(workspaceId, ownerId, 'owner');
    const result = (await dispatchCapability({ pool }, owner, 'issue_handle', {
      sessionKind: 'interactive',
      scope: {
        capabilities: ['get_object', 'traverse'],
        resources: { gatekeeper: [gatekeeperId] },
      },
    })) as { scope: { capabilities: string[]; resources: Record<string, string[]> } };

    expect(result.scope.capabilities.sort()).toEqual(['get_object', 'traverse']);
    expect(result.scope.resources.gatekeeper).toEqual([gatekeeperId]);
  });

  it('a requested scope wider than the ceiling never widens it — silently dropped, not an error', async () => {
    const owner = humanCaller(workspaceId, ownerId, 'owner');
    const result = (await dispatchCapability({ pool }, owner, 'issue_handle', {
      sessionKind: 'interactive',
      // grant_capability is channel:'human', minRole:'owner' — never in the entry ceiling
      // (governance/capability/handles.ts's ENTRY_CEILING_CAPABILITIES never includes a
      // human-only name) — requesting it must never leak into the issued scope.
      scope: { capabilities: ['get_object', 'grant_capability'] },
    })) as { scope: { capabilities: string[] } };

    expect(result.scope.capabilities).toEqual(['get_object']);
  });

  it('a requested gatekeeper id the caller has no Grant for is dropped, not honoured', async () => {
    const owner = humanCaller(workspaceId, ownerId, 'owner');
    const notGrantedGatekeeperId = randomUUID();
    const result = (await dispatchCapability({ pool }, owner, 'issue_handle', {
      sessionKind: 'interactive',
      scope: { resources: { gatekeeper: [notGrantedGatekeeperId] } },
    })) as { scope: { resources: Record<string, string[]> } };

    expect(result.scope.resources.gatekeeper ?? []).toEqual([]);
  });

  it('the plaintext handle is never written to audit_records — only params are audited, never the result', async () => {
    const owner = humanCaller(workspaceId, ownerId, 'owner');
    const result = (await dispatchCapability({ pool }, owner, 'issue_handle', {
      sessionKind: 'interactive',
    })) as { handle: string; sessionId: string };

    const auditRows = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
      queryAudit(client, workspaceId, { action: 'issue_handle', resourceId: result.sessionId }),
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.actorPrincipalId).toBe(ownerId);
    expect(JSON.stringify(auditRows[0]?.payload)).not.toContain(result.handle);
  });

  it('revocation via the existing revoke path: disable_principal on the on_behalf_of principal 401s the Handle on its next use', async () => {
    const secondOwnerCaller = humanCaller(workspaceId, secondOwnerId, 'owner');
    const issued = (await dispatchCapability({ pool }, secondOwnerCaller, 'issue_handle', {
      sessionKind: 'interactive',
    })) as { handle: string };

    // Sanity: the freshly-issued Handle authenticates before any disable.
    await expect(
      authenticateHandle(pool, issued.handle, { publicKey: handlePublicKey }),
    ).resolves.toMatchObject({ obo: secondOwnerId });

    // The primary owner disables the second owner — governance/capability/handle-auth.ts's own
    // "belt and suspenders" doc comment: authenticateHandle checks the on_behalf_of principal's
    // disabled_at on *every* verification, independent of session/Handle kind (the entry-session-
    // only revokeEntrySessionHandles call inside disable_principal's own handler never reaches a
    // kind='mcp_session' Handle — this second, independent check is what actually closes it for
    // an interactive Handle).
    const primaryOwnerCaller = humanCaller(workspaceId, ownerId, 'owner');
    await dispatchCapability({ pool }, primaryOwnerCaller, 'disable_principal', {
      principalId: secondOwnerId,
    });

    await expect(
      authenticateHandle(pool, issued.handle, { publicKey: handlePublicKey }),
    ).rejects.toThrow(HandleRevoked);
  });
});
