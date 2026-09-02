import type { FastifyInstance } from 'fastify';
import type { CapabilityRouteDeps } from './capability-route.js';
import { handleCapabilityRoute } from './capability-route.js';

/**
 * interfaces/http: Fastify HTTP route registration; capability HTTP projection (§9.3).
 *
 * Depends only on the application and governance layers' service interfaces — never reaches into
 * substrate directly (depcruise `kernel-interfaces-must-not-reach-into-substrate-directly`).
 * `packages/kernel/src/index.ts` is the composition root: it builds `CapabilityRouteDeps` (the
 * `pg` pool, an optional injected Handle-key loader) and calls `registerCapabilityRoutes`.
 *
 * `packages/kernel/src/interfaces/http/internal/**` (S1.7's `POST /internal/llm-usage`) is a
 * separate route tree owned by a different task — not touched here.
 */

export type { CapabilityRouteDeps } from './capability-route.js';

/** Registers `POST /api/cap/:name` on `app`. `GET /api/health` stays in index.ts's `createServer`. */
export function registerCapabilityRoutes(app: FastifyInstance, deps: CapabilityRouteDeps): void {
  app.post('/api/cap/:name', async (request, reply) => handleCapabilityRoute(request, reply, deps));
}
