import type { FastifyInstance } from 'fastify';

/**
 * interfaces/http/internal/metrics: `GET /internal/metrics` (S3.8, docs/development-tasks.md
 * "不变量监控与混沌" deliverable 1: "Fastify route `/internal/metrics` in Prometheus text format
 * ... reuse `registerInternalRoutes`; the internal plane is token-gated already").
 *
 * Trust boundary: same as every other `/internal/*` route (llm-usage.ts's doc comment has the
 * full history) — sits behind `interfaces/internal-auth`'s shared-secret guard, installed once at
 * the composition root on the `/internal/` prefix. This file performs no authentication itself.
 *
 * **Deliberately substrate-agnostic** (dependency-cruiser's `kernel-interfaces-must-not-reach-
 * into-substrate-directly` rule: `interfaces/**` may not import `substrate/**`, even a type-only
 * import — the invariant-check results this route actually serves live in `substrate/audit`).
 * `deps.renderMetrics` is a plain `() => string` closure the composition root
 * (`packages/kernel/src/index.ts`, the one place allowed to import across every layer) builds
 * over its own scheduler state and `substrate/audit`'s `renderInvariantMetricsPrometheus` — this
 * route knows nothing about invariants, checks, or counters, only "produce today's metrics text".
 * A future second metrics source (a different subsystem's own counters) composes into the same
 * closure at the call site, not by this file growing subsystem-specific knowledge.
 */

export interface MetricsRoutesDeps {
  /** Returns the full response body for `GET /internal/metrics` — Prometheus text-format
   *  exposition, newline-terminated. Called fresh on every request (the underlying counters are
   *  cheap in-memory reads, not a live DB query — see the composition root's own wiring).
   *
   *  Optional, like every other injectable dependency in this directory (`EgressRoutesDeps.
   *  recordEgressObservations`, `LlmUsageRoutesDeps.recordUsage`) — every existing caller of
   *  `createServer`/`registerInternalRoutes` across this codebase predates this route and supplies
   *  no `renderMetrics`; defaulting to {@link DEFAULT_RENDER_METRICS} keeps every one of them
   *  compiling and passing unchanged, with the route itself still live and correctly content-typed
   *  (just reporting nothing scheduled yet) rather than 404. `main()` (`packages/kernel/src/
   *  index.ts`) always supplies the real one in production. */
  readonly renderMetrics?: () => string;
}

const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** What an unwired `GET /internal/metrics` reports — valid, empty Prometheus text (no series),
 *  not an error. A deployment or test that never wires `renderMetrics` (nothing schedules
 *  invariant checks) is a legitimate configuration, not a broken one. */
function defaultRenderMetrics(): string {
  return '# nexttime kernel /internal/metrics — no metrics source wired\n';
}

export async function registerMetricsRoute(
  app: FastifyInstance,
  deps: MetricsRoutesDeps,
): Promise<void> {
  const renderMetrics = deps.renderMetrics ?? defaultRenderMetrics;
  app.get('/internal/metrics', async (_request, reply) => {
    reply.header('content-type', PROMETHEUS_CONTENT_TYPE);
    return renderMetrics();
  });
}
