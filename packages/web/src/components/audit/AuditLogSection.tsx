import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import {
  AUDIT_RESOURCE_TYPES,
  type AuditFilter,
  type AuditRecordRow,
  auditActionSuggestions,
  downloadJson,
  downloadName,
  isEmptyFilter,
  isReadAuditAction,
  resourceHref,
} from '../../lib/audit.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { isForbiddenError } from '../../lib/errors.js';
import { formatDateTime, formatRelative, prettyJson, redactSensitive } from '../../lib/format.js';
import type { PrincipalRow } from '../../lib/governance.js';
import { useT } from '../../lib/i18n.js';
import { auditResourceTypeLabel, roleLabel } from '../../lib/labels.js';
import { nameOf } from '../approvals/useDirectoryNames.js';
import { Button } from '../ui/Button.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Field, Input, Select } from '../ui/Field.js';
import { RefChip } from '../ui/RefChip.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { useToast } from '../ui/Toast.js';

export interface AuditLogSectionProps {
  readonly http: CapabilityCaller;
  /** The filter to apply right away (a deep link) — the section re-applies whenever it changes. */
  readonly requestedFilter?: AuditFilter;
  readonly principals: readonly PrincipalRow[] | undefined;
  readonly principalNames: ReadonlyMap<string, string>;
  /** `list_principals` was refused / failed: the actor filter is a text input from the start
   *  (never swapped under the reader's typing — C20). */
  readonly principalsUnavailable: boolean;
}

const PAGE_SIZE = 50;

/**
 * components/audit/AuditLogSection (S6-A A4 — docs/console-completion-plan.md §5.5): the
 * workspace audit stream (`audit_query`, auditor only) as a structured list — time, action,
 * actor (`RefChip` with the name from `list_principals`), resource (`RefChip`, linked to its
 * console page where one exists), payload behind a disclosure. Filters: actor (a `<select>` over
 * the principal directory when readable, a text input otherwise), action (free text with the
 * capability registry + lifecycle actions as suggestions), resource type (the enum of what
 * audit rows actually carry, `lib/audit.ts` `AUDIT_RESOURCE_TYPES`) and resource id. Keyset
 * "加载更多" via `useCapabilityList` (S6-A: `audit_query{limit, cursor}` → `nextCursor`), the
 * same pattern as the platform audit page. "导出 Export" serializes the rows this page holds —
 * `export_prov` exports a provenance graph around one node, not an audit range (runbook 已知缺口
 * 10), so the list is serialized client-side.
 */
export function AuditLogSection({
  http,
  requestedFilter,
  principals,
  principalNames,
  principalsUnavailable,
}: AuditLogSectionProps) {
  const t = useT();
  const toast = useToast();
  const [actor, setActor] = useState(requestedFilter?.actorPrincipalId ?? '');
  const [action, setAction] = useState(requestedFilter?.action ?? '');
  const [resourceType, setResourceType] = useState(requestedFilter?.resourceType ?? '');
  const [resourceId, setResourceId] = useState(requestedFilter?.resourceId ?? '');
  const [applied, setApplied] = useState<AuditFilter>(requestedFilter ?? {});
  // S8 W4-A (ui-audit S11/PA1): default hides pure reads — a deep link that names a specific
  // action (`?action=`) or comes from an approval/explain context is almost always about a
  // write/decision already, but shows reads anyway once the reader explicitly asked for a
  // specific action, so a read-mode `?action=list_grants` deep link is never hidden from itself.
  const [showReads, setShowReads] = useState(
    () => requestedFilter?.action !== undefined && isReadAuditAction(requestedFilter.action),
  );

  useEffect(() => {
    if (!requestedFilter) return;
    setActor(requestedFilter.actorPrincipalId ?? '');
    setAction(requestedFilter.action ?? '');
    setResourceType(requestedFilter.resourceType ?? '');
    setResourceId(requestedFilter.resourceId ?? '');
    setApplied(requestedFilter);
    setShowReads(requestedFilter.action !== undefined && isReadAuditAction(requestedFilter.action));
  }, [requestedFilter]);

  const params = useMemo(
    () => (isEmptyFilter(applied) ? { limit: PAGE_SIZE } : { filter: applied, limit: PAGE_SIZE }),
    [applied],
  );
  const audit = useCapabilityList<AuditRecordRow>(http, 'audit_query', params);
  const suggestions = useMemo(() => auditActionSuggestions(), []);
  const forbidden = audit.state.status === 'error' && isForbiddenError(audit.state.error);
  const rows = audit.state.status === 'ready' ? audit.state.data.items : [];
  const nextCursor = audit.state.status === 'ready' ? audit.state.data.nextCursor : undefined;
  const visibleRows = useMemo(
    () => (showReads ? rows : rows.filter((row) => !isReadAuditAction(row.action))),
    [rows, showReads],
  );
  const hiddenReadCount = rows.length - visibleRows.length;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const next: { -readonly [K in keyof AuditFilter]: AuditFilter[K] } = {};
    if (actor.trim()) next.actorPrincipalId = actor.trim();
    if (action.trim()) next.action = action.trim();
    if (resourceType.trim()) next.resourceType = resourceType.trim();
    if (resourceId.trim()) next.resourceId = resourceId.trim();
    setApplied(next);
  }

  function handleExport(): void {
    const saved = downloadJson(
      downloadName('audit', applied.resourceId ?? applied.action ?? applied.resourceType ?? 'all'),
      {
        exportedAt: new Date().toISOString(),
        filter: applied,
        truncated: nextCursor !== undefined,
        count: visibleRows.length,
        items: visibleRows,
      },
    );
    toast.push({
      tone: saved ? 'ok' : 'warn',
      title: saved
        ? `已导出 ${visibleRows.length} 条审计记录 Exported ${visibleRows.length} audit rows`
        : t('浏览器不支持下载', 'Download not supported in this browser'),
    });
  }

  const actorSelect = !principalsUnavailable;

  return (
    <section className="section" aria-labelledby="audit-query-title" data-testid="audit-log">
      <div className="section-header">
        <h2 id="audit-query-title">{t('审计流', 'Audit log')}</h2>
        <label className="row-wrap text-small" data-testid="audit-show-reads-toggle">
          <input
            type="checkbox"
            checked={showReads}
            onChange={(event) => setShowReads(event.target.checked)}
          />
          {t('显示读操作', 'Show reads')}
        </label>
        {visibleRows.length > 0 ? (
          <Button variant="secondary" size="s" onClick={handleExport} data-testid="audit-export">
            {t('导出本页', 'Export loaded rows')}
          </Button>
        ) : null}
      </div>
      <form className="inline-form row-wrap" onSubmit={handleSubmit} data-testid="audit-query-form">
        <Field id="audit-actor" label={t('操作者', 'Actor')}>
          {actorSelect ? (
            <Select
              id="audit-actor"
              value={actor}
              onChange={(event) => setActor(event.target.value)}
              data-testid="audit-actor-select"
            >
              <option value="">{t('任意', 'Any')}</option>
              {(principals ?? []).map((principal) => (
                <option key={principal.id} value={principal.id}>
                  {principal.displayName} · {roleLabel(principal.role, t)}
                </option>
              ))}
              {actor !== '' && !(principals ?? []).some((p) => p.id === actor) ? (
                <option value={actor}>{actor}</option>
              ) : null}
            </Select>
          ) : (
            <Input
              id="audit-actor"
              value={actor}
              onChange={(event) => setActor(event.target.value)}
              placeholder="principal id"
              mono
              data-testid="audit-actor-input"
            />
          )}
        </Field>
        <Field id="audit-action" label={t('动作', 'Action')}>
          <Input
            id="audit-action"
            value={action}
            onChange={(event) => setAction(event.target.value)}
            list="audit-action-options"
            mono
          />
          <datalist id="audit-action-options">
            {suggestions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </Field>
        <Field id="audit-resource-type" label={t('资源类型', 'Resource type')}>
          <Select
            id="audit-resource-type"
            value={resourceType}
            onChange={(event) => setResourceType(event.target.value)}
          >
            <option value="">{t('任意', 'Any')}</option>
            {AUDIT_RESOURCE_TYPES.map((type) => (
              <option key={type} value={type}>
                {auditResourceTypeLabel(type, t)}
              </option>
            ))}
            {resourceType !== '' &&
            !(AUDIT_RESOURCE_TYPES as readonly string[]).includes(resourceType) ? (
              <option value={resourceType}>{resourceType}</option>
            ) : null}
          </Select>
        </Field>
        <Field id="audit-resource-id" label={t('资源 id', 'Resource id')}>
          <Input
            id="audit-resource-id"
            value={resourceId}
            onChange={(event) => setResourceId(event.target.value)}
            mono
          />
        </Field>
        <Button type="submit" variant="secondary" data-testid="audit-apply">
          {t('应用', 'Apply')}
        </Button>
      </form>

      {audit.state.status === 'loading' ? (
        <SkeletonRows
          count={5}
          label={t('正在加载审计流…', 'Loading audit log')}
          testId="audit-loading"
        />
      ) : audit.state.status === 'error' ? (
        forbidden ? (
          <EmptyState
            icon="shield"
            title={t('审计流需要 auditor 角色', 'The audit log needs the auditor role')}
            body={t('当前主体不能调用 audit_query。', 'Your principal cannot call audit_query.')}
            testId="audit-query-forbidden"
          />
        ) : (
          <ErrorBanner
            error={audit.state.error}
            title={t('无法查询审计流', 'Could not query the audit log')}
            onRetry={() => void audit.reload()}
            testId="audit-query-error"
          />
        )
      ) : rows.length === 0 ? (
        <EmptyState
          icon="search"
          title={t('没有匹配的审计记录', 'No matching audit rows')}
          testId="audit-empty"
        />
      ) : (
        <>
          {audit.state.refreshError ? (
            <ErrorBanner error={audit.state.refreshError} onRetry={() => void audit.reload()} />
          ) : null}
          {visibleRows.length === 0 ? (
            // S8 W4-A fix (CI #288/#290 audit.spec.ts:28/59 — a page whose loaded rows are all
            // reads must never render neither `audit-list` nor `audit-empty`): the *same*
            // `audit-empty` testid every other "nothing to show" state already uses, just with
            // the hidden-reads count and a one-click way to reveal them instead of the generic
            // "no matching rows" title (there genuinely are rows — they're filtered, not absent).
            <EmptyState
              icon="search"
              title={t('已加载的记录全部是读操作', 'Every loaded row is a read')}
              body={t(
                `已隐藏 ${hiddenReadCount} 条——勾选"显示读操作"查看。`,
                `${hiddenReadCount} hidden — check "Show reads" to see them.`,
              )}
              action={
                <Button variant="secondary" size="s" onClick={() => setShowReads(true)}>
                  {t('显示读操作', 'Show reads')}
                </Button>
              }
              testId="audit-empty"
            />
          ) : (
            <>
              {hiddenReadCount > 0 ? (
                <p className="text-3 text-small" data-testid="audit-hidden-reads-note">
                  {t(
                    `已隐藏 ${hiddenReadCount} 条读操作`,
                    `${hiddenReadCount} read ${hiddenReadCount === 1 ? 'row' : 'rows'} hidden`,
                  )}
                </p>
              ) : null}
              <ul className="data-list" aria-label="Audit log" data-testid="audit-list">
                {visibleRows.map((row) => (
                  <li className="data-row" key={row.id} data-testid="audit-row">
                    <div className="data-row-main">
                      <div className="data-row-title">
                        <span className="mono">{row.action}</span>
                        <time className="text-3 text-small" title={formatDateTime(row.createdAt)}>
                          {formatRelative(row.createdAt)} · {formatDateTime(row.createdAt)}
                        </time>
                      </div>
                      <div className="data-row-meta">
                        <RefChip
                          kind="principal"
                          id={row.actorPrincipalId}
                          name={nameOf(principalNames, row.actorPrincipalId)}
                          size="s"
                        />
                        {row.resourceId ? (
                          <>
                            <span className="meta-sep" />
                            <RefChip
                              kind="object"
                              id={row.resourceId}
                              name={
                                row.resourceType
                                  ? auditResourceTypeLabel(row.resourceType, t)
                                  : undefined
                              }
                              href={resourceHref(row.resourceType, row.resourceId)}
                              size="s"
                            />
                          </>
                        ) : row.resourceType ? (
                          <>
                            <span className="meta-sep" />
                            <span>{auditResourceTypeLabel(row.resourceType, t)}</span>
                          </>
                        ) : null}
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
          {nextCursor !== undefined ? (
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
              title={t('无法加载更多审计记录', 'Could not load more audit rows')}
              testId="audit-load-more-error"
            />
          ) : null}
        </>
      )}
    </section>
  );
}
