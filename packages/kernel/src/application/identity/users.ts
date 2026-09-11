import type { Role } from '@nexttime/shared';
/**
 * Platform users and their workspace memberships (S4.1, design doc §7.11 "身份模型：用户在平台，
 * 成员资格在工作区").
 *
 * A *user* is a platform-level row (`users`: login, password, platform_role admin|user); a human
 * Principal is that user's membership in one workspace (`principals.user_id`) and keeps the five
 * workspace roles. Everything in this module runs on the admin client (`withAdminClient`): the
 * `users` table has no workspace and no RLS, and the membership lookups below are pinned to one
 * (user, workspace) pair — the same reasoning `lookupPrincipalByApiKeyHash` uses.
 *
 * Nothing here holds or sees an external credential: password hashes are the platform's own
 * identity store (see password.ts), API keys keep living on `principals.api_key_hash`.
 */
import type { PoolClient } from 'pg';
import type { PoolLike } from '../../adapters/db/pool.js';
import { withWorkspace } from '../../adapters/db/pool.js';
import { withAdminClient } from '../gateway/auth.js';
import { MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from './password.js';

export type PlatformRole = 'admin' | 'user';
export type UserStatus = 'active' | 'disabled';

export interface UserRow {
  readonly id: string;
  readonly login: string;
  readonly displayName: string;
  readonly platformRole: PlatformRole;
  readonly status: UserStatus;
  readonly mustChangePassword: boolean;
  readonly hasPassword: boolean;
  readonly createdAt: Date;
}

export interface MembershipRow {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceStatus: 'active' | 'disabled';
  readonly principalId: string;
  readonly role: Role;
  readonly disabled: boolean;
}

interface UserDbRow {
  id: string;
  login: string;
  display_name: string;
  platform_role: string;
  status: string;
  must_change_password: boolean;
  has_password: boolean;
  created_at: Date;
}

const USER_COLUMNS = `id, login, display_name, platform_role, status, must_change_password,
  (password_hash is not null) as has_password, created_at`;

const ENV_ADMINS_VAR = 'NEXTTIME_PLATFORM_ADMINS';

/** Logins that are always platform administrators (docs/platform-admin-design.md §6.6, borrowed
 *  from cloudflare-os `ADMINS`): comma/space-separated, lower-cased; empty when unset. Applied at
 *  the single point every reader of a user row goes through (`mapUser`), so a login named here is
 *  `admin` for the console session, `/api/auth/me`, the platform channel and the users page alike,
 *  whatever `users.platform_role` says — the anti-lockout backstop a hijacked admin session cannot
 *  edit. The platform handlers additionally refuse to disable, demote or reset such an account. */
export function envAdminLogins(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const raw = env[ENV_ADMINS_VAR];
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(/[,\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/** The platform role a user effectively holds: `admin` when the login is env-pinned. */
export function effectivePlatformRole(login: string, stored: PlatformRole): PlatformRole {
  return envAdminLogins().includes(login) ? 'admin' : stored;
}

function mapUser(row: UserDbRow): UserRow {
  return {
    id: row.id,
    login: row.login,
    displayName: row.display_name,
    platformRole: effectivePlatformRole(row.login, row.platform_role as PlatformRole),
    status: row.status as UserStatus,
    mustChangePassword: row.must_change_password,
    hasPassword: row.has_password,
    createdAt: row.created_at,
  };
}

export type IdentityErrorKind =
  | 'invalid_login'
  | 'invalid_display_name'
  | 'login_taken'
  | 'weak_password'
  | 'user_not_found'
  | 'already_claimed'
  | 'already_member'
  | 'invalid_api_key'
  | 'last_admin';

export class IdentityError extends Error {
  readonly kind: IdentityErrorKind;

  constructor(kind: IdentityErrorKind, message: string) {
    super(message);
    this.name = 'IdentityError';
    this.kind = kind;
  }
}

/** Login names: 3–64 chars of `[a-z0-9._-]`, must start with a letter or digit. Lower-cased. */
export const LOGIN_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;

export function normalizeLogin(login: string): string {
  const normalized = login.trim().toLowerCase();
  if (!LOGIN_PATTERN.test(normalized)) {
    throw new IdentityError(
      'invalid_login',
      'login must be 3–64 characters of a-z, 0-9, ".", "_" or "-", starting with a letter or digit',
    );
  }
  return normalized;
}

export function assertPasswordStrength(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > 256) {
    throw new IdentityError(
      'weak_password',
      `password must be ${MIN_PASSWORD_LENGTH}–256 characters`,
    );
  }
}

/** The backfill's login shape (migration 0019): `<slug of display name>-<8 hex of id>`. Used for
 *  human principals created by the legacy CLI / `create_principal` paths after the migration, so
 *  every human Principal keeps pointing at a user even when nobody typed a login for it. */
export function derivedLogin(displayName: string | null | undefined, principalId: string): string {
  const slug = (displayName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return `${slug || 'user'}-${principalId.slice(0, 8)}`;
}

export async function findUserByLogin(pool: PoolLike, login: string): Promise<UserRow | null> {
  return withAdminClient(pool, async (client) => {
    const result = await client.query<UserDbRow>(
      `select ${USER_COLUMNS} from users where login = $1`,
      [login.trim().toLowerCase()],
    );
    const row = result.rows[0];
    return row ? mapUser(row) : null;
  });
}

export async function findUserById(pool: PoolLike, id: string): Promise<UserRow | null> {
  return withAdminClient(pool, async (client) => {
    const result = await client.query<UserDbRow>(
      `select ${USER_COLUMNS} from users where id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? mapUser(row) : null;
  });
}

export interface CreateUserInput {
  readonly login: string;
  readonly displayName: string;
  /** Plain password; hashed here. Omit for a user that cannot log in yet (backfill shape). */
  readonly password?: string;
  readonly platformRole?: PlatformRole;
  /** Admin-set passwords are temporary (§7.11): force a change on first login. */
  readonly mustChangePassword?: boolean;
}

/** Creates a user on the given client (caller owns the transaction — `createWorkspace` and the
 *  setup flow create a user and a membership together). */
export async function insertUser(client: PoolClient, input: CreateUserInput): Promise<UserRow> {
  const login = normalizeLogin(input.login);
  const displayName = input.displayName.trim() || login;
  let passwordHash: string | null = null;
  if (input.password !== undefined) {
    assertPasswordStrength(input.password);
    passwordHash = await hashPassword(input.password);
  }
  const existing = await client.query('select 1 from users where login = $1', [login]);
  if ((existing.rowCount ?? 0) > 0) {
    throw new IdentityError('login_taken', `login "${login}" is already taken`);
  }
  const result = await client.query<UserDbRow>(
    `insert into users (login, display_name, password_hash, platform_role, must_change_password)
     values ($1, $2, $3, $4, $5)
     returning ${USER_COLUMNS}`,
    [
      login,
      displayName,
      passwordHash,
      input.platformRole ?? 'user',
      input.mustChangePassword ?? false,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertUser: INSERT ... RETURNING produced no row');
  return mapUser(row);
}

export async function createUser(pool: PoolLike, input: CreateUserInput): Promise<UserRow> {
  return withAdminClient(pool, (client) => insertUser(client, input));
}

/** Ensures a human Principal points at a user: if `principals.user_id` is already set, no-op;
 *  otherwise creates a passwordless user with the derived login and links it. For the legacy
 *  creation paths (CLI `create-workspace` / `add-principal`, S3.11 `create_principal`). Runs on
 *  the caller's client, inside its transaction — which for `create_principal` is the
 *  `nexttime_app` role, so the INSERT below names exactly the columns migration 0019 grants that
 *  role (`login`, `display_name`; never `password_hash`) and reads back only `id`. Do not route
 *  this through `insertUser`, whose column list needs the admin path. */
export async function ensureUserForHumanPrincipal(
  client: PoolClient,
  principal: {
    readonly workspaceId: string;
    readonly id: string;
    readonly displayName: string | null;
  },
): Promise<string> {
  const current = await client.query<{ user_id: string | null }>(
    'select user_id from principals where workspace_id = $1 and id = $2',
    [principal.workspaceId, principal.id],
  );
  const existing = current.rows[0]?.user_id;
  if (existing) return existing;
  const login = derivedLogin(principal.displayName, principal.id);
  const taken = await client.query('select 1 from users where login = $1', [login]);
  if ((taken.rowCount ?? 0) > 0) {
    throw new IdentityError('login_taken', `login "${login}" is already taken`);
  }
  const inserted = await client.query<{ id: string }>(
    'insert into users (login, display_name) values ($1, $2) returning id',
    [login, principal.displayName?.trim() || login],
  );
  const userId = inserted.rows[0]?.id;
  if (!userId) throw new Error('ensureUserForHumanPrincipal: INSERT ... RETURNING produced no row');
  await client.query('update principals set user_id = $3 where workspace_id = $1 and id = $2', [
    principal.workspaceId,
    principal.id,
    userId,
  ]);
  return userId;
}

export interface ClaimIdentityInput {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly login: string;
  readonly displayName: string;
  readonly password: string;
  /** Only the setup flow raises this (first administrator claiming their existing identity). */
  readonly platformRole?: PlatformRole;
}

/**
 * Turns the passwordless user behind an existing human Principal (migration 0019's backfill, or
 * one created by the CLI / `create_principal`) into a login-able account, in place: the caller
 * proves they *are* that person by holding the Principal's API key (the route resolves it to
 * `principalId` before calling this), then chooses their own login, display name and password.
 * One-way and once: a user that already has a password cannot be re-claimed — an API key is a
 * workspace credential, and letting it overwrite a platform password would turn a leaked key
 * into a platform-account takeover. Runs on `client` (caller's transaction) so the setup flow can
 * combine it with consuming the token. Throws `IdentityError` (`already_claimed`, `login_taken`,
 * `invalid_login`, `weak_password`, `user_not_found`).
 */
export async function claimIdentityOnClient(
  client: PoolClient,
  input: ClaimIdentityInput,
): Promise<UserRow> {
  const login = normalizeLogin(input.login);
  assertPasswordStrength(input.password);
  const displayName = input.displayName.trim();
  if (displayName.length === 0 || displayName.length > 128) {
    throw new IdentityError('invalid_display_name', 'display name must be 1–128 characters');
  }
  const principal = await client.query<{ display_name: string | null }>(
    `select display_name from principals
      where workspace_id = $1 and id = $2 and kind = 'human' and disabled_at is null`,
    [input.workspaceId, input.principalId],
  );
  if (!principal.rows[0]) throw new IdentityError('user_not_found', 'principal not found');
  const userId = await ensureUserForHumanPrincipal(client, {
    workspaceId: input.workspaceId,
    id: input.principalId,
    displayName: principal.rows[0].display_name,
  });
  const current = await client.query<{ password_hash: string | null }>(
    'select password_hash from users where id = $1 for update',
    [userId],
  );
  if (current.rows[0]?.password_hash) {
    throw new IdentityError(
      'already_claimed',
      'this identity already has a password; log in with it (or ask an administrator to reset it)',
    );
  }
  const taken = await client.query('select 1 from users where login = $1 and id <> $2', [
    login,
    userId,
  ]);
  if ((taken.rowCount ?? 0) > 0) {
    throw new IdentityError('login_taken', `login "${login}" is already taken`);
  }
  const passwordHash = await hashPassword(input.password);
  const updated = await client.query<UserDbRow>(
    `update users
        set login = $2, display_name = $3, password_hash = $4,
            platform_role = coalesce($5, platform_role), must_change_password = false,
            failed_login_count = 0, locked_until = null, updated_at = now()
      where id = $1
      returning ${USER_COLUMNS}`,
    [userId, login, displayName, passwordHash, input.platformRole ?? null],
  );
  const row = updated.rows[0];
  if (!row) throw new IdentityError('user_not_found', 'user not found');
  return mapUser(row);
}

export async function claimIdentity(pool: PoolLike, input: ClaimIdentityInput): Promise<UserRow> {
  return withAdminClient(pool, (client) => claimIdentityOnClient(client, input));
}

export interface BindPrincipalInput {
  /** The calling (cookie-authenticated) user — the account that will own the membership. */
  readonly userId: string;
  /** The Principal the API key resolved to (`lookupPrincipalByApiKeyHash`). */
  readonly workspaceId: string;
  readonly principalId: string;
}

/**
 * "绑定已有 API key" (S4.1 revision): moves an existing human Principal — proven by holding its
 * API key — onto the calling user's account, so a person who logs in with a password (the
 * pre-created `admin`, or anyone) picks up the workspace memberships they already had under
 * pre-S4.1 API keys. The key keeps working (same Principal, same hash); only `principals.user_id`
 * changes, and the Principal's former passwordless user row is deleted when nothing else points
 * at it. Refused when that former user has a password (`already_claimed`: it is somebody's
 * account, and a workspace key must never absorb a platform account) or when the caller already
 * has a membership in that workspace (`already_member`, the `(workspace_id, user_id)` unique
 * index). Binding a Principal that is already the caller's own is a no-op.
 */
export async function bindPrincipalToUser(
  pool: PoolLike,
  input: BindPrincipalInput,
): Promise<void> {
  await withAdminClient(pool, async (client) => {
    const current = await client.query<{ user_id: string | null }>(
      `select user_id from principals
        where workspace_id = $1 and id = $2 and kind = 'human' and disabled_at is null
        for update`,
      [input.workspaceId, input.principalId],
    );
    const row = current.rows[0];
    if (!row)
      throw new IdentityError('invalid_api_key', 'that API key does not belong to a person');
    const formerUserId = row.user_id;
    if (formerUserId === input.userId) return;
    const clash = await client.query(
      'select 1 from principals where workspace_id = $1 and user_id = $2 and id <> $3',
      [input.workspaceId, input.userId, input.principalId],
    );
    if ((clash.rowCount ?? 0) > 0) {
      throw new IdentityError('already_member', 'you already have a membership in that workspace');
    }
    if (formerUserId) {
      const former = await client.query<{ password_hash: string | null }>(
        'select password_hash from users where id = $1 for update',
        [formerUserId],
      );
      if (former.rows[0]?.password_hash) {
        throw new IdentityError(
          'already_claimed',
          'that API key belongs to an account that already has its own password',
        );
      }
    }
    await client.query('update principals set user_id = $3 where workspace_id = $1 and id = $2', [
      input.workspaceId,
      input.principalId,
      input.userId,
    ]);
    if (formerUserId) {
      const stillReferenced = await client.query(
        'select 1 from principals where user_id = $1 limit 1',
        [formerUserId],
      );
      if ((stillReferenced.rowCount ?? 0) === 0) {
        await client.query('delete from user_sessions where user_id = $1', [formerUserId]);
        await client.query('delete from users where id = $1', [formerUserId]);
      }
    }
  });
}

export async function setUserPassword(
  pool: PoolLike,
  userId: string,
  password: string,
  options: { readonly mustChangePassword: boolean },
): Promise<void> {
  assertPasswordStrength(password);
  const passwordHash = await hashPassword(password);
  await withAdminClient(pool, async (client) => {
    const result = await client.query(
      `update users
         set password_hash = $2, must_change_password = $3, failed_login_count = 0,
             locked_until = null, updated_at = now()
       where id = $1`,
      [userId, passwordHash, options.mustChangePassword],
    );
    if ((result.rowCount ?? 0) === 0) throw new IdentityError('user_not_found', 'user not found');
  });
}

export async function updateUserDisplayName(
  pool: PoolLike,
  userId: string,
  displayName: string,
): Promise<UserRow> {
  const trimmed = displayName.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    throw new IdentityError('invalid_display_name', 'display name must be 1–128 characters');
  }
  return withAdminClient(pool, async (client) => {
    const result = await client.query<UserDbRow>(
      `update users set display_name = $2, updated_at = now() where id = $1 returning ${USER_COLUMNS}`,
      [userId, trimmed],
    );
    const row = result.rows[0];
    if (!row) throw new IdentityError('user_not_found', 'user not found');
    return mapUser(row);
  });
}

/** `POST /api/auth/password`: verifies the current password, then stores the new one and clears
 *  `must_change_password`. `null` = current password wrong (the route answers 401). */
export async function changeOwnPassword(
  pool: PoolLike,
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<UserRow | null> {
  assertPasswordStrength(newPassword);
  const current = await withAdminClient(pool, async (client) => {
    const result = await client.query<{ password_hash: string | null }>(
      'select password_hash from users where id = $1',
      [userId],
    );
    return result.rows[0]?.password_hash ?? null;
  });
  if (current === null || !(await verifyPassword(currentPassword, current))) return null;
  await setUserPassword(pool, userId, newPassword, { mustChangePassword: false });
  return findUserById(pool, userId);
}

export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCK_MINUTES = 5;

export type PasswordCheck =
  | { readonly ok: true; readonly user: UserRow }
  | { readonly ok: false; readonly reason: 'bad_credentials' | 'locked' | 'disabled' };

/**
 * Verifies a login + password with the S4.1 throttle: 5 consecutive failures lock the login for
 * 5 minutes; a success resets the counter. Unknown logins take the same code path length as
 * wrong passwords (a dummy hash verification) so timing does not reveal which logins exist.
 */
export async function checkPassword(
  pool: PoolLike,
  login: string,
  password: string,
): Promise<PasswordCheck> {
  const normalized = login.trim().toLowerCase();
  const row = await withAdminClient(pool, async (client) => {
    const result = await client.query<
      UserDbRow & { password_hash: string | null; locked_until: Date | null }
    >(`select ${USER_COLUMNS}, password_hash, locked_until from users where login = $1`, [
      normalized,
    ]);
    return result.rows[0];
  });
  if (!row || row.password_hash === null) {
    await verifyPassword(password, DUMMY_HASH); // equalize timing
    return { ok: false, reason: 'bad_credentials' };
  }
  if (row.locked_until && row.locked_until.getTime() > Date.now()) {
    return { ok: false, reason: 'locked' };
  }
  const verified = await verifyPassword(password, row.password_hash);
  if (!verified) {
    await withAdminClient(pool, (client) =>
      client.query(
        `update users
           set failed_login_count = failed_login_count + 1,
               locked_until = case when failed_login_count + 1 >= $2
                                   then now() + make_interval(mins => $3) else locked_until end,
               updated_at = now()
         where id = $1`,
        [row.id, LOGIN_MAX_FAILURES, LOGIN_LOCK_MINUTES],
      ),
    );
    return { ok: false, reason: 'bad_credentials' };
  }
  if (row.status !== 'active') return { ok: false, reason: 'disabled' };
  await withAdminClient(pool, (client) =>
    client.query('update users set failed_login_count = 0, locked_until = null where id = $1', [
      row.id,
    ]),
  );
  return { ok: true, user: mapUser(row) };
}

// A real scrypt hash of a random value, used only to keep the unknown-login path as slow as the
// known-login path. Generated once per process.
let dummyHashPromise: Promise<string> | undefined;
const DUMMY_HASH_PLACEHOLDER =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
let DUMMY_HASH = DUMMY_HASH_PLACEHOLDER;
export function primeDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword('nexttime-dummy').then((h) => {
      DUMMY_HASH = h;
      return h;
    });
  }
  return dummyHashPromise;
}
void primeDummyHash().catch(() => {});

export async function countActivePlatformAdmins(pool: PoolLike): Promise<number> {
  return withAdminClient(pool, async (client) => {
    const result = await client.query<{ n: string }>(
      `select count(*)::text as n from users where platform_role = 'admin' and status = 'active'`,
    );
    return Number(result.rows[0]?.n ?? '0');
  });
}

interface MembershipDbRow {
  workspace_id: string;
  workspace_name: string;
  workspace_status: string;
  principal_id: string;
  role: string;
  disabled: boolean;
}

function mapMembership(row: MembershipDbRow): MembershipRow {
  return {
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    workspaceStatus: row.workspace_status as 'active' | 'disabled',
    principalId: row.principal_id,
    role: row.role as Role,
    disabled: row.disabled,
  };
}

/** Every membership of a user, including disabled ones (flagged) — the console shows them
 *  greyed out; `findActiveMembership` below is what authentication uses. */
export async function listMemberships(pool: PoolLike, userId: string): Promise<MembershipRow[]> {
  return withAdminClient(pool, async (client) => {
    const result = await client.query<MembershipDbRow>(
      `select p.workspace_id, w.name as workspace_name, w.status as workspace_status,
              p.id as principal_id, p.role, (p.disabled_at is not null) as disabled
         from principals p
         join workspaces w on w.id = p.workspace_id
        where p.user_id = $1 and p.kind = 'human'
        order by w.created_at`,
      [userId],
    );
    return result.rows.map(mapMembership);
  });
}

/** The usable memberships: principal not disabled, workspace active. */
export async function listActiveMemberships(
  pool: PoolLike,
  userId: string,
): Promise<MembershipRow[]> {
  const all = await listMemberships(pool, userId);
  return all.filter((m) => !m.disabled && m.workspaceStatus === 'active');
}

export async function findActiveMembership(
  pool: PoolLike,
  userId: string,
  workspaceId: string,
): Promise<MembershipRow | null> {
  const all = await listActiveMemberships(pool, userId);
  return all.find((m) => m.workspaceId === workspaceId) ?? null;
}

/** Revokes every workspace session of a user's principals (used when a user is disabled or
 *  logs out everywhere). Runs under `app.platform = on` — the one cross-workspace write this
 *  module makes, on the `sessions_platform_admin` policy. */
export async function revokeWorkspaceSessionsForUser(
  pool: PoolLike,
  userId: string,
): Promise<number> {
  return withWorkspace(
    pool,
    {
      workspaceId: '00000000-0000-0000-0000-000000000000',
      principalId: '00000000-0000-0000-0000-000000000000',
    },
    async (client) => {
      await client.query("select set_config('app.platform', 'on', true)");
      const result = await client.query(
        `update sessions s
            set status = 'revoked', expires_at = now()
           from principals p
          where p.workspace_id = s.workspace_id and p.id = s.principal_id
            and p.user_id = $1 and s.status = 'active'`,
        [userId],
      );
      return result.rowCount ?? 0;
    },
  );
}
