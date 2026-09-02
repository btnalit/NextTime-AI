import type { CryptoKey } from 'jose';
import type { PoolLike } from '../../adapters/db/pool.js';
import {
  type HandleClaims,
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
 */

export interface HandleAuthDeps {
  readonly publicKey: CryptoKey;
}

/**
 * Verifies `token` as a CapabilityHandle. Throws `HandleExpired` / `HandleRevoked` / `HandleInvalid`
 * (governance/capability/handles.ts) on failure — this module adds no error type of its own.
 */
export async function authenticateHandle(
  pool: PoolLike,
  token: string,
  deps: HandleAuthDeps,
): Promise<HandleClaims> {
  return withAdminClient(pool, (client) =>
    verifyHandle(token, { publicKey: deps.publicKey, isRevoked: createDbRevocationCheck(client) }),
  );
}
