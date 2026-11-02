import {
  ADMIN_AGENT_TARGETS_MAX,
  type AdminAgentTargetsResultWire,
  type AdminAgentTrialWorkspaceWire,
  type PlatformWorkspaceWire,
} from '@nexttime/shared';
import { useEffect, useMemo, useState } from 'react';
import { invalidateCapability, useCapabilityList } from '../../../hooks/useCapability.js';
import { adminAgentTargetsErrorOverrides } from '../../../lib/admin-agent.js';
import type { CapabilityCaller } from '../../../lib/clients.js';
import { useT } from '../../../lib/i18n.js';
import { Button } from '../../kit/button.js';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../kit/dialog.js';
import { ErrorBanner } from '../../kit/error-banner.js';
import { InlineError } from '../../kit/inline-error.js';
import { Notice } from '../../kit/notice.js';
import { SkeletonRows } from '../../kit/skeleton.js';
import { StatusChip } from '../../kit/status-chip.js';
import { sharedTargetsText } from './text.js';

export interface AdminAgentTargetsDialogProps {
  readonly http: CapabilityCaller;
  /** The trial workspace whose targets are chosen; `null` keeps the dialog closed. */
  readonly workspace: AdminAgentTrialWorkspaceWire | null;
  readonly onClose: () => void;
  /** The targets were saved (`get_admin_agent_status` is already invalidated). */
  readonly onSaved: (result: AdminAgentTargetsResultWire) => void;
}

/** A row the reader may tick: every active standard workspace, and every target chosen before that
 *  the list does not hold — kept ticked, so unticking it is how it is removed. Whether it is disabled
 *  is read from the target itself (`AdminAgentTargetWire.status`, #501 on #943), not inferred from
 *  its absence from the list. */
interface Candidate {
  readonly workspaceId: string;
  readonly name: string;
  readonly disabled: boolean;
}

/**
 * components/platform/admin-agent/AdminAgentTargetsDialog: 选择目标工作区 (S11 AA4c-3; the AA4c
 * plan D1). The workspaces the reader's admin agent may make an admin proposal to from one trial
 * workspace, chosen from the platform's active standard workspaces (`list_workspaces`; a trial or
 * ephemeral workspace is never one), at most `ADMIN_AGENT_TARGETS_MAX`, saved as the whole list
 * (`set_admin_agent_targets`). The dialog says that the choice is shared by all of the reader's
 * admin agent chats in that trial workspace, and what adding and removing one does.
 */
export function AdminAgentTargetsDialog({
  http,
  workspace,
  onClose,
  onSaved,
}: AdminAgentTargetsDialogProps) {
  const t = useT();
  const open = workspace !== null;
  const workspaces = useCapabilityList<PlatformWorkspaceWire>(
    http,
    'list_workspaces',
    { status: 'active', purpose: 'standard' },
    { autoLoadAll: true, enabled: open },
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // A fresh choice, from what is saved now, every time the dialog opens.
  const workspaceId = workspace?.workspaceId ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the dialog opens on a trial workspace
  useEffect(() => {
    if (workspace === null) return;
    setSelected(new Set(workspace.targets.map((target) => target.workspaceId)));
    setSearch('');
    setError(null);
  }, [workspaceId]);

  const saved = useMemo(
    () => new Set(workspace?.targets.map((target) => target.workspaceId) ?? []),
    [workspace],
  );
  const candidates = useMemo<readonly Candidate[]>(() => {
    const listed =
      workspaces.state.status === 'ready'
        ? workspaces.state.data.items.map((row) => ({
            workspaceId: row.id,
            name: row.name,
            disabled: false,
          }))
        : [];
    const listedIds = new Set(listed.map((row) => row.workspaceId));
    const kept = (workspace?.targets ?? [])
      .filter((target) => !listedIds.has(target.workspaceId))
      .map((target) => ({
        workspaceId: target.workspaceId,
        name: target.name,
        disabled: target.status === 'disabled',
      }));
    return [...kept, ...listed];
  }, [workspaces.state, workspace]);

  const query = search.trim().toLowerCase();
  const shown =
    query === '' ? candidates : candidates.filter((row) => row.name.toLowerCase().includes(query));
  const names = new Map(candidates.map((row) => [row.workspaceId, row.name]));
  const added = [...selected].filter((id) => !saved.has(id));
  const removed = [...saved].filter((id) => !selected.has(id));
  const changed = added.length > 0 || removed.length > 0;
  const full = selected.size >= ADMIN_AGENT_TARGETS_MAX;

  function toggle(id: string, on: boolean): void {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function save(): Promise<void> {
    if (workspace === null || !changed) return;
    setBusy(true);
    setError(null);
    try {
      const result = await http.call<AdminAgentTargetsResultWire>('set_admin_agent_targets', {
        trialWorkspaceId: workspace.workspaceId,
        targetWorkspaceIds: [...selected],
      });
      invalidateCapability(http, 'get_admin_agent_status');
      onSaved(result);
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const nameOf = (id: string) => names.get(id) ?? id;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="max-w-lg" data-testid="admin-agent-targets-dialog">
        <DialogHeader>
          <DialogTitle>{t('选择目标工作区', 'Choose target workspaces')}</DialogTitle>
          <DialogDescription>
            {t(
              `管理员智能体在「${workspace?.name ?? ''}」里试好改动后，可以向这些工作区提出管理员提案；每个工作区的部分由那里的所有者决定是否应用。`,
              `Once the admin agent has tried a change out in “${workspace?.name ?? ''}”, it may make an admin proposal to these workspaces; each workspace’s part is for its owner to apply or not.`,
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="stack">
          <Notice testId="admin-agent-targets-shared">{sharedTargetsText(t)}</Notice>
          {workspaces.state.status === 'loading' ? (
            <SkeletonRows count={3} label={t('正在读取工作区…', 'Loading workspaces')} />
          ) : workspaces.state.status === 'error' ? (
            <ErrorBanner
              error={workspaces.state.error}
              title={t('读不到平台上的工作区', 'Could not read the platform’s workspaces')}
              onRetry={() => void workspaces.reload()}
            />
          ) : candidates.length === 0 ? (
            <p className="text-3" data-testid="admin-agent-targets-none">
              {t(
                '平台上还没有可以选的常规工作区（试验和临时工作区不能当目标）。',
                'The platform has no regular workspace to choose yet (trial and ephemeral workspaces cannot be targets).',
              )}
            </p>
          ) : (
            <>
              {candidates.length > 8 ? (
                <input
                  type="search"
                  className="input"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t('按名称筛选…', 'Filter by name…')}
                  aria-label={t('按名称筛选工作区', 'Filter workspaces by name')}
                  data-testid="admin-agent-targets-search"
                />
              ) : null}
              <fieldset className="stack-s" data-testid="admin-agent-targets-options">
                <legend className="text-3">
                  {t(
                    `已选 ${selected.size} 个，最多 ${ADMIN_AGENT_TARGETS_MAX} 个`,
                    `${selected.size} chosen, at most ${ADMIN_AGENT_TARGETS_MAX}`,
                  )}
                </legend>
                {shown.map((row) => {
                  const checked = selected.has(row.workspaceId);
                  return (
                    <label
                      key={row.workspaceId}
                      className="checkbox"
                      data-testid="admin-agent-target-option"
                      data-workspace-id={row.workspaceId}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        // A disabled workspace can only be taken off, never added back here.
                        disabled={busy || (!checked && (full || row.disabled))}
                        onChange={(event) => toggle(row.workspaceId, event.target.checked)}
                      />
                      <span className="row-wrap">
                        <span>{row.name}</span>
                        {row.disabled ? (
                          <>
                            <StatusChip machine="workspaceStatus" status="disabled" size="s" />
                            <span className="text-3">
                              {t('向它提议会被拒绝', 'proposing to it is refused')}
                            </span>
                          </>
                        ) : null}
                      </span>
                    </label>
                  );
                })}
                {shown.length === 0 ? (
                  <p className="text-3">{t('没有匹配的工作区。', 'No workspace matches.')}</p>
                ) : null}
              </fieldset>
            </>
          )}
          <InlineError
            error={error}
            overrides={adminAgentTargetsErrorOverrides(t)}
            testId="admin-agent-targets-error"
          />
        </div>
        <DialogFooter>
          {changed ? (
            <div
              className="stack-s text-3 basis-full"
              data-testid="admin-agent-targets-diff"
              // UX P3-2 on #943: in the pinned footer, so what Save does is in view beside it.
              aria-live="polite"
            >
              {added.length > 0 ? (
                <p>
                  {t('加上：', 'Adding: ')}
                  {added.map(nameOf).join(t('、', ', '))}
                </p>
              ) : null}
              {removed.length > 0 ? (
                <p>
                  {t('去掉：', 'Removing: ')}
                  {removed.map(nameOf).join(t('、', ', '))}
                  {removed.length === 1
                    ? t(
                        '。之前向它提的工作区部分暂时不能应用。',
                        '. The workspace part proposed to it before cannot be applied until it is added back.',
                      )
                    : t(
                        '。之前向它们提的工作区部分暂时不能应用。',
                        '. The workspace parts proposed to them before cannot be applied until they are added back.',
                      )}
                </p>
              ) : null}
            </div>
          ) : null}
          <Button
            variant="primary"
            size="s"
            disabled={busy || !changed}
            title={
              !changed && !busy
                ? t(
                    '还没有改动：勾选或去掉工作区后再保存',
                    'Nothing changed yet: tick or untick a workspace first',
                  )
                : undefined
            }
            aria-busy={busy || undefined}
            onClick={() => void save()}
            data-testid="admin-agent-targets-save"
          >
            {t('保存目标', 'Save targets')}
          </Button>
          <DialogClose asChild>
            <Button variant="ghost" size="s" disabled={busy}>
              {t('取消', 'Cancel')}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
