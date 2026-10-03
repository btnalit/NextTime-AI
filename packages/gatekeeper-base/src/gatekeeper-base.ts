import type { Operation } from '@nexttime/shared';
import type { CredentialResolver } from './credentials/index.js';
import {
  ApplyOutcomeUnknownError,
  ApplyRequiresIdempotencyKeyError,
  IdempotencyConflictError,
  OperationModeMismatchError,
  OperationNotFoundError,
  OperationRefusedError,
  RevertNotSupportedError,
  TransportInvokeError,
  TransportTimeoutError,
} from './errors.js';
import { hashIdempotencyParams } from './idempotency-store.js';
import type { IdempotencyStore, StoredApplyFailure } from './idempotency-store.js';
import type { Transport, TransportInvokeResult } from './kinds/types.js';
import { assertParamsValid } from './params-validation.js';
import type { ObservedFactCandidate } from './protocol.js';
import { applyResultMapping } from './result-mapping.js';

/**
 * `GatekeeperBase`: constructed from a manifest (`Operation[]`, §5.1.4) + one transport `kind`
 * implementation (`kinds/{http,mcp,cli,ssh}.ts`) + one credential resolver + an idempotent apply
 * store. Validates `params` against each Operation's `params_schema`, routes `observe` only to
 * `mode: 'observe'` Operations and `apply` only to `mode: 'execute'` ones, and turns a mapped
 * response into `observed` fact candidates when the Operation declares a `result_mapping`.
 *
 * This class has no HTTP awareness at all — `server.ts` is the thin Fastify adapter around it, so
 * every method here is directly unit-testable with a fake `Transport`.
 */

export interface ObserveResult {
  readonly data: unknown;
  readonly observedFacts: readonly ObservedFactCandidate[];
}

export interface SimulateResult {
  readonly description: string;
  readonly detail?: unknown;
}

export interface ApplyResult {
  readonly data: unknown;
  readonly observedFacts: readonly ObservedFactCandidate[];
  readonly replayed: boolean;
}

export interface RevertResult {
  readonly data: unknown;
}

export interface HealthResult {
  readonly status: 'ok' | 'degraded' | 'down';
  readonly detail?: string;
}

export interface GatekeeperBaseCallContext {
  readonly onBehalfOf?: string;
}

/** The error a stored failed `apply` answers with on every later call for its key (R-51): the
 *  same transport failure (502), or "outcome unknown" (409) when a timeout killed the call. */
function storedFailureError(key: string, failure: StoredApplyFailure): Error {
  return failure.outcomeUnknown
    ? new ApplyOutcomeUnknownError(key, failure.message)
    : new TransportInvokeError(failure.message);
}

export interface GatekeeperBaseOptions {
  readonly manifest: readonly Operation[];
  readonly transport: Transport;
  readonly credentialResolver: CredentialResolver;
  readonly idempotencyStore: IdempotencyStore;
}

export class GatekeeperBase {
  private readonly options: GatekeeperBaseOptions;
  private readonly operationsByName: Map<string, Operation>;

  constructor(options: GatekeeperBaseOptions) {
    this.options = options;
    this.operationsByName = new Map(options.manifest.map((op) => [op.name, op]));
  }

  describeOperations(): readonly Operation[] {
    return [...this.operationsByName.values()];
  }

  private getOperation(name: string): Operation {
    const operation = this.operationsByName.get(name);
    if (!operation) throw new OperationNotFoundError(name);
    return operation;
  }

  private async resolveCredential(onBehalfOf: string | undefined): Promise<unknown> {
    // A transport that authenticates out of band (ssh identity file, local cli) declares
    // `credentialRequired: false` — resolving would only ever fail for a gate that has no
    // credential to configure (kinds/types.ts).
    if (this.options.transport.credentialRequired === false) return undefined;
    return this.options.credentialResolver.resolve(onBehalfOf);
  }

  private toObservedFacts(operation: Operation, data: unknown): ObservedFactCandidate[] {
    if (!operation.result_mapping) return [];
    return applyResultMapping(data, operation.result_mapping);
  }

  async observe(
    name: string,
    params: unknown,
    ctx: GatekeeperBaseCallContext = {},
  ): Promise<ObserveResult> {
    const operation = this.getOperation(name);
    if (operation.mode !== 'observe') {
      throw new OperationModeMismatchError(name, 'observe', operation.mode);
    }
    assertParamsValid(name, operation.params_schema, params);
    const credential = await this.resolveCredential(ctx.onBehalfOf);
    const result = await this.options.transport.invoke(operation, params, {
      onBehalfOf: ctx.onBehalfOf,
      credential,
    });
    return { data: result.data, observedFacts: this.toObservedFacts(operation, result.data) };
  }

  async simulate(
    name: string,
    params: unknown,
    ctx: GatekeeperBaseCallContext = {},
  ): Promise<SimulateResult> {
    const operation = this.getOperation(name);
    assertParamsValid(name, operation.params_schema, params);
    const credential = await this.resolveCredential(ctx.onBehalfOf);
    if (this.options.transport.simulate) {
      return this.options.transport.simulate(operation, params, {
        onBehalfOf: ctx.onBehalfOf,
        credential,
      });
    }
    return {
      description: `would ${operation.mode} "${operation.name}" via ${operation.binding.kind}`,
      detail: { binding: operation.binding, params: params ?? {} },
    };
  }

  async apply(
    name: string,
    params: unknown,
    actionRequestId: string,
    ctx: GatekeeperBaseCallContext = {},
  ): Promise<ApplyResult> {
    if (!actionRequestId) throw new ApplyRequiresIdempotencyKeyError(name);
    const operation = this.getOperation(name);
    if (operation.mode !== 'execute') {
      throw new OperationModeMismatchError(name, 'execute', operation.mode);
    }
    assertParamsValid(name, operation.params_schema, params);

    // Reserved *before* the transport is invoked (review lane 5, P2-1) — a concurrent `apply` for
    // the same key, matching tuple or not, gets 'conflict' rather than a second invocation. The
    // idempotency store is keyed by `actionRequestId` (docs/wire-contract-conventions.md §1,
    // 2026-09-08 decision — the ActionRequest's own id, not a caller-supplied dedupe token).
    const descriptor = {
      operation: name,
      paramsHash: hashIdempotencyParams(params),
      onBehalfOf: ctx.onBehalfOf,
    };
    const store = this.options.idempotencyStore;
    const reservation = await store.reserve(actionRequestId, descriptor);
    if (reservation.status === 'conflict') {
      throw new IdempotencyConflictError(actionRequestId);
    }
    if (reservation.status === 'unknown') {
      // R-51 / D-11: reserved by a gate process that died mid-call — never re-run.
      throw new ApplyOutcomeUnknownError(actionRequestId);
    }
    if (reservation.status === 'failed') {
      throw storedFailureError(actionRequestId, reservation.failure);
    }
    if (reservation.status === 'replay') {
      const entry = reservation.entry;
      return {
        data: entry.data,
        observedFacts: entry.observedFacts as ObservedFactCandidate[],
        replayed: true,
      };
    }

    let credential: unknown;
    try {
      credential = await this.resolveCredential(ctx.onBehalfOf);
    } catch (err) {
      // R-51: nothing ran yet — free the key, so a retry once the credential is fixed is a clean
      // first attempt rather than 409 forever.
      await store.release(actionRequestId);
      throw err;
    }
    let result: TransportInvokeResult;
    try {
      result = await this.options.transport.invoke(operation, params, {
        onBehalfOf: ctx.onBehalfOf,
        credential,
      });
    } catch (err) {
      // R-04: a refusal ran nothing — free the key so a retry is refused again, not 409.
      if (err instanceof OperationRefusedError) {
        await store.release(actionRequestId);
        throw err;
      }
      // R-51: any other failure may have acted before it failed — record it under the key, so a
      // retry (the kernel reaper's replay) gets this same answer instead of 409 forever or a
      // second run. A timeout killed the command mid-call: its outcome is unknown, not failed.
      const failure: StoredApplyFailure = {
        message:
          err instanceof TransportInvokeError
            ? err.message
            : `apply for "${name}" failed inside the gate`,
        outcomeUnknown: err instanceof TransportTimeoutError,
      };
      await store.fail(actionRequestId, failure);
      throw failure.outcomeUnknown ? storedFailureError(actionRequestId, failure) : err;
    }
    const observedFacts = this.toObservedFacts(operation, result.data);
    await this.options.idempotencyStore.complete(actionRequestId, {
      data: result.data,
      observedFacts,
    });
    return { data: result.data, observedFacts, replayed: false };
  }

  async revert(
    name: string,
    params: unknown,
    ctx: GatekeeperBaseCallContext = {},
  ): Promise<RevertResult> {
    const operation = this.getOperation(name);
    if (!operation.reversibility || !this.options.transport.revert) {
      throw new RevertNotSupportedError(name);
    }
    const credential = await this.resolveCredential(ctx.onBehalfOf);
    const result = await this.options.transport.revert(operation, params, {
      onBehalfOf: ctx.onBehalfOf,
      credential,
    });
    return { data: result.data };
  }

  async health(): Promise<HealthResult> {
    if (this.options.transport.health) return this.options.transport.health();
    return { status: 'ok' };
  }
}
