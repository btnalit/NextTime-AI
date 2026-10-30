import type { PoolClient } from 'pg';
import { HttpGatekeeperClient } from '../../adapters/gatekeeper-client/index.js';
import type { GatekeeperClient } from '../../adapters/gatekeeper-client/index.js';
import { getGatekeeper } from '../../governance/gatekeepers/index.js';
import type { CapabilityHandlerContext } from './capability-handler.js';
import { resolveGateTarget } from './gate-target.js';

/**
 * application/gateway/credential-presence (legacy 513): whether a member has connected their own
 * account on a `connected_account` gate, asked before anything acts on it — so the goal page, its
 * confirmation and an approval card can say "this member has not connected this account" before
 * a person confirms or approves, not after the gate refuses the call with `credential_unavailable`.
 *
 * Asked of the gate itself (`gate/credential-presence`): the gate holds the credentials, and its
 * answer is the credential mode and, in `connected_account` mode, one boolean — never a credential
 * field (gatekeeper-base `CredentialPresenceResponseSchema`, parsed strictly by the client). The
 * kernel stores no copy: an answer is kept in memory for {@link PRESENCE_TTL_MS} so a page that
 * polls does not ask the gate on every read, and nowhere else.
 *
 * Only for a person (coordinator constraint on legacy 513): who has connected which account is
 * worked out only on a path serving a human Principal on the human channel ({@link servesPerson}),
 * and no capability an agent or a Handle can call carries it.
 *
 * Best effort: a gate that does not answer (down, too old to have the route, a self-connected gate
 * with no connection secret) is left out of the answer, and the reader shows nothing for it — the
 * same as before this check existed.
 */

/** A member's account on one `connected_account` gate. A `shared` gate, or one whose answer is not
 *  known, has no entry. */
export type ConnectedAccountPresence = 'connected' | 'not_connected';

/** How long one gate's answer for one member is reused. Short: the member connects their account
 *  in the console straight on the gate, which the kernel does not see. */
export const PRESENCE_TTL_MS = 15_000;
const PRESENCE_CACHE_MAX = 1_000;
const PRESENCE_TIMEOUT_MS = 3_000;

type CachedAnswer = ConnectedAccountPresence | 'shared';

const cache = new Map<string, { readonly answer: CachedAnswer; readonly expiresAt: number }>();

export interface CredentialPresenceDeps {
  readonly gatekeeperClient?: GatekeeperClient;
  readonly now?: () => number;
}

let overrideClient: GatekeeperClient | undefined;
let lazyDefaultClient: GatekeeperClient | undefined;
let now: () => number = Date.now;

/** Test seam — also empties the cache. Omit a field for the production default. */
export function setCredentialPresenceDeps(deps: CredentialPresenceDeps): void {
  overrideClient = deps.gatekeeperClient;
  now = deps.now ?? Date.now;
  cache.clear();
}

function resolveClient(): GatekeeperClient {
  if (overrideClient) return overrideClient;
  if (!lazyDefaultClient) {
    lazyDefaultClient = new HttpGatekeeperClient({ timeoutMs: PRESENCE_TIMEOUT_MS });
  }
  return lazyDefaultClient;
}

/** Whether a call is served to a person: a human Principal on the human channel — never an agent
 *  or service Principal, never a Handle. */
export function servesPerson(ctx: CapabilityHandlerContext | undefined): boolean {
  return ctx?.channel === 'human' && ctx.principal?.kind === 'human';
}

function cacheKey(workspaceId: string, gatekeeperId: string, principalId: string): string {
  return `${workspaceId}\u0000${gatekeeperId}\u0000${principalId}`;
}

function remember(key: string, answer: CachedAnswer): void {
  cache.delete(key);
  if (cache.size >= PRESENCE_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { answer, expiresAt: now() + PRESENCE_TTL_MS });
}

/**
 * `principalId`'s account on each of `gatekeeperIds` that runs in `connected_account` mode (see
 * the module comment). Never throws for a gate: one that does not answer is left out.
 */
export async function connectedAccountPresence(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  gatekeeperIds: readonly string[],
): Promise<ReadonlyMap<string, ConnectedAccountPresence>> {
  const answers = new Map<string, CachedAnswer>();
  const asks: Promise<void>[] = [];
  const gateClient = resolveClient();
  for (const gatekeeperId of new Set(gatekeeperIds)) {
    const key = cacheKey(workspaceId, gatekeeperId, principalId);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) {
      answers.set(gatekeeperId, cached.answer);
      continue;
    }
    if (!gateClient.credentialPresence) continue;
    // The reads share one client, so they run one after the other; the gate calls overlap.
    const record = await getGatekeeper(client, workspaceId, gatekeeperId);
    if (!record) continue;
    const target = await resolveGateTarget(client, workspaceId, record);
    if (target.credential.kind === 'none') continue;
    const ask = gateClient.credentialPresence;
    asks.push(
      ask.call(gateClient, target, principalId).then(
        (response) => {
          const answer: CachedAnswer =
            response.credentialMode === 'shared'
              ? 'shared'
              : response.present
                ? 'connected'
                : 'not_connected';
          remember(key, answer);
          answers.set(gatekeeperId, answer);
        },
        () => {
          // Not known: shown as nothing, and asked again on the next read.
        },
      ),
    );
  }
  await Promise.all(asks);
  const presence = new Map<string, ConnectedAccountPresence>();
  for (const [gatekeeperId, answer] of answers) {
    if (answer !== 'shared') presence.set(gatekeeperId, answer);
  }
  return presence;
}
