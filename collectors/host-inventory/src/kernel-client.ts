import { readFile } from 'node:fs/promises';
import type { IngestObservation } from './types.js';

/**
 * kernel-client: this collector's own thin HTTP client for `POST <kernelUrl>/api/cap/<name>`
 * (design doc §9.3; `packages/kernel/src/interfaces/http/capability-route.ts`'s own response
 * envelope — `{ok:true, result}` / `{ok:false, error:{code,message}}`, docs/wire-contract-
 * conventions.md §3). Authenticates with the Handle bearer token `config.ts`'s `handleTokenFile`
 * names — read fresh on every call (not cached in memory) so a rotated token on disk takes effect
 * without restarting this process.
 */

export interface RegisterSourceParams {
  readonly kind: string;
  readonly name: string;
  readonly visibility: 'workspace' | 'private';
  readonly uri?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface RegisterSourceResult {
  readonly id: string;
  readonly kind: string;
  readonly name: string | null;
  readonly ownerPrincipalId: string;
  readonly visibility: 'workspace' | 'private';
}

export interface SubmitObservationsParams {
  readonly sourceId: string;
  readonly activityId?: string;
  readonly observations: readonly IngestObservation[];
}

export interface SubmitObservationsResult {
  readonly activityId: string;
  readonly objectsUpserted: number;
  readonly factsAsserted: number;
  readonly factsSuperseded: number;
  readonly objects: readonly {
    objectType: string;
    identity: Record<string, unknown>;
    id: string;
  }[];
}

/** S3.4: params for the `observe_operation` capability (`packages/kernel/src/application/gateway/
 *  request-action-handler.ts`'s `observeOperationHandler`) — dispatches one `mode: 'observe'`
 *  Operation on a Gatekeeper and returns its raw response, with no ActionRequest/approval flow (the
 *  entire reason `ragflow.ts` uses this instead of `request_action`: `kb.list`/`kb.documents` are
 *  read-only, so there is nothing to approve). */
export interface ObserveOperationParams {
  readonly gatekeeperId: string;
  readonly operation: string;
  readonly params?: Record<string, unknown>;
}

/** `data` is whatever the target system's own API returned, untouched
 *  (`packages/gatekeeper-base/src/gatekeeper-base.ts`'s `observe()`: `{data: result.data, ...}`) —
 *  for `gatekeepers/ragflow`'s `kb.list`/`kb.documents` that is RAGFlow's own `{code, data}`
 *  envelope, not this platform's own capability envelope. Callers must inspect `code` themselves
 *  (`gatekeepers/ragflow/README.md`'s own documented limitation: "RAGFlow's own `{code, data}`
 *  error envelope is invisible to the protocol"). */
export interface ObserveOperationResult {
  readonly status: 'ok';
  readonly data: unknown;
  readonly observedFactCount: number;
}

export class KernelClientError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(capability: string, status: number, code: string, message: string) {
    super(`kernel-client: ${capability} failed (${status} ${code}): ${message}`);
    this.name = 'KernelClientError';
    this.code = code;
    this.status = status;
  }
}

export interface KernelClientOptions {
  readonly kernelUrl: string;
  readonly handleTokenFile: string;
  /** Injectable for tests — defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable for tests — defaults to reading `handleTokenFile` from disk. */
  readonly readToken?: (file: string) => Promise<string>;
}

export interface KernelClient {
  registerSource(params: RegisterSourceParams): Promise<RegisterSourceResult>;
  submitObservations(params: SubmitObservationsParams): Promise<SubmitObservationsResult>;
  /** S3.4 — see `ObserveOperationParams`/`ObserveOperationResult`'s own doc comments. Requires this
   *  collector's own Handle to hold `observe_operation` in its capability scope
   *  (`docs/runbooks/host-collector.md`'s `issue-service-handle --scope` step). */
  observeOperation(params: ObserveOperationParams): Promise<ObserveOperationResult>;
}

async function defaultReadToken(file: string): Promise<string> {
  const raw = await readFile(file, 'utf8');
  return raw.trim();
}

interface CapabilityOkResponse {
  readonly ok: true;
  readonly result: unknown;
}
interface CapabilityErrorResponse {
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string };
}

async function callCapability(
  options: KernelClientOptions,
  capability: string,
  params: unknown,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const readToken = options.readToken ?? defaultReadToken;
  const token = await readToken(options.handleTokenFile);

  const response = await fetchImpl(`${options.kernelUrl}/api/cap/${capability}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(params),
  });

  const body = (await response.json()) as CapabilityOkResponse | CapabilityErrorResponse;
  if (!body.ok) {
    throw new KernelClientError(capability, response.status, body.error.code, body.error.message);
  }
  return body.result;
}

export function createKernelClient(options: KernelClientOptions): KernelClient {
  return {
    async registerSource(params: RegisterSourceParams): Promise<RegisterSourceResult> {
      return (await callCapability(options, 'register_source', params)) as RegisterSourceResult;
    },
    async submitObservations(params: SubmitObservationsParams): Promise<SubmitObservationsResult> {
      return (await callCapability(
        options,
        'submit_observations',
        params,
      )) as SubmitObservationsResult;
    },
    async observeOperation(params: ObserveOperationParams): Promise<ObserveOperationResult> {
      return (await callCapability(options, 'observe_operation', params)) as ObserveOperationResult;
    },
  };
}
