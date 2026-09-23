import { randomBytes, randomUUID } from 'node:crypto';
import type {
  PlatformAuditRecordWire,
  PlatformOverviewWire,
  PlatformWorkspaceWire,
  PurgeUserOutcomeWire,
  PurgeUsersResultWire,
  PurgeWorkspaceResultWire,
  Role,
  UserMembershipWire,
  UserWire,
  WorkspaceOwnerWire,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { setWorkspaceContext, withPlatform } from '../../adapters/db/platform-context.js';
import type { PoolLike } from '../../adapters/db/pool.js';
import { modelPolicyViolation } from '../../governance/agent-profile/index.js';
import { revokeRoleScopedSessionHandles } from '../../governance/capability/index.js';
import { writeAudit } from '../../substrate/audit/index.js';
import type { OntologyEnforcement } from '../../substrate/graph/index.js';
import { hashPassword } from '../identity/password.js';
import { LOGIN_PATTERN, effectivePlatformRole, normalizeLogin } from '../identity/users.js';
import {
  PurgeWorkspaceRefusedError,
  assessPurgeEligibility,
  findUserReferences,
  purgeWorkspace,
} from '../platform/purge-workspace.js';
import {
  DEFAULT_PLATFORM_SETTINGS,
  type PlatformSettings,
  envAdminLogins,
  readPlatformSettings,
  toWirePlatformSettings,
  updatePlatformSettings,
} from '../platform/settings.js';
import { getConfiguredTaskRuntime } from '../task/runtime.js';
import { createWorkspaceWithOwner } from '../workspace/create.js';
import type { WorkspacePurpose } from '../workspace/create.js';
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
  /** S6 C10: "cannot disable your own account" — split out of `last_admin`, which is kept for
   *  the real last-active-administrator case; the console renders each with its own text. */
  | 'self_disable'
  | 'last_owner'
  | 'protected_admin'
  | 'weak_password'
  | 'invalid_login'
  | 'workspace_disabled'
  // P-A2 (workspace configuration)
  | 'user_disabled'
  | 'default_workspace'
  | 'unknown_model'
  | 'entry_model_not_allowed'
  // P-B1 (platform-gates-handlers.ts)
  | 'connector_not_found'
  | 'connector_mode_not_allowed'
  | 'gate_not_found'
  | 'trust_not_applicable'
  | 'runtime_not_found'
  // P-B2a (gate-host instances)
  | 'gate_id_taken'
  | 'gate_in_use'
  | 'gate_not_hosted'
  | 'credential_mode_mismatch'
  // S6 A1 (`purge_workspace`; application/platform/purge-workspace.ts)
  | 'workspace_active'
  | 'retention_not_elapsed'
  // S7-E (P-C §6.5; application/platform/runtime.ts)
  | 'image_not_in_inventory'
  | 'runtime_unreachable'
  | 'no_previous_settings_version';

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
    platformRole: effectivePlatformRole(row.login, row.platform_role),
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

/**
 * S6 A6 (`list_users {hideResidual}`): a *residual* user is one awaiting activation
 * (`has_password = false`) who holds at least one membership and none of whose non-disabled
 * memberships is in an active `standard` workspace — every one sits in a disabled workspace or an
 * `ephemeral` one (an acceptance run, a demo). Those are the "重复的、看不懂的用户" of A6: they
 * leave with their workspace (`purge_workspace`, §4 edge (b)) and the page hides them by default
 * until then. A user with no membership at all, or with a membership somewhere real, is never
 * residual whatever their password state. Expressed as SQL so the keyset cursor stays exact.
 */
const RESIDUAL_USER_CONDITION = `
  (u.has_password = false
   and exists (select 1 from principals p where p.user_id = u.id and p.kind = 'human')
   and not exists (
     select 1 from principals p
       join workspaces w on w.id = p.workspace_id
      where p.user_id = u.id and p.kind = 'human' and p.disabled_at is null
        and w.status = 'active' and w.purpose = 'standard'
   ))`;

export const listUsersHandler: CapabilityHandler = async (client, _workspaceId, params) => {
  const { status, query, pendingOnly, hideResidual, cursor, limit } = params as {
    status?: 'active' | 'disabled';
    query?: string;
    pendingOnly?: boolean;
    hideResidual?: boolean;
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
  if (pendingOnly) conditions.push('u.has_password = false');
  if (hideResidual) conditions.push(`not ${RESIDUAL_USER_CONDITION}`);
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
      // C10: its own code — the last-admin rule below is a different refusal with different
      // advice (make someone else an administrator first vs. ask another administrator).
      throw new PlatformAdminError('self_disable', 'you cannot disable your own account');
    }
    await assertAdminCanBeReduced(client, before);
  }
  await client.query('update users set status = $2, updated_at = now() where id = $1', [
    input.userId,
    input.status,
  ]);
  let principalIds: string[] = [];
  if (input.status === 'disabled') {
    await revokeConsoleSessions(client, input.userId);
    await revokeWorkspaceSessions(client, input.userId);
    principalIds = await listHumanPrincipalIds(client, { userId: input.userId });
  }
  const result = await loadUser(client, input.userId);
  return {
    result,
    resourceType: 'user',
    resourceId: input.userId,
    // P-A2 (design §8 "停用用户 … 入口容器 stop"; a P-A1 gap): once the sessions are gone, stop
    // the user's resident entry containers too — best-effort, after commit.
    afterCommit: async () => {
      await stopEntryContainers(principalIds);
      return result;
    },
  };
};

export const resetUserPasswordHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  context,
) => {
  const input = params as { userId: string; password?: string };
  const target = await loadUser(client, input.userId);
  if (envAdminLogins().includes(target.login) && target.id !== actingUser(context).id) {
    // The env-pinned administrator is the anti-lockout backstop (design §6.6): a hijacked admin
    // session must not be able to take that account over by resetting its password.
    throw new PlatformAdminError(
      'protected_admin',
      `"${target.login}" is a platform administrator by environment configuration; only they can change their password`,
    );
  }
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
  if (input.role !== membership.role) {
    // Same as the workspace-side `set_principal_role` (W5.5, leftover 18): Handles minted under
    // the old role carry its capability set until ttl unless revoked here.
    await revokeRoleScopedSessionHandles(client, input.workspaceId, membership.principalId);
  }
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
// workspaces (P-A2 — docs/platform-admin-design.md §2 "工作区配置归管理面", §5 "工作区配置",
// development-tasks.md P-A2 deliverable 1). The platform view of a workspace joins its
// AgentPolicy (governance 0011 opened `agent_policies` to the platform policy): `default_model`
// is the entry model the runtime actually resolves (governance/agent-profile/resolve.ts), mirrored
// in `workspaces.entry_model`; `allowed_models` is what "我的智能体" narrows to.
// -------------------------------------------------------------------------------------------

interface PlatformWorkspaceDbRow {
  id: string;
  name: string;
  status: 'active' | 'disabled';
  entry_model: string | null;
  ontology_enforcement: OntologyEnforcement;
  purpose: WorkspacePurpose;
  expires_at: Date | null;
  /** S6 (migration core 0030): stamped by `set_workspace_status`; null while active or when the
   *  row was disabled before 0030 (then purgeable at once — §12 决定 3). */
  disabled_at: Date | null;
  created_at: Date;
  default_model: string | null;
  allowed_models: unknown;
  member_count: number;
}

const WORKSPACE_SELECT = `
  select w.id, w.name, w.status, w.entry_model, w.ontology_enforcement, w.purpose, w.expires_at,
         w.disabled_at, w.created_at,
         ap.default_model, coalesce(ap.allowed_models, '[]'::jsonb) as allowed_models,
         (select count(*)::int from principals p
           where p.workspace_id = w.id and p.kind = 'human' and p.user_id is not null
             and p.disabled_at is null) as member_count
    from workspaces w
    left join agent_policies ap on ap.workspace_id = w.id`;

function allowedModelsOf(row: PlatformWorkspaceDbRow): string[] {
  return Array.isArray(row.allowed_models)
    ? row.allowed_models.filter((m): m is string => typeof m === 'string')
    : [];
}

/** The entry model as the runtime sees it: the AgentPolicy's `defaultModel` first (that is what
 *  `resolveEffectiveAgentProfile` reads), the bootstrap-time `workspaces.entry_model` otherwise. */
function entryModelOf(row: PlatformWorkspaceDbRow): string | null {
  return row.default_model ?? row.entry_model ?? null;
}

async function loadOwners(
  client: PoolClient,
  workspaceIds: readonly string[],
): Promise<Map<string, WorkspaceOwnerWire[]>> {
  const owners = new Map<string, WorkspaceOwnerWire[]>();
  if (workspaceIds.length === 0) return owners;
  const result = await client.query<{
    workspace_id: string;
    principal_id: string;
    user_id: string;
    login: string;
    display_name: string;
  }>(
    `select p.workspace_id, p.id as principal_id, u.id as user_id, u.login, u.display_name
       from principals p
       join users u on u.id = p.user_id
      where p.workspace_id = any($1::uuid[]) and p.kind = 'human' and p.role = 'owner'
        and p.disabled_at is null
      order by u.login`,
    [workspaceIds],
  );
  for (const row of result.rows) {
    const list = owners.get(row.workspace_id) ?? [];
    list.push({
      userId: row.user_id,
      login: row.login,
      displayName: row.display_name,
      principalId: row.principal_id,
    });
    owners.set(row.workspace_id, list);
  }
  return owners;
}

function toWirePlatformWorkspace(
  row: PlatformWorkspaceDbRow,
  owners: readonly WorkspaceOwnerWire[],
  defaultWorkspaceId: string | null,
): PlatformWorkspaceWire {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    entryModel: entryModelOf(row),
    allowedModels: allowedModelsOf(row),
    ontologyEnforcement: row.ontology_enforcement,
    purpose: row.purpose,
    expiresAt: row.expires_at?.toISOString() ?? null,
    disabledAt: row.disabled_at?.toISOString() ?? null,
    // S6: the same rule `purge_workspace` applies (application/platform/purge-workspace.ts), so the
    // console shows the purge entry exactly when the call would succeed.
    purgeable:
      defaultWorkspaceId !== row.id &&
      assessPurgeEligibility({
        status: row.status,
        purpose: row.purpose,
        expiresAt: row.expires_at,
        disabledAt: row.disabled_at,
      }).eligible,
    isDefault: defaultWorkspaceId === row.id,
    memberCount: row.member_count,
    owners: [...owners],
    createdAt: row.created_at.toISOString(),
  };
}

async function loadPlatformWorkspaceRow(
  client: PoolClient,
  workspaceId: string,
): Promise<PlatformWorkspaceDbRow> {
  const result = await client.query<PlatformWorkspaceDbRow>(`${WORKSPACE_SELECT} where w.id = $1`, [
    workspaceId,
  ]);
  const row = result.rows[0];
  if (!row) throw new PlatformAdminError('workspace_not_found', 'workspace not found');
  return row;
}

async function loadPlatformWorkspace(
  client: PoolClient,
  workspaceId: string,
): Promise<PlatformWorkspaceWire> {
  // S5.5 leftover 34: one client, one query at a time (pg@9 rejects concurrent queries on a client).
  const row = await loadPlatformWorkspaceRow(client, workspaceId);
  const owners = await loadOwners(client, [workspaceId]);
  const { settings } = await readPlatformSettings(client);
  return toWirePlatformWorkspace(row, owners.get(row.id) ?? [], settings.defaultWorkspaceId);
}

/** Every model id must be in the llm-proxy catalog (the same rule `set_agent_profile` applies). */
async function assertModelsInCatalog(models: readonly string[]): Promise<void> {
  if (models.length === 0) return;
  const known = new Set((await readModelCatalog()).map((entry) => entry.id));
  const unknown = models.filter((model) => !known.has(model));
  if (unknown.length > 0) {
    throw new PlatformAdminError(
      'unknown_model',
      `model(s) not in the llm-proxy catalog: ${unknown.join(', ')}`,
    );
  }
}

/**
 * A non-empty allow-list must contain the entry model, and there must be one: otherwise
 * `resolveEffectiveAgentProfile` (which caps by the list) resolves to `''` and the runtime falls
 * through to the entry WorkerDefinition's own `model` / pi's default — a model the administrator
 * just said the workspace may not use.
 */
function assertEntryModelAllowed(
  entryModel: string | null,
  allowedModels: readonly string[],
): void {
  // Shared with the owner's `set_agent_policy` (agent-profile-handlers.ts) — one rule, two planes.
  const violation = modelPolicyViolation(entryModel, allowedModels);
  if (violation) throw new PlatformAdminError('entry_model_not_allowed', violation);
}

/** Upserts the AgentPolicy's `default_model` / `allowed_models` from the platform plane (governance
 *  0011 policy). `updated_by` is a Principal FK and the platform plane has none, so it is cleared;
 *  the platform audit row carries the acting administrator. */
async function writeWorkspaceModelPolicy(
  client: PoolClient,
  workspaceId: string,
  patch: { defaultModel?: string | null; allowedModels?: readonly string[] },
): Promise<void> {
  await client.query(
    `insert into agent_policies (workspace_id, default_model, allowed_models, updated_by, updated_at)
     values ($1, $2, coalesce($3::jsonb, '[]'::jsonb), null, now())
     on conflict (workspace_id) do update set
       default_model = case when $4 then excluded.default_model else agent_policies.default_model end,
       allowed_models = coalesce($3::jsonb, agent_policies.allowed_models),
       updated_by = null,
       updated_at = now()`,
    [
      workspaceId,
      patch.defaultModel ?? null,
      patch.allowedModels === undefined ? null : JSON.stringify(patch.allowedModels),
      patch.defaultModel !== undefined,
    ],
  );
}

async function listHumanPrincipalIds(
  client: PoolClient,
  filter: { workspaceId: string } | { userId: string },
): Promise<string[]> {
  const result =
    'workspaceId' in filter
      ? await client.query<{ id: string }>(
          `select id from principals where workspace_id = $1 and kind = 'human' and disabled_at is null`,
          [filter.workspaceId],
        )
      : await client.query<{ id: string }>(
          `select id from principals where user_id = $1 and kind = 'human' and disabled_at is null`,
          [filter.userId],
        );
  return result.rows.map((row) => row.id);
}

/**
 * Best-effort, after commit: ask worker-supervisor to stop each principal's resident entry
 * container (`POST /resident/stop`; design §8). Sessions were already revoked in the transaction,
 * so a container that survives (supervisor unreachable, runtime not configured in a unit test)
 * can no longer act — the stop only reclaims resources sooner. Never throws.
 */
async function stopEntryContainers(principalIds: readonly string[]): Promise<void> {
  if (principalIds.length === 0) return;
  let stop: ((principalId: string) => Promise<boolean>) | undefined;
  try {
    const client = getConfiguredTaskRuntime().supervisorClient;
    stop = client.stopResident?.bind(client);
  } catch {
    return; // no task runtime configured (unit tests / CLI) — nothing to stop
  }
  if (!stop) return;
  for (const principalId of principalIds) {
    try {
      await stop(principalId);
    } catch {
      // Logged nowhere on purpose: the failure carries no state the platform relies on.
    }
  }
}

export const listWorkspacesHandler: CapabilityHandler = async (client, _workspaceId, params) => {
  // S6 A1: no filter = every workspace, as before; `status` / `purpose` narrow; `includeExpired:
  // false` drops ephemeral workspaces past their expiry (the console's default view passes
  // `{status: 'active', includeExpired: false}` — an expired ephemeral workspace is purgeable
  // residue, not something to configure).
  const input = params as {
    status?: 'active' | 'disabled';
    purpose?: WorkspacePurpose;
    includeExpired?: boolean;
  };
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (input.status) {
    values.push(input.status);
    conditions.push(`w.status = $${values.length}`);
  }
  if (input.purpose) {
    values.push(input.purpose);
    conditions.push(`w.purpose = $${values.length}`);
  }
  if (input.includeExpired === false) {
    conditions.push(
      `not (w.purpose = 'ephemeral' and w.expires_at is not null and w.expires_at < now())`,
    );
  }
  const where = conditions.length > 0 ? ` where ${conditions.join(' and ')}` : '';
  const result = await client.query<PlatformWorkspaceDbRow>(
    `${WORKSPACE_SELECT}${where} order by w.created_at, w.id`,
    values,
  );
  const owners = await loadOwners(
    client,
    result.rows.map((row) => row.id),
  );
  const { settings } = await readPlatformSettings(client);
  return {
    result: {
      items: result.rows.map((row) =>
        toWirePlatformWorkspace(row, owners.get(row.id) ?? [], settings.defaultWorkspaceId),
      ),
    },
  };
};

export const listPlatformModelsHandler: CapabilityHandler = async () => {
  return { result: { items: await readModelCatalog() } };
};

export const createWorkspaceHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  context,
) => {
  const input = params as {
    name: string;
    ownerUserId: string;
    entryModel?: string;
    allowedModels?: string[];
    ontologyEnforcement?: OntologyEnforcement;
  };
  const acting = actingUser(context);
  const owner = await loadUser(client, input.ownerUserId);
  if (owner.status !== 'active') {
    throw new PlatformAdminError('user_disabled', 'the owner must be an active user');
  }
  const allowedModels = input.allowedModels ?? [];
  await assertModelsInCatalog([...(input.entryModel ? [input.entryModel] : []), ...allowedModels]);
  assertEntryModelAllowed(input.entryModel ?? null, allowedModels);

  // P-B2b (§5d S7-D 决定 D4): the platform setting `defaultModules` this new workspace installs,
  // read here (this platform transaction can read `platform_settings`) so the bootstrap call below
  // — which runs with no platform context at all — never has to.
  const { settings } = await readPlatformSettings(client);

  // The workspace itself is created after this platform transaction commits: bootstrap needs the
  // superuser path (`workspaces` insert, meta-ontology seed, default modules, entry WorkerDefinition
  // — application/workspace/create.ts), which a platform transaction deliberately does not have.
  // The id is fixed here so the audit row written with this phase names the workspace; if the
  // bootstrap then fails, the caller sees the error and the audit row records an attempt with no
  // matching workspace (see development-tasks.md P-A2 实现说明).
  const workspaceId = randomUUID();

  // D4: "平台审计 workspace.created 的 details 记 defaultModules，Activity 记 triggeredBy:
  // create_workspace" — a second, hand-written audit row alongside dispatch.ts's own automatic
  // `create_workspace` row (same pattern `purgeUserHandler`'s own `platform.user_purged` row uses
  // for detail the generic `{channel, params}` payload cannot carry). Written here, in phase 1,
  // like the automatic row: it records the *configured* default-module list at the moment of the
  // call, not a post-hoc confirmation that every install actually succeeded (`afterCommit` below
  // can still fail after this commits — the same pre-existing caveat this function's own comment
  // above already documents for `create_workspace` itself). No separate substrate Activity object
  // is created for the installs themselves (`application/workspace/create.ts`'s `defaultModules`
  // branch deliberately mirrors `seedPlatformMetaOntology`'s own no-Activity precedent) —
  // `triggeredBy` is carried on this audit row's payload instead, which is what a human or agent
  // asking "who/what caused these OntologyVersion rows" actually reads (`platform_audit_query`),
  // and the rows themselves already carry `proposed_by`/`published_by` = the new owner Principal so
  // the owner side of "负责人（管理员）与名下（owner）都可回答" is answerable straight from the graph.
  await writeAudit(client, {
    workspaceId: null,
    actorPrincipalId: null,
    actorUserId: acting.id,
    action: 'workspace.created',
    resourceType: 'workspace',
    resourceId: workspaceId,
    payload: {
      channel: 'platform',
      actorLogin: acting.login,
      details: { defaultModules: settings.defaultModules },
      triggeredBy: 'create_workspace',
    },
  });

  return {
    result: { workspaceId },
    resourceType: 'workspace',
    resourceId: workspaceId,
    afterCommit: async (pool: PoolLike) => {
      await createWorkspaceWithOwner(pool, {
        workspaceId,
        name: input.name,
        owner: { userId: owner.id, displayName: owner.displayName },
        entryModel: input.entryModel,
        allowedModels,
        ontologyEnforcement: input.ontologyEnforcement,
        defaultModules: settings.defaultModules,
      });
      return withPlatform(pool, { userId: acting.id }, (platformClient) =>
        loadPlatformWorkspace(platformClient, workspaceId),
      );
    },
  };
};

export const updateWorkspaceHandler: CapabilityHandler = async (client, _workspaceId, params) => {
  // `entryModel` cannot be cleared here (the wire keeps it non-nullable): the entry
  // WorkerDefinition pins the bootstrap model in its own published content, so "null" would only
  // hide that model from `list_workspaces` while containers kept running it (review finding).
  const input = params as {
    workspaceId: string;
    name?: string;
    entryModel?: string;
    ontologyEnforcement?: OntologyEnforcement;
  };
  const before = await loadPlatformWorkspaceRow(client, input.workspaceId);
  if (input.entryModel !== undefined) {
    await assertModelsInCatalog([input.entryModel]);
    assertEntryModelAllowed(input.entryModel, allowedModelsOf(before));
  }
  if (input.name !== undefined) {
    await client.query('update workspaces set name = $2 where id = $1', [
      input.workspaceId,
      input.name,
    ]);
  }
  // S5.1 (migration core 0025): the administrator's rollout switch — `warn` while a host's
  // writers are being checked against the ontology, `reject` once I-S5-1 reads 0.
  if (input.ontologyEnforcement !== undefined) {
    await client.query('update workspaces set ontology_enforcement = $2 where id = $1', [
      input.workspaceId,
      input.ontologyEnforcement,
    ]);
  }
  if (input.entryModel !== undefined) {
    await client.query('update workspaces set entry_model = $2 where id = $1', [
      input.workspaceId,
      input.entryModel,
    ]);
    await writeWorkspaceModelPolicy(client, input.workspaceId, { defaultModel: input.entryModel });
  }
  return {
    result: await loadPlatformWorkspace(client, input.workspaceId),
    resourceType: 'workspace',
    resourceId: input.workspaceId,
  };
};

export const setWorkspaceStatusHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
) => {
  const input = params as { workspaceId: string; status: 'active' | 'disabled' };
  await loadPlatformWorkspaceRow(client, input.workspaceId);
  let principalIds: string[] = [];
  if (input.status === 'disabled') {
    const { settings } = await readPlatformSettings(client);
    if (settings.defaultWorkspaceId === input.workspaceId) {
      throw new PlatformAdminError(
        'default_workspace',
        'the platform default workspace cannot be disabled — pick another default first',
      );
    }
    // Every session in the workspace — entry, Worker, MCP, service — under `sessions_platform_admin`.
    await client.query(
      `update sessions set status = 'revoked', expires_at = now()
        where workspace_id = $1 and status = 'active'`,
      [input.workspaceId],
    );
    principalIds = await listHumanPrincipalIds(client, { workspaceId: input.workspaceId });
  }
  // S6 (migration core 0030): `disabled_at` starts the 7-day purge retention clock; re-enabling
  // clears it (a later disable starts a fresh clock). `coalesce` keeps the original timestamp
  // when an already-disabled workspace is disabled again — and keeps a pre-0030 `null` null,
  // which `purge_workspace` reads as "retention elapsed" (§12 决定 3).
  await client.query(
    `update workspaces
        set status = $2,
            disabled_at = case when $2 = 'disabled' then coalesce(disabled_at, now()) else null end
      where id = $1`,
    [input.workspaceId, input.status],
  );
  const result = await loadPlatformWorkspace(client, input.workspaceId);
  return {
    result,
    resourceType: 'workspace',
    resourceId: input.workspaceId,
    afterCommit: async () => {
      await stopEntryContainers(principalIds);
      return result;
    },
  };
};

export const setAllowedModelsHandler: CapabilityHandler = async (client, _workspaceId, params) => {
  const input = params as { workspaceId: string; allowedModels: string[] };
  const before = await loadPlatformWorkspaceRow(client, input.workspaceId);
  await assertModelsInCatalog(input.allowedModels);
  assertEntryModelAllowed(entryModelOf(before), input.allowedModels);
  await writeWorkspaceModelPolicy(client, input.workspaceId, {
    allowedModels: input.allowedModels,
    // Keep the runtime's source of truth aligned with the record when the bootstrap-time value
    // never reached the policy row (a workspace created before P-A2).
    ...(before.default_model === null && before.entry_model !== null
      ? { defaultModel: before.entry_model }
      : {}),
  });
  return {
    result: await loadPlatformWorkspace(client, input.workspaceId),
    resourceType: 'workspace',
    resourceId: input.workspaceId,
  };
};

// -------------------------------------------------------------------------------------------
// purge (S6 A1 / A6 — docs/console-completion-plan.md §4 "Workspace 生命周期", §5.2, §6 rows
// `purge_workspace` / `purge_user`, §7 "清除类能力只在 platform scope、管理员、两步确认、平台审计保留").
// -------------------------------------------------------------------------------------------

/**
 * `purge_workspace {workspaceId, confirm?}` — two phases, the `create_workspace` shape: this
 * platform transaction loads the row and applies every precondition (a refusal is a clean 409
 * with no audit row, like every other guard here); the cascade — or, without `confirm`, the
 * count-only preview — then runs in `afterCommit` on the bootstrap (superuser) path, because the
 * application role has no DELETE on `workspaces` / `audit_records` and cannot lift the
 * append-only triggers (application/platform/purge-workspace.ts has the full rationale). The
 * cascade re-checks the preconditions under a row lock, so a workspace re-enabled between the
 * phases survives. Dispatch writes the `purge_workspace` audit row for the call (params carry
 * `confirm`, so a preview is distinguishable); the cascade writes `platform.workspace_purged`
 * with the counts once it has actually run.
 */
export const purgeWorkspaceHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  context,
) => {
  const input = params as { workspaceId: string; confirm?: boolean };
  const acting = actingUser(context);
  const row = await loadPlatformWorkspaceRow(client, input.workspaceId);
  const { settings } = await readPlatformSettings(client);
  if (settings.defaultWorkspaceId === row.id) {
    throw new PlatformAdminError(
      'default_workspace',
      'the platform default workspace cannot be purged — pick another default first',
    );
  }
  const eligibility = assessPurgeEligibility({
    status: row.status,
    purpose: row.purpose,
    expiresAt: row.expires_at,
    disabledAt: row.disabled_at,
  });
  if (!eligibility.eligible) {
    throw new PlatformAdminError(eligibility.code, eligibility.message);
  }
  const confirm = input.confirm === true;
  return {
    // Phase-1 placeholder: dispatch replaces it with `afterCommit`'s value (the real preview or
    // outcome); the audit row for this call carries the params and the workspace as resource.
    result: { workspaceId: row.id, executed: false },
    resourceType: 'workspace',
    resourceId: row.id,
    afterCommit: async (pool: PoolLike): Promise<PurgeWorkspaceResultWire> => {
      try {
        return await purgeWorkspace(pool, {
          workspaceId: row.id,
          confirm,
          actorUserId: acting.id,
        });
      } catch (err) {
        // The row-locked re-check refused (re-enabled, or purged concurrently): surface it as
        // the same 404 / 409 the phase-1 guard would have — the phase-1 audit row records an
        // attempt with no matching `platform.workspace_purged`, like `create_workspace`'s.
        if (err instanceof PurgeWorkspaceRefusedError) {
          throw new PlatformAdminError(err.code, err.message);
        }
        throw err;
      }
    },
  };
};

interface PurgeUserDbRow {
  id: string;
  login: string;
  platform_role: 'admin' | 'user';
  has_password: boolean;
  session_count: string;
  active_membership_count: string;
}

/**
 * `purge_user {userIds}` — the leftovers `purge_workspace` cannot reach: users awaiting
 * activation whose memberships were all removed (disabled Principals) or who never had one.
 * Runs entirely in this platform transaction (0021 grants the application role DELETE on
 * `users` / `user_sessions` for `merge_user`). Per user, in order: exists → has no password →
 * is not a platform administrator → has never logged in → holds no non-disabled membership
 * (§5.2 "无活跃成员资格": a membership in a *disabled* workspace still counts — purge the
 * workspace instead, which cascades the user) → nothing else references the row
 * (`findUserReferences`, the same explicit catalog check the cascade uses). Disabled membership
 * Principals are then detached (`user_id = null`; the rows stay for audit lineage — nothing in
 * the kernel sweeps a user-less human Principal back into a user) and the row deleted, with one
 * `platform.user_purged` audit row per purged user so `platform_audit_query {targetUserId}` finds
 * it. A skipped user never fails the batch.
 */
export const purgeUserHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  context,
) => {
  const input = params as { userIds: string[] };
  const acting = actingUser(context);
  const outcomes: PurgeUserOutcomeWire[] = [];
  let purgedCount = 0;
  for (const userId of [...new Set(input.userIds)]) {
    const found = await client.query<PurgeUserDbRow>(
      `select u.id, u.login, u.platform_role, u.has_password,
              (select count(*) from user_sessions s where s.user_id = u.id)::text as session_count,
              (select count(*) from principals p
                where p.user_id = u.id and p.kind = 'human' and p.disabled_at is null)::text
                as active_membership_count
         from users u where u.id = $1`,
      [userId],
    );
    const user = found.rows[0];
    if (!user) {
      outcomes.push({ userId, login: null, status: 'skipped', reason: 'user_not_found' });
      continue;
    }
    const skip = (reason: PurgeUserOutcomeWire['reason'], detail?: string): void => {
      outcomes.push({
        userId,
        login: user.login,
        status: 'skipped',
        reason,
        ...(detail !== undefined ? { detail } : {}),
      });
    };
    if (user.has_password) {
      skip('activated');
      continue;
    }
    if (effectivePlatformRole(user.login, user.platform_role) === 'admin') {
      skip('platform_admin');
      continue;
    }
    if (Number(user.session_count) > 0) {
      skip('has_sessions');
      continue;
    }
    if (Number(user.active_membership_count) > 0) {
      skip('active_membership');
      continue;
    }
    const references = (await findUserReferences(client, userId)).filter(
      // The disabled memberships are detached below, not a reason to keep the user.
      (ref) => !(ref.table === 'principals' && ref.column === 'user_id'),
    );
    if (references.length > 0) {
      skip(
        'referenced',
        references.map((ref) => `${ref.table}.${ref.column} (${ref.rows})`).join(', '),
      );
      continue;
    }
    const detached = await client.query<{ workspace_id: string; id: string }>(
      `update principals set user_id = null
        where user_id = $1 and kind = 'human'
        returning workspace_id, id`,
      [userId],
    );
    await client.query('delete from user_sessions where user_id = $1', [userId]);
    await client.query('delete from users where id = $1', [userId]);
    await writeAudit(client, {
      workspaceId: null,
      actorPrincipalId: null,
      actorUserId: acting.id,
      action: 'platform.user_purged',
      resourceType: 'user',
      resourceId: userId,
      payload: {
        channel: 'platform',
        actorLogin: acting.login,
        params: { userId },
        login: user.login,
        detachedPrincipals: detached.rows.map((row) => ({
          workspaceId: row.workspace_id,
          principalId: row.id,
        })),
      },
    });
    outcomes.push({ userId, login: user.login, status: 'purged' });
    purgedCount += 1;
  }
  const result: PurgeUsersResultWire = { outcomes, purgedCount };
  return { result };
};

// -------------------------------------------------------------------------------------------
// platform audit
// -------------------------------------------------------------------------------------------

interface AuditDbRow {
  id: string;
  action: string;
  // 遗留 54: null for an unattributed operator-CLI platform row (`payload.attributedActor: false`,
  // audit_records_actor_shape / migration core 0032) — the join below already yields `actor_login:
  // null` for the same rows.
  actor_user_id: string | null;
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

// Exported for application/platform/runtime.ts's own `platform_status` handler (S7-E) — one
// pagination/audit-query implementation, not a second copy.
export async function queryPlatformAudit(
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
    // Inside the platform transaction: a failed statement would abort the whole transaction,
    // so there is deliberately no `.catch` here — migration 0021 grants the SELECT this needs.
    .query<{ n: string; latest: string | null }>(
      `select count(*)::text as n, max(lpad(version::text, 4, '0') || '_' || name) as latest
       from schema_migrations where module = 'core'`,
    );
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
