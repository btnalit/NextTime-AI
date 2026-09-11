/**
 * First-run initialization (S4.1, design doc §7.11 "初始化：一次性令牌，不是默认口令").
 *
 * When the kernel starts and no active platform admin exists, it mints a one-time setup token:
 * the sha256 of the token goes into `platform_setup` (single row, 24 h expiry, used_at, failure
 * counter), the plaintext into a 0600 file under the setup directory the compose file mounts
 * writable (`PLATFORM_SETUP_TOKEN_FILE`), and the log line names the path — never the value.
 * `POST /api/platform/setup` exchanges the token for the first admin user (login + password) and
 * marks it used; five wrong tokens invalidate it (a kernel restart mints a fresh one). Once an
 * active admin exists the token row is deleted and the file removed, and the route reports
 * `initialized: true` forever after.
 *
 * Rejected alternative (recorded in §7.11): a fixed default account.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import type { PoolLike } from '../../adapters/db/pool.js';
import { withAdminClient } from '../gateway/auth.js';
import { type UserRow, countActivePlatformAdmins, insertUser } from './users.js';

export const DEFAULT_SETUP_TOKEN_FILE = '/run/setup/token';
export const SETUP_TOKEN_TTL_HOURS = 24;
export const SETUP_TOKEN_MAX_FAILURES = 5;

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface SetupState {
  readonly initialized: boolean;
  /** Only meaningful when not initialized: whether a usable token currently exists. */
  readonly tokenAvailable: boolean;
}

export async function getSetupState(pool: PoolLike): Promise<SetupState> {
  const admins = await countActivePlatformAdmins(pool);
  if (admins > 0) return { initialized: true, tokenAvailable: false };
  const tokenAvailable = await withAdminClient(pool, async (client) => {
    const result = await client.query(
      `select 1 from platform_setup
        where used_at is null and expires_at > now() and failed_count < $1`,
      [SETUP_TOKEN_MAX_FAILURES],
    );
    return (result.rowCount ?? 0) > 0;
  });
  return { initialized: false, tokenAvailable };
}

export interface EnsureSetupTokenOptions {
  readonly tokenFile?: string;
  readonly log?: (line: string) => void;
}

/**
 * Startup step. Returns the path the token was written to, or `undefined` when the platform is
 * already initialized (in which case any stale token row/file is cleared). Always mints a fresh
 * token on a start without an admin — a previous token may have been consumed by a partial
 * setup or lost with the container's filesystem; the file is the only place the plaintext lives.
 */
export async function ensureSetupToken(
  pool: PoolLike,
  options: EnsureSetupTokenOptions = {},
): Promise<string | undefined> {
  const tokenFile = options.tokenFile ?? DEFAULT_SETUP_TOKEN_FILE;
  const log = options.log ?? (() => {});
  const admins = await countActivePlatformAdmins(pool);
  if (admins > 0) {
    await withAdminClient(pool, (client) => client.query('delete from platform_setup'));
    await rm(tokenFile, { force: true }).catch(() => {});
    return undefined;
  }
  const token = randomBytes(32).toString('base64url');
  await withAdminClient(pool, (client) =>
    client.query(
      `insert into platform_setup (singleton, token_hash, expires_at, used_at, failed_count)
       values (true, $1, now() + make_interval(hours => $2), null, 0)
       on conflict (singleton) do update
         set token_hash = excluded.token_hash, created_at = now(),
             expires_at = excluded.expires_at, used_at = null, failed_count = 0`,
      [hashToken(token), SETUP_TOKEN_TTL_HOURS],
    ),
  );
  await mkdir(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600, flag: 'w' });
  await chmod(tokenFile, 0o600).catch(() => {});
  log(
    JSON.stringify({
      level: 'warn',
      msg: 'platform not initialized: a one-time setup token was written; open the console to create the first administrator',
      tokenFile,
      expiresInHours: SETUP_TOKEN_TTL_HOURS,
    }),
  );
  return tokenFile;
}

export type SetupErrorKind = 'already_initialized' | 'invalid_token' | 'token_exhausted';

export class SetupError extends Error {
  readonly kind: SetupErrorKind;

  constructor(kind: SetupErrorKind, message: string) {
    super(message);
    this.name = 'SetupError';
    this.kind = kind;
  }
}

interface SetupRow {
  token_hash: string;
  expires_at: Date;
  used_at: Date | null;
  failed_count: number;
}

type SetupOutcome =
  | { readonly kind: 'ok'; readonly user: UserRow }
  | { readonly kind: 'invalid_token' | 'token_exhausted' };

export interface CompleteSetupInput {
  readonly token: string;
  readonly login: string;
  readonly displayName: string;
  readonly password: string;
}

/**
 * Exchanges the setup token for the first platform administrator. One transaction, and the
 * failure paths *return* rather than throw so the transaction commits: a wrong token's
 * `failed_count + 1` must survive the request that caused it (a throw would roll it back with
 * the rest of the transaction and make the five-strike invalidation unreachable). The success
 * path marks the token used and creates the user in the same transaction, so a lost response
 * cannot leave a used token with no admin; an `IdentityError` from `insertUser` (login taken,
 * weak password) does propagate — and rolls the `used_at` back with it, which is the intent:
 * the token is still good for a corrected second attempt. Throws `SetupError` / `IdentityError`.
 */
export async function completeSetup(pool: PoolLike, input: CompleteSetupInput): Promise<UserRow> {
  if ((await countActivePlatformAdmins(pool)) > 0) {
    throw new SetupError('already_initialized', 'the platform already has an administrator');
  }
  const outcome = await withAdminClient(pool, async (client): Promise<SetupOutcome> => {
    const row = (
      await client.query<SetupRow>(
        'select token_hash, expires_at, used_at, failed_count from platform_setup for update',
      )
    ).rows[0];
    if (!row || row.used_at !== null || row.expires_at.getTime() <= Date.now()) {
      return { kind: 'invalid_token' };
    }
    if (row.failed_count >= SETUP_TOKEN_MAX_FAILURES) return { kind: 'token_exhausted' };
    if (row.token_hash !== hashToken(input.token.trim())) {
      await client.query('update platform_setup set failed_count = failed_count + 1');
      return { kind: 'invalid_token' };
    }
    await client.query('update platform_setup set used_at = now()');
    const user = await insertUser(client, {
      login: input.login,
      displayName: input.displayName,
      password: input.password,
      platformRole: 'admin',
      mustChangePassword: false,
    });
    await client.query('delete from platform_setup');
    return { kind: 'ok', user };
  });
  switch (outcome.kind) {
    case 'ok':
      return outcome.user;
    case 'token_exhausted':
      throw new SetupError(
        'token_exhausted',
        'setup token invalidated after too many failures; restart the kernel to mint a new one',
      );
    default:
      throw new SetupError(
        'invalid_token',
        'setup token does not match or has expired; restart the kernel to mint a new one',
      );
  }
}

/** CLI fallback (`bootstrap.js create-platform-admin`): same result as `completeSetup` without a
 *  token — only reachable by whoever can run a command inside the kernel container. */
export async function createPlatformAdmin(
  pool: PoolLike,
  input: {
    readonly login: string;
    readonly displayName: string;
    readonly password: string;
    /** Admin-set passwords are temporary (§7.11): force a change on first login. Default false. */
    readonly mustChangePassword?: boolean;
  },
): Promise<UserRow> {
  return withAdminClient(pool, async (client) => {
    const user = await insertUser(client, {
      login: input.login,
      displayName: input.displayName,
      password: input.password,
      platformRole: 'admin',
      mustChangePassword: input.mustChangePassword ?? false,
    });
    await client.query('delete from platform_setup');
    return user;
  });
}
