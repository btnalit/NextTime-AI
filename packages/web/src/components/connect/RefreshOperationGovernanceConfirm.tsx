import type {
  GateInstanceEnablePreviewOperationPresentWire,
  PreviewGateInstanceEnableResultWire,
  RefreshOperationGovernanceResultWire,
} from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { useT } from '../../lib/i18n.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { NoticeErrorBody } from '../kit/inline-error.js';
import { Notice } from '../kit/notice.js';
import {
  type GovernanceChangeItem,
  GovernanceChangeList,
  governanceChangeSummary,
  governanceConsequences,
  isLoosening,
} from './GovernanceChange.js';

export interface RefreshOperationGovernanceConfirmProps {
  readonly http: CapabilityCaller;
  /** The workspace's own Gatekeeper Object id — `refresh_operation_governance`'s target (not the
   *  platform `gateId` below; see that capability's own doc comment on the two ids). */
  readonly gatekeeperId: string;
  /** The platform gate instance id `preview_gate_instance_enable` reads its announced manifest
   *  from — only known once this Gatekeeper is linked to a platform-catalog instance. The caller
   *  renders this component only when that link exists (`healthInfo.linked`); `refresh_operation_
   *  governance` itself refuses with `no_announced_manifest` when it does not, which the mapped
   *  error banner below still covers defensively for the race. */
  readonly platformGateId: string;
  readonly gateDisplayName: string;
  /** A refresh (even a no-op one — `unchanged` non-empty, `refreshed` empty) succeeded; the caller
   *  reloads whatever it derives from Operation governance fields (readiness's per-mode counts,
   *  the catalog list) — same "full result, caller's own reload" split `EnableGateConfirm` uses. */
  readonly onRefreshed: (result: RefreshOperationGovernanceResultWire) => void;
  readonly testId?: string;
}

/**
 * components/connect/RefreshOperationGovernanceConfirm (closing wave C6, G3 — docs/kernel-console-
 * coverage-2026-09-26.md, leftover 79's exit): the write half of `preview_gate_instance_enable`'s
 * own `differs` flag finally gets a caller. Same preview-then-confirm shape `EnableGateConfirm`
 * established: click → `preview_gate_instance_enable` loads → only the `operationsAlreadyPresent`
 * rows flagging `differs` matter here (`operationsToImport`/`wouldLink` are this call's own concern,
 * not this one's) → a `medium` `Confirm` lists what would change → `refresh_operation_governance`
 * applies it to exactly the drifting names.
 *
 * **Tier is `medium`, not `irreversible`**: the write only re-syncs already-published Operations'
 * governance fields to the manifest in effect, it is reversible (align again after the manifest
 * changes back, or reclassify in the catalog) and every change is shown here before confirming and
 * recorded in its own AuditRecord (`before`/`after`) after — `kit/confirm`'s "reversible, needs a
 * look before it runs". **But a loosening is the danger case and is said plainly** (R-19, D-17):
 * the kernel's own `direction` per Operation (never a ranking of this component's) drives the
 * danger styling, and `governanceConsequences` spells out what it means — execute → observe needs
 * neither approval nor a grant (so it *does* change who may call the system), leaving `high` drops
 * the mandatory human approval and lets the requester approve their own request, and so on.
 *
 * **Exactly the reviewed manifest** (R-18, D-18): the confirm sends back the preview's
 * `manifestDigest`; the kernel refuses `manifest_changed` (mapped below) if the manifest in effect
 * is no longer the one these rows were computed from, so a newer manifest is never applied unseen.
 */
export function RefreshOperationGovernanceConfirm({
  http,
  gatekeeperId,
  platformGateId,
  gateDisplayName,
  onRefreshed,
  testId,
}: RefreshOperationGovernanceConfirmProps) {
  const t = useT();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<unknown | null>(null);
  const [diffs, setDiffs] = useState<
    readonly GateInstanceEnablePreviewOperationPresentWire[] | null
  >(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [alignedNotice, setAlignedNotice] = useState(false);
  const [manifestDigest, setManifestDigest] = useState<string | null>(null);
  const items = (diffs ?? []).map(changeItem);
  // R-19 (D-17): the kernel's direction decides the danger case; the consequences say what it means.
  const consequences = items.flatMap((item) => governanceConsequences(item, t));
  const loosens = items.some((item) => isLoosening(item.direction));
  const [lastResult, setLastResult] = useState<RefreshOperationGovernanceResultWire | null>(null);

  async function loadPreviewAndOpen(): Promise<void> {
    if (checking) return;
    setChecking(true);
    setCheckError(null);
    setAlignedNotice(false);
    setLastResult(null);
    try {
      const preview = await http.call<PreviewGateInstanceEnableResultWire>(
        'preview_gate_instance_enable',
        { gateId: platformGateId },
      );
      const drifting = preview.operationsAlreadyPresent.filter((op) => op.differs);
      setDiffs(drifting);
      setManifestDigest(preview.manifestDigest);
      if (drifting.length === 0) setAlignedNotice(true);
      else setConfirmOpen(true);
    } catch (err) {
      setCheckError(err);
    } finally {
      setChecking(false);
    }
  }

  async function confirmRefresh(): Promise<void> {
    if (diffs === null || manifestDigest === null) return;
    // A refused refresh propagates as-is: `kit/confirm` renders it through `presentError`, which
    // maps a known platform code to its copy and keeps the kernel's text in 「技术细节」.
    const result = await http.call<RefreshOperationGovernanceResultWire>(
      'refresh_operation_governance',
      { gatekeeperId, operationNames: diffs.map((op) => op.name), manifestDigest },
    );
    setLastResult(result);
    setDiffs(null);
    onRefreshed(result);
  }

  const trigger = (
    <Button
      variant="secondary"
      size="s"
      onClick={() => void loadPreviewAndOpen()}
      disabled={checking}
      data-testid={testId}
    >
      {t('与门公告对齐', "Align with the gate's announcement")}
    </Button>
  );

  return (
    <div className="stack-s" data-testid={testId ? `${testId}-wrapper` : undefined}>
      {checkError !== null ? (
        <Notice tone="warn" testId={testId ? `${testId}-check-error` : undefined}>
          {t('读不到公告差异：', 'Could not load the announcement diff: ')}
          <NoticeErrorBody error={checkError} />
        </Notice>
      ) : null}
      {alignedNotice ? (
        <Notice testId={testId ? `${testId}-aligned` : undefined}>
          {t(
            '已与门的公告一致，没有需要对齐的字段。',
            "Already matches the gate's announcement — nothing to align.",
          )}
        </Notice>
      ) : null}
      {lastResult !== null ? (
        <Notice testId={testId ? `${testId}-result` : undefined}>
          {t(
            `已对齐 ${lastResult.refreshed.length} 个 Operation${
              lastResult.unchanged.length > 0 ? `，${lastResult.unchanged.length} 个未变化` : ''
            }。`,
            `Aligned ${lastResult.refreshed.length} operation(s)${
              lastResult.unchanged.length > 0 ? `, ${lastResult.unchanged.length} unchanged` : ''
            }.`,
          )}
        </Notice>
      ) : null}
      <Confirm
        tier="medium"
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        anchor={trigger}
        title={t('与门公告对齐', "Align with the gate's announcement")}
        description={t(
          '按门当前生效清单的模式 / 影响级 / 是否可自动批准，就地修正下列已发布 Operation 的治理字段（不产生新版本）。这决定它们要不要人工审批；改为只读调用的 Operation 也不再需要授权。',
          'Corrects the mode / blast radius / auto-approvable of the published operations below in place, to the manifest in effect (no new Operation version). This decides whether they need a person’s approval — and an operation that becomes an observe call no longer needs a grant either.',
        )}
        target={gateDisplayName}
        impact={items.map((item) => governanceChangeSummary(item, t))}
        confirmLabel={t('对齐', 'Align')}
        danger={loosens}
        onConfirm={confirmRefresh}
        testId={testId ? `${testId}-confirm` : undefined}
      >
        {consequences.length > 0 ? (
          <Notice tone="warn" testId={testId ? `${testId}-loosens` : undefined}>
            <ul className="stack-s" style={{ margin: 0, paddingLeft: '1.2em' }}>
              {consequences.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
        {items.length > 0 ? <GovernanceChangeList items={items} /> : null}
      </Confirm>
    </div>
  );
}

/** A drifting row as the shared confirm list reads it — `existing` → `announced`, with the
 *  kernel's direction. */
function changeItem(op: GateInstanceEnablePreviewOperationPresentWire): GovernanceChangeItem {
  return {
    name: op.name,
    before: {
      mode: op.existing.mode,
      blastRadius: op.existing.blastRadius,
      autoApprovable: op.existing.autoApprovable,
    },
    after: op.announced,
    direction: op.direction,
  };
}
