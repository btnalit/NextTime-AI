import type {
  AvailableGateInstanceWire,
  GateOwnedParamWire,
  OperationSummaryWire,
  PreviewGateInstanceEnableResultWire,
} from '@nexttime/shared';
import { useId } from 'react';
import { useCapability, useCapabilityList } from '../../hooks/useCapability.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { useT } from '../../lib/i18n.js';
import {
  type GateOwnedParamsFix,
  gateOwnedParamsNextStep,
  gateOwnedParamsText,
} from '../connect/GateOwnedParams.js';
import { RefreshOperationGovernanceConfirm } from '../connect/RefreshOperationGovernanceConfirm.js';
import { Button } from '../kit/button.js';
import { Notice } from '../kit/notice.js';

const ALL: Readonly<Record<string, unknown>> = {};

/**
 * components/catalog/GateOwnedParamsNotice (console G4, legacy 219): an Operation row whose
 * definition declares a param only the gate sets (`OperationSummaryWire.gateOwnedParams`, the
 * judgment `publish_operation` refuses with 400 `gate_owned_params`). On a draft it says why the
 * draft cannot be published, before anyone clicks 发布; on a published row (published before the
 * check existed) it says the gate refuses every call passing one of them.
 *
 * The fix is at the gate. For a platform gate this workspace enabled, the align that rewrites the
 * held draft to the gate's corrected manifest is offered right here, narrowed to this one draft
 * (`RefreshOperationGovernanceConfirm`, `operationNames`), so the reader is not sent to find it.
 * Whether the gate is a platform one is read from `list_available_gate_instances` — only by a
 * reader who may align (`refresh_operation_governance`), and only once the role is known.
 *
 * UX acceptance of #567 P2: whether that rewrite would change anything is known before the click,
 * from the same preview the align reads (`preview_gate_instance_enable`, `pendingDraft.rewritable`).
 * While the gate's manifest still declares the params, the button is greyed out and says why.
 *
 * Legacy 214: a gate the workspace connected itself gets the same rewrite, from what the gate
 * describes now (`preview_gatekeeper_resync`) — read on the click rather than for every catalog row,
 * since it asks the gate itself; the confirm then says whether the gate still declares the params.
 */
export function GateOwnedParamsNotice({
  http,
  gatekeeperId,
  name,
  status,
  params,
  origin,
  canDiscard = false,
  gateDisplayName,
  onRewritten,
}: {
  readonly http: CapabilityCaller;
  readonly gatekeeperId: string;
  readonly name: string;
  readonly status: string;
  readonly params: readonly GateOwnedParamWire[];
  /** Who wrote this version (`OperationSummaryWire.origin`) — absent on a legacy row. */
  readonly origin?: OperationSummaryWire['origin'];
  /** Legacy 278: the reader may discard this draft right below (`discard_operation_draft`), so a
   *  draft that can never be published names that way out instead of "leave it". */
  readonly canDiscard?: boolean;
  readonly gateDisplayName: string;
  /** The align rewrote the draft — the caller reloads the catalog and says so. */
  readonly onRewritten: () => void;
}) {
  const t = useT();
  const waitingId = useId();
  const can = useRoleCan(http);
  const draft = status === 'draft';
  const mayAlign = can('refresh_operation_governance') !== false;
  const readsInstances = can('list_available_gate_instances') === true;
  const instances = useCapabilityList<AvailableGateInstanceWire>(
    http,
    'list_available_gate_instances',
    ALL,
    { enabled: draft && mayAlign && readsInstances },
  );
  const linked =
    instances.state.status === 'ready'
      ? (instances.state.data.items.find((row) => row.gatekeeperId === gatekeeperId) ?? null)
      : undefined;
  const offersRewrite = draft && mayAlign && linked !== undefined && linked !== null;
  const readsPreview = can('preview_gate_instance_enable') === true;
  const preview = useCapability<PreviewGateInstanceEnableResultWire>(
    http,
    'preview_gate_instance_enable',
    { gateId: linked?.gateId ?? '' },
    { enabled: offersRewrite && readsPreview },
  );
  // Why the rewrite is or is not offered, read from the same preview the align reads. While it
  // loads nothing is offered yet; when it cannot be read the confirm reads it itself and says what
  // it finds. A draft the align would not rewrite is one of three cases (review #501 on #571 ①):
  // the gate still declares the params (`waiting`: the button greys out until it changes), the
  // draft is an agent's or member's proposal the align never rewrites (`proposal`), or the gate no
  // longer announces this Operation at all (`gone`) — the last two never become rewritable, so
  // no button is shown for them.
  const rewrite: RewriteState = !offersRewrite
    ? // Legacy 214: a self-connected gate's re-read never rewrites a proposal either.
      linked === null && draft && origin !== undefined && origin !== 'import'
      ? 'proposal'
      : 'none'
    : preview.state.status === 'ready'
      ? rewriteStateOf(preview.state.data, name, origin)
      : preview.state.status === 'loading' && readsPreview
        ? 'loading'
        : 'ready';
  // Legacy 214: a gate the workspace connected itself is re-read on the click (the preview asks
  // the gate itself, so it is not read for every row of the catalog) — a proposal is never
  // rewritten, so it gets no button.
  const offersResync = draft && mayAlign && linked === null && rewrite !== 'proposal';
  const fix: GateOwnedParamsFix =
    linked === undefined
      ? 'either'
      : linked === null
        ? offersResync
          ? 'resync-here'
          : 'resync'
        : offersRewrite
          ? 'align-here'
          : 'align';
  const named = gateOwnedParamsText(params, t);
  // Legacy 278 (UX acceptance of #577): a draft that will never be published can leave the catalog.
  const discardLine =
    t('', ' ') +
    (canDiscard
      ? t(
          '不再需要的话，可以用下面的「丢弃」把它移出目录。',
          'If it is no longer needed, “Discard” below takes it out of the catalog.',
        )
      : t(
          '不再需要的话，它的提议者或工作区所有者可以把它丢弃。',
          'If it is no longer needed, its proposer or the workspace owner can discard it.',
        ));

  return (
    <Notice tone="warn" testId="operation-gate-owned-params">
      <span className="stack-s">
        <span>
          {draft
            ? t(
                `发布不了：这份草稿声明了只能由门自己设置的参数——${named}。门会拒绝带这些参数的每一次调用。`,
                `Cannot be published: this draft declares params only the gate sets — ${named}. The gate refuses every call that passes one.`,
              )
            : t(
                `门会拒绝带这些参数的调用：${named}。这一版是在发布检查加上之前发布的。`,
                `The gate refuses calls that pass these params: ${named}. This version was published before that check existed.`,
              )}
        </span>
        <span className="text-3">
          {draft
            ? rewrite === 'proposal'
              ? `${t(
                  '这份草稿是 agent 或成员提议的，不是门自己导入的，按门的清单重写不会改它。要发布，需要提议者去掉这些参数后重新提议一份。',
                  'This draft was proposed by an agent or a member, not imported by the gate, so rewriting from the gate’s manifest never changes it. To publish, its proposer has to propose it again without these params.',
                )}${discardLine}`
              : rewrite === 'gone'
                ? `${t(
                    '门的当前清单里已经没有这个 Operation，没有可以重写成的新版本，这份草稿也就发布不了。草稿不会被调用。',
                    'The gate’s current manifest no longer announces this Operation, so there is no new version to rewrite this draft to, and it cannot be published. A draft is never called.',
                  )}${discardLine}`
                : gateOwnedParamsNextStep(fix, t)
            : t(
                '门的维护者从门的清单里去掉它们之后，到「系统与授权」打开这个系统，对齐（平台提供的系统）或重新读取门的清单（工作区自己接入的系统），再发布修订。',
                'Once the gate’s maintainer drops them from its manifest, open this system under Systems & access, align it (a platform-provided system) or re-read the gate’s manifest (one the workspace connected itself), and publish the revision.',
              )}
        </span>
        {offersResync ? (
          <RefreshOperationGovernanceConfirm
            http={http}
            gatekeeperId={gatekeeperId}
            gateDisplayName={gateDisplayName}
            operationNames={[name]}
            label={t('按门的最新清单重写', 'Rewrite from the gate’s latest manifest')}
            onRefreshed={onRewritten}
            testId="operation-gate-owned-resync"
          />
        ) : linked && rewrite === 'waiting' ? (
          <span className="stack-s">
            <span>
              <Button
                variant="secondary"
                size="s"
                disabled
                aria-describedby={waitingId}
                data-testid="operation-gate-owned-rewrite"
              >
                {t('按门的最新清单重写', 'Rewrite from the gate’s latest manifest')}
              </Button>
            </span>
            <span
              id={waitingId}
              className="text-3 text-small"
              data-testid="operation-gate-owned-rewrite-waiting"
            >
              {t(
                '门的清单仍声明这些参数，按它重写也还是发布不了。门的维护者去掉它们、平台采用改好的清单之后才能重写。',
                'The gate’s manifest still declares these params, so a rewrite from it could not be published either. The rewrite becomes possible once the gate’s maintainer drops them and the platform adopts the corrected manifest.',
              )}
            </span>
          </span>
        ) : linked && rewrite === 'ready' ? (
          <RefreshOperationGovernanceConfirm
            http={http}
            gatekeeperId={gatekeeperId}
            platformGateId={linked.gateId}
            gateDisplayName={gateDisplayName}
            operationNames={[name]}
            label={t('按门的最新清单重写', 'Rewrite from the gate’s latest manifest')}
            // Legacy 280: the preview this notice just read decided the button; the confirm
            // reuses it rather than reading it again on the click.
            preview={preview.state.status === 'ready' ? preview.state.data : undefined}
            onRefreshed={onRewritten}
            testId="operation-gate-owned-rewrite"
          />
        ) : null}
      </span>
    </Notice>
  );
}

export type RewriteState = 'none' | 'loading' | 'ready' | 'waiting' | 'proposal' | 'gone';

/** What the enable preview says about rewriting this one held draft.
 *
 *  - A draft the gate did not write is a proposal, whatever the preview says — first, so a
 *    proposed name the gate never announced is not called one it stopped announcing (UX acceptance
 *    of #573 P3-1). `origin` is the draft's own; `pendingDraft.fromGate` says the same where the
 *    gate still announces the name.
 *  - The gate no longer announcing the name, or no longer running it while the platform has not
 *    adopted its new manifest yet (`awaitingPlatformAdoption.dropped`, UX acceptance of #583): `gone`
 *    — the align does not rewrite such a draft, and adopting removes the name.
 *  - The gate's entry still declaring a gate-owned param: `waiting`, even when the rewrite would
 *    change other fields (`pendingDraft.rewritable`) — the rewritten draft could not be published
 *    either (review #501 on #573).
 *  - Otherwise `rewritable` decides; an older kernel without `fromGate` falls back to the row's
 *    own params. */
export function rewriteStateOf(
  preview: PreviewGateInstanceEnableResultWire,
  name: string,
  origin?: OperationSummaryWire['origin'],
): RewriteState {
  if (origin !== undefined && origin !== 'import') return 'proposal';
  const row = preview.operationsToImport.find((entry) => entry.name === name);
  if (!row || preview.awaitingPlatformAdoption?.dropped?.includes(name) === true) return 'gone';
  if (row.pendingDraft?.fromGate === false) return 'proposal';
  if (row.gateOwnedParams && row.gateOwnedParams.length > 0) return 'waiting';
  if (row.pendingDraft?.rewritable === true) return 'ready';
  return 'proposal';
}
