import type {
  AdminProposalSegmentWire,
  AdminProposalWire,
  PlatformChangeSegmentWire,
  PlatformSegmentApplyResultWire,
  PlatformWorkspaceWire,
} from '@nexttime/shared';
import { ADMIN_PROPOSAL_REASON_MAX_LENGTH } from '@nexttime/shared';
import { useRef, useState } from 'react';
import {
  invalidateCapability,
  useCapability,
  useCapabilityList,
} from '../../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../../lib/clients.js';
import { describeError } from '../../../lib/errors.js';
import { formatDateTime } from '../../../lib/format.js';
import { type Translate, useT } from '../../../lib/i18n.js';
import { hrefs } from '../../../lib/router.js';
import { Button } from '../../kit/button.js';
import { Confirm } from '../../kit/confirm.js';
import { EmptyState } from '../../kit/empty-state.js';
import { ErrorBanner } from '../../kit/error-banner.js';
import { Field, describedBy } from '../../kit/field.js';
import { KeyValue } from '../../kit/key-value.js';
import { Notice } from '../../kit/notice.js';
import { RouteLink } from '../../kit/route-link.js';
import { SkeletonRows } from '../../kit/skeleton.js';
import { StatusChip } from '../../kit/status-chip.js';
import { Textarea } from '../../kit/textarea.js';
import { ChangeRecordBody } from './ChangeRecords.js';
import { PlatformSegmentReview } from './PlatformSegmentReview.js';
import { type PresetLabel, usePresetLabel } from './preset-labels.js';
import { ADMIN_PROPOSAL_STALE_READS } from './stale-reads.js';
import {
  nextStepText,
  partialApplicationText,
  platformIntentText,
  proposerText,
  withdrawnText,
} from './text.js';
import { WorkspaceName, type WorkspaceRefs, useWorkspaceRefs } from './workspace-refs.js';

export function ProposalDetail({
  http,
  proposalId,
  onChanged,
}: {
  readonly http: CapabilityCaller;
  readonly proposalId: string;
  /** Something here changed the proposal: the list reads again. */
  readonly onChanged: () => void;
}) {
  const t = useT();
  const read = useCapability<AdminProposalWire>(http, 'get_admin_proposal', { proposalId });
  const workspaces = useWorkspaceRefs(http);
  const presetLabel = usePresetLabel(http);
  // What applying the platform part here returned: its next steps stay in view after the proposal
  // reads again.
  const [applied, setApplied] = useState<PlatformSegmentApplyResultWire | null>(null);
  // Why nothing was done, when someone else decided first: it stays in view above the proposal
  // as it now stands.
  const [notice, setNotice] = useState<string | null>(null);
  // The proposal as last read. A decision here reads it again in place — the parts stay on screen
  // while it does — so what a part says it just did (a rollback's result) is not lost to a reload.
  const shown = useRef<AdminProposalWire | null>(null);
  if (read.state.status === 'ready') shown.current = read.state.data;

  function changed(next: AdminProposalWire | null, message: string | null = null): void {
    for (const name of ADMIN_PROPOSAL_STALE_READS) invalidateCapability(http, name);
    setNotice(message);
    if (next !== null) read.mutate(() => next);
    else void read.reload();
    onChanged();
  }

  if (read.state.status === 'error') {
    if (describeError(read.state.error).code === 'admin_proposal_not_found') {
      return (
        <EmptyState
          title={t('找不到这份管理员提案', 'Admin proposal not found')}
          body={t(
            '链接可能不对，或者它已经不在平台上了。回到左侧列表重新选择。',
            'The link may be wrong, or it is no longer on the platform. Pick it again from the list.',
          )}
          testId="platform-admin-proposal-missing"
        />
      );
    }
    return (
      <ErrorBanner
        error={read.state.error}
        title={t('无法加载管理员提案', 'Could not load the admin proposal')}
        onRetry={() => void read.reload()}
        testId="platform-admin-proposal-error"
      />
    );
  }

  const proposal = read.state.status === 'ready' ? read.state.data : shown.current;
  if (proposal === null) {
    return <SkeletonRows count={4} label={t('正在加载管理员提案…', 'Loading admin proposal')} />;
  }
  const platform = proposal.segments.find((segment) => segment.authority === 'platform') ?? null;
  const workspaceParts = proposal.segments.filter((segment) => segment.authority === 'workspace');
  const partial = partialApplicationText(proposal, t);
  const open = proposal.segments.filter((segment) => segment.status === 'proposed').length;

  return (
    <div className="stack" data-testid="platform-admin-proposal-detail">
      <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
        <h2
          className="catalog-detail-title wrap-anywhere"
          data-testid="platform-admin-proposal-title"
        >
          {proposal.title}
        </h2>
        <StatusChip
          machine="adminProposal"
          status={proposal.status}
          testId="platform-admin-proposal-status"
        />
      </div>
      {proposal.description ? (
        <p className="pre-wrap wrap-anywhere" data-testid="platform-admin-proposal-description">
          {proposal.description}
        </p>
      ) : null}
      <KeyValue
        items={[
          {
            key: 'proposer',
            label: t('提议人', 'Proposed by'),
            value: (
              <span data-testid="platform-admin-proposal-proposer">
                {proposerText(proposal.proposedBy, t)}
              </span>
            ),
          },
          {
            key: 'when',
            label: t('提议时间', 'Proposed'),
            value: <span data-volatile="">{formatDateTime(proposal.proposedAt)}</span>,
          },
          {
            key: 'source',
            label: t('来源名', 'Source name'),
            value: (
              <span
                className="mono wrap-anywhere"
                title={t(
                  '工作区里新建的 Skill 和 Worker 以它命名',
                  'New Skills and Workers in a workspace are named under it',
                )}
              >
                {proposal.sourceName}
              </span>
            ),
          },
        ]}
      />
      {notice !== null ? (
        <Notice tone="warn" testId="platform-admin-proposal-notice">
          {notice}
        </Notice>
      ) : null}
      {partial !== null ? (
        <Notice testId="platform-admin-proposal-partial">{partial}</Notice>
      ) : null}
      {open > 0 ? (
        <WithdrawProposal http={http} proposal={proposal} open={open} onWithdrawn={changed} />
      ) : null}

      {platform !== null ? (
        <section className="stack-s" data-testid="platform-admin-proposal-platform-part">
          <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
            <span className="section-title">{t('平台部分', 'Platform part')}</span>
            <StatusChip
              machine="adminProposalSegment"
              status={platform.status}
              size="s"
              testId="platform-admin-proposal-platform-status"
            />
          </div>
          {platform.status === 'proposed' ? (
            <PlatformSegmentReview
              http={http}
              proposal={proposal}
              segment={platform}
              workspaces={workspaces}
              onApplied={(result) => {
                setApplied(result);
                changed(null);
              }}
              onRejected={(next) => changed(next)}
              onDecidedElsewhere={(message) => changed(null, message)}
            />
          ) : platform.status === 'applied' || platform.status === 'rolled_back' ? (
            <PlatformPartRecord
              http={http}
              segment={platform}
              applied={applied?.segment.id === platform.id ? applied : null}
              workspaces={workspaces}
              onRolledBack={() => changed(null)}
            />
          ) : (
            <ClosedPlatformPart segment={platform} presetLabel={presetLabel} />
          )}
        </section>
      ) : null}

      {workspaceParts.length > 0 ? (
        <section className="stack-s" data-testid="platform-admin-proposal-workspace-parts">
          <span className="section-title">{t('工作区部分', 'Workspace parts')}</span>
          <p className="text-3 text-small">
            {t(
              '每个工作区部分由那个工作区的所有者在「能力目录 → 管理员提案」里审阅和决定。这里只看它们各自的状态和所有者写的理由，看不到它们在工作区里会改什么。',
              'Each workspace part is reviewed and decided by that workspace’s owner under Catalog → Admin proposals. Only how each stands and the reason its owner gave show here, never what it changes in the workspace.',
            )}
          </p>
          <div className="stack-s">
            {workspaceParts.map((segment) => (
              <WorkspacePart
                key={segment.id}
                segment={segment}
                platform={platform}
                workspaces={workspaces}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function WithdrawProposal({
  http,
  proposal,
  open,
  onWithdrawn,
}: {
  readonly http: CapabilityCaller;
  readonly proposal: AdminProposalWire;
  /** How many of its parts are still awaiting a decision. */
  readonly open: number;
  /** Withdrawn here (`next`), or found decided meanwhile (`null`, with why nothing was done). */
  readonly onWithdrawn: (next: AdminProposalWire | null, message?: string) => void;
}) {
  const t = useT();
  const [dialog, setDialog] = useState(false);
  const [reason, setReason] = useState('');

  const notOpenText = t(
    '在你打开之后它已经没有待确认的部分了，什么也没有撤回。下面已经换成它现在的样子。',
    'Nothing of it awaits a decision any more, so nothing was withdrawn. It now shows as it stands.',
  );

  async function withdraw(): Promise<void> {
    const trimmed = reason.trim();
    let next: AdminProposalWire;
    try {
      next = await http.call<AdminProposalWire>('withdraw_admin_proposal', {
        proposalId: proposal.id,
        ...(trimmed !== '' ? { reason: trimmed } : {}),
      });
    } catch (error) {
      // Decided meanwhile: read how it stands now.
      if (describeError(error).code === 'admin_proposal_not_open') {
        onWithdrawn(null, notOpenText);
      }
      throw error;
    }
    onWithdrawn(next);
  }

  return (
    <div className="row-wrap">
      <Confirm
        tier="medium"
        open={dialog}
        onOpenChange={(next) => {
          setDialog(next);
          if (!next) setReason('');
        }}
        anchor={
          <Button
            variant="ghost"
            onClick={() => setDialog(true)}
            data-testid="platform-admin-proposal-withdraw-trigger"
          >
            {t('撤回…', 'Withdraw…')}
          </Button>
        }
        title={t('撤回这份管理员提案', 'Withdraw this admin proposal')}
        description={t(
          '还在待确认的部分都会撤回，之后不能再应用；已经应用、拒绝或撤回的部分保持原样。撤销一个已经应用的工作区部分，由那个工作区的所有者在「安装历史」里做。',
          'Every part still awaiting a decision is withdrawn and can no longer be applied; parts already applied, rejected or withdrawn stay as they are. Rolling back a workspace part that was applied is that workspace owner’s, under Install history.',
        )}
        target={proposal.title}
        impact={[
          t(`撤回 ${open} 个待确认的部分`, `Withdraws ${open} part(s) awaiting a decision`),
          t('平台审计里记一条撤回', 'Records the withdrawal in the platform audit'),
        ]}
        confirmLabel={t('撤回', 'Withdraw')}
        danger
        onConfirm={withdraw}
        errorOverrides={{ admin_proposal_not_open: notOpenText }}
        testId="platform-admin-proposal-withdraw-confirm"
      >
        <Field
          id="platform-admin-proposal-withdraw-reason"
          label={t('撤回理由', 'Reason')}
          hint={t(
            '选填。提议它的管理员智能体、平台管理员和收到它的工作区的所有者都读得到。',
            'Optional. The admin agent that proposed it, the platform’s administrators and the owners of the workspaces it was addressed to all read it.',
          )}
        >
          <Textarea
            id="platform-admin-proposal-withdraw-reason"
            value={reason}
            maxLength={ADMIN_PROPOSAL_REASON_MAX_LENGTH}
            onChange={(event) => setReason(event.target.value)}
            aria-label={t('撤回理由', 'Withdraw reason')}
            aria-describedby={describedBy('platform-admin-proposal-withdraw-reason', true, false)}
            data-testid="platform-admin-proposal-withdraw-reason"
          />
        </Field>
      </Confirm>
    </div>
  );
}

/** The platform part once applied: the record its apply left (F7: the evidence after apply), and
 *  — right after applying it here — what the administrator does next for each instance. */
function PlatformPartRecord({
  http,
  segment,
  applied,
  workspaces,
  onRolledBack,
}: {
  readonly http: CapabilityCaller;
  readonly segment: AdminProposalSegmentWire;
  readonly applied: PlatformSegmentApplyResultWire | null;
  readonly workspaces: WorkspaceRefs;
  readonly onRolledBack: () => void;
}) {
  const t = useT();
  // The record as a rollback here left it: shown as is while the proposal reads again.
  const [rolledBack, setRolledBack] = useState<PlatformChangeSegmentWire | null>(null);
  // The record is found by the segment it came from; the one an apply here returned is used as is.
  const records = useCapabilityList<PlatformChangeSegmentWire>(
    http,
    'list_platform_change_segments',
    {},
    { enabled: applied === null },
  );
  const record =
    rolledBack ??
    applied?.changeSegment ??
    (records.state.status === 'ready'
      ? records.state.data.items.find((item) => item.source.proposalSegmentId === segment.id)
      : undefined);

  return (
    <div className="stack-s">
      {applied !== null && segment.status === 'applied' ? (
        <Notice testId="platform-admin-proposal-next-steps">
          <span className="stack-s">
            <span>
              {t(
                '平台部分已应用。新建的门宿主实例现在是「已发现」，工作区还用不了；每个实例还要做：',
                'The platform part is applied. The new gate-host instances are discovered and no workspace can use them yet; for each, what is left to do:',
              )}
            </span>
            {applied.nextSteps.map((entry) => {
              const item = applied.changeSegment.items.find((i) => i.gateId === entry.gateId);
              return (
                <span className="text-small" key={entry.gateId}>
                  {`${item?.displayName ?? entry.gateId}${t('：', ': ')}`}
                  {entry.steps.map((step) => nextStepText(step, t)).join(t('，然后', ', then '))}
                  {t('。', '. ')}
                  <RouteLink
                    href={hrefs.platformGateInstance(entry.gateId)}
                    className="link-inline"
                  >
                    {t('去门实例页', 'Open the gate instance')}
                  </RouteLink>
                </span>
              );
            })}
          </span>
        </Notice>
      ) : null}
      {record !== undefined ? (
        <>
          <span className="text-small">
            {t('应用时记成了一条平台变更记录：', 'Applying it left a platform change record: ')}
            <RouteLink
              href={hrefs.platformAdminProposals('records', record.id)}
              className="link-inline"
            >
              {t('在「平台变更记录」查看', 'Open it under Platform change records')}
            </RouteLink>
          </span>
          <ChangeRecordBody
            http={http}
            record={record}
            workspaces={workspaces}
            onRolledBack={(next) => {
              if (next !== null) setRolledBack(next);
              onRolledBack();
            }}
          />
        </>
      ) : records.state.status === 'loading' ? (
        <SkeletonRows
          count={2}
          label={t('正在加载平台变更记录…', 'Loading the platform change record')}
        />
      ) : records.state.status === 'error' ? (
        <ErrorBanner
          error={records.state.error}
          title={t('无法加载平台变更记录', 'Could not load the platform change record')}
          onRetry={() => void records.reload()}
          testId="platform-admin-proposal-record-error"
        />
      ) : (
        <p className="text-3 text-small" data-testid="platform-admin-proposal-record-missing">
          {t(
            '它的平台变更记录不在最新的 100 条里。到「平台变更记录」按状态筛选查看。',
            'Its platform change record is not among the newest 100. Filter by status under Platform change records to find it.',
          )}
        </p>
      )}
    </div>
  );
}

/** A platform part that was rejected or withdrawn: why, and what it would have created. */
function ClosedPlatformPart({
  segment,
  presetLabel,
}: {
  readonly segment: AdminProposalSegmentWire;
  readonly presetLabel: PresetLabel;
}) {
  const t = useT();
  const withdrawn = withdrawnText(segment.withdrawnOrigin, t);
  return (
    <div className="stack-s" data-testid="platform-admin-proposal-platform-closed">
      <KeyValue
        items={[
          {
            key: 'decision',
            label: t('决定', 'Decision'),
            value: (
              <span data-testid="platform-admin-proposal-platform-decision">
                {segment.status === 'rejected'
                  ? t('平台管理员拒绝了它', 'A platform administrator rejected it')
                  : (withdrawn ?? t('已撤回', 'Withdrawn'))}
                {segment.decidedAt ? (
                  <>
                    {t('，', ', ')}
                    <span data-volatile="">{formatDateTime(segment.decidedAt)}</span>
                  </>
                ) : null}
              </span>
            ),
          },
          ...(segment.reason !== null
            ? [
                {
                  key: 'reason',
                  label: t('理由', 'Reason'),
                  value: (
                    <span
                      className="pre-wrap wrap-anywhere"
                      data-testid="platform-admin-proposal-platform-reason"
                    >
                      {segment.reason}
                    </span>
                  ),
                },
              ]
            : []),
        ]}
      />
      <span className="text-3 text-small">{t('它提议的是：', 'What it proposed:')}</span>
      {segment.items.map((intent, index) =>
        intent.kind === 'gate_instance' ? (
          <span
            className="text-small"
            key={intent.gateId}
            data-testid={`platform-admin-proposal-intent-${index + 1}`}
          >
            {platformIntentText(intent, t, presetLabel)}
            {t('，地址 ', ', address ')}
            <span className="mono wrap-anywhere">{intent.target}</span>
          </span>
        ) : null,
      )}
    </div>
  );
}

/** How one workspace part stands, by its owner's decision — never what it changes there (F7). */
function workspacePartText(
  segment: AdminProposalSegmentWire,
  platform: AdminProposalSegmentWire | null,
  t: Translate,
): string {
  switch (segment.status) {
    case 'proposed':
      return platform !== null && platform.status === 'proposed'
        ? t(
            '要等平台部分应用之后，所有者才能应用它',
            'Its owner can apply it only once the platform part is applied',
          )
        : t(
            '等工作区所有者在「能力目录 → 管理员提案」里决定',
            'Waiting for the workspace owner to decide under Catalog → Admin proposals',
          );
    case 'applied':
      return t('所有者已应用', 'Applied by its owner');
    case 'rolled_back':
      return t(
        '所有者应用后，又在「安装历史」里撤销了',
        'Applied by its owner, then rolled back under Install history',
      );
    case 'rejected':
      return t('所有者拒绝了它', 'Rejected by its owner');
    case 'withdrawn':
      return withdrawnText(segment.withdrawnOrigin, t) ?? t('已撤回', 'Withdrawn');
  }
}

function WorkspacePart({
  segment,
  platform,
  workspaces,
}: {
  readonly segment: AdminProposalSegmentWire;
  readonly platform: AdminProposalSegmentWire | null;
  readonly workspaces: WorkspaceRefs;
}) {
  const t = useT();
  const prefix = `platform-admin-proposal-workspace-part-${segment.ordinal}`;
  const when = segment.status === 'rolled_back' ? segment.rolledBackAt : segment.decidedAt;
  return (
    <div className="card card-padded stack-s" data-testid={prefix}>
      <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
        {segment.targetWorkspaceId !== null ? (
          <WorkspaceName
            workspaceId={segment.targetWorkspaceId}
            refs={workspaces}
            testId={`${prefix}-workspace`}
          />
        ) : (
          <span />
        )}
        <StatusChip machine="adminProposalSegment" status={segment.status} size="s" />
      </div>
      <span className="text-small" data-testid={`${prefix}-state`}>
        {workspacePartText(segment, platform, t)}
        {when ? (
          <>
            {t('，', ', ')}
            <span data-volatile="">{formatDateTime(when)}</span>
          </>
        ) : null}
      </span>
      {segment.reason !== null ? (
        <span className="text-small pre-wrap wrap-anywhere" data-testid={`${prefix}-reason`}>
          {segment.status === 'rejected'
            ? t('所有者的理由：', 'The owner’s reason: ')
            : t('理由：', 'Reason: ')}
          {segment.reason}
        </span>
      ) : null}
    </div>
  );
}
