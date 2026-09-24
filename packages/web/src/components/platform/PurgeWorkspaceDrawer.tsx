import type { PlatformWorkspaceWire, PurgeWorkspaceResultWire } from '@nexttime/shared';
import { useEffect, useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { platformErrorMessage } from '../../lib/platform-errors.js';
import { PURGE_WORKSPACE_REASON_LABELS, purgeCountLabel } from '../../lib/platform-workspaces.js';
import { Confirm } from '../kit/confirm.js';
import { Button } from '../ui/Button.js';
import { Drawer } from '../ui/Drawer.js';
import { Notice } from '../ui/Notice.js';
import { RefChip } from '../ui/RefChip.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { StatusChip } from '../ui/StatusChip.js';
import { PlatformError } from './PlatformError.js';

export interface PurgeWorkspaceDrawerProps {
  readonly http: CapabilityCaller;
  readonly workspace: PlatformWorkspaceWire;
  /** Cancel, Escape, overlay click — before anything was deleted. */
  readonly onClose: () => void;
  /** `purge_workspace{confirm: true}` answered `executed: true` — the row is gone. */
  readonly onPurged: (result: PurgeWorkspaceResultWire) => void;
}

type Preview =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: unknown }
  | { readonly status: 'ready'; readonly result: PurgeWorkspaceResultWire };

/** The kernel's 409 / 404 with the console's bilingual copy as its message, so `kit/confirm`'s
 *  own inline error banner (message + code) reads the same as `PlatformError` does on the
 *  preview step. Anything unmapped is rethrown as it came. */
function friendly(err: unknown): unknown {
  const mapped = platformErrorMessage(err);
  if (mapped === null || !(err instanceof HttpError)) return err;
  return new HttpError(err.kind, mapped, err.code);
}

/**
 * components/platform/PurgeWorkspaceDrawer (S6-A A1, docs/console-completion-plan.md §4
 * "Workspace 生命周期", §5.2 `purge_workspace`, §5.9 principle 4 "不可逆"): the two-step purge.
 *
 * Step 1 is the **preview** — `purge_workspace{workspaceId}` without `confirm` is the kernel's
 * dry run (counts per table, live Handles, the users that would go with it, and the
 * `service_handle_in_use` warnings of §4 edge (a)). It is read with a plain `http.call` on mount,
 * never through `useCapability`: a cached preview re-shown on the next open would report counts
 * the kernel no longer agrees with (a failed preview is retried by closing and reopening — the
 * drawer remounts). Step 2 is `kit/confirm tier="irreversible"` (S8 W1-A7, a centred `AlertDialog`)
 * — retype the workspace name + acknowledge — which sends `confirm: true`; the executed result
 * goes back to the page (`onPurged`) for the toast, the list mutation and closing the detail panel.
 *
 * Exactly one modal surface is on screen at a time: the preview drawer unmounts while the confirm
 * tier is open, and cancelling the tier returns to the preview rather than closing everything —
 * the administrator can re-read the warnings before deciding again.
 */
export function PurgeWorkspaceDrawer({
  http,
  workspace,
  onClose,
  onPurged,
}: PurgeWorkspaceDrawerProps) {
  const [preview, setPreview] = useState<Preview>({ status: 'loading' });
  const [step, setStep] = useState<'preview' | 'confirm'>('preview');

  useEffect(() => {
    let cancelled = false;
    setPreview({ status: 'loading' });
    http
      .call<PurgeWorkspaceResultWire>('purge_workspace', { workspaceId: workspace.id })
      .then((result) => {
        if (!cancelled) setPreview({ status: 'ready', result });
      })
      .catch((error: unknown) => {
        if (!cancelled) setPreview({ status: 'error', error });
      });
    return () => {
      cancelled = true;
    };
  }, [http, workspace.id]);

  async function execute(): Promise<void> {
    try {
      const result = await http.call<PurgeWorkspaceResultWire>('purge_workspace', {
        workspaceId: workspace.id,
        confirm: true,
      });
      onPurged(result);
    } catch (err) {
      throw friendly(err);
    }
  }

  if (step === 'confirm' && preview.status === 'ready') {
    const { result } = preview;
    const impact = [
      `${result.totalRows} 行数据将被删除 rows deleted across ${Object.keys(result.counts).length} tables`,
      `${result.activeHandles} 个有效 Handle 将被吊销 live Handles revoked`,
      ...(result.purgedUsers.length > 0
        ? [
            `随之删除 ${result.purgedUsers.length} 个从未激活的用户 never-activated users deleted: ${result.purgedUsers.map((user) => user.login).join(', ')}`,
          ]
        : []),
      ...result.warnings.map(
        (warning) =>
          `service Handle 仍在使用 still in use: ${warning.name ?? warning.principalId} (${warning.activeHandles})`,
      ),
    ];
    return (
      <Confirm
        tier="irreversible"
        open
        onOpenChange={(open) => {
          if (!open) setStep('preview');
        }}
        title="清除工作区 Purge workspace"
        description="行与级联数据删除，平台审计行保留（谁、何时、清了什么）。 Rows and cascaded data are deleted; the platform audit row is kept."
        target={workspace.name}
        impact={impact}
        confirmLabel="确认清除 Purge"
        onConfirm={execute}
        testId="purge-workspace-confirm"
      />
    );
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title="清除工作区 Purge workspace"
      subtitle={<span className="mono">{workspace.name}</span>}
      testId="purge-workspace-drawer"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} data-testid="purge-workspace-cancel">
            取消 Cancel
          </Button>
          <Button
            variant="danger"
            disabled={preview.status !== 'ready'}
            onClick={() => setStep('confirm')}
            data-testid="purge-workspace-continue"
          >
            继续 Continue
          </Button>
        </>
      }
    >
      <div className="stack" data-testid="purge-workspace-preview">
        <Notice>
          第一步是预览：下面是内核将删除的内容，此刻什么都没删。 Step one is a preview — nothing is
          deleted until the next step is confirmed.
        </Notice>
        {preview.status === 'loading' ? (
          <SkeletonRows count={4} label="Loading purge preview" testId="purge-preview-loading" />
        ) : preview.status === 'error' ? (
          <PlatformError
            error={preview.error}
            title="无法预览清除 Could not preview the purge"
            testId="purge-preview-error"
          />
        ) : (
          <PreviewBody result={preview.result} />
        )}
      </div>
    </Drawer>
  );
}

function PreviewBody({ result }: { readonly result: PurgeWorkspaceResultWire }) {
  const counts = Object.entries(result.counts).sort(([, a], [, b]) => b - a);
  return (
    <>
      {result.warnings.map((warning) => (
        <Notice key={warning.principalId} tone="warn" testId="purge-warning-service-handle">
          <div className="stack-s">
            <strong>
              service Handle 仍在使用 A service Handle is still in use — {warning.activeHandles}{' '}
              个有效 Handle live
            </strong>
            <RefChip
              kind="principal"
              id={warning.principalId}
              name={warning.name}
              size="s"
              testId="purge-warning-principal"
            />
            <span>
              采集器或外部运行时可能还在用这个 Principal 的 Handle：清除后那个进程立刻 401（遗留 41
              的来源）。先把它指回正确的工作区，再回来清除。 A collector or external runtime may
              still be calling with it — it gets 401 the moment the purge runs. Point that process
              at the right workspace first.
            </span>
          </div>
        </Notice>
      ))}

      <dl className="definition-list">
        <dt>原因 Reason</dt>
        <dd data-testid="purge-preview-reason">{PURGE_WORKSPACE_REASON_LABELS[result.reason]}</dd>
        <dt>状态 Status</dt>
        <dd>
          <StatusChip machine="workspaceStatus" status={result.status} size="s" />{' '}
          <StatusChip machine="workspacePurpose" status={result.purpose} size="s" />
        </dd>
        <dt>有效 Handle Live Handles</dt>
        <dd className="mono" data-testid="purge-preview-active-handles">
          {result.activeHandles}
        </dd>
      </dl>

      <div className="stack-s">
        <span className="section-title">将删除 Will delete</span>
        {counts.length === 0 ? (
          <p className="text-3">没有工作区级数据行。 No workspace-scoped rows.</p>
        ) : (
          <table className="data-table" data-testid="purge-preview-counts">
            <thead>
              <tr>
                <th>表 Table</th>
                <th className="tabular">行数 Rows</th>
              </tr>
            </thead>
            <tbody>
              {counts.map(([key, n]) => (
                <tr key={key} data-purge-table={key}>
                  <td>
                    {purgeCountLabel(key)} <span className="mono text-3">{key}</span>
                  </td>
                  <td className="mono tabular">{n}</td>
                </tr>
              ))}
              <tr>
                <td>
                  <strong>合计 Total</strong>
                </td>
                <td className="mono tabular" data-testid="purge-preview-total">
                  <strong>{result.totalRows}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </div>

      <div className="stack-s">
        <span className="section-title">随之删除的用户 Users deleted with it</span>
        {result.purgedUsers.length === 0 ? (
          <p className="text-3">
            没有从未激活且成员资格全在此工作区的用户。 No never-activated user has all its
            memberships here.
          </p>
        ) : (
          <div className="row-wrap" data-testid="purge-preview-users">
            {result.purgedUsers.map((user) => (
              <span key={user.id} className="chip chip-s chip-neutral" title={user.id}>
                {user.login}
              </span>
            ))}
          </div>
        )}
      </div>

      {result.principalIds.length > 0 || result.taskIds.length > 0 ? (
        <p className="text-3 text-small" data-testid="purge-preview-host-side">
          主机侧目录不由内核删除：{result.principalIds.length} 个 Principal 目录、
          {result.taskIds.length} 个任务目录，按 scripts/delete-workspace.sh 清理。 Host-side
          directories are not the kernel's to delete: {result.principalIds.length} principal and{' '}
          {result.taskIds.length} task directories — see scripts/delete-workspace.sh.
        </p>
      ) : null}
    </>
  );
}
