import type { GateHostTokenWire } from '@nexttime/shared';

/**
 * lib/gate-host: P-B2a (决定 ⑩) — posting a credential straight from the browser to the platform
 * gate host, same-origin, with the 5-minute token `issue_gate_host_token` /
 * `issue_gate_credential_token` mint. The kernel is never in this path: `postGateCredential` talks
 * only to `tokenResult.url` (`gate-instance-handlers.ts` / `platform-gates-handlers.ts`'s
 * `gateHostCredentialUrl`), never `/api/cap/*`.
 *
 * The gate host answers `{ok:true,result:{stored:true}}` on success (`gatekeeper-base/src/
 * server.ts`'s `POST /gate/connected-accounts` route, mounted per-instance under `/i/<gateId>`);
 * anything else — a non-2xx status, a malformed body, an unexpected shape — becomes a
 * {@link GateHostError} with a message this package's `ErrorBanner` can render directly. Never a
 * `HttpError`: that type's `capability_error` kind would route through `lib/platform-errors.ts`,
 * which knows nothing about the gate host's own (unrelated) error vocabulary.
 *
 * Mirrors `lib/http-client.ts`'s receiver-safe default-fetch pattern (`defaultFetch` below) — a
 * bare `fetchImpl: typeof fetch = fetch` default would be invoked with `this` bound to whatever
 * holds the reference, which every browser's native `fetch` rejects.
 */

export class GateHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateHostError';
  }
}

const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

function isStoredEnvelope(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const record = body as Record<string, unknown>;
  if (record.ok !== true) return false;
  const result = record.result;
  if (typeof result !== 'object' || result === null) return false;
  return (result as Record<string, unknown>).stored === true;
}

/**
 * Posts `credential` (a plain object — never logged, never persisted) to `tokenResult.url` as the
 * caller's own slot (`tokenResult.onBehalfOf`, carried in the body only for the host's own
 * audit — the slot actually written is the one baked into `tokenResult.token`). Resolves on
 * `{ok:true,result:{stored:true}}`; throws {@link GateHostError} otherwise.
 */
export async function postGateCredential(
  tokenResult: GateHostTokenWire,
  credential: Readonly<Record<string, unknown>>,
  fetchImpl: typeof fetch = defaultFetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(tokenResult.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tokenResult.token}`,
      },
      body: JSON.stringify({ onBehalfOf: tokenResult.onBehalfOf, credential }),
    });
  } catch (error) {
    throw new GateHostError(
      `无法连接门宿主 Could not reach the gate host: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (response.status === 401) {
    throw new GateHostError(
      '令牌已过期或无效，请重新获取 The token expired or is invalid — get a new one',
    );
  }
  if (!response.ok) {
    throw new GateHostError(
      `门宿主拒绝了这次写入 The gate host rejected this write (HTTP ${response.status})`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new GateHostError(
      '门宿主返回了无法识别的响应 The gate host returned an unrecognized response',
    );
  }
  if (!isStoredEnvelope(body)) {
    throw new GateHostError(
      '门宿主返回了意料之外的响应 The gate host returned an unexpected response',
    );
  }
}
