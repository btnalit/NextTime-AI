import type { PoolLike } from '../../adapters/db/pool.js';
import { withAdminClient } from './auth.js';
import type { ResolvedCaller } from './caller.js';

/**
 * application/gateway/session-revocation: what keeps an already-open human `/ws` connection
 * honest after it authenticated (review 2026-10-02 R-05). HTTP re-resolves its caller on every
 * request (`resolveRequestCaller`); a WebSocket authenticates once, at connect — so before this a
 * disable, a logout or a password reset left an open tab receiving approval / task pushes and
 * dispatching calls (a `send_chat_message` even re-minted an entry Handle for the Turn). Two
 * halves, both consumed by `interfaces/ws/server.ts`:
 *
 *   - {@link recheckHumanSession}: one indexed read per WS call — the Principal is not disabled,
 *     its platform user is active, (cookie sockets) the console `user_sessions` row is still
 *     unrevoked and unexpired, and (API-key sockets) the Principal still has a key. A disabled
 *     workspace is already refused per call by `dispatchCapability` itself.
 *   - the kick bus ({@link publishSessionKick} / {@link subscribeToSessionKicks}): logout,
 *     `reset_user_password`, `set_user_status` → disabled, a self-service password change,
 *     `disable_principal` and `remove_membership` publish to it after their transaction commits,
 *     so matching sockets close and stop receiving pushes at once instead of at their next call.
 *     In-process only, for the same reason `application/chat/push.ts` is: there is one kernel
 *     instance.
 *
 * Both answer with the verdict a fresh first-frame `authenticate` would give right now
 * (resolve-caller.ts): `session_invalid` — the credential itself is gone (UNAUTHORIZED; the
 * console goes back to login) — or `membership_gone` — a cookie user whose membership Principal
 * in this workspace was disabled while their login stays valid (FORBIDDEN; the console re-reads
 * `/api/auth/me` and opens another workspace). An API-key socket has no login behind it, so a
 * disabled Principal is `session_invalid` there.
 */

/** The only caller kind `/ws` accepts (interfaces/ws/server.ts `isHumanChannel`). */
export type HumanCaller = Extract<ResolvedCaller, { readonly channel: 'human' }>;

export type HumanSessionVerdict = 'live' | 'session_invalid' | 'membership_gone';

interface SessionLivenessRow {
  principal_active: boolean;
  user_active: boolean;
  console_session_live: boolean;
  has_api_key: boolean;
}

/**
 * Re-checks the session `caller` authenticated with. Admin client for the same reason
 * `lookupConsoleSessionUser` (identity/console-session.ts) uses one: the application role has no
 * read on `user_sessions` outside a platform transaction. Every lookup is by primary key. A
 * missing Principal row (or, for a cookie caller, one no longer linked to that user) is treated
 * as a lost membership, never as live.
 */
export async function recheckHumanSession(
  pool: PoolLike,
  caller: HumanCaller,
): Promise<HumanSessionVerdict> {
  const consoleUser = caller.user;
  const row = await withAdminClient(pool, async (client) => {
    const result = await client.query<SessionLivenessRow>(
      `select p.disabled_at is null as principal_active,
              (u.id is null or u.status = 'active') as user_active,
              p.api_key_hash is not null as has_api_key,
              ($3::uuid is null or exists (
                 select 1 from user_sessions s
                  where s.id = $3::uuid and s.user_id = $4::uuid
                    and s.revoked_at is null and s.expires_at > now()
              )) as console_session_live
         from principals p
         left join users u on u.id = p.user_id
        where p.workspace_id = $1 and p.id = $2
          and ($4::uuid is null or p.user_id = $4::uuid)`,
      [
        caller.principal.workspaceId,
        caller.principal.id,
        consoleUser?.consoleSessionId ?? null,
        consoleUser?.id ?? null,
      ],
    );
    return result.rows[0];
  });
  if (row && (!row.console_session_live || !row.user_active)) return 'session_invalid';
  // R-12 / R-13: an API-key socket whose Principal no longer has a key (a reset, a disable or a
  // password change cleared it) has lost its credential, like an API-key socket of a disabled
  // Principal.
  if (row && !consoleUser && !row.has_api_key) return 'session_invalid';
  if (!row || !row.principal_active) return consoleUser ? 'membership_gone' : 'session_invalid';
  return 'live';
}

/**
 * One revocation, described by who it reaches. A socket matches when any field names it.
 */
export interface SessionKick {
  /** Sockets authenticated by this console session (`user_sessions.id`) — logout. */
  readonly consoleSessionId?: string;
  /** Sockets authenticated by any console session of this user — `reset_user_password`,
   *  `set_user_status` → disabled. */
  readonly userId?: string;
  /** Sockets acting as one of these Principals, whatever the credential — `disable_principal`,
   *  `remove_membership`, and the API-key half of `set_user_status` → disabled and
   *  `reset_user_password`. */
  readonly principalIds?: readonly string[];
  /** Sockets that authenticated with an API key as one of these Principals — never a cookie
   *  socket. A self-service password change clears the user's membership keys (R-13) but keeps
   *  the console session making the change, so it cannot use `principalIds`. */
  readonly apiKeyPrincipalIds?: readonly string[];
}

/** Whether `kick` reaches a socket authenticated as `caller`, and with which verdict (see this
 *  module's doc comment). `undefined` = not this socket. */
export function sessionKickVerdict(
  caller: HumanCaller,
  kick: SessionKick,
): Exclude<HumanSessionVerdict, 'live'> | undefined {
  const consoleUser = caller.user;
  if (
    consoleUser &&
    (kick.consoleSessionId === consoleUser.consoleSessionId || kick.userId === consoleUser.id)
  ) {
    return 'session_invalid';
  }
  if (kick.principalIds?.includes(caller.principal.id)) {
    return consoleUser ? 'membership_gone' : 'session_invalid';
  }
  if (!consoleUser && kick.apiKeyPrincipalIds?.includes(caller.principal.id)) {
    return 'session_invalid';
  }
  return undefined;
}

export type SessionKickListener = (kick: SessionKick) => void;

const kickListeners = new Set<SessionKickListener>();

/** Registers `listener` for every kick. Returns an unsubscribe function. */
export function subscribeToSessionKicks(listener: SessionKickListener): () => void {
  kickListeners.add(listener);
  return () => {
    kickListeners.delete(listener);
  };
}

/** Delivers `kick` to every current listener. Call only after the revoking transaction has
 *  committed — a socket that reconnects in reaction must already see the revoked state. Never
 *  throws: publishers run it from a capability's post-commit continuation, where a failing
 *  listener must not turn a committed revocation into an error response. */
export function publishSessionKick(kick: SessionKick): void {
  for (const listener of [...kickListeners]) {
    try {
      listener(kick);
    } catch {
      // A socket that cannot be closed cleanly still fails its next call's recheck.
    }
  }
}

/** Test-only escape hatch: clears every registered listener. Not exported from index.ts. */
export function _resetSessionKicksForTests(): void {
  kickListeners.clear();
}
