import { type ReactNode, useState } from 'react';
import { invalidateCapability, useCapabilityList } from '../hooks/useCapability.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { type WorkerDefinitionForm, opsRunnerTemplateForm } from '../lib/catalog.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { describeError, isForbiddenError } from '../lib/errors.js';
import { formatRelative } from '../lib/format.js';
import {
  type CapabilityNameRow,
  type GatekeeperListRow,
  type ModelRow,
  type OperationCatalogRow,
  type OperationStatsRow,
  type ProcedureRow,
  type SkillRow,
  operationKey,
  operationStatsKey,
} from '../lib/governance.js';
import { useT } from '../lib/i18n.js';
import { workerDefinitionKindLabel } from '../lib/labels.js';
import { breadcrumbFor } from '../lib/nav.js';
import type { CatalogTab } from '../lib/router.js';
import { hrefs } from '../lib/router.js';
import { type WorkerDefinitionSummary, definitionName } from '../lib/tasks.js';
import { nameOf, useGatekeeperNames } from './approvals/useDirectoryNames.js';
import { ModulesTab } from './catalog/ModulesTab.js';
import { ProcedureEditor } from './catalog/ProcedureEditor.js';
import { SkillEditor } from './catalog/SkillEditor.js';
import { WorkerDefinitionEditor } from './catalog/WorkerDefinitionEditor.js';
import { Confirm } from './kit/confirm.js';
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

/** S8 W1-A10 (i18n remainder): `Operation`/`Skill`/`Procedure`/`Worker` stay English proper nouns
 *  even in zh copy (the page's own description above does the same); `Module` has an established
 *  zh term ("模块", `lib/nav.ts`'s catalog nav group). */
const TAB_LABEL: Readonly<Record<CatalogTab, { readonly zh: string; readonly en: string }>> = {
  operations: { zh: 'Operation', en: 'Operations' },
  skills: { zh: 'Skill', en: 'Skills' },
  procedures: { zh: 'Procedure', en: 'Procedures' },
  workers: { zh: 'Worker', en: 'Workers' },
  modules: { zh: '模块', en: 'Modules' },
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
 * 弃用 Deprecate (all four tabs) is a `DeprecateConfirm` — `kit/confirm` `medium`, anchored to its
 * own button (S8 W1-A7, audit S13: previously a plain text button with no confirmation at all,
 * the one catalog-scoped gap that audit named directly). Errors from a confirmed deprecate (like
 * publish) surface as a toast, not the confirm's own inline banner — `act`/`deprecate` already
 * catch and toast rather than re-throw, the same path Publish already used; changing that would
 * also change Publish's error handling, out of this lane's scope.
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
 * `list_worker_definitions` returns *published* rows by default, same as before; the Workers tab
 * also makes one dedicated `list_worker_definitions{includeOwnDrafts: true}` call (S8 W2-U2b,
 * audit R6 "保存草稿后找不回它") and renders its `status === 'draft'` rows as a "我的草稿" section,
 * shown only when non-empty, with the same one-click Publish Skills/Procedures rows already have —
 * a draft is otherwise reachable only from the id the editor's own success screen showed at
 * propose time. The Entry/Worker sections below still filter the *published*-only list, so a
 * draft never appears mixed into either of them.
 *
 * Operations rows also carry a usage summary (调用/批准/拒绝/最近, S3.12 catalog-usage follow-up)
 * fed by its own `get_operation_stats` capability call, joined client-side by `{gatekeeperId,
 * name}` (`lib/governance.ts`'s `operationStatsKey`) — a separate `useCapabilityList` from
 * `list_operations`'s own, so a stats failure degrades one row's usage span to "—" rather than
 * the whole tab.
 */
export function CatalogPage({ http, tab, onTabChange }: CatalogPageProps) {
  const t = useT();
  return (
    <div className="page">
      <PageHeader
        breadcrumb={breadcrumbFor('catalog')}
        title={t('能力目录', 'Catalog')}
        description={t(
          '工作区里已发布的 Operation、Skill、Procedure 与 Worker 定义，以及你自己的草稿。',
          'Published Operations, Skills, Procedures and Worker definitions across the workspace, plus your own drafts.',
        )}
      />
      <div className="page-toolbar">
        <Tabs<CatalogTab>
          ariaLabel="Catalog section"
          value={tab}
          onChange={onTabChange}
          options={(Object.keys(TAB_LABEL) as CatalogTab[]).map((value) => ({
            value,
            label: t(TAB_LABEL[value].zh, TAB_LABEL[value].en),
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
  extra,
}: {
  readonly canPropose: boolean;
  readonly onNewDraft: () => void;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
  readonly testId: string;
  /** An extra action grouped right after "New draft" — the Workers tab's own "从模板创建
   *  （ops-runner）" (J7/CW1). `undefined` for every other tab, unchanged layout. */
  readonly extra?: ReactNode;
}) {
  const t = useT();
  return (
    <div className="page-toolbar">
      {canPropose || extra ? (
        <div className="row-wrap">
          {canPropose ? (
            <Button variant="primary" icon="plus" onClick={onNewDraft} data-testid={testId}>
              {t('新建草稿', 'New draft')}
            </Button>
          ) : null}
          {extra}
        </div>
      ) : null}
      <Button variant="ghost" icon="refresh" onClick={onRefresh} loading={refreshing}>
        {t('刷新', 'Refresh')}
      </Button>
    </div>
  );
}

/** S8 W1-A7 (audit S13 "目录「弃用」是普通文字按钮" — no confirm at all): the one 弃用 Deprecate
 *  button every tab below shares — a `kit/confirm` `medium` popover anchored to the button itself
 *  (deprecating a published Operation/Skill/Procedure/Worker stops agents from reaching it, at
 *  least medium per the dispatch). `target`/`impact` are the one piece of data each tab already
 *  has about what deprecating this row affects; a tab with nothing more specific than "this row"
 *  passes `impact` as `undefined` rather than inventing a count it does not have. */
function DeprecateConfirm({
  busy,
  target,
  impact,
  onConfirm,
  testId,
}: {
  readonly busy: boolean;
  readonly target: string;
  readonly impact?: readonly string[];
  readonly onConfirm: () => Promise<void>;
  readonly testId: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <Confirm
      tier="medium"
      open={open}
      onOpenChange={setOpen}
      anchor={
        <Button
          variant="ghost"
          size="s"
          disabled={busy}
          onClick={() => setOpen(true)}
          data-testid={`${testId}-trigger`}
        >
          {t('弃用', 'Deprecate')}
        </Button>
      }
      title={`弃用 ${target} Deprecate ${target}`}
      description={t(
        '弃用后 Agent 不能再使用它；已发生的调用与审计不受影响，随时可以重新发布恢复。',
        'Once deprecated, agents can no longer reach it; past calls and the audit trail are unaffected, and republishing brings it back at any time.',
      )}
      target={target}
      impact={impact}
      confirmLabel={t('弃用', 'Deprecate')}
      danger
      onConfirm={onConfirm}
      testId={testId}
    />
  );
}

function OperationsTab({ http }: { readonly http: CapabilityCaller }) {
  const t = useT();
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
        title: `${row.name} ${action === 'publish_operation' ? t('已发布', 'published') : t('已弃用', 'deprecated')}`,
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
        title={t('还没有导入任何', 'Operation No operations imported yet')}
        body={t(
          'Operation 来自系统接入的清单（publish_manifest）或接入向导的提议。',
          "Operations come from a connected system's manifest or the onboarding wizard's proposals.",
        )}
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
                  {/* S8 W1-A11 (audit L3): through the shared StatusChip machine, not a bare tag. */}
                  {row.autoApprovable ? (
                    <StatusChip machine="autoApprovable" status="true" size="s" />
                  ) : null}
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
                    {t('发布', 'Publish')}
                  </Button>
                ) : !permissions.isDenied('deprecate_operation') && row.status === 'published' ? (
                  <DeprecateConfirm
                    busy={busy === key}
                    target={row.name}
                    impact={
                      usage
                        ? [
                            `${usage.calls} 次调用 calls in the trailing window`,
                            `${usage.approved} 次批准 approved`,
                          ]
                        : undefined
                    }
                    onConfirm={() => act(row, 'deprecate_operation')}
                    testId={`operation-deprecate-confirm-${key}`}
                  />
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
  const t = useT();
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
        title: `${row.name} ${action === 'publish_skill' ? t('已发布', 'published') : t('已弃用', 'deprecated')}`,
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
          ? t('编辑为新草稿', 'Edit as new draft')
          : t('新建 Skill 草稿', 'New Skill draft')
      }
      subtitle={t(
        'SKILL.md：frontmatter 字段 + Markdown 正文',
        'frontmatter fields + Markdown body',
      )}
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
          title={t('还没有', 'Skill No skills proposed yet')}
          body={t(
            '用「新建草稿」写第一个 SKILL.md，或让 Worker 在结果里提议。',
            'Write the first SKILL.md with New draft, or let a Worker propose one in its result.',
          )}
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
                      {t('编辑为新草稿', 'Edit as new draft')}
                    </Button>
                  ) : null}
                  {!permissions.isDenied('publish_skill') && row.status === 'draft' ? (
                    <Button
                      variant="primary"
                      size="s"
                      loading={busy === row.id}
                      onClick={() => void act(row, 'publish_skill')}
                    >
                      {t('发布', 'Publish')}
                    </Button>
                  ) : !permissions.isDenied('deprecate_skill') && row.status === 'published' ? (
                    <DeprecateConfirm
                      busy={busy === row.id}
                      target={row.name}
                      onConfirm={() => act(row, 'deprecate_skill')}
                      testId={`skill-deprecate-confirm-${row.id}`}
                    />
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
            {t('加载更多', 'Load more')}
          </Button>
        </div>
      ) : null}
      {skills.state.status === 'ready' && skills.state.data.truncated === true ? (
        <p className="text-3 text-small" data-testid="skills-truncated">
          {t(
            '已达到单次读取上限，继续点“加载更多”查看其余 Skill。',
            'Reached the per-page limit — keep loading more to see the rest.',
          )}
        </p>
      ) : null}
      {skills.loadMoreError !== null ? (
        <ErrorBanner
          error={skills.loadMoreError}
          title={t('无法加载更多 Skill', 'Could not load more skills')}
          testId="skills-load-more-error"
        />
      ) : null}
      {editorDrawer}
    </>
  );
}

function ProceduresTab({ http }: { readonly http: CapabilityCaller }) {
  const t = useT();
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
        title: `${row.name} ${action === 'publish_procedure' ? t('已发布', 'published') : t('已弃用', 'deprecated')}`,
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
          ? t('编辑为新草稿', 'Edit as new draft')
          : t('新建 Procedure 草稿', 'New Procedure draft')
      }
      subtitle={t('名称、描述与有序步骤', 'name, description and ordered steps')}
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
          title={t('还没有', 'Procedure No procedures proposed yet')}
          body={t(
            '用「新建草稿」写第一条有序步骤，或让 Worker 从成功的任务里蒸馏。',
            'Write the first one with New draft, or let a Worker distil one from a successful Task.',
          )}
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
                  {row.steps ? (
                    <span className="tag">
                      {row.steps.length} {t('步', 'steps')}
                    </span>
                  ) : null}
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
                      {t('编辑为新草稿', 'Edit as new draft')}
                    </Button>
                  ) : null}
                  {!permissions.isDenied('publish_procedure') && row.status === 'draft' ? (
                    <Button
                      variant="primary"
                      size="s"
                      loading={busy === row.id}
                      onClick={() => void act(row, 'publish_procedure')}
                    >
                      {t('发布', 'Publish')}
                    </Button>
                  ) : !permissions.isDenied('deprecate_procedure') && row.status === 'published' ? (
                    <DeprecateConfirm
                      busy={busy === row.id}
                      target={row.name}
                      onConfirm={() => act(row, 'deprecate_procedure')}
                      testId={`procedure-deprecate-confirm-${row.id}`}
                    />
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
            {t('加载更多', 'Load more')}
          </Button>
        </div>
      ) : null}
      {procedures.state.status === 'ready' && procedures.state.data.truncated === true ? (
        <p className="text-3 text-small" data-testid="procedures-truncated">
          {t(
            '已达到单次读取上限，继续点“加载更多”查看其余 Procedure。',
            'Reached the per-page limit — keep loading more to see the rest.',
          )}
        </p>
      ) : null}
      {procedures.loadMoreError !== null ? (
        <ErrorBanner
          error={procedures.loadMoreError}
          title={t('无法加载更多 Procedure', 'Could not load more procedures')}
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

/** Workers tab local editor state — a superset of the shared `EditorState<Row>` used by the
 *  Skills/Procedures tabs above: adds `'template'` for J7/CW1 "从模板创建（ops-runner）", which
 *  prefills a brand-new draft rather than starting blank or copying a published row. */
type WorkerEditorState =
  | { readonly kind: 'new' }
  | { readonly kind: 'copy'; readonly row: WorkerDefinitionSummary }
  | { readonly kind: 'template' }
  | null;

/** CW1 (audit "唯一一行是入口定义（v1 entry），还提供'弃用'——弃用它会让本工作区入口 agent 失效"):
 *  the entry-kind row(s) — shown separately from the delegable Worker rows, with **no** Deprecate
 *  action at all (not even behind a confirm — the kernel's own `deprecateWorkerDefinition` has no
 *  entry-kind special case, docs/development-tasks.md §5e F1: this page is the only guard, and
 *  omitting the action entirely is simpler than an `irreversible`-tier confirm for an action this
 *  page has no real reason to expose). "编辑（新版本草稿）" still proposes the next version, same
 *  as a Worker row — an entry family is still meant to evolve, just never be deprecated from here.
 */
function EntrySection({
  rows,
  canPropose,
  onEdit,
}: {
  readonly rows: readonly WorkerDefinitionSummary[];
  readonly canPropose: boolean;
  readonly onEdit: (row: WorkerDefinitionSummary) => void;
}) {
  const t = useT();
  return (
    <div className="stack-s" data-testid="workers-entry-section">
      <span className="section-title">{t('入口定义', 'Entry definition')}</span>
      {rows.length === 0 ? (
        <p className="text-3 text-small">
          {t(
            '本工作区还没有已发布的入口定义。',
            'No published entry definition in this workspace yet.',
          )}
        </p>
      ) : (
        <DataList ariaLabel="Entry definition" testId="workers-entry-list">
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
                  <span className="tag">{workerDefinitionKindLabel(row.kind, t)}</span>
                </>
              }
              meta={
                typeof row.definition.description === 'string' ? (
                  <span className="truncate">{row.definition.description}</span>
                ) : undefined
              }
              trailing={
                canPropose ? (
                  <Button
                    variant="ghost"
                    size="s"
                    onClick={() => onEdit(row)}
                    data-testid="catalog-edit-as-draft"
                  >
                    {t('编辑（新版本草稿）', 'Edit as new draft version')}
                  </Button>
                ) : undefined
              }
            />
          ))}
        </DataList>
      )}
    </div>
  );
}

/** S8 W2-U2b (audit R6 "保存草稿后找不回它"): the caller's own draft Worker definitions — shown
 *  only when non-empty (unlike `EntrySection` above, which always renders with an empty-state
 *  line; an empty "我的草稿" would just be clutter for the common case of no outstanding drafts).
 *  Publish is the one action offered, a plain button with no confirm (same tier Skills/Procedures
 *  rows already use for `publish_skill`/`publish_procedure` — publish only ever *adds* visibility,
 *  it does not remove or overwrite anything, so this tab's own `DeprecateConfirm` convention does
 *  not apply here). No "继续编辑"/edit action: the only mechanism that exists
 *  (`propose_worker_definition{definitionId}`) always inserts the *next* version rather than
 *  updating this draft row in place (`application/worker/definitions.ts`'s own doc comment — I16:
 *  "propose 总是插入新行"), and a still-draft version has no way to be cleared afterwards
 *  (`deprecate_worker_definition` only transitions out of `published`) — offering it here would
 *  leave an orphaned stale draft behind with no route to clean it up, so it is left out; publish
 *  (or resume the family from an already-published row's own "编辑（新版本草稿）", once this one is
 *  published) covers every path this lane's F6 read-only kernel scope allows. */
function MyDraftsSection({
  rows,
  busy,
  canPublish,
  onPublish,
}: {
  readonly rows: readonly WorkerDefinitionSummary[];
  readonly busy: string | null;
  readonly canPublish: boolean;
  readonly onPublish: (row: WorkerDefinitionSummary) => void;
}) {
  const t = useT();
  if (rows.length === 0) return null;
  return (
    <div className="stack-s" data-testid="workers-my-drafts-section">
      <span className="section-title">{t('我的草稿', 'My drafts')}</span>
      <DataList ariaLabel="My drafts" testId="workers-my-drafts-list">
        {rows.map((row) => (
          <DataRow
            key={`${row.id}@${row.version}`}
            testId="workers-my-draft-row"
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
                <span className="tag">{workerDefinitionKindLabel(row.kind, t)}</span>
              </>
            }
            meta={
              typeof row.definition.description === 'string' ? (
                <span className="truncate">{row.definition.description}</span>
              ) : undefined
            }
            trailing={
              canPublish ? (
                <Button
                  variant="primary"
                  size="s"
                  loading={busy === row.id}
                  onClick={() => onPublish(row)}
                  data-testid="worker-draft-publish"
                >
                  {t('发布', 'Publish')}
                </Button>
              ) : undefined
            }
          />
        ))}
      </DataList>
    </div>
  );
}

function WorkersTab({ http }: { readonly http: CapabilityCaller }) {
  const t = useT();
  const permissions = usePermissions();
  const toast = useToast();
  const workers = useCapabilityList<WorkerDefinitionSummary>(http, 'list_worker_definitions', {});
  // S8 W2-U2b (audit R6): a dedicated own-drafts read — `includeOwnDrafts` is additive (published
  // rows come back too, same as `workers` above), so this is filtered to `status === 'draft'`
  // below rather than treated as the tab's real list; `autoLoadAll` so a caller with drafts past
  // the first page still sees every one of them under "我的草稿" (own-drafts counts are small in
  // practice, same reasoning `WorkerEditorHost`'s own `list_skills` picker call below uses).
  const myDrafts = useCapabilityList<WorkerDefinitionSummary>(
    http,
    'list_worker_definitions',
    { includeOwnDrafts: true },
    { autoLoadAll: true },
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [editor, setEditor] = useState<WorkerEditorState>(null);

  function refresh(): void {
    invalidateCapability(http, 'list_worker_definitions');
    void workers.reload();
    void myDrafts.reload();
  }

  async function publishDraft(row: WorkerDefinitionSummary): Promise<void> {
    setBusy(row.id);
    try {
      await http.call('publish_worker_definition', { definitionId: row.id, version: row.version });
      toast.push({
        tone: 'ok',
        title: `${definitionName([row], row.id, row.version) ?? row.id} ${t('已发布', 'published')}`,
      });
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('publish_worker_definition');
      toast.push({
        tone: 'danger',
        title: t('无法发布该草稿', 'Could not publish this draft'),
        description: describeError(err).message,
      });
    } finally {
      setBusy(null);
    }
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
        title: t('无法弃用该定义', 'Could not deprecate this definition'),
        description: describeError(err).message,
      });
    } finally {
      setBusy(null);
    }
  }

  const canPropose = !permissions.isDenied('propose_worker_definition');
  const canPublish = !permissions.isDenied('publish_worker_definition');

  const editorDrawer = (
    <Drawer
      open={editor !== null}
      onClose={() => setEditor(null)}
      title={
        editor?.kind === 'copy'
          ? t('提议新版本', 'Propose a new version')
          : editor?.kind === 'template'
            ? t('从模板创建（ops-runner）', 'Create from template (ops-runner)')
            : t('新建 Worker 定义草稿', 'New Worker definition draft')
      }
      subtitle="kind + definition（systemPrompt、model、capabilities…）"
      wide
      testId="worker-editor-drawer"
    >
      {editor ? (
        <WorkerEditorHost
          key={editor.kind === 'copy' ? `${editor.row.id}@${editor.row.version}` : editor.kind}
          http={http}
          newVersionOf={editor.kind === 'copy' ? editor.row : undefined}
          initialForm={editor.kind === 'template' ? opsRunnerTemplateForm() : undefined}
          onProposed={() => {
            void workers.reload();
            void myDrafts.reload();
          }}
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
  const entryRows = rows.filter((row) => row.kind === 'entry');
  const workerRows = rows.filter((row) => row.kind !== 'entry');
  // R6: additive on top of `workers` above (published rows come back from this call too, S8
  // W2-U2b) — only the caller's own draft rows are this section's concern.
  const myDraftRows =
    myDrafts.state.status === 'ready'
      ? myDrafts.state.data.items.filter((row) => row.status === 'draft')
      : [];
  return (
    <>
      <DraftToolbar
        canPropose={canPropose}
        onNewDraft={() => setEditor({ kind: 'new' })}
        onRefresh={refresh}
        refreshing={workers.state.refreshing}
        testId="workers-new-draft"
        extra={
          canPropose ? (
            <Button
              variant="secondary"
              onClick={() => setEditor({ kind: 'template' })}
              data-testid="workers-template-button"
            >
              {t('从模板创建（ops-runner）', 'Create from template (ops-runner)')}
            </Button>
          ) : null
        }
      />

      <MyDraftsSection
        rows={myDraftRows}
        busy={busy}
        canPublish={canPublish}
        onPublish={(row) => void publishDraft(row)}
      />

      <EntrySection
        rows={entryRows}
        canPropose={canPropose}
        onEdit={(row) => setEditor({ kind: 'copy', row })}
      />

      <div className="stack-s" data-testid="workers-worker-section">
        <span className="section-title">{t('Worker 定义', 'Worker definitions')}</span>
        {workerRows.length === 0 ? (
          <EmptyState
            icon="grid"
            title={t('本工作区还没有已发布的 Worker', 'No published Workers in this workspace yet')}
            body={t(
              '入口 agent 委派任务时找不到可用的 Worker——发布至少一个 Worker 定义，委派才能成功。可以用上面的「从模板创建（ops-runner）」快速开始。',
              'The entry agent has nothing to delegate to — publish at least one Worker definition so delegation can succeed. Use “Create from template (ops-runner)” above to get started quickly.',
            )}
            testId="catalog-empty"
          />
        ) : (
          <DataList ariaLabel="Worker definitions" testId="catalog-list">
            {workerRows.map((row) => (
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
                    <span className="tag">{workerDefinitionKindLabel(row.kind, t)}</span>
                  </>
                }
                meta={
                  typeof row.definition.description === 'string' ? (
                    <span className="truncate">{row.definition.description}</span>
                  ) : undefined
                }
                trailing={
                  // CW2 (768px row actions overlapping the title's "v1 entry"-shaped chips):
                  // `row-wrap` instead of `row` so two actions stack instead of crowding the title
                  // out of the row at narrow widths.
                  <span className="row-wrap">
                    {canPropose ? (
                      <Button
                        variant="ghost"
                        size="s"
                        onClick={() => setEditor({ kind: 'copy', row })}
                        data-testid="catalog-edit-as-draft"
                      >
                        {t('编辑（新版本草稿）', 'Edit as new draft version')}
                      </Button>
                    ) : null}
                    {!permissions.isDenied('deprecate_worker_definition') &&
                    row.status === 'published' ? (
                      <DeprecateConfirm
                        busy={busy === row.id}
                        target={definitionName([row], row.id, row.version) ?? row.id}
                        onConfirm={() => deprecate(row)}
                        testId={`worker-deprecate-confirm-${row.id}@${row.version}`}
                      />
                    ) : null}
                  </span>
                }
              />
            ))}
          </DataList>
        )}
      </div>
      {workers.state.status === 'ready' && workers.state.data.nextCursor !== undefined ? (
        <div className="row" style={{ justifyContent: 'center' }}>
          <Button
            variant="secondary"
            loading={workers.loadingMore}
            onClick={() => void workers.loadMore()}
          >
            {t('加载更多', 'Load more')}
          </Button>
        </div>
      ) : null}
      {workers.state.status === 'ready' && workers.state.data.truncated === true ? (
        <p className="text-3 text-small" data-testid="workers-truncated">
          {t(
            '已达到单次读取上限，继续点“加载更多”查看其余 Worker 定义。',
            'Reached the per-page limit — keep loading more to see the rest.',
          )}
        </p>
      ) : null}
      {workers.loadMoreError !== null ? (
        <ErrorBanner
          error={workers.loadMoreError}
          title={t('无法加载更多 Worker 定义', 'Could not load more worker definitions')}
          testId="workers-load-more-error"
        />
      ) : null}
      {editorDrawer}
    </>
  );
}

/** Loads the picker directories (`list_models`, `list_capability_names`, `list_gatekeepers`,
 *  `list_skills`) only while the Worker editor is open — member-level reads, cached per session by
 *  `useCapabilityList`; the editor degrades to raw ids/names without them (same convention
 *  `ProcedureEditorHost` above already established). `list_skills` uses `autoLoadAll` (it is
 *  keyset-paginated, S8 W1-C) so the skills picker never silently hides a published Skill past the
 *  first page — same reasoning as `ProcedureEditorHost`'s own `list_worker_definitions` load. */
function WorkerEditorHost({
  http,
  newVersionOf,
  initialForm,
  onProposed,
  onDone,
}: {
  readonly http: CapabilityCaller;
  readonly newVersionOf?: WorkerDefinitionSummary;
  readonly initialForm?: WorkerDefinitionForm;
  readonly onProposed: () => void;
  readonly onDone: () => void;
}) {
  const models = useCapabilityList<ModelRow>(http, 'list_models');
  const capabilityNames = useCapabilityList<CapabilityNameRow>(http, 'list_capability_names');
  const gatekeepers = useCapabilityList<GatekeeperListRow>(http, 'list_gatekeepers');
  const skills = useCapabilityList<SkillRow>(http, 'list_skills', {}, { autoLoadAll: true });
  return (
    <WorkerDefinitionEditor
      http={http}
      newVersionOf={newVersionOf}
      initialForm={initialForm}
      models={models.state.status === 'ready' ? models.state.data.items : undefined}
      capabilityNames={
        capabilityNames.state.status === 'ready' ? capabilityNames.state.data.items : undefined
      }
      gatekeepers={gatekeepers.state.status === 'ready' ? gatekeepers.state.data.items : undefined}
      skills={skills.state.status === 'ready' ? skills.state.data.items : undefined}
      onProposed={onProposed}
      onDone={onDone}
    />
  );
}
