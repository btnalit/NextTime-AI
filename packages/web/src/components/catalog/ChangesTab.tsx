import {
  CHANGE_ROLLBACK_IN_USE_CAP,
  type ChangeItemWire,
  type ChangePrincipalRefWire,
  type ChangeRollbackItemWire,
  type ChangeRollbackPreviewWire,
  type ChangeSegmentDetailWire,
  type ChangeSegmentWire,
  type ChangeWideningReasonWire,
  type OntologyTypeNamesWire,
} from '@nexttime/shared';
import { useEffect, useState } from 'react';
import {
  invalidateCapability,
  useCapability,
  useCapabilityList,
} from '../../hooks/useCapability.js';
import { usePermissions } from '../../hooks/usePermissions.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { isForbiddenError } from '../../lib/errors.js';
import { formatDateTime, formatRelative, shortId } from '../../lib/format.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { EmptyState } from '../kit/empty-state.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { KeyValue } from '../kit/key-value.js';
import { List, ListRow } from '../kit/list-row.js';
import { MasterDetail } from '../kit/master-detail.js';
import { Notice } from '../kit/notice.js';
import { RouteLink } from '../kit/route-link.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { StatusChip } from '../kit/status-chip.js';
import { StillNeeded } from '../kit/still-needed.js';

export interface ChangesTabProps {
  readonly http: CapabilityCaller;
  /** The selected install record's id (`#/govern/catalog/changes/<id>`). */
  readonly itemId: string | undefined;
  readonly onSelectItem: (itemId: string | null) => void;
}

/** 「能力包 ops-assets v2」 — what an install record installed. Every source is a pack (S11 P1-C:
 *  a module is a pack with one ontology part, so a module install before P1-C reads the same). */
export function sourceLabel(segment: Pick<ChangeSegmentWire, 'source'>, t: Translate): string {
  const { name, version } = segment.source;
  return t(`能力包 ${name} v${version}`, `Pack ${name} v${version}`);
}

function principalName(ref: ChangePrincipalRefWire): string {
  return ref.displayName ?? shortId(ref.id);
}

/** Who applied it, as one phrase. `platform`: the platform installed it with the workspace (it is
 *  recorded under the first owner, who did nothing themselves). */
function appliedByText(segment: ChangeSegmentWire, t: Translate): string {
  return segment.channel === 'platform'
    ? t('创建工作区时由平台安装', 'Installed by the platform with the workspace')
    : t(
        `由 ${principalName(segment.appliedBy)} 应用`,
        `Applied by ${principalName(segment.appliedBy)}`,
      );
}

const SECTION_LABEL: Readonly<Record<string, { readonly zh: string; readonly en: string }>> = {
  objectTypes: { zh: '对象类型', en: 'object type' },
  linkTypes: { zh: '关系类型', en: 'link type' },
  actionTypes: { zh: '动作类型', en: 'action type' },
};

const REASON_LABEL: Readonly<
  Record<ChangeWideningReasonWire['reason'], { readonly zh: string; readonly en: string }>
> = {
  added: { zh: '新增', en: 'added' },
  removed: { zh: '去掉', en: 'taken out' },
  loosened: { zh: '放宽', en: 'loosened' },
  changed: { zh: '改变', en: 'changed' },
  unrecognized: { zh: '无法识别', en: 'not recognized' },
};

const WIDENING_PATH = /^(objectTypes|linkTypes|actionTypes)\[([^\]]+)\](?:\.(.+))?$/;

/** A Skill's or Worker's field name for people (S11 P1-D; an unknown one as it is). */
export function contentFieldText(field: string, t: Translate): string {
  switch (field) {
    case 'name':
      return t('名称', 'name');
    case 'description':
      return t('说明', 'description');
    case 'markdown':
      return t('正文', 'body');
    case 'applicable':
      return t('适用范围', 'applies to');
    case 'systemPrompt':
      return t('系统提示词', 'system prompt');
    case 'model':
      return t('模型', 'model');
    case 'skills':
      return t('挂载的 Skill', 'mounted Skills');
    case 'capabilities':
      return t('能力范围', 'capabilities');
    case 'gates':
      return t('可操作的系统', 'systems it may act on');
    case 'egressDeny':
      return t('禁止访问的地址', 'denied hosts');
    default:
      return field;
  }
}

/** 「挂载的 Skill 增加」, 「正文有改动」: a space only between a Latin word and the Chinese after it. */
function zhJoin(head: string, tail: string): string {
  return /[A-Za-z0-9]$/.test(head) ? `${head} ${tail}` : `${head}${tail}`;
}

/** 「Worker 挂载的 Skill 增加」 — a Skill's or Worker's widening reason (path `skill` / `worker`,
 *  or one of its fields). A list loosens by growing, except the hosts a Worker is denied. */
function contentWideningText(
  subject: 'skill' | 'worker',
  field: string | undefined,
  reason: ChangeWideningReasonWire['reason'],
  t: Translate,
): string {
  const noun = subject === 'skill' ? 'Skill' : 'Worker';
  if (field === undefined) {
    return subject === 'skill'
      ? t(
          '新增这个 Skill：挂载它的 Worker 会读到它的全文',
          'adds this Skill: a Worker that mounts it reads all of it',
        )
      : t(
          '新增这个 Worker：能委派任务的助手都可以调用它',
          'adds this Worker: any agent that delegates may invoke it',
        );
  }
  const label = contentFieldText(field, t);
  switch (reason) {
    case 'loosened':
      return field === 'egressDeny'
        ? t(`${noun} ${zhJoin(label, '减少')}`, `${noun} ${label}: fewer`)
        : t(`${noun} ${zhJoin(label, '增加')}`, `${noun} ${label}: more`);
    case 'unrecognized':
      return t(`${noun} 字段 ${field}：无法识别`, `${noun} field ${field}: not recognized`);
    default:
      return t(`${noun} ${zhJoin(label, '有改动')}`, `${noun} ${label} changed`);
  }
}

const CONTENT_WIDENING_PATH = /^(skill|worker)(?:\.(.+))?$/;

/** One widening reason as a sentence: 「去掉动作类型 restart」, 「动作类型 restart 的 mode 放宽」,
 *  「Skill 正文有改动」. */
export function wideningText(widening: ChangeWideningReasonWire, t: Translate): string {
  const reason = REASON_LABEL[widening.reason];
  const content = CONTENT_WIDENING_PATH.exec(widening.path);
  if (content?.[1] === 'skill' || content?.[1] === 'worker') {
    return contentWideningText(content[1], content[2], widening.reason, t);
  }
  const match = WIDENING_PATH.exec(widening.path);
  const section = match?.[1] ? SECTION_LABEL[match[1]] : undefined;
  if (!match || !section) {
    return t(`字段 ${widening.path}：${reason.zh}`, `field ${widening.path}: ${reason.en}`);
  }
  const name = match[2] ?? '';
  const field = match[3];
  if (field) {
    return t(
      `${section.zh} ${name} 的 ${field}${reason.zh}`,
      `${section.en} ${name}: ${field} ${reason.en}`,
    );
  }
  return t(`${reason.zh}${section.zh} ${name}`, `${section.en} ${name} ${reason.en}`);
}

/** What a change item changes, by kind: 「本体 ops-assets」, 「Skill docker-triage」, 「Worker
 *  ops-runner」 (S11 P1-D). */
export type ChangeSubject =
  | { readonly kind: 'ontology_version'; readonly target: { readonly family: string } }
  | {
      readonly kind: 'skill_version' | 'worker_definition_version';
      readonly target: { readonly name: string };
    };

export function changeSubjectText(item: ChangeSubject, t: Translate): string {
  switch (item.kind) {
    case 'ontology_version':
      return t(`本体 ${item.target.family}`, `Ontology ${item.target.family}`);
    case 'skill_version':
      return `Skill ${item.target.name}`;
    case 'worker_definition_version':
      return `Worker ${item.target.name}`;
  }
}

/** The family's own version noun: 本体 / Skill / Worker 版本. */
function familyNoun(kind: ChangeItemWire['kind'], t: Translate): string {
  switch (kind) {
    case 'ontology_version':
      return t('本体', 'Ontology');
    case 'skill_version':
      return 'Skill';
    case 'worker_definition_version':
      return 'Worker';
  }
}

function versionText(version: { readonly version: number } | null, t: Translate): string {
  return version === null
    ? t('未安装', 'not installed')
    : t(`第 ${version.version} 版`, `v${version.version}`);
}

/** How many names of one kind `typeNamesText` spells out before 「等 N 个」. */
const TYPE_NAMES_SHOWN = 5;

/** 「对象类型 A、B；关系类型 c」 — type names by kind (the first few of each kind, then how many in
 *  all), or `null` for none: what a rollback takes out, what an install adds, takes out or
 *  changes (`PacksTab`). */
export function typeNamesText(names: OntologyTypeNamesWire, t: Translate): string | null {
  const parts: string[] = [];
  for (const key of ['objectTypes', 'linkTypes', 'actionTypes'] as const) {
    const named = names[key];
    const section = SECTION_LABEL[key];
    if (named.length === 0 || !section) continue;
    const shown = named.slice(0, TYPE_NAMES_SHOWN);
    const more = named.length - shown.length;
    parts.push(
      more > 0
        ? t(
            `${section.zh} ${shown.join('、')} 等 ${named.length} 个`,
            `${section.en}s ${shown.join(', ')} and ${more} more`,
          )
        : t(`${section.zh} ${shown.join('、')}`, `${section.en}s ${shown.join(', ')}`),
    );
  }
  return parts.length > 0 ? parts.join(t('；', '; ')) : null;
}

/**
 * components/catalog/ChangesTab: 能力目录 · 安装历史 (`#/govern/catalog/changes`, S11 P1-B). Every
 * pack install or upgrade since the ChangePlan core is one **安装记录** (a ChangePlan segment);
 * what it changed are its **改动项** (a new version of an ontology family, a Skill or a Worker,
 * P1-D). Members read the list
 * (`list_change_segments`) and a record (`get_change_segment`: each change, and whether it is
 * still in effect); the owner can roll a record back — `preview_roll_back_change_segment` first,
 * inside the confirm, then `roll_back_change_segment` with each authority-widening change ticked.
 * A pack installed before records were kept, or published some other way, has no record and is
 * not here (its 能力包 pane says so, per component).
 */
export function ChangesTab({ http, itemId, onSelectItem }: ChangesTabProps) {
  const t = useT();
  const segments = useCapabilityList<ChangeSegmentWire>(http, 'list_change_segments', {});

  function refresh(): void {
    invalidateCapability(http, 'list_change_segments');
    invalidateCapability(http, 'get_change_segment');
    invalidateCapability(http, 'list_packs');
    void segments.reload();
  }

  const rows = segments.state.status === 'ready' ? segments.state.data.items : [];
  const list =
    segments.state.status === 'loading' ? (
      <SkeletonRows count={4} label={t('正在加载安装历史…', 'Loading install history')} />
    ) : segments.state.status === 'error' ? (
      <ErrorBanner
        error={segments.state.error}
        title={t('无法加载安装历史', 'Could not load install history')}
        onRetry={() => void segments.reload()}
        testId="catalog-changes-error"
      />
    ) : (
      <div className="stack-s">
        <p className="text-3 text-small">
          {t(
            '每次安装或升级能力包会留下一条安装记录：谁做的，改了什么（每个改动项是这次写入的一处变化：一个本体、Skill 或 Worker 的新版本），需要时可以整条撤销。启用安装记录之前装上的能力包不在这里。',
            'Each pack install or upgrade leaves an install record: who did it and what changed (each change is one thing it wrote: a new version of an ontology, a Skill or a Worker); the whole record can be rolled back if needed. Packs installed before records were kept are not here.',
          )}
        </p>
        {rows.length === 0 ? (
          <EmptyState
            title={t('还没有安装记录', 'No install records yet')}
            body={t(
              '在「能力包」页签安装或升级一个能力包后，这里会出现它的安装记录。',
              'Install or upgrade a pack on the Packs tab and its install record shows up here.',
            )}
            testId="catalog-changes-empty"
          />
        ) : (
          <List ariaLabel={t('安装记录', 'Install records')} testId="catalog-changes-list">
            {rows.map((segment) => (
              <ListRow
                key={segment.id}
                testId={`catalog-change-row-${segment.id}`}
                selected={segment.id === itemId}
                onSelect={() => onSelectItem(segment.id)}
              >
                <span className="row-wrap" style={{ justifyContent: 'space-between' }}>
                  <span className="truncate">{sourceLabel(segment, t)}</span>
                  <StatusChip machine="changeSegment" status={segment.status} size="s" />
                </span>
                <span className="truncate text-3">
                  {appliedByText(segment, t)}
                  {' · '}
                  <time
                    dateTime={segment.appliedAt}
                    title={formatDateTime(segment.appliedAt)}
                    data-volatile=""
                  >
                    {formatRelative(segment.appliedAt)}
                  </time>
                </span>
              </ListRow>
            ))}
          </List>
        )}
        {segments.state.data.nextCursor !== undefined ? (
          <div className="row" style={{ justifyContent: 'center' }}>
            <Button
              variant="secondary"
              aria-busy={segments.loadingMore || undefined}
              disabled={segments.loadingMore}
              onClick={() => void segments.loadMore()}
            >
              {t('加载更多', 'Load more')}
            </Button>
          </div>
        ) : null}
        {segments.loadMoreError !== null ? (
          <ErrorBanner
            error={segments.loadMoreError}
            title={t('无法加载更多安装记录', 'Could not load more install records')}
            testId="catalog-changes-load-more-error"
          />
        ) : null}
      </div>
    );

  const detail =
    itemId !== undefined ? (
      <ChangeSegmentDetail http={http} segmentId={itemId} onRolledBack={refresh} />
    ) : rows.length > 0 ? (
      <EmptyState
        title={t(
          '选择左侧一条安装记录，查看它改了什么',
          'Select an install record on the left to see what it changed',
        )}
        testId="catalog-detail-empty"
      />
    ) : null;

  return (
    <MasterDetail
      list={list}
      detail={detail}
      open={itemId !== undefined}
      onClose={() => onSelectItem(null)}
      sheetTitle={t('安装记录', 'Install record')}
      detailTestId="catalog-detail"
    />
  );
}

function ChangeSegmentDetail({
  http,
  segmentId,
  onRolledBack,
}: {
  readonly http: CapabilityCaller;
  readonly segmentId: string;
  readonly onRolledBack: () => void;
}) {
  const t = useT();
  const detail = useCapability<ChangeSegmentDetailWire>(http, 'get_change_segment', { segmentId });
  // The record this pane just rolled back: says so where the 撤销 control was (its trigger is gone).
  const [rolledBackHere, setRolledBackHere] = useState<string | null>(null);

  if (detail.state.status === 'loading') {
    return <SkeletonRows count={3} label={t('正在加载安装记录…', 'Loading install record')} />;
  }
  if (detail.state.status === 'error') {
    return (
      <ErrorBanner
        error={detail.state.error}
        title={t('无法加载这条安装记录', 'Could not load this install record')}
        onRetry={() => void detail.reload()}
        testId="catalog-change-error"
      />
    );
  }
  const { segment, items } = detail.state.data;
  return (
    <div className="stack" data-testid="catalog-change-detail">
      <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
        <h2 className="catalog-detail-title" data-testid="catalog-change-title">
          {t('能力包 ', 'Pack ')}
          <span className="mono wrap-anywhere">{segment.source.name}</span>
          {` v${segment.source.version}`}
        </h2>
        <StatusChip
          machine="changeSegment"
          status={segment.status}
          testId="catalog-change-status"
        />
      </div>
      <KeyValue
        items={[
          { key: 'how', label: t('方式', 'How'), value: appliedByText(segment, t) },
          {
            key: 'when',
            label: t('时间', 'When'),
            value: <span data-volatile="">{formatDateTime(segment.appliedAt)}</span>,
          },
          {
            key: 'items',
            label: t('改动项', 'Changes'),
            value:
              segment.wideningItemCount > 0
                ? t(
                    `${segment.itemCount} 项，其中 ${segment.wideningItemCount} 项改变了权限边界`,
                    `${segment.itemCount}, ${segment.wideningItemCount} of them moving an authority boundary`,
                  )
                : t(`${segment.itemCount} 项`, `${segment.itemCount}`),
          },
          ...(segment.rolledBackBy && segment.rolledBackAt
            ? [
                {
                  key: 'rolledBack',
                  label: t('撤销', 'Rolled back'),
                  value: (
                    <span>
                      {t(
                        `由 ${principalName(segment.rolledBackBy)} 撤销于 `,
                        `By ${principalName(segment.rolledBackBy)}, `,
                      )}
                      <span data-volatile="">{formatDateTime(segment.rolledBackAt)}</span>
                    </span>
                  ),
                },
              ]
            : []),
        ]}
      />
      {segment.channel === 'platform' ? (
        <p className="text-3 text-small">
          {t(
            `这是平台在创建工作区时代为安装的，记在第一位所有者 ${principalName(segment.appliedBy)} 名下。`,
            `The platform installed this when it created the workspace; it is recorded under the first owner, ${principalName(segment.appliedBy)}.`,
          )}
        </p>
      ) : null}

      <span className="section-title">{t('改了什么', 'What changed')}</span>
      <div className="stack-s" data-testid="catalog-change-items">
        {items.map((item) => (
          <ChangeItemView key={item.id} item={item} segment={segment} />
        ))}
      </div>

      {segment.status !== 'rolled_back' ? (
        <RollBackSegment
          http={http}
          segment={segment}
          onRolledBack={() => {
            setRolledBackHere(segment.id);
            void detail.reload();
            onRolledBack();
          }}
        />
      ) : rolledBackHere === segment.id ? (
        <output className="block">
          <Notice testId="catalog-change-rolled-back">
            {t(
              '已撤销。这次安装写入的版本已停用，能力包回到了安装之前的样子；已有的对象和事实都保留着。',
              'Rolled back. The versions this install wrote are deprecated and the pack is back to how it was before; existing objects and Facts are kept.',
            )}
          </Notice>
        </output>
      ) : null}
    </div>
  );
}

function ChangeItemView({
  item,
  segment,
}: {
  readonly item: ChangeItemWire;
  readonly segment: ChangeSegmentWire;
}) {
  const t = useT();
  return (
    <div className="card card-padded stack-s" data-testid={`catalog-change-item-${item.ordinal}`}>
      <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
        <span>{changeSubjectText(item, t)}</span>
        <StatusChip machine="changeItemState" status={item.state} size="s" />
      </div>
      <span className="text-3 text-small">
        {t(
          `能力包 v${segment.source.version} 带来的${familyNoun(item.kind, t)}版本（与能力包版本分开编号）：${versionText(item.before, t)} → ${versionText(item.after, t)}`,
          `${familyNoun(item.kind, t)} version pack v${segment.source.version} brought (numbered apart from the pack's): ${versionText(item.before, t)} → ${versionText(item.after, t)}`,
        )}
      </span>
      {item.widening.length > 0 ? (
        <span className="text-small">
          {t('改变了权限边界：', 'Moved an authority boundary: ')}
          {item.widening.map((w) => wideningText(w, t)).join(t('；', '; '))}
          {item.confirmedBy
            ? t(
                `（${principalName(item.confirmedBy)} 已逐项确认）`,
                ` (confirmed by ${principalName(item.confirmedBy)})`,
              )
            : null}
        </span>
      ) : null}
      {item.state === 'replaced' ? (
        <span className="text-small" data-testid={`catalog-change-item-${item.ordinal}-replaced`}>
          {item.replacedBy ? (
            <>
              {t('之后被另一条安装记录改过：', 'Changed again since by another install record: ')}
              <RouteLink href={hrefs.catalog('changes', item.replacedBy.segmentId)}>
                {t('查看那条记录', 'Open that record')}
              </RouteLink>
            </>
          ) : (
            t(
              '之后在能力包安装之外被改过（例如直接发布了新版本），这里没有它的记录。',
              'Changed again since outside a pack install (such as a version published directly); there is no record of it here.',
            )
          )}
        </span>
      ) : null}
    </div>
  );
}

const BLOCKER_TEXT: Readonly<
  Record<
    NonNullable<ChangeRollbackItemWire['blocker']>,
    { readonly zh: string; readonly en: string }
  >
> = {
  replaced: {
    zh: '之后又被改过，撤销会把后来的改动一起盖掉，所以不撤销。',
    en: 'It was changed again since; rolling it back would overwrite the later change, so it is not rolled back.',
  },
  not_installed: {
    zh: '它已经不在工作区里了，没有可撤销的。',
    en: 'It is no longer installed; there is nothing to roll back.',
  },
  restored_version_missing: {
    zh: '要退回的那一版已经不在了（被弃用），无法退回。',
    en: 'The version to return to is gone (deprecated), so it cannot go back to it.',
  },
  namespace_conflict: {
    zh: '要退回的那一版里有类型名已被别的本体占用，退回会让两个本体重名。',
    en: 'A type name in the version to return to is now taken by another ontology; going back would give it two owners.',
  },
};

function RollBackSegment({
  http,
  segment,
  onRolledBack,
}: {
  readonly http: CapabilityCaller;
  readonly segment: ChangeSegmentWire;
  readonly onRolledBack: () => void;
}) {
  const t = useT();
  const can = useRoleCan(http);
  const permissions = usePermissions();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<
    | { readonly status: 'loading' }
    | { readonly status: 'ready'; readonly data: ChangeRollbackPreviewWire }
    | { readonly status: 'error'; readonly error: unknown }
  >({ status: 'loading' });
  const [confirmed, setConfirmed] = useState<ReadonlySet<number>>(new Set());
  // An owner-only read: run once the role is known to allow it, never on a guess.
  const canPreview = can('preview_roll_back_change_segment') === true;

  useEffect(() => {
    if (!open || !canPreview) return;
    let cancelled = false;
    setPreview({ status: 'loading' });
    setConfirmed(new Set());
    http
      .call<ChangeRollbackPreviewWire>('preview_roll_back_change_segment', {
        segmentId: segment.id,
      })
      .then((data) => {
        if (!cancelled) setPreview({ status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (isForbiddenError(error)) permissions.markDenied('preview_roll_back_change_segment');
        if (!cancelled) setPreview({ status: 'error', error });
      });
    return () => {
      cancelled = true;
    };
  }, [open, canPreview, http, segment.id, permissions]);

  if (can('roll_back_change_segment') === false) return null;

  const data = preview.status === 'ready' ? preview.data : null;
  const widening = data
    ? data.items.filter(
        (item) => item.blocker === null && item.classification === 'authority_widening',
      )
    : [];
  const unconfirmed = widening.filter((item) => !confirmed.has(item.ordinal)).length;
  const allConfirmed = unconfirmed === 0;

  async function rollBack(): Promise<void> {
    try {
      await http.call('roll_back_change_segment', {
        segmentId: segment.id,
        ...(widening.length > 0 ? { confirmedOrdinals: widening.map((item) => item.ordinal) } : {}),
      });
    } catch (error) {
      if (isForbiddenError(error)) permissions.markDenied('roll_back_change_segment');
      throw error;
    }
    permissions.markAllowed('roll_back_change_segment');
    onRolledBack();
  }

  const inUse = data?.inUse;
  const inUseCount = (count: number) =>
    inUse?.capped && count >= CHANGE_ROLLBACK_IN_USE_CAP
      ? t(`至少 ${count}`, `at least ${count}`)
      : String(count);

  return (
    <div className="stack-s" data-testid="catalog-change-rollback">
      <span className="section-title">{t('撤销', 'Roll back')}</span>
      <p className="text-3 text-small">
        {t(
          '把这条记录的每项改动退回到安装之前：本体回到上一版，首次安装的则不再安装。已经写入的数据保留。之后可以在「能力包」页签重新安装。',
          'Returns each change of this record to what it was before: the ontology goes back a version, or a first install is no longer installed. Data already written stays. You can install again from the Packs tab.',
        )}
      </p>
      <Confirm
        tier="medium"
        open={open}
        onOpenChange={setOpen}
        anchor={
          <Button
            variant="secondary"
            onClick={() => setOpen(true)}
            data-testid="catalog-change-rollback-trigger"
          >
            {t('撤销这条安装记录…', 'Roll back this install record…')}
          </Button>
        }
        title={t('撤销这条安装记录', 'Roll back this install record')}
        target={sourceLabel(segment, t)}
        confirmLabel={t('撤销', 'Roll back')}
        danger
        confirmDisabled={data === null || !data.possible || !allConfirmed}
        onConfirm={rollBack}
        testId="catalog-change-rollback-confirm"
      >
        {preview.status === 'loading' ? (
          <SkeletonRows
            count={2}
            label={t('正在检查能否撤销…', 'Checking whether it can be rolled back')}
          />
        ) : preview.status === 'error' ? (
          <ErrorBanner
            error={preview.error}
            title={t('无法检查能否撤销', 'Could not check whether it can be rolled back')}
            testId="catalog-change-preview-error"
          />
        ) : (
          <div className="stack-s" data-testid="catalog-change-preview">
            {preview.data.items.map((item) => (
              <div
                className="stack-s"
                key={item.ordinal}
                data-testid={`catalog-change-preview-${item.ordinal}`}
              >
                <span>
                  {t(
                    `${changeSubjectText(item, t)}：${versionText(item.from, t)} → ${versionText(item.to, t)}`,
                    `${changeSubjectText(item, t)}: ${versionText(item.from, t)} → ${versionText(item.to, t)}`,
                  )}
                </span>
                {item.blocker !== null ? (
                  <Notice tone="warn" testId={`catalog-change-blocker-${item.ordinal}`}>
                    {t(BLOCKER_TEXT[item.blocker].zh, BLOCKER_TEXT[item.blocker].en)}
                    {item.kind === 'ontology_version' &&
                    item.blocker === 'namespace_conflict' &&
                    item.conflicts.length > 0
                      ? t(
                          `（${item.conflicts.map((c) => `${c.kind === 'object' ? '对象类型' : '动作类型'} ${c.name}`).join('、')}）`,
                          ` (${item.conflicts.map((c) => `${c.kind} type ${c.name}`).join(', ')})`,
                        )
                      : null}
                    {item.blocker === 'replaced' ? (
                      item.blockedBy ? (
                        <>
                          {' '}
                          <RouteLink href={hrefs.catalog('changes', item.blockedBy.segmentId)}>
                            {t('先撤销后来的那条记录', 'Roll back the later record first')}
                          </RouteLink>
                        </>
                      ) : (
                        t(
                          '后来的改动不是通过能力包安装做的，这里撤销不了。',
                          ' The later change was not made through a pack install, so it cannot be rolled back here.',
                        )
                      )
                    ) : null}
                  </Notice>
                ) : (
                  <>
                    {item.kind === 'ontology_version' && typeNamesText(item.removes, t) ? (
                      <span className="text-3 text-small">
                        {t('撤销后本体里不再有：', 'Afterwards the ontology no longer has: ')}
                        {typeNamesText(item.removes, t)}
                      </span>
                    ) : item.kind !== 'ontology_version' && item.to === null ? (
                      <span className="text-3 text-small">
                        {item.kind === 'skill_version'
                          ? t(
                              '撤销后工作区里不再有这个 Skill，Worker 不会再挂载它。',
                              'Afterwards the workspace no longer has this Skill; no Worker mounts it.',
                            )
                          : t(
                              '撤销后工作区里不再有这个 Worker，助手不能再调用它。',
                              'Afterwards the workspace no longer has this Worker; no agent can invoke it.',
                            )}
                      </span>
                    ) : null}
                    {item.classification === 'authority_widening' ? (
                      <label className="checkbox">
                        <input
                          type="checkbox"
                          checked={confirmed.has(item.ordinal)}
                          onChange={(event) => {
                            const checked = event.currentTarget.checked;
                            setConfirmed((prev) => {
                              const next = new Set(prev);
                              if (checked) next.add(item.ordinal);
                              else next.delete(item.ordinal);
                              return next;
                            });
                          }}
                          data-testid={`catalog-change-confirm-item-${item.ordinal}`}
                        />
                        <span>
                          {t(
                            '我确认这会改变权限边界：',
                            'I confirm this moves an authority boundary: ',
                          )}
                          {item.widening.map((w) => wideningText(w, t)).join(t('；', '; '))}
                        </span>
                      </label>
                    ) : null}
                  </>
                )}
              </div>
            ))}
            {preview.data.inUse.objects + preview.data.inUse.links > 0 ? (
              <Notice testId="catalog-change-in-use">
                {t(
                  `工作区里有 ${inUseCount(preview.data.inUse.objects)} 个对象、${inUseCount(preview.data.inUse.links)} 条有效关系用到撤销后不再有的类型。它们会保留，不会被删除，但会被算作不符合本体；之后再写入用到这些类型的关系，会按工作区的本体检查设置被拒绝或记一条告警。`,
                  `${inUseCount(preview.data.inUse.objects)} objects and ${inUseCount(preview.data.inUse.links)} active links in this workspace use types the rollback takes out. They stay — nothing is deleted — but count as not fitting the ontology, and a new link written with those types is refused or flagged, as the workspace's ontology check is set.`,
                )}
              </Notice>
            ) : null}
            <StillNeeded
              items={
                preview.data.possible && unconfirmed > 0
                  ? [
                      t(
                        `勾选 ${unconfirmed} 项权限边界确认`,
                        `tick ${unconfirmed} authority-boundary confirmation${unconfirmed > 1 ? 's' : ''}`,
                      ),
                    ]
                  : []
              }
              reason={
                preview.data.possible
                  ? null
                  : t(
                      '有改动项现在不能撤销，原因见上',
                      'Some changes cannot be rolled back now; see above',
                    )
              }
              testId="catalog-change-missing"
            />
          </div>
        )}
      </Confirm>
    </div>
  );
}
