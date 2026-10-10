import { shortOperationDigest } from './operation-digest.js';

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

/** R-51: an exec transport (`ssh`, `cli`) killed a command that ran past its exec timeout
 *  (`kinds/exec-timeout.ts`). The command may have partially or fully run on the target, so
 *  `GatekeeperBase.apply` records the call's key as outcome-unknown, never as a plain failure.
 *  Extends `TransportInvokeError`: on `observe` it maps like any other transport failure (502). */
export class TransportTimeoutError extends TransportInvokeError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransportTimeoutError';
  }
}

/** R-51 / D-11: the gate cannot say whether this `apply` took effect — an earlier gate process
 *  reserved the key and stopped before recording a result, or the transport timed out mid-call
 *  (`TransportTimeoutError`). The call is never re-run automatically: the kernel marks the
 *  ActionRequest `failed` with an `outcome_unknown` reason for a person to reconcile against the
 *  target. `server.ts` maps it to 409 `apply_outcome_unknown`. */
export class ApplyOutcomeUnknownError extends Error {
  constructor(key: string, detail?: string) {
    super(
      `apply for actionRequestId "${key}" has an unknown outcome: ${
        detail ?? 'an earlier gate process reserved it and stopped before recording a result'
      } — it is not re-run automatically; check the target system and reconcile by hand`,
    );
    this.name = 'ApplyOutcomeUnknownError';
  }
}

/** R-04: the gate itself refuses the call — its target is outside what this gate serves (the
 *  docker gate's platform agent containers, `gatekeepers/docker/src/transport.ts`). A transport
 *  throws it *before* touching the target system, so nothing ran: `GatekeeperBase.apply` releases
 *  the call's idempotency reservation (a retry gets the same refusal, not 409), and `server.ts`
 *  maps it to 403 `operation_refused`. */
export class OperationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationRefusedError';
  }
}

/** Legacy 175 follow-up (review of #532): an Operation's param the `http` transport would put
 *  where only the gate's own configuration may: a request header that says who is calling, on
 *  whose account or where the call goes (`Authorization`, `Cookie`, `X-API-Key`, `X-Auth-Token`,
 *  `Impersonate-User`, `X-Forwarded-Host`, `X-HTTP-Method-Override`, one the gate's own
 *  credential injection sets — `kinds/http.ts`'s `isGateOwnedHeader`), a credential in the query
 *  string (`access_token`, `api_key` — `isGateOwnedQueryParam`), a cookie, or a query parameter
 *  the Operation's binding fixes. Refused by name before any request is made, whatever the value:
 *  the gate authenticates with the credential configured on it, never with one a caller passes,
 *  and an observe-class call has no approval. An `OperationRefusedError`, so `server.ts` maps it
 *  to 403 `operation_refused` and `apply` frees the call's key. */
export class GateOwnedParamRefusedError extends OperationRefusedError {
  readonly operationName: string;
  readonly param: string;
  readonly location: 'header' | 'query' | 'cookie' | 'binding';
  constructor(
    operationName: string,
    param: string,
    location: 'header' | 'query' | 'cookie' | 'binding',
  ) {
    const why = {
      header: `would be sent as the "${param}" request header, which says who is calling, on whose account or where the call goes`,
      query: `would be sent as the "${param}" query parameter, which carries who is calling`,
      cookie: 'is declared as a cookie, which carries session state',
      binding: `would replace the "${param}" query parameter the Operation's binding fixes`,
    }[location];
    super(
      `operation "${operationName}": param "${param}" ${why} — refused, nothing was sent. Only the gate's own configuration sets these; it authenticates with the credential configured on it.`,
    );
    this.name = 'GateOwnedParamRefusedError';
    this.operationName = operationName;
    this.param = param;
    this.location = location;
  }
}

/** Legacy K: the call's `operationDigest` is not the digest of the definition this gate runs
 *  (`operation-digest.ts`), or the call carried none. Thrown before the transport or credential
 *  is touched, so nothing ran; `apply` frees the call's key. The one exception is an `apply`
 *  whose key already holds an answer: that answer is returned, because the call did run.
 *  `server.ts` maps it to 409 `operation_definition_mismatch`. */
export class OperationDefinitionMismatchError extends Error {
  readonly operationName: string;
  /** The digest the call said was approved — `null` when it carried none. */
  readonly approvedDigest: string | null;
  /** The digest of the definition this gate runs. `server.ts` puts it in the error's `details`,
   *  so the kernel can record both sides of a refusal (UX acceptance of #538). */
  readonly runningDigest: string;
  constructor(operationName: string, approved: string | null, running: string) {
    super(
      approved === null
        ? `operation "${operationName}": the call does not say which definition was approved (no operationDigest) — refused, nothing ran. This gate checks it on every call; the kernel calling it is older than the gate. Upgrade the kernel and its gates together.`
        : `operation "${operationName}": the definition that was approved (${shortOperationDigest(approved)}) is not the one this gate runs (${shortOperationDigest(running)}) — refused, nothing ran. The gate's manifest changed after the Operation was published, or differs from the copy the workspace imported. Publish the definition this gate runs, then call again. For a platform gate: a platform admin first adopts the gate's new manifest (Integrations) if it is still waiting there; then the workspace aligns the Operation (Systems & access) and publishes the revision it opens (Catalog).`,
    );
    this.name = 'OperationDefinitionMismatchError';
    this.operationName = operationName;
    this.approvedDigest = approved;
    this.runningDigest = running;
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
    super(`apply for operation "${name}" requires actionRequestId`);
    this.name = 'ApplyRequiresIdempotencyKeyError';
  }
}

/** Review lane 5, P2-1: an `actionRequestId` reused for a different `(operation, paramsHash,
 *  onBehalfOf)` tuple than the one it was first reserved for — either a caller bug (key reuse
 *  across unrelated calls) or a genuinely concurrent duplicate `apply` for the same key that is
 *  still in flight (`idempotency-store.ts`'s `reserve` folds both cases into `'conflict'`: neither
 *  may safely invoke the transport a second time). Class name unchanged
 *  (docs/wire-contract-conventions.md's rename is the wire field/key value, not this generic
 *  "idempotent execution" mechanism's own name). */
export class IdempotencyConflictError extends Error {
  constructor(key: string) {
    super(
      `actionRequestId "${key}" is already in use for a different (operation, params, onBehalfOf) or is still being applied — reuse a key only for a retry of the exact same call`,
    );
    this.name = 'IdempotencyConflictError';
  }
}

/** Review lane 5, P2-5: an Operation's `params_schema` that `ajv.compile()` cannot handle (most
 *  commonly an unresolved `$ref` — this package does not fetch/inline external JSON Schema
 *  documents at manifest-import time) previously surfaced as a bare 500 `internal_error`, giving
 *  no signal that the *manifest*, not the caller's `params`, is broken. Named after the Operation
 *  so the error is diagnosable from the wire response alone. */
export class ParamsSchemaInvalidError extends Error {
  constructor(operationName: string, cause: unknown) {
    super(
      `params_schema for operation "${operationName}" could not be compiled: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = 'ParamsSchemaInvalidError';
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
