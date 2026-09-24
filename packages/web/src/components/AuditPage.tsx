import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  type AuditEntry,
  type AuditFilter,
  auditEntryFromHash,
  auditFilterFromEntry,
  isEmptyFilter,
} from '../lib/audit.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import { prettyJson, redactSensitive } from '../lib/format.js';
import type { ActionRequestRow } from '../lib/governance.js';
import { useT } from '../lib/i18n.js';
import { breadcrumbFor } from '../lib/nav.js';
import { useGatekeeperNames, usePrincipalDirectory } from './approvals/useDirectoryNames.js';
import { ApprovalContext } from './audit/ApprovalContext.js';
import { AuditLogSection } from './audit/AuditLogSection.js';
import { ExplainSection } from './audit/ExplainSection.js';
import { PageHeader } from './kit/page-header.js';
import { Button } from './ui/Button.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Input } from './ui/Field.js';

export interface AuditPageProps {
  readonly http: CapabilityCaller;
  /** The entry point (a deep link's pre-filled ids). When omitted the page reads it from the
   *  hash itself (`#/govern/audit?nodeId=…`, `lib/audit.ts` `auditEntryFromHash`) and follows
   *  `hashchange` — so a route table that only recognises the bare route still lands here with
   *  the entry applied once the router lets the `?…` suffix through. */
  readonly entry?: AuditEntry;
}

/**
 * components/AuditPage: 审计 Audit (`/govern/audit`) — S6-A A4 / C27 (docs/console-completion-
 * plan.md §5.5 "审计：上下文关联", §5.9 "审计"). Three sections over the three existing
 * capabilities plus `export_prov`:
 *
 *   - 溯源 `explain{nodeId}` (member) → `ui/ProvenanceChain` + Decision / links; 导出 →
 *     `export_prov{nodeId}` (auditor) as a PROV-JSON download (`audit/ExplainSection`).
 *   - 审批上下文 (`audit/ApprovalContext`, only when opened from an approval): `get_action`,
 *     read-only card; its `approvalDecisionId` becomes the explain root, its id the audit filter.
 *   - 重建 `reconstruct{entityId}` (auditor) — raw, redacted JSON (no fixed rendering exists).
 *   - 审计流 `audit_query{filter, limit, cursor}` (auditor) — structured rows, actor / action /
 *     resource-type selectors, keyset "加载更多", export of the loaded page
 *     (`audit/AuditLogSection`).
 *
 * Entry points (§5.5): `?nodeId=` (explain), `?resourceType=&resourceId=` (audit filter),
 * `?actionRequestId=` (approval context + its decision's explain + the `action_request` rows) —
 * each auto-runs. Acceptance chain "Fact → Activity → WorkerRun → Source": a Fact's explain shows
 * the chain with the Activity's `metadata.workerRunId` / `taskId` as links; an approval's
 * decision explains to its `governance.approval_decision` Activity (that Activity does not itself
 * chain on to the WorkerRun — the request's `parentWorkerRunId` is shown on the card instead).
 */
export function AuditPage({ http, entry: entryProp }: AuditPageProps) {
  const t = useT();
  const entry = useAuditEntry(entryProp);
  const principals = usePrincipalDirectory(http);
  const gatekeeperNames = useGatekeeperNames(http);
  // `ApprovalContext` is keyed on the request id, so a new entry remounts it and reports its
  // own row; a stale row from a previous entry is ignored here rather than reset by an effect.
  const [approval, setApproval] = useState<ActionRequestRow | null>(null);
  const approvalRow = approval && approval.id === entry.actionRequestId ? approval : null;

  const requestedNodeId = entry.nodeId ?? approvalRow?.approvalDecisionId ?? undefined;
  const requestedFilter = useMemo<AuditFilter | undefined>(() => {
    const filter = auditFilterFromEntry(entry);
    return isEmptyFilter(filter) ? undefined : filter;
  }, [entry]);

  return (
    <div className="page">
      <PageHeader
        breadcrumb={breadcrumbFor('audit')}
        title={t('审计', 'Audit')}
        description={t(
          '按 id 或筛选做溯源（explain / reconstruct）与审计流查询；从任务、审批与对话中的事实一键进入。',
          'Provenance lookups (explain, reconstruct) and the audit log, by id or filter — reachable from tasks, approvals and facts in a chat.',
        )}
      />
      {entry.actionRequestId ? (
        <ApprovalContext
          key={entry.actionRequestId}
          http={http}
          actionRequestId={entry.actionRequestId}
          principalNames={principals.names}
          gatekeeperNames={gatekeeperNames}
          onLoaded={setApproval}
        />
      ) : null}
      <ExplainSection
        http={http}
        requestedNodeId={requestedNodeId}
        principalNames={principals.names}
      />
      <ReconstructCard http={http} />
      <AuditLogSection
        http={http}
        requestedFilter={requestedFilter}
        principals={principals.rows}
        principalNames={principals.names}
        principalsUnavailable={principals.failed}
      />
    </div>
  );
}

/** The entry from the prop, or — when the route table does not carry it — from the hash, kept
 *  in sync with `hashchange` so a second deep link into the already-mounted page re-runs. */
function useAuditEntry(entryProp: AuditEntry | undefined): AuditEntry {
  const read = useCallback(
    () => entryProp ?? auditEntryFromHash(window.location.hash),
    [entryProp],
  );
  const [entry, setEntry] = useState<AuditEntry>(read);
  useEffect(() => {
    setEntry(read());
    if (entryProp !== undefined) return;
    const sync = () => setEntry(auditEntryFromHash(window.location.hash));
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [read, entryProp]);
  return entry;
}

interface LookupState {
  readonly busy: boolean;
  readonly error: unknown | null;
  readonly result: unknown | null;
}

const IDLE: LookupState = { busy: false, error: null, result: null };

function ReconstructCard({ http }: { readonly http: CapabilityCaller }) {
  const t = useT();
  const [entityId, setEntityId] = useState('');
  const [state, setState] = useState<LookupState>(IDLE);
  const forbidden = state.error !== null && isForbiddenError(state.error);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = entityId.trim();
    if (!trimmed || state.busy) return;
    setState({ busy: true, error: null, result: null });
    try {
      const result = await http.call('reconstruct', { entityId: trimmed });
      setState({ busy: false, error: null, result });
    } catch (err) {
      setState({ busy: false, error: err, result: null });
    }
  }

  return (
    <section className="section" aria-labelledby="reconstruct-title">
      <div className="section-header">
        <h2 id="reconstruct-title">{t('重建', 'Reconstruct')}</h2>
      </div>
      <form
        className="inline-form"
        onSubmit={(event) => void handleSubmit(event)}
        data-testid="reconstruct-form"
      >
        <Field
          id="reconstruct-entity-id"
          label={t('实体 id', 'Entity id')}
          hint={t(
            '图对象 id：从审计记录重建其历史。',
            'A graph Object id — its history rebuilt from the audit records.',
          )}
        >
          <Input
            id="reconstruct-entity-id"
            value={entityId}
            onChange={(event) => setEntityId(event.target.value)}
            disabled={state.busy}
            mono
          />
        </Field>
        <Button type="submit" variant="secondary" loading={state.busy} disabled={!entityId.trim()}>
          {t('重建', 'Reconstruct')}
        </Button>
      </form>
      {forbidden ? (
        <EmptyState
          icon="shield"
          title={t('需要 auditor 角色', 'Needs the auditor role')}
          testId="reconstruct-forbidden"
        />
      ) : state.error !== null ? (
        <ErrorBanner
          error={state.error}
          title={t('无法重建该实体', 'Could not reconstruct this entity')}
          testId="reconstruct-error"
        />
      ) : null}
      {state.result !== null ? (
        <pre className="code-block pre-wrap" data-testid="reconstruct-result">
          {prettyJson(redactSensitive(state.result))}
        </pre>
      ) : null}
    </section>
  );
}
