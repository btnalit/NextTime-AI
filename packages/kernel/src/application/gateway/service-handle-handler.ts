import { type Role, getCapability } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { issueHandle, roleSatisfiesMinRole } from '../../governance/capability/index.js';
import { getConfiguredTaskRuntime } from '../task/index.js';
import type { CapabilityHandler } from './capability-handler.js';
import {
  PrincipalNotFoundError,
  PrincipalOperationRefusedError,
  isInternalPrincipalDisplayName,
} from './members-handlers.js';

/**
 * application/gateway/service-handle-handler: `issue_service_handle` (P-B1; docs/platform-admin-
 * design.md §6.3 "外部运行时 … 签发仍在工作区'访问'页（service Principal + Handle，替代
 * `issue-service-handle` CLI）"). The CLI's `issueServiceHandleFromCli` step for step — a `service`
 * session for the named Principal, then `issueHandle` with the requested capability list — on the
 * workspace plane, owner only (registry `minRole`). `issueHandle`'s own `assertValidScope` refuses
 * any `channel:'human'` capability, so a service Handle can never carry a member-management or
 * platform capability whatever the page asks for. The token is returned once and never stored.
 * Review 2026-10-02 R-36: the platform's internal service Principals are refused, and the
 * requested capabilities are narrowed by the service Principal's role, like every other issuer's.
 */

const DEFAULT_SERVICE_HANDLE_TTL_SECONDS = 365 * 24 * 60 * 60;

export class ServicePrincipalRequiredError extends Error {
  constructor(principalId: string) {
    super(`issue_service_handle: principal ${principalId} is not an active service Principal`);
    this.name = 'ServicePrincipalRequiredError';
  }
}

/**
 * The target must be an active `service` Principal the workspace manages. Review 2026-10-02 R-36
 * (the kernel half of leftover 88, whose fix was UI-only): never one of the platform's internal
 * service Principals (`__gatekeeper_service__`, `__draft_reaper__`, …) — a Handle on
 * `__gatekeeper_service__` with `assert_fact` would write Facts indistinguishable from a gate's own
 * observations — refused like every other workspace-side operation on them (`platform_managed`,
 * members-handlers.ts). Returns the Principal's role for the scope narrowing below.
 */
async function requireServicePrincipal(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<Role> {
  const result = await client.query<{
    kind: string;
    role: Role;
    display_name: string | null;
    disabled_at: Date | null;
  }>(
    'select kind, role, display_name, disabled_at from principals where workspace_id = $1 and id = $2',
    [workspaceId, principalId],
  );
  const row = result.rows[0];
  if (!row) throw new PrincipalNotFoundError(workspaceId, principalId);
  if (row.kind !== 'service' || row.disabled_at !== null) {
    throw new ServicePrincipalRequiredError(principalId);
  }
  if (isInternalPrincipalDisplayName(row.display_name)) {
    throw new PrincipalOperationRefusedError(
      'platform_managed',
      `issue_service_handle: principal ${principalId} is managed by the platform, not from a workspace`,
    );
  }
  return row.role;
}

export const issueServiceHandleHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { privateKey } = getConfiguredTaskRuntime();
  const input = params as { principalId: string; scope: string[]; ttlSeconds?: number };
  const role = await requireServicePrincipal(client, workspaceId, input.principalId);
  // R-36: the third Handle issuer applies the same role narrowing as the other two (W5.5,
  // `entryScope({ role })` / issue-handle-handler.ts): a capability whose registry `minRole` the
  // service Principal's role does not satisfy is dropped — a member-role key never receives
  // builder-only `propose_*`. Dropped silently, as `issue_handle` drops what exceeds its ceiling;
  // the returned `scope` is what the Handle carries.
  const capabilities = [...new Set(input.scope)].filter((name) =>
    roleSatisfiesMinRole(role, getCapability(name)?.minRole),
  );

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
    scope: { capabilities, resources: {} },
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
