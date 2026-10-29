import type {
  EnableGateInstanceResultWire,
  GateLinkDriftWire,
  PreviewGateInstanceEnableResultWire,
} from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { actionKindTagText } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { NoticeErrorBody } from '../kit/inline-error.js';
import { Notice } from '../kit/notice.js';
import { RefChip } from '../kit/ref-chip.js';
import { StatusChip } from '../kit/status-chip.js';
import { announceReadinessChange } from '../readiness/useExecutionReadiness.js';
import { AbsentAnswersHeldPreview } from './AbsentAnswerDrafts.js';
import { AwaitingAdoptionNotice } from './DefinitionDrift.js';
import { gateOwnedParamsNextStep, gateOwnedParamsText } from './GateOwnedParams.js';

export interface EnableGateConfirmProps {
  readonly http: CapabilityCaller;
  readonly gateId: string;
  readonly gateDisplayName: string;
  /** Carries the full result (incl. `linkedExisting`, `publishedOperationNames`) so the caller —
   *  already on the legacy `components/ui/*` allowlist — can push its own toast; this file may
   *  not import `components/ui/Toast` (a new `components/kit`-adjacent file, S8 risk ①, same
   *  boundary `kit/confirm`'s own `notify` prop documents). */
  readonly onEnabled: (result: EnableGateInstanceResultWire) => void;
  /** Trigger label override — defaults to 在本工作区启用; a caller offering 重新启用 for a
   *  previously-disabled link passes its own. */
  readonly label?: string;
  /** `session.user?.platformRole === 'admin'` — the notice for a gate whose new manifest still
   *  waits for the platform then links to it (UX acceptance of #538). */
  readonly platformAdmin?: boolean;
  /** Rendered on the trigger button; the confirm popover uses `${testId}-confirm`, the ambiguous
   *  notice `${testId}-ambiguous`. Callers that render one of these per row/gate should also pass
   *  `key={gateId}` at the call site — this component keeps no effect resetting its own state when
   *  `gateId` changes under a stable key. */
  readonly testId?: string;
}

/**
 * components/connect/EnableGateConfirm (S8 W2-U1, audit J3/J4): the medium-tier confirm in front
 * of `enable_gate_instance`, fed by the read-only `preview_gate_instance_enable` (S8 W2-K2). Before
 * this, both call sites (`AvailableGateInstancesSection`'s catalog row and the launcher's
 * `WorkspaceEnableSection`) wrote a Gatekeeper and published its announced Operations — including
 * execute/high-impact ones — the instant the button was clicked, with no preview (J3), and could
 * silently register a duplicate Gatekeeper next to an already-registered one for the same endpoint
 * (J4). Now: click → `preview_gate_instance_enable` loads → `ambiguousCandidates` non-empty blocks
 * the confirm entirely (a real merge/cleanup problem the kernel cannot resolve by guessing, see the
 * notice's own copy) → otherwise a `Confirm` (`kit/confirm`, `tier="medium"`) opens anchored to the
 * button, listing what would be imported/already-present and, when `wouldLink` is set, which
 * Gatekeeper the workspace connected itself this call would claim instead of duplicating. The confirm's own
 * `onConfirm` is the actual `enable_gate_instance` call; success calls `onEnabled` with the full
 * result (`linkedExisting` incl.) so the caller's own toast can report it (J4's own ask).
 */
export function EnableGateConfirm({
  http,
  gateId,
  gateDisplayName,
  onEnabled,
  label,
  platformAdmin = false,
  testId,
}: EnableGateConfirmProps) {
  const t = useT();
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<PreviewGateInstanceEnableResultWire | null>(null);
  const [previewError, setPreviewError] = useState<unknown | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function loadPreviewAndOpen(): Promise<void> {
    if (previewing) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const result = await http.call<PreviewGateInstanceEnableResultWire>(
        'preview_gate_instance_enable',
        { gateId },
      );
      setPreview(result);
      // J4: an ambiguous endpoint match refuses to guess — no confirm renders at all, only the
      // notice below explaining why and where to fix it.
      if (result.ambiguousCandidates.length === 0) setConfirmOpen(true);
    } catch (err) {
      setPreviewError(err);
    } finally {
      setPreviewing(false);
    }
  }

  async function confirmEnable(): Promise<void> {
    // R-18 (D-18): bind the enable to the manifest this preview showed — the kernel refuses
    // `manifest_changed` if an administrator confirmed a newer one in between. A refusal
    // propagates as-is: `kit/confirm` renders it through `presentError` (a known platform code
    // such as connector_not_preset or gate_not_enabled reads as its own copy).
    const result = await http.call<EnableGateInstanceResultWire>('enable_gate_instance', {
      gateId,
      ...(preview?.manifestDigest ? { manifestDigest: preview.manifestDigest } : {}),
    });
    announceReadinessChange(http);
    onEnabled(result);
  }

  const trigger = (
    <Button
      variant="primary"
      size="s"
      onClick={() => void loadPreviewAndOpen()}
      disabled={previewing}
      data-testid={testId}
    >
      {label ?? t('在本工作区启用', 'Enable here')}
    </Button>
  );

  return (
    <div className="stack-s" data-testid={testId ? `${testId}-wrapper` : undefined}>
      {preview && preview.ambiguousCandidates.length > 0 ? (
        <Notice tone="warn" testId={testId ? `${testId}-ambiguous` : undefined}>
          <div className="stack-s">
            <span>
              {t(
                '工作区里有不止一个门与该实例端点相同，无法确定关联哪一个：',
                'More than one Gatekeeper in this workspace shares this endpoint — cannot tell which one to link:',
              )}
            </span>
            <span className="row-wrap">
              {preview.ambiguousCandidates.map((id) => (
                <RefChip key={id} kind="gatekeeper" id={id} http={http} size="s" />
              ))}
            </span>
            <span className="text-3 text-small">
              {t(
                '内核没有撤销 Gatekeeper 的能力——请先在「已注册系统」里核实并清理重复的注册，再重试启用。',
                'The kernel has no way to retire a Gatekeeper — verify and clean up the duplicate registrations in Registered systems first, then try again.',
              )}
            </span>
          </div>
        </Notice>
      ) : null}
      {previewError !== null ? (
        <Notice tone="warn" testId={testId ? `${testId}-preview-error` : undefined}>
          {t('读不到启用预览：', 'Could not load the enable preview: ')}
          {/* L4-13 `gatekeeper_already_linked` (and any other mapped code) reads as its own sentence. */}
          <NoticeErrorBody error={previewError} />
        </Notice>
      ) : null}
      <Confirm
        tier="medium"
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        anchor={trigger}
        title={t('在本工作区启用', 'Enable in this workspace')}
        target={gateDisplayName}
        confirmLabel={
          preview?.wouldLink
            ? t('关联并启用', 'Link and enable')
            : t('注册并启用', 'Register and enable')
        }
        onConfirm={confirmEnable}
        errorOverrides={{
          // Review of #549: an instance stored with a credential in its target is not copied into
          // this workspace; only a platform administrator can recreate it.
          credentials_in_connection_params: t(
            '这个平台门实例的目标地址里带了凭据，没有启用，本工作区也没有写入任何东西。请平台管理员在「集成」里按不带凭据的地址重新创建这个实例。',
            'This platform gate instance’s target carries a credential, so it was not enabled and nothing was written to this workspace. Ask a platform administrator to recreate the instance under Integrations with an address that carries no credential.',
          ),
        }}
        testId={testId ? `${testId}-confirm` : undefined}
      >
        {preview ? (
          <EnablePreviewBody
            preview={preview}
            http={http}
            platformAdmin={platformAdmin}
            testId={testId}
          />
        ) : null}
      </Confirm>
    </div>
  );
}

function EnablePreviewBody({
  preview,
  http,
  platformAdmin,
  testId,
}: {
  readonly preview: PreviewGateInstanceEnableResultWire;
  readonly http: CapabilityCaller;
  readonly platformAdmin: boolean;
  readonly testId?: string;
}) {
  const t = useT();
  // Console G4 (legacy 219): an announced entry declaring a param only the gate sets stays a draft —
  // said here, before the click, not counted among what will be published.
  const heldBack = preview.operationsToImport.filter(
    (operation) => (operation.gateOwnedParams?.length ?? 0) > 0,
  );
  // S11 「门确认不存在」 B-a: so does one declaring answers that mean "does not exist" — a person
  // publishes it in the catalog, confirming them.
  const absentHeld = preview.operationsToImport.flatMap((operation) =>
    (operation.gateOwnedParams?.length ?? 0) === 0 && operation.absentAnswers !== undefined
      ? [{ name: operation.name, absentAnswers: operation.absentAnswers }]
      : [],
  );
  const toPublish = preview.operationsToImport.filter(
    (operation) =>
      (operation.gateOwnedParams?.length ?? 0) === 0 && operation.absentAnswers === undefined,
  );
  const toImportCount = toPublish.length;
  const presentCount = preview.operationsAlreadyPresent.length;
  // Held entries are announced Operations too: only an empty announcement is "none yet".
  const noOperations = preview.operationsToImport.length === 0 && presentCount === 0;
  // Read as absent when a kernel without it answers — never as "awaiting".
  const awaiting = preview.awaitingPlatformAdoption ?? null;
  return (
    <div className="stack-s">
      {awaiting ? (
        <AwaitingAdoptionNotice
          operations={awaiting.operations}
          dropped={awaiting.dropped}
          announcedAt={awaiting.announcedAt}
          platformAdmin={platformAdmin}
          platformGateId={preview.gateId}
          enabling
          testId={testId ? `${testId}-awaiting-adoption` : undefined}
        />
      ) : null}
      {preview.wouldLink ? (
        <div className="stack-s" data-testid="enable-preview-would-link">
          {/* Legacy 371 (#620): the Gatekeeper at this address is one the workspace connected
              itself (a card tagged 「自己接入」 — #612 P2-3: never 「旧注册」). Enabling claims it:
              from then on it comes from this instance and aligns with the platform's announcement,
              not the gate's own manifest (`gatekeeper_linked`). */}
          <span className="text-13">
            {t(
              '这个地址上已有本工作区自己接入的门：',
              'This workspace already connected the gate at this address itself: ',
            )}
            <RefChip kind="gatekeeper" id={preview.wouldLink.gatekeeperId} http={http} size="s" />
            {t(
              '。启用后不新建门，它改由这个平台实例接入：不再是「自己接入」，以后按平台的公告对齐，不再重新读取门的清单。',
              '. Enabling creates no new Gatekeeper — that one comes from this platform instance instead: it is no longer self-connected, and from then on it aligns with the platform’s announcement rather than re-reading the gate’s own manifest.',
            )}
          </span>
          <DriftList drift={preview.wouldLink.drift} />
        </div>
      ) : null}
      {toPublish.length > 0 ? (
        <div className="stack-s" data-testid="enable-preview-import">
          <span className="text-12 font-medium text-text-2">
            {t(`将发布 ${toImportCount} 个 Operation`, `Will publish ${toImportCount}`)}
          </span>
          <ul className="stack-s" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {toPublish.map((operation) => (
              <li key={operation.name} className="row-wrap">
                <span className="mono">{actionKindTagText(operation.name)}</span>
                <StatusChip machine="operationMode" status={operation.mode} size="s" />
                <StatusChip machine="blastRadius" status={operation.blastRadius} size="s" />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {heldBack.length > 0 ? (
        <Notice tone="warn" testId="enable-preview-held">
          <span className="stack-s">
            <span>
              {t(
                `${heldBack.length} 个 Operation 不会发布，只导入为草稿：门的清单给它们声明了只能由门自己设置的参数，门会拒绝带这些参数的每一次调用。`,
                `${heldBack.length} operation(s) will not be published, only imported as drafts: the gate’s manifest declares params on them that only the gate sets, and the gate refuses every call that passes one.`,
              )}
            </span>
            <ul className="stack-s" style={{ margin: 0, paddingLeft: '1.2em' }}>
              {heldBack.map((operation) => (
                <li key={operation.name}>
                  <span className="mono">{actionKindTagText(operation.name)}</span>
                  {t('：', ': ')}
                  {gateOwnedParamsText(operation.gateOwnedParams ?? [], t)}
                </li>
              ))}
            </ul>
            <span className="text-3">{gateOwnedParamsNextStep('align', t)}</span>
          </span>
        </Notice>
      ) : null}
      <AbsentAnswersHeldPreview operations={absentHeld} testId="enable-preview-absent" />
      {preview.operationsAlreadyPresent.length > 0 ? (
        <div className="stack-s" data-testid="enable-preview-present">
          <span className="text-12 font-medium text-text-2">
            {t(`已存在 ${presentCount} 个 Operation`, `${presentCount} operation(s) already there`)}
          </span>
          <ul className="stack-s" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {preview.operationsAlreadyPresent.map((operation) => (
              <li key={operation.name} className="row-wrap">
                <span className="mono">{actionKindTagText(operation.name)}</span>
                <StatusChip machine="publishable" status={operation.existing.status} size="s" />
                {operation.differs ? (
                  <span className="tag" data-testid="enable-preview-differs">
                    {t('治理字段与公告不一致', 'Governance fields differ from the manifest')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {noOperations ? (
        <p className="text-3" data-testid="enable-preview-empty">
          {t(
            '该门实例还没有公布任何操作（Operation）。',
            'This gate instance has not announced any operations yet.',
          )}
        </p>
      ) : null}
    </div>
  );
}

const DRIFT_FIELD_LABEL: Readonly<Record<keyof GateLinkDriftWire, { zh: string; en: string }>> = {
  name: { zh: '名称', en: 'Name' },
  target: { zh: '目标', en: 'Target' },
  transportKind: { zh: '传输类型', en: 'Transport' },
};

function DriftList({ drift }: { readonly drift: GateLinkDriftWire }) {
  const t = useT();
  const entries = (Object.keys(DRIFT_FIELD_LABEL) as (keyof GateLinkDriftWire)[])
    .map((field) => ({ field, value: drift[field] }))
    .filter(
      (
        entry,
      ): entry is {
        field: keyof GateLinkDriftWire;
        value: { existing: string; instance: string };
      } => entry.value !== undefined,
    );
  if (entries.length === 0) return null;
  return (
    <ul
      className="stack-s"
      data-testid="enable-preview-drift"
      style={{ listStyle: 'none', margin: 0, padding: 0 }}
    >
      {entries.map(({ field, value }) => (
        <li key={field} className="text-3 text-small">
          {t(DRIFT_FIELD_LABEL[field].zh, DRIFT_FIELD_LABEL[field].en)}: {value.existing} →{' '}
          {value.instance}
        </li>
      ))}
    </ul>
  );
}
