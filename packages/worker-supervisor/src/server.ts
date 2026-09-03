/**
 * server: the resident-mode AND one-shot Task-mode HTTP API (docs/development-tasks.md S1.5a and
 * S2.8 task briefs) — Fastify, matching `@nexttime/kernel`'s own stack and giving the route tests
 * both briefs explicitly ask for (`Fastify inject`, no bound port). `control`-network only
 * (docker-compose.yml: no published host port) — every route here, resident or Task, is
 * trusted-caller (agent-host / the kernel's `task/service.ts`, later; `curl` from inside the
 * compose network for now), same trust boundary kernel's own internal routes document — Task-mode
 * routes deliberately add no separate auth layer on top of that (S2.8 task brief: "same auth model
 * as resident endpoints").
 *
 * Routes:
 *   POST /resident/spawn          {workspaceId, principalId, handle, kernelUrl?, llmUrl?}
 *                                  -> 200 {containerId, ip, status, created, restarts}
 *   POST /resident/stop           {principalId} -> 204
 *   GET  /resident/:principalId   -> 200 ResidentStatus | 404
 *   POST /resident/:principalId/touch -> 204 | 404
 *   POST /task/spawn              {taskId, workerRunId, workspaceId, onBehalfOf, capabilityHandle,
 *                                   image?, model?, skills?, timeoutSec?}
 *                                  -> 200 {containerId, ip} | 400 | 403 (image not allowlisted)
 *   POST /task/:workerRunId/terminate -> 204 | 404
 *   GET  /task/:workerRunId       -> 200 TaskStatus | 404
 *   GET  /healthz                 -> 200 {status:"ok"}
 */

import Fastify, { type FastifyInstance } from 'fastify';
import {
  SpawnRequestSchema,
  StopRequestSchema,
  TaskSpawnRequestSchema,
  isImageAllowed,
} from './config.js';
import type { SupervisorConfig } from './config.js';
import type { ResidentService } from './resident-service.js';
import type { TaskService } from './task-service.js';

export interface CreateServerOptions {
  readonly residentService: ResidentService;
  /** Optional so existing resident-only callers (none left in this repo, but kept defensive)
   *  aren't forced to wire up Task mode — `/task/*` routes 501 without it. */
  readonly taskService?: TaskService;
  /** Only needed alongside `taskService`, for `POST /task/spawn`'s image-allowlist check
   *  (`config.taskImageAllowlist` / `isImageAllowed`). */
  readonly config?: SupervisorConfig;
  readonly logger?: boolean;
}

export function createServer(options: CreateServerOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const { residentService, taskService, config } = options;

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

  app.post('/task/spawn', async (request, reply) => {
    if (!taskService || !config) {
      reply.code(501);
      return { error: { code: 'not_implemented', message: 'Task mode is not wired up' } };
    }
    const parsed = TaskSpawnRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: { code: 'invalid_body', message: parsed.error.message } };
    }
    const image = parsed.data.image ?? config.workerImage;
    if (!isImageAllowed(config, image)) {
      reply.code(403);
      return { error: { code: 'image_not_allowed', message: `image not allowlisted: ${image}` } };
    }
    try {
      const outcome = await taskService.spawn({ ...parsed.data, image });
      reply.code(200);
      return outcome;
    } catch (err) {
      request.log?.error?.(err, 'task/spawn failed');
      reply.code(500);
      return { error: { code: 'internal_error', message: String(err) } };
    }
  });

  app.post<{ Params: { workerRunId: string } }>(
    '/task/:workerRunId/terminate',
    async (request, reply) => {
      if (!taskService) {
        reply.code(501);
        return { error: { code: 'not_implemented', message: 'Task mode is not wired up' } };
      }
      try {
        const terminated = await taskService.terminate(request.params.workerRunId);
        if (!terminated) {
          reply.code(404);
          return {
            error: { code: 'not_found', message: 'no Task container for this workerRunId' },
          };
        }
        reply.code(204);
        return null;
      } catch (err) {
        request.log?.error?.(err, 'task/terminate failed');
        reply.code(500);
        return { error: { code: 'internal_error', message: String(err) } };
      }
    },
  );

  app.get<{ Params: { workerRunId: string } }>('/task/:workerRunId', async (request, reply) => {
    if (!taskService) {
      reply.code(501);
      return { error: { code: 'not_implemented', message: 'Task mode is not wired up' } };
    }
    const status = await taskService.status(request.params.workerRunId);
    if (!status) {
      reply.code(404);
      return { error: { code: 'not_found', message: 'no Task container for this workerRunId' } };
    }
    reply.code(200);
    return status;
  });

  return app;
}
