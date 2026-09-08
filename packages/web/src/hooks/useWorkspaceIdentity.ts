import type { CapabilityCaller } from '../lib/clients.js';
import type { WorkspaceInfo } from '../lib/governance.js';
import { type InferredRole, inferRole } from '../lib/role.js';
import { useCapability } from './useCapability.js';
import { usePermissions } from './usePermissions.js';

export interface WorkspaceIdentity {
  /** `get_workspace`'s `name` once loaded; the pre-S3.14 static label otherwise (not deployed
   *  yet, still loading, or the call failed) — the Sidebar never shows a blank line. */
  readonly workspaceName: string;
  readonly role: InferredRole;
}

const FALLBACK_NAME = 'Workspace console';

/** hooks/useWorkspaceIdentity: the Sidebar's "workspace name + role badge" (S3.14 deliverable 2)
 *  — `get_workspace` (S3.11, `minRole: 'member'`, open to everyone) for the name, `lib/role.ts`'s
 *  best-effort inference for the badge. Both degrade to their pre-S3.14 defaults (a static label,
 *  no badge) rather than blocking the shell on a capability that may not be deployed yet. */
export function useWorkspaceIdentity(http: CapabilityCaller): WorkspaceIdentity {
  const workspace = useCapability<WorkspaceInfo>(http, 'get_workspace');
  const permissions = usePermissions();
  const workspaceName =
    workspace.state.status === 'ready' ? workspace.state.data.name : FALLBACK_NAME;
  return { workspaceName, role: inferRole(permissions) };
}
