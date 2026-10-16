import type { Operation } from '@nexttime/shared';
import type { CredentialResolver } from './credentials/index.js';
import {
  ApplyNotReceivedError,
  ApplyOutcomeUnknownError,
  ApplyRequiresIdempotencyKeyError,
  BindingKindMismatchError,
  IdempotencyConflictError,
  OperationDefinitionMismatchError,
  OperationModeMismatchError,
  OperationNotFoundError,
  OperationRefusedError,
  RevertNotSupportedError,
  TransportInvokeError,
  TransportOutcomeUnknownError,
} from './errors.js';
import { hashIdempotencyParams } from './idempotency-store.js';
import type { IdempotencyStore, StoredApplyFailure } from './idempotency-store.js';
import type { Transport, TransportInvokeResult } from './kinds/types.js';
import { networkFailureCode, networkFailureDelivery } from './network-failure.js';
import { operationDefinitionDigest } from './operation-digest.js';
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
  /**
   * Legacy K: the digest of the definition the caller approved (`operation-digest.ts`), checked
   * against this gate's own before anything runs. `server.ts` always passes the request's value,
   * `null` when the request carried none, which is refused. `undefined` skips the check; only an
   * in-process caller that holds this gate's own manifest (a test, a gate's own tooling) passes
   * nothing.
   */
  readonly operationDigest?: string | null;
}

/** What a gate's own definition hashes to when it does not parse: equal to no digest a caller
 *  can send, so every call to it is refused. */
const UNREADABLE_DEFINITION = 'unreadable';

/**
 * How a failed transport call is recorded under its key (R-51, legacy 287, legacy 310). The
 * transport says which side of the line a failure is on, by what it throws:
 *
 *   - `TransportOutcomeUnknownError`: it cannot know (an exec timeout, an ssh session that dropped
 *     mid-command, a connection that broke after the request may have reached the target) —
 *     outcome-unknown.
 *   - `TransportInvokeError`: its own verdict that the call failed — the target answered (a status,
 *     an exit code, an error result) or nothing was sent — a plain failure, unless its `cause`
 *     chain shows the call failed on the network after the request may have reached the target
 *     (`networkFailureDelivery` reads `maybe_delivered`: a reset, a closed socket, a timeout).
 *   - `BindingKindMismatchError`: the Operation is not this transport's kind, thrown before anything
 *     is touched — a plain failure.
 *
 * Anything else — an error a custom or third-party transport did not classify — is outcome-unknown
 * unless it proves the request never left (`not_sent`: refused, no such host, a handshake-only TLS
 * failure). Legacy 310: this used to default to a plain failure, which reads as "did not happen" and
 * invites a second run of a call that may have reached the target; a transport that knows better
 * says so by throwing one of the classes above. (`OperationRefusedError` never gets here: `apply`
 * frees the key for it, since nothing ran.)
 */
function storedTransportFailure(name: string, err: unknown): StoredApplyFailure {
  const message =
    err instanceof TransportInvokeError
      ? err.message
      : `apply for "${name}" failed inside the gate`;
  if (err instanceof TransportOutcomeUnknownError) return { message, outcomeUnknown: true };
  const delivery = networkFailureDelivery(err);
  if (delivery === 'maybe_delivered') {
    const code = networkFailureCode(err);
    const stopped =
      code !== undefined
        ? `its connection to the target failed (${code})`
        : 'it stopped waiting for the answer';
    return {
      message: `${message} — ${stopped} after the request may have reached the target, so it may have run`,
      outcomeUnknown: true,
    };
  }
  if (
    err instanceof TransportInvokeError ||
    err instanceof BindingKindMismatchError ||
    delivery === 'not_sent'
  ) {
    return { message, outcomeUnknown: false };
  }
  return {
    message: `${message} — the transport did not say whether the request reached the target, so it may have run`,
    outcomeUnknown: true,
  };
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
  private readonly digestsByName = new Map<string, string>();

  constructor(options: GatekeeperBaseOptions) {
    this.options = options;
    this.operationsByName = new Map(options.manifest.map((op) => [op.name, op]));
  }

  /** Legacy K: the digest of this gate's own definition of `operation`, computed once. */
  definitionDigest(operation: Operation): string {
    let digest = this.digestsByName.get(operation.name);
    if (digest === undefined) {
      try {
        digest = operationDefinitionDigest(operation);
      } catch {
        digest = UNREADABLE_DEFINITION;
      }
      this.digestsByName.set(operation.name, digest);
    }
    return digest;
  }

  /** Legacy K: the refusal for a call whose approved definition is not this gate's, if it is
   *  one (see `GatekeeperBaseCallContext.operationDigest`). */
  private definitionMismatch(
    operation: Operation,
    ctx: GatekeeperBaseCallContext,
  ): OperationDefinitionMismatchError | undefined {
    if (ctx.operationDigest === undefined) return undefined;
    const running = this.definitionDigest(operation);
    if (ctx.operationDigest !== null && ctx.operationDigest === running) return undefined;
    return new OperationDefinitionMismatchError(operation.name, ctx.operationDigest, running);
  }

  private assertDefinition(operation: Operation, ctx: GatekeeperBaseCallContext): void {
    const mismatch = this.definitionMismatch(operation, ctx);
    if (mismatch) throw mismatch;
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
    this.assertDefinition(operation, ctx);
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
    this.assertDefinition(operation, ctx);
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
    // Legacy K: a call for a definition this gate does not run is refused — but only once its key
    // is known to hold no answer. A repeat of an apply that already ran gets that run's answer even
    // when the manifest changed since: refusing it would report as failed an action that took
    // effect. (The kernel reaper asks `lookupApply` instead, legacy 287.) So the mismatch is decided here and thrown after the
    // reservation below; the mode and params checks, which read this gate's definition, are
    // skipped for it.
    const mismatch = this.definitionMismatch(operation, ctx);
    if (!mismatch) {
      if (operation.mode !== 'execute') {
        throw new OperationModeMismatchError(name, 'execute', operation.mode);
      }
      assertParamsValid(name, operation.params_schema, params);
    }

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
    if (mismatch) {
      // Nothing ran under this key — free it, as for any other refusal (R-04).
      await store.release(actionRequestId);
      throw mismatch;
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
      // second run. One that stopped without an answer is outcome-unknown, not failed.
      const failure = storedTransportFailure(name, err);
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

  /**
   * Legacy 287: what this gate holds for an `apply` — the kernel reaper's question about a call it
   * never got an answer to. Reads the idempotency store only: never the transport, never a
   * credential, and no definition or params check (the answer is whatever ran under the key, even
   * if the manifest changed since). The stored result (`replayed: true`); the stored failure, or
   * "outcome unknown", as the `apply` would answer now; 409 `idempotency_conflict` while the call
   * still runs or when the key holds a different call; and `ApplyNotReceivedError` when no call
   * for the key ran here — the key is closed in the same step, so an `apply` that only arrives now
   * is refused, never run.
   */
  async lookupApply(
    name: string,
    params: unknown,
    actionRequestId: string,
    ctx: Pick<GatekeeperBaseCallContext, 'onBehalfOf'> = {},
  ): Promise<ApplyResult> {
    if (!actionRequestId) throw new ApplyRequiresIdempotencyKeyError(name);
    const found = await this.options.idempotencyStore.lookup(actionRequestId, {
      operation: name,
      paramsHash: hashIdempotencyParams(params),
      onBehalfOf: ctx.onBehalfOf,
    });
    switch (found.status) {
      case 'replay':
        return {
          data: found.entry.data,
          observedFacts: found.entry.observedFacts as ObservedFactCandidate[],
          replayed: true,
        };
      case 'failed':
        throw storedFailureError(actionRequestId, found.failure);
      case 'unknown':
        throw new ApplyOutcomeUnknownError(actionRequestId);
      case 'pending':
      case 'conflict':
        throw new IdempotencyConflictError(actionRequestId);
      case 'absent':
        throw new ApplyNotReceivedError(actionRequestId);
    }
  }

  async revert(
    name: string,
    params: unknown,
    ctx: GatekeeperBaseCallContext = {},
  ): Promise<RevertResult> {
    const operation = this.getOperation(name);
    this.assertDefinition(operation, ctx);
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
