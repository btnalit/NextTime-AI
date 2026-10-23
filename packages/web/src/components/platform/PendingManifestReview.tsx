import type {
  GateInstanceWire,
  GateOperationSummaryWire,
  PendingGateManifestWire,
} from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { actionKindTagText, formatDateTime, formatRelative } from '../../lib/format.js';
import { type Translate, sentenceGap, useT } from '../../lib/i18n.js';
import { operationFieldLabel } from '../../lib/labels.js';
import { labelText, statusChipStyle } from '../../lib/status-tone.js';
import { gateOwnedParamsText } from '../connect/GateOwnedParams.js';
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
  /** The workspaces that enabled this instance (`GateInstanceWire.enablingWorkspaces`, possibly
   *  truncated) and their true total — those that must align and publish after the adoption. */
  readonly enablingWorkspaces: readonly { readonly id: string; readonly name: string }[];
  readonly enabledWorkspaceCount: number;
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
 *
 * Legacy K (UX acceptance of #538): a gate runs what it announced, so a held change to what it runs
 * (`refusedOperations`) is not "without effect until confirmed" — calls to those Operations are
 * refused from the moment it was announced. The notice says so, and the confirm names the
 * workspaces that must then align and publish the revision before calls resume — except for an
 * Operation whose new definition declares a gate-owned param (UX acceptance of #573 P2): its
 * revision can never be published, so that one is said to wait on the gate's maintainer instead.
 * Nor for one the gate dropped (review #501 on #577 ③): the kernel refuses it until adoption too,
 * but adopting removes it, so calls to it never resume — said on its own as well.
 */
export function PendingManifestReview({
  http,
  gateId,
  displayName,
  pending,
  enablingWorkspaces,
  enabledWorkspaceCount,
  onConfirmed,
}: PendingManifestReviewProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const governed = pending.changed.filter((change) => change.direction !== 'neutral');
  const consequences = governed.flatMap((change) => governanceConsequences(change, t));
  const widens = pending.added.length > 0 || governed.some((c) => isLoosening(c.direction));

  async function confirm(): Promise<void> {
    // A refusal propagates as-is: `kit/confirm` renders it through `presentError`.
    const instance = await http.call<GateInstanceWire>('confirm_gate_manifest', {
      gateId,
      digest: pending.digest,
    });
    onConfirmed(instance);
  }

  const impact = [
    ...pending.added.map((op) =>
      t(`新增 ${gateOperationLine(op, t)}`, `Adds ${gateOperationLine(op, t)}`),
    ),
    ...pending.removed.map((op) =>
      t(`移除 ${actionKindTagText(op.name)}`, `Removes ${actionKindTagText(op.name)}`),
    ),
    ...governed.map((change) => governanceChangeSummary(change, t)),
    ...pending.changed
      .filter((change) => change.otherChangedFields.length > 0)
      .map((change) =>
        t(
          `${actionKindTagText(change.name)} 的定义变了：${change.otherChangedFields.map((field) => operationFieldLabel(field, t)).join('、')}`,
          `${actionKindTagText(change.name)} definition changed: ${change.otherChangedFields.map((field) => operationFieldLabel(field, t)).join(', ')}`,
        ),
      ),
    // Review #501 on #571 ③: a changed entry that now declares a gate-owned param is the costliest
    // case — every enabling workspace's revision of it would be held back — so it is said before
    // adopting, like an added one.
    ...pending.changed
      .filter((change) => (change.gateOwnedParams?.length ?? 0) > 0)
      .map((change) =>
        t(
          `${actionKindTagText(change.name)} 发布不了：新定义声明了只能由门自己设置的参数 ${gateOwnedParamsText(change.gateOwnedParams ?? [], t)}，采用后各工作区为它打开的修订会停在草稿`,
          `${actionKindTagText(change.name)} cannot be published: the new definition declares params only the gate sets, ${gateOwnedParamsText(change.gateOwnedParams ?? [], t)}; once adopted, every workspace's revision of it stays a draft`,
        ),
      ),
  ];
  // UX acceptance of #573 P2: a refused Operation whose new definition declares a gate-owned
  // param cannot come back through adopting and aligning — its revision can never be published —
  // so it is kept out of every "calls resume once …" line and said on its own.
  const heldByGate = new Set(
    pending.changed
      .filter((change) => (change.gateOwnedParams?.length ?? 0) > 0)
      .map((change) => change.name),
  );
  const dropped = new Set(pending.removed.map((op) => op.name));
  const refused = pending.refusedOperations.filter(
    (name) => !heldByGate.has(name) && !dropped.has(name),
  );
  const refusedHeld = pending.refusedOperations.filter((name) => heldByGate.has(name));
  const refusedDropped = pending.refusedOperations.filter((name) => dropped.has(name));
  const heldLine =
    refusedHeld.length > 0
      ? t(
          `对 ${refusedHeld.join('、')} 的调用会被拒绝，而且采用和对齐都恢复不了：新定义声明了只能由门自己设置的参数，修订发布不了。要等门的维护者去掉这些参数、平台采用改好的清单之后才会恢复。`,
          `Calls to ${refusedHeld.join(', ')} are refused, and neither adopting nor aligning brings them back: the new definition declares params only the gate sets, so its revision cannot be published. They resume only once the gate's maintainer drops those params and the platform adopts the corrected manifest.`,
        )
      : null;
  const one = refusedDropped.length === 1;
  const droppedLine =
    refusedDropped.length > 0
      ? t(
          `门已经不再提供 ${refusedDropped.join('、')}，对${one ? '它' : '它们'}的调用会被拒绝，采用和对齐都恢复不了：采用后${one ? '它' : '它们'}会从清单里移除。`,
          `The gate no longer offers ${refusedDropped.join(', ')}, so calls to ${one ? 'it' : 'them'} are refused, and neither adopting nor aligning brings ${one ? 'it' : 'them'} back: adopting removes ${one ? 'it' : 'them'} from the manifest.`,
        )
      : null;
  const unrecoverable = [heldLine, droppedLine].filter((line): line is string => line !== null);
  const workspaceNames = enablingWorkspaces.map((workspace) => workspace.name);
  const moreWorkspaces = enabledWorkspaceCount - workspaceNames.length;

  return (
    <div className="stack-s" data-testid="gate-instance-pending-manifest">
      <Notice tone="warn" testId="gate-instance-pending-manifest-notice">
        {refused.length > 0
          ? t(
              `门已经在按新清单运行。采用、并让启用它的工作区对齐和发布修订之前，对 ${refused.join('、')} 的调用会被拒绝。`,
              `The gate already runs its new manifest. Calls to ${refused.join(', ')} are refused until it is adopted and every workspace that enabled it aligns and publishes the revision.`,
            )
          : unrecoverable.length > 0
            ? t('门已经在按新清单运行。', 'The gate already runs its new manifest.')
            : t(
                `门公布了与生效清单不同的 Operation（${pending.operationCount} 个），采用之前不生效。`,
                `The gate announced operations that differ from the manifest in effect (${pending.operationCount}); they take no effect until adopted.`,
              )}
        {/* UX acceptance of #577 P3: Chinese sentences run on with no half-width space between. */}
        {unrecoverable.map((line) => (
          <span key={line}>
            {sentenceGap(t)}
            {line}
          </span>
        ))}{' '}
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
            '采用后，之后在工作区启用这个门会导入这份清单，工作区所有者也可以按它对齐已部署的 Operation；已部署的不会自动改变。',
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
          {refused.length > 0 && enabledWorkspaceCount > 0 ? (
            <Notice tone="warn" testId="gate-instance-pending-manifest-workspaces">
              {workspaceNames.length === 0
                ? t(
                    `采用后，启用它的 ${enabledWorkspaceCount} 个工作区需要到「系统与授权」对齐并发布修订，对 ${refused.join('、')} 的调用才会恢复。`,
                    `After adopting, the ${enabledWorkspaceCount} workspace(s) that enabled it must align under Systems & access and publish the revision before calls to ${refused.join(', ')} resume.`,
                  )
                : moreWorkspaces > 0
                  ? t(
                      `采用后，${workspaceNames.join('、')} 等 ${enabledWorkspaceCount} 个工作区需要到「系统与授权」对齐并发布修订，对 ${refused.join('、')} 的调用才会恢复。`,
                      `After adopting, ${workspaceNames.join(', ')} and ${moreWorkspaces} more workspace(s) must align under Systems & access and publish the revision before calls to ${refused.join(', ')} resume.`,
                    )
                  : t(
                      `采用后，${workspaceNames.join('、')} 工作区需要到「系统与授权」对齐并发布修订，对 ${refused.join('、')} 的调用才会恢复。`,
                      `After adopting, ${workspaceNames.join(', ')} must align under Systems & access and publish the revision before calls to ${refused.join(', ')} resume.`,
                    )}
            </Notice>
          ) : null}
          {heldLine !== null && enabledWorkspaceCount > 0 ? (
            <Notice tone="warn" testId="gate-instance-pending-manifest-held">
              {heldLine}
            </Notice>
          ) : null}
          {droppedLine !== null && enabledWorkspaceCount > 0 ? (
            <Notice tone="warn" testId="gate-instance-pending-manifest-dropped">
              {droppedLine}
            </Notice>
          ) : null}
          {governed.length > 0 ? <GovernanceChangeList items={governed} /> : null}
        </Confirm>
      </div>
    </div>
  );
}

/** One announced Operation in a line: its name and how it is classified (the 新清单 review here,
 *  and a connector preset's Operations on 新建门宿主实例, S11 P1-F). */
export function gateOperationLine(op: GateOperationSummaryWire, t: Translate): string {
  const parts = [
    labelText(statusChipStyle('operationMode', op.mode), t),
    labelText(statusChipStyle('blastRadius', op.blastRadius), t),
  ];
  if (op.autoApprovable) parts.push(labelText(statusChipStyle('autoApprovable', 'true'), t));
  // UX acceptance of #567 P3: an entry that will stay a draft in every workspace says so here,
  // before it is adopted.
  if (op.gateOwnedParams && op.gateOwnedParams.length > 0) {
    parts.push(
      t(
        `发布不了：声明了只能由门自己设置的参数 ${gateOwnedParamsText(op.gateOwnedParams, t)}`,
        `cannot be published: declares params only the gate sets, ${gateOwnedParamsText(op.gateOwnedParams, t)}`,
      ),
    );
  }
  return `${actionKindTagText(op.name)} (${parts.join(' · ')})`;
}
