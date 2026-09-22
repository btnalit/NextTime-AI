import type { CryptoKey } from 'jose';
import { SignJWT, errors as joseErrors, jwtVerify } from 'jose';
import { z } from 'zod';
import { HANDLE_SIGNING_ALG } from './handle-token.js';

/**
 * llm-admin-token — the 5-minute platform JWT that lets an administrator's browser call the
 * llm-proxy provider-management endpoints *directly* (docs/console-completion-plan.md §5.4 /
 * §6 `issue_llm_admin_token`; docs/platform-admin-design.md §6.2 "web → caddy `/api/llm-admin/*`
 * → llm-proxy 管理端点，鉴权用内核签发的 5 分钟平台 JWT"). Same construction as
 * `gate-host-token.ts` (P-B2a 决定 ⑩), the first token of this kind in the deployment.
 *
 * Signed with the kernel's Handle key (the only signing key the deployment has) but deliberately
 * *not* a Handle: a distinct `typ`, a fixed `aud`, and a strict claims shape `HandleClaimsSchema`
 * rejects — so an admin token can never be replayed as a Handle at the kernel or at llm-proxy's
 * provider routes, and a real Handle (no `aud`, different `typ`) is never accepted by the admin
 * routes. llm-proxy verifies with the same `config/handle.pub` it already mounts for Handles.
 *
 * It is a capability token, not a credential to a third party (CLAUDE.md design line "agent /
 * kernel 进程不持凭证"): holding it lets a browser edit provider *records* at llm-proxy; provider
 * keys never travel with it — they stay in llm-proxy's own env (`api_key_env`).
 *
 * Claims: `aud` fixed, `sub` = the administrator (`users.id`, audit), `jti` = this token's id —
 * the kernel's `platform.llm_admin_token_issued` audit row and llm-proxy's own audit log lines
 * both carry it, which is how a provider mutation at llm-proxy is tied back to the kernel row
 * that issued the token (design line "隔离与审计只增不减"). `iat`/`exp` standard.
 */
export const LLM_ADMIN_TOKEN_TYP = 'nt-llm-admin+jwt' as const;
export const LLM_ADMIN_TOKEN_AUD = 'llm-admin' as const;
export const LLM_ADMIN_TOKEN_TTL_SECONDS = 300;

export const LlmAdminTokenClaimsSchema = z
  .object({
    aud: z.literal(LLM_ADMIN_TOKEN_AUD),
    sub: z.string().min(1),
    jti: z.string().uuid(),
    iat: z.number(),
    exp: z.number(),
  })
  .strict();
export type LlmAdminTokenClaims = z.infer<typeof LlmAdminTokenClaimsSchema>;

export class LlmAdminTokenInvalid extends Error {
  /** `expired` is separated out so a verifier can tell the browser to re-mint rather than
   *  treat the request as an attack. */
  readonly reason: 'expired' | 'invalid';

  constructor(reason: 'expired' | 'invalid', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LlmAdminTokenInvalid';
    this.reason = reason;
  }
}

export async function mintLlmAdminToken(params: {
  readonly privateKey: CryptoKey;
  readonly subject: string;
  readonly jti: string;
  readonly ttlSeconds?: number;
  readonly nowMs?: number;
}): Promise<{ token: string; expiresAt: Date }> {
  const iat = Math.floor((params.nowMs ?? Date.now()) / 1000);
  const ttl = Math.min(
    params.ttlSeconds ?? LLM_ADMIN_TOKEN_TTL_SECONDS,
    LLM_ADMIN_TOKEN_TTL_SECONDS,
  );
  const exp = iat + ttl;
  const claims: LlmAdminTokenClaims = LlmAdminTokenClaimsSchema.parse({
    aud: LLM_ADMIN_TOKEN_AUD,
    sub: params.subject,
    jti: params.jti,
    iat,
    exp,
  });
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: HANDLE_SIGNING_ALG, typ: LLM_ADMIN_TOKEN_TYP })
    .sign(params.privateKey);
  return { token, expiresAt: new Date(exp * 1000) };
}

/** Verifies signature (algorithm pinned), `typ`, `aud`, expiry and the claims shape. Throws
 *  `LlmAdminTokenInvalid` — never a raw `jose` error — so every verifier maps one type to 401. */
export async function verifyLlmAdminToken(
  token: string,
  publicKey: CryptoKey,
  options: { readonly nowMs?: number } = {},
): Promise<LlmAdminTokenClaims> {
  let payload: unknown;
  try {
    const verified = await jwtVerify(token, publicKey, {
      algorithms: [HANDLE_SIGNING_ALG],
      typ: LLM_ADMIN_TOKEN_TYP,
      audience: LLM_ADMIN_TOKEN_AUD,
      ...(options.nowMs !== undefined ? { currentDate: new Date(options.nowMs) } : {}),
    });
    payload = verified.payload;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      throw new LlmAdminTokenInvalid('expired', 'llm-admin token is expired', { cause: err });
    }
    throw new LlmAdminTokenInvalid('invalid', 'llm-admin token failed verification', {
      cause: err,
    });
  }
  const parsed = LlmAdminTokenClaimsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new LlmAdminTokenInvalid('invalid', 'llm-admin token has an unexpected claims shape', {
      cause: parsed.error,
    });
  }
  return parsed.data;
}
