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
 * There is deliberately no `list_workspaces` call here: that capability lands in **P-A2** with
 * workspace creation / disabling and owner delegation (docs/development-tasks.md "### P-A2"), so
 * until then the only workspaces the platform plane can name are the ones it can already see
 * through the user directory. Every picker built on this list therefore also accepts a typed
 * workspace id — a brand-new workspace nobody is a member of yet is reachable that way, and this
 * whole module collapses into one `list_workspaces` read when P-A2 ships.
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
