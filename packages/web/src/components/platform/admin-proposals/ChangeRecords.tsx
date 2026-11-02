import type {
  GateInstanceWire,
  PlatformChangeRollbackPreviewWire,
  PlatformChangeRollbackResultWire,
  PlatformChangeSegmentStatus,
  PlatformChangeSegmentWire,
} from '@nexttime/shared';
import { PLATFORM_CHANGE_SEGMENT_STATUS_VALUES } from '@nexttime/shared';
import { useMemo, useRef, useState } from 'react';
import {
  invalidateCapability,
  useCapability,
  useCapabilityList,
} from '../../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../../lib/clients.js';
import { describeError } from '../../../lib/errors.js';
import { formatDateTime, formatRelative } from '../../../lib/format.js';
import { type Translate, useT } from '../../../lib/i18n.js';
import { hrefs } from '../../../lib/router.js';
import { PLATFORM_CHANGE_SEGMENT_TONES, labelText } from '../../../lib/status-tone.js';
import { Button } from '../../kit/button.js';
import { Confirm } from '../../kit/confirm.js';
import { EmptyState } from '../../kit/empty-state.js';
import { ErrorBanner } from '../../kit/error-banner.js';
import { KeyValue } from '../../kit/key-value.js';
import { List, ListRow } from '../../kit/list-row.js';
import { MasterDetail } from '../../kit/master-detail.js';
import { Notice } from '../../kit/notice.js';
import { RouteLink } from '../../kit/route-link.js';
import { Select } from '../../kit/select.js';
import { SkeletonRows } from '../../kit/skeleton.js';
import { StatusChip } from '../../kit/status-chip.js';
import { StillNeeded } from '../../kit/still-needed.js';
import { InstanceFacts } from './PlatformSegmentReview.js';
import { usePresetLabel } from './preset-labels.js';
import { ADMIN_PROPOSAL_STALE_READS } from './stale-reads.js';
import {
  currentStateText,
  driftFieldsText,
  proposerText,
  rollbackActionText,
  userName,
} from './text.js';
import { WorkspaceName, type WorkspaceRefs, useWorkspaceRefs } from './workspace-refs.js';

type StatusFilter = PlatformChangeSegmentStatus | 'all';

/** 「RAGFlow、Docker prod」 — the instances a record created, by name. */
function recordSubject(record: PlatformChangeSegmentWire): string {
  return record.items.map((item) => item.displayName || item.gateId).join('、');
}

/**
 * 平台 · 管理员提案 · 平台变更记录 (S11 AA4b; the AA4 plan F7): what applying admin proposals'
 * platform parts changed on the platform (`list_platform_change_segments`), and each record's
 * detail. Only those changes: what an administrator changes by hand is in 平台审计.
 */
export function ChangeRecordsTab({
  http,
  itemId,
  onSelectItem,
}: {
  readonly http: CapabilityCaller;
  readonly itemId: string | undefined;
  readonly onSelectItem: (id: string | null) => void;
}) {
  const t = useT();
  const [filter, setFilter] = useState<StatusFilter>('all');
  const records = useCapabilityList<PlatformChangeSegmentWire>(
    http,
    'list_platform_change_segments',
    filter === 'all' ? {} : { status: filter },
  );
  const rows = records.state.status === 'ready' ? records.state.data.items : [];

  const list =
    records.state.status === 'loading' ? (
      <SkeletonRows
        count={3}
        label={t('正在加载平台变更记录…', 'Loading platform change records')}
      />
    ) : records.state.status === 'error' ? (
      <ErrorBanner
        error={records.state.error}
        title={t('无法加载平台变更记录', 'Could not load platform change records')}
        onRetry={() => void records.reload()}
        testId="platform-change-records-error"
      />
    ) : (
      <div className="stack-s">
        <Notice testId="platform-change-records-scope">
          <span>
            {t(
              '这里只记应用管理员提案平台部分的改动；手动做的改动看平台审计。',
              'Only what applying admin proposals’ platform parts changed is recorded here; for changes made by hand, see the platform audit.',
            )}{' '}
            <RouteLink href={hrefs.platformAudit()} className="link-inline">
              {t('打开平台审计', 'Open the platform audit')}
            </RouteLink>
          </span>
        </Notice>
        <Select
          aria-label={t('按状态筛选', 'Filter by status')}
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value as StatusFilter)}
          data-testid="platform-change-records-filter"
        >
          <option value="all">{t('全部', 'All')}</option>
          {PLATFORM_CHANGE_SEGMENT_STATUS_VALUES.map((status) => (
            <option key={status} value={status}>
              {labelText(PLATFORM_CHANGE_SEGMENT_TONES[status], t)}
            </option>
          ))}
        </Select>
        {rows.length === 0 ? (
          <EmptyState
            title={
              filter === 'all'
                ? t('还没有平台变更记录', 'No platform change records yet')
                : t('没有这个状态的平台变更记录', 'No platform change records in this status')
            }
            body={t(
              '在「管理员提案」里应用一份提案的平台部分后，它在平台上新建的门宿主实例会记成一条记录，出现在这里。',
              'Once you apply an admin proposal’s platform part under Admin proposals, the gate-host instances it creates are recorded here.',
            )}
            testId="platform-change-records-empty"
          />
        ) : (
          <List
            ariaLabel={t('平台变更记录', 'Platform change records')}
            testId="platform-change-records-list"
          >
            {rows.map((record) => (
              <ListRow
                key={record.id}
                testId={`platform-change-record-row-${record.id}`}
                selected={record.id === itemId}
                onSelect={() => onSelectItem(record.id)}
              >
                <span className="row-wrap" style={{ justifyContent: 'space-between' }}>
                  <span className="truncate">
                    {t(
                      `新建门宿主实例 ${recordSubject(record)}`,
                      `New gate-host instance ${recordSubject(record)}`,
                    )}
                  </span>
                  <StatusChip machine="platformChangeSegment" status={record.status} size="s" />
                </span>
                <span className="truncate text-3">
                  {t(
                    `来源：管理员提案 ${record.source.name}`,
                    `Source: admin proposal ${record.source.name}`,
                  )}
                </span>
                <span className="truncate text-3 text-small">
                  {t(
                    `由 ${userName(record.appliedBy)} 应用`,
                    `Applied by ${userName(record.appliedBy)}`,
                  )}
                  {' · '}
                  <time
                    dateTime={record.appliedAt}
                    title={formatDateTime(record.appliedAt)}
                    data-volatile=""
                  >
                    {formatRelative(record.appliedAt)}
                  </time>
                </span>
              </ListRow>
            ))}
          </List>
        )}
        {records.state.data.truncated ? (
          <span className="text-3 text-small" data-testid="platform-change-records-truncated">
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
            '选择左侧一条记录，查看它建了什么、现在怎样，以及撤销',
            'Select a record on the left to see what it created, how it stands now, and its rollback',
          )}
          testId="platform-change-record-detail-empty"
        />
      ) : null
    ) : (
      <ChangeRecordDetail
        key={itemId}
        http={http}
        changeSegmentId={itemId}
        onChanged={() => void records.reload()}
      />
    );

  return (
    <MasterDetail
      list={list}
      detail={detail}
      open={itemId !== undefined}
      onClose={() => onSelectItem(null)}
      sheetTitle={t('平台变更记录', 'Platform change record')}
      detailTestId="platform-change-record-pane"
    />
  );
}

function ChangeRecordDetail({
  http,
  changeSegmentId,
  onChanged,
}: {
  readonly http: CapabilityCaller;
  readonly changeSegmentId: string;
  readonly onChanged: () => void;
}) {
  const t = useT();
  const read = useCapability<PlatformChangeSegmentWire>(http, 'get_platform_change_segment', {
    changeSegmentId,
  });
  const workspaces = useWorkspaceRefs(http);
  if (read.state.status === 'loading') {
    return (
      <SkeletonRows
        count={4}
        label={t('正在加载平台变更记录…', 'Loading the platform change record')}
      />
    );
  }
  if (read.state.status === 'error') {
    if (describeError(read.state.error).code === 'platform_change_segment_not_found') {
      return (
        <EmptyState
          title={t('找不到这条平台变更记录', 'Platform change record not found')}
          body={t(
            '链接可能不对。回到左侧列表重新选择。',
            'The link may be wrong. Pick it again from the list.',
          )}
          testId="platform-change-record-missing"
        />
      );
    }
    return (
      <ErrorBanner
        error={read.state.error}
        title={t('无法加载平台变更记录', 'Could not load the platform change record')}
        onRetry={() => void read.reload()}
        testId="platform-change-record-error"
      />
    );
  }
  const record = read.state.data;
  return (
    <div className="stack" data-testid="platform-change-record-detail">
      <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
        <h2 className="catalog-detail-title wrap-anywhere">
          {t(
            `新建门宿主实例 ${recordSubject(record)}`,
            `New gate-host instance ${recordSubject(record)}`,
          )}
        </h2>
        <StatusChip
          machine="platformChangeSegment"
          status={record.status}
          testId="platform-change-record-status"
        />
      </div>
      <ChangeRecordBody
        http={http}
        record={record}
        workspaces={workspaces}
        onRolledBack={(next) => {
          if (next !== null) read.mutate(() => next);
          else void read.reload();
          onChanged();
        }}
        linkProposal
      />
    </div>
  );
}

/**
 * A platform change record (F7's evidence after apply): where it came from, who applied it, each
 * instance it created as created, how each stands now, and its rollback. How each stands now is
 * read live from `preview_roll_back_platform_change_segment` every time the record opens (the AA4
 * plan F8 (b)) — for a record rolled back already too, so what shows is the state now, never a
 * conclusion kept from before the rollback (legacy 603's trap).
 */
export function ChangeRecordBody({
  http,
  record,
  workspaces,
  onRolledBack,
  linkProposal = false,
}: {
  readonly http: CapabilityCaller;
  readonly record: PlatformChangeSegmentWire;
  readonly workspaces: WorkspaceRefs;
  /** The record rolled back here (or `null`: read it again). */
  readonly onRolledBack: (record: PlatformChangeSegmentWire | null) => void;
  /** Where the record is shown apart from its proposal: a link back to it. */
  readonly linkProposal?: boolean;
}) {
  const t = useT();
  const presetLabel = usePresetLabel(http);
  const now = useCapability<PlatformChangeRollbackPreviewWire>(
    http,
    'preview_roll_back_platform_change_segment',
    { changeSegmentId: record.id },
  );
  const [result, setResult] = useState<PlatformChangeRollbackResultWire | null>(null);
  // Why a rollback did nothing (the record or the platform moved after the dry run): it stays in
  // view beside how things stand now, read again.
  const [stale, setStale] = useState<string | null>(null);
  // How things stood as last read: it stays on screen while it is read again, so the rollback
  // and what it just said are not unmounted by the reload.
  const shownNow = useRef<PlatformChangeRollbackPreviewWire | null>(null);
  if (now.state.status === 'ready') shownNow.current = now.state.data;
  const nowData = now.state.status === 'ready' ? now.state.data : shownNow.current;
  const nameOf = (gateId: string): string =>
    record.items.find((item) => item.gateId === gateId)?.displayName || gateId;

  return (
    <div className="stack" data-testid={`platform-change-record-${record.id}`}>
      <KeyValue
        items={[
          {
            key: 'source',
            label: t('来源', 'Source'),
            value: (
              <span data-testid="platform-change-record-source">
                {t(`管理员提案 ${record.source.name}`, `Admin proposal ${record.source.name}`)}
                {linkProposal ? (
                  <>
                    {t('，', ', ')}
                    <RouteLink
                      href={hrefs.platformAdminProposals('proposals', record.source.proposalId)}
                      className="link-inline"
                    >
                      {t('查看这份管理员提案', 'open the admin proposal')}
                    </RouteLink>
                  </>
                ) : null}
              </span>
            ),
          },
          {
            key: 'proposer',
            label: t('提议人', 'Proposed by'),
            value: proposerText(record.proposedBy, t),
          },
          {
            key: 'applied',
            label: t('应用', 'Applied'),
            value: (
              <span data-testid="platform-change-record-applied">
                {t(`由 ${userName(record.appliedBy)} 应用`, `By ${userName(record.appliedBy)}`)}
                {t('，', ', ')}
                <span data-volatile="">{formatDateTime(record.appliedAt)}</span>
              </span>
            ),
          },
          ...(record.rolledBackBy !== null && record.rolledBackAt !== null
            ? [
                {
                  key: 'rolled-back',
                  label: t('撤销', 'Rolled back'),
                  value: (
                    <span data-testid="platform-change-record-rolled-back">
                      {t(
                        `由 ${userName(record.rolledBackBy)} 撤销`,
                        `By ${userName(record.rolledBackBy)}`,
                      )}
                      {t('，', ', ')}
                      <span data-volatile="">{formatDateTime(record.rolledBackAt)}</span>
                    </span>
                  ),
                },
              ]
            : []),
        ]}
      />

      {result !== null ? (
        <Notice testId="platform-change-record-rollback-result">
          {t(
            `已撤销：停用了 ${result.items.filter((item) => item.action === 'disable').length} 个门宿主实例`,
            `Rolled back: ${result.items.filter((item) => item.action === 'disable').length} gate-host instance(s) disabled`,
          )}
          {result.withdrawnSegments > 0
            ? t(
                `；这份提案还在待确认的 ${result.withdrawnSegments} 个工作区部分随之撤回`,
                `; the ${result.withdrawnSegments} workspace part(s) of this proposal still awaiting a decision were withdrawn with it`,
              )
            : null}
          {t('。', '.')}
        </Notice>
      ) : null}

      <span className="section-title">{t('它建了什么', 'What it created')}</span>
      <div className="stack-s" data-testid="platform-change-record-items">
        {record.items.map((item) => (
          <div
            className="card card-padded stack-s"
            key={item.ordinal}
            data-testid={`platform-change-record-item-${item.ordinal}`}
          >
            <span className="row-wrap" style={{ justifyContent: 'space-between' }}>
              <span>{item.displayName || item.gateId}</span>
              <RouteLink href={hrefs.platformGateInstance(item.gateId)}>
                {t('去门实例页', 'Open the gate instance')}
              </RouteLink>
            </span>
            <InstanceFacts
              gateId={item.gateId}
              connector={item.connector}
              definition={item.definition}
              presetLabel={presetLabel}
            />
            <span className="text-3 text-small">
              {t(
                `由 ${userName(item.confirmedBy)} 逐项确认（权限边界）`,
                `Confirmed item by item by ${userName(item.confirmedBy)} (authority boundary)`,
              )}
            </span>
          </div>
        ))}
      </div>

      <span className="section-title">
        {record.status === 'applied'
          ? t('现在和应用时相比', 'Now, against when it was applied')
          : t('撤销之后的现状', 'How things stand since the rollback')}
      </span>
      {stale !== null ? (
        <Notice tone="warn" testId="platform-change-record-stale">
          {stale}
        </Notice>
      ) : null}
      {now.state.status === 'error' ? (
        <ErrorBanner
          error={now.state.error}
          title={t('无法检查现在的样子', 'Could not check how things stand now')}
          onRetry={() => void now.reload()}
          testId="platform-change-record-now-error"
        />
      ) : nowData === null ? (
        <SkeletonRows count={2} label={t('正在检查现在的样子…', 'Checking how things stand now')} />
      ) : (
        <>
          <div className="stack-s" data-testid="platform-change-record-now">
            {nowData.items.map((item) => (
              <span
                className="text-small"
                key={item.ordinal}
                data-testid={`platform-change-record-now-${item.ordinal}`}
              >
                {currentStateText(item, nameOf(item.gateId), t)}
              </span>
            ))}
          </div>
          {record.status === 'applied' ? (
            <RollBack
              http={http}
              record={record}
              preview={nowData}
              workspaces={workspaces}
              nameOf={nameOf}
              onRolledBack={(next) => {
                setResult(next);
                setStale(null);
                for (const name of ADMIN_PROPOSAL_STALE_READS) invalidateCapability(http, name);
                void now.reload();
                onRolledBack(next.changeSegment);
              }}
              onStale={(message) => {
                setStale(message);
                invalidateCapability(http, 'preview_roll_back_platform_change_segment');
                void now.reload();
                onRolledBack(null);
              }}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

/** Why a rollback was refused because the record or the platform moved since the dry run (both
 *  are read again), or `null` for any other refusal. */
function rollbackRefusalText(code: string, t: Translate): string | null {
  switch (code) {
    case 'platform_change_drifted':
      return t(
        '在你查看之后，有实例在平台上又被改过，所以什么也没有撤销。下面已经换成现在的样子。',
        'An instance was changed on the platform after you looked, so nothing was rolled back. It now shows as it stands.',
      );
    case 'dependent_segments_applied':
      return t(
        '在你查看之后，这份提案有工作区部分被应用了，所以什么也没有撤销。要先由那个工作区的所有者在「安装历史」里撤销它。',
        'A workspace part of this proposal was applied after you looked, so nothing was rolled back. Its workspace owner rolls it back under Install history first.',
      );
    case 'platform_change_segment_rolled_back':
      return t(
        '它已经被撤销过了，这次什么也没有做。下面已经换成现在的样子。',
        'It was already rolled back, so nothing was done this time. It now shows as it stands.',
      );
    default:
      return null;
  }
}

/**
 * #936 UX 必须修-1: disabling Operations is the connector's (`set_connector_mode`'s
 * `disabledOperations`), and an instance an admin proposal created from a preset joins a connector
 * other instances may share — so the rollback dialog says what that cut-off costs, from how many
 * instances the connector holds now (`list_gate_instances {connector}`), before anyone does it in
 * the heat of a rollback. Read while the dialog is open only; while it loads or when it fails, the
 * sentence says "every instance" without a number.
 */
function ConnectorCutOff({
  http,
  connector,
  gateName,
  testId,
}: {
  readonly http: CapabilityCaller;
  readonly connector: string;
  readonly gateName: string;
  readonly testId: string;
}) {
  const t = useT();
  const params = useMemo(() => ({ connector }), [connector]);
  const instances = useCapabilityList<GateInstanceWire>(http, 'list_gate_instances', params);
  const count = instances.state.status === 'ready' ? instances.state.data.items.length : null;
  const text =
    count === null
      ? t(
          `也可以在「集成 → 接入包」停用 ${connector} 的 Operation，但那会切断这个接入包下所有门宿主实例的调用，不只 ${gateName}。`,
          `Disabling ${connector}’s Operations under Integrations → Connectors also works, but it cuts off every gate-host instance of that connector, not just ${gateName}.`,
        )
      : count > 1
        ? t(
            `也可以在「集成 → 接入包」停用 ${connector} 的 Operation，但那会切断这个接入包下全部 ${count} 个门宿主实例的调用，不只 ${gateName}。`,
            `Disabling ${connector}’s Operations under Integrations → Connectors also works, but it cuts off all ${count} gate-host instances of that connector, not just ${gateName}.`,
          )
        : t(
            `也可以在「集成 → 接入包」停用 ${connector} 的 Operation：这个接入包下现在只有 ${gateName} 这一个门宿主实例，之后加进来的实例也会被拒绝这些 Operation。`,
            `Disabling ${connector}’s Operations under Integrations → Connectors also works: ${gateName} is the only gate-host instance of that connector now, and any instance added later is refused those Operations too.`,
          );
  return (
    <span
      className="text-3 text-small"
      data-testid={testId}
      data-instance-count={count === null ? undefined : String(count)}
    >
      {text}
    </span>
  );
}

function RollBack({
  http,
  record,
  preview,
  workspaces,
  nameOf,
  onRolledBack,
  onStale,
}: {
  readonly http: CapabilityCaller;
  readonly record: PlatformChangeSegmentWire;
  readonly preview: PlatformChangeRollbackPreviewWire;
  readonly workspaces: WorkspaceRefs;
  readonly nameOf: (gateId: string) => string;
  readonly onRolledBack: (result: PlatformChangeRollbackResultWire) => void;
  /** Refused because something moved after the dry run: nothing was rolled back. */
  readonly onStale: (message: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const drifted = preview.items.filter((item) => item.drift.length > 0);
  const used = preview.items.filter((item) => item.linkedWorkspaceCount > 0);

  async function rollBack(): Promise<void> {
    let result: PlatformChangeRollbackResultWire;
    try {
      result = await http.call<PlatformChangeRollbackResultWire>(
        'roll_back_platform_change_segment',
        { changeSegmentId: record.id },
      );
    } catch (error) {
      const code = describeError(error).code;
      const stale = rollbackRefusalText(code, t);
      // The dialog showed the dry run that is now out of date: close it and say why beside how
      // things stand now, read again.
      if (stale !== null) {
        onStale(stale);
        return;
      }
      throw error;
    }
    onRolledBack(result);
  }

  const reasons = [
    ...(drifted.length > 0
      ? [
          t(
            `${drifted.map((item) => `${nameOf(item.gateId)}（${driftFieldsText(item.drift, t)}）`).join('、')}在应用之后变了（被删掉重建过，或门宿主报上来的不一样了），已经不是这条记录建的样子，这条记录撤销不了。要停用它，到它的门实例页去停用`,
            `${drifted.map((item) => `${nameOf(item.gateId)} (${driftFieldsText(item.drift, t)})`).join(', ')} changed since it was applied (deleted and created again, or its gate host announced it differently), so it is no longer what this record created and this record cannot be rolled back. To disable it, do so on its gate instance page`,
          ),
        ]
      : []),
    ...(preview.dependentsApplied.length > 0
      ? [
          t(
            `这份提案有 ${preview.dependentsApplied.length} 个工作区部分已经应用，要先由各自的所有者在「安装历史」里撤销`,
            `${preview.dependentsApplied.length} workspace part(s) of this proposal are applied; their owners roll them back under Install history first`,
          ),
        ]
      : []),
  ];

  return (
    <div className="stack-s" data-testid="platform-change-record-rollback">
      {preview.dependentsApplied.length > 0 ? (
        <div className="stack-s" data-testid="platform-change-record-dependents">
          <span className="text-small">
            {t('已经应用的工作区部分：', 'Workspace parts applied now:')}
          </span>
          {preview.dependentsApplied.map((dependent) => (
            <WorkspaceName
              key={dependent.segmentId}
              workspaceId={dependent.targetWorkspaceId}
              refs={workspaces}
            />
          ))}
        </div>
      ) : null}
      <div className="row-wrap">
        <Confirm
          tier="medium"
          open={open}
          onOpenChange={setOpen}
          anchor={
            <Button
              variant="danger"
              disabled={!preview.canRollBack}
              onClick={() => setOpen(true)}
              aria-describedby="platform-change-record-rollback-missing"
              data-testid="platform-change-record-rollback-trigger"
            >
              {t('撤销…', 'Roll back…')}
            </Button>
          }
          title={t('撤销这条平台变更记录', 'Roll back this platform change record')}
          description={t(
            '撤销会停用它新建的门宿主实例，之后没有工作区能再启用它们；实例本身和它们的 Operation 留着。这份提案还在待确认的工作区部分会随之撤回。',
            'Rolling back disables the gate-host instances it created, so no workspace can enable them any more; the instances and their Operations stay. The workspace parts of this proposal still awaiting a decision are withdrawn with it.',
          )}
          target={t(
            `新建门宿主实例 ${recordSubject(record)}`,
            `New gate-host instance ${recordSubject(record)}`,
          )}
          impact={preview.items.map((item) => rollbackActionText(item, nameOf(item.gateId), t))}
          confirmLabel={t('撤销', 'Roll back')}
          danger
          onConfirm={rollBack}
          testId="platform-change-record-rollback-confirm"
        >
          {used.length > 0 ? (
            <div className="stack-s" data-testid="platform-change-record-enabled-in">
              <span className="text-small">
                {t(
                  '下面这些工作区已经启用了它们：撤销后不能再新启用，但已启用的会继续调用。要切断某个工作区的调用，请那个工作区的所有者在「能力目录 → Operation」里停用这个门的 Operation，只影响他们自己的工作区。',
                  'The workspaces below have enabled them: once rolled back no workspace can newly enable them, but those that did keep calling them. To cut one workspace off, ask its owner to disable this gate’s Operations under Catalog → Operations, which affects their workspace only.',
                )}
              </span>
              {used.map((item) => {
                const connector = record.items.find((i) => i.gateId === item.gateId)?.connector
                  .name;
                const more = item.linkedWorkspaceCount - item.enabledIn.length;
                return (
                  <div
                    className="stack-s"
                    key={item.ordinal}
                    data-testid={`platform-change-record-enabled-in-${item.ordinal}`}
                  >
                    <span className="text-small">
                      {t(
                        `${nameOf(item.gateId)}：${item.linkedWorkspaceCount} 个工作区启用了它`,
                        `${nameOf(item.gateId)}: ${item.linkedWorkspaceCount} workspace(s) enabled it`,
                      )}
                    </span>
                    {item.enabledIn.map((workspace) => (
                      <span className="row-wrap text-small" key={workspace.workspaceId}>
                        <span className="wrap-anywhere">{workspace.name}</span>
                        {workspace.purpose === 'admin_trial' ? (
                          <StatusChip machine="workspacePurpose" status="admin_trial" size="s" />
                        ) : null}
                      </span>
                    ))}
                    {more > 0 ? (
                      <span className="text-3 text-small">
                        {t(`还有 ${more} 个没有列出`, `${more} more not listed`)}
                      </span>
                    ) : null}
                    {connector !== undefined ? (
                      <ConnectorCutOff
                        http={http}
                        connector={connector}
                        gateName={nameOf(item.gateId)}
                        testId={`platform-change-record-connector-cutoff-${item.ordinal}`}
                      />
                    ) : null}
                    <span className="row-wrap text-small">
                      <RouteLink href={hrefs.platformGateInstance(item.gateId)}>
                        {t('去门实例页', 'Open the gate instance')}
                      </RouteLink>
                      <RouteLink href={hrefs.platformIntegrationsTab('connectors')}>
                        {t('去「集成 → 接入包」', 'Open Integrations → Connectors')}
                      </RouteLink>
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </Confirm>
      </div>
      <div id="platform-change-record-rollback-missing">
        <StillNeeded
          items={[]}
          reason={reasons.length > 0 ? reasons.join(t('；', '; ')) : null}
          testId="platform-change-record-rollback-missing-steps"
        />
      </div>
    </div>
  );
}
