import type { FastifyReply, FastifyRequest } from 'fastify';
import { ChatNotFoundError, TurnAlreadyRunningError } from '../../application/chat/index.js';
import {
  CapabilityNotFoundError,
  CapabilityNotImplementedError,
  type DispatchDeps,
  ForbiddenError,
  InvalidCapabilityParamsError,
  type ResolveCallerDeps,
  UnauthorizedError,
  dispatchCapability,
  resolveCaller,
} from '../../application/gateway/index.js';

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
  if (err instanceof ForbiddenError) {
    return { status: 403, code: 'forbidden', message: err.message };
  }
  if (err instanceof InvalidCapabilityParamsError) {
    return { status: 400, code: 'invalid_params', message: err.message };
  }
  if (err instanceof CapabilityNotImplementedError) {
    return { status: 501, code: 'not_implemented', message: err.message };
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
