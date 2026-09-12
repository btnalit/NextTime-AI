import type { PlatformWorkspaceWire } from '@nexttime/shared';
import { useState } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import type { WireMembership } from '../../lib/auth-api.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import type { ModelRow } from '../../lib/governance.js';
import { Button } from '../ui/Button.js';
import { Drawer } from '../ui/Drawer.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { PageHeader } from '../ui/PageHeader.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { CreateWorkspaceForm } from './CreateWorkspaceForm.js';
import { WorkspaceDetailPanel } from './WorkspaceDetailPanel.js';

export interface PlatformWorkspacesPageProps {
  readonly http: CapabilityCaller;
  /** The signed-in administrator's own workspace memberships — the only workspaces whose own
   *  (`scope:'workspace'`) configuration pages they can actually open. */
  readonly memberships: readonly WireMembership[];
  /** Switch the session to `workspaceId` and land on its 成员与授权 page. */
  readonly onOpenWorkspaceConfig: (workspaceId: string) => void;
}

/**
 * Exactly one panel is open at a time. `workspace` carries only the row's **id** — the
 * `PlatformWorkspaceWire` is re-derived from the live list on every render, so every mutation that
 * answers with a fresh row is reflected in the open drawer without a second copy going stale
 * behind it (the shape `PlatformUsersPage` established).
 */
type Panel =
  | { readonly kind: 'closed' }
  | { readonly kind: 'create' }
  | { readonly kind: 'workspace'; readonly workspaceId: string };

/**
 * components/platform/PlatformWorkspacesPage: 工作区 Workspaces (`/platform/workspaces`,
 * docs/platform-admin-design.md §2 "工作区配置归管理面", §5 "工作区配置" row) — the platform's list
 * of workspaces and everything P-A2 added to it: `list_workspaces`, `create_workspace`,
 * `update_workspace`, `set_workspace_status`, `set_allowed_models`, plus owner delegation through
 * `add_membership` / `set_membership_role`. Reachable only for `platformRole === 'admin'` (gated in
 * `App.tsx`'s `Routed`); every capability here is `scope: 'platform'` and ignores the workspace
 * header, so a platform-only session (an admin with zero memberships) configures workspaces it has
 * no data access to — which is the point of the design's "管理权与数据权是两层".
 *
 * `list_platform_models` is the llm-proxy catalog as the platform plane reads it: an administrator
 * configuring a workspace they are not a member of cannot use the workspace-scoped `list_models`.
 * The per-workspace configuration pages themselves (成员与授权, 访问, 能力目录 …) are unchanged
 * `scope:'workspace'` pages — reaching them still means *being* in the workspace, so the drawer
 * offers the switch only when the administrator is already a member (P-A2 deliberately does not
 * implement acting in a workspace without a membership).
 */
export function PlatformWorkspacesPage({
  http,
  memberships,
  onOpenWorkspaceConfig,
}: PlatformWorkspacesPageProps) {
  const [panel, setPanel] = useState<Panel>({ kind: 'closed' });

  const workspaces = useCapabilityList<PlatformWorkspaceWire>(http, 'list_workspaces');
  const models = useCapabilityList<ModelRow>(http, 'list_platform_models');

  const rows = workspaces.state.status === 'ready' ? workspaces.state.data.items : [];
  const catalog = models.state.status === 'ready' ? models.state.data.items : [];

  const openWorkspace =
    panel.kind === 'workspace' ? rows.find((row) => row.id === panel.workspaceId) : undefined;
  const memberOf = new Set(memberships.map((membership) => membership.workspaceId));

  function replaceWorkspace(updated: PlatformWorkspaceWire): void {
    workspaces.mutate((data) => ({
      ...data,
      items: data.items.map((row) => (row.id === updated.id ? updated : row)),
    }));
  }

  /** The new row is written into the loaded page before the re-read so the drawer this opens has
   *  a subject for the whole round trip (`reload()` keeps the cached page on screen). */
  function handleCreated(created: PlatformWorkspaceWire): void {
    workspaces.mutate((data) => ({ ...data, items: [...data.items, created] }));
    setPanel({ kind: 'workspace', workspaceId: created.id });
    void workspaces.reload();
  }

  return (
    <div className="page" data-testid="platform-workspaces-page">
      <PageHeader
        title="工作区 Workspaces"
        description="Each workspace is one shared graph: who it is for, which models its agents may use, and who configures it."
        actions={
          <Button
            variant="primary"
            icon="plus"
            onClick={() => setPanel({ kind: 'create' })}
            data-testid="new-workspace"
          >
            新建工作区 Create workspace
          </Button>
        }
      />

      {models.state.status === 'error' ? (
        <ErrorBanner
          error={models.state.error}
          title="Could not load the model catalog"
          onRetry={() => void models.reload()}
          testId="platform-models-error"
        />
      ) : null}

      {workspaces.state.status === 'loading' ? (
        <SkeletonRows count={4} label="Loading workspaces" testId="platform-workspaces-loading" />
      ) : workspaces.state.status === 'error' ? (
        <ErrorBanner
          error={workspaces.state.error}
          title="Could not load the workspace list"
          onRetry={() => void workspaces.reload()}
          testId="platform-workspaces-error"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="grid"
          title="还没有工作区 No workspaces yet"
          testId="platform-workspaces-empty"
        />
      ) : (
        <div className="table-scroll">
          <table className="data-table" data-testid="platform-workspaces-table">
            <thead>
              <tr>
                <th>名称 Name</th>
                <th>状态 Status</th>
                <th>入口模型 Entry model</th>
                <th>允许的模型 Allowed models</th>
                <th>成员数 Members</th>
                <th>Owners</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <WorkspaceRow
                  key={row.id}
                  workspace={row}
                  onOpen={() => setPanel({ kind: 'workspace', workspaceId: row.id })}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Drawer
        open={panel.kind === 'create'}
        onClose={() => setPanel({ kind: 'closed' })}
        title="新建工作区 Create workspace"
        subtitle="A second shared graph, with its first owner."
        testId="create-workspace-drawer"
      >
        {panel.kind === 'create' ? (
          <CreateWorkspaceForm
            http={http}
            models={catalog}
            onCreated={handleCreated}
            onCancel={() => setPanel({ kind: 'closed' })}
          />
        ) : null}
      </Drawer>

      <Drawer
        open={panel.kind === 'workspace' && openWorkspace !== undefined}
        onClose={() => setPanel({ kind: 'closed' })}
        title={openWorkspace?.name ?? '工作区 Workspace'}
        subtitle={openWorkspace ? <span className="mono">{openWorkspace.id}</span> : undefined}
        testId="workspace-drawer"
      >
        {panel.kind === 'workspace' && openWorkspace ? (
          <WorkspaceDetailPanel
            key={openWorkspace.id}
            http={http}
            workspace={openWorkspace}
            models={catalog}
            modelsReady={models.state.status === 'ready'}
            onChanged={replaceWorkspace}
            onDelegated={() => void workspaces.reload()}
            onOpenWorkspaceConfig={
              memberOf.has(openWorkspace.id)
                ? () => onOpenWorkspaceConfig(openWorkspace.id)
                : undefined
            }
          />
        ) : null}
      </Drawer>
    </div>
  );
}

/** The whole row opens the drawer on click; the 配置 Configure button in the last cell is the
 *  keyboard path, and the row's own Enter/Space handler covers it while focus is anywhere inside
 *  the row. `onOpen` is idempotent (it sets the panel to the same value), so the button's click
 *  bubbling up to the row costs nothing. */
function WorkspaceRow({
  workspace,
  onOpen,
}: {
  readonly workspace: PlatformWorkspaceWire;
  readonly onOpen: () => void;
}) {
  return (
    <tr
      className="row-clickable"
      data-testid={`workspace-row-${workspace.id}`}
      data-workspace-id={workspace.id}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <td>
        <span className="truncate">{workspace.name}</span>
      </td>
      <td>
        <span
          className={`chip chip-s ${workspace.status === 'disabled' ? 'chip-neutral' : 'chip-ok'}`}
          data-testid="workspace-status"
        >
          {workspace.status}
        </span>
        {workspace.isDefault ? (
          <span className="tag" data-testid="workspace-default-badge">
            默认 Default
          </span>
        ) : null}
      </td>
      <td className="mono">
        {workspace.entryModel ?? <span className="text-3">平台默认 Platform default</span>}
      </td>
      <td>
        {workspace.allowedModels.length === 0 ? (
          <span className="text-3">全部 All</span>
        ) : (
          `${workspace.allowedModels.length} 个`
        )}
      </td>
      <td className="mono">{workspace.memberCount}</td>
      <td>
        <div className="row-wrap">
          {workspace.owners.length === 0 ? (
            <span className="text-3">—</span>
          ) : (
            workspace.owners.map((owner) => (
              <span
                key={owner.userId}
                className="chip chip-s chip-info"
                title={owner.displayName}
                data-testid="workspace-owner-chip"
              >
                {owner.login}
              </span>
            ))
          )}
        </div>
      </td>
      <td>
        <Button variant="ghost" size="s" onClick={onOpen}>
          配置 Configure
        </Button>
      </td>
    </tr>
  );
}
