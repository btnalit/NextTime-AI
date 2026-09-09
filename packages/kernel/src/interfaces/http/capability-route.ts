import { IllegalTransition } from '@nexttime/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  GatekeeperClientError,
  GatekeeperTimeoutError,
} from '../../adapters/gatekeeper-client/index.js';
import { ChatNotFoundError, TurnAlreadyRunningError } from '../../application/chat/index.js';
// NoActiveTurnError/TurnNotFoundError are exported from handlers.ts itself but not re-exported by
// application/gateway/index.ts's curated public surface (adding them there is a one-line change
// inside application/gateway/**, outside this task's file ownership — see this PR's own report)
// — imported directly from the file that defines them instead. Layer-wise this is still
// interfaces -> application, exactly what .dependency-cruiser.cjs already permits; only the
// "go through index.ts" naming convention is bypassed, not the six-layer rule itself.
import { NoActiveTurnError, TurnNotFoundError } from '../../application/gateway/handlers.js';
import {
  AgentProfileValidationError,
  AssertFactWriteNotImplementedError,
  CapabilityNotFoundError,
  CapabilityNotImplementedError,
  ConnectionCredentialRequiredError,
  ConnectionManifestFetchError,
  type DispatchDeps,
  ExplainNodeNotFoundError,
  ForbiddenError,
  GatekeeperNotFoundError,
  InvalidCapabilityParamsError,
  MetaOntologyWriteForbiddenError,
  ModelsCatalogUnavailableError,
  PrincipalNotFoundError,
  PrincipalOperationRefusedError,
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
  TaskRuntimeNotConfiguredError,
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
import {
  GrantNotFoundError,
  HandleIssuanceError,
  ScopeValidationError,
} from '../../governance/capability/index.js';
import { ConnectionRequestNotFoundError } from '../../governance/connections/index.js';
import {
  OperationIdentityConflictError,
  OperationNotFoundError,
} from '../../governance/gatekeepers/index.js';
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
  // Lane-4 P2 fix (docs/development-tasks.md "Unmapped error classes → 500"): `report_turn`'s own
  // `turnId` lookup failure and `record_decision`'s "no currently-running Turn to attribute this
  // Decision to" both previously fell through to the generic 500/internal_error branch below —
  // neither is a server fault, both are the caller naming/implying a Turn that either does not
  // exist (404) or is not currently running (409, a state conflict — same family as
  // `TurnAlreadyRunningError`/`IllegalTransition` below).
  if (err instanceof TurnNotFoundError) {
    return { status: 404, code: 'turn_not_found', message: err.message };
  }
  if (err instanceof NoActiveTurnError) {
    return { status: 409, code: 'no_active_turn', message: err.message };
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
  // Review 2026-09 (docs/development-tasks.md S2.4 "实现说明补充"): `propose_operation` over an
  // identity that already exists and is not the caller's own draft — a published/deprecated
  // Operation, another Principal's draft, an import draft (I16). Same 409 family as
  // IllegalTransition / not_published: well-formed request, the row's *state* forbids it.
  if (err instanceof OperationIdentityConflictError) {
    return { status: 409, code: 'conflict', message: err.message };
  }
  // S3.11 (docs/development-tasks.md "中台控制面"): member-management invariant refusals — same
  // 409 "well-formed request, the row's current state forbids it" family as
  // OperationIdentityConflictError/IllegalTransition above (last-owner protection, self-disable,
  // a non-human target for set_principal_role/rotate_api_key/disable_principal).
  if (err instanceof PrincipalOperationRefusedError) {
    return { status: 409, code: 'conflict', message: err.message };
  }
  if (err instanceof PrincipalNotFoundError) {
    return { status: 404, code: 'not_found', message: err.message };
  }
  // S3.13 (docs/development-tasks.md "每用户智能体配置"): `set_agent_profile`'s own semantic
  // validation (model not in the whitelist, an unpublished Skill, an ungranted Gatekeeper, an
  // addendum over the policy's length cap, autoApproveLow when the policy forbids it) — same 400
  // bucket as HighBlastRadiusAutoApproveError/SetPolicyValidationError below.
  if (err instanceof AgentProfileValidationError) {
    return { status: 400, code: 'invalid_params', message: err.message };
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
  // Lane-4 P2 fix (docs/development-tasks.md "Unmapped error classes → 500"): `invoke_worker`'s
  // Handle-mint path (governance/capability/handles.ts's `assertValidScope`, called from
  // `issueHandle`) throws this for a scope naming an unknown or human-channel-only capability —
  // the caller's own malformed request, not a server fault.
  if (err instanceof ScopeValidationError) {
    return { status: 400, code: 'invalid_scope', message: err.message };
  }
  // Review fix 2026-09 (code-review finding F10 "unmapped kernel error classes drift between
  // HTTP and WS"): `invoke_worker`'s Handle-mint path (governance/capability/handles.ts's
  // `issueHandle`, called after the ScopeValidationError check above passes) throws this for an
  // invalid issuance request (unknown session, non-positive ttl) — the caller's own malformed
  // request, same 400 bucket every other Handle-mint failure mode above already uses.
  if (err instanceof HandleIssuanceError) {
    return { status: 400, code: 'invalid_params', message: err.message };
  }
  // Review fix 2026-09 (code-review finding F10): `invoke_worker`'s task-runtime precondition
  // (application/task/runtime.ts's `getConfiguredTaskRuntime`) throws this when the composition
  // root never called `configureTaskRuntime` — not a caller-input problem (400/404/409 all wrong)
  // and not silently a caller-invisible internal bug either (a plain 500 undersells it): the
  // kernel process itself is not ready to serve this capability yet. 503 is the one HTTP status
  // this file did not yet use for anything — added consistently with WS's new
  // SERVICE_UNAVAILABLE code below (rpc.ts).
  if (err instanceof TaskRuntimeNotConfiguredError) {
    return { status: 503, code: 'service_unavailable', message: err.message };
  }
  // S3.11 `list_models`: models.json missing/unreadable/malformed — same "kernel process itself
  // is not ready to serve this capability yet" 503 bucket as TaskRuntimeNotConfiguredError above.
  if (err instanceof ModelsCatalogUnavailableError) {
    return { status: 503, code: 'service_unavailable', message: err.message };
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
  // `explain` (substrate/epistemic/explain.ts) on an id that does not resolve to a Fact/Activity/
  // Decision — found on the host as a 500 (lane-4 hookup: re-exported through
  // application/gateway/index.ts's own doc comment on why, since interfaces may not import
  // substrate directly).
  if (err instanceof ExplainNodeNotFoundError) {
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
  // Extracted before the try block — available regardless of how far the request gets (even a
  // resolveCaller/401 failure knows which capability was named), and needed by the lane-4 P2
  // error log below.
  const { name: capability } = request.params as CapabilityRouteParams;

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

    const result = await dispatchCapability(
      { pool: deps.pool },
      caller,
      capability,
      request.body ?? {},
    );

    outcome = 'success';
    reply.code(200);
    return { ok: true, result };
  } catch (err) {
    outcome = 'error';
    const mapped = mapCapabilityError(err);
    reply.code(mapped.status);
    // Lane-4 P2 fix (docs/development-tasks.md "errors never logged on either transport (500s
    // invisible server-side)"): one structured line per failed call, `{capability, errorName,
    // code, status}` only — deliberately never `message`/request params, even though `message`
    // is already generic for 401/500 (mapCapabilityError's own doc comment) and could in
    // principle be logged safely for the other statuses; keeping the field set uniform across
    // every status is simpler than special-casing which ones are "safe enough" to add message to.
    request.log.error({
      capability,
      errorName: err instanceof Error ? err.name : typeof err,
      code: mapped.code,
      status: mapped.status,
    });
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
