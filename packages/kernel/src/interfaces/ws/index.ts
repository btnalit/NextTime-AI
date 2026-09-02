/**
 * interfaces/ws: chat WebSocket protocol (§9.4) — JSON-RPC requests/responses plus
 * server-initiated pushes.
 *
 * Depends only on the application and governance layers' service interfaces — never reaches into
 * substrate directly (depcruise `kernel-interfaces-must-not-reach-into-substrate-directly`).
 * `packages/kernel/src/index.ts` is the composition root: it builds `WsRouteDeps` (the same `pg`
 * pool and optional Handle-key loader `interfaces/http` already uses) and calls
 * `registerWsRoute`.
 */

export { registerWsRoute } from './server.js';
export type { WsRouteDeps } from './server.js';

export {
  WS_ERROR_CODES,
  errorResponse,
  mapDispatchError,
  notification,
  successResponse,
} from './rpc.js';
export type {
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
} from './rpc.js';
