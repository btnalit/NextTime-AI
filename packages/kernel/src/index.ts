import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { createPool } from './adapters/db/pool.js';
import type { CapabilityRouteDeps } from './interfaces/http/index.js';
import { registerCapabilityRoutes } from './interfaces/http/index.js';

/**
 * Builds the kernel's Fastify instance. This is the composition root (design doc §7.1, §7.10):
 * it is the one place allowed to import across every layer (substrate/governance/application/
 * adapters/interfaces) — `createPool()` (adapters) is built here and injected into
 * `interfaces/http` as `CapabilityRouteDeps`, so `interfaces/http` itself never imports adapters
 * or substrate directly.
 */
export function createServer(
  deps: KernelServerDeps,
  options: CreateServerOptions = {},
): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.get('/api/health', async () => ({ status: 'ok' }));

  registerCapabilityRoutes(app, deps);

  return app;
}

export interface KernelServerDeps extends CapabilityRouteDeps {}

export interface CreateServerOptions {
  /** Fastify's own `logger` option — the structured per-call log (§12) is written regardless of
   *  this setting (interfaces/http/capability-route.ts uses `request.log`, a no-op sink when
   *  `logger` is `false`); this only controls Fastify's own request/response access log. */
  logger?: boolean;
}

export function main(): void {
  const pool = createPool();
  const app = createServer({ pool }, { logger: true });
  const port = Number(process.env.KERNEL_PORT ?? 8080);
  const host = process.env.KERNEL_BIND_ADDR ?? '0.0.0.0';

  app.listen({ port, host }).catch((err: unknown) => {
    app.log.error(err);
    process.exitCode = 1;
  });
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main();
}
