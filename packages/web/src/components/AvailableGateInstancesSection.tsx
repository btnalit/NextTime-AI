import type {
  AvailableGateInstanceWire,
  EnableGateInstanceResultWire,
  GateHostTokenWire,
} from '@nexttime/shared';
import { useEffect, useState } from 'react';
import type { CapabilityListResult } from '../hooks/useCapability.js';
import { usePermissions } from '../hooks/usePermissions.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import { useT } from '../lib/i18n.js';
import { hrefs } from '../lib/router.js';
import { EnableGateConfirm } from './connect/EnableGateConfirm.js';
// Bugfix (PR #324 review): "待启用的平台实例" was still the legacy dashed-border EmptyState —
// `kit/empty-state` (block variant, no dashed border) instead, matching V9. The rest of this
// file's `components/ui/*` imports are unchanged (this file stays on
// `scripts/guards/legacy-ui-importers.json`; out of this lane's scope to migrate fully).
import { EmptyState } from './kit/empty-state.js';
import { GateCredentialEntry } from './platform/GateCredentialEntry.js';
import { Button } from './ui/Button.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Notice } from './ui/Notice.js';
import { SkeletonRows } from './ui/Skeleton.js';
import { StatusChip } from './ui/StatusChip.js';
import { useToast } from './ui/Toast.js';

export interface AvailableGateInstancesSectionProps {
  readonly http: CapabilityCaller;
  /** S6-C: the catalog read is owned by `ConnectionsPage` now (it also feeds the launcher and the
   *  registered-system → platform-instance links), passed in rather than read twice. */
  readonly available: CapabilityListResult<AvailableGateInstanceWire>;
  /** The Registered systems section below must reload too: `enable_gate_instance` registers a
   *  Gatekeeper object that section reads independently. */
  readonly onEnabled: () => void;
  /** Owner-only: shows the 启用 button. Members still see the list and, on linked rows, the
   *  per-member credential entry (P-B2a). */
  readonly canEnable: boolean;
}

/**
 * components/AvailableGateInstancesSection: "从平台目录启用 Enable from platform catalog"
 * (`ConnectionsPage`, P-B1, design §6.3) — `list_available_gate_instances` /
 * `enable_gate_instance`, the workspace-owner half of P-B1's platform catalog. Rendered only for
 * an owner (`ConnectionsPage`'s existing `canCreate` — `create_connection`'s own owner-only
 * `deniedClosure`, which `enable_gate_instance`/`list_available_gate_instances` share).
 *
 * B7 (docs/console-completion-plan.md §2b, §4 "接入三层"): a row here is a *platform* instance —
 * its `status` / `health` are the platform's (`enabled · ok` means "the administrator enabled it
 * and it is healthy"), while the button is about *this workspace*. The old raw `enabled · ok`
 * text next to a 启用 button read as a contradiction. Now the two facts are two `StatusChip`s and
 * the button says what it does — 在本工作区启用 Enable here — and appears only while the workspace
 * has no link yet (`gatekeeperId === null`) and the platform side is `enabled` (the only status
 * the kernel accepts, `requireAvailable`'s `gate_not_enabled`); a linked row shows the Gatekeeper
 * link instead.
 */
export function AvailableGateInstancesSection({
  http,
  available,
  onEnabled,
  canEnable,
}: AvailableGateInstancesSectionProps) {
  const t = useT();
  const permissions = usePermissions();
  const forbidden = available.state.status === 'error' && isForbiddenError(available.state.error);
  useEffect(() => {
    if (forbidden) permissions.markDenied('list_available_gate_instances');
  }, [forbidden, permissions]);

  const rows = available.state.status === 'ready' ? available.state.data.items : [];

  function handleEnabled(result: EnableGateInstanceResultWire): void {
    available.mutate((data) => ({
      ...data,
      items: data.items.map((row) =>
        row.gateId === result.gateId
          ? { ...row, gatekeeperId: result.gatekeeperId, status: 'enabled' }
          : row,
      ),
    }));
    onEnabled();
  }

  return (
    <div aria-labelledby="available-gates-title">
      <div className="section-header">
        {/* S8 W2-U1 (audit SY1 "两套接入机制并存"): `h3` — nested under `ConnectionsPage`'s own
         *  "已接入系统" `h2`, which now wraps this sub-group and 已注册系统 as one page section. */}
        <h3 id="available-gates-title">
          {t('待启用的平台实例', 'Platform instances pending enable')}
        </h3>
        <Button
          variant="ghost"
          size="s"
          icon="refresh"
          onClick={() => void available.reload()}
          loading={available.state.status === 'ready' && available.state.refreshing}
        >
          {t('刷新', 'Refresh')}
        </Button>
      </div>

      {available.state.status === 'loading' ? (
        <SkeletonRows
          count={2}
          label={t('正在加载平台目录…', 'Loading the platform catalog')}
          testId="available-gates-loading"
        />
      ) : forbidden ? (
        <Notice testId="available-gates-forbidden">
          {t(
            '从平台目录启用是 owner 专属操作',
            'Enabling from the platform catalog is owner-only.',
          )}
        </Notice>
      ) : available.state.status === 'error' ? (
        <ErrorBanner
          error={available.state.error}
          title={t('无法加载平台目录', 'Could not load the platform catalog')}
          onRetry={() => void available.reload()}
          testId="available-gates-error"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title={t('平台目录里还没有可启用的实例', 'Nothing to enable yet')}
          body={t(
            '需要管理员先把某个接入包设为「平台预置」，其实例才会出现在这里。',
            'An administrator needs to set a connector to platform-preset for its instances to show up here.',
          )}
          testId="available-gates-empty"
        />
      ) : (
        <div className="table-scroll">
          <table className="data-table" data-testid="available-gates-table">
            <thead>
              <tr>
                <th>{t('名称', 'Name')}</th>
                <th>{t('接入包', 'Connector')}</th>
                <th>{t('平台状态', 'Platform status')}</th>
                <th>{t('健康', 'Health')}</th>
                <th>Operation 数</th>
                <th>{t('本工作区', 'This workspace')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <AvailableGateRow
                  key={row.gateId}
                  http={http}
                  row={row}
                  onEnabled={handleEnabled}
                  canEnable={canEnable}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AvailableGateRow({
  http,
  row,
  onEnabled,
  canEnable,
}: {
  readonly http: CapabilityCaller;
  readonly row: AvailableGateInstanceWire;
  readonly onEnabled: (result: EnableGateInstanceResultWire) => void;
  readonly canEnable: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const [publishedCount, setPublishedCount] = useState<number | null>(null);

  // S8 W2-U1 (audit J4): `EnableGateConfirm` cannot import `components/ui/Toast` itself (S8 risk
  // ① — a new file under `components/kit`-adjacent boundaries may not reach into legacy
  // `components/ui/*`), so this already-allowlisted caller reports `linkedExisting` instead.
  function handleEnabled(result: EnableGateInstanceResultWire): void {
    setPublishedCount(result.publishedOperationNames.length);
    const skipped = result.skippedOperationNames.length;
    toast.push({
      tone: 'ok',
      title: result.linkedExisting
        ? t(
            `已关联已有的注册（旧路径）：${row.displayName}`,
            `Linked the existing (legacy) registration: ${row.displayName}`,
          )
        : t(
            `已在本工作区启用：${row.displayName}`,
            `Enabled in this workspace: ${row.displayName}`,
          ),
      description: t(
        `已发布 ${result.publishedOperationNames.length} 个 Operation${skipped > 0 ? `，跳过 ${skipped} 个已存在的` : ''}。`,
        `Published ${result.publishedOperationNames.length} operation(s)${skipped > 0 ? `, skipped ${skipped} already there` : ''}.`,
      ),
    });
    onEnabled(result);
  }

  // B7: the platform side must be `enabled` for the kernel to accept a workspace enable; a row
  // that is here only because this workspace linked it earlier (platform `disabled` / `lost`)
  // shows its link but no button.
  const platformEnabled = row.status === 'enabled';

  return (
    <tr data-testid={`available-gate-${row.gateId}`}>
      <td>
        <div className="stack-s" style={{ gap: 0 }}>
          <span>{row.displayName}</span>
          <span className="mono text-3">{row.gateId}</span>
        </div>
      </td>
      <td className="mono">{row.connector}</td>
      <td>
        <StatusChip
          machine="gateInstance"
          status={row.status}
          size="s"
          testId={`available-gate-status-${row.gateId}`}
        />
      </td>
      <td>
        <StatusChip machine="gateHealth" status={row.health} size="s" />
      </td>
      <td className="mono">{row.operationCount}</td>
      <td>
        {row.gatekeeperId ? (
          <div className="stack-s">
            <a href={hrefs.gatekeeper(row.gatekeeperId)}>{t('已启用', 'Enabled')}</a>
            <GateCredentialEntry
              requestToken={() =>
                http.call<GateHostTokenWire>('issue_gate_credential_token', {
                  gateId: row.gateId,
                })
              }
              tokenButtonLabel={t('录入我的凭证', 'Enter my credential')}
            />
          </div>
        ) : !platformEnabled ? (
          <span className="muted" data-testid={`available-gate-not-enableable-${row.gateId}`}>
            {t('平台侧未启用', 'Not enabled on the platform')}
          </span>
        ) : canEnable ? (
          <EnableGateConfirm
            key={row.gateId}
            http={http}
            gateId={row.gateId}
            gateDisplayName={row.displayName}
            onEnabled={handleEnabled}
            testId={`enable-gate-${row.gateId}`}
          />
        ) : (
          <span className="muted">
            {t('未启用（由 owner 启用）', 'Not enabled (owner enables)')}
          </span>
        )}
        {publishedCount !== null ? (
          <Notice>
            {t(
              `已发布 ${publishedCount} 个 Operation`,
              `Published ${publishedCount} operation${publishedCount === 1 ? '' : 's'}`,
            )}
          </Notice>
        ) : null}
      </td>
    </tr>
  );
}
