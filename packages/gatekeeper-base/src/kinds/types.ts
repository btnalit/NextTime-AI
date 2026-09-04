import type { Operation, OperationBinding } from '@nexttime/shared';

/**
 * The transport port every `kinds/{http,mcp,cli,ssh}.ts` implementation satisfies. `GatekeeperBase`
 * (`../gatekeeper-base.ts`) is the only caller — it resolves the Operation, validates params against
 * `params_schema`, resolves the credential, then hands off to `invoke`/`simulate`/`revert`.
 */

export type TransportKind = OperationBinding['kind'];

export interface TransportInvokeContext {
  readonly onBehalfOf?: string;
  /** Resolved credential material (shape is transport-specific — an auth header value, a token,
   *  ...), or `undefined` for a gate with no credential configured. */
  readonly credential?: unknown;
}

export interface TransportInvokeResult {
  /** The raw response, before `result_mapping` runs against it. */
  readonly data: unknown;
  /** Transport-specific extra detail carried through to the protocol response's `observedFacts`
   *  computation or logging — e.g. the ssh transport's live command classification. */
  readonly detail?: unknown;
}

export interface Transport {
  readonly kind: TransportKind;

  /** Whether `GatekeeperBase` must resolve a credential before every call (default `true`). `ssh`
   *  (identity file) and `cli` (local socket/binary) authenticate out of band and set this `false`
   *  — otherwise a gate started in shared mode with no `GATE_CREDENTIAL_*` var fails every
   *  observe/simulate/apply with CredentialResolutionError (S2.12 host run: the ssh fixture gate). */
  readonly credentialRequired?: boolean;

  /** Executes one Operation call (used for both `observe` and `apply` — GatekeeperBase is what
   *  restricts which Operations may reach either protocol method). */
  invoke(
    operation: Operation,
    params: unknown,
    ctx: TransportInvokeContext,
  ): Promise<TransportInvokeResult>;

  /** Dry-run description of what `invoke` would do, without doing it. Optional — GatekeeperBase
   *  falls back to a generic binding-derived description when a transport omits this. */
  simulate?(
    operation: Operation,
    params: unknown,
    ctx: TransportInvokeContext,
  ): Promise<{ description: string; detail?: unknown }>;

  /** Reverses a prior `invoke` call. Optional — Operations with `reversibility: false` never call
   *  this; GatekeeperBase throws `RevertNotSupportedError` if a `reversibility: true` Operation's
   *  transport has no `revert`. */
  revert?(
    operation: Operation,
    params: unknown,
    ctx: TransportInvokeContext,
  ): Promise<TransportInvokeResult>;

  /** Transport-level health check (e.g. a lightweight ping to the target system). Optional —
   *  GatekeeperBase reports `ok` when a transport has none. */
  health?(): Promise<{ status: 'ok' | 'degraded' | 'down'; detail?: string }>;
}
