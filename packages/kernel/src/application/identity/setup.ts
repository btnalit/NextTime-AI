/**
 * First-run administrator (S4.1, design doc §7.11 "初始化", revised 2026-09-11 by the maintainer:
 * an installed host must have an administrator that can log in *immediately*, with no extra
 * ceremony — no token exchange, no setup page).
 *
 * When the kernel starts and no active platform administrator exists, it creates the user
 * `admin` (platform_role admin) with a random *temporary* password: the plaintext goes, once, to
 * a 0600 file under the setup directory the compose file mounts writable
 * (`INITIAL_ADMIN_PASSWORD_FILE`), the log line names the path — never the value — and the first
 * login forces a password change (`must_change_password`). Once an active administrator exists
 * the file is removed and nothing is ever regenerated. This is the "generated initial password
 * printed at install" every appliance uses; what §7.11 rejects is a *fixed* default (`admin` /
 * `admin`) — the plaintext here is unguessable and lives only on the host.
 *
 * `createPlatformAdmin` is the CLI fallback for the case where that file is lost before the first
 * login and nobody wants to restart the kernel.
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PoolLike } from '../../adapters/db/pool.js';
import { withAdminClient } from '../gateway/auth.js';
import { hashPassword } from './password.js';
import {
  IdentityError,
  type UserRow,
  countActivePlatformAdmins,
  findUserByLogin,
  insertUser,
} from './users.js';

export const INITIAL_ADMIN_LOGIN = 'admin';
export const INITIAL_ADMIN_DISPLAY_NAME = 'Administrator';
export const DEFAULT_INITIAL_ADMIN_PASSWORD_FILE = '/run/setup/initial-admin-password';

export interface EnsureInitialAdminOptions {
  readonly passwordFile?: string;
  readonly log?: (line: string) => void;
}

/**
 * Startup step. Returns the path the temporary password was written to, or `undefined` when an
 * active administrator already exists (in which case a stale password file is removed). Never
 * rotates an existing administrator's password: the only time this writes anything is the very
 * first start (or a start after every administrator was disabled).
 */
export async function ensureInitialAdmin(
  pool: PoolLike,
  options: EnsureInitialAdminOptions = {},
): Promise<string | undefined> {
  const passwordFile = options.passwordFile ?? DEFAULT_INITIAL_ADMIN_PASSWORD_FILE;
  const log = options.log ?? (() => {});
  if ((await countActivePlatformAdmins(pool)) > 0) {
    await rm(passwordFile, { force: true }).catch(() => {});
    return undefined;
  }
  const password = randomBytes(18).toString('base64url');
  const passwordHash = await hashPassword(password);
  const existing = await findUserByLogin(pool, INITIAL_ADMIN_LOGIN);
  if (existing?.hasPassword && existing.platformRole !== 'admin') {
    // A person already owns the login `admin` (claimed it with their own password) — never
    // overwrite their password. The operator creates an administrator by hand instead.
    throw new IdentityError(
      'login_taken',
      `login "${INITIAL_ADMIN_LOGIN}" belongs to a non-administrator user; create an administrator with bootstrap.js create-platform-admin`,
    );
  }
  await withAdminClient(pool, async (client) => {
    if (existing) {
      // Disabled or passwordless `admin` row (e.g. every admin was disabled, or a backfilled
      // user happens to carry the login): re-arm it as the temporary-password administrator.
      await client.query(
        `update users
            set password_hash = $2, platform_role = 'admin', status = 'active',
                must_change_password = true, failed_login_count = 0, locked_until = null,
                updated_at = now()
          where id = $1`,
        [existing.id, passwordHash],
      );
    } else {
      await insertUser(client, {
        login: INITIAL_ADMIN_LOGIN,
        displayName: INITIAL_ADMIN_DISPLAY_NAME,
        password,
        platformRole: 'admin',
        mustChangePassword: true,
      });
    }
  });
  await mkdir(path.dirname(passwordFile), { recursive: true, mode: 0o700 });
  await writeFile(passwordFile, `${password}\n`, { mode: 0o600, flag: 'w' });
  await chmod(passwordFile, 0o600).catch(() => {});
  log(
    JSON.stringify({
      level: 'warn',
      msg: `no platform administrator existed: user "${INITIAL_ADMIN_LOGIN}" was created with a temporary password; log in with it and change it`,
      passwordFile,
    }),
  );
  return passwordFile;
}

/** CLI fallback (`bootstrap.js create-platform-admin`): an administrator with a chosen login and
 *  password — only reachable by whoever can run a command inside the kernel container. */
export async function createPlatformAdmin(
  pool: PoolLike,
  input: {
    readonly login: string;
    readonly displayName: string;
    readonly password: string;
    readonly mustChangePassword?: boolean;
  },
): Promise<UserRow> {
  return withAdminClient(pool, (client) =>
    insertUser(client, {
      login: input.login,
      displayName: input.displayName,
      password: input.password,
      platformRole: 'admin',
      mustChangePassword: input.mustChangePassword ?? false,
    }),
  );
}
