import type {
  GateInstanceEnablePreviewOperationPresentWire,
  OperationGovernanceFieldsWire,
  PreviewGateInstanceEnableResultWire,
  RefreshOperationGovernanceResultWire,
} from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { describeError } from '../../lib/errors.js';
import { HttpError } from '../../lib/http-client.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { platformErrorMessage } from '../../lib/platform-errors.js';
import { labelText, statusChipStyle } from '../../lib/status-tone.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { Notice } from '../kit/notice.js';
import { StatusChip } from '../kit/status-chip.js';

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
 * **Tier is `medium`, not `irreversible`, even when a diff loosens auto-approval** (the case that
 * most looks like "widening what an agent may do without approval"): the write only re-syncs an
 * already-published, already-granted Operation's governance fields to match what its own gate is
 * announcing *right now* — it grants no Handle anything new (grants are per-Gatekeeper, not
 * per-field) and creates no new capability. The owner who could grant execute on this gate a moment
 * ago could already do so; this changes only whether a future `request_action` on it needs a human
 * to approve. It is also trivially reversible (run it again after the gate's own manifest changes
 * back, or hand-edit the Operation) and every change is visible here before confirming and in its
 * own AuditRecord (`before`/`after`) after — exactly `kit/confirm`'s own "reversible, needs a look
 * before it runs" definition of `medium`, the same tier its siblings on this page-family use
 * (`EnableGateConfirm`, `set_active_runtime_image`).
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
  // The one direction worth stopping on: an Operation that needed a person's approval and would no
  // longer (auto-approve switched on, or execute re-announced as observe). Still `medium` — see the
  // doc comment above — but called out and styled as a danger action, never one chip among many.
  const loosened = (diffs ?? []).filter((op) => loosensApproval(op)).map((op) => op.name);
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
      if (drifting.length === 0) setAlignedNotice(true);
      else setConfirmOpen(true);
    } catch (err) {
      setCheckError(err);
    } finally {
      setChecking(false);
    }
  }

  async function confirmRefresh(): Promise<void> {
    if (diffs === null) return;
    let result: RefreshOperationGovernanceResultWire;
    try {
      result = await http.call<RefreshOperationGovernanceResultWire>(
        'refresh_operation_governance',
        { gatekeeperId, operationNames: diffs.map((op) => op.name) },
      );
    } catch (err) {
      const mapped = platformErrorMessage(err, t);
      const described = describeError(err);
      throw mapped ? new HttpError('capability_error', mapped, described.code) : err;
    }
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
          {describeError(checkError).message}
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
          '按门当前公告的模式 / 影响级 / 是否可自动批准，就地修正下列已发布 Operation 的治理字段——不产生新版本，不改变谁能调用这个系统。',
          'Corrects the mode/blast-radius/auto-approvable fields of the operations below in place, to match what the gate announces right now — no new Operation version, and it never changes who may call this system.',
        )}
        target={gateDisplayName}
        impact={(diffs ?? []).map((op) => governanceDiffSummary(op, t))}
        confirmLabel={t('对齐', 'Align')}
        danger={loosened.length > 0}
        onConfirm={confirmRefresh}
        testId={testId ? `${testId}-confirm` : undefined}
      >
        {loosened.length > 0 ? (
          <Notice tone="warn" testId={testId ? `${testId}-loosens` : undefined}>
            {t(
              `对齐后，${loosened.join('、')} 以后执行时不再需要人工审批。`,
              `Once aligned, ${loosened.join(', ')} will no longer need a person's approval to run.`,
            )}
          </Notice>
        ) : null}
        {diffs !== null && diffs.length > 0 ? <GovernanceDiffList diffs={diffs} /> : null}
      </Confirm>
    </div>
  );
}

function governanceDiffSummary(
  op: GateInstanceEnablePreviewOperationPresentWire,
  t: Translate,
): string {
  const changed = fieldChanges(op.existing, op.announced, t);
  return `${op.name}: ${changed.map((c) => `${c.label} ${c.before} → ${c.after}`).join('; ')}`;
}

interface FieldChange {
  readonly label: string;
  readonly before: string;
  readonly after: string;
}

function modeLabel(status: OperationGovernanceFieldsWire['mode'], t: Translate): string {
  return labelText(statusChipStyle('operationMode', status), t);
}

function blastRadiusLabel(
  status: OperationGovernanceFieldsWire['blastRadius'],
  t: Translate,
): string {
  return labelText(statusChipStyle('blastRadius', status), t);
}

function autoApprovableLabel(autoApprovable: boolean, t: Translate): string {
  return labelText(statusChipStyle('autoApprovable', String(autoApprovable)), t);
}

/** Only the fields that actually differ — `differs` is already true for every row this renders,
 *  but a governance change rarely touches all three fields at once, and listing an unchanged one
 *  as "x → x" would misreport the diff. */
function fieldChanges(
  existing: OperationGovernanceFieldsWire,
  announced: OperationGovernanceFieldsWire,
  t: Translate,
): readonly FieldChange[] {
  const changes: FieldChange[] = [];
  if (existing.mode !== announced.mode) {
    changes.push({
      label: t('模式', 'Mode'),
      before: modeLabel(existing.mode, t),
      after: modeLabel(announced.mode, t),
    });
  }
  if (existing.blastRadius !== announced.blastRadius) {
    changes.push({
      label: t('影响级', 'Blast radius'),
      before: blastRadiusLabel(existing.blastRadius, t),
      after: blastRadiusLabel(announced.blastRadius, t),
    });
  }
  if (existing.autoApprovable !== announced.autoApprovable) {
    changes.push({
      label: t('自动批准', 'Auto-approve'),
      before: autoApprovableLabel(existing.autoApprovable, t),
      after: autoApprovableLabel(announced.autoApprovable, t),
    });
  }
  return changes;
}

function loosensApproval(op: GateInstanceEnablePreviewOperationPresentWire): boolean {
  return (
    (!op.existing.autoApprovable && op.announced.autoApprovable) ||
    (op.existing.mode === 'execute' && op.announced.mode === 'observe')
  );
}

function GovernanceDiffList({
  diffs,
}: {
  readonly diffs: readonly GateInstanceEnablePreviewOperationPresentWire[];
}) {
  const t = useT();
  return (
    <div className="stack-s" data-testid="governance-diff-list">
      <span className="text-12 font-medium text-text-2">
        {t(`将对齐 ${diffs.length} 个 Operation`, `Will align ${diffs.length}`)}
      </span>
      <ul className="stack-s" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {diffs.map((op) => (
          <li key={op.name} className="stack-s">
            <span className="mono">{op.name}</span>
            <div className="row-wrap">
              <StatusChip machine="operationMode" status={op.existing.mode} size="s" />
              <span aria-hidden="true">→</span>
              <StatusChip machine="operationMode" status={op.announced.mode} size="s" />
            </div>
            <div className="row-wrap">
              <StatusChip machine="blastRadius" status={op.existing.blastRadius} size="s" />
              <span aria-hidden="true">→</span>
              <StatusChip machine="blastRadius" status={op.announced.blastRadius} size="s" />
            </div>
            <div className="row-wrap">
              <StatusChip
                machine="autoApprovable"
                status={String(op.existing.autoApprovable)}
                size="s"
              />
              <span aria-hidden="true">→</span>
              <StatusChip
                machine="autoApprovable"
                status={String(op.announced.autoApprovable)}
                size="s"
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
