import type { PlatformAuditRecordWire, UserWire } from '@nexttime/shared';
import { type FormEvent, useMemo, useState } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import { isReadAuditAction } from '../../lib/audit.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import {
  formatAuditActor,
  formatDateTime,
  prettyJson,
  redactSensitive,
  shortId,
} from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { breadcrumbFor } from '../../lib/nav.js';
import { PageHeader } from '../kit/page-header.js';
import { Button } from '../ui/Button.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Field, Input, Select } from '../ui/Field.js';
import { SkeletonRows } from '../ui/Skeleton.js';

export interface PlatformAuditPageProps {
  readonly http: CapabilityCaller;
}

interface AppliedFilters {
  readonly action?: string;
  readonly actorUserId?: string;
}

const PAGE_SIZE = 50;

/**
 * components/platform/PlatformAuditPage: 平台审计 Platform audit (`/platform/audit`, design doc
 * §6.7) — `platform_audit_query`, the `workspace_id is null` audit stream (every platform-scope
 * write, one row each). Filterable by `action` and actor (client-side apply, matching `AuditPage`'s
 * own `AuditQueryCard` convention), cursor-paged via `useCapabilityList`'s `loadMore` — the same
 * "加载更多" pattern every other governance list page in this console uses. Reachable only for
 * `platformRole === 'admin'` (gated in `App.tsx`'s `Routed`).
 *
 * S8 W4-A (ui-audit AU1 "平台审计页停止要求裸 UUID 输入", copy-guard baseline: 2 UUID entries):
 * the actor filter is a `<select>` over `list_users` (degrades to a raw-id text input only when
 * that call is refused/fails, same convention `AuditLogSection`'s own actor filter already uses);
 * each row's own actor resolves through the same `list_users` result before falling back to
 * `formatAuditActor`'s `shortId`-truncated id (there is no `resolve_refs` kind for a platform
 * user, so a `RefChip` cannot self-resolve one) — never a bare full UUID. `resourceId` in the row
 * meta line is `shortId`-truncated the same way.
 *
 * S8 W4-A (ui-audit PA1 "见 S11"): the subtitle used to claim "every platform-scope write", but
 * `platform_audit_query`'s stream is the same `workspace_id is null` table every platform-scope
 * capability dispatch audits itself under, reads included — same "default hides pure reads, a
 * toggle shows them" fix `AuditLogSection`'s own S11 fix applies, over the same `isReadAuditAction`
 * helper (`lib/audit.ts`); the subtitle now says what the stream actually is.
 */
export function PlatformAuditPage({ http }: PlatformAuditPageProps) {
  const t = useT();
  const [actionInput, setActionInput] = useState('');
  const [actorUserIdInput, setActorUserIdInput] = useState('');
  const [applied, setApplied] = useState<AppliedFilters>({});
  const [showReads, setShowReads] = useState(false);

  const params = useMemo(() => ({ limit: PAGE_SIZE, ...applied }), [applied]);
  const audit = useCapabilityList<PlatformAuditRecordWire>(http, 'platform_audit_query', params);

  // S8 W4-A (ui-audit AU1 "平台审计页停止要求裸 UUID 输入"): a `<select>` over `list_users` when
  // readable — same degrade-to-text-input convention `AuditLogSection`'s own actor filter already
  // uses when `list_principals` is refused (`principalsUnavailable`).
  const users = useCapabilityList<UserWire>(http, 'list_users', {});
  const userRows = users.state.status === 'ready' ? users.state.data.items : undefined;
  const usersUnavailable = users.state.status === 'error';
  const userNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const user of userRows ?? []) map.set(user.id, `${user.displayName} (${user.login})`);
    return map;
  }, [userRows]);

  function handleFilterSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const next: { action?: string; actorUserId?: string } = {};
    if (actionInput.trim()) next.action = actionInput.trim();
    if (actorUserIdInput.trim()) next.actorUserId = actorUserIdInput.trim();
    setApplied(next);
  }

  const rows = audit.state.status === 'ready' ? audit.state.data.items : [];
  const nextCursor = audit.state.status === 'ready' ? audit.state.data.nextCursor : undefined;
  const visibleRows = useMemo(
    () => (showReads ? rows : rows.filter((row) => !isReadAuditAction(row.action))),
    [rows, showReads],
  );
  const hiddenReadCount = rows.length - visibleRows.length;

  return (
    <div className="page">
      <PageHeader
        breadcrumb={breadcrumbFor('platformAudit')}
        title={t('平台审计', 'Platform audit')}
        description={t(
          '每一次平台范围的调用（workspace_id 为空）：谁做了什么、什么时候——默认隐藏纯读操作。',
          'Every platform-scope call (workspace_id is null): who did what, and when — pure reads are hidden by default.',
        )}
      />

      <form
        className="inline-form row-wrap"
        onSubmit={handleFilterSubmit}
        data-testid="platform-audit-filter-form"
      >
        <Field id="platform-audit-action" label={t('动作', 'Action')}>
          <Input
            id="platform-audit-action"
            value={actionInput}
            onChange={(event) => setActionInput(event.target.value)}
            mono
          />
        </Field>
        <Field id="platform-audit-actor" label={t('操作者', 'Actor')}>
          {usersUnavailable ? (
            <Input
              id="platform-audit-actor"
              value={actorUserIdInput}
              onChange={(event) => setActorUserIdInput(event.target.value)}
              mono
              data-testid="platform-audit-actor-input"
            />
          ) : (
            <Select
              id="platform-audit-actor"
              value={actorUserIdInput}
              onChange={(event) => setActorUserIdInput(event.target.value)}
              data-testid="platform-audit-actor-select"
            >
              <option value="">{t('任意', 'Any')}</option>
              {(userRows ?? []).map((user) => (
                <option key={user.id} value={user.id}>
                  {user.displayName} ({user.login})
                </option>
              ))}
              {actorUserIdInput !== '' &&
              !(userRows ?? []).some((u) => u.id === actorUserIdInput) ? (
                <option value={actorUserIdInput}>{actorUserIdInput}</option>
              ) : null}
            </Select>
          )}
        </Field>
        <Button type="submit" variant="secondary">
          {t('应用', 'Apply')}
        </Button>
        <label className="row-wrap text-small" data-testid="platform-audit-show-reads-toggle">
          <input
            type="checkbox"
            checked={showReads}
            onChange={(event) => setShowReads(event.target.checked)}
          />
          {t('显示读操作', 'Show reads')}
        </label>
      </form>

      {audit.state.status === 'loading' ? (
        <SkeletonRows
          count={5}
          label={t('正在加载平台审计…', 'Loading platform audit')}
          testId="platform-audit-loading"
        />
      ) : audit.state.status === 'error' ? (
        <ErrorBanner
          error={audit.state.error}
          title={t('无法加载平台审计流', 'Could not load the platform audit log')}
          onRetry={() => void audit.reload()}
          testId="platform-audit-error"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="search"
          title={t('没有匹配的平台审计记录', 'No matching platform audit rows')}
          testId="platform-audit-empty"
        />
      ) : visibleRows.length === 0 ? (
        <EmptyState
          icon="search"
          title={t('已加载的记录全部是读操作', 'Every loaded row is a read')}
          body={t(
            `已隐藏 ${hiddenReadCount} 条——勾选上方"显示读操作"查看。`,
            `${hiddenReadCount} hidden — check "Show reads" above to see them.`,
          )}
          action={
            <Button variant="secondary" size="s" onClick={() => setShowReads(true)}>
              {t('显示读操作', 'Show reads')}
            </Button>
          }
          testId="platform-audit-empty-reads-hidden"
        />
      ) : (
        <>
          {hiddenReadCount > 0 ? (
            <p className="text-3 text-small" data-testid="platform-audit-hidden-reads-note">
              {t(
                `已隐藏 ${hiddenReadCount} 条读操作`,
                `${hiddenReadCount} read ${hiddenReadCount === 1 ? 'row' : 'rows'} hidden`,
              )}
            </p>
          ) : null}
          <ul
            className="data-list"
            aria-label={t('平台审计', 'Platform audit')}
            data-testid="platform-audit-list"
          >
            {visibleRows.map((row) => (
              <li className="data-row" key={row.id} data-testid="platform-audit-row">
                <div className="data-row-main">
                  <div className="data-row-title">
                    <span className="mono text-small">{formatDateTime(row.createdAt)}</span> —{' '}
                    {row.action}
                  </div>
                  <div className="data-row-meta">
                    {(row.actorUserId ? userNameById.get(row.actorUserId) : undefined) ??
                      formatAuditActor(row, t)}
                    {row.resourceType
                      ? ` · ${row.resourceType}${row.resourceId ? `:${shortId(row.resourceId)}` : ''}`
                      : ''}
                  </div>
                  <details className="platform-audit-payload">
                    <summary>{t('负载', 'Payload')}</summary>
                    <pre className="code-block pre-wrap">
                      {prettyJson(redactSensitive(row.payload))}
                    </pre>
                  </details>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {audit.state.status === 'ready' && nextCursor !== undefined ? (
        <div className="row" style={{ justifyContent: 'center' }}>
          <Button
            variant="secondary"
            loading={audit.loadingMore}
            onClick={() => void audit.loadMore()}
          >
            {t('加载更多', 'Load more')}
          </Button>
        </div>
      ) : null}
      {audit.loadMoreError !== null ? (
        <ErrorBanner
          error={audit.loadMoreError}
          title={t('无法加载更多平台审计记录', 'Could not load more platform audit rows')}
          testId="platform-audit-load-more-error"
        />
      ) : null}
    </div>
  );
}
