import type { PlatformWorkspaceWire } from '@nexttime/shared';
import { useCapabilityList } from '../../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../../lib/clients.js';
import { shortId } from '../../../lib/format.js';
import { useT } from '../../../lib/i18n.js';
import { StatusChip } from '../../kit/status-chip.js';

/** A workspace by what the platform plane shows of it. */
export interface WorkspaceRef {
  readonly name: string;
  readonly purpose: PlatformWorkspaceWire['purpose'];
  readonly disabled: boolean;
}
export type WorkspaceRefs = ReadonlyMap<string, WorkspaceRef>;

/** Every workspace the platform plane lists, by id — the names a workspace part, a dependent of
 *  the platform part and a rollback's `enabledIn` are shown by. */
export function useWorkspaceRefs(http: CapabilityCaller): WorkspaceRefs {
  const workspaces = useCapabilityList<PlatformWorkspaceWire>(
    http,
    'list_workspaces',
    {},
    { autoLoadAll: true },
  );
  return new Map(
    workspaces.state.status === 'ready'
      ? workspaces.state.data.items.map((workspace) => [
          workspace.id,
          {
            name: workspace.name,
            purpose: workspace.purpose,
            disabled: workspace.status === 'disabled',
          },
        ])
      : [],
  );
}

/** A workspace's name, marked 试验 for a trial workspace (#924) and 已停用 when disabled; a short id
 *  when the platform no longer lists it (purged). */
export function WorkspaceName({
  workspaceId,
  refs,
  testId,
}: {
  readonly workspaceId: string;
  readonly refs: WorkspaceRefs;
  readonly testId?: string;
}) {
  const t = useT();
  const ref = refs.get(workspaceId);
  if (ref === undefined) {
    return (
      <span className="text-3" data-testid={testId}>
        <span className="mono">{shortId(workspaceId)}</span>
        {t(
          '（平台上找不到这个工作区，可能已清除）',
          ' (not on the platform any more, perhaps purged)',
        )}
      </span>
    );
  }
  return (
    <span className="row-wrap" data-testid={testId}>
      <span className="wrap-anywhere">{ref.name}</span>
      {ref.purpose === 'admin_trial' ? (
        <StatusChip machine="workspacePurpose" status="admin_trial" size="s" />
      ) : null}
      {ref.disabled ? <span className="text-3">{t('（已停用）', ' (disabled)')}</span> : null}
    </span>
  );
}
