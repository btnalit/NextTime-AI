import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Builds the kernel's Fastify instance. This is deliberately minimal for R1 (repo skeleton) —
 * the six-layer module tree under src/{substrate,governance,application,adapters,interfaces}
 * is wired in starting with R4/S1; see design doc §7.1 and §7.10.
 */
export function createServer(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/api/health', async () => ({ status: 'ok' }));

  return app;
}

export function main(): void {
  const app = createServer();
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
