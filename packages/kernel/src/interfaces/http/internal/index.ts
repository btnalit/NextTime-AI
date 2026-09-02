import type { FastifyInstance } from 'fastify';
import { type EgressRoutesDeps, registerEgressRoutes } from './egress.js';
import {
  type HandleRevocationsRoutesDeps,
  registerHandleRevocationRoutes,
} from './handle-revocations.js';
import { type LlmUsageRoutesDeps, registerLlmUsageRoutes } from './llm-usage.js';

/**
 * interfaces/http/internal: kernel-internal routes reachable only from the `control` compose
 * network (design doc §11: the kernel publishes no host port; internal-only, service-to-service
 * traffic reaches it there — see llm-usage.ts's own doc comment for the S1 no-extra-auth
 * assumption this implies). Self-contained: `packages/kernel/src/index.ts` and every other
 * `interfaces/http/**` file belong to the parallel S1.3 dispatch, not this one
 * (docs/development-tasks.md S1.7 ownership) — `registerInternalRoutes` is exported here for that
 * dispatch (or the main session) to call from wherever it builds the Fastify instance, without
 * this file touching that wiring itself.
 *
 *   - `POST /internal/llm-usage` (S1.7; llm-usage.ts)
 *   - `GET /internal/handle-revocations` (S1.7; handle-revocations.ts)
 *   - `POST /internal/egress` (S1.10 kernel gap; egress.ts)
 */

export interface InternalRoutesDeps
  extends LlmUsageRoutesDeps,
    HandleRevocationsRoutesDeps,
    EgressRoutesDeps {}

export async function registerInternalRoutes(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
): Promise<void> {
  await registerLlmUsageRoutes(app, deps);
  await registerHandleRevocationRoutes(app, deps);
  await registerEgressRoutes(app, deps);
}

export type { LlmUsageRoutesDeps } from './llm-usage.js';
export type { HandleRevocationsRoutesDeps, RevokedHandleRow } from './handle-revocations.js';
export type { EgressRoutesDeps } from './egress.js';
