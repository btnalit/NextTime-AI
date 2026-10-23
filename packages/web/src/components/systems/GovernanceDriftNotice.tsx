import type { PreviewGateInstanceEnableResultWire } from '@nexttime/shared';
import { useCapability } from '../../hooks/useCapability.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { useT } from '../../lib/i18n.js';
import { governanceChangeSummary } from '../connect/GovernanceChange.js';
import {
  RefreshOperationGovernanceConfirm,
  governanceDriftOf,
} from '../connect/RefreshOperationGovernanceConfirm.js';
import { Notice } from '../kit/notice.js';

/**
 * components/systems/GovernanceDriftNotice (legacy 456): a platform gate whose deployed Operations
 * are classified otherwise than the manifest the platform adopted says so on its row in 系统与授权,
 * before anyone opens the drawer. Adopting a new manifest never changes what a workspace deployed
 * (R-18): until the owner aligns, a tightened Operation still runs under its old classification —
 * the first case was RAGFlow's `document.parse` (#726), still auto-approved until aligned. The
 * align is offered right here, over the same preview this notice was read from
 * (`RefreshOperationGovernanceConfirm`, `preview`), so the confirm shows exactly what was listed.
 *
 * Read only by whoever may align (`preview_gate_instance_enable` and `refresh_operation_governance`
 * are both the owner's); nothing shows while it loads or when it cannot be read — the drawer's own
 * 「已部署 Operation 的治理字段」 stays the way in.
 */
export function GovernanceDriftNotice({
  http,
  gatekeeperId,
  platformGateId,
  gateDisplayName,
  platformAdmin,
  onAligned,
}: {
  readonly http: CapabilityCaller;
  /** The workspace's own Gatekeeper Object id (`refresh_operation_governance`'s target). */
  readonly gatekeeperId: string;
  /** The platform gate instance id the adopted manifest is read from. */
  readonly platformGateId: string;
  readonly gateDisplayName: string;
  readonly platformAdmin?: boolean;
  /** The align ran — the page reloads what it derives from Operation governance fields. */
  readonly onAligned: () => void;
}) {
  const t = useT();
  const can = useRoleCan(http);
  const reads = can('preview_gate_instance_enable') === true;
  const preview = useCapability<PreviewGateInstanceEnableResultWire>(
    http,
    'preview_gate_instance_enable',
    { gateId: platformGateId },
    { enabled: reads },
  );
  if (!reads || preview.state.status !== 'ready') return null;
  const drift = governanceDriftOf(preview.state.data);
  if (drift.length === 0) return null;
  const items = drift.map((op) => ({
    name: op.name,
    before: op.existing,
    after: op.announced,
    direction: op.direction,
  }));
  const tightens = drift.some((op) => op.direction === 'tightened' || op.direction === 'mixed');
  return (
    <div className="stack-s" data-testid="gatekeeper-governance-drift">
      <Notice tone="warn" testId="gatekeeper-governance-drift-notice">
        <span className="stack-s">
          <span>
            {t(
              `${drift.length} 个已部署的 Operation 分类与平台最新清单不一致，需对齐：`,
              `${drift.length} deployed operation(s) are classified otherwise than the platform’s latest manifest and need aligning:`,
            )}
          </span>
          <ul className="stack-s" data-testid="gatekeeper-governance-drift-items">
            {items.map((item) => (
              <li key={item.name} className="text-small">
                {governanceChangeSummary(item, t)}
              </li>
            ))}
          </ul>
          <span>
            {tightens
              ? t(
                  '对齐之前，这个工作区仍按旧分类执行，收紧的部分还没有生效。',
                  'Until aligned, this workspace still runs them under the old classification; what was tightened is not in effect yet.',
                )
              : t(
                  '对齐会按平台的清单放宽这些分类；确认时会列出放宽后谁能做什么。',
                  'Aligning loosens them to the platform’s manifest; the confirm lists what that lets whom do.',
                )}
          </span>
        </span>
      </Notice>
      <RefreshOperationGovernanceConfirm
        http={http}
        gatekeeperId={gatekeeperId}
        platformGateId={platformGateId}
        gateDisplayName={gateDisplayName}
        platformAdmin={platformAdmin}
        preview={preview.state.data}
        label={t('对齐', 'Align')}
        onRefreshed={() => {
          void preview.reload();
          onAligned();
        }}
        testId="gatekeeper-governance-drift-align"
      />
    </div>
  );
}
