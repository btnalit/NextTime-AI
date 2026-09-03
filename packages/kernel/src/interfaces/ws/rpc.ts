import { IllegalTransition } from '@nexttime/shared';
import { z } from 'zod';
import { ChatNotFoundError, TurnAlreadyRunningError } from '../../application/chat/index.js';
import {
  AssertFactWriteNotImplementedError,
  CapabilityNotFoundError,
  CapabilityNotImplementedError,
  ForbiddenError,
  GatekeeperNotFoundError,
  InvalidCapabilityParamsError,
  UnauthorizedError,
} from '../../application/gateway/index.js';
import {
  InvalidQuotaValueError,
  InvokeWorkerAttenuationError,
  InvokeWorkerValidationError,
  QuotaExceededError,
  TaskNotFoundError,
  UnknownQuotaKeyError,
} from '../../application/task/index.js';
import { ActionRequestNotFoundError, ApprovalScopeError } from '../../governance/approval/index.js';
import { GrantNotFoundError } from '../../governance/capability/index.js';
import { OperationNotFoundError } from '../../governance/gatekeepers/index.js';
import {
  HighBlastRadiusAutoApproveError,
  SetPolicyValidationError,
} from '../../governance/policy/index.js';

/**
 * interfaces/ws/rpc: JSON-RPC 2.0 message shapes and error-code mapping for `/ws` (design doc
 * §9.4; docs/development-tasks.md S1.4 deliverable 4). Pure — no IO, no Fastify/`ws` types —
 * `server.ts` is the only caller.
 *
 * Wire contract: every request the client sends is `{jsonrpc:"2.0", id, method, params}` and gets
 * exactly one `{jsonrpc:"2.0", id, result}` or `{jsonrpc:"2.0", id, error:{code,message}}` reply.
 * Server-initiated pushes carry no `id`: `{jsonrpc:"2.0", method, params}`, where `method` is the
 * platform event's own `type` (`chat.message` / `chat.stream` / `chat.metadata` / `action.pending`
 * / `action.updated` / `task.updated`, packages/shared/src/events.ts) and `params` is that event
 * object verbatim (including its own `type` field — redundant with `method`, kept anyway so a
 * client can validate `params` alone against `PlatformEventSchema` without consulting `method`).
 */

export const JsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);
export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;

export const JsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: JsonRpcIdSchema,
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .strict();
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export interface JsonRpcSuccessResponse {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly result: unknown;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly error: { readonly code: number; readonly message: string };
}

export interface JsonRpcNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: unknown;
}

export function successResponse(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: '2.0', id, result };
}

export function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcErrorResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function notification(method: string, params?: unknown): JsonRpcNotification {
  return params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params };
}

/** Custom error codes, in the JSON-RPC-reserved `-32000..-32099` "server error" band, alongside
 *  the four standard codes this server also uses. */
export const WS_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  UNAUTHORIZED: -32001,
  FORBIDDEN: -32002,
  NOT_IMPLEMENTED: -32003,
  NOT_FOUND: -32004,
  /** §9.4 "进行中时 send_chat_message 被拒" — the WS-transport equivalent of the task brief's "HTTP
   *  409" (interfaces/http/capability-route.ts is out of this task's ownership, so only this
   *  transport gets a distinct code — see the PR body "假设与偏离" for the HTTP-side deviation). */
  TURN_ALREADY_RUNNING: -32010,
  /** governance/approval I6 ("ActionRequest 只沿转移表走") — a status the row is not currently in
   *  (e.g. approving an already-approved ActionRequest); mirrors HTTP 409 (S2.3). */
  ILLEGAL_TRANSITION: -32011,
  /** S2.7 I18 (docs/development-tasks.md S2.7) — mirrors HTTP 429. The WS wire shape has no room
   *  for a separate stable string code the way HTTP's `error.code` does (interfaces/http/
   *  capability-route.ts's `mapCapabilityError` carries `QuotaExceededError.code` — `depth_exceeded`
   *  / `concurrency_exceeded` / `daily_cost_exceeded` — verbatim there); over WS every quota
   *  violation shares this one numeric code, and the readable `message` (still `err.message`
   *  verbatim) is what an entry agent relays. */
  QUOTA_EXCEEDED: -32012,
  /** S2.7 — mirrors HTTP 403 `attenuation_denied` ("入口 Handle 请求含 execute 的子 Handle 被拒"). */
  ATTENUATION_DENIED: -32013,
} as const;

/** Maps an error thrown by `resolveCaller`/`dispatchCapability` (application/gateway) or by
 *  application/chat's service functions to a JSON-RPC error code + message. Mirrors
 *  interfaces/http/capability-route.ts's `mapCapabilityError` (same error classes, same
 *  "generic 401/500 message, never echo internals" discipline) with one addition:
 *  `TurnAlreadyRunningError`, which HTTP's fixed mapping (out of this task's ownership) cannot
 *  express and therefore falls through to a generic 500 there. */
export function mapDispatchError(err: unknown): { code: number; message: string } {
  if (err instanceof UnauthorizedError) {
    return { code: WS_ERROR_CODES.UNAUTHORIZED, message: 'unauthorized' };
  }
  if (err instanceof ForbiddenError) {
    return { code: WS_ERROR_CODES.FORBIDDEN, message: err.message };
  }
  if (err instanceof CapabilityNotFoundError) {
    return { code: WS_ERROR_CODES.METHOD_NOT_FOUND, message: err.message };
  }
  if (err instanceof InvalidCapabilityParamsError) {
    return { code: WS_ERROR_CODES.INVALID_PARAMS, message: err.message };
  }
  if (err instanceof CapabilityNotImplementedError) {
    return { code: WS_ERROR_CODES.NOT_IMPLEMENTED, message: err.message };
  }
  // S2.6: `assert_fact`'s handler runs the I16 guard, then throws this because the write half is
  // still unimplemented — same code as the registry-level "no handler" case (see
  // interfaces/http/capability-route.ts for why it is not a subclass).
  if (err instanceof AssertFactWriteNotImplementedError) {
    return { code: WS_ERROR_CODES.NOT_IMPLEMENTED, message: err.message };
  }
  if (err instanceof TurnAlreadyRunningError) {
    return { code: WS_ERROR_CODES.TURN_ALREADY_RUNNING, message: err.message };
  }
  if (err instanceof ChatNotFoundError) {
    return { code: WS_ERROR_CODES.NOT_FOUND, message: err.message };
  }
  // governance/approval + governance/policy domain errors (S2.2/S2.3) — same additions as
  // interfaces/http/capability-route.ts's mapCapabilityError, reusing FORBIDDEN/NOT_FOUND/
  // INVALID_PARAMS where an existing code already fits and only ILLEGAL_TRANSITION is new.
  if (err instanceof ApprovalScopeError) {
    return { code: WS_ERROR_CODES.FORBIDDEN, message: err.message };
  }
  if (
    err instanceof ActionRequestNotFoundError ||
    err instanceof GrantNotFoundError ||
    err instanceof GatekeeperNotFoundError ||
    err instanceof OperationNotFoundError
  ) {
    return { code: WS_ERROR_CODES.NOT_FOUND, message: err.message };
  }
  if (err instanceof IllegalTransition) {
    return { code: WS_ERROR_CODES.ILLEGAL_TRANSITION, message: err.message };
  }
  if (err instanceof HighBlastRadiusAutoApproveError || err instanceof SetPolicyValidationError) {
    return { code: WS_ERROR_CODES.INVALID_PARAMS, message: err.message };
  }
  // S2.7 (docs/development-tasks.md S2.7) — same set of application/task errors interfaces/http/
  // capability-route.ts's mapCapabilityError maps.
  if (err instanceof QuotaExceededError) {
    return { code: WS_ERROR_CODES.QUOTA_EXCEEDED, message: err.message };
  }
  if (err instanceof InvokeWorkerAttenuationError) {
    return { code: WS_ERROR_CODES.ATTENUATION_DENIED, message: err.message };
  }
  if (err instanceof InvokeWorkerValidationError || err instanceof InvalidQuotaValueError) {
    return { code: WS_ERROR_CODES.INVALID_PARAMS, message: err.message };
  }
  if (err instanceof UnknownQuotaKeyError) {
    return { code: WS_ERROR_CODES.INVALID_PARAMS, message: err.message };
  }
  if (err instanceof TaskNotFoundError) {
    return { code: WS_ERROR_CODES.NOT_FOUND, message: err.message };
  }
  return { code: WS_ERROR_CODES.INTERNAL_ERROR, message: 'internal error' };
}
