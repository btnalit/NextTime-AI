import type { CapabilityCaller } from '../lib/clients.js';
import type { WorkspaceInfo } from '../lib/governance.js';
import { type WorkspaceRole, inferRole } from '../lib/role.js';
import { useCapability } from './useCapability.js';
import { usePermissions } from './usePermissions.js';

export interface WorkspaceIdentity {
  /** `get_workspace`'s `name` once loaded; the pre-S3.14 static label otherwise (not deployed
   *  yet, still loading, or the call failed) — the Sidebar never shows a blank line. */
  readonly workspaceName: string;
  readonly role: WorkspaceRole;
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
  const workspaceName =
    workspace.state.status === 'ready' ? workspace.state.data.name : FALLBACK_NAME;
  const role: WorkspaceRole =
    workspace.state.status === 'ready'
      ? { kind: 'known', role: workspace.state.data.caller.role }
      : { kind: 'inferred', role: inferRole(permissions) };
  return { workspaceName, role };
}
