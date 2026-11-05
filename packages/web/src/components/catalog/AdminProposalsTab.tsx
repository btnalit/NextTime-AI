import {
  ADMIN_PROPOSAL_REASON_MAX_LENGTH,
  ADMIN_PROPOSAL_SEGMENT_STATUS_VALUES,
  type AdminProposalItemBlockerWire,
  type AdminProposalItemIntentWire,
  type AdminProposalPlatformInstanceChangeWire,
  type AdminProposalPlatformItemIntentWire,
  type AdminProposalPreviewItemWire,
  type AdminProposalSegmentApplyResultWire,
  type AdminProposalSegmentPreviewWire,
  type AdminProposalSegmentStatus,
  type AdminProposalWorkerGateBindingWire,
  type AvailableGateInstanceWire,
  type ChangePrincipalRefWire,
  type GateInstanceDriftField,
  type ReceivedAdminProposalSegmentWire,
} from '@nexttime/shared';
import { useState } from 'react';
import { notifyAdminProposalsDecided } from '../../hooks/useAdminProposalCount.js';
import {
  invalidateCapability,
  useCapability,
  useCapabilityList,
} from '../../hooks/useCapability.js';
import { usePermissions } from '../../hooks/usePermissions.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import { actionLabel as capabilityLabel } from '../../lib/capability-labels.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { credentialReviewParams } from '../../lib/credential-review.js';
import { describeError, isForbiddenError } from '../../lib/errors.js';
import { formatDateTime, formatRelative, shortId } from '../../lib/format.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { operationFieldLabel, principalShownName } from '../../lib/labels.js';
import { hrefs } from '../../lib/router.js';
import { ADMIN_PROPOSAL_SEGMENT_TONES, labelText } from '../../lib/status-tone.js';
import { EnableGateConfirm } from '../connect/EnableGateConfirm.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { CredentialReview } from '../kit/credential-review.js';
import { EmptyState } from '../kit/empty-state.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { Field, describedBy } from '../kit/field.js';
import { KeyValue } from '../kit/key-value.js';
import { List, ListRow } from '../kit/list-row.js';
import { MasterDetail } from '../kit/master-detail.js';
import { Notice } from '../kit/notice.js';
import { RedactedNote } from '../kit/redacted-note.js';
import { RouteLink } from '../kit/route-link.js';
import { Select } from '../kit/select.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { StatusChip } from '../kit/status-chip.js';
import { StillNeeded } from '../kit/still-needed.js';
import { Textarea } from '../kit/textarea.js';
import { announceReadinessChange } from '../readiness/useExecutionReadiness.js';
import {
  changeSubjectText,
  contentFieldText,
  operationValueText,
  typeNamesText,
  wideningText,
} from './ChangesTab.js';
import { MarkdownPreview } from './MarkdownPreview.js';

/**
 * components/catalog/AdminProposalsTab: 能力目录 · 管理员提案 (`#/govern/catalog/proposals`, S11
 * AA4a; plan §3.1–§3.3, §5.4). A platform administrator's 管理员智能体 tries a change out in a
 * trial workspace and proposes it as an **管理员提案**; the part of it for this workspace (its
 * workspace segment, the 工作区部分) arrives here, and only this workspace's owner reads, applies or
 * rejects it (F10-2: every capability below is `minRole: owner`, so the tab is offered to owners
 * alone — `CatalogPage`).
 *
 * The list is `list_admin_proposal_segments` (待确认 by default). A segment still awaiting a
 * decision is reviewed in its detail: `preview_admin_proposal_segment` dry-runs it here — what each
 * intent resolved to in this workspace, item by item as a pack's install review shows it, what in it
 * does not fit (blockers; a system it needs that the owner can enable on the spot), the platform part
 * it depends on, and an instance that part created that has changed since. Applying
 * (`apply_admin_proposal_segment`) carries the reviewed digest, each authority-widening item ticked
 * and — when it holds values that look like credentials — the owner's confirmation; it leaves one
 * install record (安装历史), from where it is rolled back. Rejecting
 * (`reject_admin_proposal_segment`) takes a reason, which this workspace and the platform's
 * administrators read; the admin agent reads only that it was rejected.
 */

export interface AdminProposalsTabProps {
  readonly http: CapabilityCaller;
  /** The selected segment's id (`#/govern/catalog/proposals/<id>`). */
  readonly itemId: string | undefined;
  readonly onSelectItem: (itemId: string | null) => void;
  /** `session.user?.platformRole === 'admin'`: a system the platform has to offer first says so
   *  with a way to 平台 · 集成. */
  readonly platformAdmin?: boolean;
}

type StatusFilter = AdminProposalSegmentStatus | 'all';

/** The reads a decision here makes stale: the list, and — an apply writes versions and leaves an
 *  install record — the catalog's own lists and 安装历史. */
const DECISION_STALE_READS = [
  'list_admin_proposal_segments',
  'preview_admin_proposal_segment',
  'list_change_segments',
  'get_change_segment',
  'list_skills',
  'list_worker_definitions',
  'list_operations',
  'list_packs',
] as const;

/** Refusals that mean what was reviewed is not what is here now: the review is read again. */
const STALE_CODES = new Set([
  'change_plan_changed',
  'admin_proposal_segment_blocked',
  'admin_proposal_segment_unchanged',
  'platform_segment_not_applied',
  'platform_segment_changed',
  'admin_proposal_target_no_longer_chosen',
]);

/** 「平台管理员 Ada 的管理员智能体」 — who proposed it, by the name they had then (as 安装历史 says
 *  it, `ChangesTab`). */
function proposerText(segment: ReceivedAdminProposalSegmentWire, t: Translate): string {
  const { proposedBy } = segment.proposal;
  const name = proposedBy.displayName || shortId(proposedBy.userId);
  return t(`平台管理员 ${name} 的管理员智能体`, `${name}'s admin agent (platform administrator)`);
}

function principalName(ref: ChangePrincipalRefWire, t: Translate): string {
  return principalShownName(ref.displayName, t) ?? shortId(ref.id);
}

/** How a segment that is no longer awaiting a decision came to be where it is. */
function decisionText(segment: ReceivedAdminProposalSegmentWire, t: Translate): string | null {
  const by = segment.decidedBy ? principalName(segment.decidedBy, t) : null;
  switch (segment.status) {
    case 'proposed':
      return null;
    case 'applied':
    case 'rolled_back':
      return by ? t(`由 ${by} 应用`, `Applied by ${by}`) : t('已应用', 'Applied');
    case 'rejected':
      return by ? t(`由 ${by} 拒绝`, `Rejected by ${by}`) : t('已拒绝', 'Rejected');
    case 'withdrawn':
      switch (segment.withdrawnOrigin) {
        case 'agent':
          return t(
            '提议它的平台管理员通过管理员智能体撤回了它',
            'The platform administrator who proposed it withdrew it through their admin agent',
          );
        case 'human':
          return t(
            '平台管理员在控制台撤回了它',
            'A platform administrator withdrew it in the console',
          );
        case 'platform_segment':
          return t(
            '它依赖的平台部分被拒绝或撤销了，这一部分随之撤回，不能再应用',
            'The platform part it depends on was rejected or rolled back, so this part was withdrawn with it and can no longer be applied',
          );
        default:
          return t('已撤回', 'Withdrawn');
      }
  }
}

/** The gate an Operation intent names, by the name the workspace knows it by when it is offered
 *  here (F10-6: never the bare id where a name exists). */
type GateNames = ReadonlyMap<string, string>;

function gateNameOf(gateId: string, names: GateNames): string {
  return names.get(gateId) ?? gateId;
}

/** 「Skill docker-triage」, 「Worker ops-runner」, 「本体 ops-assets」, 「Operation restart（门
 *  Docker prod）」 — an intent as proposed, before it resolves to anything here. */
function intentSubjectText(
  intent: AdminProposalItemIntentWire,
  gates: GateNames,
  t: Translate,
): string {
  switch (intent.kind) {
    case 'skill_version':
      return `Skill ${intent.skill.name}`;
    case 'worker_definition_version': {
      const name = intent.definition.name;
      return typeof name === 'string' && name !== ''
        ? `Worker ${name}`
        : t('Worker（没有名字）', 'Worker (no name)');
    }
    case 'ontology_version':
      return t(`本体 ${intent.family}`, `Ontology ${intent.family}`);
    case 'operation_version':
      return t(
        `Operation ${intent.name}（门 ${gateNameOf(intent.gateId, gates)}）`,
        `Operation ${intent.name} (gate ${gateNameOf(intent.gateId, gates)})`,
      );
  }
}

/** 「新建门宿主实例 RAGFlow（预设 ragflow）」 — what the platform part proposes, without its address
 *  (the platform's; this workspace never connects to it by that). */
function platformItemText(item: AdminProposalPlatformItemIntentWire, t: Translate): string {
  const name = item.displayName ?? item.gateId;
  const from = item.preset
    ? t(`预设 ${item.preset}`, `preset ${item.preset}`)
    : item.connector
      ? t(`接入包 ${item.connector}`, `connector ${item.connector}`)
      : null;
  return from
    ? t(`新建门宿主实例 ${name}（${from}）`, `New gate-host instance ${name} (${from})`)
    : t(`新建门宿主实例 ${name}`, `New gate-host instance ${name}`);
}

const DRIFT_FIELD_LABEL: Readonly<
  Record<GateInstanceDriftField, { readonly zh: string; readonly en: string }>
> = {
  connector: { zh: '接入包', en: 'connector' },
  transportKind: { zh: '接入方式', en: 'transport' },
  target: { zh: '地址', en: 'address' },
  credentialMode: { zh: '凭据方式', en: 'credential mode' },
  manifestSource: { zh: '清单来源', en: 'manifest source' },
  preset: { zh: '预设', en: 'preset' },
};

/** 「RAGFlow：地址、接入包改过」, 「RAGFlow：已删除」 — an instance the platform part created that is
 *  not as it created it any more. */
function platformChangeText(
  change: AdminProposalPlatformInstanceChangeWire,
  names: GateNames,
  t: Translate,
): string {
  const name = gateNameOf(change.gateId, names);
  if (change.gone) return t(`${name}：已删除`, `${name}: deleted`);
  const fields = change.drift.map((field) =>
    t(DRIFT_FIELD_LABEL[field].zh, DRIFT_FIELD_LABEL[field].en),
  );
  return t(`${name}：${fields.join('、')}改过`, `${name}: ${fields.join(', ')} changed`);
}

/** Why an intent does not resolve here, as what the owner can do about it. A gate or system waits
 *  on the platform part only when the kernel says that part creates it (`fromPlatformSegment`):
 *  any other the platform has to offer some other way (UX acceptance of #968, M-1). */
function blockerText(
  blocker: AdminProposalItemBlockerWire,
  subject: string,
  platformPartPending: boolean,
  t: Translate,
): string {
  const waitsOnPlatformPart = platformPartPending && blocker.fromPlatformSegment === true;
  switch (blocker.reason) {
    case 'name_taken':
      return t(
        `${subject}：这个名字在本工作区是入口智能体配置的，不能当作 Worker 发布。只能拒绝，或请平台管理员换个名字重新提议。`,
        `${subject}: here that name is the entry agent configuration’s, so it cannot be published as a Worker. Reject it, or ask a platform administrator to propose it again under another name.`,
      );
    case 'name_ambiguous':
      return t(
        `${subject}：本工作区有不止一个 Worker 叫这个名字，不知道该改哪一个。先在「Worker」页停用多余的那个，再回来看。`,
        `${subject}: more than one Worker here goes by that name, so it cannot tell which to change. Deprecate the extra one on the Workers tab, then come back.`,
      );
    case 'unresolved_references':
      return t(
        `${subject}：它用到本工作区没有的东西（还没发布的 Skill，或 Worker 不能拥有的能力）。在「Skill」页发布它要的 Skill 后再来看，或拒绝它。`,
        `${subject}: it names what this workspace does not have (a Skill with no published version, or a capability a Worker can never hold). Publish the Skill it needs on the Skills tab and come back, or reject it.`,
      );
    case 'gate_not_enabled':
      return blocker.gateAvailability === 'can_enable'
        ? t(
            `${subject}：它要改的系统平台已经提供，本工作区还没启用。可以在下面直接启用，启用后会重新检查。`,
            `${subject}: the platform offers the system it changes, but this workspace has not enabled it. Enable it below; the review is checked again afterwards.`,
          )
        : waitsOnPlatformPart
          ? t(
              `${subject}：它要改的系统由这份提案的平台部分新建，要等平台管理员应用平台部分并启用这个系统，之后才能在这里启用。`,
              `${subject}: the system it changes is the one this proposal’s platform part creates; a platform administrator has to apply that part and enable the system before it can be enabled here.`,
            )
          : t(
              `${subject}：它要改的系统平台还没有提供给工作区，需要平台管理员先提供。`,
              `${subject}: the platform does not offer the system it changes to workspaces yet; a platform administrator has to offer it first.`,
            );
    case 'operation_not_found':
      return t(
        `${subject}：本工作区启用的这个系统里没有叫这个名字的 Operation。可能是系统的版本不同；只能拒绝，或请平台管理员核对后重新提议。`,
        `${subject}: the system this workspace enabled has no Operation by that name — it may run another version. Reject it, or ask a platform administrator to check and propose it again.`,
      );
    case 'operation_revision_invalid':
      return t(
        `${subject}：它要改的设置对本工作区里的这个 Operation 不成立（例如系统自己定死的字段）。只能拒绝，或请平台管理员改过后重新提议。`,
        `${subject}: what it sets does not make a valid revision of this Operation here (such as a field the system itself fixes). Reject it, or ask a platform administrator to revise and propose it again.`,
      );
    case 'worker_system_not_connected': {
      const system = blocker.connector ?? '';
      return blocker.gateAvailability === 'can_enable'
        ? t(
            `${subject}：它要用的系统 ${system} 平台已经提供，本工作区还没启用。可以在下面直接启用，启用后会重新检查。`,
            `${subject}: the platform offers the system it acts on (${system}), but this workspace has not enabled it. Enable it below; the review is checked again afterwards.`,
          )
        : waitsOnPlatformPart
          ? t(
              `${subject}：它要用的系统 ${system} 由这份提案的平台部分新建，要等平台管理员应用平台部分并启用这个系统，之后才能在这里启用。`,
              `${subject}: the system it acts on (${system}) is the one this proposal’s platform part creates; a platform administrator has to apply that part and enable the system before it can be enabled here.`,
            )
          : t(
              `${subject}：它要用的系统 ${system} 平台还没有提供给工作区，需要平台管理员先提供。`,
              `${subject}: the platform does not offer the system it acts on (${system}) to workspaces yet; a platform administrator has to offer it first.`,
            );
    }
  }
}

export function AdminProposalsTab({
  http,
  itemId,
  onSelectItem,
  platformAdmin = false,
}: AdminProposalsTabProps) {
  const t = useT();
  const can = useRoleCan(http);
  const owner = can('list_admin_proposal_segments');
  const [filter, setFilter] = useState<StatusFilter>('proposed');
  const segments = useCapabilityList<ReceivedAdminProposalSegmentWire>(
    http,
    'list_admin_proposal_segments',
    filter === 'all' ? {} : { status: filter },
    { enabled: owner === true },
  );
  const rows = segments.state.status === 'ready' ? segments.state.data.items : [];
  // A segment opened from a link, or one the filter leaves out (just decided): read without it.
  const inRows = itemId !== undefined && rows.some((row) => row.id === itemId);
  const unfiltered = useCapabilityList<ReceivedAdminProposalSegmentWire>(
    http,
    'list_admin_proposal_segments',
    {},
    {
      enabled:
        owner === true &&
        itemId !== undefined &&
        filter !== 'all' &&
        segments.state.status === 'ready' &&
        !inRows,
    },
  );

  // What a decision here returned, held while the lists read again (a filter may leave it out).
  const [held, setHeld] = useState<ReceivedAdminProposalSegmentWire | null>(null);

  if (owner === false) {
    return (
      <Notice testId="catalog-proposals-owner-only">
        {t(
          '管理员提案由工作区所有者审阅、应用或拒绝；这里只有所有者看得到。',
          'Admin proposals are reviewed, applied or rejected by the workspace owner; only the owner sees them here.',
        )}
      </Notice>
    );
  }

  function refresh(decided: ReceivedAdminProposalSegmentWire | null): void {
    if (decided !== null) setHeld(decided);
    for (const name of DECISION_STALE_READS) invalidateCapability(http, name);
    void segments.reload();
    // S11 AA4e: the 能力目录 badge, this tab's count and 待我审批's note follow.
    notifyAdminProposalsDecided();
  }

  const selected =
    itemId === undefined
      ? undefined
      : (rows.find((row) => row.id === itemId) ??
        (unfiltered.state.status === 'ready'
          ? unfiltered.state.data.items.find((row) => row.id === itemId)
          : undefined) ??
        (held?.id === itemId ? held : undefined));

  const list =
    owner === null || segments.state.status === 'loading' ? (
      <SkeletonRows count={3} label={t('正在加载管理员提案…', 'Loading admin proposals')} />
    ) : segments.state.status === 'error' ? (
      <ErrorBanner
        error={segments.state.error}
        title={t('无法加载管理员提案', 'Could not load admin proposals')}
        onRetry={() => void segments.reload()}
        testId="catalog-proposals-error"
      />
    ) : (
      <div className="stack-s">
        <p className="text-3 text-small">
          {t(
            '平台管理员的管理员智能体在试验工作区里做好改动后，会把要用到本工作区的部分发到这里。审阅后应用的，会在「安装历史」留下一条记录，需要时可以整条撤销；不需要的就写明理由拒绝。',
            'When a platform administrator’s admin agent has tried a change out in a trial workspace, the part of it for this workspace arrives here. What you apply after reviewing it leaves an install record under Install history, which can be rolled back as a whole; reject what is not needed, with your reason.',
          )}
        </p>
        <Select
          aria-label={t('按状态筛选', 'Filter by status')}
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value as StatusFilter)}
          data-testid="catalog-proposals-filter"
        >
          {ADMIN_PROPOSAL_SEGMENT_STATUS_VALUES.map((status) => (
            <option key={status} value={status}>
              {labelText(ADMIN_PROPOSAL_SEGMENT_TONES[status], t)}
            </option>
          ))}
          <option value="all">{t('全部', 'All')}</option>
        </Select>
        {rows.length === 0 ? (
          <EmptyState
            title={
              filter === 'proposed'
                ? t('没有待确认的管理员提案', 'No admin proposals awaiting a decision')
                : t('没有这个状态的管理员提案', 'No admin proposals in this status')
            }
            body={t(
              '平台管理员的管理员智能体提议的改动里有本工作区的部分时，会出现在这里。',
              'When a platform administrator’s admin agent proposes a change with a part for this workspace, it shows up here.',
            )}
            testId="catalog-proposals-empty"
          />
        ) : (
          <List ariaLabel={t('管理员提案', 'Admin proposals')} testId="catalog-proposals-list">
            {rows.map((segment) => (
              <ListRow
                key={segment.id}
                testId={`catalog-proposal-row-${segment.id}`}
                selected={segment.id === itemId}
                onSelect={() => onSelectItem(segment.id)}
              >
                <span className="row-wrap" style={{ justifyContent: 'space-between' }}>
                  <span className="truncate">{segment.proposal.title}</span>
                  <StatusChip machine="adminProposalSegment" status={segment.status} size="s" />
                </span>
                <span className="truncate text-3">
                  {proposerText(segment, t)}
                  {' · '}
                  <time
                    dateTime={segment.proposal.proposedAt}
                    title={formatDateTime(segment.proposal.proposedAt)}
                    data-volatile=""
                  >
                    {formatRelative(segment.proposal.proposedAt)}
                  </time>
                </span>
              </ListRow>
            ))}
          </List>
        )}
        {segments.state.data.truncated ? (
          <span className="text-3 text-small" data-testid="catalog-proposals-truncated">
            {t(
              '只列出最新的 100 条；按状态筛选可以看到其余的。',
              'Only the newest 100 are listed; filter by status to see the rest.',
            )}
          </span>
        ) : null}
      </div>
    );

  const detail =
    itemId === undefined ? (
      rows.length > 0 ? (
        <EmptyState
          title={t(
            '选择左侧一份管理员提案，审阅它会在本工作区改动什么',
            'Select an admin proposal on the left to review what it changes here',
          )}
          testId="catalog-detail-empty"
        />
      ) : null
    ) : selected !== undefined ? (
      <AdminProposalSegmentDetail
        key={selected.id}
        http={http}
        segment={selected}
        platformAdmin={platformAdmin}
        onDecided={refresh}
      />
    ) : segments.state.status !== 'ready' ||
      (unfiltered.state.status === 'loading' && filter !== 'all') ? (
      <SkeletonRows count={3} label={t('正在加载管理员提案…', 'Loading admin proposal')} />
    ) : (
      <EmptyState
        title={t('找不到这份管理员提案', 'Admin proposal not found')}
        body={t(
          '它可能是发给另一个工作区的，或者不在最新的 100 条里。',
          'It may be addressed to another workspace, or not among the newest 100.',
        )}
        testId="catalog-proposal-missing"
      />
    );

  return (
    <MasterDetail
      list={list}
      detail={detail}
      open={itemId !== undefined}
      onClose={() => onSelectItem(null)}
      sheetTitle={t('管理员提案', 'Admin proposal')}
      detailTestId="catalog-detail"
    />
  );
}

function AdminProposalSegmentDetail({
  http,
  segment: listed,
  platformAdmin,
  onDecided,
}: {
  readonly http: CapabilityCaller;
  readonly segment: ReceivedAdminProposalSegmentWire;
  readonly platformAdmin: boolean;
  /** `decided`: what an apply or reject here returned; `null`: decided elsewhere meanwhile (read
   *  the list again). */
  readonly onDecided: (decided: ReceivedAdminProposalSegmentWire | null) => void;
}) {
  const t = useT();
  // What this pane's own apply or reject returned: shown until the list catches up.
  const [decided, setDecided] = useState<ReceivedAdminProposalSegmentWire | null>(null);
  const segment = decided !== null && listed.status === 'proposed' ? decided : listed;
  const hasOperations = segment.items.some((item) => item.kind === 'operation_version');
  const offered = useCapabilityList<AvailableGateInstanceWire>(
    http,
    'list_available_gate_instances',
    {},
    { enabled: hasOperations },
  );
  const gateNames: GateNames = new Map([
    ...(segment.platformSegment?.items ?? []).flatMap((item) =>
      item.displayName ? ([[item.gateId, item.displayName]] as const) : [],
    ),
    ...(offered.state.status === 'ready'
      ? offered.state.data.items.map((gate) => [gate.gateId, gate.displayName] as const)
      : []),
  ]);
  const decision = decisionText(segment, t);
  const platform = segment.platformSegment;

  return (
    <div className="stack" data-testid="catalog-proposal-detail">
      <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
        <h2 className="catalog-detail-title wrap-anywhere" data-testid="catalog-proposal-title">
          {segment.proposal.title}
        </h2>
        <StatusChip
          machine="adminProposalSegment"
          status={segment.status}
          testId="catalog-proposal-status"
        />
      </div>
      {segment.proposal.description ? (
        <p className="pre-wrap wrap-anywhere" data-testid="catalog-proposal-description">
          {segment.proposal.description}
        </p>
      ) : null}
      <KeyValue
        items={[
          {
            key: 'proposer',
            label: t('提议人', 'Proposed by'),
            value: <span data-testid="catalog-proposal-proposer">{proposerText(segment, t)}</span>,
          },
          {
            key: 'when',
            label: t('提议时间', 'Proposed'),
            value: <span data-volatile="">{formatDateTime(segment.proposal.proposedAt)}</span>,
          },
          {
            key: 'source',
            label: t('来源名', 'Source name'),
            value: (
              <span
                className="mono wrap-anywhere"
                title={t(
                  '新建的 Skill 和 Worker 以它命名',
                  'New Skills and Workers are named under it',
                )}
              >
                {segment.proposal.sourceName}
              </span>
            ),
          },
          ...(decision !== null
            ? [
                {
                  key: 'decision',
                  label: t('决定', 'Decision'),
                  value: (
                    <span data-testid="catalog-proposal-decision">
                      {decision}
                      {segment.decidedAt ? (
                        <>
                          {t('，', ', ')}
                          <span data-volatile="">{formatDateTime(segment.decidedAt)}</span>
                        </>
                      ) : null}
                    </span>
                  ),
                },
              ]
            : []),
          ...(segment.reason !== null
            ? [
                {
                  key: 'reason',
                  label: t('理由', 'Reason'),
                  value: (
                    <span className="pre-wrap wrap-anywhere" data-testid="catalog-proposal-reason">
                      {segment.reason}
                    </span>
                  ),
                },
              ]
            : []),
        ]}
      />
      {platform !== null ? (
        <Notice
          tone={platform.status === 'applied' ? undefined : 'warn'}
          testId="catalog-proposal-platform"
        >
          <span className="stack-s">
            <span>
              {platform.status === 'applied'
                ? t(
                    '这份提案还有平台部分，平台管理员已经应用：',
                    'This proposal also has a platform part, which a platform administrator has applied:',
                  )
                : platform.status === 'proposed'
                  ? t(
                      '这份提案还有平台部分，要等平台管理员先应用它，这一部分才能应用：',
                      'This proposal also has a platform part; a platform administrator has to apply it before this part can be applied:',
                    )
                  : t(
                      `这份提案的平台部分${labelText(ADMIN_PROPOSAL_SEGMENT_TONES[platform.status], t)}，这一部分不能再应用：`,
                      `This proposal’s platform part is ${labelText(ADMIN_PROPOSAL_SEGMENT_TONES[platform.status], t).toLowerCase()}, so this part can no longer be applied:`,
                    )}
            </span>
            {platform.items.map((item) => (
              <span className="text-small" key={item.gateId}>
                {platformItemText(item, t)}
              </span>
            ))}
          </span>
        </Notice>
      ) : null}

      {segment.status === 'proposed' ? (
        <SegmentReview
          http={http}
          segment={segment}
          gateNames={gateNames}
          offered={offered.state.status === 'ready' ? offered.state.data.items : []}
          platformAdmin={platformAdmin}
          onDecided={(next) => {
            if (next !== null) setDecided(next);
            onDecided(next);
          }}
        />
      ) : (
        <>
          <span className="section-title">{t('提议的内容', 'What it proposes')}</span>
          <div className="stack-s" data-testid="catalog-proposal-intents">
            {segment.items.map((intent, index) => (
              <span
                className="text-small"
                key={`${intent.kind}-${index}`}
                data-testid={`catalog-proposal-intent-${index + 1}`}
              >
                {intentSubjectText(intent, gateNames, t)}
              </span>
            ))}
          </div>
          {segment.appliedSegmentId !== null ? (
            <span className="text-small" data-testid="catalog-proposal-record">
              {segment.status === 'rolled_back'
                ? t('应用后又撤销了：', 'Applied, then rolled back: ')
                : t('应用后记成了一条安装记录：', 'Applying it left an install record: ')}
              <RouteLink href={hrefs.catalog('changes', segment.appliedSegmentId)}>
                {t('在「安装历史」查看', 'Open it under Install history')}
              </RouteLink>
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}

function SegmentReview({
  http,
  segment,
  gateNames,
  offered,
  platformAdmin,
  onDecided,
}: {
  readonly http: CapabilityCaller;
  readonly segment: ReceivedAdminProposalSegmentWire;
  readonly gateNames: GateNames;
  readonly offered: readonly AvailableGateInstanceWire[];
  readonly platformAdmin: boolean;
  /** As `AdminProposalSegmentDetail`'s. */
  readonly onDecided: (segment: ReceivedAdminProposalSegmentWire | null) => void;
}) {
  const t = useT();
  const can = useRoleCan(http);
  const permissions = usePermissions();
  const preview = useCapability<AdminProposalSegmentPreviewWire>(
    http,
    'preview_admin_proposal_segment',
    { segmentId: segment.id },
    { enabled: can('preview_admin_proposal_segment') === true },
  );
  const [confirmed, setConfirmed] = useState<ReadonlySet<number>>(new Set());
  const [credentialsReviewed, setCredentialsReviewed] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('');
  // A refusal that showed the review was out of date: say so above the fresh one.
  const [staleNotice, setStaleNotice] = useState(false);

  function readAgain(): void {
    setConfirmed(new Set());
    setCredentialsReviewed(false);
    invalidateCapability(http, 'preview_admin_proposal_segment');
    void preview.reload();
  }

  if (preview.state.status === 'loading') {
    return (
      <SkeletonRows
        count={3}
        label={t('正在检查它会在这里改动什么…', 'Checking what it changes here')}
      />
    );
  }
  if (preview.state.status === 'error') {
    // Decided meanwhile (409 not open, by someone else or withdrawn): the list says how it
    // stands now, so retrying reads it again.
    const decidedMeanwhile =
      describeError(preview.state.error).code === 'admin_proposal_segment_not_open';
    return (
      <ErrorBanner
        error={preview.state.error}
        title={t('无法检查它会在这里改动什么', 'Could not check what it changes here')}
        onRetry={() => {
          if (decidedMeanwhile) onDecided(null);
          else void preview.reload();
        }}
        testId="catalog-proposal-preview-error"
      />
    );
  }

  const data = preview.state.data;
  const platformPartPending =
    segment.platformSegment !== null && segment.platformSegment.status !== 'applied';
  const widening = data.items.filter(
    (item) => !item.unchanged && item.classification === 'authority_widening',
  );
  const unconfirmed = widening.filter((item) => !confirmed.has(item.ordinal)).length;
  const needsCredentialReview = data.suspectedSecretValues > 0;
  const subjectOf = (ordinal: number): string => {
    const intent = segment.items[ordinal - 1];
    return intent ? intentSubjectText(intent, gateNames, t) : `#${ordinal}`;
  };
  const canApply = can('apply_admin_proposal_segment') !== false;
  const canReject = can('reject_admin_proposal_segment') !== false;
  const changes = data.items.filter((item) => !item.unchanged).length;
  const staleText = t(
    '在你查看之后，工作区或平台上的情况变了，所以什么也没有应用。上面已经换成现在的样子，请重新看一遍再确认。',
    'Things in the workspace or on the platform changed after you looked, so nothing was applied. The review above now shows how things are; look it over again before confirming.',
  );

  async function apply(): Promise<void> {
    if (data.digest === null) return;
    let result: AdminProposalSegmentApplyResultWire;
    try {
      result = await http.call<AdminProposalSegmentApplyResultWire>(
        'apply_admin_proposal_segment',
        {
          segmentId: segment.id,
          reviewedDigest: data.digest,
          // #501 P3: exactly what the owner ticked (I-A4) — a widening item the review gained after
          // the dialog opened is then refused by the kernel, never confirmed on the owner's behalf.
          ...(widening.length > 0
            ? {
                confirmedOrdinals: widening
                  .filter((item) => confirmed.has(item.ordinal))
                  .map((item) => item.ordinal),
              }
            : {}),
          ...credentialReviewParams(needsCredentialReview && credentialsReviewed),
        },
      );
    } catch (error) {
      if (isForbiddenError(error)) permissions.markDenied('apply_admin_proposal_segment');
      const code = describeError(error).code;
      if (STALE_CODES.has(code)) {
        setStaleNotice(true);
        readAgain();
      }
      if (code === 'admin_proposal_segment_not_open') onDecided(null);
      throw error;
    }
    permissions.markAllowed('apply_admin_proposal_segment');
    // A Worker it publishes is what the readiness hint asks for when there is none.
    announceReadinessChange(http);
    onDecided(result.segment);
  }

  async function reject(): Promise<void> {
    let result: ReceivedAdminProposalSegmentWire;
    try {
      result = await http.call<ReceivedAdminProposalSegmentWire>('reject_admin_proposal_segment', {
        segmentId: segment.id,
        reason: reason.trim(),
      });
    } catch (error) {
      if (isForbiddenError(error)) permissions.markDenied('reject_admin_proposal_segment');
      if (describeError(error).code === 'admin_proposal_segment_not_open') onDecided(null);
      throw error;
    }
    permissions.markAllowed('reject_admin_proposal_segment');
    onDecided(result);
  }

  // UX P3-1 (#929): a part that cannot be applied however it is ticked (an instance the platform
  // part created changed since, or nothing to apply) says only why; ticking is left for later.
  // S11 AA4c (governance 0036): the administrator dropped this workspace from their admin agent's
  // targets since it proposed — nothing here can be ticked into an apply.
  const targetDropped = !data.targetChosen;
  const hardBlocked =
    targetDropped ||
    (data.blockers.length === 0 &&
      !platformPartPending &&
      (data.platformChanges.length > 0 || data.unchanged));
  const missing = [
    ...(data.blockers.length > 0
      ? [
          t(
            `处理 ${data.blockers.length} 处对不上的地方`,
            `deal with ${data.blockers.length} problem(s) above`,
          ),
        ]
      : []),
    ...(unconfirmed > 0 && !hardBlocked
      ? [
          t(
            `勾选 ${unconfirmed} 项权限边界确认`,
            `tick ${unconfirmed} authority-boundary confirmation${unconfirmed > 1 ? 's' : ''}`,
          ),
        ]
      : []),
    ...(needsCredentialReview && !credentialsReviewed && !hardBlocked
      ? [t('核对疑似凭据', 'review the suspected credentials')]
      : []),
  ];
  const notReadySentence = targetDropped
    ? t(
        '提议它的平台管理员之后把本工作区从管理员智能体的目标里去掉了，现在不能应用。可以拒绝它，或请对方把本工作区重新加回目标',
        'The platform administrator who proposed it has since removed this workspace from their admin agent’s targets, so it cannot be applied now. Reject it, or ask them to add this workspace back to the targets',
      )
    : data.blockers.length > 0
      ? null
      : platformPartPending
        ? t(
            '要等平台管理员先应用平台部分',
            'A platform administrator has to apply the platform part first',
          )
        : data.platformChanges.length > 0
          ? t(
              '平台部分建好的门宿主实例之后被改过，现在不能应用',
              'A gate-host instance the platform part created has changed since; it cannot be applied now',
            )
          : data.unchanged
            ? t(
                '工作区里已经是它提议的样子，没有要应用的内容',
                'The workspace already is as it proposes; there is nothing to apply',
              )
            : null;
  // UX P3-2 (#929): after 「还差：…；」 the reason continues the sentence (no capital in English).
  const notReadyReason =
    notReadySentence !== null && missing.length > 0
      ? notReadySentence.charAt(0).toLowerCase() + notReadySentence.slice(1)
      : notReadySentence;

  return (
    <div className="stack" data-testid="catalog-proposal-review">
      {staleNotice ? (
        <Notice tone="warn" testId="catalog-proposal-stale">
          {staleText}
        </Notice>
      ) : null}
      {targetDropped ? (
        <Notice tone="warn" testId="catalog-proposal-target-dropped">
          {t(
            '提议它的平台管理员之后把本工作区从管理员智能体的目标里去掉了：这份管理员提案还在，但不能应用。可以拒绝它；如果还需要，请对方把本工作区重新加回目标，它就能照原样应用。',
            'The platform administrator who proposed it has since removed this workspace from their admin agent’s targets: the admin proposal is still here, but it cannot be applied. Reject it; if it is still wanted, ask them to add this workspace back to the targets and it can be applied as it is.',
          )}
        </Notice>
      ) : null}
      {data.blockers.length > 0 ? (
        <Notice tone="warn" testId="catalog-proposal-blockers">
          <span className="stack-s">
            <span>
              {t(
                '其中有内容在本工作区里对不上，处理好之前不能应用：',
                'Part of it does not fit this workspace; it cannot be applied until that is dealt with:',
              )}
            </span>
            {data.blockers.map((blocker, index) => (
              <BlockerLine
                // A Worker has one blocker per system it names that is not connected (AA5f), so
                // the ordinal alone is not unique.
                key={`${blocker.ordinal}-${index}`}
                http={http}
                blocker={blocker}
                intent={segment.items[blocker.ordinal - 1]}
                subject={subjectOf(blocker.ordinal)}
                offered={offered}
                platformPartPending={platformPartPending}
                platformAdmin={platformAdmin}
                onEnabled={readAgain}
              />
            ))}
          </span>
        </Notice>
      ) : null}
      {data.platformChanges.length > 0 ? (
        <Notice tone="warn" testId="catalog-proposal-platform-changes">
          <span className="stack-s">
            <span>
              {t(
                '平台部分建好的门宿主实例，之后在平台上被改过，和你要审阅的已经不一样，现在不能应用。可以拒绝它，或请平台管理员改回原样：',
                'A gate-host instance the platform part created was changed on the platform since, so it is not what you would be reviewing; it cannot be applied now. Reject it, or ask a platform administrator to put it back as it was:',
              )}
            </span>
            {data.platformChanges.map((change) => (
              <span className="text-small" key={change.gateId}>
                {platformChangeText(change, gateNames, t)}
              </span>
            ))}
          </span>
        </Notice>
      ) : null}

      {data.items.length > 0 ? (
        <>
          <span className="section-title">
            {platformPartPending
              ? t(
                  '平台部分应用后，它会在这里改动',
                  'Once the platform part is applied, it changes here',
                )
              : t('它会在这里改动', 'What it changes here')}
          </span>
          <div className="stack-s" data-testid="catalog-proposal-items">
            {data.items.map((item) => (
              <ReviewItem
                key={item.ordinal}
                item={item}
                disabled={hardBlocked}
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
          <span className="section-title">{t('提议的内容', 'What it proposes')}</span>
          <div className="stack-s" data-testid="catalog-proposal-intents">
            {segment.items.map((intent, index) => (
              <span
                className="text-small"
                key={`${intent.kind}-${index}`}
                data-testid={`catalog-proposal-intent-${index + 1}`}
              >
                {intentSubjectText(intent, gateNames, t)}
              </span>
            ))}
          </div>
        </>
      )}

      <CredentialReview
        count={data.suspectedSecretValues}
        paths={data.suspectedSecretPaths}
        subject="publish"
        checked={credentialsReviewed}
        onChange={setCredentialsReviewed}
      />

      {canApply || canReject ? (
        <div className="stack-s">
          <div className="row-wrap">
            {canApply ? (
              <Confirm
                tier="medium"
                open={applyOpen}
                onOpenChange={setApplyOpen}
                anchor={
                  <Button
                    variant="primary"
                    disabled={
                      data.digest === null ||
                      targetDropped ||
                      data.unchanged ||
                      data.blockers.length > 0 ||
                      unconfirmed > 0 ||
                      (needsCredentialReview && !credentialsReviewed)
                    }
                    onClick={() => setApplyOpen(true)}
                    aria-describedby="catalog-proposal-missing"
                    data-testid="catalog-proposal-apply-trigger"
                  >
                    {t('应用…', 'Apply…')}
                  </Button>
                }
                title={t('应用这份管理员提案', 'Apply this admin proposal')}
                target={segment.proposal.title}
                impact={[
                  t(
                    `在本工作区写入 ${changes} 项改动，记成一条安装记录（来源：管理员提案 ${segment.proposal.sourceName}）`,
                    `Writes ${changes} change(s) in this workspace as one install record (source: admin proposal ${segment.proposal.sourceName})`,
                  ),
                  t(
                    '发布的版本记为由管理员智能体起草、由你发布',
                    'The versions it publishes are recorded as drafted by an admin agent and published by you',
                  ),
                  t(
                    '需要时可以在「安装历史」里整条撤销',
                    'It can be rolled back as a whole under Install history if needed',
                  ),
                ]}
                confirmLabel={t('应用', 'Apply')}
                danger={widening.length > 0}
                confirmDisabled={data.digest === null}
                onConfirm={apply}
                errorOverrides={{
                  change_plan_changed: staleText,
                  admin_proposal_segment_blocked: staleText,
                  platform_segment_changed: staleText,
                  admin_proposal_target_no_longer_chosen: t(
                    '提议它的平台管理员刚把本工作区从管理员智能体的目标里去掉了，所以什么也没有应用。上面已经换成现在的样子：可以拒绝它，或请对方把本工作区重新加回目标。',
                    'The platform administrator who proposed it has just removed this workspace from their admin agent’s targets, so nothing was applied. The review above now shows how things are: reject it, or ask them to add this workspace back to the targets.',
                  ),
                }}
                testId="catalog-proposal-apply-confirm"
              />
            ) : null}
            {canReject ? (
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
                    data-testid="catalog-proposal-reject-trigger"
                  >
                    {t('拒绝…', 'Reject…')}
                  </Button>
                }
                title={t('拒绝这份管理员提案', 'Reject this admin proposal')}
                description={t(
                  '拒绝后它不能再应用，工作区里什么也不会改。理由会留在这个工作区，平台管理员也看得到；提议它的管理员智能体只知道被拒绝了，看不到理由。',
                  'Once rejected it can never be applied, and nothing in the workspace changes. The reason stays with this workspace and the platform’s administrators read it too; the admin agent that proposed it learns only that it was rejected, not why.',
                )}
                target={segment.proposal.title}
                confirmLabel={t('拒绝', 'Reject')}
                danger
                confirmDisabled={reason.trim() === ''}
                onConfirm={reject}
                testId="catalog-proposal-reject-confirm"
              >
                <Field
                  id="catalog-proposal-reject-reason"
                  label={t('拒绝理由', 'Reason')}
                  hint={t(
                    '必填：为什么不采用它。只有本工作区和平台管理员看得到。',
                    'Required: why it is not taken. Only this workspace and the platform’s administrators read it.',
                  )}
                  required
                >
                  <Textarea
                    id="catalog-proposal-reject-reason"
                    value={reason}
                    maxLength={ADMIN_PROPOSAL_REASON_MAX_LENGTH}
                    onChange={(event) => setReason(event.target.value)}
                    aria-label={t('拒绝理由', 'Reject reason')}
                    aria-required
                    aria-describedby={describedBy('catalog-proposal-reject-reason', true, false)}
                    data-testid="catalog-proposal-reject-reason"
                  />
                </Field>
              </Confirm>
            ) : null}
          </div>
          <div id="catalog-proposal-missing">
            <StillNeeded
              items={missing}
              reason={notReadyReason}
              testId="catalog-proposal-missing-steps"
            />
          </div>
        </div>
      ) : (
        <p className="text-3 text-small" data-testid="catalog-proposal-owner-only">
          {t(
            '应用或拒绝管理员提案由工作区所有者操作。',
            'A workspace owner applies or rejects admin proposals.',
          )}
        </p>
      )}
    </div>
  );
}

function BlockerLine({
  http,
  blocker,
  intent,
  subject,
  offered,
  platformPartPending,
  platformAdmin,
  onEnabled,
}: {
  readonly http: CapabilityCaller;
  readonly blocker: AdminProposalItemBlockerWire;
  readonly intent: AdminProposalItemIntentWire | undefined;
  readonly subject: string;
  readonly offered: readonly AvailableGateInstanceWire[];
  readonly platformPartPending: boolean;
  readonly platformAdmin: boolean;
  readonly onEnabled: () => void;
}) {
  const t = useT();
  const can = useRoleCan(http);
  const gateId = intent?.kind === 'operation_version' ? intent.gateId : null;
  const gate =
    gateId !== null ? offered.find((candidate) => candidate.gateId === gateId) : undefined;
  return (
    <span
      className="stack-s text-small"
      data-testid={`catalog-proposal-blocker-${blocker.ordinal}`}
    >
      <span>{blockerText(blocker, subject, platformPartPending, t)}</span>
      {blocker.reason === 'gate_not_enabled' &&
      blocker.gateAvailability === 'can_enable' &&
      gateId !== null ? (
        can('enable_gate_instance') !== false ? (
          <span className="row-wrap">
            <EnableGateConfirm
              key={gateId}
              http={http}
              gateId={gateId}
              gateDisplayName={gate?.displayName ?? gateId}
              platformAdmin={platformAdmin}
              onEnabled={onEnabled}
              testId={`catalog-proposal-blocker-${blocker.ordinal}-enable`}
            />
          </span>
        ) : null
      ) : null}
      {blocker.reason === 'worker_system_not_connected' &&
      blocker.gateAvailability === 'can_enable' &&
      (blocker.offered ?? []).length > 0 ? (
        can('enable_gate_instance') !== false ? (
          <span className="row-wrap">
            {(blocker.offered ?? []).map((offer) => (
              <EnableGateConfirm
                key={offer.gateId}
                http={http}
                gateId={offer.gateId}
                gateDisplayName={offer.displayName}
                platformAdmin={platformAdmin}
                onEnabled={onEnabled}
                testId={`catalog-proposal-blocker-${blocker.ordinal}-enable-${offer.gateId}`}
              />
            ))}
          </span>
        ) : null
      ) : null}
      {blocker.reason === 'worker_system_not_connected' &&
      blocker.gateAvailability !== 'can_enable' &&
      platformAdmin ? (
        <RouteLink href={hrefs.platformIntegrations()}>
          {t('去「平台 · 集成」', 'Open Platform · Integrations')}
        </RouteLink>
      ) : null}
      {blocker.reason === 'gate_not_enabled' &&
      blocker.gateAvailability !== 'can_enable' &&
      platformAdmin ? (
        <RouteLink
          href={
            gateId !== null && !(platformPartPending && blocker.fromPlatformSegment === true)
              ? hrefs.platformGateInstance(gateId)
              : hrefs.platformIntegrations()
          }
        >
          {t('去「平台 · 集成」', 'Open Platform · Integrations')}
        </RouteLink>
      ) : null}
    </span>
  );
}

/** S11 AA5f: how applying binds a proposed Worker that names its systems and has no gates here
 *  yet — to the gates it keeps (`gates`) of those systems; and the ones among them the person
 *  previewing does not hold (binding grants nothing: 系统与授权 does). Until they hold them, a goal
 *  step using the Worker is refused outright (`authority_lost: gates`), and so is delegating to it
 *  when it holds an execute-class capability (`InvokeWorkerAttenuationError`); one that only
 *  observes drops those gates and goes on (#501 on #968, P3-1). The owner cannot tell those apart
 *  here, so delegating "may be" refused (UX re-check of #968). */
function workerGateBindingText(
  binding: AdminProposalWorkerGateBindingWire,
  gates: readonly { readonly id: string; readonly name: string }[],
  t: Translate,
): string {
  const systems = binding.systems.join(t('、', ', '));
  if (gates.length === 0) {
    return t(
      `接入的系统：它要用 ${systems}，这次应用一个门都不绑`,
      `Systems: it acts on ${systems}; this apply binds it to no gate`,
    );
  }
  const names = gates.map((gate) => gate.name).join(t('、', ', '));
  const kept = new Set(gates.map((gate) => gate.id));
  const notHeld = binding.candidates
    .filter((candidate) => kept.has(candidate.id) && !candidate.held)
    .map((candidate) => candidate.name);
  const bound = t(
    `接入的系统：它要用 ${systems}，应用时绑到本工作区的 ${names}`,
    `Systems: it acts on ${systems}; applying binds it to ${names} here`,
  );
  if (notHeld.length === 0) return bound;
  const them = notHeld.length === 1 ? 'it' : 'them';
  return t(
    `${bound}。其中 ${notHeld.join('、')} 你还没有授权给自己：授权之前，目标里用到这个 Worker 的步骤会被拒绝，你的智能体委派它也可能被拒。先在「系统与授权」里授权`,
    `${bound}. You do not hold ${notHeld.join(', ')} yet: until you grant ${them} to yourself on Systems & access, goal steps that use this Worker are refused, and your agent may be refused when it delegates to it`,
  );
}

/** 「Skill docker-triage：新建」, 「Worker ops-runner：第 2 版 → 新的一版」 — what one item does to
 *  its family here. */
function itemHeadline(item: AdminProposalPreviewItemWire, t: Translate): string {
  const subject = changeSubjectText(item, t);
  if (item.unchanged) {
    return t(`${subject}：已经是提议的样子，不改动`, `${subject}: already as proposed, left as is`);
  }
  if (item.kind !== 'operation_version' && item.before === null) {
    return t(`${subject}：本工作区还没有，新建`, `${subject}: not here yet, created`);
  }
  const before = item.before;
  return before === null
    ? subject
    : t(
        `${subject}：第 ${before.version} 版 → 新的一版`,
        `${subject}: v${before.version} → a new version`,
      );
}

function ReviewItem({
  item,
  disabled,
  checked,
  onCheckedChange,
}: {
  readonly item: AdminProposalPreviewItemWire;
  /** It cannot be applied whatever is ticked (`hardBlocked`): the confirmation waits. */
  readonly disabled: boolean;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  const t = useT();
  const prefix = `catalog-proposal-item-${item.ordinal}`;
  return (
    <div className="card card-padded stack-s" data-testid={prefix}>
      <span>{itemHeadline(item, t)}</span>
      {item.unchanged ? null : (
        <>
          <ItemChanges item={item} prefix={prefix} />
          {item.classification === 'authority_widening' ? (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(event) => onCheckedChange(event.currentTarget.checked)}
                data-testid={`${prefix}-confirm`}
              />
              <span>
                {t('我确认这会改变权限边界：', 'I confirm this moves an authority boundary: ')}
                {item.widening.map((w) => wideningText(w, t)).join(t('；', '; '))}
              </span>
            </label>
          ) : null}
        </>
      )}
    </div>
  );
}

function stringList(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as string[])
    : null;
}

function ItemChanges({
  item,
  prefix,
}: {
  readonly item: AdminProposalPreviewItemWire;
  readonly prefix: string;
}) {
  const t = useT();
  if (item.kind === 'ontology_version') {
    const added = typeNamesText(item.types.added, t);
    const changed = typeNamesText(item.types.changed, t);
    const removed = typeNamesText(item.types.removed, t);
    return (
      <>
        {added ? (
          <span className="text-3 text-small">
            {t('新增：', 'Adds: ')}
            {added}
          </span>
        ) : null}
        {changed ? (
          <span className="text-3 text-small">
            {t('修改：', 'Changes: ')}
            {changed}
          </span>
        ) : null}
        {removed ? (
          <span className="text-3 text-small">
            {t('应用后不再有：', 'Afterwards no longer has: ')}
            {removed}
          </span>
        ) : null}
      </>
    );
  }
  if (item.kind === 'operation_version') {
    return item.fields.length > 0 ? (
      <div className="stack-s" data-testid={`${prefix}-fields`}>
        {item.fields.map((change) => (
          <span className="text-3 text-small" key={change.field}>
            {`${operationFieldLabel(change.field, t)}${t('：', ': ')}${operationValueText(change.field, change.before, t)} → ${operationValueText(change.field, change.after, t)}`}
          </span>
        ))}
        <RedactedNote
          value={item.fields.map((change) => [change.before, change.after])}
          testId={`${prefix}-redacted`}
        />
      </div>
    ) : null;
  }
  const changed =
    item.before !== null && item.changedFields.length > 0
      ? item.changedFields.map((field) => contentFieldText(field, t)).join(t('、', ', '))
      : null;
  if (item.kind === 'skill_version') {
    return (
      <>
        <span className="text-3 text-small">{item.skill.description}</span>
        {changed ? (
          <span className="text-3 text-small" data-testid={`${prefix}-changed`}>
            {t('和工作区里现在的相比，改动了：', 'Differs from what the workspace has in: ')}
            {changed}
          </span>
        ) : null}
        <details className="disclosure" data-testid={`${prefix}-content`}>
          <summary>{t('查看 Skill 正文', 'Show the Skill body')}</summary>
          <div className="disclosure-body">
            <MarkdownPreview markdown={item.skill.markdown} />
          </div>
        </details>
      </>
    );
  }
  const { definition } = item;
  const description = typeof definition.description === 'string' ? definition.description : null;
  const systemPrompt = typeof definition.systemPrompt === 'string' ? definition.systemPrompt : '';
  const skills = stringList(definition.skills) ?? [];
  const capabilities = stringList(definition.capabilities);
  const egressDeny = stringList(definition.egressDeny) ?? [];
  return (
    <>
      {description ? <span className="text-3 text-small">{description}</span> : null}
      {changed ? (
        <span className="text-3 text-small" data-testid={`${prefix}-changed`}>
          {t('和工作区里现在的相比，改动了：', 'Differs from what the workspace has in: ')}
          {changed}
        </span>
      ) : null}
      <span className="text-3 text-small" data-testid={`${prefix}-skills`}>
        {t('挂载的 Skill：', 'Mounted Skills: ')}
        {skills.length > 0 ? skills.join(t('、', ', ')) : t('无', 'none')}
      </span>
      <span className="text-3 text-small" data-testid={`${prefix}-capabilities`}>
        {t('能力范围：', 'Capabilities: ')}
        {capabilities === null
          ? t(
              '平台默认：查询台账、只读查看已接入的系统、提出建议；不能执行需要审批的操作',
              'the platform default: read the records, read connected systems, propose; it cannot run anything that needs approval',
            )
          : capabilities.map((capability) => capabilityLabel(capability, t)).join(t('、', ', '))}
      </span>
      {egressDeny.length > 0 ? (
        <span className="text-3 text-small">
          {t('禁止访问的地址：', 'Denied hosts: ')}
          {egressDeny.join(t('、', ', '))}
        </span>
      ) : null}
      <span className="text-3 text-small" data-testid={`${prefix}-gates`}>
        {item.gateBinding.source === 'apply'
          ? workerGateBindingText(item.gateBinding, item.gates, t)
          : item.newFamily
            ? t(
                '接入的系统：新的 Worker 不接入任何系统；应用后在「Worker」页给它选',
                'Systems: a new Worker is connected to none; pick some on the Workers tab afterwards',
              )
            : item.gates.length > 0
              ? t(
                  `接入的系统：沿用工作区为它选的 ${item.gates.map((gate) => gate.name).join('、')}`,
                  `Systems: keeps the ones the workspace chose, ${item.gates.map((gate) => gate.name).join(', ')}`,
                )
              : t(
                  '接入的系统：沿用工作区的设置，不接入任何系统',
                  'Systems: keeps the workspace’s setting, none',
                )}
      </span>
      <details className="disclosure" data-testid={`${prefix}-content`}>
        <summary>{t('查看系统提示词', 'Show the system prompt')}</summary>
        <div className="disclosure-body">
          <pre className="code-block pre-wrap">{systemPrompt}</pre>
        </div>
      </details>
    </>
  );
}
