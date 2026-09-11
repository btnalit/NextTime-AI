/**
 * interfaces/explorer-contract/session: the caller-owned browser session the nine Explorer
 * endpoints accept as an alternative to `X-API-Key` (W7, STATUS leftover 8; retrospective
 * 2026-09-09 §5.8 "Explorer 鉴权由 caddy 注入 key").
 *
 * Why a cookie: the Explorer static bundle is an unmodified third-party build (explorer/README.md)
 * whose data calls are plain same-origin `fetch('/api/graph/nodes')` — no headers, no
 * `credentials` option — so the only credential it can carry is whatever the browser attaches
 * on its own, i.e. a same-origin cookie. Before W7 caddy attached one shared `X-API-Key` for
 * every viewer instead (docs/runbooks/host-explorer.md's old "信任边界" section), which made every
 * LAN client an unauthenticated reader attributed to one Principal. Now the console, right after
 * a successful login, exchanges the caller's own API key for this cookie (`POST
 * /api/explorer/session`, index.ts), and each Explorer request is attributed to that caller.
 *
 * Token shape: an EdDSA JWT signed with the kernel's own Handle key pair
 * (governance/capability/keys.ts) — the one signing key the process already has — but with a
 * distinct `typ` header and a claims set that `HandleClaimsSchema` (strict; requires `scope`/
 * `obo`/`jti`) rejects, and that this module's own strict schema rejects for a real Handle. The
 * two token kinds therefore never verify as each other, even though they share a key. Claims:
 * `ws` (workspace), `sub` (principal), `sid` (the `kind='web'` sessions row the API key resolved
 * to), `iat`/`exp`. Nothing here grants anything: the cookie is honored only by the Explorer
 * routes (index.ts `authenticateExplorerCaller`), never by `/api/cap/*`, `/ws` or `/mcp`, and on
 * every request the kernel re-reads the principal (must not be disabled) and the session (must be
 * `active`) it names — `disable_principal` therefore cuts it off immediately, while
 * `rotate_api_key` does not (the cookie is not derived from the key); {@link
 * EXPLORER_SESSION_TTL_SECONDS} is the bound in that case.
 *
 * Cookie attributes: `HttpOnly` (the bundle never needs to read it), `Secure` (caddy is https;
 * browsers exempt `localhost` for the vite dev proxy), `SameSite=Strict` (never sent on a
 * cross-site navigation or request, so no CSRF surface on the one `POST` Explorer route),
 * `Path=/api` (only the kernel routes ever see it).
 */

import { SignJWT, jwtVerify } from 'jose';
import type { CryptoKey } from 'jose';
import { z } from 'zod';
import { HANDLE_SIGNING_ALG, loadHandleKeyPair } from '../../governance/capability/index.js';

export const EXPLORER_SESSION_COOKIE = 'nexttime_explorer_session';

/** JOSE `typ` header pinned on mint and required on verify — a Handle (no `typ`) never passes. */
export const EXPLORER_SESSION_TYP = 'nexttime-explorer-session+jwt';

/** 8 hours: a working day, and the revocation bound for `rotate_api_key` (module doc comment). */
export const EXPLORER_SESSION_TTL_SECONDS = 8 * 60 * 60;

const uuidClaim = z.string().uuid();

export const ExplorerSessionClaimsSchema = z
  .object({
    ws: uuidClaim,
    sub: uuidClaim,
    sid: uuidClaim,
    iat: z.number(),
    exp: z.number(),
  })
  .strict();
export type ExplorerSessionClaims = z.infer<typeof ExplorerSessionClaimsSchema>;

export class ExplorerSessionInvalid extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ExplorerSessionInvalid';
  }
}

export interface MintExplorerSessionParams {
  readonly privateKey: CryptoKey;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly sessionId: string;
  /** Defaults to now; injectable for tests. Milliseconds since epoch. */
  readonly nowMs?: number;
  readonly ttlSeconds?: number;
}

export interface MintedExplorerSession {
  readonly token: string;
  readonly expiresAt: Date;
}

export async function mintExplorerSessionToken(
  params: MintExplorerSessionParams,
): Promise<MintedExplorerSession> {
  const iat = Math.floor((params.nowMs ?? Date.now()) / 1000);
  const exp = iat + (params.ttlSeconds ?? EXPLORER_SESSION_TTL_SECONDS);
  const claims: ExplorerSessionClaims = {
    ws: params.workspaceId,
    sub: params.principalId,
    sid: params.sessionId,
    iat,
    exp,
  };
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: HANDLE_SIGNING_ALG, typ: EXPLORER_SESSION_TYP })
    .sign(params.privateKey);
  return { token, expiresAt: new Date(exp * 1000) };
}

/** Verifies signature (EdDSA only), `typ`, expiry, and the strict claims shape. Throws
 *  {@link ExplorerSessionInvalid} for anything else — including a genuine Handle token. */
export async function verifyExplorerSessionToken(
  token: string,
  publicKey: CryptoKey,
): Promise<ExplorerSessionClaims> {
  let payload: unknown;
  try {
    const verified = await jwtVerify(token, publicKey, {
      algorithms: [HANDLE_SIGNING_ALG],
      typ: EXPLORER_SESSION_TYP,
    });
    payload = verified.payload;
  } catch (err) {
    throw new ExplorerSessionInvalid('explorer session token failed verification', { cause: err });
  }
  const parsed = ExplorerSessionClaimsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ExplorerSessionInvalid('explorer session token has an unexpected claims shape', {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** Minimal `Cookie` header parser (RFC 6265 §5.4 shape: `name=value; name2=value2`). Values are
 *  taken verbatim (a JWT never needs decoding); the first occurrence of a name wins. A `Map`, not
 *  a plain object: cookie names are attacker-chosen strings, and writing them as object keys is
 *  the classic prototype-pollution shape (CodeQL `js/remote-property-injection`). */
export function parseCookieHeader(header: string | undefined): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || out.has(name)) continue;
    out.set(name, part.slice(eq + 1).trim());
  }
  return out;
}

const COOKIE_ATTRIBUTES = 'Path=/api; HttpOnly; Secure; SameSite=Strict';

/** The `Set-Cookie` value that installs `token` for `maxAgeSeconds`. */
export function serializeSessionCookie(token: string, maxAgeSeconds: number): string {
  return `${EXPLORER_SESSION_COOKIE}=${token}; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; ${COOKIE_ATTRIBUTES}`;
}

/** The `Set-Cookie` value that removes the cookie (same attributes, so the browser matches it). */
export function clearSessionCookie(): string {
  return `${EXPLORER_SESSION_COOKIE}=; Max-Age=0; ${COOKIE_ATTRIBUTES}`;
}

// Module-level cache for the default private-key loader — the same reasoning and shape as
// application/gateway/resolve-caller.ts's `defaultLoadHandlePublicKey`: one persisted key pair
// for the process lifetime, re-read only after a failure.
let cachedPrivateKeyPromise: Promise<CryptoKey> | undefined;

export async function defaultLoadHandlePrivateKey(): Promise<CryptoKey> {
  if (!cachedPrivateKeyPromise) {
    cachedPrivateKeyPromise = loadHandleKeyPair()
      .then((keyPair) => keyPair.privateKey)
      .catch((err: unknown) => {
        cachedPrivateKeyPromise = undefined;
        throw err;
      });
  }
  return cachedPrivateKeyPromise;
}
