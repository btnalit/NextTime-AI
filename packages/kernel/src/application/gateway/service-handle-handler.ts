import type { PoolClient } from 'pg';
import { issueHandle } from '../../governance/capability/index.js';
import { getConfiguredTaskRuntime } from '../task/index.js';
import type { CapabilityHandler } from './capability-handler.js';
import { PrincipalNotFoundError } from './members-handlers.js';

/**
 * application/gateway/service-handle-handler: `issue_service_handle` (P-B1; docs/platform-admin-
 * design.md §6.3 "外部运行时 … 签发仍在工作区'访问'页（service Principal + Handle，替代
 * `issue-service-handle` CLI）"). The CLI's `issueServiceHandleFromCli` step for step — a `service`
 * session for the named Principal, then `issueHandle` with the requested capability list — on the
 * workspace plane, owner only (registry `minRole`). `issueHandle`'s own `assertValidScope` refuses
 * any `channel:'human'` capability, so a service Handle can never carry a member-management or
 * platform capability whatever the page asks for. The token is returned once and never stored.
 */

const DEFAULT_SERVICE_HANDLE_TTL_SECONDS = 365 * 24 * 60 * 60;

export class ServicePrincipalRequiredError extends Error {
  constructor(principalId: string) {
    super(`issue_service_handle: principal ${principalId} is not an active service Principal`);
    this.name = 'ServicePrincipalRequiredError';
  }
}

async function requireServicePrincipal(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<void> {
  const result = await client.query<{ kind: string; disabled_at: Date | null }>(
    'select kind, disabled_at from principals where workspace_id = $1 and id = $2',
    [workspaceId, principalId],
  );
  const row = result.rows[0];
  if (!row) throw new PrincipalNotFoundError(workspaceId, principalId);
  if (row.kind !== 'service' || row.disabled_at !== null) {
    throw new ServicePrincipalRequiredError(principalId);
  }
}

export const issueServiceHandleHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { privateKey } = getConfiguredTaskRuntime();
  const input = params as { principalId: string; scope: string[]; ttlSeconds?: number };
  await requireServicePrincipal(client, workspaceId, input.principalId);

  const sessionResult = await client.query<{ id: string }>(
    `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
     values ($1, $2, 'service', $2, 'active')
     returning id`,
    [workspaceId, input.principalId],
  );
  const sessionId = sessionResult.rows[0]?.id;
  if (!sessionId)
    throw new Error('issue_service_handle: session INSERT ... RETURNING produced no row');

  const issued = await issueHandle(client, {
    sessionId,
    scope: { capabilities: [...new Set(input.scope)], resources: {} },
    ttlSeconds: input.ttlSeconds ?? DEFAULT_SERVICE_HANDLE_TTL_SECONDS,
    privateKey,
  });
  return {
    result: {
      handle: issued.token,
      principalId: input.principalId,
      sessionId: issued.sessionId,
      expiresAt: issued.expiresAt.toISOString(),
      scope: issued.scope,
    },
    resourceType: 'session',
    resourceId: sessionId,
  };
};
