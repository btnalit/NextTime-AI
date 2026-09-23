/**
 * server: the resident-mode AND one-shot Task-mode HTTP API (docs/development-tasks.md S1.5a and
 * S2.8 task briefs) — Fastify, matching `@nexttime/kernel`'s own stack and giving the route tests
 * both briefs explicitly ask for (`Fastify inject`, no bound port). `POST /task/spawn` and every
 * `/resident/*` route require the internal-plane shared secret (`internal-auth.ts`, lane-6 review
 * P1-3): this service is `control`-network only (docker-compose.yml — no agent container can
 * reach it directly), but every other `control`-network service could previously call these
 * routes unauthenticated too, not just agent-host / the kernel's `task/service.ts` — "trusted
 * caller, no separate auth" was a convention, not something the listener enforced. `POST
 * /task/:workerRunId/terminate`, `GET /task/:workerRunId`, and `GET /healthz` stay unguarded, per
 * the same review's own scoping.
 *
 * Routes:
 *   POST /resident/spawn          {workspaceId, principalId, handle, kernelUrl?, llmUrl?,
 *                                   systemPrompt?, model?, image?}                [guarded]
 *                                  -> 200 {containerId, ip, status, created, restarts}
 *                                     | 403 (image not allowlisted)
 *   POST /resident/stop           {principalId} -> 204                           [guarded]
 *   GET  /resident/:principalId   -> 200 ResidentStatus | 404                    [guarded]
 *   POST /resident/:principalId/touch -> 204 | 404                               [guarded]
 *   GET  /residents               -> 200 {items: ResidentInventoryEntry[]}       [guarded]
 *   GET  /images                  -> 200 {defaultImage: string, images: RuntimeImageInfo[],
 *                                          allowedImages: string[]}
 *                                     | 502 {error:{code:"docker_upstream_error", message, status}}
 *                                     (images: platform-labelled only; defaultImage is this
 *                                     process's own config.workerImage — the kernel has no other
 *                                     way to learn it; allowedImages is config.taskImageAllowlist
 *                                     verbatim, P1-a hotfix — lets the kernel reject a
 *                                     set_active_runtime_image target that would 403 at spawn;
 *                                     502 (v0.16.2): the underlying Docker/proxy call — a separate
 *                                     `docker-socket-proxy-images` connection, config.ts's
 *                                     `dockerImagesConnection` — failed; `status` carries the real
 *                                     upstream HTTP status when known)
 *                                                                                 [guarded]
 *   POST /task/spawn              {taskId, workerRunId, workspaceId, onBehalfOf, capabilityHandle,
 *                                   image?, model?, systemPrompt?, skillsInline?,
 *                                   timeoutSec?}                                  [guarded]
 *                                  -> 200 {containerId, ip} | 400 | 403 (image not allowlisted)
 *   POST /task/:workerRunId/terminate -> 204 | 404
 *   GET  /task/:workerRunId       -> 200 TaskStatus | 404
 *   GET  /healthz                 -> 200 {status:"ok"}
 *
 * S7-E (P-C §6.5): `/resident/spawn`'s optional `image` is validated against the exact same
 * `isImageAllowed`/`config.taskImageAllowlist` `/task/spawn` already uses — one allowlist, one
 * security boundary, for both spawn APIs (design §6.6 "WORKER_IMAGE_ALLOWLIST 仍在 env，不进页面").
 * `/images` and `/residents` are read-only inventory for the kernel's `runtime_inventory`
 * capability — see `resident-service.ts`'s `listImages`/`list` for what each actually returns.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import {
  SpawnRequestSchema,
  StopRequestSchema,
  TaskSpawnRequestSchema,
  isImageAllowed,
} from './config.js';
import { IdClaimSchema, type SupervisorConfig } from './config.js';
import { dockerErrorStatusCode } from './docker-client.js';
import { requireInternalToken } from './internal-auth.js';
import type { ResidentService } from './resident-service.js';
import type { TaskService } from './task-service.js';

export interface CreateServerOptions {
  readonly residentService: ResidentService;
  /** Optional so existing resident-only callers (none left in this repo, but kept defensive)
   *  aren't forced to wire up Task mode — `/task/*` routes 501 without it. */
  readonly taskService?: TaskService;
  /** `POST /task/spawn`'s image-allowlist check (`config.taskImageAllowlist` / `isImageAllowed`)
   *  needs this alongside `taskService`. S7-E: `POST /resident/spawn`'s own optional `image` is
   *  checked against the same allowlist when this is present (see that route's own comment). */
  readonly config?: SupervisorConfig;
  /** The internal-plane shared secret (`internal-auth.ts` `loadInternalToken`'s output) —
   *  required on `POST /task/spawn` and every `/resident/*` route. `undefined` fails closed:
   *  every guarded request is rejected, matching the kernel's own guard's behavior when it starts
   *  without a configured token (see `internal-auth.ts`'s own doc comment). */
  readonly internalToken?: string;
  readonly logger?: boolean;
}

export function createServer(options: CreateServerOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const { residentService, taskService, config } = options;
  const requireInternal = { preHandler: requireInternalToken(options.internalToken) };

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.post('/resident/spawn', requireInternal, async (request, reply) => {
    const parsed = SpawnRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: { code: 'invalid_body', message: parsed.error.message } };
    }
    // S7-E (P-C §6.5 决定 E1): same allowlist and same 403 shape `/task/spawn` already enforces
    // below (`isImageAllowed`/`config.taskImageAllowlist`) — one security boundary for both spawn
    // APIs. `config` stays optional here (unlike `/task/spawn`'s hard 501 guard) for the same
    // "existing resident-only caller, none left in this repo, kept defensive" reason
    // `CreateServerOptions.config`'s own doc comment already gives: every real deployment passes
    // it, so the allowlist is enforced in practice; a caller that omits `config` entirely gets the
    // pre-S7-E behavior (no image override possible to allowlist in the first place, since
    // `image` then falls back to `undefined` and `residentService.spawn` resolves its own
    // `config.workerImage`).
    const image = parsed.data.image ?? config?.workerImage;
    if (config && image && !isImageAllowed(config, image)) {
      reply.code(403);
      return { error: { code: 'image_not_allowed', message: `image not allowlisted: ${image}` } };
    }
    try {
      const outcome = await residentService.spawn({ ...parsed.data, image });
      reply.code(200);
      return outcome;
    } catch (err) {
      request.log?.error?.(err, 'resident/spawn failed');
      reply.code(500);
      return { error: { code: 'internal_error', message: String(err) } };
    }
  });

  app.get('/residents', requireInternal, async (_request, reply) => {
    const items = await residentService.list();
    reply.code(200);
    return { items };
  });

  app.get('/images', requireInternal, async (request, reply) => {
    try {
      const { defaultImage, images, allowedImages } = await residentService.listImages();
      reply.code(200);
      return { defaultImage, images, allowedImages };
    } catch (err) {
      // v0.16.2 (fix/supervisor-images-proxy): a Docker/proxy-level failure here (e.g.
      // `docker-socket-proxy-images` unreachable, or 403ing an unexpected call) is an upstream
      // failure, not this service's own auth decision — passing e.g. Docker's raw 403 straight
      // through would read as *this* route rejecting the caller, when `requireInternal` above
      // already accepted them. Always 502, with the real upstream status (when known) in the body
      // — the kernel's own `TaskSupervisorError('http_error', ...)` (supervisor-client.ts) already
      // treats any non-200 the same way (`runtime_unreachable`), so this is a clarity/diagnostic
      // fix, not a behavior change for callers.
      request.log?.error?.(err, 'GET /images failed');
      const status = dockerErrorStatusCode(err);
      reply.code(502);
      return {
        error: {
          code: 'docker_upstream_error',
          message:
            status !== undefined
              ? `Docker image API request failed with upstream status ${status}`
              : `Docker image API request failed: ${err instanceof Error ? err.message : String(err)}`,
          status,
        },
      };
    }
  });

  app.post('/resident/stop', requireInternal, async (request, reply) => {
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

  app.get<{ Params: { principalId: string } }>(
    '/resident/:principalId',
    requireInternal,
    async (request, reply) => {
      if (!IdClaimSchema.safeParse(request.params.principalId).success) {
        reply.code(400);
        return { error: { code: 'invalid_principal_id', message: 'principalId must be a UUID' } };
      }
      const status = await residentService.status(request.params.principalId);
      if (!status) {
        reply.code(404);
        return {
          error: { code: 'not_found', message: 'no resident container for this principal' },
        };
      }
      reply.code(200);
      return status;
    },
  );

  app.post<{ Params: { principalId: string } }>(
    '/resident/:principalId/touch',
    requireInternal,
    async (request, reply) => {
      if (!IdClaimSchema.safeParse(request.params.principalId).success) {
        reply.code(400);
        return { error: { code: 'invalid_principal_id', message: 'principalId must be a UUID' } };
      }
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

  app.post('/task/spawn', requireInternal, async (request, reply) => {
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
