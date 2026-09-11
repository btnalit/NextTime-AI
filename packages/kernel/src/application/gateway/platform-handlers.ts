import { randomBytes } from 'node:crypto';
import type {
  PlatformAuditRecordWire,
  PlatformOverviewWire,
  Role,
  UserMembershipWire,
  UserWire,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { setWorkspaceContext } from '../../adapters/db/platform-context.js';
import { hashPassword } from '../identity/password.js';
import { LOGIN_PATTERN, normalizeLogin } from '../identity/users.js';
import {
  DEFAULT_PLATFORM_SETTINGS,
  type PlatformSettings,
  envAdminLogins,
  readPlatformSettings,
  toWirePlatformSettings,
  updatePlatformSettings,
} from '../platform/settings.js';
import type { CapabilityHandler, CapabilityHandlerContext } from './capability-handler.js';
import { readModelCatalog } from './models-catalog-handler.js';

/**
 * application/gateway/platform-handlers: the `scope: 'platform'` capabilities (P-A1;
 * docs/platform-admin-design.md §5, §6.1, §6.6, §6.7). Every handler runs inside
 * `adapters/db/platform-context.ts`'s transaction — role `nexttime_app`, `app.platform = on`, no
 * workspace — so `users` / `user_sessions` / `principals` / `sessions` are reachable through the
 * `*_platform_admin` policies of migrations 0019/0021 and nothing here needs the superuser. The
 * `workspaceId` argument every handler receives is `''` on this path; the acting administrator is
 * `context.platformUser`.
 *
 * Deliberately *not* reusing the identity module's `insertUser`/`setUserPassword`: those run on
 * the admin client and read `password_hash` back (`has_password` is derived from it there);
 * here the application role may write the hash but never select it, so the SQL is written against
 * the 0021 column grants exactly.
 */

export type PlatformErrorCode =
  | 'user_not_found'
  | 'workspace_not_found'
  | 'membership_not_found'
  | 'login_taken'
  | 'already_member'
  | 'already_claimed'
  | 'last_admin'
  | 'last_owner'
  | 'protected_admin'
  | 'weak_password'
  | 'invalid_login'
  | 'workspace_disabled';

/** Mapped by interfaces/http/capability-route.ts: `*_not_found` → 404, the rest → 409. */
export class PlatformAdminError extends Error {
  readonly code: PlatformErrorCode;
  constructor(code: PlatformErrorCode, message: string) {
    super(message);
    this.name = 'PlatformAdminError';
    this.code = code;
  }
}

function actingUser(context: CapabilityHandlerContext | undefined): { id: string; login: string } {
  if (!context?.platformUser) {
    throw new Error('platform handler invoked outside a platform transaction');
  }
  return context.platformUser;
}

// -------------------------------------------------------------------------------------------
// users: read side
// -------------------------------------------------------------------------------------------

interface UserDbRow {
  id: string;
  login: string;
  display_name: string;
  platform_role: 'admin' | 'user';
  status: 'active' | 'disabled';
  has_password: boolean;
  must_change_password: boolean;
  daily_call_limit: number | null;
  monthly_token_budget: string | number | null;
  last_login_at: Date | null;
  created_at: Date;
  /** `created_at::text` — full microsecond precision for the keyset cursor (a JS `Date` only
   *  carries milliseconds, which would re-include or skip boundary rows). */
  created_at_cursor: string;
}

interface MembershipDbRow {
  user_id: string;
  workspace_id: string;
  workspace_name: string;
  workspace_status: 'active' | 'disabled';
  principal_id: string;
  role: Role;
  disabled: boolean;
}

const USER_SELECT = `
  select u.id, u.login, u.display_name, u.platform_role, u.status, u.has_password,
         u.must_change_password, u.daily_call_limit, u.monthly_token_budget, u.created_at,
         u.created_at::text as created_at_cursor,
         (select max(s.created_at) from user_sessions s where s.user_id = u.id) as last_login_at
    from users u`;

function toWireMembership(row: MembershipDbRow): UserMembershipWire {
  return {
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    workspaceStatus: row.workspace_status,
    principalId: row.principal_id,
    role: row.role,
    disabled: row.disabled,
  };
}

async function loadMemberships(
  client: PoolClient,
  userIds: readonly string[],
): Promise<Map<string, UserMembershipWire[]>> {
  const map = new Map<string, UserMembershipWire[]>();
  if (userIds.length === 0) return map;
  const result = await client.query<MembershipDbRow>(
    `select p.user_id, p.workspace_id, w.name as workspace_name, w.status as workspace_status,
            p.id as principal_id, p.role, (p.disabled_at is not null) as disabled
       from principals p
       join workspaces w on w.id = p.workspace_id
      where p.kind = 'human' and p.user_id = any($1::uuid[])
      order by w.created_at, p.created_at`,
    [userIds],
  );
  for (const row of result.rows) {
    const list = map.get(row.user_id) ?? [];
    list.push(toWireMembership(row));
    map.set(row.user_id, list);
  }
  return map;
}

function toWireUser(row: UserDbRow, memberships: readonly UserMembershipWire[]): UserWire {
  return {
    id: row.id,
    login: row.login,
    displayName: row.display_name,
    platformRole: row.platform_role,
    status: row.status,
    hasPassword: row.has_password,
    mustChangePassword: row.must_change_password,
    dailyCallLimit: row.daily_call_limit,
    monthlyTokenBudget: row.monthly_token_budget === null ? null : Number(row.monthly_token_budget),
    lastLoginAt: row.last_login_at ? row.last_login_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    memberships: [...memberships],
  };
}

async function loadUser(client: PoolClient, userId: string): Promise<UserWire> {
  const result = await client.query<UserDbRow>(`${USER_SELECT} where u.id = $1`, [userId]);
  const row = result.rows[0];
  if (!row) throw new PlatformAdminError('user_not_found', 'user not found');
  const memberships = await loadMemberships(client, [row.id]);
  return toWireUser(row, memberships.get(row.id) ?? []);
}

function encodeCursor(row: { created_at_cursor: string; id: string }): string {
  return Buffer.from(`${row.created_at_cursor}|${row.id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = decoded.indexOf('|');
  if (separator < 0) return null;
  return { createdAt: decoded.slice(0, separator), id: decoded.slice(separator + 1) };
}

export const listUsersHandler: CapabilityHandler = async (client, _workspaceId, params) => {
  const { status, query, cursor, limit } = params as {
    status?: 'active' | 'disabled';
    query?: string;
    cursor?: string;
    limit?: number;
  };
  const pageSize = limit ?? 50;
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (status) {
    values.push(status);
    conditions.push(`u.status = $${values.length}`);
  }
  if (query) {
    values.push(`%${query.toLowerCase()}%`);
    conditions.push(
      `(lower(u.login) like $${values.length} or lower(u.display_name) like $${values.length})`,
    );
  }
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (decoded) {
      values.push(decoded.createdAt, decoded.id);
      conditions.push(
        `(u.created_at, u.id) > ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
      );
    }
  }
  values.push(pageSize + 1);
  const where = conditions.length > 0 ? ` where ${conditions.join(' and ')}` : '';
  const result = await client.query<UserDbRow>(
    `${USER_SELECT}${where} order by u.created_at, u.id limit $${values.length}`,
    values,
  );
  const rows = result.rows.slice(0, pageSize);
  const memberships = await loadMemberships(
    client,
    rows.map((r) => r.id),
  );
  const items = rows.map((row) => toWireUser(row, memberships.get(row.id) ?? []));
  const last = rows[rows.length - 1];
  const nextCursor = result.rows.length > pageSize && last ? encodeCursor(last) : undefined;
  return { result: nextCursor ? { items, nextCursor } : { items } };
};

export const listUserMembershipsHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
) => {
  const { userId } = params as { userId: string };
  await loadUser(client, userId);
  const memberships = await loadMemberships(client, [userId]);
  return { result: { items: memberships.get(userId) ?? [] } };
};

// -------------------------------------------------------------------------------------------
// users: write side
// -------------------------------------------------------------------------------------------

function generateTemporaryPassword(): string {
  return randomBytes(12).toString('base64url');
}

function assertPasswordPolicy(password: string, settings: PlatformSettings): void {
  if (password.length < settings.passwordMinLength) {
    throw new PlatformAdminError(
      'weak_password',
      `password must be at least ${settings.passwordMinLength} characters`,
    );
  }
}

interface WorkspaceDbRow {
  id: string;
  name: string;
  status: 'active' | 'disabled';
}

async function loadWorkspace(client: PoolClient, workspaceId: string): Promise<WorkspaceDbRow> {
  const result = await client.query<WorkspaceDbRow>(
    'select id, name, status from workspaces where id = $1',
    [workspaceId],
  );
  const row = result.rows[0];
  if (!row) throw new PlatformAdminError('workspace_not_found', 'workspace not found');
  return row;
}

/** Creates the membership Principal (no API key) under the workspace GUC + platform policy. */
async function insertMembership(
  client: PoolClient,
  input: { userId: string; workspaceId: string; role: Role; displayName: string },
): Promise<UserMembershipWire> {
  const workspace = await loadWorkspace(client, input.workspaceId);
  if (workspace.status !== 'active') {
    throw new PlatformAdminError('workspace_disabled', 'that workspace is disabled');
  }
  const existing = await client.query(
    `select 1 from principals where workspace_id = $1 and user_id = $2 and kind = 'human'`,
    [input.workspaceId, input.userId],
  );
  if ((existing.rowCount ?? 0) > 0) {
    throw new PlatformAdminError(
      'already_member',
      'the user is already a member of that workspace',
    );
  }
  const inserted = await client.query<{ id: string }>(
    `insert into principals (workspace_id, kind, role, display_name, user_id)
     values ($1, 'human', $2, $3, $4)
     returning id`,
    [input.workspaceId, input.role, input.displayName, input.userId],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('add_membership: INSERT ... RETURNING produced no row');
  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceStatus: workspace.status,
    principalId: row.id,
    role: input.role,
    disabled: false,
  };
}

export const createUserHandler: CapabilityHandler = async (client, _workspaceId, params) => {
  const input = params as {
    login: string;
    displayName: string;
    platformRole?: 'admin' | 'user';
    password?: string;
    workspaceId?: string | null;
    role?: Role;
  };
  const { settings } = await readPlatformSettings(client);
  let login: string;
  try {
    login = normalizeLogin(input.login);
  } catch (err) {
    throw new PlatformAdminError('invalid_login', (err as Error).message);
  }
  if (!LOGIN_PATTERN.test(login)) {
    throw new PlatformAdminError('invalid_login', 'login must be 3–64 chars of a-z 0-9 . _ -');
  }
  const temporaryPassword = input.password ?? generateTemporaryPassword();
  assertPasswordPolicy(temporaryPassword, settings);
  const taken = await client.query('select 1 from users where login = $1', [login]);
  if ((taken.rowCount ?? 0) > 0) {
    throw new PlatformAdminError('login_taken', `login "${login}" is already taken`);
  }
  const passwordHash = await hashPassword(temporaryPassword);
  const displayName = input.displayName.trim() || login;
  const inserted = await client.query<{ id: string }>(
    `insert into users (login, display_name, password_hash, platform_role, must_change_password)
     values ($1, $2, $3, $4, true)
     returning id`,
    [login, displayName, passwordHash, input.platformRole ?? settings.defaultPlatformRole],
  );
  const created = inserted.rows[0];
  if (!created) throw new Error('create_user: INSERT ... RETURNING produced no row');

  const workspaceId =
    input.workspaceId === undefined ? settings.defaultWorkspaceId : input.workspaceId;
  if (workspaceId) {
    await insertMembership(client, {
      userId: created.id,
      workspaceId,
      role: input.role ?? 'member',
      displayName,
    });
  }
  const user = await loadUser(client, created.id);
  return {
    result: { user, temporaryPassword },
    resourceType: 'user',
    resourceId: created.id,
  };
};

async function countOtherActiveAdmins(client: PoolClient, userId: string): Promise<number> {
  const result = await client.query<{ n: string }>(
    `select count(*)::text as n from users
      where platform_role = 'admin' and status = 'active' and id <> $1`,
    [userId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

/** The two guards every "take admin away" path shares: never the last active administrator,
 *  never an account NEXTTIME_PLATFORM_ADMINS names (design §6.6, borrowed from cloudflare-os). */
async function assertAdminCanBeReduced(client: PoolClient, user: UserWire): Promise<void> {
  if (envAdminLogins().includes(user.login)) {
    throw new PlatformAdminError(
      'protected_admin',
      `"${user.login}" is a platform administrator by environment configuration and cannot be disabled or demoted here`,
    );
  }
  if (
    user.platformRole === 'admin' &&
    user.status === 'active' &&
    (await countOtherActiveAdmins(client, user.id)) === 0
  ) {
    throw new PlatformAdminError(
      'last_admin',
      'the last active administrator cannot be disabled or demoted',
    );
  }
}

export const updateUserHandler: CapabilityHandler = async (client, _workspaceId, params) => {
  const input = params as { userId: string; displayName?: string; platformRole?: 'admin' | 'user' };
  const before = await loadUser(client, input.userId);
  if (input.platformRole === 'user' && before.platformRole === 'admin') {
    await assertAdminCanBeReduced(client, before);
  }
  await client.query(
    `update users
        set display_name = coalesce($2, display_name),
            platform_role = coalesce($3, platform_role),
            updated_at = now()
      where id = $1`,
    [input.userId, input.displayName?.trim() || null, input.platformRole ?? null],
  );
  if (input.displayName) {
    // Keep the membership Principals' display names in step (the members page reads them).
    await client.query(
      `update principals set display_name = $2 where user_id = $1 and kind = 'human'`,
      [input.userId, input.displayName.trim()],
    );
  }
  return {
    result: await loadUser(client, input.userId),
    resourceType: 'user',
    resourceId: input.userId,
  };
};

async function revokeConsoleSessions(client: PoolClient, userId: string): Promise<void> {
  await client.query(
    'update user_sessions set revoked_at = now() where user_id = $1 and revoked_at is null',
    [userId],
  );
}

async function revokeWorkspaceSessions(client: PoolClient, userId: string): Promise<void> {
  await client.query(
    `update sessions s
        set status = 'revoked', expires_at = now()
       from principals p
      where p.workspace_id = s.workspace_id and p.id = s.principal_id
        and p.user_id = $1 and s.status = 'active'`,
    [userId],
  );
}

export const setUserStatusHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  context,
) => {
  const input = params as { userId: string; status: 'active' | 'disabled' };
  const before = await loadUser(client, input.userId);
  if (input.status === 'disabled') {
    if (before.id === actingUser(context).id) {
      throw new PlatformAdminError('last_admin', 'you cannot disable your own account');
    }
    await assertAdminCanBeReduced(client, before);
  }
  await client.query('update users set status = $2, updated_at = now() where id = $1', [
    input.userId,
    input.status,
  ]);
  if (input.status === 'disabled') {
    await revokeConsoleSessions(client, input.userId);
    await revokeWorkspaceSessions(client, input.userId);
  }
  return {
    result: await loadUser(client, input.userId),
    resourceType: 'user',
    resourceId: input.userId,
  };
};

export const resetUserPasswordHandler: CapabilityHandler = async (client, _workspaceId, params) => {
  const input = params as { userId: string; password?: string };
  await loadUser(client, input.userId);
  const { settings } = await readPlatformSettings(client);
  const temporaryPassword = input.password ?? generateTemporaryPassword();
  assertPasswordPolicy(temporaryPassword, settings);
  const passwordHash = await hashPassword(temporaryPassword);
  await client.query(
    `update users
        set password_hash = $2, must_change_password = true, failed_login_count = 0,
            locked_until = null, updated_at = now()
      where id = $1`,
    [input.userId, passwordHash],
  );
  // A reset ends every existing session, console and workspace alike: whoever held the old
  // password (or a stolen cookie) is out until they log in with the new temporary one.
  await revokeConsoleSessions(client, input.userId);
  await revokeWorkspaceSessions(client, input.userId);
  return {
    result: { userId: input.userId, temporaryPassword },
    resourceType: 'user',
    resourceId: input.userId,
  };
};

export const setUserBudgetHandler: CapabilityHandler = async (client, _workspaceId, params) => {
  const input = params as {
    userId: string;
    dailyCallLimit?: number | null;
    monthlyTokenBudget?: number | null;
  };
  await loadUser(client, input.userId);
  const sets: string[] = ['updated_at = now()'];
  const values: unknown[] = [input.userId];
  if (input.dailyCallLimit !== undefined) {
    values.push(input.dailyCallLimit);
    sets.push(`daily_call_limit = $${values.length}`);
  }
  if (input.monthlyTokenBudget !== undefined) {
    values.push(input.monthlyTokenBudget);
    sets.push(`monthly_token_budget = $${values.length}`);
  }
  await client.query(`update users set ${sets.join(', ')} where id = $1`, values);
  return {
    result: await loadUser(client, input.userId),
    resourceType: 'user',
    resourceId: input.userId,
  };
};

// -------------------------------------------------------------------------------------------
// memberships
// -------------------------------------------------------------------------------------------

export const addMembershipHandler: CapabilityHandler = async (client, _workspaceId, params) => {
  const input = params as { userId: string; workspaceId: string; role: Role };
  const user = await loadUser(client, input.userId);
  const membership = await insertMembership(client, {
    userId: user.id,
    workspaceId: input.workspaceId,
    role: input.role,
    displayName: user.displayName,
  });
  return { result: membership, resourceType: 'principal', resourceId: membership.principalId };
};

async function loadMembership(
  client: PoolClient,
  userId: string,
  workspaceId: string,
): Promise<UserMembershipWire> {
  const memberships = await loadMemberships(client, [userId]);
  const found = (memberships.get(userId) ?? []).find((m) => m.workspaceId === workspaceId);
  if (!found)
    throw new PlatformAdminError(
      'membership_not_found',
      'the user is not a member of that workspace',
    );
  return found;
}

async function countOtherActiveOwners(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<number> {
  const result = await client.query<{ n: string }>(
    `select count(*)::text as n from principals
      where workspace_id = $1 and kind = 'human' and role = 'owner'
        and disabled_at is null and id <> $2`,
    [workspaceId, principalId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

export const setMembershipRoleHandler: CapabilityHandler = async (client, _workspaceId, params) => {
  const input = params as { userId: string; workspaceId: string; role: Role };
  const membership = await loadMembership(client, input.userId, input.workspaceId);
  if (
    membership.role === 'owner' &&
    input.role !== 'owner' &&
    !membership.disabled &&
    (await countOtherActiveOwners(client, input.workspaceId, membership.principalId)) === 0
  ) {
    throw new PlatformAdminError('last_owner', 'the last owner of a workspace cannot be demoted');
  }
  await client.query('update principals set role = $3 where workspace_id = $1 and id = $2', [
    input.workspaceId,
    membership.principalId,
    input.role,
  ]);
  // The entry Handle is re-minted with the new role on the next turn (S3.11); current workspace
  // sessions of this Principal are ended so no stale-role session outlives the change.
  await setWorkspaceContext(client, input.workspaceId, membership.principalId);
  await client.query(
    `update sessions set status = 'revoked', expires_at = now()
      where workspace_id = $1 and principal_id = $2 and status = 'active'`,
    [input.workspaceId, membership.principalId],
  );
  const after = await loadMembership(client, input.userId, input.workspaceId);
  return { result: after, resourceType: 'principal', resourceId: membership.principalId };
};

export const removeMembershipHandler: CapabilityHandler = async (client, _workspaceId, params) => {
  const input = params as { userId: string; workspaceId: string };
  const membership = await loadMembership(client, input.userId, input.workspaceId);
  if (
    membership.role === 'owner' &&
    !membership.disabled &&
    (await countOtherActiveOwners(client, input.workspaceId, membership.principalId)) === 0
  ) {
    throw new PlatformAdminError('last_owner', 'the last owner of a workspace cannot be removed');
  }
  await client.query(
    `update principals set disabled_at = coalesce(disabled_at, now())
      where workspace_id = $1 and id = $2`,
    [input.workspaceId, membership.principalId],
  );
  await client.query(
    `update sessions set status = 'revoked', expires_at = now()
      where workspace_id = $1 and principal_id = $2 and status = 'active'`,
    [input.workspaceId, membership.principalId],
  );
  return {
    result: { userId: input.userId, workspaceId: input.workspaceId, removed: true },
    resourceType: 'principal',
    resourceId: membership.principalId,
  };
};

export const mergeUserHandler: CapabilityHandler = async (client, _workspaceId, params) => {
  const input = params as { sourceUserId: string; targetUserId: string };
  if (input.sourceUserId === input.targetUserId) {
    throw new PlatformAdminError('already_claimed', 'source and target are the same user');
  }
  const source = await loadUser(client, input.sourceUserId);
  const target = await loadUser(client, input.targetUserId);
  if (source.hasPassword) {
    throw new PlatformAdminError(
      'already_claimed',
      'only a user without a password can be merged — an API key must never take over a password-protected account',
    );
  }
  const targetWorkspaces = new Set(target.memberships.map((m) => m.workspaceId));
  const clash = source.memberships.find((m) => targetWorkspaces.has(m.workspaceId));
  if (clash) {
    throw new PlatformAdminError(
      'already_member',
      `both users hold a membership in workspace "${clash.workspaceName}"; remove one first`,
    );
  }
  await client.query(`update principals set user_id = $2 where user_id = $1 and kind = 'human'`, [
    source.id,
    target.id,
  ]);
  await client.query('delete from user_sessions where user_id = $1', [source.id]);
  await client.query('delete from users where id = $1', [source.id]);
  return { result: await loadUser(client, target.id), resourceType: 'user', resourceId: target.id };
};

// -------------------------------------------------------------------------------------------
// platform settings
// -------------------------------------------------------------------------------------------

export const getPlatformSettingsHandler: CapabilityHandler = async (client) => {
  return { result: toWirePlatformSettings(await readPlatformSettings(client)) };
};

export const updatePlatformSettingsHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  context,
) => {
  const patch = params as Partial<PlatformSettings>;
  if (patch.defaultWorkspaceId) {
    const workspace = await loadWorkspace(client, patch.defaultWorkspaceId);
    if (workspace.status !== 'active') {
      throw new PlatformAdminError('workspace_disabled', 'the default workspace must be active');
    }
  }
  const row = await updatePlatformSettings(client, patch, actingUser(context).id);
  return {
    result: toWirePlatformSettings(row),
    resourceType: 'platform_settings',
    resourceId: undefined,
  };
};

// -------------------------------------------------------------------------------------------
// platform audit
// -------------------------------------------------------------------------------------------

interface AuditDbRow {
  id: string;
  action: string;
  actor_user_id: string;
  actor_login: string | null;
  resource_type: string | null;
  resource_id: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
  created_at_cursor: string;
}

function toWireAudit(row: AuditDbRow): PlatformAuditRecordWire {
  return {
    id: row.id,
    action: row.action,
    actorUserId: row.actor_user_id,
    actorLogin: row.actor_login,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
  };
}

const PLATFORM_AUDIT_SELECT = `
  select a.id, a.action, a.actor_user_id, u.login as actor_login, a.resource_type, a.resource_id,
         a.payload, a.created_at, a.created_at::text as created_at_cursor
    from audit_records a
    left join users u on u.id = a.actor_user_id
   where a.workspace_id is null`;

async function queryPlatformAudit(
  client: PoolClient,
  filter: {
    actorUserId?: string;
    action?: string;
    targetUserId?: string;
    targetWorkspaceId?: string;
    cursor?: string;
    limit: number;
  },
): Promise<{ items: PlatformAuditRecordWire[]; nextCursor?: string }> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (filter.actorUserId) {
    values.push(filter.actorUserId);
    conditions.push(`a.actor_user_id = $${values.length}`);
  }
  if (filter.action) {
    values.push(filter.action);
    conditions.push(`a.action = $${values.length}`);
  }
  if (filter.targetUserId) {
    values.push(filter.targetUserId);
    conditions.push(
      `(a.payload->'params'->>'userId' = $${values.length} or a.payload->'params'->>'targetUserId' = $${values.length} or a.payload->'params'->>'sourceUserId' = $${values.length} or (a.resource_type = 'user' and a.resource_id::text = $${values.length}))`,
    );
  }
  if (filter.targetWorkspaceId) {
    values.push(filter.targetWorkspaceId);
    conditions.push(`a.payload->'params'->>'workspaceId' = $${values.length}`);
  }
  if (filter.cursor) {
    const decoded = decodeCursor(filter.cursor);
    if (decoded) {
      values.push(decoded.createdAt, decoded.id);
      conditions.push(
        `(a.created_at, a.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
      );
    }
  }
  values.push(filter.limit + 1);
  const where = conditions.length > 0 ? ` and ${conditions.join(' and ')}` : '';
  const result = await client.query<AuditDbRow>(
    `${PLATFORM_AUDIT_SELECT}${where} order by a.created_at desc, a.id desc limit $${values.length}`,
    values,
  );
  const rows = result.rows.slice(0, filter.limit);
  const last = rows[rows.length - 1];
  const nextCursor = result.rows.length > filter.limit && last ? encodeCursor(last) : undefined;
  const items = rows.map(toWireAudit);
  return nextCursor ? { items, nextCursor } : { items };
}

export const platformAuditQueryHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
) => {
  const input = params as {
    actorUserId?: string;
    action?: string;
    targetUserId?: string;
    targetWorkspaceId?: string;
    cursor?: string;
    limit?: number;
  };
  return { result: await queryPlatformAudit(client, { ...input, limit: input.limit ?? 50 }) };
};

// -------------------------------------------------------------------------------------------
// overview
// -------------------------------------------------------------------------------------------

async function countGatekeepers(
  client: PoolClient,
  workspaces: readonly WorkspaceDbRow[],
): Promise<number> {
  // Gatekeepers are `objects` rows (object_type 'Gatekeeper', governance/gatekeepers/registry.ts)
  // behind the workspace RLS policy — count per workspace under its GUC.
  let total = 0;
  for (const workspace of workspaces) {
    await setWorkspaceContext(client, workspace.id, '00000000-0000-0000-0000-000000000000');
    const result = await client.query<{ n: string }>(
      `select count(*)::text as n from objects where workspace_id = $1 and object_type = 'Gatekeeper'`,
      [workspace.id],
    );
    total += Number(result.rows[0]?.n ?? '0');
  }
  await client.query("select set_config('app.workspace_id', '', true)");
  await client.query("select set_config('app.principal_id', '', true)");
  return total;
}

export const platformOverviewHandler: CapabilityHandler = async (client) => {
  const { settings } = await readPlatformSettings(client);
  const users = await client.query<{ total: string; active: string; pending: string }>(
    `select count(*)::text as total,
            count(*) filter (where status = 'active')::text as active,
            count(*) filter (where not has_password)::text as pending
       from users`,
  );
  const workspaces = await client.query<WorkspaceDbRow>(
    'select id, name, status from workspaces order by created_at',
  );
  const migrations = await client
    .query<{ n: string; latest: string | null }>(
      `select count(*)::text as n, max(lpad(version::text, 4, '0') || '_' || name) as latest
       from schema_migrations where module = 'core'`,
    )
    .catch(() => ({ rows: [{ n: '0', latest: null }] }));
  let modelsAvailable = 0;
  let modelsStatus: 'ok' | 'down' = 'ok';
  try {
    modelsAvailable = (await readModelCatalog()).length;
  } catch {
    modelsStatus = 'down';
  }
  const gatekeepers = await countGatekeepers(client, workspaces.rows);
  const recent = await queryPlatformAudit(client, { limit: 20 });

  const activeWorkspaces = workspaces.rows.filter((w) => w.status === 'active');
  const defaultWorkspace = settings.defaultWorkspaceId
    ? workspaces.rows.find((w) => w.id === settings.defaultWorkspaceId)
    : undefined;
  const activeUsers = Number(users.rows[0]?.active ?? '0');
  const overview: PlatformOverviewWire = {
    version: {
      kernel: process.env.KERNEL_VERSION ?? 'dev',
      migrationsApplied: Number(migrations.rows[0]?.n ?? '0'),
      latestMigration: migrations.rows[0]?.latest ?? null,
    },
    counts: {
      users: Number(users.rows[0]?.total ?? '0'),
      activeUsers,
      pendingActivationUsers: Number(users.rows[0]?.pending ?? '0'),
      workspaces: workspaces.rows.length,
      activeWorkspaces: activeWorkspaces.length,
      gatekeepers,
      modelsAvailable,
    },
    health: [
      { service: 'kernel', status: 'ok' },
      { service: 'postgres', status: 'ok' },
      {
        service: 'llm-proxy',
        status: modelsStatus === 'ok' ? 'ok' : 'degraded',
        detail:
          modelsStatus === 'ok'
            ? `${modelsAvailable} model(s) in models.json`
            : 'models.json unreadable — provider configuration missing?',
      },
    ],
    checklist: [
      {
        key: 'providers',
        done: modelsAvailable > 0,
        detail:
          modelsAvailable > 0
            ? `${modelsAvailable} model(s) available; default ${settings.defaultEntryModel ?? DEFAULT_PLATFORM_SETTINGS.defaultEntryModel ?? 'pi default'}`
            : 'no model available — configure a provider on the host (llm-providers.yaml)',
      },
      {
        key: 'defaultWorkspace',
        done: defaultWorkspace !== undefined && defaultWorkspace.status === 'active',
        detail: defaultWorkspace
          ? `default workspace "${defaultWorkspace.name}"${defaultWorkspace.status === 'active' ? '' : ' (disabled)'}`
          : 'no default workspace — pick one in platform settings',
      },
      {
        key: 'integrations',
        done: gatekeepers > 0,
        detail:
          gatekeepers > 0
            ? `${gatekeepers} gatekeeper(s) registered`
            : 'no gatekeeper registered yet — connect a system from the workspace configuration',
      },
      {
        key: 'users',
        done: activeUsers > 1,
        detail:
          activeUsers > 1
            ? `${activeUsers} active user(s)`
            : 'only the administrator so far — create users',
      },
      {
        key: 'runtime',
        done: true,
        detail:
          'pi / runtime image consistency is enforced by CI (check-pi-version-consistency); the runtime page lands in P-C',
      },
    ],
    recentAudit: recent.items,
  };
  return { result: overview };
};
