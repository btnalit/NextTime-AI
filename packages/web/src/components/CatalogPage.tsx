import { useState } from 'react';
import { invalidateCapability, useCapabilityList } from '../hooks/useCapability.js';
import { usePermissions } from '../hooks/usePermissions.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { isForbiddenError, isNotFoundError } from '../lib/errors.js';
import type { OperationCatalogRow, ProcedureRow, SkillRow } from '../lib/governance.js';
import type { CatalogTab } from '../lib/router.js';
import { type WorkerDefinitionSummary, definitionName } from '../lib/tasks.js';
import { Button } from './ui/Button.js';
import { DataList, DataRow } from './ui/DataList.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { PageHeader } from './ui/PageHeader.js';
import { SkeletonRows } from './ui/Skeleton.js';
import { StatusChip } from './ui/StatusChip.js';
import { Tabs } from './ui/Tabs.js';
import { useToast } from './ui/Toast.js';

export interface CatalogPageProps {
  readonly http: CapabilityCaller;
  readonly tab: CatalogTab;
  readonly onTabChange: (tab: CatalogTab) => void;
}

const TAB_LABEL: Readonly<Record<CatalogTab, string>> = {
  operations: 'Operations',
  skills: 'Skills',
  procedures: 'Procedures',
  workers: 'Workers',
};

/**
 * components/CatalogPage: 能力目录 Catalog (`/govern/catalog`, S3.11 "目录" group — `minRole:
 * 'member'`, open to everyone). Four tabs over the platform's publishable content: Operations
 * (`list_operations`, new), Skills/Procedures (`list_skills`/`list_procedures`, existing —
 * verified wire shape, `lib/governance.ts`'s own doc comment), Workers (`list_worker_definitions`,
 * existing, reuses `lib/tasks.ts`'s `WorkerDefinitionSummary` rather than a second type for the
 * same row). Publish/deprecate stay the two-step `propose → publish` capabilities already in the
 * registry (docs/wire-contract-conventions.md: "UI 不得提供'直接改分类'的捷径") — this page never
 * offers a shortcut, only the two existing write calls, each still `channel: 'human'`-gated on its
 * own (no fixed `minRole`, so a 403 denies only that one capability — `hooks/usePermissions.tsx`).
 *
 * `list_worker_definitions` only ever returns *published* rows (its own kernel-side doc comment,
 * `lib/tasks.ts`), so unlike Skills/Procedures (which also show the caller's own drafts) the
 * Workers tab has nothing to Publish — Deprecate only.
 */
export function CatalogPage({ http, tab, onTabChange }: CatalogPageProps) {
  return (
    <div className="page">
      <PageHeader
        title="能力目录 Catalog"
        description="Published Operations, Skills, Procedures, and Worker definitions across the workspace."
      />
      <div className="page-toolbar">
        <Tabs<CatalogTab>
          ariaLabel="Catalog section"
          value={tab}
          onChange={onTabChange}
          options={(Object.keys(TAB_LABEL) as CatalogTab[]).map((value) => ({
            value,
            label: TAB_LABEL[value],
          }))}
        />
      </div>
      {tab === 'operations' ? (
        <OperationsTab http={http} />
      ) : tab === 'skills' ? (
        <SkillsTab http={http} />
      ) : tab === 'procedures' ? (
        <ProceduresTab http={http} />
      ) : (
        <WorkersTab http={http} />
      )}
    </div>
  );
}

function DegradedList({
  status,
  error,
  reload,
  emptyIcon,
  capabilityLabel,
}: {
  readonly status: 'loading' | 'error';
  readonly error?: unknown;
  readonly reload: () => void;
  readonly emptyIcon: 'grid';
  readonly capabilityLabel: string;
}) {
  if (status === 'loading') {
    return <SkeletonRows count={4} label={`Loading ${capabilityLabel}`} />;
  }
  if (isNotFoundError(error)) {
    return (
      <EmptyState
        icon={emptyIcon}
        title="该能力尚未上线 Not live yet"
        body={`${capabilityLabel} is still landing on the kernel side.`}
        testId="catalog-unavailable"
      />
    );
  }
  return (
    <ErrorBanner
      error={error}
      title={`Could not load ${capabilityLabel}`}
      onRetry={reload}
      testId="catalog-error"
    />
  );
}

function OperationsTab({ http }: { readonly http: CapabilityCaller }) {
  const permissions = usePermissions();
  const toast = useToast();
  const operations = useCapabilityList<OperationCatalogRow>(http, 'list_operations');
  const [busy, setBusy] = useState<string | null>(null);

  function refresh(): void {
    invalidateCapability(http, 'list_operations');
    void operations.reload();
  }

  async function act(
    row: OperationCatalogRow,
    action: 'publish_operation' | 'deprecate_operation',
  ) {
    setBusy(row.id);
    try {
      await http.call(action, { gatekeeperId: row.gatekeeperId, name: row.name });
      toast.push({
        tone: 'ok',
        title: `${row.name} ${action === 'publish_operation' ? 'published' : 'deprecated'}`,
      });
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied(action);
      toast.push({ tone: 'danger', title: `Could not update ${row.name}` });
    } finally {
      setBusy(null);
    }
  }

  if (operations.state.status !== 'ready') {
    return (
      <DegradedList
        status={operations.state.status === 'loading' ? 'loading' : 'error'}
        error={operations.state.status === 'error' ? operations.state.error : undefined}
        reload={() => void operations.reload()}
        emptyIcon="grid"
        capabilityLabel="list_operations"
      />
    );
  }
  const rows = operations.state.data.items;
  if (rows.length === 0) {
    return <EmptyState icon="grid" title="No operations imported yet" testId="catalog-empty" />;
  }
  return (
    <DataList ariaLabel="Operations" testId="catalog-list">
      {rows.map((row) => (
        <DataRow
          key={row.id}
          testId="catalog-row"
          leading={<StatusChip machine="publishable" status={row.status} size="s" />}
          title={
            <>
              <span className="mono truncate">{row.name}</span>
              {row.mode ? <span className="tag">{row.mode}</span> : null}
            </>
          }
          meta={
            <>
              <span title={row.gatekeeperId}>{row.gatekeeperName ?? row.gatekeeperId}</span>
              {row.blastRadius && row.blastRadius !== 'low' ? (
                <>
                  <span className="meta-sep" />
                  <span className={row.blastRadius === 'high' ? 'text-danger' : ''}>
                    {row.blastRadius} blast radius
                  </span>
                </>
              ) : null}
            </>
          }
          trailing={
            !permissions.isDenied('publish_operation') && row.status === 'draft' ? (
              <Button
                variant="primary"
                size="s"
                loading={busy === row.id}
                onClick={() => void act(row, 'publish_operation')}
              >
                Publish
              </Button>
            ) : !permissions.isDenied('deprecate_operation') && row.status === 'published' ? (
              <Button
                variant="ghost"
                size="s"
                loading={busy === row.id}
                onClick={() => void act(row, 'deprecate_operation')}
              >
                Deprecate
              </Button>
            ) : undefined
          }
        />
      ))}
    </DataList>
  );
}

function SkillsTab({ http }: { readonly http: CapabilityCaller }) {
  const permissions = usePermissions();
  const toast = useToast();
  const skills = useCapabilityList<SkillRow>(http, 'list_skills');
  const [busy, setBusy] = useState<string | null>(null);

  function refresh(): void {
    invalidateCapability(http, 'list_skills');
    void skills.reload();
  }

  async function act(row: SkillRow, action: 'publish_skill' | 'deprecate_skill') {
    setBusy(row.id);
    try {
      await http.call(action, { skillId: row.id });
      toast.push({
        tone: 'ok',
        title: `${row.name} ${action === 'publish_skill' ? 'published' : 'deprecated'}`,
      });
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied(action);
      toast.push({ tone: 'danger', title: `Could not update ${row.name}` });
    } finally {
      setBusy(null);
    }
  }

  if (skills.state.status !== 'ready') {
    return (
      <DegradedList
        status={skills.state.status === 'loading' ? 'loading' : 'error'}
        error={skills.state.status === 'error' ? skills.state.error : undefined}
        reload={() => void skills.reload()}
        emptyIcon="grid"
        capabilityLabel="list_skills"
      />
    );
  }
  const rows = skills.state.data.items;
  if (rows.length === 0) {
    return <EmptyState icon="grid" title="No skills proposed yet" testId="catalog-empty" />;
  }
  return (
    <DataList ariaLabel="Skills" testId="catalog-list">
      {rows.map((row) => (
        <DataRow
          key={row.id}
          testId="catalog-row"
          leading={<StatusChip machine="publishable" status={row.status} size="s" />}
          title={
            <>
              <span className="truncate">{row.name}</span>
              <span className="text-3 text-small">v{row.version}</span>
            </>
          }
          meta={<span className="truncate">{row.description}</span>}
          trailing={
            !permissions.isDenied('publish_skill') && row.status === 'draft' ? (
              <Button
                variant="primary"
                size="s"
                loading={busy === row.id}
                onClick={() => void act(row, 'publish_skill')}
              >
                Publish
              </Button>
            ) : !permissions.isDenied('deprecate_skill') && row.status === 'published' ? (
              <Button
                variant="ghost"
                size="s"
                loading={busy === row.id}
                onClick={() => void act(row, 'deprecate_skill')}
              >
                Deprecate
              </Button>
            ) : undefined
          }
        />
      ))}
    </DataList>
  );
}

function ProceduresTab({ http }: { readonly http: CapabilityCaller }) {
  const permissions = usePermissions();
  const toast = useToast();
  const procedures = useCapabilityList<ProcedureRow>(http, 'list_procedures');
  const [busy, setBusy] = useState<string | null>(null);

  function refresh(): void {
    invalidateCapability(http, 'list_procedures');
    void procedures.reload();
  }

  async function act(row: ProcedureRow, action: 'publish_procedure' | 'deprecate_procedure') {
    setBusy(row.id);
    try {
      await http.call(action, { procedureId: row.id });
      toast.push({
        tone: 'ok',
        title: `${row.name} ${action === 'publish_procedure' ? 'published' : 'deprecated'}`,
      });
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied(action);
      toast.push({ tone: 'danger', title: `Could not update ${row.name}` });
    } finally {
      setBusy(null);
    }
  }

  if (procedures.state.status !== 'ready') {
    return (
      <DegradedList
        status={procedures.state.status === 'loading' ? 'loading' : 'error'}
        error={procedures.state.status === 'error' ? procedures.state.error : undefined}
        reload={() => void procedures.reload()}
        emptyIcon="grid"
        capabilityLabel="list_procedures"
      />
    );
  }
  const rows = procedures.state.data.items;
  if (rows.length === 0) {
    return <EmptyState icon="grid" title="No procedures proposed yet" testId="catalog-empty" />;
  }
  return (
    <DataList ariaLabel="Procedures" testId="catalog-list">
      {rows.map((row) => (
        <DataRow
          key={row.id}
          testId="catalog-row"
          leading={<StatusChip machine="publishable" status={row.status} size="s" />}
          title={
            <>
              <span className="truncate">{row.name}</span>
              <span className="text-3 text-small">v{row.version}</span>
            </>
          }
          meta={<span className="truncate">{row.description}</span>}
          trailing={
            !permissions.isDenied('publish_procedure') && row.status === 'draft' ? (
              <Button
                variant="primary"
                size="s"
                loading={busy === row.id}
                onClick={() => void act(row, 'publish_procedure')}
              >
                Publish
              </Button>
            ) : !permissions.isDenied('deprecate_procedure') && row.status === 'published' ? (
              <Button
                variant="ghost"
                size="s"
                loading={busy === row.id}
                onClick={() => void act(row, 'deprecate_procedure')}
              >
                Deprecate
              </Button>
            ) : undefined
          }
        />
      ))}
    </DataList>
  );
}

function WorkersTab({ http }: { readonly http: CapabilityCaller }) {
  const permissions = usePermissions();
  const toast = useToast();
  const workers = useCapabilityList<WorkerDefinitionSummary>(http, 'list_worker_definitions', {});
  const [busy, setBusy] = useState<string | null>(null);

  function refresh(): void {
    invalidateCapability(http, 'list_worker_definitions');
    void workers.reload();
  }

  async function deprecate(row: WorkerDefinitionSummary): Promise<void> {
    setBusy(row.id);
    try {
      await http.call('deprecate_worker_definition', {
        definitionId: row.id,
        version: row.version,
      });
      toast.push({
        tone: 'ok',
        title: `${definitionName([row], row.id, row.version) ?? row.id} deprecated`,
      });
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('deprecate_worker_definition');
      toast.push({ tone: 'danger', title: 'Could not deprecate this definition' });
    } finally {
      setBusy(null);
    }
  }

  if (workers.state.status !== 'ready') {
    return (
      <DegradedList
        status={workers.state.status === 'loading' ? 'loading' : 'error'}
        error={workers.state.status === 'error' ? workers.state.error : undefined}
        reload={() => void workers.reload()}
        emptyIcon="grid"
        capabilityLabel="list_worker_definitions"
      />
    );
  }
  const rows = workers.state.data.items;
  if (rows.length === 0) {
    return (
      <EmptyState icon="grid" title="No published worker definitions" testId="catalog-empty" />
    );
  }
  return (
    <DataList ariaLabel="Worker definitions" testId="catalog-list">
      {rows.map((row) => (
        <DataRow
          key={`${row.id}@${row.version}`}
          testId="catalog-row"
          leading={<StatusChip machine="publishable" status={row.status} size="s" />}
          title={
            <>
              <span className="truncate">
                {definitionName([row], row.id, row.version) ?? row.id}
              </span>
              <span className="text-3 text-small">v{row.version}</span>
              <span className="tag">{row.kind}</span>
            </>
          }
          trailing={
            !permissions.isDenied('deprecate_worker_definition') && row.status === 'published' ? (
              <Button
                variant="ghost"
                size="s"
                loading={busy === row.id}
                onClick={() => void deprecate(row)}
              >
                Deprecate
              </Button>
            ) : undefined
          }
        />
      ))}
    </DataList>
  );
}
