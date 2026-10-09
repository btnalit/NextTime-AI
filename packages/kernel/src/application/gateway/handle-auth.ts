import { handleHolderOf } from '@nexttime/shared';
import type { CryptoKey } from 'jose';
import type { PoolClient } from 'pg';
import type { PoolLike } from '../../adapters/db/pool.js';
import {
  type HandleClaims,
  HandleInvalid,
  HandleRevoked,
  createDbRevocationCheck,
  holderForSessionKind,
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
 * S3.11 `disable_principal` addition: `disable_principal`'s own handler revokes the Handles of
 * every session on the disabled Principal's behalf — entry, mcp_session and worker_run since R-05
 * (`revokeOnBehalfOfSessionHandles`, governance/capability/handles.ts). Checking `disabled_at`
 * here, on *every* Handle verification, also refuses one that revocation did not reach (a disabled
 * user, a disabled workspace) — belt (revoke now) and suspenders (also refuse going forward), the
 * same two-layer shape `capability_handles.revoked_at` already gives Handles themselves. Only the
 * belt reaches llm-proxy, which checks revoked jtis, not principals (packages/llm-proxy/src/
 * revocation.ts). Reuses `HandleRevoked` rather than inventing a new error class: functionally this
 * is exactly "treat the credential as revoked", and every existing caller of `verifyHandle`/
 * `authenticateHandle` (resolve-caller.ts) already maps that error to a generic 401 the same way.
 *
 * Presentation (@nexttime/shared handle-binding.ts): how the token reached the kernel. `bearer` —
 * the request carried it itself — is refused for a container-held Handle; `source` — the kernel
 * took it from the binding for the request's peer address — is refused for anything else. Whether
 * a Handle is container-held is read from the issuing session's `kind` (`holderForSessionKind`) as
 * well as from the token's `hld` claim, so a container-held Handle minted before the claim existed
 * (or by a rolled-back release) is refused as a bearer all the same.
 */

export interface HandleAuthDeps {
  readonly publicKey: CryptoKey;
}

/** How the Handle reached the kernel — see this module's own doc comment. */
export type HandlePresentationKind = 'bearer' | 'source';

/** Thrown when a Handle is genuine but arrived the wrong way for its holder (this module's own
 *  doc comment). A `HandleInvalid`, so every caller maps it to the same generic 401. */
export class HandlePresentationRefused extends HandleInvalid {
  readonly presentation: HandlePresentationKind;
  readonly jti: string;
  constructor(presentation: HandlePresentationKind, jti: string) {
    super(
      presentation === 'bearer'
        ? `handle ${jti} is container-held and cannot be presented as a bearer token`
        : `handle ${jti} is not container-held and cannot be bound to a source address`,
    );
    this.name = 'HandlePresentationRefused';
    this.presentation = presentation;
    this.jti = jti;
  }
}

/** The kind of the session `jti` was issued under; `undefined` when there is no such Handle row
 *  (the revocation check has already refused that case). */
async function issuingSessionKind(client: PoolClient, jti: string): Promise<string | undefined> {
  const result = await client.query<{ kind: string }>(
    `select s.kind
       from capability_handles h
       join sessions s on s.workspace_id = h.workspace_id and s.id = h.session_id
      where h.jti = $1`,
    [jti],
  );
  return result.rows[0]?.kind;
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
  // P-A1: a Handle acting on behalf of a Principal whose platform user is disabled is refused
  // the same way as a disabled Principal — `set_user_status` closes every channel at once.
  // P-A2: likewise a Principal whose workspace is disabled (`set_workspace_status`).
  const result = await client.query<DisabledCheckRow>(
    `select case when p.disabled_at is not null then p.disabled_at
                 when u.status = 'disabled' then now()
                 when w.status = 'disabled' then now() end as disabled_at
       from principals p
       join workspaces w on w.id = p.workspace_id
       left join users u on u.id = p.user_id
      where p.workspace_id = $1 and p.id = $2`,
    [workspaceId, principalId],
  );
  const row = result.rows[0];
  if (!row) return true;
  return row.disabled_at !== null;
}

/**
 * Verifies `token` as a CapabilityHandle. Throws `HandleExpired` / `HandleRevoked` / `HandleInvalid`
 * (governance/capability/handles.ts) on failure — `HandleRevoked` now also covers a Handle whose
 * on_behalf_of Principal has been disabled, and `HandlePresentationRefused` (a `HandleInvalid`) one
 * presented the wrong way for its holder (see this module's own doc comment). `presentation`
 * defaults to `bearer`: only the source-binding path (resolve-caller.ts
 * `resolveSourceBoundCaller`) passes `source`.
 */
export async function authenticateHandle(
  pool: PoolLike,
  token: string,
  deps: HandleAuthDeps,
  presentation: HandlePresentationKind = 'bearer',
): Promise<HandleClaims> {
  return withAdminClient(pool, async (client) => {
    const claims = await verifyHandle(token, {
      publicKey: deps.publicKey,
      isRevoked: createDbRevocationCheck(client),
    });
    const containerHeld =
      handleHolderOf(claims) === 'container' ||
      holderForSessionKind(await issuingSessionKind(client, claims.jti)) === 'container';
    if (containerHeld !== (presentation === 'source')) {
      throw new HandlePresentationRefused(presentation, claims.jti);
    }
    if (await isPrincipalDisabled(client, claims.ws, claims.obo)) {
      throw new HandleRevoked(`handle ${claims.jti} belongs to disabled principal ${claims.obo}`);
    }
    return claims;
  });
}
