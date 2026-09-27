import { AsyncLocalStorage } from 'node:async_hooks';
import { isValidCorrelationId } from '@nexttime/shared';

/**
 * substrate/correlation: the kernel's per-call correlation context (docs/STATUS.md leftover 87;
 * `@nexttime/shared`'s `correlation.ts` has the wire rule and the id's origin).
 *
 * One `AsyncLocalStorage` holding the id of the call currently being served, so the places that
 * need it deep inside a capability — every `writeAudit` row (substrate/audit), the gate client and
 * the supervisor client (adapters) — read it without threading a parameter through ~100 handler
 * signatures. Set in exactly three places, all at the edge of one inbound call: the HTTP
 * `preHandler` hook in `createServer` (index.ts — every `/api/cap/*`, `/mcp`, explorer and
 * `/internal/*` request, id = Fastify's `request.id`, itself the validated inbound
 * `x-correlation-id` or a minted one), and the WS frame dispatch (interfaces/ws/server.ts — one id
 * per frame, since a WebSocket's frames all share one upgrade request). Background work (outbox
 * dispatch, the task reaper, invariant checks) runs outside any context and reads `undefined`.
 *
 * Lives in `substrate/` — the lowest kernel layer — because `writeAudit` needs it and substrate may
 * depend only on the domain layer; `application/gateway/index.ts` re-exports it for `interfaces/`
 * (which may not import substrate directly), and adapters import it here.
 */

const storage = new AsyncLocalStorage<string>();

/** Runs `fn` with `id` as the current correlation id (an invalid id runs `fn` with none — the
 *  callers always pass an already-validated id; this is only a guard). */
export function runWithCorrelationId<T>(id: string, fn: () => T): T {
  if (!isValidCorrelationId(id)) return storage.exit(fn);
  return storage.run(id, fn);
}

/** The id of the call currently being served, or `undefined` outside any call. */
export function currentCorrelationId(): string | undefined {
  return storage.getStore();
}
