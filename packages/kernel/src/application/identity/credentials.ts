/**
 * A platform user's credential lifecycle (review 2026-10-02 R-12 / R-13, maintainer decision
 * D-25): setting or changing a password, and the one function that revokes what a user holds.
 * Separate from users.ts because it builds on console-session.ts, which itself reads users.ts.
 *
 * A user reaches the platform through four kinds of credential: console sessions
 * (`user_sessions`), the API key of a human membership Principal (`principals.api_key_hash`, kept
 * only by members the operator CLI provisioned — the console no longer issues one to a person,
 * D-25), and the Handles minted under any session acting on a membership's behalf (`entry`,
 * `mcp_session`, `worker_run`, `web`). Handle verification reads `capability_handles.revoked_at`
 * and never `sessions.status` (governance/capability/handles.ts), so "revoke a session" means
 * revoking its Handles; `sessions.status = 'revoked'` (with `expires_at` pulled to now) is the
 * bookkeeping that makes the next Turn open a fresh entry session instead of reusing the old one.
 * Every revocation writes `'revoked'` over whatever live status the row had — `active` for most
 * kinds, `starting` for an entry session, which never advances (agent-host-runtime.ts).
 */
import type { PoolClient } from 'pg';
import type { PoolLike } from '../../adapters/db/pool.js';
import { revokeSession } from '../../governance/capability/index.js';
import { withAdminClient } from '../gateway/auth.js';
import { readPlatformSettings } from '../platform/settings.js';
import { revokeAllUserSessions } from './console-session.js';
import { hashPassword } from './password.js';
import {
  IdentityError,
  type UserRow,
  assertPasswordStrength,
  checkPassword,
  findUserById,
} from './users.js';

export interface UserCredentialRevocation {
  /** The `user_sessions` rows revoked — the console sockets to close. */
  readonly consoleSessionIds: readonly string[];
  /** The human membership Principals whose sessions, Handles and API key were revoked. */
  readonly principalIds: readonly string[];
}

export interface RevokeUserCredentialsOptions {
  /** Only the user's membership in this workspace (`remove_membership`); console sessions, which
   *  are not tied to a workspace, are left alone. */
  readonly workspaceId?: string;
  /** Keep this one console session (a self-service password change keeps the browser that made
   *  it); every other one is revoked. */
  readonly keepConsoleSessionId?: string;
  /** Leave the user's running Workers alone: `worker_run` sessions and their Handles are not
   *  touched. A self-service password change sets it — the person changing their own password
   *  must not see their Tasks lose LLM access mid-run. Resets, disables and removals never do. */
  readonly keepWorkerRuns?: boolean;
}

/**
 * R-12 / D-25: revokes everything `userId` holds, on `client` inside the caller's transaction —
 * `reset_user_password`, `set_user_status` → disabled, a self-service password change and (scoped
 * to one workspace) `remove_membership` all call this, and nothing else revokes a user's access in
 * bulk. For each of the user's human membership Principals: its API key is cleared, every session
 * on its behalf is marked revoked, and every Handle minted under those sessions is revoked
 * (`revokeSession` per session — what `revokeOnBehalfOfSessionHandles`, the primitive
 * `disable_principal` uses, does — and llm-proxy picks the revocations up through its sync).
 * Plus the console sessions; `keepWorkerRuns` spares the `worker_run` sessions (see the options).
 *
 * Works on a platform transaction (`nexttime_app` with `app.platform = on`: `user_sessions`,
 * `principals` and `sessions` through their `*_platform_admin` policies) and on the admin client.
 * `capability_handles` carries only the workspace-isolation policy (governance 0001), so each
 * Principal's statements run with `app.workspace_id` set to its workspace; the caller's own value
 * is restored afterwards, so nothing the caller does next is scoped by accident.
 */
export async function revokeUserCredentials(
  client: PoolClient,
  userId: string,
  options: RevokeUserCredentialsOptions = {},
): Promise<UserCredentialRevocation> {
  const consoleSessionIds =
    options.workspaceId === undefined
      ? await revokeAllUserSessions(client, userId, {
          exceptSessionId: options.keepConsoleSessionId,
        })
      : [];
  const principals = await client.query<{ workspace_id: string; id: string }>(
    `select workspace_id, id from principals
      where user_id = $1 and kind = 'human' and ($2::uuid is null or workspace_id = $2::uuid)`,
    [userId, options.workspaceId ?? null],
  );
  const previous = await client.query<{ workspace_id: string | null }>(
    "select current_setting('app.workspace_id', true) as workspace_id",
  );
  try {
    for (const principal of principals.rows) {
      await client.query("select set_config('app.workspace_id', $1, true)", [
        principal.workspace_id,
      ]);
      await client.query(
        `update principals set api_key_hash = null
          where workspace_id = $1 and id = $2 and api_key_hash is not null`,
        [principal.workspace_id, principal.id],
      );
      const params = [principal.workspace_id, principal.id, options.keepWorkerRuns === true];
      // Every session's Handles — a session already marked revoked included: its status never
      // stopped a Handle, and `revokeSession` is idempotent.
      const sessions = await client.query<{ id: string }>(
        `select id from sessions
          where workspace_id = $1 and on_behalf_of = $2
            and ($3::boolean is false or kind <> 'worker_run')`,
        params,
      );
      await client.query(
        `update sessions set status = 'revoked', expires_at = least(expires_at, now())
          where workspace_id = $1 and on_behalf_of = $2 and status <> 'revoked'
            and ($3::boolean is false or kind <> 'worker_run')`,
        params,
      );
      for (const session of sessions.rows) await revokeSession(client, session.id);
    }
  } finally {
    await client.query("select set_config('app.workspace_id', $1, true)", [
      previous.rows[0]?.workspace_id ?? '',
    ]);
  }
  return { consoleSessionIds, principalIds: principals.rows.map((row) => row.id) };
}

/** The platform's password rule with its configured minimum (`passwordMinLength`). */
async function assertPlatformPasswordPolicy(client: PoolClient, password: string): Promise<void> {
  const { settings } = await readPlatformSettings(client);
  assertPasswordStrength(password, settings.passwordMinLength);
}

/** `set-password` (operator CLI): gives a user a first or replacement password and ends every
 *  console session signed in with the old one (R-13). Applies the platform's password rule. Leaves
 *  the user's API keys and Handles alone: the CLI runs with host-level trust, and the acceptance
 *  suites give a CLI-provisioned member a console password while they keep using its key. */
export async function setUserPassword(
  pool: PoolLike,
  userId: string,
  password: string,
  options: { readonly mustChangePassword: boolean },
): Promise<void> {
  await withAdminClient(pool, async (client) => {
    await assertPlatformPasswordPolicy(client, password);
    const passwordHash = await hashPassword(password);
    const result = await client.query(
      `update users
         set password_hash = $2, must_change_password = $3, failed_login_count = 0,
             locked_until = null, updated_at = now()
       where id = $1`,
      [userId, passwordHash, options.mustChangePassword],
    );
    if ((result.rowCount ?? 0) === 0) throw new IdentityError('user_not_found', 'user not found');
    await revokeAllUserSessions(client, userId);
  });
}

export interface ChangeOwnPasswordInput {
  readonly userId: string;
  /** The console session making the change — the one session that survives it. */
  readonly consoleSessionId: string;
  readonly currentPassword: string;
  readonly newPassword: string;
}

export type ChangeOwnPasswordOutcome =
  | {
      readonly ok: true;
      readonly user: UserRow;
      readonly revoked: UserCredentialRevocation;
    }
  | { readonly ok: false; readonly reason: 'bad_credentials' | 'locked' };

/**
 * `POST /api/auth/password` (R-13). The new password must pass the same rule the administrator's
 * reset applies (the platform's `passwordMinLength`). The current password is verified through
 * `checkPassword`, so wrong guesses count toward the login lockout — a stolen cookie cannot be used
 * to brute-force it. On success the password is stored, `must_change_password` cleared, and the
 * user's other credentials are revoked as a reset revokes them (`revokeUserCredentials`) — other
 * console sessions, membership API keys, `mcp_session` and entry Handles — except for the console
 * session making the change and the user's running Workers (`keepWorkerRuns`): a person changing
 * their own password must not see their Tasks lose LLM access mid-run.
 */
export async function changeOwnPassword(
  pool: PoolLike,
  input: ChangeOwnPasswordInput,
): Promise<ChangeOwnPasswordOutcome> {
  await withAdminClient(pool, (client) => assertPlatformPasswordPolicy(client, input.newPassword));
  const user = await findUserById(pool, input.userId);
  if (!user) throw new IdentityError('user_not_found', 'user not found');
  const check = await checkPassword(pool, user.login, input.currentPassword);
  if (!check.ok) {
    return { ok: false, reason: check.reason === 'locked' ? 'locked' : 'bad_credentials' };
  }
  if (check.user.id !== user.id) return { ok: false, reason: 'bad_credentials' };
  const passwordHash = await hashPassword(input.newPassword);
  const revoked = await withAdminClient(pool, async (client) => {
    await client.query(
      `update users
         set password_hash = $2, must_change_password = false, failed_login_count = 0,
             locked_until = null, updated_at = now()
       where id = $1`,
      [user.id, passwordHash],
    );
    return revokeUserCredentials(client, user.id, {
      keepConsoleSessionId: input.consoleSessionId,
      keepWorkerRuns: true,
    });
  });
  const updated = await findUserById(pool, user.id);
  if (!updated) throw new IdentityError('user_not_found', 'user not found');
  return { ok: true, user: updated, revoked };
}
