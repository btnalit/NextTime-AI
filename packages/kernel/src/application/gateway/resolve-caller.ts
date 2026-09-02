import type { CryptoKey } from 'jose';
import type { PoolLike } from '../../adapters/db/pool.js';
import { type HandleClaims, loadHandleKeyPair } from '../../governance/capability/index.js';
import { type PrincipalRow, type SessionRow, authenticateHuman } from './auth.js';
import { authenticateHandle } from './handle-auth.js';

/**
 * application/gateway/resolve-caller: the channel-detection seam (design doc §7.1 gateway "两类
 * 通道认证"; docs/development-tasks.md S1.3, item 2). One Bearer token, tried as an API key first
 * (human channel), then as a CapabilityHandle JWT (handle channel); neither → 401.
 */

export type ResolvedCaller =
  | { readonly channel: 'human'; readonly principal: PrincipalRow; readonly session: SessionRow }
  | { readonly channel: 'handle'; readonly claims: HandleClaims };

/** Thrown by `resolveCaller` for a missing/malformed Authorization header, or a Bearer token that
 *  is neither a known API key nor a valid CapabilityHandle. Always maps to HTTP 401. */
export class UnauthorizedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UnauthorizedError';
  }
}

export interface ResolveCallerDeps {
  readonly pool: PoolLike;
  /**
   * Loads the Handle-verification public key, lazily — only invoked when a Bearer token fails as
   * an API key, so a kernel with no Handle keys configured (e.g. local dev without S1.9 secrets)
   * still serves the human channel normally. Defaults to a cached call to
   * governance/capability/keys.ts's `loadHandleKeyPair()` (reads `HANDLE_PRIVATE_KEY_FILE` /
   * `HANDLE_PUBLIC_KEY_FILE` from `process.env`); injectable for tests (e.g. an ephemeral keypair).
   */
  readonly loadHandlePublicKey?: () => Promise<CryptoKey>;
}

// Module-level cache for the default key loader — the production kernel signs/verifies with one
// persisted keypair for its whole lifetime (governance/capability/keys.ts's own doc comment: "a
// Handle issued before a restart still verifies afterward"), so there is no reason to re-read the
// PEM files on every request. Reset on failure so a later request can retry (e.g. secrets mounted
// after the first request arrives).
let cachedPublicKeyPromise: Promise<CryptoKey> | undefined;

async function defaultLoadHandlePublicKey(): Promise<CryptoKey> {
  if (!cachedPublicKeyPromise) {
    cachedPublicKeyPromise = loadHandleKeyPair()
      .then((keyPair) => keyPair.publicKey)
      .catch((err: unknown) => {
        cachedPublicKeyPromise = undefined;
        throw err;
      });
  }
  return cachedPublicKeyPromise;
}

function parseBearerToken(authorizationHeader: string | undefined): string {
  if (!authorizationHeader) {
    throw new UnauthorizedError('missing Authorization header');
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  const token = match?.[1]?.trim();
  if (!token) {
    throw new UnauthorizedError('Authorization header must be "Bearer <token>"');
  }
  return token;
}

/**
 * Resolves the caller of one HTTP request from its raw `Authorization` header value. Tries the
 * human channel (API key) first, then the handle channel (CapabilityHandle JWT). Throws
 * `UnauthorizedError` if the header is missing/malformed or the token matches neither.
 */
export async function resolveCaller(
  authorizationHeader: string | undefined,
  deps: ResolveCallerDeps,
): Promise<ResolvedCaller> {
  const token = parseBearerToken(authorizationHeader);

  const human = await authenticateHuman(deps.pool, token);
  if (human) {
    return { channel: 'human', principal: human.principal, session: human.session };
  }

  try {
    const publicKey = await (deps.loadHandlePublicKey ?? defaultLoadHandlePublicKey)();
    const claims = await authenticateHandle(deps.pool, token, { publicKey });
    return { channel: 'handle', claims };
  } catch (err) {
    throw new UnauthorizedError('invalid credentials', { cause: err });
  }
}
