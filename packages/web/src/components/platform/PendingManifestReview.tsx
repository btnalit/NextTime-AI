import type {
  GateInstanceWire,
  GateOperationSummaryWire,
  PendingGateManifestWire,
} from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { describeError } from '../../lib/errors.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { HttpError } from '../../lib/http-client.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { platformErrorMessage } from '../../lib/platform-errors.js';
import { labelText, statusChipStyle } from '../../lib/status-tone.js';
import {
  GovernanceChangeList,
  governanceChangeSummary,
  governanceConsequences,
  isLoosening,
} from '../connect/GovernanceChange.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { Notice } from '../kit/notice.js';

export interface PendingManifestReviewProps {
  readonly http: CapabilityCaller;
  readonly gateId: string;
  readonly displayName: string;
  readonly pending: PendingGateManifestWire;
  /** `confirm_gate_manifest` answered with the instance, the held manifest now in effect. */
  readonly onConfirmed: (instance: GateInstanceWire) => void;
}

/**
 * components/platform/PendingManifestReview (R-18, decision D-18): a decided gate re-announced a
 * manifest that changes what it can do, and the kernel held it (`GateInstanceWire.pendingManifest`)
 * — the manifest in effect stays until an administrator looks at this diff and confirms it. Added
 * and removed Operations are listed by name and classification; a changed one shows old → new
 * with the kernel's own direction (`GovernanceChange`, shared with every other classification
 * confirm), plus any other field it changed. Confirming sends back this diff's `digest`, so the
 * kernel adopts exactly this version — if the gate announced again in the meantime it refuses
 * `manifest_changed` and the administrator reviews the newer one instead.
 *
 * `medium`: reversible (the next confirmed announcement replaces it) and listed in full here;
 * danger-styled when it adds an Operation or the kernel says a change loosens one. Adopting it
 * does not touch any workspace's deployed Operations — each owner aligns those with their own
 * preview and confirm.
 */
export function PendingManifestReview({
  http,
  gateId,
  displayName,
  pending,
  onConfirmed,
}: PendingManifestReviewProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const governed = pending.changed.filter((change) => change.direction !== 'neutral');
  const consequences = governed.flatMap((change) => governanceConsequences(change, t));
  const widens = pending.added.length > 0 || governed.some((c) => isLoosening(c.direction));

  async function confirm(): Promise<void> {
    let instance: GateInstanceWire;
    try {
      instance = await http.call<GateInstanceWire>('confirm_gate_manifest', {
        gateId,
        digest: pending.digest,
      });
    } catch (err) {
      const mapped = platformErrorMessage(err, t);
      const described = describeError(err);
      throw mapped ? new HttpError('capability_error', mapped, described.code) : err;
    }
    onConfirmed(instance);
  }

  const impact = [
    ...pending.added.map((op) => t(`新增 ${opLine(op, t)}`, `Adds ${opLine(op, t)}`)),
    ...pending.removed.map((op) => t(`移除 ${op.name}`, `Removes ${op.name}`)),
    ...governed.map((change) => governanceChangeSummary(change, t)),
    ...pending.changed
      .filter((change) => change.otherChangedFields.length > 0)
      .map((change) =>
        t(
          `${change.name} 的定义变了：${change.otherChangedFields.join('、')}`,
          `${change.name} definition changed: ${change.otherChangedFields.join(', ')}`,
        ),
      ),
  ];

  return (
    <div className="stack-s" data-testid="gate-instance-pending-manifest">
      <Notice tone="warn">
        {t(
          `这个门 announce 了与生效清单不同的 Operation（${pending.operationCount} 个），确认之前不生效。`,
          `This gate announced operations that differ from the manifest in effect (${pending.operationCount}); they take no effect until confirmed.`,
        )}{' '}
        <time title={formatDateTime(pending.announcedAt)}>
          {formatRelative(pending.announcedAt)}
        </time>
      </Notice>
      <ul className="stack-s" style={{ margin: 0, paddingLeft: '1.2em' }}>
        {impact.map((line) => (
          <li key={line} className="text-13">
            {line}
          </li>
        ))}
      </ul>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Confirm
          tier="medium"
          open={open}
          onOpenChange={setOpen}
          anchor={
            <Button
              variant="secondary"
              size="s"
              onClick={() => setOpen(true)}
              data-testid="gate-instance-pending-manifest-review"
            >
              {t('审阅并采用', 'Review and adopt')}
            </Button>
          }
          title={t('采用门的新清单', "Adopt the gate's new manifest")}
          description={t(
            '采用后，之后在工作区启用这个门会导入这份清单，工作区 owner 也可以按它对齐已部署的 Operation；已部署的不会自动改变。',
            'Once adopted, later workspace enables import this manifest and workspace owners can align their deployed operations to it; nothing deployed changes on its own.',
          )}
          target={displayName}
          impact={impact}
          confirmLabel={t('采用', 'Adopt')}
          danger={widens}
          onConfirm={confirm}
          testId="gate-instance-pending-manifest-confirm"
        >
          {consequences.length > 0 ? (
            <Notice tone="warn" testId="gate-instance-pending-manifest-loosens">
              <ul className="stack-s" style={{ margin: 0, paddingLeft: '1.2em' }}>
                {consequences.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          {governed.length > 0 ? <GovernanceChangeList items={governed} /> : null}
        </Confirm>
      </div>
    </div>
  );
}

function opLine(op: GateOperationSummaryWire, t: Translate): string {
  const parts = [
    labelText(statusChipStyle('operationMode', op.mode), t),
    labelText(statusChipStyle('blastRadius', op.blastRadius), t),
  ];
  if (op.autoApprovable) parts.push(labelText(statusChipStyle('autoApprovable', 'true'), t));
  return `${op.name} (${parts.join(' · ')})`;
}
