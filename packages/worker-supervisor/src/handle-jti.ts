/**
 * handle-jti: best-effort, **unverified** extraction of a Capability Handle JWT's `jti` claim —
 * used only to detect Handle rotation for entry-container recreation (lane-6 review P2-5), never
 * for authorization or trust decisions. This process has no reason to verify the Handle's
 * signature here: whoever calls `POST /resident/spawn` is already trusted (gated by
 * `internal-auth.ts`), and the Handle itself is verified per-request, downstream, by `llm-proxy`
 * (S1.7) against the kernel's public key — this decode exists purely to answer "is this the same
 * Handle as last time, or a freshly issued one", so a long-lived resident container picks up a
 * newly issued entry Handle instead of running for its whole 24h TTL on a stale one (see
 * `resident-service.ts`'s own doc comment for the full rotation rationale).
 */

/** Decodes the `jti` claim from a JWT's payload segment without verifying its signature. Returns
 *  `undefined` for anything that isn't a well-formed `<header>.<payload>.<signature>` compact JWT
 *  with a non-empty string `jti` claim — never throws. Callers (`resident-service.ts`) treat
 *  `undefined` as "cannot tell, don't force a recreation on this alone". */
export function decodeHandleJtiUnsafe(token: string): string | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const payloadSegment = parts[1];
  if (!payloadSegment) return undefined;
  try {
    const json = Buffer.from(payloadSegment, 'base64url').toString('utf8');
    const payload: unknown = JSON.parse(json);
    if (typeof payload !== 'object' || payload === null) return undefined;
    const jti = (payload as Record<string, unknown>).jti;
    return typeof jti === 'string' && jti.length > 0 ? jti : undefined;
  } catch {
    return undefined;
  }
}
