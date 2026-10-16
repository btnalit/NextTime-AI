import type {
  AvailableGateInstanceWire,
  GateOwnedParamWire,
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
 */
export function GateOwnedParamsNotice({
  http,
  gatekeeperId,
  name,
  status,
  params,
  gateDisplayName,
  onRewritten,
}: {
  readonly http: CapabilityCaller;
  readonly gatekeeperId: string;
  readonly name: string;
  readonly status: string;
  readonly params: readonly GateOwnedParamWire[];
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
    ? 'none'
    : preview.state.status === 'ready'
      ? rewriteStateOf(preview.state.data, name)
      : preview.state.status === 'loading' && readsPreview
        ? 'loading'
        : 'ready';
  const fix: GateOwnedParamsFix =
    linked === undefined
      ? 'either'
      : linked === null
        ? 'reconnect'
        : offersRewrite
          ? 'align-here'
          : 'align';
  const named = gateOwnedParamsText(params, t);

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
              ? t(
                  '这份草稿是 agent 或成员提议的，不是门自己导入的，按门的清单重写不会改它。要发布，需要提议者去掉这些参数后重新提议一份。',
                  'This draft was proposed by an agent or a member, not imported by the gate, so rewriting from the gate’s manifest never changes it. To publish, its proposer has to propose it again without these params.',
                )
              : rewrite === 'gone'
                ? t(
                    '门的当前清单里已经没有这个 Operation，没有可以重写成的新版本，这份草稿也就发布不了。',
                    'The gate’s current manifest no longer announces this Operation, so there is no new version to rewrite this draft to, and it cannot be published.',
                  )
                : gateOwnedParamsNextStep(fix, t)
            : t(
                '门的维护者从门的清单里去掉它们之后，平台提供的系统到「系统与授权」对齐并发布修订；工作区自己接入的系统需要重新接入。',
                'Once the gate’s maintainer drops them from its manifest, align a platform-provided system under Systems & access and publish the revision; a system the workspace connected itself has to be connected again.',
              )}
        </span>
        {linked && rewrite === 'waiting' ? (
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
                '门的清单还没改：它仍声明这些参数。门的维护者改好、平台采用新清单之后才能重写。',
                'The gate’s manifest has not changed yet: it still declares these params. The rewrite becomes possible once the gate’s maintainer fixes it and the platform adopts the new manifest.',
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
            onRefreshed={onRewritten}
            testId="operation-gate-owned-rewrite"
          />
        ) : null}
      </span>
    </Notice>
  );
}

export type RewriteState = 'none' | 'loading' | 'ready' | 'waiting' | 'proposal' | 'gone';

/** What the enable preview says about rewriting this one held draft. `pendingDraft.rewritable` is
 *  `false` both when the gate still declares the params and when the draft is not the gate's own;
 *  `pendingDraft.fromGate` tells them apart, and an older kernel without it falls back to the row's
 *  own `gateOwnedParams` (still declared → the gate has not changed). */
export function rewriteStateOf(
  preview: PreviewGateInstanceEnableResultWire,
  name: string,
): RewriteState {
  const row = preview.operationsToImport.find((entry) => entry.name === name);
  if (!row) return 'gone';
  if (row.pendingDraft?.rewritable === true) return 'ready';
  if (row.pendingDraft?.fromGate === false) return 'proposal';
  if (row.gateOwnedParams && row.gateOwnedParams.length > 0) return 'waiting';
  return 'proposal';
}
