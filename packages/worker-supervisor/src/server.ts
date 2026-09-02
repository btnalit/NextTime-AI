/**
 * server: the resident-mode HTTP API (docs/development-tasks.md S1.5a task brief) — Fastify,
 * matching `@nexttime/kernel`'s own stack and giving the route tests this task's brief explicitly
 * asks for (`Fastify inject`, no bound port). `control`-network only (docker-compose.yml: no
 * published host port) — every route here is trusted-caller (agent-host, later; `curl` from
 * inside the compose network for now), same trust boundary kernel's own internal routes document.
 *
 * Routes:
 *   POST /resident/spawn          {workspaceId, principalId, handle, kernelUrl?, llmUrl?}
 *                                  -> 200 {containerId, ip, status, created, restarts}
 *   POST /resident/stop           {principalId} -> 204
 *   GET  /resident/:principalId   -> 200 ResidentStatus | 404
 *   POST /resident/:principalId/touch -> 204 | 404
 *   GET  /healthz                 -> 200 {status:"ok"}
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { SpawnRequestSchema, StopRequestSchema } from './config.js';
import type { ResidentService } from './resident-service.js';

export interface CreateServerOptions {
  readonly residentService: ResidentService;
  readonly logger?: boolean;
}

export function createServer(options: CreateServerOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const { residentService } = options;

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.post('/resident/spawn', async (request, reply) => {
    const parsed = SpawnRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: { code: 'invalid_body', message: parsed.error.message } };
    }
    try {
      const outcome = await residentService.spawn(parsed.data);
      reply.code(200);
      return outcome;
    } catch (err) {
      request.log?.error?.(err, 'resident/spawn failed');
      reply.code(500);
      return { error: { code: 'internal_error', message: String(err) } };
    }
  });

  app.post('/resident/stop', async (request, reply) => {
    const parsed = StopRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: { code: 'invalid_body', message: parsed.error.message } };
    }
    try {
      await residentService.stop(parsed.data.principalId);
      reply.code(204);
      return null;
    } catch (err) {
      request.log?.error?.(err, 'resident/stop failed');
      reply.code(500);
      return { error: { code: 'internal_error', message: String(err) } };
    }
  });

  app.get<{ Params: { principalId: string } }>('/resident/:principalId', async (request, reply) => {
    const status = await residentService.status(request.params.principalId);
    if (!status) {
      reply.code(404);
      return { error: { code: 'not_found', message: 'no resident container for this principal' } };
    }
    reply.code(200);
    return status;
  });

  app.post<{ Params: { principalId: string } }>(
    '/resident/:principalId/touch',
    async (request, reply) => {
      const touched = await residentService.touch(request.params.principalId);
      if (!touched) {
        reply.code(404);
        return {
          error: { code: 'not_found', message: 'no resident container for this principal' },
        };
      }
      reply.code(204);
      return null;
    },
  );

  return app;
}
