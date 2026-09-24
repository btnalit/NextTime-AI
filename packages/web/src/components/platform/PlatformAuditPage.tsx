import type { PlatformAuditRecordWire } from '@nexttime/shared';
import { type FormEvent, useMemo, useState } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatAuditActor, formatDateTime, prettyJson, redactSensitive } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { breadcrumbFor } from '../../lib/nav.js';
import { PageHeader } from '../kit/page-header.js';
import { Button } from '../ui/Button.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Field, Input } from '../ui/Field.js';
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
 * write, one row each). Filterable by `action` and `actorUserId` (client-side apply, matching
 * `AuditPage`'s own `AuditQueryCard` convention), cursor-paged via `useCapabilityList`'s
 * `loadMore` — the same "加载更多" pattern every other governance list page in this console uses.
 * Reachable only for `platformRole === 'admin'` (gated in `App.tsx`'s `Routed`).
 */
export function PlatformAuditPage({ http }: PlatformAuditPageProps) {
  const t = useT();
  const [actionInput, setActionInput] = useState('');
  const [actorUserIdInput, setActorUserIdInput] = useState('');
  const [applied, setApplied] = useState<AppliedFilters>({});

  const params = useMemo(() => ({ limit: PAGE_SIZE, ...applied }), [applied]);
  const audit = useCapabilityList<PlatformAuditRecordWire>(http, 'platform_audit_query', params);

  function handleFilterSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const next: { action?: string; actorUserId?: string } = {};
    if (actionInput.trim()) next.action = actionInput.trim();
    if (actorUserIdInput.trim()) next.actorUserId = actorUserIdInput.trim();
    setApplied(next);
  }

  const rows = audit.state.status === 'ready' ? audit.state.data.items : [];
  const nextCursor = audit.state.status === 'ready' ? audit.state.data.nextCursor : undefined;

  return (
    <div className="page">
      <PageHeader
        breadcrumb={breadcrumbFor('platformAudit')}
        title={t('平台审计', 'Platform audit')}
        description={t(
          '每一次平台范围的写操作（workspace_id 为空）：谁改了什么、什么时候。',
          'Every platform-scope write (workspace_id is null): who changed what, and when.',
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
        <Field id="platform-audit-actor" label={t('操作者用户 id', 'Actor user id')}>
          <Input
            id="platform-audit-actor"
            value={actorUserIdInput}
            onChange={(event) => setActorUserIdInput(event.target.value)}
            mono
          />
        </Field>
        <Button type="submit" variant="secondary">
          {t('应用', 'Apply')}
        </Button>
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
      ) : (
        <ul
          className="data-list"
          aria-label={t('平台审计', 'Platform audit')}
          data-testid="platform-audit-list"
        >
          {rows.map((row) => (
            <li className="data-row" key={row.id} data-testid="platform-audit-row">
              <div className="data-row-main">
                <div className="data-row-title">
                  <span className="mono text-small">{formatDateTime(row.createdAt)}</span> —{' '}
                  {row.action}
                </div>
                <div className="data-row-meta">
                  {formatAuditActor(row, t)}
                  {row.resourceType
                    ? ` · ${row.resourceType}${row.resourceId ? `:${row.resourceId}` : ''}`
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
