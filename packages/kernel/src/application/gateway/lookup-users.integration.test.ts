import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LookupUsersResultWire, PrincipalKind, Role } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { createUser } from '../identity/index.js';
import { CapabilityCallRefusedError, ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import { InvalidCapabilityParamsError } from './invalid-params.js';
import { lookupUsersHandler } from './members-handlers.js';
import type { ResolvedCaller } from './resolve-caller.js';
import { fixtureApiKeyHash } from './traversal-fixture.js';

/**
 * application/gateway/lookup-users.integration.test (legacy 150): `lookup_users` and core 0064's
 * `lookup_users_for_owner` against real Postgres — an owner finds the platform users they could
 * add with `add_member`, by login or display name, and sees login and display name only; nobody
 * else gets an answer, through the gateway or straight from the function.
 *
 * The users table is shared with every other suite, so each test names its users with a fresh
 * tag and searches for that tag.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function caller(
  workspaceId: string,
  principalId: string,
  role: Role,
  kind: PrincipalKind = 'human',
): ResolvedCaller {
  return {
    channel: 'human',
    apiKeyHash: fixtureApiKeyHash(principalId),
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

/** A fresh lowercase tag no other user's login or display name contains. */
function newTag(): string {
  return `lu${randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

describe.runIf(DATABASE_URL !== undefined)('lookup_users (integration)', () => {
  let pool: Pool;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let ownerId: string;
  let serviceOwnerId: string;
  let memberId: string;
  let operatorId: string;
  let auditorId: string;
  let disabledOwnerId: string;
  let agentOwnerId: string;
  let otherOwnerId: string;

  async function asAdmin<T>(ws: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return withWorkspace(pool, { workspaceId: ws, principalId: randomUUID() }, fn, {
      skipRoleSwitch: true,
    });
  }

  async function insertWorkspace(
    name: string,
    options: { purpose?: 'standard' | 'ephemeral'; status?: 'active' | 'disabled' } = {},
  ): Promise<string> {
    const id = randomUUID();
    await asAdmin(id, (client) =>
      client.query('insert into workspaces (id, name, purpose, status) values ($1, $2, $3, $4)', [
        id,
        name,
        options.purpose ?? 'standard',
        options.status ?? 'active',
      ]),
    );
    return id;
  }

  async function insertPrincipal(
    ws: string,
    options: {
      kind?: 'human' | 'service' | 'agent';
      role?: Role;
      userId?: string;
      disabled?: boolean;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    await asAdmin(ws, (client) =>
      client.query(
        `insert into principals (workspace_id, id, kind, role, display_name, api_key_hash, user_id, disabled_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          ws,
          id,
          options.kind ?? 'human',
          options.role ?? 'member',
          'lookup fixture',
          options.kind === 'service' ? fixtureApiKeyHash(id) : null,
          options.userId ?? null,
          options.disabled ? new Date() : null,
        ],
      ),
    );
    return id;
  }

  async function newUser(
    login: string,
    displayName: string,
    options: { password?: boolean } = {},
  ): Promise<string> {
    const user = await createUser(pool, {
      login,
      displayName,
      ...(options.password ? { password: 'correct horse battery staple' } : {}),
    });
    return user.id;
  }

  async function lookUp(query: string, as: ResolvedCaller = caller(workspaceId, ownerId, 'owner')) {
    return (await dispatchCapability({ pool }, as, 'lookup_users', {
      query,
    })) as LookupUsersResultWire;
  }

  const logins = (result: LookupUsersResultWire) => result.items.map((item) => item.login);

  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool, MIGRATIONS_DIR);
    workspaceId = await insertWorkspace(`lookup-${randomUUID().slice(0, 8)}`);
    otherWorkspaceId = await insertWorkspace(`lookup-other-${randomUUID().slice(0, 8)}`);
    ownerId = await insertPrincipal(workspaceId, { role: 'owner' });
    serviceOwnerId = await insertPrincipal(workspaceId, { kind: 'service', role: 'owner' });
    memberId = await insertPrincipal(workspaceId, { role: 'member' });
    operatorId = await insertPrincipal(workspaceId, { role: 'operator' });
    auditorId = await insertPrincipal(workspaceId, { role: 'auditor' });
    disabledOwnerId = await insertPrincipal(workspaceId, { role: 'owner', disabled: true });
    agentOwnerId = await insertPrincipal(workspaceId, { kind: 'agent', role: 'owner' });
    otherOwnerId = await insertPrincipal(otherWorkspaceId, { role: 'owner' });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('an owner finds users by login or display name, whatever the case, and sees login and display name only', async () => {
    const tag = newTag();
    const other = newTag();
    await newUser(`${tag}-alpha`, 'Alpha Person');
    await newUser(`${other}-gamma`, `Gamma ${tag.toUpperCase()}`);

    const found = await lookUp(tag);
    expect(found).toEqual({
      items: [
        { login: `${tag}-alpha`, displayName: 'Alpha Person' },
        { login: `${other}-gamma`, displayName: `Gamma ${tag.toUpperCase()}` },
      ],
    });
    for (const item of found.items)
      expect(Object.keys(item).sort()).toEqual(['displayName', 'login']);

    // Upper case and surrounding spaces find the same users.
    expect(await lookUp(`  ${tag.toUpperCase()}  `)).toEqual(found);
    // A service owner may look up too (add_member is open to it as well).
    expect(await lookUp(tag, caller(workspaceId, serviceOwnerId, 'owner', 'service'))).toEqual(
      found,
    );
  });

  it('leaves out whoever add_member could not add, and keeps whoever it could', async () => {
    const tag = newTag();
    const activeMember = await newUser(`${tag}-member-here`, 'Member Here', { password: true });
    await insertPrincipal(workspaceId, { userId: activeMember });
    const removedMember = await newUser(`${tag}-removed-here`, 'Removed Here', { password: true });
    await insertPrincipal(workspaceId, { userId: removedMember, disabled: true });
    const elsewhere = await newUser(`${tag}-member-elsewhere`, 'Member Elsewhere', {
      password: true,
    });
    await insertPrincipal(otherWorkspaceId, { userId: elsewhere });
    const disabled = await newUser(`${tag}-disabled`, 'Disabled User', { password: true });
    await asAdmin(workspaceId, (client) =>
      client.query(`update users set status = 'disabled' where id = $1`, [disabled]),
    );
    // Awaiting activation: kept with no membership, or with a live one in an active standard
    // workspace; left out as acceptance residue when every live membership is in an ephemeral or
    // a disabled workspace, or every membership was removed.
    await newUser(`${tag}-pending-alone`, 'Pending Alone');
    const pendingStandard = await newUser(`${tag}-pending-standard`, 'Pending Standard');
    await insertPrincipal(otherWorkspaceId, { userId: pendingStandard });
    const ephemeral = await insertWorkspace(`lookup-eph-${tag}`, { purpose: 'ephemeral' });
    const residualEphemeral = await newUser(`${tag}-residual-ephemeral`, 'Residual Ephemeral');
    await insertPrincipal(ephemeral, { userId: residualEphemeral });
    const disabledWs = await insertWorkspace(`lookup-off-${tag}`, { status: 'disabled' });
    const residualDisabledWs = await newUser(`${tag}-residual-disabled-ws`, 'Residual Disabled');
    await insertPrincipal(disabledWs, { userId: residualDisabledWs });
    const residualRemoved = await newUser(`${tag}-residual-removed`, 'Residual Removed');
    await insertPrincipal(otherWorkspaceId, { userId: residualRemoved, disabled: true });

    expect(logins(await lookUp(tag))).toEqual([
      `${tag}-member-elsewhere`,
      `${tag}-pending-alone`,
      `${tag}-pending-standard`,
      `${tag}-removed-here`,
    ]);

    // add_member agrees on the edges: the active member is refused, the removed one is added.
    await expect(
      dispatchCapability({ pool }, caller(workspaceId, ownerId, 'owner'), 'add_member', {
        login: `${tag}-member-here`,
        role: 'member',
      }),
    ).rejects.toThrow(/already a member/);
    await dispatchCapability({ pool }, caller(workspaceId, ownerId, 'owner'), 'add_member', {
      login: `${tag}-removed-here`,
      role: 'member',
    });
    expect(logins(await lookUp(tag))).not.toContain(`${tag}-removed-here`);
  });

  it('matches the query as plain text: % and _ are not wildcards', async () => {
    const tag = newTag();
    await newUser(`${tag}-k`, 'Dash K');
    await newUser(`${tag}_k`, 'Underscore K');

    expect(logins(await lookUp(`${tag}_k`))).toEqual([`${tag}_k`]);
    expect(logins(await lookUp(`${tag}%`))).toEqual([]);
    expect(logins(await lookUp(`${tag.slice(0, 4)}%${tag.slice(5)}`))).toEqual([]);
  });

  it('needs 2 characters: shorter is refused by the schema, or answers nothing once trimmed', async () => {
    await expect(lookUp('a')).rejects.toBeInstanceOf(InvalidCapabilityParamsError);
    await expect(lookUp('x'.repeat(101))).rejects.toBeInstanceOf(InvalidCapabilityParamsError);
    expect(await lookUp(' a ')).toEqual({ items: [] });
  });

  it('answers at most 20, best match first, and says when more matched', async () => {
    const tag = newTag();
    await newUser(tag, 'Exact');
    for (let i = 1; i <= 20; i += 1) {
      await newUser(`${tag}-a${String(i).padStart(2, '0')}`, `Prefix ${i}`);
    }
    await newUser(`m-${newTag()}`, `${tag} Display`);
    await newUser(`a-${tag}`, 'Contains');

    const first = await lookUp(tag);
    expect(first.truncated).toBe(true);
    expect(logins(first)).toEqual([
      tag,
      ...Array.from({ length: 19 }, (_, i) => `${tag}-a${String(i + 1).padStart(2, '0')}`),
    ]);

    // Exactly 20: all of them, and nothing more to say.
    const twenty = newTag();
    for (let i = 1; i <= 20; i += 1) {
      await newUser(`${twenty}-${String(i).padStart(2, '0')}`, 'Twenty');
    }
    const all = await lookUp(twenty);
    expect(all.items).toHaveLength(20);
    expect(all).not.toHaveProperty('truncated');

    // Exact login, then logins and then display names that start with the query, then the rest
    // by login — a display-name match after a login match although its login sorts first.
    const small = newTag();
    await newUser(`a-${small}`, 'Contains');
    const displayFirst = `a0-${newTag()}`;
    await newUser(displayFirst, `${small} Display`);
    await newUser(`${small}-z`, 'Prefix');
    await newUser(small, 'Exact');
    expect(await lookUp(small)).toEqual({
      items: [
        { login: small, displayName: 'Exact' },
        { login: `${small}-z`, displayName: 'Prefix' },
        { login: displayFirst, displayName: `${small} Display` },
        { login: `a-${small}`, displayName: 'Contains' },
      ],
    });
  });

  it('only an owner may call it', async () => {
    const tag = newTag();
    await newUser(`${tag}-x`, 'Anyone');
    for (const [id, role] of [
      [memberId, 'member'],
      [operatorId, 'operator'],
      [auditorId, 'auditor'],
    ] as const) {
      // Refused by the gateway for the role, before the function would refuse it too.
      await expect(lookUp(tag, caller(workspaceId, id, role))).rejects.toSatisfy(
        (err) => err instanceof CapabilityCallRefusedError && err.reason === 'role',
      );
    }
  });

  it('the function answers only an active owner of the transaction’s own workspace (42501 otherwise)', async () => {
    const tag = newTag();
    await newUser(`${tag}-fn`, 'Function');
    const call = (ws: string, principalId: string) =>
      withWorkspace(
        pool,
        { workspaceId: ws, principalId },
        async (client) =>
          (
            await client.query<{ login: string; display_name: string }>(
              'select login, display_name from lookup_users_for_owner($1, 21)',
              [tag],
            )
          ).rows,
      );

    expect(await call(workspaceId, ownerId)).toEqual([
      { login: `${tag}-fn`, display_name: 'Function' },
    ]);
    for (const [ws, principalId] of [
      [workspaceId, memberId],
      [workspaceId, auditorId],
      [workspaceId, disabledOwnerId],
      // An owner, but an agent: not a person nor a service account.
      [workspaceId, agentOwnerId],
      // An owner, but of another workspace than the transaction's.
      [workspaceId, otherOwnerId],
      [workspaceId, randomUUID()],
    ] as const) {
      await expect(call(ws, principalId)).rejects.toMatchObject({ code: '42501' });
    }
    // However much it is asked for, never more than 21 rows.
    for (let i = 1; i <= 22; i += 1) await newUser(`${tag}-many${i}`, 'Many');
    const many = await withWorkspace(
      pool,
      { workspaceId, principalId: ownerId },
      async (client) =>
        (await client.query('select 1 from lookup_users_for_owner($1, 100000)', [tag])).rowCount,
    );
    expect(many).toBe(21);
  });

  it('an owner removed or demoted after the gateway checked is answered 403, not 500', async () => {
    // The handler run straight as a member: what a demotion committed between the gateway's
    // role check and the function's would look like.
    await expect(
      withWorkspace(pool, { workspaceId, principalId: memberId }, (client) =>
        lookupUsersHandler(client, workspaceId, { query: 'lu' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
