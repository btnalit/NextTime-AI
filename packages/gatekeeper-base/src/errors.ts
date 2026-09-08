/**
 * Error classes thrown by `GatekeeperBase` and its transports. `server.ts` maps each to a stable
 * HTTP status (protocol validation errors → 400, per the task brief).
 */

export class OperationNotFoundError extends Error {
  constructor(name: string) {
    super(`operation not found: "${name}"`);
    this.name = 'OperationNotFoundError';
  }
}

/** Thrown when `observe` is called on a `mode: 'execute'` Operation, or `apply` on `mode:
 *  'observe'` — GatekeeperBase routes each protocol call to only the matching mode. */
export class OperationModeMismatchError extends Error {
  constructor(name: string, expectedMode: string, actualMode: string) {
    super(`operation "${name}" has mode "${actualMode}", expected "${expectedMode}"`);
    this.name = 'OperationModeMismatchError';
  }
}

export class ParamsValidationError extends Error {
  readonly issues: unknown;
  constructor(operationName: string, issues: unknown) {
    super(`params for operation "${operationName}" failed validation against params_schema`);
    this.name = 'ParamsValidationError';
    this.issues = issues;
  }
}

export class CredentialResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialResolutionError';
  }
}

export class TransportInvokeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransportInvokeError';
  }
}

export class RevertNotSupportedError extends Error {
  constructor(name: string) {
    super(`operation "${name}" does not support revert`);
    this.name = 'RevertNotSupportedError';
  }
}

export class BindingKindMismatchError extends Error {
  constructor(operationName: string, transportKind: string, bindingKind: string) {
    super(
      `operation "${operationName}" has binding kind "${bindingKind}" but this gate's transport is "${transportKind}"`,
    );
    this.name = 'BindingKindMismatchError';
  }
}

export class ApplyRequiresIdempotencyKeyError extends Error {
  constructor(name: string) {
    super(`apply for operation "${name}" requires idempotencyKey`);
    this.name = 'ApplyRequiresIdempotencyKeyError';
  }
}

/** Review lane 5, P2-1: an `idempotencyKey` reused for a different `(operation, paramsHash,
 *  onBehalfOf)` tuple than the one it was first reserved for — either a caller bug (key reuse
 *  across unrelated calls) or a genuinely concurrent duplicate `apply` for the same key that is
 *  still in flight (`idempotency-store.ts`'s `reserve` folds both cases into `'conflict'`: neither
 *  may safely invoke the transport a second time). */
export class IdempotencyConflictError extends Error {
  constructor(key: string) {
    super(
      `idempotencyKey "${key}" is already in use for a different (operation, params, onBehalfOf) or is still being applied — reuse a key only for a retry of the exact same call`,
    );
    this.name = 'IdempotencyConflictError';
  }
}

/** S2.13: `POST`/`DELETE /gate/connected-accounts` on a gate started in shared-credential mode
 *  (no `ConnectedAccountStore` configured — `credentials/shared-env.ts`'s `SharedEnvCredentialResolver`).
 *  There is nowhere to write the credential; the caller (`create_connection`'s handler) should
 *  have used `credentialKind: 'shared'` for this Gatekeeper instead. */
export class ConnectedAccountStoreNotConfiguredError extends Error {
  constructor() {
    super(
      'this gate has no ConnectedAccountStore configured (GATE_CREDENTIAL_MODE is not ' +
        'connected_account) — there is nowhere to store or delete a per-principal credential',
    );
    this.name = 'ConnectedAccountStoreNotConfiguredError';
  }
}
