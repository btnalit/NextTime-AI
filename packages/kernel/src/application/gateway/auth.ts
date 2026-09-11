import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PrincipalKind, Role } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type { PoolLike } from '../../adapters/db/pool.js';
import { withWorkspace } from '../../adapters/db/pool.js';

/**
 * application/gateway/auth: the human channel — `Authorization: Bearer <API key>` → sha256 →
 * `principals.api_key_hash` → Principal, plus create/reuse a `sessions` row of `kind='web'`
 * (design doc §5.1.1 Session, §9.2; docs/development-tasks.md S1.3, item 1).
 *
 * Placement (see PR body "假设"): `workspaces`/`principals`/`sessions` (migrations/core/
 * 0001_identity.sql) are not claimed by any module in design doc §7.1's module table (that table
 * lists gateway's own state ownership as "无"), yet 0001_identity.sql's own comments twice name
 * "the gateway" as the reader/writer of `api_key_hash` and `sessions` — so this module is, in
 * practice, identity's owner. Placed under `application/` (not `interfaces/`) because it composes
 * a DB read (adapters, allowed from application) with governance/capability's Handle-verification
 * service interface (governance, allowed from application) — exactly the kind of orchestration
 * `application/{chat,task,host-bridge,worker}` already do for their own domains (design doc
 * §7.10's layer table). `interfaces/http` calls this module; it never reaches into substrate or
 * governance directly (depcruise `kernel-interfaces-must-not-reach-into-substrate-directly`).
 *
 * The pre-workspace `api_key_hash` lookup: `withWorkspace()` (adapters/db/pool.ts) requires a
 * non-empty `workspaceId`/`principalId` up front, but at this point neither is known yet — that
 * is the whole reason `api_key_hash` is a globally unique column (0001_identity.sql comment).
 * The fix already established by packages/kernel/src/substrate/invariants.test.ts's
 * `adminInsertWorkspace` (bootstrapping the very first row in a workspace that does not exist
 * yet) is reused here as `withAdminClient`: pass throwaway `randomUUID()` placeholders for both
 * GUCs and `skipRoleSwitch: true`. Since skipping the role switch leaves the connection on the
 * superuser login role — which bypasses RLS unconditionally — those two GUC values are inert;
 * only `skipRoleSwitch` does the actual work of making the global lookup possible.
 */

export interface PrincipalRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly kind: PrincipalKind;
  readonly role: Role;
  readonly displayName: string | null;
}

export interface SessionRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly principalId: string;
  readonly kind: string;
  readonly onBehalfOf: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
}

export interface AuthenticatedHuman {
  readonly principal: PrincipalRow;
  readonly session: SessionRow;
}

interface PrincipalDbRow {
  workspace_id: string;
  id: string;
  kind: string;
  role: string;
  display_name: string | null;
}

interface SessionDbRow {
  workspace_id: string;
  id: string;
  principal_id: string;
  kind: string;
  on_behalf_of: string;
  status: string;
  created_at: Date;
  expires_at: Date | null;
}

function mapPrincipalRow(row: PrincipalDbRow): PrincipalRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    // `kind`/`role` are DB-CHECK-constrained to packages/shared's PrincipalKind/Role value sets
    // (migrations/core/0001_identity.sql) — cast, not re-validated, same convention
    // substrate/graph/sql-store.ts uses for `epistemic_status`.
    kind: row.kind as PrincipalKind,
    role: row.role as Role,
    displayName: row.display_name,
  };
}

function mapSessionRow(row: SessionDbRow): SessionRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    principalId: row.principal_id,
    kind: row.kind,
    onBehalfOf: row.on_behalf_of,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/** sha256 of the raw API key, hex-encoded — matches `principals.api_key_hash` (never the raw key). */
export function hashApiKey(rawApiKey: string): string {
  return createHash('sha256').update(rawApiKey, 'utf8').digest('hex');
}

const API_KEY_BYTES = 32;

/**
 * Generates a fresh raw API key (S3.11 `create_principal`/`rotate_api_key` reuse — moved out of
 * `cli/bootstrap.ts`'s former private copy, docs/development-tasks.md S3.11 "reuse the bootstrap
 * CLI's key generation + sha256 hashing path ... factor a shared function if needed, no duplicate
 * hashing code"). Never logged; the caller is responsible for returning it to its caller exactly
 * once and storing only `hashApiKey(...)` of it.
 */
export function generateApiKey(): string {
  return randomBytes(API_KEY_BYTES).toString('base64url');
}

/**
 * Runs `fn` on a connection that stays on the superuser login role (RLS bypassed) with no
 * meaningful workspace/principal GUCs set — for lookups that must run before a workspace is
 * known (see this file's module doc). Never for anything but a read of a globally-unique column.
 */
export function withAdminClient<T>(
  pool: PoolLike,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withWorkspace(pool, { workspaceId: randomUUID(), principalId: randomUUID() }, fn, {
    skipRoleSwitch: true,
  });
}

/**
 * Looks up a Principal by the sha256 hash of its API key. `null` if no such key is registered —
 * or (S3.11 `disable_principal`) if it is registered but `disabled_at is not null`: a disabled
 * Principal's key must stop authenticating immediately, and this is the one place the human
 * channel resolves a raw key to a Principal, so excluding it here (rather than checking
 * `disabledAt` after the fact) closes the path with no separate post-hoc check a caller could
 * forget.
 */
export async function lookupPrincipalByApiKeyHash(
  pool: PoolLike,
  apiKeyHash: string,
): Promise<PrincipalRow | null> {
  return withAdminClient(pool, async (client) => {
    const result = await client.query<PrincipalDbRow>(
      'select workspace_id, id, kind, role, display_name from principals where api_key_hash = $1 and disabled_at is null',
      [apiKeyHash],
    );
    const row = result.rows[0];
    return row ? mapPrincipalRow(row) : null;
  });
}

/**
 * W7 (interfaces/explorer-contract/session.ts): re-resolves the Principal an Explorer session
 * cookie names, on every request — the cookie is a bearer of identity, not of state, so the
 * kernel checks here that the Principal still exists and is not disabled (`disable_principal`,
 * same `disabled_at is null` predicate as {@link lookupPrincipalByApiKeyHash}) and that the
 * `kind='web'` sessions row it was minted for is still `active` and unexpired. Admin path for the
 * same reason as the API-key lookup: the row must be found before any workspace context is set,
 * and the query is pinned to one (workspace, principal, session) triple. `null` = 401.
 */
export async function lookupWebSessionPrincipal(
  pool: PoolLike,
  ref: { readonly workspaceId: string; readonly principalId: string; readonly sessionId: string },
): Promise<PrincipalRow | null> {
  return withAdminClient(pool, async (client) => {
    const result = await client.query<PrincipalDbRow>(
      `select p.workspace_id, p.id, p.kind, p.role, p.display_name
         from principals p
         join sessions s
           on s.workspace_id = p.workspace_id
          and s.principal_id = p.id
          and s.on_behalf_of = p.id
        where p.workspace_id = $1
          and p.id = $2
          and p.disabled_at is null
          and s.id = $3
          and s.kind = 'web'
          and s.status = 'active'
          and (s.expires_at is null or s.expires_at > now())`,
      [ref.workspaceId, ref.principalId, ref.sessionId],
    );
    const row = result.rows[0];
    return row ? mapPrincipalRow(row) : null;
  });
}

/**
 * Finds an unexpired `kind='web'` session for `principal` (`on_behalf_of` = the principal itself
 * — a human always acts on its own behalf, I13) and reuses it, or creates a new one. `client` must
 * already be inside a `withWorkspace()` transaction scoped to `principal.workspaceId`.
 */
async function createOrReuseWebSession(
  client: PoolClient,
  principal: PrincipalRow,
): Promise<SessionRow> {
  const existing = await client.query<SessionDbRow>(
    `select workspace_id, id, principal_id, kind, on_behalf_of, status, created_at, expires_at
     from sessions
     where workspace_id = $1 and principal_id = $2 and kind = 'web' and on_behalf_of = $2
       and (expires_at is null or expires_at > now())
     order by created_at desc
     limit 1`,
    [principal.workspaceId, principal.id],
  );
  const existingRow = existing.rows[0];
  if (existingRow) return mapSessionRow(existingRow);

  const inserted = await client.query<SessionDbRow>(
    `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
     values ($1, $2, 'web', $2, 'active')
     returning workspace_id, id, principal_id, kind, on_behalf_of, status, created_at, expires_at`,
    [principal.workspaceId, principal.id],
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    throw new Error('createOrReuseWebSession: INSERT ... RETURNING produced no row');
  }
  return mapSessionRow(row);
}

/**
 * The human channel: hashes `rawApiKey`, looks up its Principal (admin path), then creates/reuses
 * its `web` Session inside a normal `withWorkspace()` transaction. Returns `null` — never throws
 * — when no Principal has this key, so the caller (resolve-caller.ts) can fall through to the
 * Handle channel before deciding the whole Bearer token is unauthenticated.
 */
export async function authenticateHuman(
  pool: PoolLike,
  rawApiKey: string,
): Promise<AuthenticatedHuman | null> {
  const principal = await lookupPrincipalByApiKeyHash(pool, hashApiKey(rawApiKey));
  if (!principal) return null;

  const session = await withWorkspace(
    pool,
    { workspaceId: principal.workspaceId, principalId: principal.id },
    (client) => createOrReuseWebSession(client, principal),
  );

  return { principal, session };
}
