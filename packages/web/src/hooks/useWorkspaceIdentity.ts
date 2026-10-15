import { useEffect } from 'react';
import type { CapabilityCaller } from '../lib/clients.js';
import type { WorkspaceInfo } from '../lib/governance.js';
import { CALLER_ROLE_CHANGED_EVENT, type CallerRoleChange } from '../lib/http-client.js';
import { type WorkspaceRole, inferRole } from '../lib/role.js';
import { useCapability } from './useCapability.js';
import { usePermissions } from './usePermissions.js';

export interface WorkspaceIdentity {
  /** `get_workspace`'s `name` once loaded; the pre-S3.14 static label otherwise (not deployed
   *  yet, still loading, or the call failed) — the Sidebar never shows a blank line. */
  readonly workspaceName: string;
  readonly role: WorkspaceRole;
  /** S8 W4 (audit S15 "成员页不标你"): `get_workspace.caller.id` once loaded, `null` while
   *  loading/failed/not yet deployed — lets a page mark the row matching the signed-in caller
   *  without a second read. */
  readonly principalId: string | null;
  /** `get_workspace` has answered (or failed): `role` is as good as it will get this session. */
  readonly roleSettled: boolean;
}

const FALLBACK_NAME = 'Workspace console';

/**
 * hooks/useWorkspaceIdentity: the Sidebar's "workspace name + role badge" (S3.14 deliverable 2)
 * — `get_workspace` (S3.11, `minRole: 'member'`, open to everyone) for both the name and, as of
 * the S3.11 coordination addendum, the caller's own authoritative role (`caller.role`). The role
 * is `{kind:'known', role}` the moment that read is `ready`; `{kind:'inferred', role}` — the
 * pre-existing 403/200 best-effort bucket (`lib/role.ts` `inferRole`) — while it is loading, has
 * failed (including `not_found` on a kernel that predates the `caller` field), or has not been
 * attempted yet. The workspace name degrades to a static fallback label the same way it always
 * has; neither read blocks the shell on a capability that may not be deployed yet.
 */
export function useWorkspaceIdentity(http: CapabilityCaller): WorkspaceIdentity {
  const workspace = useCapability<WorkspaceInfo>(http, 'get_workspace');
  const permissions = usePermissions();
  // A later `get_workspace` read (any page's, or the request layer's own re-read) found the role
  // changed: take that answer as this one's, so the nav and every role-gated control follow it
  // without a reload or a workspace switch (#541 review M2). No request of its own.
  const { mutate, reload } = workspace;
  const ready = workspace.state.status === 'ready';
  useEffect(() => {
    const onChange = (event: Event) => {
      const change = (event as CustomEvent<CallerRoleChange>).detail;
      if (change.client !== http) return;
      if (ready) mutate(() => change.workspace as WorkspaceInfo);
      else void reload();
    };
    window.addEventListener(CALLER_ROLE_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(CALLER_ROLE_CHANGED_EVENT, onChange);
  }, [http, mutate, reload, ready]);
  const workspaceName =
    workspace.state.status === 'ready' ? workspace.state.data.name : FALLBACK_NAME;
  const role: WorkspaceRole =
    workspace.state.status === 'ready'
      ? { kind: 'known', role: workspace.state.data.caller.role }
      : { kind: 'inferred', role: inferRole(permissions) };
  const principalId = workspace.state.status === 'ready' ? workspace.state.data.caller.id : null;
  return {
    workspaceName,
    role,
    principalId,
    roleSettled: workspace.state.status !== 'loading',
  };
}
