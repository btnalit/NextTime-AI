import type { CryptoKey } from 'jose';
import { SignJWT, errors as joseErrors, jwtVerify } from 'jose';
import { z } from 'zod';
import { HANDLE_SIGNING_ALG } from './handle-token.js';

/**
 * gate-host-token — the 5-minute platform JWT that lets a browser post a credential *directly* to
 * the generic gate host (docs/development-tasks.md P-B 决定 ⑩; design §6.3 "凭证由页面经 5 分钟平台
 * JWT 直达门宿主、不经内核").
 *
 * Signed with the kernel's Handle key (the only signing key the deployment has) but deliberately
 * *not* a Handle: a distinct `typ`, an `aud`, and a strict claims shape that `HandleClaimsSchema`
 * rejects — so a gate-host token can never be replayed as a Handle at the kernel, and a real Handle
 * (no `aud`, different `typ`) is never accepted by the gate host. The gate host verifies with the
 * same `config/handle.pub` llm-proxy already mounts.
 *
 * Claims: `aud` fixed, `gate` = the instance the token may write, `obo` = the credential slot it may
 * write (`GATE_SHARED_CREDENTIAL_SLOT` for the instance-wide credential, otherwise a Principal id),
 * `sub` = the user who asked for it (audit), `iat`/`exp`.
 */
export const GATE_HOST_TOKEN_TYP = 'nt-gate-host+jwt' as const;
export const GATE_HOST_TOKEN_AUD = 'gate-host' as const;
export const GATE_HOST_TOKEN_TTL_SECONDS = 300;
/** Not a UUID on purpose: it can never collide with a Principal id (决定 ⑪). */
export const GATE_SHARED_CREDENTIAL_SLOT = '__shared__' as const;

export const GateHostTokenClaimsSchema = z
  .object({
    aud: z.literal(GATE_HOST_TOKEN_AUD),
    gate: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
    obo: z.string().min(1).max(128),
    sub: z.string().min(1),
    iat: z.number(),
    exp: z.number(),
  })
  .strict();
export type GateHostTokenClaims = z.infer<typeof GateHostTokenClaimsSchema>;

export class GateHostTokenInvalid extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GateHostTokenInvalid';
  }
}

export async function mintGateHostToken(params: {
  readonly privateKey: CryptoKey;
  readonly gateId: string;
  readonly onBehalfOf: string;
  readonly subject: string;
  readonly ttlSeconds?: number;
  readonly nowMs?: number;
}): Promise<{ token: string; expiresAt: Date }> {
  const iat = Math.floor((params.nowMs ?? Date.now()) / 1000);
  const ttl = Math.min(
    params.ttlSeconds ?? GATE_HOST_TOKEN_TTL_SECONDS,
    GATE_HOST_TOKEN_TTL_SECONDS,
  );
  const exp = iat + ttl;
  const claims: GateHostTokenClaims = GateHostTokenClaimsSchema.parse({
    aud: GATE_HOST_TOKEN_AUD,
    gate: params.gateId,
    obo: params.onBehalfOf,
    sub: params.subject,
    iat,
    exp,
  });
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: HANDLE_SIGNING_ALG, typ: GATE_HOST_TOKEN_TYP })
    .sign(params.privateKey);
  return { token, expiresAt: new Date(exp * 1000) };
}

/** Verifies signature, `typ`, `aud`, expiry and claims shape; `expectedGateId` pins the token to
 *  the instance named in the request path. */
export async function verifyGateHostToken(
  token: string,
  publicKey: CryptoKey,
  options: { readonly expectedGateId: string; readonly nowMs?: number },
): Promise<GateHostTokenClaims> {
  let payload: unknown;
  try {
    const verified = await jwtVerify(token, publicKey, {
      algorithms: [HANDLE_SIGNING_ALG],
      typ: GATE_HOST_TOKEN_TYP,
      audience: GATE_HOST_TOKEN_AUD,
      ...(options.nowMs !== undefined ? { currentDate: new Date(options.nowMs) } : {}),
    });
    payload = verified.payload;
  } catch (err) {
    const expired = err instanceof joseErrors.JWTExpired;
    throw new GateHostTokenInvalid(
      expired ? 'gate-host token is expired' : 'gate-host token failed verification',
      { cause: err },
    );
  }
  const parsed = GateHostTokenClaimsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new GateHostTokenInvalid('gate-host token has an unexpected claims shape', {
      cause: parsed.error,
    });
  }
  if (parsed.data.gate !== options.expectedGateId) {
    throw new GateHostTokenInvalid('gate-host token was issued for a different gate instance');
  }
  return parsed.data;
}
