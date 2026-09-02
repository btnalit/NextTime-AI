import { importSPKI, errors as joseErrors, jwtVerify } from 'jose';
import type { CryptoKey } from 'jose';
import { z } from 'zod';

/**
 * handle-token: the wire-level Capability Handle primitive shared by every verifier — the kernel
 * (which also signs, packages/kernel/src/governance/capability/{handles,keys}.ts) and `llm-proxy`
 * (S1.7, design doc §7.7: "用内核公钥在本地验证 Handle 签名（不逐请求回调内核）"), which only ever
 * verifies. Splitting this out avoids a second, drifting copy of the claims schema and the
 * signature/expiry verification logic in `packages/llm-proxy` — see docs/development-tasks.md
 * S1.7 "共享 Handle-token 原语".
 *
 * What stays kernel-only (not here): signing (`SignJWT`, the private-key half of the keypair,
 * `issueHandle`/`attenuate`) and revocation (`capability_handles.revoked_at` is a kernel table;
 * llm-proxy syncs a local revocation set out-of-band instead of querying it per request, S1.7
 * "撤销表按 jti 周期同步不逐请求回调"). `verifyHandleToken` below therefore only proves the token
 * is a genuine, unexpired, well-shaped Handle signed by the holder of `publicKey` — it says
 * nothing about revocation; callers that care (the kernel's own `verifyHandle`, llm-proxy's
 * request path) layer their own revocation check on top of this.
 */

/** JWA algorithm identifier every Handle signature uses (design doc §11: "EdDSA"). Pinned and
 *  never read from the token's own header — closes the classic alg-confusion hole. */
export const HANDLE_SIGNING_ALG = 'EdDSA' as const;

/**
 * `resources` maps a resource-scope key (e.g. a Gatekeeper id, an ObjectType name — the exact key
 * vocabulary is defined by each capability's own semantics, not fixed here) to the specific
 * resource ids/names a Handle may act on within that key. An absent key means "no access under
 * that key" (not "unrestricted").
 */
export const CapabilityScopeSchema = z
  .object({
    capabilities: z.array(z.string().min(1)),
    resources: z.record(z.string(), z.array(z.string())),
  })
  .strict();
export type CapabilityScope = z.infer<typeof CapabilityScopeSchema>;

const uuidClaim = z.string().uuid();

/**
 * The JWT Claims Set every Handle carries (design doc S1.9 task brief): `ws`=workspace_id,
 * `sid`=session_id, `obo`=on_behalf_of (I13), `scope`, `jti`, `exp`/`iat` (standard JWT claims,
 * seconds since epoch), `par`=parent_jti (present only on an attenuated child Handle).
 */
export const HandleClaimsSchema = z
  .object({
    ws: uuidClaim,
    sid: uuidClaim,
    obo: uuidClaim,
    scope: CapabilityScopeSchema,
    jti: uuidClaim,
    iat: z.number(),
    exp: z.number(),
    par: uuidClaim.optional(),
  })
  .strict();
export type HandleClaims = z.infer<typeof HandleClaimsSchema>;

/** Thrown by `verifyHandleToken` when the token's `exp` claim is in the past. */
export class HandleTokenExpired extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandleTokenExpired';
  }
}

/** Thrown by `verifyHandleToken` for a malformed token: bad signature, bad shape, wrong algorithm. */
export class HandleTokenInvalid extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HandleTokenInvalid';
  }
}

/**
 * Imports a Handle-signing public key from an SPKI PEM (e.g. `${NEXTTIME_DATA}/config/handle.pub`,
 * design doc §10.2/§11) for use with `verifyHandleToken`. Thin wrapper over `jose`'s `importSPKI`
 * pinned to `HANDLE_SIGNING_ALG`, so every caller imports the key the same way.
 */
export function importHandlePublicKey(pem: string): Promise<CryptoKey> {
  return importSPKI(pem, HANDLE_SIGNING_ALG);
}

/**
 * Verifies a Handle's EdDSA signature and standard JWT claims (algorithm pinned to
 * `HANDLE_SIGNING_ALG` — never trusts the token's own `alg` header), then validates the decoded
 * claims against `HandleClaimsSchema`. Returns the validated `HandleClaims` on success; throws
 * `HandleTokenExpired` or `HandleTokenInvalid` otherwise — never the raw `jose` error. Does not
 * check revocation (see module doc comment) — callers layer that on top.
 */
export async function verifyHandleToken(
  token: string,
  publicKey: CryptoKey,
): Promise<HandleClaims> {
  let rawPayload: unknown;
  try {
    const result = await jwtVerify(token, publicKey, { algorithms: [HANDLE_SIGNING_ALG] });
    rawPayload = result.payload;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      throw new HandleTokenExpired('handle token is expired');
    }
    throw new HandleTokenInvalid('handle token failed signature or claims verification', {
      cause: err,
    });
  }

  const parsed = HandleClaimsSchema.safeParse(rawPayload);
  if (!parsed.success) {
    throw new HandleTokenInvalid(
      `handle token claims do not match the expected shape: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}
