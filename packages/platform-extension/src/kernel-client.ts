import { capabilityRoute } from '@nexttime/shared';

/**
 * Thin fetch client over the HTTP capability-route convention (design doc §9.3, decided in
 * `packages/shared/src/http.ts`): `POST /api/cap/<capability_name>` with a JSON body of params and
 * `Authorization: Bearer <CAPABILITY_HANDLE>`; response `{ok:true, result}` or
 * `{ok:false, error:{code,message}}`. Used by every mode (entry now, worker/interactive later) to
 * call the kernel without depending on the kernel's internal HTTP framework.
 *
 * The capability Handle is a bearer credential (S1.9): this module never logs it, never includes
 * it in a thrown error's message, and only ever places it in the `authorization` request header.
 */

/** Default request timeout, in milliseconds, applied to every kernel call unless overridden. */
export const DEFAULT_KERNEL_CLIENT_TIMEOUT_MS = 30_000;

export interface KernelClientOptions {
  /** Base URL of the kernel, e.g. `http://kernel:8080` — no trailing slash required. */
  kernelUrl: string;
  /** The CapabilityHandle (S1.9 JWT) sent as `Authorization: Bearer <handle>`. Never logged. */
  capabilityHandle: string;
  /** Per-call timeout in milliseconds. Defaults to {@link DEFAULT_KERNEL_CLIENT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Injectable `fetch` implementation, for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Discriminates why a kernel call failed, without ever carrying the capability Handle. */
export type KernelErrorKind =
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'invalid_response'
  | 'capability_error';

export interface KernelErrorOptions {
  /** The `error.code` from a `{ok:false}` envelope, when `kind === 'capability_error'`. */
  code?: string;
  cause?: unknown;
}

/** Typed error thrown by every {@link KernelClient.call} failure mode. */
export class KernelError extends Error {
  readonly kind: KernelErrorKind;
  readonly code: string | undefined;

  constructor(kind: KernelErrorKind, message: string, options: KernelErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'KernelError';
    this.kind = kind;
    this.code = options.code;
  }
}

interface CapabilitySuccessEnvelope {
  ok: true;
  result: unknown;
}

interface CapabilityErrorEnvelope {
  ok: false;
  error: { code: string; message: string };
}

function asErrorEnvelope(error: unknown): CapabilityErrorEnvelope['error'] | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record.code === 'string' && typeof record.message === 'string') {
    return { code: record.code, message: record.message };
  }
  return undefined;
}

function parseCapabilityEnvelope(
  value: unknown,
): CapabilitySuccessEnvelope | CapabilityErrorEnvelope | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.ok === true && 'result' in record) {
    return { ok: true, result: record.result };
  }
  if (record.ok === false) {
    const error = asErrorEnvelope(record.error);
    if (error) return { ok: false, error };
  }
  return undefined;
}

export class KernelClient {
  private readonly kernelUrl: string;
  private readonly capabilityHandle: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: KernelClientOptions) {
    this.kernelUrl = options.kernelUrl.replace(/\/+$/, '');
    this.capabilityHandle = options.capabilityHandle;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_KERNEL_CLIENT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Calls one capability. Resolves with `result` on `{ok:true}`; throws {@link KernelError} on any
   * other outcome (network failure, timeout, caller-aborted, malformed response body, or
   * `{ok:false}`).
   */
  async call<T = unknown>(
    capabilityName: string,
    params: unknown = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${this.kernelUrl}${capabilityRoute(capabilityName)}`;
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.capabilityHandle}`,
        },
        body: JSON.stringify(params ?? {}),
        signal: requestSignal,
      });
    } catch (error) {
      if (timeoutSignal.aborted) {
        throw new KernelError(
          'timeout',
          `kernel call "${capabilityName}" timed out after ${this.timeoutMs}ms`,
          {
            cause: error,
          },
        );
      }
      if (signal?.aborted) {
        throw new KernelError('aborted', `kernel call "${capabilityName}" was aborted`, {
          cause: error,
        });
      }
      throw new KernelError(
        'network',
        `kernel call "${capabilityName}" failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new KernelError(
        'invalid_response',
        `kernel call "${capabilityName}" returned a non-JSON response (HTTP ${response.status})`,
        { cause: error },
      );
    }

    const envelope = parseCapabilityEnvelope(body);
    if (!envelope) {
      throw new KernelError(
        'invalid_response',
        `kernel call "${capabilityName}" returned an unrecognized response shape (HTTP ${response.status})`,
      );
    }

    if (!envelope.ok) {
      throw new KernelError('capability_error', envelope.error.message, {
        code: envelope.error.code,
      });
    }

    return envelope.result as T;
  }
}
