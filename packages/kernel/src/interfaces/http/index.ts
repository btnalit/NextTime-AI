import type { FastifyInstance } from 'fastify';
import type { ExplorerRouteDeps } from '../explorer-contract/index.js';
import { registerExplorerRoutes } from '../explorer-contract/index.js';
import type { AuthRouteDeps } from './auth-routes.js';
import { registerAuthRoutes } from './auth-routes.js';
import type { CapabilityRouteDeps } from './capability-route.js';
import { handleCapabilityRoute } from './capability-route.js';

/**
 * interfaces/http: Fastify HTTP route registration; capability HTTP projection (§9.3); the
 * Explorer contract (§9.5, S3.5).
 *
 * Depends only on the application and governance layers' service interfaces — never reaches into
 * substrate directly (depcruise `kernel-interfaces-must-not-reach-into-substrate-directly`).
 * `packages/kernel/src/index.ts` is the composition root: it builds `CapabilityRouteDeps`/
 * `ExplorerRouteDeps` (the `pg` pool, an optional injected Handle-key loader) and calls
 * `registerCapabilityRoutes`/`registerExplorerRoutes`.
 *
 * `packages/kernel/src/interfaces/http/internal/**` (S1.7's `POST /internal/llm-usage`) is a
 * separate route tree owned by a different task — not touched here.
 */

export type { CapabilityRouteDeps } from './capability-route.js';
export type { AuthRouteDeps } from './auth-routes.js';
export type { ExplorerRouteDeps } from '../explorer-contract/index.js';

/** Registers `POST /api/cap/:name` on `app`. `GET /api/health` stays in index.ts's `createServer`. */
export function registerCapabilityRoutes(app: FastifyInstance, deps: CapabilityRouteDeps): void {
  app.post('/api/cap/:name', async (request, reply) => handleCapabilityRoute(request, reply, deps));
}

/** Registers the nine Explorer endpoints (`interfaces/explorer-contract`'s own module doc
 *  comment) on `app`. Same `deps` shape as `registerCapabilityRoutes` (both only need `pool` and
 *  an optional Handle-key loader) — kept as a distinct type alias (`ExplorerRouteDeps`) rather
 *  than reusing `CapabilityRouteDeps` so the two route trees' dependency contracts can diverge
 *  independently later without one accidentally constraining the other. */
export function registerExplorerHttpRoutes(app: FastifyInstance, deps: ExplorerRouteDeps): void {
  registerExplorerRoutes(app, deps);
}

/** S4.1: `/api/auth/*` + `/api/platform/setup*` (console login, first-run setup) — see
 *  auth-routes.ts's own module doc comment. Same `deps` shape as the capability routes. */
export function registerAuthHttpRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  registerAuthRoutes(app, deps);
}
