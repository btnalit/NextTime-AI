import type {
  GateInstanceEnablePreviewOperationPresentWire,
  GateInstanceEnablePreviewOperationWire,
  GateOwnedParamWire,
  OperationGovernanceFieldsWire,
  PreviewGateInstanceEnableResultWire,
  PreviewGatekeeperResyncResultWire,
  RefreshOperationGovernanceResultWire,
} from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { actionKindTagText } from '../../lib/format.js';
import { operationKey, revisionDraftKey } from '../../lib/governance.js';
import { useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { NoticeErrorBody } from '../kit/inline-error.js';
import { Notice } from '../kit/notice.js';
import { AwaitingAdoptionNotice } from './DefinitionDrift.js';
import { gateOwnedParamsNextStep, gateOwnedParamsText } from './GateOwnedParams.js';
import {
  type GovernanceChangeItem,
  GovernanceChangeList,
  governanceChangeSummary,
  governanceConsequences,
  governanceFieldsText,
  isLoosening,
} from './GovernanceChange.js';

export interface RefreshOperationGovernanceConfirmProps {
  readonly http: CapabilityCaller;
  /** The workspace's own Gatekeeper Object id — `refresh_operation_governance`'s target (not the
   *  platform `gateId` below; see that capability's own doc comment on the two ids). */
  readonly gatekeeperId: string;
  /** The platform gate instance id `preview_gate_instance_enable` reads its announced manifest
   *  from — known once this Gatekeeper is linked to a platform-catalog instance. Omitted for a gate
   *  the workspace connected itself (legacy 214): the preview is then `preview_gatekeeper_resync`,
   *  which asks the gate what it runs now, and the same `refresh_operation_governance` opens the
   *  revisions — and imports what the gate describes that the workspace never had. */
  readonly platformGateId?: string;
  readonly gateDisplayName: string;
  /** A refresh (even a no-op one — `unchanged` non-empty, `refreshed` empty) succeeded; the caller
   *  reloads whatever it derives from Operation governance fields (readiness's per-mode counts,
   *  the catalog list) — same "full result, caller's own reload" split `EnableGateConfirm` uses. */
  readonly onRefreshed: (result: RefreshOperationGovernanceResultWire) => void;
  /** `session.user?.platformRole === 'admin'` — when the gate's new manifest still waits for the
   *  platform, the notice links a platform admin to it (UX acceptance of #538). */
  readonly platformAdmin?: boolean;
  /** Narrows the align to these Operation names (the catalog's one held draft); omitted aligns
   *  everything that drifts. */
  readonly operationNames?: readonly string[];
  /** Trigger label override — defaults to 与门公告对齐 (a platform gate) or 重新读取门的清单 (a
   *  gate the workspace connected itself). */
  readonly label?: string;
  /** Legacy 280 (acceptance of #571 P3-1): the preview the caller already read for this gate, used
   *  for the confirm instead of reading it again on the click. The kernel still refuses the write
   *  with `manifest_changed` when the gate's manifest moved since (the confirm sends this
   *  preview's `manifestDigest`), so a stale one is never applied unseen. First open only: after a
   *  write is sent under its digest, reopening reads the preview again. */
  readonly preview?: PreviewGateInstanceEnableResultWire | PreviewGatekeeperResyncResultWire;
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
 *
 * **Adopting comes first** (UX acceptance of #538): while the platform has not adopted the gate's
 * new manifest, the gate already runs it but this preview still reads the manifest in effect, so
 * there is nothing to align yet — and saying 「已一致」 would leave the reader stuck while every
 * call is refused. The preview's `awaitingPlatformAdoption` names those Operations; this says the
 * platform admin has to adopt it first (`AwaitingAdoptionNotice`), never 「已一致」.
 *
 * **A draft held back for a gate-owned param is reached too** (console G4, legacy 219): a bulk
 * publish leaves the gate's own draft unpublished when it declares a param only the gate sets. Once
 * the gate's manifest drops it, the preview marks that draft `pendingDraft.rewritable` (the kernel's
 * own judgment) and the align rewrites it to the new announcement — still a draft, published in the
 * catalog. While the gate still announces the param, the draft is not rewritable and this says so
 * instead of 「已一致」.
 */
/**
 * Legacy 345 (review #493 on #612): the align opens a revision only above a *published* version
 * (`refreshOperationGovernance`), so on a deprecated Operation nothing that would ride one is
 * written — not a loosening the kernel holds for a revision (`governanceByRevision`), not a changed
 * definition. Only a tightening applies to it, in place. Such a row is listed only for what the
 * align actually does to it, never as 「将打开修订」.
 */
function alignableOnDeprecated(
  op: GateInstanceEnablePreviewOperationPresentWire,
): GateInstanceEnablePreviewOperationPresentWire {
  if (op.existing.status !== 'deprecated') return op;
  return {
    ...op,
    differs: op.differs && op.governanceByRevision !== true,
    definitionDiffers: false,
  };
}

/** Legacy 391 (UX acceptance of #640): what `alignableOnDeprecated` leaves out of a deprecated row — a
 *  loosening or a changed definition the align does not write. Named, so 「已一致」 is never said
 *  while the gate still differs from those rows. */
function unwrittenOnDeprecated(op: GateInstanceEnablePreviewOperationPresentWire): boolean {
  return (
    op.existing.status === 'deprecated' &&
    ((op.differs && op.governanceByRevision === true) || op.definitionDiffers)
  );
}

export function RefreshOperationGovernanceConfirm({
  http,
  gatekeeperId,
  platformGateId,
  gateDisplayName,
  onRefreshed,
  platformAdmin = false,
  operationNames,
  label,
  preview: knownPreview,
  testId,
}: RefreshOperationGovernanceConfirmProps) {
  const t = useT();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<unknown | null>(null);
  const [diffs, setDiffs] = useState<
    readonly GateInstanceEnablePreviewOperationPresentWire[] | null
  >(null);
  // Console G4: the gate's own held drafts the announcement now differs from (rewritten by the
  // align), and those it still announces with a gate-owned param (nothing to rewrite yet).
  const [heldDrafts, setHeldDrafts] = useState<readonly string[]>([]);
  const [stuckDrafts, setStuckDrafts] = useState<readonly GateInstanceEnablePreviewOperationWire[]>(
    [],
  );
  const [rewrittenNames, setRewrittenNames] = useState<ReadonlySet<string>>(new Set());
  // UX acceptance of #573 P2 / review #501 on #573: the drafts this align opens or rewrites that
  // will still declare a gate-owned param — they stay unpublishable, so nothing here promises the
  // calls come back once they are published. Name → the params, kept past the confirm so the
  // result can say it too.
  const [stillHeld, setStillHeld] = useState<ReadonlyMap<string, readonly GateOwnedParamWire[]>>(
    new Map(),
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [alignedNotice, setAlignedNotice] = useState(false);
  const [awaitingAdoption, setAwaitingAdoption] =
    useState<PreviewGateInstanceEnableResultWire['awaitingPlatformAdoption']>(null);
  const [manifestDigest, setManifestDigest] = useState<string | null>(null);
  // Review #501 on #577 ①: the caller's preview serves the first open only. Once a write was sent
  // under its digest — applied, or refused with `manifest_changed` — it no longer describes the
  // gate, so reopening reads the preview afresh instead of being refused on the same digest again.
  const [knownPreviewSpent, setKnownPreviewSpent] = useState(false);
  // Which previewed rows are published — a revision draft of one is its own catalog row.
  const [publishedNames, setPublishedNames] = useState<ReadonlySet<string>>(new Set());
  // What the manifest names that the workspace never had — the resync (legacy 214) or the align
  // (P0b, #612 P2) imports it as a draft — and published Operations a self-connected gate no
  // longer describes.
  const [newNames, setNewNames] = useState<readonly string[]>([]);
  // UX acceptance of #612 (P2-2): what each new Operation would be allowed to do once published.
  const [newFields, setNewFields] = useState<ReadonlyMap<string, OperationGovernanceFieldsWire>>(
    new Map(),
  );
  const [importedNames, setImportedNames] = useState<ReadonlySet<string>>(new Set());
  const [notDescribed, setNotDescribed] = useState<readonly string[]>([]);
  const [deprecatedUnwritten, setDeprecatedUnwritten] = useState<readonly string[]>([]);
  // Review #493 on #612 (M1): the revisions this resync opened only to carry a loosening the gate
  // describes (its definition did not change) — kept past the confirm so the result says what
  // publishing them changes instead of "the gate refuses calls until then", which is not so.
  const [loosenedOnlyNames, setLoosenedOnlyNames] = useState<ReadonlySet<string>>(new Set());
  const self = platformGateId === undefined;
  // The same sentence for both sources, naming where the manifest comes from: a platform gate's
  // announcement (adopted by the platform) or what a self-connected gate describes it runs.
  const source = (platform: [string, string], own: [string, string]) =>
    self ? t(own[0], own[1]) : t(platform[0], platform[1]);
  // UX acceptance of #612 (P2-1): one verb per flow — the button says 同步 for a self-connected
  // gate, so nothing in its confirm or result says 对齐.
  const verbZh = self ? '同步' : '对齐';
  const verbEn = self ? 'Syncing' : 'Aligning';
  // Who has to act before a param only the gate sets goes away.
  const heldUntil = source(
    [
      '门的维护者去掉这些参数、平台采用改好的清单之前',
      'until the gate’s maintainer drops those params and the platform adopts the corrected manifest',
    ],
    [
      '门的维护者从门的清单里去掉这些参数、重启门之前',
      'until the gate’s maintainer drops those params from its manifest and restarts it',
    ],
  );
  // Applied in place: everything a platform manifest changes, and what a self-connected gate
  // tightens. Review #493 on #612 (M1): what a self-connected gate loosens is the kernel's
  // `governanceByRevision` — carried by a revision draft, live only once it is published.
  const items = (diffs ?? [])
    .filter((op) => op.differs && op.governanceByRevision !== true)
    .map(changeItem);
  const byRevision = (diffs ?? [])
    .filter(
      (op) =>
        op.differs && op.governanceByRevision === true && (op.gateOwnedParams?.length ?? 0) === 0,
    )
    .map(changeItem);
  const byRevisionNames = new Set(byRevision.map((item) => item.name));
  const heldRevisions = (diffs ?? []).filter(
    (op) => op.definitionDiffers && (op.gateOwnedParams?.length ?? 0) > 0,
  );
  const redefined = (diffs ?? [])
    .filter(
      (op) =>
        op.definitionDiffers &&
        (op.gateOwnedParams?.length ?? 0) === 0 &&
        !byRevisionNames.has(op.name),
    )
    .map((op) => op.name);
  const heldNames = (names: readonly string[]) => names.filter((name) => stillHeld.has(name));
  const freeNames = (names: readonly string[]) => names.filter((name) => !stillHeld.has(name));
  const heldText = (name: string) => gateOwnedParamsText(stillHeld.get(name) ?? [], t);
  const newFieldsText = (name: string) => {
    const fields = newFields.get(name);
    return fields ? governanceFieldsText(fields, t) : '';
  };
  // R-19 (D-17): the kernel's direction decides the danger case; the consequences say what it means.
  const consequences = items.flatMap((item) => governanceConsequences(item, t));
  const loosens = items.some((item) => isLoosening(item.direction));
  // What publishing the revisions that carry a loosening would change — said now, not after.
  const byRevisionConsequences = byRevision.flatMap((item) => governanceConsequences(item, t));
  // UX re-check of #612 (legacy 346): what a self-connected gate loosens opens a revision
  // (`byRevision`), so what its sync writes in place is only what the gate tightens — the
  // description says 「就地」 of those names alone, and that the loosened ones wait for their
  // revision. (`loosens` cannot hold here; if a kernel ever sent one, the general wording stays.)
  // The general wording (a platform manifest, applied as a whole, loosenings included) says
  // 「直接改写」, not 「就地」: 「就地」 is kept for the self-connected sentence above, where it can
  // only mean a tightening.
  const tagList = (list: readonly GovernanceChangeItem[], separator: string) =>
    list.map((item) => actionKindTagText(item.name)).join(separator);
  const tightensInPlace = self && !loosens;
  const tightenedInPlaceText = `${t(
    `按门现在描述的模式 / 影响级 / 是否可自动批准，就地收紧 ${tagList(items, '、')} 的治理字段（不产生新版本），同步后立即生效。这决定它们要不要人工审批。`,
    `Tightens the mode / blast radius / auto-approvable of ${tagList(items, ', ')} in place, to what the gate describes now (no new Operation version), effective once synced. This decides whether they need a person’s approval.`,
  )}${
    byRevision.length > 0
      ? t(
          `门放宽的 ${tagList(byRevision, '、')} 不就地改：只打开修订草稿，发布后才生效。`,
          ` What the gate loosens — ${tagList(byRevision, ', ')} — is not changed in place: it only opens revision drafts, which take effect once published.`,
        )
      : ''
  }`;
  const [lastResult, setLastResult] = useState<RefreshOperationGovernanceResultWire | null>(null);
  const revisions = (lastResult?.revisionDrafts ?? []).filter(
    (draft) =>
      !rewrittenNames.has(draft.name) &&
      !importedNames.has(draft.name) &&
      !loosenedOnlyNames.has(draft.name) &&
      !stillHeld.has(draft.name),
  );
  const loosenedRevisions = (lastResult?.revisionDrafts ?? []).filter(
    (draft) => loosenedOnlyNames.has(draft.name) && !stillHeld.has(draft.name),
  );
  const imported = (lastResult?.revisionDrafts ?? []).filter(
    (draft) => importedNames.has(draft.name) && !stillHeld.has(draft.name),
  );
  const rewritten = (lastResult?.revisionDrafts ?? []).filter(
    (draft) => rewrittenNames.has(draft.name) && !stillHeld.has(draft.name),
  );
  const heldResults = (lastResult?.revisionDrafts ?? []).filter((draft) =>
    stillHeld.has(draft.name),
  );

  async function loadPreviewAndOpen(): Promise<void> {
    if (checking) return;
    setChecking(true);
    setCheckError(null);
    setAlignedNotice(false);
    setAwaitingAdoption(null);
    setLastResult(null);
    setStuckDrafts([]);
    setStillHeld(new Map());
    setNotDescribed([]);
    setDeprecatedUnwritten([]);
    try {
      const preview =
        (knownPreviewSpent ? undefined : knownPreview) ??
        (platformGateId === undefined
          ? await http.call<PreviewGatekeeperResyncResultWire>('preview_gatekeeper_resync', {
              gatekeeperId,
            })
          : await http.call<PreviewGateInstanceEnableResultWire>('preview_gate_instance_enable', {
              gateId: platformGateId,
            }));
      const inScope = (name: string) =>
        operationNames === undefined || operationNames.includes(name);
      const adoption =
        'awaitingPlatformAdoption' in preview ? preview.awaitingPlatformAdoption : null;
      // UX acceptance of #583 (P3-2): the align opens no revision for an Operation the gate no
      // longer runs (the kernel's `droppedByGate`; its held draft is not `rewritable` either) —
      // adopting removes it, so nothing here offers a revision to publish for it.
      const dropped = new Set(adoption?.dropped ?? []);
      // Legacy K (G1): a definition-only change drifts as well — "already aligned" would leave the
      // gate refusing those Operations with no way to open the revision that fixes it.
      const present = preview.operationsAlreadyPresent.map((op) =>
        dropped.has(op.name) ? { ...op, definitionDiffers: false } : op,
      );
      const drifting = present
        .map(alignableOnDeprecated)
        .filter((op) => (op.differs || op.definitionDiffers) && inScope(op.name));
      setDiffs(drifting);
      setDeprecatedUnwritten(
        present.filter((op) => unwrittenOnDeprecated(op) && inScope(op.name)).map((op) => op.name),
      );
      const pending = preview.operationsToImport.filter(
        (op) => op.pendingDraft !== undefined && inScope(op.name),
      );
      const held = pending.filter((op) => op.pendingDraft?.rewritable).map((op) => op.name);
      setHeldDrafts(held);
      // What the manifest names that this Gatekeeper never had is imported as a draft, never
      // published here: legacy 214, what a self-connected gate describes now; P0b (#612 P2), what
      // the platform adopted for a catalog gate after this workspace enabled it. A name the gate no
      // longer runs (`dropped`) is not imported — the kernel skips it too.
      const fresh = preview.operationsToImport.filter(
        (op) => op.pendingDraft === undefined && !dropped.has(op.name) && inScope(op.name),
      );
      setNewNames(fresh.map((op) => op.name));
      setNewFields(
        new Map(
          fresh.map((op) => [
            op.name,
            { mode: op.mode, blastRadius: op.blastRadius, autoApprovable: op.autoApprovable },
          ]),
        ),
      );
      setNotDescribed(
        'notDescribed' in preview ? preview.notDescribed.filter((name) => inScope(name)) : [],
      );
      setStillHeld(
        new Map([
          ...drifting
            .filter((op) => op.definitionDiffers && (op.gateOwnedParams?.length ?? 0) > 0)
            .map((op) => [op.name, op.gateOwnedParams ?? []] as const),
          ...pending
            .filter((op) => op.pendingDraft?.rewritable && (op.gateOwnedParams?.length ?? 0) > 0)
            .map((op) => [op.name, op.gateOwnedParams ?? []] as const),
          ...fresh
            .filter((op) => (op.gateOwnedParams?.length ?? 0) > 0)
            .map((op) => [op.name, op.gateOwnedParams ?? []] as const),
        ]),
      );
      // Only the gate's own drafts wait on the gate: a proposal is never rewritten, so it is not
      // said to be waiting for the manifest to change (review #501 on #571 ①).
      const stuck = pending.filter(
        (op) =>
          !dropped.has(op.name) &&
          !op.pendingDraft?.rewritable &&
          op.pendingDraft?.fromGate !== false &&
          (op.gateOwnedParams?.length ?? 0) > 0,
      );
      setPublishedNames(
        new Set(
          preview.operationsAlreadyPresent
            .filter((op) => op.existing.status === 'published')
            .map((op) => op.name),
        ),
      );
      setManifestDigest(preview.manifestDigest);
      const awaiting = adoption ?? null;
      setAwaitingAdoption(awaiting);
      if (drifting.length > 0 || held.length > 0 || fresh.length > 0) setConfirmOpen(true);
      else if (stuck.length > 0) setStuckDrafts(stuck);
      else if (awaiting === null) setAlignedNotice(true);
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
    setKnownPreviewSpent(true);
    const result = await http.call<RefreshOperationGovernanceResultWire>(
      'refresh_operation_governance',
      {
        gatekeeperId,
        operationNames: [...diffs.map((op) => op.name), ...heldDrafts, ...newNames],
        manifestDigest,
      },
    );
    setRewrittenNames(new Set(heldDrafts));
    setImportedNames(new Set(newNames));
    setLoosenedOnlyNames(
      new Set(
        diffs
          .filter(
            (op) =>
              op.differs &&
              op.governanceByRevision === true &&
              !op.definitionDiffers &&
              (op.gateOwnedParams?.length ?? 0) === 0,
          )
          .map((op) => op.name),
      ),
    );
    setLastResult(result);
    setDiffs(null);
    setHeldDrafts([]);
    setNewNames([]);
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
      {label ??
        source(
          ['与门公告对齐', "Align with the gate's announcement"],
          ['重新读取门的清单', 'Re-read the gate’s manifest'],
        )}
    </Button>
  );

  return (
    <div className="stack-s" data-testid={testId ? `${testId}-wrapper` : undefined}>
      {checkError !== null ? (
        <Notice tone="warn" testId={testId ? `${testId}-check-error` : undefined}>
          {source(
            ['读不到公告差异：', 'Could not load the announcement diff: '],
            ['读不到门的清单：', 'Could not read the gate’s manifest: '],
          )}
          <NoticeErrorBody error={checkError} />
        </Notice>
      ) : null}
      {awaitingAdoption !== null && !confirmOpen ? (
        <AwaitingAdoptionNotice
          operations={awaitingAdoption.operations}
          dropped={awaitingAdoption.dropped}
          announcedAt={awaitingAdoption.announcedAt}
          platformAdmin={platformAdmin}
          platformGateId={platformGateId}
          testId={testId ? `${testId}-awaiting-adoption` : undefined}
        />
      ) : null}
      {deprecatedUnwritten.length > 0 && !confirmOpen ? (
        <DeprecatedUnwrittenNotice
          names={deprecatedUnwritten}
          testId={testId ? `${testId}-deprecated-unwritten` : undefined}
        />
      ) : null}
      {alignedNotice && deprecatedUnwritten.length === 0 ? (
        <Notice testId={testId ? `${testId}-aligned` : undefined}>
          {source(
            [
              '已与门的公告一致，没有需要对齐的字段。',
              "Already matches the gate's announcement — nothing to align.",
            ],
            [
              '已与门当前运行的清单一致，没有要打开的修订。',
              'Already matches what the gate runs now — no revision to open.',
            ],
          )}
        </Notice>
      ) : null}
      {notDescribed.length > 0 && !confirmOpen ? (
        <NotDescribedNotice
          names={notDescribed}
          testId={testId ? `${testId}-not-described` : undefined}
        />
      ) : null}
      {stuckDrafts.length > 0 ? (
        <Notice tone="warn" testId={testId ? `${testId}-held` : undefined}>
          <span className="stack-s">
            <span>
              {t(
                '门的清单还没改：下面的草稿仍声明只能由门自己设置的参数，没有可重写的内容，也发布不了。',
                'The gate’s manifest has not changed yet: these drafts still declare params only the gate sets, so there is nothing to rewrite and they cannot be published.',
              )}
            </span>
            <ul className="stack-s" style={{ margin: 0, paddingLeft: '1.2em' }}>
              {stuckDrafts.map((op) => (
                <li key={op.name}>
                  <span className="mono">{actionKindTagText(op.name)}</span>
                  {t('：', ': ')}
                  {gateOwnedParamsText(op.gateOwnedParams ?? [], t)}
                </li>
              ))}
            </ul>
            <span className="text-3">{gateOwnedParamsNextStep(self ? 'resync' : 'align', t)}</span>
          </span>
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
                  `已${verbZh} ${lastResult.refreshed.length} 个 Operation${
                    lastResult.unchanged.length > 0
                      ? `，${lastResult.unchanged.length} 个未变化`
                      : ''
                  }。`,
                  `${self ? 'Synced' : 'Aligned'} ${lastResult.refreshed.length} operation(s)${
                    lastResult.unchanged.length > 0
                      ? `, ${lastResult.unchanged.length} unchanged`
                      : ''
                  }.`,
                )}
              </span>
            ) : null}
            {imported.length > 0 ? (
              <div className="stack-s" data-testid={testId ? `${testId}-imported` : undefined}>
                <span>
                  {source(
                    [
                      `已把平台采用的清单新增的 ${imported.length} 个 Operation 导入为草稿。到能力目录核对后发布：`,
                      `Imported ${imported.length} operation(s) new in the manifest the platform adopted as drafts. Check them in the catalog, then publish:`,
                    ],
                    [
                      `已把门新增的 ${imported.length} 个 Operation 导入为草稿。到能力目录核对后发布：`,
                      `Imported ${imported.length} operation(s) the gate now provides as drafts. Check them in the catalog, then publish:`,
                    ],
                  )}
                </span>
                <ul className="stack-s" style={{ margin: 0, paddingLeft: '1.2em' }}>
                  {imported.map((draft) => (
                    <li key={draft.name} className="row-wrap">
                      <span className="mono">{actionKindTagText(draft.name)}</span>
                      <a
                        href={hrefs.catalog(
                          'operations',
                          operationKey({ gatekeeperId, name: draft.name }),
                        )}
                        data-testid={testId ? `${testId}-imported-link` : undefined}
                      >
                        {t('去能力目录发布', 'Publish in the catalog')}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {revisions.length > 0 ? (
              <div className="stack-s" data-testid={testId ? `${testId}-drafts` : undefined}>
                <span>
                  {t(
                    `已为 ${revisions.length} 个 Operation 打开修订草稿。发布之前，门会拒绝对它们的调用——到能力目录核对改了什么，再发布：`,
                    `Opened a revision draft for ${revisions.length} operation(s). The gate refuses calls to them until it is published — check what changed in the catalog, then publish it:`,
                  )}
                </span>
                <ul className="stack-s" style={{ margin: 0, paddingLeft: '1.2em' }}>
                  {revisions.map((draft) => {
                    const row = { gatekeeperId, name: draft.name };
                    const key = publishedNames.has(draft.name)
                      ? revisionDraftKey(row)
                      : operationKey(row);
                    return (
                      <li key={draft.name} className="row-wrap">
                        <span className="mono">{actionKindTagText(draft.name)}</span>
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
            {loosenedRevisions.length > 0 ? (
              <div
                className="stack-s"
                data-testid={testId ? `${testId}-loosened-drafts` : undefined}
              >
                <span>
                  {t(
                    `门放宽了 ${loosenedRevisions.length} 个 Operation 的治理字段，已为它们打开修订草稿。已发布的版本没有变，审批要求照旧；到能力目录核对后再决定是否发布：`,
                    `The gate loosened the governance of ${loosenedRevisions.length} operation(s); a revision draft carries it. The published versions are unchanged and keep their approval requirements — check the drafts in the catalog before deciding whether to publish:`,
                  )}
                </span>
                <ul className="stack-s" style={{ margin: 0, paddingLeft: '1.2em' }}>
                  {loosenedRevisions.map((draft) => (
                    <li key={draft.name} className="row-wrap">
                      <span className="mono">{actionKindTagText(draft.name)}</span>
                      <span>{t(`修订 v${draft.version}`, `revision v${draft.version}`)}</span>
                      <a
                        href={hrefs.catalog(
                          'operations',
                          revisionDraftKey({ gatekeeperId, name: draft.name }),
                        )}
                        data-testid={testId ? `${testId}-loosened-draft-link` : undefined}
                      >
                        {t('去能力目录核对', 'Review in the catalog')}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {rewritten.length > 0 ? (
              <div className="stack-s" data-testid={testId ? `${testId}-rewritten` : undefined}>
                <span>
                  {t(
                    `已按门的新清单重写 ${rewritten.length} 份待发布的草稿。到能力目录核对后发布：`,
                    `Rewrote ${rewritten.length} pending draft(s) to the gate’s new manifest. Check them in the catalog, then publish:`,
                  )}
                </span>
                <ul className="stack-s" style={{ margin: 0, paddingLeft: '1.2em' }}>
                  {rewritten.map((draft) => {
                    const row = { gatekeeperId, name: draft.name };
                    const key = publishedNames.has(draft.name)
                      ? revisionDraftKey(row)
                      : operationKey(row);
                    return (
                      <li key={draft.name} className="row-wrap">
                        <span className="mono">{actionKindTagText(draft.name)}</span>
                        <a
                          href={hrefs.catalog('operations', key)}
                          data-testid={testId ? `${testId}-rewritten-link` : undefined}
                        >
                          {t('去能力目录发布', 'Publish in the catalog')}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
            {heldResults.length > 0 ? (
              <div className="stack-s" data-testid={testId ? `${testId}-held-drafts` : undefined}>
                <span>
                  {t(
                    `${heldResults.length} 份草稿已按门的清单打开或重写，但仍声明只能由门自己设置的参数，发布不了：${heldUntil}，对它们的调用不会恢复。`,
                    `${heldResults.length} draft(s) were opened or rewritten from the gate’s manifest but still declare params only the gate sets, so they cannot be published: calls to them do not resume ${heldUntil}.`,
                  )}
                </span>
                <ul className="stack-s" style={{ margin: 0, paddingLeft: '1.2em' }}>
                  {heldResults.map((draft) => {
                    const row = { gatekeeperId, name: draft.name };
                    const key = publishedNames.has(draft.name)
                      ? revisionDraftKey(row)
                      : operationKey(row);
                    return (
                      <li key={draft.name} className="row-wrap">
                        <span className="mono">{actionKindTagText(draft.name)}</span>
                        <span>{heldText(draft.name)}</span>
                        <a
                          href={hrefs.catalog('operations', key)}
                          data-testid={testId ? `${testId}-held-draft-link` : undefined}
                        >
                          {t('去能力目录看说明', 'See it in the catalog')}
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
        title={source(
          ['与门公告对齐', "Align with the gate's announcement"],
          ['按门的清单同步', 'Sync with the gate’s manifest'],
        )}
        description={
          // A definition-only change is said once, by the notice below (UX acceptance of #538).
          items.length > 0 && tightensInPlace
            ? tightenedInPlaceText
            : items.length > 0
              ? source(
                  [
                    '按门当前生效清单的模式 / 影响级 / 是否可自动批准，直接改写下列已发布 Operation 的治理字段（不产生新版本，确认后立即生效）。这决定它们要不要人工审批；改为只读调用的 Operation 也不再需要授权。',
                    'Rewrites the mode / blast radius / auto-approvable of the published operations below to the manifest in effect (no new Operation version; effective once confirmed). This decides whether they need a person’s approval — and an operation that becomes an observe call no longer needs a grant either.',
                  ],
                  [
                    '按门现在描述的模式 / 影响级 / 是否可自动批准，直接改写下列已发布 Operation 的治理字段（不产生新版本，确认后立即生效）。这决定它们要不要人工审批；改为只读调用的 Operation 也不再需要授权。',
                    'Rewrites the mode / blast radius / auto-approvable of the published operations below to what the gate describes now (no new Operation version; effective once confirmed). This decides whether they need a person’s approval — and an operation that becomes an observe call no longer needs a grant either.',
                  ],
                )
              : undefined
        }
        target={gateDisplayName}
        impact={[
          ...items.map((item) => governanceChangeSummary(item, t)),
          ...byRevision.map((item) =>
            t(
              `${governanceChangeSummary(item, t)}（门放宽了，不就地改：打开修订草稿，发布后才生效）`,
              `${governanceChangeSummary(item, t)} (loosened by the gate — not applied in place: opens a revision draft that takes effect once published)`,
            ),
          ),
          ...redefined.map((name) =>
            t(
              `${actionKindTagText(name)}：门运行的定义变了，打开修订草稿`,
              `${actionKindTagText(name)}: the definition the gate runs changed — opens a revision draft`,
            ),
          ),
          // Review #501 on #571 ③: a revision whose new definition declares a gate-owned param
          // stays a draft — said here, before the align opens it.
          ...heldRevisions.map((op) =>
            t(
              `${actionKindTagText(op.name)}：打开的修订发布不了，新定义声明了只能由门自己设置的参数 ${gateOwnedParamsText(op.gateOwnedParams ?? [], t)}`,
              `${actionKindTagText(op.name)}: the revision it opens cannot be published — the new definition declares params only the gate sets, ${gateOwnedParamsText(op.gateOwnedParams ?? [], t)}`,
            ),
          ),
          ...freeNames(heldDrafts).map((name) =>
            t(
              `${actionKindTagText(name)}：门的清单改了，按新清单重写待发布的草稿`,
              `${actionKindTagText(name)}: the gate’s manifest changed — rewrites the pending draft to it`,
            ),
          ),
          // Review #501 on #573: the gate changed something else but still declares the param —
          // the rewrite still runs, and the draft still cannot be published.
          ...heldNames(heldDrafts).map((name) =>
            t(
              `${actionKindTagText(name)}：门的清单改了，按新清单重写待发布的草稿；新清单仍声明只能由门自己设置的参数 ${heldText(name)}，重写后仍发布不了`,
              `${actionKindTagText(name)}: the gate’s manifest changed — rewrites the pending draft to it; the new manifest still declares params only the gate sets, ${heldText(name)}, so it still cannot be published`,
            ),
          ),
          // Legacy 214 / P0b (#612 P2): what the manifest now names and the workspace never had.
          ...freeNames(newNames).map((name) =>
            source(
              [
                `${actionKindTagText(name)}：平台采用的清单新增的 Operation（${newFieldsText(name)}），导入为草稿，发布后才能调用`,
                `${actionKindTagText(name)}: new in the manifest the platform adopted (${newFieldsText(name)}) — imported as a draft, callable once published`,
              ],
              [
                `${actionKindTagText(name)}：门新增的 Operation（${newFieldsText(name)}），导入为草稿`,
                `${actionKindTagText(name)}: new on the gate (${newFieldsText(name)}) — imported as a draft`,
              ],
            ),
          ),
          ...heldNames(newNames).map((name) =>
            source(
              [
                `${actionKindTagText(name)}：平台采用的清单新增的 Operation（${newFieldsText(name)}），导入为草稿；它声明了只能由门自己设置的参数 ${heldText(name)}，导入后发布不了`,
                `${actionKindTagText(name)}: new in the manifest the platform adopted — imported as a draft; it declares params only the gate sets, ${heldText(name)}, so it cannot be published`,
              ],
              [
                `${actionKindTagText(name)}：门新增的 Operation（${newFieldsText(name)}），导入为草稿；它声明了只能由门自己设置的参数 ${heldText(name)}，导入后发布不了`,
                `${actionKindTagText(name)}: new on the gate — imported as a draft; it declares params only the gate sets, ${heldText(name)}, so it cannot be published`,
              ],
            ),
          ),
        ]}
        confirmLabel={source(['对齐', 'Align'], ['同步', 'Sync'])}
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
        {byRevision.length > 0 ? (
          <Notice tone="warn" testId={testId ? `${testId}-loosens-by-revision` : undefined}>
            <span className="stack-s">
              <span>
                {t(
                  `门放宽了这些 Operation 的治理字段：${byRevision.map((item) => actionKindTagText(item.name)).join('、')}。门的描述没有人审过，所以同步不会就地放宽：已发布的版本保持现在的审批要求，同步只打开修订草稿，到能力目录核对后由你决定是否发布。`,
                  `The gate loosened the governance of: ${byRevision.map((item) => actionKindTagText(item.name)).join(', ')}. Nobody reviewed the gate’s description, so syncing does not loosen anything in place: the published versions keep their approval requirements, and syncing only opens revision drafts for you to check and decide on in the catalog.`,
                )}
              </span>
              {byRevisionConsequences.length > 0 ? (
                <>
                  <span>{t('发布这些修订之后：', 'Once those revisions are published:')}</span>
                  <ul className="stack-s" style={{ margin: 0, paddingLeft: '1.2em' }}>
                    {byRevisionConsequences.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </span>
          </Notice>
        ) : null}
        {heldRevisions.length > 0 ? (
          <Notice tone="warn" testId={testId ? `${testId}-redefined-held` : undefined}>
            {t(
              `门运行的新定义声明了只能由门自己设置的参数：${heldRevisions.map((op) => actionKindTagText(op.name)).join('、')}。${verbZh}为它们打开的修订发布不了；${heldUntil}，门会一直拒绝对它们的调用。`,
              `The new definition the gate runs declares params only the gate sets: ${heldRevisions.map((op) => actionKindTagText(op.name)).join(', ')}. The revisions ${verbEn.toLowerCase()} opens for them cannot be published; the gate keeps refusing calls to them ${heldUntil}.`,
            )}
          </Notice>
        ) : null}
        {redefined.length > 0 ? (
          <Notice tone="warn" testId={testId ? `${testId}-redefined` : undefined}>
            {t(
              `门运行的定义（绑定、参数或结果映射）已经变了：${redefined.join('、')}。${verbZh}只会为它们打开修订草稿；在你到能力目录发布修订之前，门会拒绝对它们的调用。`,
              `The definition the gate runs (binding, params or result mapping) has changed: ${redefined.join(', ')}. ${verbEn} only opens a revision draft for each; the gate refuses calls to them until you publish it in the catalog.`,
            )}
          </Notice>
        ) : null}
        {freeNames(heldDrafts).length > 0 ? (
          <Notice testId={testId ? `${testId}-rewrites` : undefined}>
            {t(
              `门的清单已经改了：${freeNames(heldDrafts).join('、')}。${verbZh}会按新清单重写这些还没发布的草稿，不会发布它们；之后到能力目录核对再发布。`,
              `The gate’s manifest has changed: ${freeNames(heldDrafts).join(', ')}. ${verbEn} rewrites these unpublished drafts to it without publishing them; check and publish them in the catalog afterwards.`,
            )}
          </Notice>
        ) : null}
        {awaitingAdoption !== null ? (
          <AwaitingAdoptionNotice
            operations={awaitingAdoption.operations}
            dropped={awaitingAdoption.dropped}
            announcedAt={awaitingAdoption.announcedAt}
            platformAdmin={platformAdmin}
            platformGateId={platformGateId}
            testId={testId ? `${testId}-confirm-awaiting-adoption` : undefined}
          />
        ) : null}
        {notDescribed.length > 0 ? (
          <NotDescribedNotice
            names={notDescribed}
            testId={testId ? `${testId}-confirm-not-described` : undefined}
          />
        ) : null}
        {deprecatedUnwritten.length > 0 ? (
          <DeprecatedUnwrittenNotice
            names={deprecatedUnwritten}
            testId={testId ? `${testId}-confirm-deprecated-unwritten` : undefined}
          />
        ) : null}
        {items.length > 0 ? <GovernanceChangeList items={items} /> : null}
      </Confirm>
    </div>
  );
}

/** Legacy 214: published Operations a self-connected gate no longer describes. The gate refuses
 *  calls to them and the resync writes nothing for them — deprecating them is the catalog's call. */
function NotDescribedNotice({
  names,
  testId,
}: {
  readonly names: readonly string[];
  readonly testId?: string;
}) {
  const t = useT();
  const shown = names.map((name) => actionKindTagText(name));
  return (
    <Notice tone="warn" testId={testId}>
      {t(
        `门已不再提供这些已发布的 Operation：${shown.join('、')}。对它们的调用会被门拒绝，同步不会改动它们；不再需要的话，到能力目录弃用。`,
        `The gate no longer provides these published operations: ${shown.join(', ')}. The gate refuses calls to them and syncing leaves them as they are; deprecate them in the catalog if they are no longer needed.`,
      )}
      {t('', ' ')}
      <a href={hrefs.catalog('operations')}>{t('去能力目录', 'Open the catalog')}</a>
    </Notice>
  );
}

/** Legacy 391 (UX acceptance of #640): a loosening or a changed definition on a deprecated Operation. No
 *  revision opens above a deprecated version, so the align writes none of it and the row stays
 *  deprecated — said, rather than 「已一致」. */
function DeprecatedUnwrittenNotice({
  names,
  testId,
}: {
  readonly names: readonly string[];
  readonly testId?: string;
}) {
  const t = useT();
  const shown = names.map((name) => actionKindTagText(name));
  return (
    <Notice testId={testId}>
      {t(
        `门对这些已弃用的 Operation 放宽了治理字段或改了运行的定义：${shown.join('、')}。已弃用的 Operation 不能再改，这些变化不会写入；它们仍是弃用状态，不会被调用。不需要你处理。`,
        `The gate loosened the governance of, or changed the definition it runs for, these deprecated operations: ${shown.join(', ')}. A deprecated operation can no longer change, so none of this is written; they stay deprecated and are not called. Nothing for you to do.`,
      )}
    </Notice>
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
