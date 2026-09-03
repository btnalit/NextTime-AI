import type { Operation } from '@nexttime/shared';
import type { CredentialResolver } from './credentials/index.js';
import {
  ApplyRequiresIdempotencyKeyError,
  OperationModeMismatchError,
  OperationNotFoundError,
  RevertNotSupportedError,
} from './errors.js';
import type { IdempotencyStore } from './idempotency-store.js';
import type { Transport } from './kinds/types.js';
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
    idempotencyKey: string,
    ctx: GatekeeperBaseCallContext = {},
  ): Promise<ApplyResult> {
    if (!idempotencyKey) throw new ApplyRequiresIdempotencyKeyError(name);
    const operation = this.getOperation(name);
    if (operation.mode !== 'execute') {
      throw new OperationModeMismatchError(name, 'execute', operation.mode);
    }
    assertParamsValid(name, operation.params_schema, params);

    const existing = await this.options.idempotencyStore.get(idempotencyKey);
    if (existing !== undefined) {
      const stored = existing as { data: unknown; observedFacts: ObservedFactCandidate[] };
      return { data: stored.data, observedFacts: stored.observedFacts, replayed: true };
    }

    const credential = await this.resolveCredential(ctx.onBehalfOf);
    const result = await this.options.transport.invoke(operation, params, {
      onBehalfOf: ctx.onBehalfOf,
      credential,
    });
    const observedFacts = this.toObservedFacts(operation, result.data);
    await this.options.idempotencyStore.set(idempotencyKey, { data: result.data, observedFacts });
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
