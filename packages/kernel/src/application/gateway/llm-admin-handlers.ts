import { randomUUID } from 'node:crypto';
import type { LlmAdminTokenWire } from '@nexttime/shared';
import { mintLlmAdminToken } from '@nexttime/shared';
import { writeAudit } from '../../substrate/audit/index.js';
import { getConfiguredTaskRuntime } from '../task/runtime.js';
import type { CapabilityHandler } from './capability-handler.js';

/**
 * application/gateway/llm-admin-handlers: `issue_llm_admin_token` (S6-B, docs/console-
 * completion-plan.md §5.4 / §6; docs/platform-admin-design.md §6.2 "鉴权用内核签发的 5 分钟平台
 * JWT"). The kernel's entire share of provider management: it signs a short-lived capability
 * token with the Handle key (`@nexttime/shared`'s `mintLlmAdminToken` — distinct `typ` / `aud`,
 * never accepted as a Handle) and audits the issuance. The provider records, the test calls and
 * the `models.json` rewrite all happen in the model proxy, which the browser reaches directly
 * through the reverse proxy's `/api/llm-admin/*` route with this token — the kernel never sees a
 * provider key, holds none, and stores none (design line "agent / kernel 进程不持凭证").
 *
 * Same shape as `platform-gates-handlers.ts`'s `issueGateHostTokenHandler` (P-B2a 决定 ⑩), the
 * first token of this kind. Two audit rows result from one call: dispatch.ts's own
 * `issue_llm_admin_token` row (every platform capability gets one) and, written here inside the
 * same platform transaction, `platform.llm_admin_token_issued` carrying the token's `jti` and
 * expiry — the correlation key the model proxy's audit lines and its per-mutation
 * `POST /internal/llm-admin-audit` rows (interfaces/http/internal/llm-admin-audit.ts) carry back,
 * so `platform_audit_query` can tie every provider change to the administrator session that
 * minted the token. The token itself is never audited (it is a bearer credential for five
 * minutes); the `jti` is.
 */

/** Same-origin path the browser calls (deploy/caddy/Caddyfile `handle_path /api/llm-admin/*`). */
export const LLM_ADMIN_URL = '/api/llm-admin';

export const issueLlmAdminTokenHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  _params,
  ctx,
) => {
  const subject = ctx?.platformUser?.id;
  if (!subject) throw new Error('issue_llm_admin_token invoked outside a platform transaction');
  const { privateKey } = getConfiguredTaskRuntime();
  const jti = randomUUID();
  const minted = await mintLlmAdminToken({ privateKey, subject, jti });
  await writeAudit(client, {
    workspaceId: null,
    actorPrincipalId: null,
    actorUserId: subject,
    action: 'platform.llm_admin_token_issued',
    resourceType: 'llm_admin_token',
    resourceId: jti,
    payload: {
      channel: 'platform',
      actorLogin: ctx?.platformUser?.login,
      jti,
      expiresAt: minted.expiresAt.toISOString(),
      url: LLM_ADMIN_URL,
    },
  });
  const result: LlmAdminTokenWire = {
    token: minted.token,
    url: LLM_ADMIN_URL,
    jti,
    expiresAt: minted.expiresAt.toISOString(),
  };
  return { result, resourceType: 'llm_admin_token', resourceId: jti };
};
