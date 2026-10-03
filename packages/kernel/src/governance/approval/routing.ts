import type { Role } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  listGrantHolderPrincipalIds,
  listWorkspaceOwnerPrincipalIds,
} from '../capability/index.js';
import { roleMayDecideActionRequests } from './reads.js';

/**
 * governance/approval/routing: computes the holders of one ActionRequest's `action_kind ×
 * resource_scope` (design doc §5.4 I14, §8.5 "写入业务系统的审批路由...按 I14 路由给持有该动作范围的
 * 人，不一定是发起对话的用户"; docs/development-tasks.md S2.3).
 *
 * The result feeds two things, both outside this task's scope to wire: the `ActionRequestPending`
 * outbox event's `holderPrincipalIds` field (packages/shared/src/events.ts, S2.3 addition — see
 * that field's own doc comment) so `chat`/`web` (S2.11/S2.10) can drop a system message into each
 * holder's Chat/queue; and `list_pending`/`get_action`'s own I14-scoped read (service.ts, this
 * task). `approval` never imports `chat` — enforced by .dependency-cruiser.cjs
 * `chat-and-host-bridge-must-not-import-approval-or-task` (the mirror-image rule for the other
 * direction is enforced simply by `chat` never importing this module).
 */

export interface HolderQuery {
  readonly actionKind: string;
  readonly resourceScope?: string | null | undefined;
}

/**
 * Every principal id that may approve an ActionRequest with this `action_kind`/`resource_scope`:
 * every active workspace owner (§5.8/I14 "workspace owner 视为持有一切范围") plus every principal
 * holding a matching active `capability_grants` row (`governance/capability`'s
 * `listGrantHolderPrincipalIds`), narrowed to the principals who could actually decide it (R-38,
 * maintainer decision D-13: holder = approver, one predicate) — not disabled (`disabled_at is
 * null`; a disabled principal cannot authenticate) and with a role that passes
 * `roleMayDecideActionRequests` (`reads.ts` — the same rule `approverHasScope` and
 * `application/gateway/authorize.ts` apply to `approve`; a `member` with a gatekeeper grant may
 * use the gate through a Worker but cannot approve on it). Those are the checks an `approve` call
 * itself passes — authentication, the registry `minRole`, then `decide.ts`'s I14 scope precheck —
 * so nobody receives an "Approval needed" push or system message, with the action kind and scope
 * it carries, for a request they could not decide. Deduplicated (an owner who also holds an
 * explicit grant for the same scope appears once) and in no particular order — callers that need
 * a stable order should sort the result themselves.
 */
export async function computeActionRequestHolders(
  client: PoolClient,
  workspaceId: string,
  query: HolderQuery,
): Promise<readonly string[]> {
  // S5.5 leftover 34: one client, one query at a time (pg@9 rejects concurrent queries on a client).
  const owners = await listWorkspaceOwnerPrincipalIds(client, workspaceId);
  const grantHolders = await listGrantHolderPrincipalIds(client, workspaceId, {
    resourceType: query.actionKind,
    resourceId: query.resourceScope,
  });
  const candidates = [...new Set([...owners, ...grantHolders])];
  if (candidates.length === 0) return [];
  const active = await client.query<{ id: string; role: Role }>(
    `select id, role from principals
     where workspace_id = $1 and id = any($2::uuid[]) and disabled_at is null`,
    [workspaceId, candidates],
  );
  return active.rows.filter((row) => roleMayDecideActionRequests(row.role)).map((row) => row.id);
}
