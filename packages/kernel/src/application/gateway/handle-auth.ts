import type { CryptoKey } from 'jose';
import type { PoolClient } from 'pg';
import type { PoolLike } from '../../adapters/db/pool.js';
import {
  type HandleClaims,
  HandleRevoked,
  createDbRevocationCheck,
  verifyHandle,
} from '../../governance/capability/index.js';
import { withAdminClient } from './auth.js';

/**
 * application/gateway/handle-auth: the Handle channel — verifies a Bearer token as a
 * CapabilityHandle JWT via governance/capability's `verifyHandle` (signature + standard claims)
 * and `createDbRevocationCheck` (design doc §5.1.4 I13, §9.2, §11 EdDSA; docs/development-tasks.md
 * S1.3, item 2; S1.9 governance/capability/handles.ts).
 *
 * Revocation lookup before the workspace is known: `capability_handles.jti` is globally unique
 * (governance/capability/handles.ts's `revokeHandle` doc comment — `jti` is `randomUUID()`-
 * generated), so `createDbRevocationCheck` can run on the same admin/`skipRoleSwitch` connection
 * `auth.ts`'s `withAdminClient` already establishes for the API-key lookup — no need to decode the
 * token's `ws` claim out-of-band before verification just to pick a workspace to scope RLS to.
 *
 * S3.11 `disable_principal` addition: `disable_principal`'s own handler revokes the disabled
 * Principal's `kind='entry'` sessions (`revokeEntrySessionHandles`, governance/capability/
 * handles.ts) — but a live `kind='worker_run'` Handle whose `obo` is that Principal (minted by an
 * entry Handle before the disable, still within its own ttl) is not a member of any `entry`
 * session and so is not touched by that call. Checking `disabled_at` here, on *every* Handle
 * verification, closes that gap independently — belt (revoke now) and suspenders (also refuse
 * going forward), the same two-layer shape `capability_handles.revoked_at` already gives Handles
 * themselves. Reuses `HandleRevoked` rather than inventing a new error class: functionally this
 * is exactly "treat the credential as revoked", and every existing caller of `verifyHandle`/
 * `authenticateHandle` (resolve-caller.ts) already maps that error to a generic 401 the same way.
 */

export interface HandleAuthDeps {
  readonly publicKey: CryptoKey;
}

interface DisabledCheckRow {
  disabled_at: Date | null;
}

/** Whether the Principal identified by `(workspaceId, principalId)` has `disabled_at` set. `true`
 *  (fail closed) if no such principal row exists at all — the same "missing row is never treated
 *  as valid" convention `createDbRevocationCheck` already uses for an unknown `jti`. */
async function isPrincipalDisabled(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<boolean> {
  const result = await client.query<DisabledCheckRow>(
    'select disabled_at from principals where workspace_id = $1 and id = $2',
    [workspaceId, principalId],
  );
  const row = result.rows[0];
  if (!row) return true;
  return row.disabled_at !== null;
}

/**
 * Verifies `token` as a CapabilityHandle. Throws `HandleExpired` / `HandleRevoked` / `HandleInvalid`
 * (governance/capability/handles.ts) on failure — `HandleRevoked` now also covers a Handle whose
 * on_behalf_of Principal has been disabled (see this module's own doc comment).
 */
export async function authenticateHandle(
  pool: PoolLike,
  token: string,
  deps: HandleAuthDeps,
): Promise<HandleClaims> {
  return withAdminClient(pool, async (client) => {
    const claims = await verifyHandle(token, {
      publicKey: deps.publicKey,
      isRevoked: createDbRevocationCheck(client),
    });
    if (await isPrincipalDisabled(client, claims.ws, claims.obo)) {
      throw new HandleRevoked(`handle ${claims.jti} belongs to disabled principal ${claims.obo}`);
    }
    return claims;
  });
}
