import { randomBytes, randomUUID } from 'node:crypto';
import type {
  AuditActingThrough,
  PlatformAuditRecordWire,
  PlatformOverviewWire,
  PlatformWorkspaceWire,
  ProviderHealthWire,
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
import { lockAuthoritiesForChange } from '../../governance/capability/index.js';
import { shownAuditPayload } from '../../governance/redaction/index.js';
import { writeAudit } from '../../substrate/audit/index.js';
import { DEFAULT_COLLECTOR_SILENCE_THRESHOLD_MS } from '../../substrate/audit/invariant-checks.js';
import { listSourceFreshness } from '../../substrate/epistemic/index.js';
import type { OntologyEnforcement } from '../../substrate/graph/index.js';
import { ADMIN_TRIAL_WORKSPACE_PURPOSE } from '../admin-agent/index.js';
import { revokeUserAdminAgentSessions, revokeUserCredentials } from '../identity/credentials.js';
import { type ReleasedMembership, freeMembershipSlot } from '../identity/memberships.js';
import { hashPassword, passwordPolicyViolation } from '../identity/password.js';
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
import { applyRoleChange } from '../task/role-change.js';
import { getConfiguredTaskRuntime } from '../task/runtime.js';
import { createWorkspaceWithOwner } from '../workspace/create.js';
import type { WorkspacePurpose } from '../workspace/create.js';
import { READ_AUDIT_ACTIONS } from './audit-reads.js';
import { isLastActiveHumanOwner } from './auth.js';
import type { CapabilityHandler, CapabilityHandlerContext } from './capability-handler.js';
import { readModelCatalog, readModelCatalogWithHealth } from './models-catalog-handler.js';
import { EVERY_RESIDENT_CONTAINER_KIND, stopResidentContainers } from './resident-containers.js';
import { publishSessionKick } from './session-revocation.js';

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
  /** S11 AA3a: a trial workspace (`purpose = 'admin_trial'`) named as the platform default. */
  | 'trial_workspace'
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
  // P0b (`suspend_self_connection` / `resume_self_connection`)
  | 'self_connection_not_found'
  // P-B2a (gate-host instances)
  | 'gate_id_taken'
  | 'gate_in_use'
  | 'gate_not_hosted'
  | 'credential_mode_mismatch'
  // P1 (`create_gate_instance`'s `connector`): another kind's connector, or a packaged gate's
  | 'connector_kind_mismatch'
  | 'connector_packaged'
  // S11 P1-F (`create_gate_instance`'s `preset`): no connector preset of that name ships here
  | 'connector_preset_not_found'
  // R-18 (`confirm_gate_manifest`): nothing held, or the held manifest is not the one shown
  | 'no_pending_manifest'
  | 'manifest_changed'
  // S6 A1 (`purge_workspace`; application/platform/purge-workspace.ts)
  | 'workspace_active'
  | 'retention_not_elapsed'
  // S7-E (P-C §6.5; application/platform/runtime.ts)
  | 'image_not_in_inventory'
  | 'runtime_unreachable'
  | 'no_previous_settings_version'
  // P1-a hotfix (post-v0.16.0 review): a target not in worker-supervisor's own allowlist
  // (`WORKER_IMAGE_ALLOWLIST` / `config.taskImageAllowlist`) — see runtime.ts.
  | 'image_not_allowed'
  // STATUS leftover 422: a target worker-supervisor would refuse to start anything from (no
  // matching `ai.nexttime.runtime-contract` label) — see runtime.ts.
  | 'runtime_image_incompatible';

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
  workspace_purpose: WorkspacePurpose;
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
    workspacePurpose: row.workspace_purpose,
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
            w.purpose as workspace_purpose, p.id as principal_id, p.role,
            (p.disabled_at is not null) as disabled
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
 * memberships is in an active workspace that is not `ephemeral` — every one sits in a disabled
 * workspace or an `ephemeral` one (an acceptance run, a demo). A trial workspace (S11 AA3a,
 * `admin_trial`) is a real place like a `standard` one: its members are people, not acceptance
 * residue. Those are the "重复的、看不懂的用户" of A6: they
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
        and w.status = 'active' and w.purpose <> 'ephemeral'
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

/** R-13: the same rule a self-service password change applies (identity/password.ts). */
function assertPasswordPolicy(password: string, settings: PlatformSettings): void {
  const violation = passwordPolicyViolation(password, settings.passwordMinLength);
  if (violation !== null) throw new PlatformAdminError('weak_password', violation);
}

interface WorkspaceDbRow {
  id: string;
  name: string;
  status: 'active' | 'disabled';
  purpose: WorkspacePurpose;
}

async function loadWorkspace(client: PoolClient, workspaceId: string): Promise<WorkspaceDbRow> {
  const result = await client.query<WorkspaceDbRow>(
    'select id, name, status, purpose from workspaces where id = $1',
    [workspaceId],
  );
  const row = result.rows[0];
  if (!row) throw new PlatformAdminError('workspace_not_found', 'workspace not found');
  return row;
}

/**
 * Creates the membership Principal (no API key) under the workspace GUC + platform policy.
 * Legacy 725: only an active membership makes the user "already a member"; a removed one is let go
 * of the user (`freeMembershipSlot`) and the new Principal takes its place — returned as
 * `released` for the audit row. The caller holds the user's authority lock.
 */
async function insertMembership(
  client: PoolClient,
  input: { userId: string; workspaceId: string; role: Role; displayName: string },
): Promise<{ membership: UserMembershipWire; released: ReleasedMembership | null }> {
  const workspace = await loadWorkspace(client, input.workspaceId);
  if (workspace.status !== 'active') {
    throw new PlatformAdminError('workspace_disabled', 'that workspace is disabled');
  }
  const slot = await freeMembershipSlot(client, {
    workspaceId: input.workspaceId,
    userId: input.userId,
  });
  if (slot.state === 'held') {
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
    membership: {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceStatus: workspace.status,
      workspacePurpose: workspace.purpose,
      principalId: row.id,
      role: input.role,
      disabled: false,
    },
    released: slot.released,
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
    // A user created just now: no membership to clash with or to let go, no one else holds its id.
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
  // Legacy 702 (governance 0043): the user's authority lock before any row is read or locked.
  if (input.platformRole !== undefined) {
    await lockAuthoritiesForChange(client, { userIds: [input.userId] });
  }
  const before = await loadUser(client, input.userId);
  const demoted = input.platformRole === 'user' && before.platformRole === 'admin';
  if (demoted) await assertAdminCanBeReduced(client, before);
  await client.query(
    `update users
        set display_name = coalesce($2, display_name),
            platform_role = coalesce($3, platform_role),
            updated_at = now()
      where id = $1`,
    [input.userId, input.displayName?.trim() || null, input.platformRole ?? null],
  );
  // S11 AA1 (I-A3): an admin agent's power follows its person. Every call through one re-checks
  // the platform role already; revoking its Handles here is what also stops llm-proxy at once.
  // S11 AA4c-2: and, after commit, its containers stop (best-effort; with the Handles gone they
  // can no longer act anyway). The person's entry containers are theirs to keep.
  const adminContainerPrincipalIds = demoted
    ? await listHumanPrincipalIds(client, { userId: input.userId })
    : [];
  if (demoted) await revokeUserAdminAgentSessions(client, input.userId);
  if (input.displayName) {
    // Keep the membership Principals' display names in step (the members page reads them).
    await client.query(
      `update principals set display_name = $2 where user_id = $1 and kind = 'human'`,
      [input.userId, input.displayName.trim()],
    );
  }
  const result = await loadUser(client, input.userId);
  return {
    result,
    resourceType: 'user',
    resourceId: input.userId,
    ...(demoted
      ? {
          afterCommit: async () => {
            await stopResidentContainers(adminContainerPrincipalIds, ['admin_agent']);
            return result;
          },
        }
      : {}),
  };
};

/** R-06: a disabled user signs in nowhere, so disabling one who is a workspace's last active
 *  human owner would leave that workspace with no person able to own it — the same outcome
 *  `remove_membership` refuses. Checked per workspace the user owns, with the shared
 *  `isLastActiveHumanOwner` predicate; the administrator transfers ownership first. */
async function assertNotLastHumanOwnerAnywhere(client: PoolClient, userId: string): Promise<void> {
  const owned = await client.query<{ workspace_id: string; id: string; name: string }>(
    `select p.workspace_id, p.id, w.name
       from principals p
       join workspaces w on w.id = p.workspace_id
      where p.user_id = $1 and p.kind = 'human' and p.role = 'owner' and p.disabled_at is null
      order by w.created_at`,
    [userId],
  );
  for (const row of owned.rows) {
    if (await isLastActiveHumanOwner(client, row.workspace_id, row.id)) {
      throw new PlatformAdminError(
        'last_owner',
        `the user is the last human owner of workspace "${row.name}" — make someone else an owner first`,
      );
    }
  }
}

export const setUserStatusHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  context,
) => {
  const input = params as { userId: string; status: 'active' | 'disabled' };
  // Legacy 702 (governance 0043): the user's authority lock before any row is read or locked —
  // `assertNotLastHumanOwnerAnywhere` takes `for update` on owners' rows, which an issuer holding
  // this user's lock may be waiting to reference. A disable then revokes the sessions of every
  // membership of the user in the database too (0043's trigger).
  await lockAuthoritiesForChange(client, { userIds: [input.userId] });
  const before = await loadUser(client, input.userId);
  if (input.status === 'disabled') {
    if (before.id === actingUser(context).id) {
      // C10: its own code — the last-admin rule below is a different refusal with different
      // advice (make someone else an administrator first vs. ask another administrator).
      throw new PlatformAdminError('self_disable', 'you cannot disable your own account');
    }
    await assertAdminCanBeReduced(client, before);
    if (before.status === 'active') await assertNotLastHumanOwnerAnywhere(client, before.id);
  }
  await client.query('update users set status = $2, updated_at = now() where id = $1', [
    input.userId,
    input.status,
  ]);
  let principalIds: string[] = [];
  if (input.status === 'disabled') {
    // R-12 (D-25): console sessions, every membership's sessions and Handles, and any legacy
    // API key of the user's — identity's one revocation.
    await revokeUserCredentials(client, input.userId);
    principalIds = await listHumanPrincipalIds(client, { userId: input.userId });
  }
  const result = await loadUser(client, input.userId);
  return {
    result,
    resourceType: 'user',
    resourceId: input.userId,
    // P-A2 (design §8 "停用用户 … 入口容器 stop"; a P-A1 gap): once the sessions are gone, stop
    // the user's resident entry containers too — best-effort, after commit. R-05: and close the
    // user's open /ws sockets — console ones by user, API-key ones by membership Principal.
    // S11 AA4c-2: and their admin agent's containers, whose sessions went with the rest.
    afterCommit: async () => {
      if (input.status === 'disabled') {
        publishSessionKick({ userId: input.userId, principalIds });
      }
      await stopResidentContainers(principalIds, EVERY_RESIDENT_CONTAINER_KIND);
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
  // A reset ends every existing credential of the user's: whoever held the old password (or a
  // stolen cookie) is out until they log in with the new temporary one — and, R-12 (D-25), so is
  // anything they minted with it: the Handles of every membership's sessions (an `issue_handle`
  // `mcp_session` included) and the memberships' API keys, which people are no longer issued.
  const { principalIds } = await revokeUserCredentials(client, input.userId);
  const result = { userId: input.userId, temporaryPassword };
  return {
    result,
    resourceType: 'user',
    resourceId: input.userId,
    // R-05: once committed, the console sockets those sessions opened close too, and so do the
    // API-key sockets of the memberships — their key is gone.
    afterCommit: async () => {
      publishSessionKick({ userId: input.userId, principalIds });
      return result;
    },
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
  // Legacy 725 (#493 on #1189): the user's authority lock before any row is read, as every path
  // that changes a user's memberships takes it (`merge_user`, binding an API key, the workspace's
  // `add_member`): two adds of the same user no longer race to the unique index (a 500), and a
  // merge never meets a membership added after it read the user's.
  await lockAuthoritiesForChange(client, { userIds: [input.userId] });
  const user = await loadUser(client, input.userId);
  const { membership, released } = await insertMembership(client, {
    userId: user.id,
    workspaceId: input.workspaceId,
    role: input.role,
    displayName: user.displayName,
  });
  return {
    result: membership,
    resourceType: 'principal',
    resourceId: membership.principalId,
    // Legacy 725: the removed membership this one replaces, as `merge_user` lists the ones it
    // lets go — whose it was and where, so the row says it without a lookup.
    ...(released !== null
      ? {
          auditPayload: {
            detachedPrincipals: [
              { ...released, login: user.login, workspaceName: membership.workspaceName },
            ],
          },
        }
      : {}),
  };
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

// R-06: "last owner" is the predicate the workspace plane uses too (`isLastActiveHumanOwner`,
// auth.ts) — one rule for both planes: the last active human owner, a service owner never
// counting toward it.
export const setMembershipRoleHandler: CapabilityHandler = async (client, _workspaceId, params) => {
  const input = params as { userId: string; workspaceId: string; role: Role };
  const membership = await loadMembership(client, input.userId, input.workspaceId);
  // Legacy 696: the role is already the one asked for, so the person's authority does not change
  // and nothing else does either — no write, no session ends, no Handle is revoked. Ending the
  // sessions here used to leave the Handles they had issued valid until ttl (`verifyHandle` reads
  // only a Handle's own `revoked_at`): a session revoked while its Handles still worked. The audit
  // row says the call changed nothing.
  if (input.role === membership.role) {
    return {
      result: membership,
      resourceType: 'principal',
      resourceId: membership.principalId,
      auditPayload: { unchanged: true },
    };
  }
  // Legacy 702 (governance 0043): the Principal's authority lock before any row is locked here.
  await lockAuthoritiesForChange(client, { principalIds: [membership.principalId] });
  if (
    membership.role === 'owner' &&
    !membership.disabled &&
    (await isLastActiveHumanOwner(client, input.workspaceId, membership.principalId))
  ) {
    throw new PlatformAdminError(
      'last_owner',
      'the last human owner of a workspace cannot be demoted',
    );
  }
  await client.query('update principals set role = $3 where workspace_id = $1 and id = $2', [
    input.workspaceId,
    membership.principalId,
    input.role,
  ]);
  // Legacy 699: one rule with the workspace-side `set_principal_role` (`applyRoleChange`). The
  // sessions whose Handles carry the old role's scope end (entry, MCP, admin agent; their Handles
  // with them, governance 0042) and are issued again with the new role on next use; a running
  // Worker ends only when the new role no longer covers what it holds. The person's console is
  // not signed out — it reads the current role on every request. This used to end every session of
  // the Principal while revoking only the entry / MCP / admin agent Handles, so a demoted person's
  // Workers kept the old scope until ttl.
  await setWorkspaceContext(client, input.workspaceId, membership.principalId);
  await applyRoleChange(client, input.workspaceId, membership.principalId);
  const after = await loadMembership(client, input.userId, input.workspaceId);
  return { result: after, resourceType: 'principal', resourceId: membership.principalId };
};

export const removeMembershipHandler: CapabilityHandler = async (client, _workspaceId, params) => {
  const input = params as { userId: string; workspaceId: string };
  const membership = await loadMembership(client, input.userId, input.workspaceId);
  // Legacy 702 (governance 0043): the user's and the Principal's authority locks, in that order,
  // before any row is locked here (`revokeUserCredentials` takes the user's again).
  await lockAuthoritiesForChange(client, {
    userIds: [input.userId],
    principalIds: [membership.principalId],
  });
  if (
    membership.role === 'owner' &&
    !membership.disabled &&
    (await isLastActiveHumanOwner(client, input.workspaceId, membership.principalId))
  ) {
    throw new PlatformAdminError(
      'last_owner',
      'the last human owner of a workspace cannot be removed',
    );
  }
  await client.query(
    `update principals set disabled_at = coalesce(disabled_at, now())
      where workspace_id = $1 and id = $2`,
    [input.workspaceId, membership.principalId],
  );
  // R-12 (D-25): the membership's sessions, their Handles and any legacy API key go with it —
  // identity's one revocation, scoped to this workspace.
  await revokeUserCredentials(client, input.userId, { workspaceId: input.workspaceId });
  const result = { userId: input.userId, workspaceId: input.workspaceId, removed: true };
  return {
    result,
    resourceType: 'principal',
    resourceId: membership.principalId,
    // R-05: the membership's open /ws sockets close once committed (session-revocation.ts).
    afterCommit: async () => {
      publishSessionKick({ principalIds: [membership.principalId] });
      return result;
    },
  };
};

export const mergeUserHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  context,
) => {
  const input = params as { sourceUserId: string; targetUserId: string };
  if (input.sourceUserId === input.targetUserId) {
    throw new PlatformAdminError('already_claimed', 'source and target are the same user');
  }
  // Legacy 702 (governance 0043): both users' authority locks, then the moved memberships', before
  // any row is locked — every membership of the source user changes user, and an issuer for one of
  // them either commits first or re-reads the new user and refuses (`authority_changed`). The
  // target's lock also makes a concurrent disable of the target wait, so its revocation sees the
  // moved memberships.
  await lockAuthoritiesForChange(client, { userIds: [input.sourceUserId, input.targetUserId] });
  let source = await loadUser(client, input.sourceUserId);
  let target = await loadUser(client, input.targetUserId);
  if (source.hasPassword) {
    throw new PlatformAdminError(
      'already_claimed',
      'only a user without a password can be merged — an API key must never take over a password-protected account',
    );
  }
  // Legacy 708: the moved memberships would act for a disabled user with their sessions and
  // Handles still valid (I-H2) — a disable revokes only what acts for the user when it happens.
  // Read under the target's authority lock above, so a disable of the target either committed
  // before (refused here) or waits for the merge and then revokes the moved memberships too.
  if (target.status === 'disabled') {
    throw new PlatformAdminError(
      'user_disabled',
      'the target user is disabled: the moved memberships would act for a disabled user — enable it first, or merge into another user',
    );
  }
  // Legacy 702 (governance 0043): every Principal this may change — each of the source's, which
  // move or are detached, and each of the target's in a workspace the source is in, which may be
  // detached — locked after the users', and the memberships read again under those locks before
  // anything is decided on them (#1189 #501 P3-1): a workspace-side `disable_principal` takes
  // only the Principal's lock, so a membership read before it would still count as not removed
  // (a clash where there is none, a detach of the wrong one, a false `membership_restored`).
  // A membership added since the read before (`add_membership` takes no user lock) is in play but
  // not locked yet: lock it too and read again, until a read brings none — in practice the first
  // read under the locks.
  const locked = new Set<string>();
  for (;;) {
    const sourceWorkspaces = new Set(source.memberships.map((m) => m.workspaceId));
    const unlocked = [
      ...source.memberships,
      ...target.memberships.filter((m) => sourceWorkspaces.has(m.workspaceId)),
    ]
      .map((m) => m.principalId)
      .filter((principalId) => !locked.has(principalId));
    if (unlocked.length === 0) break;
    await lockAuthoritiesForChange(client, { principalIds: unlocked });
    for (const principalId of unlocked) locked.add(principalId);
    source = await loadUser(client, source.id);
    target = await loadUser(client, target.id);
  }
  // A user holds one membership per workspace (`principals_workspace_user_key`). Where both hold
  // one, only two that are not removed clash; otherwise the removed one is detached
  // (`user_id = null`, as `purge_user` detaches a purged user's removed memberships: the Principal
  // row stays for the audit lineage, and the `merge_user` row says whose it was), and the other
  // stays or moves. Counting removed ones too made "remove one first" a dead end: a removed
  // membership is never deleted, and every new user joins the default workspace.
  const targetByWorkspace = new Map(target.memberships.map((m) => [m.workspaceId, m]));
  const clash = source.memberships.find((m) => {
    const theirs = targetByWorkspace.get(m.workspaceId);
    return theirs !== undefined && !m.disabled && !theirs.disabled;
  });
  if (clash) {
    throw new PlatformAdminError(
      'already_member',
      `both users hold a membership in workspace "${clash.workspaceName}" that is not removed: remove one of them there first`,
    );
  }
  const detached: (ReleasedMembership & { login: string; workspaceName: string })[] = [];
  for (const membership of source.memberships) {
    const theirs = targetByWorkspace.get(membership.workspaceId);
    if (theirs === undefined) continue;
    // The source's when it is removed (both removed: the target keeps its own); else the target's.
    const gone = membership.disabled
      ? { membership, user: source }
      : { membership: theirs, user: target };
    // Legacy 725 (UX on #1189): the login and the workspace's name too, so the platform audit
    // says "Y's membership in W" — the source user row is deleted below.
    detached.push({
      workspaceId: gone.membership.workspaceId,
      principalId: gone.membership.principalId,
      userId: gone.user.id,
      login: gone.user.login,
      workspaceName: gone.membership.workspaceName,
    });
  }
  for (const gone of detached) {
    // Only a removed one, still that user's. Under both users' locks and its own nothing can
    // change that (nothing re-enables a removed membership), so a miss is a broken invariant.
    const result = await client.query(
      `update principals set user_id = null
        where workspace_id = $1 and id = $2 and user_id = $3 and kind = 'human'
          and disabled_at is not null`,
      [gone.workspaceId, gone.principalId, gone.userId],
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new Error(
        `merge_user: the removed membership ${gone.principalId} to detach is no longer removed or no longer that user's`,
      );
    }
  }
  await client.query(`update principals set user_id = $2 where user_id = $1 and kind = 'human'`, [
    source.id,
    target.id,
  ]);
  await client.query('delete from user_sessions where user_id = $1', [source.id]);
  await client.query('delete from users where id = $1', [source.id]);
  // Legacy 719: disabling a user leaves its memberships as they are (it revokes their sessions,
  // Handles and API keys); what kept them unusable was the user's status. Moved onto the active
  // target they act again, with no credential of the source's back: each one gets its own row,
  // like an enable would, so the platform audit says when, for whom and by whom it came back.
  // A removed membership (a disabled Principal) moves as it is and stays removed.
  if (source.status === 'disabled') {
    const acting = actingUser(context);
    for (const membership of source.memberships.filter((m) => !m.disabled)) {
      await writeAudit(client, {
        workspaceId: null,
        actorPrincipalId: null,
        actorUserId: acting.id,
        action: 'platform.membership_restored',
        resourceType: 'principal',
        resourceId: membership.principalId,
        payload: {
          channel: 'platform',
          actorLogin: acting.login,
          // `params` so `platform_audit_query` finds the row by either user and by workspace.
          params: {
            workspaceId: membership.workspaceId,
            sourceUserId: source.id,
            targetUserId: target.id,
          },
          // The source row is deleted above: its login is what still says who it was (as
          // `platform.user_purged` keeps the purged user's).
          sourceLogin: source.login,
          targetLogin: target.login,
          reason: 'merged_from_disabled_user',
          role: membership.role,
          workspaceName: membership.workspaceName,
          workspaceStatus: membership.workspaceStatus,
        },
      });
    }
  }
  return {
    result: await loadUser(client, target.id),
    resourceType: 'user',
    resourceId: target.id,
    // On the `merge_user` row too, for every merge: `params.sourceUserId` names a deleted user.
    auditPayload: {
      sourceLogin: source.login,
      targetLogin: target.login,
      ...(detached.length > 0 ? { detachedPrincipals: detached } : {}),
    },
  };
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
    // S11 AA3a: every new user joins the default workspace, and an admin agent acts in a trial
    // workspace (I-A6) — ordinary users never land in the one place it explores.
    if (workspace.purpose === ADMIN_TRIAL_WORKSPACE_PURPOSE) {
      throw new PlatformAdminError(
        'trial_workspace',
        'a trial workspace cannot be the default workspace: every new user joins the default workspace',
      );
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
  const known = new Set(
    (await readModelCatalog(process.env, { withHealth: false })).map((entry) => entry.id),
  );
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
 * S8 W5 (leftover 77): best-effort, after a workspace purge actually executed (never called for
 * a preview) — ask worker-supervisor to permanently reclaim each purged Principal's resident entry
 * container (`POST /resident/reclaim`: force-removed, not just stopped — the Principal is gone for
 * good, so nothing will ever reuse this container again) and its `workspaces/<principalId>` data
 * directory. The kernel still never touches a host path or the underlying container runtime itself
 * (design's own "agent / kernel 进程不持凭证"): this only calls worker-supervisor's existing
 * internal-plane HTTP API, over the same client `stopResidentContainers`
 * (`resident-containers.ts`) uses, just a different route. Same
 * shape as the CLI path (`scripts/delete-workspace.sh`'s host-side cleanup, driven by the
 * `purgeWorkspace` result's own `principalIds` — see `PurgeWorkspaceResultWire`'s doc comment) —
 * this closes the gap for the *other* entry point, the console's `purge_workspace` capability,
 * where no operator ever runs that script. Tries every principal id regardless of kind: a
 * service/agent Principal never had a container or directory, and worker-supervisor's `reclaim`
 * already tolerates "not found" as a no-op (`resident-service.ts`). Never throws — a failure here
 * leaves host-side residue for the operator script to still catch, exactly as it did before this
 * existed, never a reason to fail an already-committed purge.
 */
async function reclaimEntryContainers(principalIds: readonly string[]): Promise<void> {
  if (principalIds.length === 0) return;
  let reclaim: ((principalId: string) => Promise<boolean>) | undefined;
  try {
    const client = getConfiguredTaskRuntime().supervisorClient;
    reclaim = client.reclaimResident?.bind(client);
  } catch {
    return; // no task runtime configured (unit tests / CLI) — nothing to reclaim
  }
  if (!reclaim) return;
  for (const principalId of principalIds) {
    try {
      await reclaim(principalId);
    } catch {
      // Logged nowhere on purpose, same convention as stopResidentContainers.
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
    /** S11 AA3a: `standard` (omitted) or `admin_trial` — the registry's schema admits no other. */
    purpose?: 'standard' | 'admin_trial';
  };
  const acting = actingUser(context);
  const owner = await loadUser(client, input.ownerUserId);
  if (owner.status !== 'active') {
    throw new PlatformAdminError('user_disabled', 'the owner must be an active user');
  }
  const allowedModels = input.allowedModels ?? [];
  // E5 / P-B2b D4: one read of `platform_settings` covers both platform defaults this call may
  // fall back to — `defaultEntryModel` (E5) and `defaultModules` (D4) — since this platform
  // transaction can read `platform_settings` and the bootstrap call below (which runs with no
  // platform context at all) cannot.
  const { settings } = await readPlatformSettings(client);
  // E5: an explicit `entryModel` always wins; omitted falls back to the platform's own default
  // entry model (`set_platform_default_model`) — the same precedence `ensureDefaultWorkspace`
  // already applies when bootstrapping the very first workspace (application/platform/
  // default-workspace.ts). Still validated exactly like an explicit value: a platform default
  // that conflicts with a non-empty `allowedModels` this call also sets fails loudly
  // (`entry_model_not_allowed`) rather than silently being dropped.
  const effectiveEntryModel = input.entryModel ?? settings.defaultEntryModel ?? undefined;
  await assertModelsInCatalog([
    ...(effectiveEntryModel ? [effectiveEntryModel] : []),
    ...allowedModels,
  ]);
  assertEntryModelAllowed(effectiveEntryModel ?? null, allowedModels);

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
      details: {
        defaultModules: settings.defaultModules,
        purpose: input.purpose ?? 'standard',
      },
      triggeredBy: 'create_workspace',
    },
  });

  return {
    result: { workspaceId },
    resourceType: 'workspace',
    resourceId: workspaceId,
    afterCommit: async (pool: PoolLike) => {
      const outcome = await createWorkspaceWithOwner(pool, {
        workspaceId,
        name: input.name,
        owner: { userId: owner.id, displayName: owner.displayName },
        entryModel: effectiveEntryModel,
        allowedModels,
        ontologyEnforcement: input.ontologyEnforcement,
        defaultModules: settings.defaultModules,
        purpose: input.purpose ?? 'standard',
      });
      // P2 hotfix (post-v0.16.0 review, "default modules drift"): only known once the bootstrap
      // above has actually run its install loop — too late for the phase-1 `workspace.created` row
      // above (already committed). A second row, same action/resourceId, same "hand-written row
      // alongside the automatic one" convention this handler's own phase-1 comment documents —
      // distinguished by carrying `skippedDefaultModules` where the phase-1 row never does. Only
      // written when something was actually skipped, never for the ordinary case.
      if (outcome.skippedDefaultModules.length > 0) {
        await withPlatform(pool, { userId: acting.id }, (platformClient) =>
          writeAudit(platformClient, {
            workspaceId: null,
            actorPrincipalId: null,
            actorUserId: acting.id,
            action: 'workspace.created',
            resourceType: 'workspace',
            resourceId: workspaceId,
            payload: {
              channel: 'platform',
              actorLogin: acting.login,
              details: { skippedDefaultModules: outcome.skippedDefaultModules },
              triggeredBy: 'create_workspace',
            },
          }),
        );
      }
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
  // Legacy 702 (governance 0043): the workspace's authority lock before any row is read or locked.
  await lockAuthoritiesForChange(client, { workspaceIds: [input.workspaceId] });
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
  }
  // S6 (migration core 0030): `disabled_at` starts the 7-day purge retention clock; re-enabling
  // clears it (a later disable starts a fresh clock). `coalesce` keeps the original timestamp
  // when an already-disabled workspace is disabled again — and keeps a pre-0030 `null` null,
  // which `purge_workspace` reads as "retention elapsed" (§12 决定 3).
  //
  // Disabling revokes every session in the workspace — entry, Worker, MCP, service; R-12: every
  // one not `revoked`, an entry session may still be `starting` — and through governance 0042 their
  // Handles, so llm-proxy stops them too, not only the kernel (which refuses every call in a
  // disabled workspace). governance 0043's `workspaces_disabled_revokes_sessions` trigger does it in
  // this UPDATE, taking the sessions in one statement ordered by id first (the lock order,
  // governance/capability/handles.ts); a second revocation here would only find them revoked.
  await client.query(
    `update workspaces
        set status = $2,
            disabled_at = case when $2 = 'disabled' then coalesce(disabled_at, now()) else null end
      where id = $1`,
    [input.workspaceId, input.status],
  );
  if (input.status === 'disabled') {
    principalIds = await listHumanPrincipalIds(client, { workspaceId: input.workspaceId });
  }
  const result = await loadPlatformWorkspace(client, input.workspaceId);
  return {
    result,
    resourceType: 'workspace',
    resourceId: input.workspaceId,
    // S11 AA4c-2: a disabled trial workspace's admin agent containers stop with its entry ones.
    afterCommit: async () => {
      await stopResidentContainers(principalIds, EVERY_RESIDENT_CONTAINER_KIND);
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
        const purgeResult = await purgeWorkspace(pool, {
          workspaceId: row.id,
          confirm,
          actorUserId: acting.id,
        });
        // Leftover 77: only once the cascade actually ran (never for a `confirm: false` preview)
        // — see reclaimEntryContainers's own doc comment for why this, not the CLI script, is now
        // the console purge path's host-side cleanup.
        if (purgeResult.executed) {
          await reclaimEntryContainers(purgeResult.principalIds);
        }
        return purgeResult;
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
  // Legacy 702 (governance 0043): every named user's authority lock first, in one ordered call; the
  // detached memberships' locks follow in the trigger (Principals after users, the global order).
  await lockAuthoritiesForChange(client, { userIds: input.userIds });
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
  // Batch D3 (migration core 0054).
  acting_through: AuditActingThrough | null;
  acting_session_id: string | null;
}

function toWireAudit(row: AuditDbRow): PlatformAuditRecordWire {
  return {
    id: row.id,
    action: row.action,
    actorUserId: row.actor_user_id,
    actorLogin: row.actor_login,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    // Legacy 420: as a workspace audit read shows a payload (`shownAuditPayload`).
    payload: shownAuditPayload(row.payload),
    createdAt: row.created_at.toISOString(),
    actingThrough: row.acting_through,
    actingSessionId: row.acting_session_id,
  };
}

const PLATFORM_AUDIT_SELECT = `
  select a.id, a.action, a.actor_user_id, u.login as actor_login, a.resource_type, a.resource_id,
         a.payload, a.created_at, a.created_at::text as created_at_cursor,
         a.acting_through, a.acting_session_id
    from audit_records a
    left join users u on u.id = a.actor_user_id
   where a.workspace_id is null`;

/** How many of the newest platform audit rows a `recentWrites` query looks through: the overview
 *  and status cards show the latest changes among them, and a console polling reads can never make
 *  that query scan the whole table. */
const RECENT_WRITES_SCAN_ROWS = 1000;

/** The newest platform audit rows that changed something (console audit P1-14: the overview's and
 *  status page's 「最近平台审计」 show changes, never the reads the console's own polling makes),
 *  looked for among the latest `RECENT_WRITES_SCAN_ROWS` rows. */
export async function queryRecentPlatformWrites(
  client: PoolClient,
  limit: number,
): Promise<PlatformAuditRecordWire[]> {
  const result = await client.query<AuditDbRow>(
    `select * from (${PLATFORM_AUDIT_SELECT} order by a.created_at desc, a.id desc limit $1) recent
      where recent.action <> all($2::text[])
      order by recent.created_at desc, recent.id desc limit $3`,
    [RECENT_WRITES_SCAN_ROWS, READ_AUDIT_ACTIONS, limit],
  );
  return result.rows.map(toWireAudit);
}

// Exported for application/platform/runtime.ts's own `platform_status` handler (S7-E) — one
// pagination/audit-query implementation, not a second copy.
export async function queryPlatformAudit(
  client: PoolClient,
  filter: {
    actorUserId?: string;
    action?: string;
    targetUserId?: string;
    targetWorkspaceId?: string;
    actingThrough?: string;
    /** Legacy 669: leave out the pure reads (`READ_AUDIT_ACTIONS`), except a refused one. */
    excludeReads?: boolean;
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
  // Legacy 666: what the act came through (#1028's column). A row from before carries none and
  // matches no value but `admin_agent_session`, which also keeps one whose payload names the
  // admin agent's session (legacy 583, the same rule as `queryAudit`).
  if (filter.actingThrough) {
    values.push(filter.actingThrough);
    const n = values.length;
    conditions.push(
      `(a.acting_through = $${n}::text or ($${n}::text = 'admin_agent_session' and a.acting_through is null and a.payload ->> 'sessionKind' = 'admin_agent'))`,
    );
  }
  // Legacy 669: the reads go before paging, so a page of writes is a whole page. A refused read
  // stays — what was refused is exactly what an auditor looks for (legacy 628).
  if (filter.excludeReads) {
    values.push(READ_AUDIT_ACTIONS);
    conditions.push(
      `(a.action <> all($${values.length}::text[]) or a.payload ->> 'outcome' = 'refused')`,
    );
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
    actingThrough?: string;
    excludeReads?: boolean;
    cursor?: string;
    limit?: number;
  };
  return { result: await queryPlatformAudit(client, { ...input, limit: input.limit ?? 50 }) };
};

// -------------------------------------------------------------------------------------------
// overview
// -------------------------------------------------------------------------------------------

/** S8 W4-C (ui-audit O3, convergence-plan-2026-09-25.md §6 W4 "计数与列表同口径"): the same
 *  "验收残留" predicate `packages/web/src/lib/platform-workspaces.ts`'s `isResidueWorkspace`
 *  applies client-side — a disabled workspace, or an expired ephemeral one. Every cross-workspace
 *  count this file computes for the control tower excludes these, matching what the workspaces
 *  page's own default (residue-hidden) view would count. */
function isResidueWorkspaceRow(row: OverviewWorkspaceRow, now: Date = new Date()): boolean {
  if (row.status === 'disabled') return true;
  if (row.purpose === 'ephemeral' && row.expires_at !== null) {
    return row.expires_at.getTime() < now.getTime();
  }
  return false;
}

interface OverviewWorkspaceRow {
  readonly id: string;
  readonly name: string;
  readonly status: 'active' | 'disabled';
  readonly purpose: WorkspacePurpose;
  readonly expires_at: Date | null;
}

interface CrossWorkspaceOverviewCounts {
  readonly gatekeepers: number;
  readonly pendingActionRequests: number;
  readonly runningTasks: number;
  readonly staleSourceCount: number;
  readonly affectedWorkspaceCount: number;
}

/**
 * S8 W4-C (ui-audit O1/O3/L1/G1): one per-workspace loop, `setWorkspaceContext` + ordinary RLS-
 * scoped queries — same shape `countGatekeepers` (its predecessor) already established, extended
 * to also total the control tower's "待处理" / "运行中" / "图谱新鲜度" metrics instead of a second
 * loop each. `workspaces` is expected pre-filtered to the non-residue set (`isResidueWorkspaceRow`)
 * — see this function's own call site. Graph freshness reuses `listSourceFreshness` (the exact
 * `ops.collector_silent` predicate `graph_freshness`, S8 W4-A, restates per-workspace) rather than
 * a third copy of that query.
 */
async function computeCrossWorkspaceOverview(
  client: PoolClient,
  workspaces: readonly OverviewWorkspaceRow[],
): Promise<CrossWorkspaceOverviewCounts> {
  const NIL_PRINCIPAL = '00000000-0000-0000-0000-000000000000';
  let gatekeepers = 0;
  let pendingActionRequests = 0;
  let runningTasks = 0;
  let staleSourceCount = 0;
  let affectedWorkspaceCount = 0;
  for (const workspace of workspaces) {
    await setWorkspaceContext(client, workspace.id, NIL_PRINCIPAL);
    // Gatekeepers are `objects` rows (object_type 'Gatekeeper', governance/gatekeepers/registry.ts).
    const gatekeeperResult = await client.query<{ n: string }>(
      `select count(*)::text as n from objects where workspace_id = $1 and object_type = 'Gatekeeper'`,
      [workspace.id],
    );
    gatekeepers += Number(gatekeeperResult.rows[0]?.n ?? '0');

    const pendingResult = await client.query<{ n: string }>(
      `select count(*)::text as n from action_requests
        where workspace_id = $1 and status = 'pending_approval'`,
      [workspace.id],
    );
    pendingActionRequests += Number(pendingResult.rows[0]?.n ?? '0');

    const runningResult = await client.query<{ n: string }>(
      `select count(*)::text as n from tasks where workspace_id = $1 and status = 'running'`,
      [workspace.id],
    );
    runningTasks += Number(runningResult.rows[0]?.n ?? '0');

    const freshness = await listSourceFreshness(
      client,
      workspace.id,
      DEFAULT_COLLECTOR_SILENCE_THRESHOLD_MS,
    );
    const silentHere = freshness.filter((source) => source.silent).length;
    staleSourceCount += silentHere;
    if (silentHere > 0) affectedWorkspaceCount += 1;
  }
  await client.query("select set_config('app.workspace_id', '', true)");
  await client.query("select set_config('app.principal_id', '', true)");
  return {
    gatekeepers,
    pendingActionRequests,
    runningTasks,
    staleSourceCount,
    affectedWorkspaceCount,
  };
}

export const platformOverviewHandler: CapabilityHandler = async (client) => {
  const { settings } = await readPlatformSettings(client);
  const users = await client.query<{ total: string; active: string; pending: string }>(
    `select count(*)::text as total,
            count(*) filter (where status = 'active')::text as active,
            count(*) filter (where not has_password)::text as pending
       from users`,
  );
  const workspaces = await client.query<OverviewWorkspaceRow>(
    'select id, name, status, purpose, expires_at from workspaces order by created_at',
  );
  const migrations = await client
    // Inside the platform transaction: a failed statement would abort the whole transaction,
    // so there is deliberately no `.catch` here — migration 0021 grants the SELECT this needs.
    .query<{ n: string; latest: string | null }>(
      `select count(*)::text as n, max(lpad(version::text, 4, '0') || '_' || name) as latest
       from schema_migrations where module = 'core'`,
    );
  let modelsAvailable = 0;
  let modelsConfigured = 0;
  let modelsStatus: 'ok' | 'down' = 'ok';
  let providerHealthFile: PlatformOverviewWire['providerHealthFile'] = 'missing';
  const modelProviders = new Map<
    string,
    { id: string; health: ProviderHealthWire | null; models: number }
  >();
  try {
    const catalog = await readModelCatalogWithHealth();
    providerHealthFile = catalog.healthFile;
    // Console audit P0-2 / review M1: "available" means a model whose provider's last applicable
    // test passed — only an explicit success counts. Unknown health (no readable health file, or
    // a provider it does not name) is not available.
    modelsConfigured = catalog.items.length;
    for (const entry of catalog.items) {
      if (entry.health?.status === 'ok') modelsAvailable += 1;
      const provider = modelProviders.get(entry.provider) ?? {
        id: entry.provider,
        health: entry.health ?? null,
        models: 0,
      };
      provider.models += 1;
      modelProviders.set(entry.provider, provider);
    }
  } catch {
    modelsStatus = 'down';
  }
  const healthUnknown = modelsStatus === 'ok' && providerHealthFile !== 'ok';
  // S8 W4-C (ui-audit O3 "计数与列表同口径"): the cross-workspace counts below (gatekeepers,
  // pending ActionRequests, running Tasks, graph freshness) are computed only over non-residue
  // workspaces — an accept-* workspace disabled or past its ephemeral expiry never inflates them.
  // `counts.workspaces`/`activeWorkspaces` below stay the literal totals (unchanged, pre-existing
  // meaning); the workspaces page's own residue banner is where "残留单独显示" already lives.
  const nonResidueWorkspaces = workspaces.rows.filter((row) => !isResidueWorkspaceRow(row));
  const {
    gatekeepers,
    pendingActionRequests,
    runningTasks,
    staleSourceCount,
    affectedWorkspaceCount,
  } = await computeCrossWorkspaceOverview(client, nonResidueWorkspaces);
  const recent = await queryRecentPlatformWrites(client, 20);

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
      modelsConfigured,
      pendingActionRequests,
      runningTasks,
    },
    graphFreshness: {
      staleThresholdMs: DEFAULT_COLLECTOR_SILENCE_THRESHOLD_MS,
      staleSourceCount,
      affectedWorkspaceCount,
    },
    health: [
      { service: 'kernel', status: 'ok' },
      { service: 'postgres', status: 'ok' },
      {
        service: 'llm-proxy',
        status: modelsStatus === 'ok' && !healthUnknown ? 'ok' : 'degraded',
        detail:
          modelsStatus !== 'ok'
            ? 'models.json unreadable — provider configuration missing?'
            : healthUnknown
              ? `${modelsConfigured} model(s) in models.json; provider health unknown — provider-health.json ${providerHealthFile === 'missing' ? 'not written' : 'unreadable or malformed'} (check the llm-proxy log)`
              : `${modelsConfigured} model(s) in models.json`,
      },
    ],
    providerHealthFile,
    modelsCatalog: modelsStatus === 'ok' ? 'ok' : 'unreadable',
    modelProviders: [...modelProviders.values()],
    checklist: [
      {
        key: 'providers',
        done: modelsAvailable > 0,
        detail:
          modelsAvailable > 0
            ? `${modelsAvailable} model(s) available; default ${settings.defaultEntryModel ?? DEFAULT_PLATFORM_SETTINGS.defaultEntryModel ?? 'pi default'}`
            : modelsConfigured > 0 && healthUnknown
              ? `${modelsConfigured} model(s) configured; provider health unknown — llm-proxy's provider-health.json ${providerHealthFile === 'missing' ? 'is not written' : 'is malformed or unreadable'} (check its log)`
              : modelsConfigured > 0
                ? `${modelsConfigured} model(s) configured, none whose provider passed a test — test the provider in the console`
                : modelsStatus !== 'ok'
                  ? 'models.json unreadable — fix or re-save the provider configuration'
                  : 'no model provider yet — add one in the console',
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
    recentAudit: recent,
  };
  return { result: overview };
};
