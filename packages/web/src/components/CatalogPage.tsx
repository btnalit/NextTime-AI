import { type ReactNode, useId, useState } from 'react';
import { invalidateCapability, useCapabilityList } from '../hooks/useCapability.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { opsRunnerTemplateForm } from '../lib/catalog.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { describeError, isForbiddenError } from '../lib/errors.js';
import { formatRelative } from '../lib/format.js';
import {
  type CapabilityNameRow,
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
import { DraftExpiryNote, type EditorState } from './catalog/CatalogShared.js';
import { ModulesTab } from './catalog/ModulesTab.js';
import { ProcedureEditorHost } from './catalog/ProcedureEditorHost.js';
import { SkillEditor } from './catalog/SkillEditor.js';
import { WorkerEditorHost } from './catalog/WorkerEditorHost.js';
import { Confirm } from './kit/confirm.js';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './kit/dialog.js';
import { PageHeader } from './kit/page-header.js';
import { ExecutionPrerequisiteBar } from './readiness/ExecutionPrerequisiteBar.js';
import { Button } from './ui/Button.js';
import { DataList, DataRow } from './ui/DataList.js';
import { Drawer } from './ui/Drawer.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Textarea, describedBy } from './ui/Field.js';
import { Notice } from './ui/Notice.js';
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
      <ExecutionPrerequisiteBar http={http} />
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
  const t = useT();
  if (status === 'loading') {
    return <SkeletonRows count={4} label={`Loading ${capabilityLabel}`} />;
  }
  return (
    <ErrorBanner
      error={error}
      title={t(`无法加载 ${capabilityLabel}`, `Could not load ${capabilityLabel}`)}
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
      title={t(`弃用 ${target}`, `Deprecate ${target}`)}
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

/** S8 W3-K1 (leftover 81): the bound `update_operation_description`'s own `paramsSchema` enforces
 *  (`packages/shared/src/capabilities.ts`) — mirrored here only so the textarea can stop the owner
 *  before a doomed round trip, not as the source of truth. */
const OPERATION_DESCRIPTION_MAX_LENGTH = 2000;

/** S8 W3 K2 (leftover 82): the caller's own private draft's "丢弃" action — a `kit/confirm`
 *  `medium` popover, same tier as `DeprecateConfirm` above (the dispatch's own wording: "kit/confirm
 *  tier medium, consequence '草稿将被删除，无法恢复'"). Unlike Deprecate, this is destructive and
 *  irreversible for the row itself (a hard delete, not a status change) — `danger` styling, but
 *  still `medium` (not `irreversible`/retyped-name) per the dispatch's own call, since a draft is
 *  private to the caller alone and easy to recreate. */
function DiscardDraftConfirm({
  busy,
  target,
  onConfirm,
  testId,
}: {
  readonly busy: boolean;
  readonly target: string;
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
          {t('丢弃', 'Discard')}
        </Button>
      }
      title={t(`丢弃 ${target}`, `Discard ${target}`)}
      description={t(
        '草稿将被删除，无法恢复。',
        'This draft will be permanently deleted and cannot be recovered.',
      )}
      target={target}
      confirmLabel={t('丢弃', 'Discard')}
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
  // S8 W3-K1 (leftover 81): the "编辑描述" dialog — one instance shared across rows, controlled by
  // which row (if any) is being edited, same "single shared surface, not one-per-row" convention
  // `GrantGateDrawer`/`Confirm` already use elsewhere in this codebase.
  const [editingRow, setEditingRow] = useState<OperationCatalogRow | null>(null);
  const [descriptionDraft, setDescriptionDraft] = useState('');
  const [savingDescription, setSavingDescription] = useState(false);
  const [descriptionError, setDescriptionError] = useState<unknown | null>(null);
  const descriptionFieldId = useId();

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

  function openDescriptionEditor(row: OperationCatalogRow): void {
    setEditingRow(row);
    setDescriptionDraft(row.description ?? '');
    setDescriptionError(null);
  }

  function closeDescriptionEditor(): void {
    setEditingRow(null);
    setDescriptionError(null);
  }

  async function saveDescription(): Promise<void> {
    if (!editingRow) return;
    setSavingDescription(true);
    setDescriptionError(null);
    try {
      await http.call('update_operation_description', {
        gatekeeperId: editingRow.gatekeeperId,
        name: editingRow.name,
        description: descriptionDraft,
      });
      toast.push({
        tone: 'ok',
        title: t('描述已更新', 'Description updated'),
        description: editingRow.name,
      });
      setEditingRow(null);
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('update_operation_description');
      setDescriptionError(err);
    } finally {
      setSavingDescription(false);
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
        title={t('还没有导入任何 Operation', 'No operations imported yet')}
        body={t(
          'Operation 来自已接入系统发布的清单，或接入向导的提议。',
          "Operations come from a connected system's published manifest, or the onboarding wizard's proposals.",
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
                  <div className="row-wrap">
                    <span className="mono truncate">{row.name}</span>
                    {row.mode ? (
                      <StatusChip machine="operationMode" status={row.mode} size="s" />
                    ) : null}
                    {/* S8 W1-A11 (audit L3): through the shared StatusChip machine, not a bare tag. */}
                    {row.autoApprovable ? (
                      <StatusChip machine="autoApprovable" status="true" size="s" />
                    ) : null}
                  </div>
                  {/* S8 W3-K1 (leftover 81, audit CO1): a blank description reads "未填写描述", not
                   *  the generic "—" every other missing-value field in this codebase uses — this
                   *  is a call to action (编辑描述 below), not just an absent fact. */}
                  <div
                    className="text-3 text-small truncate"
                    title={
                      row.description && row.description.trim().length > 0
                        ? row.description
                        : undefined
                    }
                    data-testid={`catalog-row-description-${key}`}
                  >
                    {row.description && row.description.trim().length > 0
                      ? row.description
                      : t('未填写描述', 'No description yet')}
                  </div>
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
                <div className="row-wrap">
                  {!permissions.isDenied('publish_operation') && row.status === 'draft' ? (
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
                              t(
                                `${usage.calls} 次调用`,
                                `${usage.calls} calls in the trailing window`,
                              ),
                              t(`${usage.approved} 次批准`, `${usage.approved} approved`),
                            ]
                          : undefined
                      }
                      onConfirm={() => act(row, 'deprecate_operation')}
                      testId={`operation-deprecate-confirm-${key}`}
                    />
                  ) : null}
                  {/* S8 W3-K1 (leftover 81): documentation-only, so it is not gated by the
                   *  publish/deprecate lifecycle above — a draft, published, or deprecated
                   *  Operation's description can all be edited. */}
                  {!permissions.isDenied('update_operation_description') ? (
                    <Button
                      variant="ghost"
                      size="s"
                      onClick={() => openDescriptionEditor(row)}
                      data-testid={`operation-edit-description-${key}`}
                    >
                      {t('编辑描述', 'Edit description')}
                    </Button>
                  ) : null}
                </div>
              }
            />
          );
        })}
      </DataList>
      <Dialog
        open={editingRow !== null}
        onOpenChange={(open) => {
          if (!open) closeDescriptionEditor();
        }}
      >
        <DialogContent data-testid="operation-description-dialog">
          <DialogHeader>
            <DialogTitle>{t('编辑描述', 'Edit description')}</DialogTitle>
            <DialogDescription className="mono">{editingRow?.name}</DialogDescription>
          </DialogHeader>
          <Field
            id={descriptionFieldId}
            label={t('描述', 'Description')}
            hint={t(
              '说明这个 Operation 做什么——会用于自然语言检索与在目录 / 审批卡片里展示。',
              "What this Operation does — used for natural-language search and shown wherever it's listed.",
            )}
            error={descriptionError !== null ? describeError(descriptionError).message : undefined}
          >
            <Textarea
              id={descriptionFieldId}
              value={descriptionDraft}
              onChange={(event) => setDescriptionDraft(event.target.value)}
              rows={4}
              maxLength={OPERATION_DESCRIPTION_MAX_LENGTH}
              invalid={descriptionError !== null}
              aria-describedby={describedBy(descriptionFieldId, true, descriptionError !== null)}
              data-testid="operation-description-textarea"
            />
          </Field>
          <DialogFooter>
            <Button
              variant="primary"
              size="s"
              loading={savingDescription}
              disabled={descriptionDraft.trim().length === 0}
              onClick={() => void saveDescription()}
              data-testid="operation-description-save"
            >
              {t('保存', 'Save')}
            </Button>
            <DialogClose asChild>
              <Button variant="ghost" size="s" disabled={savingDescription}>
                {t('取消', 'Cancel')}
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

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

  // S8 W3 K2 (leftover 82): `discard_draft{kind, id, version}` — a different params shape from
  // `act` above (`{skillId}` alone), so it is its own function rather than a third `action` value.
  async function discardSkillDraft(row: SkillRow): Promise<void> {
    setBusy(row.id);
    try {
      await http.call('discard_draft', { kind: 'skill', id: row.id, version: row.version });
      toast.push({ tone: 'ok', title: `${row.name} ${t('已丢弃', 'discarded')}` });
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('discard_draft');
      toast.push({
        tone: 'danger',
        title: t('无法丢弃该草稿', 'Could not discard this draft'),
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
      <DraftExpiryNote testId="skills-draft-expiry-note" />
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
                <span className="row-wrap">
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
                  {!permissions.isDenied('discard_draft') && row.status === 'draft' ? (
                    <DiscardDraftConfirm
                      busy={busy === row.id}
                      target={row.name}
                      onConfirm={() => discardSkillDraft(row)}
                      testId={`skill-discard-confirm-${row.id}`}
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

  // S8 W3 K2 (leftover 82): `discard_draft{kind, id, version}` — a different params shape from
  // `act` above (`{procedureId}` alone), so it is its own function rather than a third `action`.
  async function discardProcedureDraft(row: ProcedureRow): Promise<void> {
    setBusy(row.id);
    try {
      await http.call('discard_draft', { kind: 'procedure', id: row.id, version: row.version });
      toast.push({ tone: 'ok', title: `${row.name} ${t('已丢弃', 'discarded')}` });
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('discard_draft');
      toast.push({
        tone: 'danger',
        title: t('无法丢弃该草稿', 'Could not discard this draft'),
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
      <DraftExpiryNote testId="procedures-draft-expiry-note" />
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
                <span className="row-wrap">
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
                  {!permissions.isDenied('discard_draft') && row.status === 'draft' ? (
                    <DiscardDraftConfirm
                      busy={busy === row.id}
                      target={row.name}
                      onConfirm={() => discardProcedureDraft(row)}
                      testId={`procedure-discard-confirm-${row.id}`}
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
 *  Publish is a plain button with no confirm (same tier Skills/Procedures rows already use for
 *  `publish_skill`/`publish_procedure` — publish only ever *adds* visibility, it does not remove or
 *  overwrite anything, so this tab's own `DeprecateConfirm` convention does not apply here). No
 *  "继续编辑"/edit action: the only mechanism that exists (`propose_worker_definition{definitionId}`)
 *  always inserts the *next* version rather than updating this draft row in place
 *  (`application/worker/definitions.ts`'s own doc comment — I16: "propose 总是插入新行").
 *
 *  S8 W3 K2 (leftover 82): a still-draft version used to have no way to be cleared afterwards
 *  (`deprecate_worker_definition` only transitions out of `published`) — `discard_draft` now closes
 *  that gap, so "丢弃" (a `DiscardDraftConfirm`, tier `medium`) sits next to "发布"; the one-line
 *  `DraftExpiryNote` covers the drafts a caller simply forgets about. */
function MyDraftsSection({
  rows,
  busy,
  canPublish,
  canDiscard,
  onPublish,
  onDiscard,
}: {
  readonly rows: readonly WorkerDefinitionSummary[];
  readonly busy: string | null;
  readonly canPublish: boolean;
  readonly canDiscard: boolean;
  readonly onPublish: (row: WorkerDefinitionSummary) => void;
  readonly onDiscard: (row: WorkerDefinitionSummary) => Promise<void>;
}) {
  const t = useT();
  if (rows.length === 0) return null;
  return (
    <div className="stack-s" data-testid="workers-my-drafts-section">
      <span className="section-title">{t('我的草稿', 'My drafts')}</span>
      <DraftExpiryNote testId="workers-my-drafts-expiry-note" />
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
              <span className="row-wrap">
                {canPublish ? (
                  <Button
                    variant="primary"
                    size="s"
                    loading={busy === row.id}
                    onClick={() => onPublish(row)}
                    data-testid="worker-draft-publish"
                  >
                    {t('发布', 'Publish')}
                  </Button>
                ) : null}
                {canDiscard ? (
                  <DiscardDraftConfirm
                    busy={busy === row.id}
                    target={definitionName([row], row.id, row.version) ?? row.id}
                    onConfirm={() => onDiscard(row)}
                    testId={`worker-draft-discard-${row.id}@${row.version}`}
                  />
                ) : null}
              </span>
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
  // S8 W3 K2 (leftover 84): lifted up from `WorkerEditorHost` below — the "从模板创建（ops-runner）"
  // button needs this loaded *before* the editor drawer even opens (it must stay disabled until
  // then, so an incomplete list is never submitted as the template's `capabilities`); passed down
  // into `WorkerEditorHost` as a prop instead of that component loading its own second copy.
  const capabilityNames = useCapabilityList<CapabilityNameRow>(http, 'list_capability_names');
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
        title: t(
          `${definitionName([row], row.id, row.version) ?? row.id} 已弃用`,
          `${definitionName([row], row.id, row.version) ?? row.id} deprecated`,
        ),
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

  // S8 W3 K2 (leftover 82): discards one of the caller's own draft WorkerDefinition versions —
  // same catch-and-toast convention every other write in this tab already uses (never re-throws
  // into `Confirm`'s own inline error state, matching `deprecate`/`publishDraft` above).
  async function discardWorkerDraft(row: WorkerDefinitionSummary): Promise<void> {
    setBusy(row.id);
    try {
      await http.call('discard_draft', {
        kind: 'worker_definition',
        id: row.id,
        version: row.version,
      });
      toast.push({
        tone: 'ok',
        title: `${definitionName([row], row.id, row.version) ?? row.id} ${t('已丢弃', 'discarded')}`,
      });
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('discard_draft');
      toast.push({
        tone: 'danger',
        title: t('无法丢弃该草稿', 'Could not discard this draft'),
        description: describeError(err).message,
      });
    } finally {
      setBusy(null);
    }
  }

  const canPropose = !permissions.isDenied('propose_worker_definition');
  const canPublish = !permissions.isDenied('publish_worker_definition');
  const canDiscard = !permissions.isDenied('discard_draft');

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
          initialForm={
            editor.kind === 'template' && capabilityNames.state.status === 'ready'
              ? opsRunnerTemplateForm(capabilityNames.state.data.items)
              : undefined
          }
          capabilityNames={
            capabilityNames.state.status === 'ready' ? capabilityNames.state.data.items : undefined
          }
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
              disabled={capabilityNames.state.status !== 'ready'}
              title={
                capabilityNames.state.status !== 'ready'
                  ? t('能力清单加载中，请稍候', 'Loading the capability list, please wait')
                  : undefined
              }
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
        canDiscard={canDiscard}
        onPublish={(row) => void publishDraft(row)}
        onDiscard={discardWorkerDraft}
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
        {canPropose &&
        workers.state.status === 'ready' &&
        workers.state.data.nextCursor === undefined &&
        workerRows.length > 0 &&
        workerRows.length <= 2 ? (
          // S8 W4 (audit L11 "Workers 只有 1-2 行时，下方空白像没做完"): the row's own remedy
          // example — point back at the toolbar's "新建 Worker 定义草稿" / "从模板创建" above,
          // instead of leaving bare canvas below a short list.
          <Notice testId="workers-short-list-hint">
            {t(
              '还可以新建 Worker 定义草稿，或从模板创建（ops-runner）快速开始。',
              'You can start another Worker definition draft, or create one from the ops-runner template.',
            )}
          </Notice>
        ) : null}
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
