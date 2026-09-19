import type { LlmAdminTokenClaims } from '@nexttime/shared';
import { LlmAdminTokenInvalid, verifyLlmAdminToken } from '@nexttime/shared';
import type { CryptoKey } from 'jose';

/**
 * admin-auth: authenticates a request to the S6-B provider-management endpoints (`/admin/*`,
 * reached through caddy as `/api/llm-admin/*` — docs/console-completion-plan.md §5.4 / §7;
 * docs/platform-admin-design.md §6.2). Two checks, both required:
 *
 *   1. `Authorization: Bearer <llm-admin token>` — the 5-minute platform JWT
 *      `issue_llm_admin_token` mints (`@nexttime/shared`'s llm-admin-token.ts), verified locally
 *      with the same `HANDLE_PUBLIC_KEY_FILE` handle-auth.ts uses. A Handle (no `aud`, different
 *      `typ`, different claims) fails this verification — a Worker or entry agent holding a
 *      Handle can never reach the admin routes, and conversely an admin token presented on a
 *      provider route fails `verifyHandleToken` there. Never the internal-plane token either:
 *      that is a service-to-service secret, not a browser credential.
 *   2. `X-Requested-With: nexttime` — the same CSRF guard the kernel applies to every `/api/*`
 *      call from the console (design §7.11). A cross-site page cannot add this header without a
 *      CORS preflight this proxy never answers; belt-and-braces alongside the Bearer token,
 *      which a browser never attaches automatically.
 *
 * Every failure is `AdminAuthError` with an HTTP status and a stable `code`; `reason` exists
 * for the audit log line, never to vary the body beyond `code`.
 */

export type AdminAuthFailureReason = 'missing' | 'invalid' | 'expired' | 'csrf';

export class AdminAuthError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason: AdminAuthFailureReason;

  constructor(reason: AdminAuthFailureReason, message: string) {
    super(message);
    this.name = 'AdminAuthError';
    this.reason = reason;
    this.status = reason === 'csrf' ? 403 : 401;
    this.code =
      reason === 'csrf'
        ? 'csrf_header_required'
        : reason === 'expired'
          ? 'token_expired'
          : 'unauthorized';
  }
}

export const ADMIN_CSRF_HEADER = 'x-requested-with';
export const ADMIN_CSRF_VALUE = 'nexttime';

function headerValue(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

export async function authenticateAdminRequest(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  options: { readonly publicKey: CryptoKey; readonly nowMs?: number },
): Promise<LlmAdminTokenClaims> {
  if (headerValue(headers, ADMIN_CSRF_HEADER) !== ADMIN_CSRF_VALUE) {
    throw new AdminAuthError('csrf', `missing "${ADMIN_CSRF_HEADER}: ${ADMIN_CSRF_VALUE}" header`);
  }
  const authorization = headerValue(headers, 'authorization');
  if (!authorization || !authorization.startsWith('Bearer ')) {
    throw new AdminAuthError('missing', 'missing bearer token');
  }
  const token = authorization.slice('Bearer '.length).trim();
  if (!token) throw new AdminAuthError('missing', 'empty bearer token');
  try {
    return await verifyLlmAdminToken(token, options.publicKey, { nowMs: options.nowMs });
  } catch (err) {
    if (err instanceof LlmAdminTokenInvalid && err.reason === 'expired') {
      throw new AdminAuthError('expired', 'llm-admin token is expired');
    }
    throw new AdminAuthError('invalid', 'llm-admin token failed verification');
  }
}
