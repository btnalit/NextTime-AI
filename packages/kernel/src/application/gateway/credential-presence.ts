import type { PoolClient } from 'pg';
import { HttpGatekeeperClient } from '../../adapters/gatekeeper-client/index.js';
import type { GateTarget, GatekeeperClient } from '../../adapters/gatekeeper-client/index.js';
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
 * Best effort: a gate that does not answer (down, too old to have the route) or cannot be asked (a
 * self-connected gate with no connection secret) is left out of the answer, and the reader shows
 * nothing for it — the same as before this check existed.
 */

/** A member's account on one `connected_account` gate. A `shared` gate, or one whose answer is not
 *  known, has no entry. */
export type ConnectedAccountPresence = 'connected' | 'not_connected';

/** How long one gate's answer for one member is reused — and how long a gate that did not answer
 *  is not asked again (review #493 on #821: a hung gate must not cost every read of a page that
 *  polls its timeout). Short: the member connects their account in the console straight on the
 *  gate, which the kernel does not see. */
export const PRESENCE_TTL_MS = 15_000;
const PRESENCE_CACHE_MAX = 1_000;
const PRESENCE_TIMEOUT_MS = 3_000;

type CachedAnswer = ConnectedAccountPresence | 'shared' | 'unknown';

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

/** One member's account on one gate — what {@link connectedAccountPresenceOf} is asked about. */
export interface AccountOnGate {
  readonly principalId: string;
  readonly gatekeeperId: string;
}

/** The key {@link connectedAccountPresenceOf}'s answer is read by. */
export function accountOnGateKey(principalId: string, gatekeeperId: string): string {
  return `${principalId}\u0000${gatekeeperId}`;
}

function cacheKey(workspaceId: string, account: AccountOnGate): string {
  return `${workspaceId}\u0000${accountOnGateKey(account.principalId, account.gatekeeperId)}`;
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
 * Each member's account on each gate that runs in `connected_account` mode (see the module
 * comment), keyed by {@link accountOnGateKey}. The database reads run first, one after the other
 * on `client`; then every gate not answered from memory is asked at once — so a read waits at most
 * one gate timeout however many members and gates it covers. Never throws for a gate: one that
 * does not answer is left out, and not asked again until {@link PRESENCE_TTL_MS} has passed.
 */
export async function connectedAccountPresenceOf(
  client: PoolClient,
  workspaceId: string,
  accounts: readonly AccountOnGate[],
): Promise<ReadonlyMap<string, ConnectedAccountPresence>> {
  const answers = new Map<string, CachedAnswer>();
  const gateClient = resolveClient();
  const targets = new Map<string, GateTarget | null>();
  const asks: {
    readonly account: AccountOnGate;
    readonly key: string;
    readonly target: GateTarget;
  }[] = [];
  const seen = new Set<string>();
  for (const account of accounts) {
    const key = cacheKey(workspaceId, account);
    if (seen.has(key)) continue;
    seen.add(key);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) {
      answers.set(accountOnGateKey(account.principalId, account.gatekeeperId), cached.answer);
      continue;
    }
    if (!gateClient.credentialPresence) continue;
    let target = targets.get(account.gatekeeperId);
    if (target === undefined) {
      const record = await getGatekeeper(client, workspaceId, account.gatekeeperId);
      const resolved = record ? await resolveGateTarget(client, workspaceId, record) : null;
      target = resolved && resolved.credential.kind !== 'none' ? resolved : null;
      targets.set(account.gatekeeperId, target);
    }
    if (target) asks.push({ account, key, target });
  }
  const ask = gateClient.credentialPresence;
  if (ask) {
    await Promise.all(
      asks.map(async ({ account, key, target }) => {
        let answer: CachedAnswer;
        try {
          const response = await ask.call(gateClient, target, account.principalId);
          answer =
            response.credentialMode === 'shared'
              ? 'shared'
              : response.present
                ? 'connected'
                : 'not_connected';
        } catch {
          // Not known: shown as nothing, and not asked again until the answer would have expired.
          answer = 'unknown';
        }
        remember(key, answer);
        answers.set(accountOnGateKey(account.principalId, account.gatekeeperId), answer);
      }),
    );
  }
  const presence = new Map<string, ConnectedAccountPresence>();
  for (const [key, answer] of answers) {
    if (answer === 'connected' || answer === 'not_connected') presence.set(key, answer);
  }
  return presence;
}

/** {@link connectedAccountPresenceOf} for one member, keyed by gatekeeper id. */
export async function connectedAccountPresence(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  gatekeeperIds: readonly string[],
): Promise<ReadonlyMap<string, ConnectedAccountPresence>> {
  const presence = await connectedAccountPresenceOf(
    client,
    workspaceId,
    gatekeeperIds.map((gatekeeperId) => ({ principalId, gatekeeperId })),
  );
  const byGate = new Map<string, ConnectedAccountPresence>();
  for (const gatekeeperId of gatekeeperIds) {
    const answer = presence.get(accountOnGateKey(principalId, gatekeeperId));
    if (answer !== undefined) byGate.set(gatekeeperId, answer);
  }
  return byGate;
}
