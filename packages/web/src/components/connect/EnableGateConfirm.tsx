import type {
  EnableGateInstanceResultWire,
  GateLinkDriftWire,
  PreviewGateInstanceEnableResultWire,
} from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { describeError } from '../../lib/errors.js';
import { HttpError } from '../../lib/http-client.js';
import { useT } from '../../lib/i18n.js';
import { platformErrorMessage } from '../../lib/platform-errors.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { Notice } from '../kit/notice.js';
import { RefChip } from '../kit/ref-chip.js';
import { StatusChip } from '../kit/status-chip.js';

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
 * existing (legacy) registration this call would link instead of duplicating. The confirm's own
 * `onConfirm` is the actual `enable_gate_instance` call; success calls `onEnabled` with the full
 * result (`linkedExisting` incl.) so the caller's own toast can report it (J4's own ask).
 */
export function EnableGateConfirm({
  http,
  gateId,
  gateDisplayName,
  onEnabled,
  label,
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
    let result: EnableGateInstanceResultWire;
    try {
      result = await http.call<EnableGateInstanceResultWire>('enable_gate_instance', { gateId });
    } catch (err) {
      // Re-map a known platform wire code (e.g. connector_not_preset, gate_not_enabled,
      // ambiguous_existing_gatekeeper) to its bilingual copy before `kit/confirm`'s own error
      // banner renders it — that banner shows `describeError(error).message` verbatim, which is
      // the kernel's raw English text, not the mapped copy `PlatformError` used to give this flow.
      const mapped = platformErrorMessage(err, t);
      const described = describeError(err);
      throw mapped ? new HttpError('capability_error', mapped, described.code) : err;
    }
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
          {describeError(previewError).message}
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
        testId={testId ? `${testId}-confirm` : undefined}
      >
        {preview ? <EnablePreviewBody preview={preview} http={http} /> : null}
      </Confirm>
    </div>
  );
}

function EnablePreviewBody({
  preview,
  http,
}: {
  readonly preview: PreviewGateInstanceEnableResultWire;
  readonly http: CapabilityCaller;
}) {
  const t = useT();
  const toImportCount = preview.operationsToImport.length;
  const presentCount = preview.operationsAlreadyPresent.length;
  const noOperations = toImportCount === 0 && presentCount === 0;
  return (
    <div className="stack-s">
      {preview.wouldLink ? (
        <div className="stack-s" data-testid="enable-preview-would-link">
          <span className="text-13">
            {t('将关联已有的注册（旧路径）：', 'Will link the existing (legacy) registration: ')}
            <RefChip kind="gatekeeper" id={preview.wouldLink.gatekeeperId} http={http} size="s" />
            {t('，不会新建 Gatekeeper。', ' — no new Gatekeeper is created.')}
          </span>
          <DriftList drift={preview.wouldLink.drift} />
        </div>
      ) : null}
      {preview.operationsToImport.length > 0 ? (
        <div className="stack-s" data-testid="enable-preview-import">
          <span className="text-12 font-medium text-text-2">
            {t(`将发布 ${toImportCount} 个 Operation`, `Will publish ${toImportCount}`)}
          </span>
          <ul className="stack-s" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {preview.operationsToImport.map((operation) => (
              <li key={operation.name} className="row-wrap">
                <span className="mono">{operation.name}</span>
                <StatusChip machine="operationMode" status={operation.mode} size="s" />
                <StatusChip machine="blastRadius" status={operation.blastRadius} size="s" />
                {operation.mode === 'execute' || operation.blastRadius === 'high' ? (
                  <span className="tag" data-testid="enable-preview-high-impact">
                    {t('高影响', 'High impact')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {preview.operationsAlreadyPresent.length > 0 ? (
        <div className="stack-s" data-testid="enable-preview-present">
          <span className="text-12 font-medium text-text-2">
            {t(`已存在 ${presentCount} 个 Operation`, `${presentCount} operation(s) already there`)}
          </span>
          <ul className="stack-s" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {preview.operationsAlreadyPresent.map((operation) => (
              <li key={operation.name} className="row-wrap">
                <span className="mono">{operation.name}</span>
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
            '该门实例还没有 announce 任何 Operation。',
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
