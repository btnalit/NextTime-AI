import type { UserWire } from '@nexttime/shared';

export interface WorkspaceOption {
  readonly id: string;
  readonly name: string;
}

/**
 * lib/platform-workspaces: the workspace picker's option list for the users page (P-A1) —
 * the union of every `memberships[].{workspaceId, workspaceName}` across the loaded users, plus
 * the platform default workspace when it is not already among them.
 *
 * There is deliberately no `list_workspaces` call here. P-A2 added that capability (and
 * `PlatformWorkspacesPage` reads it), but the users page's own pickers still derive their options
 * from the loaded directory: swapping them onto `list_workspaces` is a behaviour change to a
 * shipped, tested page rather than part of P-A2's deliverable. Every picker built on this list
 * therefore still also accepts a typed workspace id — a brand-new workspace nobody is a member of
 * yet is reachable that way.
 */
export function deriveWorkspaceOptions(
  users: readonly UserWire[],
  defaultWorkspaceId: string | null,
): readonly WorkspaceOption[] {
  const byId = new Map<string, string>();
  for (const user of users) {
    for (const membership of user.memberships) {
      if (!byId.has(membership.workspaceId))
        byId.set(membership.workspaceId, membership.workspaceName);
    }
  }
  if (defaultWorkspaceId !== null && !byId.has(defaultWorkspaceId)) {
    byId.set(defaultWorkspaceId, defaultWorkspaceId);
  }
  return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}
