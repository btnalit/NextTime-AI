import { IllegalTransition } from '@nexttime/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  GatekeeperClientError,
  GatekeeperTimeoutError,
} from '../../adapters/gatekeeper-client/index.js';
import { ChatNotFoundError, TurnAlreadyRunningError } from '../../application/chat/index.js';
import {
  AssertFactWriteNotImplementedError,
  CapabilityNotFoundError,
  CapabilityNotImplementedError,
  ConnectionCredentialRequiredError,
  ConnectionManifestFetchError,
  type DispatchDeps,
  ForbiddenError,
  GatekeeperNotFoundError,
  InvalidCapabilityParamsError,
  MetaOntologyWriteForbiddenError,
  type ResolveCallerDeps,
  UnauthorizedError,
  WorkerResultValidationError,
  dispatchCapability,
  resolveCaller,
} from '../../application/gateway/index.js';
import {
  InvalidQuotaValueError,
  InvokeWorkerAttenuationError,
  InvokeWorkerValidationError,
  QuotaExceededError,
  TaskNotFoundError,
  UnknownQuotaKeyError,
} from '../../application/task/index.js';
import {
  ProcedureNotFoundError,
  ProcedureStepReferenceError,
  SkillNotFoundError,
  SkillValidationError,
  WorkerDefinitionKindMismatchError,
  WorkerDefinitionNotFoundError,
  WorkerDefinitionNotPublishedError,
  WorkerDefinitionValidationError,
} from '../../application/worker/index.js';
import { ActionRequestNotFoundError, ApprovalScopeError } from '../../governance/approval/index.js';
import { GrantNotFoundError } from '../../governance/capability/index.js';
import { ConnectionRequestNotFoundError } from '../../governance/connections/index.js';
import { OperationNotFoundError } from '../../governance/gatekeepers/index.js';
import {
  HighBlastRadiusAutoApproveError,
  SetPolicyValidationError,
} from '../../governance/policy/index.js';

/**
 * interfaces/http/capability-route: `POST /api/cap/<name>` (design doc §9.3; docs/development-
 * tasks.md S1.3, item 3). Thin HTTP adapter — every actual decision (auth, authorization, param
 * validation, the transaction, the audit write) lives in `application/gateway`
 * (`resolveCaller`/`dispatchCapability`); this file only translates HTTP ⇄ that service interface
 * and emits the structured request log (design doc §12, narrowed to S1.3's own fields — chat_id/
 * turn_id/task_id/worker_run_id/action_request_id/gatekeeper are §12's full list but belong to
 * modules that don't exist yet).
 *
 * Response envelope (packages/shared/src/http.ts): `{ok:true,result}` / `{ok:false,error:
 * {code,message}}`, always — regardless of HTTP status — matching S1.6's `kernel-client.ts`,
 * which parses the body and never branches on `response.status`.
 */

export interface CapabilityRouteDeps extends ResolveCallerDeps, DispatchDeps {}

/** `pg` surfaces server errors as `Error & { code: string }` (SQLSTATE). 22P02 is
 *  invalid_text_representation — the one class a caller can cause with a malformed id. */
export function isPgInvalidTextRepresentation(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: unknown }).code === '22P02';
}

interface ErrorMapping {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/**
 * Maps a thrown error to an HTTP status + wire error code. 401/500 messages are deliberately
 * generic — the specific reason (bad key, expired Handle, unexpected exception, ...) is never
 * echoed back to the caller; it is still available server-side via the `outcome`/error passed to
 * the structured log below (never persisted with credentials, see log() call).
 */
export function mapCapabilityError(err: unknown): ErrorMapping {
  if (err instanceof UnauthorizedError) {
    return { status: 401, code: 'unauthorized', message: 'unauthorized' };
  }
  // application/chat domain errors (S1.4) — the HTTP transport's equivalents of interfaces/ws/
  // rpc.ts's `-32010` / `-32004` codes: §9.4 "进行中时 send_chat_message 被拒" is a 409, a Chat that
  // does not exist or is not visible to the caller is a 404 (never distinguishing the two, same as
  // the service itself).
  if (err instanceof TurnAlreadyRunningError) {
    return { status: 409, code: 'turn_already_running', message: err.message };
  }
  if (err instanceof ChatNotFoundError) {
    return { status: 404, code: 'chat_not_found', message: err.message };
  }
  if (err instanceof CapabilityNotFoundError) {
    return { status: 404, code: 'not_found', message: err.message };
  }
  // S2.6: checked *before* the generic ForbiddenError branch below — MetaOntologyWriteForbiddenError
  // extends ForbiddenError (application/gateway/meta-ontology-guard.ts), so an `instanceof
  // ForbiddenError` check alone would always match first and this more specific, stable code
  // (docs/development-tasks.md S2.6: "403 with a stable error code") would never be reached.
  if (err instanceof MetaOntologyWriteForbiddenError) {
    return { status: 403, code: 'meta_ontology_write_forbidden', message: err.message };
  }
  if (err instanceof ForbiddenError) {
    return { status: 403, code: 'forbidden', message: err.message };
  }
  if (err instanceof InvalidCapabilityParamsError) {
    return { status: 400, code: 'invalid_params', message: err.message };
  }
  if (err instanceof CapabilityNotImplementedError) {
    return { status: 501, code: 'not_implemented', message: err.message };
  }
  // S2.6: `assert_fact` now has a handler (the I16 meta-ontology guard runs first) whose write half
  // is still unimplemented — same 501 the registry-level "no handler" case gets, so a client sees
  // one stable `not_implemented` code either way. Not a subclass of CapabilityNotImplementedError:
  // that class lives in dispatch.ts, which imports handlers.ts (an import cycle).
  if (err instanceof AssertFactWriteNotImplementedError) {
    return { status: 501, code: 'not_implemented', message: err.message };
  }
  // governance/approval + governance/policy domain errors (S2.2/S2.3). ApprovalScopeError is I14
  // ("does the approver hold this action_kind × resource_scope") — a *narrower* forbidden than
  // ForbiddenError's role-gate, but the same HTTP shape. IllegalTransition (packages/shared,
  // ACTION_REQUEST_TRANSITIONS/DECISION_TRANSITIONS) is I6's own error for a status the row is not
  // currently in (e.g. approving an already-approved ActionRequest) — a conflict, not a 400 (the
  // request itself is well-formed, the row's *state* just does not allow it right now).
  if (err instanceof ApprovalScopeError) {
    return { status: 403, code: 'forbidden', message: err.message };
  }
  if (
    err instanceof ActionRequestNotFoundError ||
    err instanceof GrantNotFoundError ||
    err instanceof GatekeeperNotFoundError ||
    err instanceof OperationNotFoundError ||
    err instanceof ConnectionRequestNotFoundError
  ) {
    return { status: 404, code: 'not_found', message: err.message };
  }
  if (err instanceof IllegalTransition) {
    return { status: 409, code: 'illegal_transition', message: err.message };
  }
  // Postgres 22P02 invalid_text_representation — a well-typed but malformed value reached a typed
  // column (e.g. a non-uuid `actionRequestId` on `approve`: the registry's `id` params are
  // `z.string().min(1)`, not uuid). The caller sent the bad value; 400, not 500 (seen on the host
  // during the S2.12 run).
  if (isPgInvalidTextRepresentation(err)) {
    return { status: 400, code: 'invalid_params', message: 'malformed identifier or value' };
  }
  // S2.13 `create_connection` (application/gateway/connection-handlers.ts): the two network legs
  // that run inline in the handler surface as upstream failures, not internal errors — the gate
  // (or the manifest URL) answered badly / not at all, and the caller can fix the endpoint or
  // retry. The gate's own `{code,message}` is preserved verbatim in `message` (e.g.
  // `connected_account_store_not_configured` → "use credentialKind: 'shared'").
  if (err instanceof ConnectionCredentialRequiredError) {
    return { status: 400, code: 'invalid_params', message: err.message };
  }
  if (err instanceof ConnectionManifestFetchError) {
    return { status: 502, code: 'manifest_fetch_failed', message: err.message };
  }
  if (err instanceof GatekeeperTimeoutError) {
    return { status: 504, code: 'gatekeeper_timeout', message: err.message };
  }
  if (err instanceof GatekeeperClientError) {
    return { status: 502, code: 'gatekeeper_error', message: `${err.code}: ${err.message}` };
  }
  if (err instanceof HighBlastRadiusAutoApproveError || err instanceof SetPolicyValidationError) {
    return { status: 400, code: 'invalid_params', message: err.message };
  }
  // S2.7 (docs/development-tasks.md S2.7 "a violated quota returns an error the entry agent can
  // relay verbatim (stable code + readable message)") — `QuotaExceededError.code` (e.g.
  // `depth_exceeded`) *is* the wire `code`, not a generic one, so the entry agent's tool-call
  // result carries the specific, stable identifier this task's acceptance criteria call for.
  if (err instanceof QuotaExceededError) {
    return { status: 429, code: err.code, message: err.message };
  }
  if (err instanceof InvokeWorkerAttenuationError) {
    return { status: 403, code: 'attenuation_denied', message: err.message };
  }
  if (err instanceof InvokeWorkerValidationError || err instanceof InvalidQuotaValueError) {
    return { status: 400, code: 'invalid_params', message: err.message };
  }
  if (err instanceof UnknownQuotaKeyError) {
    return { status: 400, code: 'unknown_quota_key', message: err.message };
  }
  if (err instanceof TaskNotFoundError) {
    return { status: 404, code: 'not_found', message: err.message };
  }
  // application/worker registry errors (S2.6 WorkerDefinitions, S2.14 Skills/Procedures) — found
  // on the host as 500s: a Procedure step referencing a nonexistent Operation must be a 400 with a
  // stable code, not an internal error. NotPublished is a 409: the row exists, its *state* forbids
  // the reference (same reasoning as IllegalTransition above).
  if (
    err instanceof WorkerDefinitionNotFoundError ||
    err instanceof SkillNotFoundError ||
    err instanceof ProcedureNotFoundError
  ) {
    return { status: 404, code: 'not_found', message: err.message };
  }
  if (err instanceof WorkerDefinitionNotPublishedError) {
    return { status: 409, code: 'not_published', message: err.message };
  }
  if (err instanceof ProcedureStepReferenceError) {
    return { status: 400, code: 'invalid_step_reference', message: err.message };
  }
  if (
    err instanceof WorkerDefinitionValidationError ||
    err instanceof WorkerDefinitionKindMismatchError ||
    err instanceof SkillValidationError
  ) {
    return { status: 400, code: 'invalid_params', message: err.message };
  }
  // S2.9 (docs/development-tasks.md S2.9 "malformed contract → 400"): a `report_task_result`
  // contract that is schema-valid (InvalidCapabilityParamsError already covers a syntax-level
  // malformed one) but invalid at the meaning level — a `factsToAssert[].objectId` that does not
  // exist, an `evidence[].factIndex` out of range, a `proposedOperations[].gatekeeperId` that does
  // not exist.
  if (err instanceof WorkerResultValidationError) {
    return { status: 400, code: 'invalid_params', message: err.message };
  }
  return { status: 500, code: 'internal_error', message: 'internal error' };
}

/** `request.params` shape for `POST /api/cap/:name` — Fastify validates the route pattern itself. */
interface CapabilityRouteParams {
  readonly name: string;
}

export async function handleCapabilityRoute(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: CapabilityRouteDeps,
): Promise<
  { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }
> {
  let workspaceId: string | undefined;
  let principalId: string | undefined;
  let onBehalfOf: string | undefined;
  let sessionId: string | undefined;
  let outcome: 'success' | 'error' = 'error';

  try {
    const caller = await resolveCaller(request.headers.authorization, {
      pool: deps.pool,
      loadHandlePublicKey: deps.loadHandlePublicKey,
    });

    if (caller.channel === 'human') {
      workspaceId = caller.principal.workspaceId;
      principalId = caller.principal.id;
      onBehalfOf = caller.principal.id;
      sessionId = caller.session.id;
    } else {
      workspaceId = caller.claims.ws;
      principalId = caller.claims.obo;
      onBehalfOf = caller.claims.obo;
      sessionId = caller.claims.sid;
    }

    const { name } = request.params as CapabilityRouteParams;
    const result = await dispatchCapability({ pool: deps.pool }, caller, name, request.body ?? {});

    outcome = 'success';
    reply.code(200);
    return { ok: true, result };
  } catch (err) {
    outcome = 'error';
    const mapped = mapCapabilityError(err);
    reply.code(mapped.status);
    return { ok: false, error: { code: mapped.code, message: mapped.message } };
  } finally {
    // Structured log fields (design doc §12, S1.3 subset) — never the Authorization header or
    // request/response body.
    request.log.info({
      workspaceId,
      principalId,
      onBehalfOf,
      sessionId,
      outcome,
      durationMs: reply.elapsedTime,
    });
  }
}
