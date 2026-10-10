import type {
  GateInstanceEnablePreviewOperationPresentWire,
  PreviewGateInstanceEnableResultWire,
  RefreshOperationGovernanceResultWire,
} from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { operationKey, revisionDraftKey } from '../../lib/governance.js';
import { useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
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
 *
 * **A changed definition drifts too** (legacy K, review of #538 G1/G2): a row flagging
 * `definitionDiffers` — the gate now runs another binding / params_schema / result_mapping than the
 * deployed version — is listed even when its governance fields still match. The gate refuses every
 * call made under the deployed definition until a revision carrying the announced one is published,
 * and this refresh is what opens that revision (as a draft, never published from here). The confirm
 * says so; the result lists each draft with a link to the catalog row that publishes it.
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
  // Which previewed rows are published — a revision draft of one is its own catalog row.
  const [publishedNames, setPublishedNames] = useState<ReadonlySet<string>>(new Set());
  const items = (diffs ?? []).filter((op) => op.differs).map(changeItem);
  const redefined = (diffs ?? []).filter((op) => op.definitionDiffers).map((op) => op.name);
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
      // Legacy K (G1): a definition-only change drifts as well — "already aligned" would leave the
      // gate refusing those Operations with no way to open the revision that fixes it.
      const drifting = preview.operationsAlreadyPresent.filter(
        (op) => op.differs || op.definitionDiffers,
      );
      setDiffs(drifting);
      setPublishedNames(
        new Set(
          preview.operationsAlreadyPresent
            .filter((op) => op.existing.status === 'published')
            .map((op) => op.name),
        ),
      );
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
        <Notice
          tone={lastResult.revisionDrafts.length > 0 ? 'warn' : 'info'}
          testId={testId ? `${testId}-result` : undefined}
        >
          <div className="stack-s">
            {lastResult.refreshed.length > 0 || lastResult.revisionDrafts.length === 0 ? (
              <span>
                {t(
                  `已对齐 ${lastResult.refreshed.length} 个 Operation${
                    lastResult.unchanged.length > 0
                      ? `，${lastResult.unchanged.length} 个未变化`
                      : ''
                  }。`,
                  `Aligned ${lastResult.refreshed.length} operation(s)${
                    lastResult.unchanged.length > 0
                      ? `, ${lastResult.unchanged.length} unchanged`
                      : ''
                  }.`,
                )}
              </span>
            ) : null}
            {lastResult.revisionDrafts.length > 0 ? (
              <div className="stack-s" data-testid={testId ? `${testId}-drafts` : undefined}>
                <span>
                  {t(
                    `已为 ${lastResult.revisionDrafts.length} 个 Operation 打开修订草稿。发布之前，门会拒绝对它们的调用——到能力目录核对后发布：`,
                    `Opened a revision draft for ${lastResult.revisionDrafts.length} operation(s). The gate refuses calls to them until it is published — review and publish it in the catalog:`,
                  )}
                </span>
                <ul className="stack-s" style={{ margin: 0, paddingLeft: '1.2em' }}>
                  {lastResult.revisionDrafts.map((draft) => {
                    const row = { gatekeeperId, name: draft.name };
                    const key = publishedNames.has(draft.name)
                      ? revisionDraftKey(row)
                      : operationKey(row);
                    return (
                      <li key={draft.name} className="row-wrap">
                        <span className="mono">{draft.name}</span>
                        <span>{t(`修订 v${draft.version}`, `revision v${draft.version}`)}</span>
                        <a
                          href={hrefs.catalog('operations', key)}
                          data-testid={testId ? `${testId}-draft-link` : undefined}
                        >
                          {t('去能力目录发布', 'Publish in the catalog')}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </div>
        </Notice>
      ) : null}
      <Confirm
        tier="medium"
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        anchor={trigger}
        title={t('与门公告对齐', "Align with the gate's announcement")}
        description={
          items.length > 0
            ? t(
                '按门当前生效清单的模式 / 影响级 / 是否可自动批准，就地修正下列已发布 Operation 的治理字段（不产生新版本）。这决定它们要不要人工审批；改为只读调用的 Operation 也不再需要授权。',
                'Corrects the mode / blast radius / auto-approvable of the published operations below in place, to the manifest in effect (no new Operation version). This decides whether they need a person’s approval — and an operation that becomes an observe call no longer needs a grant either.',
              )
            : t(
                '下列已发布 Operation 的治理字段与门的公告一致，但门运行的定义变了，不能就地修改：对齐会为它们各打开一个修订草稿。',
                'The governance fields of the published operations below match the announcement, but the definition the gate runs has changed and cannot be corrected in place: aligning opens a revision draft for each.',
              )
        }
        target={gateDisplayName}
        impact={[
          ...items.map((item) => governanceChangeSummary(item, t)),
          ...redefined.map((name) =>
            t(
              `${name}：门运行的定义变了，打开修订草稿`,
              `${name}: the definition the gate runs changed — opens a revision draft`,
            ),
          ),
        ]}
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
        {redefined.length > 0 ? (
          <Notice tone="warn" testId={testId ? `${testId}-redefined` : undefined}>
            {t(
              `门运行的定义（绑定、参数或结果映射）已经变了：${redefined.join('、')}。对齐只会为它们打开修订草稿；在你到能力目录发布修订之前，门会拒绝对它们的调用。`,
              `The definition the gate runs (binding, params or result mapping) has changed: ${redefined.join(', ')}. Aligning only opens a revision draft for each; the gate refuses calls to them until you publish it in the catalog.`,
            )}
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
