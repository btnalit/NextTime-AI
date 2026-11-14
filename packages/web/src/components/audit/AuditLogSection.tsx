import type { AdminAgentStatusWire } from '@nexttime/shared';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useAskForAccess } from '../../hooks/useAskForAccess.js';
import { useCanOpen } from '../../hooks/useCanOpen.js';
import { useCapability, useCapabilityList } from '../../hooks/useCapability.js';
import {
  ACTING_THROUGH_OPTIONS,
  actingThroughFilterNote,
  actingThroughLabel,
} from '../../lib/acting-through.js';
import { AuditIdPicker } from '../../lib/audit-id-picker.js';
import { auditActorSource, resourceIdSource } from '../../lib/audit-pickers.js';
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
import { actionLabel } from '../../lib/capability-labels.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { isForbiddenError } from '../../lib/errors.js';
import {
  auditPayloadShown,
  formatDateTime,
  formatRelative,
  prettyJsonVisible,
} from '../../lib/format.js';
import type { PrincipalRow } from '../../lib/governance.js';
import { useT } from '../../lib/i18n.js';
import { auditResourceTypeLabel, principalShownName, roleLabel } from '../../lib/labels.js';
import { hrefs } from '../../lib/router.js';
import { sameNameIds, withSameNameId } from '../../lib/same-name.js';
import { nameOf } from '../approvals/useDirectoryNames.js';
import { Button } from '../ui/Button.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Field, Input, Select } from '../ui/Field.js';
import { RefChip } from '../ui/RefChip.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { useToast } from '../ui/Toast.js';
import { ActingThroughChip } from './ActingThroughChip.js';
import { AuditMigrationActor } from './AuditMigrationActor.js';
import { AuditPayloadNotes, adminProposalBreakerTarget } from './AuditPayloadNotes.js';
import { AuditRefusedChip } from './AuditRefusedChip.js';
import { AuditUnchangedChip } from './AuditUnchangedChip.js';

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
 * the principal directory when readable, otherwise an id box offering the actors of recent audit
 * rows), action (free text with the capability registry + lifecycle actions as suggestions),
 * resource type (the enum of what audit rows actually carry, `lib/audit.ts`
 * `AUDIT_RESOURCE_TYPES`) and resource id (candidates from that type's list capability —
 * `lib/audit-pickers.ts` `resourceIdSource`). Keyset
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
  const canOpen = useCanOpen(http);
  const ask = useAskForAccess(http);
  const toast = useToast();
  const [actor, setActor] = useState(requestedFilter?.actorPrincipalId ?? '');
  const [action, setAction] = useState(requestedFilter?.action ?? '');
  const [resourceType, setResourceType] = useState(requestedFilter?.resourceType ?? '');
  const [resourceId, setResourceId] = useState(requestedFilter?.resourceId ?? '');
  const [actingThrough, setActingThrough] = useState(requestedFilter?.actingThrough ?? '');
  const [applied, setApplied] = useState<AuditFilter>(requestedFilter ?? {});
  // S8 W4-A (ui-audit S11/PA1): default hides pure reads — a deep link that names a specific
  // action (`?action=`) or comes from an approval/explain context is almost always about a
  // write/decision already, but shows reads anyway once the reader explicitly asked for a
  // specific action, so a read-mode `?action=list_grants` deep link is never hidden from itself.
  const showReadsToggle = useRef<HTMLInputElement>(null);
  const [showReads, setShowReads] = useState(
    () => requestedFilter?.action !== undefined && isReadAuditAction(requestedFilter.action),
  );

  useEffect(() => {
    if (!requestedFilter) return;
    setActor(requestedFilter.actorPrincipalId ?? '');
    setAction(requestedFilter.action ?? '');
    setResourceType(requestedFilter.resourceType ?? '');
    setResourceId(requestedFilter.resourceId ?? '');
    setActingThrough(requestedFilter.actingThrough ?? '');
    setApplied(requestedFilter);
    setShowReads(requestedFilter.action !== undefined && isReadAuditAction(requestedFilter.action));
  }, [requestedFilter]);

  // Legacy 669: the kernel leaves the reads out before paging (`filter.excludeReads`, a refused
  // read kept — legacy 628), so a page of writes and decisions is a whole page. They used to be
  // hidden here, after paging, and a page could come back all reads. The toggle asks again.
  const params = useMemo(
    () =>
      showReads
        ? isEmptyFilter(applied)
          ? { limit: PAGE_SIZE }
          : { filter: applied, limit: PAGE_SIZE }
        : { filter: { ...applied, excludeReads: true }, limit: PAGE_SIZE },
    [applied, showReads],
  );
  const audit = useCapabilityList<AuditRecordRow>(http, 'audit_query', params);
  const suggestions = useMemo(() => auditActionSuggestions(), []);
  // Candidates for the two id filters (field-inventory §11): the chosen resource type's own list
  // capability (falling back to ids seen in the audit log), and — when `list_principals` is
  // refused, e.g. for an auditor — the principals who acted in recent audit rows.
  const resourceSource = useMemo(() => resourceIdSource(resourceType, t), [resourceType, t]);
  const actorSource = useMemo(() => auditActorSource(t), [t]);
  const forbidden = audit.state.status === 'error' && isForbiddenError(audit.state.error);
  const rows = audit.state.status === 'ready' ? audit.state.data.items : [];
  const nextCursor = audit.state.status === 'ready' ? audit.state.data.nextCursor : undefined;
  // S11 AA5a-2 (#956 UX P2-1): a row the rejection breaker refused names its target workspace,
  // from the administrator's own admin agent targets — read only when such a row is loaded and the
  // reader is a platform administrator (no one else reads them); a short id otherwise.
  const breakerShown = useMemo(
    () => rows.some((row) => adminProposalBreakerTarget(row.payload) !== undefined),
    [rows],
  );
  const adminAgent = useCapability<AdminAgentStatusWire>(
    http,
    'get_admin_agent_status',
    undefined,
    {
      enabled: breakerShown && canOpen(hrefs.platformAdminAgent()) === true,
    },
  );
  const targetNames = useMemo(
    () =>
      new Map(
        adminAgent.state.status === 'ready'
          ? adminAgent.state.data.workspaces.flatMap((trial) =>
              trial.targets.map((target) => [target.workspaceId, target.name] as const),
            )
          : [],
      ),
    [adminAgent.state],
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const next: { -readonly [K in keyof AuditFilter]: AuditFilter[K] } = {};
    if (actor.trim()) next.actorPrincipalId = actor.trim();
    if (action.trim()) next.action = action.trim();
    if (resourceType.trim()) next.resourceType = resourceType.trim();
    if (resourceId.trim()) next.resourceId = resourceId.trim();
    if (actingThrough) next.actingThrough = actingThrough;
    // #501 on #1040 (P3-1): asking for a read by name shows the reads, the same rule a deep link
    // follows — never an empty page that says nothing matched while the rows are there.
    if (next.action !== undefined && isReadAuditAction(next.action)) setShowReads(true);
    setApplied(next);
  }

  function handleExport(): void {
    const saved = downloadJson(
      downloadName('audit', applied.resourceId ?? applied.action ?? applied.resourceType ?? 'all'),
      {
        exportedAt: new Date().toISOString(),
        filter: applied,
        readsShown: showReads,
        truncated: nextCursor !== undefined,
        count: rows.length,
        items: rows,
      },
    );
    toast.push({
      tone: saved ? 'ok' : 'warn',
      title: saved
        ? t(`已导出 ${rows.length} 条审计记录`, `Exported ${rows.length} audit rows`)
        : t('浏览器不支持下载', 'Download not supported in this browser'),
    });
  }

  const actorSelect = !principalsUnavailable;
  const actorName = (p: PrincipalRow) => principalShownName(p.displayName, t) ?? p.displayName;
  const actorSame = sameNameIds(principals, (p) => p.id, actorName);
  // Legacy 729 (#1193 UX P3): someone added back after a removal has two memberships of one name;
  // the disabled ones — earlier memberships, disabled service accounts — group at the bottom under
  // their own label instead of reading as duplicates of the active ones.
  const activeActors = (principals ?? []).filter((p) => !p.disabledAt);
  const disabledActors = (principals ?? []).filter((p) => p.disabledAt);
  const actorOption = (principal: PrincipalRow) => (
    <option key={principal.id} value={principal.id}>
      {withSameNameId(actorName(principal), principal.id, actorSame)} ·{' '}
      {roleLabel(principal.role, t)}
    </option>
  );

  /** The resource chip's name: its type, and — legacy 740 (UX acceptance of #1220) — for a member,
   *  that member's name from the same directory the actor chip reads (a row a migration wrote
   *  names its member only here). */
  const resourceChipName = (
    resourceType: string | null,
    resourceId: string,
  ): string | undefined => {
    if (!resourceType) return undefined;
    const label = auditResourceTypeLabel(resourceType, t);
    const member = resourceType === 'principal' ? nameOf(principalNames, resourceId) : null;
    return member ? `${label} ${member}` : label;
  };

  return (
    <section className="section" aria-labelledby="audit-query-title" data-testid="audit-log">
      <div className="section-header">
        <h2 id="audit-query-title">{t('审计流', 'Audit log')}</h2>
        <label className="row-wrap text-small" data-testid="audit-show-reads-toggle">
          <input
            type="checkbox"
            ref={showReadsToggle}
            checked={showReads}
            onChange={(event) => setShowReads(event.target.checked)}
          />
          {t('显示读操作', 'Show reads')}
        </label>
        {rows.length > 0 ? (
          <Button variant="secondary" size="s" onClick={handleExport} data-testid="audit-export">
            {t('导出本页', 'Export loaded rows')}
          </Button>
        ) : null}
      </div>
      <form
        className="inline-form inline-form-top audit-query-grid"
        onSubmit={handleSubmit}
        data-testid="audit-query-form"
      >
        {actorSelect ? (
          <Field id="audit-actor" label={t('操作者', 'Actor')}>
            <Select
              id="audit-actor"
              value={actor}
              onChange={(event) => setActor(event.target.value)}
              data-testid="audit-actor-select"
            >
              <option value="">{t('任意', 'Any')}</option>
              {activeActors.map(actorOption)}
              {disabledActors.length > 0 ? (
                <optgroup
                  label={t(
                    '已停用的成员（含之前的成员资格）',
                    'Disabled members (and earlier memberships)',
                  )}
                  data-testid="audit-actor-disabled"
                >
                  {disabledActors.map(actorOption)}
                </optgroup>
              ) : null}
              {actor !== '' && !(principals ?? []).some((p) => p.id === actor) ? (
                <option value={actor}>{actor}</option>
              ) : null}
            </Select>
          </Field>
        ) : (
          <AuditIdPicker
            http={http}
            id="audit-actor"
            label={t('操作者', 'Actor')}
            hint={t(
              '你的角色看不到成员名单，这里的候选取自最近审计记录里的操作者。',
              'Your role does not see the member list; suggestions are the actors of recent audit rows.',
            )}
            value={actor}
            onChange={setActor}
            source={actorSource}
            refusedNote={t(
              '也无法读取审计记录，请直接粘贴成员 id。',
              'The audit log is not readable either — paste a member id.',
            )}
            placeholder={t('粘贴成员 id，或从下方选择', 'Paste a member id or pick below')}
            testId="audit-actor-input"
          />
        )}
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
        <AuditIdPicker
          http={http}
          id="audit-resource-id"
          label={t('资源 ID', 'Resource id')}
          value={resourceId}
          onChange={setResourceId}
          source={resourceSource}
          noSourceNote={t(
            '先选择资源类型，即可从该类型的资源中选择。',
            'Choose a resource type first to pick from its resources.',
          )}
          testId="audit-resource-id"
        />
        <Field id="audit-acting-through" label={t('经由', 'Through')}>
          <Select
            id="audit-acting-through"
            value={actingThrough}
            onChange={(event) => setActingThrough(event.target.value)}
          >
            <option value="">{t('任意', 'Any')}</option>
            {ACTING_THROUGH_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {actingThroughLabel(value, t)}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="secondary" data-testid="audit-apply">
          {t('应用', 'Apply')}
        </Button>
      </form>
      {applied.actingThrough ? (
        <p className="text-3 text-small" data-testid="audit-acting-through-note">
          {actingThroughFilterNote(applied.actingThrough, t)}
        </p>
      ) : null}

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
            title={t(
              '审计流只有审计员和工作区所有者能看',
              'Only auditors and the workspace owner see the audit log',
            )}
            body={ask('auditor', 'see')}
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
          {...(showReads
            ? {}
            : {
                body: t(
                  '读操作默认不列出；勾选「显示读操作」可一并查看。',
                  'Reads are not listed by default; check “Show reads” to include them.',
                ),
                action: (
                  <Button
                    variant="secondary"
                    size="s"
                    data-testid="audit-empty-show-reads"
                    onClick={() => {
                      setShowReads(true);
                      // Legacy 479 (same class): this button goes away as the reads show; focus
                      // lands on the toggle that now says they are shown.
                      showReadsToggle.current?.focus();
                    }}
                  >
                    {t('显示读操作', 'Show reads')}
                  </Button>
                ),
              })}
          testId="audit-empty"
        />
      ) : (
        <>
          {audit.state.refreshError ? (
            <ErrorBanner error={audit.state.refreshError} onRetry={() => void audit.reload()} />
          ) : null}
          <ul className="data-list" aria-label="Audit log" data-testid="audit-list">
            {rows.map((row) => (
              <li className="data-row" key={row.id} data-testid="audit-row">
                <div className="data-row-main">
                  <div className="data-row-title audit-row-title">
                    {/* P1-14: what happened first; the action name stays as the secondary
                     *  text an auditor filters by. */}
                    <span>{actionLabel(row.action, t)}</span>
                    <AuditRefusedChip payload={row.payload} />
                    <AuditUnchangedChip payload={row.payload} />
                    <span className="mono text-3 text-small">{row.action}</span>
                    <time className="text-3 text-small" title={formatDateTime(row.createdAt)}>
                      {formatRelative(row.createdAt)} · {formatDateTime(row.createdAt)}
                    </time>
                  </div>
                  <div className="data-row-meta">
                    <AuditMigrationActor payload={row.payload}>
                      <RefChip
                        kind="principal"
                        id={row.actorPrincipalId}
                        name={nameOf(principalNames, row.actorPrincipalId)}
                        size="s"
                      />
                      <ActingThroughChip
                        actingThrough={row.actingThrough}
                        actingName={row.actingName}
                        payload={row.payload}
                      />
                    </AuditMigrationActor>
                    {row.resourceId ? (
                      <>
                        <span className="meta-sep" />
                        <RefChip
                          kind="object"
                          id={row.resourceId}
                          name={resourceChipName(row.resourceType, row.resourceId)}
                          href={resourceHref(
                            row.resourceType,
                            row.resourceId,
                            canOpen,
                            row.payload,
                          )}
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
                  <AuditPayloadNotes
                    payload={row.payload}
                    action={row.action}
                    workspaceNames={targetNames}
                  />
                  <details className="platform-audit-payload">
                    <summary>{t('负载', 'Payload')}</summary>
                    <pre className="code-block pre-wrap">
                      {prettyJsonVisible(auditPayloadShown(row.payload))}
                    </pre>
                  </details>
                </div>
              </li>
            ))}
          </ul>
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
