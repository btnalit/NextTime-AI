import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withPlatform } from '../../../adapters/db/platform-context.js';
import type { PoolLike } from '../../../adapters/db/pool.js';
import { writeAudit } from '../../../substrate/audit/index.js';

/**
 * interfaces/http/internal/llm-admin-audit: `POST /internal/llm-admin-audit` (S6-B, docs/console-
 * completion-plan.md §6 "llm-proxy 自己的审计日志 + 内核平台审计一行（不含密钥）"; §8). The model
 * proxy posts one event here after every provider mutation it performs on an administrator's
 * behalf (its admin-api.ts: create / update / delete / test), and this route turns it into one
 * platform audit row — `platform.llm_provider_created` / `_updated` / `_deleted` / `_tested` —
 * next to every other administrator action `platform_audit_query` shows. That is the design line
 * "隔离与审计只增不减" for a write that, by design, never passes through a kernel capability.
 *
 * Correlation: `actorUserId` and `tokenJti` are the `sub` / `jti` of the llm-admin token the proxy
 * verified (`@nexttime/shared` llm-admin-token.ts); the `jti` is the same one
 * `application/gateway/llm-admin-handlers.ts` audited as `platform.llm_admin_token_issued`, so
 * every provider row links back to the console session that minted the token. The row is written
 * as the actor (`withPlatform({userId})`), which also means an actor that no longer exists (a
 * purged user) fails the `audit_records.actor_user_id` foreign key → 400 `unknown_actor` — a
 * fabricated actor is never recorded.
 *
 * Trust boundary: behind `interfaces/internal-auth`'s shared-secret guard like every `/internal/*`
 * route — only the proxy (holding the internal-plane token) can reach this; a browser cannot
 * write its own audit rows here. `details` is a bounded, schema-checked object and never carries
 * a key: the proxy has no key to send (the secret-write path is a 501 stub) and this schema has
 * no field for one.
 */

const DetailsSchema = z
  .record(z.string().max(64), z.unknown())
  .refine((value) => JSON.stringify(value).length <= 4096, 'details too large');

export const LlmAdminAuditEventSchema = z
  .object({
    action: z.enum(['provider_created', 'provider_updated', 'provider_deleted', 'provider_tested']),
    providerId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    actorUserId: z.string().uuid(),
    tokenJti: z.string().uuid(),
    details: DetailsSchema,
  })
  .strict();
export type LlmAdminAuditEvent = z.infer<typeof LlmAdminAuditEventSchema>;

export interface LlmAdminAuditRoutesDeps {
  readonly pool: PoolLike;
  /** Injectable for tests. Defaults to writing the platform audit row via `withPlatform`. */
  readonly writeLlmAdminAudit?: (event: LlmAdminAuditEvent) => Promise<{ auditId: string }>;
}

async function defaultWriteLlmAdminAudit(
  pool: PoolLike,
  event: LlmAdminAuditEvent,
): Promise<{ auditId: string }> {
  return withPlatform(pool, { userId: event.actorUserId }, async (client) => {
    // `audit_records.resource_id` is a uuid column and a provider id is a slug — same choice
    // `application/gateway/dispatch.ts`'s `auditResourceRef` makes for every non-uuid resource:
    // `resource_id = null`, the reference lives in the payload (`resourceRef`), and
    // `platform_audit_query {resourceType: 'llm_provider'}` still finds the row.
    const row = await writeAudit(client, {
      workspaceId: null,
      actorPrincipalId: null,
      actorUserId: event.actorUserId,
      action: `platform.llm_${event.action}`,
      resourceType: 'llm_provider',
      payload: {
        channel: 'platform',
        via: 'llm_admin_token',
        tokenJti: event.tokenJti,
        resourceRef: event.providerId,
        providerId: event.providerId,
        ...event.details,
      },
    });
    return { auditId: row.id };
  });
}

function isForeignKeyViolation(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === '23503';
}

export async function registerLlmAdminAuditRoutes(
  app: FastifyInstance,
  deps: LlmAdminAuditRoutesDeps,
): Promise<void> {
  const write =
    deps.writeLlmAdminAudit ??
    ((event: LlmAdminAuditEvent) => defaultWriteLlmAdminAudit(deps.pool, event));

  app.post('/internal/llm-admin-audit', async (request, reply) => {
    const parsed = LlmAdminAuditEventSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: { code: 'invalid_body', message: parsed.error.message } };
    }
    try {
      const { auditId } = await write(parsed.data);
      return { ok: true, result: { auditId } };
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        reply.code(400);
        return {
          ok: false,
          error: { code: 'unknown_actor', message: 'actorUserId does not name an existing user' },
        };
      }
      app.log?.error?.(err, 'llm-admin-audit: failed to write the platform audit row');
      reply.code(500);
      return { ok: false, error: { code: 'internal_error', message: 'failed to record audit' } };
    }
  });
}
