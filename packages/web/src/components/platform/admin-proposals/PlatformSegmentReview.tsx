import type {
  AdminProposalSegmentWire,
  AdminProposalWire,
  PlatformSegmentApplyResultWire,
  PlatformSegmentPreviewItemWire,
  PlatformSegmentPreviewWire,
} from '@nexttime/shared';
import { ADMIN_PROPOSAL_REASON_MAX_LENGTH } from '@nexttime/shared';
import { useState } from 'react';
import { invalidateCapability, useCapability } from '../../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../../lib/clients.js';
import { credentialReviewParams } from '../../../lib/credential-review.js';
import { describeError } from '../../../lib/errors.js';
import { useT } from '../../../lib/i18n.js';
import { hrefs } from '../../../lib/router.js';
import { Button } from '../../kit/button.js';
import { Confirm } from '../../kit/confirm.js';
import { CredentialReview } from '../../kit/credential-review.js';
import { ErrorBanner } from '../../kit/error-banner.js';
import { Field, describedBy } from '../../kit/field.js';
import { KeyValue } from '../../kit/key-value.js';
import { Notice } from '../../kit/notice.js';
import { RouteLink } from '../../kit/route-link.js';
import { SkeletonRows } from '../../kit/skeleton.js';
import { StatusChip } from '../../kit/status-chip.js';
import { StillNeeded } from '../../kit/still-needed.js';
import { Textarea } from '../../kit/textarea.js';
import { type PresetLabel, usePresetLabel } from './preset-labels.js';
import {
  credentialModeText,
  nextStepText,
  operationSourceText,
  platformBlockerText,
  platformIntentText,
  transportText,
} from './text.js';
import { WorkspaceName, type WorkspaceRefs } from './workspace-refs.js';

/** Refusals that mean what was reviewed is not what is on the platform now: the review is read
 *  again (`apply_platform_segment`). */
const STALE_CODES = new Set(['change_plan_changed', 'admin_proposal_segment_blocked']);

/**
 * The platform part of an admin proposal, still awaiting a decision (S11 AA4b; the AA4 plan F7):
 * `preview_platform_segment`'s dry run — each gate-host instance applying it creates, as it would
 * be created (address, connector, transport, credential mode, where its Operations come from, what
 * is left to do afterwards) — with each item ticked (every one moves an authority boundary: a new
 * outside address, which the credential entered for it is sent to), what does not fit the platform
 * now, the workspace parts that wait on it, and the suspected credentials to review. Applying
 * carries the reviewed digest, the ticked ordinals and the credential review, nothing else;
 * rejecting takes a reason.
 */
export function PlatformSegmentReview({
  http,
  proposal,
  segment,
  workspaces,
  onApplied,
  onRejected,
  onDecidedElsewhere,
}: {
  readonly http: CapabilityCaller;
  readonly proposal: AdminProposalWire;
  readonly segment: AdminProposalSegmentWire;
  readonly workspaces: WorkspaceRefs;
  readonly onApplied: (result: PlatformSegmentApplyResultWire) => void;
  readonly onRejected: (proposal: AdminProposalWire) => void;
  /** Decided or withdrawn by someone else meanwhile: read the proposal again. */
  /** Someone decided this part meanwhile: read the proposal again, saying why nothing was done. */
  readonly onDecidedElsewhere: (message: string) => void;
}) {
  const t = useT();
  const presetLabel = usePresetLabel(http);
  const preview = useCapability<PlatformSegmentPreviewWire>(http, 'preview_platform_segment', {
    segmentId: segment.id,
  });
  const [confirmed, setConfirmed] = useState<ReadonlySet<number>>(new Set());
  const [credentialsReviewed, setCredentialsReviewed] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [staleNotice, setStaleNotice] = useState(false);

  function readAgain(): void {
    setConfirmed(new Set());
    setCredentialsReviewed(false);
    invalidateCapability(http, 'preview_platform_segment');
    void preview.reload();
  }

  if (preview.state.status === 'loading') {
    return (
      <SkeletonRows
        count={3}
        label={t('正在检查它会在平台上新建什么…', 'Checking what it creates on the platform')}
      />
    );
  }
  if (preview.state.status === 'error') {
    const decidedMeanwhile =
      describeError(preview.state.error).code === 'admin_proposal_segment_not_open';
    return (
      <ErrorBanner
        error={preview.state.error}
        title={t('无法检查它会在平台上新建什么', 'Could not check what it creates on the platform')}
        onRetry={() => {
          if (decidedMeanwhile) {
            onDecidedElsewhere(
              t(
                '这个平台部分在你打开之后已经被处理了。下面已经换成它现在的样子。',
                'This platform part was decided after you opened it. It now shows as it stands.',
              ),
            );
          } else void preview.reload();
        }}
        testId="platform-segment-preview-error"
      />
    );
  }

  const data = preview.state.data;
  const widening = data.items.filter((item) => item.classification === 'authority_widening');
  const unconfirmed = widening.filter((item) => !confirmed.has(item.ordinal)).length;
  const needsCredentialReview = data.suspectedSecretValues > 0;
  const subjectOf = (ordinal: number): string => {
    const intent = segment.items[ordinal - 1];
    return intent?.kind === 'gate_instance'
      ? platformIntentText(intent, t, presetLabel)
      : `#${ordinal}`;
  };
  const createdConnectors = data.items
    .filter((item) => item.connector.created)
    .map((item) => item.connector.name);
  const staleText = t(
    '在你查看之后，平台上的情况变了（例如 gate id 或接入包被占用），所以什么也没有应用。上面已经换成现在的样子，请重新看一遍再确认。',
    'Things on the platform changed after you looked (a gate id or a connector was taken, say), so nothing was applied. The review above now shows how things are; look it over again before confirming.',
  );

  async function apply(): Promise<void> {
    if (data.digest === null) return;
    let result: PlatformSegmentApplyResultWire;
    try {
      result = await http.call<PlatformSegmentApplyResultWire>('apply_platform_segment', {
        segmentId: segment.id,
        reviewedDigest: data.digest,
        confirmedOrdinals: widening
          .filter((item) => confirmed.has(item.ordinal))
          .map((item) => item.ordinal),
        ...credentialReviewParams(needsCredentialReview && credentialsReviewed),
      });
    } catch (error) {
      const code = describeError(error).code;
      if (STALE_CODES.has(code)) {
        setStaleNotice(true);
        readAgain();
      }
      if (code === 'admin_proposal_segment_not_open') {
        onDecidedElsewhere(
          t(
            '这个平台部分在你打开之后已经被处理了，什么也没有应用。下面已经换成它现在的样子。',
            'This platform part was decided after you opened it, so nothing was applied. It now shows as it stands.',
          ),
        );
      }
      throw error;
    }
    onApplied(result);
  }

  async function reject(): Promise<void> {
    let next: AdminProposalWire;
    try {
      next = await http.call<AdminProposalWire>('reject_platform_segment', {
        segmentId: segment.id,
        reason: reason.trim(),
      });
    } catch (error) {
      if (describeError(error).code === 'admin_proposal_segment_not_open') {
        onDecidedElsewhere(
          t(
            '这个平台部分在你打开之后已经被处理了，什么也没有拒绝。下面已经换成它现在的样子。',
            'This platform part was decided after you opened it, so nothing was rejected. It now shows as it stands.',
          ),
        );
      }
      throw error;
    }
    onRejected(next);
  }

  const missing = [
    ...(data.blockers.length > 0
      ? [
          t(
            `处理 ${data.blockers.length} 处对不上的地方`,
            `deal with ${data.blockers.length} problem(s) above`,
          ),
        ]
      : []),
    ...(unconfirmed > 0
      ? [
          t(
            `勾选 ${unconfirmed} 项权限边界确认`,
            `tick ${unconfirmed} authority-boundary confirmation${unconfirmed > 1 ? 's' : ''}`,
          ),
        ]
      : []),
    ...(needsCredentialReview && !credentialsReviewed
      ? [t('核对疑似凭据', 'review the suspected credentials')]
      : []),
  ];
  const pendingDependents = data.dependents.filter((dependent) => dependent.status === 'proposed');

  return (
    <div className="stack" data-testid="platform-segment-review">
      {staleNotice ? (
        <Notice tone="warn" testId="platform-segment-stale">
          {staleText}
        </Notice>
      ) : null}
      {data.blockers.length > 0 ? (
        <Notice tone="warn" testId="platform-segment-blockers">
          <span className="stack-s">
            <span>
              {t(
                '其中有实例现在没法按提议的样子在平台上新建，处理好之前不能应用：',
                'Part of it cannot be created on the platform as proposed now; it cannot be applied until that is dealt with:',
              )}
            </span>
            {data.blockers.map((blocker) => (
              <span
                className="stack-s text-small"
                key={blocker.ordinal}
                data-testid={`platform-segment-blocker-${blocker.ordinal}`}
              >
                <span>{platformBlockerText(blocker.reason, subjectOf(blocker.ordinal), t)}</span>
                {blocker.reason === 'connector_not_offerable' ? (
                  <RouteLink
                    href={hrefs.platformIntegrationsTab('connectors')}
                    className="link-inline"
                  >
                    {t('去「集成 → 接入包」', 'Open Integrations → Connectors')}
                  </RouteLink>
                ) : null}
              </span>
            ))}
          </span>
        </Notice>
      ) : null}

      {data.items.length > 0 ? (
        <>
          <span className="text-small">
            {t(
              `应用后会在平台上新建 ${data.items.length} 个门宿主实例：`,
              `Applying it creates ${data.items.length} gate-host instance(s) on the platform:`,
            )}
          </span>
          <div className="stack-s" data-testid="platform-segment-items">
            {data.items.map((item) => (
              <PlatformItemCard
                presetLabel={presetLabel}
                key={item.ordinal}
                item={item}
                checked={confirmed.has(item.ordinal)}
                onCheckedChange={(checked) =>
                  setConfirmed((prev) => {
                    const next = new Set(prev);
                    if (checked) next.add(item.ordinal);
                    else next.delete(item.ordinal);
                    return next;
                  })
                }
              />
            ))}
          </div>
        </>
      ) : (
        <>
          <span className="text-3 text-small">{t('它提议的是：', 'What it proposes:')}</span>
          <div className="stack-s" data-testid="platform-segment-intents">
            {segment.items.map((intent, index) =>
              intent.kind === 'gate_instance' ? (
                <span
                  className="text-small"
                  key={intent.gateId}
                  data-testid={`platform-segment-intent-${index + 1}`}
                >
                  {platformIntentText(intent, t, presetLabel)}
                  {t('，地址 ', ', address ')}
                  <span className="mono wrap-anywhere">{intent.target}</span>
                </span>
              ) : null,
            )}
          </div>
        </>
      )}

      {data.dependents.length > 0 ? (
        <div className="stack-s" data-testid="platform-segment-dependents">
          <span className="text-small">
            {t(
              `这份提案的 ${data.dependents.length} 个工作区部分依赖它：平台部分应用之后，所有者才能应用；拒绝它，还在待确认的会随之撤回。`,
              `${data.dependents.length} workspace part(s) of this proposal depend on it: owners can apply them only once it is applied, and rejecting it withdraws those still awaiting a decision.`,
            )}
          </span>
          {data.dependents.map((dependent) => (
            <span
              className="row-wrap text-small"
              key={dependent.segmentId}
              data-testid={`platform-segment-dependent-${dependent.segmentId}`}
            >
              <WorkspaceName workspaceId={dependent.targetWorkspaceId} refs={workspaces} />
              <StatusChip machine="adminProposalSegment" status={dependent.status} size="s" />
            </span>
          ))}
        </div>
      ) : null}

      <CredentialReview
        count={data.suspectedSecretValues}
        paths={data.suspectedSecretPaths}
        subject="publish"
        where={t(
          '这些值会原样写进门宿主实例的定义，交给门宿主使用。凭据应该在应用之后到门宿主上录入，不该写在地址里。',
          'These values go into the gate-host instance’s definition as they are, for the gate host to use. A credential belongs on the gate host, entered after applying, not in the address.',
        )}
        checked={credentialsReviewed}
        onChange={setCredentialsReviewed}
      />

      <div className="stack-s">
        <div className="row-wrap">
          <Confirm
            tier="medium"
            open={applyOpen}
            onOpenChange={setApplyOpen}
            anchor={
              <Button
                variant="primary"
                disabled={
                  data.digest === null ||
                  data.blockers.length > 0 ||
                  unconfirmed > 0 ||
                  (needsCredentialReview && !credentialsReviewed)
                }
                onClick={() => setApplyOpen(true)}
                aria-describedby="platform-segment-missing"
                data-testid="platform-segment-apply-trigger"
              >
                {t('应用平台部分…', 'Apply the platform part…')}
              </Button>
            }
            title={t('应用平台部分', 'Apply the platform part')}
            target={proposal.title}
            impact={[
              t(
                `在平台上新建 ${data.items.length} 个门宿主实例，状态为「已发现」，工作区还用不了`,
                `Creates ${data.items.length} gate-host instance(s) on the platform, discovered, which no workspace can use yet`,
              ),
              ...(createdConnectors.length > 0
                ? [
                    t(
                      `新建接入包 ${createdConnectors.join('、')}（平台预置）`,
                      `Creates the connector(s) ${createdConnectors.join(', ')} (platform preset)`,
                    ),
                  ]
                : []),
              t(
                '记成一条平台变更记录，需要时可以在「平台变更记录」里撤销',
                'Records it as one platform change record, which can be rolled back under Platform change records',
              ),
              t(
                '平台审计里记下每个实例的新建和这次应用，由你应用、由提议它的平台管理员的管理员智能体提议',
                'The platform audit records each instance created and this apply, applied by you and proposed by the platform administrator’s admin agent',
              ),
            ]}
            confirmLabel={t('应用', 'Apply')}
            danger
            confirmDisabled={data.digest === null}
            onConfirm={apply}
            errorOverrides={{
              change_plan_changed: staleText,
              admin_proposal_segment_blocked: staleText,
            }}
            testId="platform-segment-apply-confirm"
          />
          <Confirm
            tier="medium"
            open={rejectOpen}
            onOpenChange={(next) => {
              setRejectOpen(next);
              if (!next) setReason('');
            }}
            anchor={
              <Button
                variant="ghost"
                onClick={() => setRejectOpen(true)}
                data-testid="platform-segment-reject-trigger"
              >
                {t('拒绝…', 'Reject…')}
              </Button>
            }
            title={t('拒绝平台部分', 'Reject the platform part')}
            description={t(
              '拒绝后平台部分不能再应用，平台上什么也不会改；这份提案还在待确认的工作区部分会随之撤回。理由只有平台管理员看得到；提议它的管理员智能体只知道被拒绝了，看不到理由。',
              'Once rejected the platform part can never be applied, and nothing on the platform changes; the workspace parts of this proposal still awaiting a decision are withdrawn with it. Only the platform’s administrators read the reason; the admin agent that proposed it learns only that it was rejected, not why.',
            )}
            target={proposal.title}
            impact={
              pendingDependents.length > 0
                ? [
                    t(
                      `撤回 ${pendingDependents.length} 个待确认的工作区部分`,
                      `Withdraws ${pendingDependents.length} workspace part(s) awaiting a decision`,
                    ),
                  ]
                : undefined
            }
            confirmLabel={t('拒绝', 'Reject')}
            danger
            confirmDisabled={reason.trim() === ''}
            onConfirm={reject}
            testId="platform-segment-reject-confirm"
          >
            <Field
              id="platform-segment-reject-reason"
              label={t('拒绝理由', 'Reason')}
              hint={t(
                '必填：为什么不采用它。只有平台管理员看得到。',
                'Required: why it is not taken. Only the platform’s administrators read it.',
              )}
              required
            >
              <Textarea
                id="platform-segment-reject-reason"
                value={reason}
                maxLength={ADMIN_PROPOSAL_REASON_MAX_LENGTH}
                onChange={(event) => setReason(event.target.value)}
                aria-label={t('拒绝理由', 'Reject reason')}
                aria-required
                aria-describedby={describedBy('platform-segment-reject-reason', true, false)}
                data-testid="platform-segment-reject-reason"
              />
            </Field>
          </Confirm>
        </div>
        <div id="platform-segment-missing">
          <StillNeeded items={missing} testId="platform-segment-missing-steps" />
        </div>
      </div>
    </div>
  );
}

/** One gate-host instance applying the platform part creates, as it would be created. */
function PlatformItemCard({
  item,
  checked,
  onCheckedChange,
  presetLabel,
}: {
  readonly item: PlatformSegmentPreviewItemWire;
  readonly presetLabel: PresetLabel;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  const t = useT();
  const prefix = `platform-segment-item-${item.ordinal}`;
  return (
    <div className="card card-padded stack-s" data-testid={prefix}>
      <span>
        {t(`新建门宿主实例 ${item.displayName}`, `New gate-host instance ${item.displayName}`)}
      </span>
      <InstanceFacts
        gateId={item.gateId}
        connector={item.connector}
        definition={item.definition}
        presetLabel={presetLabel}
        testId={`${prefix}-facts`}
      />
      {item.nextSteps.length > 0 ? (
        <span className="text-3 text-small" data-testid={`${prefix}-next-steps`}>
          {t('应用之后还要：', 'After applying, still to do: ')}
          {item.nextSteps.map((step) => nextStepText(step, t)).join(t('，然后', ', then '))}
          {t('。在此之前工作区用不了它。', '. No workspace can use it before that.')}
        </span>
      ) : null}
      {item.classification === 'authority_widening' ? (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => onCheckedChange(event.currentTarget.checked)}
            data-testid={`${prefix}-confirm`}
          />
          <span>
            {t('我确认这会改变权限边界：', 'I confirm this moves an authority boundary: ')}
            {t(
              '平台多一个外部地址，为这个实例录入的凭据会发到这个地址',
              'the platform gains an outside address, and the credential entered for this instance is sent to it',
            )}
          </span>
        </label>
      ) : null}
    </div>
  );
}

/** What a gate-host instance is (or would be) created with: its gate id, address, connector,
 *  transport, credential mode and where its Operations come from. */
export function InstanceFacts({
  gateId,
  connector,
  definition,
  presetLabel,
  testId,
}: {
  readonly gateId: string;
  readonly connector: PlatformSegmentPreviewItemWire['connector'];
  readonly definition: PlatformSegmentPreviewItemWire['definition'];
  readonly presetLabel: PresetLabel;
  readonly testId?: string;
}) {
  const t = useT();
  return (
    <KeyValue
      testId={testId}
      items={[
        { key: 'gate', label: 'gate id', value: gateId, mono: true },
        {
          key: 'target',
          label: t('地址', 'Address'),
          value: <span className="mono wrap-anywhere">{definition.target}</span>,
        },
        {
          key: 'connector',
          label: t('接入包', 'Connector'),
          value: connector.created
            ? t(
                `${connector.name}（新建，平台预置）`,
                `${connector.name} (created, platform preset)`,
              )
            : t(`${connector.name}（已有）`, `${connector.name} (existing)`),
        },
        {
          key: 'transport',
          label: t('接入方式', 'Transport'),
          value: transportText(definition, t),
        },
        {
          key: 'credential',
          label: t('凭据方式', 'Credential mode'),
          value: credentialModeText(definition, t),
        },
        {
          key: 'operations',
          label: t('Operation 来源', 'Operations from'),
          value: (
            <span className="wrap-anywhere">{operationSourceText(definition, t, presetLabel)}</span>
          ),
        },
      ]}
    />
  );
}
