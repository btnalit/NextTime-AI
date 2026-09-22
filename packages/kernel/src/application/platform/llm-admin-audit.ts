import { withPlatform } from '../../adapters/db/platform-context.js';
import type { PoolLike } from '../../adapters/db/pool.js';
import { writeAudit } from '../../substrate/audit/index.js';

/**
 * application/platform/llm-admin-audit: the platform audit row for an llm-proxy provider mutation
 * (S6-B, docs/console-completion-plan.md §5.4 / §6; S7-A, docs/STATUS.md 维护者决定 2026-09-22 ①
 * for `provider_secret_set`/`provider_secret_cleared`). The proxy reports each administrator
 * action to `POST /internal/llm-admin-audit` (interfaces/http/internal/llm-admin-audit.ts); that
 * route is an interface and must not reach into `substrate/audit` itself (.dependency-cruiser.cjs
 * `kernel-interfaces-must-not-reach-into-substrate-directly`), so the write lives here, on the
 * application layer, the same way every other interface reaches audit through a service.
 */

export interface LlmAdminAuditEventInput {
  readonly action:
    | 'provider_created'
    | 'provider_updated'
    | 'provider_deleted'
    | 'provider_tested'
    | 'provider_secret_set'
    | 'provider_secret_cleared';
  readonly providerId: string;
  readonly actorUserId: string;
  readonly tokenJti: string;
  readonly details: Record<string, unknown>;
}

export async function recordLlmAdminAudit(
  pool: PoolLike,
  event: LlmAdminAuditEventInput,
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
