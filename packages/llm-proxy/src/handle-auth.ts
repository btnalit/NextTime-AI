import { readFile } from 'node:fs/promises';
import type { HandleClaims } from '@nexttime/shared';
import { HandleTokenExpired, importHandlePublicKey, verifyHandleToken } from '@nexttime/shared';
import type { CryptoKey } from 'jose';
import type { ProviderAuth } from './config.js';

/**
 * handle-auth: verifies the inbound Handle (design doc §7.7 "用内核公钥在本地验证 Handle 签名（不逐
 * 请求回调内核）") using the shared `@nexttime/shared` `handle-token` primitive — the same one
 * `packages/kernel/src/governance/capability/handles.ts` now delegates to (S1.7 "共享 Handle-token
 * 原语"). Revocation is layered on top via an injected `isRevoked` check (revocation.ts's
 * in-memory synced set), never a per-request kernel call.
 */

export type HandleAuthFailureReason = 'missing' | 'invalid' | 'expired' | 'revoked';

/** Every failure mode here maps to HTTP 401 in proxy.ts (S1.7 acceptance: "无 Handle 401；过期 /
 *  撤销 Handle 401") — `reason` exists for logging/metrics, not to vary the response. */
export class HandleAuthError extends Error {
  readonly reason: HandleAuthFailureReason;

  constructor(reason: HandleAuthFailureReason, message: string) {
    super(message);
    this.name = 'HandleAuthError';
    this.reason = reason;
  }
}

/** Reads `HANDLE_PUBLIC_KEY_FILE` (design doc §10.2 compose block: `/data/config/handle.pub`,
 *  written by scripts/gen-handle-keys.sh from the same key material the kernel signs with) once
 *  at startup — never re-read per request. */
export async function loadHandlePublicKey(filePath: string): Promise<CryptoKey> {
  const pem = await readFile(filePath, 'utf8');
  return importHandlePublicKey(pem);
}

/**
 * Extracts the raw Handle token from the provider's configured inbound header (S1.7 task brief:
 * "入站 Handle 从该 provider auth 指定的头读取"), stripping the `scheme` prefix (e.g. `"Bearer "`)
 * when one is configured. `headers` is Node's already-lowercased `IncomingHttpHeaders` (or an
 * equivalent plain object in tests) — HTTP header lookup is case-insensitive by construction here,
 * not by re-normalizing case in this function.
 */
export function extractHandleToken(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  auth: ProviderAuth,
): string {
  const raw = headers[auth.header];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) {
    throw new HandleAuthError('missing', `missing "${auth.header}" header`);
  }

  if (auth.scheme) {
    const prefix = `${auth.scheme} `;
    if (!value.startsWith(prefix)) {
      throw new HandleAuthError(
        'missing',
        `"${auth.header}" header does not start with "${prefix}"`,
      );
    }
    const token = value.slice(prefix.length).trim();
    if (!token) throw new HandleAuthError('missing', `"${auth.header}" header has an empty token`);
    return token;
  }

  const token = value.trim();
  if (!token) throw new HandleAuthError('missing', `"${auth.header}" header is empty`);
  return token;
}

export interface VerifyInboundHandleOptions {
  readonly publicKey: CryptoKey;
  readonly isRevoked: (jti: string) => boolean;
}

/**
 * Verifies a Handle token's signature/expiry (via `@nexttime/shared`'s `verifyHandleToken`) and
 * revocation status. Throws `HandleAuthError` on any failure — never the raw `HandleTokenInvalid`/
 * `HandleTokenExpired` from the shared primitive — so `proxy.ts` has exactly one error type to
 * catch and map to 401.
 */
export async function verifyInboundHandle(
  token: string,
  options: VerifyInboundHandleOptions,
): Promise<HandleClaims> {
  let claims: HandleClaims;
  try {
    claims = await verifyHandleToken(token, options.publicKey);
  } catch (err) {
    if (err instanceof HandleTokenExpired) {
      throw new HandleAuthError('expired', 'handle token is expired');
    }
    throw new HandleAuthError('invalid', 'handle token failed verification');
  }

  if (options.isRevoked(claims.jti)) {
    throw new HandleAuthError('revoked', `handle ${claims.jti} has been revoked`);
  }

  return claims;
}
