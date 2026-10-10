import type { PlatformAuditRecordWire, UserWire } from '@nexttime/shared';
import { type FormEvent, useMemo, useRef, useState } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import { useDebounced } from '../../lib/audit-id-picker.js';
import { platformAuditActionSuggestions } from '../../lib/audit-pickers.js';
import { isReadAuditAction } from '../../lib/audit.js';
import { actionLabel } from '../../lib/capability-labels.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { isForbiddenError } from '../../lib/errors.js';
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
const USER_SEARCH_DEBOUNCE_MS = 250;

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
  // Field-inventory §11: the actor `<select>` used to hold only `list_users`'s first page (50).
  // Typing in the search box re-asks `list_users{query}` (login or display name, kernel-side), so
  // any user is reachable. An empty box is the plain directory read, exactly as before.
  const [actorQuery, setActorQuery] = useState('');
  const debouncedActorQuery = useDebounced(actorQuery.trim(), USER_SEARCH_DEBOUNCE_MS);
  const searching = debouncedActorQuery !== '';
  const userParams = useMemo(
    () => (searching ? { query: debouncedActorQuery.slice(0, 100), limit: PAGE_SIZE } : {}),
    [searching, debouncedActorQuery],
  );
  const users = useCapabilityList<UserWire>(http, 'list_users', userParams);
  const userRows = users.state.status === 'ready' ? users.state.data.items : undefined;
  // Only the plain directory read decides "unreadable" — a failed search keeps the picker and
  // shows its own banner.
  const usersUnavailable = users.state.status === 'error' && !searching;
  const usersRefused = usersUnavailable && isForbiddenError(users.state.error);
  // Every user seen so far (directory and searches): rows keep their actor names, and the picked
  // actor keeps its option, after the search moves on.
  const knownUsers = useRef(new Map<string, UserWire>());
  for (const user of userRows ?? []) knownUsers.current.set(user.id, user);
  const userName = (id: string): string | undefined => {
    const user = knownUsers.current.get(id);
    return user ? `${user.displayName} (${user.login})` : undefined;
  };
  const pickedUser = actorUserIdInput === '' ? undefined : knownUsers.current.get(actorUserIdInput);
  const actionSuggestions = useMemo(() => platformAuditActionSuggestions(), []);

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
            list="platform-audit-action-options"
            mono
          />
          <datalist id="platform-audit-action-options" data-testid="platform-audit-action-options">
            {actionSuggestions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </Field>
        {usersUnavailable ? (
          <Field
            id="platform-audit-actor"
            label={t('操作者', 'Actor')}
            hint={
              usersRefused
                ? t(
                    '无权读取用户目录，请粘贴用户 id。',
                    'The user directory is not readable — paste a user id.',
                  )
                : undefined
            }
          >
            <Input
              id="platform-audit-actor"
              value={actorUserIdInput}
              onChange={(event) => setActorUserIdInput(event.target.value)}
              placeholder={t('粘贴用户 id', 'Paste a user id')}
              mono
              data-testid="platform-audit-actor-input"
            />
            {usersRefused || users.state.status !== 'error' ? null : (
              <ErrorBanner
                error={users.state.error}
                title={t('无法读取用户目录', 'Could not load the user directory')}
                onRetry={() => void users.reload()}
                testId="platform-audit-users-error"
              />
            )}
          </Field>
        ) : (
          <>
            <Field id="platform-audit-actor-query" label={t('搜索操作者', 'Find an actor')}>
              <Input
                id="platform-audit-actor-query"
                value={actorQuery}
                onChange={(event) => setActorQuery(event.target.value)}
                // Enter searches as you type already; never let it apply the filter half-typed.
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.preventDefault();
                }}
                placeholder={t('登录名或名称', 'Login or name')}
                autoComplete="off"
                spellCheck={false}
                data-testid="platform-audit-actor-query"
              />
            </Field>
            <Field
              id="platform-audit-actor"
              label={t('操作者', 'Actor')}
              hint={
                searching && userRows !== undefined && userRows.length === 0 ? (
                  <span data-testid="platform-audit-actor-empty">
                    {t('没有匹配的用户', 'No matching users')}
                  </span>
                ) : undefined
              }
            >
              <Select
                id="platform-audit-actor"
                value={actorUserIdInput}
                onChange={(event) => setActorUserIdInput(event.target.value)}
                disabled={users.state.status === 'loading'}
                data-testid="platform-audit-actor-select"
              >
                <option value="">
                  {users.state.status === 'loading'
                    ? searching
                      ? t('正在搜索…', 'Searching…')
                      : t('正在加载用户…', 'Loading users…')
                    : t('任意', 'Any')}
                </option>
                {pickedUser && !(userRows ?? []).some((u) => u.id === pickedUser.id) ? (
                  <option value={pickedUser.id}>
                    {pickedUser.displayName} ({pickedUser.login})
                  </option>
                ) : null}
                {(userRows ?? []).map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.displayName} ({user.login})
                  </option>
                ))}
                {actorUserIdInput !== '' && !pickedUser ? (
                  <option value={actorUserIdInput}>{actorUserIdInput}</option>
                ) : null}
              </Select>
              {users.state.status === 'error' && searching ? (
                <ErrorBanner
                  error={users.state.error}
                  title={t('无法搜索用户', 'Could not search users')}
                  onRetry={() => void users.reload()}
                  testId="platform-audit-actor-search-error"
                />
              ) : null}
            </Field>
          </>
        )}
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
        // S8 W4-A fix (CI #288/#290 — same audit.spec.ts-shaped assertion applies here too): the
        // *same* `platform-audit-empty` testid every other "nothing to show" state already uses,
        // never neither `platform-audit-list` nor `platform-audit-empty` — rows exist, they are
        // filtered, not absent, so the empty state says that instead of the generic title.
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
          testId="platform-audit-empty"
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
                    {actionLabel(row.action, t)}{' '}
                    <span className="mono text-3 text-small">{row.action}</span>
                  </div>
                  <div className="data-row-meta">
                    {(row.actorUserId ? userName(row.actorUserId) : undefined) ??
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
