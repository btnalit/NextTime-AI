import { type CapabilityScope, type Role, getCapability } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { entryScope, roleMayUseCapability } from '../../governance/capability/index.js';
import { type ExecuteAccess, narrowScopeToExecutableGates } from '../gates/execute-access.js';

/**
 * application/task/acting-authority: what the person a Task acts for may hold **now**, for the
 * Worker starts that do not come from a live caller — a goal step's attempt (`step-attempt.ts`,
 * I-G7) and a crash retry (`lifecycle.ts`'s `spawnWorkerRunForRetry`, legacy 289).
 */

/** Whether the principal, their platform user or their workspace is disabled — the predicate
 *  `application/gateway/handle-auth.ts` applies to every Handle acting for them (a missing row is
 *  disabled). A Worker minted for a disabled principal could not authenticate to the kernel, but
 *  llm-proxy honours revoked `jti`s only, so its fresh Handle would still reach the model. */
export async function principalDisabled(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<boolean> {
  const result = await client.query<{ disabled: boolean }>(
    `select (p.disabled_at is not null
             or coalesce(u.status = 'disabled', false)
             or w.status = 'disabled') as disabled
       from principals p
       join workspaces w on w.id = p.workspace_id
       left join users u on u.id = p.user_id
      where p.workspace_id = $1 and p.id = $2`,
    [workspaceId, principalId],
  );
  return result.rows[0]?.disabled ?? true;
}

/** Whether `role` starts Workers: `invoke_worker` is in the entry scope that role is issued
 *  (`entryScope`, the role rule every Handle issuer applies). An auditor's is not. */
export function roleStartsWorkers(role: Role): boolean {
  return entryScope({}, { role }).capabilities.includes('invoke_worker');
}

/** Legacy 289: a crash retry not started — its person can no longer start a Worker. */
export class RetryAuthorityLostError extends Error {
  constructor(detail: string) {
    super(`crash retry not started: ${detail}`);
    this.name = 'RetryAuthorityLostError';
  }
}

/**
 * Legacy 289: the scope a crash retry's Handle attenuates from — the failed run's own scope as its
 * person may hold it now. Until this, the retry was minted from the failed run's scope as it was:
 * execution was already re-checked at call time (R-37 / D-20), but a capability the person's role
 * lost and a gate they can no longer act on stayed in the retry's Handle and its tool list, and a
 * disabled person's retry was minted a fresh Handle that llm-proxy accepted.
 *
 *   - **Capabilities**: only those the person's role may use now (`roleMayUseCapability`, the
 *     rule `entryScope` and every Handle issuer apply). A role that no longer starts Workers at
 *     all — gone, or an auditor now — refuses the retry (`RetryAuthorityLostError`).
 *   - **Gates**: only those the person may act on now (`narrowScopeToExecutableGates`, the R-37 /
 *     D-20 predicate `request_action` and `list_allowed_operations` apply to every call).
 *
 * Narrowing only: nothing the failed run did not hold is added. With nothing changed since the
 * failed run started, the result is that run's scope (its capabilities passed the same role rule
 * when its parent was issued, its gates the same gate rule). A disabled person is checked by the
 * caller first ({@link principalDisabled}), in the same transaction as `access` was read.
 */
export function retryScopeNow(failed: CapabilityScope, access: ExecuteAccess): CapabilityScope {
  const role = access.role;
  if (role === undefined) {
    throw new RetryAuthorityLostError('the principal the Task acts for no longer exists');
  }
  if (!roleStartsWorkers(role)) {
    throw new RetryAuthorityLostError(`the role "${role}" no longer starts Workers`);
  }
  const capabilities = failed.capabilities.filter((name) =>
    roleMayUseCapability(role, getCapability(name)),
  );
  return narrowScopeToExecutableGates({ capabilities, resources: failed.resources }, access);
}
