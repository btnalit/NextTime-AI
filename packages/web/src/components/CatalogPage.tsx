import { useState } from 'react';
import { invalidateCapability, useCapabilityList } from '../hooks/useCapability.js';
import { usePermissions } from '../hooks/usePermissions.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { describeError, isForbiddenError } from '../lib/errors.js';
import { formatRelative } from '../lib/format.js';
import {
  type GatekeeperListRow,
  type ModelRow,
  type OperationCatalogRow,
  type OperationStatsRow,
  type ProcedureRow,
  type SkillRow,
  operationKey,
  operationStatsKey,
} from '../lib/governance.js';
import { breadcrumbFor } from '../lib/nav.js';
import type { CatalogTab } from '../lib/router.js';
import { hrefs } from '../lib/router.js';
import { type WorkerDefinitionSummary, definitionName } from '../lib/tasks.js';
import { nameOf, useGatekeeperNames } from './approvals/useDirectoryNames.js';
import { ModulesTab } from './catalog/ModulesTab.js';
import { ProcedureEditor } from './catalog/ProcedureEditor.js';
import { SkillEditor } from './catalog/SkillEditor.js';
import { WorkerDefinitionEditor } from './catalog/WorkerDefinitionEditor.js';
import { PageHeader } from './kit/page-header.js';
import { Button } from './ui/Button.js';
import { DataList, DataRow } from './ui/DataList.js';
import { Drawer } from './ui/Drawer.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { RefChip } from './ui/RefChip.js';
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
  modules: 'Modules',
};

/**
 * components/CatalogPage: 能力目录 Catalog (`/govern/catalog`, S3.11 "目录" group — `minRole:
 * 'member'`, open to everyone). Four tabs over the platform's publishable content: Operations
 * (`list_operations`), Skills/Procedures (`list_skills`/`list_procedures` — verified wire shape,
 * `lib/governance.ts`'s own doc comment), Workers (`list_worker_definitions`, reuses
 * `lib/tasks.ts`'s `WorkerDefinitionSummary`). Publish/deprecate stay the two-step `propose →
 * publish` capabilities already in the registry (docs/wire-contract-conventions.md: "UI 不得提供
 * '直接改分类'的捷径") — never a shortcut, each write still `channel: 'human'`-gated on its own
 * (no fixed `minRole`, so a 403 denies only that one capability — `hooks/usePermissions.tsx`).
 *
 * S6-A A2 (docs/console-completion-plan.md §5.3 "编辑器"): the Skills / Procedures / Workers
 * tabs gain "新建草稿 New draft" and, per row, "编辑为新草稿 Edit as new draft" — the editors in
 * `components/catalog/*` call `propose_skill` / `propose_procedure` /
 * `propose_worker_definition` (drafts are private to the proposer, I16) and then offer the
 * matching `publish_*`. Two kernel facts the page states rather than hides: `propose_skill` /
 * `propose_procedure` address no family, so "edit" of those two is a copy into a *new* draft
 * (new id, v1; a Skill copy re-enters the body — `list_skills` has no `markdown`), whereas
 * `propose_worker_definition{definitionId}` is a real next version. S8 W1-C (#243) made
 * `list_skills` / `list_procedures` / `list_worker_definitions` keyset-paginated (this comment
 * said "noParams … stay single-page, B5 does not apply" until S8 W1-A4); the three browsable tabs
 * below now offer "加载更多" via `useCapabilityList`'s `loadMore`/`nextCursor`/`truncated`.
 *
 * `list_worker_definitions` only ever returns *published* rows (its own kernel-side doc comment,
 * `lib/tasks.ts`), so unlike Skills/Procedures (which also show the caller's own drafts) the
 * Workers tab has nothing to Publish — Deprecate only; a freshly proposed Worker draft is
 * published from the editor's success state instead.
 *
 * Operations rows also carry a usage summary (调用/批准/拒绝/最近, S3.12 catalog-usage follow-up)
 * fed by its own `get_operation_stats` capability call, joined client-side by `{gatekeeperId,
 * name}` (`lib/governance.ts`'s `operationStatsKey`) — a separate `useCapabilityList` from
 * `list_operations`'s own, so a stats failure degrades one row's usage span to "—" rather than
 * the whole tab.
 */
export function CatalogPage({ http, tab, onTabChange }: CatalogPageProps) {
  return (
    <div className="page">
      <PageHeader
        breadcrumb={breadcrumbFor('catalog')}
        title="能力目录 Catalog"
        description="工作区里已发布的 Operation、Skill、Procedure 与 Worker 定义，以及你自己的草稿。 Published Operations, Skills, Procedures and Worker definitions across the workspace, plus your own drafts."
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
      ) : tab === 'workers' ? (
        <WorkersTab http={http} />
      ) : (
        <ModulesTab http={http} />
      )}
    </div>
  );
}

function DegradedList({
  status,
  error,
  reload,
  capabilityLabel,
}: {
  readonly status: 'loading' | 'error';
  readonly error?: unknown;
  readonly reload: () => void;
  readonly capabilityLabel: string;
}) {
  if (status === 'loading') {
    return <SkeletonRows count={4} label={`Loading ${capabilityLabel}`} />;
  }
  return (
    <ErrorBanner
      error={error}
      title={`无法加载 Could not load ${capabilityLabel}`}
      onRetry={reload}
      testId="catalog-error"
    />
  );
}

/** The per-tab toolbar: the one primary action of the page ("新建草稿", §5.9 principle 1) plus
 *  the refresh — hidden entirely when the session has learned it may not propose. */
function DraftToolbar({
  canPropose,
  onNewDraft,
  onRefresh,
  refreshing,
  testId,
}: {
  readonly canPropose: boolean;
  readonly onNewDraft: () => void;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
  readonly testId: string;
}) {
  return (
    <div className="page-toolbar">
      {canPropose ? (
        <Button variant="primary" icon="plus" onClick={onNewDraft} data-testid={testId}>
          新建草稿 New draft
        </Button>
      ) : null}
      <Button variant="ghost" icon="refresh" onClick={onRefresh} loading={refreshing}>
        刷新 Refresh
      </Button>
    </div>
  );
}

function OperationsTab({ http }: { readonly http: CapabilityCaller }) {
  const permissions = usePermissions();
  const toast = useToast();
  const operations = useCapabilityList<OperationCatalogRow>(http, 'list_operations');
  // Own capability call, own degrade path — a `get_operation_stats` failure (not deployed yet, a
  // transient error, whatever) never blocks the Operations list itself; a row simply renders "—"
  // for its usage columns when no matching stats entry comes back (see `statsFor` below).
  const stats = useCapabilityList<OperationStatsRow>(http, 'get_operation_stats');
  const gatekeeperNames = useGatekeeperNames(http);
  const [busy, setBusy] = useState<string | null>(null);

  function refresh(): void {
    invalidateCapability(http, 'list_operations');
    void operations.reload();
  }

  function statsFor(row: OperationCatalogRow): OperationStatsRow | undefined {
    if (stats.state.status !== 'ready') return undefined;
    const key = operationStatsKey({ gatekeeperId: row.gatekeeperId, operationName: row.name });
    return stats.state.data.items.find((item) => operationStatsKey(item) === key);
  }

  async function act(
    row: OperationCatalogRow,
    action: 'publish_operation' | 'deprecate_operation',
  ) {
    const key = operationKey(row);
    setBusy(key);
    try {
      await http.call(action, { gatekeeperId: row.gatekeeperId, name: row.name });
      toast.push({
        tone: 'ok',
        title: `${row.name} ${action === 'publish_operation' ? '已发布 published' : '已弃用 deprecated'}`,
      });
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied(action);
      // C14: carry the kernel's own text — the generic title alone dropped the actual reason.
      toast.push({
        tone: 'danger',
        title: `Could not update ${row.name}`,
        description: describeError(err).message,
      });
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
        capabilityLabel="list_operations"
      />
    );
  }
  const rows = operations.state.data.items;
  if (rows.length === 0) {
    return (
      <EmptyState
        icon="grid"
        title="还没有导入任何 Operation No operations imported yet"
        body="Operation 来自系统接入的清单（publish_manifest）或接入向导的提议。 Operations come from a connected system's manifest or the onboarding wizard's proposals."
        testId="catalog-empty"
      />
    );
  }
  return (
    <>
      <DataList ariaLabel="Operations" testId="catalog-list">
        {rows.map((row) => {
          const key = operationKey(row);
          const usage = statsFor(row);
          return (
            <DataRow
              key={key}
              testId="catalog-row"
              leading={<StatusChip machine="publishable" status={row.status} size="s" />}
              title={
                <>
                  <span className="mono truncate">{row.name}</span>
                  {row.mode ? (
                    <StatusChip machine="operationMode" status={row.mode} size="s" />
                  ) : null}
                  {row.autoApprovable ? <span className="tag">auto-approvable</span> : null}
                </>
              }
              meta={
                <>
                  <RefChip
                    kind="gatekeeper"
                    id={row.gatekeeperId}
                    name={nameOf(gatekeeperNames, row.gatekeeperId)}
                    href={hrefs.gatekeeper(row.gatekeeperId)}
                    size="s"
                  />
                  {row.blastRadius && row.blastRadius !== 'low' ? (
                    <>
                      <span className="meta-sep" />
                      <StatusChip machine="blastRadius" status={row.blastRadius} size="s" />
                    </>
                  ) : null}
                  <span className="meta-sep" />
                  <span
                    data-testid="catalog-row-usage"
                    title={
                      usage
                        ? `${usage.calls} calls, ${usage.approved} approved, ${usage.rejected} rejected in the trailing window`
                        : 'No usage data for this Operation (get_operation_stats unavailable, or no calls in the window)'
                    }
                  >
                    {usage
                      ? `${usage.calls} 调用 · ${usage.approved} 批准 · ${usage.rejected} 拒绝 · ${formatRelative(usage.lastCalledAt)}`
                      : '—'}
                  </span>
                </>
              }
              trailing={
                !permissions.isDenied('publish_operation') && row.status === 'draft' ? (
                  <Button
                    variant="primary"
                    size="s"
                    loading={busy === key}
                    onClick={() => void act(row, 'publish_operation')}
                  >
                    发布 Publish
                  </Button>
                ) : !permissions.isDenied('deprecate_operation') && row.status === 'published' ? (
                  <Button
                    variant="ghost"
                    size="s"
                    loading={busy === key}
                    onClick={() => void act(row, 'deprecate_operation')}
                  >
                    弃用 Deprecate
                  </Button>
                ) : undefined
              }
            />
          );
        })}
      </DataList>
    </>
  );
}

type EditorState<Row> =
  | { readonly kind: 'new' }
  | { readonly kind: 'copy'; readonly row: Row }
  | null;

function SkillsTab({ http }: { readonly http: CapabilityCaller }) {
  const permissions = usePermissions();
  const toast = useToast();
  const skills = useCapabilityList<SkillRow>(http, 'list_skills');
  const [busy, setBusy] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState<SkillRow>>(null);

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
        title: `${row.name} ${action === 'publish_skill' ? '已发布 published' : '已弃用 deprecated'}`,
      });
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied(action);
      // C14: carry the kernel's own text — the generic title alone dropped the actual reason.
      toast.push({
        tone: 'danger',
        title: `Could not update ${row.name}`,
        description: describeError(err).message,
      });
    } finally {
      setBusy(null);
    }
  }

  const editorDrawer = (
    <Drawer
      open={editor !== null}
      onClose={() => setEditor(null)}
      title={
        editor?.kind === 'copy'
          ? '编辑为新草稿 Edit as new draft'
          : '新建 Skill 草稿 New Skill draft'
      }
      subtitle="SKILL.md：frontmatter 字段 + Markdown 正文 frontmatter fields + Markdown body"
      wide
      testId="skill-editor-drawer"
    >
      {editor ? (
        <SkillEditor
          key={editor.kind === 'copy' ? editor.row.id : 'new'}
          http={http}
          copyOf={editor.kind === 'copy' ? editor.row : undefined}
          onProposed={() => void skills.reload()}
          onDone={() => {
            setEditor(null);
            refresh();
          }}
        />
      ) : null}
    </Drawer>
  );

  // The editor drawer is rendered in every state (below) so a reload that passes through
  // `loading` never unmounts an editor mid-flight and loses its "draft proposed" state.
  if (skills.state.status !== 'ready') {
    return (
      <>
        <DegradedList
          status={skills.state.status === 'loading' ? 'loading' : 'error'}
          error={skills.state.status === 'error' ? skills.state.error : undefined}
          reload={() => void skills.reload()}
          capabilityLabel="list_skills"
        />
        {editorDrawer}
      </>
    );
  }
  const rows = skills.state.data.items;
  return (
    <>
      <DraftToolbar
        canPropose={!permissions.isDenied('propose_skill')}
        onNewDraft={() => setEditor({ kind: 'new' })}
        onRefresh={refresh}
        refreshing={skills.state.refreshing}
        testId="skills-new-draft"
      />
      {rows.length === 0 ? (
        <EmptyState
          icon="grid"
          title="还没有 Skill No skills proposed yet"
          body="用「新建草稿」写第一个 SKILL.md，或让 Worker 在结果里提议。 Write the first SKILL.md with New draft, or let a Worker propose one in its result."
          testId="catalog-empty"
        />
      ) : (
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
                <span className="row">
                  {!permissions.isDenied('propose_skill') ? (
                    <Button
                      variant="ghost"
                      size="s"
                      onClick={() => setEditor({ kind: 'copy', row })}
                      data-testid="catalog-edit-as-draft"
                    >
                      编辑为新草稿 Edit as new draft
                    </Button>
                  ) : null}
                  {!permissions.isDenied('publish_skill') && row.status === 'draft' ? (
                    <Button
                      variant="primary"
                      size="s"
                      loading={busy === row.id}
                      onClick={() => void act(row, 'publish_skill')}
                    >
                      发布 Publish
                    </Button>
                  ) : !permissions.isDenied('deprecate_skill') && row.status === 'published' ? (
                    <Button
                      variant="ghost"
                      size="s"
                      loading={busy === row.id}
                      onClick={() => void act(row, 'deprecate_skill')}
                    >
                      弃用 Deprecate
                    </Button>
                  ) : null}
                </span>
              }
            />
          ))}
        </DataList>
      )}
      {skills.state.status === 'ready' && skills.state.data.nextCursor !== undefined ? (
        <div className="row" style={{ justifyContent: 'center' }}>
          <Button
            variant="secondary"
            loading={skills.loadingMore}
            onClick={() => void skills.loadMore()}
          >
            加载更多 Load more
          </Button>
        </div>
      ) : null}
      {skills.state.status === 'ready' && skills.state.data.truncated === true ? (
        <p className="text-3 text-small" data-testid="skills-truncated">
          已达到单次读取上限 Reached the per-page limit — 继续点“加载更多”查看其余 Skill keep
          loading more to see the rest.
        </p>
      ) : null}
      {skills.loadMoreError !== null ? (
        <ErrorBanner
          error={skills.loadMoreError}
          title="Could not load more skills"
          testId="skills-load-more-error"
        />
      ) : null}
      {editorDrawer}
    </>
  );
}

function ProceduresTab({ http }: { readonly http: CapabilityCaller }) {
  const permissions = usePermissions();
  const toast = useToast();
  const procedures = useCapabilityList<ProcedureRow>(http, 'list_procedures');
  const [busy, setBusy] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState<ProcedureRow>>(null);

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
        title: `${row.name} ${action === 'publish_procedure' ? '已发布 published' : '已弃用 deprecated'}`,
      });
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied(action);
      // C14: carry the kernel's own text — the generic title alone dropped the actual reason.
      toast.push({
        tone: 'danger',
        title: `Could not update ${row.name}`,
        description: describeError(err).message,
      });
    } finally {
      setBusy(null);
    }
  }

  const editorDrawer = (
    <Drawer
      open={editor !== null}
      onClose={() => setEditor(null)}
      title={
        editor?.kind === 'copy'
          ? '编辑为新草稿 Edit as new draft'
          : '新建 Procedure 草稿 New Procedure draft'
      }
      subtitle="名称、描述与有序步骤 name, description and ordered steps"
      wide
      testId="procedure-editor-drawer"
    >
      {editor ? (
        <ProcedureEditorHost
          key={editor.kind === 'copy' ? editor.row.id : 'new'}
          http={http}
          copyOf={editor.kind === 'copy' ? editor.row : undefined}
          onProposed={() => void procedures.reload()}
          onDone={() => {
            setEditor(null);
            refresh();
          }}
        />
      ) : null}
    </Drawer>
  );

  if (procedures.state.status !== 'ready') {
    return (
      <>
        <DegradedList
          status={procedures.state.status === 'loading' ? 'loading' : 'error'}
          error={procedures.state.status === 'error' ? procedures.state.error : undefined}
          reload={() => void procedures.reload()}
          capabilityLabel="list_procedures"
        />
        {editorDrawer}
      </>
    );
  }
  const rows = procedures.state.data.items;
  return (
    <>
      <DraftToolbar
        canPropose={!permissions.isDenied('propose_procedure')}
        onNewDraft={() => setEditor({ kind: 'new' })}
        onRefresh={refresh}
        refreshing={procedures.state.refreshing}
        testId="procedures-new-draft"
      />
      {rows.length === 0 ? (
        <EmptyState
          icon="grid"
          title="还没有 Procedure No procedures proposed yet"
          body="用「新建草稿」写第一条有序步骤，或让 Worker 从成功的任务里蒸馏。 Write the first one with New draft, or let a Worker distil one from a successful Task."
          testId="catalog-empty"
        />
      ) : (
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
                  {row.steps ? <span className="tag">{row.steps.length} 步 steps</span> : null}
                </>
              }
              meta={<span className="truncate">{row.description}</span>}
              trailing={
                <span className="row">
                  {!permissions.isDenied('propose_procedure') ? (
                    <Button
                      variant="ghost"
                      size="s"
                      onClick={() => setEditor({ kind: 'copy', row })}
                      data-testid="catalog-edit-as-draft"
                    >
                      编辑为新草稿 Edit as new draft
                    </Button>
                  ) : null}
                  {!permissions.isDenied('publish_procedure') && row.status === 'draft' ? (
                    <Button
                      variant="primary"
                      size="s"
                      loading={busy === row.id}
                      onClick={() => void act(row, 'publish_procedure')}
                    >
                      发布 Publish
                    </Button>
                  ) : !permissions.isDenied('deprecate_procedure') && row.status === 'published' ? (
                    <Button
                      variant="ghost"
                      size="s"
                      loading={busy === row.id}
                      onClick={() => void act(row, 'deprecate_procedure')}
                    >
                      弃用 Deprecate
                    </Button>
                  ) : null}
                </span>
              }
            />
          ))}
        </DataList>
      )}
      {procedures.state.status === 'ready' && procedures.state.data.nextCursor !== undefined ? (
        <div className="row" style={{ justifyContent: 'center' }}>
          <Button
            variant="secondary"
            loading={procedures.loadingMore}
            onClick={() => void procedures.loadMore()}
          >
            加载更多 Load more
          </Button>
        </div>
      ) : null}
      {procedures.state.status === 'ready' && procedures.state.data.truncated === true ? (
        <p className="text-3 text-small" data-testid="procedures-truncated">
          已达到单次读取上限 Reached the per-page limit — 继续点“加载更多”查看其余 Procedure keep
          loading more to see the rest.
        </p>
      ) : null}
      {procedures.loadMoreError !== null ? (
        <ErrorBanner
          error={procedures.loadMoreError}
          title="Could not load more procedures"
          testId="procedures-load-more-error"
        />
      ) : null}
      {editorDrawer}
    </>
  );
}

/** Loads the pickers' directories only while the Procedure editor is open (member-level reads,
 *  cached per session by `useCapabilityList`); the editor degrades to typed ids without them. */
function ProcedureEditorHost({
  http,
  copyOf,
  onProposed,
  onDone,
}: {
  readonly http: CapabilityCaller;
  readonly copyOf?: ProcedureRow;
  readonly onProposed: () => void;
  readonly onDone: () => void;
}) {
  const gatekeepers = useCapabilityList<GatekeeperListRow>(http, 'list_gatekeepers');
  // A step picker, not a browsable list — autoLoadAll so a workspace with > 100 published Worker
  // definitions still offers every one of them, not just the first page (S8 W1-A4).
  const definitions = useCapabilityList<WorkerDefinitionSummary>(
    http,
    'list_worker_definitions',
    {},
    { autoLoadAll: true },
  );
  return (
    <ProcedureEditor
      http={http}
      copyOf={copyOf}
      gatekeepers={gatekeepers.state.status === 'ready' ? gatekeepers.state.data.items : undefined}
      workerDefinitions={
        definitions.state.status === 'ready' ? definitions.state.data.items : undefined
      }
      onProposed={onProposed}
      onDone={onDone}
    />
  );
}

function WorkersTab({ http }: { readonly http: CapabilityCaller }) {
  const permissions = usePermissions();
  const toast = useToast();
  const workers = useCapabilityList<WorkerDefinitionSummary>(http, 'list_worker_definitions', {});
  const [busy, setBusy] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState<WorkerDefinitionSummary>>(null);

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
        title: `${definitionName([row], row.id, row.version) ?? row.id} 已弃用 deprecated`,
      });
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('deprecate_worker_definition');
      toast.push({
        tone: 'danger',
        title: '无法弃用该定义 Could not deprecate this definition',
        description: describeError(err).message,
      });
    } finally {
      setBusy(null);
    }
  }

  const editorDrawer = (
    <Drawer
      open={editor !== null}
      onClose={() => setEditor(null)}
      title={
        editor?.kind === 'copy'
          ? '提议新版本 Propose a new version'
          : '新建 Worker 定义草稿 New Worker definition draft'
      }
      subtitle="kind + definition（systemPrompt、model、capabilities…）"
      wide
      testId="worker-editor-drawer"
    >
      {editor ? (
        <WorkerEditorHost
          key={editor.kind === 'copy' ? `${editor.row.id}@${editor.row.version}` : 'new'}
          http={http}
          newVersionOf={editor.kind === 'copy' ? editor.row : undefined}
          onProposed={() => void workers.reload()}
          onDone={() => {
            setEditor(null);
            refresh();
          }}
        />
      ) : null}
    </Drawer>
  );

  if (workers.state.status !== 'ready') {
    return (
      <>
        <DegradedList
          status={workers.state.status === 'loading' ? 'loading' : 'error'}
          error={workers.state.status === 'error' ? workers.state.error : undefined}
          reload={() => void workers.reload()}
          capabilityLabel="list_worker_definitions"
        />
        {editorDrawer}
      </>
    );
  }
  const rows = workers.state.data.items;
  return (
    <>
      <DraftToolbar
        canPropose={!permissions.isDenied('propose_worker_definition')}
        onNewDraft={() => setEditor({ kind: 'new' })}
        onRefresh={refresh}
        refreshing={workers.state.refreshing}
        testId="workers-new-draft"
      />
      {rows.length === 0 ? (
        <EmptyState
          icon="grid"
          title="没有已发布的 Worker 定义 No published worker definitions"
          body="这里只列已发布的版本；草稿在编辑器里发布。 Only published versions are listed; a draft is published from the editor."
          testId="catalog-empty"
        />
      ) : (
        <DataList ariaLabel="Worker definitions" testId="catalog-list">
          {rows.map((row) => (
            <DataRow
              key={`${row.id}@${row.version}`}
              testId="catalog-row"
              leading={<StatusChip machine="publishable" status={row.status} size="s" />}
              title={
                <>
                  <RefChip
                    kind="workerDefinition"
                    id={row.id}
                    name={definitionName([row], row.id, row.version)}
                    size="s"
                  />
                  <span className="text-3 text-small">v{row.version}</span>
                  <span className="tag">{row.kind}</span>
                </>
              }
              meta={
                typeof row.definition.description === 'string' ? (
                  <span className="truncate">{row.definition.description}</span>
                ) : undefined
              }
              trailing={
                <span className="row">
                  {!permissions.isDenied('propose_worker_definition') ? (
                    <Button
                      variant="ghost"
                      size="s"
                      onClick={() => setEditor({ kind: 'copy', row })}
                      data-testid="catalog-edit-as-draft"
                    >
                      编辑（新版本草稿） Edit as new draft version
                    </Button>
                  ) : null}
                  {!permissions.isDenied('deprecate_worker_definition') &&
                  row.status === 'published' ? (
                    <Button
                      variant="ghost"
                      size="s"
                      loading={busy === row.id}
                      onClick={() => void deprecate(row)}
                    >
                      弃用 Deprecate
                    </Button>
                  ) : null}
                </span>
              }
            />
          ))}
        </DataList>
      )}
      {workers.state.status === 'ready' && workers.state.data.nextCursor !== undefined ? (
        <div className="row" style={{ justifyContent: 'center' }}>
          <Button
            variant="secondary"
            loading={workers.loadingMore}
            onClick={() => void workers.loadMore()}
          >
            加载更多 Load more
          </Button>
        </div>
      ) : null}
      {workers.state.status === 'ready' && workers.state.data.truncated === true ? (
        <p className="text-3 text-small" data-testid="workers-truncated">
          已达到单次读取上限 Reached the per-page limit — 继续点“加载更多”查看其余 Worker 定义 keep
          loading more to see the rest.
        </p>
      ) : null}
      {workers.loadMoreError !== null ? (
        <ErrorBanner
          error={workers.loadMoreError}
          title="Could not load more worker definitions"
          testId="workers-load-more-error"
        />
      ) : null}
      {editorDrawer}
    </>
  );
}

/** Loads `list_models` for the model suggestions only while the Worker editor is open. */
function WorkerEditorHost({
  http,
  newVersionOf,
  onProposed,
  onDone,
}: {
  readonly http: CapabilityCaller;
  readonly newVersionOf?: WorkerDefinitionSummary;
  readonly onProposed: () => void;
  readonly onDone: () => void;
}) {
  const models = useCapabilityList<ModelRow>(http, 'list_models');
  return (
    <WorkerDefinitionEditor
      http={http}
      newVersionOf={newVersionOf}
      models={models.state.status === 'ready' ? models.state.data.items : undefined}
      onProposed={onProposed}
      onDone={onDone}
    />
  );
}
